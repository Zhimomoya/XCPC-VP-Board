/* Submit only on an explicit request; QOJ is contacted by background fetch. */
if(typeof importScripts==='function')importScripts('submit-parser.js');
const qojSubmitForms=new Map();
function qojHost(sender){
  const page=new URL(sender.url||sender.tab?.url||'');
  if(page.protocol!=='http:'||!['127.0.0.1','localhost'].includes(page.hostname)||!sender.tab?.id)throw Error('Submit 只接受主机页面操作');
  return{origin:page.origin,tabId:sender.tab.id};
}
async function parseQojInHost(host,action,data){
  const tab=await chrome.tabs.get(host.tabId);
  if(new URL(tab.url).origin!==host.origin)throw Error('主机页面已切换，请重新打开 Submit');
  const result=await chrome.scripting.executeScript({target:{tabId:host.tabId},func:qojSubmitPage,args:[action,{...data,host_origin:host.origin}]});
  const value=result[0]?.result;
  if(!value)throw Error('主机页面无法读取 QOJ 响应，请刷新榜单页面');
  if(value.error)throw Error(value.error);
  return value;
}
async function fetchQojHtml(url,options={}){
  if(!options.method||options.method==='GET')return xcpcReadQojPage(url,options);
  const response=await fetch(url,{credentials:'include',cache:'no-store',redirect:'follow',signal:AbortSignal.timeout(options.method==='POST'?20000:15000),...options});
  const target=new URL(response.url);
  if(target.origin!==new URL(url).origin)throw Error('QOJ 响应跳转到其他网站，请检查登录或访问验证');
  const redirectId=response.redirected?target.pathname.match(/^\/submission\/(\d{1,15})\/?$/)?.[1]:null;
  const challengeHeader=response.headers.get('cf-mitigated')==='challenge';
  let html='';
  try{
    if(!challengeHeader){
      if(Number(response.headers.get('Content-Length')||0)>5000000)throw Error('QOJ 页面内容过大');
      html=await response.text();if(html.length>5000000)throw Error('QOJ 页面内容过大');
    }
  }catch(error){if(!redirectId)throw error;html=''}
  const issue=xcpcQojPageIssue(html,response.url,response.status,challengeHeader?'challenge':'');
  if(issue)globalThis.xcpcPauseQojReads?.(response.url,{...issue,status:response.status},response.headers.get('Retry-After'),response.headers.get('Date'));
  if(issue?.kind==='verification')await xcpcOpenQojVerification(response.url).catch(()=>xcpcOpenQojVerification(url).catch(()=>{}));
  return{html,url:response.url,ok:response.ok,status:response.status,redirected:response.redirected,redirectId,issue,challengeHeader,content_type:response.headers.get('Content-Type')||''};
}
async function inspectQojProblem(baseUrl,contestId,problemId,host){
  if(!/^\d{1,10}$/.test(String(problemId)))throw Error('QOJ 题目 ID 无效');
  const pathname=`/contest/${contestId}/problem/${problemId}`,url=baseUrl.origin+pathname;
  const parsed=await parseQojInHost(host,'inspect',{...await fetchQojHtml(url,{fresh:true,networkOnly:true}),pathname});
  if(!parsed.ready)throw Error('未读取到 QOJ 提交表单，请检查登录或题目提交权限');
  // Tokens and native field names stay in the extension, never in page/relay replies.
  return{pathname,url,parsed,info:{ready:true,handle:parsed.handle,languages:parsed.languages,selected:parsed.selected}};
}
async function readQojSubmitForm(baseUrl,contestId,host,{problem_id,problem}){
  let timer;
  const reading=(async()=>{
    let problemId=problem_id;
    if(!problemId){
      const label=String(problem||'').trim().toUpperCase();
      if(!/^[A-Z][A-Z0-9]?$/.test(label))throw Error('请选择有效的比赛题目');
      const mapped=await parseQojInHost(host,'problem',{...await fetchQojHtml(baseUrl.href,{fresh:true,networkOnly:true}),label});
      problemId=mapped.problem_id;
      if(!problemId)throw Error('未找到该题的 QOJ 对应题号，请检查比赛地址和登录状态');
    }
    return{...await inspectQojProblem(baseUrl,contestId,problemId,host),problemId:String(problemId)};
  })();
  try{
    return await Promise.race([reading,new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(Error('QOJ 提交表单读取超时，代码未发送。请点 Retry 重试。')),20000);
    })]);
  }finally{clearTimeout(timer)}
}
async function readQojSource(url,host){
  const target=new URL(url);
  if(target.protocol!=='https:'||!['qoj.ac','training.qoj.ac','pjudge.ac'].includes(target.hostname)||target.port||target.username||target.password||!/^\/submission\/\d{1,15}\/?$/.test(target.pathname))throw Error('QOJ 提交地址无效');
  target.search='';target.hash='';
  return parseQojInHost(host,'source',await fetchQojHtml(target.href,{fresh:true}));
}
const normalizedSource=source=>source.replace(/\r\n?/g,'\n').trimEnd();
async function sendQojSolution(baseUrl,contestId,problemId,host,data,beforeSend,prepared){
  let listUrl,receipt,target,fields;
  try{
    if(typeof data.source!=='string'||new TextEncoder().encode(data.source).length>262144||!data.source.trim()||!/^[-a-f0-9]{32,36}$/.test(data.request_id||''))throw Error('源码或提交请求无效');
    const opened=prepared||await inspectQojProblem(baseUrl,contestId,problemId,host),info=opened.parsed;
    if(info.handle!==data.handle)throw Error('QOJ 登录账号已变化，请重新打开 Submit');
    if(!info.languages.some(language=>language.value===data.language))throw Error('QOJ 不支持所选语言');
    listUrl=baseUrl.origin+`/contest/${contestId}/submissions`;
    const before=await parseQojInHost(host,'list',await fetchQojHtml(listUrl,{fresh:true}));
    if(before.handle!==data.handle)throw Error('QOJ 登录账号已变化或无法确认，请重新打开 Submit');
    receipt={previous:before.ids,handle:data.handle,problem_id:String(problemId)};
    target=info.target;
    fields=new FormData();for(const [name,value] of info.fields)fields.append(name,value);
    if(info.upload_name)fields.set(info.upload_name,'editor');
    fields.set(info.editor_name,data.source);fields.set(info.language_name,data.language);fields.set('submit-answer','answer');
    await globalThis.xcpcAssertQojReadsAllowed?.(target);
    const saved=await beforeSend({qoj_handle:info.handle,qoj_language:data.language,qoj_problem_id:String(problemId)});
    if(typeof saved?.source!=='string')throw Error('The host did not return the saved source. Restart the scoreboard service before trying again.');
    if(saved.source!==data.source)throw Error('The saved source does not match this request. Code was not sent.');
    fields.set(info.editor_name,saved.source);
  }catch(error){return{outcome:'failed',message:'代码未发送：'+String(error.message).slice(0,220)}}

  const accepted=qoj_id=>({outcome:'accepted',qoj_id,message:'已提交到 QOJ，等待同步评测结果'});
  let reason='QOJ 未返回提交编号';
  try{
    // Sending and reading the receipt are separate. A blocked confirmation GET
    // must never turn an accepted POST into a failure or trigger another POST.
    const response=await fetchQojHtml(target,{method:'POST',body:fields});
    if(response.redirectId&&!receipt.previous.includes(response.redirectId))return accepted(response.redirectId);
    const issue=response.issue?.kind;
    if(!response.redirected&&issue==='verification'&&(response.challengeHeader||response.status===403)){
      return{outcome:'failed',message:'提交请求被 QOJ 安全验证拦截，代码未送达。请在主机浏览器完成验证，再重新提交。'};
    }
    if(!response.redirected&&issue==='rate_limit')return{outcome:'failed',message:'QOJ 限流拒绝了本次提交。请等待限流解除后再提交。'};
    if(!response.redirected&&issue==='login')return{outcome:'failed',message:'QOJ 登录已失效，代码未送达。请在主机浏览器重新登录后提交。'};
    if(issue&&issue!=='http')reason=response.issue.message;
    else{
      const result=await parseQojInHost(host,'receipt',{...response,...receipt,posted:true});
      if(result.outcome==='failed')return result;
      if(result.qoj_id)return accepted(result.qoj_id);
      reason=`QOJ 未确认提交编号（HTTP ${response.status}）`;
    }
  }catch(error){reason='发送后连接中断或未能读取回执：'+String(error.message).slice(0,170)}

  // A reset can happen after QOJ accepted the code. Check with GET only, and
  // require matching source before associating a new list row with this send.
  const checked=new Set();
  try{
    for(const delay of [0,600,1400,3000]){
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      const latest=await fetchQojHtml(listUrl,{fresh:true});
      const {candidate_id}=await parseQojInHost(host,'receipt',{...latest,...receipt});
      if(!candidate_id||checked.has(candidate_id))continue;
      checked.add(candidate_id);
      const detail=await readQojSource(new URL('/submission/'+candidate_id,baseUrl).href,host);
      if(normalizedSource(detail.source)===normalizedSource(data.source))return accepted(candidate_id);
    }
  }catch(error){reason+='；核对受阻：'+String(error.message).slice(0,150)}
  return{outcome:'uncertain',message:reason+'。请先核对 QOJ 提交记录，勿直接重复发送。'};
}

