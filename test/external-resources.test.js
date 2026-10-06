import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openObservations} from '../src/observations.js';
import {createAdvisorTools} from '../src/advisor-tools.js';
import {withExtensions} from '../src/extensions.js';
test('external knowledge keeps personal cards out of channel replies',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'reiyoh-test-'));
 const file=path.join(dir,'observations.sqlite'),cards=path.join(dir,'cards.json');
 const old=process.env.REIYOH_KNOWLEDGE_FILE;
 try{
  openObservations(file).close();
  writeFileSync(cards,JSON.stringify([{id:'shared'},{id:'personal',ownerId:'111111111111111111'}]));
  process.env.REIYOH_KNOWLEDGE_FILE=cards;
  for(const [userId,includePersonalKnowledge,expected] of [['111111111111111111',false,1],['111111111111111111',true,2],['222222222222222222',true,1]]){
   const tools=createAdvisorTools({dbPath:file,guildId:'333333333333333333',channelIds:['444444444444444444'],userId,includePersonalKnowledge});
   try{assert.equal(tools.invoke('search_strategy_knowledge',{query:''}).length,expected);}finally{tools.close();}
  }
 }finally{if(old===undefined)delete process.env.REIYOH_KNOWLEDGE_FILE;else process.env.REIYOH_KNOWLEDGE_FILE=old;rmSync(dir,{recursive:true});}
});
test('optional example calculation uses validated bounded arguments',()=>{
 const old=process.env.REIYOH_TOOLS_MODULE;
 try{
  process.env.REIYOH_TOOLS_MODULE=path.resolve('examples/tools.cjs');
  const tools=withExtensions({definitions:[],invoke(){throw Error('unavailable');}},{guildId:'g',userId:'u',channelIds:['c'],visibility:'channel'});
  assert.equal(tools.invoke('example_resource_balance',{cost:20,refill:12}).netPerCycle,-8);
  assert.throws(()=>tools.invoke('example_resource_balance',{cost:20,refill:Infinity}));
 }finally{if(old===undefined)delete process.env.REIYOH_TOOLS_MODULE;else process.env.REIYOH_TOOLS_MODULE=old;}
});
