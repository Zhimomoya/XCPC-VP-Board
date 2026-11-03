const $=id=>document.getElementById(id);
const state={session:null,data:null,history:null,submissions:[],submissionWindow:null,syncHealth:null,syncReadError:'',canManage:false,permissions:{home:false,analysis:false,submit:false},screen:'setup',view:'scoreboard',archiveId:null,clockStatus:null,catalog:[],localContests:[],catalogStale:false,catalogLoading:false,catalogStep:'series',browseSeries:'',browseYear:null,catalogError:'',qojObservation:null,qojContestInfo:null,qojLanguageInfo:null,debug:{enabled:false,elapsed_seconds:null}};
let waitingSince=0,waitingStarting=false,matchSessionLoading=false,scheduledSessionLoading=false,passiveSessionLoading=false;
let scrollQuietUntil=0,deferredRenderTimer=0,scoreboardIdentity='',lastBoardRenderAt=0,virtualBoardState=null,virtualScrollFrame=0,virtualTopSpacer=null,virtualBottomSpacer=null;
const scoreboardRows=new Map();
let analysisCache=null,analysisCohortSolved=null,analysisChartRange=null,analysisRankWindow=null;
let liveStandingsCache=null;
let lastStandingsView=null;
let renderFrame=0,resumeTimer=0,resumeRefresh=null,clockTickTimer=0;
const pendingReads=new Map();
const pagePolls=new Set();
const pageIsVisible=()=>typeof document==='undefined'||!document.hidden;
if(typeof window!=='undefined')window.addEventListener('scroll',()=>{
  if(!pageIsVisible())return;
  scrollQuietUntil=performance.now()+180;
  if(virtualBoardState&&!virtualScrollFrame){
    virtualScrollFrame=requestAnimationFrame(()=>{
      virtualScrollFrame=0;
      if(state.screen==='match'&&state.view==='scoreboard'&&virtualBoardState)patchScoreboardRows(virtualBoardState.rows,virtualBoardState.data,virtualBoardState.result,virtualBoardState.session,true);
    });
  }
},{passive:true,capture:true});
const ownId='__vp_team__';
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=(url,{pagePoll=false,...options}={})=>{
  const read=(options.method||'GET').toUpperCase()==='GET',shared=read&&!options.signal;
  if(shared&&pendingReads.has(url))return pendingReads.get(url);
  const request=(async()=>{
    const controller=read&&!options.signal?new AbortController():null;
    if(pagePoll&&controller)pagePolls.add(controller);
    const timeout=/^\/api\/(session|submissions|submission-sync-status|debug-time|qoj-vp-observation|qoj-contest-info)(?:\?|$)/.test(url)?8000:45000;
    const timer=controller?setTimeout(()=>controller.abort(),timeout):null;
    try{
      const response=await fetch(url,{cache:'no-store',...options,...(controller?{signal:controller.signal}:{})});
      const body=await response.json();if(!response.ok){const error=Error(body.error||response.statusText);error.status=response.status;throw error}return body;
    }catch(error){if(controller?.signal.aborted)throw Error('与主机连接超时，正在重试');throw error}
    finally{if(timer!==null)clearTimeout(timer);if(pagePoll)pagePolls.delete(controller)}
  })();
  if(shared){pendingReads.set(url,request);const clear=()=>{if(pendingReads.get(url)===request)pendingReads.delete(url)};request.then(clear,clear)}
  return request;
};
const post=(url,body,options={})=>api(url,{...options,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const matchSubmissions=(sessionId,options)=>api('/api/submissions'+(sessionId?'?session_id='+encodeURIComponent(sessionId):''),options);
const requestUuid=()=>{
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');return`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
const mayView=view=>state.canManage||Boolean(state.permissions[view]);
const maySubmit=()=>state.screen==='match'&&!state.archiveId&&mayView('submit')&&mayView('home');
const mayReadSource=()=>state.screen==='match'&&mayView('home')&&(state.canManage||!state.archiveId);
const canFetchSource=()=>mayReadSource()&&(!state.canManage||document.documentElement.dataset.xcpcSubmitBridge==='1');
const steadyNow=()=>globalThis.performance?.now?.()??Date.now();
let serverClockEpochMs=Date.now(),serverClockSteadyMs=steadyNow();
// Anchor host time to elapsed time: OS clock corrections must not move a match.
const serverNow=()=>serverClockEpochMs+(steadyNow()-serverClockSteadyMs);
async function readSession(viewerSessionId=null){
  const url=viewerSessionId?'/api/session?viewer_session_id='+encodeURIComponent(viewerSessionId):'/api/session';
  const sent=steadyNow(),response={...await api(url,{pagePoll:Boolean(viewerSessionId)})},received=steadyNow();
  if(received-sent<=8000&&response.server_time_ms!=null&&Number.isFinite(Number(response.server_time_ms))){
    serverClockEpochMs=Number(response.server_time_ms)+Math.max(0,received-sent)/2;
    serverClockSteadyMs=received;
  }
  state.clockStatus=response.clock||state.clockStatus;
  state.submissionWindow=response.submission_window?{...response.submission_window,session_id:response.session?.session_id}:null;
  const permissions=response.permissions||{home:Boolean(response.can_manage),analysis:Boolean(response.can_manage),submit:Boolean(response.can_manage)};
  response.permissionsChanged=JSON.stringify(state.permissions)!==JSON.stringify(permissions);
  state.permissions=permissions;state.canManage=Boolean(response.can_manage);
  return response;
}
const beijingDateTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const beijingTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const beijingInputParts=value=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
const formatBeijing=value=>beijingDateTime.format(new Date(value));
const formatBeijingTime=value=>beijingTime.format(new Date(value));
const contestMinute=seconds=>Math.max(0,Math.floor(seconds/60));
const formatClock=seconds=>{const minutes=contestMinute(seconds);return `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`};
const statusType=value=>{const s=String(value||'').toUpperCase();if(['CORRECT','AC','ACCEPTED'].includes(s))return'correct';if(['PENDING','JUDGING','WAITING','PREPARING','RUNNING','COMPILING','SUBMITTED','FROZEN'].includes(s))return'pending';if(['CE','COMPILE_ERROR','COMPILATION_ERROR'].includes(s))return'compile_error';if(['IGNORED','SYSTEM_ERROR','TOO_LATE','SKIPPED','CANCELED','CANCELLED','JUDGEMENT_FAILED','CONFIGURATION_ERROR','FILE_ERROR','QUEUED','SENDING','AWAITING_SYNC','SEND_UNCERTAIN','SEND_FAILED','SEND_CANCELLED'].includes(s))return'ignored';return'incorrect'};
const nameOf=value=>value&&typeof value==='object'?(value.texts?.['zh-CN']||value['zh-CN']||value.fallback||value.texts?.en||value.en||Object.values(value.texts||{})[0]||''):String(value??'');
const hash=value=>{let h=2166136261;for(const c of String(value)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0};
const sourceUrl=path=>`https://board.xcpcio.com/data/${path}/config.json`;
const compareRuns=(a,b)=>a.time-b.time||String(a.id).localeCompare(String(b.id));
const sortRuns=runs=>runs.sort(compareRuns);
const compareRows=(a,b)=>a.sortorder-b.sortorder||b.solved-a.solved||a.penalty-b.penalty||a.lastAccepted-b.lastAccepted||a.name.localeCompare(b.name);

function normalize(raw,contestPath=''){
  const config=raw.config;
  const problems=(config.problems||[]).map((p,i)=>({id:String(p.id??i),label:String(p.label??String.fromCharCode(65+i)),badge:p.balloon_color||{}}));
  const entries=value=>Array.isArray(value)?value.map((v,i)=>[String(i),v]):Object.entries(value||{});
  const organizations=new Map(entries(raw.organizations).map(([id,o])=>[String(o.id??o.organization_id??id),nameOf(o.name)]));
  const teams=entries(raw.team).map(([id,t])=>({id:String(t.id??t.team_id??id),name:nameOf(t.name??t.team_name),organization:nameOf(t.organization||organizations.get(String(t.organization_id))||t.organization_id||''),group:t.official===false||t.unofficial===true?[...(t.group||[]).filter(g=>g!=='official'),'unofficial']:t.group||[],sortorder:Number(t.sortorder||0)}));
  const divisor={second:1,millisecond:1000,microsecond:1000000,nanosecond:1000000000}[config.options?.submission_timestamp_unit]||1;
  const runs=entries(raw.run).map(([id,r])=>({id:String(r.id??r.submission_id??id),team:String(r.team_id),problem:String(r.problem_id),time:Number(r.timestamp)/divisor,status:r.is_ignore?'ignored':statusType(r.status)})).filter(r=>Number.isFinite(r.time)&&r.time>=0&&r.status!=='ignored');
  const duration=(Number(config.end_time)-Number(config.start_time))/(Number(config.start_time)>1e11?1000:1)||18000;
  const data={config,problems,teams,runs:sortRuns(runs),duration,penalty:Number(config.penalty??1200)};
  const awards=resolveMedals(data,contestPath);
  return{...data,medals:awards.counts,medalInfo:awards};
}

function medalGroupForTeam(team){
  if(team.id===ownId||team.group.includes('unofficial'))return null;
  if(team.group.includes('vocation'))return'vocation';
  return team.group.includes('official')||!team.group.length?'official':null;
}

function medalGroups(data){
  const counts=data.medals??data.config.medal;
  return counts&&typeof counts==='object'&&!Array.isArray(counts)?counts:{};
}

function resolveMedals(data,contestPath=''){
  const setting=data.config.medal;
  // Explicit per-group quotas, including zero quotas, are authoritative.
  const emptySetting=setting&&typeof setting==='object'&&!Array.isArray(setting)&&!Object.keys(setting).length;
  if(setting&&typeof setting==='object'&&!Array.isArray(setting)&&!emptySetting)return{counts:setting,source:'config'};
  const preset=typeof setting==='string'?setting.trim().toLowerCase():'';
  const knownPreset=['ccpc','icpc'].includes(preset);
  if(setting===false||setting===0||['none','off','disabled'].includes(preset))return{counts:{},source:'none'};
  if(setting!=null&&setting!==''&&!emptySetting&&!knownPreset)return{counts:{},source:'unsupported'};
  const identity=(contestPath+' '+nameOf(data.config.contest_name)).toLowerCase();
  const series=contestPath.split('/')[0].toLowerCase();
  const logo=String(data.config.logo?.preset||'').toLowerCase();
  const rule=knownPreset?preset:series==='ccpc'||logo==='ccpc'||/\bccpc\b|中国大学生程序设计竞赛/.test(identity)?'ccpc':series==='icpc'||logo==='icpc'||/\bicpc\b|国际大学生程序设计竞赛/.test(identity)?'icpc':['provincial-contest','invitational'].includes(series)?'regional':null;
  // Qualifiers and practice contests do not imply medal awards. Finals can
  // use school ranks or fixed quotas, which cannot be inferred from a ratio.
  if(!knownPreset&&(!rule||/warm[\s_-]*up|practice|training|online|qualification|qualifier|\bfinals?\b|(?:^|\/)ecfinal(?:\/|\s|$)|热身|练习|训练|网络|预选|总决赛/.test(identity)))return{counts:{},source:'none'};
  const rawStart=Number(data.config.start_time),startMs=rawStart>1e11?rawStart:rawStart*1000;
  // xcpcio's historical ccpc preset counts solved teams. For missing 2026+
  // CCPC settings use the rule effective from 2026-03-01 (any submission).
  const basis=!knownPreset&&rule==='ccpc'&&startMs>=Date.UTC(2026,1,28,16)?'submitted':'solved';
  const problems=new Set(data.problems.map(problem=>problem.id));
  const activeTeams=new Set(data.runs.filter(run=>run.time>=0&&run.time<data.duration&&problems.has(run.problem)&&(basis==='submitted'||run.status==='correct')).map(run=>run.team));
  const eligibleTeams=new Map();
  for(const team of data.teams){
    const group=medalGroupForTeam(team);
    if(!group)continue;
    if(!eligibleTeams.has(group))eligibleTeams.set(group,new Set());
    if(activeTeams.has(team.id))eligibleTeams.get(group).add(team.id);
  }
  const counts={};
  for(const[group,teams]of eligibleTeams){
    const total=teams.size,gold=Math.ceil(total/10);
    if(rule==='icpc'){
      const silver=Math.min(gold*2,total-gold);
      counts[group]={gold,silver,bronze:Math.min(gold*3,total-gold-silver)};
    }else{
      const silverEnd=Math.ceil(total*3/10),bronzeEnd=Math.ceil(total*6/10);
      counts[group]={gold,silver:silverEnd-gold,bronze:bronzeEnd-silverEnd};
    }
  }
  return{counts,source:knownPreset?'preset':'estimated',rule,basis,eligibleTeams};
}

function adjustedRuns(data){
  const groups=new Map(),firstAccepted=new Map(),firstAttempts=new Map(),acceptedByTeam=new Map(data.teams.map(team=>[team.id,[]]));
  const scenarioSalt=String(data.config.contest_name||'contest');
  for(const run of data.runs){
    const key=run.team+'|'+run.problem;
    if(!groups.has(key)){
      groups.set(key,{team:run.team,problem:run.problem,first:run.time,runs:[],accepted:false});
      if(!firstAttempts.has(run.problem))firstAttempts.set(run.problem,[]);
      firstAttempts.get(run.problem).push(run.time);
    }
    const group=groups.get(key);group.runs.push(run);
    if(run.status==='correct'){
      if(!firstAccepted.has(run.problem))firstAccepted.set(run.problem,run.time);
      if(!group.accepted){group.accepted=true;acceptedByTeam.get(run.team)?.push(run.time)}
    }
  }
  const countBefore=(values,time)=>{let low=0,high=values.length;while(low<high){const mid=(low+high)>>1;if(values[mid]<time)low=mid+1;else high=mid}return low};
  const percentileWeakness=(counts,value)=>{
    if(counts.length<=1)return.5;
    const stronger=counts.filter(count=>count>value).length,tied=counts.filter(count=>count===value).length;
    return(stronger+(tied-1)/2)/(counts.length-1);
  };
  const finalCounts=data.teams.map(team=>acceptedByTeam.get(team.id)?.length||0);
  const out=[];
  for(const[key,item]of groups){
    const signal=Math.min(firstAccepted.get(item.problem)??Infinity,firstAttempts.get(item.problem)?.[2]??Infinity);
    let discoveryDelay=0,weakness=.5;
    if(Number.isFinite(signal)&&item.first>signal){
      const currentCounts=data.teams.map(team=>countBefore(acceptedByTeam.get(team.id)||[],item.first));
      const teamIndex=data.teams.findIndex(team=>team.id===item.team),current=currentCounts[teamIndex]??0;
      const dynamicWeakness=percentileWeakness(currentCounts,current),finalWeakness=percentileWeakness(finalCounts,finalCounts[teamIndex]??0);
      weakness=.75*dynamicWeakness+.25*finalWeakness;
      const progress=Math.min(1,item.first/data.duration),early=Math.max(0,1-progress)**1.6;
      const lateResidual=.4*weakness**1.3,timeFactor=lateResidual+(1-lateResidual)*early;
      const cueResidual=.35*weakness,cueFactor=cueResidual+(1-cueResidual)*Math.exp(-(item.first-signal)/2400);
      const probability=(.08+.5*weakness)*timeFactor*cueFactor;
      const draw=hash(scenarioSalt+'|'+key+'|xcpc-vp-v2')/0xffffffff;
      if(draw<probability){
        const spread=.75+.5*(hash('delay|'+scenarioSalt+'|'+key+'|xcpc-vp-v2')/0xffffffff);
        discoveryDelay=Math.round((3+15*weakness)*60*timeFactor*cueFactor*spread);
      }
    }
    const retained=.35+.45*weakness;
    for(const run of item.runs){
      const age=Math.max(0,run.time-item.first);
      const shift=discoveryDelay*(retained+(1-retained)*Math.exp(-age/2400));
      const time=run.time+Math.round(shift);
      if(time<data.duration)out.push({...run,time});
    }
  }
  return sortRuns(out);
}

const submissionContestTime=(submission,session)=>{const direct=Number(submission.contest_time_seconds);return Number.isFinite(direct)?direct:(Number(submission.submitted_at_ms)-session.start_at_ms)/1000};
const isLocalSendAttempt=row=>Boolean(row.from_submit&&!row.qoj_id);
function ownRuns(data,submissions,session){
  const labels=new Map(data.problems.map(p=>[p.label.toUpperCase(),p.id]));
  return submissions.map(r=>{
    const problem=labels.get(String(r.problem).toUpperCase());
    const time=submissionContestTime(r,session);
    const resultTime=r.judged_at_ms==null?Infinity:(Number(r.judged_at_ms)-session.start_at_ms)/1000;
    return{id:'own-'+r.id,team:ownId,problem,time,resultTime,status:statusType(r.status)};
  }).filter(r=>r.status!=='ignored'&&r.problem!==undefined&&Number.isFinite(r.time)&&r.time>=0&&r.time<=data.duration);
}

function addAcceptedPenalty(row,time,wrong,data){
  const options=data.config.options||{},method=options.calculation_of_penalty;
  const precision=Number(options.penalty_precision_seconds||0),rankingPrecision=Number(options.ranking_penalty_precision_seconds||0);
  let seconds=time+wrong*data.penalty;
  if(precision>0)seconds=Math.floor(seconds/precision+1e-9)*precision;
  row.penaltySeconds=(row.penaltySeconds||0)+seconds;
  const total=rankingPrecision>0?Math.floor(row.penaltySeconds/rankingPrecision+1e-9)*rankingPrecision:row.penaltySeconds;
  if(method==='accumulate_in_seconds_and_finally_to_the_minute')row.penalty=contestMinute(total);
  else if(method==='in_seconds')row.penalty=total/60;
  else row.penalty+=contestMinute(seconds);
}
const formatPenalty=value=>Number.isInteger(value)?String(value):Number(value.toFixed(2)).toString();
function* mergeRuns(history,own){
  let i=0,j=0;
  while(i<history.length&&j<own.length)yield compareRuns(history[i],own[j])<=0?history[i++]:own[j++];
  while(i<history.length)yield history[i++];
  while(j<own.length)yield own[j++];
}
function compute(data,history,submissions,session,elapsed,revealFrozen=false,historySorted=false){
  const mode=session.mode,freeze=Math.max(0,data.duration-(mode==='ccpc'?3600:Number(data.config.frozen_time??3600)));
  const observationTime=Math.max(0,elapsed),time=Math.min(data.duration,observationTime);
  const frozen=freeze<data.duration&&time>=freeze&&!session.revealed_at_ms&&!revealFrozen;
  const allTeams=[...data.teams,{id:ownId,name:session.own_name,organization:'本次 VP',group:['unofficial'],sortorder:0}];
  const rows=new Map(allTeams.map(t=>[t.id,{...t,solved:0,penalty:0,lastAccepted:-1,states:new Map()}]));
  const firstSolve=new Map(),accepted=new Map(data.problems.map(p=>[p.id,new Set()]));
  const teamRuns=ownRuns(data,submissions,session);
  const allRuns=historySorted?(teamRuns.length?mergeRuns(history,sortRuns(teamRuns)):history):sortRuns([...history,...teamRuns]);
  // Historical VP verdicts may have been observed after the contest ended.
  const finalPublished=Boolean(session.revealed_at_ms)&&observationTime>=data.duration;
  for(const run of allRuns){
    if(run.time>=data.duration||run.time>time)break;
    const row=rows.get(run.team);if(!row||!accepted.has(run.problem))continue;
    const cell=row.states.get(run.problem)||{attempts:0,pending:0,accepted:null,first:run.time};
    if(cell.accepted!==null)continue;
    if(frozen&&run.time>=freeze){
      cell.frozen=(cell.frozen||0)+1;row.states.set(run.problem,cell);continue;
    }
    const status=finalPublished?run.status:(run.resultTime!==undefined&&run.resultTime>observationTime)?'pending':run.status;
    if(status==='correct'){
      cell.accepted=run.time;row.solved++;addAcceptedPenalty(row,run.time,cell.attempts,data);
      row.lastAccepted=Math.max(row.lastAccepted,run.time);accepted.get(run.problem).add(run.team);
      if(!firstSolve.has(run.problem))firstSolve.set(run.problem,run.team);
    }else if(status==='pending')cell.pending++;
    else if(status==='incorrect')cell.attempts++;
    else continue;
    row.states.set(run.problem,cell);
  }
  const threshold=Math.min(50,Math.floor(data.teams.length*.2));
  const visible=new Set(mode==='icpc'||time>=freeze?data.problems.map(p=>p.id):data.problems.filter(p=>accepted.get(p.id).size>=threshold).map(p=>p.id));
  const ordered=[...rows.values()].sort(compareRows);
  let officialRank=0,vocationRank=0,publicRank=0;
  for(const row of ordered){
    row.starred=row.group.includes('unofficial')||row.id===ownId;
    const group=medalGroupForTeam(row),eligible=group&&(!data.medalInfo?.eligibleTeams||data.medalInfo.eligibleTeams.get(group)?.has(row.id));
    row.medalRank=!eligible?null:group==='vocation'?++vocationRank:++officialRank;
    row.rankLabel=row.starred?'*':String(++publicRank);
  }
  return{ordered,visible,freeze,threshold,firstSolve,time,frozen};
}

function liveStandings(data,history,submissions,session,elapsed){
  const time=Math.min(data.duration,Math.max(0,elapsed));
  let low=0,high=history.length;
  while(low<high){const middle=(low+high)>>>1;if(history[middle].time<=time)low=middle+1;else high=middle}
  const freeze=Math.max(0,data.duration-(session.mode==='ccpc'?3600:Number(data.config.frozen_time??3600)));
  const ownKey=ownRuns(data,submissions,session).map(run=>`${run.id}:${run.problem}:${run.time}:${run.status}:${run.time<=time?1:0}:${run.resultTime<=elapsed?1:0}`).join('|');
  const key=`${session.session_id}:${session.mode}:${session.own_name}:${session.start_at_ms}:${Boolean(session.revealed_at_ms)}:${time>=freeze}:${time>=data.duration}:${low}:${ownKey}`;
  if(!liveStandingsCache||liveStandingsCache.data!==data||liveStandingsCache.history!==history||liveStandingsCache.key!==key){
    const result=compute(data,history,submissions,session,elapsed,false,true);
    const ownLive=result.frozen?compute({...data,teams:[]},[],submissions,session,elapsed,true,true).ordered[0]:null;
    liveStandingsCache={data,history,key,result,ownLive};
  }
  // Phase labels still follow time between submission events and at the deadline.
  return{result:{...liveStandingsCache.result,time},ownLive:liveStandingsCache.ownLive,revision:liveStandingsCache};
}

function problemOrder(row,data,visible){
  const shown=data.problems.filter(p=>visible.has(p.id)),hidden=data.problems.filter(p=>!visible.has(p.id));
  const category=cell=>cell?.accepted!==null&&cell?.accepted!==undefined?0:cell?1:2;
  hidden.sort((a,b)=>{const x=row.states.get(a.id),y=row.states.get(b.id);return category(x)-category(y)||(category(x)===0?x.accepted-y.accepted:category(x)===1?x.first-y.first:data.problems.indexOf(a)-data.problems.indexOf(b))});
  return[...shown,...hidden];
}

function cellHtml(row,problem,firstSolve,ownLabel=false){
  const cell=row.states.get(problem.id);
  const label=ownLabel?`<em class="own-problem-label">${escapeHtml(problem.label)}</em>`:'';
  if(!cell)return`<div class="cell blank">${label}</div>`;
  if(cell.frozen)return`<div class="cell pending">${label}<b>&nbsp;</b><small>${cell.attempts} + ${cell.frozen} tries</small></div>`;
  if(cell.accepted!==null&&cell.accepted!==undefined)return`<div class="cell ok ${firstSolve.get(problem.id)===row.id?'first':''}">${label}<b>${contestMinute(cell.accepted)}</b><small>${cell.attempts+1} ${cell.attempts?'tries':'try'}</small></div>`;
  if(cell.pending)return`<div class="cell pending">${label}<b>&nbsp;</b><small>${cell.attempts} + ${cell.pending} tries</small></div>`;
  return`<div class="cell wa">${label}<b>&nbsp;</b><small>${cell.attempts} ${cell.attempts===1?'try':'tries'}</small></div>`;
}

function medalCutoffs(counts){
  if(!counts)return null;
  const count=key=>Number.isFinite(Number(counts[key]))?Math.max(0,Math.floor(Number(counts[key]))):0;
  const gold=count('gold'),silver=gold+count('silver');
  return{gold,silver,bronze:silver+count('bronze')};
}
function medalKind(data,group,rank){
  const cutoffs=medalCutoffs(medalGroups(data)[group]);
  rank=Number(rank);
  if(!cutoffs||!Number.isInteger(rank)||rank<1)return null;
  return rank<=cutoffs.gold?'gold':rank<=cutoffs.silver?'silver':rank<=cutoffs.bronze?'bronze':null;
}

function medalIcon(kind){
  if(!kind)return'';
  const name={gold:'金牌',silver:'银牌',bronze:'铜牌'}[kind];
  return`<span class="medal ${kind}" aria-label="${name}" title="${name}"><svg viewBox="0 0 22 24" aria-hidden="true"><path class="medal-ribbon" d="M2 1h7l3.2 7.1-5.5 3.7zm11 0h7l-4.7 10.8-5.5-3.7z"/><circle cx="11" cy="15" r="8.5"/><path class="medal-star" d="m11 9.2 1.72 3.48 3.84.56-2.78 2.71.66 3.82L11 17.96l-3.44 1.81.66-3.82-2.78-2.71 3.84-.56z"/></svg></span>`;
}

function medal(data,row){
  if(row.starred||!row.medalRank||data.medalInfo?.basis==='solved'&&!row.solved)return'';
  return medalIcon(medalKind(data,medalGroupForTeam(row),row.medalRank));
}

function projectedOfficialRank(rows,own){
  if(!own)return null;
  return 1+rows.filter(row=>row.id!==ownId&&!row.starred&&(row.solved>own.solved||row.solved===own.solved&&row.penalty<own.penalty)).length;
}

const median=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!sorted.length)return null;const middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2};
const quantile=(values,ratio)=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!sorted.length)return null;const position=(sorted.length-1)*ratio,lower=Math.floor(position),upper=Math.ceil(position);return lower===upper?sorted[lower]:sorted[lower]+(sorted[upper]-sorted[lower])*(position-lower)};
const formatAnalysisMinutes=value=>Number.isFinite(value)?`${Math.round(value)} 分钟`:'—';
function problemAwardTiers(data,formal,problemStats){
  const counts=medalGroups(data).official,cutoffs=medalCutoffs(counts),hasMedals=cutoffs&&cutoffs.bronze>0;
  const official=formal.filter(row=>medalGroupForTeam(row)==='official'&&(!data.medalInfo?.eligibleTeams||data.medalInfo.eligibleTeams.get('official')?.has(row.id))).sort(compareRows);
  if(!hasMedals||!official.length)return new Map();
  const cohorts={gold:official.slice(0,cutoffs.gold),silver:official.slice(cutoffs.gold,cutoffs.silver),bronze:official.slice(cutoffs.silver,cutoffs.bronze)};
  const cohortStats=Object.fromEntries(Object.entries(cohorts).map(([kind,rows])=>[kind,{count:rows.length,medianSolved:median(rows.map(row=>row.solved))}]));
  // A single fast team at a medal boundary can have fewer solves than typical
  // teams in its tier. Use the whole tier, so a penalty-only boundary does not
  // collapse the silver and bronze problem sets into one another.
  const lines=Object.fromEntries(Object.entries(cohortStats).map(([kind,stats])=>[kind,Math.ceil(stats.medianSolved??0)]));
  lines.cup=official[0].solved;
  const solvedProblem=(row,problem)=>Number.isFinite(row.states?.get(problem)?.accepted);
  const solverCounts=problemStats.map(item=>official.filter(row=>solvedProblem(row,item.problem.id)).length);
  return new Map(problemStats.map((item,index)=>{
    const solved=solverCounts[index];
    if(!solved)return[item.problem.id,null];
    const difficultyRank=1+solverCounts.filter(value=>value>solved).length;
    const tier=difficultyRank<=lines.bronze?'bronze':difficultyRank<=lines.silver?'silver':difficultyRank<=lines.gold?'gold':difficultyRank<=lines.cup?'cup':null;
    const cohortPasses=Object.fromEntries(Object.entries(cohorts).map(([kind,rows])=>[kind,{solved:rows.filter(row=>solvedProblem(row,item.problem.id)).length,total:rows.length}]));
    return[item.problem.id,tier?{tier,difficultyRank,lines,cohortStats,cohortPasses,solverCount:solved,teamCount:official.length}:null];
  }));
}
function problemAwardIcon(info){
  if(!info)return'';
  const {tier,difficultyRank,lines,cohortPasses}=info,names={cup:'捧杯题',gold:'金牌题',silver:'银牌题',bronze:'铜牌题'},name=names[tier],passes=cohortPasses?.[tier];
  const title=`${name}估计 · 正式组通过 ${info.solverCount}/${info.teamCount} · 难度序第 ${difficultyRank} · 铜/银/金参考题数 ${lines.bronze}/${lines.silver}/${lines.gold}（各奖牌档过题数中位数向上取整）· 冠军 ${lines.cup} 题${passes?` · 本题${name.slice(0,2)}组通过 ${passes.solved}/${passes.total}`:''} · 实际奖牌按题数与罚时计算`;
  const svg=tier==='cup'?'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h8v2h2c0 3-1.4 4.6-4 5.1-.4.5-.9.8-1.4 1V12H12v2H4v-2h3.4v-1.9c-.5-.2-1-.5-1.4-1C3.4 8.6 2 7 2 4h2zm8 3V4h1c-.1 1.8-.8 2.8-2.2 3.3.6-.8 1-1.5 1.2-2.3M4 5c.2.8.6 1.5 1.2 2.3C3.8 6.8 3.1 5.8 3 4h1z"/></svg>':'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1h4l1.3 4L5 7zM9 1h4l-2 6-3.3-2z"/><circle cx="8" cy="10" r="4.4"/><path class="tier-star" d="m8 7.4.8 1.6 1.8.3-1.3 1.2.3 1.8L8 11.4l-1.6.9.3-1.8-1.3-1.2L7.2 9z"/></svg>';
  return`<span class="problem-tier-icon ${tier}" aria-label="${name}" title="${title}">${svg}</span>`;
}
const percent=(part,total)=>total?`${Math.round(part/total*100)}%`:'—';
const scoreBetter=(row,solved,penalty)=>row.solved>solved||row.solved===solved&&row.penalty<penalty;

