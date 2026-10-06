import { Client, GatewayIntentBits } from 'discord.js';
import { readConfig } from './config.js';
import { createLogger, shouldCapture } from './log.js';
import { loadState } from './state.js';

const config = readConfig();
const state = await loadState(config.statePath);
config.channelIds = state.channels ?? config.channelIds;
config.guildId = state.guildId ?? config.guildId;
config.observerBotIds = state.observerBotIds ?? [];
if (config.channelIds.length === 0) throw new Error('先に LOG_CHANNEL_IDS または gsetup で対象チャンネルを設定してください');
const requested = Number(process.argv[2] ?? 200);
if (!Number.isInteger(requested) || requested < 1 || requested > 500) {
  throw new Error('件数は 1〜500 の整数で指定してください: npm run backfill -- 200');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const logger = createLogger(config.logPath);

try {
  await client.login(config.token);
  for (const channelId of config.channelIds) {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !('messages' in channel)) {
      throw new Error(`${channelId} はメッセージを取得できるチャンネルではありません`);
    }
    if (config.guildId && channel.guildId !== config.guildId) throw new Error('対象サーバー外のチャンネルです');
    let before;
    let seen = 0;
    const messages = [];
    while (seen < requested) {
      const page = await channel.messages.fetch({ limit: Math.min(100, requested - seen), before });
      if (page.size === 0) break;
      seen += page.size;
      messages.push(...page.values());
      before = page.last().id;
    }
    messages.reverse();
    let kept = 0;
    for (const message of messages) {
      if (shouldCapture(message, config)) {
        await logger.write(message, 'backfill');
        kept++;
      }
    }
    console.log(`${channelId}: ${seen} 件確認、${kept} 件記録`);
  }
} finally {
  client.destroy();
  await logger.flush();
}
