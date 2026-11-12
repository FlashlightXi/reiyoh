import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { classify, commandInfo, messageText, observedFacts } from './observations.js';
import { parseTeamStreak, summarizeStreak } from './streaks.js';
import { parseFormation, formationChanges } from './formations.js';

const noArgs = { type:'object', properties:{}, additionalProperties:false };
export const ADVISOR_TOOLS = [
  ['get_player_context','本人の観測済み編成・ペット・武器情報を、観測日時・出典・取得範囲とともに返す。',noArgs],
  ['get_pet_roster','本人の表示編成からペット種別・Lv・能力値を一覧化し、取得済みpet詳細を返す。個体の識別と全所持の網羅率は要確認。',noArgs],
  ['get_formation_history','表示パネル内のページ別の編成観測と差分。別メッセージの同一プリセット対応は未確定。',noArgs],
  ['get_battle_summary','通常戦の勝敗・勝率と連勝（OwO表示値を優先、根拠付き）、連勝が切れた実績、観測XPをメッセージ単位で集計。ボス戦は別枠。',noArgs],
  ['get_command_usage','本人がこのチャンネルで実際に入力したOwOコマンドの形・回数・OwOの返信種別（待機・エラー等）を返す。',noArgs],
  ['search_strategy_knowledge','過去の分析の知見と成立条件を探す。古い手持ちを現在値へ転用しない。',
    {type:'object',properties:{query:{type:'string',maxLength:200}},required:['query'],additionalProperties:false}],
  ['get_analysis_record','許可された過去分析カードをIDで読む。任意ファイルや他人の個別分析は読めない。',
    {type:'object',properties:{id:{type:'string',maxLength:80}},required:['id'],additionalProperties:false}],
].map(([name,description,parameters])=>({type:'function',function:{name,description,parameters}}));

