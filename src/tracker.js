const DURATIONS = { owo: 10_000, hunt: 15_000, battle: 15_000, curse: 300_000, pray: 300_000 };
const KINDS = Object.keys(DURATIONS);
const RESPONSE_WINDOW_MS = 20_000;
const RESET_UTC_HOUR = 7; // JST 16:00。OwO の実リセット時刻は実ログで再確認する。

export function parseInput(content) {
  const value = content.trim().toLowerCase();
  if (value === 'owo') return 'owo';
  if (/^(?:gboss|owo\s*boss)\s+(?:t|ticket)$/.test(value)) return 'ticket';
  if (/^(?:gh|owo\s*h(?:unt)?|owoh(?:unt)?)(?:\s|$)/.test(value)) return 'hunt';
  if (/^(?:gb|owo\s*b(?:attle)?|owob(?:attle)?)(?:\s|$)/.test(value)) return 'battle';
  if (/^(?:gcurse|owo\s*curse|owocurse)(?:\s|$)/.test(value)) return 'curse';
  if (/^(?:gpray|owo\s*pray|owopray)(?:\s|$)/.test(value)) return 'pray';
  return null;
}

function flattenComponent(component) {
  return [component.content, component.label, ...(component.components ?? []).flatMap(flattenComponent)]
    .filter(Boolean).join('\n');
}

export function responseText(message) {
  return [
    message.content,
    ...message.embeds.flatMap((embed) => [
      embed.title, embed.description, ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
      embed.footer?.text,
    ]),
    ...message.components.map(flattenComponent),
  ].filter(Boolean).join('\n');
}

