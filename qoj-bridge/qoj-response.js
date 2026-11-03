/* Read fresh QOJ pages; merge active requests and respect site cooldowns. */
(function(){
  const paused=new Map(),flights=new Map(),recoveryVersions=new Map();
  const readClock=()=>globalThis.performance?.now?.()??Date.now();
  const epochClock=()=>Number.isFinite(globalThis.performance?.timeOrigin)?performance.timeOrigin+performance.now():Date.now();
  // The worker owns shared cooldowns. Page-local inspection must not overwrite
  // a persisted 429 restriction with an empty/stale content-script map.
  const storage=typeof document==='undefined'?globalThis.chrome?.storage?.session:null,key='qojReadPauses';
  const ready=storage?storage.get(key).then(saved=>{
    for(const [origin,record] of Object.entries(saved[key]||{})){
      if(!origin.startsWith("https://"))continue;
      if(record?.issue&&Number.isFinite(record.until_ms)&&record.until_ms>epochClock()-3600000){
        const scoped=record.issue.kind==='verification'&&record.issue.status!==429&&record.blocked_url?record.blocked_url:origin;
        paused.set(scoped,{...record,until:readClock()+record.until_ms-epochClock()});
      }
    }
  }).catch(()=>{}):Promise.resolve();
  const save=()=>{if(storage)void storage.set({[key]:Object.fromEntries([...paused].map(([origin,record])=>[origin,{issue:record.issue,attempts:record.attempts,blocked_url:record.blocked_url,until_ms:epochClock()+Math.max(0,record.until-readClock())}]))}).catch(()=>{})};
  function pageIssue(html,url,status=200,mitigated=''){
    // Cloudflare also injects /challenge-platform/ scripts into ordinary pages.
    // Only an actual interstitial/header is evidence that the request was blocked.
    const page=String(html).replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|pre|code|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
    if(mitigated==='challenge'||/<title\b[^>]*>\s*(?:just a moment|attention required|security verification|安全验证)/i.test(page)||/<(?:form|div|main|section)\b[^>]*\bid\s*=\s*["'](?:challenge-form|cf-challenge-running)["']/i.test(page)){
      return{kind:'verification',message:'QOJ 需要安全验证，请在主机同一浏览器打开 QOJ 完成验证；完成后自动继续同步'};
    }
    if(status===429)return{kind:'rate_limit',message:'QOJ 请求过于频繁，已暂缓读取，稍后自动重试'};
    if(status>=400)return{kind:'http',message:`QOJ 读取失败（HTTP ${status}）${status===403?'，请在主机浏览器检查安全验证或访问权限':''}`};
    if(/^\/login\/?$/.test(new URL(url).pathname)||/<input\b[^>]*\btype\s*=\s*["']password["']/i.test(page))return{kind:'login',message:'QOJ 登录已失效，请在主机同一浏览器重新登录；完成后自动继续同步'};
    return null;
  }
  function failure(issue,retryAfterMs=0){
    const error=Error(issue.message);error.qojKind=issue.kind;error.qojStatus=issue.status;error.retryAfterMs=retryAfterMs;return error;
  }
  function retryDelay(value,serverDate){
    if(!value)return 0;
    const seconds=Number(value);
    if(Number.isFinite(seconds))return Math.max(0,seconds*1000);
    const deadline=Date.parse(value);
    const serverNow=serverDate?Date.parse(serverDate):NaN;
    return Number.isFinite(deadline)?Math.max(0,deadline-(Number.isFinite(serverNow)?serverNow:epochClock())):0;
  }
  function assertAllowed(origin,url){
    for(const scope of new Set([origin,url])){
      const record=paused.get(scope);
      if(record&&record.until>readClock())throw failure(record.issue,record.until-readClock());
    }
  }
  function pause(url,issue,retryAfter='',serverDate=''){
    const origin=new URL(url).origin;
    const limited=issue.kind==='rate_limit'||issue.status===429;
    // A challenged detail page must not suspend a healthy live submission list.
    // Explicit rate limits and network outages still apply to the whole origin.
    const scope=!limited&&(issue.kind==='verification'||issue.kind==='http'&&issue.status===403)?url:origin;
    const previous=paused.get(scope);
    const attempts=(previous?.issue.kind===issue.kind?previous.attempts:0)+1;
    const delays=limited?[60000,120000,300000]:(issue.kind==='network'||issue.kind==='http'&&issue.status>=500)?[2000,5000,15000]:[5000,15000,30000];
    const delay=Math.max(delays[Math.min(attempts-1,2)],retryDelay(retryAfter,serverDate));
    paused.set(scope,{issue,attempts,blocked_url:url,until:readClock()+delay});save();return delay;
  }
  async function readPage(value,options={}){
    const target=new URL(value);target.hash='';const url=target.href,origin=target.origin;
    await ready;
    assertAllowed(origin,url);
    const flightKey=(options.networkOnly?'network:':options.fresh?'interactive:':'live:')+url;
    if(flights.has(flightKey))return flights.get(flightKey);
    const operation=async()=>{
      assertAllowed(origin,url);
      const requestStarted=epochClock(),requestClock=readClock();
      const recoveryVersion=recoveryVersions.get(origin)||0;
      try{
        const response=typeof globalThis.xcpcFetchQojResponse==='function'?await globalThis.xcpcFetchQojResponse(url,options):await fetch(url,{credentials:'include',cache:'no-store',redirect:'follow',signal:globalThis.AbortSignal?.timeout?.(15000)});
        const receivedAt=epochClock(),receivedClock=readClock();
        if(new URL(response.url).origin!==origin)throw Error('QOJ 响应跳转到其他网站，请检查登录或访问验证');
        if(Number(response.headers.get('Content-Length')||0)>5000000)throw Error('QOJ 页面内容过大');
        const html=await response.text();if(html.length>5000000)throw Error('QOJ 页面内容过大');
        const issue=pageIssue(html,response.url,response.status,response.headers.get('cf-mitigated'));
        if(issue){
          issue.status=response.status;
          const stale=(recoveryVersions.get(origin)||0)!==recoveryVersion&&issue.kind!=='rate_limit'&&response.status!==429;
          const delay=stale?0:pause(url,issue,response.headers.get('Retry-After'),response.headers.get('Date'));
          if(!stale&&issue.kind==='verification'&&typeof globalThis.xcpcOpenQojVerification==='function'){
            const opened=await globalThis.xcpcOpenQojVerification(url).catch(()=>null);
            if(opened?.homeAccessible)issue.message='QOJ 首页可访问，但'+(/^\/submission\//.test(target.pathname)?'提交详情':'比赛数据')+'仍要求验证；请在保留的验证标签页完成验证，其他可用列表继续同步';
            else if(opened?.tabId)issue.message='QOJ 需要安全验证，已打开 QOJ 首页；完成后自动重试同步';
          }
          throw failure(issue,delay);
        }
        paused.delete(url);
        const previous=paused.get(origin);
        if(previous&&(!['verification','http'].includes(previous.issue.kind)||previous.blocked_url===url))paused.delete(origin);
        save();
        if(typeof globalThis.xcpcQojReadRecovered==='function')void globalThis.xcpcQojReadRecovered(url).catch(()=>{});
        const result={html,url:response.url,ok:response.ok,status:response.status,redirected:response.redirected,content_type:response.headers.get('Content-Type')||'',sampled_at_ms:Math.round((requestStarted+receivedAt)/2),sample_age_ms:Math.max(0,readClock()-(requestClock+receivedClock)/2)};
        return result;
      }catch(error){
        if(!error.qojKind){const issue={kind:'network',message:String(error.message||'QOJ 网络连接失败')};throw failure(issue,pause(url,issue,'',''))}
        throw error;
      }
    };
    const pending=operation().finally(()=>flights.delete(flightKey));
    flights.set(flightKey,pending);return pending;
  }
  globalThis.xcpcQojPageIssue=pageIssue;
  globalThis.xcpcReadQojPage=readPage;
  globalThis.xcpcPauseQojReads=pause;
  globalThis.xcpcAssertQojReadsAllowed=async url=>{await ready;assertAllowed(new URL(url).origin,new URL(url).href)};
  globalThis.xcpcResumeQojReads=async origin=>{
    await ready;
    // A healthy homepage does not cancel the website's Retry-After restriction.
    recoveryVersions.set(origin,(recoveryVersions.get(origin)||0)+1);
    for(const [scope,record] of paused){
      if(new URL(scope).origin!==origin||record.issue.kind==='rate_limit'||record.issue.status===429)continue;
      record.until=0;record.attempts=0;
    }
    save();
  };
})();
