import test from 'node:test';
import assert from 'node:assert/strict';
import {compactAdvisorTools} from '../src/compact-advisor-tools.js';
import {createAiCommands} from '../src/ai-commands.js';
test('compact overview offers scoped detail without duplicating payloads',()=>{
 const data={formations:[],truncated:false,observations:[{kind:'weapon',source:{messageId:'111111111111111111',url:'https://example.org',sourceAt:'2026-10-06'},display:'a'.repeat(2000)}]};
 const tools=compactAdvisorTools({definitions:[],invoke:()=>data});
 const summary=tools.invoke('get_player_context');assert.equal(summary.observations[0].preview.length,220);assert.equal(summary.observations[0].more,true);
 assert.equal(tools.invoke('get_observation_detail',{messageId:'111111111111111111'}).text.length,2000);
 assert.throws(()=>tools.invoke('get_observation_detail',{messageId:'222222222222222222'}));
 assert.throws(()=>tools.invoke('get_observation_detail',{messageId:'111111111111111111',userId:'another'}));
});
test('reply continues only same user and channel, expires after thirty minutes',async()=>{
 const old=process.env.OPENROUTER_KEY;process.env.OPENROUTER_KEY='test';
 try{
  let now=0,calls=0;
  const handler=createAiCommands({config:{guildId:'g',channelIds:['c','d'],statePath:'data/state.json'},now:()=>now,
   makeTools:()=>({definitions:[],close(){}}),run:async({history})=>{calls++;assert.equal(history.length,calls===1?0:2);return {history:[{role:'user',content:'first'},{role:'assistant',content:'answer'}],answer:'answer',usage:[],apiMs:1};}});
  const message={guildId:'g',channelId:'c',author:{id:'u'},reply:async()=>({id:'reply',edit:async()=>{}})};
  await handler(message,'gai first');now=20000;
  const reply={...message,reference:{messageId:'reply'}};
  assert.equal(await handler({...reply,author:{id:'other'}},'続き'),false);
  assert.equal(await handler({...reply,channelId:'d'},'続き'),false);
  assert.equal(await handler(reply,'続き'),true);assert.equal(calls,2);
  now=1900000;assert.equal(await handler(reply,'続き'),false);assert.equal(calls,2);
 }finally{if(old===undefined)delete process.env.OPENROUTER_KEY;else process.env.OPENROUTER_KEY=old;}
});
