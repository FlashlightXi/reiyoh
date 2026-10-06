import test from 'node:test';
import assert from 'node:assert/strict';
import {aiPayload,createAiCommands} from '../src/ai-commands.js';
import {normalizeCommand} from '../src/collection-commands.js';
import {classify,observedFacts} from '../src/observations.js';

test('prefixes preserve timer and query case, gx defaults to useful help',()=>{
  assert.equal(normalizeCommand('g'),'g');assert.equal(normalizeCommand('gx'),'gx help');
  assert.equal(normalizeCommand('gai ABCDEFを見て'),'gai ABCDEFを見て');
  assert.equal(normalizeCommand('g! team'),'gx team');assert.equal(normalizeCommand('gxbl export'),'gx logs export');
});
test('observed unknown formats classify without inventing inventory ownership',()=>{
  const pairs=[['hunt is empowered by gems. gained **109xp**!','hunt'],['spent 5 coins and caught a **common** bee','hunt'],['cat is now wielding **Healing Staff**!','equipment'],['you currently have **11,462** Weapon Shards!','shards'],["<@700000000000000000>'s Daily Checklist",'checklist'],['Slow down and try the command again','cooldown'],['I could not find a weapon with that unique weapon id!','error']];
  for(const [content,kind] of pairs)assert.equal(classify({content},'owo'),kind);
  assert.equal(observedFacts({content:pairs[0][0]},'hunt').hunt.xp,109);
  assert.equal(observedFacts({content:pairs[3][0]},'shards').shards.count,11462);
  assert.equal(classify({content:'an unknown future format'},'owo'),'unknown');
});
test('AI payload bounds embed and preserves complete long answer with tokens and rich time',()=>{
  const p=aiPayload({answer:'文'.repeat(6000),trace:Array.from({length:12},()=>({name:'get_pet_roster',done:true})),usage:[{prompt_tokens:100,completion_tokens:20},{prompt_tokens:40,completion_tokens:10}],apiMs:1234,completedAt:2000000});
  const text=p.components[0].components.filter(c=>c.type===10).map(c=>c.content).join('\n');assert.equal(p.flags,32768);assert.equal(p.components[0].accent_color,undefined);assert.match(text,/140/);assert.match(text,/30/);assert.ok(p.components[0].components.some(c=>c.type===14));
  assert.match(text,/<t:2000:R>/);assert.equal(p.files[0].attachment.toString().length,6000);
  assert.deepEqual(p.allowedMentions.parse,[]);
});
test('gai edits the same reply, scopes public data, and closes tools',async()=>{
  const previous=process.env.OPENROUTER_KEY;process.env.OPENROUTER_KEY='test';
  try {
    let closed=0,tick=20000,replies=0;const edits=[];
    const handler=createAiCommands({config:{guildId:'g',channelIds:['c'],statePath:'data/state.json'},now:()=>tick+=2000,
      makeTools(scope){assert.equal(scope.includePersonalKnowledge,false);assert.deepEqual(scope.channelIds,['c']);assert.equal(scope.userId,'u');return {close(){closed++;}};},
      run:async({prompt,onProgress,audience})=>{assert.equal(prompt,'ABCDEF');assert.equal(audience,'channel');await onProgress({phase:'tool-start',name:'get_pet_roster'});await onProgress({phase:'tool-end',name:'get_pet_roster',ok:true});return {answer:'回答',usage:[{total_tokens:10}],apiMs:1000};}});
    const m={guildId:'g',channelId:'c',author:{id:'u'},reply:async p=>{replies++;return {edit:async p=>edits.push(p)};}};
    assert.equal(await handler(m,'gai ABCDEF'),true);assert.equal(replies,1);assert.equal(closed,1);assert.ok(edits.length>=2);
    assert.match(JSON.stringify(edits.at(-1).components),/回答/);
    await handler({...m,channelId:'else'},'gai ABCDEF');assert.equal(closed,1);
  } finally {if(previous===undefined)delete process.env.OPENROUTER_KEY;else process.env.OPENROUTER_KEY=previous;}
});
