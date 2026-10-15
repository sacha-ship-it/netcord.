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
  StringSelectMenuBuilder, ChannelSelectMenuBuilder,
  LabelBuilder, FileUploadBuilder,
} = require('discord.js');

function required(name) {
  const value = process.env[name]?.trim();

  if (!value || /REMPLACE|A_COMPLETER/.test(value)) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

const TOKEN = required('DISCORD_TOKEN');
const GUILD = required('DISCORD_GUILD_ID');

if (!/^\d{17,20}$/.test(GUILD)) {
  throw new Error('Invalid DISCORD_GUILD_ID.');
}

const directory = path.join(__dirname, 'data');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

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
    xp INTEGER NOT NULL DEFAULT 0 CHECK(xp>=0),
    coins INTEGER NOT NULL DEFAULT 0 CHECK(coins>=0),
    message_at INTEGER NOT NULL DEFAULT 0,
    reaction_at INTEGER NOT NULL DEFAULT 0,
    loot_day TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS users_xp ON users(xp DESC,id);
  CREATE INDEX IF NOT EXISTS users_coins ON users(coins DESC,id);

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
  const record = get('SELECT value FROM settings WHERE key=?', key);
  return record ? JSON.parse(record.value) : fallback;
}

function set(key, value) {
  run(
    'INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key,
    JSON.stringify(value)
  );
}

if (!setting('guild', null)) set('guild', GUILD);

if (setting('guild') !== GUILD) {
  throw new Error('This database belongs to another server.');
}

function audit(actor, action, detail) {
  run(
    'INSERT INTO audit(created,actor,action,detail) VALUES (?,?,?,?)',
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

  if (![old.xp + xp, old.coins + coins].every(
    n => Number.isSafeInteger(n) && n >= 0
  )) {
    throw new Error('Balance out of range.');
  }

  run(
    'UPDATE users SET xp=xp+?,coins=coins+? WHERE id=?',
    xp,
    coins,
    id
  );
}

class UserError extends Error {}

function error(where, e) {
  console.error(`${where}: ${e.code || e.name || 'Error'}`);
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
  { name: 'Common', chance: 60, amount: 25, color: 0x95a5a6 },
  { name: 'Uncommon', chance: 25, amount: 50, color: 0x2ecc71 },
  { name: 'Rare', chance: 10, amount: 100, color: 0x3498db },
  { name: 'Epic', chance: 4, amount: 250, color: 0x9b59b6 },
  { name: 'Legendary', chance: 1, amount: 500, color: 0xf1c40f },
];

const rarityLevels = [
  'COMMON',
  'UNCOMMON',
  'RARE',
  'EPIC',
  'LEGENDARY',
];

const rarityIcons = ['⚪', '🟢', '🔵', '🟣', '🟡'];

function pick(tiers) {
  let roll = randomInt(100);

  for (const tier of tiers) {
    if (roll < tier.chance) return tier;
    roll -= tier.chance;
  }

  throw new Error('Invalid probabilities.');
}

function color(value, fallback = 0x5865f2) {
  if (!value?.trim()) return fallback;

  const text = value.trim().replace(/^#/, '');

  if (!/^[0-9a-f]{6}$/i.test(text)) {
    throw new UserError(
      'Enter a HEX color such as #E91E63 or #FFD700.'
    );
  }

  return parseInt(text, 16);
}

function hex(value) {
  return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
}

// Translate previously saved built-in defaults without changing balances or settings.
const legacyDefaults = {
  'Commune': 'Common',
  'Peu commune': 'Uncommon',
  '\u00c9pique': 'Epic',
  'L\u00e9gendaire': 'Legendary',
  '\ud83c\udf81 TON COFFRE DU JOUR': '🎁 YOUR DAILY CHEST',
  'Ton coffre du jour est pr\u00eat. Ouvre-le et d\u00e9couvre la r\u00e9compense qui t\u2019attend \u2728\n\nPlus le coffre est rare, plus tu gagnes de points.':
    'Your daily chest is ready. Open it and discover your reward ✨\n\nThe rarer the chest, the more points you earn.',
};

const englishDefault = value =>
  Object.hasOwn(legacyDefaults, value) ? legacyDefaults[value] : value;

function tiersFor(currency) {
  return setting(`tiers:${currency}`, tiersDefault).map((t, n) => ({
    ...tiersDefault[n],
    description: '',
    image: null,
    ...t,
    name: englishDefault(t.name || tiersDefault[n].name),
    description: englishDefault(t.description || ''),
    slot: n,
  }));
}

function boxStyle(currency) {
  const style = {
    title: '🎁 YOUR DAILY CHEST',
    description:
      'Your daily chest is ready. Open it and discover your reward ✨\n\n' +
      'The rarer the chest, the more points you earn.',
    color: 0xf1c40f,
    image: null,
    animation: null,
    seconds: 3,
    ...setting(`boxstyle:${currency}`, {}),
  };

  style.title = englishDefault(style.title);
  style.description = englishDefault(style.description);

  return style;
}

function validTiers(tiers) {
  if (
    tiers.length !== 5 ||
    tiers.reduce((sum, t) => sum + t.chance, 0) !== 100
  ) {
    throw new UserError(
      'The chances for all five chests must add up to 100%. ' +
      'Open /lootbox, then Chances and rewards.'
    );
  }

  if (tiers.some((t, n) =>
    !Number.isInteger(t.chance) ||
    t.chance < 0 ||
    t.chance > 100 ||
    !Number.isInteger(t.amount) ||
    t.amount < 1 ||
    t.amount > 1000000 ||
    (n && t.amount <= tiers[n - 1].amount)
  )) {
    throw new UserError(
      'Rewards must increase with rarity. ' +
      'Update the values in /lootbox.'
    );
  }
}

function readyBox(currency) {
  const tiers = tiersFor(currency);
  validTiers(tiers);

  if (tiers.some(t =>
    !t.image ||
    !get('SELECT id FROM assets WHERE id=?', t.image)
  )) {
    throw new UserError(
      'A reward image is missing. Open /lootbox and upload ' +
      'a dedicated image for each of the five chests.'
    );
  }

  const style = boxStyle(currency);

  if (
    !style.image ||
    !style.animation ||
    !get('SELECT id FROM assets WHERE id=?', style.image) ||
    !get('SELECT id FROM assets WHERE id=?', style.animation)
  ) {
    throw new UserError(
      'Add the welcome image and opening GIF ' +
      'in /lootbox → Images and GIF.'
    );
  }
}

async function importAsset(attachment, gifOnly = false) {
  if (!attachment || attachment.size > 8 * 1024 * 1024) {
    throw new UserError('File too large: maximum 8 MB.');
  }

  const url = new URL(attachment.url);

  if (
    url.protocol !== 'https:' ||
    !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
  ) {
    throw new UserError(
      'Attach the file directly to the Discord command.'
    );
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });

  if (!response.ok) {
    throw new UserError(
      'File unavailable. Attach it to the command again.'
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
      throw new UserError('File too large: maximum 8 MB.');
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
        ? 'Upload a GIF for the opening animation. ' +
          'MP4 videos do not autoplay in this embed.'
        : 'Supported formats: PNG, JPG, WEBP or GIF.'
    );
  }

  const id = randomUUID();

  run(
    'INSERT INTO assets VALUES (?,?,?)',
    id,
    `visual-${id}.${ext}`,
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
      new AttachmentBuilder(Buffer.from(asset.bytes), {
        name: asset.name,
      }),
    ],
    attachments: [],
    allowedMentions: noPing,
  };
}

