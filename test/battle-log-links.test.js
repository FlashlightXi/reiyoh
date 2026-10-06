import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createBattleLogService, createBattleLogStore, extractBattleLogEntries, normalizeBattleLogUrl } from '../src/battle-log-links.js';
import { createStateWriter, loadState } from '../src/state.js';
import { shouldCapture } from '../src/log.js';
import { Tracker } from '../src/tracker.js';

const A = '111111111111111111', B = '222222222222222222', OWO = '408785106942164992';
const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const url = (n) => `https://owobot.com/battle-log?uuid=${uuid(n)}`;
const avatar = (id) => `https://cdn.discordapp.com/avatars/${id}/hash.png`;
function message(n, owner = A) {
  return { id: `m${n}`, author: { id: OWO, bot: true }, guildId: 'guild', channelId: 'channel',
    createdTimestamp: 2000, content: '', embeds: [{ author: { icon_url: avatar(owner) }, description: `[Log Link](${url(n)})` }], components: [] };
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'reiyo-gxbl-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { users: {} };
  const filePath = path.join(directory, 'battle-log-links.jsonl');
  const writer = createStateWriter(path.join(directory, 'state.json'));
  const service = await createBattleLogService({ state, writer, filePath, owoBotId: OWO, now: () => 1000, ...options });
  return { service, state, writer, filePath, directory };
}

test('URLは公式host/path/UUIDだけを正規化する', () => {
  assert.deepEqual(normalizeBattleLogUrl(url(1).toUpperCase().replace('BATTLE-LOG', 'battle-log').replace('UUID=', 'uuid=')), { uuid: uuid(1), url: url(1) });
  for (const value of ['http://owobot.com/battle-log?uuid='+uuid(1), url(1).replace('owobot.com','owobot.com.evil.test'),
    url(1).replace('/battle-log','/other'), url(1)+'&uuid='+uuid(2), url(1).replace(uuid(1),'bad'),
    url(1).replace('https://','https://user@')]) assert.equal(normalizeBattleLogUrl(value), null);
});

test('実返信由来の匿名fixtureでembedとbossの複数リンクを抽出する', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/battle-log-replies.json', import.meta.url), 'utf8'));
  assert.equal(fixtures.length, 2);
  const embed = extractBattleLogEntries(fixtures[0]);
  assert.equal(embed.length, 1);
  assert.equal(embed[0].authorId, A);
  const leaderboard = extractBattleLogEntries(fixtures[1]);
  assert.equal(leaderboard.length, 3);
  assert.ok(leaderboard.every((entry) => entry.rowOwnerId === '700000000000000001'));
});

test('embed.url、author.url、リンクボタンurlも読む', () => {
  const entries = extractBattleLogEntries({ embeds: [{ url: url(1), author: { url: url(2) } }],
    components: [{ type: 1, components: [{ type: 2, url: url(3) }] },
      { type:9,components:[],accessory:{type:2,url:url(4)} }] });
  assert.deepEqual(entries.map((entry) => entry.uuid), [uuid(1), uuid(2), uuid(3), uuid(4)]);
});

test('初期OFF、ON/OFFとURLは再起動後も保持される', async (t) => {
  const { service, state, writer, filePath, directory } = await setup(t);
  assert.equal(await service.capture(message(1)), 0);
  assert.deepEqual(await service.toggle(A), { enabled: true, count: 0 });
  assert.equal(await service.capture(message(1)), 1);
  await service.toggle(A);
  assert.equal(await service.capture(message(2)), 0);
  const restored = await createBattleLogService({ state: await loadState(path.join(directory,'state.json')), writer, filePath,
    owoBotId: OWO, now: () => 1000 });
  assert.equal((await restored.export(A)).text, url(1)+'\n');
  assert.equal(await restored.capture(message(3)), 0);
  await restored.toggle(A);
  assert.equal(await restored.capture(message(1)), 0);
  assert.equal(state.users[A].battleLogCapture.enabled, false);
});

test('同じ返信の編集後に増えるURLを保持し、編集で消えたURLも残す', async (t) => {
  const { service } = await setup(t);
  await service.toggle(A);
  const first = message(1);
  await service.capture(first);
  first.embeds[0].description = `[Log Link](${url(2)})`;
  assert.equal(await service.capture(first), 1);
  assert.equal(await service.capture(first), 0);
  assert.deepEqual((await service.export(A)).text.split('\n').filter(Boolean), [url(1),url(2)]);
});

