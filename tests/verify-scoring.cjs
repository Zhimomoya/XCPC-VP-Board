const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('static/app.js', 'utf8');
const setup = source.slice(0, source.indexOf("$('catalogSearch').oninput"));
const context = {};
vm.runInNewContext(setup + '\nglobalThis.test = {compute, adjustedRuns, projectedOfficialRank, submissionContestTime, contestMinute, formatClock, cellHtml, medal, medalKind, problemBadgeColors, problemAwardTiers, boardRefreshInterval, buildContestAnalysis, catalogGroupKey, catalogGroupLabel, inferredSeasonYear};', context);

const data = {
  duration: 18000, penalty: 1200, config: {frozen_time: 3600},
  problems: [{id: 'A', label: 'A'}],
  teams: ['a', 'b', 'c', 'd'].map(id => ({id, name: id, organization: '', group: [], sortorder: 0})),
};
const runs = [
  {id: '1', team: 'd', problem: 'A', time: 30, status: 'correct'},
  {id: '2', team: 'a', problem: 'A', time: 59.9, status: 'correct'},
  {id: '3', team: 'b', problem: 'A', time: 60, status: 'correct'},
  {id: '4', team: 'c', problem: 'A', time: 119, status: 'incorrect'},
  {id: '5', team: 'c', problem: 'A', time: 179, status: 'correct'},
];
const session = {mode: 'icpc', own_name: 'VP', start_at_ms: 0};
const result = context.test.compute(data, runs, [], session, 300);
const order = result.ordered.slice(0, 4).map(row => row.id).join(',');
const penalties = Object.fromEntries(result.ordered.map(row => [row.id, row.penalty]));
if (order !== 'd,a,b,c' || JSON.stringify([penalties.d, penalties.a, penalties.b, penalties.c]) !== '[0,0,1,22]') {
  throw Error(`minute scoring or second-resolution tie-break failed: ${order} ${JSON.stringify(penalties)}`);
}
if (context.test.contestMinute(59.9) !== 0 || context.test.contestMinute(60) !== 1 || context.test.formatClock(3599) !== '00:59') {
  throw Error('display minute boundary failed');
}
const cell = context.test.cellHtml(result.ordered.find(row => row.id === 'c'), data.problems[0], result.firstSolve);
if (!cell.includes('<b>2</b>') || !cell.includes('2 tries')) throw Error(`cell display failed: ${cell}`);
const early = context.test.compute(data, runs, [], session, 59.95);
if (early.ordered.find(row => row.id === 'b').solved !== 0) throw Error('second-resolution replay failed');
const ignored = context.test.compute(data, [], [{id:'ce',problem:'A',submitted_at_ms:30_000,judged_at_ms:31_000,status:'compile_error'}], session, 60);
if(ignored.ordered.find(row=>row.id==='__vp_team__').states.has('A'))throw Error('compile error created a scoreboard cell or penalty');
for(const status of ['too_late','sending','awaiting_sync','send_uncertain','send_failed']){
  const board=context.test.compute(data,[],[{id:status,problem:'A',contest_time_seconds:30,submitted_at_ms:30000,judged_at_ms:31000,status,from_submit:true}],session,60,true);
  const own=board.ordered.find(row=>row.id==='__vp_team__');
  if(own.solved!==0||own.penalty!==0||own.states.has('A')||board.firstSolve.has('A'))throw Error(`submit receipt ${status} affected score, attempts or first solve`);
}
if(context.test.problemBadgeColors('#072d8c').foreground!=='#ffffff'||context.test.problemBadgeColors('#ffff00').foreground!=='#000000')throw Error('DOMjudge badge contrast selection failed');
const clockMismatch=context.test.compute(data,[],[{id:'edge',problem:'A',contest_time_seconds:17999,submitted_at_ms:18005_000,judged_at_ms:18006_000,status:'correct'}],session,18010,true);
if(clockMismatch.ordered.find(row=>row.id==='__vp_team__').solved!==1)throw Error('QOJ contest-relative time did not override a late local wall clock');
const afterAccepted=context.test.compute(data,[],[
  {id:'ce-before',problem:'A',contest_time_seconds:10,submitted_at_ms:10_000,judged_at_ms:11_000,status:'compile_error'},
  {id:'ml-before',problem:'A',contest_time_seconds:20,submitted_at_ms:20_000,judged_at_ms:21_000,status:'memory_limit'},
  {id:'first-ac',problem:'A',contest_time_seconds:30,submitted_at_ms:30_000,judged_at_ms:31_000,status:'correct'},
  {id:'wa-after',problem:'A',contest_time_seconds:40,submitted_at_ms:40_000,judged_at_ms:41_000,status:'wrong_answer'},
  {id:'ac-after',problem:'A',contest_time_seconds:50,submitted_at_ms:50_000,judged_at_ms:51_000,status:'correct'},
],session,60,true);
const afterAcceptedRow=afterAccepted.ordered.find(row=>row.id==='__vp_team__'),afterAcceptedCell=afterAcceptedRow.states.get('A');
if(afterAcceptedRow.solved!==1||afterAcceptedRow.penalty!==20||afterAcceptedCell.attempts!==1||afterAcceptedCell.accepted!==30)throw Error('submissions after first accepted changed score, penalty, attempts, or accepted time');
if(!context.test.cellHtml(afterAcceptedRow,data.problems[0],afterAccepted.firstSolve).includes('2 tries'))throw Error('first accepted cell did not exclude post-accept submissions');
const unsolved=context.test.compute(data,[],[{id:'only-wa',problem:'A',contest_time_seconds:15,submitted_at_ms:15_000,judged_at_ms:16_000,status:'time_limit'}],session,60,true);
const unsolvedRow=unsolved.ordered.find(row=>row.id==='__vp_team__');
if(unsolvedRow.penalty!==0||unsolvedRow.states.get('A')?.attempts!==1)throw Error('unsolved wrong attempt incorrectly added total penalty');
const atEnd=context.test.compute(data,[],[{id:'at-end',problem:'A',contest_time_seconds:data.duration,submitted_at_ms:data.duration*1000,judged_at_ms:data.duration*1000,status:'correct'}],session,data.duration,true);
if(atEnd.ordered.find(row=>row.id==='__vp_team__').solved!==0)throw Error('submission at the exact contest end was accepted');
const projectedRows=[
  {id:'better-solve',solved:3,penalty:500,starred:false},
  {id:'better-penalty',solved:2,penalty:90,starred:false},
  {id:'same-score',solved:2,penalty:100,starred:false},
  {id:'worse',solved:2,penalty:110,starred:false},
  {id:'star',solved:9,penalty:0,starred:true},
  {id:'__vp_team__',solved:2,penalty:100,starred:true},
];
if(context.test.projectedOfficialRank(projectedRows,projectedRows.at(-1))!==3)throw Error('projected official rank did not use the best equal-score position');
console.log('minute scoring, minute display, second-resolution replay and tie-break OK');

