'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, randomInt } = require('node:crypto');

const {
  Client, Events, GatewayIntentBits: I, Partials, ChannelType: C,
  PermissionFlagsBits: P, MessageFlags, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  EmbedBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder,
} = require('discord.js');

function required(name) {
  const value = process.env[name]?.trim();

  if (!value || /REMPLACE|A_COMPLETER/.test(value)) {
    throw new Error(`Variable à compléter : ${name}`);
  }

  return value;
}

const TOKEN = required('DISCORD_TOKEN');
const GUILD = required('DISCORD_GUILD_ID');

if (!/^\d{17,20}$/.test(GUILD)) {
  throw new Error('DISCORD_GUILD_ID invalide.');
}

// Créé automatiquement, sans configuration supplémentaire.
const directory = path.join(__dirname, 'data');

fs.mkdirSync(directory, {
  recursive: true,
  mode: 0o700,
});

const db = new DatabaseSync(
  path.join(directory, 'gamification.sqlite')
);

db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA busy_timeout=5000;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    xp INTEGER NOT NULL DEFAULT 0 CHECK(xp >= 0),
    coins INTEGER NOT NULL DEFAULT 0 CHECK(coins >= 0),
    message_at INTEGER NOT NULL DEFAULT 0,
    reaction_at INTEGER NOT NULL DEFAULT 0,
    loot_day TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS users_xp
    ON users(xp DESC,id);

  CREATE INDEX IF NOT EXISTS users_coins
    ON users(coins DESC,id);

  CREATE TABLE IF NOT EXISTS quests (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    format TEXT NOT NULL,
    xp INTEGER NOT NULL,
    coins INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    cursor TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS claims (
    quest TEXT NOT NULL,
    user TEXT NOT NULL,
    message TEXT NOT NULL,
    PRIMARY KEY(quest,user)
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    created INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invited (
    user TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    expires INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS boards (
    currency TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    message TEXT NOT NULL,
    day TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS boxes (
    message TEXT PRIMARY KEY,
    currency TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    created INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bytes BLOB NOT NULL
  );
`);

// Adaptation automatique de l'ancienne version.
const boxColumns = new Set(
  db.prepare('PRAGMA table_info(boxes)').all().map(c => c.name)
);

if (!boxColumns.has('channel')) {
  db.exec('ALTER TABLE boxes ADD COLUMN channel TEXT');
}

if (!boxColumns.has('title')) {
  db.exec('ALTER TABLE boxes ADD COLUMN title TEXT');
}

const sql = new Map();

function statement(text) {
  if (!sql.has(text)) sql.set(text, db.prepare(text));
  return sql.get(text);
}

const get = (text, ...args) => statement(text).get(...args);
const all = (text, ...args) => statement(text).all(...args);
const run = (text, ...args) => statement(text).run(...args);

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function setting(key, fallback) {
  const record = get(
    'SELECT value FROM settings WHERE key=?',
    key
  );

  return record ? JSON.parse(record.value) : fallback;
}

function set(key, value) {
  run(
    `INSERT INTO settings VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    key,
    JSON.stringify(value)
  );
}

if (!setting('guild', null)) set('guild', GUILD);

if (setting('guild') !== GUILD) {
  throw new Error('Ce stockage appartient à un autre serveur.');
}

function audit(actor, action, detail) {
  run(
    `INSERT INTO audit(created,actor,action,detail)
     VALUES (?,?,?,?)`,
    Date.now(),
    actor,
    action,
    JSON.stringify(detail)
  );
}

function user(id) {
  run('INSERT OR IGNORE INTO users(id) VALUES (?)', id);
  return get('SELECT * FROM users WHERE id=?', id);
}

function add(id, xp = 0, coins = 0) {
  const old = user(id);

  if (
    ![old.xp + xp, old.coins + coins].every(
      n => Number.isSafeInteger(n) && n >= 0
    )
  ) {
    throw new Error('Solde hors limites.');
  }

  run(
    'UPDATE users SET xp=xp+?,coins=coins+? WHERE id=?',
    xp, coins, id
  );
}

class UserError extends Error {}

function error(where, e) {
  console.error(`${where}: ${e.code || e.name || 'Erreur'}`);
}

const defaults = {
  message: 5,
  media: 5,
  reaction: 2,
  invitation: 25,
  delai: 60,
  active: true,
};

const tiersDefault = [
  { name: 'Commune', chance: 60, amount: 25, color: 0x95a5a6 },
  { name: 'Peu commune', chance: 25, amount: 50, color: 0x2ecc71 },
  { name: 'Rare', chance: 10, amount: 100, color: 0x3498db },
  { name: 'Épique', chance: 4, amount: 250, color: 0x9b59b6 },
  { name: 'Légendaire', chance: 1, amount: 500, color: 0xf1c40f },
];

function pick(tiers) {
  let roll = randomInt(100);

  for (const tier of tiers) {
    if (roll < tier.chance) return tier;
    roll -= tier.chance;
  }

  throw new Error('Probabilités invalides.');
}

function color(value, fallback = 0x5865f2) {
  if (!value?.trim()) return fallback;

  const text = value.trim().replace(/^#/, '');

  if (!/^[0-9a-f]{6}$/i.test(text)) {
    throw new UserError(
      'Couleur attendue : un code HEX comme #E91E63 ou #FFD700.'
    );
  }

  return parseInt(text, 16);
}

function hex(value) {
  return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
}

function tiersFor(currency) {
  return setting(`tiers:${currency}`, tiersDefault).map(
    (tier, index) => ({
      ...tiersDefault[index],
      description: '',
      image: null,
      ...tier,
    })
  );
}

function boxStyle(currency) {
  return {
    title: '🎁 Ta lootbox du jour',
    description: 'Ouvre ton coffre quotidien et découvre ta récompense !',
    color: 0xf1c40f,
    image: null,
    animation: null,
    seconds: 3,
    ...setting(`boxstyle:${currency}`, {}),
  };
}

async function importAsset(attachment, gifOnly = false) {
  if (!attachment || attachment.size > 8 * 1024 * 1024) {
    throw new UserError(
      'Fichier trop volumineux : maximum 8 Mo.'
    );
  }

  const url = new URL(attachment.url);

  if (
    url.protocol !== 'https:' ||
    !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
  ) {
    throw new UserError(
      'Joins directement le fichier à la commande Discord.'
    );
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });

  if (!response.ok) {
    throw new UserError(
      'Fichier inaccessible. Joins-le à nouveau à la commande.'
    );
  }

  const parts = [];
  let size = 0;
  const reader = response.body.getReader();

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    size += value.length;

    if (size > 8 * 1024 * 1024) {
      await reader.cancel();

      throw new UserError(
        'Fichier trop volumineux : maximum 8 Mo.'
      );
    }

    parts.push(value);
  }

  const bytes = Buffer.concat(parts);

  const ext =
    ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())
      ? 'gif'
      : bytes.subarray(0, 8).equals(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        )
        ? 'png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          ? 'jpg'
          : bytes.subarray(0, 4).toString() === 'RIFF' &&
            bytes.subarray(8, 12).toString() === 'WEBP'
            ? 'webp'
            : null;

  if (!ext || (gifOnly && ext !== 'gif')) {
    throw new UserError(
      gifOnly
        ? 'Importe un GIF pour l’animation d’ouverture. Les vidéos MP4 ne se lisent pas automatiquement dans cet embed.'
        : 'Formats acceptés : PNG, JPG, WEBP ou GIF.'
    );
  }

  const id = randomUUID();

  run(
    'INSERT INTO assets VALUES (?,?,?)',
    id,
    `visuel-${id}.${ext}`,
    bytes
  );

  return id;
}

