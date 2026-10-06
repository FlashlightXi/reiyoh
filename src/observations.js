import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFormation } from './formations.js';

export const KINDS = ['weapon', 'pet', 'team', 'battle', 'reroll', 'neonutil', 'hunt', 'equipment', 'shards', 'checklist', 'cooldown', 'error', 'unknown', 'input'];
const idPattern = /^\d{17,20}$/;
const plain = (value) => value?.toJSON ? value.toJSON() : value;
export function commandInfo(content = '') {
  const match = content.trim().match(/^(?:owo\s*|g)(weapons?|wep|w|teams?|setteam|useteams|squads?|tm|pets?|battle|b|boss|hunt|h|pray|curse)(?=\s|$)\s*(.*)$/i);
  if (!match) return null;
  const verb = match[1].toLowerCase(), args = match[2];
  const kind = /^(w|wep|weapons?)$/.test(verb) ? (/^(rr|reroll)(?:\s|$)/i.test(args) ? 'reroll' : 'weapon')
    : /^(teams?|setteam|useteams|squads?|tm)$/.test(verb) ? 'team' : /^pets?$/.test(verb) ? 'pet'
      : /^(battle|b|boss)$/.test(verb) ? 'battle' : 'unknown';
  return { kind, verb, args };
}

export function snapshotMessage(message) {
  const attachments = message.attachments?.values ? [...message.attachments.values()] : (message.attachments ?? []);
  return {
    id: message.id, guild_id: message.guildId, channel_id: message.channelId,
    author: message.author && { id: message.author.id, username: message.author.username, bot: message.author.bot },
    content: message.content ?? '', embeds: (message.embeds ?? []).map(plain), components: (message.components ?? []).map(plain),
    attachments: attachments.map((a) => ({ id: a.id, filename: a.name ?? a.filename, content_type: a.contentType ?? a.content_type, url: a.url })),
    timestamp: message.createdAt?.toISOString() ?? new Date(message.createdTimestamp ?? Date.now()).toISOString(),
    edited_timestamp: message.editedAt?.toISOString() ?? null,
    message_reference: message.reference ? { message_id: message.reference.messageId } : null,
    interaction_metadata: message.interactionMetadata ? { user: { id: message.interactionMetadata.user?.id }, name: message.interactionMetadata.name } : null,
    interaction: message.interaction ? { user: { id: message.interaction.user?.id }, name: message.interaction.commandName } : null,
    flags: message.flags?.bitfield ?? null,
  };
}