function resultMessage(id, currency, tier, style, preview = false) {
  const embed = new EmbedBuilder()
    .setColor(tier.color)
    .setAuthor({
      name:
        `${rarityIcons[tier.slot] || '🎁'} ` +
        `${rarityLevels[tier.slot] || 'CHEST'} ` +
        `${preview ? '· PREVIEW' : '· CHEST REVEALED'}`,
    })
    .setTitle(tier.name)
    .setDescription([
      `**+${tier.amount.toLocaleString('en-US')} ${
        currency === 'xp' ? 'XP' : 'COINS'
      }**`,
      tier.description ||
        'A new reward to boost your score!',
      preview
        ? '*Preview: no points awarded.*'
        : '✅ Your reward has been added to your balance.',
    ].filter(Boolean).join('\n\n'))
    .addFields(
      {
        name: '💰 Reward',
        value:
          `**+${tier.amount.toLocaleString('en-US')} ` +
          `${currency === 'xp' ? 'XP' : 'coins'}**`,
        inline: true,
      },
      {
        name: preview ? '🎨 Preview' : '🏆 Your rank',
        value: preview
          ? 'No chest opened and no points awarded.'
          : position(id, currency),
        inline: true,
      }
    )
    .setFooter({
      text: preview
        ? 'This rarity uses its own image. No shared fallback image.'
        : 'Your next chest will be available tomorrow at midnight, Paris time.',
    });

  return withImage(embed, tier.image);
}

async function animateBox(i, currency, tier, preview = false) {
  const style = boxStyle(currency);

  if (style.animation) {
    try {
      await i.editReply(withImage(
        new EmbedBuilder()
          .setColor(style.color)
          .setTitle('✨ Opening your lootbox…')
          .setDescription(
            'Your chest is opening… Your reward will appear in a moment!'
          ),
        style.animation
      ));

      await new Promise(resolve =>
        setTimeout(resolve, style.seconds * 1000)
      );
    } catch (e) {
      error('Animation (reward saved)', e);
    }
  }

  await i.editReply(
    resultMessage(i.user.id, currency, tier, style, preview)
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
          run('DELETE FROM boxes WHERE message=?', box.message);
        } else {
          error('Lootbox image update', e);
        }
      }
    }
  } finally {
    updatingBoxes = false;
  }
}

function upload(id, title, required = false) {
  return new LabelBuilder()
    .setLabel(title)
    .setFileUploadComponent(
      new FileUploadBuilder()
        .setCustomId(id)
        .setRequired(required)
        .setMinValues(required ? 1 : 0)
        .setMaxValues(1)
    );
}

function labelled(id, title, style, max, value = '', required = true) {
  const field = new TextInputBuilder()
    .setCustomId(id)
    .setStyle(style)
    .setMaxLength(max)
    .setRequired(required);

  if (value) field.setValue(value);

  return new LabelBuilder()
    .setLabel(title)
    .setTextInputComponent(field);
}

function uploaded(i, id) {
  return [...(
    i.fields.getUploadedFiles(id)?.values() || []
  )][0] || null;
}

function lootPanel(currency = 'xp', note = '') {
  const tiers = tiersFor(currency);
  const style = boxStyle(currency);
  const total = tiers.reduce((sum, tier) => sum + tier.chance, 0);

  const currencyMenu = new StringSelectMenuBuilder()
    .setCustomId('lbox:currency')
    .setPlaceholder('XP or coin rewards?')
    .addOptions(
      {
        label: 'XP',
        value: 'xp',
        default: currency === 'xp',
      },
      {
        label: 'Coins',
        value: 'coins',
        default: currency === 'coins',
      }
    );

  const rarityMenu = new StringSelectMenuBuilder()
    .setCustomId(`lbox:rarity:${currency}`)
    .setPlaceholder('Choose a chest to edit or preview')
    .addOptions(
      ...tiers.map((tier, n) => ({
        label: `Edit ${tier.name}`.slice(0, 100),
        value: `edit:${n}`,
        emoji: rarityIcons[n],
        description:
          `${tier.chance} % · ${tier.amount} ` +
          `${currency === 'xp' ? 'XP' : 'coins'} · ` +
          `${tier.image ? 'image uploaded' : 'image required'}`,
      })),
      ...tiers.map((tier, n) => ({
        label: `Preview ${tier.name}`.slice(0, 100),
        value: `preview:${n}`,
        emoji: rarityIcons[n],
        description:
          'Preview the GIF and this reward without earning points',
      }))
    );

  const destination = new ChannelSelectMenuBuilder()
    .setCustomId(`lbox:publish:${currency}`)
    .setPlaceholder('Choose the channel to publish the chest')
    .addChannelTypes(C.GuildText, C.GuildAnnouncement);

  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle('🎁 Lootbox settings')
    .setDescription(
      `**Rewards in ${currency === 'xp' ? 'XP' : 'coins'}**\n\n` +
      `Welcome image: ${style.image ? '✅' : 'upload required'}\n` +
      `Opening GIF: ${
        style.animation ? `✅ ${style.seconds} s` : 'upload required'
      }\n\n` +
      tiers.map((tier, n) =>
        `${rarityIcons[n]} **${tier.name}** · ${tier.amount} ` +
        `${currency === 'xp' ? 'XP' : 'coins'} · ${tier.chance} % · ` +
        `${tier.image ? '✅ dedicated image' : '⚠️ image required'}`
      ).join('\n') +
      `\n\n${
        total === 100
          ? '✅ Chances: 100%'
          : `⚠️ Chances: ${total}%. The total must be 100%.`
      }\n\n` +
      'Choose a chest from the menu to edit its name, text, ' +
      'reward, color and **dedicated image**. ' +
      'When everything is ready, select the publishing channel.'
    )
    .setFooter({
      text:
        'Configure everything from this panel. ' +
        'Rewards are always free.',
    });

  return {
    content: note || undefined,
    embeds: [embed],
    files: [],
    attachments: [],
    allowedMentions: noPing,
    components: [
      row(currencyMenu),
      row(
        button(
          `lbox:text:${currency}`,
          'Welcome message',
          ButtonStyle.Secondary
        ),
        button(
          `lbox:visuals:${currency}`,
          'Images and GIF',
          ButtonStyle.Secondary
        ),
        button(
          `lbox:chances:${currency}`,
          'Chances and rewards',
          ButtonStyle.Secondary
        )
      ),
      row(rarityMenu),
      row(destination),
    ],
  };
}

