import {withExtensions} from './extensions.js';
import {compactAdvisorTools} from './compact-advisor-tools.js';
import {icon,textBlock,separator,cardPayload} from './display.js';
import path from 'node:path';
import {createAdvisorTools} from './advisor-tools.js';
import {runAdvisor} from './advisor-client.js';

const labels={get_observation_detail:'必要な詳細を取得',get_player_context:'編成・装備を取得',get_pet_roster:'ペット一覧を取得',get_formation_history:'編成の履歴を確認',get_battle_summary:'戦績を集計',search_strategy_knowledge:'過去の知見を検索',get_analysis_record:'分析の条件を確認',example_resource_balance:'補給と消費を比較'};
export function aiPayload({stage,trace=[],answer,usage=[],apiMs=0,completedAt,error=false}) {
  const sum=key=>usage.length&&usage.every(u=>Number.isFinite(u?.[key]))?usage.reduce((n,u)=>n+u[key],0).toLocaleString('en-US'):'…';
  const log=trace.slice(-7).map(t=>`-# ${icon(t.ok===false?'lost':t.done?'tool':'pending')} ${labels[t.name]??'情報を確認'}`).join('\n');
  const cached=usage.reduce((n,u)=>n+(u?.prompt_tokens_details?.cached_tokens??0),0);
  const blocks=[];
  if(log)blocks.push(textBlock(log));
  blocks.push(textBlock(answer?answer.slice(0,3000):stage));
  if(completedAt)blocks.push(separator(),textBlock(`-# ${icon('model')} \`gpt-6-luna xhigh\` • ${icon('input')} ${sum('prompt_tokens')}${cached?` (cache ${cached.toLocaleString('en-US')})`:''} ${icon('output')} ${sum('completion_tokens')} • ${icon('time')} ${(apiMs/1000).toFixed(1)}s • <t:${Math.floor(completedAt/1000)}:R>`));
  const payload=cardPayload(blocks);
  if(answer?.length>3000){payload.files=[{attachment:Buffer.from(answer),name:'reiyo-answer.txt'}];payload.components.push({type:13,file:{url:'attachment://reiyo-answer.txt'}});}
  return payload;
}

export function createAiCommands({config,run=runAdvisor,makeTools=createAdvisorTools,now=Date.now}) {
  const active=new Set(),lastStarted=new Map(),sessions=new Map();
  return async function handle(message,command) {
    for(const [key,s] of sessions)if(now()-s.at>1800000)sessions.delete(key);
    const prior=sessions.get(message.reference?.messageId);
    const linked=prior&&prior.userId===message.author.id&&prior.guildId===message.guildId&&prior.channelId===message.channelId;
    if(!/^gai(?:\s|$)/i.test(command)&&!linked)return false;
    if(message.guildId!==config.guildId)return true;
    const simple=text=>message.reply({content:text,allowedMentions:{parse:[],repliedUser:false}});
    if(!config.channelIds.includes(message.channelId)){await simple('このチャンネルの収集を `gx collect on` で有効にしてください。');return true;}
    const prompt=command.replace(/^gai\s*/i,'').trim();
    if(!prompt||prompt.toLowerCase()==='help'){await simple('`gai 通常戦の編成を見て、手持ちで改善できる点を教えて`\nこのチャンネルの本人の記録を調べ、ここへ回答します。');return true;}
    if(prompt.length>4000){await simple('相談内容を4000文字以内にまとめてください。');return true;}
    if(!process.env.OPENROUTER_KEY){await simple('AI接続キーの設定を確認してください。');return true;}
    const id=message.author.id;
    if(active.has(id)||active.size>=2){await simple('進行中の相談が完了してから、もう一度お試しください。');return true;}
    if(now()-(lastStarted.get(id)??-Infinity)<15000){await simple('少し間隔を空けて、もう一度お試しください。');return true;}
    // Bound process-local cooldown state without retaining conversation content.
    for(const [key,time] of lastStarted)if(now()-time>60000)lastStarted.delete(key);
    active.add(id);lastStarted.set(id,now());
    let sent,tools,lastEdit=0;
    const state={stage:'まずは、編成と手持ちの情報を確認します。',trace:[],usage:[],apiMs:0};
    try {
      sent=await message.reply(aiPayload(state));lastEdit=now();
      tools=makeTools({dbPath:path.join(path.dirname(config.statePath),'observations.sqlite'),guildId:message.guildId,userId:id,channelIds:[message.channelId],includePersonalKnowledge:false});
      const result=await run({apiKey:process.env.OPENROUTER_KEY,tools:withExtensions(compactAdvisorTools(tools),{guildId:message.guildId,userId:id,channelIds:[message.channelId],visibility:'channel'}),prompt,audience:'channel',history:linked?prior.history:[],onProgress:async event=>{
        if(event.phase==='model-start')state.stage=state.trace.length?'取得した情報をもとに検討しています。':'相談内容を確認しています。';
        if(event.phase==='model-end'){state.usage=event.usage;state.apiMs=event.apiMs;}
        if(event.phase==='tool-start'){state.stage='必要な情報を調べています。';state.trace.push({name:event.name,done:false});}
        if(event.phase==='tool-end'){const t=state.trace.at(-1);if(t){t.done=true;t.ok=event.ok;}}
        if(now()-lastEdit>=1500){lastEdit=now();await sent.edit(aiPayload(state));}
      }});
      if(sent.id&&result.history){
        const history=result.history;
        if(JSON.stringify(history).length<=50000){sessions.set(sent.id,{history,userId:id,guildId:message.guildId,channelId:message.channelId,at:now()});while(sessions.size>40)sessions.delete(sessions.keys().next().value);}
      }
      await sent.edit(aiPayload({...state,answer:result.answer,usage:result.usage,apiMs:result.apiMs,completedAt:now()}));
    } catch(error) {
      console.warn('[reiyo ai]',/OpenRouter HTTP \d+/.exec(error.message)?.[0]??error.name);
      if(sent)await sent.edit(aiPayload({...state,stage:'回答の取得を中断しました。少し待ってから、もう一度お試しください。',completedAt:now(),error:true})).catch(()=>{});
    } finally {tools?.close();active.delete(id);}
    return true;
  };
}
