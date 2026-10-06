import {readFileSync} from 'node:fs';
export async function runAdvisor({apiKey,tools,prompt,fetchImpl=fetch,maxRounds=5,onTool=()=>{},onProgress=()=>{},audience='private',history=[]}) {
  if(!apiKey)throw Error('OPENROUTER_KEY を設定してください');
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>4000)throw Error('相談文は1〜4000文字で指定してください');
  const instructions=readFileSync(process.env.REIYOH_INSTRUCTIONS_FILE || new URL('../prompts/advisor.md',import.meta.url),'utf8');
  const messages=[{role:'system',content:instructions+(audience==='channel'?'\nこの回答は呼出元チャンネルへ公開される。提供された同チャンネルの本人観測と共通知識の範囲で回答する。回答は日本語1200文字程度を目安にする。':'')},...history,{role:'user',content:prompt}];
  const trace=[],usage=[];
  let calls=0,apiMs=0;
  for(let round=0;round<maxRounds;round++) {
    await onProgress({phase:'model-start'});
    const apiStarted=performance.now();
    const response=await fetchImpl('https://openrouter.ai/api/v1/chat/completions',{
      method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:'openai/gpt-6-luna',messages,tools:tools.definitions,max_tokens:8000,reasoning:{effort:'xhigh'},
        tool_choice:round===maxRounds-1?'none':'auto'}),signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error(`OpenRouter HTTP ${response.status}`);
    const data=await response.json();
    apiMs+=performance.now()-apiStarted;
    if(data.error)throw Error('OpenRouter returned an error');
    usage.push(data.usage);
    await onProgress({phase:'model-end',apiMs,usage:[...usage]});
    const message=data.choices?.[0]?.message;
    if(!message)throw Error('OpenRouter response missing message');
    if(!message.tool_calls?.length) {
      if(!message.content?.trim())throw Error('回答が空でした');
      if(/ではありません|ではなく/.test(message.content)) {
        if(round===maxRounds-1)throw Error('回答の表現確認に達しました。再実行してください');
        messages.push(message,{role:'user',content:'回答の数値・根拠・条件・不確実性を保持し、「ではありません」「ではなく」を含む文を、対象と条件を直接述べる肯定形へ書き換えてください。追加の調査や計算は不要です。修正した回答全文だけ返してください。'});
        continue;
      }
      return {model:data.model,answer:message.content,trace,usage,apiMs,history:[...messages.slice(1),message]};
    }
    if(calls+message.tool_calls.length>12)throw Error('ツール呼出し上限に達しました');
    messages.push(message);
    for(const call of message.tool_calls) {
      calls++;
      await onProgress({phase:'tool-start',name:call.function.name});
      let result,args;
      try { args=JSON.parse(call.function.arguments);result=await tools.invoke(call.function.name,args); }
      catch { result={error:'指定したツールまたは引数を確認してください。'}; }
      const content=JSON.stringify(result);
      if(content.length>100000)throw Error('ツール出力が上限に達しました');
      const entry={name:call.function.name,args,ok:!result.error};trace.push(entry);await onTool(entry);
      await onProgress({phase:'tool-end',name:entry.name,ok:entry.ok});
      messages.push({role:'tool',tool_call_id:call.id,content});
    }
  }
  throw Error('回答生成の呼出し上限に達しました');
}
