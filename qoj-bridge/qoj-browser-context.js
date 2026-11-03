/* Reuse a verified QOJ tab for ordinary same-origin GETs. No cookie export. */
(function(){
  const contexts=new Map();
  const allowed=url=>url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname);
  const area=chrome.storage?.session,key='qojBrowserContexts';
  const ready=area?area.get(key).then(saved=>{
    for(const [origin,ids] of Object.entries(saved[key]||{})){
      if(!allowed(new URL(origin))||!Array.isArray(ids))continue;
      contexts.set(origin,new Map(ids.filter(Number.isInteger).slice(-5).map(id=>[id,{preferDocument:true}])));
    }
  }).catch(()=>{}):Promise.resolve();
  const save=()=>{if(area)void area.set({[key]:Object.fromEntries([...contexts].map(([origin,tabs])=>[origin,[...tabs.keys()]]))}).catch(()=>{})};
  globalThis.xcpcRegisterQojBrowserContext=async(tabId,value)=>{
    const url=new URL(value);
    if(!Number.isInteger(tabId)||!allowed(url))return;
    await ready;
    let tabs=contexts.get(url.origin);if(!tabs){tabs=new Map();contexts.set(url.origin,tabs)}
    tabs.delete(tabId);tabs.set(tabId,{preferDocument:true});
    if(tabs.size>5)tabs.delete(tabs.keys().next().value);
    save();
  };
  chrome.tabs?.onRemoved?.addListener(tabId=>{for(const tabs of contexts.values())tabs.delete(tabId)});
  globalThis.xcpcFetchQojResponse=async(value,{networkOnly=false}={})=>{
    const target=new URL(value);if(!allowed(target))throw Error('QOJ 页面地址无效');
    await ready;
    const tabs=contexts.get(target.origin);
    if(chrome.scripting?.executeScript&&tabs){
      for(const [tabId,settings] of [...tabs].reverse()){
        const tab=await chrome.tabs.get(tabId).catch(()=>null);
        if(!tab||new URL(tab.url||'about:blank').origin!==target.origin||tab.pendingUrl&&new URL(tab.pendingUrl).origin!==target.origin){tabs.delete(tabId);continue}
        let results;
        try{
          results=await chrome.scripting.executeScript({target:{tabId},func:async(url,preferDocument)=>{
            const target=new URL(url);
            if(location.origin!==target.origin)return{unavailable:true};
            const samePage=()=>{
              const actual=new URL(location.href);
              const page=u=>u.searchParams.get('page')||'1';
              return actual.pathname.replace(/\/$/,'')===target.pathname.replace(/\/$/,'')&&page(actual)===page(target);
            };
            const challenge=/^(?:just a moment|attention required|security verification|安全验证)/i.test(document.title)||Boolean(document.querySelector('#challenge-form,#cf-challenge-running'));
            if(preferDocument&&samePage()&&!challenge&&document.readyState!=='loading'){
              const html=document.documentElement.outerHTML;
              if(html.length>5000000)throw Error('QOJ 页面内容过大');
              return{url:location.href,status:200,ok:true,redirected:false,headers:{'Content-Type':'text/html'},html,used_document:true};
            }
            let response;
            try{response=await fetch(target.href,{credentials:'include',cache:'no-store',redirect:'follow',signal:AbortSignal.timeout(15000)})}
            catch(error){return{error:String(error.message||'QOJ 网络连接失败')}}
            if(new URL(response.url).origin!==target.origin)throw Error('QOJ 响应跳转到其他网站');
            if(Number(response.headers.get('Content-Length')||0)>5000000)throw Error('QOJ 页面内容过大');
            const html=await response.text();if(html.length>5000000)throw Error('QOJ 页面内容过大');
            const headers={};for(const name of ['Content-Type','Retry-After','Date','cf-mitigated'])headers[name]=response.headers.get(name);
            return{url:response.url,status:response.status,ok:response.ok,redirected:response.redirected,headers,html};
          },args:[target.href,settings.preferDocument&&!networkOnly]});
        }catch{tabs.delete(tabId);continue}
        const result=results?.[0]?.result;
        if(!result||result.unavailable){tabs.delete(tabId);continue}
        if(result.error)throw Error(result.error);
        if(result.used_document)settings.preferDocument=false;
        return{...result,headers:{get:name=>Object.entries(result.headers||{}).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1]??null},text:async()=>result.html};
      }
    }
    return fetch(target.href,{credentials:'include',cache:'no-store',redirect:'follow',signal:globalThis.AbortSignal?.timeout?.(15000)});
  };
})();