function withImage(embed, assetId) {
  const asset = assetId
    ? get('SELECT * FROM assets WHERE id=?', assetId)
    : null;

  if (!asset) {
    return {
      embeds: [embed],
      files: [],
      attachments: [],
      allowedMentions: noPing,
    };
  }

  embed.setImage(`attachment://${asset.name}`);

  return {
    embeds: [embed],
    files: [
      new AttachmentBuilder(
        Buffer.from(asset.bytes),
        { name: asset.name }
      ),
    ],
    attachments: [],
    allowedMentions: noPing,
  };
}

function resultMessage(id, currency, tier, style, preview = false) {
  const embed = new EmbedBuilder()
    .setColor(tier.color)
    .setTitle(`🎁 ${tier.name}`)
    .setDescription(
      [
        tier.description,
        `${preview ? 'Cette récompense contient' : 'Tu gagnes'} ` +
          `**${tier.amount.toLocaleString('fr-FR')} ` +
          `${currency === 'xp' ? 'XP' : 'coins'}** !`,
        preview
          ? '*Aperçu : aucun point crédité.*'
          : position(id, currency),
      ]
        .filter(Boolean)
        .join('\n\n')
    )
    .setFooter({
      text: preview
        ? 'Aperçu administrateur, sans ouverture de lootbox.'
        : 'Récompense ajoutée à ton solde. Reviens demain pour une nouvelle ouverture !',
    });

  return withImage(embed, tier.image || style.image);
}

async function animateBox(i, currency, tier) {
  const style = boxStyle(currency);

  if (style.animation) {
    try {
      await i.editReply(
        withImage(
          new EmbedBuilder()
            .setColor(style.color)
            .setTitle('✨ Ouverture de ta lootbox…')
            .setDescription(
              'Ton coffre s’ouvre… Découvre ta récompense dans un instant !'
            ),
          style.animation
        )
      );

      await new Promise(resolve =>
        setTimeout(resolve, style.seconds * 1000)
      );
    } catch (e) {
      error('Animation (récompense conservée)', e);
    }
  }

  await i.editReply(
    resultMessage(i.user.id, currency, tier, style)
  );
}

let updatingBoxes = false;

async function updateBoxes(currency) {
  if (updatingBoxes) return;
  updatingBoxes = true;

  try {
    for (const box of all(
      'SELECT * FROM boxes WHERE currency=?',
      currency
    )) {
      if (!box.channel) continue;

      try {
        const channel = await client.channels.fetch(box.channel);
        const message = await channel.messages.fetch(box.message);

        await message.edit(
          boxMessage(currency, box.title || undefined)
        );
      } catch (e) {
        if ([10003, 10008].includes(Number(e.code))) {
          run(
            'DELETE FROM boxes WHERE message=?',
            box.message
          );
        } else {
          error('Actualisation du visuel de lootbox', e);
        }
      }
    }
  } finally {
    updatingBoxes = false;
  }
}

async function styleFromOptions(i, currency) {
  const image = i.options.getAttachment('image');
  const animation = i.options.getAttachment('animation');
  const parsedColor = i.options.getString('couleur');

  const nextColor = parsedColor ? color(parsedColor) : null;
  const imageId = image ? await importAsset(image) : null;

  const animationId = animation
    ? await importAsset(animation, true)
    : null;

  const style = boxStyle(currency);

  if (imageId) style.image = imageId;
  if (animationId) style.animation = animationId;
  if (nextColor !== null) style.color = nextColor;

  set(`boxstyle:${currency}`, style);

  return style;
}

const fmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function paris(now = Date.now()) {
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(now)).map(
      part => [part.type, part.value]
    )
  );

  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

const client = new Client({
  intents: [
    I.Guilds,
    I.GuildMessages,
    I.MessageContent,
    I.GuildMessageReactions,
    I.GuildMembers,
    I.GuildInvites,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
  ],
  rest: {
    timeout: 15000,
    retries: 0,
  },
});

let ready = false;
let stopping = false;
let clock;
let ticks = 0;

const jobs = new Set();

function task(name, fn) {
  if (stopping) return;

  const promise = Promise.resolve()
    .then(fn)
    .catch(e => error(name, e));

  jobs.add(promise);

  void promise.finally(() => jobs.delete(promise));
}

function admin(i) {
  if (
    i.guildId !== GUILD ||
    !i.memberPermissions?.has(P.ManageGuild)
  ) {
    throw new UserError(
      'Commande réservée aux membres ayant Gérer le serveur.'
    );
  }
}

function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

function button(id, label, style = ButtonStyle.Primary) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style);
}

function input(id, label, style, max, required = true, value) {
  const text = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setMaxLength(max)
    .setRequired(required);

  if (value) text.setValue(value);

  return row(text);
}

function modal(id, title, ...inputs) {
  return new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(...inputs);
}

function rewardLabel(xp, coins) {
  return [
    xp ? `${xp} XP` : '',
    coins ? `${coins} coins` : '',
  ]
    .filter(Boolean)
    .join(' et ');
}

const noPing = { parse: [] };

function permission(channel, list) {
  if (!channel?.permissionsFor(client.user)?.has(list)) {
    throw new UserError(
      'Permissions du bot insuffisantes dans ce salon.'
    );
  }
}

function canEarn(_channel, config) {
  return config.active;
}

function meets(message, format) {
  const attachments = [...message.attachments.values()];

  const image = attachments.some(
    attachment => attachment.contentType?.startsWith('image/')
  );

  const video = attachments.some(
    attachment => attachment.contentType?.startsWith('video/')
  );

  return format === 'texte'
    ? Boolean(message.content?.trim())
    : format === 'image'
      ? image
      : format === 'video'
        ? video
        : image || video;
}

function claimQuest(message, quest) {
  if (!quest.active || !meets(message, quest.format)) {
    return false;
  }

  return transaction(() => {
    const result = run(
      'INSERT OR IGNORE INTO claims VALUES (?,?,?)',
      quest.id,
      message.author.id,
      message.id
    );

    if (!result.changes) return false;

    add(message.author.id, quest.xp, quest.coins);

    audit(message.author.id, 'quete', {
      quest: quest.id,
      message: message.id,
      xp: quest.xp,
      coins: quest.coins,
    });

    return true;
  });
}

async function processMessage(message, catchup = false) {
  if (
    !ready ||
    message.guildId !== GUILD ||
    !message.author ||
    message.author.bot ||
    message.webhookId ||
    ![0, 19].includes(message.type)
  ) {
    return;
  }

  const quest = get(
    'SELECT * FROM quests WHERE id=?',
    message.channelId
  );

  if (quest && claimQuest(message, quest)) {
    try {
      await message.reply({
        content:
          `<@${message.author.id}>, quête **${quest.title}** validée ! ` +
          `Tu gagnes **${rewardLabel(quest.xp, quest.coins)}**.`,
        allowedMentions: {
          parse: [],
          users: [message.author.id],
          repliedUser: false,
        },
      });
    } catch (e) {
      error('Confirmation de quête (récompense conservée)', e);
    }
  }

  if (catchup) return;

  const config = setting('activity', defaults);

  if (
    !canEarn(message.channel, config) ||
    (!message.content?.trim() && !message.attachments.size)
  ) {
    return;
  }

  transaction(() => {
    const inserted = run(
      'INSERT OR IGNORE INTO events VALUES (?,?)',
      `m:${message.id}`,
      Date.now()
    );

    if (!inserted.changes) return;

    const record = user(message.author.id);
    const now = message.createdTimestamp;

    if (now - record.message_at < config.delai * 1000) {
      return;
    }

    add(
      record.id,
      config.message +
        (meets(message, 'media') ? config.media : 0)
    );

    run(
      'UPDATE users SET message_at=? WHERE id=?',
      now,
      record.id
    );
  });
}

