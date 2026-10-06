import path from 'node:path';
import {createAdvisorTools} from './advisor-tools.js';
import {petsPayload,battlePayload} from './display.js';

export async function handlePetPage(interaction,config,botId,makeTools=createAdvisorTools){
  const match=interaction.customId.match(/^(pets|battle):(\d{17,20}):(?:(prev|next|page):)?(\d{1,4})$/);
  const reject=content=>interaction.reply({content,flags:64,allowedMentions:{parse:[]}});
  if(!match||interaction.guildId!==config.guildId||interaction.message.author.id!==botId)return reject('この一覧を再表示してください。');
  if(interaction.user.id!==match[2])return reject('自分の一覧は `gx pets` / `gx battle` で表示できます。');
  if(!config.channelIds.includes(interaction.channelId))return reject('このチャンネルの収集設定を確認してください。');
  await interaction.deferUpdate();
  let tools;
  try{
    tools=makeTools({dbPath:path.join(path.dirname(config.statePath),'observations.sqlite'),guildId:interaction.guildId,userId:interaction.user.id,channelIds:[interaction.channelId],includePersonalKnowledge:false});
    await interaction.editReply(match[1]==='pets'?petsPayload(tools.invoke('get_pet_roster'),Number(match[4]),interaction.user.id):battlePayload(tools.invoke('get_battle_summary'),Number(match[4]),interaction.user.id));
  }catch{
    await interaction.followUp({content:'一覧の取得に失敗しました。もう一度ボタンを押してください。',flags:64,allowedMentions:{parse:[]}});
  }finally{tools?.close();}
}
