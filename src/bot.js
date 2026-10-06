import { createBossRecords } from './boss-records.js';
import {handlePetPage} from './pet-pagination.js';
import {emojiText} from './display.js';
import {
  Client, ContainerBuilder, GatewayIntentBits, MessageFlags, Partials,
  PermissionFlagsBits, SlashCommandBuilder, TextDisplayBuilder,
} from 'discord.js';
import path from 'node:path';
import { readConfig } from './config.js';
import { createLogger, shouldCapture } from './log.js';
import { createStateWriter, loadState } from './state.js';
import { Tracker } from './tracker.js';
import { emojiList, loadEmojiMap } from './emoji.js';
import { statusText } from './status.js';
import { createBattleLogService } from './battle-log-links.js';
import { openObservations, snapshotMessage } from './observations.js';
import { createAiCommands } from './ai-commands.js';
import { createCollectionCommands, normalizeCommand } from './collection-commands.js';

const config = readConfig();
const state = await loadState(config.statePath);
state.channels ??= config.channelIds;
config.channelIds = state.channels;
config.guildId = state.guildId ?? config.guildId;
config.observerBotIds = state.observerBotIds ?? [];
let scopeReady = false;
const observations = openObservations(path.join(path.dirname(config.statePath), 'observations.sqlite'));
const bosses = createBossRecords({dbPath:path.join(path.dirname(config.statePath),'observations.sqlite'),config,onError:reportError});
const tracker = new Tracker(state);
const writer = createStateWriter(config.statePath);
const logger = createLogger(config.logPath);
const emojis = loadEmojiMap(config.emojiMapPath);
const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
], partials: [Partials.Message] });
const battleLogs = await createBattleLogService({
  state, writer, owoBotId: config.owoBotId,
  filePath: path.join(path.dirname(config.statePath), 'battle-log-links.jsonl'),
  resolveReference: (message) => message.fetchReference(),
  onWarning: (text) => console.warn('[reiyo]', text),
});

function reportError(error) { console.error('[reiyo]', error?.message ?? String(error)); }
function ts(milliseconds) { return `<t:${Math.floor(milliseconds / 1000)}:R>`; }
function safe(text) { return String(text).replaceAll('@', '@\u200b').replaceAll('`', 'ˈ'); }

async function reply(message, body, mention = false) {
  return message.reply({
    components: statusComponents(body),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], repliedUser: mention },
  });
}

function statusComponents(body) {
  return [new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(emojiText(body)))];
}

function scheduleStatusEdits(sent, snapshot) {
  const expirations = [...new Set(['owo', 'hunt', 'pray']
    .map((kind) => snapshot.cooldowns[kind]?.until)
    .filter((until) => until > Date.now()))].sort((a, b) => a - b);
  let lastEdit = Promise.resolve();
  for (const until of expirations) {
    const timer = setTimeout(() => {
      lastEdit = lastEdit.then(() => sent.edit({
        components: statusComponents(statusText(snapshot, emojis)),
        flags: MessageFlags.IsComponentsV2,
      })).catch(reportError);
    }, Math.max(0, until - Date.now()));
    timer.unref();
  }
}

function debug(userId, channelId) {
  const snapshot = tracker.snapshot(userId);
  const recent = snapshot.recent.slice(0, 5).map((item) =>
    `• ${item.kind} ${ts(item.at)}: ${safe(item.result)}\n  入力 ${item.inputId} / 返信 ${item.responseId ?? 'なし'}\n  ${safe(item.preview || '本文なし').slice(0, 150)}`);
  return `**Reiyo · gx 記録**\n接続: ${client.isReady() ? 'On' : 'Off'} / このチャンネル: ${config.channelIds.includes(channelId) ? '収集中' : '対象外'}\n起動後のログ: ${logger.captured}件 / 未応答入力: ${snapshot.pending.length}件\n直近の判定:\n${recent.length ? recent.join('\n') : 'まだありません'}\n-# 対応付けが曖昧な返信は状態に反映しません。生ログは ${safe(config.logPath)}。`;
}

async function capture(message, event) {
  if (scopeReady) observations.capture(snapshotMessage(message), event, config);
  if (shouldCapture(message, config)) await logger.write(message, event);
}

const collectionCommands = createCollectionCommands({ config, state, writer, store: observations, bosses, client, reply,
  isManager: (message) => message.member?.permissions.has(PermissionFlagsBits.ManageGuild) });

const aiCommands=createAiCommands({config});

async function saveResponseRecords(message, result) {
  const operations = [battleLogs.capture(message, { input: tracker.responses.get(message.id) })];
  if (result.status === 'matched') operations.push(writer.save(state));
  for (const outcome of await Promise.allSettled(operations)) {
    if (outcome.status === 'rejected') reportError(outcome.reason);
  }
}

const slashG = new SlashCommandBuilder().setName('g').setDescription('Reiyo の操作')
  .addSubcommand((command) => command.setName('x').setDescription('カウントダウン絵文字を一覧表示'));

async function registerSlashG(guild) {
  try {
    const commands = await guild.commands.fetch();
    const existing = commands.find((command) => command.name === 'g');
    if (existing) await existing.edit(slashG.toJSON());
    else await guild.commands.create(slashG.toJSON());
    console.log(`Registered /g x in ${guild.id}`);
  } catch (error) { reportError(error); }
}

