import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);

// Modules are trusted operator code, configured locally; models cannot choose paths.
export function withExtensions(base,scope){
 const file=process.env.REIYOH_TOOLS_MODULE;
 if(!file)return base;
 const context=Object.freeze({...scope,channelIds:Object.freeze([...scope.channelIds])});
 const extension=require(path.resolve(file)).createTools(context);
 const names=new Set(base.definitions.map(d=>d.function.name));
 for(const d of extension.definitions){
  if(d.type!=='function'||!/^\w{1,64}$/.test(d.function?.name)||names.has(d.function.name))throw Error('Invalid or duplicate extension tool');
  names.add(d.function.name);
 }
 const extra=new Set(extension.definitions.map(d=>d.function.name));
 return {definitions:[...base.definitions,...extension.definitions],invoke(name,args){
  return extra.has(name)?extension.invoke(name,args):base.invoke(name,args);
 }};
}