const analysisData={duration:7200,penalty:1200,config:{frozen_time:3600},problems:[{id:'A',label:'A'},{id:'B',label:'B'}],teams:[
  {id:'a',name:'a',organization:'',group:['official'],sortorder:0},
  {id:'b',name:'b',organization:'',group:['official'],sortorder:0},
  {id:'c',name:'c',organization:'',group:['official'],sortorder:0},
]};
const analysisRuns=[
  {id:'a1',team:'a',problem:'A',time:600,status:'correct'},{id:'b1',team:'b',problem:'A',time:1200,status:'correct'},
  {id:'c0',team:'c',problem:'A',time:300,status:'incorrect'},{id:'c1',team:'c',problem:'A',time:1500,status:'correct'},
  {id:'a2',team:'a',problem:'B',time:2400,status:'correct'},
];
const analysisSubmissions=[
  {id:'own-wa',problem:'A',contest_time_seconds:900,submitted_at_ms:900000,judged_at_ms:999999999,status:'wrong_answer'},
  {id:'own-ac',problem:'A',contest_time_seconds:1800,submitted_at_ms:1800000,judged_at_ms:999999999,status:'correct'},
];
const analysis=context.test.buildContestAnalysis(analysisData,analysisRuns,analysisSubmissions,{...session,revealed_at_ms:1});
if(analysis.finalRank!==4||analysis.own.solved!==1||analysis.own.penalty!==50)throw Error(`analysis final score mismatch: ${analysis.finalRank} ${analysis.own.solved}/${analysis.own.penalty}`);
if(analysis.sameStats.count!==2||analysis.sameStats.medianPenalty!==32.5||analysis.moreStats.count!==1)throw Error('same-solved or one-more cohort statistics failed');
if(analysis.countedWrong!==1||analysis.wrongPenalty!==20||analysis.whatIf.oneLessWrong!==3)throw Error('penalty decomposition or counterfactual rank failed');
const tierData={config:{medal:{official:{gold:2,silver:1,bronze:1}}}},tierFormal=[5,4,3,2,1].map((solved,index)=>({id:`tier-${index}`,name:`tier-${index}`,group:['official'],sortorder:0,solved,penalty:index,lastAccepted:index,states:new Map(Array.from({length:solved},(_,problem)=>[String(problem),{accepted:60}]))})),tierProblems=[5,4,3,2,1].map((solved,index)=>({problem:{id:String(index)},allDistribution:{solved,rate:solved/5}})),tiers=context.test.problemAwardTiers(tierData,tierFormal,tierProblems);
if(tiers.get('0')?.tier!=='bronze'||tiers.get('2')?.tier!=='silver'||tiers.get('3')?.tier!=='gold'||tiers.get('4')?.tier!=='gold'||tiers.get('0')?.cohortStats.gold.medianSolved!==4.5||context.test.problemAwardTiers({config:{medal:{}}},tierFormal,tierProblems).size!==0)throw Error('problem award-tier inference failed');
const tiedProblems=[5,4,4,3,2].map((solved,index)=>({problem:{id:`tie-${index}`},allDistribution:{solved,rate:solved/5}})),tiedFormal=tierFormal.map((row,index)=>{const states=new Map(tiedProblems.filter(item=>index<item.allDistribution.solved).map(item=>[item.problem.id,{accepted:60}]));return{...row,states,solved:states.size}}),tiedTiers=context.test.problemAwardTiers(tierData,tiedFormal,tiedProblems);
if(tiedTiers.get('tie-1')?.difficultyRank!==tiedTiers.get('tie-2')?.difficultyRank||tiedTiers.get('tie-1')?.tier!==tiedTiers.get('tie-2')?.tier)throw Error('problems with equal solver counts did not share the same difficulty rank and tier');
if(analysis.trajectory.at(-1).rank!==4||analysis.markers.length!==2||analysis.gapProblems[0]?.problem.id!=='B')throw Error('rank trajectory, submission markers, or gap-problem detection failed');
const problemA=analysis.problemStats.find(item=>item.problem.id==='A');
if(problemA.allDistribution.total!==3||problemA.allDistribution.solved!==3||problemA.allDistribution.medianTime!==20||problemA.allDistribution.q1Time!==15||problemA.allDistribution.q3Time!==22.5||problemA.sameDistribution.total!==2||problemA.firstSolve?.time!==600||problemA.ownSubmissionCounts.incorrect!==1||problemA.ownSubmissionCounts.correct!==1)throw Error('per-problem cohort distribution, first solve, or own submission breakdown failed');
const oneSolvedFinal=analysis.cohortTrajectories[1]?.at(-1);
if(!analysis.cohortSolvedOptions.includes(2)||analysis.cohortTrajectories[2]?.[0]?.count!==1||analysis.cohortTrajectories[1]?.some(point=>point.count!==2)||oneSolvedFinal?.count!==2||oneSolvedFinal.min!==2||oneSolvedFinal.q1!==2.25||oneSolvedFinal.median!==2.5||oneSolvedFinal.q3!==2.75||oneSolvedFinal.max!==3)throw Error('final solved-count cohort rank distribution failed');
console.log('post-contest analysis cohorts, trajectory, penalty and gap detection OK');