function componentText(c) {
  return [c.content, c.label, c.url, ...(c.components ?? []).flatMap(componentText), ...(c.accessory ? componentText(c.accessory) : [])].filter(Boolean);
}
export function messageText(m) {
  return [m.content, ...(m.embeds ?? []).flatMap(e => [e.author?.name, e.title, e.description, e.footer?.text,
    ...(e.fields ?? []).flatMap(f => [f.name, f.value])]), ...(m.components ?? []).flatMap(componentText)].filter(Boolean).join('\n');
}
function avatarId(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'cdn.discordapp.com' ? u.pathname.match(/^\/avatars\/(\d{17,20})\//)?.[1] : null;
  } catch { return null; }
}
export function classify(m, source) {
  if (source === 'neonutil') return 'neonutil';
  if (source === 'input') return 'input';
  const text = messageText(m);
  if (/\[CURRENT\]|\[NEW\]|Weapon Shards to reroll/i.test(text)) return 'reroll';
  if (/These weapons belong to|<@!?\d{17,20}>'s Weapons|\*\*ID:\*\*\s*`[A-Z0-9]+`/i.test(text)) return 'weapon';
  if (/owo team add|Current Streak:.*Highest Streak:/i.test(text)) return 'team';
  if ((m.embeds ?? []).some(e => /'s pets$/i.test(e.author?.name ?? ''))) return 'pet';
  if (/owobot\.com\/battle-log\?|You (?:won|lost) in \d+ turns|It's a tie/i.test(text)) return 'battle';
  if (/hunt is empowered|spent [\d,]+ .*and caught an? /i.test(text)) return 'hunt';
  if (/is now wielding/i.test(text)) return 'equipment';
  if (/you currently have \*\*[\d,]+\*\* Weapon Shards/i.test(text)) return 'shards';
  if (/<@!?\d{17,20}>'s (?:Daily|Weekly) Checklist/i.test(text)) return 'checklist';
  if (/Slow down and try the command again/i.test(text)) return 'cooldown';
  if (/I could not find a weapon with that unique weapon id/i.test(text)) return 'error';
  return 'unknown';
}

export function observedFacts(m, kind) {
  const text = messageText(m);
  const footer = (m.embeds ?? []).map(e => e.footer?.text ?? '').join('\n');
  const outcome = footer.match(/You (won|lost) in (\d+) turns|It's a tie(?: in (\d+) turns)?/i);
  const page = text.match(/Page\s+(\d+)\s*\/\s*(\d+)/i);
  return {
    hunt: kind === 'hunt' ? {xp: Number(text.match(/gained \*\*([\d,]+)xp/i)?.[1]?.replaceAll(',','')) || null} : null,
    shards: kind === 'shards' ? {count:Number(text.match(/have \*\*([\d,]+)\*\* Weapon Shards/i)?.[1]?.replaceAll(',',''))} : null,
    formation: kind === 'team' ? parseFormation(m) : null,
    weaponIds: [...new Set([...text.matchAll(/\*\*ID:\*\*\s*`([A-Z0-9]+)`/gi)].map(m => m[1]))],
    page: page ? { number: Number(page[1]), total: Number(page[2]), completeInventory: false } : null,
    battle: kind === 'battle' ? { outcome: outcome ? outcome[1]?.toLowerCase() ?? 'tie' : 'unknown',
      turns: outcome ? Number(outcome[2] ?? outcome[3]) || null : null,
      visibleTeams: (m.embeds ?? []).flatMap(e => e.fields ?? []).map(f => ({ label: f.name, display: f.value })) } : null,
    inventoryConfirmed: false,
    reroll: kind === 'reroll' ? 'observed-preview-or-result; verify-with-weapon-detail' : null,
  };
}

// Only observations are stored. Reroll previews never become current inventory.
export function openObservations(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS observations (
      seq INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
      event TEXT NOT NULL, observed_at TEXT NOT NULL, source_at TEXT NOT NULL, source TEXT NOT NULL,
      kind TEXT NOT NULL, actor_id TEXT, subject_id TEXT, ownership TEXT NOT NULL,
      command_id TEXT, association TEXT NOT NULL, snapshot TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL,
      facts TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS observation_message ON observations(guild_id,message_id,seq);
    CREATE INDEX IF NOT EXISTS observation_channel ON observations(guild_id,channel_id,kind,seq);
    CREATE INDEX IF NOT EXISTS observation_owner ON observations(guild_id,subject_id,seq);`);
  db.exec('CREATE INDEX IF NOT EXISTS observation_inputs ON observations(guild_id,channel_id,source,source_at);');
  const latest = (guild, id) => db.prepare('SELECT * FROM observations WHERE guild_id=? AND message_id=? ORDER BY source_at DESC,seq DESC LIMIT 1').get(guild,id);
  return {
    has(guild, messageId) { return Boolean(latest(guild, messageId)); },
    capture(payload, event, config) {
      const guild = payload.guild_id, channel = payload.channel_id;
      if (guild !== config.guildId || !config.channelIds.includes(channel)) return false;
      const previous = latest(guild, payload.id);
      const prior = previous ? JSON.parse(previous.snapshot) : {};
      const m = { ...prior, ...payload };
      const source = m.author?.id === config.owoBotId ? 'owo' : config.observerBotIds?.includes(m.author?.id) ? 'neonutil'
        : !m.author?.bot && m.author?.id && (commandInfo(m.content) || /owo/i.test(m.content ?? '')) ? 'input' : null;
      if (!source) return false;
      const serialized = JSON.stringify(m);
      const hash = createHash('sha256').update(serialized).digest('hex');
      const lastObserved = db.prepare('SELECT hash FROM observations WHERE guild_id=? AND message_id=? ORDER BY seq DESC LIMIT 1').get(guild,payload.id);
      if (lastObserved?.hash === hash) return false;
      let kind = classify(m, source), actor = null, commandId = null, association = 'none';
      const ref = m.message_reference?.message_id;
      const referenced = ref ? latest(guild, ref) : null;
      const interactionActor = m.interaction_metadata?.user?.id ?? m.interaction?.user?.id;
      let input;
      if (source === 'input') actor = m.author.id;
      else if (referenced?.source === 'input' && referenced.channel_id === channel) {
        input = JSON.parse(referenced.snapshot); actor = input.author.id; commandId = ref; association = 'reference';
        if (interactionActor && interactionActor !== actor) { actor = null; association = 'conflict'; }
      } else if (idPattern.test(interactionActor ?? '')) { actor = interactionActor; association = 'interaction'; }
      // Keep a time-based candidate separately: never use it to establish ownership.
      if (source !== 'input' && !commandId && !actor && !previous && association === 'none') {
        const since = new Date(new Date(m.timestamp ?? Date.now()).getTime() - 20000).toISOString();
        const candidates = db.prepare(`SELECT message_id,snapshot FROM observations WHERE guild_id=? AND channel_id=? AND source='input'
          AND source_at>=? AND source_at<=? GROUP BY message_id LIMIT 2`).all(guild,channel,since,m.timestamp ?? new Date().toISOString());
        if (candidates.length === 1) { commandId = candidates[0].message_id; association = 'time-candidate'; }
      }
      if (previous && !commandId && previous.command_id) { commandId = previous.command_id; association = previous.association; }
      if (kind === 'unknown' && input) kind = commandInfo(input.content)?.kind ?? kind;
      const text = messageText(m);
      const declared = source === 'owo' ? [...text.matchAll(/These weapons belong to <@!?(\d{17,20})>|<@!?(\d{17,20})>'s Weapons/gi)].map(x => x[1] ?? x[2]) : [];
      const avatars = ['weapon','pet','team','reroll','battle'].includes(kind) && source === 'owo'
        ? (m.embeds ?? []).map(e => avatarId(e.author?.icon_url)).filter(Boolean) : [];
      const owners = [...new Set([...declared, ...avatars])];
      let subject = owners.length === 1 ? owners[0] : null;
      let ownership = owners.length > 1 ? 'conflict' : subject ? 'display' : 'unknown';
      // An explicitly linked own pet/team query is evidence, but arbitrary weapon IDs can refer to other people.
      if (!subject && ownership === 'unknown' && actor && input && ['team','pet'].includes(kind)
        && !commandInfo(input.content)?.args && source === 'owo') { subject = actor; ownership = 'own-query'; }
      if (source === 'input') ownership = 'not-an-inventory';
      const at = new Date(m.edited_timestamp ?? m.timestamp ?? Date.now()).toISOString();
      db.prepare(`INSERT INTO observations(guild_id,channel_id,message_id,event,observed_at,source_at,source,kind,actor_id,subject_id,
        ownership,command_id,association,snapshot,payload,hash,facts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(guild,channel,m.id,event,new Date().toISOString(),at,source,kind,actor,subject,ownership,commandId,association,serialized,JSON.stringify(payload),hash,JSON.stringify(observedFacts(m,kind)));
      return true;
    },
    summary(guild, channel) {
      const rows=db.prepare('SELECT message_id,source,kind,subject_id,snapshot FROM observations WHERE guild_id=? AND channel_id=?').all(guild,channel);
      const groups=new Map();
      for(const r of rows){const detected=classify(JSON.parse(r.snapshot),r.source),kind=detected==='unknown'?r.kind:detected;
        const g=groups.get(kind)??{kind,revisions:0,ids:new Set(),attributed:0};g.revisions++;g.ids.add(r.message_id);g.attributed+=Number(Boolean(r.subject_id));groups.set(kind,g);}
      return [...groups.values()].map(({ids,...g})=>({...g,messages:ids.size}));
    },
    personal(guild, userId, limit = 100) {
      return db.prepare(`SELECT * FROM observations WHERE guild_id=? AND subject_id=? ORDER BY seq DESC LIMIT ?`)
        .all(guild,userId,limit).reverse().map(r => ({ ...r, snapshot: JSON.parse(r.snapshot), payload: JSON.parse(r.payload), facts: JSON.parse(r.facts) }));
    },
    samples(guild, channel, kind, limit = 100) {
      const rows=db.prepare('SELECT * FROM observations WHERE guild_id=? AND channel_id=? ORDER BY seq DESC LIMIT 2000').all(guild,channel).reverse();
      return rows.map(r=>{const snapshot=JSON.parse(r.snapshot),detected=classify(snapshot,r.source),resolved=detected==='unknown'?r.kind:detected;
        return {...r,kind:resolved,storedKind:r.kind,snapshot,payload:JSON.parse(r.payload),facts:observedFacts(snapshot,resolved)};})
        .filter(r=>!kind||r.kind===kind).slice(-limit);
    },
    history(guild, channel, messageId) {
      return db.prepare('SELECT * FROM observations WHERE guild_id=? AND channel_id=? AND message_id=? ORDER BY seq DESC LIMIT 100')
        .all(guild,channel,messageId).reverse().map(r => ({ ...r, snapshot: JSON.parse(r.snapshot), payload: JSON.parse(r.payload), facts: JSON.parse(r.facts) }));
    },
    close() { db.close(); },
  };
}
