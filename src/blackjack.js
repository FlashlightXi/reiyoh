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
const other = (emoji) => (emoji === HIT ? STAND : HIT);
const statusOf = (error) => error?.status ?? error?.httpStatus ?? error?.code;

// Leaves only the better choice on OwO's message (needs Manage Messages):
// - clears every reaction of the worse emoji (OwO's and the player's) at once,
// - when OwO deals the next card, clears both emojis and re-adds the better one as Reiyo's reaction,
//   so the next choice is always one fresh click.
// Never removes the player's reaction one by one: OwO treats a removal of the player's reaction as a click,
// whereas clearing a whole emoji (MESSAGE_REACTION_REMOVE_EMOJI) and Reiyo's own reactions are ignored by OwO.
// OwO's collector only checks which emoji the player adds, so who added the reaction first does not matter.
// Without Manage Messages it falls back to marking the better choice with Reiyo's own reaction.
export function createBlackjackHelper({
  state, writer, owoBotId, react, unreact, clearEmoji, removeReaction, resolveOwner = () => null,
  onError = () => {}, initialDelayMs = 1500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  state.users ??= {};
  const games = new Map(); // messageId -> per-game reaction state
  let settings = Promise.resolve();
  let canClear = typeof clearEmoji === 'function';

  const enabled = (userId) => Boolean(userId && state.users[userId]?.blackjackHint?.enabled);
  const autoOn = (userId) => Boolean(enabled(userId) && state.users[userId]?.blackjackHint?.auto);

  function saveHint(userId, change) {
    const result = settings.catch(() => {}).then(async () => {
      const user = state.users[userId] ??= { cooldowns: {}, tickets: null, recent: [] };
      const previous = user.blackjackHint;
      const next = change({ enabled: false, auto: false, ...previous });
      user.blackjackHint = next;
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
  const setEnabled = (userId, value) =>
    saveHint(userId, (hint) => ({ ...hint, enabled: value ?? !hint.enabled })).then((hint) => hint.enabled);
  // Auto mode: also turns the hint on, since it builds on the one-choice display.
  const setAuto = (userId, value) => saveHint(userId, (hint) => {
    const auto = value ?? !hint.auto;
    return { enabled: auto ? true : hint.enabled, auto };
  });

  function track(messageId, channelId) {
    let entry = games.get(messageId);
    if (!entry) {
      entry = { channelId, want: null, own: null, hand: null, ownerHit: false, autoHand: null, chain: Promise.resolve(), started: false };
      games.set(messageId, entry);
      if (games.size > RECENT_LIMIT) games.delete(games.keys().next().value);
    }
    return entry;
  }

  // Clear every reaction of one emoji; false without the permission (then we fall back to marking).
  async function clear(entry, messageId, emoji) {
    if (!canClear) return false;
    try {
      await clearEmoji(entry.channelId, messageId, emoji);
    } catch (error) {
      const status = statusOf(error);
      if (status === 403 || status === 50013) { canClear = false; return false; }
      if (status !== 404 && status !== 10014) throw error; // nothing to clear yet
    }
    if (entry.own === emoji) entry.own = null;
    if (emoji === HIT) entry.ownerHit = false;
    return true;
  }

  // Auto mode: removing the player's own 👊 is read by OwO as another hit. Do it once per dealt card,
  // only when the player's 👊 from the previous hit is still there and hitting is again the better move.
  async function autoHit(entry, messageId) {
    if (!removeReaction || !autoOn(entry.ownerId) || !entry.ownerHit || entry.autoHand === entry.hand) return false;
    entry.autoHand = entry.hand;
    entry.ownerHit = false;
    try { await removeReaction(entry.channelId, messageId, HIT, entry.ownerId); }
    catch (error) {
      const status = statusOf(error);
      if (status === 403 || status === 50013 || status === 404 || status === 10014) return false;
      throw error;
    }
    return true;
  }

  async function apply(entry, messageId, handChanged) {
    const want = entry.want;
    if (!want) {
      if (entry.own) { await unreact(entry.channelId, messageId, entry.own); entry.own = null; }
      games.delete(messageId);
      return;
    }
    if (entry.own && entry.own !== want) { await unreact(entry.channelId, messageId, entry.own); entry.own = null; }
    await clear(entry, messageId, other(want));
    if (handChanged && want === HIT && await autoHit(entry, messageId)) return;
    // After a new card, also reset the better emoji so the player's previous click is gone.
    if (handChanged) await clear(entry, messageId, want);
    if (entry.own !== want) { await react(entry.channelId, messageId, want); entry.own = want; }
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
    if (!enabled(ownerId) && !tracked) return null;
    const advice = enabled(ownerId) ? adviseBlackjack(game) : null;
    const want = advice?.emoji ?? null;
    const entry = track(messageId, channelId);
    entry.ownerId = ownerId;
    const hand = `${game.player.join(',')}|${game.dealer.join(',')}`;
    entry.chain = entry.chain.catch(() => {}).then(async () => {
      if (!entry.started) {
        entry.started = true;
        // Let OwO add 👊 and 🛑 first so the reaction order stays the same.
        if (event === 'create' && initialDelayMs > 0) await sleep(initialDelayMs);
      }
      const handChanged = entry.hand !== null && entry.hand !== hand;
      // Gateway often sends the same edit twice; skip states already applied.
      if (entry.hand === hand && entry.want === want && entry.own === want) return;
      entry.hand = hand;
      entry.want = want;
      await apply(entry, messageId, handChanged);
    }).catch(onError);
    return advice;
  }

  // Raw MESSAGE_REACTION_ADD / MESSAGE_REACTION_REMOVE.
  // OwO adding the worse choice after we cleared it is cleared again; the player's 👊 is tracked for auto mode.
  function observeReaction(packet, type = 'add') {
    const emoji = packet?.emoji?.name;
    const messageId = packet?.message_id;
    if (!messageId || (emoji !== HIT && emoji !== STAND)) return;
    const entry = games.get(messageId);
    if (!entry) return;
    if (packet.user_id && packet.user_id === entry.ownerId) {
      if (emoji === HIT) entry.ownerHit = type === 'add';
      return;
    }
    if (type !== 'add' || packet.user_id !== owoBotId) return;
    entry.chain = entry.chain.catch(() => {}).then(async () => {
      if (entry.want && emoji !== entry.want) await clear(entry, messageId, emoji);
    }).catch(onError);
  }

  return {
    observe, observeReaction, setEnabled, setAuto, enabled,
    pending: () => Promise.all([...games.values()].map((entry) => entry.chain)),
  };
}

export function blackjackAutoText({ enabled, auto }) {
  return auto
    ? `**blackjack 自動ヒット: ON**\n最適手の1択表示に加えて、${HIT} を押した後もヒットが最適なら、令夭があなたの ${HIT} を外して次のヒットを進めます（OwO はリアクションを外すことも押したと判定するため）。スタンドや手が変わる場面は、これまでどおりあなたが押します。\n-# 令夭があなたの代わりに OwO のゲームを進める機能です。OwO の自動化に関する決まりに触れるおそれがあり、その責任はあなたのアカウントにかかります。\`gx bj auto off\` で止められます。`
    : `**blackjack 自動ヒット: OFF**\n${enabled ? '1択表示は続けます。押すのは毎回あなたです。' : '令夭はリアクションに触れません。'}`;
}

export function blackjackSettingText(on) {
  return on
    ? `**blackjack 最適手: ON**\nOwO blackjack の進行中、最適でない方のリアクション（${HIT} ヒット / ${STAND} スタンド）を令夭がまとめて消し、押せるのを最適手の1つだけにします。カードが増えるたびに両方を消して最適手を令夭が付け直すので、毎回残っている1つを1回押すだけです。\n-# 令夭に「メッセージの管理」権限が無いチャンネルでは、最適手に令夭のリアクションを重ねて示します。52枚1デッキ・ディーラーは17以上で停止・同点と両者バーストは引き分け、という公開版OwOのルールで期待値を厳密計算しています。\`gx bj\` でOFF、\`gx bj auto\` で連続ヒットを令夭が進める自動ヒット。`
    : `**blackjack 最適手: OFF**\n令夭はリアクションに触れません。\`gx bj\` で再びONにできます。`;
}
