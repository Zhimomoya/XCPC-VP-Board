/* Read a signed-in QOJ contest through the extension service worker from the local setup page. */
(function(){
  if(!['127.0.0.1','localhost'].includes(location.hostname))return;
  const input=document.getElementById('qojUrl');
  if(!input)return;
  const bridgeVersion=chrome.runtime.getManifest?.().version||'unknown';
  document.documentElement.dataset.xcpcQojBridge=bridgeVersion;
  const nameBox=document.getElementById('qojContestName');
  const bridgeStatus=document.createElement('div');
  bridgeStatus.id='qojBridgeStatus';bridgeStatus.className='qoj-bridge-status';
  bridgeStatus.textContent='扩展已连接：QOJ 比赛页读取可用。';
  nameBox?.insertAdjacentElement('afterend',bridgeStatus);
  const show=(message,error=false)=>{bridgeStatus.textContent=message;bridgeStatus.classList.toggle('error',error)};
  const norm=value=>String(value||'').replace(/\s+/g,' ').trim();
  const clockEpoch=Date.now(),clockSteady=globalThis.performance?.now?.()??0;
  const preciseNow=()=>Math.round(clockEpoch+(globalThis.performance?.now?.()??(Date.now()-clockEpoch))-clockSteady);
  const label=element=>norm(element?.textContent||element?.value||'');
  const generic=value=>!value||/^(?:QOJ(?:\.ac)?|Public Judge|pjudge|Dashboard|Contest|Login)$/i.test(norm(value).replace(/[|·-]+$/,'').trim());
  const titleName=root=>{
    let value=norm(root.title);
    for(const suffix of [/\s+-\s+Dashboard\s+-\s+Contest\s+-\s+(?:QOJ(?:\.ac)?|Public Judge|pjudge)$/i,/\s+-\s+Contest\s+-\s+(?:QOJ(?:\.ac)?|Public Judge|pjudge)$/i,/\s+-\s+(?:QOJ(?:\.ac)?|Public Judge|pjudge)$/i]){
      const stripped=value.replace(suffix,'');
      if(stripped!==value){value=norm(stripped);break}
    }
    return generic(value)?'':value;
  };
  const contestName=root=>[...root.querySelectorAll('main h1,.uoj-content h1,[data-contest-name],body h1')]
    .filter(element=>!element.closest?.('nav,header,footer')).map(label).find(value=>!generic(value))||titleName(root);
  const timeSeconds=value=>{
    const match=String(value||'').match(/(?:^|\D)(\d{1,2}):(\d{2}):(\d{2})(?!\d)/);
    if(!match)return null;
    const hours=Number(match[1]),minutes=Number(match[2]),seconds=Number(match[3]);
    return minutes<60&&seconds<60?hours*3600+minutes*60+seconds:null;
  };
  const virtualArea=root=>{
    const heading=[...root.querySelectorAll('h2,h3,h4,h5,.panel-heading,.card-header')].find(element=>/virtual contest|虚拟比赛|虚拟参赛|距离(?:虚拟)?比赛结束|contest ends? in|time (?:until|to) contest end/i.test(label(element)));
    return heading?.closest('.panel,.card,section')||heading?.parentElement?.parentElement||null;
  };
  const remaining=root=>{
    const area=virtualArea(root);if(!area)return null;
    const all=label(area);
    if(/(?:^|\s)start!?\s*$/i.test(all)||/你可以开始虚拟参赛|you can start your participation/i.test(all))return null;
    for(const node of area.querySelectorAll('[data-countdown],[class*="countdown"],[id*="countdown"],[class*="timer"],[id*="timer"],[class*="remaining"],[id*="remaining"]')){
      const value=timeSeconds(label(node)||node.getAttribute('data-countdown'));if(value!==null&&value>0)return value;
    }
    const found=all.match(/(?:remaining|time left|剩余(?:时间)?|倒计时|距离(?:虚拟)?比赛结束|contest ends? in|time (?:until|to) contest end)[^\d]{0,40}(\d{1,2}:\d{2}:\d{2})/i);
    return found?timeSeconds(found[1]):timeSeconds(all);
  };
  const extension=(type,payload)=>new Promise((resolve,reject)=>chrome.runtime.sendMessage({type,payload},response=>response?.ok?resolve(response.body):reject(Error(response?.error||chrome.runtime.lastError?.message||'扩展后台请求失败'))));
  const post=async(path,payload)=>{
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'});
    const body=await response.json();if(!response.ok)throw Error(body.error||String(response.status));return body;
  };
  const observedStart=async contestId=>{
    const response=await fetch('/api/qoj-vp-observation',{cache:'no-store'});
    if(!response.ok)return null;
    const observation=(await response.json()).observation;
    return observation?.qoj_contest_id===contestId&&['countdown','finish-confirmed'].includes(observation.source)?observation:null;
  };
  let busy=false,lastUrl='',lastName='',lastPost=0,lastNotStartedPost=0,previous=null;
  async function poll(){
    const setup=document.getElementById('setup'),waiting=document.getElementById('qojWait');
    if(busy||setup?.classList.contains('hidden')&&(!waiting||waiting.classList.contains('hidden')))return;
    let url,contestId;
    try{
      url=new URL(input.value.trim());
      contestId=url.pathname.match(/^\/contest\/(\d+)\/?$/)?.[1];
      if(url.protocol!=='https:'||!['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname)||!contestId)return;
    }catch{return}
    if(url.href!==lastUrl){lastUrl=url.href;lastName='';previous=null;lastPost=0}
    busy=true;
    try{
      show('扩展正在使用当前 QOJ 登录会话读取比赛页面…');
      const requestStartedAt=preciseNow(),{html,sample_age_ms}=await extension('VP_FETCH_QOJ_PAGE',{url:url.href}),responseReceivedAt=preciseNow();
      const root=new DOMParser().parseFromString(html,'text/html');
      if(root.querySelector('form[action*="login"],input[type="password"]')||/^Login(?:\s+-|$)/i.test(norm(root.title)))throw Error('QOJ 登录状态已失效，请先登录 QOJ');
      const name=contestName(root);
      if(!name)throw Error('已收到 QOJ 页面，但没有识别到比赛名称');
      if(name&&name!==lastName){await post('/api/qoj-contest-info',{qoj_contest_id:contestId,name});lastName=name}
      // Worker and page epochs can differ after a clock correction/navigation.
      const value=remaining(root),now=Number.isFinite(sample_age_ms)?Math.round(responseReceivedAt-sample_age_ms):Math.round((requestStartedAt+responseReceivedAt)/2);
      if(value!==null&&previous&&previous.value-value>=1&&previous.value-value<=Math.ceil((now-previous.at)/1000)+2&&now-lastPost>=2000){
        await post('/api/qoj-vp-observation',{qoj_contest_id:contestId,source:'countdown',remaining_seconds:value,sampled_at_ms:now,client_sent_at_ms:preciseNow()});lastPost=now;
      }
      previous=value===null?null:{value,at:now};
      const area=virtualArea(root),text=label(area);
      if(value!==null){show(`已读取 ${name}；VP 倒计时 ${String(Math.floor(value/3600)).padStart(2,'0')}:${String(Math.floor(value/60)%60).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`);chrome.storage.local.set({vpStartStatus:'已由扩展直接读取 QOJ 倒计时。'})}
      else if(/(?:^|\s)start!?\s*$/i.test(text)||/你可以开始虚拟参赛|you can start your participation/i.test(text)){
        if(now-lastNotStartedPost>=4000){await post('/api/qoj-vp-observation',{qoj_contest_id:contestId,source:'not-started'});lastNotStartedPost=now}
        show(`已读取 ${name}；这场 VP 尚未开始。`);chrome.storage.local.set({vpStartStatus:'已连接 QOJ；这场 VP 尚未开始。'});
      }
      else{
        const observation=await observedStart(contestId);
        if(observation)show(`已读取 ${name}；QOJ 比赛页已经识别到进行中的 VP，倒计时见下方。`);
        else show(`已读取 ${name}；等待 QOJ 比赛页出现 VP 启动或倒计时。`);
      }
    }catch(error){show('QOJ 读取失败：'+error.message,true);chrome.storage.local.set({vpStartStatus:'读取 QOJ 比赛状态失败：'+error.message});previous=null}
    finally{busy=false}
  }
  input.addEventListener('input',()=>{lastUrl='';poll()});
  poll();setInterval(poll,2000);
})();
