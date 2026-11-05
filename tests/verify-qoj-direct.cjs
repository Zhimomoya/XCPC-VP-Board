const fs=require('fs');
const vm=require('vm');

async function backgroundFetchTest(){
  let listener,request;
  const chrome={
    runtime:{onMessage:{addListener:value=>listener=value}},
    storage:{local:{get:async()=>({})}},
  };
  const context={
    chrome,URL,
    fetch:async(url,options)=>{
      request={url,options};
      return{ok:true,url,status:200,headers:{get:()=>null},text:async()=>'<html>contest</html>',json:async()=>({})};
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('qoj-bridge/qoj-response.js','utf8'),context);
  vm.runInContext(fs.readFileSync('qoj-bridge/background.js','utf8'),context);
  const response=await new Promise(resolve=>listener({type:'VP_FETCH_QOJ_PAGE',payload:{url:'https://qoj.ac/contest/1828'}},{},resolve));
  if(!response.ok||response.body.html!=='<html>contest</html>')throw Error('background QOJ response bridge failed');
  if(request.url!=='https://qoj.ac/contest/1828'||request.options.credentials!=='include'||request.options.cache!=='no-store')throw Error('authenticated QOJ fetch options failed');
  const rejected=await new Promise(resolve=>listener({type:'VP_FETCH_QOJ_PAGE',payload:{url:'https://example.com/contest/1828'}},{},resolve));
  if(rejected.ok||!/QOJ (?:比赛)?页面地址无效/.test(rejected.error))throw Error('background QOJ URL allowlist failed');
}

async function localSetupTest(){
  let inputListener,interval,disconnect,intervalCleared=false,hidden=false,waiting=false,qojReads=0;
  let steady=100000,wallShift=0;
  const posts=[];
  const input={value:'https://qoj.ac/contest/1828',addEventListener:(_,callback)=>inputListener=callback};
  const nameBox={insertAdjacentElement:()=>{}};
  const statusBox={textContent:'',className:'',classList:{toggle:()=>{}}};
  const area={textContent:'距离比赛结束 04:59:38',querySelectorAll:()=>[]};
  const virtualHeading={textContent:'距离比赛结束',closest:()=>area};
  const contestHeading={textContent:'Fetched Contest',closest:()=>null};
  const root={
    title:'Fetched Contest - Dashboard - Contest - QOJ.ac',
    querySelector:()=>null,
    querySelectorAll:selector=>selector.includes('h1')?[contestHeading]:[virtualHeading],
  };
  const context={
    URL,Date:{now:()=>steady+wallShift},performance:{now:()=>steady},location:{hostname:'127.0.0.1'},DOMParser:class{parseFromString(){return root}},
    document:{documentElement:{dataset:{}},addEventListener:(name,callback)=>{if(name==='xcpc-submit-bridge-disconnected')disconnect=callback},getElementById:id=>id==='qojUrl'?input:id==='qojContestName'?nameBox:id==='setup'?{classList:{contains:()=>hidden}}:id==='qojWait'?{classList:{contains:()=>!waiting}}:null,createElement:()=>statusBox},
    chrome:{
      runtime:{sendMessage:(_,callback)=>{qojReads++;callback({ok:true,body:{html:'<html></html>',sampled_at_ms:steady-3600000,sample_age_ms:2000}})},lastError:null},
      storage:{local:{set:()=>{}}},
    },
    fetch:async(path,options)=>{posts.push({path,body:JSON.parse(options.body)});return{ok:true,json:async()=>({})}},
    setInterval:callback=>interval=callback,
    clearInterval:()=>{intervalCleared=true},
  };
  vm.runInNewContext(fs.readFileSync('qoj-bridge/local-qoj.js','utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  const info=posts.find(item=>item.path==='/api/qoj-contest-info');
  if(info?.body.qoj_contest_id!=='1828'||info.body.name!=='Fetched Contest')throw Error('local setup contest recognition failed');
  if(typeof interval!=='function'||typeof inputListener!=='function')throw Error('local setup polling was not installed');
  steady+=2000;wallShift=5*3600_000;
  area.textContent='距离比赛结束 04:59:37';await interval();
  const observation=posts.find(item=>item.path==='/api/qoj-vp-observation');
  if(!observation||observation.body.sampled_at_ms!==steady-2000||observation.body.client_sent_at_ms!==steady)throw Error('countdown used the worker/OS clock instead of sample age');
  steady+=2000;wallShift=-5*3600_000;
  area.textContent='距离比赛结束 04:59:35';await interval();
  const latest=posts.filter(item=>item.path==='/api/qoj-vp-observation').at(-1);
  if(latest.body.sampled_at_ms!==steady-2000||latest.body.client_sent_at_ms!==steady)throw Error('backward OS correction stopped countdown updates');
  const before=qojReads;hidden=true;await interval();await new Promise(resolve=>setImmediate(resolve));
  if(qojReads!==before)throw Error('hidden setup kept polling QOJ');
  waiting=true;await interval();
  if(qojReads!==before+1)throw Error('waiting for VP start stopped QOJ detection');
  const beforeDisconnect=qojReads;
  disconnect();await interval();inputListener();
  await new Promise(resolve=>setImmediate(resolve));
  if(qojReads!==beforeDisconnect||!intervalCleared||!statusBox.textContent.includes('扩展连接已失效'))throw Error('a disconnected local reader kept polling');
}

Promise.all([backgroundFetchTest(),localSetupTest()]).then(()=>console.log('Direct authenticated QOJ fetch and local setup bridge OK')).catch(error=>{console.error(error);process.exitCode=1});
