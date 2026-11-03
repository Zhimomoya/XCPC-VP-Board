const fs=require('fs');
const vm=require('vm');
const source=fs.readFileSync('qoj-bridge/vp-start.js','utf8');
const responseSource=fs.readFileSync('qoj-bridge/qoj-response.js','utf8');

function fixture(initial,options={}){
  let now=100000,wallShift=0,areaText=initial,networkText=options.networkText||'',click,reads=0,opened=0;
  const intervals=[];
  const sent=[],saved={},session=new Map();
  const area={get textContent(){return areaText},querySelectorAll:()=>[]};
  const heading={textContent:options.areaHeading||'Virtual Contest',closest:()=>area};
  const contestHeadings=(options.headings||[]).map(text=>({textContent:text,closest:()=>null}));
  const networkArea={get textContent(){return networkText},querySelectorAll:()=>[]};
  const networkHeading={textContent:'Virtual Contest',closest:()=>networkArea};
  const networkRoot={
    title:options.networkTitle||'',
    querySelector:()=>null,
    querySelectorAll:selector=>selector.includes('h1')?[]:[networkHeading],
  };
  const context={
    URL,
    location:{pathname:options.pathname||'/contest/2513',origin:'https://qoj.ac',href:'https://qoj.ac'+(options.pathname||'/contest/2513')},
    Date:{now:()=>now+wallShift},
    ...(options.steadyClock?{performance:{now:()=>now-100000,timeOrigin:100000}}:{}),
    document:{title:options.title||'Example contest - Dashboard',documentElement:{outerHTML:options.html||'<html><title>'+(options.title||'Example contest - Dashboard')+'</title></html>'},readyState:'complete',querySelectorAll:selector=>selector.includes('h1')?contestHeadings:[heading],addEventListener:(_,callback)=>click=callback},
    sessionStorage:{getItem:key=>session.get(key)||null,setItem:(key,value)=>session.set(key,value),removeItem:key=>session.delete(key)},
    chrome:{runtime:{sendMessage:(message,callback)=>{sent.push(message);if(message.type==='VP_FETCH_QOJ_PAGE'){context.xcpcReadQojPage(message.payload.url).then(body=>callback({ok:true,body}),error=>callback({ok:false,error:error.message,qoj_kind:error.qojKind}));return}callback({ok:true})}},storage:{local:{set:value=>Object.assign(saved,value)}}},
    setInterval:callback=>intervals.push(callback),
    xcpcOpenQojVerification:async()=>{opened++;return{tabId:99}},
  };
  if(options.networkTitle){
    context.DOMParser=class{parseFromString(){return networkRoot}};
    context.fetch=async url=>{reads++;return{url,ok:true,status:200,headers:{get:()=>null},text:async()=>options.networkHtml||'<html></html>'}};
  }
  vm.runInNewContext(responseSource,context);
  vm.runInNewContext(source,context);
  return{
    sent,saved,intervals,reads:()=>reads,opened:()=>opened,shiftWall:value=>wallShift=value,
    set:(time,text)=>{now=time;areaText=text;intervals[0]()},
    pollNetwork:(time,text)=>{now=time;networkText=text;return intervals[1]()},
    press:(time,text,formText='')=>{
      now=time;
      const control={textContent:text,closest:()=>({textContent:formText})};
      click({target:{closest:()=>control}});
    },
  };
}

