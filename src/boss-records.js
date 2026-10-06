import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { messageText } from './observations.js';
import { extractBattleLogEntries } from './battle-log-links.js';
import { cardPayload, textBlock, separator } from './display.js';

export function parseBoss(m) {
  const text = messageText(m);
  const board = /A Guild Boss Appeared!/i.test(text);
  const mail = /You (?:defeated|failed to defeat) a guild boss/i.test(text) && /You dealt/.test(text);
  const fight = /guild boss/i.test(text) && extractBattleLogEntries(m).length > 0;
  if (!board && !mail && !fight) return null;
  const media = [];
  function visit(x) {
    if (!x || typeof x !== 'object') return;
    if (x.media?.url) media.push(x.media.url);
    for (const v of Object.values(x)) if (v && typeof v === 'object') Array.isArray(v) ? v.forEach(visit) : visit(v);
  }
  visit(m.components);
  const number = re => { const v = text.match(re)?.[1]; return v == null ? null : Number(v.replaceAll(',', '')); };
  const rewards = mail ? {
    shards: number(/<a?:weaponshard:\d+>\s*([\d,]+)/),
    crates: number(/<a?:crate:\d+>\s*([\d,]+)/),
    bossCrates: number(/<a?:bcrate:\d+>\s*([\d,]+)/),
    experience: [...text.matchAll(/\+([\d,]+)xp/gi)].map(x => Number(x[1].replaceAll(',', ''))),
  } : null;
  return { type: board ? 'board' : mail ? 'mail' : 'fight',
    expires: number(/runs away\s*<t:(\d+):/), received: number(/Received:\s*<t:(\d+):/),
    fighters: number(/\*\*([\d,]+)\*\* fighters/), defeated: number(/\*\*([\d,]+)\*\* defeated/),
    damage: number(/You dealt `([\d,]+)`/), rank: number(/ranked (\d+)/),
    outcome: mail ? (/failed to defeat/i.test(text) ? 'lost' : 'won') : null,
    bossImage: media.find(u => /\/boss\.png(?:\?|$)/.test(u)) ?? null,
    rewardImage: media.find(u => /\/reward\.png(?:\?|$)/.test(u)) ?? null,
    ranking: text.match(/### Top 10 Damage Dealt\n([\s\S]*?)(?=\n###|$)/)?.[1] ?? null,
    rewards, links: extractBattleLogEntries(m), uuids: [...new Set(extractBattleLogEntries(m).map(x => x.uuid))] };
}

export async function boundedFetch(url, limit, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > limit) throw Error('Response too large');
  const parts = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > limit) throw Error('Response too large'); parts.push(part); }
  return Buffer.concat(parts);
}

export async function recognizeRewards(buffer, cachePath) {
  const { default: sharp } = await import('sharp');
  const { createWorker } = await import('tesseract.js');
  const meta = await sharp(buffer, { limitInputPixels: 2_000_000 }).metadata();
  if (meta.width !== 620 || meta.height !== 60) throw Error('Unsupported reward layout');
  mkdirSync(cachePath, { recursive: true });
  const worker = await createWorker('eng', 1, { cachePath });
  const values = [], raw = [], confidences = [];
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789,' });
    for (let i = 0; i < 4; i++) {
      const variants = [];
      for (const width of [450, 540]) {
        const image = await sharp(buffer).flatten({ background: '#303338' })
          .extract({ left: 46 + i * 152, top: 15, width: 90, height: 17 })
          .resize({ width }).grayscale().negate().png().toBuffer();
        const { data } = await worker.recognize(image);
        variants.push({ text: data.text.trim(), confidence: data.confidence });
      }
      raw.push(variants); confidences.push(Math.min(...variants.map(v => v.confidence)));
      const valid = variants.every(v => /^\d{1,3}(?:,\d{3})*$|^\d+$/.test(v.text)) && variants[0].text === variants[1].text && confidences.at(-1) >= 80;
      values.push(valid ? Number(variants[0].text.replaceAll(',', '')) : null);
    }
    // The badge is an annotation; never multiply the displayed experience.
    await worker.setParameters({ tessedit_char_whitelist: 'xX23456789' });
    const badge = await sharp(buffer).flatten({ background: '#303338' }).extract({ left: 599, top: 0, width: 21, height: 20 }).resize({ width: 168 }).png().toBuffer();
    const badgeText = (await worker.recognize(badge)).data.text.trim();
    return { shards: values[0], crates: values[1], bossCrates: values[2], experience: values[3],
      multiplier: /[xX]([2-9])/.exec(badgeText)?.[1] ? Number(/[xX]([2-9])/.exec(badgeText)[1]) : null,
      badgeText, status: values.every(v => v != null) ? 'read' : 'uncertain', raw, confidences,
      imageHash: createHash('sha256').update(buffer).digest('hex'), parser: 'reward-620x60-v1' };
  } finally { await worker.terminate(); }
}