export function createAdvisorTools({dbPath,guildId,userId,channelIds,includePersonalKnowledge=true}) {
  if (![guildId,userId,...(channelIds??[])].every(id=>/^\d{17,20}$/.test(id)) || !channelIds?.length || channelIds.length>100) throw Error('Invalid server-controlled scope');
  const db=new DatabaseSync(dbPath,{readOnly:true});
  const cards=process.env.REIYOH_KNOWLEDGE_FILE ? JSON.parse(readFileSync(process.env.REIYOH_KNOWLEDGE_FILE,'utf8')) : [];
  if(!Array.isArray(cards))throw Error('Knowledge file must contain an array');
  const allowed=()=>cards.filter(c=>!c.ownerId || (includePersonalKnowledge && c.ownerId===userId));
  const context={guildId,userId,channelIds:[...channelIds]};
  const source=(r)=>({seq:r.seq,messageId:r.message_id,channelId:r.channel_id,observedAt:r.observed_at,sourceAt:r.source_at,
    url:`https://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.message_id}`,ownership:r.ownership});
  function rows(kinds,limit=2000) {
    const result=db.prepare(`SELECT * FROM observations WHERE guild_id=? AND channel_id IN (${channelIds.map(()=>'?').join(',')})
      AND source='owo' AND kind IN (${kinds.map(()=>'?').join(',')})
      AND (subject_id=? OR (subject_id IS NULL AND instr(snapshot,?)>0)) ORDER BY source_at DESC,seq DESC LIMIT ?`)
      .all(guildId,...channelIds,...kinds,userId,userId,limit+1);
    const truncated=result.length>limit;
    const owned=result.slice(0,limit).map(r=>{
      const m=JSON.parse(r.snapshot),text=messageText(m);
      const mentioned=[...new Set([...text.matchAll(/These weapons belong to <@!?(\d{17,20})>|<@!?(\d{17,20})>'s Weapons/g)].map(x=>x[1]??x[2]))];
      const owners=[...new Set([r.subject_id,...mentioned].filter(Boolean))];
      return {...r,m,derivedKind:classify(m,r.source),owner:owners.length===1 && r.ownership!=='conflict' ? owners[0]:null};
    }).filter(r=>r.owner===userId);
    return {owned,truncated};
  }
  function formations() {
    const {owned,truncated}=rows(['team']);
    const prior=new Map(),history=[];
    for(const r of owned.reverse()) {
      const form=parseFormation(r.m); if(!form) continue;
      // Page numbers are not stable preset IDs. Never join across different messages.
      const preset=`panel:${r.message_id}:page:${form.presetPage ?? 'unknown'}`;
      const old=prior.get(preset);
      if(old?.form.stateKey===form.stateKey) { old.lastSeen=source(r); old.form=form; old.entry.lastSeen=source(r); continue; }
      const entry={displayKey:preset,continuity:'same-display-panel-only; stable preset identity unconfirmed',formation:form,source:source(r),lastSeen:source(r),changes:formationChanges(old?.form,form)};
      history.push(entry);prior.set(preset,{form,lastSeen:entry.lastSeen,entry});
    }
    const latestDisplays=[...prior].map(([preset,r])=>({displayKey:preset,formation:r.form,source:r.lastSeen})).slice(-30);
    return {scope:context,history:history.slice(-30),latestDisplays,truncated:truncated||history.length>30||prior.size>30,
      limitations:['Changes are differences between observations, not proof of a player action.','Preset pages can be reordered/renamed; page numbers are not permanent IDs.','Displayed preset does not establish the active formation.']};
  }
  function player() {
    const {owned,truncated}=rows(['pet','weapon','unknown']);
    const seen=new Set(),records=[];
    for(const r of owned) {
      if(!['pet','weapon'].includes(r.derivedKind)||seen.has(r.message_id))continue;
      seen.add(r.message_id);
      const text=messageText(r.m);
      records.push({fields:r.derivedKind==='pet'?(r.m.embeds??[]).flatMap(e=>e.fields??[]):undefined,kind:r.derivedKind,source:source(r),facts:observedFacts(r.m,r.derivedKind),display:text.slice(0,12000),displayTruncated:text.length>12000});
      if(records.length===12)break;
    }
    const form=formations();
    return {scope:context,formations:form.latestDisplays,observations:records,
      gaps:['Full inventory coverage is unknown.','Unattributed details are excluded.','Exact passive coefficients and latest owner must be checked before simulation.','Objective, budget and protected equipment need an explicit user request.'],
      truncated:truncated||seen.size>=12||form.truncated,currentInventoryConfirmed:false};
  }
  // The row limit used to be applied before the owner filter, so busy channels silently dropped a player's battles.
  const inputOf=db.prepare("SELECT snapshot FROM observations WHERE guild_id=? AND message_id=? AND source='input' ORDER BY seq DESC LIMIT 1");
  function bossMode(r,text) {
    if(/guild boss/i.test(text))return true;
    if(!r.command_id||!['reference','time-candidate'].includes(r.association))return false;
    const input=inputOf.get(guildId,r.command_id);if(!input)return false;
    const m=JSON.parse(input.snapshot);
    return m.author?.id===userId&&commandInfo(m.content)?.kind==='boss';
  }
  const when=r=>Date.parse(r.m.timestamp??r.source_at)||0;
  function battles() {
    const {owned,truncated}=rows(['battle'],5000);
    const seen=new Set(),battles=[];let boss=0;
    for(const r of owned) {
      if(seen.has(r.message_id))continue;seen.add(r.message_id);
      if(bossMode(r,messageText(r.m))){boss++;continue;}
      battles.push({source:source(r),at:when(r),...observedFacts(r.m,'battle').battle});
    }
    battles.sort((a,b)=>b.at-a.at||(BigInt(b.source.messageId)>BigInt(a.source.messageId)?1:-1));
    const teams=rows(['team']),shown=new Set(),events=[];
    for(const r of teams.owned) {
      if(shown.has(r.message_id))continue;shown.add(r.message_id);
      const streak=parseTeamStreak(messageText(r.m));
      // An edited team panel keeps its creation time; the edit time is when the value was displayed.
      if(streak)events.push({type:'team',...streak,at:Date.parse(r.source_at)||when(r),source:source(r)});
    }
    for(const b of battles)events.push({type:'battle',...b});
    events.sort((a,b)=>a.at-b.at);
    const counts={won:0,lost:0,tie:0,unknown:0};for(const b of battles)counts[b.outcome]++;
    const decided=counts.won+counts.lost+counts.tie;
    return {scope:context,counts,total:battles.length,decided,winRate:decided?Number((counts.won/decided).toFixed(4)):null,
      streak:summarizeStreak(events),bossReplies:boss,
      recent:battles.slice(0,100).map(({at,...b})=>b),truncated:truncated||teams.truncated,
      limitations:['Observed message outcomes only; edits deduplicated by message ID.',
        'streak basis: reported = value printed by OwO; estimated = printed value plus later observed wins; observed-lower-bound = only wins seen in this channel, the real streak can be longer.',
        'A loss is treated as resetting the streak unless OwO printed another value.',
        'Boss replies are excluded from counts and streak.',
        'No global win-rate estimate or evidence of causality.','Detailed weapon IDs/opponent stats and formation-to-battle linkage may be missing.']};
  }
  const KEYWORDS=new Set(['add','remove','rename','rr','reroll','unequip','passive','stat','stats','t','ticket','all','lock','unlock','sort','display','log','logs']);
  const shape=args=>args.trim().split(/\s+/).filter(Boolean).slice(0,5).map(t=>KEYWORDS.has(t.toLowerCase())?t.toLowerCase()
    :/^<@!?\d{17,20}>$/.test(t)?'<user>':/^\d+$/.test(t)?'<n>':/^[A-Z0-9]{4,8}$/i.test(t)&&/\d|^[A-Z0-9]+$/.test(t)?'<id>':'<arg>').join(' ');
  function commands() {
    const marks=channelIds.map(()=>'?').join(',');
    const inputs=db.prepare(`SELECT message_id,source_at,snapshot FROM observations WHERE guild_id=? AND channel_id IN (${marks})
      AND source='input' AND actor_id=? ORDER BY source_at DESC,seq DESC LIMIT 3001`).all(guildId,...channelIds,userId);
    const replies=new Map(),counted=new Set();
    for(const r of db.prepare(`SELECT message_id,command_id,kind,association FROM observations WHERE guild_id=? AND channel_id IN (${marks})
      AND source='owo' AND command_id IS NOT NULL ORDER BY seq DESC LIMIT 20000`).all(guildId,...channelIds)) {
      if(counted.has(r.message_id))continue;counted.add(r.message_id);
      if(!replies.has(r.command_id))replies.set(r.command_id,r);
    }
    const seen=new Set(),forms=new Map(),totals={inputs:0,cooldown:0,error:0,noLinkedReply:0},prefixes={};
    for(const r of inputs.slice(0,3000)) {
      if(seen.has(r.message_id))continue;seen.add(r.message_id);
      const content=JSON.parse(r.snapshot).content??'',info=commandInfo(content);if(!info)continue;
      const form=[info.prefix==='g'?'g'+info.verb:'owo '+info.verb,shape(info.args)].filter(Boolean).join(' ');
      const f=forms.get(form)??{form,kind:info.kind,count:0,lastAt:r.source_at,replies:{}};
      const reply=replies.get(r.message_id),label=reply?reply.kind:'noLinkedReply';
      f.count++;f.replies[label]=(f.replies[label]??0)+1;forms.set(form,f);
      totals.inputs++;prefixes[info.prefix]=(prefixes[info.prefix]??0)+1;
      if(label in totals)totals[label]++;
    }
    const list=[...forms.values()].sort((a,b)=>b.count-a.count);
    return {scope:context,totals,prefixes,forms:list.slice(0,40),truncated:inputs.length>3000||list.length>40,
      limitations:['Only commands the collector recognizes and typed in this channel while it was running.',
        'Arguments are reduced to shapes: <id>, <n>, <user>, <arg>.',
        'Reply links use Discord references or a single input within 20 seconds; noLinkedReply does not prove OwO ignored the command.',
        'A form that was never observed is unverified here, not invalid.']};
  }
  return {
    definitions:ADVISOR_TOOLS,
    invoke(name,args={}) {
      if(!args || typeof args!=='object'||Array.isArray(args))throw Error('Invalid tool arguments');
      const def=ADVISOR_TOOLS.find(t=>t.function.name===name);if(!def)throw Error('Unknown tool');
      for(const key of Object.keys(args))if(!(key in def.function.parameters.properties))throw Error('Scope/unknown arguments are not accepted');
      for(const key of def.function.parameters.required??[]) {
        if(typeof args[key]!=='string'||args[key].length>def.function.parameters.properties[key].maxLength)throw Error('Invalid tool arguments');
      }
      if(name==='get_player_context')return player();
      if(name==='get_pet_roster') {
        const p=player();
        return {scope:context,coverage:'観測した表示編成とpet詳細',identity:'speciesは種別。個体の同定は詳細で確認する。',
          entries:p.formations.flatMap(f=>f.formation.slots.map(s=>({species:s.species,level:s.level,stats:s.stats,weaponId:s.weaponId,position:s.position,source:f.source}))),
          petDetails:p.observations.filter(r=>r.kind==='pet'),truncated:p.truncated};
      }
      if(name==='get_formation_history')return formations();
      if(name==='get_battle_summary')return battles();
      if(name==='get_command_usage')return commands();
      if(name==='search_strategy_knowledge') {
        const tokens=args.query.toLowerCase().split(/[\s、,]+/).filter(Boolean);
        return allowed().map(card=>({card,score:tokens.reduce((n,t)=>n+Number(JSON.stringify(card).toLowerCase().includes(t)),0)}))
          .filter(x=>!tokens.length||x.score).sort((a,b)=>b.score-a.score).slice(0,8).map(x=>x.card);
      }
      const card=allowed().find(c=>c.id===args.id);if(!card)throw Error('Analysis not available in this scope');
      return card;
    },
    close(){db.close();},
  };
}