async function processReaction(reaction, author) {
  if (!ready || author.bot) return;

  if (reaction.partial) await reaction.fetch();

  const message = reaction.message.partial
    ? await reaction.message.fetch()
    : reaction.message;

  if (
    message.guildId !== GUILD ||
    !message.author ||
    message.author.bot ||
    message.author.id === author.id ||
    message.webhookId
  ) {
    return;
  }

  const config = setting('activity', defaults);

  if (!canEarn(message.channel, config) || !config.reaction) {
    return;
  }

  transaction(() => {
    const inserted = run(
      'INSERT OR IGNORE INTO events VALUES (?,?)',
      `r:${message.id}:${author.id}`,
      Date.now()
    );

    if (!inserted.changes) return;

    const record = user(author.id);
    const now = Date.now();

    if (now - record.reaction_at < config.delai * 1000) {
      return;
    }

    add(record.id, config.reaction);

    run(
      'UPDATE users SET reaction_at=? WHERE id=?',
      now,
      record.id
    );
  });
}

let invites = null;
let inviteQueue = Promise.resolve();

function queueInvite(fn) {
  inviteQueue = inviteQueue
    .then(fn)
    .catch(e => {
      invites = null;
      error('Invitations', e);
    });

  return inviteQueue;
}

async function inviteSnapshot(guild) {
  if (
    !guild.members.me?.permissions.has(P.ManageGuild) ||
    guild.vanityURLCode
  ) {
    return null;
  }

  const list = await guild.invites.fetch();

  return new Map(
    [...list.values()].map(invite => [
      invite.code,
      {
        uses: invite.uses || 0,
        inviter: invite.inviter?.id,
        bot: invite.inviter?.bot,
      },
    ])
  );
}

async function join(member) {
  if (
    !ready ||
    member.guild.id !== GUILD ||
    member.user.bot
  ) {
    return;
  }

  const before = invites;
  invites = await inviteSnapshot(member.guild);

  const first = run(
    'INSERT OR IGNORE INTO invited VALUES (?)',
    member.id
  ).changes;

  if (
    !first ||
    !before ||
    !invites ||
    Date.now() - member.user.createdTimestamp < 7 * 86400000
  ) {
    return;
  }

  if ([...before.keys()].some(code => !invites.has(code))) {
    return;
  }

  const changed = [...invites].filter(
    ([code, invite]) =>
      invite.uses !== (before.get(code)?.uses || 0)
  );

  if (changed.length !== 1) return;

  const [code, invite] = changed[0];

  if (
    !before.has(code) ||
    invite.uses - before.get(code).uses !== 1 ||
    !invite.inviter ||
    invite.bot ||
    invite.inviter === member.id
  ) {
    return;
  }

  const config = setting('activity', defaults);

  if (!config.active || !config.invitation) return;

  transaction(() => {
    add(invite.inviter, config.invitation);

    audit(invite.inviter, 'invitation', {
      member: member.id,
      xp: config.invitation,
    });
  });
}

function leaderboard(currency) {
  const entries = all(
    `SELECT id,${currency} AS amount
     FROM users
     WHERE ${currency}>0
     ORDER BY ${currency} DESC,id
     LIMIT 20`
  );

  const embed = new EmbedBuilder()
    .setColor(
      setting(
        `boardcolor:${currency}`,
        currency === 'xp' ? 0x5865f2 : 0xf1c40f
      )
    )
    .setTitle(
      currency === 'xp'
        ? '🏆 Classement XP'
        : '🪙 Classement coins'
    )
    .setDescription(
      entries
        .map(
          (member, index) =>
            `**${index + 1}.** <@${member.id}> · ` +
            `**${member.amount.toLocaleString('fr-FR')} ` +
            `${currency === 'xp' ? 'XP' : 'coins'}**`
        )
        .join('\n') || 'Aucun point pour le moment.'
    )
    .setFooter({
      text:
        'Actualisé chaque matin à 10 h, heure de Paris. ' +
        'Le bouton affiche ta position actuelle.',
    })
    .setTimestamp();

  return {
    ...withImage(
      embed,
      setting(`boardimage:${currency}`, null)
    ),
    components: [
      row(
        button(
          `position:${currency}`,
          'Voir ma position',
          ButtonStyle.Secondary
        )
      ),
    ],
  };
}

let refreshing = false;

async function refreshBoards(force = false) {
  if (refreshing) return;
  refreshing = true;

  try {
    const time = paris();

    for (const board of all('SELECT * FROM boards')) {
      if (
        !force &&
        (time.hour < 10 || board.day === time.day)
      ) {
        continue;
      }

      try {
        const channel = await client.channels.fetch(
          board.channel
        );

        const message = await channel.messages.fetch(
          board.message
        );

        await message.edit(leaderboard(board.currency));

        run(
          'UPDATE boards SET day=? WHERE currency=?',
          time.day,
          board.currency
        );
      } catch (e) {
        error(
          'Classement : vérifier le message et les permissions',
          e
        );
      }
    }
  } finally {
    refreshing = false;
  }
}

function boxMessage(currency, title) {
  const tiers = tiersFor(currency);
  const style = boxStyle(currency);

  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(title || style.title)
    .setDescription(
      `${style.description}\n\n**Les récompenses possibles**\n` +
      tiers
        .map(
          tier =>
            `**${tier.name}** : ${tier.amount} ` +
            `${currency === 'xp' ? 'XP' : 'coins'} · ` +
            `${tier.chance} %`
        )
        .join('\n')
    )
    .setFooter({
      text:
        'Une ouverture par membre et par jour. ' +
        'Nouveau coffre à minuit, heure de Paris.',
    });

  return {
    ...withImage(embed, style.image),
    components: [
      row(
        button(
          `box:${currency}`,
          '🎁 Ouvrir ma box du jour'
        )
      ),
    ],
  };
}

function openBox(id, currency) {
  return transaction(() => {
    const record = user(id);
    const today = paris().day;

    if (record.loot_day === today) {
      throw new UserError(
        'Tu as déjà ouvert ta lootbox aujourd’hui. ' +
        'Reviens demain, après minuit, heure de Paris !'
      );
    }

    const tier = pick(tiersFor(currency));

    add(
      id,
      currency === 'xp' ? tier.amount : 0,
      currency === 'coins' ? tier.amount : 0
    );

    run(
      'UPDATE users SET loot_day=? WHERE id=?',
      today,
      id
    );

    audit(id, 'lootbox', {
      day: today,
      currency,
      rarity: tier.name,
      amount: tier.amount,
    });

    return tier;
  });
}

function base(name, description, restricted = true) {
  const command = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description);

  if (restricted) {
    command.setDefaultMemberPermissions(P.ManageGuild);
  }

  return command;
}

const currencies = [
  { name: 'XP', value: 'xp' },
  { name: 'Coins', value: 'coins' },
];

const currencyOption = option =>
  option
    .setName('monnaie')
    .setDescription('XP ou coins')
    .setRequired(true)
    .addChoices(...currencies);

const forumOption = option =>
  option
    .setName('forum')
    .setDescription('Forum où publier la quête')
    .setRequired(true)
    .addChannelTypes(C.GuildForum);

const textOption = option =>
  option
    .setName('salon')
    .setDescription('Salon texte de publication')
    .setRequired(true)
    .addChannelTypes(C.GuildText, C.GuildAnnouncement);

const colorOption = option =>
  option
    .setName('couleur')
    .setDescription('Couleur HEX, par exemple #FFD700')
    .setMaxLength(7);

