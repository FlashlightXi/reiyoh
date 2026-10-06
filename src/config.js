import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

const snowflake = /^\d{17,20}$/;
const DEFAULT_OWO_BOT_ID = '408785106942164992';

export function readConfig() {
  const envFile = path.resolve(process.env.REIYO_ENV_FILE || '.env');
  if (existsSync(envFile)) loadEnvFile(envFile);
  const token = process.env.DISCORD_TOKEN?.trim();
  const owoBotId = process.env.OWO_BOT_ID?.trim() || DEFAULT_OWO_BOT_ID;
  const guildId = process.env.GUILD_ID?.trim();
  if (guildId && !snowflake.test(guildId)) throw new Error('GUILD_IDはサーバーIDを指定してください');
  const channelIds = [...new Set((process.env.LOG_CHANNEL_IDS ?? '')
    .split(',').map((id) => id.trim()).filter(Boolean))];

  if (!token) throw new Error('DISCORD_TOKEN を .env に設定してください');
  if (!snowflake.test(owoBotId)) throw new Error('OWO_BOT_ID に OwO Bot のユーザー ID を設定してください');
  if (channelIds.some((id) => !snowflake.test(id))) {
    throw new Error('LOG_CHANNEL_IDS に対象チャンネル ID をカンマ区切りで設定してください');
  }

  return {
    token,
    guildId,
    owoBotId,
    channelIds,
    logPath: path.resolve(process.env.LOG_PATH?.trim() || 'data/owo-messages.jsonl'),
    statePath: path.resolve(process.env.STATE_PATH?.trim() || 'data/state.json'),
    emojiMapPath: path.resolve(process.env.EMOJI_MAP_PATH?.trim() || 'aa.txt'),
  };
}