const largeAnalysisData={duration:18000,penalty:1200,config:{frozen_time:3600},problems:Array.from({length:13},(_,i)=>({id:String(i),label:String.fromCharCode(65+i)})),teams:Array.from({length:2000},(_,i)=>({id:`large-${i}`,name:`large-${i}`,organization:'',group:['official'],sortorder:0}))};
const largeAnalysisRuns=[];
for(let i=0;i<largeAnalysisData.teams.length;i++)for(let problem=0;problem<Math.min(7,i%9);problem++)largeAnalysisRuns.push({id:`${i}-${problem}`,team:`large-${i}`,problem:String(problem),time:60+i+problem*600,status:'correct'});
largeAnalysisRuns.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
const largeStarted=Date.now();
const largeAnalysis=context.test.buildContestAnalysis(largeAnalysisData,largeAnalysisRuns,analysisSubmissions,{...session,revealed_at_ms:1});
const largeElapsed=Date.now()-largeStarted;
if(largeAnalysis.formal.length!==2000||largeAnalysis.trajectory.length<80||largeElapsed>3000)throw Error(`large analysis is incomplete or too slow: ${largeElapsed}ms`);
console.log(`post-contest analysis scales to 2000 teams in ${largeElapsed}ms`);

const thawData={
  duration:300,penalty:1200,config:{frozen_time:60,medal:{official:{gold:1,silver:1,bronze:0}}},
  problems:[{id:'A',label:'A'},{id:'B',label:'B'}],
  teams:[
    {id:'star',name:'star',organization:'',group:['unofficial'],sortorder:0},
    {id:'official1',name:'official1',organization:'',group:['official'],sortorder:0},
    {id:'official2',name:'official2',organization:'',group:['official'],sortorder:0},
  ],
};
const thawRuns=[
  {id:'s',team:'star',problem:'B',time:10,status:'correct'},
  {id:'o1',team:'official1',problem:'A',time:245,status:'correct'},
  {id:'o2',team:'official2',problem:'A',time:260,status:'correct'},
];
const ccpc={mode:'ccpc',own_name:'VP',start_at_ms:0};
const frozen=context.test.compute(thawData,thawRuns,[],ccpc,299);
if(frozen.ordered.find(r=>r.id==='official1').solved!==0||frozen.firstSolve.has('A'))throw Error('CCPC freeze leaked post-freeze solve');
const stillFrozen=context.test.compute(thawData,thawRuns,[],ccpc,300);
if(stillFrozen.firstSolve.has('A')||stillFrozen.ordered.find(r=>r.id==='official1').solved!==0)throw Error('contest end exposed frozen first solve before release');
const thawed=context.test.compute(thawData,thawRuns,[],{...ccpc,revealed_at_ms:1},300);
const winner=thawed.ordered.find(r=>r.id==='official1');
if(winner.solved!==1||thawed.firstSolve.get('A')!=='official1'||!context.test.cellHtml(winner,thawData.problems[0],thawed.firstSolve).includes('first'))throw Error('CCPC thaw/first-solve failed');
if(winner.medalRank!==1||!context.test.medal(thawData,winner).includes('gold')||thawed.ordered.find(r=>r.id==='star').rankLabel!=='*'||thawed.ordered.find(r=>r.id==='__vp_team__').medalRank!==null)throw Error('starred team occupied a medal place');
const cutoffData={config:{medal:{official:{gold:30,silver:60,bronze:90},vocation:{gold:1,silver:0,bronze:2}}}};
for(const [rank,expected] of [[1,'gold'],[30,'gold'],[31,'silver'],[60,'silver'],[90,'silver'],[91,'bronze'],[180,'bronze'],[181,null],[0,null],[-1,null],[null,null],[1.5,null]]){
  if(context.test.medalKind(cutoffData,'official',rank)!==expected)throw Error(`per-tier medal count boundary failed at rank ${rank}`);
}
if(context.test.medalKind(cutoffData,'vocation',1)!=='gold'||context.test.medalKind(cutoffData,'vocation',2)!=='bronze'||context.test.medalKind(cutoffData,'vocation',3)!=='bronze'||context.test.medalKind(cutoffData,'vocation',4)!==null||context.test.medalKind({config:{medal:{official:{gold:0,silver:0,bronze:0}}}},'official',1)!==null)throw Error('zero medal quotas or independent medal groups failed');
const countTierData={config:{medal:{official:{gold:1,silver:2,bronze:1}}}},countTiers=context.test.problemAwardTiers(countTierData,tierFormal,tierProblems);
if(countTiers.get('0')?.lines.gold!==5||countTiers.get('0')?.lines.silver!==4||countTiers.get('0')?.lines.bronze!==2)throw Error('analysis medal groups did not accumulate per-tier quotas before computing typical solves');
const noBronzeTiers=context.test.problemAwardTiers({config:{medal:{official:{gold:1,silver:1,bronze:0}}}},tierFormal,tierProblems);
if([...noBronzeTiers.values()].some(info=>info?.tier==='bronze'))throw Error('analysis inferred bronze questions with no bronze quota');
console.log('CCPC thaw, first solve, starred team and medal eligibility OK');

