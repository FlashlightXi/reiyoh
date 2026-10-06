// A fictional arithmetic example. Supply your own validated mechanics privately.
exports.createTools = scope => ({
 definitions:[{type:'function',function:{name:'example_resource_balance',description:'架空の1周期あたり消費と補給の差を計算する。',parameters:{type:'object',properties:{cost:{type:'number',minimum:0,maximum:10000},refill:{type:'number',minimum:0,maximum:10000}},required:['cost','refill'],additionalProperties:false}}}],
 invoke(name,args){
  if(name!=='example_resource_balance'||!args||Object.keys(args).some(k=>!['cost','refill'].includes(k))||!['cost','refill'].every(k=>Number.isFinite(args[k])&&args[k]>=0&&args[k]<=10000))throw Error('Invalid arguments');
  return {example:true,netPerCycle:args.refill-args.cost,conditions:'入力値を用いた単純な差分。実ゲームの効果は運用者が検証する。'};
 }
});