function buildRankTrajectory(data,history,submissions,session,finalFormal){
  const allTeams=[...data.teams,{id:ownId,name:session.own_name,organization:'本次 VP',group:['unofficial'],sortorder:0}];
  const rows=new Map(allTeams.map(team=>[team.id,{...team,solved:0,penalty:0,lastAccepted:-1,states:new Map()}]));
  const formal=[...rows.values()].filter(row=>row.id!==ownId&&!row.group.includes('unofficial'));
  const own=rows.get(ownId),ownSubmissionRuns=ownRuns(data,submissions,session);
  const finalSolvedByTeam=new Map((finalFormal||[]).map(row=>[row.id,row.solved]));
  const events=sortRuns([...history,...ownSubmissionRuns]).filter(run=>run.time>=0&&run.time<data.duration);
  const sampleTimes=new Set([0,data.duration]);
  const step=60;
  for(let time=step;time<data.duration;time+=step)sampleTimes.add(time);
  for(const run of ownSubmissionRuns)sampleTimes.add(Math.min(data.duration,Math.max(0,run.time)));
  const samples=[...sampleTimes].sort((a,b)=>a-b),points=[],cohorts=new Map();let eventIndex=0;
  const applyRun=run=>{
    const row=rows.get(run.team);if(!row)return;
    const cell=row.states.get(run.problem)||{attempts:0,accepted:null};
    if(cell.accepted!==null)return;
    if(run.status==='correct'){
      cell.accepted=run.time;row.solved++;addAcceptedPenalty(row,run.time,cell.attempts,data);row.lastAccepted=Math.max(row.lastAccepted,run.time);
    }else if(run.status==='incorrect')cell.attempts++;
    else return;
    row.states.set(run.problem,cell);
  };
  for(const time of samples){
    while(eventIndex<events.length&&events[eventIndex].time<=time)applyRun(events[eventIndex++]);
    points.push({time,rank:1+formal.filter(row=>scoreBetter(row,own.solved,own.penalty)).length,solved:own.solved,penalty:own.penalty});
    const ordered=[...formal].sort((a,b)=>b.solved-a.solved||a.penalty-b.penalty),ranked=[];let previous=null,rank=0;
    ordered.forEach((row,index)=>{
      const score=`${row.solved}:${row.penalty}`;
      if(score!==previous){rank=index+1;previous=score}
      ranked.push({row,rank});
    });
    const groups=new Map();
    for(const item of ranked){
      const finalSolved=finalSolvedByTeam.get(item.row.id);
      if(!Number.isFinite(finalSolved))continue;
      if(!groups.has(finalSolved))groups.set(finalSolved,[]);
      groups.get(finalSolved).push(item.rank);
    }
    for(const [solved,ranks] of groups){
      if(!cohorts.has(solved))cohorts.set(solved,[]);
      cohorts.get(solved).push({time,count:ranks.length,min:Math.min(...ranks),q1:quantile(ranks,.25),median:median(ranks),q3:quantile(ranks,.75),max:Math.max(...ranks)});
    }
  }
  const solvedOptions=[...cohorts.keys()].sort((a,b)=>a-b);
  const completeCohorts=Object.fromEntries(solvedOptions.map(solved=>{
    const byTime=new Map(cohorts.get(solved).map(point=>[point.time,point]));
    return[solved,samples.map(time=>byTime.get(time)||{time,count:0,min:null,q1:null,median:null,q3:null,max:null})];
  }));
  return{points,cohorts:completeCohorts,solvedOptions};
}

function buildContestAnalysis(data,history,submissions,session){
  const finalSession={...session,revealed_at_ms:session.revealed_at_ms||1};
  const finalResult=compute(data,history,submissions,finalSession,data.duration,true);
  const own=finalResult.ordered.find(row=>row.id===ownId);
  const formal=finalResult.ordered.filter(row=>row.id!==ownId&&!row.starred);
  const finalRank=projectedOfficialRank(finalResult.ordered,own);
  const sameSolved=formal.filter(row=>row.solved===own.solved),oneMore=formal.filter(row=>row.solved===own.solved+1);
  const acceptedCells=[...own.states.values()].filter(cell=>cell.accepted!==null&&cell.accepted!==undefined);
  const acceptedMinutes=acceptedCells.reduce((sum,cell)=>sum+contestMinute(cell.accepted),0);
  const countedWrong=acceptedCells.reduce((sum,cell)=>sum+cell.attempts,0);
  const wrongPenalty=contestMinute(countedWrong*data.penalty);
  const rankFor=(solved,penalty)=>1+formal.filter(row=>scoreBetter(row,solved,Math.max(0,penalty))).length;
  const trajectoryData=buildRankTrajectory(data,history,submissions,finalSession,formal),trajectory=trajectoryData.points;
  const formalIds=new Set(data.teams.filter(team=>!team.group.includes('unofficial')).map(team=>team.id));
  const firstSolveByProblem=new Map();
  for(const run of sortRuns(history))if(run.status==='correct'&&formalIds.has(run.team)&&!firstSolveByProblem.has(run.problem))firstSolveByProblem.set(run.problem,run);
  const firstSolveMarkers=data.problems.map(problem=>{
    const run=firstSolveByProblem.get(problem.id);
    return run?{problem:problem.label,time:run.time,team:data.teams.find(team=>team.id===run.team)?.name||run.team}:null;
  }).filter(Boolean);
  const markers=submissions.filter(row=>!isLocalSendAttempt(row)).map(submission=>({
    id:submission.id,problem:String(submission.problem||'?').toUpperCase(),time:submissionContestTime(submission,session),status:statusType(submission.status),rawStatus:String(submission.status||'').toLowerCase()
  })).filter(marker=>Number.isFinite(marker.time)&&marker.time>=0&&marker.time<data.duration).sort((a,b)=>a.time-b.time||String(a.id).localeCompare(String(b.id)));
  const cohortStats=rows=>({count:rows.length,medianPenalty:median(rows.map(row=>row.penalty)),medianLast:median(rows.filter(row=>row.lastAccepted>=0).map(row=>contestMinute(row.lastAccepted)))});
  const sortedFormal=[...formal].sort(compareRows),ownPosition=sortedFormal.findIndex(row=>!scoreBetter(row,own.solved,own.penalty));
  const ahead=[...formal].filter(row=>scoreBetter(row,own.solved,own.penalty)).sort(compareRows).at(-1)||null;
  const behind=[...formal].filter(row=>!scoreBetter(row,own.solved,own.penalty)&&!(row.solved===own.solved&&row.penalty===own.penalty)).sort(compareRows)[0]||null;
  const solveDistribution=(rows,problem)=>{
    const times=rows.map(row=>row.states.get(problem.id)?.accepted).filter(Number.isFinite).map(contestMinute);
    return{total:rows.length,solved:times.length,rate:rows.length?times.length/rows.length:null,medianTime:median(times),q1Time:quantile(times,.25),q3Time:quantile(times,.75)};
  };
  const problemStats=data.problems.map(problem=>{
    const cell=own.states.get(problem.id),solvers=formal.filter(row=>row.states.get(problem.id)?.accepted!==null&&row.states.get(problem.id)?.accepted!==undefined);
    const sameSolvers=sameSolved.filter(row=>row.states.get(problem.id)?.accepted!==null&&row.states.get(problem.id)?.accepted!==undefined);
    const moreSolvers=oneMore.filter(row=>row.states.get(problem.id)?.accepted!==null&&row.states.get(problem.id)?.accepted!==undefined);
    const ownMarkers=markers.filter(marker=>marker.problem===String(problem.label).toUpperCase()),firstRun=firstSolveByProblem.get(problem.id);
    return{problem,cell,solvers,allRate:formal.length?solvers.length/formal.length:0,sameRate:sameSolved.length?sameSolvers.length/sameSolved.length:null,moreRate:oneMore.length?moreSolvers.length/oneMore.length:null,medianTime:median(solvers.map(row=>contestMinute(row.states.get(problem.id).accepted))),allDistribution:solveDistribution(formal,problem),sameDistribution:solveDistribution(sameSolved,problem),moreDistribution:solveDistribution(oneMore,problem),firstSolve:firstRun?{time:firstRun.time,team:data.teams.find(team=>team.id===firstRun.team)?.name||firstRun.team}:null,ownSubmissionCounts:{total:ownMarkers.length,incorrect:ownMarkers.filter(marker=>marker.status==='incorrect').length,compileError:ownMarkers.filter(marker=>marker.status==='compile_error').length,pending:ownMarkers.filter(marker=>marker.status==='pending').length,correct:ownMarkers.filter(marker=>marker.status==='correct').length}};
  });
  const awardTiers=problemAwardTiers(data,formal,problemStats);
  for(const item of problemStats)item.awardTier=awardTiers.get(item.problem.id)||null;
  const gapProblems=problemStats.filter(item=>(item.cell?.accepted===null||item.cell?.accepted===undefined)&&item.moreRate!==null).sort((a,b)=>b.moreRate-a.moreRate||b.allRate-a.allRate).slice(0,3);
  const sameMilestones=[];
  for(let index=0;index<own.solved;index++){
    const ownTimes=acceptedCells.map(cell=>contestMinute(cell.accepted)).sort((a,b)=>a-b);
    const peerTimes=sameSolved.map(row=>[...row.states.values()].filter(cell=>cell.accepted!==null&&cell.accepted!==undefined).map(cell=>contestMinute(cell.accepted)).sort((a,b)=>a-b)[index]).filter(Number.isFinite);
    sameMilestones.push({number:index+1,own:ownTimes[index],peerMedian:median(peerTimes)});
  }
  return{finalResult,own,formal,finalRank,sameSolved,oneMore,sameStats:cohortStats(sameSolved),moreStats:cohortStats(oneMore),acceptedMinutes,countedWrong,wrongPenalty,trajectory,cohortTrajectories:trajectoryData.cohorts,cohortSolvedOptions:trajectoryData.solvedOptions,firstSolveMarkers,markers,problemStats,gapProblems,sameMilestones,ahead,behind,whatIf:{oneLessWrong:countedWrong?rankFor(own.solved,own.penalty-contestMinute(data.penalty)):null,tenEarlier:own.solved?rankFor(own.solved,own.penalty-own.solved*10):null,thirtyEarlier:own.solved?rankFor(own.solved,own.penalty-own.solved*30):null},ownPosition};
}

function cohortProblemMarkers(analysis,data,solved){
  const peers=analysis.formal.filter(row=>row.solved===solved);
  return data.problems.map(problem=>{
    const times=peers.map(row=>row.states.get(problem.id)?.accepted).filter(Number.isFinite);
    return times.length?{problem:problem.label,time:median(times),count:times.length,total:peers.length}:null;
  }).filter(Boolean);
}