async function reconcileQojAttempt(url,contestId,problemId,handle,job,host){
  const at=job.attempt.send_started_at_ms||job.attempt.submitted_at_ms;
  if(!Number.isFinite(at)||at<=0||at>job.now_ms+5000)throw Error('旧记录没有可靠的原发送时间');
  const earliest=at-5000,latest=at+120000;
  const listUrl=new URL(`/contest/${contestId}/submissions`,url),matches=new Set(),details=new Map(),seen=new Set();
  const deadline=performance.now()+30000,options={fresh:true,networkOnly:true};
  const checkBudget=()=>{if(performance.now()>=deadline)throw Error('核对超时，请稍后再试')};
  const detail=async id=>{
    if(!details.has(id)){
      checkBudget();if(details.size>=8)throw Error('需检查的提交详情太多，请在 QOJ 手动核对');
      const result=await fetchQojHtml(new URL('/submission/'+id,url).href,options);
      if(new URL(result.url).pathname.replace(/\/$/,'')!=='/submission/'+id)throw Error('QOJ 提交详情地址不匹配');
      details.set(id,await parseQojInHost(host,'rejudge_detail',result));
    }
    return details.get(id);
  };
  for(let page=1;page<=8;page++){
    checkBudget();if(page>1)listUrl.searchParams.set('page',String(page));
    const result=await parseQojInHost(host,'rejudge_list',{...await fetchQojHtml(listUrl.href,options),expected_url:listUrl.href});
    if(result.handle!==handle)throw Error('QOJ 登录账号已变化，请切回原账号');
    const rows=result.submissions,signature=rows.map(row=>row.id).join(',');
    if(seen.has(signature)||result.hasNext&&!rows.length)throw Error('QOJ 分页未覆盖原提交，请手动核对');
    seen.add(signature);
    for(const row of rows){
      if(row.own===false||row.problem&&row.problem!==problemId)continue;
      const timestamp=row.at??(await detail(row.id)).at;
      if(timestamp===null)throw Error('QOJ 未提供足够的提交时间，无法安全重发');
      if(timestamp<earliest||timestamp>latest)continue;
      if(row.own!==true||row.problem!==problemId)throw Error('QOJ 列表有无法确认账号或题号的记录');
      if(!job.source)return{needs_source:true};
      const entry=await detail(row.id);
      if(!entry.source)throw Error('有可能对应的 QOJ 提交，但无法读取源码核对');
      if(normalizedSource(entry.source)===normalizedSource(job.source))matches.add(row.id);
    }
    if(matches.size>1)throw Error('原发送时间附近有多条相同源码的提交，请在 QOJ 核对');
    if(!result.hasNext)return{qoj_id:[...matches][0]};
    // QOJ pages are newest first. Only stop early on a verified older boundary.
    const descending=rows.every((row,i)=>!i||Number(rows[i-1].id)>Number(row.id));
    const tail=rows.at(-1);
    const tailTime=descending?(tail.at??(await detail(tail.id)).at):null;
    if(tailTime!==null&&tailTime<earliest)return{qoj_id:[...matches][0]};
  }
  throw Error('核对页数达到上限，尚未覆盖原发送时间');
}

