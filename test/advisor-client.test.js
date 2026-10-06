import test from 'node:test';
import assert from 'node:assert/strict';
import {runAdvisor} from '../src/advisor-client.js';

test('tool result is returned to model with matching call ID',async()=>{
  let calls=0;
  const result=await runAdvisor({apiKey:'test',prompt:'test',tools:{definitions:[],invoke(name,args){assert.equal(name,'get_pet_roster');return {entries:[{level:34}]};}},fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);calls++;
    if(calls===1)return {ok:true,json:async()=>({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call1',type:'function',function:{name:'get_pet_roster',arguments:'{}'}}]}}]})};
    assert.equal(body.messages.at(-1).tool_call_id,'call1');assert.equal(JSON.parse(body.messages.at(-1).content).entries[0].level,34);
    return {ok:true,json:async()=>({model:'test',choices:[{message:{role:'assistant',content:'Lv34です'}}]})};
  }});
  assert.equal(calls,2);assert.equal(result.trace.length,1);assert.equal(result.answer,'Lv34です');
});
test('HTTP errors expose status only and tool loops are bounded',async()=>{
  await assert.rejects(runAdvisor({apiKey:'secret',prompt:'test',tools:{definitions:[]},fetchImpl:async()=>({ok:false,status:401})}),/HTTP 401/);
  await assert.rejects(runAdvisor({apiKey:'test',prompt:'test',maxRounds:1,tools:{definitions:[],invoke(){return {};}},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{role:'assistant',tool_calls:[{id:'x',function:{name:'x',arguments:'{}'}}]}}]})})}),/上限/);
});
test('negative contrast wording receives a bounded rewrite preserving conditions',async()=>{
  let calls=0;
  const result=await runAdvisor({apiKey:'test',prompt:'test',tools:{definitions:[]},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{role:'assistant',content:++calls===1?'現在値ではありません。':'比較条件は過去Lv33です。'}}]})})});
  assert.equal(calls,2);assert.equal(result.answer,'比較条件は過去Lv33です。');
});
