/**
 * index.js
 *
 * Full Discord giveaway Battle Royale bot with minimal Web UI.
 * - Use environment variables:
 *    BOT_TOKEN (required for Discord features)
 *    SERVER_SEED (private server seed / public server key string)
 *    PORT (optional, default 3000)
 *
 * - Data persisted in ./data/giveaways.json and ./data/setups.json
 *
 * - Command: $start {setupNameOrId}
 * - Join via message "Join" button, Verify via "Verify" button (creator provides seeds via Modal)
 *
 * Notes:
 * - Uses HMAC-SHA512(serverSeed, `${clientSeed1}:${clientSeed2}:${entryIndex}`) -> float
 * - Live embed update every 1s
 * - Join queue processes one join per second
 * - If interaction errors `Unknown interaction (10062)` are caught, bot attempts a restart
 */

import fs from 'fs';
import path from 'path';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import http from 'http';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  PermissionFlagsBits
} from 'discord.js';

const DATA_DIR = path.resolve('./data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const GIVEAWAYS_FILE = path.join(DATA_DIR, 'giveaways.json');
const SETUPS_FILE = path.join(DATA_DIR, 'setups.json');
if (!fs.existsSync(GIVEAWAYS_FILE)) fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify({}));
if (!fs.existsSync(SETUPS_FILE)) fs.writeFileSync(SETUPS_FILE, JSON.stringify({}));

let GIVEAWAYS = JSON.parse(fs.readFileSync(GIVEAWAYS_FILE, 'utf8') || '{}');
let SETUPS = JSON.parse(fs.readFileSync(SETUPS_FILE, 'utf8') || '{}');

function saveGiveaways() { fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify(GIVEAWAYS, null, 2)); }
function saveSetups() { fs.writeFileSync(SETUPS_FILE, JSON.stringify(SETUPS, null, 2)); }

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const SERVER_SEED = process.env.SERVER_SEED || 'replace_with_64_char_key';
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

app.get('/api/setups', (req, res) => res.json(SETUPS));
app.post('/api/setups', (req, res) => {
  const id = `setup_${Date.now()}`;
  const body = req.body || {};
  // expected: name, description, collectDuration, baseEntries, roleEntries: [{roleId, entries}]
  SETUPS[id] = { id, ...body };
  saveSetups();
  res.json({ ok: true, id, setup: SETUPS[id] });
});
app.delete('/api/setups/:id', (req, res) => {
  const id = req.params.id;
  if (SETUPS[id]) { delete SETUPS[id]; saveSetups(); res.json({ ok: true }); }
  else res.status(404).json({ ok: false, error: 'not found' });
});
app.get('/', (req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));

const server = http.createServer(app);
server.listen(PORT, () => console.log(`Web UI running at http://localhost:${PORT}`));

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel, Partials.Message]
});

let restarting = false;
async function tryRestartClient() {
  if (restarting) return;
  restarting = true;
  console.warn('Attempting to restart Discord client...');
  try { await client.destroy(); } catch (e) { console.warn('destroy error', e); }
  setTimeout(async () => {
    try {
      await client.login(BOT_TOKEN);
      console.log('Client restarted successfully');
    } catch (err) {
      console.error('Restart failed:', err);
      setTimeout(() => { restarting = false; tryRestartClient(); }, 5000);
    }
    restarting = false;
  }, 2000);
}

// HMAC -> float in [0,1)
function hmacFloat(serverSeed, message) {
  const h = crypto.createHmac('sha512', serverSeed).update(message).digest('hex');
  const prefix = h.slice(0, 13); // 13 hex chars -> up to 52 bits
  const intVal = parseInt(prefix, 16);
  const denom = Math.pow(16, 13);
  return intVal / denom;
}

function makeParticipantsDescription(entries) {
  const byUser = {};
  for (const e of entries) byUser[e.userId] = (byUser[e.userId] || 0) + 1;
  const lines = Object.entries(byUser).slice(0, 100).map(([uid, count]) => `• <@${uid}> — ${count} entries`);
  return lines.join('\n') || 'No participants yet.';
}

// Join queue (1 join per second)
class JoinQueue {
  constructor() { this.queue = []; this.processing = false; }
  push(task) { this.queue.push(task); this.startProcessing(); }
  startProcessing() {
    if (this.processing) return;
    this.processing = true;
    (async () => {
      while (this.queue.length) {
        const t = this.queue.shift();
        try { await t(); } catch (e) { console.error('Error processing join task', e); }
        await new Promise(r => setTimeout(r, 1000));
      }
      this.processing = false;
    })();
  }
}
const joinQueue = new JoinQueue();

