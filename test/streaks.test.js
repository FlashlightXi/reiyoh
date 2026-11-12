import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openObservations, commandInfo } from '../src/observations.js';
import { createAdvisorTools } from '../src/advisor-tools.js';
import { compactAdvisorTools } from '../src/compact-advisor-tools.js';
import { parseBattleResult, parseTeamStreak, summarizeStreak } from '../src/streaks.js';
import { battlePayload } from '../src/display.js';

const G='700000000000000010',C='700000000000000002',U='111111111111111111',V='222222222222222222',OWO='408785106942164992';
const avatar=id=>`https://cdn.discordapp.com/avatars/${id}/x.png`;
const stamp=n=>new Date(Date.UTC(2026,9,6,0,0,0)+n*1000).toISOString();
const id=n=>String(500000000000000000n+BigInt(n));
function setup(t) {
  const dir=mkdtempSync(path.join(tmpdir(),'reiyo-streak-')),file=path.join(dir,'observations.sqlite');
  const store=openObservations(file),config={guildId:G,channelIds:[C],owoBotId:OWO,observerBotIds:[]};
  const tools=createAdvisorTools({dbPath:file,guildId:G,userId:U,channelIds:[C]});
  t.after(()=>{tools.close();store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));rmSync(dir,{recursive:true});});
  let n=0;
  const owo=(extra,user=U)=>{n++;const m={id:id(n),guild_id:G,channel_id:C,author:{id:OWO,bot:true},timestamp:stamp(n),edited_timestamp:null,content:'',components:[],...extra};
    m.embeds=(m.embeds??[]).map(e=>({author:{icon_url:avatar(user)},...e}));store.capture(m,'create',config);return m;};
  const battle=(footer,user=U,extra={})=>owo({embeds:[{footer:{text:footer},fields:[]}],...extra},user);
  const input=(content,user=U)=>{n++;const m={id:id(n),guild_id:G,channel_id:C,author:{id:user,bot:false},timestamp:stamp(n),content,embeds:[],components:[]};store.capture(m,'create',config);return m;};
  return {store,config,tools,owo,battle,input};
}

test('戦闘フッターからOwO表示の連勝・切れた連勝・XPとボーナスを読む',()=>{
  assert.deepEqual(parseBattleResult('You won in 8 turns! Your team gained 200 + 2,000 xp! Streak: 1,230'),
    {outcome:'won',turns:8,streak:1230,lostStreak:null,xp:200,bonusXp:2000});
  assert.deepEqual(parseBattleResult('You lost in 5 turns! Your team gained 50 xp! You lost your streak of 12 wins...'),
    {outcome:'lost',turns:5,streak:null,lostStreak:12,xp:50,bonusXp:null});
  assert.equal(parseBattleResult("It's a tie in 20 turns! Streak: 7").streak,7);
  assert.deepEqual(parseBattleResult('You won in 3 turns!  |  +2,174 xp  |  Streak: 250'),{outcome:'won',turns:3,streak:250,lostStreak:null,xp:2174,bonusXp:null});
  assert.deepEqual(parseBattleResult('You lost in 8 turns!  |  +50 xp  |  Streak ended at 1,799'),{outcome:'lost',turns:8,streak:null,lostStreak:1799,xp:50,bonusXp:null});
  assert.deepEqual(parseBattleResult("It's a tie in 24 turns!  |  +100 xp  |  Streak: 248"),{outcome:'tie',turns:24,streak:248,lostStreak:null,xp:100,bonusXp:null});
  assert.deepEqual(parseBattleResult("Battle was too long! It's a tie! Your team gained 100 xp! Streak: 54"),{outcome:'tie',turns:null,streak:54,lostStreak:null,xp:100,bonusXp:null});
  assert.deepEqual(parseBattleResult('PlayerA / 1,427 Streak wins!'),{outcome:'unknown',turns:null,streak:null,lostStreak:null,xp:null,bonusXp:null});
  assert.equal(parseBattleResult('You won in 3 turns!').streak,null);
  assert.deepEqual(parseTeamStreak('Current Streak: 41 | Highest Streak: 1,205'),{current:41,highest:1205});
});

test('表示値がない連続勝利は下限として扱い、表示値があればそれを採用する',()=>{
  const won={type:'battle',outcome:'won',streak:null};
  const low=summarizeStreak([won,won,won]);
  assert.deepEqual([low.current.value,low.current.basis],[3,'observed-lower-bound']);
  const reported=summarizeStreak([won,won,{type:'battle',outcome:'won',streak:57},won,{type:'battle',outcome:'tie',streak:null}]);
  assert.deepEqual([reported.current.value,reported.current.basis],[58,'estimated']);
  assert.deepEqual([reported.highest.value,reported.highest.basis],[58,'estimated']);
});

