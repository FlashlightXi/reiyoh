import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openObservations, commandInfo } from '../src/observations.js';
import { createCollectionCommands, normalizeCommand } from '../src/collection-commands.js';
const G='700000000000000010', C='700000000000000002', U='111111111111111111', V='222222222222222222';
const configBase={guildId:G,channelIds:[C],owoBotId:'408785106942164992',observerBotIds:['333333333333333333']};
function setup(t) {
  const dir=mkdtempSync(path.join(tmpdir(),'reiyo-observation-'));
  const file=path.join(dir,'observations.sqlite');
  let store=openObservations(file);
  t.after(()=>{ store.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep)); rmSync(dir,{recursive:true}); });
  return {get store(){return store;},reopen(){store.close();store=openObservations(file);},config:structuredClone(configBase)};
}
function msg(id, extra={}) {
  return {id, guild_id:G, channel_id:C,author:{id:configBase.owoBotId,bot:true},timestamp:'2026-10-06T00:00:05.000Z',
    edited_timestamp:null,content:'',embeds:[],components:[],...extra};
}
const avatar=(id)=>`https://cdn.discordapp.com/avatars/${id}/x.png`;
test('実コマンド別名を記録しReiyoの管理コマンドとは分離',()=>{
  for (const value of ['gweapon','gw','owow','owo weapon 108','gwep']) assert.equal(commandInfo(value).kind,'weapon');
  assert.equal(commandInfo('gw rr ABCDEF stat').kind,'reroll');
  assert.equal(commandInfo('gtm').kind,'team'); assert.equal(commandInfo('gpet').kind,'pet');
  for(const value of ['g','gx samples','great','gx collect on']) assert.equal(commandInfo(value),null);
  assert.equal(normalizeCommand('gxbl export'),'gx logs export');
});
test('編集版を追記、同じパケットは重複せずA→B→Aは保持。再起動後のpartialにも対応',t=>{
  const x=setup(t), id='444444444444444444';
  const initial=msg(id,{author:{id:x.config.observerBotIds[0],bot:true},content:'A'});
  assert.equal(x.store.capture(initial,'create',x.config),true);
  assert.equal(x.store.has(G,id),true); assert.equal(x.store.has(G,'missing'),false);
  const patch={id,guild_id:G,channel_id:C,content:'B',edited_timestamp:'2026-10-06T00:00:06.000Z'};
  assert.equal(x.store.capture(patch,'update',x.config),true);
  assert.equal(x.store.capture(patch,'update',x.config),false);
  x.reopen();
  x.store.capture({...patch,content:'A',edited_timestamp:'2026-10-06T00:00:07.000Z'},'update',x.config);
  assert.deepEqual(x.store.history(G,C,id).map(r=>r.snapshot.content),['A','B','A']);
  assert.ok(x.store.history(G,C,id).every(r=>r.source==='neonutil'));
});
test('一覧のページ・リロール候補の履歴を独立保存し、現有性能には昇格しない',t=>{
  const {store,config}=setup(t);
  const initial=msg('444444444444444444',{embeds:[{author:{icon_url:avatar(U)},description:`These weapons belong to <@${U}>`,footer:{text:'Page 1/2'}}]});
  store.capture(initial,'create',config);
  store.capture({...initial,edited_timestamp:'2026-10-06T00:00:06.000Z',embeds:[{...initial.embeds[0],footer:{text:'Page 2/2'}}]},'update',config);
  const rr=msg('555555555555555555',{embeds:[{author:{name:'User spent 100 Weapon Shards to reroll!',icon_url:avatar(U)},fields:[{name:'[CURRENT]',value:'old'},{name:'[NEW]',value:'candidate'}]}]});
  store.capture(rr,'create',config);
  store.capture({...rr,edited_timestamp:'2026-10-06T00:00:07.000Z',embeds:[{...rr.embeds[0],color:16711680}]},'update',config);
  assert.equal(store.personal(G,U).length,4);
  assert.equal(store.samples(G,C,'weapon').length,2);
  assert.equal(store.samples(G,C,'reroll').length,2);
});
test('他人の武器照会は実行者と所有者を区別、時間候補は所有根拠にしない',t=>{
  const {store,config}=setup(t), inputId='666666666666666666';
  store.capture(msg(inputId,{author:{id:U,bot:false},timestamp:'2026-10-06T00:00:00.000Z',content:`gw <@${V}>`}), 'create',config);
  store.capture(msg('444444444444444444',{message_reference:{message_id:inputId},embeds:[{author:{icon_url:avatar(V)},description:`These weapons belong to <@${V}>`}]}),'create',config);
  const result=store.samples(G,C,'weapon')[0];
  assert.equal(result.actor_id,U); assert.equal(result.subject_id,V); assert.equal(result.association,'reference');
  store.capture(msg('555555555555555555',{content:'**ID:** `ABCDEF`'}),'create',config);
  const uncertain=store.samples(G,C,'weapon')[1];
  assert.equal(uncertain.association,'time-candidate'); assert.equal(uncertain.subject_id,null); assert.equal(uncertain.actor_id,null);
});
test('所有根拠矛盾、別サーバー、停止チャンネル、未知Botを確定記録しない',t=>{
  const {store,config}=setup(t);
  const m=msg('444444444444444444',{embeds:[{author:{icon_url:avatar(U)},description:`These weapons belong to <@${V}>`}]});
  assert.equal(store.capture({...m,guild_id:V},'create',config),false);
  assert.equal(store.capture({...m,channel_id:V},'create',config),false);
  assert.equal(store.capture({...m,author:{id:V,bot:true}},'create',config),false);
  store.capture(m,'create',config);
  assert.equal(store.samples(G,C)[0].ownership,'conflict'); assert.equal(store.personal(G,U).length,0);
});
test('管理権限なしの生ログexport・設定は拒否。停止しても保存履歴を保持',async t=>{
  const {store,config}=setup(t); const state={channels:[C],observerBotIds:[]}, replies=[];
  let manager=false;
  const handle=createCollectionCommands({config,state,store,writer:{save:async()=>{}},client:{},reply:async(_m,s)=>replies.push(s),isManager:()=>manager});
  const m={guildId:G,channelId:C,author:{id:U}};
  store.capture(msg('444444444444444444'),'create',config);
  await handle(m,'gx samples export'); assert.match(replies.pop(),/管理/);
  await handle(m,'gx collect off'); assert.deepEqual(config.channelIds,[C]);
  manager=true; await handle(m,'gx collect off'); assert.deepEqual(config.channelIds,[]);
  assert.equal(store.samples(G,C).length,1);
});
test('設定保存失敗では収集設定を変えない',async t=>{
  const {store,config}=setup(t),state={channels:[C],observerBotIds:[]};
  const handle=createCollectionCommands({config,state,store,writer:{save:async()=>{throw Error('disk');}},client:{},reply:async()=>{},isManager:()=>true});
  await assert.rejects(handle({guildId:G,channelId:C},'gx collect off'),/disk/);
  assert.deepEqual(config.channelIds,[C]);assert.deepEqual(state.channels,[C]);
});
test('現行Components V2の武器詳細にあるリロール回数を候補画面と誤分類しない',t=>{
  const {store,config}=setup(t);
  store.capture(msg('444444444444444444',{components:[{type:17,components:[{type:10,content:'**Owner:** @display_name\n**ID:** `ABCDEF`\nReroll Changes: 3 | Reroll Attempts: 72'}]}]}),'create',config);
  const r=store.samples(G,C)[0];
  assert.equal(r.kind,'weapon');assert.deepEqual(r.facts.weaponIds,['ABCDEF']);assert.equal(r.subject_id,null);
  assert.equal(r.facts.inventoryConfirmed,false);
});
test('battle通常返信だけから勝敗・ターン・表示編成を保存、外部ログを取得しない',t=>{
  const {store,config}=setup(t);
  store.capture(msg('444444444444444444',{embeds:[{author:{icon_url:avatar(U)},footer:{text:'You won in 8 turns! | Streak: 12'},fields:[{name:'own',value:'L. 41 cat - staff'},{name:'opponent',value:'L. 29 wolf - orb'}]}]}),'create',config);
  const r=store.personal(G,U)[0];
  assert.equal(r.kind,'battle');assert.equal(r.facts.battle.outcome,'won');assert.equal(r.facts.battle.turns,8);
  assert.equal(r.facts.battle.visibleTeams.length,2);
});