const publicationLocks = new Set();

async function publishBox(i, currency, channelId) {
  const key = `${currency}:${channelId}`;

  if (publicationLocks.has(key)) {
    throw new UserError('Publication already in progress.');
  }

  publicationLocks.add(key);

  try {
    readyBox(currency);

    const channel = await i.guild.channels.fetch(channelId);

    if (
      !channel ||
      ![C.GuildText, C.GuildAnnouncement].includes(channel.type)
    ) {
      throw new UserError('Choose a text channel on this server.');
    }

    permission(channel, [
      P.ViewChannel,
      P.SendMessages,
      P.EmbedLinks,
      P.AttachFiles,
      P.ReadMessageHistory,
    ]);

    const previous = get(
      'SELECT * FROM boxes WHERE currency=? AND channel=? ' +
      'ORDER BY rowid DESC LIMIT 1',
      currency,
      channel.id
    );

    if (previous) {
      const message = await channel.messages.fetch(
        previous.message
      ).catch(e => {
        if (Number(e.code) === 10008) return null;
        throw e;
      });

      if (message) {
        await message.edit(boxMessage(currency));

        run(
          'UPDATE boxes SET title=NULL WHERE message=?',
          message.id
        );

        await i.editReply(
          lootPanel(currency, `✅ Chest updated: ${message.url}`)
        );
        return;
      }
    }

    const message = await channel.send(boxMessage(currency));

    run(
      'INSERT INTO boxes(message,currency,channel,title) VALUES (?,?,?,NULL)',
      message.id,
      currency,
      channel.id
    );

    await i.editReply(
      lootPanel(currency, `✅ Chest published: ${message.url}`)
    );
  } finally {
    publicationLocks.delete(key);
  }
}

async function lootControls(i) {
  const [prefix, action, currency, indexText] = i.customId.split(':');

  if (
    action !== 'currency' &&
    !['xp', 'coins'].includes(currency)
  ) {
    throw new UserError('Invalid currency.');
  }

  if (
    prefix === 'lbox' &&
    ['text', 'visuals', 'chances'].includes(action)
  ) {
    const style = boxStyle(currency);

    if (action === 'text') {
      await i.showModal(modal(
        `lboxform:text:${currency}`,
        'Welcome message',
        labelled(
          'titre',
          'Message title',
          TextInputStyle.Short,
          100,
          style.title
        ),
        labelled(
          'description',
          'Text (Markdown and line breaks)',
          TextInputStyle.Paragraph,
          2000,
          style.description,
          false
        ),
        labelled(
          'couleur',
          'HEX color, example #FFD700',
          TextInputStyle.Short,
          7,
          hex(style.color)
        )
      ));
    } else if (action === 'visuals') {
      await i.showModal(modal(
        `lboxform:visuals:${currency}`,
        'Welcome image and GIF',
        upload('image', 'Welcome message image', !style.image),
        upload('animation', 'Opening animation GIF', !style.animation),
        labelled(
          'secondes',
          'GIF duration (1 to 15 seconds)',
          TextInputStyle.Short,
          2,
          String(style.seconds)
        )
      ));
    } else {
      await i.showModal(modal(
        `lboxform:chances:${currency}`,
        'Chance % ; reward (example 60;25)',
        ...tiersFor(currency).map((tier, n) => labelled(
          `t${n}`,
          `${tier.name.slice(0, 17)} : chance % ; reward`,
          TextInputStyle.Short,
          20,
          `${tier.chance};${tier.amount}`
        ))
      ));
    }

    return;
  }

  if (prefix === 'lbox' && action === 'rarity') {
    const [choice, index] = i.values[0].split(':');
    const tier = tiersFor(currency)[Number(index)];

    if (!tier) throw new UserError('Chest not found.');

    if (choice === 'edit') {
      await i.showModal(modal(
        `lboxform:rarity:${currency}:${index}`,
        'Customize this chest',
        labelled(
          'nom',
          'Chest name',
          TextInputStyle.Short,
          80,
          tier.name
        ),
        labelled(
          'description',
          'Reward text (Markdown supported)',
          TextInputStyle.Paragraph,
          2000,
          tier.description,
          false
        ),
        labelled(
          'gain',
          'Chance % ; reward (example 60;25)',
          TextInputStyle.Short,
          20,
          `${tier.chance};${tier.amount}`
        ),
        labelled(
          'couleur',
          'HEX color, example #FFD700',
          TextInputStyle.Short,
          7,
          hex(tier.color)
        ),
        upload(
          'image',
          'Dedicated image for THIS chest',
          !tier.image
        )
      ));
      return;
    }

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await animateBox(i, currency, tier, true);
    return;
  }

  if (prefix === 'lbox' && action === 'currency') {
    const selected = i.values[0];

    if (!['xp', 'coins'].includes(selected)) {
      throw new UserError('Invalid currency.');
    }

    await i.deferUpdate();
    await i.editReply(lootPanel(selected));
    return;
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  if (prefix === 'lbox' && action === 'publish') {
    await publishBox(i, currency, i.values[0]);
    return;
  }

  if (prefix !== 'lboxform') {
    throw new UserError('Unknown action. Run /lootbox again.');
  }

  if (action === 'text') {
    const style = boxStyle(currency);
    const title = i.fields.getTextInputValue('titre').trim();

    if (!title) {
      throw new UserError('The title cannot be empty.');
    }

    style.title = title;
    style.description = i.fields
      .getTextInputValue('description').trim();
    style.color = color(i.fields.getTextInputValue('couleur'));

    set(`boxstyle:${currency}`, style);
  } else if (action === 'visuals') {
    const seconds = Number(
      i.fields.getTextInputValue('secondes').trim()
    );

    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 15) {
      throw new UserError('Duration must be between 1 and 15 seconds.');
    }

    const image = uploaded(i, 'image');
    const animation = uploaded(i, 'animation');

    const imageId = image ? await importAsset(image) : null;
    const animationId = animation
      ? await importAsset(animation, true)
      : null;

    const style = boxStyle(currency);
    style.seconds = seconds;

    if (imageId) style.image = imageId;
    if (animationId) style.animation = animationId;

    set(`boxstyle:${currency}`, style);
  } else if (action === 'rarity') {
    const index = Number(indexText);

    if (!Number.isInteger(index) || index < 0 || index > 4) {
      throw new UserError('Invalid rarity.');
    }

    const name = i.fields.getTextInputValue('nom').trim();

    if (!name) {
      throw new UserError('The chest name cannot be empty.');
    }

    const match = i.fields.getTextInputValue('gain')
      .trim().match(/^(\d{1,3})\s*;\s*(\d{1,7})$/);

    if (
      !match ||
      Number(match[1]) > 100 ||
      Number(match[2]) < 1 ||
      Number(match[2]) > 1000000
    ) {
      throw new UserError(
        'Use chance;reward, for example 60;25.'
      );
    }

    const selectedColor = color(
      i.fields.getTextInputValue('couleur')
    );

    const attachment = uploaded(i, 'image');
    const imageId = attachment
      ? await importAsset(attachment)
      : null;

    const tiers = tiersFor(currency);
    const tier = tiers[index];

    tier.name = name;
    tier.description = i.fields
      .getTextInputValue('description').trim();
    tier.color = selectedColor;
    tier.chance = Number(match[1]);
    tier.amount = Number(match[2]);

    if (imageId) tier.image = imageId;

    set(`tiers:${currency}`, tiers);
  } else if (action === 'chances') {
    const tiers = tiersFor(currency).map((tier, n) => {
      const match = i.fields.getTextInputValue(`t${n}`)
        .trim().match(/^(\d{1,3})\s*;\s*(\d{1,7})$/);

      if (!match) {
        throw new UserError(
          'Each line must use the chance;reward format, ' +
          'for example 60;25.'
        );
      }

      return {
        ...tier,
        chance: Number(match[1]),
        amount: Number(match[2]),
      };
    });

    validTiers(tiers);
    set(`tiers:${currency}`, tiers);
  } else {
    throw new UserError('Unknown action.');
  }

  try {
    readyBox(currency);
    await updateBoxes(currency);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
  }

  await i.editReply(lootPanel(
    currency,
    '✅ Settings saved. You can configure the next chest ' +
    'or try a preview.'
  ));
}

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function paris(now = Date.now()) {
  const p = Object.fromEntries(
    fmt.formatToParts(new Date(now)).map(x => [x.type, x.value])
  );

  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
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
      'This command requires the Manage Server permission.'
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
  ].filter(Boolean).join(' and ');
}

