import {readFileSync} from 'node:fs';
let mapping={};
try{mapping=JSON.parse(readFileSync(process.env.REIYOH_DISPLAY_EMOJIS_FILE || new URL('../data/display-emojis.json',import.meta.url),'utf8'));}catch{}
export const icon=(name)=>mapping[name]??({tool:'⚒',model:'✦',input:'↑',output:'↓',time:'◷',won:'✓',lost:'×',tie:'＝',pending:'◌'}[name]??'');
export function emojiText(text=''){
 return String(text).replace(/<a?:([\w]+):(\d+)>/g,(full,name,id)=>mapping['source_'+id]??full)
 .replace(/(?<![<\w]):(snail|dog2|sheep|mouse2|cat2|rabbit2):/g,(_,n)=>({snail:'🐌',dog2:'🐕',sheep:'🐑',mouse2:'🐁',cat2:'🐈',rabbit2:'🐇'}[n]));
}
export const textBlock=content=>({type:10,content:emojiText(content)});
export function cardPayload(blocks){return {flags:32768,components:[{type:17,components:blocks}],allowedMentions:{parse:[],repliedUser:false}};}
export const separator=()=>({type:14,divider:true,spacing:1});
export const richTime=at=>Number.isFinite(Date.parse(at))?`<t:${Math.floor(Date.parse(at)/1000)}:R>`:'時刻未確認';
export function pageButtons(kind,ownerId,page,pages){return {type:1,components:[
 {type:2,style:2,label:'前へ',custom_id:`${kind}:${ownerId}:prev:${Math.max(1,page-1)}`,disabled:page<=1},
 {type:2,style:2,label:`${page} / ${pages}`,custom_id:`${kind}:${ownerId}:page:${page}`,disabled:true},
 {type:2,style:2,label:'次へ',custom_id:`${kind}:${ownerId}:next:${Math.min(pages,page+1)}`,disabled:page>=pages}
]};}
export function battlePayload(b,page=1,ownerId){
 const pages=Math.max(1,Math.min(10,Math.ceil(b.recent.length/10)));page=Math.min(Math.max(1,page),pages);
 const count=n=>`\`${String(n).padStart(3,' ')}\``;
 const rows=b.recent.slice((page-1)*10,page*10).map((r,i)=>`${(page-1)*10+i+1}. ${icon(({won:'won',lost:'lost',tie:'tie'})[r.outcome]??'pending')} ${count(r.turns??'?')} • [メッセージ](${r.source.url}) • ${richTime(r.source.sourceAt)}`);
 const blocks=[textBlock(rows.join('\n')||'戦闘の記録を待っています。'),separator(),textBlock(`${icon('won')} ${count(b.counts.won)}　${icon('lost')} ${count(b.counts.lost)}　${icon('tie')} ${count(b.counts.tie)} • 記録 ${count(b.total??b.recent.length)}戦${b.truncated?' • 取得範囲に上限あり':''}`)];
 if(ownerId)blocks.push(pageButtons('battle',ownerId,page,pages));
 return cardPayload(blocks);
}
export function petsPayload(p,page=1,ownerId){
 const fields=p.petDetails.flatMap(r=>(r.fields??[]).map(f=>({...f,source:r.source})));
 const pages=Math.max(1,Math.ceil(fields.length/6));page=Math.min(Math.max(1,page),pages);
 const rows=fields.slice((page-1)*6,page*6).map(f=>{
 const lv=f.value.match(/Lvl\.?\s*(\d+)/i)?.[1]??'?';
 const stats=[...f.value.matchAll(/<a?:([\w]+):(\d+)>\s*`([^`]+)`/g)].map(m=>`<:${m[1]}:${m[2]}> ${m[3]}`).join('　');
 return `${f.name} **Lv${lv}**\n-# ${stats}`;
 });
 if(!rows.length)rows.push(...p.entries.slice(0,20).map(r=>`${r.species?.emojiId?`<a:${r.species.name}:${r.species.emojiId}>`:r.species?.name??'?'} **Lv${r.level??'?'}** • \`${r.weaponId??'?'}\``));
 const source=fields[0]?.source;
 const payload=cardPayload([textBlock((rows.join('\n\n')||'ペット表示の記録を待っています。').slice(0,3800)),separator(),textBlock(source?`-# [取得元](${source.url}) • ${richTime(source.sourceAt)} • ${page}/${pages}`:'-# 観測した表示範囲')]);
 if(ownerId && /^\d{17,20}$/.test(ownerId))payload.components[0].components.push(pageButtons('pets',ownerId,page,pages));
 return payload;
}