function rejudgeCompiler(job,options){
  const exact=job.identity.qoj_language;
  if(exact)return options.find(option=>option.value===exact)?.value;
  const label=String(job.language||'').trim().toLowerCase();
  const known=options.find(option=>[option.value,option.label].some(value=>value.toLowerCase()===label));
  if(known)return known.value;
  const family=value=>/c\s*\+\+|cpp/i.test(value)?'cpp':/python\s*3|pypy\s*3/i.test(value)?'python3':/\bjava/i.test(value)?'java':/\bc(?:\s*\d|\s|$)/i.test(value)?'c':'';
  const kind=family(label),matches=options.filter(option=>kind&&family(`${option.value} ${option.label}`)===kind);
  return (matches.find(option=>option.value===job.session.language_defaults?.[kind])||(matches.length===1?matches[0]:null))?.value;
}

async function rejudgeQojSolution(url,contestId,job,host,beforeSend){
  if(job.attempt.qoj_id)return{outcome:'accepted',qoj_id:job.attempt.qoj_id,message:'已找到 QOJ 提交'};
  const definite=job.attempt.status==='send_failed'&&!job.attempt.delivery_checked_by_host;
  try{
    const mapped=await parseQojInHost(host,'problem',{...await fetchQojHtml(url.href,{fresh:true,networkOnly:true}),label:job.problem});
    const problemId=mapped.problem_id,handle=job.identity.qoj_handle||mapped.handle;
    if(!problemId||job.identity.qoj_problem_id&&job.identity.qoj_problem_id!==problemId)throw Error('原题目与当前 QOJ 题目不匹配');
    if(!handle||mapped.handle!==handle)throw Error('请在主机浏览器登录原 QOJ 账号');
    const evidence=await reconcileQojAttempt(url,contestId,problemId,handle,job,host);
    if(evidence.qoj_id)return{outcome:'accepted',qoj_id:evidence.qoj_id,message:'已核对并恢复原 QOJ 编号'};
    if(evidence.needs_source)return{outcome:definite?'failed':'uncertain',needs_source:true,message:'没有保存原源码；再次点 Rejudge，选择这次提交的原始文件。'};
    const originalTime=job.attempt.send_started_at_ms||job.attempt.submitted_at_ms;
    if(!definite&&job.now_ms-originalTime<30000)return{outcome:'uncertain',message:'QOJ 记录可能还没更新，请在原发送 30 秒后再核对。'};
    if(!job.window.can_submit)return{outcome:'failed',message:`QOJ 未找到对应提交；${job.window.reason}。`};
    if(!job.source)return{outcome:'failed',needs_source:true,message:'QOJ 未找到对应提交。再次点 Rejudge，选择原始源码文件后可重发。'};
    const opened=await inspectQojProblem(url,contestId,problemId,host);
    const language=rejudgeCompiler(job,opened.info.languages);
    if(!language)return{outcome:'failed',message:'QOJ 未找到对应提交，但无法确认原编译器。请在 Submit 选定语言后手动提交。'};
    return sendQojSolution(url,contestId,problemId,host,{request_id:job.id,source:job.source,language,handle},beforeSend,opened);
  }catch(error){return{outcome:definite?'failed':'uncertain',message:'核对未完成，未重新发送：'+String(error.message).slice(0,260)}}
}