const noPing = { parse: [] };

function permission(channel, list) {
  if (!channel?.permissionsFor(client.user)?.has(list)) {
    throw new UserError(
      'The bot does not have the required permissions in this channel.'
    );
  }
}

function canEarn(_channel, config) {
  return config.active;
}

function meets(message, format) {
  const attachments = [...message.attachments.values()];

  const image = attachments.some(a =>
    a.contentType?.startsWith('image/')
  );

  const video = attachments.some(a =>
    a.contentType?.startsWith('video/')
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
  if (!quest.active || !meets(message, quest.format)) return false;

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
  ) return;

  const quest = get(
    'SELECT * FROM quests WHERE id=?',
    message.channelId
  );

  if (quest && claimQuest(message, quest)) {
    try {
      await message.reply({
        content:
          `<@${message.author.id}>, quest **${quest.title}** completed! ` +
          `You earn **${rewardLabel(quest.xp, quest.coins)}**.`,
        allowedMentions: {
          parse: [],
          users: [message.author.id],
          repliedUser: false,
        },
      });
    } catch (e) {
      error('Quest confirmation (reward saved)', e);
    }
  }

  if (catchup) return;

  const config = setting('activity', defaults);

  if (
    !canEarn(message.channel, config) ||
    (!message.content?.trim() && !message.attachments.size)
  ) return;

  transaction(() => {
    if (!run(
      'INSERT OR IGNORE INTO events VALUES (?,?)',
      `m:${message.id}`,
      Date.now()
    ).changes) return;

    const record = user(message.author.id);
    const now = message.createdTimestamp;

    if (now - record.message_at < config.delai * 1000) return;

    add(
      record.id,
      config.message + (meets(message, 'media') ? config.media : 0)
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
  ) return;

  const config = setting('activity', defaults);

  if (
    !canEarn(message.channel, config) ||
    !config.reaction
  ) return;

  transaction(() => {
    if (!run(
      'INSERT OR IGNORE INTO events VALUES (?,?)',
      `r:${message.id}:${author.id}`,
      Date.now()
    ).changes) return;

    const record = user(author.id);
    const now = Date.now();

    if (now - record.reaction_at < config.delai * 1000) return;

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
  inviteQueue = inviteQueue.then(fn).catch(e => {
    invites = null;
    error('Invitations', e);
  });

  return inviteQueue;
}

async function inviteSnapshot(guild) {
  if (
    !guild.members.me?.permissions.has(P.ManageGuild) ||
    guild.vanityURLCode
  ) return null;

  const list = await guild.invites.fetch();

  return new Map([...list.values()].map(v => [
    v.code,
    {
      uses: v.uses || 0,
      inviter: v.inviter?.id,
      bot: v.inviter?.bot,
    },
  ]));
}

async function join(member) {
  if (
    !ready ||
    member.guild.id !== GUILD ||
    member.user.bot
  ) return;

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
  ) return;

  if ([...before.keys()].some(code => !invites.has(code))) return;

  const changed = [...invites].filter(([code, v]) =>
    v.uses !== (before.get(code)?.uses || 0)
  );

  if (changed.length !== 1) return;

  const [code, invite] = changed[0];

  if (
    !before.has(code) ||
    invite.uses - before.get(code).uses !== 1 ||
    !invite.inviter ||
    invite.bot ||
    invite.inviter === member.id
  ) return;

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
    `SELECT id,${currency} AS amount FROM users ` +
    `WHERE ${currency}>0 ORDER BY ${currency} DESC,id LIMIT 20`
  );

  const embed = new EmbedBuilder()
    .setColor(setting(
      `boardcolor:${currency}`,
      currency === 'xp' ? 0x5865f2 : 0xf1c40f
    ))
    .setTitle(
      currency === 'xp'
        ? '🏆 XP leaderboard'
        : '🪙 Coins leaderboard'
    )
    .setDescription(
      entries.map((p, i) =>
        `**${i + 1}.** <@${p.id}> · ` +
        `**${p.amount.toLocaleString('en-US')} ` +
        `${currency === 'xp' ? 'XP' : 'coins'}**`
      ).join('\n') || 'No points yet.'
    )
    .setFooter({
      text:
        'Updated every morning at 10 a.m., Paris time. ' +
        'Use the button to see your current rank.',
    })
    .setTimestamp();

  return {
    ...withImage(embed, setting(`boardimage:${currency}`, null)),
    components: [
      row(button(
        `position:${currency}`,
        'View my rank',
        ButtonStyle.Secondary
      )),
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
      ) continue;

      try {
        const channel = await client.channels.fetch(board.channel);
        const message = await channel.messages.fetch(board.message);

        await message.edit(leaderboard(board.currency));

        run(
          'UPDATE boards SET day=? WHERE currency=?',
          time.day,
          board.currency
        );
      } catch (e) {
        error('Leaderboard: check the message and permissions', e);
      }
    }
  } finally {
    refreshing = false;
  }
}

function boxMessage(currency, title) {
  const style = boxStyle(currency);

  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(englishDefault(title) || style.title)
    .setDescription(style.description)
    .addFields(
      {
        name: '✨ Rewards',
        value:
          `Earn **${currency === 'xp' ? 'XP' : 'coins'}** ` +
          'for your leaderboard rank',
        inline: true,
      },
      {
        name: '🎁 Your daily chest',
        value: '**One free chest every day**',
        inline: true,
      }
    )
    .setFooter({
      text:
        'One opening per member per day. ' +
        'A new chest at midnight, Paris time.',
    });

  return {
    ...withImage(embed, style.image),
    components: [
      row(button(`box:${currency}`, '🎁 Open my chest')),
    ],
  };
}

function openBox(id, currency) {
  return transaction(() => {
    const record = user(id);
    const today = paris().day;

    if (record.loot_day === today) {
      throw new UserError(
        'You have already opened your lootbox today. ' +
        'Come back tomorrow after midnight, Paris time!'
      );
    }

    const tiers = tiersFor(currency);
    validTiers(tiers);

    const tier = pick(tiers);

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

const currencyOption = o => o
  .setName('currency')
  .setDescription('XP or coins')
  .setRequired(true)
  .addChoices(...currencies);

const forumOption = o => o
  .setName('forum')
  .setDescription('Forum in which to publish the quest')
  .setRequired(true)
  .addChannelTypes(C.GuildForum);

const textOption = o => o
  .setName('channel')
  .setDescription('Text channel for publication')
  .setRequired(true)
  .addChannelTypes(C.GuildText, C.GuildAnnouncement);

const colorOption = o => o
  .setName('color')
  .setDescription('HEX color, for example #FFD700')
  .setMaxLength(7);

const commands = [
  base('quest', 'Create and manage quests')
    .addSubcommand(s => s
      .setName('create')
      .setDescription('Open the creation form')
      .addChannelOption(forumOption)
      .addStringOption(o => o
        .setName('format')
        .setDescription('Accepted submission format')
        .setRequired(true)
        .addChoices(
          { name: 'Attached image', value: 'image' },
          { name: 'Attached video', value: 'video' },
          { name: 'Attached image or video', value: 'media' },
          { name: 'Text', value: 'texte' }
        ))
      .addIntegerOption(o => o
        .setName('xp')
        .setDescription('XP reward')
        .setMinValue(0)
        .setMaxValue(1000000))
      .addIntegerOption(o => o
        .setName('coins')
        .setDescription('Coin reward')
        .setMinValue(0)
        .setMaxValue(1000000))
      .addAttachmentOption(o => o
        .setName('image')
        .setDescription('Optional welcome image, maximum 8 MB'))
      .addStringOption(colorOption)
      .addStringOption(o => o
        .setName('tag')
        .setDescription('Exact forum tag name, if required')
        .setMaxLength(20)))
    .addSubcommand(s => s
      .setName('close')
      .setDescription('Stop rewards and archive the quest')
      .addStringOption(o => o
        .setName('thread')
        .setDescription('Thread ID or link')
        .setRequired(true)))
    .addSubcommand(s => s
      .setName('delete')
      .setDescription('Delete the quest post after confirmation')
      .addStringOption(o => o
        .setName('thread')
        .setDescription('Thread ID or link')
        .setRequired(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('View quests and their rewards')),

  base('leaderboard', 'Publish and refresh leaderboards')
    .addSubcommand(s => s
      .setName('publish')
      .setDescription('Publish the Top 20 leaderboard')
      .addStringOption(currencyOption)
      .addChannelOption(textOption)
      .addStringOption(colorOption)
      .addAttachmentOption(o => o
        .setName('image')
        .setDescription('Optional large leaderboard image')))
    .addSubcommand(s => s
      .setName('appearance')
      .setDescription('Change the existing leaderboard color or image')
      .addStringOption(currencyOption)
      .addStringOption(colorOption)
      .addAttachmentOption(o => o
        .setName('image')
        .setDescription('Large leaderboard image')))
    .addSubcommand(s => s
      .setName('refresh')
      .setDescription('Refresh leaderboards now')),

  base('points', 'Manage XP and coin balances')
    .addSubcommand(s => s
      .setName('add')
      .setDescription('Add points')
      .addUserOption(o => o
        .setName('member')
        .setDescription('Member')
        .setRequired(true))
      .addStringOption(currencyOption)
      .addIntegerOption(o => o
        .setName('amount')
        .setDescription('Number of points')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(1000000)))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription('Remove points')
      .addUserOption(o => o
        .setName('member')
        .setDescription('Member')
        .setRequired(true))
      .addStringOption(currencyOption)
      .addIntegerOption(o => o
        .setName('amount')
        .setDescription('Number of points')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(1000000)))
    .addSubcommand(s => s
      .setName('reset')
      .setDescription('Reset balances after confirmation')
      .addStringOption(o => o
        .setName('currency')
        .setDescription('Balance to reset')
        .setRequired(true)
        .addChoices(
          ...currencies,
          { name: 'XP and coins', value: 'tout' }
        ))),

  base('lootbox', 'Open the chest configuration panel'),

  base('activity', 'Configure automatic XP rewards')
    .addSubcommand(s => s
      .setName('configure')
      .setDescription('Change points and cooldown')
      .addIntegerOption(o => o
        .setName('message')
        .setDescription('XP per message')
        .setMinValue(0)
        .setMaxValue(1000))
      .addIntegerOption(o => o
        .setName('media')
        .setDescription('Bonus XP for an attached image or video')
        .setMinValue(0)
        .setMaxValue(1000))
      .addIntegerOption(o => o
        .setName('reaction')
        .setDescription('XP per reaction')
        .setMinValue(0)
        .setMaxValue(1000))
      .addIntegerOption(o => o
        .setName('invitation')
        .setDescription('XP per clearly attributed invitation')
        .setMinValue(0)
        .setMaxValue(10000))
      .addIntegerOption(o => o
        .setName('cooldown')
        .setDescription('Cooldown between rewards, in seconds')
        .setMinValue(10)
        .setMaxValue(86400))
      .addBooleanOption(o => o
        .setName('active')
        .setDescription('Enable activity rewards')))
    .addSubcommand(s => s
      .setName('view')
      .setDescription('View current settings')),

  base('profile', 'View your XP, coins and ranks', false)
    .addUserOption(o => o
      .setName('member')
      .setDescription('Optional other member')),
];

function questId(value) {
  if (/^\d{17,20}$/.test(value)) return value;

  const match = value.match(
    /^https:\/\/discord.com\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?$/
  );

  if (!match || match[1] !== GUILD) {
    throw new UserError(
      'Enter the ID or link of a thread on this server.'
    );
  }

  return match[2];
}

function position(id, currency) {
  const record = user(id);
  const amount = record[currency];

  if (!amount) {
    return `0 ${currency === 'xp' ? 'XP' : 'coins'} · not ranked yet`;
  }

  const above = get(
    `SELECT COUNT(*) AS n FROM users WHERE ${currency}>? ` +
    `OR (${currency}=? AND id<?)`,
    amount,
    amount,
    id
  ).n;

  return (
    `**${amount.toLocaleString('en-US')} ` +
    `${currency === 'xp' ? 'XP' : 'coins'}** · ` +
    `rank **#${above + 1}**`
  );
}

async function createQuest(i, draft) {
  const title = i.fields.getTextInputValue('titre').trim();
  const body = i.fields.getTextInputValue('texte').trim();

  if (!title || !body) {
    throw new UserError('The title and text cannot be empty.');
  }

  const forum = await i.guild.channels.fetch(draft.forum);

  if (!forum || forum.type !== C.GuildForum) {
    throw new UserError('Forum not found.');
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
    const tag = forum.availableTags.find(t => t.name === draft.tag);

    if (!tag) {
      throw new UserError(
        'Tag not found. Create the quest again using the exact tag name.'
      );
    }

    if (
      tag.moderated &&
      !forum.permissionsFor(client.user).has(P.ManageThreads)
    ) {
      throw new UserError(
        'This tag requires the Manage Threads permission.'
      );
    }

    appliedTags.push(tag.id);
  }

  if (forum.flags.has('RequireTag') && !appliedTags.length) {
    throw new UserError(
      'This forum requires a tag. Create the quest again using the tag option.'
    );
  }

  const formats = {
    image: 'attached image',
    video: 'attached video',
    media: 'attached image or video',
    texte: 'text',
  };

  const embed = new EmbedBuilder()
    .setColor(draft.color ?? 0x5865f2)
    .setTitle(title)
    .setDescription(body)
    .addFields(
      {
        name: 'Reward',
        value: rewardLabel(draft.xp, draft.coins),
      },
      {
        name: 'Participation',
        value:
          `Format: **${formats[draft.format]}**.\n` +
          'One reward per member. Awarded automatically based on ' +
          'the format, without reviewing the submission.',
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
      throw new UserError('Invalid Discord image.');
    }

    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });

    if (!response.ok) {
      throw new UserError(
        'Image expired or unavailable. Create the quest again with the image attached.'
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
        throw new UserError('Image too large: maximum 8 MB.');
      }

      parts.push(value);
    }

    const name = `quest.${draft.image.ext}`;

    files.push(new AttachmentBuilder(
      Buffer.concat(parts),
      { name }
    ));

    embed.setImage(`attachment://${name}`);
  }

  if (!run(
    'DELETE FROM drafts WHERE id=?',
    draft.id
  ).changes) {
    throw new UserError('Form already submitted.');
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
    'INSERT INTO quests(id,title,format,xp,coins,cursor) VALUES (?,?,?,?,?,?)',
    thread.id,
    title,
    draft.format,
    draft.xp,
    draft.coins,
    thread.id
  );

  audit(i.user.id, 'creation_quete', { thread: thread.id });

  await i.editReply(
    `Quest created: <#${thread.id}>. ` +
    `Reward: **${rewardLabel(draft.xp, draft.coins)}**.`
  );
}

async function interaction(i) {
  if (i.guildId !== GUILD) return;

  const supported = i.isChatInputCommand()
    ? commands.some(c => c.name === i.commandName)
    : (
        i.isButton() ||
        i.isModalSubmit() ||
        i.isAnySelectMenu?.()
      ) &&
      /^(position:|box:|quest:|lbox:|lboxform:|delete:|reset:)/
        .test(i.customId);

  if (!supported) return;

  try {
    if (!ready || stopping) {
      await i.reply({
        content: 'The bot is starting. Try again in a moment.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const publicControl =
      i.isButton() &&
      /^(position:|box:)/.test(i.customId);

    if (
      !publicControl &&
      !(i.isChatInputCommand() && i.commandName === 'profile')
    ) {
      admin(i);
    }

    if (/^lbox(form)?:/.test(i.customId || '')) {
      await lootControls(i);
      return;
    }

    if (
      i.isChatInputCommand() &&
      i.commandName === 'lootbox'
    ) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await i.editReply(lootPanel());
      return;
    }

    if (i.isChatInputCommand()) {
      const cmd = i.commandName;
      const sub = cmd === 'profile'
        ? ''
        : i.options.getSubcommand();

      if (cmd === 'quest' && sub === 'create') {
        const xp = i.options.getInteger('xp') || 0;
        const coins = i.options.getInteger('coins') || 0;

        if (!xp && !coins) {
          throw new UserError(
            'Enter an XP and/or coin reward greater than zero.'
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
          throw new UserError('Attach an image of up to 8 MB.');
        }

        const id = randomUUID();

        const draft = {
          id,
          color: color(i.options.getString('color')),
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
          id,
          i.user.id,
          Date.now() + 20 * 60000,
          JSON.stringify(draft)
        );

        await i.showModal(modal(
          `quest:${id}`,
          'Create a quest',
          input(
            'titre',
            'Quest title',
            TextInputStyle.Short,
            100
          ),
          input(
            'texte',
            'Quest text (line breaks supported)',
            TextInputStyle.Paragraph,
            3800
          )
        ));

        return;
      }
    }

    await i.deferReply({ flags: MessageFlags.Ephemeral });

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
            'Form expired. Run /quest create again.'
          );
        }

        await createQuest(i, JSON.parse(record.data));
        return;
      }

      throw new UserError('Unknown form.');
    }

    if (i.isButton()) {
      const [action, arg, owner] = i.customId.split(':');

      if (action === 'position') {
        if (!['xp', 'coins'].includes(arg)) {
          throw new UserError('Invalid currency.');
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
          throw new UserError('This lootbox is no longer available.');
        }

        if (!box.channel && i.channelId) {
          run(
            'UPDATE boxes SET channel=? WHERE message=?',
            i.channelId,
            i.message.id
          );
        }

        readyBox(box.currency);

        const tier = openBox(i.user.id, box.currency);
        await animateBox(i, box.currency, tier);
        return;
      }

      if (
        owner !== i.user.id ||
        Date.now() - i.message.createdTimestamp > 5 * 60000
      ) {
        throw new UserError(
          'This confirmation is only available to its author and expires after 5 minutes.'
        );
      }

      if (!run(
        'INSERT OR IGNORE INTO events VALUES (?,?)',
        `confirm:${i.message.id}`,
        Date.now()
      ).changes) {
        throw new UserError('Confirmation already used.');
      }

      if (action === 'reset') {
        if (!['xp', 'coins', 'tout'].includes(arg)) {
          throw new UserError('Invalid currency.');
        }

        transaction(() => {
          db.exec(
            arg === 'tout'
              ? 'UPDATE users SET xp=0,coins=0'
              : `UPDATE users SET ${arg}=0`
          );

          audit(i.user.id, 'reset', { currency: arg });
        });

        await refreshBoards(true);

        await i.editReply(
          'Balances reset. Previously completed quests and ' +
          'today’s lootbox remain marked as used.'
        );
        return;
      }

      if (action === 'delete') {
        const quest = get(
          'SELECT * FROM quests WHERE id=?',
          arg
        );

        if (!quest) throw new UserError('Quest not found.');

        run('UPDATE quests SET active=0 WHERE id=?', arg);

        const thread = await i.guild.channels.fetch(arg).catch(e => {
          if (Number(e.code) === 10003) return null;
          throw e;
        });

        if (thread) {
          await thread.delete('Quest deletion confirmed');
        }

        audit(i.user.id, 'suppression_quete', { thread: arg });

        await i.editReply(
          'Post deleted. Previously earned points are kept.'
        );
        return;
      }
    }

    const cmd = i.commandName;
    const sub = cmd === 'profile'
      ? ''
      : i.options.getSubcommand();

    const currency = i.options.getString('currency');

    if (cmd === 'profile') {
      const member = i.options.getUser('member') || i.user;

      await i.editReply({
        content:
          `<@${member.id}>\n` +
          `${position(member.id, 'xp')}\n` +
          `${position(member.id, 'coins')}`,
        allowedMentions: noPing,
      });
    } else if (cmd === 'quest') {
      if (sub === 'list') {
        const quests = all(
          'SELECT * FROM quests ORDER BY active DESC,id DESC LIMIT 40'
        );

        const text = quests.map(q =>
          `<#${q.id}> · ${rewardLabel(q.xp, q.coins)} · ` +
          `${q.active ? 'open' : 'closed'}`
        ).join('\n');

        await i.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle('Quests (up to the latest 40)')
              .setDescription(text || 'No quests created yet.'),
          ],
        });
      } else {
        const id = questId(i.options.getString('thread'));
        const quest = get('SELECT * FROM quests WHERE id=?', id);

        if (!quest) {
          throw new UserError(
            'This thread is not a quest created by this bot.'
          );
        }

        if (sub === 'delete') {
          await i.editReply({
            content:
              'Permanently delete this post? ' +
              'Earned points will be kept.',
            components: [
              row(button(
                `delete:${id}:${i.user.id}`,
                'Confirm deletion',
                ButtonStyle.Danger
              )),
            ],
          });
        } else {
          run('UPDATE quests SET active=0 WHERE id=?', id);

          const thread = await i.guild.channels.fetch(id);

          if (thread) {
            await thread.setLocked(true, 'Quest closed');
            await thread.setArchived(true, 'Quest closed');
          }

          audit(i.user.id, 'fermeture_quete', { thread: id });

          await i.editReply(
            'Quest closed: no new rewards.'
          );
        }
      }
    } else if (cmd === 'leaderboard') {
      if (sub === 'refresh') {
        await refreshBoards(true);

        await i.editReply(
          'Refresh requested. ' +
          'Any errors will be reported in the logs.'
        );
      } else {
        const selectedColor = i.options.getString('color');
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

        if (sub === 'appearance') {
          await refreshBoards(true);

          await i.editReply(
            'Leaderboard appearance saved. ' +
            'Accessible leaderboards have been refreshed.'
          );
          return;
        }

        const channel = i.options.getChannel('channel');

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

            await i.editReply('Existing leaderboard refreshed.');
            return;
          }
        }

        const message = await channel.send(leaderboard(currency));

        run(
          'INSERT INTO boards VALUES (?,?,?,?) ' +
          'ON CONFLICT(currency) DO UPDATE SET ' +
          'channel=excluded.channel,message=excluded.message,day=excluded.day',
          currency,
          channel.id,
          message.id,
          paris().day
        );

        if (existing) {
          try {
            const old = await client.channels.fetch(existing.channel);
            const oldMessage = await old.messages.fetch(existing.message);

            await oldMessage.edit({
              content: 'This leaderboard has moved.',
              embeds: [],
              components: [],
            });
          } catch (e) {
            error('Previous leaderboard', e);
          }
        }

        await i.editReply(`Leaderboard published: ${message.url}`);
      }
    } else if (cmd === 'points') {
      if (sub === 'reset') {
        await i.editReply({
          content:
            `Reset ${
              currency === 'tout' ? 'XP and coins' : currency
            } for all members to zero?`,
          components: [
            row(button(
              `reset:${currency}:${i.user.id}`,
              'Confirm reset',
              ButtonStyle.Danger
            )),
          ],
        });
      } else {
        const member = i.options.getUser('member');

        if (member.bot) {
          throw new UserError(
            'Bots do not participate in leaderboards.'
          );
        }

        const amount = i.options.getInteger('amount');

        transaction(() => {
          const balance = user(member.id)[currency];

          if (sub === 'remove' && amount > balance) {
            throw new UserError(
              `This member only has ${balance} ${currency}.`
            );
          }

          const delta = sub === 'add' ? amount : -amount;

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
            `Balance updated for <@${member.id}> : ` +
            `${position(member.id, currency)}.`,
          allowedMentions: noPing,
        });
      }
    } else if (cmd === 'activity') {
      const config = { ...setting('activity', defaults) };

      if (sub === 'configure') {
        for (const key of [
          'message',
          'media',
          'reaction',
          'invitation',
          'delai',
        ]) {
          const value = i.options.getInteger(
            key === 'delai' ? 'cooldown' : key
          );

          if (value !== null) config[key] = value;
        }

        const active = i.options.getBoolean('active');

        if (active !== null) config.active = active;
      }

      delete config.channels;
      set('activity', config);

      await i.editReply({
        content:
          `Activity: **${config.active ? 'enabled' : 'disabled'}**\n` +
          `Message : ${config.message} XP\n` +
          `Image/video bonus: ${config.media} XP\n` +
          `Reaction: ${config.reaction} XP\n` +
          `Invitation : ${config.invitation} XP\n` +
          `Cooldown: ${config.delai} s\n` +
          'Rewards apply to all accessible channels on the server.',
        allowedMentions: noPing,
      });
    }
  } catch (e) {
    error('Command', e);

    const content = e instanceof UserError
      ? e.message
      : [50001, 50013].includes(Number(e.code))
        ? 'Insufficient permissions. ' +
          'Check the bot permissions in this channel.'
        : 'Operation not confirmed. Check the channel and /profile before ' +
          'trying again: any reward already recorded is kept. ' +
          'Check the Railway logs.';

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
      error('Discord response', failure);
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

          pending.push(...rows.filter(m =>
            BigInt(m.id) > BigInt(quest.cursor)
          ));

          if (
            rows.length < 100 ||
            rows.some(m => BigInt(m.id) <= BigInt(quest.cursor))
          ) {
            complete = true;
            break;
          }

          before = rows.reduce((a, b) =>
            BigInt(a.id) < BigInt(b.id) ? a : b
          ).id;
        }

        if (!complete) {
          console.error(
            `Incomplete catch-up for thread ${quest.id} : ` +
            'more than 10,000 messages. No cursor was advanced.'
          );
          continue;
        }

        pending.sort((a, b) =>
          BigInt(a.id) < BigInt(b.id) ? -1 : 1
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
        error(`Quest catch-up ${quest.id}`, e);
      }
    }
  } finally {
    catchingUp = false;
  }
}

