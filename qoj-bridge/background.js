if(typeof importScripts==='function')importScripts('qoj-response.js','qoj-verification.js','qoj-browser-context.js','submit-worker.js','qoj-sync-driver.js');
const safeServer=value=>{
  const url=new URL(value||'http://127.0.0.1:8770');
  const h=url.hostname;
  const privateHost=h==='127.0.0.1'||h==='localhost'||/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)||/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)||/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h);
  if(url.protocol!=='http:'||!privateHost||url.username||url.password)throw Error('主机地址必须是本机或局域网 IPv4');
  return url.origin;
};
const safeQojPage=value=>{
  const url=new URL(value);
  const contestPage=/^\/contest\/\d+(?:\/submissions)?\/?$/.test(url.pathname);
  const submissionPage=/^\/submission\/\d+\/?$/.test(url.pathname);
  if(url.protocol!=='https:'||!['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname)||!contestPage&&!submissionPage||url.username||url.password)throw Error('QOJ 页面地址无效');
  if(url.pathname.includes('/submissions')){
    const page=url.searchParams.get('page');
    if([...url.searchParams.keys()].some(key=>key!=='page')||page!==null&&!/^\d{1,4}$/.test(page))throw Error('QOJ 提交页参数无效');
  }else url.search='';
  url.hash='';
  return url.href;
};
if(globalThis.__XCPC_QOJ_BACKGROUND_TEST__)Object.assign(globalThis.__XCPC_QOJ_BACKGROUND_TEST__,{safeServer,safeQojPage});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(!['VP_GET_SESSION','VP_POST_SUBMISSIONS','VP_POST_SYNC_ERROR','VP_POST_OBSERVATION','VP_POST_CONTEST_INFO','VP_FETCH_QOJ_PAGE','VP_QOJ_ACCESS_OK','VP_OPEN_QOJ_VERIFICATION'].includes(message?.type))return false;
  if(message.type==='VP_GET_SESSION'&&typeof flushSubmitReceipts==='function')void flushSubmitReceipts();
  (async()=>{
    if(message.type==='VP_OPEN_QOJ_VERIFICATION'){
      const source=new URL(sender.url||sender.tab?.url||'');
      const trusted=source.protocol==='https:'&&['qoj.ac','training.qoj.ac','pjudge.ac'].includes(source.hostname)||source.protocol==='http:'&&['127.0.0.1','localhost'].includes(source.hostname);
      if(!trusted||!sender.tab?.id)throw Error('只接受主机或 QOJ 页面请求验证');
      reply({ok:true,body:await xcpcOpenQojVerification(message.payload?.url)});return;
    }
    if(message.type==='VP_QOJ_ACCESS_OK'){
      const url=new URL(sender.url||sender.tab?.url||'');
      if(url.protocol!=='https:'||!['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname))throw Error('只接受 QOJ 页面确认访问恢复');
      const completed=typeof xcpcCompleteQojVerification==='function'?await xcpcCompleteQojVerification(url.origin,sender.tab?.id,url.href):null;
      await globalThis.xcpcRegisterQojBrowserContext?.(sender.tab?.id,url.href);
      await xcpcResumeQojReads(url.origin);
      if(chrome.tabs?.query){
        const tabs=await chrome.tabs.query({});
        await Promise.allSettled(tabs.filter(tab=>{
          try{const target=new URL(tab.url);return target.origin===url.origin||target.protocol==='http:'&&['127.0.0.1','localhost'].includes(target.hostname)}catch{return false}
        }).map(tab=>chrome.tabs.sendMessage(tab.id,{type:'VP_QOJ_SYNC_RESUME',origin:url.origin})));
      }
      globalThis.xcpcKickQojSync?.();
      reply({ok:true,body:{ok:true,can_sync:!completed?.verification_tab}});return;
    }
    if(message.type==='VP_FETCH_QOJ_PAGE'){
      const url=safeQojPage(message.payload?.url);
      reply({ok:true,body:await xcpcReadQojPage(url)});
      return;
    }
    const config=await chrome.storage.local.get(['serverUrl']);
    const base=safeServer(config.serverUrl);
    const isPost=message.type!=='VP_GET_SESSION';
    if(['VP_POST_OBSERVATION','VP_POST_CONTEST_INFO'].includes(message.type)&&!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('QOJ 页面识别仅能写入主机本机服务');
    const path=message.type==='VP_POST_SUBMISSIONS'?'/api/submissions':message.type==='VP_POST_SYNC_ERROR'?'/api/submission-sync-error':message.type==='VP_POST_OBSERVATION'?'/api/qoj-vp-observation':message.type==='VP_POST_CONTEST_INFO'?'/api/qoj-contest-info':'/api/session';
    const response=await fetch(base+path,{
      method:isPost?'POST':'GET',
      headers:isPost?{'Content-Type':'application/json'}:{},
      body:isPost?JSON.stringify(message.payload):undefined,
      cache:'no-store',
      signal:globalThis.AbortSignal?.timeout?.(15000),
    });
    const body=await response.json();
    if(!response.ok)throw Error(body.error||String(response.status));
    reply({ok:true,body});
  })().catch(error=>reply({ok:false,error:error.message,qoj_kind:error.qojKind,qoj_status:error.qojStatus,retry_after_ms:error.retryAfterMs}));
  return true;
});
