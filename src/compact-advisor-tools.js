const clean=text=>String(text??'').replace(/<a?:(\w+):\d+>/g,':$1:');
const source=s=>({messageId:s.messageId,url:s.url,at:s.sourceAt});
const form=r=>({source:source(r.source),page:r.formation.presetPage,active:r.formation.active,slots:r.formation.slots.map(s=>({position:s.position,pet:s.species?.name,level:s.level,weapon:s.weaponId,stats:s.stats}))});
export function compactAdvisorTools(tools){
 const details={type:'function',function:{name:'get_observation_detail',description:'概要に含まれるmessageIdのペット・武器詳細を必要なときに取得する。',parameters:{type:'object',properties:{messageId:{type:'string',pattern:'^[0-9]{17,20}$'}},required:['messageId'],additionalProperties:false}}};
 return {definitions:[...(tools.definitions??[]),details],invoke(name,args={}){
  if(name==='get_observation_detail'){
   if(Object.keys(args).some(k=>k!=='messageId')||!/^\d{17,20}$/.test(args.messageId))throw Error('Invalid arguments');
   const r=tools.invoke('get_player_context').observations.find(r=>r.source.messageId===args.messageId);
   if(!r)throw Error('Observation unavailable');
   return {source:source(r.source),kind:r.kind,text:clean(r.display),truncated:r.displayTruncated};
  }
  const r=tools.invoke(name,args);
  if(name==='get_player_context')return {formations:r.formations.slice(-3).map(form),observations:r.observations.map(o=>({kind:o.kind,source:source(o.source),preview:clean(o.display).slice(0,220),more:clean(o.display).length>220})),coverage:'観測済み表示。現在の全所持・選択中編成は要確認。',truncated:r.truncated};
  if(name==='get_pet_roster')return {pets:r.petDetails.map(d=>({source:source(d.source),pets:(d.fields??[]).map(f=>({name:clean(f.name),stats:clean(f.value)}))})),formationEntries:r.petDetails.length?undefined:r.entries.map(e=>({pet:e.species?.name,level:e.level,stats:e.stats,weapon:e.weaponId})),coverage:r.coverage,truncated:r.truncated};
  if(name==='get_formation_history')return {history:r.history.slice(-6).map(e=>({...form(e),changes:e.changes})),coverage:'同一メッセージの表示ページ内で比較',truncated:r.truncated||r.history.length>6};
  if(name==='get_battle_summary')return {counts:r.counts,total:r.total,recent:r.recent.slice(0,5).map(b=>({outcome:b.outcome,turns:b.turns,source:source(b.source)})),truncated:r.truncated,coverage:'収集済み返信の集計'};
  if(name==='search_strategy_knowledge')return r.slice(0,3).map(c=>({id:c.id,finding:c.finding,action:c.action,limits:c.limits,sources:c.sources}));
  return r;
 }};
}