test('ランキングの各行を所有者に結び付け、同じ返信の他人URLを混ぜない', async (t) => {
  const { service } = await setup(t);
  await service.toggle(A); await service.toggle(B);
  const board = message(1);
  board.embeds = [];
  board.components = [{ type: 17, components: [{ type: 10, content:
    `### Top 10 Damage Dealt\n**1** <@${A}> [📜](${url(1)}) [📜](${url(2)})\n**2** <@${B}> [📜](${url(3)})\n[unknown](${url(4)})` }] }];
  assert.equal(await service.capture(board, { input: { id:'input',userId:A,kind:'battle' } }), 3);
  assert.equal((await service.export(A)).text, url(1)+'\n'+url(2)+'\n');
  assert.equal((await service.export(B)).text, url(3)+'\n');
});

test('OwO以外、ON前の返信、デフォルトアバター、矛盾する根拠は記録しない', async (t) => {
  const { service } = await setup(t);
  await service.toggle(A); await service.toggle(B);
  const other = message(1); other.author = { id:A,bot:false };
  assert.equal(await service.capture(other), 0);
  const old = message(2); old.createdTimestamp = 500;
  assert.equal(await service.capture(old), 0);
  const noId = message(3); noId.embeds[0].author.icon_url='https://cdn.discordapp.com/embed/avatars/1.png';
  assert.equal(await service.capture(noId), 0);
  const conflict=message(4); conflict.interactionMetadata={user:{id:B}};
  assert.equal(await service.capture(conflict), 0);
});

test('明示参照でboss/mailの複数URLを記録し、参照取得不能なら推定しない', async (t) => {
  const { service } = await setup(t, { resolveReference: async (msg) => {
    if (msg.id === 'missing') throw new Error('missing');
    return { channelId:'channel',author:{id:A,bot:false} };
  }});
  await service.toggle(A);
  const mail = message(1); mail.embeds=[];
  mail.components=[{content:`[View Battle Log 1](${url(1)})\n[View Battle Log 2](${url(2)})`}];
  mail.reference={messageId:'input'};
  assert.equal(await service.capture(mail), 2);
  mail.id='missing'; mail.components=[{content:`[View Battle Log](${url(3)})`}];
  assert.equal(await service.capture(mail), 0);
});

test('別ブロックの利用者名を未所属リンクに流用せず、embed fieldの明示IDは使う', async (t) => {
  const { service } = await setup(t);
  await service.toggle(A); await service.toggle(B);
  const board=message(1); board.embeds=[];
  board.components=[{content:`<@${B}> [📜](${url(1)})`},{url:url(2)}];
  await service.capture(board,{input:{id:'input',userId:A,kind:'battle'}});
  assert.equal((await service.export(A)).count,0);
  assert.equal((await service.export(B)).text,url(1)+'\n');
  const fields=message(3); fields.embeds=[{author:{icon_url:avatar(A)},fields:[{name:`<@${B}>`,value:`[Log Link](${url(3)})`}]}];
  await service.capture(fields);
  assert.equal((await service.export(B)).text,url(1)+'\n'+url(3)+'\n');
});

test('サービスのexportは0件でも使え、URL保存の失敗を警告して既存分を保持する', async (t) => {
  let fail=false;
  const { service }=await setup(t,{append:async(p,text,encoding)=>{
    if(fail)throw new Error('disk');
    await appendFile(p,text,encoding);
  }});
  assert.equal((await service.export(A)).count,0);
  await service.toggle(A); await service.capture(message(1));
  fail=true;
  await assert.rejects(service.capture(message(2)),/disk/);
  const partial=await service.export(A);
  assert.equal(partial.text,url(1)+'\n');
  assert.equal(partial.warnings,1);
  fail=false;
  assert.equal(await service.capture(message(2)),1);
  assert.equal((await service.export(A)).count,2);
});

test('URL後付けduplicateは保存でき、クールダウンは再開始しない', async (t) => {
  const { service } = await setup(t);
  await service.toggle(A);
  const tracker = new Tracker();
  tracker.observeInput({id:'input',author:{id:A},channelId:'channel',content:'gb',createdTimestamp:1500});
  const resultMessage = message(1); resultMessage.embeds=[]; resultMessage.content='Battle results';
  resultMessage.reference={messageId:'input'};
  const first = tracker.observeResponse(resultMessage);
  await service.capture(resultMessage, {result:first,input:tracker.responses.get(resultMessage.id)});
  const until = tracker.snapshot(A).cooldowns.battle.until;
  resultMessage.content=`[Log Link](${url(1)})`;
  const second = tracker.observeResponse(resultMessage);
  assert.equal(second.status, 'duplicate');
  assert.equal(await service.capture(resultMessage, {result:second,input:tracker.responses.get(resultMessage.id)}),1);
  assert.equal(tracker.snapshot(A).cooldowns.battle.until,until);
});