function combinedRankChartHtml(analysis,data,solved,requestedRange){
  const width=1120,height=430,left=62,right=58,top=30,bottom=126,plotWidth=width-left-right,plotHeight=height-top-bottom;
  const cohortActive=solved!==null&&solved!==''&&Number.isFinite(Number(solved));
  const start=Math.max(0,Math.min(data.duration-1,Number(requestedRange?.start)||0)),end=Math.min(data.duration,Math.max(start+1,Number(requestedRange?.end)||data.duration)),span=end-start,isFull=start<=0&&end>=data.duration;
  const windowPoints=(items,step=false)=>{
    const inside=items.filter(point=>point.time>=start&&point.time<=end),before=[...items].reverse().find(point=>point.time<start),last=[...items].reverse().find(point=>point.time<=end);
    if(before)inside.unshift({...before,time:start});
    if(last&&(!inside.length||inside.at(-1).time<end))inside.push({...last,time:end});
    return inside;
  };
  const trajectory=windowPoints(analysis.trajectory,true),series=cohortActive?windowPoints(analysis.cohortTrajectories[solved]||[]):[],valid=series.filter(point=>point.count>0&&Number.isFinite(point.median));
  const fullRanks=[...trajectory.map(point=>point.rank),...valid.flatMap(point=>[point.min,point.max]),...(isFull?[analysis.finalRank]:[])];
  const focusRanks=[...trajectory.map(point=>point.rank),...valid.flatMap(point=>[point.q1,point.median,point.q3]),...(isFull?[analysis.finalRank]:[])];
  const focusMin=Math.min(...focusRanks),focusMax=Math.max(...focusRanks),padding=Math.max(1,Math.ceil((focusMax-focusMin)*.06)),domainMin=1,domainMax=Math.max(domainMin+1,analysis.formal.length+1,...fullRanks);
  const defaultMin=Math.max(domainMin,Math.floor(focusMin-padding)),defaultMax=Math.min(domainMax,Math.max(defaultMin+1,Math.ceil(focusMax+padding))),storedMin=Number(analysisRankWindow?.min),storedMax=Number(analysisRankWindow?.max);
  const minRank=Number.isFinite(storedMin)?Math.max(domainMin,Math.min(domainMax-1,Math.round(storedMin))):defaultMin,maxRank=Number.isFinite(storedMax)?Math.max(minRank+1,Math.min(domainMax,Math.round(storedMax))):defaultMax,rankSpan=Math.max(1,maxRank-minRank),domainSpan=Math.max(1,domainMax-domainMin),windowTop=(minRank-domainMin)/domainSpan*100,windowBottom=(maxRank-domainMin)/domainSpan*100;
  const x=time=>left+(Math.min(end,Math.max(start,time))-start)/span*plotWidth,y=rank=>top+(rank-minRank)/rankSpan*plotHeight;
  const ownPath=trajectory.map((point,index)=>index?`H ${x(point.time).toFixed(1)} V ${y(point.rank).toFixed(1)}`:`M ${x(point.time).toFixed(1)} ${y(point.rank).toFixed(1)}`).join(' ');
  const segments=[];let current=[];
  for(const point of series){if(point.count>0)current.push(point);else if(current.length){segments.push(current);current=[]}}
  if(current.length)segments.push(current);
  const polygon=(segment,low,high)=>`${segment.map(point=>`${x(point.time).toFixed(1)},${y(point[low]).toFixed(1)}`).join(' ')} ${[...segment].reverse().map(point=>`${x(point.time).toFixed(1)},${y(point[high]).toFixed(1)}`).join(' ')}`;
  const line=(segment,key)=>segment.map((point,index)=>`${index?'L':'M'} ${x(point.time).toFixed(1)} ${y(point[key]).toFixed(1)}`).join(' ');
  const xTickCount=span<=1800?11:span<=7200?10:9,xTicks=Array.from({length:xTickCount},(_,index)=>start+span*index/(xTickCount-1)),tickCount=Math.min(6,maxRank-minRank+1),yTicks=Array.from({length:tickCount},(_,index)=>Math.round(minRank+(maxRank-minRank)*index/Math.max(1,tickCount-1))).filter((value,index,array)=>!index||value!==array[index-1]);
  const peerMarkers=cohortActive?cohortProblemMarkers(analysis,data,Number(solved)):[],ownSolveMarkers=data.problems.map(problem=>{const cell=analysis.own.states.get(problem.id);return Number.isFinite(cell?.accepted)?{problem:problem.label,time:cell.accepted,attempts:cell.attempts}:null}).filter(Boolean),trackBase=top+plotHeight;
  const markerTitle=(text,time)=>`${formatSeconds(time)} · ${text}`;
  const visibleLabels=items=>{const labels=new Set(),ordered=items.filter(marker=>marker.time>=start&&marker.time<=end).sort((a,b)=>a.time-b.time);let last=-Infinity;for(const marker of ordered){const px=x(marker.time);if(px-last>=22){labels.add(marker);last=px}}return labels};
  const clusterMarkers=items=>{const clusters=[];for(const marker of items.sort((a,b)=>a.time-b.time)){const previous=clusters.at(-1);if(previous&&x(marker.time)-x(previous.items.at(-1).time)<22)previous.items.push(marker);else clusters.push({items:[marker]})}return clusters.map(cluster=>({...cluster,time:cluster.items.reduce((sum,marker)=>sum+marker.time,0)/cluster.items.length,label:[...new Set(cluster.items.map(marker=>marker.problem))].join('·')}))};
  const ownSubmissions=analysis.markers.filter(marker=>marker.time>=start&&marker.time<=end),ownSolves=ownSolveMarkers.filter(marker=>marker.time>=start&&marker.time<=end),peerSolves=peerMarkers.filter(marker=>marker.time>=start&&marker.time<=end),submissionLabels=visibleLabels(ownSubmissions),ownSolveLabels=visibleLabels(ownSolves),peerClusters=clusterMarkers(peerSolves);
  return`<div class="analysis-chart-layout"><div class="analysis-rank-window" data-domain-min="${domainMin}" data-domain-max="${domainMax}" data-view-min="${minRank}" data-view-max="${maxRank}" title="精细拖动端点调整范围，拖动中间区域整体移动，双击恢复自动范围"><div class="analysis-rank-window-track"><div class="analysis-rank-window-selection" style="top:${windowTop}%;height:${Math.max(1,windowBottom-windowTop)}%" role="slider" aria-label="整体移动当前名次范围" aria-valuemin="${domainMin}" aria-valuemax="${domainMax}" aria-valuetext="${minRank} 至 ${maxRank}"></div><button class="analysis-rank-window-handle min" type="button" style="top:${windowTop}%" aria-label="当前最高名次" aria-valuemin="${domainMin}" aria-valuemax="${maxRank-1}" aria-valuenow="${minRank}"><span>${minRank}</span></button><button class="analysis-rank-window-handle max" type="button" style="top:${windowBottom}%" aria-label="当前最低名次" aria-valuemin="${minRank+1}" aria-valuemax="${domainMax}" aria-valuenow="${maxRank}"><span>${maxRank}</span></button></div><small>双击复位</small></div><div class="analysis-chart-stage"><svg class="rank-chart-svg combined-rank-svg" viewBox="0 0 ${width} ${height}" data-left="${left}" data-right="${right}" data-top="${top}" data-plot-bottom="${trackBase}" data-min-rank="${minRank}" data-max-rank="${maxRank}" role="img" aria-label="${cohortActive?`本队和最终 ${solved} 题队伍`:'本队'}排名随时间变化">
    <defs><clipPath id="analysis-rank-clip"><rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/></clipPath></defs>
    <rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" class="chart-plot"/>
    ${xTicks.map(time=>`<g><line x1="${x(time)}" y1="${top}" x2="${x(time)}" y2="${trackBase}" class="chart-grid"/><text x="${x(time)}" y="${trackBase+22}" class="chart-axis" text-anchor="middle">${span<=3600?formatSeconds(time):formatClock(time)}</text></g>`).join('')}
    ${yTicks.map((rank,index)=>`<g class="chart-y-tick" data-ratio="${index/Math.max(1,yTicks.length-1)}"><line x1="${left}" y1="${y(rank)}" x2="${width-right}" y2="${y(rank)}" class="chart-grid"/><text x="${left-11}" y="${y(rank)+4}" class="chart-axis" text-anchor="end">${rank}</text></g>`).join('')}
    <g clip-path="url(#analysis-rank-clip)"><g class="chart-rank-data">${segments.map(segment=>`<polygon points="${polygon(segment,'min','max')}" class="cohort-rank-range"/><polygon points="${polygon(segment,'q1','q3')}" class="cohort-rank-iqr"/><path d="${line(segment,'median')}" class="cohort-rank-median"/>`).join('')}
    <line x1="${left}" y1="${y(analysis.finalRank)}" x2="${width-right}" y2="${y(analysis.finalRank)}" class="chart-final-line"/>
    <path d="${ownPath}" class="chart-rank-line"/></g></g>
    <text x="${width-right+9}" y="${analysis.finalRank<minRank?top+13:analysis.finalRank>maxRank?top+plotHeight-5:Math.max(top+12,Math.min(top+plotHeight-5,y(analysis.finalRank)+4))}" class="chart-final-label" text-anchor="start">${analysis.finalRank}</text>
    <text x="18" y="${top+plotHeight/2}" class="chart-axis-title" text-anchor="middle" transform="rotate(-90 18 ${top+plotHeight/2})">正式榜名次</text>
    <g class="chart-event-tracks"><line x1="${left}" y1="${trackBase+43}" x2="${width-right}" y2="${trackBase+43}"/><line x1="${left}" y1="${trackBase+70}" x2="${width-right}" y2="${trackBase+70}"/><line x1="${left}" y1="${trackBase+97}" x2="${width-right}" y2="${trackBase+97}"/><text x="${left-9}" y="${trackBase+47}" text-anchor="end">提交</text><text x="${left-9}" y="${trackBase+74}" text-anchor="end">过题</text><text x="${left-9}" y="${trackBase+101}" text-anchor="end">同题中位</text></g>
    ${ownSubmissions.map(marker=>`<g class="analysis-event-marker own ${marker.status}" transform="translate(${x(marker.time)} ${trackBase+43})"><circle r="4"/>${submissionLabels.has(marker)?`<text y="-9" text-anchor="middle">${escapeHtml(marker.problem)}</text>`:''}<title>${escapeHtml(markerTitle(`${marker.problem} · ${marker.rawStatus.toUpperCase()} · #${marker.id}`,marker.time))}</title></g>`).join('')}
    ${ownSolves.map(marker=>`<g class="analysis-event-marker own-solve" transform="translate(${x(marker.time)} ${trackBase+70})"><circle r="4.5"/>${ownSolveLabels.has(marker)?`<text y="-9" text-anchor="middle">${escapeHtml(marker.problem)}</text>`:''}<title>${escapeHtml(markerTitle(`${marker.problem} 过题 · ${marker.attempts+1} 次尝试`,marker.time))}</title></g>`).join('')}
    ${peerClusters.map(cluster=>`<g class="analysis-event-marker peer" transform="translate(${x(cluster.time)} ${trackBase+97})"><path d="M0-5 5 4-5 4Z"/><text y="-9" text-anchor="middle">${escapeHtml(cluster.label)}</text><title>${escapeHtml(cluster.items.map(marker=>`${marker.problem} ${formatSeconds(marker.time)}（${marker.count}/${marker.total} 支通过）`).join('；'))} · 最终 ${solved} 题队伍过题时间中位数</title></g>`).join('')}
    <line x1="${left}" y1="${top}" x2="${left}" y2="${trackBase+104}" class="chart-hover-line hidden"/>
    <circle cx="${left}" cy="${top}" r="4" class="chart-hover-dot own hidden"/><circle cx="${left}" cy="${top}" r="4" class="chart-hover-dot cohort hidden"/>
    <rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight+105}" class="chart-hover-surface"/>
  </svg><div class="analysis-chart-tooltip hidden"></div></div></div>`;
}

function wireCombinedRankChart(analysis,data,solved,requestedRange,onRangeChange,onRankWindowChange){
  const host=$('analysisRankChart'),stage=host.querySelector('.analysis-chart-stage'),svg=host.querySelector('.combined-rank-svg'),tooltip=host.querySelector('.analysis-chart-tooltip');
  if(!stage||!svg||!tooltip)return;
  const line=svg.querySelector('.chart-hover-line'),ownDot=svg.querySelector('.chart-hover-dot.own'),cohortDot=svg.querySelector('.chart-hover-dot.cohort');
  const width=1120,left=Number(svg.dataset.left),right=Number(svg.dataset.right),top=Number(svg.dataset.top),plotBottom=Number(svg.dataset.plotBottom),plotWidth=width-left-right;
  const start=Math.max(0,Number(requestedRange?.start)||0),end=Math.min(data.duration,Number(requestedRange?.end)||data.duration),span=Math.max(1,end-start);
  const cohortActive=solved!==null&&solved!==''&&Number.isFinite(Number(solved)),series=cohortActive?(analysis.cohortTrajectories[solved]||[]):[],minRank=Number(svg.dataset.minRank),maxRank=Number(svg.dataset.maxRank),rankSpan=Math.max(1,maxRank-minRank),y=rank=>top+(rank-minRank)/rankSpan*(plotBottom-top);
  const nearest=(items,time)=>items.reduce((best,item)=>!best||Math.abs(item.time-time)<Math.abs(best.time-time)?item:best,null);
  const show=event=>{
    const rect=svg.getBoundingClientRect(),viewX=Math.min(width-right,Math.max(left,(event.clientX-rect.left)/rect.width*width)),time=start+(viewX-left)/plotWidth*span,own=nearest(analysis.trajectory,time),cohort=nearest(series,time),cursorX=Math.min(width-right,Math.max(left,left+(own.time-start)/span*plotWidth));
    line.setAttribute('x1',cursorX);line.setAttribute('x2',cursorX);line.classList.remove('hidden');ownDot.setAttribute('cx',cursorX);ownDot.setAttribute('cy',y(own.rank));ownDot.classList.remove('hidden');
    if(cohort?.count>0){cohortDot.setAttribute('cx',cursorX);cohortDot.setAttribute('cy',y(cohort.median));cohortDot.classList.remove('hidden')}else cohortDot.classList.add('hidden');
    tooltip.innerHTML=`<strong>${escapeHtml(formatSeconds(own.time))}</strong><div><span><i class="tooltip-own"></i>本队</span><b>第 ${own.rank} 名</b><small>${own.solved} 题 · ${formatPenalty(own.penalty)} 罚时</small></div>${cohortActive?`<div><span><i class="tooltip-cohort"></i>最终 ${solved} 题队伍</span>${cohort?.count>0?`<b>${cohort.min}–${cohort.max} 名</b><small>${cohort.count} 支 · P25–P75 ${Number(cohort.q1.toFixed(1))}–${Number(cohort.q3.toFixed(1))} · 中位 ${Number(cohort.median.toFixed(1))}</small>`:'<b>该组暂无数据</b><small>最终分组数据尚未生成</small>'}</div>`:''}`;
    tooltip.classList.remove('hidden');const stageRect=stage.getBoundingClientRect(),localX=(cursorX/width)*stageRect.width;tooltip.classList.toggle('place-left',localX>stageRect.width*.68);tooltip.style.left=`${localX}px`;
  };
  let drag=null,dragFrame=0,dragPreview=null;
  const currentSvg=()=>host.querySelector('.combined-rank-svg')||svg,currentRankWindow=()=>({min:Number(currentSvg().dataset.minRank),max:Number(currentSvg().dataset.maxRank)});
  const previewRange=clientX=>{const delta=clientX-drag.x,shift=-delta/Math.max(1,drag.rectWidth)*drag.span,nextStart=Math.max(0,Math.min(Math.max(0,data.duration-drag.span),drag.start+shift));return{start:nextStart,end:nextStart+drag.span}};
  const scheduleDragPreview=next=>{dragPreview=next;if(dragFrame)return;dragFrame=requestAnimationFrame(()=>{dragFrame=0;if(drag&&dragPreview)onRangeChange?.(dragPreview,{rankWindow:currentRankWindow()})})};
  const moveDrag=event=>{if(!drag)return;drag.currentX=event.clientX;currentSvg().classList.add('dragging');const next=previewRange(event.clientX),label=$('analysisRangeLabel');if(label)label.textContent=`${formatSeconds(next.start)}–${formatSeconds(next.end)}`;if(Math.abs(event.clientX-drag.x)>2)scheduleDragPreview(next)};
  const finishDrag=event=>{if(!drag)return;const moved=Math.abs((event?.clientX??drag.currentX)-drag.x),next=previewRange(event?.clientX??drag.currentX);drag=null;dragPreview=null;host.dataset.dragging='';if(dragFrame){cancelAnimationFrame(dragFrame);dragFrame=0}currentSvg().classList.remove('dragging');window.removeEventListener('pointermove',moveDrag);window.removeEventListener('pointerup',finishDrag);window.removeEventListener('pointercancel',finishDrag);if(moved>2)onRangeChange?.(next,{rankWindow:currentRankWindow()})};
  svg.addEventListener('pointermove',event=>{if(!drag&&!host.dataset.dragging)show(event)});
  svg.addEventListener('pointerdown',event=>{if(event.button!==0||span>=data.duration)return;event.preventDefault();line.classList.add('hidden');ownDot.classList.add('hidden');cohortDot.classList.add('hidden');tooltip.classList.add('hidden');drag={x:event.clientX,currentX:event.clientX,rectWidth:Math.max(1,svg.getBoundingClientRect().width),start,span};host.dataset.dragging='1';svg.classList.add('dragging');window.addEventListener('pointermove',moveDrag);window.addEventListener('pointerup',finishDrag,{once:true});window.addEventListener('pointercancel',finishDrag,{once:true})});
  svg.addEventListener('pointerleave',()=>{if(!drag){line.classList.add('hidden');ownDot.classList.add('hidden');cohortDot.classList.add('hidden');tooltip.classList.add('hidden')}});
  svg.addEventListener('wheel',event=>{event.preventDefault();const rect=svg.getBoundingClientRect(),ratio=Math.min(1,Math.max(0,(event.clientX-rect.left)/rect.width)),center=start+ratio*span,factor=event.deltaY<0?.6:1.65,newSpan=Math.max(Math.min(300,data.duration),Math.min(data.duration,span*factor));onRangeChange?.({start:center-ratio*newSpan,end:center+(1-ratio)*newSpan},{rankWindow:{min:Number(svg.dataset.minRank),max:Number(svg.dataset.maxRank)}})},{passive:false});
  svg.addEventListener('dblclick',()=>onRangeChange?.({start:0,end:data.duration}));
  const rankWindow=host.querySelector('.analysis-rank-window'),rankTrack=rankWindow?.querySelector('.analysis-rank-window-track'),rankSelection=rankWindow?.querySelector('.analysis-rank-window-selection'),minHandle=rankWindow?.querySelector('.analysis-rank-window-handle.min'),maxHandle=rankWindow?.querySelector('.analysis-rank-window-handle.max');
  if(rankWindow&&rankTrack&&rankSelection&&minHandle&&maxHandle){
    const domainMin=Number(rankWindow.dataset.domainMin),domainMax=Number(rankWindow.dataset.domainMax),domainSpan=Math.max(1,domainMax-domainMin),initial={min:Number(rankWindow.dataset.viewMin),max:Number(rankWindow.dataset.viewMax)},clamp=(value,min,max)=>Math.max(min,Math.min(max,value)),rankData=svg.querySelector('.chart-rank-data'),finalLabel=svg.querySelector('.chart-final-label'),yTickLabels=[...svg.querySelectorAll('.chart-y-tick')];let rankDrag=null,preview={...initial};
    const topPercent=value=>(value-domainMin)/domainSpan*100;
    const paintChart=range=>{const nextSpan=Math.max(1,range.max-range.min),scale=rankSpan/nextSpan,offset=top+(minRank-range.min)/nextSpan*(plotBottom-top)-scale*top;rankData?.setAttribute('transform',`matrix(1 0 0 ${scale} 0 ${offset})`);svg.dataset.minRank=range.min;svg.dataset.maxRank=range.max;yTickLabels.forEach(tick=>{const ratio=Number(tick.dataset.ratio),label=tick.querySelector('text');if(label)label.textContent=Math.round(range.min+nextSpan*ratio)});if(finalLabel)finalLabel.setAttribute('y',analysis.finalRank<range.min?top+13:analysis.finalRank>range.max?plotBottom-5:Math.max(top+12,Math.min(plotBottom-5,top+(analysis.finalRank-range.min)/nextSpan*(plotBottom-top)+4)))};
    const paint=range=>{preview=range;const top=topPercent(range.min),bottom=topPercent(range.max);minHandle.style.top=`${top}%`;maxHandle.style.top=`${bottom}%`;rankSelection.style.top=`${top}%`;rankSelection.style.height=`${Math.max(1,bottom-top)}%`;minHandle.querySelector('span').textContent=range.min;maxHandle.querySelector('span').textContent=range.max;minHandle.setAttribute('aria-valuenow',range.min);maxHandle.setAttribute('aria-valuenow',range.max);rankSelection.setAttribute('aria-valuetext',`${range.min} 至 ${range.max}`);paintChart(range)};
    const nextRange=clientY=>{const delta=Math.round((clientY-rankDrag.startY)/rankDrag.trackHeight*domainSpan*.35);if(rankDrag.kind==='min')return{min:clamp(rankDrag.range.min+delta,domainMin,rankDrag.range.max-1),max:rankDrag.range.max};if(rankDrag.kind==='max')return{min:rankDrag.range.min,max:clamp(rankDrag.range.max+delta,rankDrag.range.min+1,domainMax)};const size=rankDrag.range.max-rankDrag.range.min,nextMin=clamp(rankDrag.range.min+delta,domainMin,domainMax-size);return{min:nextMin,max:nextMin+size}};
    const moveRank=event=>{if(rankDrag)paint(nextRange(event.clientY))};
    const finishRank=()=>{if(!rankDrag)return;rankDrag=null;rankWindow.classList.remove('dragging');window.removeEventListener('pointermove',moveRank);window.removeEventListener('pointerup',finishRank);window.removeEventListener('pointercancel',finishRank);if(preview.min!==initial.min||preview.max!==initial.max)onRankWindowChange?.(preview)};
    const startRank=(kind,event)=>{if(event.button!==0||event.detail>1)return;event.preventDefault();event.stopPropagation();rankDrag={kind,startY:event.clientY,trackHeight:Math.max(1,rankTrack.getBoundingClientRect().height),range:{...preview}};rankWindow.classList.add('dragging');window.addEventListener('pointermove',moveRank);window.addEventListener('pointerup',finishRank,{once:true});window.addEventListener('pointercancel',finishRank,{once:true})};
    minHandle.addEventListener('pointerdown',event=>startRank('min',event));maxHandle.addEventListener('pointerdown',event=>startRank('max',event));rankSelection.addEventListener('pointerdown',event=>startRank('window',event));
    const keyMove=(kind,event)=>{if(!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key))return;event.preventDefault();const step=event.key.startsWith('Page')?Math.max(1,Math.round(domainSpan*.05)):1,direction=event.key==='ArrowUp'||event.key==='PageUp'?-step:event.key==='ArrowDown'||event.key==='PageDown'?step:0;let next={...preview};if(kind==='min')next.min=event.key==='Home'?domainMin:event.key==='End'?next.max-1:clamp(next.min+direction,domainMin,next.max-1);else next.max=event.key==='End'?domainMax:event.key==='Home'?next.min+1:clamp(next.max+direction,next.min+1,domainMax);onRankWindowChange?.(next)};
    minHandle.addEventListener('keydown',event=>keyMove('min',event));maxHandle.addEventListener('keydown',event=>keyMove('max',event));rankWindow.addEventListener('dblclick',event=>{event.preventDefault();onRankWindowChange?.(null)});
  }
}

function renderAnalysisCohortChart(analysis,data){
  const options=analysis.cohortSolvedOptions||[];
  if(analysisCohortSolved!==null&&!options.includes(Number(analysisCohortSolved)))analysisCohortSolved=null;
  const select=$('analysisSolvedSelect');
  select.innerHTML=`<option value=""${analysisCohortSolved===null?' selected':''}></option>${options.map(value=>`<option value="${value}"${analysisCohortSolved!==null&&value===Number(analysisCohortSolved)?' selected':''}>${value} 题</option>`).join('')}`;
  if(!analysisChartRange||analysisChartRange.duration!==data.duration)analysisChartRange={start:0,end:data.duration,duration:data.duration};
  const normalizeRange=range=>{const minSpan=Math.min(300,data.duration),span=Math.max(minSpan,Math.min(data.duration,Number(range.end)-Number(range.start))),start=Math.max(0,Math.min(data.duration-span,Number(range.start)));return{start,end:start+span,duration:data.duration}};
  const setRange=(range,options={})=>{if(options.rankWindow)analysisRankWindow=options.rankWindow;analysisChartRange=normalizeRange(range);draw()};
  const draw=()=>{
    const range=analysisChartRange,span=range.end-range.start,isFull=range.start<=0&&range.end>=data.duration;
    $('analysisRangeLabel').textContent=isFull?'全场 · 1 分钟精度':`${formatSeconds(range.start)}–${formatSeconds(range.end)}`;
    const cohortActive=analysisCohortSolved!==null;$('analysisChartDescription').textContent=cohortActive?'对比本队与所选最终过题数队伍的整体范围、P25–P75 范围和中位数。':'当前仅显示本队排名和提交、过题时间。';document.querySelectorAll('.analysis-legend .cohort-only').forEach(node=>node.classList.toggle('hidden',!cohortActive));
    $('analysisRankChart').innerHTML=combinedRankChartHtml(analysis,data,analysisCohortSolved,range);wireCombinedRankChart(analysis,data,analysisCohortSolved,range,setRange,value=>{analysisRankWindow=value;draw()});
    $('analysisPanLeft').disabled=range.start<=0;$('analysisPanRight').disabled=range.end>=data.duration;$('analysisZoomOut').disabled=isFull;$('analysisZoomReset').disabled=isFull;
  };
  const zoom=factor=>{const range=analysisChartRange,center=(range.start+range.end)/2,next=(range.end-range.start)*factor;setRange({start:center-next/2,end:center+next/2})};
  const zoomToSpan=seconds=>{const range=analysisChartRange,span=Math.min(seconds,data.duration),center=(range.start+range.end)/2;setRange({start:center-span/2,end:center+span/2})};
  const pan=direction=>{const range=analysisChartRange,shift=(range.end-range.start)*.3*direction;setRange({start:range.start+shift,end:range.end+shift})};
  $('analysisZoomIn').onclick=()=>zoom(.55);$('analysisZoomOut').onclick=()=>zoom(1.8);$('analysisPanLeft').onclick=()=>pan(-1);$('analysisPanRight').onclick=()=>pan(1);$('analysisZoom30').onclick=()=>zoomToSpan(1800);$('analysisZoom60').onclick=()=>zoomToSpan(3600);$('analysisZoomReset').onclick=()=>setRange({start:0,end:data.duration});
  draw();select.onchange=()=>{analysisCohortSolved=select.value===''?null:Number(select.value);analysisRankWindow=null;draw()};
}