export function createBossRecords({ dbPath, config, fetcher = fetch, ocr = recognizeRewards, now = Date.now, onError = () => {} }) {
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA busy_timeout=5000');
  db.exec(`CREATE TABLE IF NOT EXISTS boss_events(seq INTEGER PRIMARY KEY,guild_id TEXT,channel_id TEXT,message_id TEXT,actor_id TEXT,source_at TEXT,record TEXT);
    CREATE TABLE IF NOT EXISTS battle_logs(uuid TEXT PRIMARY KEY,status TEXT NOT NULL,attempted_at TEXT,body TEXT,error TEXT);
    CREATE TABLE IF NOT EXISTS boss_reward_ocr(image_key TEXT PRIMARY KEY,status TEXT NOT NULL,result TEXT,error TEXT);
    CREATE TABLE IF NOT EXISTS boss_cursor(id INTEGER PRIMARY KEY,seq INTEGER NOT NULL);`);
  let pending = Promise.resolve(), closed = false;
  async function sync() {
    if (!config.guildId || !config.channelIds?.length) return;
    const cursor = db.prepare('SELECT seq FROM boss_cursor WHERE id=1').get()?.seq ?? 0;
    const rows = db.prepare('SELECT * FROM observations WHERE seq>? ORDER BY seq LIMIT 500').all(cursor);
    for (const row of rows) {
      if (row.guild_id === config.guildId && config.channelIds.includes(row.channel_id) && row.source === 'owo') {
        const record = parseBoss(JSON.parse(row.snapshot));
        if (record) {
          db.prepare('INSERT OR IGNORE INTO boss_events VALUES(?,?,?,?,?,?,?)').run(row.seq,row.guild_id,row.channel_id,row.message_id,row.actor_id,row.source_at,JSON.stringify(record));
          for (const uuid of record.uuids) db.prepare("INSERT OR IGNORE INTO battle_logs(uuid,status) VALUES(?,'pending')").run(uuid);
          if (record.rewardImage) {
            const u = new URL(record.rewardImage);
            if (u.protocol === 'https:' && u.hostname === 'cdn.discordapp.com' && !u.port && !u.username && !u.password && /^\/attachments\/\d+\/\d+\/reward\.png$/.test(u.pathname)) {
              db.prepare("INSERT OR IGNORE INTO boss_reward_ocr(image_key,status,result) VALUES(?,'pending',?)").run(u.pathname,JSON.stringify({ url: record.rewardImage }));
            }
          }
        }
      }
      db.prepare('INSERT INTO boss_cursor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq').run(row.seq);
    }
    // One request at a time; persisted failures are not retried automatically.
    const log = db.prepare("SELECT uuid FROM battle_logs WHERE status='pending' LIMIT 1").get();
    if (log) {
      try {
        const body = await boundedFetch(`https://logs.owobot.com/logs/${log.uuid}`, 5_000_000, fetcher);
        const data = JSON.parse(body.toString());
        if (data.uuid !== log.uuid || typeof data.logs !== 'string') throw Error('Unexpected battle log format');
        JSON.parse(data.logs);
        db.prepare("UPDATE battle_logs SET status='saved',attempted_at=?,body=?,error=NULL WHERE uuid=?").run(new Date(now()).toISOString(),body.toString(),log.uuid);
      } catch (error) { db.prepare("UPDATE battle_logs SET status='failed',attempted_at=?,error=? WHERE uuid=?").run(new Date(now()).toISOString(),String(error.message).slice(0,200),log.uuid); onError(error); }
    }
    const image = db.prepare("SELECT * FROM boss_reward_ocr WHERE status='pending' ORDER BY rowid DESC LIMIT 1").get();
    if (image) {
      try {
        const buffer = await boundedFetch(JSON.parse(image.result).url, 1_000_000, fetcher);
        const result = await ocr(buffer,path.join(path.dirname(dbPath),'ocr-cache'));
        db.prepare('UPDATE boss_reward_ocr SET status=?,result=?,error=NULL WHERE image_key=?').run(result.status,JSON.stringify(result),image.image_key);
      } catch (error) { db.prepare("UPDATE boss_reward_ocr SET status='failed',result=NULL,error=? WHERE image_key=?").run(String(error.message).slice(0,200),image.image_key); onError(error); }
    }
  }
  function enqueue() { if (!closed) pending = pending.then(sync).catch(onError); return pending; }
  function scoped(guild,channel) {
    if (guild !== config.guildId || !config.channelIds.includes(channel)) return [];
    return db.prepare('SELECT * FROM boss_events WHERE guild_id=? AND channel_id=? ORDER BY source_at DESC,seq DESC LIMIT 500').all(guild,channel).map(r=>({...r,data:JSON.parse(r.record)}));
  }
  return {
    sync: enqueue,
    start() { const timer = setInterval(()=>{ if (!closed && !this.busy) { this.busy=true; enqueue().finally(()=>{this.busy=false;}); } },5000); timer.unref(); this.timer=timer; },
    payload(guild,channel) {
      const event = scoped(guild,channel).find(r=>r.data.type==='board');
      if (!event) return cardPayload([textBlock('ボスの観測記録を待っています。このチャンネルで `gboss` を表示してください。')]);
      const b=event.data, expired=b.expires && b.expires*1000<=now();
      const key=b.rewardImage ? new URL(b.rewardImage).pathname : '';
      const saved=db.prepare('SELECT * FROM boss_reward_ocr WHERE image_key=?').get(key);
      const rewards=saved?.result && saved.status!=='pending' ? JSON.parse(saved.result) : null;
      const fmt=n=>n==null?'未確定':n.toLocaleString('en-US');
      const blocks=[textBlock(`${expired?'終了時刻を過ぎたボス':'ボスの最終観測'} • ${b.expires?`逃走 <t:${b.expires}:R>`:'逃走時刻未確認'}\n参加 \`${b.fighters??'?'}\` 人 • 討伐カウンター \`${b.defeated??'?'}\``)];
      if (b.bossImage && /^https:\/\/cdn\.discordapp\.com\/attachments\/\d+\/\d+\/boss\.png(?:\?|$)/.test(b.bossImage)) blocks.push({type:12,items:[{media:{url:b.bossImage},description:'ボスの最終観測画像'}]});
      if (b.ranking) blocks.push(textBlock(b.ranking.slice(0,1500)));
      blocks.push(separator(),textBlock(rewards ? `予定報酬 • Shards \`${fmt(rewards.shards)}\` • Crate \`${fmt(rewards.crates)}\` • Boss Crate \`${fmt(rewards.bossCrates)}\`\n経験値 \`${fmt(rewards.experience)}\`${rewards.multiplier?` • ×${rewards.multiplier} 表示`:''} • OCR${rewards.status==='read'?'読取済み':'要確認'}` : `予定報酬 • OCR ${saved?.status==='failed'?'取得・読取失敗': '処理待ち'}`));
      blocks.push(separator(),textBlock(`-# [観測元](https://discord.com/channels/${guild}/${channel}/${event.message_id}) • <t:${Math.floor(Date.parse(event.source_at)/1000)}:R>\n-# 保存済みの表示です。最新状態は \`gboss\` で更新できます。`));
      return cardPayload(blocks);
    },
    logs(guild,channel,user) {
      const uuids=[...new Set(scoped(guild,channel).flatMap(r=>(r.data.links??[]).filter(link=>{
        if(link.ambiguousRow)return false;
        const owner=link.rowOwnerId ?? (link.needsRowOwner ? null : link.authorId);
        if(owner)return owner===user;
        return !link.needsRowOwner && r.data.type==='mail' && r.data.uuids.length===1 && r.actor_id===user;
      }).map(link=>link.uuid)))];
      return uuids.map(uuid=>db.prepare('SELECT uuid,status,body FROM battle_logs WHERE uuid=?').get(uuid)).filter(Boolean);
    },
    async close() { closed=true; clearInterval(this.timer); await pending; db.close(); },
  };
}
