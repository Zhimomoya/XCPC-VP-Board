/* Cooperative replay must produce exactly the synchronous scoring result. */
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('static/app.js','utf8').split('function problemOrder')[0];
let time=0,yields=0,onYield=()=>{};
const context={Date,Map,Set,Intl,URL,AbortController,performance:{now:()=>++time},scheduler:{yield:async()=>{yields++;onYield()}},setTimeout,clearTimeout};
vm.createContext(context);vm.runInContext(source+';globalThis.fixture={compute,normalize,responsiveStandings,computeCooperatively};',context);
const api=context.fixture;
const config={contest_name:'Responsive replay',start_time:0,end_time:18000,frozen_time:3600,problems:Array.from({length:12},(_,id)=>({id:String(id),label:String.fromCharCode(65+id)})),medal:false};
const team=Array.from({length:600},(_,id)=>({id:String(id),name:'Team '+id,group:id%7?['official']:['unofficial']}));
const run=Array.from({length:24000},(_,id)=>({id:String(id),team_id:String(id%600),problem_id:String(Math.floor(id/600)%12),timestamp:id%17999,status:id%3?'correct':'incorrect'}));
const data=api.normalize({config,team,run},'fixture');
const own=[{id:'own',problem:'A',status:'correct',contest_time_seconds:15,submitted_at_ms:15000}];
const summarize=result=>JSON.stringify({...result,ordered:result.ordered.map(row=>({...row,states:[...row.states]})),visible:[...result.visible],firstSolve:[...result.firstSolve]});
(async()=>{
  for(const mode of ['icpc','ccpc'])for(const revealed of [false,true])for(const elapsed of [0,9000,14500,18000]){
    const session={session_id:mode+'-'+revealed,mode,scenario:'original',own_name:'VP',start_at_ms:0,...(revealed?{revealed_at_ms:1}:{})};
    const expected=api.compute(data,data.runs,own,session,elapsed,false,true);
    const actual=await api.responsiveStandings(data,data.runs,own,session,elapsed,()=>true);
    assert.equal(summarize(actual.result),summarize(expected),mode+' t='+elapsed);
  }
  assert(yields>0,'large replay never yielded to the browser');
  let visible=true;onYield=()=>{visible=false};
  assert.equal(await api.computeCooperatively(data,data.runs,own,{mode:'icpc'},18000,()=>visible),null,'a hidden or superseded view kept replaying');
  onYield=()=>{};
  const session={session_id:'recovered',mode:'icpc',own_name:'VP',start_at_ms:0};
  const recovered=await api.responsiveStandings(data,data.runs,own,session,15000,()=>true);
  assert.equal(summarize(recovered.result),summarize(api.compute(data,data.runs,own,session,15000,false,true)));
  console.log('PASS: cooperative and synchronous scoring match for ICPC/CCPC, freeze/reveal/end, own submissions, cancellation and recovery; browser tasks receive time slices.');
})().catch(error=>{console.error(error);process.exitCode=1});
