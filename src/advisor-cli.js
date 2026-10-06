import {loadEnvFile} from 'node:process';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {createAdvisorTools} from './advisor-tools.js';
import {withExtensions} from './extensions.js';
import {compactAdvisorTools} from './compact-advisor-tools.js';
import {runAdvisor} from './advisor-client.js';

// Host-selected scope: node src/advisor-cli.js GUILD USER CHANNEL "QUESTION"
const [guildId,userId,channelId,prompt]=process.argv.slice(2);
let local;
try {
  const envFile=path.resolve(process.env.REIYO_ENV_FILE||'.env');
  if(existsSync(envFile))loadEnvFile(envFile);
  local=createAdvisorTools({dbPath:path.join(path.dirname(path.resolve(process.env.STATE_PATH||'data/state.json')),'observations.sqlite'),guildId,userId,channelIds:[channelId]});
  const tools=withExtensions(compactAdvisorTools(local),{guildId,userId,channelIds:[channelId],visibility:'private'});
  const result=await runAdvisor({apiKey:process.env.OPENROUTER_KEY,tools,prompt,onTool:t=>console.log(`tool: ${t.name} (${t.ok?'ok':'error'})`)});
  mkdirSync('data/advisor-runs',{recursive:true});
  const file=path.resolve('data/advisor-runs',`${Date.now()}.json`);
  writeFileSync(file,JSON.stringify({at:new Date().toISOString(),scope:{guildId,userId,channelId},prompt,...result},null,2));
  console.log(result.answer);
  console.log(JSON.stringify({file,requests:result.usage.length,costUSD:result.usage.reduce((n,u)=>n+(u?.cost??0),0)}));
} catch(error) { console.error(error.message);process.exitCode=1; }
finally { local?.close(); }
