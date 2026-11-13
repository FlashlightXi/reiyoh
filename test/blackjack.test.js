import test from 'node:test';
import assert from 'node:assert/strict';
import { adviseBlackjack, bestAction, blackjackModeText, cardRank, createBlackjackHelper, HIT, parseBlackjack, STAND } from '../src/blackjack.js';

const OWO = '408785106942164992', USER = '111111111111111111';
const avatar = `https://cdn.discordapp.com/avatars/${USER}/hash.png?size=128`;
function owoMessage({ id = 'm1', dealer = '<a:7df:1> <:cardback:2>', player = '<a:qcf:3> <a:8hf:4>', footer = '🎲 ~ game in progress', icon = avatar, raw = false } = {}) {
  const embed = { author: { name: 'tester, you bet 250,000 to play blackjack', icon_url: icon }, footer: { text: footer },
    fields: [{ name: 'Dealer `[7+?]`', value: dealer }, { name: 'tester `[18]`', value: player }] };
  return raw ? { id, channel_id: 'c1', guild_id: 'g1', author: { id: OWO }, embeds: [embed] }
    : { id, channelId: 'c1', guildId: 'g1', author: { id: OWO }, embeds: [{ toJSON: () => embed }] };
}

test('OwOのカード絵文字名からランクを読む', () => {
  assert.equal(cardRank('ahf'), 1);
  assert.equal(cardRank('10sf'), 10);
  assert.equal(cardRank('qcf'), 10);
  assert.equal(cardRank('2s'), 2);
  assert.equal(cardRank('cardback'), null);
});

test('進行中のblackjack embedを解析する（discord.jsとraw両方）', () => {
  for (const raw of [false, true]) {
    const game = parseBlackjack(owoMessage({ raw }));
    assert.deepEqual({ ...game }, { username: 'tester', bet: 250000, ownerId: USER, dealer: [7], player: [10, 8], hiddenDealer: true, inProgress: true });
  }
  assert.equal(parseBlackjack({ embeds: [{ author: { name: 'tester goes into battle' } }] }), null);
});

test('期待値の比較で代表的な局面の最適手を選ぶ', () => {
  assert.equal(bestAction([10, 6], 10).action, 'hit');
  assert.equal(bestAction([10, 10], 5).action, 'stand');
  assert.equal(bestAction([5, 6], 10).action, 'hit');
  assert.equal(bestAction([10, 10, 1], 1).action, 'stand');
  const { hit, stand } = bestAction([10, 8], 7);
  assert.ok(stand > hit);
});

test('決着後・ディーラー公開後は助言しない', () => {
  assert.equal(adviseBlackjack(parseBlackjack(owoMessage({ footer: '🎲 ~ You won 250,000' }))), null);
  assert.equal(adviseBlackjack(parseBlackjack(owoMessage({ dealer: '<a:7df:1> <a:9hf:2>' }))), null);
});

function setup(overrides = {}) {
  const calls = [];
  const state = { users: {} };
  const helper = createBlackjackHelper({
    state, writer: { save: async () => {} }, owoBotId: OWO, initialDelayMs: 0,
    react: async (c, m, e) => { calls.push(['+', e]); },
    unreact: async (c, m, e) => { calls.push(['-', e]); },
    clearEmoji: async (c, m, e) => { calls.push(['clear', e]); },
    onError: (error) => { throw error; }, ...overrides,
  });
  return { helper, calls, state };
}
const hand = (player, dealer = '<a:kdf:1> <:cardback:2>', extra = {}) => owoMessage({ player, dealer, ...extra });
const reaction = (emoji, user = OWO) => ({ user_id: user, message_id: 'm1', channel_id: 'c1', emoji: { name: emoji } });

test('OFFの人のゲームには触れない', async () => {
  const { helper, calls } = setup();
  helper.observe(owoMessage(), 'create');
  helper.observeReaction(reaction(HIT));
  await helper.pending();
  assert.deepEqual(calls, []);
});

test('不利な方を絵文字ごと消し、カードが増えたら両方消して最適手を付け直す', async () => {
  const { helper, calls, state } = setup();
  assert.equal(await helper.setEnabled(USER), true);
  assert.equal(state.users[USER].blackjackHint.enabled, true);
  helper.observe(hand('<a:10cf:3> <a:6hf:4>'), 'create');                       // 16 vs K: hit
  helper.observe(hand('<a:10cf:3> <a:6hf:4>', undefined, { raw: true }), 'update'); // same hand: nothing new
  helper.observe(hand('<:10c:3> <:6h:4> <a:4hf:5>', undefined, { raw: true }), 'update'); // 20: stand
  helper.observe(hand('<:10c:3> <:6h:4> <:4h:5>', '<:kd:1> <a:8df:2>', { footer: '🎲 ~ You won 250,000', raw: true }), 'update');
  await helper.pending();
  assert.deepEqual(calls, [
    ['clear', STAND], ['+', HIT],
    ['-', HIT], ['clear', HIT], ['clear', STAND], ['+', STAND],
    ['-', STAND],
  ]);
});