// Utility to persist single giveaway
function persistGiveaway(gwId) {
  GIVEAWAYS[gwId] = GIVEAWAYS[gwId] || {};
  fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify(GIVEAWAYS, null, 2));
}

// Text command $start {setup}
client.on('messageCreate', async (message) => {
  try {
    if (!message.content.startsWith('$start')) return;
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      await message.reply('Only administrators can start a giveaway.');
      return;
    }
    const args = message.content.trim().split(/\s+/).slice(1);
    const setupArg = args[0];
    if (!setupArg) {
      await message.reply('Usage: $start {setupNameOrId}');
      return;
    }
    const setup = Object.values(SETUPS).find(s => s.name === setupArg || s.id === setupArg) || SETUPS[setupArg];
    if (!setup) {
      await message.reply(`Setup "${setupArg}" not found. Create it in the web UI.`);
      return;
    }
    const collectDuration = parseInt(setup.collectDuration || 30);

    const gwId = `gw_${Date.now()}`;
    const gw = {
      id: gwId,
      channelId: message.channel.id,
      messageId: null,
      setupId: setup.id,
      setup,
      entries: [], // per-entry rows {id, userId, username}
      entrantsByUser: {},
      collecting: true,
      startAt: Date.now(),
      endAt: Date.now() + collectDuration * 1000,
      clientSeed1: null,
      clientSeed2: null,
      serverSeed: SERVER_SEED,
      finalFloats: null,
      winner: null
    };
    GIVEAWAYS[gwId] = gw;
    persistGiveaway(gwId);

    const joinBtn = new ButtonBuilder().setCustomId(`join_${gwId}`).setLabel('Join Giveaway').setStyle(ButtonStyle.Success);
    const verifyBtn = new ButtonBuilder().setCustomId(`verify_${gwId}`).setLabel('Verify / Run').setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(joinBtn, verifyBtn);

    const embed = new EmbedBuilder()
      .setTitle(`Giveaway — ${setup.name}`)
      .setDescription(setup.description || 'Battle Royale giveaway. Click Join to enter!')
      .addFields(
        { name: 'Entries', value: '0', inline: true },
        { name: 'Collecting ends', value: `<t:${Math.floor(gw.endAt / 1000)}:R>`, inline: true }
      )
      .setFooter({ text: 'Live updating — updated every 1s' });

    const sent = await message.channel.send({ embeds: [embed], components: [row] });
    gw.messageId = sent.id;
    persistGiveaway(gwId);

    // live update loop for this giveaway (1s)
    const updateInterval = setInterval(async () => {
      try {
        const g = GIVEAWAYS[gwId];
        if (!g) { clearInterval(updateInterval); return; }
        const now = Date.now();
        if (g.collecting && now >= g.endAt) { g.collecting = false; persistGiveaway(gwId); }

        const channel = await client.channels.fetch(g.channelId).catch(() => null);
        if (!channel) return;
        const msg = await channel.messages.fetch(g.messageId).catch(() => null);
        if (!msg) return;

        const participantsDesc = makeParticipantsDescription(g.entries);
        const embed2 = new EmbedBuilder()
          .setTitle(`Giveaway — ${g.setup.name}`)
          .setDescription(g.setup.description || 'Battle Royale giveaway')
          .addFields(
            { name: 'Entries', value: `${g.entries.length}`, inline: true },
            { name: 'Collecting', value: `${g.collecting ? 'Yes' : 'No'}`, inline: true },
            { name: 'Ends At', value: `<t:${Math.floor(g.endAt / 1000)}:R>`, inline: true }
          )
          .addFields({ name: 'Participants (sample)', value: participantsDesc });

        const joinBtn2 = new ButtonBuilder().setCustomId(`join_${gwId}`).setLabel('Join Giveaway').setStyle(ButtonStyle.Success).setDisabled(!g.collecting);
        const verifyBtn2 = new ButtonBuilder().setCustomId(`verify_${gwId}`).setLabel('Verify / Run').setStyle(ButtonStyle.Secondary);
        const comp = [new ActionRowBuilder().addComponents(joinBtn2, verifyBtn2)];

        await msg.edit({ embeds: [embed2], components: comp }).catch(e => console.warn('edit fail', e));

        // when collecting ended -> notify once
        if (!g.collecting && now - g.endAt < 2000) {
          await channel.send(`Collection ended. Total entries: ${g.entries.length}. Creator should press Verify and provide seeds to run the Battle Royale.`);
        }
      } catch (e) {
        console.error('updateInterval error', e);
      }
    }, 1000);

    await message.reply(`Giveaway started with setup "${setup.name}". Message posted.`);
  } catch (err) {
    console.error('messageCreate error', err);
  }
});

