import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openObservations } from '../src/observations.js';
import { createCollectionCommands } from '../src/collection-commands.js';
const G='700000000000000010',C='700000000000000002',OTHER='700000000000000005',U='111111111111111111',V='222222222222222222',OWO='408785106942164992';
function team(id,user,weapon,channel=C) {
  return {id,guild_id:G,channel_id:channel,author:{id:OWO,bot:true},timestamp:'2026-10-06T00:00:01.000Z',content:'',
    embeds:[{author:{name:'t',icon_url:`https://cdn.discordapp.com/avatars/${user}/x.png`},description:'owo team add',
      fields:[{name:'[1] <a:sample_pet:700000000000000004> **x**',value:`Lvl 30\n\`${weapon}\` <:uncommon:700000000000000007>`}]}],
    components:[{type:1,components:[{custom_id:'noop',label:'1/2'}]}]};
}
function setup(t) {
  const dir=mkdtempSync(path.join(tmpdir(),'reiyo-team-share-')),file=path.join(dir,'observations.sqlite');
  const store=openObservations(file),config={guildId:G,channelIds:[C,OTHER],owoBotId:OWO,observerBotIds:[],statePath:path.join(dir,'state.json')};
  const state={channels:[C,OTHER],observerBotIds:[]},replies=[],saves=[];
  const handle=createCollectionCommands({config,state,store,writer:{save:async s=>saves.push(structuredClone(s))},client:{},reply:async(_m,s)=>replies.push(s),isManager:()=>false});
  t.after(()=>{store.close();rmSync(dir,{recursive:true});});
  const as=(user,channel=C)=>({guildId:G,channelId:channel,author:{id:user}});
  return {store,config,state,replies,saves,handle,as};
}
test('他の人の編成は収集中の全チャンネルからまとめて返し、対象外チャンネルの記録は出さない',async t=>{
  const x=setup(t);
  x.store.capture(team('444444444444444444',V,'VHERE'),'create',x.config);
  x.store.capture(team('555555555555555555',V,'VELSE',OTHER),'create',x.config);
  x.store.capture(team('666666666666666666',U,'MINE'),'create',x.config);
  assert.equal(await x.handle(x.as(U),`gx team <@${V}>`),true);
  const r=x.replies.pop();
  assert.match(r,/VHERE/);assert.match(r,/VELSE/);assert.doesNotMatch(r,/MINE/);
  await x.handle(x.as(U),`gx team ${V}`);assert.match(x.replies.pop(),/VHERE/);
  await x.handle(x.as(U,OTHER),`gx team <@!${V}>`);assert.match(x.replies.pop(),/VELSE/);
  x.config.channelIds=[C];
  await x.handle(x.as(U),`gx team <@${V}>`);assert.doesNotMatch(x.replies.pop(),/VELSE/);
  await x.handle(x.as(U),'gx team list');
  const list=x.replies.pop();assert.match(list,new RegExp(V));assert.match(list,new RegExp(U));
});
test('hideした人は他人から見えず、本人とshow後は見える',async t=>{
  const x=setup(t);
  x.store.capture(team('444444444444444444',V,'VHERE'),'create',x.config);
  await x.handle(x.as(V),'gx team hide');
  assert.deepEqual(x.state.teamHidden,[V]);assert.deepEqual(x.saves.at(-1).teamHidden,[V]);
  await x.handle(x.as(V),'gx team hide');assert.deepEqual(x.state.teamHidden,[V]);
  await x.handle(x.as(U),`gx team <@${V}>`);const r=x.replies.pop();assert.match(r,/非公開/);assert.doesNotMatch(r,/VHERE/);
  await x.handle(x.as(U),'gx team list');assert.doesNotMatch(x.replies.pop(),new RegExp(V));
  await x.handle(x.as(V),`gx team <@${V}>`);assert.match(x.replies.pop(),/VHERE/);
  await x.handle(x.as(V),'gx team show');assert.deepEqual(x.state.teamHidden,[]);
  await x.handle(x.as(U),`gx team <@${V}>`);assert.match(x.replies.pop(),/VHERE/);
});
test('収集対象外チャンネルでは他人の編成を返さない',async t=>{
  const x=setup(t);
  await x.handle({guildId:G,channelId:'999999999999999999',author:{id:U}},`gx team <@${V}>`);
  assert.match(x.replies.pop(),/対象外/);
});