const rarityOption = option =>
  option
    .setName('rarete')
    .setDescription('Niveau de rareté à personnaliser')
    .setRequired(true)
    .addChoices(
      ...tiersDefault.map((tier, index) => ({
        name: tier.name,
        value: index,
      }))
    );

const commands = [
  base('quete', 'Créer et gérer les quêtes')
    .addSubcommand(sub =>
      sub
        .setName('creer')
        .setDescription('Ouvrir le formulaire de création')
        .addChannelOption(forumOption)
        .addStringOption(option =>
          option
            .setName('format')
            .setDescription('Preuve acceptée')
            .setRequired(true)
            .addChoices(
              { name: 'Image jointe', value: 'image' },
              { name: 'Vidéo jointe', value: 'video' },
              { name: 'Image ou vidéo jointe', value: 'media' },
              { name: 'Texte', value: 'texte' }
            )
        )
        .addIntegerOption(option =>
          option.setName('xp').setDescription('Récompense XP')
            .setMinValue(0).setMaxValue(1000000)
        )
        .addIntegerOption(option =>
          option.setName('coins').setDescription('Récompense coins')
            .setMinValue(0).setMaxValue(1000000)
        )
        .addAttachmentOption(option =>
          option.setName('image')
            .setDescription('Image de présentation facultative, maximum 8 Mo')
        )
        .addStringOption(colorOption)
        .addStringOption(option =>
          option.setName('tag')
            .setDescription('Nom exact du tag du forum si nécessaire')
            .setMaxLength(20)
        )
    )
    .addSubcommand(sub =>
      sub.setName('fermer')
        .setDescription('Arrêter les récompenses et archiver la quête')
        .addStringOption(option =>
          option.setName('fil').setDescription('Identifiant ou lien du fil')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('supprimer')
        .setDescription('Supprimer le post de quête après confirmation')
        .addStringOption(option =>
          option.setName('fil').setDescription('Identifiant ou lien du fil')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('liste')
        .setDescription('Afficher les quêtes et leurs récompenses')
    ),

  base('classement', 'Publier et actualiser les classements')
    .addSubcommand(sub =>
      sub.setName('publier')
        .setDescription('Publier le classement Top 20')
        .addStringOption(currencyOption)
        .addChannelOption(textOption)
        .addStringOption(colorOption)
        .addAttachmentOption(option =>
          option.setName('image')
            .setDescription('Grande image facultative du classement')
        )
    )
    .addSubcommand(sub =>
      sub.setName('apparence')
        .setDescription('Modifier la couleur ou l’image du classement existant')
        .addStringOption(currencyOption)
        .addStringOption(colorOption)
        .addAttachmentOption(option =>
          option.setName('image')
            .setDescription('Grande image du classement')
        )
    )
    .addSubcommand(sub =>
      sub.setName('actualiser')
        .setDescription('Actualiser les classements maintenant')
    ),

  base('points', 'Gérer les soldes XP et coins')
    .addSubcommand(sub =>
      sub.setName('ajouter')
        .setDescription('Ajouter des points')
        .addUserOption(option =>
          option.setName('membre').setDescription('Membre').setRequired(true)
        )
        .addStringOption(currencyOption)
        .addIntegerOption(option =>
          option.setName('montant').setDescription('Nombre de points')
            .setRequired(true).setMinValue(1).setMaxValue(1000000)
        )
    )
    .addSubcommand(sub =>
      sub.setName('retirer')
        .setDescription('Retirer des points')
        .addUserOption(option =>
          option.setName('membre').setDescription('Membre').setRequired(true)
        )
        .addStringOption(currencyOption)
        .addIntegerOption(option =>
          option.setName('montant').setDescription('Nombre de points')
            .setRequired(true).setMinValue(1).setMaxValue(1000000)
        )
    )
    .addSubcommand(sub =>
      sub.setName('reset')
        .setDescription('Remettre les soldes à zéro après confirmation')
        .addStringOption(option =>
          option.setName('monnaie').setDescription('Solde à remettre à zéro')
            .setRequired(true)
            .addChoices(...currencies, { name: 'XP et coins', value: 'tout' })
        )
    ),

  base('lootbox', 'Publier et configurer les lootbox')
    .addSubcommand(sub =>
      sub.setName('publier')
        .setDescription('Publier le bouton de lootbox quotidienne')
        .addStringOption(currencyOption)
        .addChannelOption(textOption)
        .addStringOption(option =>
          option.setName('titre').setDescription('Titre facultatif')
            .setMaxLength(100)
        )
        .addAttachmentOption(option =>
          option.setName('image').setDescription('Grande image de présentation')
        )
        .addAttachmentOption(option =>
          option.setName('animation')
            .setDescription('GIF d’ouverture à importer, maximum 8 Mo')
        )
        .addStringOption(colorOption)
    )
    .addSubcommand(sub =>
      sub.setName('configurer')
        .setDescription('Configurer les chances et gains des 5 raretés')
        .addStringOption(currencyOption)
    )
    .addSubcommand(sub =>
      sub.setName('personnaliser')
        .setDescription('Personnaliser le titre, le texte et la couleur de la lootbox')
        .addStringOption(currencyOption)
    )
    .addSubcommand(sub =>
      sub.setName('rarete')
        .setDescription('Nom, description, couleur et image d’une récompense')
        .addStringOption(currencyOption)
        .addIntegerOption(rarityOption)
        .addAttachmentOption(option =>
          option.setName('image').setDescription('Grande image de cette rareté')
        )
    )
    .addSubcommand(sub =>
      sub.setName('visuels')
        .setDescription('Importer l’image de présentation et le GIF d’ouverture')
        .addStringOption(currencyOption)
        .addAttachmentOption(option =>
          option.setName('image').setDescription('Grande image de présentation')
        )
        .addAttachmentOption(option =>
          option.setName('animation').setDescription('GIF d’ouverture, maximum 8 Mo')
        )
        .addIntegerOption(option =>
          option.setName('secondes')
            .setDescription('Durée d’affichage du GIF, de 1 à 15 secondes')
            .setMinValue(1).setMaxValue(15)
        )
    )
    .addSubcommand(sub =>
      sub.setName('apercu')
        .setDescription('Voir une récompense sans dépenser la box du jour')
        .addStringOption(currencyOption)
        .addIntegerOption(rarityOption)
    ),

  base('activite', 'Configurer les gains XP automatiques')
    .addSubcommand(sub =>
      sub.setName('configurer')
        .setDescription('Modifier les points et le délai')
        .addIntegerOption(option =>
          option.setName('message').setDescription('XP par message')
            .setMinValue(0).setMaxValue(1000)
        )
        .addIntegerOption(option =>
          option.setName('media')
            .setDescription('Bonus XP pour une image ou vidéo jointe')
            .setMinValue(0).setMaxValue(1000)
        )
        .addIntegerOption(option =>
          option.setName('reaction').setDescription('XP par réaction')
            .setMinValue(0).setMaxValue(1000)
        )
        .addIntegerOption(option =>
          option.setName('invitation')
            .setDescription('XP par invitation attribuée sans ambiguïté')
            .setMinValue(0).setMaxValue(10000)
        )
        .addIntegerOption(option =>
          option.setName('delai').setDescription('Délai entre gains, en secondes')
            .setMinValue(10).setMaxValue(86400)
        )
        .addBooleanOption(option =>
          option.setName('active').setDescription('Activer les gains d’activité')
        )
    )
    .addSubcommand(sub =>
      sub.setName('voir').setDescription('Afficher les réglages actuels')
    ),

  base('profil', 'Voir tes XP, coins et positions', false)
    .addUserOption(option =>
      option.setName('membre').setDescription('Autre membre facultatif')
    ),
];

function questId(value) {
  if (/^\d{17,20}$/.test(value)) return value;

  const match = value.match(
    /^https:\/\/discord.com\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?$/
  );

  if (!match || match[1] !== GUILD) {
    throw new UserError(
      'Donne l’identifiant ou le lien du fil de ce serveur.'
    );
  }

  return match[2];
}

function position(id, currency) {
  const record = user(id);
  const amount = record[currency];

  if (!amount) {
    return `0 ${currency === 'xp' ? 'XP' : 'coins'} · pas encore classé`;
  }

  const above = get(
    `SELECT COUNT(*) AS n
     FROM users
     WHERE ${currency}>?
        OR (${currency}=? AND id<?)`,
    amount, amount, id
  ).n;

  return (
    `**${amount.toLocaleString('fr-FR')} ` +
    `${currency === 'xp' ? 'XP' : 'coins'}** · ` +
    `position **#${above + 1}**`
  );
}

async function createQuest(i, draft) {
  const title = i.fields.getTextInputValue('titre').trim();
  const body = i.fields.getTextInputValue('texte').trim();

  if (!title || !body) {
    throw new UserError(
      'Le titre et le texte ne peuvent pas être vides.'
    );
  }

  const forum = await i.guild.channels.fetch(draft.forum);

  if (!forum || forum.type !== C.GuildForum) {
    throw new UserError('Forum introuvable.');
  }

  permission(forum, [
    P.ViewChannel,
    P.SendMessages,
    P.SendMessagesInThreads,
    P.ReadMessageHistory,
    P.EmbedLinks,
  ]);

  const appliedTags = [];

  if (draft.tag) {
    const tag = forum.availableTags.find(
      candidate => candidate.name === draft.tag
    );

    if (!tag) {
      throw new UserError(
        'Tag introuvable. Recrée la quête avec le nom exact du tag.'
      );
    }

    if (
      tag.moderated &&
      !forum.permissionsFor(client.user).has(P.ManageThreads)
    ) {
      throw new UserError('Ce tag exige Gérer les fils.');
    }

    appliedTags.push(tag.id);
  }

  if (forum.flags.has('RequireTag') && !appliedTags.length) {
    throw new UserError(
      'Ce forum exige un tag. Recrée la quête avec l’option tag.'
    );
  }

  const formats = {
    image: 'image jointe',
    video: 'vidéo jointe',
    media: 'image ou vidéo jointe',
    texte: 'texte',
  };

  const embed = new EmbedBuilder()
    .setColor(draft.color ?? 0x5865f2)
    .setTitle(title)
    .setDescription(body)
    .addFields(
      {
        name: 'Récompense',
        value: rewardLabel(draft.xp, draft.coins),
      },
      {
        name: 'Participation',
        value:
          `Format : **${formats[draft.format]}**.\n` +
          'Une récompense par membre. Attribution automatique ' +
          'selon le format, sans vérification de la preuve.',
      }
    );

  const files = [];

  if (draft.image) {
    permission(forum, [P.AttachFiles]);

    const url = new URL(draft.image.url);

    if (
      !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
      url.protocol !== 'https:'
    ) {
      throw new UserError('Image Discord invalide.');
    }

    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });

    if (!response.ok) {
      throw new UserError(
        'Image expirée ou inaccessible. Recrée la quête avec l’image jointe.'
      );
    }

    const reader = response.body.getReader();
    const parts = [];
    let size = 0;

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      size += value.length;

      if (size > 8 * 1024 * 1024) {
        await reader.cancel();

        throw new UserError(
          'Image trop volumineuse : maximum 8 Mo.'
        );
      }

      parts.push(value);
    }

    const name = `quete.${draft.image.ext}`;

    files.push(
      new AttachmentBuilder(
        Buffer.concat(parts),
        { name }
      )
    );

    embed.setImage(`attachment://${name}`);
  }

  if (!run(
    'DELETE FROM drafts WHERE id=?',
    draft.id
  ).changes) {
    throw new UserError('Formulaire déjà envoyé.');
  }

  const thread = await forum.threads.create({
    name: title,
    appliedTags,
    message: {
      embeds: [embed],
      files,
      allowedMentions: noPing,
    },
  });

  run(
    `INSERT INTO quests(id,title,format,xp,coins,cursor)
     VALUES (?,?,?,?,?,?)`,
    thread.id, title, draft.format,
    draft.xp, draft.coins, thread.id
  );

  audit(i.user.id, 'creation_quete', {
    thread: thread.id,
  });

  await i.editReply(
    `Quête créée : <#${thread.id}>. ` +
    `Récompense : **${rewardLabel(draft.xp, draft.coins)}**.`
  );
}

