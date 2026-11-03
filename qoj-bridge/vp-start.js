/* Observe the signed-in QOJ contest page. Never read or store browser cookies. */
(function(){
  const match=location.pathname.match(/^\/contest\/(\d+)(?:\/|$)/);
  if(!match)return;
  // An interstitial has no contest state and must not start another poller.
  if(xcpcQojPageIssue(document.documentElement.outerHTML,location.href))return;
  const contestId=match[1],pendingKey='xcpc-vp-finish-'+contestId,intentKey='xcpc-vp-start-intent-'+contestId;
  const clockEpoch=Date.now(),clockSteady=globalThis.performance?.now?.()??0;
  const preciseNow=()=>Math.round(clockEpoch+(globalThis.performance?.now?.()??(Date.now()-clockEpoch))-clockSteady);
  const norm=value=>String(value||'').replace(/\s+/g,' ').trim();
  const timeSeconds=value=>{
    const match=String(value||'').match(/(?:^|\D)(\d{1,2}):(\d{2}):(\d{2})(?!\d)/);
    if(!match)return null;
    const [,hours,minutes,seconds]=match.map(Number);
    return minutes<60&&seconds<60?hours*3600+minutes*60+seconds:null;
  };
  const label=element=>norm(element?.textContent||element?.value||'');
  const genericContestName=value=>{
    const name=norm(value).replace(/[|·-]+$/,'').trim();
    return !name||/^(?:QOJ(?:\.ac)?|Public Judge|pjudge|Dashboard|Contest|Login)$/i.test(name);
  };
  const titleContestName=root=>{
    let value=norm(root.title);
    const suffixes=[
      /\s+-\s+Dashboard\s+-\s+Contest\s+-\s+(?:QOJ(?:\.ac)?|Public Judge|pjudge)$/i,
      /\s+-\s+Contest\s+-\s+(?:QOJ(?:\.ac)?|Public Judge|pjudge)$/i,
      /\s+-\s+(?:Dashboard|Contest|Login)\s+-\s+(?:QOJ(?:\.ac)?|Public Judge|pjudge)$/i,
      /\s+-\s+(?:QOJ(?:\.ac)?|Public Judge|pjudge)$/i,
      /\s+-\s+(?:Dashboard|Contest)$/i,
    ];
    for(const suffix of suffixes){
      const stripped=value.replace(suffix,'');
      if(stripped!==value){value=norm(stripped);break}
    }
    return genericContestName(value)?'':value;
  };
  let lastReportedName='';
  function reportContestName(root=document){
    const raw=[...root.querySelectorAll('main h1,.uoj-content h1,[data-contest-name],body h1')]
      .filter(element=>!element.closest?.('nav,header,footer'))
      .map(label).find(value=>!genericContestName(value));
    const name=raw||titleContestName(root);
    if(name&&name!==lastReportedName&&name.length>=2&&name.length<=160){
      lastReportedName=name;
      chrome.runtime.sendMessage({type:'VP_POST_CONTEST_INFO',payload:{qoj_contest_id:contestId,name}},response=>{if(!response?.ok)lastReportedName=''});
    }
  }
  function virtualArea(root=document){
    const heading=[...root.querySelectorAll('h2,h3,h4,h5,.panel-heading,.card-header')].find(el=>/virtual contest|虚拟比赛|虚拟参赛|距离(?:虚拟)?比赛结束|contest ends? in|time (?:until|to) contest end/i.test(label(el)));
    return heading?.closest('.panel,.card,section')||heading?.parentElement?.parentElement||null;
  }
  function remaining(root=document){
    const area=virtualArea(root);if(!area)return null;
    const all=label(area);
    if(/(?:^|\s)start!?\s*$/i.test(all)||/你可以开始虚拟参赛|you can start your participation/i.test(all))return null;
    const candidates=[...area.querySelectorAll('[data-countdown],[class*="countdown"],[id*="countdown"],[class*="timer"],[id*="timer"],[class*="remaining"],[id*="remaining"]')];
    for(const node of candidates){const value=timeSeconds(label(node)||node.getAttribute('data-countdown'));if(value!==null&&value>0)return value}
    const labeled=all.match(/(?:remaining|time left|剩余(?:时间)?|倒计时|距离(?:虚拟)?比赛结束|contest ends? in|time (?:until|to) contest end)[^\d]{0,40}(\d{1,2}:\d{2}:\d{2})/i);
    return labeled?timeSeconds(labeled[1]):timeSeconds(all);
  }
  function post(source,extra){
    chrome.runtime.sendMessage({type:'VP_POST_OBSERVATION',payload:{qoj_contest_id:contestId,source,...extra,client_sent_at_ms:preciseNow()}},response=>{
      if(response?.ok)chrome.storage.local.set({vpStartStatus:source==='finish-confirmed'?'已确认 QOJ Finish 后开始，起点已发给本机榜单。':source==='countdown'?'已从 QOJ 剩余时间识别进行中的 VP。':'已确认这场 QOJ VP 尚未开始。'});
      else chrome.storage.local.set({vpStartStatus:'VP 起点尚未写入本机榜单：'+(response?.error||chrome.runtime.lastError?.message||'连接失败')});
    });
  }
  let startIntent=Number(sessionStorage.getItem(intentKey))||0,lastPost=0,lastNotStartedPost=0,finishSent=false;
  const previous=new Map();
  document.addEventListener('click',event=>{
    const control=event.target.closest('button,input[type="submit"],a,[role="button"]');if(!control)return;
    const text=label(control);
    if(/^start!?$/i.test(text)||/开始(?:虚拟)?(?:比赛|参赛)/.test(text)){
      startIntent=preciseNow();sessionStorage.setItem(intentKey,String(startIntent));
    }
    if(!/^finish!?$/i.test(text)&&text!=='完成')return;
    const context=label(control.closest('form,.modal,[role="dialog"],.panel,.card')||virtualArea());
    if((!startIntent||preciseNow()-startIntent>120000)&&!/start.*virtual|virtual.*start|开始.*虚拟|虚拟.*开始/i.test(context))return;
    sessionStorage.setItem(pendingKey,String(preciseNow()));
    chrome.storage.local.set({vpStartStatus:'已点击 Finish，等待 QOJ 显示进行中的倒计时以确认开赛。'});
  },true);
  function observeCountdown(value,source,sampledAt=preciseNow()){
    const now=sampledAt,before=previous.get(source);
    if(value===null){previous.delete(source);return}
    if(before&&before.value-value>=1&&before.value-value<=Math.ceil((now-before.at)/1000)+2){
      const finishAt=Number(sessionStorage.getItem(pendingKey));
      if(!finishSent&&finishAt&&now-finishAt<120000){
        const submissionClockOffset=Math.max(0,Math.min(10*60_000,finishAt-startIntent));
        finishSent=true;sessionStorage.removeItem(pendingKey);sessionStorage.removeItem(intentKey);
        post('finish-confirmed',{start_at_ms:finishAt,submission_clock_offset_ms:submissionClockOffset});
      }else if(now-lastPost>=2000){
        lastPost=now;
        post('countdown',{remaining_seconds:value,sampled_at_ms:now});
      }
    }
    previous.set(source,{value,at:now});
  }
  function check(){
    const sampledAt=preciseNow();observeCountdown(remaining(document),'page',sampledAt);
    const text=label(virtualArea());
    if((/(?:^|\s)start!?\s*$/i.test(text)||/你可以开始虚拟参赛|you can start your participation/i.test(text))&&sampledAt-lastNotStartedPost>=5000){lastNotStartedPost=sampledAt;post('not-started',{})}
  }
  let fetchingContest=false;
  async function fetchContestPage(){
    if(fetchingContest||remaining(document)!==null||onContestRoot&&virtualArea())return;
    fetchingContest=true;
    try{
      const requestStartedAt=preciseNow();
      const response=await new Promise((resolve,reject)=>chrome.runtime.sendMessage({type:'VP_FETCH_QOJ_PAGE',payload:{url:new URL('/contest/'+contestId,location.origin).href}},reply=>{
        if(reply?.ok&&reply.body){resolve(reply.body);return}
        const error=Error(reply?.error||'QOJ 后台读取失败');error.qojKind=reply?.qoj_kind;reject(error);
      }));
      const responseReceivedAt=preciseNow();
      const root=new DOMParser().parseFromString(response.html,'text/html');
      reportContestName(root);
      const value=remaining(root);
      observeCountdown(value,'fetch',Number.isFinite(response.sample_age_ms)?Math.round(responseReceivedAt-response.sample_age_ms):Math.round((requestStartedAt+responseReceivedAt)/2));
      const area=virtualArea(root),text=label(area);
      if(value!==null)chrome.storage.local.set({vpStartStatus:'已通过 QOJ 登录会话读取倒计时：'+String(Math.floor(value/3600)).padStart(2,'0')+':'+String(Math.floor(value/60)%60).padStart(2,'0')+':'+String(value%60).padStart(2,'0')});
      else if(/(?:^|\s)start!?\s*$/i.test(text)||/你可以开始虚拟参赛|you can start your participation/i.test(text)){
        if(responseReceivedAt-lastNotStartedPost>=4000){lastNotStartedPost=responseReceivedAt;post('not-started',{})}
        chrome.storage.local.set({vpStartStatus:'已连接 QOJ；这场 VP 尚未开始。'});
      }
    }catch(error){
      chrome.storage.local.set({vpStartStatus:'读取 QOJ 比赛状态失败：'+error.message});
      previous.delete('fetch');
    }finally{fetchingContest=false}
  }
  const onContestRoot=new RegExp('^/contest/'+contestId+'/?$').test(location.pathname);
  if(onContestRoot){
    reportContestName();
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',reportContestName,{once:true});
    if(typeof setTimeout==='function')setTimeout(reportContestName,1200);
  }
  check();setInterval(check,250);
  if(typeof fetch==='function'&&typeof DOMParser==='function'){
    fetchContestPage();setInterval(fetchContestPage,2000);
  }
})();
