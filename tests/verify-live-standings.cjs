/* Differential checks: cached display versus a fresh reference replay. */
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('static/app.js','utf8'),context={};
vm.runInNewContext(source.slice(0,source.indexOf("$('catalogSearch').oninput"))+'\nglobalThis.test={compute,liveStandings};',context);
const data={duration:7200,penalty:1200,config:{frozen_time:1200},problems:['A','B'].map(id=>({id,label:id})),teams:['a','b'].map(id=>({id,name:id,group:[],sortorder:0}))};
const history=[{id:'1',team:'a',problem:'A',time:60,status:'incorrect'},{id:'2',team:'a',problem:'A',time:3599,status:'correct'},{id:'3',team:'b',problem:'A',time:3600,status:'correct'},{id:'4',team:'a',problem:'B',time:6000,status:'incorrect'},{id:'5',team:'a',problem:'B',time:6001,status:'correct'},{id:'6',team:'b',problem:'B',time:7200,status:'correct'}];
const own=[{id:'11',problem:'A',status:'correct',contest_time_seconds:1000,submitted_at_ms:1000000,judged_at_ms:6100000},{id:'12',problem:'B',status:'compile_error',contest_time_seconds:3599,submitted_at_ms:3599000}];
const summarize=result=>JSON.stringify({time:result.time,freeze:result.freeze,frozen:result.frozen,visible:[...result.visible],first:[...result.firstSolve],rows:result.ordered.map(row=>({...row,states:[...row.states]}))});
for(const mode of ['icpc','ccpc'])for(const revealed of [false,true]){
  const session={session_id:mode+revealed,mode,own_name:'VP',start_at_ms:0,...(revealed?{revealed_at_ms:1}:{})};
  // Includes moving backwards, freeze/end boundaries and delayed own verdicts.
  for(const time of [0,59.9,60,1000,3599,3600,3601,5999,6000,6001,6099,6100,7199,7200,8000,3599,0]){
    const actual=context.test.liveStandings(data,history,own,session,time),expected=context.test.compute(data,history,own,session,time);
    assert.equal(summarize(actual.result),summarize(expected),`${mode} revealed=${revealed} t=${time}`);
    if(expected.frozen){
      const live=context.test.compute(data,history,own,session,time,true).ordered.find(row=>row.id==='__vp_team__');
      assert.equal(JSON.stringify({...actual.ownLive,states:[...actual.ownLive.states]}),JSON.stringify({...live,states:[...live.states]}));
    }
  }
}
const session={session_id:'stable',mode:'icpc',own_name:'VP',start_at_ms:0,revealed_at_ms:1};
const first=context.test.liveStandings(data,history,own,session,8000);
assert.equal(context.test.liveStandings(data,history,[...own],{...session},9000).revision,first.revision,'an unchanged poll discarded the standings');
own[0]={...own[0],status:'wrong_answer'};
assert.notEqual(context.test.liveStandings(data,history,own,session,9000).revision,first.revision,'a changed own verdict reused stale standings');
console.log('PASS: cached replay matches fresh scoring across ICPC/CCPC, freeze/end, delayed verdicts, reveal, rewind, unchanged polls and changed submissions.');
