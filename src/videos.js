import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {textBlock, separator} from './display.js';

// A lookup catalog (passives, weapons, teams…) with optional explainer videos, kept outside this
// repository. REIYOH_VIDEOS_FILE points to the JSON; each entry's video file is resolved inside the
// catalog's directory and attached as-is. Entries without a video still show their details.
export const UPLOAD_LIMIT = 10 * 1024 * 1024;
const MAX_OPTIONS = 25;

export const normalizeKey = (text = '') => String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function loadVideoCatalog(file) {
  const root = path.dirname(path.resolve(file));
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const kinds = raw.kinds ?? {};
  const seen = new Set();
  const videos = [];
  for (const v of raw.videos ?? []) {
    if (!v?.id || !v?.name || !v?.kind) continue;
    const key = `${v.kind}:${v.id}`;
    if (seen.has(key)) continue;
    let full = null;
    if (v.file) {
      full = path.resolve(root, String(v.file));
      const rel = path.relative(root, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    }
    seen.add(key);
    videos.push({
      kind: String(v.kind), id: String(v.id), name: String(v.name),
      aliases: (v.aliases ?? []).map(String), summary: v.summary ? String(v.summary) : '',
      effect: v.effect ? String(v.effect) : '', facts: (v.facts ?? []).map(String),
      file: full, key,
      keys: [...new Set([v.id, v.name, ...(v.aliases ?? [])].map(normalizeKey).filter(Boolean))],
    });
  }
  const order = [...new Set([...Object.keys(kinds), ...videos.map((v) => v.kind)])];
  return {kinds, order, videos, attribution: raw.attribution ? String(raw.attribution) : ''};
}

// Cache by mtime so replacing the catalog takes effect without a restart.
export function createCatalogReader(file, load = loadVideoCatalog) {
  let cached, mtime;
  return () => {
    if (!file) return null;
    const current = statSync(file).mtimeMs;
    if (!cached || current !== mtime) { cached = load(file); mtime = current; }
    return cached;
  };
}

export function findVideos(catalog, query) {
  const q = normalizeKey(query);
  if (!q) return [];
  const exact = catalog.videos.filter((v) => v.keys.includes(q));
  if (exact.length) return exact;
  const prefix = catalog.videos.filter((v) => v.keys.some((k) => k.startsWith(q)));
  if (prefix.length) return prefix;
  return catalog.videos.filter((v) => v.keys.some((k) => k.includes(q)));
}

export const kindLabel = (catalog, kind) => catalog.kinds[kind]?.label ?? kind.toUpperCase();
const kindColor = (catalog, kind) => {
  const hex = catalog.kinds[kind]?.color;
  return /^#?[0-9a-f]{6}$/i.test(hex ?? '') ? parseInt(hex.replace('#', ''), 16) : undefined;
};

export function attachmentName(video) {
  const base = normalizeKey(`${video.kind}-${video.id}`) || 'video';
  return `${base}${path.extname(video.file ?? '').toLowerCase() || '.mp4'}`;
}

// Card with the entry's details; the video is attached only when the file exists and fits.
export function videoPayload(catalog, video, limit = UPLOAD_LIMIT) {
  const problem = video.file ? checkSize(video, limit) : null;
  const attach = video.file && !problem;
  const name = attachmentName(video);
  const blocks = [textBlock(`**${video.name}** · ${kindLabel(catalog, video.kind)}${video.aliases.length ? `\n-# ${video.aliases.join(' · ')}` : ''}`)];
  if (attach) blocks.push({type: 12, items: [{media: {url: `attachment://${name}`}, description: video.name.slice(0, 1024)}]});
  const body = [video.summary, video.effect, video.facts.map((f) => `• ${f}`).join('\n')].filter(Boolean).join('\n\n');
  if (body) blocks.push(textBlock(body.slice(0, 3000)));
  const notes = [!video.file ? '説明動画は準備中です。' : problem, catalog.attribution].filter(Boolean);
  if (notes.length) blocks.push(textBlock(notes.map((n) => `-# ${n}`).join('\n').slice(0, 600)));
  const container = {type: 17, components: blocks};
  const accent = kindColor(catalog, video.kind);
  if (accent !== undefined) container.accent_color = accent;
  return {
    flags: 32768, components: [container],
    ...(attach ? {files: [{attachment: video.file, name}]} : {}),
    allowedMentions: {parse: [], repliedUser: false},
  };
}

function selectRow(customId, placeholder, videos) {
  return {type: 1, components: [{
    type: 3, custom_id: customId, placeholder: placeholder.slice(0, 150),
    options: videos.slice(0, MAX_OPTIONS).map((v) => ({label: `${v.file ? '▶ ' : ''}${v.name}`.slice(0, 100), value: v.key.slice(0, 100),
      description: v.aliases.length ? v.aliases.join(', ').slice(0, 100) : undefined})),
  }]};
}

// Menus are usable by anyone; selections are answered privately to avoid channel spam.
export function listPayload(catalog) {
  const blocks = [textBlock('**図鑑**\n`gx v 名前` で効果と説明動画（▶ 付き）を表示します。下のメニューから選ぶと、自分だけに表示されます。')];
  for (const kind of catalog.order) {
    const videos = catalog.videos.filter((v) => v.kind === kind);
    if (!videos.length) continue;
    blocks.push(separator(), textBlock(`**${kindLabel(catalog, kind)}**（${videos.length}本）\n-# ${videos.map((v) => v.name).join(' · ')}`.slice(0, 3800)));
    for (let i = 0; i < videos.length; i += MAX_OPTIONS) {
      const page = Math.floor(i / MAX_OPTIONS);
      const chunk = videos.slice(i, i + MAX_OPTIONS);
      const range = videos.length > MAX_OPTIONS ? ` ${i + 1}〜${i + chunk.length}` : '';
      blocks.push(selectRow(`video:list:${normalizeKey(kind).slice(0, 40)}:${page}`, `${kindLabel(catalog, kind)}${range}を選ぶ`, chunk));
    }
  }
  if (blocks.length === 1) blocks.push(textBlock('項目はまだ登録されていません。'));
  return {flags: 32768, components: [{type: 17, components: blocks}], allowedMentions: {parse: [], repliedUser: false}};
}

export function choicesPayload(catalog, query, matches) {
  return {flags: 32768, components: [{type: 17, components: [
    textBlock(`「${String(query).slice(0, 50).replaceAll('`', 'ˈ')}」に当てはまる動画が${matches.length}本あります。選んでください。`),
    selectRow('video:pick:0', '動画を選ぶ', matches),
  ]}], allowedMentions: {parse: [], repliedUser: false}};
}

export function autocompleteChoices(catalog, query) {
  const list = normalizeKey(query) ? findVideos(catalog, query) : catalog.videos;
  return list.slice(0, MAX_OPTIONS).map((v) => ({name: `${v.file ? '▶ ' : ''}${v.name} · ${kindLabel(catalog, v.kind)}`.slice(0, 100), value: v.key.slice(0, 100)}));
}

export function byKey(catalog, key) { return catalog.videos.find((v) => v.key === key); }

export function checkSize(video, limit = UPLOAD_LIMIT) {
  try {
    const size = statSync(video.file).size;
    if (size > limit) return `説明動画が大きすぎて添付できません（${(size / 1048576).toFixed(1)} MB）。`;
    return null;
  } catch { return '説明動画のファイルが見つかりません。'; }
}

const NOT_CONFIGURED = '図鑑はこのサーバーでは設定されていません。';

export function createVideoCommands({readCatalog, reply, onError = () => {}}) {
  const catalog = () => { try { return readCatalog(); } catch (error) { onError(error); return null; } };

  async function message(msg, normalized) {
    const match = normalized.match(/^gx\s+(?:v|video|wiki)(?:\s+([\s\S]*))?$/i);
    if (!match) return false;
    const c = catalog();
    if (!c) { await reply(msg, NOT_CONFIGURED); return true; }
    const query = (match[1] ?? '').trim();
    if (!query) { await msg.reply(listPayload(c)); return true; }
    const found = findVideos(c, query);
    if (!found.length) { await reply(msg, `「${query.slice(0, 50).replaceAll('`', 'ˈ')}」は見つかりませんでした。\`gx v\` で一覧を表示できます。`); return true; }
    if (found.length > 1) { await msg.reply(choicesPayload(c, query, found)); return true; }
    await msg.reply(videoPayload(c, found[0]));
    return true;
  }

  // Select menus from `gx v` lists and choices. Returns false when the interaction is not ours.
  async function select(interaction) {
    if (!interaction.isStringSelectMenu?.() || !/^video:(list|pick):/.test(interaction.customId)) return false;
    const c = catalog();
    const video = c && byKey(c, interaction.values[0]);
    if (!video) { await interaction.reply({content: c ? 'この項目は一覧から外れました。`gx v` で一覧を出し直してください。' : NOT_CONFIGURED, flags: 64}); return true; }
    await interaction.deferReply({flags: 64});
    await interaction.editReply(videoPayload(c, video));
    return true;
  }

  async function slash(interaction) {
    const c = catalog();
    const query = interaction.options.getString('name', true);
    const share = interaction.options.getBoolean('public') ?? false;
    if (!c) { await interaction.reply({content: NOT_CONFIGURED, flags: 64}); return; }
    const video = byKey(c, query) ?? (() => { const f = findVideos(c, query); return f.length === 1 ? f[0] : null; })();
    if (!video) { await interaction.reply({content: '項目を特定できませんでした。候補から選んでください。', flags: 64}); return; }
    await interaction.deferReply(share ? {} : {flags: 64});
    await interaction.editReply(videoPayload(c, video));
  }

  async function autocomplete(interaction) {
    const c = catalog();
    await interaction.respond(c ? autocompleteChoices(c, interaction.options.getFocused()) : []);
  }

  return {message, select, slash, autocomplete};
}
