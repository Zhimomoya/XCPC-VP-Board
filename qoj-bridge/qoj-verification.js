/* One verification tab per origin and episode. Never automate the challenge. */
(function(){
  const key='qojVerificationTabs';
  let state={},loaded=null,tail=Promise.resolve();
  const area=chrome.storage?.session;
  function targetOf(value){
    const url=new URL(value);
    if(url.protocol!=='https:'||!['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname)||url.port||url.username||url.password||!/^\/(?:(?:contest\/\d+(?:\/submissions|\/problem\/\d+)?|submission\/\d+)\/?)?$/.test(url.pathname))throw Error('QOJ 验证页面地址无效');
    const page=url.pathname.includes('/submissions')?url.searchParams.get('page'):null;
    url.search='';url.hash='';if(page&&/^\d{1,4}$/.test(page))url.searchParams.set('page',page);
    return url;
  }
  async function load(){
    if(!loaded)loaded=area?area.get(key).then(saved=>{state=saved[key]&&typeof saved[key]==='object'?saved[key]:{}}):Promise.resolve();
    await loaded;
  }
  const save=()=>area?area.set({[key]:state}):Promise.resolve();
  function serial(operation){
    const result=tail.then(async()=>{await load();return operation()});tail=result.catch(()=>{});return result;
  }
  async function currentTab(record,origin){
    if(!Number.isInteger(record?.tabId))return null;
    try{
      const tab=await chrome.tabs.get(record.tabId);
      return[tab.url,tab.pendingUrl].some(value=>{try{return new URL(value).origin===origin}catch{return false}})?tab:null;
    }catch{return null}
  }
  function samePage(a,b){
    try{const first=targetOf(a),second=targetOf(b);return first.origin===second.origin&&first.pathname.replace(/\/$/,'')===second.pathname.replace(/\/$/,'')}catch{return false}
  }
  const blockedPages=record=>Array.isArray(record?.blocked)?record.blocked:record?.url?[record.url]:[];
  async function open(value){
    const blocked=targetOf(value),target=new URL('/',blocked.origin);
    return serial(async()=>{
      const record=state[target.origin];
      const pages=record?.status==='done'?[]:blockedPages(record).slice();
      if(!pages.some(url=>samePage(url,blocked.href)))pages.push(blocked.href);
      if(record&&record.status!=='done'){record.blocked=pages;await save()}
      if(record&&record.status!=='done'){
        const tab=await currentTab(record,target.origin);
        if(tab){
          // Only the helper we created may move from an already healthy home
          // to the exact page that still needs verification. Never touch editors.
          if(record.owned&&record.homeAccessible&&new URL(record.url).pathname==='/'&&blocked.pathname!=='/'&&samePage(tab.url,record.url)){
            state[target.origin]={...record,url:blocked.href,status:'pending'};await save();
            await chrome.tabs.update(tab.id,{url:blocked.href,active:true});
          }
          return{tabId:tab.id,opened:false,homeAccessible:Boolean(record.homeAccessible)};
        }
        state[target.origin]={...record,tabId:null,status:'suppressed'};await save();return{opened:false};
      }
      // Reuse a real challenge already open, without navigating a user's editor.
      const tabs=await chrome.tabs.query({url:target.origin+'/*'});
      const existing=tabs.find(tab=>(samePage(tab.url,blocked.href)||samePage(tab.url,target.href))&&/^(?:just a moment|attention required|security verification|安全验证)/i.test(tab.title||''));
      if(existing){
        state[target.origin]={tabId:existing.id,url:existing.url,blocked:pages,owned:false,status:'pending',homeAccessible:false};await save();
        await chrome.tabs.update(existing.id,{active:true});return{tabId:existing.id,opened:false};
      }
      const retained=record?.owned?await currentTab(record,target.origin):null;
      if(retained&&samePage(retained.url,record.url)){
        const destination=record.homeAccessible?blocked.href:target.href;
        state[target.origin]={...record,url:destination,blocked:pages,status:'pending'};await save();
        await chrome.tabs.update(retained.id,samePage(retained.url,destination)?{active:true}:{url:destination,active:true});
        return{tabId:retained.id,opened:false,homeAccessible:Boolean(record.homeAccessible)};
      }
      // Persist the episode before creating a tab so failure cannot cause a loop.
      state[target.origin]={tabId:null,url:target.href,blocked:pages,owned:true,status:'suppressed',homeAccessible:false};await save();
      try{
        const tab=await chrome.tabs.create({url:target.href,active:true});
        state[target.origin]={tabId:tab.id,url:target.href,blocked:pages,owned:true,status:'pending',homeAccessible:false};await save();
        return{tabId:tab.id,opened:true};
      }catch{return{opened:false}}
    });
  }
  async function complete(origin,sourceId,sourceUrl){
    return serial(async()=>{
      const record=state[origin];if(!record)return{verification_tab:false};
      // A healthy home page does not prove that a blocked detail GET recovered.
      const pages=blockedPages(record).filter(blocked=>!samePage(sourceUrl,blocked));
      const verificationTab=Boolean(record.owned&&record.tabId===sourceId);
      state[origin]={...record,blocked:pages,status:pages.length?'retrying':'done',homeAccessible:record.homeAccessible||new URL(sourceUrl).pathname==='/'};await save();
      // Keep the user's verification page in place, including after success.
      // Closing it here steals focus and can interrupt a challenge in progress.
      return{verification_tab:verificationTab,remaining:pages.length};
    });
  }
  function readRecovered(url){
    return serial(async()=>{
      const origin=new URL(url).origin,record=state[origin];
      if(!record)return;
      const pages=blockedPages(record),remaining=pages.filter(blocked=>!samePage(url,blocked));
      if(remaining.length!==pages.length){
        state[origin]={...record,blocked:remaining,status:!remaining.length?'done':record.status};await save();
      }
    });
  }
  chrome.tabs.onRemoved?.addListener(tabId=>{
    void serial(async()=>{
      let changed=false;
      for(const [origin,record] of Object.entries(state))if(record.tabId===tabId){
        state[origin]={...record,tabId:null,owned:false,status:blockedPages(record).length?'suppressed':'done'};changed=true;
      }
      if(changed)await save();
    }).catch(()=>{});
  });
  globalThis.xcpcOpenQojVerification=open;
  globalThis.xcpcCompleteQojVerification=complete;
  globalThis.xcpcQojReadRecovered=readRecovered;
})();
