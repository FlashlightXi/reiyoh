import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openObservations } from '../src/observations.js';
import { createBossRecords } from '../src/boss-records.js';
import { createAdvisorTools } from '../src/advisor-tools.js';
import { compactAdvisorTools } from '../src/compact-advisor-tools.js';
import { withExtensions } from '../src/extensions.js';

const guild='111111111111111111', channel='222222222222222222', user='333333333333333333', other='666666666666666666', owo='408785106942164992';
const uuid='00000000-0000-0000-0000-000000000001', second='00000000-0000-0000-0000-000000000002';
const config={guildId:guild,channelIds:[channel],owoBotId:owo};
const msg=(text,id)=>({id,guild_id:guild,channel_id:channel,author:{id:owo,bot:true},timestamp:'2026-01-01T00:00:00Z',components:[{type:17,components:[{type:10,content:text}]}]});
const mail=(outcome,damage,u)=>`You ${outcome==='won'?'defeated':'failed to defeat'} a guild boss!\nReceived: <t:100:R>\nYou dealt \`${damage}\` damage and were ranked 4th\n<:weaponshard:111111111111111111> 79\n+14,284xp\nhttps://owobot.com/battle-log?uuid=${u}`;

async function setup(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'reiyoh-bh-')),file=path.join(dir,'observations.sqlite');
  const store=openObservations(file);
  const own=msg(mail('lost','9,000',uuid),'444444444444444444');own.interaction_metadata={user:{id:user}};store.capture(own,'create',config);
  const theirs=msg(mail('won','5,000',second),'555555555555555555');theirs.interaction_metadata={user:{id:other}};store.capture(theirs,'create',config);
  store.capture(msg('A Guild Boss Appeared!\nruns away <t:110:R> **2** fighters **5** defeated','777777777777777777'),'create',config);
  const service=createBossRecords({dbPath:file,config,fetcher:async url=>new Response(JSON.stringify({uuid:url.split('/').at(-1),logs:JSON.stringify([{turn:1}])}))});
  await service.sync();await service.sync();await service.close();
  const tools=createAdvisorTools({dbPath:file,guildId:guild,userId:user,channelIds:[channel]});
  t.after(()=>{tools.close();store.close();rmSync(dir,{recursive:true,force:true});});
  return tools;
}

test('boss history returns only the requesting user mails and logs',async t=>{
  const tools=await setup(t);
  const r=tools.invoke('get_boss_history');
  assert.deepEqual(r.counts,{won:0,lost:1});
  assert.equal(r.mails[0].damage,9000);assert.deepEqual(r.mails[0].logUuids,[uuid]);
  assert.deepEqual(r.logs.map(l=>[l.uuid,l.status]),[[uuid,'saved']]);
  assert.equal(r.logs[0].logs,undefined);assert.equal(r.boards[0].fighters,2);
  const c=compactAdvisorTools(tools).invoke('get_boss_history');
  assert.equal(c.medianDamage,9000);assert.equal(c.savedLogs,1);
});

test('trusted calculators receive parsed logs through the host scope only',async t=>{
  const tools=await setup(t),old=process.env.REIYOH_TOOLS_MODULE;
  const dir=mkdtempSync(path.join(os.tmpdir(),'reiyoh-ext-')),mod=path.join(dir,'tools.cjs');
  const {writeFileSync}=await import('node:fs');
  writeFileSync(mod,`exports.createTools=scope=>({definitions:[{type:'function',function:{name:'probe',parameters:{type:'object',properties:{}}}}],invoke(){return scope.data.bossHistory({includeLogs:true,limit:5});}});`);
  try{
    process.env.REIYOH_TOOLS_MODULE=mod;
    const ext=withExtensions(compactAdvisorTools(tools),{guildId:guild,userId:user,channelIds:[channel],visibility:'channel'});
    const r=ext.invoke('probe',{});
    assert.deepEqual(r.logs[0].logs,[{turn:1}]);assert.equal(r.scope.userId,user);
    assert.throws(()=>tools.bossHistory({limit:1000}),/Invalid/);
    assert.equal(tools.bossHistory({includeLogs:true,maxLogBytes:0}).logs[0].omitted,'size-limit');
  }finally{if(old===undefined)delete process.env.REIYOH_TOOLS_MODULE;else process.env.REIYOH_TOOLS_MODULE=old;rmSync(dir,{recursive:true,force:true});}
});

test('boss history is empty before boss records exist',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'reiyoh-bh-')),file=path.join(dir,'observations.sqlite');
  openObservations(file).close();const tools=createAdvisorTools({dbPath:file,guildId:guild,userId:user,channelIds:[channel]});
  t.after(()=>{tools.close();rmSync(dir,{recursive:true,force:true});});
  assert.equal(tools.invoke('get_boss_history').mails.length,0);
});