const mixedGroups={...thawData,teams:[
  {id:'general',name:'general',group:['official'],sortorder:0},
  {id:'vocational',name:'vocational',group:['official','vocation'],sortorder:0},
  {id:'unofficial',name:'unofficial',group:['unofficial'],sortorder:0},
]};
const mixed=context.test.compute(mixedGroups,[
  {id:'1',team:'general',problem:'A',time:10,status:'correct'},
  {id:'2',team:'vocational',problem:'A',time:20,status:'correct'},
],[],ccpc,100);
if(mixed.ordered.find(r=>r.id==='general').rankLabel!=='1'||mixed.ordered.find(r=>r.id==='vocational').rankLabel!=='2'||mixed.ordered.find(r=>r.id==='vocational').medalRank!==1)throw Error('global displayed rank or separate vocational medal rank failed');
const thresholdData={...thawData,duration:7200,config:{frozen_time:3600},teams:Array.from({length:99},(_,i)=>({id:`threshold${i}`,name:`threshold${i}`,organization:'',group:['official'],sortorder:0}))};
const thresholdBoard=context.test.compute(thresholdData,[],[],ccpc,100);
if(thresholdBoard.threshold!==19)throw Error(`VP team changed the CCPC problem-release threshold: ${thresholdBoard.threshold}`);

