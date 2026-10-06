import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { commandInfo } from './observations.js';

// OwO の入力と Reiyo の操作だけを記録する。OwO の返信は author ID で判定する。
const relevantInput = /^(?:owo\S*|g(?:x(?:bl)?|h|b|curse|pray|boss)?)(?:\s|$)/i;

export function shouldCapture(message, config) {
  if (!message.guildId || !config.channelIds.includes(message.channelId)) return false;
  if (config.guildId && message.guildId !== config.guildId) return false;
  if (message.author?.id === config.owoBotId || config.observerBotIds?.includes(message.author?.id)) return true;
  const content = message.content?.trim() ?? '';
  return !message.author?.bot && (commandInfo(content) || relevantInput.test(content) || /owo/i.test(content)) ? true : false;
}

function serialize(message, event) {
  return {
    event,
    capturedAt: new Date().toISOString(),
    messageId: message.id,
    messageType: message.type,
    flags: message.flags?.bitfield ?? null,
    createdAt: message.createdAt?.toISOString() ?? null,
    editedAt: message.editedAt?.toISOString() ?? null,
    guildId: message.guildId,
    channelId: message.channelId,
    author: message.author && {
      id: message.author.id,
      username: message.author.username,
      bot: message.author.bot,
    },
    content: message.content ?? null,
    referenceMessageId: message.reference?.messageId ?? null,
    embeds: message.embeds.map((embed) => embed.toJSON()),
    components: message.components.map((component) => component.toJSON()),
    attachments: [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      contentType: attachment.contentType,
      url: attachment.url,
    })),
  };
}

export function createLogger(logPath) {
  let pending = Promise.resolve();
  let captured = 0;

  return {
    get captured() { return captured; },
    write(message, event) {
      const line = JSON.stringify(serialize(message, event)) + '\n';
      pending = pending.catch(() => {}).then(async () => {
        await mkdir(path.dirname(logPath), { recursive: true });
        await appendFile(logPath, line, 'utf8');
        captured++;
      });
      return pending;
    },
    flush() { return pending; },
  };
}