client.on(Events.InteractionCreate, i =>
  task('Interaction', () => interaction(i))
);

client.on(Events.MessageCreate, m =>
  task('Message', () => processMessage(m))
);

client.on(Events.MessageUpdate, (_old, m) =>
  task('Message update', async () => {
    if (m.partial) m = await m.fetch();
    await processMessage(m, true);
  })
);

client.on(Events.MessageReactionAdd, (r, u) =>
  task('Reaction', () => processReaction(r, u))
);

client.on(Events.GuildMemberAdd, m =>
  task('Member join', () => queueInvite(() => join(m)))
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
  // Keep the previous reference if attribution is ambiguous.
});

client.on(Events.ShardResume, () => {
  task('Catch-up', catchUpQuests);
});

client.on(Events.Error, e => error('Discord', e));

async function main() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Discord connection timed out')),
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
      'The bot is not on the configured server. ' +
      'Check DISCORD_GUILD_ID and the bot invitation.'
    );
  }

  for (const command of commands) {
    await guild.commands.create(command.toJSON());
  }

  const registered = await guild.commands.fetch();

  for (const command of registered.values()) {
    if (
      ['quete', 'classement', 'activite', 'profil'].includes(command.name) &&
      command.applicationId === client.application.id
    ) {
      await guild.commands.delete(command.id);
    }
  }

  try {
    invites = await inviteSnapshot(guild);
  } catch (e) {
    error('Invite tracking disabled', e);
  }

  if (!invites) {
    console.warn(
      'Invitations: tracking unavailable ' +
      '(missing Manage Server permission or a custom invite link). ' +
      'Other features remain active.'
    );
  }

  ready = true;

  console.log(
    `Quest bot ready: ${client.user.tag}. ` +
    'Leaderboards refresh at 10 a.m. Europe/Paris.'
  );

  task('Initial catch-up', catchUpQuests);
  task('Startup leaderboards', () => refreshBoards());

  clock = setInterval(() => {
    task('Daily leaderboards', () => refreshBoards());

    if (++ticks % 10 === 0) {
      task('Periodic quest catch-up', catchUpQuests);
    }

    run('DELETE FROM drafts WHERE expires<?', Date.now());
  }, 30000);
}

async function shutdown(code = 0) {
  if (stopping) return;

  stopping = true;
  ready = false;
  clearInterval(clock);

  const timer = setTimeout(() => process.exit(code), 25000);

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
  error('Fatal error', e);
  void shutdown(1);
});

process.once('unhandledRejection', e => {
  error('Fatal error', e);
  void shutdown(1);
});

if (require.main === module) {
  main().catch(e => {
    console.error(
      e.code === 'DisallowedIntents' || e.code === 4014
        ? 'Enable SERVER MEMBERS INTENT and MESSAGE CONTENT INTENT ' +
          'in Discord Developer Portal.'
        : `Startup: ${e.message}`
    );

    void shutdown(1);
  });
}