function renderAnalysis(data,session){
  const submissionKey=state.submissions.map(item=>`${item.id}:${item.problem}:${item.status}:${item.contest_time_seconds??item.submitted_at_ms}`).join('|');
  const key=`${session.session_id}:${session.mode}:${session.own_name}:${session.start_at_ms}:${session.revealed_at_ms}:${submissionKey}`;
  const sessionChanged=analysisCache?.sessionId!==session.session_id;
  if(analysisCache?.key===key&&analysisCache.data===data&&analysisCache.history===state.history&&analysisCache.rendered)return;
  if(!analysisCache||analysisCache.key!==key||analysisCache.data!==data||analysisCache.history!==state.history){analysisCache={key,sessionId:session.session_id,data,history:state.history,value:buildContestAnalysis(data,state.history,state.submissions,session)};analysisChartRange=null;analysisRankWindow=null;if(sessionChanged)analysisCohortSolved=null}
  const analysis=analysisCache.value,own=analysis.own;
  $('analysisFinalScore').innerHTML=`<strong>本队最终第 ${analysis.finalRank} 名</strong><span>${own.solved} 题 · ${formatPenalty(own.penalty)} 罚时</span>`;
  renderAnalysisCohortChart(analysis,data);
  const distributionHtml=(stats,ownMinute)=>{
    if(!stats.total)return'<span class="analysis-data-main">—</span><small class="analysis-data-sub">该组无队伍</small>';
    const clampPercent=value=>Math.max(0,Math.min(100,value/data.duration*100)),rate=Math.round((stats.rate||0)*100),hasTime=Number.isFinite(stats.medianTime),q1=hasTime?clampPercent(stats.q1Time*60):0,q3=hasTime?clampPercent(stats.q3Time*60):0,mid=hasTime?clampPercent(stats.medianTime*60):0;
    const timeLabel=hasTime?`中位 ${Math.round(stats.medianTime)} 分钟；P25–P75 ${Math.round(stats.q1Time)}–${Math.round(stats.q3Time)} 分钟`:'无人通过',delta=hasTime&&Number.isFinite(ownMinute)?Math.round(ownMinute-stats.medianTime):null,deltaText=delta===null?'':` · 本队${delta===0?'与中位相同':delta<0?`早 ${Math.abs(delta)} 分钟`:`晚 ${delta} 分钟`}`;
    return`<span class="analysis-data-main">${stats.solved} / ${stats.total}（${rate}%）</span><small class="analysis-data-sub">中位 ${formatAnalysisMinutes(stats.medianTime)} · P25–P75 ${hasTime?`${Math.round(stats.q1Time)}–${Math.round(stats.q3Time)} 分钟`:'—'}${deltaText}</small><div class="analysis-mini-charts"><div class="analysis-mini-row" title="通过率 ${rate}%"><em>通过</em><span class="analysis-mini-track analysis-mini-rate"><i style="width:${rate}%"></i></span></div><div class="analysis-mini-row" title="${timeLabel}${deltaText}"><em>时间</em><span class="analysis-mini-track analysis-mini-time${hasTime?'':' empty'}">${hasTime?`<i style="left:${q1}%;width:${Math.max(1,q3-q1)}%"></i><b style="left:${mid}%"></b>`:''}</span></div></div>`;
  };
  $('analysisProblems').innerHTML=analysis.problemStats.map(item=>{
    const accepted=item.cell?.accepted!==null&&item.cell?.accepted!==undefined,attempts=item.cell?.attempts||0;
    const counts=item.ownSubmissionCounts,result=accepted?'AC':counts.pending?'待判':attempts||counts.compileError?'未通过':'未提交',ownMinute=accepted?contestMinute(item.cell.accepted):null,solveText=accepted?`${ownMinute} 分钟`:'—';
    const wrongText=accepted?`${attempts} 次计罚错误`:attempts?`${attempts} 次错误 · 未计入罚时`:'0 次错误';
    const compileText=counts.compileError?` · CE ${counts.compileError}（不计罚）`:'',awardInfo=item.awardTier;
    return`<tr><td><span class="analysis-problem-wrap"><span class="analysis-problem-badge"${problemBadgeStyle(item.problem)}>${escapeHtml(item.problem.label)}</span>${problemAwardIcon(awardInfo)}</span></td><td><span class="analysis-own-result ${accepted?'accepted':counts.pending?'pending':''}">${result}</span><span class="analysis-own-time">${solveText}</span><small class="analysis-data-sub">${wrongText}${compileText}</small></td><td>${distributionHtml(item.allDistribution,ownMinute)}</td><td>${distributionHtml(item.sameDistribution,ownMinute)}</td><td>${distributionHtml(item.moreDistribution,ownMinute)}</td></tr>`;
  }).join('');
  analysisCache.rendered=true;
}

