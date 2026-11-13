// OwO blackjack: read the game embed, compute the better action and mirror it as Reiyo's own reaction.
// Rules follow the public OwO implementation: one 52-card deck without the cards on the table,
// dealer draws below 17 (soft 17 stands), wins pay 1:1, no blackjack bonus, and a player bust
// still pushes when the dealer also busts.

export const HIT = '👊';
export const STAND = '🛑';
const FULL_DECK = [0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 16]; // index 1 = ace, 10 = ten-value cards

const best = (hard, aces) => (aces && hard + 10 <= 21 ? hard + 10 : hard);

export function cardRank(name = '') {
  const match = /^(a|10|[2-9]|j|q|k)[cdhs]/i.exec(name);
  if (!match) return null;
  const rank = match[1].toLowerCase();
  if (rank === 'a') return 1;
  if ('jqk'.includes(rank)) return 10;
  return Number(rank);
}

function cardsIn(text = '') {
  return [...String(text).matchAll(/<a?:([a-z0-9]+):\d+>/gi)].map((match) => match[1]);
}

function embedData(embed) {
  if (!embed) return null;
  if (typeof embed.toJSON === 'function') return embed.toJSON();
  return embed.data ?? embed;
}

// Accepts a discord.js Message or a raw Gateway message payload.
export function parseBlackjack(message) {
  for (const raw of message?.embeds ?? []) {
    const embed = embedData(raw);
    const author = embed?.author ?? {};
    const title = /^(.+), you bet ([\d,]+) to play blackjack/i.exec(author.name ?? '');
    if (!title) continue;
    const fields = embed.fields ?? [];
    const dealerField = fields.find((field) => /^Dealer\b/.test(field.name ?? ''));
    const playerField = fields.find((field) => field !== dealerField && (field.name ?? '').startsWith(title[1]));
    if (!dealerField || !playerField) return null;
    const ranks = (field) => cardsIn(field.value).map(cardRank).filter(Boolean);
    const footer = embed.footer?.text ?? '';
    const avatarId = /\/avatars\/(\d{15,22})\//.exec(author.icon_url ?? '')?.[1] ?? null;
    return {
      username: title[1],
      bet: Number(title[2].replaceAll(',', '')),
      ownerId: avatarId,
      dealer: ranks(dealerField),
      player: ranks(playerField),
      hiddenDealer: /cardback/i.test(dealerField.value ?? ''),
      inProgress: /game in progress|resuming previous game/i.test(footer),
    };
  }
  return null;
}

export function handValue(ranks) {
  const hard = ranks.reduce((sum, rank) => sum + rank, 0);
  const aces = ranks.includes(1);
  return { hard, aces, points: best(hard, aces), soft: aces && hard + 10 <= 21 };
}

export function remainingDeck(cards) {
  const deck = FULL_DECK.slice();
  for (const rank of cards) if (deck[rank] > 0) deck[rank] -= 1;
  return deck;
}

// Exact expected values (bet = 1) for standing and for hitting then playing optimally.
export function bestAction(playerRanks, dealerUp) {
  const deck = remainingDeck([...playerRanks, dealerUp]);
  const dealerMemo = new Map();
  const playerMemo = new Map();

  // Distribution of the dealer's final total: index 0..4 = 17..21, 5 = bust.
  function dealer(hard, aces) {
    const points = best(hard, aces);
    if (points > 21) return [0, 0, 0, 0, 0, 1];
    if (points >= 17) { const out = [0, 0, 0, 0, 0, 0]; out[points - 17] = 1; return out; }
    const key = `${deck.join(',')}|${hard}|${aces ? 1 : 0}`;
    const cached = dealerMemo.get(key);
    if (cached) return cached;
    const total = deck.reduce((sum, count) => sum + count, 0);
    const out = [0, 0, 0, 0, 0, 0];
    for (let rank = 1; rank <= 10; rank += 1) {
      const count = deck[rank];
      if (!count) continue;
      deck[rank] -= 1;
      const next = dealer(hard + rank, aces || rank === 1);
      deck[rank] += 1;
      for (let i = 0; i < 6; i += 1) out[i] += (count / total) * next[i];
    }
    dealerMemo.set(key, out);
    return out;
  }

  const upHard = dealerUp;
  const upAce = dealerUp === 1;
  const standEv = (points) => {
    const dist = dealer(upHard, upAce);
    let ev = dist[5];
    for (let i = 0; i < 5; i += 1) {
      const dealerPoints = 17 + i;
      if (points > dealerPoints) ev += dist[i];
      else if (points < dealerPoints) ev -= dist[i];
    }
    return ev;
  };
  const bustEv = () => -(1 - dealer(upHard, upAce)[5]);

  function play(hard, aces) {
    const key = `${deck.join(',')}|${hard}|${aces ? 1 : 0}`;
    const cached = playerMemo.get(key);
    if (cached) return cached;
    const stand = standEv(best(hard, aces));
    const total = deck.reduce((sum, count) => sum + count, 0);
    let hit = 0;
    for (let rank = 1; rank <= 10; rank += 1) {
      const count = deck[rank];
      if (!count) continue;
      deck[rank] -= 1;
      const nextAces = aces || rank === 1;
      hit += (count / total) * (best(hard + rank, nextAces) > 21 ? bustEv() : play(hard + rank, nextAces).value);
      deck[rank] += 1;
    }
    const result = { stand, hit, value: Math.max(stand, hit) };
    playerMemo.set(key, result);
    return result;
  }

  const { hard, aces } = handValue(playerRanks);
  const { stand, hit } = play(hard, aces);
  return { action: hit > stand ? 'hit' : 'stand', emoji: hit > stand ? HIT : STAND, hit, stand };
}

