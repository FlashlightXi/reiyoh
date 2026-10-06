import {battlePayload,petsPayload,emojiText,cardPayload,textBlock} from './display.js';
import { KINDS } from './observations.js';
import path from 'node:path';
import { createAdvisorTools } from './advisor-tools.js';

export const HELP = `**Reiyo · 情報と相談**
\`g\` — いつものタイマー
\`gai 相談内容\` — 手持ちを調べてAIに相談
\`gx team\` — 編成・装備・出典
\`gx pets\` — 観測したペット情報
\`gx battle\` — 記録した勝敗と直近の戦闘
\`gx me\` — 自分の観測記録
\`gx briefing\` — 相談用の情報を書き出す
\`gx logs\` / \`gx logs export\` — 戦闘URLの記録切替・取得
\`gx emoji\` — カウントダウン絵文字
\`gx admin\` — 収集設定・記録の診断（管理者向け）`;
const ADMIN_HELP = `**Reiyo · 管理**
\`gx collect status\` — 収集状況
\`gx collect on/off\` — このチャンネルの収集を切替
\`gx collect neonutil @Bot\` — 補助Botの登録
\`gx samples\` / \`gx samples export 種類\` — 記録の件数・書出し
\`gx inspect メッセージID\` — 編集履歴
\`gx debug\` — タイマーの診断`;

export function normalizeCommand(content = '') {
  const text=content.trim(),lower=text.toLowerCase();
  const legacy={gsetup:'gx collect on',gdisable:'gx collect off',gxbl:'gx logs','gxbl export':'gx logs export'};
  if(lower==='gx')return 'gx help';
  if(/^g!\s/.test(lower))return text.replace(/^g!\s+/i,'gx ');
  return legacy[lower]??text;
}

