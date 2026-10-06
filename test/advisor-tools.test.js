import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseFormation } from '../src/formations.js';
import { openObservations,commandInfo } from '../src/observations.js';
import { createAdvisorTools } from '../src/advisor-tools.js';
const G='700000000000000010',C='700000000000000002',OTHER='700000000000000005',U='111111111111111111',V='222222222222222222',OWO='408785106942164992';
function team(id,page=1,user=U,weapon='ABCDEF',level=34) {
  return {id,guild_id:G,channel_id:C,author:{id:OWO,bot:true},timestamp:'2026-10-06T00:00:01.000Z',content:'',
    embeds:[{author:{name:'test team',icon_url:`https://cdn.discordapp.com/avatars/${user}/x.png`},description:'owo team add',
      fields:[{name:'[1] <a:sample_pet:700000000000000004> **same nickname**',value:`Lvl ${level} \`[999999/9999999]\`\n<:hp:700000000000000008> \`0908\` <:wp:700000000000000009> \`1112\`\n\`${weapon}\` <:uncommon:700000000000000007> <:bushield:700000000000000003> 36.2%`}]}],
    components:[{type:1,components:[{custom_id:'noop',label:`${page}/2`}]}]};
}
function setup(t) {
  const dir=mkdtempSync(path.join(tmpdir(),'reiyo-advisor-')),file=path.join(dir,'observations.sqlite');
  const store=openObservations(file),config={guildId:G,channelIds:[C,OTHER],owoBotId:OWO,observerBotIds:[]};
  const tools=createAdvisorTools({dbPath:file,guildId:G,userId:U,channelIds:[C]});
  t.after(()=>{tools.close();store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));rmSync(dir,{recursive:true});});
  return {store,config,tools};
}
test('枠順と装備ID・実能力値を取り出し、経験値やnicknameを個体IDと誤解しない',()=>{
  const f=parseFormation(team('444444444444444444'));
  assert.equal(f.slots[0].stats.hp,908);assert.equal(f.slots[0].level,34);assert.equal(f.slots[0].weaponId,'ABCDEF');
  assert.equal(f.slots[0].species.instanceId,null);assert.equal(f.active,null);assert.equal(f.presetPage,1);assert.equal(f.completeSlots,false);
  for(const c of ['gsetteam 2','gteams','guseteams 1','gsquads'])assert.equal(commandInfo(c).kind,'team');
});
test('ページ切替は別プリセット。編集の重複を変更回数にせず、同プリセットの観測差分だけ抽出',t=>{
  const {store,config,tools}=setup(t),id='444444444444444444';
  store.capture(team(id),'create',config);
  store.capture({...team(id,2,U,'SECOND'),edited_timestamp:'2026-10-06T00:00:02.000Z'},'update',config);
  store.capture({...team(id),edited_timestamp:'2026-10-06T00:00:03.000Z'},'update',config);
  store.capture({...team(id,1,U,'ABCDEF',35),edited_timestamp:'2026-10-06T00:00:04.000Z'},'update',config);
  const result=tools.invoke('get_formation_history');
  assert.equal(result.latestDisplays.length,2);assert.equal(result.history.length,3);
  assert.ok(result.history.at(-1).changes.some(c=>c.field==='level'));
  assert.ok(!result.history.at(-1).changes.some(c=>c.field==='weaponId'));
});
test('同じページ番号でも別メッセージなら同一プリセットとして差分を結び付けない',t=>{
  const {store,config,tools}=setup(t);
  store.capture(team('444444444444444444',1,U,'ABCDEF'),'create',config);
  store.capture({...team('555555555555555555',1,U,'SECOND'),timestamp:'2026-10-06T00:00:02.000Z'},'create',config);
  const r=tools.invoke('get_formation_history');
  assert.equal(r.latestDisplays.length,2);assert.ok(r.history.every(e=>e.changes[0].type==='first-observation'));
});
test('別ユーザー・別チャンネルを返さずモデルのscope引数を拒否',t=>{
  const {store,config,tools}=setup(t);
  store.capture(team('444444444444444444',1,V),'create',config);
  store.capture({...team('555555555555555555'),channel_id:OTHER},'create',config);
  assert.equal(tools.invoke('get_formation_history').history.length,0);
  assert.throws(()=>tools.invoke('get_player_context',{userId:V}));
  assert.throws(()=>tools.invoke('get_analysis_record',{id:'private-example'}));
  assert.ok(tools.invoke('search_strategy_knowledge',{query:''}).every(c=>!c.ownerId));
});
test('戦績は各メッセージの最新結果だけ。編集3版を3勝と数えない',t=>{
  const {store,config,tools}=setup(t);
  for(let i=0;i<3;i++)store.capture({...team('444444444444444444'),edited_timestamp:`2026-10-06T00:00:0${i+2}.000Z`,
    embeds:[{author:{icon_url:`https://cdn.discordapp.com/avatars/${U}/x.png`},footer:{text:'You won in 8 turns!'},fields:[]}]},i?'update':'create',config);
  const r=tools.invoke('get_battle_summary');assert.equal(r.total,1);assert.equal(r.counts.won,1);
});
test('新形式のWeapons所有メンションを取得し一覧不完全を保持',t=>{
  const {store,config,tools}=setup(t);
  store.capture({...team('444444444444444444'),embeds:[],components:[{type:10,content:`## 🗡️ <@${U}>'s Weapons\n\`ABCDEF\` <:shield:123456789012345678> **Shield** 50%`}]},'create',config);
  const r=tools.invoke('get_player_context');assert.equal(r.observations.length,1);assert.equal(r.observations[0].kind,'weapon');
  assert.equal(r.currentInventoryConfirmed,false);
});