export function adviseBlackjack(game) {
  if (!game?.inProgress || game.dealer.length !== 1 || game.player.length < 2) return null;
  if (handValue(game.player).points > 21) return null;
  return bestAction(game.player, game.dealer[0]);
}

const RECENT_LIMIT = 200;

export function createBlackjackHelper({
  state, writer, owoBotId, react, unreact, resolveOwner = () => null,
  onError = () => {}, initialDelayMs = 1500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  state.users ??= {};
  const games = new Map(); // messageId -> { emoji, chain }
  let settings = Promise.resolve();

  const enabled = (userId) => Boolean(userId && state.users[userId]?.blackjackHint?.enabled);

  function setEnabled(userId, value) {
    const result = settings.catch(() => {}).then(async () => {
      const user = state.users[userId] ??= { cooldowns: {}, tickets: null, recent: [] };
      const previous = user.blackjackHint;
      const next = value ?? !previous?.enabled;
      user.blackjackHint = { enabled: next };
      try { await writer.save(state); }
      catch (error) {
        if (previous === undefined) delete user.blackjackHint;
        else user.blackjackHint = previous;
        await writer.save(state).catch(() => {});
        throw error;
      }
      return next;
    });
    settings = result;
    return result;
  }

  function track(messageId) {
    let entry = games.get(messageId);
    if (!entry) {
      entry = { emoji: null, chain: Promise.resolve(), started: false };
      games.set(messageId, entry);
      if (games.size > RECENT_LIMIT) games.delete(games.keys().next().value);
    }
    return entry;
  }

  // event: 'create' for the first send, 'update' for edits (hit, stand, resume).
  function observe(message, event = 'update') {
    const authorId = message?.author?.id;
    if (!authorId || authorId !== owoBotId) return null;
    const game = parseBlackjack(message);
    if (!game) return null;
    const messageId = message.id;
    const channelId = message.channelId ?? message.channel_id;
    if (!messageId || !channelId) return null;
    const tracked = games.get(messageId);
    const ownerId = game.ownerId ?? tracked?.ownerId ?? resolveOwner(game.username, message);
    if (!enabled(ownerId) && !tracked?.emoji) return null;
    const advice = enabled(ownerId) ? adviseBlackjack(game) : null;
    const want = advice?.emoji ?? null;
    const entry = track(messageId);
    entry.ownerId = ownerId;
    entry.chain = entry.chain.catch(() => {}).then(async () => {
      if (!entry.started) {
        entry.started = true;
        // Let OwO add 👊 and 🛑 first so the reaction order stays the same.
        if (event === 'create' && initialDelayMs > 0) await sleep(initialDelayMs);
      }
      if (entry.emoji === want) { if (!want) games.delete(messageId); return; }
      if (entry.emoji) { await unreact(channelId, messageId, entry.emoji); entry.emoji = null; }
      if (want) { await react(channelId, messageId, want); entry.emoji = want; }
      if (!want) games.delete(messageId);
    }).catch(onError);
    return advice;
  }

  return { observe, setEnabled, enabled, pending: () => Promise.all([...games.values()].map((entry) => entry.chain)) };
}

export function blackjackSettingText(on) {
  return on
    ? `**blackjack 最適手リアクション: ON**\nOwO blackjack の進行中、令夭が最適手と同じリアクション（${HIT} ヒット / ${STAND} スタンド）を付け、カードが増えるたびに付け替えます。決着したら外します。\n-# 52枚1デッキ・ディーラーは17以上で停止・同点と両者バーストは引き分け、という公開版OwOのルールで期待値を厳密計算しています。\`gx bj\` でOFF。`
    : `**blackjack 最適手リアクション: OFF**\n令夭はリアクションを付けません。\`gx bj\` で再びONにできます。`;
}