export function createCollectionCommands({ config, state, writer, store, client, reply, isManager }) {
  // Serialize settings changes; do not publish unpersisted settings to the collector.
  let settings = Promise.resolve();
  const saveSettings = (change) => {
    const result = settings.catch(() => {}).then(async () => {
      const previous = { channels: state.channels, observerBotIds: state.observerBotIds };
      change();
      try { await writer.save(state); }
      catch (error) { Object.assign(state, previous); await writer.save(state).catch(() => {}); throw error; }
      config.channelIds = state.channels;
      config.observerBotIds = state.observerBotIds ?? [];
    });
    settings = result;
    return result;
  };
  const counts = (message) => {
    const rows = store.summary(message.guildId, message.channelId);
    return rows.length ? rows.map(r => `${r.kind}: ${r.messages}メッセージ / ${r.revisions}版 / 所有者確認${r.attributed}版`).join('\n') : 'まだ記録がありません。';
  };
  async function sendExport(message, rows, filename) {
    if (!rows.length) return reply(message, '該当する記録はありません。未帰属の返信は管理者が `gx samples` で確認できます。');
    // Bound the Discord attachment; retain all versions locally even if this response is truncated.
    let body;
    do {
      body = JSON.stringify({ format: 'reiyo-observations-v1', note: '直近最大100版の観測記録。収集稼働中に受信した編集を保存。現在の所持・採用状態は最新の詳細表示で確認。', observations: rows }, null, 2);
      if (Buffer.byteLength(body) <= 7_000_000) break;
      rows = rows.slice(1);
    } while (rows.length);
    return message.reply({ content: `${rows.length}版を書き出しました。このチャンネルに添付します。`,
      files: [{ attachment: Buffer.from(body), name: filename }], allowedMentions: { parse: [], repliedUser: false } });
  }
  return async function handle(message, command) {
    const lower = command.toLowerCase();
    if (lower === 'gx admin') { await reply(message, ADMIN_HELP); return true; }
    if (lower === 'gx help') { await reply(message, HELP); return true; }
    if (lower === 'gx collect status') {
      await reply(message, `**Reiyo · 収集状況**\nこのチャンネル: ${config.channelIds.includes(message.channelId) ? '収集中' : '停止'}\n対象: ${config.channelIds.map(id => `<#${id}>`).join(', ') || 'なし'}\n補助Bot: ${(config.observerBotIds ?? []).map(id => `<@${id}>`).join(', ') || '未登録'}\n${counts(message)}`);
      return true;
    }
    if (/^gx pets(?: \d{1,3})?$/.test(lower) || /^gx battle(?: \d{1,2})?$/.test(lower)) {
      const tools=createAdvisorTools({dbPath:path.join(path.dirname(config.statePath),'observations.sqlite'),guildId:message.guildId,userId:message.author.id,channelIds:[message.channelId],includePersonalKnowledge:false});
      try {
        if(/^gx battle(?: \d{1,2})?$/.test(lower)){
          const b=tools.invoke('get_battle_summary');
          await message.reply(battlePayload(b,Number(lower.split(/\s+/)[2])||1,message.author.id));
        } else {
          const p=tools.invoke('get_pet_roster');
          await message.reply(petsPayload(p,Number(lower.split(/\s+/)[2])||1,message.author.id));
        }
      } finally {tools.close();}
      return true;
    }
    if (lower === 'gx team' || lower === 'gx briefing') {
      const tools=createAdvisorTools({dbPath:path.join(path.dirname(config.statePath),'observations.sqlite'),
        guildId:message.guildId,userId:message.author.id,channelIds:[message.channelId]});
      try {
        const history=tools.invoke('get_formation_history');
        if(lower==='gx team') {
          const text=history.latestDisplays.slice(-6).reverse().map(r=>
            `**${r.formation.presetPage ? 'プリセット表示 '+r.formation.presetPage : '番号不明'}**\n`+
            r.formation.slots.map(s=>`${s.position}. ${s.species?.emojiId ? `<a:${s.species.name}:${s.species.emojiId}>` : s.species?.name ?? '種別不明'} Lv${s.level ?? '?'} / ${s.weaponId ?? '装備ID未確認'}`).join('\n')+
            `\n${r.source.url}`).join('\n');
          await reply(message,`${text || 'このチャンネルに本人のteam表示の記録がまだありません。gtmで表示してください。'}\n表示履歴です。現在選択中のチームは追加確認が必要です。`.slice(0,3800));
        } else {
          const body=JSON.stringify({format:'reiyo-advisor-briefing-v1',player:tools.invoke('get_player_context'),formations:history,
            battles:tools.invoke('get_battle_summary'),knowledge:tools.invoke('search_strategy_knowledge',{query:''}).filter(card=>!card.ownerId),aiCalled:false},null,2);
          await message.reply({content:'本人の、このチャンネルで確認できる情報を書き出しました。',
            files:[{attachment:Buffer.from(body),name:'reiyo-briefing.json'}],allowedMentions:{parse:[],repliedUser:false}});
        }
      } finally { tools.close(); }
      return true;
    }
    if (/^gx (collect|samples|inspect)(?:\s|$)/i.test(command)) {
      if (!isManager(message)) { await reply(message, 'この操作には「サーバーの管理」権限が必要です。'); return true; }
      if (lower === 'gx collect on' || lower === 'gx collect off') {
        await saveSettings(() => { state.channels = lower.endsWith(' on') ? [...new Set([...state.channels, message.channelId])]
          : state.channels.filter(id => id !== message.channelId); });
        await reply(message, `${lower.endsWith(' on') ? '収集を開始しました' : '収集を停止しました'}。保存済みの記録は保持します。\n対象はOwOと登録済み補助Botの返信・編集、および関連入力です。`);
      } else if (/^gx collect neonutil\s+/.test(lower)) {
        const id = command.match(/^gx collect neonutil\s+(?:<@!?)?(\d{17,20})>?$/i)?.[1];
        if (!id || id === config.owoBotId || id === client.user.id) { await reply(message, '`gx collect neonutil @NeonUtil` で対象Botを指定してください。'); return true; }
        const member = await message.guild.members.fetch(id).catch(() => null);
        if (!member?.user.bot) { await reply(message, 'このサーバーにいるBotを指定してください。'); return true; }
        await saveSettings(() => { state.observerBotIds = [...new Set([...(state.observerBotIds ?? []),id])]; });
        await reply(message, '補助Botを登録しました。収集対象チャンネルで今後届く返信と編集を記録します。');
      } else if (lower === 'gx samples') await reply(message, counts(message));
      else if (/^gx samples export(?:\s|$)/i.test(command)) {
        const kind = lower.split(/\s+/)[3];
        if ((kind && !KINDS.includes(kind)) || lower.split(/\s+/).length > 4) await reply(message, `種類: ${KINDS.join(' / ')}`);
        else await sendExport(message, store.samples(message.guildId,message.channelId,kind), 'reiyo-samples.json');
      } else if (/^gx inspect \d{17,20}$/.test(lower)) {
        await sendExport(message, store.history(message.guildId,message.channelId,lower.split(' ')[2]), 'reiyo-history.json');
      } else await reply(message, HELP);
      return true;
    }
    if (lower === 'gx me' || lower === 'gx me export') {
      // Export only the current channel: do not disclose private-channel records via another channel.
      const rows = store.personal(message.guildId,message.author.id).filter(r => r.channel_id === message.channelId);
      if (lower.endsWith(' export')) await sendExport(message,rows,'reiyo-my-observations.json');
      else {
        const latest = rows.slice(-5).reverse();
        await reply(message, `**Reiyo · 自分の観測記録（このチャンネル）**\n${latest.map(r => `${r.kind} · <t:${Math.floor(new Date(r.source_at).getTime()/1000)}:R>\nhttps://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.message_id}`).join('\n') || '所有者を確認できた記録はまだありません。'}\n一覧の取得範囲とリロールの採用結果は、最新の詳細表示で確認できます。`);
      }
      return true;
    }
    return false;
  };
}