client.once('clientReady', async () => {
  try {
    const channels = await Promise.all(config.channelIds.map(id => client.channels.fetch(id)));
    const guilds = [...new Set(channels.map(channel => channel?.guildId).filter(Boolean))];
    if (!config.guildId && guilds.length === 1) config.guildId = guilds[0];
    if (!config.guildId || guilds.some(id => id !== config.guildId)) throw new Error('GUILD_IDと収集チャンネルを同じ1サーバーに設定してください。');
    state.guildId = config.guildId;
    await writer.save(state);
    scopeReady = true;
    bosses.start();
  console.log(`Reiyo connected as ${client.user.tag}; watching ${config.channelIds.length} channel(s)`);
    const guild = client.guilds.cache.get(config.guildId);
    if (guild) await registerSlashG(guild);
    console.log('Collection ready: SQLite observations; text commands: gx help');
  } catch (error) { reportError(error); client.destroy(); observations.close(); process.exitCode = 1; }
});
client.on('guildCreate', (guild) => { if (scopeReady && guild.id === config.guildId) void registerSlashG(guild); });

// Raw Gateway edits preserve intermediate states without fetching each message via REST.
client.on('raw', (packet) => {
  if (!scopeReady || packet.t !== 'MESSAGE_UPDATE') return;
  try { observations.capture(packet.d, 'update', config); } catch (error) { reportError(error); }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && /^(pets|battle):/.test(interaction.customId)) {
    if (!scopeReady) return;
    try { await handlePetPage(interaction,config,client.user.id); } catch(error) { reportError(error); }
    return;
  }
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'g') return;
  try {
    if (!scopeReady || interaction.guildId !== config.guildId) {
      await interaction.reply({ content: 'このサーバーは対象外、または起動準備中です。', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.options.getSubcommand() !== 'x') return;
    const body = config.channelIds.includes(interaction.channelId)
      ? emojiList(emojis)
      : 'このチャンネルは対象外です。管理者は `gx collect on` で設定できます。';
    await interaction.reply({
      components: statusComponents(body),
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  } catch (error) { reportError(error); }
});

client.on('messageCreate', async (message) => {
  try {
    const normalized = normalizeCommand(message.content);
    const command = normalized.toLowerCase();
    if (!scopeReady || message.guildId !== config.guildId) return;
    if (!message.author.bot && await aiCommands(message, normalized)) return;
    if (!message.author.bot && await collectionCommands(message, command)) return;
    if (!config.channelIds.includes(message.channelId)) return;
    if (message.author.id === config.owoBotId) {
      const result = tracker.observeResponse(message);
      await capture(message, 'create');
      await saveResponseRecords(message, result);
      return;
    }
    if (message.author.bot) { await capture(message, 'create'); return; }
    if (/^gx logs(?:\s|$)/.test(command)) {
      await capture(message, 'create');
      if (command === 'gx logs') {
        try {
          const { enabled, count } = await battleLogs.toggle(message.author.id);
          await reply(message, `**戦闘Log Link記録: ${enabled ? 'ON' : 'OFF'}**\n本人分の保存: ${count}件。\n${enabled ? 'ON後に作成されたOwO返信から記録します。' : '既存の記録は残ります。'}\n\`gx logs export\` でURL一覧を受け取れます。`);
        } catch (error) {
          reportError(error);
          await reply(message, '記録設定の保存に失敗しました。切替結果は確認できません。');
        }
      } else if (command === 'gx logs export') {
        try {
          const exported = await battleLogs.export(message.author.id);
          const warning = exported.warnings ? '\n保存エラーの記録があります。完全な一覧とは限りません。' : '';
          if (!exported.count) await reply(message, `本人分の戦闘URLはまだ0件です。${warning}`);
          else await message.reply({
            content: `本人分の戦闘URL ${exported.count}件です。このファイルを分析先のチャットへ添付できます。${warning}`,
            files: [{ attachment: Buffer.from(exported.text, 'utf8'), name: 'battle-log-links.txt' }],
            allowedMentions: { parse: [], repliedUser: false },
          });
        } catch (error) {
          reportError(error);
          await reply(message, 'URL一覧を送信できませんでした。保存済みの記録は削除していません。');
        }
      } else await reply(message, '`gx logs` で記録ON/OFF、`gx logs export` で本人分のURL一覧を受け取れます。');
      return;
    }
    const ownCommand = command === 'g' || command.startsWith('gx ');
    const input = ownCommand ? null : tracker.observeInput(message);
    await capture(message, 'create');
    if (command === 'g') {
      const snapshot = tracker.snapshot(message.author.id);
      const sent = await reply(message, statusText(snapshot, emojis), true);
      scheduleStatusEdits(sent, snapshot);
    }
    else if (command === 'gx debug') await reply(message, debug(message.author.id, message.channelId));
    else if (command === 'gx emoji') await reply(message, emojiList(emojis));
    else if (ownCommand) await reply(message, 'コマンド一覧は `gx help` で確認できます。');
    else if (input?.owoCounted) await writer.save(state);
  } catch (error) { reportError(error); }
});

client.on('messageUpdate', async (oldMessage, updatedMessage) => {
  try {
    const message = updatedMessage;
    if (!scopeReady || message.guildId !== config.guildId) return;
    if (!config.channelIds.includes(message.channelId)) return;
    if (!observations.has(message.guildId,message.id) && !message.partial) {
      if (!oldMessage.partial) observations.capture(snapshotMessage(oldMessage), 'before-update', config);
      observations.capture(snapshotMessage(message), 'update', config);
    }
    // The raw event has already recorded the edit. Do not REST-fetch uncached messages.
    if (message.partial) return;
    if (shouldCapture(message, config)) await logger.write(message, 'update');
    if (message.author?.id === config.owoBotId) {
      const result = tracker.observeResponse(message);
      await saveResponseRecords(message, result);
    }
  } catch (error) { reportError(error); }
});

client.on('error', reportError);
async function shutdown() {
  client.destroy();
  try { await Promise.all([logger.flush(), writer.flush(), battleLogs.flush()]); } catch (error) { reportError(error); }
  await bosses.close();
  observations.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await client.login(config.token);