test('本人のリアクションは個別に消さない（絵文字ごとの消去だけ）', async () => {
  const { helper, calls } = setup();
  await helper.setEnabled(USER, true);
  helper.observe(hand('<a:10cf:3> <a:2hf:4>', '<a:4df:1> <:cardback:2>'), 'create');     // 12 vs 4: hit
  helper.observeReaction(reaction(HIT, USER));
  helper.observe(hand('<:10c:3> <:2h:4> <a:2sf:5>', '<a:4df:1> <:cardback:2>', { raw: true }), 'update'); // 14 vs 4: hit
  await helper.pending();
  assert.deepEqual(calls, [['clear', STAND], ['+', HIT], ['clear', STAND], ['clear', HIT], ['+', HIT]]);
});

test('OwOが後から不利な方を付けたら消し直す', async () => {
  const { helper, calls } = setup();
  await helper.setEnabled(USER, true);
  helper.observe(owoMessage(), 'create');           // 18 vs 7: stand
  await helper.pending();
  helper.observeReaction(reaction(STAND));
  helper.observeReaction(reaction(HIT));
  await helper.pending();
  assert.deepEqual(calls, [['clear', HIT], ['+', STAND], ['clear', HIT]]);
});

test('メッセージの管理権限が無ければ最適手に令夭のリアクションを重ねるだけ', async () => {
  const denied = Object.assign(new Error('Missing Permissions'), { status: 403 });
  const { helper, calls } = setup({ clearEmoji: async () => { throw denied; } });
  await helper.setEnabled(USER, true);
  helper.observe(owoMessage(), 'create');
  await helper.pending();
  assert.deepEqual(calls, [['+', STAND]]);
});

test('途中でOFFにすると令夭のリアクションを外して手を引く', async () => {
  const { helper, calls } = setup();
  await helper.setEnabled(USER, true);
  helper.observe(owoMessage(), 'create');
  await helper.pending();
  await helper.setEnabled(USER, false);
  helper.observe(owoMessage({ raw: true }), 'update');
  await helper.pending();
  assert.deepEqual(calls.at(-1), ['-', STAND]);
});

test('既定アバターでは名前から本人を解決する', async () => {
  const { helper, calls } = setup({ resolveOwner: (name) => (name === 'tester' ? USER : null) });
  await helper.setEnabled(USER, true);
  helper.observe(owoMessage({ icon: 'https://cdn.discordapp.com/embed/avatars/1.png' }), 'create');
  await helper.pending();
  assert.ok(calls.length > 0);
});

test('OwO以外の投稿は無視する', async () => {
  const { helper, calls } = setup();
  await helper.setEnabled(USER, true);
  helper.observe({ ...owoMessage(), author: { id: 'someone' } }, 'create');
  await helper.pending();
  assert.deepEqual(calls, []);
});

test('autoモード: 押した後もヒットが最適なら本人の👊を外して次のヒットを進める', async () => {
  const calls = [];
  const { helper, state } = setup({ removeReaction: async (c, m, e, u) => { calls.push(['remove', e, u]); } });
  const hint = await helper.setAuto(USER);
  assert.deepEqual(hint, { enabled: true, auto: true });
  assert.deepEqual(state.users[USER].blackjackHint, { enabled: true, auto: true });
  helper.observe(hand('<a:2cf:3> <a:3hf:4>', '<a:10df:1> <:cardback:2>'), 'create');                // 5 vs 10: hit
  helper.observeReaction(reaction(HIT, USER));                                                      // player hits
  helper.observe(hand('<:2c:3> <:3h:4> <a:2sf:5>', '<a:10df:1> <:cardback:2>', { raw: true }), 'update'); // 7 vs 10: hit -> auto
  await helper.pending();
  assert.deepEqual(calls, [['remove', HIT, USER]]);
  helper.observeReaction(reaction(HIT, USER), 'remove');
  helper.observe(hand('<:2c:3> <:3h:4> <:2s:5> <a:2df:6>', '<a:10df:1> <:cardback:2>', { raw: true }), 'update'); // 9: hit, but player's 👊 is gone
  await helper.pending();
  assert.equal(calls.length, 1);                                                                    // next hit is the player's click
});