test('曖昧だった返信はpendingが減っただけでは採らず、明示authorがあれば採る', async (t) => {
  const { service } = await setup(t);
  await service.toggle(A);
  const reply=message(1); reply.embeds=[]; reply.content=`[Log Link](${url(1)})`;
  assert.equal(await service.capture(reply,{result:{status:'ambiguous'}}),0);
  assert.equal(await service.capture(reply,{result:{status:'matched'},input:{id:'input',userId:A,kind:'battle'}}),0);
  reply.embeds=message(1).embeds; reply.content='';
  assert.equal(await service.capture(reply,{input:{id:'wrong',userId:B,kind:'battle'}}),1);
});

test('未応答AにBの返信が誤対応してもAには保存せず、明示実行者Bで記録する', async (t) => {
  const { service }=await setup(t);
  await service.toggle(A); await service.toggle(B);
  const reply=message(1); reply.embeds=[]; reply.content=`[Log Link](${url(1)})`;
  const input={id:'a-input',userId:A,kind:'battle'};
  assert.equal(await service.capture(reply,{input}),0);
  reply.interactionMetadata={user:{id:B}};
  assert.equal(await service.capture(reply,{input}),1);
  assert.equal((await service.export(A)).count,0);
  assert.equal((await service.export(B)).text,url(1)+'\n');
});

test('toggle保存失敗中に他の状態保存が並んでも最後に元の設定を永続化する', async (t) => {
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;});
  const began=new Promise(resolve=>{started=resolve;});
  let pending=Promise.resolve(),calls=0,saved;
  const writer={save(state){
    const snapshot=JSON.parse(JSON.stringify(state));
    const operation=pending.catch(()=>{}).then(async()=>{
      if(calls++===0){started();await gate;throw new Error('transient disk error');}
      saved=snapshot;
    });
    pending=operation;return operation;
  }};
  const {service,state}=await setup(t,{writer});
  const toggle=service.toggle(A);
  const failed=assert.rejects(toggle,/transient disk error/);
  await began;
  const concurrent=writer.save(state);
  release();
  await Promise.all([failed,concurrent]);
  assert.equal(state.users[A].battleLogCapture,undefined);
  assert.equal(saved.users[A].battleLogCapture,undefined);
});

test('保存待ちのexport、同時重複、繰り返しexportで欠落や他人混入がない', async (t) => {
  const { service } = await setup(t);
  await service.toggle(A); await service.toggle(B);
  const operations=[service.capture(message(1)),service.capture(message(1)),service.capture(message(2,B)),service.export(A)];
  const results=await Promise.all(operations);
  assert.deepEqual(results.slice(0,3),[1,0,1]);
  assert.equal(results[3].text,url(1)+'\n');
  assert.deepEqual(await service.export(A),results[3]);
});

test('設定の保存失敗はONにせず、次の操作で再試行できる', async (t) => {
  let fail=true;
  const {service,state}=await setup(t,{writer:{save:async()=>{if(fail)throw new Error('disk');}}});
  await assert.rejects(service.toggle(A),/disk/);
  assert.equal(state.users[A].battleLogCapture,undefined);
  assert.equal(await service.capture(message(1)),0);
  fail=false;
  assert.equal((await service.toggle(A)).enabled,true);
});

test('途中切れのJSONLと失敗した追記を保存済みにせず、次の行を復元できる', async (t) => {
  const { filePath } = await setup(t);
  await writeFile(filePath,'{"userId":','utf8');
  const warnings=[];
  const store=await createBattleLogStore(filePath,{onWarning:(text)=>warnings.push(text)});
  const record={userId:A,uuid:uuid(1),url:url(1)};
  await store.save(record);
  assert.equal((await createBattleLogStore(filePath)).list(A).length,1);
  assert.equal(warnings.length,1);
  let fail=true;
  const failing=await createBattleLogStore(filePath,{append:async(p,text,encoding)=>{
    if(fail){fail=false; await appendFile(p,text.slice(0,12),encoding);throw new Error('disk');}
    await appendFile(p,text,encoding);
  }});
  await assert.rejects(failing.save({userId:A,uuid:uuid(2),url:url(2)}),/disk/);
  assert.equal(failing.list(A).length,1);
  await failing.save({userId:A,uuid:uuid(2),url:url(2)});
  const restored=await createBattleLogStore(filePath);
  assert.deepEqual(restored.list(A).map((r)=>r.uuid),[uuid(1),uuid(2)]);
});

test('gxbl入力だけを既存ログ対象へ足し、似た一般文字列には反応しない', () => {
  const config={channelIds:['channel'],owoBotId:OWO};
  const base={guildId:'guild',channelId:'channel',author:{id:A,bot:false}};
  assert.equal(shouldCapture({...base,content:'gxbl'},config),true);
  assert.equal(shouldCapture({...base,content:'gxbl export'},config),true);
  assert.equal(shouldCapture({...base,content:'gxblah'},config),false);
  assert.equal(shouldCapture({...base,channelId:'other',content:'gxbl'},config),false);
});