const badgeColorCache=new Map();
function parseBadgeColor(value,native=true){
  if(typeof value!=='string'||!value.trim()||value.length>200)return null;
  const input=value.trim();
  if(badgeColorCache.has(input))return badgeColorCache.get(input);
  let result=null;
  if(/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(input)){
    let hex=input.slice(1);if(hex.length<=4)hex=[...hex].map(char=>char+char).join('');
    result={css:input,rgb:[0,2,4].map(index=>parseInt(hex.slice(index,index+2),16)),alpha:hex.length===8?parseInt(hex.slice(6,8),16)/255:1};
  }
  const functional=input.match(/^rgba?\(([^()]*)\)$/i);
  if(!result&&functional){
    const parts=functional[1].trim().split(/[\s,/]+/),number=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/;
    if([3,4].includes(parts.length)&&parts.every(part=>number.test(part))){
      const channel=(part,max)=>Math.min(max,Math.max(0,part.endsWith('%')?parseFloat(part)/100*max:parseFloat(part)));
      const rgb=parts.slice(0,3).map(part=>channel(part,255)),alpha=parts.length===4?channel(parts[3],1):1;
      result={css:`rgba(${rgb.join(',')},${alpha})`,rgb,alpha};
    }
  }
  // Let the browser resolve named colors and HSL. Common dataset formats above
  // need no DOM reads; cache the uncommon native conversions as well.
  if(!result&&native&&typeof CSS!=='undefined'&&CSS.supports('color',input)&&!/(?:var|env)\(|^(?:inherit|initial|unset|revert(?:-layer)?|currentcolor)$/i.test(input)){
    const probe=document.createElement('span');probe.style.color=input;probe.style.display='none';document.body.appendChild(probe);
    const computed=getComputedStyle(probe).color;probe.remove();
    const parsed=parseBadgeColor(computed,false);
    result=parsed?{...parsed,css:input}:{css:input,rgb:null,alpha:1};
  }
  if(native){if(badgeColorCache.size>=256)badgeColorCache.clear();badgeColorCache.set(input,result)}
  return result;
}

function problemBadgeColors(background){
  const parsed=parseBadgeColor(background);
  if(!parsed?.rgb)return{foreground:'#111',border:'#c9cdd1'};
  const rgb=parsed.rgb.map(value=>Math.round(value*parsed.alpha+255*(1-parsed.alpha)));
  // Match DOMjudge Utils::hexToForegroundAndBorder: choose black or white by APCA contrast.
  const luminance=color=>.2126*(color[0]/255)**2.4+.7152*(color[1]/255)**2.4+.0722*(color[2]/255)**2.4;
  const bgLuminance=luminance(rgb),contrast=foreground=>{
    const fgLuminance=luminance(foreground);
    const value=(bgLuminance>fgLuminance?(bgLuminance**.56-fgLuminance**.57):(bgLuminance**.65-fgLuminance**.62))*114;
    return Math.sign(value)*Math.round(Math.abs(value)*100)/100;
  };
  const foreground=Math.abs(contrast([0,0,0]))>Math.abs(contrast([255,255,255]))?'#000000':'#ffffff';
  const border='#'+rgb.map(value=>Math.max(value-64,0).toString(16).padStart(2,'0')).join('');
  return{foreground,border};
}

function problemBadgeStyle(problem){
  const color=parseBadgeColor(problem?.badge?.background_color);
  if(!color)return'';
  const {foreground,border}=problemBadgeColors(color.css);
  return` style="--badge:${escapeHtml(color.css)};--badge-fg:${foreground};--badge-border:${border}"`;
}

function renderHome(data,session,result,rankLabel,ownRow){
  if(!ownRow)return;
  ownRow.displayRankLabel=rankLabel;
  patchHtml($('homeThead'),`<tr><th class="rank">RANK</th><th class="team">TEAM</th><th class="score" colspan="2">SCORE</th>${data.problems.map(problem=>`<th class="problem"><span${problemBadgeStyle(problem)}>${escapeHtml(problem.label)}</span></th>`).join('')}</tr>`);
  patchHtml($('homeTbody'),`<tr class="own starred"><td class="rank" title="按正式队伍成绩估算的最高名次">${escapeHtml(rankLabel)}</td><td class="team"><strong><span class="star-mark">★ </span>${escapeHtml(ownRow.name)}</strong><small>${escapeHtml(ownRow.organization)}</small></td><td class="solved">${ownRow.solved}</td><td class="penalty">${ownRow.penalty}</td>${data.problems.map(problem=>`<td class="problem">${cellHtml(ownRow,problem,result.firstSolve)}</td>`).join('')}</tr>`);
  renderHomeSubmissions(data,session,result.time);
}

function renderHomeSubmissions(data,session,time=Math.min(data.duration,Math.max(0,effectiveElapsed()))){
  const labels=new Map(data.problems.map(problem=>[problem.label.toUpperCase(),problem]));
  const rows=state.submissions.filter(row=>row.status!=='send_cancelled').map(submission=>({...submission,contestTime:submissionContestTime(submission,session)})).filter(submission=>isLocalSendAttempt(submission)||Number.isFinite(submission.contestTime)&&submission.contestTime>=0&&(submission.from_submit||submission.contestTime<data.duration&&submission.contestTime<=time)).sort((a,b)=>b.contestTime-a.contestTime||String(b.id).localeCompare(String(a.id)));
  patchHtml($('homeSubmissions'),rows.map(submission=>{
    const problem=labels.get(String(submission.problem).toUpperCase()),status=statusType(submission.status),rawStatus=String(submission.status||'').toLowerCase();
    const remoteId=submission.qoj_id||(/^\d+$/.test(submission.id)?submission.id:null),submissionUrl=remoteId?new URL('/submission/'+remoteId,session.qoj_url).href:'';
    const sourceButton=submissionSourceButton(submission);
    const badge=`<span class="submission-problem"${problemBadgeStyle(problem)}>${escapeHtml(problem?.label||submission.problem)}</span>`;
    if(isLocalSendAttempt(submission)){
      const key=rejudgeKey(session,submission.id),attempt=sendAttemptState(submission,serverNow());
      const busy=rejudgeUi.active.has(key)||Boolean(submission.rejudge_id);
      const message=submissionMessage(rejudgeUi.errors.get(key),attempt.message);
      const canRetry=maySubmit()&&['send_uncertain','send_failed'].includes(attempt.kind);
      const button=canRetry||busy?` <button class="secondary compact rejudge-button" type="button" data-rejudge-id="${escapeHtml(submission.id)}" title="Check QOJ and resend the saved source if needed" ${busy?'disabled':''}>Rejudge</button>`:'';
      return`<tr><td>—</td><td>${badge}</td><td><span class="submission-result ${busy?'sending':attempt.kind}" title="${escapeHtml(message)}">${busy?(submission.rejudge_id&&rawStatus==='sending'?'RESENDING…':'CHECKING QOJ…'):attempt.label}</span>${button}<small class="submission-time-note rejudge-note" title="${escapeHtml(message)}">${escapeHtml(message)}</small></td><td><div class="submission-actions">—${sourceButton}</div></td></tr>`;
    }
    const time=submission.time_provisional?'—':formatSeconds(submission.contestTime);
    const pendingTime=submission.time_provisional&&rawStatus!=='send_failed'?'<small class="submission-time-note">Awaiting QOJ time</small>':'';
    const waitingSync=['pending','awaiting_sync'].includes(rawStatus)&&!state.archiveId&&(state.syncHealth?.error||state.syncReadError);
    const verdictText=waitingSync?'AWAITING SYNC':submissionVerdict(submission);
    const resultNote=waitingSync?'<small class="submission-time-note">Awaiting QOJ result</small>':'';
    const message=waitingSync?submissionMessage(state.syncHealth?.error||state.syncReadError,'Waiting for QOJ results to sync.'):['pending','awaiting_sync'].includes(rawStatus)?submissionMessage(submission.message,'Waiting for the QOJ verdict.'):'';
    return`<tr><td>${time}${pendingTime}</td><td>${badge}</td><td><span class="submission-result ${status} ${rawStatus}" title="${escapeHtml(message)}">${escapeHtml(verdictText)}</span>${resultNote}</td><td><div class="submission-actions">${submissionUrl?`<a class="submission-link" href="${escapeHtml(submissionUrl)}" target="_blank" rel="noopener">#${escapeHtml(remoteId)}</a>`:'—'}${sourceButton}</div></td></tr>`;
  }).join('')||'<tr><td class="submission-empty" colspan="4">No submissions yet</td></tr>');
}

function submissionSourceButton(row){
  return mayReadSource()?`<button class="submission-source-button" data-submission-id="${escapeHtml(row.id)}" type="button" aria-label="View source for ${escapeHtml(row.problem)}" title="View source"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 12l-3 3 3 3m6-6 3 3-3 3"/></svg></button>`:'';
}
function submissionMessage(value,fallback=''){
  const text=String(value||'').trim();
  if(!text||!/[\u3400-\u9fff]/u.test(text))return text||fallback;
  if(/restart the scoreboard service|榜单服务需要更新|榜单服务仍在运行旧版本/i.test(text))return'Restart the scoreboard service, then refresh this page.';
  if(/没有保存原源码|选择(?:这次提交的)?原始源码|选择这次提交的原始文件/.test(text))return'Original source not saved. Click Rejudge again to select the original file.';
  if(/未开放局域网提交|关闭局域网提交/.test(text))return'LAN submissions are disabled by the host.';
  if(/比赛已结束/.test(text))return'The contest has ended. No code was sent.';
  if(/比赛尚未开始/.test(text))return'The contest has not started. No code was sent.';
  if(/限流|HTTP 429/.test(text))return'QOJ rate limit reached. Try again later.';
  if(/安全验证|访问验证/.test(text))return'Complete QOJ verification in the host browser, then try again.';
  if(/查看权限|未提供可查看/.test(text))return'This source is not available to the host QOJ account.';
  if(/原 QOJ 账号|登录|账号已变化/.test(text))return'Check the QOJ account signed in on the host browser.';
  if(/原编译器/.test(text))return'Could not verify the original compiler. Select it in Submit.';
  if(/重新加载主机的 QOJ 扩展|扩展未连接/.test(text))return'Reload the QOJ extension in the host browser, then refresh this page.';
  if(/多条相同|已关联另一条|匹配不唯一/.test(text))return'More than one submission could match. Check QOJ before resending.';
  if(/还没更新|30 秒后/.test(text))return'QOJ may still be updating. Check again after 30 seconds.';
  if(/核对未完成|未覆盖原发送|无法安全重发|无法读取源码核对/.test(text))return'Could not verify the original submission. No code was resent.';
  if(/连接中断|连接超时|网络|Failed to fetch/i.test(text))return'Connection interrupted. The QOJ receipt could not be confirmed.';
  if(/保存的.*源码|source does not match|No saved source/i.test(text))return'The saved source is missing or does not match. No code was sent.';
  const http=text.match(/HTTP \d{3}/);if(http)return`QOJ request failed (${http[0]}).`;
  return fallback;
}
function sendAttemptState(row,now){
  if(row.status==='send_failed')return{label:'SUBMISSION FAILED',kind:'send_failed',message:submissionMessage(row.message,'Code was not sent to QOJ.')};
  if(row.status==='queued')return{label:'QUEUED',kind:'sending',message:'Waiting for the host extension.'};
  if(row.status==='sending'&&now-Number(row.send_started_at_ms||row.submitted_at_ms)<=120000){
    return{label:'SENDING',kind:'sending',message:'Waiting for the QOJ receipt.'};
  }
  return{label:'UNCONFIRMED',kind:'send_uncertain',message:submissionMessage(row.message,'No QOJ receipt. Use Rejudge to check.')};
}
function medalNoticeText(data){
  const groups=Object.entries(medalGroups(data)).filter(([,counts])=>counts&&['gold','silver','bronze'].some(key=>Number(counts[key])>0));
  const source=data.medalInfo?.source,suffix=source==='preset'?'（自动计算）':source==='estimated'?'（自动估算）':'';
  if(groups.length)return`奖牌：${groups.map(([group,counts])=>`${group==='official'?'正式组':group==='vocation'?'高职组':group} 金${counts.gold||0}/银${counts.silver||0}/铜${counts.bronze||0}`).join('；')}${suffix}`;
  return source==='unsupported'?'奖牌：未识别配置':data.medalInfo?.eligibleTeams?'奖牌：暂无有效队伍':'奖牌：未设置';
}

function medalNoticeTitle(data){
  const info=data.medalInfo;
  if(!info?.eligibleTeams)return info?.source==='unsupported'?'数据源的奖牌配置无法识别。':info?.source==='config'?'使用数据源指定的各档奖牌数量，依次累加为名次范围。':'数据源未设奖牌，或本赛事不适用区域赛的默认奖牌比例。';
  const totals=[...info.eligibleTeams].map(([group,teams])=>`${group==='vocation'?'高职组':'正式组'} ${teams.size} 队`).join('；');
  const rule=info.rule==='icpc'?'金牌为有效队伍的 10% 向上取整，银牌、铜牌分别为金牌数量的 2 倍、3 倍（不超过有效队伍总数）。':'金、金银合计、金银铜合计分别为有效队伍的 10%、30%、60% 向上取整。';
  return`${info.source==='estimated'?'缺少具体配额，按常用区域赛规则估算；实际奖项以主办方为准。':'按数据源的 '+info.rule.toUpperCase()+' 奖牌预设计算。'}${rule}有效队伍：原始完整比赛记录中${info.basis==='submitted'?'至少提交一次':'至少通过一题'}的正式队伍，排除打星队与本队 VP；${totals}。`;
}

function qojSyncText(){
  const pending=state.submissions.filter(row=>row.status==='pending').length;
  if(state.archiveId)return`QOJ 历史记录 · ${state.submissions.length} submissions`;
  if(state.syncReadError)return'本地服务连接中断，正在重试 · 已保留现有成绩';
  if(state.syncHealth?.error)return`QOJ 同步失败：${state.syncHealth.error} · 已保留现有成绩`;
  const observed=Number(state.syncHealth?.observed_at_ms),age=Number.isFinite(observed)?Math.max(0,Math.floor((serverNow()-observed)/1000)):Infinity;
  const submitBridge=state.canManage?(document.documentElement.dataset.xcpcSubmitBridge==='1'?' · 网页提交已连接':' · 网页提交未连接'):'';
  const detail=`${state.submissions.length} submissions${pending?' · '+pending+' pending':''}${submitBridge}`;
  if(!Number.isFinite(observed))return`未收到扩展同步 · ${detail} · 请在装有扩展且已登录 QOJ 的浏览器中刷新本页`;
  return age<=8?`QOJ 已连接 · ${detail}`:age<=30?`QOJ 同步延迟 ${age}s · ${detail} · 已保留现有成绩`:`QOJ 同步中断 · ${detail} · 已保留现有成绩`;
}

function boardRefreshInterval(teamCount=state.data?.teams?.length||0){
  return teamCount>=1200?10_000:teamCount>=600?7_000:5_000;
}

const virtualTeamThreshold=400;
function largeScoreboard(){return(state.data?.teams?.length||0)>=virtualTeamThreshold}

function patchHtml(element,html){
  if(element.__xcpcHtml===html)return;
  element.innerHTML=html;element.__xcpcHtml=html;
}

function scoreboardRowSignature(row,problems,result,session){
  const cells=problems.map(problem=>{
    const cell=row.states.get(problem.id),ownLabel=row.id===ownId&&session.mode==='ccpc'&&!result.visible.has(problem.id);
    return`${problem.id}:${cell?.attempts??''}:${cell?.pending??''}:${cell?.accepted??''}:${cell?.frozen??''}:${cell?.first??''}:${result.firstSolve.get(problem.id)===row.id?1:0}:${ownLabel?1:0}`;
  }).join(';');
  return`${row.displayRankLabel}|${row.solved}|${row.penalty}|${row.medalRank??''}|${row.starred?1:0}|${cells}`;
}

function prepareScoreboardRow(row,data,result,session){
  const problems=session.mode==='ccpc'&&result.time<result.freeze?problemOrder(row,data,result.visible):data.problems;
  const signature=scoreboardRowSignature(row,problems,result,session);
  let node=scoreboardRows.get(row.id);
  if(!node){node=document.createElement('tr');node.dataset.teamId=row.id;scoreboardRows.set(row.id,node)}
  if(node.__xcpcSignature!==signature){
    const rank=row.displayRankLabel,rankTitle=row.starred?'打星队伍，不计正式名次':'完整榜单中的正式名次';
    node.className=`${row.id===ownId?'own':''} ${row.starred?'starred':''}`;
    node.innerHTML=`<td class="rank" title="${rankTitle}">${medal(data,row)}${escapeHtml(rank)}</td><td class="team"><strong>${row.starred?'<span class="star-mark" title="打星队伍，不占正式队伍奖牌名额">★ </span>':''}${escapeHtml(row.name)}</strong><small>${escapeHtml(row.organization)}</small></td><td class="solved">${row.solved}</td><td class="penalty">${formatPenalty(row.penalty)}</td>${problems.map(problem=>`<td class="problem">${cellHtml(row,problem,result.firstSolve,row.id===ownId&&session.mode==='ccpc'&&!result.visible.has(problem.id))}</td>`).join('')}`;
    node.__xcpcSignature=signature;
  }
  return node;
}

function virtualSpacer(kind,height,colspan){
  let node=kind==='top'?virtualTopSpacer:virtualBottomSpacer;
  if(!node){
    node=document.createElement('tr');node.className=`virtual-spacer virtual-${kind}`;
    node.appendChild(document.createElement('td'));
    if(kind==='top')virtualTopSpacer=node;else virtualBottomSpacer=node;
  }
  node.firstElementChild.colSpan=colspan;
  node.firstElementChild.style.height=`${Math.max(0,height)}px`;
  return node;
}

function patchScoreboardRows(rows,data,result,session,virtualOnly=false){
  const tbody=$('tbody'),identity=session.session_id||`${session.path}:${session.created_at_ms}`;
  if(identity!==scoreboardIdentity){scoreboardIdentity=identity;scoreboardRows.clear();tbody.replaceChildren();virtualTopSpacer=null;virtualBottomSpacer=null}
  if(!rows.length){
    virtualBoardState=null;tbody.dataset.totalRows='0';
    patchHtml(tbody,`<tr><td class="empty" colspan="${data.problems.length+4}">没有匹配的队伍</td></tr>`);
    return;
  }
  const virtual=rows.length>=virtualTeamThreshold;
  if(virtual&&!virtualOnly)virtualBoardState={rows,data,result,session,tableTop:tbody.getBoundingClientRect().top+window.scrollY,rangeKey:''};
  if(!virtual)virtualBoardState=null;
  tbody.dataset.totalRows=String(rows.length);
  let shownRows=rows,topHeight=0,bottomHeight=0;
  if(virtual&&typeof window!=='undefined'){
    const rowHeight=56,overscan=20,batchSize=40,tbodyTop=virtualBoardState?.tableTop??(tbody.getBoundingClientRect().top+window.scrollY);
    const relativeTop=Math.max(0,window.scrollY-tbodyTop);
    const firstVisible=Math.floor(relativeTop/rowHeight),visibleCount=Math.ceil(window.innerHeight/rowHeight);
    const start=Math.min(Math.floor(Math.max(0,firstVisible-overscan)/batchSize)*batchSize,Math.max(0,rows.length-visibleCount-overscan));
    const end=Math.min(rows.length,start+visibleCount+overscan*2+batchSize);
    const rangeKey=`${start}:${end}`;
    if(virtualOnly&&virtualBoardState?.rangeKey===rangeKey)return;
    if(virtualBoardState)virtualBoardState.rangeKey=rangeKey;
    shownRows=rows.slice(start,end);topHeight=start*rowHeight;bottomHeight=(rows.length-end)*rowHeight;
  }
  tbody.__xcpcHtml=null;
  const desired=[];
  if(topHeight)desired.push(virtualSpacer('top',topHeight,data.problems.length+4));
  for(const row of shownRows){
    desired.push(prepareScoreboardRow(row,data,result,session));
  }
  if(bottomHeight)desired.push(virtualSpacer('bottom',bottomHeight,data.problems.length+4));
  const keep=new Set(desired);let cursor=tbody.firstElementChild;
  for(const node of desired){
    if(node===cursor)cursor=cursor.nextElementSibling;
    else tbody.insertBefore(node,cursor);
  }
  for(const node of [...tbody.children])if(!keep.has(node))node.remove();
  if(data.teams.length>=virtualTeamThreshold&&scoreboardRows.size>240){
    const visibleIds=new Set(shownRows.map(row=>row.id));
    for(const id of scoreboardRows.keys()){
      if(scoreboardRows.size<=240)break;
      if(!visibleIds.has(id))scoreboardRows.delete(id);
    }
  }
}

function requestRender(){
  if(!pageIsVisible()||renderFrame||resumeTimer||resumeRefresh)return;
  renderFrame=requestAnimationFrame(()=>{renderFrame=0;if(!resumeTimer&&!resumeRefresh)render()});
}

function renderMatchMetadata(data,session){
  const medalText=medalNoticeText(data),syncText=qojSyncText();
  $('medalNotice').textContent=medalText;
  $('medalNotice').title=medalNoticeTitle(data);
  $('homeModeLabel').textContent=matchModeLabel(session);
  $('homeMedalNotice').textContent=medalText;
  $('homeMedalNotice').title=$('medalNotice').title;
  $('homeQojStatus').textContent=syncText;
  $('homeQojStatus').href=session.qoj_url;
  $('homeQojStatus').parentElement.classList.toggle('hidden',!state.canManage);
}

function render(){
  if(!pageIsVisible())return;
  $('submitBtn')?.classList.toggle('hidden',!maySubmit());
  updateSubmitAvailability();
  $('homeNav').classList.toggle('hidden',!mayView('home'));
  const analysisAvailable=mayView('analysis')&&Boolean(state.session?.revealed_at_ms);
  $('analysisNav').classList.toggle('hidden',!analysisAvailable);
  if(state.view==='home'&&!mayView('home')||state.view==='analysis'&&!analysisAvailable)switchMatchView('scoreboard');
  syncSubmissionDialogs();
  if(state.screen!=='match'||!state.data||!state.session)return;
  const quietFor=scrollQuietUntil-performance.now();
  if(state.view==='scoreboard'&&largeScoreboard()&&quietFor>0){
    if(!deferredRenderTimer)deferredRenderTimer=setTimeout(()=>{deferredRenderTimer=0;requestRender()},Math.ceil(quietFor)+20);
    return;
  }
  if(deferredRenderTimer){clearTimeout(deferredRenderTimer);deferredRenderTimer=0}
  const data=state.data,session=state.session,elapsed=effectiveElapsed();
  renderMatchMetadata(data,session);
  if(state.view!=='scoreboard')lastStandingsView=null;
  if(state.view==='analysis'){
    renderAnalysis(data,session);
    lastBoardRenderAt=performance.now();
    return;
  }
  const {result,ownLive,revision}=liveStandings(data,state.history,state.submissions,session,elapsed);
  const ownRow=ownLive||result.ordered.find(row=>row.id===ownId);
  if(state.view==='home'){
    renderHome(data,session,result,ownRow?`*(${projectedOfficialRank(result.ordered,ownRow)})`:'*',ownRow);
    lastBoardRenderAt=performance.now();
    return;
  }
  const filter=$('search').value.trim().toLowerCase(),group=$('groupFilter').value;
  if(lastStandingsView?.revision===revision&&lastStandingsView.filter===filter&&lastStandingsView.group===group){lastBoardRenderAt=performance.now();return}
  const displayRows=ownLive?result.ordered.map(row=>row.id===ownId?ownLive:row).sort(compareRows):result.ordered;
  let totalRank=0;
  for(const row of displayRows)row.displayRankLabel=row.starred?'*':String(++totalRank);
  if(ownRow)ownRow.displayRankLabel=`*(${projectedOfficialRank(result.ordered,ownRow)})`;
  const visibleProblems=data.problems.filter(p=>result.visible.has(p.id));
  const headings=session.mode==='ccpc'&&result.time<result.freeze?[...visibleProblems,...Array(data.problems.length-visibleProblems.length).fill(null)]:data.problems;
  patchHtml($('thead'),`<tr><th class="rank">RANK</th><th class="team">TEAM</th><th class="score" colspan="2">SCORE</th>${headings.map(p=>`<th class="problem"><span class="${p?'':'unknown'}"${problemBadgeStyle(p)}>${escapeHtml(p?.label||'?')}</span></th>`).join('')}</tr>`);
  const matchesFilter=row=>{
    if(group==='own'&&row.id!==ownId)return false;
    if(group!=='all'&&group!=='own'&&!row.group.includes(group))return false;
    return !filter||(row.name+' '+row.organization).toLowerCase().includes(filter);
  };
  const filtered=displayRows.filter(matchesFilter),filteredPublic=ownLive?result.ordered.filter(matchesFilter):filtered;
  patchScoreboardRows(filtered,data,result,session);
  patchHtml($('statsFoot'),`<tr class="stats-row"><th colspan="4">SUMMARY</th>${headings.map(p=>{
    if(!p)return'<td class="stats-hidden"></td>';
    let solved=0,wrong=0,pending=0,first=Infinity;
    for(const row of filteredPublic){
      const cell=row.states.get(p.id);if(!cell)continue;
      if(cell.accepted!==null){solved++;first=Math.min(first,cell.accepted)}
      wrong+=cell.attempts;pending+=cell.pending+(cell.frozen||0);
    }
    return`<td class="problem stats-cell"><div title="通过队伍数">✓ ${solved}</div><div title="错误提交数">✕ ${wrong}</div><div title="待判或封榜提交数">? ${pending}</div><div title="首解时间">◷ ${Number.isFinite(first)?contestMinute(first)+' min':'n/a'}</div></td>`;
  }).join('')}</tr>`);
  $('contestPhase').textContent=session.revealed_at_ms?'最终榜单已公布':state.archiveId?(result.time>=data.duration?'历史比赛 · 榜单待公布':result.frozen?'历史比赛 · 榜单封榜中':'历史比赛 · 比赛进行中'):result.time>=data.duration?'比赛结束 · 榜单待解冻':result.frozen?'榜单封榜中':'比赛进行中';
  $('revealBtn').classList.toggle('hidden',!state.canManage||Boolean(session.revealed_at_ms)||result.time<data.duration);
  $('boardSummary').textContent=`${filtered.length} / ${displayRows.length} teams · ${data.problems.length} problems`+(session.mode==='ccpc'&&result.time<result.freeze?` · ${visibleProblems.length} problem labels released`:'');
  $('boardRuleNote').textContent=(session.scenario==='adjusted'?'减弱开题提示训练情景 · ':'')+'成绩按提交时刻计分，待判结果在同步后更新。';
  lastStandingsView={revision,filter,group};
  lastBoardRenderAt=performance.now();
}

function tickClock(){
  updateSubmitAvailability();
  if(state.screen==='waiting'||state.screen==='scheduled')return;
  if(!state.session)return;
  const duration=state.data?.duration||0,elapsed=effectiveElapsed();
  $('topClock').textContent=`${formatSeconds(Math.min(duration,Math.max(0,elapsed)))} / ${formatSeconds(duration)}`;
}
function scheduleClockTick(){
  if(clockTickTimer)clearTimeout(clockTickTimer);clockTickTimer=0;
  if(!pageIsVisible())return;
  tickClock();
  let delay=250;
  if(state.session&&!state.archiveId){
    const anchor=Number(state.session.clock_start_at_ms||state.session.start_at_ms),phase=((serverNow()-anchor)%1000+1000)%1000;
    delay=Math.max(25,1005-phase);
  }
  clockTickTimer=setTimeout(scheduleClockTick,delay);
}
function effectiveElapsed(){
  if(state.archiveId){
    const saved=Number(state.session.archived_elapsed_seconds||0),anchor=Number(state.session.clock_start_at_ms||state.session.start_at_ms);
    return Math.max(saved,(serverNow()-anchor)/1000);
  }
  return state.debug.enabled&&state.debug.elapsed_seconds!==null?state.debug.elapsed_seconds:(serverNow()-Number(state.session.clock_start_at_ms||state.session.start_at_ms))/1000;
}

const seriesName={icpc:'ICPC',ccpc:'CCPC','provincial-contest':'省赛',invitational:'邀请赛',camp:'集训营',imported:'其他比赛'};
const scenarioName=scenario=>scenario==='adjusted'?'减弱开题提示':'原始记录重放';
const matchModeLabel=session=>(session.mode==='ccpc'?'CCPC 新赛制':'ICPC 赛制')+(session.scenario==='adjusted'?' · 减弱开题提示':'');
const browseSeriesOf=c=>c.browse_series||((/邀请/.test(c.name)||/invitational/i.test(c.path))?'invitational':c.series);
const inferredSeasonYear=contest=>{
  const ordinal=String(contest.season||'').match(/^(\d+)(?:st|nd|rd|th)$/i);
  if(ordinal&&contest.series==='icpc')return 1975+Number(ordinal[1]);
  if(ordinal&&contest.series==='ccpc')return 2014+Number(ordinal[1]);
  if(/^20\d{2}$/.test(String(contest.season||'')))return Number(contest.season);
  return Number(contest.year)||null;
};
const catalogGroupKey=contest=>String(contest.season_year||inferredSeasonYear(contest)||'未标赛季');
const catalogGroupLabel=key=>/^\d{4}$/.test(String(key))?`${key} 赛季`:String(key);
const catalogItems=()=>{
  const known=new Set(state.catalog.map(c=>c.path));
  const local=state.localContests.filter(c=>!known.has(c.path)).map(c=>{const parts=c.path.split('/'),season=c.season||String(c.season_year||parts[1]||''),series=c.series||(parts[0]==='imports'?'imported':parts[0]),stub={...c,name:nameOf(c.name),series,season,year:/^\d{4}$/.test(season)?Number(season):null,start_at_ms:0};return{...stub,season_year:c.season_year||inferredSeasonYear(stub)}});
  return[...state.catalog,...local];
};
function updateSource(){
  const path=$('contestSelect').value,link=$('sourceLink');
  const selected=state.catalog.find(c=>c.path===path)||state.localContests.find(c=>c.path===path);
  $('chosenContest').classList.toggle('hidden',!selected);
  $('chosenContest').innerHTML=selected?`<strong>${escapeHtml(selected.name)}</strong><small>${escapeHtml(path)}</small>`:'';
  const imported=selected?.kind==='import';
  const source=imported?'/api/contest?path='+encodeURIComponent(path):path?sourceUrl(path):'#';
  link.previousElementSibling.textContent=imported?`本地导入 · ${selected.format_name||selected.format}`:'原始数据';
  link.textContent=imported?'查看已导入的数据':path?source:'请选择比赛';link.href=source;
  renderCatalog();
}
async function refreshContests(){
  state.localContests=await api('/api/contests');
  updateSource();
}
function renderCatalog(){
  const search=$('catalogSearch').value.trim().toLowerCase();
  const local=new Set(state.localContests.map(c=>c.path));
  const catalog=catalogItems(),series=state.browseSeries,year=state.browseYear;
  $('catalogBack').classList.toggle('hidden',state.catalogStep==='series'||Boolean(search));
  $('catalogSearchWrap').classList.remove('hidden');
  const groupLabel=year&&catalogGroupLabel(year);
  $('catalogTitle').textContent=search?'搜索赛事':state.catalogStep==='series'?'选择赛事系列':state.catalogStep==='year'?`${seriesName[series]||series} · 选择赛季`:`${seriesName[series]||series} · ${groupLabel}`;
  $('catalogBreadcrumb').textContent=['系列',series&&seriesName[series],groupLabel].filter(Boolean).join(' › ');
  const suffix=state.catalogLoading?' · 正在获取赛事目录…':state.catalogError?' · '+state.catalogError:state.catalogStale?' · 目录更新失败，使用上次获取的目录':state.catalog.length?' · xcpcio 动态目录':state.localContests.length?' · 仅显示已下载比赛':'';
  if(state.catalogError&&!catalog.length){$('catalogStatus').textContent=state.catalogError;$('catalogList').innerHTML='';return}
  if(search){
    const matching=catalog.filter(c=>(`${c.name} ${c.path} ${c.season||''} ${catalogGroupLabel(catalogGroupKey(c))}`).toLowerCase().includes(search));
    $('catalogBreadcrumb').textContent=`全部赛事 › 搜索“${$('catalogSearch').value.trim()}”`;
    $('catalogStatus').textContent=`找到 ${matching.length} 场比赛${suffix}`;
    $('catalogList').innerHTML=matching.map(c=>{
      const selected=c.path===$('contestSelect').value,downloaded=local.has(c.path),label=selected?'已选中':downloaded?'选择这场':'下载并选择';
      return`<article class="catalog-item ${selected?'selected':''}"><div class="catalog-item-main"><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(seriesName[browseSeriesOf(c)]||browseSeriesOf(c))} · ${escapeHtml(catalogGroupLabel(catalogGroupKey(c)))} · ${escapeHtml(c.season||'')} · ${escapeHtml(c.path)}</small></div><button class="secondary" type="button" data-contest-path="${escapeHtml(c.path)}" ${!state.canManage&&!downloaded?'disabled':''}>${label}</button></article>`;
    }).join('')||'<p class="catalog-empty">没有匹配的赛事，请尝试赛事名称、举办地、路径或届次。</p>';
    return;
  }
  if(state.catalogStep==='series'){
    const counts=new Map();for(const c of catalog){const key=browseSeriesOf(c);counts.set(key,(counts.get(key)||0)+1)}
    const order=['icpc','ccpc','provincial-contest','invitational','camp'];
    const entries=[...counts].sort((a,b)=>(order.includes(a[0])?order.indexOf(a[0]):order.length)-(order.includes(b[0])?order.indexOf(b[0]):order.length));
    $('catalogStatus').textContent=`${catalog.length} 场比赛${suffix}`;
    $('catalogList').innerHTML=entries.map(([key,count])=>`<button class="catalog-level" type="button" data-series="${escapeHtml(key)}"><strong>${escapeHtml(seriesName[key]||key)}</strong><span>${count} 场 ›</span></button>`).join('');
    return;
  }
  const inSeries=catalog.filter(c=>browseSeriesOf(c)===series);
  if(state.catalogStep==='year'){
    const counts=new Map();for(const c of inSeries){const key=catalogGroupKey(c);counts.set(key,(counts.get(key)||0)+1)}
    const years=[...counts].sort((a,b)=>(parseInt(b[0],10)||-Infinity)-(parseInt(a[0],10)||-Infinity)||String(b[0]).localeCompare(String(a[0])));
    $('catalogStatus').textContent=`${inSeries.length} 场比赛${suffix}`;
    $('catalogList').innerHTML=years.map(([key,count])=>`<button class="catalog-level" type="button" data-year="${escapeHtml(key)}"><strong>${escapeHtml(catalogGroupLabel(key))}</strong><span>${count} 场 ›</span></button>`).join('');
    return;
  }
  const matching=inSeries.filter(c=>catalogGroupKey(c)===String(year));
  $('catalogStatus').textContent=`找到 ${matching.length} 场比赛${suffix}`;
  $('catalogList').innerHTML=matching.map(c=>{
    const selected=c.path===$('contestSelect').value,downloaded=local.has(c.path);
    const label=selected?'已选中':downloaded?'选择这场':'下载并选择';
    return`<article class="catalog-item ${selected?'selected':''}"><div class="catalog-item-main"><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.season||'')} · ${escapeHtml(c.path)}</small></div><button class="secondary" type="button" data-contest-path="${escapeHtml(c.path)}" ${!state.canManage&&!downloaded?'disabled':''}>${label}</button></article>`;
  }).join('')||'<p class="catalog-empty">没有匹配的比赛，试试更短的关键词或其他年份。</p>';
}
async function refreshCatalog(force=false){
  if(state.catalogLoading)return;
  state.catalogLoading=true;state.catalogError='';$('catalogRefresh').disabled=true;renderCatalog();
  try{
    const result=await api('/api/catalog'+(force?'?refresh=1':''));
    state.catalog=result.contests||[];state.catalogStale=Boolean(result.stale);state.catalogError='';
    updateSource();
  }finally{state.catalogLoading=false;$('catalogRefresh').disabled=!state.canManage;renderCatalog()}
}
const contestImportUi={payload:null,preview:null,busy:false};
function renderContestImport(){
  $('contestImportFiles').disabled=contestImportUi.busy||!state.canManage;
  $('contestImportCheck').disabled=contestImportUi.busy||!state.canManage||!$('contestImportFiles').files.length;
  $('contestImportConfirm').disabled=contestImportUi.busy||!state.canManage||!contestImportUi.preview;
}
async function checkContestImport(){
  if(contestImportUi.busy||!state.canManage)return;
  contestImportUi.payload=null;contestImportUi.preview=null;contestImportUi.busy=true;
  const status=$('contestImportStatus');status.classList.remove('error');status.textContent='正在检查比赛数据…';
  $('contestImportPreview').classList.add('hidden');renderContestImport();
  try{
    const files=[...$('contestImportFiles').files];
    if(!files.length||files.length>8)throw Error('请选择 1 至 8 个比赛数据文件');
    if(files.reduce((sum,file)=>sum+file.size,0)>32*1024*1024)throw Error('上传文件总计不能超过 32 MiB');
    const encoded=await Promise.all(files.map(file=>new Promise((resolve,reject)=>{
      const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:String(reader.result).split(',')[1]});reader.onerror=()=>reject(Error('无法读取文件：'+file.name));reader.readAsDataURL(file);
    })));
    const payload={files:encoded,format:'auto'},preview=await post('/api/contests/import-preview',payload);
    contestImportUi.payload={...payload,expected_sha256:preview.sha256};contestImportUi.preview=preview;
    $('contestImportPreview').innerHTML=`<strong>${escapeHtml(preview.name)}</strong><span>${escapeHtml(preview.format_name)} · ${preview.problems} 题 · ${preview.teams} 队 · ${preview.runs} 次提交</span><small>${escapeHtml(seriesName[preview.series]||preview.series)} · ${preview.season_year} 赛季 · 时长 ${escapeHtml(formatSeconds(preview.duration_seconds))}</small>${preview.warnings?.length?`<ul>${preview.warnings.map(w=>`<li>${escapeHtml(w)}</li>`).join('')}</ul>`:''}`;
    $('contestImportPreview').classList.remove('hidden');status.textContent='检查通过，可导入并选择。';
  }catch(error){status.textContent='检查失败：'+error.message;status.classList.add('error')}
  finally{contestImportUi.busy=false;renderContestImport()}
}
async function confirmContestImport(){
  if(contestImportUi.busy||!contestImportUi.preview||!state.canManage)return;
  contestImportUi.busy=true;renderContestImport();
  const status=$('contestImportStatus');status.classList.remove('error');status.textContent='正在导入比赛…';
  try{
    const result=await post('/api/contests/import',contestImportUi.payload);
    await refreshContests();
    $('contestSelect').value=result.path;$('catalogSearch').value='';state.browseSeries=result.series;state.browseYear=String(result.season_year);state.catalogStep='contest';
    updateSource();renderVpObservation();
    status.textContent='已导入并选择，可以继续连接 QOJ。';contestImportUi.payload=null;contestImportUi.preview=null;
  }catch(error){status.textContent='导入失败：'+error.message;status.classList.add('error')}
  finally{contestImportUi.busy=false;renderContestImport()}
}
async function refreshHistory(){
  try{
    const entries=await api('/api/history');
    $('historyList').innerHTML=entries.map(entry=>`<article class="history-item"><div class="history-copy"><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(formatBeijing(entry.start_at_ms))} · ${escapeHtml(entry.mode.toUpperCase())} · ${escapeHtml(scenarioName(entry.scenario))} · QOJ #${escapeHtml(entry.qoj_contest_id||'未知')} · ${entry.submission_count} submissions</small></div><div class="history-actions"><button class="secondary compact" type="button" data-history-id="${escapeHtml(entry.id)}">查看</button>${state.canManage?`<button class="secondary compact" type="button" data-history-activate="${escapeHtml(entry.id)}" data-history-name="${escapeHtml(entry.name)}">设为当前</button><button class="history-delete" type="button" data-history-delete="${escapeHtml(entry.id)}" data-history-name="${escapeHtml(entry.name)}">删除</button>`:''}</div></article>`).join('')||'<span class="history-empty">暂无历史比赛</span>';
  }catch(error){$('historyList').innerHTML=`<span class="history-empty">历史记录读取失败：${escapeHtml(error.message)}</span>`}
}
async function refreshLanInfo(includeSettings=false){
  if(!state.canManage)return;
  try{
    const host=await api('/api/host-info');
    const urls=host.lan_urls||[];
    patchHtml($('lanInfo'),!host.lan_enabled?'未开启局域网访问；以 <code>python server.py --lan</code> 启动。':urls.length?
      urls.map(url=>`<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`).join('<br>'):
      '局域网已开启，暂未检测到可共享的 IPv4 地址。');
    if(includeSettings)renderLanSettings(host.lan_settings);
  }catch(error){patchHtml($('lanInfo'),'无法读取主机地址：'+escapeHtml(error.message))}
}
async function refreshSession(){
  const response=await readSession();state.canManage=response.can_manage;state.session=response.session;
  if(!response.can_manage)return response.session;
  $('hostBadge').textContent=response.can_manage?'主机控制台':'队友只读模式';
  for(const id of ['launchBtn','catalogRefresh'])$(id).disabled=!response.can_manage;
  renderContestImport();
  renderVpObservation();
  renderCatalog();
  if(response.session){
    const s=response.session,future=s.start_at_ms>serverNow();$('currentSession').innerHTML=`<strong>${escapeHtml(s.name)}</strong><br>${s.mode.toUpperCase()} · ${escapeHtml(scenarioName(s.scenario))} · QOJ #${escapeHtml(s.qoj_contest_id)}<br>${future?'预定于':'开始于'} ${escapeHtml(formatBeijing(s.start_at_ms))}`;
    $('connectBtn').textContent=future?'查看开赛倒计时':'进入当前榜单';$('connectBtn').disabled=false;$('archiveBtn').classList.remove('hidden');
  }else{$('currentSession').textContent='尚未启动比赛。';$('connectBtn').disabled=true;$('connectBtn').textContent='进入当前榜单';$('archiveBtn').classList.add('hidden')}
  const clock=state.clockStatus,offset=Math.round(Math.abs(Number(clock?.system_offset_ms||0))/1000);
  $('clockInfo').textContent=clock?.synchronized?`榜单时钟：标准北京时间${offset>=2?`（已校正系统偏差 ${offset} 秒）`:''}`:'榜单时钟：稳定本机时钟（暂未取得网络标准时间）';
  $('clockInfo').classList.toggle('warning',!clock?.synchronized);
  await refreshLanInfo(true);
  await refreshHistory();
  return response.session;
}
function matchingVpObservation(){
  let match=null;
  try{const url=new URL($('qojUrl').value.trim());if(url.protocol==='https:'&&['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname))match=url.pathname.match(/^\/contest\/(\d+)\/?$/)}catch{}
  const observation=state.qojObservation;
  return match&&observation?.qoj_contest_id===match[1]?observation:null;
}
function startableVpObservation(){
  const observation=matchingVpObservation();
  return observation&&['finish-confirmed','countdown'].includes(observation.source)?observation:null;
}
function renderVpObservation(){
  const observation=matchingVpObservation();
  if(!observation){$('qojObservation').textContent='尚未检测到进行中的 VP；启动后可进入等待页面。';updateLaunchLabel();return}
  if(observation.source==='not-started'){$('qojObservation').textContent='已确认这场 QOJ VP 尚未开始；点击后进入等待页面。';updateLaunchLabel();return}
  const seen=formatBeijingTime(observation.observed_at_ms);
  const liveRemaining=observation.source==='countdown'
    ?Math.max(0,observation.remaining_seconds-Math.max(0,Math.floor((serverNow()-observation.sampled_at_ms)/1000)))
    :null;
  $('qojObservation').textContent=observation.source==='finish-confirmed'
    ?`已确认 Finish 后开赛：${formatBeijing(observation.start_at_ms)}（${seen} 收到）`
    :`已识别进行中的 VP：QOJ 倒计时剩余 ${formatSeconds(liveRemaining)}，最近同步于 ${seen}；可直接连接。`;
  updateLaunchLabel();
}
function updateLaunchLabel(){
  const manual=document.querySelector('input[name=startMethod]:checked')?.value==='manual';
  const scheduled=manual&&manualStartMs()>serverNow()+1000;
  $('launchBtn').textContent=manual?(scheduled?'安排开赛并进入倒计时':'按填写时间启动榜单'):startableVpObservation()?'连接当前 QOJ VP':'等待 QOJ 开始';
}
function renderQojContestInfo(){
  let match=null,url=null;
  try{url=new URL($('qojUrl').value.trim());if(url.protocol==='https:'&&['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname))match=url.pathname.match(/^\/contest\/(\d+)\/?$/)}catch{}
  const info=state.qojContestInfo,element=$('qojContestName');
  const matched=match&&info?.qoj_contest_id===match[1];
  const bridgeVersion=document.documentElement.dataset.xcpcQojBridge;
  element.classList.toggle('verified',Boolean(matched));
  element.textContent=matched?`已识别 QOJ 比赛：${info.name}`:match?(bridgeVersion?'扩展已连接，正在核对比赛名称…':'未检测到扩展。请在 edge://extensions 刷新扩展，再刷新本页。'):'输入 QOJ 比赛地址后显示比赛名称';
  $('openQojContest').classList.toggle('hidden',!match);
  if(match)$('openQojContest').href=url.href;
}
function qojSetupUrl(){
  try{
    const url=new URL($('qojUrl').value.trim()),match=url.pathname.match(/^\/contest\/(\d+)\/?$/);
    if(url.protocol==='https:'&&['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname)&&match)return{url:new URL(`/contest/${match[1]}`,url.origin),contestId:match[1]};
  }catch{}
  return null;
}
function languageOptionsByFamily(languages){
  return Object.fromEntries(submitLanguageDefinitions.map(definition=>[
    definition.id,
    (languages||[]).filter(language=>simpleLanguageId(`${language.label} ${language.value}`)===definition.id)
  ]));
}
const qojLanguageRead={url:'',generation:0,pending:null,attempts:0,retryAt:0,error:'',bridge:null};
function syncQojLanguageTarget(){
  const current=qojSetupUrl(),url=current?.url.href||'';
  if(url!==qojLanguageRead.url){
    Object.assign(qojLanguageRead,{url,generation:qojLanguageRead.generation+1,pending:null,attempts:0,retryAt:0,error:''});
    state.qojLanguageInfo=null;renderQojLanguageSettings();
  }
  return current;
}
function renderQojLanguageSettings(){
  const bridge=document.documentElement.dataset.xcpcSubmitBridge==='1',current=qojSetupUrl(),info=state.qojLanguageInfo;
  const matched=Boolean(current&&info?.url===current.url.href),groups=languageOptionsByFamily(matched?info.languages:[]);
  $('qojLanguageGrid').innerHTML=submitLanguageDefinitions.map(definition=>{
    const options=groups[definition.id]||[],selected=matched?info.defaults?.[definition.id]||'':'';
    return`<label>${escapeHtml(definition.label)}<select data-language-id="${definition.id}"${options.length?'':' disabled'}>${options.length?options.map(option=>`<option value="${escapeHtml(option.value)}"${option.value===selected?' selected':''}>${escapeHtml(option.label)}</option>`).join(''):`<option>${matched?'本场不可用':'未读取'}</option>`}</select></label>`;
  }).join('');
  $('readQojLanguages').disabled=!current||!bridge||Boolean(qojLanguageRead.pending);
  const status=$('qojLanguageStatus');status.classList.remove('error');
  if(!bridge){status.innerHTML='<span class="qoj-language-bridge bad">网页提交扩展未连接。</span> 请在扩展管理页重新加载扩展，再刷新本页。';return}
  if(!current){status.innerHTML='<span class="qoj-language-bridge ok">网页提交扩展已连接。</span> 输入比赛地址后自动识别语言。';return}
  if(qojLanguageRead.pending){status.textContent='正在自动识别本场 QOJ 可用语言…';return}
  if(qojLanguageRead.error){status.textContent='识别失败：'+qojLanguageRead.error+'；可点击“重新识别”重试。';status.classList.add('error');return}
  if(matched){status.innerHTML=`<span class="qoj-language-bridge ok">网页提交扩展已连接。</span> 已用 QOJ 账号 ${escapeHtml(info.handle)} 读取 ${info.languages.length} 个语言选项。`;return}
  status.innerHTML='<span class="qoj-language-bridge ok">网页提交扩展已连接。</span> 正在准备自动识别语言…';
}
function setupLanguageDefaults(){
  return state.qojLanguageInfo?.url===qojSetupUrl()?.url.href?{...state.qojLanguageInfo.defaults}:{};
}
async function readQojLanguages(){
  const current=syncQojLanguageTarget();
  if(!current||!state.canManage||document.documentElement.dataset.xcpcSubmitBridge!=='1')return;
  if(qojLanguageRead.pending)return qojLanguageRead.pending;
  const generation=qojLanguageRead.generation,isCurrent=()=>generation===qojLanguageRead.generation&&qojSetupUrl()?.url.href===current.url.href;
  qojLanguageRead.attempts++;qojLanguageRead.error='';
  const task=(async()=>{try{
    const {html}=await submitExtension('VP_FETCH_QOJ_PAGE',{url:current.url.href});
    if(!isCurrent())return;
    const doc=new DOMParser().parseFromString(html,'text/html');
    if(doc.querySelector('input[type="password"],form[action*="login"]'))throw Error('QOJ 登录状态已失效，请先登录 QOJ');
    const problemLink=[...doc.querySelectorAll('a[href*="/problem/"]')].map(anchor=>anchor.getAttribute('href')||'').find(href=>new RegExp(`(?:^|/)contest/${current.contestId}/problem/\\d+`).test(href))||[...doc.querySelectorAll('a[href*="/problem/"]')].map(anchor=>anchor.getAttribute('href')||'').find(href=>/\/problem\/\d+/.test(href));
    const problemId=problemLink?.match(/\/problem\/(\d+)/)?.[1];
    if(!problemId)throw Error('没有在 QOJ 比赛页找到题目，请确认比赛已开放且账号有权限');
    const info=await submitExtension('VP_INSPECT_QOJ_LANGUAGES',{qoj_url:current.url.href,problem_id:problemId});
    if(!isCurrent())return;
    const previous=setupLanguageDefaults();
    const groups=languageOptionsByFamily(info.languages),defaults={};
    for(const definition of submitLanguageDefinitions){
      const matches=groups[definition.id];if(!matches.length)continue;
      defaults[definition.id]=matches.find(option=>option.value===previous[definition.id])?.value||[...matches].sort((a,b)=>languagePreference(b,definition.id,info.selected)-languagePreference(a,definition.id,info.selected))[0].value;
    }
    state.qojLanguageInfo={...info,url:current.url.href,defaults};
  }catch(error){
    if(isCurrent()){qojLanguageRead.error=error.message;qojLanguageRead.retryAt=performance.now()+[0,10000,30000][Math.min(qojLanguageRead.attempts,2)]}
  }finally{
    if(isCurrent()){qojLanguageRead.pending=null;renderQojLanguageSettings()}
  }})();
  qojLanguageRead.pending=task;renderQojLanguageSettings();return task;
}
function autoReadQojLanguages(){
  if(!state.canManage||!['setup','waiting'].includes(state.screen))return;
  const current=syncQojLanguageTarget(),bridge=document.documentElement.dataset.xcpcSubmitBridge==='1';
  if(bridge!==qojLanguageRead.bridge){qojLanguageRead.bridge=bridge;renderQojLanguageSettings()}
  if(current&&bridge&&!qojLanguageRead.pending&&state.qojLanguageInfo?.url!==current.url.href&&qojLanguageRead.attempts<3&&performance.now()>=qojLanguageRead.retryAt)readQojLanguages();
}
async function refreshQojContestInfo(){
  if(!state.canManage)return;
  try{state.qojContestInfo=(await api('/api/qoj-contest-info')).contest;renderQojContestInfo()}catch{renderQojContestInfo()}
}
function renderStartMethod(){
  const manual=document.querySelector('input[name=startMethod]:checked').value==='manual';
  $('setup').classList.toggle('manual-start-selected',manual);
  $('manualStartRow').classList.toggle('hidden',!manual);
  $('qojObservation').classList.toggle('hidden',manual);
  if(manual){ensureManualStart();renderManualStartHint()}
  updateLaunchLabel();
}
function renderScenarioExplanation(){
  const icpc=document.querySelector('input[name=mode]:checked')?.value==='icpc';
  document.querySelector('input[name=scenario][value=adjusted]').disabled=icpc;
  if(icpc)document.querySelector('input[name=scenario][value=original]').checked=true;
  const adjusted=document.querySelector('input[name=scenario]:checked')?.value==='adjusted';
  $('scenarioExplanation').textContent=adjusted
    ?'行为模拟：以某题首次通过或第 3 支队伍首次尝试作为可能的公开开题信号。只有随后才首次尝试该题的队伍可能受影响；概率取决于队伍当时的相对表现、比赛进度和距离信号的时间。影响在前期较强并连续衰减，弱队在后程仍可能受到较小影响。初始发现延迟会施加到该队该题的提交序列，开始做题后再按队伍强弱逐渐追回一部分时间。因此罚时、过题数和排名都可能自然变化。固定哈希保证同一场比赛每次重放一致，本队提交不变。这是训练情景，不是正式比赛预测。'
    :'其他队伍完全按照所选数据的原始逐次提交记录重放，不调整开题或通过时间。';
}
async function refreshVpObservation(){
  if(!state.canManage)return;
  try{state.qojObservation=(await api('/api/qoj-vp-observation')).observation;renderVpObservation();if(waitingSince)tryWaitingLaunch()}
  catch(error){$('qojObservation').textContent='读取 VP 识别结果失败：'+error.message}
}
async function enterMatch(knownSession=null){
  const session=knownSession||await refreshSession();if(!session)throw Error('当前没有已启动的比赛');
  if(session.start_at_ms>serverNow()){state.session=session;enterScheduledWaiting(session);return}
  const [raw,submissions]=await Promise.all([api('/api/contest?path='+encodeURIComponent(session.path)),matchSubmissions(session.session_id)]);
  const data=normalize(raw,session.path),history=session.scenario==='adjusted'?adjustedRuns(data):data.runs;
  const syncHealth=state.canManage?(await api('/api/submission-sync-status')).sync:null;
  const debug=state.canManage?await api('/api/debug-time'):{enabled:false,elapsed_seconds:null};
  Object.assign(state,{archiveId:null,session,data,history,submissions,syncHealth,syncReadError:'',debug});
  state.screen='match';state.view='scoreboard';analysisCache=null;waitingSince=0;waitingStarting=false;$('setup').classList.add('hidden');$('qojWait').classList.add('hidden');$('home').classList.add('hidden');$('analysis').classList.add('hidden');$('match').classList.remove('hidden');$('matchNav').classList.remove('hidden');$('homeNav').classList.toggle('hidden',!state.canManage);$('analysisNav').classList.add('hidden');$('homeNav').classList.remove('active');$('analysisNav').classList.remove('active');$('scoreboardNav').classList.add('active');$('backBtn').classList.toggle('hidden',!state.canManage);
  renderFilterCategories();
  $('timeControls').classList.toggle('hidden',!state.debug.enabled||!state.canManage);
  $('timeSlider').max=String(state.data.duration);
  $('backBtn').textContent='比赛设置';$('topContest').textContent=session.name;$('contestTitle').textContent=session.name;
  $('modeLabel').textContent=matchModeLabel(session);
  switchMatchView('scoreboard');renderTimeControls();tickClock();requestRender();
}

async function enterHistory(ident){
  const entry=await api('/api/history?id='+encodeURIComponent(ident));
  const session={...entry.session,archived_elapsed_seconds:Number(entry.elapsed_seconds||0)};
  state.archiveId=ident;state.session=session;
  state.data=normalize(await api('/api/contest?path='+encodeURIComponent(session.path)),session.path);
  state.history=session.scenario==='adjusted'?adjustedRuns(state.data):state.data.runs;
  state.submissions=entry.submissions||[];state.syncHealth=null;state.syncReadError='';state.debug={enabled:false,elapsed_seconds:null};
  state.screen='match';state.view='scoreboard';analysisCache=null;waitingSince=0;waitingStarting=false;
  $('setup').classList.add('hidden');$('qojWait').classList.add('hidden');$('home').classList.add('hidden');$('analysis').classList.add('hidden');$('match').classList.remove('hidden');$('matchNav').classList.remove('hidden');$('analysisNav').classList.add('hidden');$('homeNav').classList.remove('active');$('analysisNav').classList.remove('active');$('scoreboardNav').classList.add('active');$('backBtn').classList.remove('hidden');
  renderFilterCategories();$('timeControls').classList.add('hidden');$('topContest').textContent=session.name;$('contestTitle').textContent=session.name;$('backBtn').textContent='返回比赛管理';
  $('modeLabel').textContent=matchModeLabel(session);switchMatchView('scoreboard');tickClock();render();
}

function renderFilterCategories(){
  const groups=[...new Set(state.data.teams.flatMap(team=>team.group))];
  const preferred=['official','vocation','girl','unofficial'];
  groups.sort((a,b)=>{const ai=preferred.indexOf(a),bi=preferred.indexOf(b);return(ai<0?999:ai)-(bi<0?999:bi)||a.localeCompare(b)});
  const labels=state.data.config.group||{};
  const select=$('groupFilter');select.replaceChildren(new Option(`全部队伍 (${state.data.teams.length+1})`,'all'));
  for(const group of groups){
    const count=state.data.teams.filter(team=>team.group.includes(group)).length+(group==='unofficial'?1:0);
    select.add(new Option(`${nameOf(labels[group])||group} (${count})`,group));
  }
  select.add(new Option('本次 VP 队伍','own'));
}

async function refreshMatchSession(){
  if(state.screen!=='match'||state.archiveId||matchSessionLoading)return;
  matchSessionLoading=true;
  const requestedSession=state.session?.session_id;
  try{
    const stillCurrent=()=>pageIsVisible()&&state.screen==='match'&&!state.archiveId&&state.session?.session_id===requestedSession;
    const response=await readSession(state.canManage?null:requestedSession),next=response.session;
    if(!stillCurrent())return;
    if(!next){state.session=null;if(state.canManage)await enterHostSetup();else enterViewerWaiting();return}
    const currentKey=state.session?.session_id||`${state.session?.path||''}:${state.session?.created_at_ms||''}`;
    const nextKey=next.session_id||`${next.path||''}:${next.created_at_ms||''}`;
    if(nextKey!==currentKey){
      await enterMatch(next);
      return;
    }
    let rowsChanged=false;
    if(!state.canManage){
      // An older service still supports the separate submissions endpoint.
      const rows=response.submissions??await matchSubmissions(next.session_id,{pagePoll:true});
      if(!stillCurrent())return;
      rowsChanged=JSON.stringify(rows)!==JSON.stringify(state.submissions)||Boolean(state.syncReadError);
      if(rowsChanged)state.submissions=rows;
      state.syncReadError='';
    }
    if(rowsChanged||JSON.stringify(next)!==JSON.stringify(state.session)||response.permissionsChanged){state.session=next;requestRender();tickClock()}
  }catch(error){
    if(pageIsVisible()&&!state.canManage&&state.screen==='match'&&!state.archiveId&&state.session?.session_id===requestedSession){
      const disconnected='与主机的连接暂时中断，正在自动重试…';
      if(state.syncReadError!==disconnected){state.syncReadError=disconnected;requestRender()}
    }
  }finally{matchSessionLoading=false}
}

function formatSeconds(seconds){const s=Math.max(0,Math.floor(seconds));return`${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`}
function inputDate(value){const part=beijingInputParts(value instanceof Date?value.getTime():value);return`${part.year}-${part.month}-${part.day}`}
function inputTime(value){const part=beijingInputParts(value instanceof Date?value.getTime():value);return`${part.hour}:${part.minute}:${part.second}`}
function setManualStart(value){$('startDate').value=inputDate(value);$('startTime').value=inputTime(value);renderManualStartHint()}
function ensureManualStart(){if(!$('startDate').value||!$('startTime').value)setManualStart(serverNow())}
function manualStartMs(){
  const date=$('startDate').value,time=$('startTime').value;
  if(!date||!time)return NaN;
  return Date.parse(`${date}T${time.length===5?time+':00':time}+08:00`);
}
function renderManualStartHint(){
  const start=manualStartMs(),hint=$('manualStartHint');
  if(!Number.isFinite(start)){hint.textContent='请选择完整的日期和时间。';hint.classList.remove('future');updateLaunchLabel();return}
  const future=start>serverNow()+1000;
  hint.classList.toggle('future',future);
  hint.textContent=future?`预定于北京时间 ${formatBeijing(start)} 开始。启动后先显示倒计时，到时自动进入榜单。`:`将北京时间 ${formatBeijing(start)} 作为已经开始的 QOJ VP 起点；若已经超过比赛时长，将直接进入赛后待公布状态。`;
  updateLaunchLabel();
}
function renderTimeControls(){
  if(!state.debug.enabled||!state.data)return;
  const elapsed=Math.min(state.data.duration,Math.max(0,effectiveElapsed()));
  if(document.activeElement!==$('timeSlider'))$('timeSlider').value=String(Math.round(elapsed));
  $('timePreviewValue').textContent=formatSeconds(elapsed);
  $('timeLive').disabled=state.debug.elapsed_seconds===null;
}
async function setDebugTime(seconds){
  state.debug=await post('/api/debug-time',{elapsed_seconds:seconds});
  renderTimeControls();tickClock();render();
}
async function refreshDebugTime(){
  if(state.screen!=='match'||!state.canManage)return;
  try{const next=await api('/api/debug-time');if(JSON.stringify(next)!==JSON.stringify(state.debug)){state.debug=next;renderTimeControls();tickClock();requestRender()}}catch{}
}

$('catalogSearch').oninput=renderCatalog;
$('contestImportFiles').onchange=()=>{contestImportUi.payload=null;contestImportUi.preview=null;$('contestImportPreview').classList.add('hidden');$('contestImportStatus').textContent='';renderContestImport();if($('contestImportFiles').files.length)void checkContestImport()};
$('contestImportCheck').onclick=checkContestImport;
$('contestImportConfirm').onclick=confirmContestImport;
$('qojUrl').oninput=()=>{syncQojLanguageTarget();qojLanguageRead.retryAt=performance.now()+350;renderVpObservation();renderQojContestInfo();renderQojLanguageSettings();setTimeout(autoReadQojLanguages,400)};
$('readQojLanguages').onclick=()=>readQojLanguages();
$('qojLanguageGrid').onchange=event=>{const select=event.target;if(select.matches('select[data-language-id]')&&state.qojLanguageInfo?.url===qojSetupUrl()?.url.href)state.qojLanguageInfo.defaults[select.dataset.languageId]=select.value};
for(const radio of document.querySelectorAll('input[name=startMethod]'))radio.onchange=renderStartMethod;
for(const radio of document.querySelectorAll('input[name=scenario]'))radio.onchange=renderScenarioExplanation;
for(const radio of document.querySelectorAll('input[name=mode]'))radio.onchange=renderScenarioExplanation;
$('startDate').oninput=renderManualStartHint;$('startTime').oninput=renderManualStartHint;$('startNow').onclick=()=>setManualStart(serverNow());
$('catalogBack').onclick=()=>{if(state.catalogStep==='contest'){state.catalogStep='year';state.browseYear=null;$('catalogSearch').value=''}else if(state.catalogStep==='year'){state.catalogStep='series';state.browseSeries=''}renderCatalog()};
$('catalogRefresh').onclick=async()=>{try{$('catalogStatus').textContent='正在刷新目录…';await refreshCatalog(true)}catch(error){state.catalogError='刷新失败：'+error.message;renderCatalog()}};
$('catalogList').onclick=async event=>{
  const seriesButton=event.target.closest('button[data-series]');
  if(seriesButton){state.browseSeries=seriesButton.dataset.series;state.catalogStep='year';renderCatalog();return}
  const yearButton=event.target.closest('button[data-year]');
  if(yearButton){state.browseYear=yearButton.dataset.year;state.catalogStep='contest';renderCatalog();return}
  const button=event.target.closest('button[data-contest-path]');if(!button)return;
  const path=button.dataset.contestPath;
  try{
    $('setupError').textContent='';button.disabled=true;
    if(!state.localContests.some(c=>c.path===path)){
      button.textContent='正在下载…';
      await post('/api/download',{path});
      await refreshContests();
    }
    $('contestSelect').value=path;updateSource();renderVpObservation();
  }catch(error){$('setupError').textContent='下载比赛失败：'+error.message;renderCatalog()}
};
$('historyList').onclick=async event=>{
  const activate=event.target.closest('button[data-history-activate]');
  if(activate){
    try{
      $('setupError').textContent='';
      if(state.session){
        if(!confirm(`当前比赛将先归档，再由“${activate.dataset.historyName}”替换。继续吗？`))return;
        await post('/api/session/archive',{});state.session=null;
      }
      await post('/api/history/activate',{id:activate.dataset.historyActivate});
      await enterMatch();
    }catch(error){$('setupError').textContent='设为当前比赛失败：'+error.message;await refreshSession()}
    return;
  }
  const remove=event.target.closest('button[data-history-delete]');
  if(remove){
    if(!confirm(`删除历史比赛“${remove.dataset.historyName}”？`))return;
    try{await post('/api/history/delete',{id:remove.dataset.historyDelete});await refreshHistory()}catch(error){$('setupError').textContent='删除历史比赛失败：'+error.message}
    return;
  }
  const button=event.target.closest('button[data-history-id]');if(button)enterHistory(button.dataset.historyId).catch(error=>$('setupError').textContent='历史比赛载入失败：'+error.message);
};
async function beginSession(startAt,qojSubmissionClockOffsetMs=0,timingSource='qoj'){
  $('setupError').textContent='';
  if(!$('contestSelect').value)throw Error('请先依次选择赛事系列、年份和具体比赛');
  if(!Number.isFinite(startAt))throw Error('请确认 QOJ 实际开始时间');
  renderScenarioExplanation();
  if(state.qojLanguageInfo?.url!==qojSetupUrl()?.url.href)await readQojLanguages();
  await post('/api/session/start',{path:$('contestSelect').value,qoj_url:$('qojUrl').value.trim(),own_name:$('ownName').value.trim(),mode:document.querySelector('input[name=mode]:checked').value,scenario:document.querySelector('input[name=scenario]:checked').value,start_at_ms:Math.round(startAt),qoj_submission_clock_offset_ms:Math.round(qojSubmissionClockOffsetMs),timing_source:timingSource,ignore_previous_submissions:$('ignorePreviousSubmissions').checked,language_defaults:setupLanguageDefaults()});
  await enterMatch();
}
async function startFromObservation(observation){
  let start=observation.start_at_ms;
  if(observation.source==='countdown'){
    const data=normalize(await api('/api/contest?path='+encodeURIComponent($('contestSelect').value)),$('contestSelect').value);
    if(observation.remaining_seconds>data.duration+5)throw Error('QOJ 剩余时间超过所选历史比赛时长，请检查比赛是否对应');
    start=observation.sampled_at_ms-(data.duration-observation.remaining_seconds)*1000;
  }
  await beginSession(start,observation.submission_clock_offset_ms||0,'qoj');
}
function enterQojWaiting(){
  if(!$('contestSelect').value)throw Error('请先依次选择赛事系列、年份和具体比赛');
  let url;
  try{url=new URL($('qojUrl').value.trim())}catch{throw Error('请填写正确的 QOJ 比赛地址')}
  if(url.protocol!=='https:'||!['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname)||!/^\/contest\/\d+\/?$/.test(url.pathname))throw Error('请填写正确的 QOJ 比赛地址');
  waitingSince=serverNow();waitingStarting=false;state.screen='waiting';
  $('setup').classList.add('hidden');$('match').classList.add('hidden');$('home').classList.add('hidden');$('analysis').classList.add('hidden');$('matchNav').classList.add('hidden');$('qojWait').classList.remove('hidden');$('backBtn').classList.add('hidden');
  document.querySelector('.wait-card').classList.remove('scheduled');$('waitSpinner').classList.remove('hidden');$('waitEyebrow').textContent='QOJ VP';$('qojWaitTitle').textContent='等待 QOJ 开始';$('scheduledCountdown').classList.add('hidden');
  $('qojWaitContest').textContent=state.qojContestInfo?.name||url.href;
  $('qojWaitStatus').textContent='请在 QOJ 点击 Start 并完成启动；识别到倒计时后将自动进入榜单。';
  $('qojWaitOpen').href=url.href;$('qojWaitOpen').classList.remove('hidden');$('qojWaitCancel').classList.remove('hidden');$('qojWaitCancel').textContent='返回设置';$('qojWaitError').textContent='';$('topContest').textContent='等待 QOJ VP';$('topClock').textContent='等待开始';
}
function enterScheduledWaiting(session){
  waitingSince=0;waitingStarting=false;state.screen='scheduled';
  $('setup').classList.add('hidden');$('match').classList.add('hidden');$('home').classList.add('hidden');$('analysis').classList.add('hidden');$('matchNav').classList.add('hidden');$('qojWait').classList.remove('hidden');$('backBtn').classList.add('hidden');
  document.querySelector('.wait-card').classList.add('scheduled');$('waitSpinner').classList.add('hidden');$('waitEyebrow').textContent='预定开赛';$('qojWaitTitle').textContent='距离比赛开始';$('scheduledCountdown').classList.remove('hidden');
  $('qojWaitContest').textContent=session.name;$('qojWaitStatus').textContent=`预定开始时间：北京时间 ${formatBeijing(session.start_at_ms)}。到时将自动进入榜单。`;
  $('qojWaitOpen').classList.add('hidden');$('qojWaitCancel').classList.toggle('hidden',!state.canManage);$('qojWaitCancel').textContent='返回设置';$('qojWaitError').textContent='';$('topContest').textContent=session.name;
  tickScheduledWaiting();
}
function enterViewerWaiting(){
  waitingSince=0;waitingStarting=false;state.screen='viewer-wait';state.view='scoreboard';
  syncSubmissionDialogs();
  $('setup').classList.add('hidden');$('match').classList.add('hidden');$('home').classList.add('hidden');$('analysis').classList.add('hidden');$('matchNav').classList.add('hidden');$('qojWait').classList.remove('hidden');$('backBtn').classList.add('hidden');
  document.querySelector('.wait-card').classList.remove('scheduled');$('waitSpinner').classList.remove('hidden');$('waitEyebrow').textContent='局域网只读榜单';$('qojWaitTitle').textContent='等待主机启动比赛';$('scheduledCountdown').classList.add('hidden');
  $('qojWaitContest').textContent='主机启动比赛后，这里会自动进入榜单。';$('qojWaitStatus').textContent='无需安装扩展，也无需在这台设备上启动服务。';
  $('qojWaitOpen').classList.add('hidden');$('qojWaitCancel').classList.add('hidden');$('qojWaitError').textContent='';$('topContest').textContent='等待比赛';$('topClock').textContent='尚未开始';
}
async function enterHostSetup(){
  state.archiveId=null;state.screen='setup';state.view='scoreboard';waitingSince=0;waitingStarting=false;
  syncSubmissionDialogs();
  $('qojWait').classList.add('hidden');$('match').classList.add('hidden');$('home').classList.add('hidden');$('analysis').classList.add('hidden');$('setup').classList.remove('hidden');$('matchNav').classList.add('hidden');$('backBtn').classList.add('hidden');$('qojWaitError').textContent='';$('topContest').textContent='XCPC VP';$('topClock').textContent='尚未开始';
  await refreshSession();
}
async function refreshViewerWaiting(){
  if(state.screen!=='viewer-wait')return;
  try{
    const session=await refreshSession();
    $('qojWaitError').textContent='';
    if(session)await enterMatch(session);
  }catch(error){$('qojWaitError').textContent='暂时无法连接主机，正在自动重试…'}
}
async function refreshScheduledSession(){
  if(state.screen!=='scheduled'||scheduledSessionLoading)return;
  scheduledSessionLoading=true;
  try{
    const response=await readSession(),next=response.session;
    state.canManage=response.can_manage;
    if(!next){
      state.session=null;
      if(!state.canManage){enterViewerWaiting();return}
      await enterHostSetup();return;
    }
    const currentKey=state.session?.session_id||`${state.session?.path||''}:${state.session?.created_at_ms||''}`;
    const nextKey=next.session_id||`${next.path||''}:${next.created_at_ms||''}`;
    if(nextKey!==currentKey){await enterMatch(next);return}
    if(JSON.stringify(next)!==JSON.stringify(state.session)){state.session=next;enterScheduledWaiting(next);return}
    if(next.start_at_ms<=serverNow())await tickScheduledWaiting();
    $('qojWaitError').textContent='';
  }catch(error){$('qojWaitError').textContent='与主机连接暂时中断，正在自动重试…'}
  finally{scheduledSessionLoading=false}
}
async function refreshPassiveSession(){
  if(!state.canManage||!['setup','waiting'].includes(state.screen)||passiveSessionLoading)return;
  passiveSessionLoading=true;
  try{
    const response=await readSession(),next=response.session;
    if(state.screen==='waiting'&&next){state.session=next;await enterMatch();return}
    if(state.screen==='setup'&&JSON.stringify(next)!==JSON.stringify(state.session)){state.session=next;await refreshSession()}
  }catch{}
  finally{passiveSessionLoading=false}
}
async function tickScheduledWaiting(){
  if(state.screen!=='scheduled'||!state.session)return;
  const remainingMs=state.session.start_at_ms-serverNow();
  if(remainingMs>0){const remaining=Math.ceil(remainingMs/1000);$('scheduledCountdown').textContent=formatSeconds(remaining);$('topClock').textContent=`距离开始 ${formatSeconds(remaining)}`;return}
  $('scheduledCountdown').textContent='00:00:00';$('topClock').textContent='正在进入比赛';
  if(navigator.onLine===false){$('qojWaitStatus').textContent='等待恢复主机连接后进入比赛…';return}
  if(waitingStarting)return;
  waitingStarting=true;$('qojWaitStatus').textContent='比赛已经开始，正在载入榜单…';
  try{await enterMatch()}catch(error){waitingStarting=false;$('qojWaitError').textContent='载入榜单失败：'+error.message}
}
async function tryWaitingLaunch(){
  if(!waitingSince||waitingStarting)return;
  const observation=startableVpObservation();
  if(!observation||observation.observed_at_ms<waitingSince-2000)return;
  waitingStarting=true;$('qojWaitStatus').textContent=observation.source==='countdown'?`已检测到 QOJ 倒计时 ${formatSeconds(observation.remaining_seconds)}，正在进入榜单…`:'已检测到 QOJ 启动，正在进入榜单…';
  try{await startFromObservation(observation)}catch(error){waitingStarting=false;$('qojWaitError').textContent=error.message}
}
$('launchBtn').onclick=async()=>{
  try{
    $('setupError').textContent='';
    if(state.session)throw Error('已有当前比赛，请先在右侧归档当前比赛，再启动新比赛');
    if(document.querySelector('input[name=startMethod]:checked').value==='manual'){
      const start=manualStartMs();if(!Number.isFinite(start))throw Error('请填写完整的 QOJ 开始日期和时间');
      return await beginSession(start,0,'manual');
    }
    await refreshVpObservation();
    const observation=startableVpObservation();
    if(observation)return await startFromObservation(observation);
    enterQojWaiting();
  }catch(error){$('setupError').textContent=error.message}
};
$('qojWaitCancel').onclick=()=>enterHostSetup();
$('connectBtn').onclick=()=>enterMatch().catch(error=>$('setupError').textContent=error.message);
$('archiveBtn').onclick=async()=>{
  if(!state.session||!confirm(`归档当前比赛“${state.session.name}”？归档后局域网将等待下一场当前比赛。`))return;
  try{await post('/api/session/archive',{});state.session=null;await refreshSession()}
  catch(error){$('setupError').textContent='归档失败：'+error.message}
};
function submissionVerdict(row){
  return{correct:'CORRECT',incorrect:'WRONG ANSWER',wrong_answer:'WRONG ANSWER',memory_limit:'MEMORY LIMIT',time_limit:'TIME LIMIT',runtime_error:'RUNTIME ERROR',output_limit:'OUTPUT LIMIT',presentation_error:'PRESENTATION ERROR',pending:'PENDING',compile_error:'COMPILE ERROR',too_late:'TOO LATE',awaiting_sync:'PENDING'}[row.status]||String(row.status||'PENDING').toUpperCase();
}
const submitUi={form:null,generation:0,busy:false,attempted:false,detailGeneration:0,details:null,detailSession:null,source:'',filename:'',preferredLanguage:''};
const rejudgeUi={active:new Set(),errors:new Map(),fileRequest:null};
const rejudgeKey=(session,ident)=>`${session.session_id}:${ident}`;
function submitClosedReason(){
  if(!state.session||state.archiveId)return'当前比赛不可提交';
  const window=state.submissionWindow?.session_id===state.session.session_id?state.submissionWindow:null;
  const start=Number(window?.start_at_ms??state.session.clock_start_at_ms??state.session.start_at_ms);
  const end=Number(window?.end_at_ms??(start+Number(state.data?.duration||0)*1000));
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return'正在读取比赛时间';
  const now=serverNow();
  return now<start?'比赛尚未开始':now>=end?'比赛已结束，不能再发起提交':'';
}
function updateSubmitAvailability(){
  const reason=submitClosedReason(),button=$('submitBtn');
  if(button){button.disabled=Boolean(reason)||submitUi.busy;button.title=reason||(submitUi.busy?'正在处理本次提交':'')}
  if($('submitDialog')?.open&&!submitUi.busy&&!submitUi.attempted&&reason){
    $('submitConfirm').disabled=true;$('submitStatus').textContent=reason;
  }
}
const submitLanguageDefinitions=[
  {id:'c',label:'C',extensions:['c']},
  {id:'cpp',label:'C++',extensions:['cpp','cc','cxx','c++']},
  {id:'java',label:'Java',extensions:['java']},
  {id:'python3',label:'Python 3',extensions:['py']},
];
function simpleLanguageId(label){
  const value=String(label||'').toLowerCase().replaceAll('_',' ');
  if(/c\s*\+\+|cpp|g\+\+|clang\+\+/.test(value))return'cpp';
  if(/pypy\s*3|python\s*3|python3/.test(value))return'python3';
  if(/\bjava(?:\s|\d|$)/.test(value)&&!/javascript/.test(value))return'java';
  if(/(?:^|\s)(?:gnu\s*)?c(?:\s*\d|\d|\s|$)/.test(value))return'c';
  return'';
}
function languagePreference(language,id,selectedValue=submitUi.form?.selected){
  const value=`${language.label||''} ${language.value||''}`.toLowerCase();
  const selected=language.value===selectedValue?1:0;
  const versions=id==='cpp'?['20','17','23','14','11']:id==='java'?['21','17','11','8']:id==='c'?['11','17','99']:[];
  const index=versions.findIndex(version=>new RegExp(`${version}(?:\\D|$)`).test(value));
  return(index<0?0:100-index*10)+(id==='python3'&&/pypy\s*3|pypy3/.test(value)?100:0)+selected;
}
function populateSubmitLanguages(form,preferred=''){
  const choices=submitLanguageDefinitions.map(definition=>{
    const matches=form.languages.filter(language=>simpleLanguageId(`${language.label} ${language.value}`)===definition.id).sort((a,b)=>languagePreference(b,definition.id)-languagePreference(a,definition.id));
    const configured=state.session?.language_defaults?.[definition.id];
    const qoj=matches.find(language=>language.value===configured)||matches[0]||(configured?{value:configured,label:configured}:null);
    return{...definition,qoj,available:Boolean(matches.length)};
  });
  const visibleChoices=form.languages.length?choices.filter(choice=>choice.available):choices;
  const select=$('submitLanguage'),placeholder=new Option('Select a language','');placeholder.disabled=true;
  select.replaceChildren(placeholder,...visibleChoices.map(choice=>{
    const option=new Option(choice.label,choice.id);if(choice.qoj){option.dataset.qojValue=choice.qoj.value;option.dataset.qojLabel=choice.qoj.label}return option;
  }));
  const available=choice=>!form.languages.length||choice.available;
  const detected=choices.some(choice=>choice.id===preferred&&available(choice))?preferred:simpleLanguageId(form.languages.find(language=>language.value===form.selected)?.label||'');
  select.value=choices.some(choice=>choice.id===detected&&available(choice))?detected:'';
}
function detectSubmitFile(file){
  const name=file?.name||'',dot=name.lastIndexOf('.'),base=dot>0?name.slice(0,dot):name,extension=dot>0?name.slice(dot+1).toLowerCase():'';
  const problem=[...$('submitProblem').options].find(option=>option.value&&option.value.toLowerCase()===base.toLowerCase());
  const language=submitLanguageDefinitions.find(definition=>definition.extensions.includes(extension));
  return{problem:problem?.value||'',language:language?.id||''};
}
function syncSubmissionDialogs(){
  for(const id of ['submitDialog','submissionSourceDialog']){
    const dialog=$(id);
    if(dialog?.open&&(dialog.dataset.sessionId!==state.session?.session_id||id==='submitDialog'&&!maySubmit()||id==='submissionSourceDialog'&&!mayReadSource())&&!(id==='submitDialog'&&submitUi.busy)){
      if(id==='submissionSourceDialog')clearSubmissionSourceView();
      dialog.close();
    }
  }
}
function clearSubmissionSourceView(){
  submitUi.detailGeneration++;submitUi.details=null;submitUi.detailSession=null;
  $('submissionSource').textContent='';$('submissionSourceFilename').textContent='';
}
function submitExtension(type,payload,timeout=35000){
  if(document.documentElement.dataset.xcpcSubmitBridge!=='1')return Promise.reject(Error('请重新加载 QOJ 扩展并刷新本页，启用 Submit'));
  return new Promise((resolve,reject)=>{
    const requestId=requestUuid(),timer=setTimeout(()=>{window.removeEventListener('message',listener);reject(Error('扩展响应超时，请检查 QOJ；已发送的代码请勿重复提交'))},timeout);
    const listener=event=>{
      if(event.source!==window||event.origin!==location.origin||event.data?.source!=='xcpc-submit-extension'||event.data.requestId!==requestId)return;
      clearTimeout(timer);window.removeEventListener('message',listener);
      event.data.ok?resolve(event.data.body):reject(Error(event.data.error||'扩展连接失败'));
    };
    window.addEventListener('message',listener);window.postMessage({source:'xcpc-submit-page',requestId,type,payload},location.origin);
  });
}
async function closeSubmitForm(form=submitUi.form){
  if(form?.relay)await post('/api/submit-relay/cancel',{id:form.form_key,token:form.form_token}).catch(()=>{});
  else if(form)await submitExtension('VP_CLOSE_SUBMIT_FORM',{form_key:form.form_key}).catch(()=>{});
  if(form===submitUi.form)submitUi.form=null;
}
async function remoteSubmitRequest(action,payload,stillNeeded=()=>true,onQueued=()=>{}){
  const request_id=requestUuid(),token=requestUuid();
  const hostRejudge=action==='rejudge'&&state.canManage;
  const relayPost=(operation,body)=>post(hostRejudge&&operation==='queue'?'/api/submit/rejudge':'/api/submit-relay/'+operation,body,{signal:AbortSignal.timeout(12000)});
  let job;
  try{job=await relayPost('queue',{action,request_id,token,...payload})}
  catch(error){
    if(hostRejudge&&error.status===404)throw Error('Restart the scoreboard service to enable Rejudge, then refresh this page.');
    if(error.status&&error.status<500)throw error;
    // A lost enqueue response does not authorize sending the code a second time.
    job={status:'unknown'};
  }
  onQueued(job);
  const deadline=performance.now()+150000;
  while(!['done','failed','uncertain'].includes(job.status)){
    if(!stillNeeded()){
      await relayPost('cancel',{id:request_id,token}).catch(()=>{});
      throw Error('请求已取消');
    }
    if(performance.now()>deadline)throw Error(['send','rejudge'].includes(action)?'未能确认主机回执，请先查看 QOJ，勿重复发送':'等待主机扩展超时，请检查主机浏览器和扩展');
    if(action==='send')$('submitStatus').textContent=job.status==='sending'?'主机正在提交到 QOJ…':'等待主机扩展转发…';
    await new Promise(resolve=>setTimeout(resolve,700));
    try{job=await relayPost('status',{id:request_id,token})}catch(error){if(error.status&&error.status<500)throw error}
  }
  if(action==='inspect'){
    if(job.status!=='done')throw Error(job.result?.message||'主机未能读取 QOJ 提交表单');
    return{...job.result,form_key:request_id,form_token:token,relay:true};
  }
  if(action==='source'&&job.status!=='done')throw Error(job.result?.message||'主机未能读取 QOJ 源码');
  return job.result;
}
async function rejudgeSubmission(session,ident,file){
  if(!maySubmit()||state.session?.session_id!==session.session_id)return;
  const row=state.submissions.find(value=>value.id===ident),key=rejudgeKey(session,ident);
  if(!row||!isLocalSendAttempt(row)||row.rejudge_id||rejudgeUi.active.has(key))return;
  if(!['send_failed','send_uncertain'].includes(sendAttemptState(row,serverNow()).kind))return;
  rejudgeUi.active.add(key);rejudgeUi.errors.delete(key);render();
  try{
    if(state.canManage&&document.documentElement.dataset.xcpcSubmitBridge!=='1')throw Error('请重新加载主机的 QOJ 扩展并刷新页面');
    const payload={session_id:session.session_id,submission_id:ident};
    if(file){
      if(file.size>262144)throw Error('源码不能超过 256 KiB');
      payload.source=await file.text();payload.filename=file.name;
      if(!payload.source.trim())throw Error('源码不能为空');
    }
    await remoteSubmitRequest('rejudge',payload);
    const rows=await matchSubmissions(session.session_id);
    if(state.session?.session_id===session.session_id&&!state.archiveId)state.submissions=rows;
  }catch(error){rejudgeUi.errors.set(key,submissionMessage(error.message,'Rejudge could not start. Refresh the page and try again.'))}
  finally{rejudgeUi.active.delete(key);if(state.session?.session_id===session.session_id)render()}
}
async function loadSubmitProblem(){
  const generation=++submitUi.generation,session=state.session,label=$('submitProblem').value;
  const previous=submitUi.form;submitUi.form=null;closeSubmitForm(previous);
  $('submitConfirm').disabled=true;populateSubmitLanguages({languages:[],selected:''},submitUi.preferredLanguage);
  if(submitClosedReason()){$('submitStatus').textContent=submitClosedReason();return}
  if(!label){$('submitStatus').textContent='请选择源码文件或题目';return}
  $('submitStatus').textContent=state.canManage?'正在读取 QOJ 提交表单…':'等待主机扩展读取 QOJ 提交表单…';
  try{
    let form;
    if(!state.canManage)form=await remoteSubmitRequest('inspect',{session_id:session.session_id,problem:label},()=>generation===submitUi.generation&&$('submitDialog').open&&state.session?.session_id===session.session_id);
    else{
      const {html}=await submitExtension('VP_FETCH_QOJ_PAGE',{url:session.qoj_url});
      const doc=new DOMParser().parseFromString(html,'text/html');
      const row=[...doc.querySelectorAll('tr')].find(tr=>tr.querySelector('td')?.textContent.trim().toUpperCase()===label.toUpperCase());
      const problemId=row?.querySelector('a[href*="/problem/"]')?.getAttribute('href')?.match(/\/problem\/(\d+)/)?.[1];
      if(!problemId)throw Error('未找到该题的 QOJ 对应题号，请检查比赛地址和登录状态');
      form=await submitExtension('VP_OPEN_SUBMIT_FORM',{session_id:session.session_id,problem_id:problemId});
    }
    if(generation!==submitUi.generation||!$('submitDialog').open||state.session?.session_id!==session.session_id){closeSubmitForm(form);return}
    submitUi.form=form;
    populateSubmitLanguages(form,submitUi.preferredLanguage);
    $('submitAccount').textContent=`QOJ · ${form.handle}`;
    if(!$('submitLanguage').options.length||$('submitLanguage').options.length===1)$('submitStatus').textContent='QOJ 当前表单没有可对应的 C、C++、Java 或 Python 3';
    else if(!$('submitLanguage').value)$('submitStatus').textContent='请选择语言';
    else $('submitStatus').textContent='';
    $('submitConfirm').disabled=!submitUi.source||!$('submitLanguage').value||Boolean(submitClosedReason());
  }catch(error){if(generation===submitUi.generation)$('submitStatus').textContent=error.message}
}
async function sendSolution(event){
  event.preventDefault();if(submitUi.busy||!submitUi.form||!maySubmit())return;
  if(submitClosedReason()){$('submitStatus').textContent=submitClosedReason();$('submitConfirm').disabled=true;return}
  const session=state.session,form=submitUi.form,source=submitUi.source,selectedLanguage=$('submitLanguage').selectedOptions[0],language=selectedLanguage?.dataset.qojValue,problem=$('submitProblem').value;
  if(!source.trim()||new TextEncoder().encode(source).length>262144){$('submitStatus').textContent='源码不能为空，且不能超过 256 KiB';return}
  if(!language){$('submitStatus').textContent='请选择语言';return}
  const languageLabel=selectedLanguage.textContent,filename=submitUi.filename;
  if(!confirm(`提交 ${problem} · ${languageLabel}\n${filename}\nQOJ 账号：${submitUi.form.handle}`))return;
  submitUi.busy=true;submitUi.attempted=true;
  updateSubmitAvailability();
  for(const id of ['submitConfirm','submitProblem','submitLanguage','submitFile'])$(id).disabled=true;
  $('submitStatus').textContent='正在提交到 QOJ…';
  const showHome=row=>{
    if($('submitDialog').dataset.sessionId===session.session_id)$('submitDialog').close();
    $('submitFile').value='';submitUi.source='';submitUi.filename='';
    if(state.session?.session_id!==session.session_id||state.archiveId||state.screen!=='match'||!mayView('home'))return;
    if(row&&!state.submissions.some(value=>value.id===row.id))state.submissions.push(row);
    switchMatchView('home');render();
    matchSubmissions(session.session_id).then(rows=>{
      if(state.session?.session_id===session.session_id&&!state.archiveId){state.submissions=rows;render()}
    }).catch(()=>{});
  };
  let receipt=null,outcome=null;
  try{
    const requestId=requestUuid();
    if(form.relay){
      outcome=await remoteSubmitRequest('send',{session_id:session.session_id,problem,language:languageLabel,qoj_language:language,source,filename,form_key:form.form_key,form_token:form.form_token},()=>true,()=>{receipt={relay:true};showHome()});
    }else{
      receipt=await post('/api/submit/prepare',{session_id:session.session_id,request_id:requestId,problem,language:languageLabel,source,filename});
      showHome(receipt.submission);
      try{outcome=await submitExtension('VP_SEND_SOLUTION',{session_id:session.session_id,form_key:form.form_key,request_id:requestId,language,source},80000)}
      catch(error){outcome={outcome:'uncertain',message:error.message}}
      await post('/api/submit/finish',{session_id:session.session_id,id:receipt.submission.id,...outcome});
    }
    $('submitStatus').textContent=outcome.message;
    if(state.session?.session_id===session.session_id&&!state.archiveId){
      const rows=await matchSubmissions(session.session_id);
      if(state.session?.session_id===session.session_id&&!state.archiveId){state.submissions=rows;render()}
    }
  }catch(error){$('submitStatus').textContent=(receipt?'请先核对提交记录和 QOJ，避免重复提交。 ':'')+error.message}
  finally{
    if(receipt)await closeSubmitForm(form);
    submitUi.busy=false;
    for(const id of ['submitProblem','submitLanguage','submitFile'])$(id).disabled=false;
    // Once a request was prepared, require reopening the form before a new send.
    $('submitConfirm').disabled=Boolean(receipt)||!submitUi.form||Boolean(submitClosedReason());
    updateSubmitAvailability();
    syncSubmissionDialogs();
  }
}
function sourceLanguageExtension(language){
  const id=simpleLanguageId(language),definition=submitLanguageDefinitions.find(item=>item.id===id);
  if(definition)return definition.extensions[0];
  const name=String(language||'').trim().toLowerCase();
  const extensions={python:'py',cpython:'py',pypy:'py',rust:'rs',d:'d',go:'go',kotlin:'kt',haskell:'hs',pascal:'pas',fortran:'f90',ruby:'rb',lean:'lean'};
  const family=name.replace(/^free\s+pascal/,'pascal').match(/^[a-z]+/)?.[0];
  return Object.hasOwn(extensions,family)?extensions[family]:'';
}
function submissionDownloadFilename({submission:row,details}){
  const original=details.filename||'';
  const suffix=original.match(/.+\.([^.]+)$/)?.[1].toLowerCase();
  if(suffix&&suffix!=='txt')return original;
  let extension=sourceLanguageExtension(row.language)||sourceLanguageExtension(details.language);
  // Some old cached QOJ rows have no language. Recognize C++-specific headers.
  if(!extension&&/^[ \t]*#[ \t]*include[ \t]*<(?:bits\/stdc\+\+\.h|iostream|vector|string|algorithm)>/m.test(details.source||''))extension='cpp';
  if(!extension&&suffix==='txt')return original;
  const basename=original.replace(/\.txt$/i,'')||`submission-${row.qoj_id||row.id}`;
  return `${basename}.${extension||'txt'}`;
}
function paintSubmissionSource(value){
  const {submission:row,details}=value;submitUi.details=value;
  const remoteId=row.qoj_id||(/^\d+$/.test(row.id)?row.id:null),session=submitUi.detailSession;
  $('submissionSourceTitle').textContent=`Source code${remoteId?' #'+remoteId:''}`;
  $('submissionSourceFilename').textContent=details.source?submissionDownloadFilename(value):'';
  $('submissionSource').textContent=details.source||'';
  $('submissionSource').classList.toggle('hidden',!details.source);
  $('submissionSourceStatus').textContent=details.source?'':remoteId?'No saved source. It can be loaded from QOJ.':'No saved source for this submission.';
  if(remoteId){
    $('submissionQojLink').classList.remove('hidden');$('submissionQojLink').href=new URL('/submission/'+remoteId,session.qoj_url).href;
  }else{
    $('submissionQojLink').classList.add('hidden');$('submissionQojLink').removeAttribute('href');
  }
  const connected=canFetchSource();
  $('refreshSubmissionSource').disabled=!remoteId||!connected;
  $('downloadSubmissionSource').disabled=!details.source;
  if(!details.source&&remoteId&&!connected)$('submissionSourceStatus').textContent='Open the host browser with the extension and sign in to QOJ to load the source.';
}
async function openSubmissionSource(ident){
  if(!mayReadSource())return;
  const generation=++submitUi.detailGeneration,session=state.session;
  submitUi.details=null;submitUi.detailSession=session;$('submissionSourceDialog').dataset.sessionId=session.session_id;
  $('submissionSourceTitle').textContent='Source code';$('submissionSourceFilename').textContent='';$('submissionSource').textContent='';$('submissionSource').classList.add('hidden');
  $('refreshSubmissionSource').disabled=true;$('downloadSubmissionSource').disabled=true;$('submissionQojLink').classList.add('hidden');
  $('submissionSourceStatus').textContent='Loading source…';$('submissionSourceDialog').showModal();
  try{
    const value=await api('/api/submission-details?session_id='+encodeURIComponent(session.session_id)+'&id='+encodeURIComponent(ident));
    if(generation!==submitUi.detailGeneration||!$('submissionSourceDialog').open)return;
    paintSubmissionSource(value);
    if(!value.details.source&&canFetchSource())await refreshSubmissionSource();
  }catch(error){if(generation===submitUi.detailGeneration)$('submissionSourceStatus').textContent=error.status===404?'Restart the scoreboard service, then refresh this page.':submissionMessage(error.message,'Could not load the saved source.')}
}
async function refreshSubmissionSource(){
  const value=submitUi.details;if(!value)return;
  const session=submitUi.detailSession,generation=submitUi.detailGeneration,row=value.submission,remoteId=row.qoj_id||(/^\d+$/.test(row.id)?row.id:null);
  if(!remoteId||!canFetchSource())return;
  $('refreshSubmissionSource').disabled=true;$('submissionSourceStatus').textContent='Loading source from QOJ…';
  try{
    let result;
    if(state.canManage){
      const details=await submitExtension('VP_FETCH_QOJ_SOURCE',{url:new URL('/submission/'+remoteId,session.qoj_url).href});
      result=await post('/api/submission-details',{session_id:session.session_id,id:row.id,details});
    }else{
      await remoteSubmitRequest('source',{session_id:session.session_id,submission_id:row.id},()=>generation===submitUi.detailGeneration&&$('submissionSourceDialog').open&&state.session?.session_id===session.session_id&&mayReadSource());
      result=await api('/api/submission-details?session_id='+encodeURIComponent(session.session_id)+'&id='+encodeURIComponent(row.id));
    }
    if(generation!==submitUi.detailGeneration||!$('submissionSourceDialog').open)return;
    paintSubmissionSource(result);
  }catch(error){if(generation===submitUi.detailGeneration){
    if(!state.canManage&&error.status===403){$('submissionSourceDialog').close();void refreshMatchSession()}
    else $('submissionSourceStatus').textContent=submissionMessage(error.message,'Could not load source from QOJ.');
  }}
  finally{if(generation===submitUi.detailGeneration)$('refreshSubmissionSource').disabled=!canFetchSource()}
}
function initializeSubmissionUI(){
  const holder=document.createElement('div');
  holder.innerHTML=`<dialog id="submitDialog" class="submission-dialog"><header><h2>Submit</h2><button type="button" data-close-dialog="submitDialog" aria-label="关闭">×</button></header><form id="solutionForm"><label>Source files<input id="submitFile" type="file" accept=".c,.cc,.cpp,.cxx,.c++,.java,.py" required></label><label>Problem<select id="submitProblem" required></select></label><label>Language<select id="submitLanguage" required></select></label><p id="submitAccount" class="submit-account"></p><p id="submitStatus" class="submit-status" role="status" aria-live="polite"></p><footer><button type="button" class="secondary" data-close-dialog="submitDialog">Cancel</button><button id="submitConfirm" class="submit-primary" type="submit" disabled>Submit</button></footer></form></dialog>
  <dialog id="submissionSourceDialog" class="submission-dialog detail-dialog source-dialog"><header><h2 id="submissionSourceTitle">Source code</h2><button type="button" data-close-dialog="submissionSourceDialog" aria-label="Close">×</button></header><div class="submission-source-body"><div class="submission-source-toolbar"><span id="submissionSourceFilename"></span><a id="submissionQojLink" target="_blank" rel="noopener">QOJ ↗</a><button id="refreshSubmissionSource" class="secondary compact" type="button">Reload</button><button id="downloadSubmissionSource" class="secondary compact" type="button">Download</button></div><pre id="submissionSource" class="submission-code hidden" tabindex="0" aria-label="Source code"></pre><p id="submissionSourceStatus" class="submit-status" role="status" aria-live="polite"></p></div></dialog>`;
  document.body.append(holder);
  const rejudgeFile=document.createElement('input');rejudgeFile.type='file';rejudgeFile.accept='.c,.cc,.cpp,.cxx,.c++,.java,.py,.txt';rejudgeFile.hidden=true;
  document.body.append(rejudgeFile);
  rejudgeFile.onchange=()=>{
    const request=rejudgeUi.fileRequest,file=rejudgeFile.files[0];rejudgeUi.fileRequest=null;rejudgeFile.value='';
    if(request&&file)void rejudgeSubmission(request.session,request.ident,file);
  };
  holder.querySelectorAll('[data-close-dialog]').forEach(button=>button.onclick=()=>{if(button.dataset.closeDialog==='submitDialog'&&submitUi.busy)return;$(button.dataset.closeDialog).close()});
  $('submitDialog').addEventListener('cancel',event=>{if(submitUi.busy)event.preventDefault()});
  $('submitDialog').addEventListener('close',()=>{submitUi.generation++;if(!submitUi.busy)closeSubmitForm()});
  $('submissionSourceDialog').addEventListener('close',()=>{if(!$('submissionSourceDialog').open)clearSubmissionSourceView()});
  $('submitProblem').onchange=loadSubmitProblem;$('submitLanguage').onchange=()=>{$('submitConfirm').disabled=!submitUi.form||!submitUi.source||!$('submitLanguage').value||Boolean(submitClosedReason())};$('solutionForm').onsubmit=sendSolution;
  $('submitFile').onchange=async()=>{
    const file=$('submitFile').files[0];submitUi.source='';submitUi.filename='';$('submitConfirm').disabled=true;
    if(!file)return;
    if(file.size>262144){$('submitStatus').textContent='源码不能超过 256 KiB';$('submitFile').value='';return}
    const generation=submitUi.generation,detected=detectSubmitFile(file),source=await file.text();
    if(generation!==submitUi.generation||!$('submitDialog').open)return;
    submitUi.source=source;submitUi.filename=file.name;submitUi.preferredLanguage=detected.language;
    if(detected.problem&&$('submitProblem').value!==detected.problem){$('submitProblem').value=detected.problem;await loadSubmitProblem()}
    else if(!$('submitProblem').value)$('submitStatus').textContent='未从文件名识别出题目，请手动选择';
    else if(submitUi.form){populateSubmitLanguages(submitUi.form,detected.language);$('submitConfirm').disabled=!$('submitLanguage').value||Boolean(submitClosedReason())}
  };
  $('submitBtn').onclick=()=>{
    if(submitUi.busy||!maySubmit()||submitClosedReason())return;
    submitUi.attempted=false;
    submitUi.source='';submitUi.filename='';submitUi.preferredLanguage='';$('submitFile').value='';
    $('submitDialog').dataset.sessionId=state.session.session_id;$('submitAccount').textContent='';
    $('submitProblem').replaceChildren(new Option('Select a problem',''),...state.data.problems.map(problem=>new Option(problem.label,problem.label)));
    populateSubmitLanguages({languages:[],selected:''});$('submitStatus').textContent='请选择源码文件；选择题目后会校验 QOJ 语言';$('submitConfirm').disabled=true;
    $('submitDialog').showModal();
  };
  $('homeSubmissions').onclick=event=>{
    const source=event.target.closest('button[data-submission-id]');if(source){void openSubmissionSource(source.dataset.submissionId);return}
    const button=event.target.closest('button[data-rejudge-id]');if(!button||!maySubmit()||!state.session)return;
    const ident=button.dataset.rejudgeId,session=state.session,row=state.submissions.find(value=>value.id===ident);
    if(row?.rejudge_needs_source){rejudgeUi.fileRequest={session,ident};rejudgeFile.click();return}
    void rejudgeSubmission(session,ident);
  };
  $('refreshSubmissionSource').onclick=refreshSubmissionSource;
  $('downloadSubmissionSource').onclick=()=>{
    const details=submitUi.details?.details;if(!details?.source)return;
    const url=URL.createObjectURL(new Blob([details.source],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');
    link.href=url;link.download=submissionDownloadFilename(submitUi.details);link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
}
initializeSubmissionUI();
renderQojLanguageSettings();
function switchMatchView(view){
  state.view=view;
  for(const [key,id] of [['home','home'],['analysis','analysis'],['scoreboard','match']]){
    $(id).classList.toggle('hidden',view!==key);$(key+'Nav').classList.toggle('active',view===key);
  }
}
async function openSharedView(view){
  if(state.screen!=='match'||!mayView(view)||view==='analysis'&&!state.session?.revealed_at_ms)return;
  try{
    if(!state.canManage){
      const current=await api('/api/'+view);
      if(current.session.session_id!==state.session.session_id){await enterMatch();return}
      state.session=current.session;state.submissions=current.submissions;
    }
    switchMatchView(view);render();
  }catch(error){switchMatchView('scoreboard');render();$('contestPhase').textContent=error.message}
}
$('homeNav').onclick=()=>openSharedView('home');
$('scoreboardNav').onclick=()=>{if(state.screen!=='match')return;switchMatchView('scoreboard');render()};
$('analysisNav').onclick=()=>openSharedView('analysis');
function renderLanSettings(settings){
  for(const [key,id] of Object.entries({home:'lanHome',analysis:'lanAnalysis',submit:'lanSubmit'}))$(id).checked=Boolean(settings?.[key]);
  if(!$('lanHome').checked)$('lanSubmit').checked=false;
}
$('lanHome').onchange=()=>{if(!$('lanHome').checked)$('lanSubmit').checked=false;$('lanSettingsStatus').textContent='共享设置已修改，请保存'};
$('lanSubmit').onchange=()=>{if($('lanSubmit').checked)$('lanHome').checked=true;$('lanSettingsStatus').textContent='共享设置已修改，请保存'};
$('lanAnalysis').onchange=()=>{$('lanSettingsStatus').textContent='共享设置已修改，请保存'};
$('saveLanSettings').onclick=async()=>{
  if(!state.canManage)return;
  $('saveLanSettings').disabled=true;
  try{
    const settings=await post('/api/lan-settings',{home:$('lanHome').checked,analysis:$('lanAnalysis').checked,submit:$('lanSubmit').checked});
    renderLanSettings(settings);
    $('lanSettingsStatus').textContent='已保存，队友页面会自动更新';
  }catch(error){$('lanSettingsStatus').textContent='保存失败：'+error.message}
  finally{$('saveLanSettings').disabled=false}
};
$('backBtn').onclick=()=>enterHostSetup();
$('filterBtn').onclick=()=>{const opened=$('filterPanel').classList.toggle('hidden')===false;$('filterBtn').setAttribute('aria-expanded',String(opened))};
$('search').oninput=render;
$('groupFilter').onchange=render;
$('revealBtn').onclick=async()=>{
  try{
    const revealed=state.archiveId?await post('/api/history/reveal',{id:state.archiveId}):await post('/api/session/reveal',{});
    state.session={...state.session,...revealed};render();
  }catch(error){$('contestPhase').textContent=error.message}
};
$('timeSlider').oninput=()=>{state.debug.elapsed_seconds=Number($('timeSlider').value);renderTimeControls();tickClock();render()};
$('timeSlider').onchange=()=>setDebugTime(Number($('timeSlider').value)).catch(error=>$('timePreviewValue').textContent=error.message);
for(const [id,delta] of [['timeBack',-600],['timeForward',600]])$(id).onclick=()=>setDebugTime(Math.max(0,Math.min(state.data.duration,effectiveElapsed()+delta))).catch(error=>$('timePreviewValue').textContent=error.message);
$('timeLive').onclick=()=>setDebugTime(null).catch(error=>$('timePreviewValue').textContent=error.message);
refreshSession().then(async()=>{
  if(!state.canManage)return state.session?enterMatch(state.session):enterViewerWaiting();
  await refreshContests();
  await refreshQojContestInfo();
  if(state.session&&state.session.start_at_ms>serverNow())return enterMatch();
  return refreshCatalog();
}).catch(error=>{
  if(!state.canManage){enterViewerWaiting();$('qojWaitError').textContent='暂时无法载入榜单，正在自动重试…';return}
  state.catalogError='目录暂时不可用，可选择已下载比赛：'+error.message;renderCatalog();
});
// Automatic page reads stop in background tabs. The QOJ extension has its own
// synchronization and relay loops, independent of these display timers.
function visibleInterval(task,interval,network=true){
  let pending=null;
  const run=()=>{
    if(!pageIsVisible()||network&&navigator.onLine===false)return Promise.resolve();
    if(pending)return pending;
    pending=Promise.resolve().then(task).finally(()=>{pending=null});return pending;
  };
  setInterval(()=>{void run().catch(()=>{})},interval);
  return run;
}
const pageTasks={
  vp:visibleInterval(refreshVpObservation,4000),
  languages:visibleInterval(()=>{if(state.screen==='setup')renderVpObservation();autoReadQojLanguages()},1000),
  qoj:visibleInterval(refreshQojContestInfo,4000),
  debug:visibleInterval(refreshDebugTime,2000),
  match:visibleInterval(refreshMatchSession,2000),
  controls:visibleInterval(renderTimeControls,1000,false),
  scheduledClock:visibleInterval(tickScheduledWaiting,1000,false),
  waiting:visibleInterval(refreshViewerWaiting,2000),
  scheduled:visibleInterval(refreshScheduledSession,2000),
  passive:visibleInterval(refreshPassiveSession,3000),
  lan:visibleInterval(()=>{if(state.screen==='setup')return refreshLanInfo()},20000),
  board:visibleInterval(()=>{if(performance.now()-lastBoardRenderAt>=boardRefreshInterval())requestRender()},1000,false),
  submissions:visibleInterval(refreshSubmissionPoll,1000),
};
refreshQojContestInfo();renderStartMethod();renderScenarioExplanation();
scheduleClockTick();
async function refreshSubmissionPoll(){
  if(!state.canManage||state.screen!=='match'||state.archiveId)return;
  const sessionId=state.session?.session_id;
  try{
    const [rows,healthResponse]=await Promise.all([matchSubmissions(sessionId),state.canManage?api('/api/submission-sync-status'):Promise.resolve({sync:null})]);
    const health=healthResponse.sync;
    if(state.session?.session_id!==sessionId||state.archiveId)return;
    const rowsChanged=JSON.stringify(rows)!==JSON.stringify(state.submissions);
    const healthChanged=JSON.stringify(health)!==JSON.stringify(state.syncHealth)||state.syncReadError;
    if(rowsChanged)state.submissions=rows;
    state.syncHealth=health;state.syncReadError='';
    if(rowsChanged)requestRender();
    else if(healthChanged)renderSyncStatus();
  }catch(error){if(state.session?.session_id===sessionId&&!state.archiveId){state.syncReadError=error.message;renderSyncStatus()}}
}

function renderSyncStatus(){
  if(!pageIsVisible()||state.screen!=='match'||!state.data||!state.session)return;
  renderMatchMetadata(state.data,state.session);
  if(state.view==='home')renderHomeSubmissions(state.data,state.session);
}

function resumePageState(){
  if(!pageIsVisible())return;
  if(resumeTimer||resumeRefresh)return;
  // focus, pageshow and visibilitychange commonly arrive together.
  resumeTimer=setTimeout(()=>{
    resumeTimer=0;
    resumeRefresh=(async()=>{
      if(!pageIsVisible())return;
      if(qojLanguageRead.error&&!qojLanguageRead.pending){qojLanguageRead.attempts=0;qojLanguageRead.retryAt=0}
      await pageTasks.languages();
      if(state.screen==='scheduled')await pageTasks.scheduled();
      else if(state.screen==='viewer-wait')await pageTasks.waiting();
      else if(state.screen==='match')await pageTasks.match();
      else if(state.screen==='waiting'&&state.canManage){await pageTasks.vp();await pageTasks.passive()}
      else if(state.screen==='setup'){
        void pageTasks.lan().catch(()=>{});
        await pageTasks.passive();
      }
      if(state.screen==='match'&&state.canManage)await pageTasks.submissions();
    })().catch(()=>{}).finally(()=>{resumeRefresh=null;scheduleClockTick();requestRender()});
  },80);
}
window.addEventListener('focus',resumePageState);
window.addEventListener('online',resumePageState);
window.addEventListener('pageshow',resumePageState);
document.addEventListener('xcpc-qoj-sync-updated',()=>{
  if(pageIsVisible()&&state.canManage&&state.screen==='match')void pageTasks.submissions().catch(()=>{});
});
document.addEventListener('visibilitychange',()=>{
  if(pageIsVisible()){resumePageState();return}
  for(const controller of pagePolls)controller.abort();
  if(resumeTimer){clearTimeout(resumeTimer);resumeTimer=0}
  if(renderFrame){cancelAnimationFrame(renderFrame);renderFrame=0}
  if(virtualScrollFrame){cancelAnimationFrame(virtualScrollFrame);virtualScrollFrame=0}
  if(deferredRenderTimer){clearTimeout(deferredRenderTimer);deferredRenderTimer=0}
  if(clockTickTimer){clearTimeout(clockTickTimer);clockTickTimer=0}
});