export function parseTicketCount(text) {
  const normalized = text.normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/\\\/|[⁄∕／⧸]/g, '/').replace(/[*_`~|]/g, '');
  if (/(?:you\s+)?(?:ran\s+out\s+of|have\s+no|do\s+not\s+have\s+any|don't\s+have\s+any)\s+(?:boss\s+)?tickets?/i.test(normalized)) return 0;
  const patterns = [
    /(?:boss\s*)?tickets?[^\n\d]{0,40}([0-3])\s*\/\s*3/i,
    /([0-3])\s*\/\s*3[^\n]{0,50}(?:boss|tickets?)/i,
    /(?:boss\s*)?tickets?[^\n\d]{0,40}([0-3])\s*(?:left|remaining|available)/i,
    /([0-3])\s*(?:boss\s*)?tickets?\s*(?:left|remaining|available)/i,
    /(?<!\d)([0-3])\s*\/\s*3(?=[^\n]{0,80}\b(?:boss\s+)?tickets?\b)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match) return Number(match[1]);
  }
  return null;
}

export function cycleStart(now = Date.now()) {
  const offset = RESET_UTC_HOUR * 60 * 60 * 1000;
  return Math.floor((now - offset) / 86_400_000) * 86_400_000 + offset;
}

function isCooldownReply(text) {
  return /(?:cool\s*down|please\s+wait|you\s+(?:must|need\s+to)\s+wait|try\s+again\s+in|wait\s+\d+\s*(?:seconds?|minutes?|secs?|mins?)|クールダウン|あと\d+\s*(?:秒|分))/i.test(text);
}

function responseKind(text) {
  if (parseTicketCount(text) !== null) return 'ticket';
  if (/owobot\.com\/battle-log\?|\bbattl(?:e|ing)\b/i.test(text)) return 'battle';
  if (/\bhunt(?:ing)?\b|caught\s+(?:an?\s+)?animal/i.test(text)) return 'hunt';
  if (/\bcurs(?:e|ed|ing)\b/i.test(text)) return 'curse';
  if (/\bpray(?:ed|ing)?\b/i.test(text)) return 'pray';
  return null;
}

export class Tracker {
  constructor(state = { users: {} }) {
    this.state = state;
    this.state.users ??= {};
    this.pending = new Map();
    this.responses = new Map();
  }

  user(id) {
    return this.state.users[id] ??= { cooldowns: {}, tickets: null, recent: [] };
  }

  observeInput(message) {
    const content = message.content ?? '';
    const kind = parseInput(content);
    const owoCounted = /owo/i.test(content);
    if (!kind && !owoCounted) return { kind: null, owoCounted: false };
    const at = message.createdTimestamp;
    if (owoCounted) {
      const user = this.user(message.author.id);
      if (!user.cooldowns.owo || at >= user.cooldowns.owo.at) {
        user.cooldowns.owo = { at, until: at + DURATIONS.owo, inputId: message.id, responseId: null };
      }
      user.recent.unshift({ kind: kind ?? 'owo', at, inputId: message.id, responseId: null,
        result: '文中の owo から10秒を開始', preview: content });
      user.recent = user.recent.slice(0, 8);
    }
    if (!kind || kind === 'owo') return { kind, owoCounted };
    const pending = (this.pending.get(message.channelId) ?? [])
      .filter((item) => at - item.at <= RESPONSE_WINDOW_MS);
    pending.push({ id: message.id, userId: message.author.id, channelId: message.channelId, kind, at });
    this.pending.set(message.channelId, pending.slice(-50));
    return { kind, owoCounted };
  }

  observeResponse(message) {
    const text = responseText(message);
    let input = this.responses.get(message.id);
    if (!input) {
      const at = message.createdTimestamp;
      const pending = (this.pending.get(message.channelId) ?? [])
        .filter((item) => at >= item.at && at - item.at <= RESPONSE_WINDOW_MS);
      this.pending.set(message.channelId, pending);
      const referenced = message.reference?.messageId;
      input = pending.find((item) => item.id === referenced);
      const kind = responseKind(text);
      if (!input) {
        const matching = kind && pending.filter((item) => item.kind === kind);
        if (matching?.length === 1) input = matching[0];
      }
      if (!input && pending.length === 1 && (!kind || pending[0].kind === kind)) input = pending[0];
      if (!input) return { status: pending.length ? 'ambiguous' : 'unmatched' };
      this.pending.set(message.channelId, pending.filter((item) => item.id !== input.id));
      this.responses.set(message.id, input);
    } else if (input.kind !== 'ticket') {
      return { status: 'duplicate' };
    }

    const user = this.user(input.userId);
    const at = message.createdTimestamp;
    let result;
    if (input.kind === 'ticket') {
      const remaining = parseTicketCount(text);
      if (remaining === null) result = 'チケット数を抽出できず';
      else {
        if (!user.tickets || at >= user.tickets.observedAt) {
          user.tickets = { remaining, observedAt: at, responseId: message.id };
        }
        result = `ボスチケット ${remaining}/3`;
      }
    } else if (isCooldownReply(text)) {
      result = 'OwO の待機応答。開始せず';
    } else {
      const previous = user.cooldowns[input.kind];
      if (!previous || at >= previous.at) {
        const cooldown = {
          at, until: at + DURATIONS[input.kind], inputId: input.id, responseId: message.id,
        };
        user.cooldowns[input.kind] = cooldown;
        if (input.kind === 'pray' || input.kind === 'curse') {
          user.cooldowns.pray = cooldown;
          user.cooldowns.curse = cooldown;
        }
      }
      result = 'OwO 返信から開始（成功判定は暫定）';
    }
    user.recent.unshift({ kind: input.kind, at, inputId: input.id, responseId: message.id,
      result, preview: text.slice(0, 180) });
    user.recent = user.recent.slice(0, 8);
    return { status: 'matched', userId: input.userId, kind: input.kind, result };
  }

  snapshot(userId, now = Date.now()) {
    const user = this.state.users[userId] ?? { cooldowns: {}, tickets: null, recent: [] };
    const cooldowns = Object.fromEntries(KINDS.map((kind) => [kind, user.cooldowns?.[kind] ?? null]));
    const shared = [cooldowns.pray, cooldowns.curse].filter(Boolean)
      .sort((a, b) => b.until - a.until)[0] ?? null;
    cooldowns.pray = shared;
    cooldowns.curse = shared;
    const tickets = user.tickets;
    return {
      cooldowns,
      tickets: tickets && {
        ...tickets,
        replenishmentEstimate: tickets.observedAt < cycleStart(now),
        nextResetAt: cycleStart(now) + 86_400_000,
      },
      recent: user.recent ?? [],
      pending: [...this.pending.values()].flat().filter((item) => item.userId === userId && now - item.at <= RESPONSE_WINDOW_MS),
    };
  }
}