const liveData={...thawData,duration:7200,config:{frozen_time:3600},teams:[]};
const ownSubmissions=[
  {id:'a',problem:'A',submitted_at_ms:3500_000,judged_at_ms:3505_000,status:'correct'},
  {id:'b',problem:'B',submitted_at_ms:3613_000,judged_at_ms:3616_000,status:'correct'},
];
const publicBoard=context.test.compute(liveData,[],ownSubmissions,ccpc,3900);
const ownBoard=context.test.compute(liveData,[],ownSubmissions,ccpc,3900,true);
if(publicBoard.ordered.find(r=>r.id==='__vp_team__').solved!==1||ownBoard.ordered.find(r=>r.id==='__vp_team__').solved!==2)throw Error('own live result did not bypass public freeze');
const submitOrderData={...thawData,teams:[{id:'official',name:'official',organization:'',group:['official'],sortorder:0}]};
const submitOrderRuns=[{id:'official-later',team:'official',problem:'A',time:250,status:'correct'}];
const delayedOwn=[{id:'own-earlier',problem:'A',contest_time_seconds:245,submitted_at_ms:245000,judged_at_ms:290000,status:'correct'}];
const beforeVerdict=context.test.compute(submitOrderData,submitOrderRuns,delayedOwn,{...ccpc,revealed_at_ms:1},270);
if(beforeVerdict.firstSolve.get('A')!=='official')throw Error('unavailable verdict was treated as an accepted result');
const afterVerdict=context.test.compute(submitOrderData,submitOrderRuns,delayedOwn,{...ccpc,revealed_at_ms:1},300);
if(afterVerdict.firstSolve.get('A')!=='__vp_team__')throw Error('first solve used verdict arrival order instead of submission time');
const beforeFreezeDelayed=[{id:'before-freeze',problem:'A',contest_time_seconds:3599,submitted_at_ms:3599000,judged_at_ms:3700000,status:'correct'}];
const pendingAtFreeze=context.test.compute(liveData,[],beforeFreezeDelayed,ccpc,3650);
const resolvedDuringFreeze=context.test.compute(liveData,[],beforeFreezeDelayed,ccpc,3750);
if(pendingAtFreeze.ordered.find(r=>r.id==='__vp_team__').states.get('A')?.pending!==1||resolvedDuringFreeze.ordered.find(r=>r.id==='__vp_team__').solved!==1)throw Error('pre-freeze submission did not update after its verdict arrived during freeze');
console.log('continuous public ranks, separate medal groups and own live results during freeze OK');

