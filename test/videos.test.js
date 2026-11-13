import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, mkdirSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadVideoCatalog, createCatalogReader, findVideos, videoPayload, listPayload, autocompleteChoices, checkSize, createVideoCommands} from '../src/videos.js';

function fixture(videos, kinds = {passive: {label: 'PASSIVE', color: '#3B4FD8'}, weapon: {label: 'WEAPON', color: '#E2462B'}}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'videos-'));
  mkdirSync(path.join(dir, 'passive')); mkdirSync(path.join(dir, 'weapon'));
  for (const v of videos) try { writeFileSync(path.join(dir, v.file), 'mp4'); } catch {}
  const file = path.join(dir, 'videos.json');
  writeFileSync(file, JSON.stringify({kinds, videos}));
  return file;
}
const base = [
  {kind: 'passive', id: 'lifesteal', name: 'Lifesteal', file: 'passive/lifesteal.mp4', summary: '与ダメージの一部を回復'},
  {kind: 'weapon', id: 'leeching-scythe', name: 'Leeching Scythe', aliases: ['lscythe'], file: 'weapon/leeching-scythe.mp4'},
  {kind: 'weapon', id: 'culling-scythe', name: 'Culling Scythe', file: 'weapon/culling-scythe.mp4'},
  {kind: 'weapon', id: 'vanguards-banner', name: "Vanguard's Banner", file: 'weapon/vanguards-banner.mp4'},
];

test('lookup prefers exact, then prefix, then substring, and ignores punctuation and case', () => {
  const c = loadVideoCatalog(fixture(base));
  assert.deepEqual(findVideos(c, 'LIFESTEAL').map((v) => v.id), ['lifesteal']);
  assert.deepEqual(findVideos(c, 'lscythe').map((v) => v.id), ['leeching-scythe']);
  assert.deepEqual(findVideos(c, 'vanguards banner').map((v) => v.id), ['vanguards-banner']);
  assert.deepEqual(findVideos(c, 'leech').map((v) => v.id), ['leeching-scythe']);
  assert.deepEqual(findVideos(c, 'scythe').map((v) => v.id).sort(), ['culling-scythe', 'leeching-scythe']);
  assert.deepEqual(findVideos(c, '   '), []);
});

test('entries outside the catalog folder or incomplete are skipped', () => {
  const c = loadVideoCatalog(fixture([...base, {kind: 'weapon', id: 'evil', name: 'Evil', file: '../../etc/passwd'}, {kind: 'weapon', id: 'x', name: 'X'}]));
  assert.equal(c.videos.length, 4);
});

test('video payload attaches the file and shows it in a media gallery with the kind color', () => {
  const c = loadVideoCatalog(fixture(base));
  const p = videoPayload(c, c.videos[0]);
  assert.equal(p.flags, 32768);
  assert.equal(p.files[0].name, 'passivelifesteal.mp4');
  assert.equal(p.components[0].accent_color, 0x3B4FD8);
  assert.equal(p.components[0].components[1].items[0].media.url, 'attachment://passivelifesteal.mp4');
  assert.match(JSON.stringify(p), /与ダメージの一部を回復/);
});

test('list splits each kind into menus of at most 25 with unique IDs', () => {
  const many = Array.from({length: 29}, (_, i) => ({kind: 'weapon', id: `w${i}`, name: `Weapon ${i}`, file: `weapon/w${i}.mp4`}));
  const c = loadVideoCatalog(fixture([base[0], ...many]));
  const rows = listPayload(c).components[0].components.filter((b) => b.type === 1);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.components[0].options.length <= 25));
  assert.equal(new Set(rows.map((r) => r.components[0].custom_id)).size, 3);
  const values = rows.flatMap((r) => r.components[0].options.map((o) => o.value));
  assert.equal(new Set(values).size, 30);
});

test('autocomplete returns at most 25 and an empty query lists everything', () => {
  const many = Array.from({length: 30}, (_, i) => ({kind: 'weapon', id: `w${i}`, name: `Weapon ${i}`, file: `weapon/w${i}.mp4`}));
  const c = loadVideoCatalog(fixture(many));
  assert.equal(autocompleteChoices(c, '').length, 25);
  assert.deepEqual(autocompleteChoices(c, 'weapon 12').map((x) => x.value), ['weapon:w12']);
});

test('size check rejects oversize and missing files', () => {
  const c = loadVideoCatalog(fixture(base));
  assert.equal(checkSize(c.videos[0]), null);
  assert.match(checkSize(c.videos[0], 1), /大きすぎ/);
  assert.match(checkSize({file: '/nonexistent.mp4'}), /見つかりません/);
});

test('catalog reader reloads when the file changes', () => {
  const file = fixture(base);
  let loads = 0;
  const read = createCatalogReader(file, (f) => { loads++; return loadVideoCatalog(f); });
  read(); read(); assert.equal(loads, 1);
  const later = new Date(Date.now() + 5000); utimesSync(file, later, later);
  read(); assert.equal(loads, 2);
  assert.equal(createCatalogReader(null)(), null);
});

test('gx v routes to video, choices, list, not-found, and unconfigured', async () => {
  const c = loadVideoCatalog(fixture(base));
  const sent = [];
  const msg = {reply: async (p) => sent.push(p)};
  const reply = async (_m, text) => sent.push(text);
  const cmd = createVideoCommands({readCatalog: () => c, reply});
  assert.equal(await cmd.message(msg, 'gx vote'), false);
  assert.equal(await cmd.message(msg, 'gx v lifesteal'), true);
  assert.equal(sent.at(-1).files[0].name, 'passivelifesteal.mp4');
  await cmd.message(msg, 'gx v scythe');
  assert.equal(sent.at(-1).components[0].components[1].components[0].options.length, 2);
  await cmd.message(msg, 'gx video');
  assert.match(JSON.stringify(sent.at(-1)), /video:list:/);
  await cmd.message(msg, 'gx v nothing');
  assert.match(sent.at(-1), /見つかりませんでした/);
  const off = createVideoCommands({readCatalog: () => null, reply});
  await off.message(msg, 'gx v lifesteal');
  assert.match(sent.at(-1), /設定されていません/);
});

test('menu selection answers privately with the chosen video', async () => {
  const c = loadVideoCatalog(fixture(base));
  let deferred, edited;
  const cmd = createVideoCommands({readCatalog: () => c, reply: async () => {}});
  const i = {customId: 'video:pick:0', values: ['weapon:culling-scythe'], isStringSelectMenu: () => true,
    deferReply: async (o) => deferred = o, editReply: async (p) => edited = p, reply: async () => assert.fail()};
  assert.equal(await cmd.select(i), true);
  assert.equal(deferred.flags, 64);
  assert.equal(edited.files[0].name, 'weaponcullingscythe.mp4');
});