test('autoモードでもスタンドが最適なら外さない・autoがOFFなら外さない', async () => {
  const calls = [];
  const { helper } = setup({ removeReaction: async (c, m, e, u) => { calls.push(['remove', e, u]); } });
  await helper.setAuto(USER, true);
  helper.observe(hand('<a:10cf:3> <a:2hf:4>', '<a:4df:1> <:cardback:2>'), 'create');
  helper.observeReaction(reaction(HIT, USER));
  helper.observe(hand('<:10c:3> <:2h:4> <a:8sf:5>', '<a:4df:1> <:cardback:2>', { raw: true }), 'update'); // 20: stand
  await helper.pending();
  assert.deepEqual(calls, []);
  assert.deepEqual(await helper.setAuto(USER, false), { enabled: true, auto: false });
  const second = setup({ removeReaction: async (c, m, e, u) => { calls.push(['remove', e, u]); } });
  await second.helper.setEnabled(USER, true);
  second.helper.observe(hand('<a:2cf:3> <a:3hf:4>', '<a:10df:1> <:cardback:2>'), 'create');
  second.helper.observeReaction(reaction(HIT, USER));
  second.helper.observe(hand('<:2c:3> <:3h:4> <a:2sf:5>', '<a:10df:1> <:cardback:2>', { raw: true }), 'update');
  await second.helper.pending();
  assert.deepEqual(calls, []);
});

test('gx bj off/on/auto のモード切替と表示', async () => {
  const { helper, state } = setup();
  assert.equal(helper.modeOf(USER), 'off');
  assert.equal(await helper.setMode(USER, 'auto'), 'auto');
  assert.deepEqual(state.users[USER].blackjackHint, { enabled: true, auto: true, left: false, plain: false });
  assert.equal(helper.modeOf(USER), 'auto');
  await helper.setMode(USER, 'on');
  assert.equal(helper.modeOf(USER), 'on');
  await helper.setMode(USER, 'off');
  assert.equal(helper.modeOf(USER), 'off');
  const text = blackjackModeText('on', true);
  assert.match(text, /最適手: ON\*\* に切り替えました/);
  assert.match(text, /▶ `gx bj on`/);
  for (const mode of ['off', 'on', 'auto']) assert.match(text, new RegExp(`gx bj ${mode}`));
});

test('on left: 両方残して最適手を常に左に並べる', async () => {
  const { helper, calls } = setup();
  await helper.setMode(USER, 'on', 'left');
  assert.equal(helper.layoutOf(USER), 'left');
  helper.observe(hand('<a:10cf:3> <a:6hf:4>'), 'create');                                  // 16 vs K: hit
  helper.observe(hand('<a:10cf:3> <a:6hf:4>', undefined, { raw: true }), 'update');            // duplicate edit
  helper.observe(hand('<:10c:3> <:6h:4> <a:4hf:5>', undefined, { raw: true }), 'update');      // 20: stand
  await helper.pending();
  assert.deepEqual(calls, [
    ['clear', HIT], ['clear', STAND], ['+', HIT], ['+', STAND],
    ['clear', STAND], ['clear', HIT], ['+', STAND], ['+', HIT],
  ]);
  assert.match(blackjackModeText('on', true, 'left'), /最適手: ON LEFT\*\*/);
});

test('on left: OwOが後から付けたら並べ直す', async () => {
  const { helper, calls } = setup();
  await helper.setMode(USER, 'on', 'left');
  helper.observe(owoMessage(), 'create');           // 18 vs 7: stand
  await helper.pending();
  helper.observeReaction(reaction(HIT));
  await helper.pending();
  assert.deepEqual(calls.slice(4), [['clear', STAND], ['clear', HIT], ['+', STAND], ['+', HIT]]);
});

test('auto left: 2回目のヒットは本人の👊を外して進める', async () => {
  const calls = [];
  const { helper } = setup({ removeReaction: async (c, m, e, u) => { calls.push(['remove', e, u]); } });
  await helper.setMode(USER, 'auto', 'left');
  helper.observe(hand('<a:2cf:3> <a:3hf:4>', '<a:10df:1> <:cardback:2>'), 'create');
  await helper.pending();
  helper.observeReaction(reaction(HIT, USER));
  helper.observe(hand('<:2c:3> <:3h:4> <a:2sf:5>', '<a:10df:1> <:cardback:2>', { raw: true }), 'update');
  await helper.pending();
  assert.deepEqual(calls, [['remove', HIT, USER]]);
});

test('on plain: 最初の1手は令夭が重ねず、カードが増えたら付け直す', async () => {
  const { helper, calls } = setup();
  await helper.setMode(USER, 'on', 'plain');
  assert.equal(helper.layoutOf(USER), 'plain');
  helper.observe(hand('<a:10cf:3> <a:6hf:4>'), 'create');                                  // 16 vs K: hit
  helper.observe(hand('<a:10cf:3> <a:6hf:4>', undefined, { raw: true }), 'update');
  helper.observe(hand('<:10c:3> <:6h:4> <a:2hf:5>', undefined, { raw: true }), 'update');      // 18 vs K: stand
  await helper.pending();
  assert.deepEqual(calls, [['clear', STAND], ['clear', HIT], ['clear', STAND], ['+', STAND]]);
});