test('観測が3戦でもOwO表示の連勝を現在値にし、team表示の最高連勝と切れた実績を残す',t=>{
  const {tools,battle,owo}=setup(t);
  battle('You won in 8 turns! Your team gained 200 xp! Streak: 40');
  battle('You lost in 9 turns! Your team gained 50 xp! You lost your streak of 40 wins');
  battle('You won in 6 turns! Your team gained 200 xp! Streak: 1');
  battle('You won in 6 turns! Your team gained 200 + 400 xp! Streak: 2');
  const r=tools.invoke('get_battle_summary');
  assert.deepEqual(r.counts,{won:3,lost:1,tie:0,unknown:0});assert.equal(r.winRate,0.75);
  assert.deepEqual([r.streak.current.value,r.streak.current.basis],[2,'reported']);
  assert.deepEqual([r.streak.highest.value,r.streak.highest.basis],[40,'reported']);
  assert.equal(r.streak.breaks.count,1);assert.equal(r.streak.breaks.largest.streak,40);
  assert.equal(r.streak.xp.bonusTotal,400);assert.equal(r.streak.bonuses[0].streak,2);
  owo({embeds:[{description:'owo team add',footer:{text:'Current Streak: 2 | Highest Streak: 310'}}]});
  const after=tools.invoke('get_battle_summary').streak;
  assert.equal(after.highest.value,310);assert.equal(after.current.value,2);
  const compact=compactAdvisorTools(tools).invoke('get_battle_summary');
  assert.equal(compact.streak.highest.value,310);assert.equal(compact.recent[0].streak,2);assert.match(compact.streak.basisNote,/reported/);
  assert.match(JSON.stringify(battlePayload(tools.invoke('get_battle_summary'))),/連勝 `  2`（OwO表示） • 最高 `310`（OwO表示） • 切れた連勝の最大 ` 40`（1回）/);
});

test('他の利用者の戦闘が多いチャンネルでも本人の戦績を取りこぼさない',t=>{
  const {tools,battle}=setup(t);
  battle('You won in 8 turns! Streak: 5');
  for(let i=0;i<2100;i++)battle('You won in 4 turns!',V);
  const r=tools.invoke('get_battle_summary');
  assert.equal(r.total,1);assert.equal(r.streak.current.value,5);assert.equal(r.truncated,false);
});

test('ボス戦の返信は通常戦の勝敗と連勝に含めない',t=>{
  const {tools,battle,input}=setup(t);
  battle('You won in 8 turns! Streak: 5');
  battle('You lost in 30 turns!',U,{content:'guild boss https://owobot.com/battle-log?uuid=00000000-0000-0000-0000-000000000001'});
  const boss=input('gboss');
  battle('You lost in 30 turns!',U,{message_reference:{message_id:boss.id}});
  const r=tools.invoke('get_battle_summary');
  assert.deepEqual(r.counts,{won:1,lost:0,tie:0,unknown:0});assert.equal(r.bossReplies,2);
  assert.equal(r.streak.current.value,5);assert.equal(r.streak.breaks.count,0);
  assert.equal(commandInfo('gboss t').kind,'boss');assert.equal(commandInfo('gb').kind,'battle');
});

test('本人の入力をコマンドの形ごとに集計し、待機・エラー返信と他人の入力を分ける',t=>{
  const {tools,input,owo}=setup(t);
  const a=input('gw rr ABC123 stat');owo({content:'I could not find a weapon with that unique weapon id',message_reference:{message_id:a.id}});
  input('gw rr XYZ789 stat');
  const b=input('gb');owo({content:'Slow down and try the command again',message_reference:{message_id:b.id}});
  input('owo team add dog 2');input('gtm',V);input('great game');
  const r=tools.invoke('get_command_usage');
  assert.deepEqual(r.totals,{inputs:4,cooldown:1,error:1,noLinkedReply:2});assert.deepEqual(r.prefixes,{g:3,owo:1});
  const rr=r.forms.find(f=>f.form==='gw rr <id> stat');assert.equal(rr.count,2);assert.deepEqual(rr.replies,{error:1,noLinkedReply:1});
  assert.ok(r.forms.some(f=>f.form==='owo team add <arg> <n>'));assert.ok(!r.forms.some(f=>f.form==='gtm'));
  assert.equal(compactAdvisorTools(tools).invoke('get_command_usage').forms.length,3);
  assert.throws(()=>tools.invoke('get_command_usage',{userId:V}));
});
