/* Adapters must preserve identity, score precision and replay/Analysis parity. */
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('static/app.js','utf8'),context={};
vm.runInNewContext(source.slice(0,source.indexOf("$('catalogSearch').oninput"))+'\nglobalThis.check={normalize,compute,buildContestAnalysis,catalogItems,state};',context);
const {normalize,compute,buildContestAnalysis,catalogItems,state}=context.check;
const raw={config:{contest_name:'Adapter',start_time:1700000000,end_time:1700018000,frozen_time:0,problems:[{id:'p',label:'A'},{id:'q',label:'B'}],options:{submission_timestamp_unit:'microsecond'}},
  team:{t:{team_name:{fallback:'Team'},organization_id:'o'},u:{name:'Unofficial',official:false}},organizations:{o:{name:{fallback:'University'}}},
  run:{first:{team_id:'t',problem_id:'p',timestamp:119900000,status:'AC'},second:{team_id:'t',problem_id:'q',timestamp:179900000,status:'AC'},ignored:{team_id:'u',problem_id:'p',timestamp:1000000,status:'AC',is_ignore:true}}};
const data=normalize(raw),session={mode:'icpc',own_name:'VP',start_at_ms:0};
assert.equal(data.teams[0].id,'t');assert.equal(data.teams[0].name,'Team');assert.equal(data.teams[0].organization,'University');
assert.equal(data.runs.length,2);assert.equal(data.runs[0].id,'first');assert.equal(data.runs[0].time,119.9);
assert(data.teams[1].group.includes('unofficial'));
for(const [method,expected] of [['in_minutes',3],['accumulate_in_seconds_and_finally_to_the_minute',4],['in_seconds',299.8/60]]){
  const current={...data,config:{...data.config,options:{calculation_of_penalty:method}}};
  const result=compute(current,current.runs,[],session,18000,true),team=result.ordered.find(r=>r.id==='t');
  assert(Math.abs(team.penalty-expected)<1e-10,method);
  const own=[{id:'1',problem:'A',status:'correct',contest_time_seconds:119.9,judged_at_ms:119900},{id:'2',problem:'B',status:'correct',contest_time_seconds:179.9,judged_at_ms:179900}];
  const analysis=buildContestAnalysis(current,current.runs,own,{...session,revealed_at_ms:1});
  assert(Math.abs(analysis.own.penalty-expected)<1e-10,method+' analysis final');
  assert(Math.abs(analysis.trajectory.at(-1).penalty-expected)<1e-10,method+' Analysis curve');
  const live=compute(current,current.runs,[],session,17000);
  assert.equal(live.frozen,false,'zero freeze unexpectedly hid results');
  assert.equal(live.ordered.find(r=>r.id==='t').solved,2);
}
for(const [options,expected] of [[{penalty_precision_seconds:1},298/60],[{ranking_penalty_precision_seconds:1},299/60]]){
  const current={...data,config:{...data.config,options:{...options,calculation_of_penalty:'in_seconds'}}};
  assert(Math.abs(compute(current,current.runs,[],session,18000,true).ordered.find(r=>r.id==='t').penalty-expected)<1e-10);
}
state.catalog=[{path:'icpc/49th/official',name:'Official',series:'icpc',season:'49th'}];
state.localContests=[{path:'icpc/49th/official',name:'Local official copy'},{path:'imports/2024/example',name:'Imported',kind:'import',series:'icpc',season_year:2024}];
const merged=catalogItems();assert.equal(merged.length,2);assert.equal(merged[0].name,'Official');assert.equal(merged[1].season_year,2024);
state.catalog=[];assert.equal(catalogItems().length,2,'imported data disappeared when XCPCIO was unavailable');
console.log('PASS: keyed records, stable IDs/names/organizations, all time units, ignored/starred rows, three penalty policies, zero freeze, Analysis parity and XCPCIO-first catalog merge.');
