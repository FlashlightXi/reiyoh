import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { classify, messageText, observedFacts } from './observations.js';
import { parseFormation, formationChanges } from './formations.js';

const noArgs = { type:'object', properties:{}, additionalProperties:false };
export const ADVISOR_TOOLS = [
  ['get_player_context','本人の観測済み編成・ペット・武器情報を、観測日時・出典・取得範囲とともに返す。',noArgs],
  ['get_pet_roster','本人の表示編成からペット種別・Lv・能力値を一覧化し、取得済みpet詳細を返す。個体の識別と全所持の網羅率は要確認。',noArgs],
  ['get_formation_history','表示パネル内のページ別の編成観測と差分。別メッセージの同一プリセット対応は未確定。',noArgs],
  ['get_battle_summary','通常返信の試合をメッセージ単位で集計。編集版は重複カウントしない。',noArgs],
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
      AND source='owo' AND kind IN (${kinds.map(()=>'?').join(',')}) ORDER BY source_at DESC,seq DESC LIMIT ?`)
      .all(guildId,...channelIds,...kinds,limit+1);
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
  function battles() {
    const {owned,truncated}=rows(['battle']);
    const seen=new Set(),battles=[];
    for(const r of owned) {
      if(seen.has(r.message_id))continue;seen.add(r.message_id);
      const facts=observedFacts(r.m,'battle').battle;
      battles.push({source:source(r),...facts});
    }
    const counts={won:0,lost:0,tie:0,unknown:0};for(const b of battles)counts[b.outcome]++;
    return {scope:context,counts,total:battles.length,recent:battles.slice(0,100),truncated,
      limitations:['Observed message outcomes only; edits deduplicated by message ID.','No global win-rate estimate or evidence of causality.','Detailed weapon IDs/opponent stats and formation-to-battle linkage may be missing.','Boss-specific effects and damage metrics are not inferred from these outcomes.']};
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
