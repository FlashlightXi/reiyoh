import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const USER_ID = /^\d{17,20}$/;
const plain = (value) => value?.toJSON ? value.toJSON() : value;

export function normalizeBattleLogUrl(value) {
  try {
    const url = new URL(value);
    const uuid = url.searchParams.get('uuid');
    if (url.protocol !== 'https:' || url.hostname !== 'owobot.com' || url.port
      || url.username || url.password || url.pathname !== '/battle-log'
      || url.searchParams.getAll('uuid').length !== 1 || !UUID.test(uuid ?? '')) return null;
    return { uuid: uuid.toLowerCase(), url: `https://owobot.com/battle-log?uuid=${uuid.toLowerCase()}` };
  } catch { return null; }
}

function avatarUserId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.discordapp.com' || url.port
      || url.username || url.password) return null;
    return /^\/avatars\/(\d{17,20})\//.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}

// Ownership is local to each embed or leaderboard row, never all links in a reply.
export function extractBattleLogEntries(message) {
  const sources = [];
  const add = (text, authorId = null, blockOwnerId = null, ambiguousBlock = false) => {
    if (typeof text === 'string') sources.push({ text, authorId, blockOwnerId, ambiguousBlock });
  };
  add(message.content);
  for (const value of message.embeds ?? []) {
    const embed = plain(value);
    const authorId = avatarUserId(embed.author?.icon_url);
    for (const text of [embed.title, embed.description, embed.footer?.text, embed.url, embed.author?.url]) add(text, authorId);
    for (const field of embed.fields ?? []) {
      const owners = [...new Set([...String(field.name ?? '').matchAll(/<@!?(\d{17,20})>/g)].map((match) => match[1]))];
      add(field.name, authorId);
      add(field.value, authorId, owners.length === 1 ? owners[0] : null, owners.length > 1);
    }
  }
  function visit(value) {
    const component = plain(value);
    if (!component) return;
    for (const text of [component.content, component.label, component.url]) add(text);
    for (const child of component.components ?? []) visit(child);
    if (component.accessory) visit(component.accessory);
  }
  for (const component of message.components ?? []) visit(component);

  const entries = [];
  const hasMentions = sources.some(({ text }) => /<@!?\d{17,20}>/.test(text));
  for (const { text, authorId, blockOwnerId, ambiguousBlock } of sources) {
    const rows = text.split(/\r?\n/);
    const hasOwnerRows = rows.some((row) => /<@!?\d{17,20}>/.test(row) && /https:\/\//i.test(row));
    for (const row of rows) {
      const mentions = [...row.matchAll(/<@!?(\d{17,20})>/g)].map((match) => match[1]);
      const rowOwners = [...new Set(mentions)];
      for (const match of row.matchAll(/https:\/\/[^\s<>"\])]+/gi)) {
        const entry = normalizeBattleLogUrl(match[0]);
        if (entry) entries.push({ ...entry, rowOwnerId: rowOwners.length === 1 ? rowOwners[0] : blockOwnerId,
          authorId, needsRowOwner: hasOwnerRows || (!authorId && hasMentions),
          ambiguousRow: ambiguousBlock || rowOwners.length > 1 });
      }
    }
  }
  return entries;
}

export async function createBattleLogStore(filePath, { append = appendFile, onWarning = () => {} } = {}) {
  const records = new Map();
  let needsBoundary = false;
  let warnings = 0;
  let pending = Promise.resolve();
  try {
    const text = await readFile(filePath, 'utf8');
    needsBoundary = text.length > 0 && !text.endsWith('\n');
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const normalized = normalizeBattleLogUrl(record.url);
        if (!USER_ID.test(record.userId ?? '') || !normalized || record.uuid !== normalized.uuid) throw new Error('invalid record');
        records.set(`${record.userId}:${normalized.uuid}`, { ...record, ...normalized });
      } catch {
        warnings++;
        onWarning(`gxbl: URL記録の${index + 1}行目を読めません。保存済みとは扱いません。`);
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  return {
    save(record) {
      const operation = pending.catch(() => {}).then(async () => {
        const key = `${record.userId}:${record.uuid}`;
        if (records.has(key)) return false;
        await mkdir(path.dirname(filePath), { recursive: true });
        const prefix = needsBoundary ? '\n' : '';
        try { await append(filePath, prefix + JSON.stringify(record) + '\n', 'utf8'); }
        catch (error) {
          needsBoundary = true;
          warnings++;
          onWarning('gxbl: URL記録の保存に失敗しました。保存済みとは扱いません。');
          throw error;
        }
        needsBoundary = false;
        records.set(key, record);
        return true;
      });
      pending = operation;
      return operation;
    },
    list(userId) { return [...records.values()].filter((record) => record.userId === userId); },
    get warnings() { return warnings; },
    flush() { return pending.catch(() => {}); },
  };
}

export async function createBattleLogService({ state, writer, filePath, owoBotId,
  resolveReference = async () => null, now = Date.now, onWarning = () => {}, append }) {
  const store = await createBattleLogStore(filePath, { append, onWarning });
  let pending = Promise.resolve();
  const run = (operation) => {
    const result = pending.catch(() => {}).then(operation);
    pending = result;
    return result;
  };
  state.users ??= {};

  return {
    toggle(userId) {
      return run(async () => {
        const user = state.users[userId] ??= { cooldowns: {}, tickets: null, recent: [] };
        const previous = user.battleLogCapture;
        const enabled = !previous?.enabled;
        user.battleLogCapture = { enabled, enabledAt: enabled ? now() : previous?.enabledAt ?? 0 };
        try { await writer.save(state); }
        catch (error) {
          if (previous === undefined) delete user.battleLogCapture;
          else user.battleLogCapture = previous;
          // Other callers may have queued a snapshot containing the tentative flag.
          try { await writer.save(state); }
          catch { onWarning('gxbl: 設定の復元を保存できません。再起動後の設定を確認してください。'); }
          throw error;
        }
        return { enabled, count: store.list(userId).length };
      });
    },
    capture(message, { input } = {}) {
      return run(async () => {
        if (message.author?.id !== owoBotId) return 0;
        const entries = extractBattleLogEntries(message);
        if (!entries.length) return 0;
        let referenced = null;
        if (message.reference?.messageId) {
          try {
            const source = await resolveReference(message);
            if (source?.channelId === message.channelId && source.author && !source.author.bot
              && USER_ID.test(source.author.id)) referenced = source.author.id;
          } catch { /* Missing references do not justify guessing an owner. */ }
        }
        // A unique pending input is a timing guess, not proof of log ownership.
        const cachedOwner = input?.kind === 'battle' && message.reference?.messageId === input.id ? input.userId : null;
        const actor = message.interactionMetadata?.user?.id ?? message.interaction?.user?.id;
        const actorId = USER_ID.test(actor ?? '') ? actor : null;
        let saved = 0;
        for (const entry of entries) {
          let userId = entry.rowOwnerId;
          if (entry.ambiguousRow || (entry.needsRowOwner && !userId)) continue;
          if (!userId) {
            const owners = [...new Set([entry.authorId, referenced, cachedOwner, actorId].filter(Boolean))];
            if (owners.length !== 1) continue;
            [userId] = owners;
          }
          const setting = state.users[userId]?.battleLogCapture;
          if (!setting?.enabled || !Number.isFinite(setting.enabledAt)
            || !Number.isFinite(message.createdTimestamp) || message.createdTimestamp < setting.enabledAt) continue;
          saved += Number(await store.save({ userId, uuid: entry.uuid, url: entry.url,
            guildId: message.guildId, channelId: message.channelId,
            inputId: input?.userId === userId ? input.id : referenced === userId ? message.reference.messageId : null,
            messageId: message.id, createdAt: new Date(message.createdTimestamp).toISOString(),
            recordedAt: new Date(now()).toISOString() }));
        }
        return saved;
      });
    },
    export(userId) {
      return run(async () => {
        await store.flush();
        const urls = store.list(userId).map((record) => record.url);
        return { count: urls.length, text: urls.length ? urls.join('\n') + '\n' : '', warnings: store.warnings };
      });
    },
    async flush() { await pending; await store.flush(); },
  };
}