async function interaction(i) {
  if (i.guildId !== GUILD) return;

  const supported = i.isChatInputCommand()
    ? commands.some(command => command.name === i.commandName)
    : (
        (i.isButton() || i.isModalSubmit()) &&
        /^(position:|box:|quest:|tiers:|boxstyle:|rarity:|delete:|reset:)/.test(
          i.customId
        )
      );

  if (!supported) return;

  try {
    if (!ready || stopping) {
      await i.reply({
        content: 'Le bot démarre. Réessaie dans quelques instants.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const publicControl =
      i.isButton() &&
      /^(position:|box:)/.test(i.customId);

    if (
      !publicControl &&
      !(i.isChatInputCommand() && i.commandName === 'profil')
    ) {
      admin(i);
    }

    if (i.isChatInputCommand()) {
      const cmd = i.commandName;
      const sub = cmd === 'profil' ? '' : i.options.getSubcommand();

      if (cmd === 'quete' && sub === 'creer') {
        const xp = i.options.getInteger('xp') || 0;
        const coins = i.options.getInteger('coins') || 0;

        if (!xp && !coins) {
          throw new UserError(
            'Indique une récompense XP et/ou coins supérieure à zéro.'
          );
        }

        const attachment = i.options.getAttachment('image');

        if (
          attachment &&
          (
            !attachment.contentType?.startsWith('image/') ||
            attachment.size > 8 * 1024 * 1024
          )
        ) {
          throw new UserError('Joins une image de 8 Mo maximum.');
        }

        const id = randomUUID();

        const draft = {
          id,
          color: color(i.options.getString('couleur')),
          forum: i.options.getChannel('forum').id,
          format: i.options.getString('format'),
          xp,
          coins,
          tag: i.options.getString('tag'),
          image: attachment
            ? {
                url: attachment.url,
                ext: ({
                  'image/jpeg': 'jpg',
                  'image/png': 'png',
                  'image/gif': 'gif',
                  'image/webp': 'webp',
                })[attachment.contentType] || 'png',
              }
            : null,
        };

        run(
          'INSERT INTO drafts VALUES (?,?,?,?)',
          id, i.user.id,
          Date.now() + 20 * 60000,
          JSON.stringify(draft)
        );

        await i.showModal(
          modal(
            `quest:${id}`,
            'Créer une quête',
            input(
              'titre', 'Titre de la quête',
              TextInputStyle.Short, 100
            ),
            input(
              'texte', 'Texte de la quête (retours à la ligne libres)',
              TextInputStyle.Paragraph, 3800
            )
          )
        );

        return;
      }

      if (cmd === 'lootbox' && sub === 'configurer') {
        const currency = i.options.getString('monnaie');
        const tiers = tiersFor(currency);

        await i.showModal(
          modal(
            `tiers:${currency}`,
            'Raretés : chance % ; récompense',
            ...tiers.map((tier, index) =>
              input(
                `t${index}`,
                `${tier.name.slice(0, 17)} : chance % ; récompense`,
                TextInputStyle.Short,
                20,
                true,
                `${tier.chance};${tier.amount}`
              )
            )
          )
        );

        return;
      }

      if (cmd === 'lootbox' && sub === 'personnaliser') {
        const currency = i.options.getString('monnaie');
        const style = boxStyle(currency);

        await i.showModal(
          modal(
            `boxstyle:${currency}`,
            'Personnaliser la lootbox',
            input(
              'titre', 'Titre de la lootbox',
              TextInputStyle.Short, 100, true, style.title
            ),
            input(
              'description',
              'Description (Markdown et retours à la ligne)',
              TextInputStyle.Paragraph, 2000, false,
              style.description
            ),
            input(
              'couleur', 'Couleur HEX, exemple #FFD700',
              TextInputStyle.Short, 7, true, hex(style.color)
            )
          )
        );

        return;
      }

      if (cmd === 'lootbox' && sub === 'rarete') {
        const currency = i.options.getString('monnaie');
        const index = i.options.getInteger('rarete');
        const tier = tiersFor(currency)[index];
        const image = i.options.getAttachment('image');

        if (image && image.size > 8 * 1024 * 1024) {
          throw new UserError(
            'Image trop volumineuse : maximum 8 Mo.'
          );
        }

        const id = randomUUID();

        run(
          'INSERT INTO drafts VALUES (?,?,?,?)',
          id, i.user.id,
          Date.now() + 20 * 60000,
          JSON.stringify({
            currency,
            index,
            image: image
              ? { url: image.url, size: image.size }
              : null,
          })
        );

        await i.showModal(
          modal(
            `rarity:${id}`,
            'Personnaliser la récompense',
            input(
              'nom', 'Nom de cette récompense',
              TextInputStyle.Short, 80, true, tier.name
            ),
            input(
              'description',
              'Description (Markdown et retours à la ligne)',
              TextInputStyle.Paragraph, 2000, false,
              tier.description
            ),
            input(
              'couleur', 'Couleur HEX, exemple #FFD700',
              TextInputStyle.Short, 7, true, hex(tier.color)
            )
          )
        );

        return;
      }
    }

    await i.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    if (i.isModalSubmit()) {
      if (i.customId.startsWith('quest:')) {
        const record = get(
          'SELECT * FROM drafts WHERE id=?',
          i.customId.slice(6)
        );

        if (
          !record ||
          record.user !== i.user.id ||
          record.expires < Date.now()
        ) {
          throw new UserError(
            'Formulaire expiré. Relance /quete creer.'
          );
        }

        await createQuest(i, JSON.parse(record.data));
        return;
      }

      if (i.customId.startsWith('boxstyle:')) {
        const currency = i.customId.split(':')[1];

        if (!['xp', 'coins'].includes(currency)) {
          throw new UserError('Monnaie invalide.');
        }

        const style = boxStyle(currency);
        const title = i.fields.getTextInputValue('titre').trim();

        if (!title) {
          throw new UserError('Le titre ne peut pas être vide.');
        }

        style.title = title;
        style.description = i.fields.getTextInputValue('description').trim();
        style.color = color(i.fields.getTextInputValue('couleur'));

        set(`boxstyle:${currency}`, style);
        await updateBoxes(currency);

        await i.editReply(
          'Titre, description et couleur enregistrés. ' +
          'Les messages de lootbox accessibles ont été actualisés.'
        );

        return;
      }

      if (i.customId.startsWith('rarity:')) {
        const id = i.customId.slice(7);

        const record = get(
          'SELECT * FROM drafts WHERE id=?',
          id
        );

        if (
          !record ||
          record.user !== i.user.id ||
          record.expires < Date.now()
        ) {
          throw new UserError(
            'Formulaire expiré. Relance /lootbox rarete.'
          );
        }

        const draft = JSON.parse(record.data);
        const name = i.fields.getTextInputValue('nom').trim();

        if (!name) {
          throw new UserError(
            'Le nom de la récompense ne peut pas être vide.'
          );
        }

        const tierColor = color(
          i.fields.getTextInputValue('couleur')
        );

        if (!run(
          'DELETE FROM drafts WHERE id=?',
          id
        ).changes) {
          throw new UserError('Formulaire déjà envoyé.');
        }

        const imageId = draft.image
          ? await importAsset(draft.image)
          : null;

        const tiers = tiersFor(draft.currency);
        const tier = tiers[draft.index];

        tier.name = name;
        tier.description = i.fields.getTextInputValue('description').trim();
        tier.color = tierColor;

        if (imageId) tier.image = imageId;

        set(`tiers:${draft.currency}`, tiers);
        await updateBoxes(draft.currency);

        await i.editReply({
          content: 'Récompense personnalisée. Aperçu ci-dessous :',
          ...resultMessage(
            i.user.id,
            draft.currency,
            tier,
            boxStyle(draft.currency),
            true
          ),
        });

        return;
      }

      const currency = i.customId.slice(6);

      if (!['xp', 'coins'].includes(currency)) {
        throw new UserError('Monnaie invalide.');
      }

      const tiers = tiersFor(currency).map((tier, index) => {
        const match = i.fields.getTextInputValue(`t${index}`)
          .trim()
          .match(/^(\d{1,3})\s*;\s*(\d{1,7})$/);

        if (
          !match ||
          Number(match[1]) > 100 ||
          Number(match[2]) < 1 ||
          Number(match[2]) > 1000000
        ) {
          throw new UserError(
            'Chaque ligne doit être au format chance;récompense, ' +
            'par exemple 60;25.'
          );
        }

        return {
          ...tier,
          chance: Number(match[1]),
          amount: Number(match[2]),
        };
      });

      if (
        tiers.reduce((sum, tier) => sum + tier.chance, 0) !== 100
      ) {
        throw new UserError(
          'La somme des cinq probabilités doit être exactement 100 %.'
        );
      }

      if (
        tiers.some(
          (tier, index) =>
            index && tier.amount <= tiers[index - 1].amount
        )
      ) {
        throw new UserError(
          'Les récompenses doivent augmenter avec la rareté.'
        );
      }

      set(`tiers:${currency}`, tiers);

      audit(i.user.id, 'rareté', {
        currency,
        tiers,
      });

      await updateBoxes(currency);

      await i.editReply(
        'Chances et gains enregistrés. ' +
        'Les noms, images et descriptions sont conservés.'
      );

      return;
    }

    if (i.isButton()) {
      const [action, arg, owner] = i.customId.split(':');

      if (action === 'position') {
        if (!['xp', 'coins'].includes(arg)) {
          throw new UserError('Monnaie invalide.');
        }

        await i.editReply(position(i.user.id, arg));
        return;
      }

      if (action === 'box') {
        const box = get(
          'SELECT * FROM boxes WHERE message=?',
          i.message.id
        );

        if (!box || box.currency !== arg) {
          throw new UserError(
            'Cette lootbox n’est plus disponible.'
          );
        }

        if (!box.channel && i.channelId) {
          run(
            'UPDATE boxes SET channel=? WHERE message=?',
            i.channelId,
            i.message.id
          );
        }

        const tier = openBox(i.user.id, box.currency);
        await animateBox(i, box.currency, tier);
        return;
      }

      if (
        owner !== i.user.id ||
        Date.now() - i.message.createdTimestamp > 5 * 60000
      ) {
        throw new UserError(
          'Confirmation réservée à son auteur et valable 5 minutes.'
        );
      }

      if (!run(
        'INSERT OR IGNORE INTO events VALUES (?,?)',
        `confirm:${i.message.id}`,
        Date.now()
      ).changes) {
        throw new UserError('Confirmation déjà utilisée.');
      }

      if (action === 'reset') {
        if (!['xp', 'coins', 'tout'].includes(arg)) {
          throw new UserError('Monnaie invalide.');
        }

        transaction(() => {
          db.exec(
            arg === 'tout'
              ? 'UPDATE users SET xp=0,coins=0'
              : `UPDATE users SET ${arg}=0`
          );

          audit(i.user.id, 'reset', {
            currency: arg,
          });
        });

        await refreshBoards(true);

        await i.editReply(
          'Soldes remis à zéro. Les quêtes déjà validées et ' +
          'la box du jour restent marquées comme utilisées.'
        );

        return;
      }

      if (action === 'delete') {
        const quest = get(
          'SELECT * FROM quests WHERE id=?',
          arg
        );

        if (!quest) throw new UserError('Quête introuvable.');

        run(
          'UPDATE quests SET active=0 WHERE id=?',
          arg
        );

        const thread = await i.guild.channels.fetch(arg).catch(e => {
          if (Number(e.code) === 10003) return null;
          throw e;
        });

        if (thread) {
          await thread.delete('Suppression de quête confirmée');
        }

        audit(i.user.id, 'suppression_quete', {
          thread: arg,
        });

        await i.editReply(
          'Post supprimé. Les points déjà gagnés sont conservés.'
        );

        return;
      }
    }

    const cmd = i.commandName;
    const sub = cmd === 'profil' ? '' : i.options.getSubcommand();
    const currency = i.options.getString('monnaie');

    if (cmd === 'profil') {
      const member = i.options.getUser('membre') || i.user;

      await i.editReply({
        content:
          `<@${member.id}>\n` +
          `${position(member.id, 'xp')}\n` +
          position(member.id, 'coins'),
        allowedMentions: noPing,
      });

      return;
    }

    if (cmd === 'quete') {
      if (sub === 'liste') {
        const quests = all(
          `SELECT * FROM quests
           ORDER BY active DESC,id DESC
           LIMIT 40`
        );

        const text = quests.map(
          quest =>
            `<#${quest.id}> · ` +
            `${rewardLabel(quest.xp, quest.coins)} · ` +
            `${quest.active ? 'ouverte' : 'fermée'}`
        ).join('\n');

        await i.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle('Quêtes (40 dernières maximum)')
              .setDescription(text || 'Aucune quête créée.'),
          ],
        });

        return;
      }

      const id = questId(i.options.getString('fil'));
      const quest = get('SELECT * FROM quests WHERE id=?', id);

      if (!quest) {
        throw new UserError(
          'Ce fil n’est pas une quête créée par ce bot.'
        );
      }

      if (sub === 'supprimer') {
        await i.editReply({
          content:
            'Supprimer définitivement ce post ? ' +
            'Les points gagnés seront conservés.',
          components: [
            row(button(
              `delete:${id}:${i.user.id}`,
              'Confirmer la suppression',
              ButtonStyle.Danger
            )),
          ],
        });

        return;
      }

      run('UPDATE quests SET active=0 WHERE id=?', id);

      const thread = await i.guild.channels.fetch(id);

      if (thread) {
        await thread.setLocked(true, 'Quête fermée');
        await thread.setArchived(true, 'Quête fermée');
      }

      audit(i.user.id, 'fermeture_quete', {
        thread: id,
      });

      await i.editReply(
        'Quête fermée : aucune nouvelle récompense.'
      );

      return;
    }

    if (cmd === 'classement') {
      if (sub === 'actualiser') {
        await refreshBoards(true);

        await i.editReply(
          'Actualisation demandée. ' +
          'Les erreurs éventuelles sont signalées dans les logs.'
        );

        return;
      }

      const selectedColor = i.options.getString('couleur');
      const image = i.options.getAttachment('image');

      const parsedColor = selectedColor
        ? color(selectedColor)
        : null;

      const imageId = image ? await importAsset(image) : null;

      if (parsedColor !== null) {
        set(`boardcolor:${currency}`, parsedColor);
      }

      if (imageId) {
        set(`boardimage:${currency}`, imageId);
      }

      if (sub === 'apparence') {
        await refreshBoards(true);

        await i.editReply(
          'Apparence du classement enregistrée. ' +
          'Les classements accessibles ont été actualisés.'
        );

        return;
      }

      const channel = i.options.getChannel('salon');

      permission(channel, [
        P.ViewChannel,
        P.SendMessages,
        P.EmbedLinks,
        P.ReadMessageHistory,
      ]);

      if (setting(`boardimage:${currency}`, null)) {
        permission(channel, [P.AttachFiles]);
      }

      const existing = get(
        'SELECT * FROM boards WHERE currency=?',
        currency
      );

      if (existing && existing.channel === channel.id) {
        const message = await channel.messages.fetch(
          existing.message
        ).catch(e => {
          if (Number(e.code) === 10008) return null;
          throw e;
        });

        if (message) {
          await message.edit(leaderboard(currency));

          run(
            'UPDATE boards SET day=? WHERE currency=?',
            paris().day,
            currency
          );

          await i.editReply('Classement existant actualisé.');
          return;
        }
      }

      const message = await channel.send(leaderboard(currency));

      run(
        `INSERT INTO boards VALUES (?,?,?,?)
         ON CONFLICT(currency) DO UPDATE SET
           channel=excluded.channel,
           message=excluded.message,
           day=excluded.day`,
        currency, channel.id, message.id, paris().day
      );

      if (existing) {
        try {
          const old = await client.channels.fetch(existing.channel);
          const oldMessage = await old.messages.fetch(existing.message);

          await oldMessage.edit({
            content: 'Ce classement a été déplacé.',
            embeds: [],
            components: [],
          });
        } catch (e) {
          error('Ancien classement', e);
        }
      }

      await i.editReply(`Classement publié : ${message.url}`);
      return;
    }

    if (cmd === 'points') {
      if (sub === 'reset') {
        await i.editReply({
          content:
            `Remettre ${
              currency === 'tout' ? 'les XP et les coins' : currency
            } de tous les membres à zéro ?`,
          components: [
            row(button(
              `reset:${currency}:${i.user.id}`,
              'Confirmer la remise à zéro',
              ButtonStyle.Danger
            )),
          ],
        });

        return;
      }

      const member = i.options.getUser('membre');

      if (member.bot) {
        throw new UserError(
          'Les bots ne participent pas aux classements.'
        );
      }

      const amount = i.options.getInteger('montant');

      transaction(() => {
        const balance = user(member.id)[currency];

        if (sub === 'retirer' && amount > balance) {
          throw new UserError(
            `Ce membre n’a que ${balance} ${currency}.`
          );
        }

        const delta = sub === 'ajouter' ? amount : -amount;

        add(
          member.id,
          currency === 'xp' ? delta : 0,
          currency === 'coins' ? delta : 0
        );

        audit(i.user.id, sub, {
          member: member.id,
          currency,
          amount,
        });
      });

      await i.editReply({
        content:
          `Solde modifié pour <@${member.id}> : ` +
          `${position(member.id, currency)}.`,
        allowedMentions: noPing,
      });

      return;
    }

    if (cmd === 'lootbox') {
      if (sub === 'apercu') {
        const tier = tiersFor(currency)[
          i.options.getInteger('rarete')
        ];

        await i.editReply(
          resultMessage(
            i.user.id, currency, tier,
            boxStyle(currency), true
          )
        );

        return;
      }

      const style = await styleFromOptions(i, currency);

      if (sub === 'visuels') {
        const seconds = i.options.getInteger('secondes');

        if (seconds !== null) {
          style.seconds = seconds;
          set(`boxstyle:${currency}`, style);
        }

        await updateBoxes(currency);

        const preview = boxMessage(currency);
        preview.components = [];

        await i.editReply({
          content:
            `Visuels enregistrés. Le GIF s’affichera pendant ` +
            `${style.seconds} secondes avant la récompense.`,
          ...preview,
        });

        return;
      }

      const channel = i.options.getChannel('salon');

      permission(channel, [
        P.ViewChannel,
        P.SendMessages,
        P.EmbedLinks,
      ]);

      if (style.image) permission(channel, [P.AttachFiles]);

      const title = i.options.getString('titre');

      const message = await channel.send(
        boxMessage(currency, title || undefined)
      );

      run(
        `INSERT INTO boxes(message,currency,channel,title)
         VALUES (?,?,?,?)`,
        message.id, currency, channel.id, title
      );

      await i.editReply(`Lootbox publiée : ${message.url}`);
      return;
    }

    if (cmd === 'activite') {
      const config = {
        ...setting('activity', defaults),
      };

      if (sub === 'configurer') {
        for (const key of [
          'message', 'media', 'reaction', 'invitation', 'delai',
        ]) {
          const value = i.options.getInteger(key);
          if (value !== null) config[key] = value;
        }

        const active = i.options.getBoolean('active');
        if (active !== null) config.active = active;
      }

      delete config.channels;
      set('activity', config);

      await i.editReply({
        content:
          `Activité : **${config.active ? 'active' : 'désactivée'}**\n` +
          `Message : ${config.message} XP\n` +
          `Bonus image/vidéo : ${config.media} XP\n` +
          `Réaction : ${config.reaction} XP\n` +
          `Invitation : ${config.invitation} XP\n` +
          `Délai : ${config.delai} s\n` +
          'Les gains s’appliquent à tous les salons accessibles du serveur.',
        allowedMentions: noPing,
      });
    }
  } catch (e) {
    error('Commande', e);

    const content = e instanceof UserError
      ? e.message
      : [50001, 50013].includes(Number(e.code))
        ? 'Permissions insuffisantes. Vérifie les permissions du bot dans ce salon.'
        : 'Opération non confirmée. Vérifie le salon et /profil avant de réessayer : une récompense déjà enregistrée reste conservée. Consulte les logs Railway.';

    try {
      if (i.deferred || i.replied) {
        await i.editReply({
          content,
          embeds: [],
          components: [],
          attachments: [],
        });
      } else {
        await i.reply({
          content,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (failure) {
      error('Réponse Discord', failure);
    }
  }
}

let catchingUp = false;

async function catchUpQuests() {
  if (catchingUp) return;
  catchingUp = true;

  try {
    for (const quest of all(
      'SELECT * FROM quests WHERE active=1'
    )) {
      if (stopping) break;

      try {
        const thread = await client.channels.fetch(quest.id);

        permission(thread, [
          P.ViewChannel,
          P.ReadMessageHistory,
        ]);

        const pending = [];
        let before;
        let complete = false;

        for (let page = 0; page < 100; page++) {
          const batch = await thread.messages.fetch({
            limit: 100,
            ...(before ? { before } : {}),
            cache: false,
          });

          const rows = [...batch.values()];

          pending.push(
            ...rows.filter(
              message =>
                BigInt(message.id) > BigInt(quest.cursor)
            )
          );

          if (
            rows.length < 100 ||
            rows.some(
              message =>
                BigInt(message.id) <= BigInt(quest.cursor)
            )
          ) {
            complete = true;
            break;
          }

          before = rows.reduce(
            (a, b) => BigInt(a.id) < BigInt(b.id) ? a : b
          ).id;
        }

        if (!complete) {
          console.error(
            `Rattrapage incomplet du fil ${quest.id} : ` +
            'plus de 10 000 messages. Aucun curseur avancé.'
          );

          continue;
        }

        pending.sort(
          (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1
        );

        for (const message of pending) {
          await processMessage(message, true);

          run(
            'UPDATE quests SET cursor=? WHERE id=?',
            message.id,
            quest.id
          );
        }
      } catch (e) {
        error(`Rattrapage quête ${quest.id}`, e);
      }
    }
  } finally {
    catchingUp = false;
  }
}

client.on(
  Events.InteractionCreate,
  i => task('Interaction', () => interaction(i))
);

client.on(
  Events.MessageCreate,
  message => task('Message', () => processMessage(message))
);

client.on(
  Events.MessageUpdate,
  (_old, message) => task('Modification', async () => {
    if (message.partial) message = await message.fetch();
    await processMessage(message, true);
  })
);

client.on(
  Events.MessageReactionAdd,
  (reaction, author) => task(
    'Réaction',
    () => processReaction(reaction, author)
  )
);

client.on(
  Events.GuildMemberAdd,
  member => task(
    'Arrivée',
    () => queueInvite(() => join(member))
  )
);

client.on(Events.InviteCreate, invite => {
  if (invite.guild.id === GUILD && invites) {
    invites.set(invite.code, {
      uses: invite.uses || 0,
      inviter: invite.inviter?.id,
      bot: invite.inviter?.bot,
    });
  }
});

client.on(Events.InviteDelete, () => {
  // Une invitation disparue rend l'attribution incertaine.
});

client.on(Events.ShardResume, () => {
  task('Rattrapage', catchUpQuests);
});

client.on(
  Events.Error,
  e => error('Discord', e)
);

async function main() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Connexion Discord trop longue')),
      60000
    );

    client.once(Events.ClientReady, () => {
      clearTimeout(timeout);
      resolve();
    });

    client.login(TOKEN).catch(e => {
      clearTimeout(timeout);
      reject(e);
    });
  });

  const guild = client.guilds.cache.get(GUILD);

  if (!guild) {
    throw new Error(
      'Bot absent du serveur configuré. ' +
      'Vérifie DISCORD_GUILD_ID et l’invitation.'
    );
  }

  for (const command of commands) {
    await guild.commands.create(command.toJSON());
  }

  try {
    invites = await inviteSnapshot(guild);
  } catch (e) {
    error('Suivi des invitations désactivé', e);
  }

  if (!invites) {
    console.warn(
      'Invitations : suivi indisponible ' +
      '(permission Gérer le serveur manquante ou lien personnalisé). ' +
      'Les autres fonctions restent actives.'
    );
  }

  ready = true;

  console.log(
    `Bot quêtes prêt : ${client.user.tag}. ` +
    'Actualisation des classements à 10 h Europe/Paris.'
  );

  task('Rattrapage initial', catchUpQuests);

  task(
    'Classements au démarrage',
    () => refreshBoards()
  );

  clock = setInterval(() => {
    task(
      'Classements quotidiens',
      () => refreshBoards()
    );

    if (++ticks % 10 === 0) {
      task(
        'Rattrapage périodique des quêtes',
        catchUpQuests
      );
    }

    run(
      'DELETE FROM drafts WHERE expires<?',
      Date.now()
    );
  }, 30000);
}

async function shutdown(code = 0) {
  if (stopping) return;

  stopping = true;
  ready = false;
  clearInterval(clock);

  const timer = setTimeout(
    () => process.exit(code),
    25000
  );

  await Promise.allSettled([...jobs]);

  client.destroy();
  db.close();

  clearTimeout(timer);
  process.exit(code);
}

process.once('SIGTERM', () => {
  void shutdown();
});

process.once('SIGINT', () => {
  void shutdown();
});

process.once('uncaughtException', e => {
  error('Erreur fatale', e);
  void shutdown(1);
});

process.once('unhandledRejection', e => {
  error('Erreur fatale', e);
  void shutdown(1);
});

if (require.main === module) {
  main().catch(e => {
    console.error(
      e.code === 'DisallowedIntents' || e.code === 4014
        ? 'Active SERVER MEMBERS INTENT et MESSAGE CONTENT INTENT dans Discord Developer Portal.'
        : `Démarrage : ${e.message}`
    );

    void shutdown(1);
  });
}
