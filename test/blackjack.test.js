import test from 'node:test';
import assert from 'node:assert/strict';
import { adviseBlackjack, bestAction, cardRank, createBlackjackHelper, HIT, parseBlackjack, STAND } from '../src/blackjack.js';

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
    react: async (c, m, e) => { calls.push(['+', m, e]); },
    unreact: async (c, m, e) => { calls.push(['-', m, e]); },
    onError: (error) => { throw error; }, ...overrides,
  });
  return { helper, calls, state };
}

test('OFFの人のゲームにはリアクションしない', async () => {
  const { helper, calls } = setup();
  helper.observe(owoMessage(), 'create');
  await helper.pending();
  assert.deepEqual(calls, []);
});

test('ONなら最適手を付け、手が変わったら付け替え、決着で外す', async () => {
  const { helper, calls, state } = setup();
  assert.equal(await helper.setEnabled(USER), true);
  assert.equal(state.users[USER].blackjackHint.enabled, true);
  helper.observe(owoMessage({ player: '<a:10cf:3> <a:6hf:4>', dealer: '<a:kdf:1> <:cardback:2>' }), 'create');
  helper.observe(owoMessage({ player: '<a:10cf:3> <a:6hf:4>', dealer: '<a:kdf:1> <:cardback:2>', raw: true }), 'update');
  helper.observe(owoMessage({ player: '<:10c:3> <:6h:4> <a:4hf:5>', dealer: '<a:kdf:1> <:cardback:2>', raw: true }), 'update');
  helper.observe(owoMessage({ player: '<:10c:3> <:6h:4> <:4h:5>', dealer: '<:kd:1> <a:8df:2>', footer: '🎲 ~ You won 250,000', raw: true }), 'update');
  await helper.pending();
  assert.deepEqual(calls, [['+', 'm1', HIT], ['-', 'm1', HIT], ['+', 'm1', STAND], ['-', 'm1', STAND]]);
});

test('途中でOFFにすると付けたリアクションを外す', async () => {
  const { helper, calls } = setup();
  await helper.setEnabled(USER, true);
  helper.observe(owoMessage(), 'create');
  await helper.pending();
  await helper.setEnabled(USER, false);
  helper.observe(owoMessage({ raw: true }), 'update');
  await helper.pending();
  assert.deepEqual(calls, [['+', 'm1', STAND], ['-', 'm1', STAND]]);
});

test('既定アバターでは名前から本人を解決する', async () => {
  const { helper, calls } = setup({ resolveOwner: (name) => (name === 'tester' ? USER : null) });
  await helper.setEnabled(USER, true);
  helper.observe(owoMessage({ icon: 'https://cdn.discordapp.com/embed/avatars/1.png' }), 'create');
  await helper.pending();
  assert.equal(calls.length, 1);
});

test('OwO以外の投稿は無視する', async () => {
  const { helper, calls } = setup();
  await helper.setEnabled(USER, true);
  helper.observe({ ...owoMessage(), author: { id: 'someone' } }, 'create');
  await helper.pending();
  assert.deepEqual(calls, []);
});