const scenarioTeams=Array.from({length:80},(_,i)=>({id:`t${i}`,name:`t${i}`,organization:'',group:['official'],sortorder:0}));
const scenarioRuns=[];
for(let i=0;i<scenarioTeams.length;i++){
  scenarioRuns.push({id:`w${i}`,team:`t${i}`,problem:'A',time:10+i,status:'incorrect'});
  scenarioRuns.push({id:`a${i}`,team:`t${i}`,problem:'A',time:900+i*2,status:'correct'});
}
scenarioRuns.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
const scenarioData={duration:7200,penalty:1200,config:{contest_name:'scenario-test',frozen_time:3600},problems:[{id:'A',label:'A'}],teams:scenarioTeams,runs:scenarioRuns};
const sourceSnapshot=JSON.stringify(scenarioRuns);
const adjusted=context.test.adjustedRuns(scenarioData);
const repeated=context.test.adjustedRuns(scenarioData);
if(JSON.stringify(adjusted)!==JSON.stringify(repeated))throw Error('adjusted scenario is not deterministic');
if(JSON.stringify(scenarioRuns)!==sourceSnapshot)throw Error('adjusted scenario mutated source runs');
const shiftedIds=new Set(adjusted.filter(run=>scenarioRuns.find(original=>original.id===run.id)?.time!==run.time).map(run=>run.id));
if(!shiftedIds.size)throw Error('adjusted scenario did not shift any eligible team-problem sequence');
if([...shiftedIds].some(id=>id==='w0'||id==='w1'||id==='w2'))throw Error('pre-signal openings were shifted');
const originalScenario=context.test.compute(scenarioData,scenarioRuns,[],session,scenarioData.duration,true);
const adjustedScenario=context.test.compute(scenarioData,adjusted,[],session,scenarioData.duration,true);
if(!adjustedScenario.ordered.some(row=>{
  const original=originalScenario.ordered.find(candidate=>candidate.id===row.id);
  return original&&row.penalty!==original.penalty;
}))throw Error('adjusted scenario was forced back to original outcomes');

const lateTeams=Array.from({length:230},(_,i)=>({id:`late${i}`,name:`late${i}`,organization:'',group:['official'],sortorder:0}));
const lateRuns=[];
for(let i=0;i<30;i++){
  lateRuns.push({id:`signal${i}`,team:`late${i}`,problem:'A',time:10+i,status:'incorrect'});
  lateRuns.push({id:`base${i}`,team:`late${i}`,problem:'B',time:100+i,status:'correct'});
}
for(let i=30;i<lateTeams.length;i++)lateRuns.push({id:`edge${i}`,team:`late${i}`,problem:'A',time:7195,status:'correct'});
lateRuns.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
const lateData={duration:7200,penalty:1200,config:{contest_name:'late-edge-test',frozen_time:3600},problems:[{id:'A',label:'A'},{id:'B',label:'B'}],teams:lateTeams,runs:lateRuns};
const lateAdjusted=context.test.adjustedRuns(lateData),lateAdjustedIds=new Set(lateAdjusted.map(run=>run.id));
if(!lateRuns.some(run=>run.status==='correct'&&!lateAdjustedIds.has(run.id)))throw Error('late accepted runs were implicitly preserved');
const lateOriginalBoard=context.test.compute(lateData,lateRuns,[],session,lateData.duration,true),lateAdjustedBoard=context.test.compute(lateData,lateAdjusted,[],session,lateData.duration,true);
if(!lateAdjustedBoard.ordered.some(row=>row.id!=='__vp_team__'&&row.solved<lateOriginalBoard.ordered.find(original=>original.id===row.id).solved))throw Error('scenario could not naturally change solved count');
console.log('behavior scenario is deterministic, preserves source data, excludes pre-signal teams, and can naturally change penalties or solved counts');

if(context.test.boardRefreshInterval(599)!==5000||context.test.boardRefreshInterval(600)!==7000||context.test.boardRefreshInterval(1200)!==10000)throw Error('scoreboard refresh strategy is not scaled by team count');
console.log('scoreboard refresh interval scales from regional to large online contests');

const catalogSamples=[
  {series:'icpc',season:'49th',year:2024,name:'49th',path:'icpc/49th/a'},
  {series:'icpc',season:'48th',year:2024,name:'48th',path:'icpc/48th/b'},
  {series:'icpc',season:'47th',year:2024,name:'47th',path:'icpc/47th/c'},
];
if(new Set(catalogSamples.map(item=>context.test.catalogGroupKey(item))).size!==3)throw Error('ICPC catalog still groups different seasons by event calendar year');
if(context.test.catalogGroupKey(catalogSamples[0])!=='2024'||context.test.catalogGroupKey(catalogSamples[1])!=='2023'||context.test.catalogGroupLabel('2024')!=='2024 赛季'||context.test.catalogGroupKey({series:'provincial-contest',season:'2024',year:2024})!=='2024')throw Error('catalog season-year inference or labels failed');
console.log('catalog groups every series by season year');
