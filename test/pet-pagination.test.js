import test from 'node:test';
import assert from 'node:assert/strict';
import {handlePetPage} from '../src/pet-pagination.js';
import {petsPayload} from '../src/display.js';
const U='700000000000000006';
const roster={entries:[],petDetails:[{fields:Array.from({length:13},(_,i)=>({name:`Pet${i}`,value:'Lvl.10'})),source:{sourceAt:'2026-10-06',url:'https://discord.com/channels/1/2/3'}}]};
test('navigation disables boundaries and encodes the owner',()=>{
  const buttons=n=>petsPayload(roster,n,U).components[0].components.at(-1).components;
  assert.equal(buttons(1)[0].disabled,true);assert.equal(buttons(1)[2].custom_id,`pets:${U}:next:2`);
  assert.equal(buttons(3)[2].disabled,true);assert.equal(buttons(2)[0].disabled,false);
});
test('only owner can update the bot message and query stays in same channel',async()=>{
 let edited,closed=0,denied=0,queries=0;
 const i={customId:`pets:${U}:2`,guildId:'g',channelId:'c',message:{author:{id:'bot'}},user:{id:'other'},reply:async()=>denied++,deferUpdate:async()=>{},editReply:async p=>edited=p};
 const make=scope=>{queries++;assert.equal(scope.userId,U);assert.deepEqual(scope.channelIds,['c']);return {invoke:()=>roster,close:()=>closed++};};
 const config={guildId:'g',channelIds:['c'],statePath:'data/state.json'};
 await handlePetPage(i,config,'bot',make);assert.equal(denied,1);assert.equal(queries,0);
 i.user.id=U;await handlePetPage(i,config,'bot',make);assert.match(JSON.stringify(edited),/Pet6/);assert.equal(closed,1);
});

test('every button ID stays unique at first, last, and single page',()=>{
 for(const page of [1,2,3]){const b=petsPayload(roster,page,U).components[0].components.at(-1).components;assert.equal(new Set(b.map(x=>x.custom_id)).size,b.length);}
 const b=petsPayload({entries:[],petDetails:[]},1,U).components[0].components.at(-1).components;
 assert.equal(new Set(b.map(x=>x.custom_id)).size,3);
});