// interaction handler (buttons & modals)
client.on('interactionCreate', async (interaction) => {
  try {
    // Modal submit for seeds
    if (interaction.type === InteractionType.ModalSubmit) {
      const customId = interaction.customId || '';
      if (customId.startsWith('seeds_')) {
        const gwId = customId.split('_')[1];
        const gw = GIVEAWAYS[gwId];
        if (!gw) return await interaction.reply({ content: 'Giveaway not found', ephemeral: true });
        // Only giveaway creator (the author who started it) can submit seeds => we do not have that in state; we require administrator or message author
        const cs1 = interaction.fields.getTextInputValue('clientSeed1').trim();
        const cs2 = interaction.fields.getTextInputValue('clientSeed2').trim();
        gw.clientSeed1 = cs1;
        gw.clientSeed2 = cs2;
        persistGiveaway(gwId);
        await interaction.reply({ content: 'Seeds received. Running Battle Royale now...', ephemeral: true });
        runBattleRoyale(gwId).catch(e => {
          console.error('runBattleRoyale error', e);
          // attempt to inform creator channel
        });
      }
      return;
    }

    if (!interaction.isButton()) return;

    const customId = interaction.customId || '';
    // robust handling and guard against Unknown Interaction errors
    try {
      if (customId.startsWith('join_')) {
        const gwId = customId.split('_')[1];
        const gw = GIVEAWAYS[gwId];
        if (!gw) return await interaction.reply({ content: 'Giveaway not found', ephemeral: true });
        if (!gw.collecting) return await interaction.reply({ content: 'Collection already ended.', ephemeral: true });

        // push join task into queue
        joinQueue.push(async () => {
          // compute entry count based on setup roleEntries
          let entryCount = gw.setup.baseEntries ? parseInt(gw.setup.baseEntries) : 1;
          try {
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (member && gw.setup.roleEntries && Array.isArray(gw.setup.roleEntries)) {
              for (const re of gw.setup.roleEntries) {
                if (!re.roleId) continue;
                if (member.roles.cache.has(re.roleId)) {
                  entryCount = Math.max(entryCount, parseInt(re.entries || entryCount));
                }
              }
            }
          } catch (e) {
            console.warn('role check failed', e);
          }

          const newEntries = [];
          for (let i = 0; i < entryCount; i++) {
            const row = { id: `e_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, userId: interaction.user.id, username: interaction.user.username };
            gw.entries.push(row);
            newEntries.push(row);
          }
          gw.entrantsByUser[interaction.user.id] = (gw.entrantsByUser[interaction.user.id] || 0) + newEntries.length;
          persistGiveaway(gwId);

          // try followUp first (since we might be replying in queued context)
          try {
            if (interaction.replied || interaction.deferred) {
              await interaction.followUp({ content: `You joined the giveaway with ${newEntries.length} entries.`, ephemeral: true });
            } else {
              await interaction.reply({ content: `You joined the giveaway with ${newEntries.length} entries.`, ephemeral: true });
            }
          } catch (e) {
            // best effort: ignore
            console.warn('reply/followUp failed for join', e);
          }
        });

      } else if (customId.startsWith('verify_')) {
        const gwId = customId.split('_')[1];
        const gw = GIVEAWAYS[gwId];
        if (!gw) return await interaction.reply({ content: 'Giveaway not found', ephemeral: true });
        // Show a modal to collect seeds
        const modal = new ModalBuilder().setCustomId(`seeds_${gwId}`).setTitle('Provide Seeds (clientSeed1, clientSeed2)');
        const cs1 = new TextInputBuilder().setCustomId('clientSeed1').setLabel('clientSeed1 (block hash or seed)').setStyle(TextInputStyle.Short).setRequired(true);
        const cs2 = new TextInputBuilder().setCustomId('clientSeed2').setLabel('clientSeed2 (creator input)').setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(cs1), new ActionRowBuilder().addComponents(cs2));
        await interaction.showModal(modal);
      }
    } catch (err) {
      console.error('interaction handling error', err);
      // If Unknown Interaction (10062) or similar, try restart
      if (err.code === 10062 || (err.message && err.message.includes('Unknown interaction'))) {
        console.warn('Unknown interaction detected — attempting client restart');
        tryRestartClient();
      }
    }

  } catch (err) {
    console.error('Fatal interactionCreate error', err);
  }
});

// Core: runBattleRoyale
async function runBattleRoyale(gwId) {
  const gw = GIVEAWAYS[gwId];
  if (!gw) throw new Error('Giveaway not found');
  if (!gw.clientSeed1 || !gw.clientSeed2) throw new Error('Seeds missing');
  const channel = await client.channels.fetch(gw.channelId).catch(() => null);
  if (!channel) throw new Error('Channel not found');
  const msg = await channel.messages.fetch(gw.messageId).catch(() => null);
  if (!msg) throw new Error('Giveaway message not found');

  if (gw.entries.length === 0) {
    await channel.send('No entries — cannot run Battle Royale.');
    return;
  }

  // compute a provably-fair float per entry using entry index (0..n-1)
  const entries = gw.entries.slice();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const message = `${gw.clientSeed1}:${gw.clientSeed2}:${i}`;
    e.pfFloat = hmacFloat(gw.serverSeed, message);
  }

  // sort descending => highest floats first (so top floats are winners)
  entries.sort((a,b) => b.pfFloat - a.pfFloat);

  // rounds percentages (rounds 1-3). Round 4 eliminates until 1 remains.
  const rounds = [0.30, 0.40, 0.25];

  // We'll maintain currentEntries (sorted desc)
  let currentEntries = entries.slice();

  // announce start
  await channel.send({ content: `Battle Royale starting now with ${currentEntries.length} entries. Rounds will run with 3s gaps and each round runs for 4.5s (visual).` });

  // helper to render per-user remaining with strikethrough if 0
  function renderState(entriesList) {
    const byUser = {};
    for (const e of entriesList) byUser[e.userId] = (byUser[e.userId] || 0) + 1;
    const lines = [];
    for (const [uid, cnt] of Object.entries(byUser)) {
      lines.push(cnt > 0 ? `• <@${uid}> — ${cnt} entries` : `~~• <@${uid}> — 0 entries~~`);
    }
    return lines.slice(0, 100).join('\n') || 'No participants.';
  }

  // perform rounds 1-3
  for (let r = 0; r < rounds.length; r++) {
    const eliminatePercent = rounds[r];
    await new Promise(res => setTimeout(res, 3000)); // 3s gap before round

    // visual progression over 4.5s -> updates
    const updates = 5;
    for (let u = 0; u < updates; u++) {
      // fraction of elimination progressed
      const frac = (u + 1) / updates;
      const eliminateCount = Math.floor(eliminatePercent * currentEntries.length * frac);
      const previewEntries = currentEntries.slice(0, Math.max(1, currentEntries.length - eliminateCount));
      const embed = new EmbedBuilder()
        .setTitle(`Round ${r+1} — Eliminating ${Math.round(eliminatePercent * 100)}% total`)
        .setDescription(`Progress ${u+1}/${updates}`)
        .addFields(
          { name: 'Remaining entries', value: `${previewEntries.length}`, inline: true },
          { name: 'Round progress', value: `${Math.round(frac * 100)}%`, inline: true },
        )
        .addFields({ name: 'Participants (sample)', value: renderState(previewEntries) });
      try { await msg.edit({ embeds: [embed] }); } catch (e) { console.warn('edit failed during round preview', e); }
      await new Promise(res => setTimeout(res, Math.floor(4500 / updates)));
    }

    // apply elimination: keep top (1 - eliminatePercent)
    const keepCount = Math.max(1, Math.floor(currentEntries.length * (1 - eliminatePercent)));
    const eliminated = currentEntries.slice(keepCount);
    currentEntries = currentEntries.slice(0, keepCount);

    // announce round result
    const embedResult = new EmbedBuilder()
      .setTitle(`Round ${r+1} finished`)
      .setDescription(`${eliminated.length} entries eliminated this round.`)
      .addFields({ name: 'Remaining entries', value: `${currentEntries.length}`, inline: true })
      .addFields({ name: 'Participants (sample)', value: renderState(currentEntries) });
    try { await msg.channel.send({ embeds: [embedResult] }); } catch (e) { console.warn('send fail', e); }
  }

  // Round 4: eliminate gradually until 1 remains.
  // We'll perform a visual progressive elimination over repeated small steps inside 4.5s segments until only 1 remains.
  await new Promise(res => setTimeout(res, 3000)); // 3s gap before final round

  // to make "slow elimination" we will eliminate floor(n * 0.25) then keep eliminating in small chunks each 1s until 1 left.
  // But to respect "each round runs 4.5s", we'll do iterative mini-rounds of 4.5s visual windows; if more time needed, continue.
  let finalRoundCount = 0;
  while (currentEntries.length > 1) {
    finalRoundCount++;
    // In each pass eliminate a fraction proportional: e.g., 1 to 2 entries each pass depending on size.
    const toEliminate = Math.max(1, Math.floor(currentEntries.length * 0.12)); // small chunk
    const updates = 5;
    for (let u = 0; u < updates; u++) {
      const frac = (u + 1) / updates;
      const elimCountNow = Math.min(currentEntries.length - 1, Math.floor(toEliminate * frac));
      const previewEntries = currentEntries.slice(0, Math.max(1, currentEntries.length - elimCountNow));
      const embed = new EmbedBuilder()
        .setTitle(`Final Round — Stage ${finalRoundCount}`)
        .setDescription(`Eliminating gradually until 1 remains.`)
        .addFields({ name: 'Remaining entries', value: `${previewEntries.length}`, inline: true })
        .addFields({ name: 'Participants (sample)', value: renderState(previewEntries) });
      try { await msg.edit({ embeds: [embed] }); } catch (e) { console.warn('edit fail final round preview', e); }
      await new Promise(res => setTimeout(res, Math.floor(4500 / updates)));
    }

    // apply elimination
    const keepCount = Math.max(1, currentEntries.length - toEliminate);
    const eliminated = currentEntries.slice(keepCount);
    currentEntries = currentEntries.slice(0, keepCount);

    // brief pause 1s between passes (also ensures embed live updates anywhere else)
    await new Promise(res => setTimeout(res, 1000));
  }

  // Winner is the single remaining entry
  const winnerEntry = currentEntries[0];
  gw.winner = winnerEntry;
  gw.finalFloats = entries.map(e => ({ id: e.id, userId: e.userId, pfFloat: e.pfFloat }));
  persistGiveaway(gwId);

  // Announce winner with verify details
  const winnerEmbed = new EmbedBuilder()
    .setTitle(`🏆 Winner: <@${winnerEntry.userId}>`)
    .setDescription(`Winning entry id: ${winnerEntry.id}\nFloat: ${winnerEntry.pfFloat}`)
    .addFields(
      { name: 'ClientSeed1', value: `${gw.clientSeed1}`, inline: false },
      { name: 'ClientSeed2', value: `${gw.clientSeed2}`, inline: false },
      { name: 'ServerSeed (public)', value: `${gw.serverSeed}`, inline: false }
    )
    .setTimestamp();
  await msg.channel.send({ embeds: [winnerEmbed] });

  // Edit original embed to show ended
  try {
    const endEmbed = new EmbedBuilder()
      .setTitle(`Giveaway — ${gw.setup.name} (Ended)`)
      .setDescription(`Winner: <@${winnerEntry.userId}>`)
      .addFields({ name: 'Total entries', value: `${gw.entries.length}`, inline: true })
      .addFields({ name: 'Winner entry', value: `${winnerEntry.id}`, inline: true });
    const components = []; // disable buttons by removing
    await msg.edit({ embeds: [endEmbed], components }).catch(e => console.warn('edit original embed after end failed', e));
  } catch (e) {
    console.warn('final edit failed', e);
  }

  // Save final state
  GIVEAWAYS[gwId] = gw;
  persistGiveaway(gwId);
}

// login the client
(async () => {
  if (!BOT_TOKEN) {
    console.warn('BOT_TOKEN not set. Bot will not log in to Discord but web UI is available.');
    return;
  }
  try {
    await client.login(BOT_TOKEN);
    console.log('Discord client logged in.');
  } catch (e) {
    console.error('Discord login failed', e);
  }
})();
