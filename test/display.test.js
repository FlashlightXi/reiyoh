import test from 'node:test';
import assert from 'node:assert/strict';
import {petsPayload,battlePayload,emojiText} from '../src/display.js';
test('pet pages use full records and custom emoji rather than flattened raw text',()=>{
 const fields=Array.from({length:13},(_,i)=>({name:`<:pet:111111111111111111> Pet${i}`,value:'Lvl.34 `[10/100]`\n<:hp:222222222222222222> `0908`'}));
 const p=petsPayload({petDetails:[{fields,source:{url:'https://discord.com/channels/1/2/3',sourceAt:'2026-10-06T00:00:00Z'}}],entries:[]},2);
 const s=JSON.stringify(p);assert.match(s,/Pet6/);assert.match(s,/Pet11/);assert.doesNotMatch(s,/Pet12|Pet0|10\/100/);
 assert.equal(p.flags,32768);assert.equal(p.components[0].accent_color,undefined);assert.ok(p.components[0].components.some(c=>c.type===14));assert.match(s,/2\/3/);
 assert.match(emojiText('<a:future:999999999999999999>'),/<a:future:999999999999999999>/);
});
test('battle rows retain turns, link and source-relative time',()=>{
 const p=battlePayload({counts:{won:1,lost:0,tie:0},recent:[{outcome:'won',turns:8,source:{url:'https://discord.com/channels/1/2/3',sourceAt:'2026-10-06T00:00:00Z'}}]});
 const s=JSON.stringify(p);assert.match(s,/`  8` • \[メッセージ\]/);assert.match(s,/<t:\d+:R>/);assert.equal(p.embeds,undefined);
});

test('battle page two starts at eleven and totals follow rows',()=>{
 const b={counts:{won:100,lost:0,tie:0},total:100,recent:Array.from({length:100},()=>({outcome:'won',turns:8,source:{url:'https://discord.com/channels/1/2/3',sourceAt:'2026-10-06'}}))};
 const p=battlePayload(b,2,'700000000000000006'),blocks=p.components[0].components;
 assert.match(blocks[0].content,/^11\. /);assert.match(blocks[0].content,/\n20\. /);assert.match(blocks[2].content,/記録 `100`戦/);
 const btns=blocks.at(-1).components;assert.equal(btns[1].label,'2 / 10');assert.equal(new Set(btns.map(x=>x.custom_id)).size,3);
});
