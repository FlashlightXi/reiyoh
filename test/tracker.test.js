import test from 'node:test';
import assert from 'node:assert/strict';
import { cycleStart, parseInput, parseTicketCount, Tracker } from '../src/tracker.js';
import { countdownDisplay, emojiList } from '../src/emoji.js';
import { statusText } from '../src/status.js';

const t0 = Date.parse('2026-09-24T06:59:00Z');
function input(id, userId, content, at = t0) {
  return { id, author: { id: userId }, channelId: 'channel', content, createdTimestamp: at };
}
function response(id, content, at = t0 + 1000, referenceMessageId = null) {
  return { id, channelId: 'channel', content, createdTimestamp: at,
    reference: { messageId: referenceMessageId }, embeds: [], components: [] };
}

test('OwO の返信時刻からのみクールダウンを開始する', () => {
  const tracker = new Tracker();
  assert.equal(parseInput('gh'), 'hunt');
  tracker.observeInput(input('1', 'user', 'gh'));
  assert.equal(tracker.snapshot('user').cooldowns.hunt, null);
  const result = tracker.observeResponse(response('2', 'You caught an animal!'));
  assert.equal(result.status, 'matched');
  assert.equal(tracker.snapshot('user').cooldowns.hunt.until, t0 + 1000 + 15_000);
  tracker.observeResponse(response('2', 'You caught an animal!', t0 + 3000));
  assert.equal(tracker.snapshot('user').cooldowns.hunt.until, t0 + 1000 + 15_000);
});

test('待機応答や曖昧な返信ではクールダウンを開始しない', () => {
  const tracker = new Tracker();
  tracker.observeInput(input('1', 'a', 'gpray'));
  tracker.observeInput(input('2', 'b', 'gcurse'));
  assert.equal(tracker.observeResponse(response('3', 'OwO', t0 + 1000)).status, 'ambiguous');
  assert.equal(tracker.snapshot('a').cooldowns.pray, null);
  assert.equal(tracker.observeResponse(response('4', 'Please wait 20 seconds', t0 + 2000, '1')).status, 'matched');
  assert.equal(tracker.snapshot('a').cooldowns.pray, null);
});

test('boss t の返信に明示された枚数を記録し、補充後は推定とする', () => {
  const tracker = new Tracker();
  assert.equal(parseInput('gboss t'), 'ticket');
  assert.equal(parseTicketCount('Boss Tickets: 2/3'), 2);
  assert.equal(parseTicketCount('**2**/**3** boss tickets'), 2);
  assert.equal(parseTicketCount('you ran out of boss tickets'), 0);
  tracker.observeInput(input('1', 'user', 'gboss t'));
  tracker.observeResponse(response('2', 'Boss Tickets: 2/3'));
  assert.equal(tracker.snapshot('user', t0 + 2000).tickets.remaining, 2);
  assert.equal(cycleStart(Date.parse('2026-09-24T07:00:00Z')), Date.parse('2026-09-24T07:00:00Z'));
  assert.equal(tracker.snapshot('user', Date.parse('2026-09-24T07:00:00Z')).tickets.replenishmentEstimate, true);
});

test('単独 owo は返信を待たず入力から始め、他の返信との混同を防ぐ', () => {
  const tracker = new Tracker();
  tracker.observeInput(input('1', 'user', 'owo'));
  tracker.observeInput(input('2', 'user', 'gb', t0 + 500));
  assert.equal(tracker.snapshot('user').cooldowns.owo.until, t0 + 10_000);
  assert.equal(tracker.observeResponse(response('3', '[Log Link](https://owobot.com/battle-log?uuid=x)', t0 + 1200)).status, 'matched');
  assert.equal(tracker.snapshot('user').cooldowns.battle.until, t0 + 1200 + 15_000);
});

test('文中の owo は入力時から計り、同時に発した hunt は返信から計る', () => {
  const tracker = new Tracker();
  tracker.observeInput(input('1', 'user', 'hello owo!', t0));
  assert.equal(tracker.snapshot('user').cooldowns.owo.until, t0 + 10_000);
  tracker.observeInput(input('2', 'user', 'owo hunt', t0 + 500));
  assert.equal(tracker.snapshot('user').cooldowns.owo.until, t0 + 10_500);
  assert.equal(tracker.observeResponse(response('3', 'You caught an animal!', t0 + 1200)).status, 'matched');
  assert.equal(tracker.snapshot('user').cooldowns.hunt.until, t0 + 1200 + 15_000);
});

test('pray と curse は同じクールダウンを共有する', () => {
  const tracker = new Tracker();
  tracker.observeInput(input('1', 'user', 'gpray'));
  tracker.observeResponse(response('2', 'You prayed!', t0 + 1000));
  const snapshot = tracker.snapshot('user');
  assert.equal(snapshot.cooldowns.pray.until, t0 + 301_000);
  assert.deepEqual(snapshot.cooldowns.curse, snapshot.cooldowns.pray);
});

test('15秒以内は .5 と .0 に対応する絵文字、超過分は秒数にする', () => {
  const emojis = new Map([
    ['s085', '12345678901234567'], ['s090', '12345678901234568'],
    ['fa', '12345678901234569'], ['fb', '12345678901234560'],
  ]);
  assert.equal(countdownDisplay(8300, emojis), '<a:s085:12345678901234567><a:fa:12345678901234569>');
  assert.equal(countdownDisplay(8900, emojis), '<a:s090:12345678901234568><a:fb:12345678901234560>');
  assert.equal(countdownDisplay(15_001, emojis), '16');
  assert.equal(countdownDisplay(0, emojis), '0');
});

test('一つが終了して編集するとき、他の待機表示も現在の残り時間になる', () => {
  const snapshot = { cooldowns: {
    owo: { until: t0 + 10_000 },
    hunt: { until: t0 + 12_000 },
    pray: { until: t0 + 300_000 },
  } };
  const emojis = new Map([
    ['s020', '12345678901234567'], ['fb', '12345678901234568'],
  ]);
  const edited = statusText(snapshot, emojis, t0 + 10_000);
  assert.match(edited, /\*\*owo\*\*: ready!/);
  assert.match(edited, /\*\*hunt\*\*: <a:s020:12345678901234567><a:fb:12345678901234568>/);
  assert.match(edited, /\*\*pray\/curse\*\*: 290 /);
});

test('絵文字一覧には30段階と小数部2個を含める', () => {
  const emojis = new Map([
    ...Array.from({ length: 30 }, (_, index) => [`s${String((index + 1) * 5).padStart(3, '0')}`, '12345678901234567']),
    ['fa', '12345678901234568'], ['fb', '12345678901234569'],
  ]);
  const list = emojiList(emojis);
  assert.match(list, /32個/);
  assert.equal((list.match(/<a:/g) ?? []).length, 32);
});
