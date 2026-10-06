import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openObservations } from '../src/observations.js';
import { parseBoss, createBossRecords, boundedFetch } from '../src/boss-records.js';

const guild='111111111111111111', channel='222222222222222222', user='333333333333333333', owo='408785106942164992';
const uuid='00000000-0000-0000-0000-000000000001';
const config={guildId:guild,channelIds:[channel],owoBotId:owo};
const msg=(text,id='444444444444444444')=>({id,guild_id:guild,channel_id:channel,author:{id:owo,bot:true},timestamp:'2026-01-01T00:00:00Z',components:[{type:17,components:[{type:10,content:text}]}]});
const mail=`You defeated a guild boss!\nReceived: <t:100:R>\nYou dealt \`9,000\` damage and were ranked 4th\n<:weaponshard:111111111111111111> 79\n<:crate:111111111111111111> 2\n<:bcrate:111111111111111111> 2\n+14,284xp\n+7,142xp\nhttps://owobot.com/battle-log?uuid=${uuid}`;

test('boss mail preserves displayed rewards and distinct experience groups',()=>{
  const p=parseBoss(msg(mail)); assert.equal(p.type,'mail'); assert.equal(p.damage,9000);
  assert.deepEqual(p.rewards,{shards:79,crates:2,bossCrates:2,experience:[14284,7142]});
  assert.deepEqual(p.uuids,[uuid]); assert.equal(parseBoss(msg('You won in 8 turns')),null);
});
test('UUID fetch deduplicates edits; stored logs enforce channel and actor; restart persists',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'reiyoh-boss-')); const file=path.join(dir,'observations.sqlite');
  const store=openObservations(file);let requests=0;
  const fetcher=async()=>{requests++;return new Response(JSON.stringify({uuid,v2:true,logs:'[]'}));};
  const source=msg(mail);source.interaction_metadata={user:{id:user}};store.capture(source,'create',config);
  const board=msg('A Guild Boss Appeared!\nruns away <t:110:R> **2** fighters **5** defeated','555555555555555555');store.capture(board,'create',config);
  let service=createBossRecords({dbPath:file,config,fetcher,now:()=>200000});
  try{
    await service.sync();source.edited_timestamp='2026-01-01T00:01:00Z';store.capture(source,'update',config);await service.sync();
    assert.equal(requests,1);assert.equal(service.logs(guild,channel,user).length,1);
    assert.equal(service.logs(guild,'999999999999999999',user).length,0);
    assert.equal(service.logs(guild,channel,'999999999999999999').length,0);
    assert.match(JSON.stringify(service.payload(guild,channel)),/終了時刻/);
    await service.close();service=createBossRecords({dbPath:file,config,fetcher});await service.sync();assert.equal(requests,1);
  }finally{await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('image OCR uses in-memory bytes; failure is persisted and not repeatedly fetched',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'reiyoh-boss-')); const file=path.join(dir,'observations.sqlite');const store=openObservations(file);
  const board=msg('A Guild Boss Appeared!');board.components[0].components.push({type:12,items:[{media:{url:'https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/reward.png'}}]});
  store.capture(board,'create',config);let count=0;
  const service=createBossRecords({dbPath:file,config,fetcher:async()=>{count++;return new Response('image');},ocr:async b=>{assert.ok(Buffer.isBuffer(b));throw Error('uncertain');}});
  try{await service.sync();await service.sync();assert.equal(count,1);assert.match(JSON.stringify(service.payload(guild,channel)),/失敗/);}
  finally{await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('bounded fetch rejects oversized bodies and redirects are disabled',async()=>{
  await assert.rejects(boundedFetch('https://logs.owobot.com/logs/'+uuid,2,async(u,o)=>{assert.equal(o.redirect,'error');return new Response('123');}),/large/);
});

test('leaderboard links retain per-row owners rather than command actor',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'reiyoh-boss-'));const file=path.join(dir,'observations.sqlite');const store=openObservations(file);
 const other='666666666666666666', second='00000000-0000-0000-0000-000000000002';
 const source=msg(`A Guild Boss Appeared!\n<@${user}> https://owobot.com/battle-log?uuid=${uuid}\n<@${other}> https://owobot.com/battle-log?uuid=${second}`);
 source.interaction_metadata={user:{id:user}};store.capture(source,'create',config);
 const service=createBossRecords({dbPath:file,config,fetcher:async url=>new Response(JSON.stringify({uuid:url.split('/').at(-1),logs:'[]'}))});
 try{await service.sync();await service.sync();assert.deepEqual(service.logs(guild,channel,user).map(r=>r.uuid),[uuid]);assert.deepEqual(service.logs(guild,channel,other).map(r=>r.uuid),[second]);}
 finally{await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
