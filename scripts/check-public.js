import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const errors=[];
const fixtureIds=new Set(["700000000000000000", "700000000000000001", "700000000000000002", "700000000000000003", "700000000000000004", "700000000000000005", "700000000000000006", "700000000000000007", "700000000000000008", "700000000000000009", "700000000000000010"]);
for(const file of files){
 if(!/^(?:src\/[^/]+\.js|test\/.+\.(?:js|json)|assets\/ui\/[^/]+\.(?:svg|png)|prompts\/advisor\.md|examples\/(?:knowledge\.json|tools\.cjs)|scripts\/check-public\.js|\.github\/workflows\/ci\.yml|README\.md|LICENSE|\.gitignore|\.env\.example|package(?:-lock)?\.json)$/.test(file))errors.push(`${file}: outside publication allowlist`);
 if(file.endsWith('.png'))continue;
 const text=readFileSync(file,'utf8');
 if(/(?:sk-or-v1-|gh[pousr]_)[A-Za-z0-9_-]{15,}/.test(text))errors.push(`${file}: credential-like value`);
 if(/C:[\\/]Users[\\/]|\/Users\//.test(text))errors.push(`${file}: local user path`);
 for(const id of text.match(/\b\d{17,20}\b/g)??[]){
  if(id!=='408785106942164992'&&!/^([1-9])\1+$/.test(id)&&!fixtureIds.has(id)&&!/^1234567890123456\d{0,2}$/.test(id))errors.push(`${file}: non-fixture identifier`);
 }
}
if(!files.length)errors.push('No tracked files');
if(errors.length){console.error([...new Set(errors)].join('\n'));process.exitCode=1;}
else console.log(`Publication allowlist passed: ${files.length} files`);