async function main(){
const newly=fixture('Virtual Contest You can start your participation. Start!');
newly.press(100100,'Start!');
newly.press(100300,'Finish','Start virtual contest');
newly.set(100400,'Virtual Contest Remaining 04:59:59');
newly.set(101600,'Virtual Contest Remaining 04:59:58');
const newlyObserved=newly.sent.filter(item=>item.type==='VP_POST_OBSERVATION'&&item.payload.source!=='not-started');
if(newlyObserved.length!==1||newlyObserved[0].payload.source!=='finish-confirmed'||newlyObserved[0].payload.start_at_ms!==100300||newlyObserved[0].payload.submission_clock_offset_ms!==200)throw Error('Finish confirmation or Start-to-Finish offset failed');

const running=fixture('Virtual Contest Remaining 04:00:00');
running.set(101200,'Virtual Contest Remaining 03:59:59');
const runningObserved=running.sent.filter(item=>item.type==='VP_POST_OBSERVATION');
if(runningObserved.length!==1||runningObserved[0].payload.source!=='countdown'||runningObserved[0].payload.remaining_seconds!==14399)throw Error('running VP countdown failed');

// Finish and countdown samples must remain on one clock when the OS resyncs.
for(const jump of [5*3600_000,-5*3600_000]){
  const corrected=fixture('Virtual Contest You can start your participation. Start!',{steadyClock:true});
  corrected.press(100100,'Start!');corrected.shiftWall(jump);
  corrected.press(100300,'Finish','Start virtual contest');
  corrected.set(100400,'Virtual Contest Remaining 04:59:59');
  corrected.set(101600,'Virtual Contest Remaining 04:59:58');
  const finish=corrected.sent.find(item=>item.payload?.source==='finish-confirmed')?.payload;
  if(finish?.start_at_ms!==100300||finish.submission_clock_offset_ms!==200||finish.client_sent_at_ms!==101600)throw Error('OS resync corrupted Finish time');
  corrected.shiftWall(-jump);corrected.set(103600,'Virtual Contest Remaining 04:59:56');
  const countdown=corrected.sent.find(item=>item.payload?.source==='countdown')?.payload;
  if(countdown?.sampled_at_ms!==103600||countdown.client_sent_at_ms!==103600)throw Error('OS resync corrupted running countdown');
}

const chineseRunning=fixture('距离比赛结束 04:59:38',{areaHeading:'距离比赛结束'});
chineseRunning.set(101200,'距离比赛结束 04:59:37');
const chineseObserved=chineseRunning.sent.find(item=>item.type==='VP_POST_OBSERVATION');
if(chineseObserved?.payload.remaining_seconds!==17977)throw Error('Chinese QOJ end-time panel detection failed');

const ending=fixture('Virtual Contest Remaining 00:30:00');
ending.press(100100,'Finish','Finish virtual contest');
ending.set(101200,'Virtual Contest Remaining 00:29:59');
if(ending.sent.some(item=>item.payload.source==='finish-confirmed'))throw Error('end-VP Finish was misread as start');

const genericTitle=fixture('Virtual Contest You can start your participation. Start!',{title:'QOJ.ac',headings:['QOJ']});
if(genericTitle.sent.some(item=>item.type==='VP_POST_CONTEST_INFO'))throw Error('generic site title was misread as contest name');

const publicJudge=fixture('Virtual Contest You can start your participation. Start!',{title:'Public Round #4 - Dashboard - Contest - Public Judge',headings:['pjudge','Public Round #4']});
const publicInfo=publicJudge.sent.find(item=>item.type==='VP_POST_CONTEST_INFO');
if(publicInfo?.payload.name!=='Public Round #4')throw Error('Public Judge contest title extraction failed');

const qojTitle=fixture('Virtual Contest You can start your participation. Start!',{title:'Example Contest - Dashboard - Contest - QOJ.ac'});
const qojInfo=qojTitle.sent.find(item=>item.type==='VP_POST_CONTEST_INFO');
if(qojInfo?.payload.name!=='Example Contest')throw Error('QOJ document title extraction failed');

const network=fixture('No contest state on this subpage',{pathname:'/contest/2513/submissions',networkTitle:'Fetched Contest - Dashboard - Contest - QOJ.ac',networkText:'Virtual Contest Remaining 04:00:00'});
await new Promise(resolve=>setImmediate(resolve));
if(network.sent.find(item=>item.type==='VP_POST_CONTEST_INFO')?.payload.name!=='Fetched Contest')throw Error('authenticated contest fetch title failed');
await network.pollNetwork(104100,'Virtual Contest Remaining 03:59:56');
await new Promise(resolve=>setImmediate(resolve));
const fetchedCountdown=network.sent.find(item=>item.type==='VP_POST_OBSERVATION'&&item.payload.source==='countdown');
if(fetchedCountdown?.payload.remaining_seconds!==14396)throw Error('authenticated contest fetch countdown failed');

const challenge=fixture('',{title:'Just a moment...',networkTitle:'Just a moment...'});
if(challenge.intervals.length||challenge.reads()||challenge.sent.length)throw Error('verification page started a VP observer');
const challengedFetch=fixture('No contest state on this subpage',{pathname:'/contest/2513/submissions',networkTitle:'Just a moment...',networkHtml:'<title>Just a moment...</title>'});
await new Promise(resolve=>setImmediate(resolve));
await challengedFetch.pollNetwork(101000,'');
if(challengedFetch.reads()!==1||challengedFetch.opened()!==1||challengedFetch.sent.some(item=>item.type==='VP_POST_OBSERVATION')||!challengedFetch.saved.vpStartStatus.includes('安全验证'))throw Error('VP observer bypassed verification guard or cooldown');

console.log('Contest title, Finish confirmation, running countdown, end-VP guard, verification-page suppression and shared read cooldown OK');
}
main().catch(error=>{console.error(error);process.exitCode=1});