let submitReceiptFlush=null;
async function flushSubmitReceipts(){
  if(submitReceiptFlush)return submitReceiptFlush;
  submitReceiptFlush=(async()=>{
    const saved=await chrome.storage.local.get(null);
    for(const [key,receipt] of Object.entries(saved)){
      if(!key.startsWith('submitReceipt:'))continue;
      try{
        const base=new URL(receipt.base);
        if(base.protocol!=='http:'||!['127.0.0.1','localhost'].includes(base.hostname))continue;
        const response=await fetch(base.origin+(receipt.relay_job_id?'/api/submit-relay/finish':'/api/submit/finish'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(receipt),signal:AbortSignal.timeout(10000)});
        if(response.ok||response.status===400)await chrome.storage.local.remove(key);
      }catch{}
    }
  })().catch(()=>{}).finally(()=>{submitReceiptFlush=null});
  return submitReceiptFlush;
}
async function storeSubmitReceipt(base,sessionId,requestId,outcome,relay={}){
  const id='submit-'+requestId,key=`submitReceipt:${base}:${sessionId}:${id}`;
  await chrome.storage.local.set({[key]:{base,session_id:sessionId,id,...outcome,...relay}});
  void flushSubmitReceipts();
}

const qojRelayPumps=new Map();
async function processRemoteSubmissions(sender){
  const host=qojHost(sender);
  void flushSubmitReceipts();
  if(qojRelayPumps.has(host.origin))return{};
  const pending=(async()=>{
    const relayPost=async(action,body)=>{
      const response=await fetch(host.origin+'/api/submit-relay/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
      const value=await response.json();if(!response.ok)throw Error(value.error||'主机连接中断');return value;
    };
    const {job}=await relayPost('claim',{});if(!job)return{};
    const receipt={relay_job_id:job.id,relay_claim:job.claim};
    let begun=false,value;
    try{
      const {url,contestId}=qojContestUrl(job.session.qoj_url);
      let problemId=job.problem_id;
      if(job.action==='source'){
        value={source_details:await readQojSource(new URL('/submission/'+job.qoj_id,url).href,host)};
      }else if(job.action==='inspect'){
        const opened=await readQojSubmitForm(url,contestId,host,{problem:job.problem});
        value={info:{...opened.info,problem_id:opened.problemId}};
      }else if(job.action==='rejudge'){
        value=await rejudgeQojSolution(url,contestId,job,host,async identity=>{
          const gate=await relayPost('begin',{...receipt,...identity});begun=true;return gate;
        });
      }else{
        value=await sendQojSolution(url,contestId,problemId,host,{
          request_id:job.id,source:job.source,language:job.language,handle:job.handle,
        },async identity=>{
          // Cancellation, expiration and contest/permission changes are checked
          // by this one-time server gate immediately before the QOJ code POST.
          const gate=await relayPost('begin',{...receipt,...identity});begun=true;return gate;
        });
      }
    }catch(error){value={outcome:begun?'uncertain':'failed',message:(job.action==='source'?'源码读取失败：':begun?'提交回执未确认，请先检查 QOJ。 ':'代码未发送：')+String(error.message).slice(0,250)}}
    if(job.action==='source'){
      // Source stays in the server cache, never in persistent extension receipts.
      // A lost acknowledgement can safely retry this read, without posting code.
      await relayPost('finish',{...receipt,...value});return{};
    }
    await storeSubmitReceipt(host.origin,job.session.session_id,job.id,value,receipt);
    return{};
  })().finally(()=>qojRelayPumps.delete(host.origin));
  qojRelayPumps.set(host.origin,pending);return pending;
}
function qojContestUrl(value){
  const url=new URL(value),match=url.pathname.match(/^\/contest\/(\d+)\/?$/);
  if(url.protocol!=='https:'||!['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname)||!match||url.username||url.password||url.port)throw Error('QOJ 比赛地址无效');
  url.search='';url.hash='';return{url,contestId:match[1]};
}
async function handleQojSubmit(message,sender){
  const host=qojHost(sender),payload=message.payload||{};
  const started=globalThis.performance?.now?.()??Date.now();
  if(message.type==='VP_CLOSE_SUBMIT_FORM'){
    const form=qojSubmitForms.get(payload.form_key);
    if(form&&form.base===host.origin&&form.tabId===host.tabId)qojSubmitForms.delete(payload.form_key);
    return{};
  }
  const readSession=async()=>{
    const response=await fetch(host.origin+'/api/session',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    const state=await response.json();
    if(!response.ok||!state.can_manage)throw Error('网页提交只接受主机控制台操作');
    return state;
  };
  const current=await readSession(),session=current.session;
  if(message.type==='VP_FETCH_QOJ_SOURCE')return readQojSource(payload.url,host);
  if(message.type==='VP_INSPECT_QOJ_LANGUAGES'){
    const {url,contestId}=qojContestUrl(payload.qoj_url);
    return(await inspectQojProblem(url,contestId,payload.problem_id,host)).info;
  }
  if(!session||session.session_id!==payload.session_id)throw Error('当前比赛已切换，请重新打开 Submit');
  const {url,contestId}=qojContestUrl(session.qoj_url);
  if(message.type==='VP_OPEN_SUBMIT_FORM'){
    if(current.submission_window&&!current.submission_window.can_submit)throw Error(current.submission_window.reason);
    const opened=await readQojSubmitForm(url,contestId,host,payload),key=crypto.randomUUID();
    if((globalThis.performance?.now?.()??Date.now())-started>24000)throw Error('QOJ 提交表单读取超时，代码未发送，请重新读取');
    qojSubmitForms.set(key,{tabId:host.tabId,base:host.origin,session_id:session.session_id,problem_id:opened.problemId,handle:opened.info.handle,requests:new Map()});
    return{...opened.info,form_key:key};
  }
  const form=qojSubmitForms.get(payload.form_key);
  if(!form||form.base!==host.origin||form.tabId!==host.tabId||form.session_id!==session.session_id)throw Error('QOJ 表单已失效，请重新选择题目');
  if(form.requests.has(payload.request_id))return form.requests.get(payload.request_id);
  const pending=(async()=>{
    const value=current.submission_window&&!current.submission_window.can_submit?
      {outcome:'failed',message:current.submission_window.reason+'，代码未发送'}:
      await sendQojSolution(url,contestId,form.problem_id,host,{...payload,handle:form.handle},async identity=>{
        const latest=(await readSession()).session;
        if(latest?.session_id!==session.session_id||latest.qoj_url!==session.qoj_url||qojSubmitForms.get(payload.form_key)!==form)throw Error('比赛或提交选择已变化，代码尚未发送');
        const response=await fetch(host.origin+'/api/submit/begin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:session.session_id,id:'submit-'+payload.request_id,...identity}),signal:AbortSignal.timeout(15000)});
        const gate=await response.json();
        if(!response.ok)throw Error(response.status===404?'榜单服务需要更新，请重启 server.py 后刷新网页':gate.error||'提交已取消，代码未发送');
        return gate;
      });
    // Persist only the acknowledgement. Recovery never repeats the code POST.
    await storeSubmitReceipt(host.origin,session.session_id,payload.request_id,value);
    return value;
  })();
  form.requests.set(payload.request_id,pending);return pending;
}

chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type==='VP_SUBMIT_BRIDGE_PING'){
    try{qojHost(sender);reply({ok:true,body:{connected:true}})}
    catch(error){reply({ok:false,error:error.message})}
    return false;
  }
  if(!['VP_INSPECT_QOJ_LANGUAGES','VP_OPEN_SUBMIT_FORM','VP_SEND_SOLUTION','VP_CLOSE_SUBMIT_FORM','VP_PROCESS_REMOTE_SUBMISSIONS','VP_FETCH_QOJ_SOURCE'].includes(message?.type))return false;
  (message.type==='VP_PROCESS_REMOTE_SUBMISSIONS'?processRemoteSubmissions(sender):handleQojSubmit(message,sender)).then(body=>reply({ok:true,body}),error=>reply({ok:false,error:error.message,qoj_kind:error.qojKind,retry_after_ms:error.retryAfterMs}));
  return true;
});
void flushSubmitReceipts();
