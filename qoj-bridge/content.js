/* Read QOJ account pages in the browser; never copy login cookies or passwords. */
(function(){
  const syncClock=()=>globalThis.performance?.now?.()??Date.now();
  const norm=value=>String(value||'').trim().replace(/\s+/g,' ');
  const bridge=(type,payload)=>new Promise((resolve,reject)=>chrome.runtime.sendMessage({type,payload},response=>{
    if(response?.ok){resolve(response.body);return}
    const error=Error(response?.error||chrome.runtime.lastError?.message||'本地连接失败');
    error.qojKind=response?.qoj_kind;error.qojStatus=response?.qoj_status;error.retryAfterMs=response?.retry_after_ms;reject(error);
  }));
  function detectHandle(root=document){
    return xcpcQojAccount(root);
  }
  const verdict=value=>{
    const s=norm(value).toLowerCase();
    const formal=s.split(/[,，;；/|]/,1)[0].trim();
    if(/^(ac|accepted|correct|100(?:\.0+)?|通过|正确)(?:\b|$)/i.test(formal))return'correct';
    if(/^(ce|compile error|compilation error|compiler error|编译错误)(?:\b|$)/i.test(formal))return'compile_error';
    if(/^(ml|mle|memory limit|memory limit exceeded)(?:\b|$)/i.test(formal))return'memory_limit';
    if(/^(tl|tle|time limit|time limit exceeded)(?:\b|$)/i.test(formal))return'time_limit';
    if(/^(wa|wrong answer)(?:\b|$)/i.test(formal))return'wrong_answer';
    if(/^(re|runtime error)(?:\b|$)/i.test(formal))return'runtime_error';
    if(/^(ole|output limit)(?:\b|$)/i.test(formal))return'output_limit';
    if(/^(pe|presentation error)(?:\b|$)/i.test(formal))return'presentation_error';
    if(/^(ie|unaccepted|not accepted|错误|超时|未通过)(?:\b|$)/i.test(formal))return'incorrect';
    if(/^(pending|judging|waiting|running|queued|compiling|submitted|评测中|等待)(?:\b|$)/i.test(formal))return'pending';
    return null;
  };
  const dateOf=value=>{
    const match=norm(value).match(/(20\d\d)[-/](\d\d?)[-/](\d\d?)[ T]?(\d\d?):(\d\d)(?::(\d\d))?(?:\s*(UTC|GMT)([+-]?\d{1,2})?)?/i);
    if(!match)return null;
    const [,year,month,day,hour,minute,second='0',zone,offset='0']=match;
    const parts=[year,month,day,hour,minute,second].map(Number);
    if(parts.slice(1,3).some((part,index)=>part<1||part>[12,31][index])||parts[3]>23||parts[4]>59||parts[5]>59)return null;
    const time=zone?Date.UTC(parts[0],parts[1]-1,parts[2],parts[3]-Number(offset),parts[4],parts[5]):Date.UTC(parts[0],parts[1]-1,parts[2],parts[3]-8,parts[4],parts[5]);
    return Number.isFinite(time)?time:null;
  };
  const elapsedSecondsOf=value=>{
    const match=norm(value).match(/(?:^|\D)(\d{1,3}):(\d{2}):(\d{2})(?!\d)/);
    if(!match)return null;
    const hours=Number(match[1]),minutes=Number(match[2]),seconds=Number(match[3]);
    if(minutes>=60||seconds>=60)return null;
    return hours*3600+minutes*60+seconds;
  };
  const submissionTimeOf=(candidates,startAtMs)=>{
    const absolute=candidates.map(dateOf).find(value=>value!==null);
    if(absolute!==undefined)return absolute;
    const elapsed=candidates.map(elapsedSecondsOf).find(value=>value!==null);
    return elapsed===undefined||!Number.isFinite(Number(startAtMs))?null:Number(startAtMs)+elapsed*1000;
  };
  const absoluteSubmissionTimeFromDetail=doc=>{
    const labelPattern=/submit(?:ted|ting)?\s*time|submission\s*time|提交时间|提交时刻/i;
    const valuesOf=element=>[element?.getAttribute?.('datetime'),element?.getAttribute?.('title'),element?.textContent,
      ...[...(element?.querySelectorAll?.('[datetime],[title]')||[])].flatMap(child=>[child.getAttribute('datetime'),child.getAttribute('title'),child.textContent])];
    for(const row of doc.querySelectorAll('tr')){
      const cells=[...row.querySelectorAll('th,td')];
      const labelIndex=cells.findIndex(cell=>labelPattern.test(norm(cell.textContent)));
      if(labelIndex<0)continue;
      const found=cells.slice(labelIndex+1).flatMap(valuesOf).map(dateOf).find(value=>value!==null);
      if(found!==undefined)return found;
    }
    for(const label of doc.querySelectorAll('dt,label,strong,b,.control-label,.form-label')){
      if(!labelPattern.test(norm(label.textContent)))continue;
      const candidates=[label.nextElementSibling,label.parentElement?.querySelector('dd,time,[datetime],.form-control-static'),label.parentElement];
      const found=candidates.filter(Boolean).flatMap(valuesOf).map(dateOf).find(value=>value!==null);
      if(found!==undefined)return found;
    }
    const labelledText=[...doc.querySelectorAll('main,.card,.panel,body')].map(element=>norm(element.textContent)).find(text=>labelPattern.test(text));
    return labelledText?dateOf(labelledText):null;
  };
  const normalizeSubmissionClock=(row,session,submissionOffsetMs=0,managed=false)=>{
    const automatic=session.timing_source!=='manual';
    // A Submit receipt must use QOJ's actual receipt time, including after VP ends.
    if(managed){
      if(!Number.isFinite(row.absolute_submitted_at_ms))return null;
      return {...row,submitted_at_ms:row.absolute_submitted_at_ms,contest_time_seconds:(row.absolute_submitted_at_ms-(session.clock_start_at_ms||session.start_at_ms))/1000,time_source:'absolute'};
    }
    if(automatic&&Number.isFinite(row.contest_time_seconds)){
      const contestTime=Math.max(0,row.contest_time_seconds-submissionOffsetMs/1000);
      return {...row,contest_time_seconds:contestTime,submitted_at_ms:session.start_at_ms+contestTime*1000,time_source:'relative'};
    }
    if((!automatic||managed)&&Number.isFinite(row.absolute_submitted_at_ms)){
      return {...row,submitted_at_ms:row.absolute_submitted_at_ms,contest_time_seconds:(row.absolute_submitted_at_ms-(managed?session.clock_start_at_ms||session.start_at_ms:session.start_at_ms))/1000,time_source:'absolute'};
    }
    return null;
  };
  async function readQojDocument(url){
    const parsed=new URL(url);
    const response=await bridge('VP_FETCH_QOJ_PAGE',{url:parsed.href});
    const issue=xcpcQojPageIssue(response.html,response.url||parsed.href,response.status||200);
    if(issue){const error=Error(issue.message);error.qojKind=issue.kind;throw error}
    return new DOMParser().parseFromString(response.html,'text/html');
  }
  async function contestMap(url){
    const doc=await readQojDocument(url);
    const map=new Map();
    map.detectedHandle=detectHandle(doc);
    for(const tr of doc.querySelectorAll('tr')){
      const label=norm(tr.querySelector('td')?.textContent).match(/^([A-Z])$/)?.[1];
      const id=tr.querySelector('a[href*="/problem/"]')?.getAttribute('href')?.match(/\/problem\/(\d+)/)?.[1];
      if(label&&id)map.set(id,label);
    }
    if(!map.size)throw Error('未从 QOJ 比赛页识别到题号映射');
    return map;
  }
  function parseSubmissions(doc,handle,map,unknownVerdicts,startAtMs){
    const rows=[];
    const showAll=[...doc.querySelectorAll('label')].find(label=>/show all submissions|显示(?:全部|所有)提交/i.test(norm(label.textContent)))?.querySelector('input[type="checkbox"]');
    const personalView=Boolean(showAll&&!showAll.checked);
    for(const tr of doc.querySelectorAll('table tr')){
      const cells=[...tr.querySelectorAll('td')];if(cells.length<3)continue;
      const link=tr.querySelector('a[href*="/submission/"]');
      const id=link?.getAttribute('href')?.match(/\/submission\/(\d+)/)?.[1];if(!id)continue;
      const table=tr.closest('table'),headers=[...table.querySelectorAll('thead th')].map(th=>norm(th.textContent).toLowerCase());
      const userLinks=[...tr.querySelectorAll('a[href*="/user/profile/"]')];
      const ownerIndex=headers.findIndex(h=>/submitter|user|owner|提交者|提交人|用户/.test(h));
      const ownerShown=handle&&(userLinks.length?userLinks.some(a=>decodeURIComponent(a.getAttribute('href')||'').split('/').pop().toLowerCase()===handle.toLowerCase()):ownerIndex>=0&&norm(cells[ownerIndex]?.textContent).toLowerCase()===handle.toLowerCase());
      if(!personalView&&!ownerShown)continue;
      const problemLink=tr.querySelector('a[href*="/problem/"]');
      const problemId=problemLink?.getAttribute('href')?.match(/\/problem\/(\d+)/)?.[1];
      const problem=map.get(problemId);if(!problem)continue;
      const timeIndex=headers.findIndex(h=>/submit.*time|提交时间|提交时刻|submission time/.test(h));
      const resultIndices=headers.map((h,i)=>({h,i})).filter(({h})=>/result|verdict|status|score|结果|状态|评测/.test(h)&&!/extra|hack|补测|追加/.test(h)).sort((a,b)=>Number(/status|状态/.test(a.h))-Number(/status|状态/.test(b.h))).map(({i})=>i);
      if(timeIndex<0||timeIndex>=cells.length||!resultIndices.length)continue;
      const timeCell=cells[timeIndex];
      const candidates=[timeCell.getAttribute('title'),...[...timeCell.querySelectorAll('[title],[datetime]')].flatMap(e=>[e.getAttribute('datetime'),e.getAttribute('title')]),timeCell.textContent];
      const absolute_submitted_at_ms=candidates.map(dateOf).find(value=>value!==null);
      const submitted_at_ms=submissionTimeOf(candidates,startAtMs);
      if(submitted_at_ms==null)continue;
      const contest_time_seconds=candidates.map(elapsedSecondsOf).find(value=>value!==null);
      let status=null;
      for(const index of resultIndices){
        const cell=cells[index];if(!cell)continue;
        const candidates=[cell.textContent,cell.getAttribute('title'),...[...cell.querySelectorAll('[title],[data-original-title]')].flatMap(e=>[e.getAttribute('title'),e.getAttribute('data-original-title')])];
        status=candidates.map(verdict).find(Boolean)||null;
        if(status)break;
        const raw=norm(cell.textContent);if(raw&&unknownVerdicts.size<3)unknownVerdicts.add(raw.slice(0,40));
      }
      if(!status||status==='ignored')continue;
      const field=pattern=>norm(cells[headers.findIndex(h=>pattern.test(h))]?.textContent).slice(0,100);
      rows.push({id,problem,submitted_at_ms,status,contest_time_seconds,absolute_submitted_at_ms,language:field(/language|语言/),runtime:field(/^(?:time|runtime|用时)$/),memory:field(/memory|内存/)});
    }
    return rows;
  }
  if(globalThis.__XCPC_QOJ_TEST__){Object.assign(globalThis.__XCPC_QOJ_TEST__,{detectHandle,verdict,dateOf,elapsedSecondsOf,submissionTimeOf,absoluteSubmissionTimeFromDetail,normalizeSubmissionClock,parseSubmissions});return}
  globalThis.xcpcOpenQojVerification=url=>bridge('VP_OPEN_QOJ_VERIFICATION',{url});
  const onQoj=/^https:\/\/(?:qoj\.ac|training\.qoj\.ac|pjudge\.ac)$/.test(location.origin);
  if(!onQoj&&!document.getElementById('qojUrl'))return;
  let readerStarted=false,bridgeDisconnected=false;
  document.addEventListener('xcpc-submit-bridge-disconnected',()=>{bridgeDisconnected=true});
  function startReader(){
  if(readerStarted)return;readerStarted=true;
  let lastFullSweep=0,lastFullSweepSession='',running=false,cachedMap=null,cachedMapUrl='',cachedMapAt=0,nextSyncAt=0,lastSyncSession='',lastQojOrigin='',resumeQueued=false,hasSession=false;
  let sweepActive=false,sweepNextPage=2;
  const sweepSignatures=new Set();
  const detailTimeCache=new Map(),pendingRows=new Map();
  async function currentContestMap(url){
    if(cachedMap&&cachedMapUrl===url&&syncClock()-cachedMapAt<60000)return cachedMap;
    cachedMap=await contestMap(url);cachedMapUrl=url;cachedMapAt=syncClock();return cachedMap;
  }
  function submissionInfoFromDetail(doc){
    const info={absolute_submitted_at_ms:absoluteSubmissionTimeFromDetail(doc),language:'',runtime:'',memory:'',status:null};
    const setField=(label,value)=>{
      const key=norm(label).toLowerCase(),text=norm(value).slice(0,100);if(!text)return;
      if(/language|语言/.test(key))info.language=text;
      else if(/^(?:status|状态)$|result|verdict|judge.*status|结果|评测状态|评测结果/.test(key))info.status=verdict(text)||info.status;
      else if(/^(?:time|runtime|用时|运行时间)$/.test(key))info.runtime=text;
      else if(/memory|内存/.test(key))info.memory=text;
    };
    for(const tr of doc.querySelectorAll('tr')){
      const cells=[...tr.children];if(cells.length===2)setField(cells[0].textContent,cells[1].textContent);
    }
    for(const table of doc.querySelectorAll('table')){
      const headers=[...table.querySelectorAll('thead th')],cells=[...table.querySelectorAll('tbody tr:first-child td')];
      headers.forEach((header,index)=>setField(header.textContent,cells[index]?.textContent));
    }
    return info;
  }
  async function detailSubmissionInfo(origin,id,refreshStatus=false){
    const cached=detailTimeCache.get(id);
    if(cached&&((refreshStatus||cached.info.status==='pending')?syncClock()-cached.checkedAt<2000:cached.info.absolute_submitted_at_ms!==null||syncClock()-cached.checkedAt<30000))return cached.info;
    const url=new URL(`/submission/${id}`,origin);
    const info=submissionInfoFromDetail(await readQojDocument(url));
    if(info.absolute_submitted_at_ms===null&&!info.status&&!info.language)throw Error('未能读取 QOJ 提交详情，稍后自动重试');
    detailTimeCache.set(id,{info,checkedAt:syncClock()});
    if(detailTimeCache.size>1000)detailTimeCache.delete(detailTimeCache.keys().next().value);
    return info;
  }
  async function fillAbsoluteSubmissionTimes(rows,origin,requireAbsolute=true){
    // A final list verdict with an absolute timestamp is already authoritative.
    // Missing optional metadata must not force a visit to a blocked detail page.
    const missing=rows.filter(row=>requireAbsolute&&!Number.isFinite(row.absolute_submitted_at_ms));
    let next=0,resolved=0,failures=0,error=null;
    const worker=async()=>{
      while(next<missing.length){
        const row=missing[next++];
        try{
          const info=await detailSubmissionInfo(origin,row.id,row.status==='pending');
          if(Number.isFinite(info.absolute_submitted_at_ms)){row.absolute_submitted_at_ms=info.absolute_submitted_at_ms;resolved++}
          for(const key of ['language','runtime','memory'])if(!row[key]&&info[key])row[key]=info[key];
          if(row.status==='pending'&&info.status)row.status=info.status;
        }catch(cause){failures++;error=error||cause;if(['verification','login','rate_limit'].includes(cause.qojKind))next=missing.length}
      }
    };
    await Promise.all(Array.from({length:Math.min(4,missing.length)},worker));
    return{resolved,failures,error};
  }
  async function sync(){
    if(running||bridgeDisconnected)return;
    running=true;
    let activeContestId='',activeSessionId='',liveListRead=false;
    try{
      const saved=await chrome.storage.local.get('handle');
      const detected=onQoj?detectHandle():'';
      let handle=detected||saved.handle||'';
      if(detected)await chrome.storage.local.set({detectedHandle:detected});
      const {session,submit_ids=[],submit_refs=[],pending_refs=[]}=await bridge('VP_GET_SESSION');hasSession=Boolean(session);if(!session)return;
      if(lastSyncSession!==session.session_id){lastSyncSession=session.session_id;nextSyncAt=0;pendingRows.clear();detailTimeCache.clear();sweepActive=false;sweepNextPage=2;sweepSignatures.clear()}
      for(const row of pending_refs)if(/^\d{1,15}$/.test(String(row.id))&&!pendingRows.has(String(row.id)))pendingRows.set(String(row.id),row);
      if(syncClock()<nextSyncAt)return;
      const managedIds=new Set(submit_ids);
      activeContestId=String(session.qoj_contest_id||'');
      activeSessionId=session.session_id;
      // A live extension alone does not prove QOJ was read successfully.
      let result={count:0,changed:0};
      const origin=new URL(session.qoj_url).origin;
      lastQojOrigin=origin;
      const map=await currentContestMap(session.qoj_url);
      if(!handle&&map.detectedHandle){handle=map.detectedHandle;await chrome.storage.local.set({detectedHandle:handle})}
      const url=new URL(`/contest/${session.qoj_contest_id}/submissions`,origin);
      const fullSweep=lastFullSweepSession!==activeSessionId||syncClock()-lastFullSweep>300000;
      if(fullSweep&&!sweepActive){sweepActive=true;sweepNextPage=2;sweepSignatures.clear()}
      const scanStarted=syncClock();let sweepComplete=false;
      const rows=[],unknownVerdicts=new Set(),submissionOffsetMs=Number(session.qoj_submission_clock_offset_ms||0),submissionClockStart=session.start_at_ms-submissionOffsetMs;
      const automatic=session.timing_source!=='manual';
      let skippedForTimeSource=0,detailTimesResolved=0,detailFailures=0,detailError=null;
      const pageSignatures=new Set();
      const publishedRows=new Map();
      const publish=async batch=>{
        const changed=[];
        for(const row of batch){
          const signature=JSON.stringify(row);
          if(publishedRows.get(row.id)!==signature){publishedRows.set(row.id,signature);changed.push(row);rows.push(row)}
          if(row.status==='pending')pendingRows.set(String(row.id),row);else pendingRows.delete(String(row.id));
        }
        if(changed.length){
          const next=await bridge('VP_POST_SUBMISSIONS',{qoj_contest_id:session.qoj_contest_id,session_id:activeSessionId,rows:changed});
          result={count:next.count,changed:result.changed+next.changed};
          if(!onQoj)document.dispatchEvent(new Event('xcpc-qoj-sync-updated'));
        }
      };
      let lastProgressReport=syncClock();
      for(let part=0;part<(fullSweep?6:1);part++){
        // Always return to the newest page between bounded historical chunks.
        const page=part===0?1:sweepNextPage;
        if(page>100){sweepComplete=true;break}
        url.searchParams.set('page',String(page));
        const doc=await readQojDocument(url);
        if(![...doc.querySelectorAll('table th')].some(cell=>/result|verdict|status|结果|状态|评测/i.test(norm(cell.textContent))))throw Error('未能读取 QOJ 提交列表，稍后自动重试');
        if(page===1)liveListRead=true;
        const pageIds=[...doc.querySelectorAll('a[href*="/submission/"]')].map(link=>link.getAttribute('href')?.match(/\/submission\/(\d+)/)?.[1]).filter(Boolean);
        if(!pageIds.length){sweepComplete=true;break}
        // Some QOJ deployments clamp an out-of-range page to the last page. Stop
        // when that page is returned again instead of requesting it up to page 100.
        const signature=pageIds.join(',');
        if(pageSignatures.has(signature)||page>1&&sweepSignatures.has(signature)){sweepComplete=true;break}
        pageSignatures.add(signature);
        const parsedRows=parseSubmissions(doc,handle,map,unknownVerdicts,submissionClockStart);
        // Publish already authoritative list rows before optional timestamp work.
        await publish(parsedRows.map(row=>normalizeSubmissionClock(row,session,submissionOffsetMs,managedIds.has(row.id))).filter(Boolean));
        const previousFailures=detailFailures,previousSkipped=skippedForTimeSource;
        let hydration;
        if(!automatic){hydration=await fillAbsoluteSubmissionTimes(parsedRows.filter(row=>!managedIds.has(row.id)),origin);detailTimesResolved+=hydration.resolved;detailFailures+=hydration.failures;detailError=detailError||hydration.error}
        else{hydration=await fillAbsoluteSubmissionTimes(parsedRows.filter(row=>row.status==='pending'&&!managedIds.has(row.id)),origin,false);detailFailures+=hydration.failures;detailError=detailError||hydration.error}
        hydration=await fillAbsoluteSubmissionTimes(parsedRows.filter(row=>managedIds.has(row.id)),origin,true);detailTimesResolved+=hydration.resolved;detailFailures+=hydration.failures;detailError=detailError||hydration.error;
        const normalizedRows=parsedRows.map(row=>{
          const normalized=normalizeSubmissionClock(row,session,submissionOffsetMs,managedIds.has(row.id));
          if(!normalized){
            skippedForTimeSource++;
            return null;
          }
          return normalized;
        }).filter(Boolean);
        await publish(normalizedRows);
        if(normalizedRows.length){
          lastProgressReport=syncClock();
        }else if(syncClock()-lastProgressReport>=3000){
          result=await bridge('VP_POST_SUBMISSIONS',{qoj_contest_id:session.qoj_contest_id,session_id:activeSessionId,rows:[]});
          lastProgressReport=syncClock();
        }
        if(detailFailures!==previousFailures||skippedForTimeSource!==previousSkipped)break;
        if(page>1){sweepNextPage=page+1;sweepSignatures.add(signature)}
        if(syncClock()-scanStarted>=1500)break;
      }
      // A managed Submit may be accepted by QOJ after VP ends and disappear
      // from its contest-only list. Its confirmed ID can still be read directly.
      const listedIds=new Set(rows.map(row=>row.id)),backfilled=[];
      const refs=new Map([...pendingRows].map(([id,row])=>[id,{id,problem:row.problem,row,managed:managedIds.has(id)}]));
      for(const ref of submit_refs)refs.set(String(ref.id),{...ref,managed:true});
      for(const ref of [...refs.values()].sort((a,b)=>Number(b.managed)-Number(a.managed))){
        if(listedIds.has(String(ref.id)))continue;
        try{
          const info=await detailSubmissionInfo(origin,String(ref.id),true);
          if(!info.status||ref.managed&&!Number.isFinite(info.absolute_submitted_at_ms))throw Error('未能读取 QOJ 提交结果，稍后自动重试');
          const row=ref.managed?normalizeSubmissionClock({id:String(ref.id),problem:ref.problem,...info,status:info.status},session,submissionOffsetMs,true):{...ref.row,...info,status:info.status};
          if(row){rows.push(row);backfilled.push(row);detailTimesResolved++;if(row.status!=='pending')pendingRows.delete(String(ref.id))}
        }catch(cause){detailFailures++;detailError=detailError||cause}
      }
      if(backfilled.length){
        const next=await bridge('VP_POST_SUBMISSIONS',{qoj_contest_id:session.qoj_contest_id,session_id:activeSessionId,rows:backfilled});
        result={count:next.count,changed:result.changed+next.changed};
      }
      if(detailFailures)throw detailError||Error('部分 QOJ 提交详情暂未读取成功，稍后自动重试');
      if(skippedForTimeSource)throw Error(`${skippedForTimeSource} 条提交尚未取得有效时间，稍后自动补查`);
      const confirmed=await bridge('VP_POST_SUBMISSIONS',{qoj_contest_id:session.qoj_contest_id,session_id:activeSessionId,rows:[]});
      result={...result,count:confirmed.count};
      nextSyncAt=0;
      // Missing detail timestamps can also be caused by a temporary outage.
      // Leave the sweep incomplete so old pages are revisited on recovery.
      if(fullSweep&&sweepComplete&&skippedForTimeSource===0&&detailFailures===0){lastFullSweep=syncClock();lastFullSweepSession=activeSessionId;sweepActive=false}
      const unique=[...new Map(rows.map(row=>[row.id,row])).values()];
      await chrome.storage.local.set({lastResult:`已连接并检查 ${unique.length} 条，本队累计 ${result.count} 条；本轮 ${result.changed} 条状态更新。${detailTimesResolved?`已从提交详情补全 ${detailTimesResolved} 条绝对时间。`:''}${skippedForTimeSource?`另有 ${skippedForTimeSource} 条缺少${automatic?'相对比赛时间':'绝对提交时间'}，已跳过。`:''}${unknownVerdicts.size?'其他未识别结果：'+[...unknownVerdicts].join(' / ')+'。':''}${new Date().toLocaleTimeString()}`});
    }catch(error){
      if(bridgeDisconnected||/extension context invalidated/i.test(String(error.message))){bridgeDisconnected=true;return}
      const pageOnly=liveListRead&&['verification','http'].includes(error.qojKind)&&error.qojStatus!==429&&!(error.qojStatus>=500);
      nextSyncAt=pageOnly?0:syncClock()+Math.max(2000,Number(error.retryAfterMs)||(['verification','login'].includes(error.qojKind)?5000:2000));
      const message=String(error?.message||error||'未知错误').slice(0,240);
      try{await chrome.storage.local.set({lastResult:'同步失败：'+message})}catch{bridgeDisconnected=true;return}
      if(activeContestId)try{await bridge('VP_POST_SYNC_ERROR',{qoj_contest_id:activeContestId,session_id:activeSessionId,error:message})}catch{}
    }
    finally{
      running=false;
      if(!onQoj)document.dispatchEvent(new Event('xcpc-qoj-sync-updated'));
      if(resumeQueued){resumeQueued=false;nextSyncAt=0;void sync()}
    }
  }
  chrome.runtime.onMessage?.addListener((message,sender,reply)=>{
    if(message?.type==='VP_QOJ_SYNC_TICK'){
      sync().then(()=>reply({ok:true,delay_ms:hasSession?1000:5000}),()=>reply({ok:true,delay_ms:2000}));return true;
    }
    if(message?.type!=='VP_QOJ_SYNC_RESUME')return false;
    void xcpcResumeQojReads(message.origin).then(()=>{
      if(message.origin!==lastQojOrigin)return;
      nextSyncAt=0;
      for(const [id,cached] of detailTimeCache)if(cached.info.status==='pending'||cached.info.absolute_submitted_at_ms===null)detailTimeCache.delete(id);
      if(running)resumeQueued=true;else void sync();
    });
    return false;
  });
  let registrationTimer=null;
  const register=()=>{
    if(registrationTimer!==null){clearTimeout(registrationTimer);registrationTimer=null}
    if(bridgeDisconnected)return;
    void bridge('VP_QOJ_READER_READY').catch(error=>{
      if(/extension context invalidated/i.test(String(error.message)))return;
      registrationTimer=setTimeout(register,2000);
    });
  };
  // The worker sends messages at the live cadence even while this page is hidden.
  // Multiple Home/QOJ tabs register, but only one scanner is elected.
  register();
  window.addEventListener('pageshow',register);
  window.addEventListener('online',register);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)register()});
  }
  const pageIssue=onQoj?xcpcQojPageIssue(document.documentElement.outerHTML,location.href):null;
  const accessReady=()=>bridge('VP_QOJ_ACCESS_OK').then(result=>{if(result?.can_sync!==false)startReader()}).catch(startReader);
  if(pageIssue){
    if(pageIssue.kind==='verification')void bridge('VP_OPEN_QOJ_VERIFICATION',{url:location.href}).catch(()=>{});
    // Cloudflare may replace its document in place. A full navigation is not
    // required for recovery, and this page never starts a second scanner.
    let checking=false;
    const observer=new MutationObserver(()=>{
      if(checking)return;
      checking=true;queueMicrotask(()=>{
        checking=false;
        if(/^(?:just a moment|attention required|security verification|安全验证)/i.test(document.title)||document.querySelector('#challenge-form,#cf-challenge-running')||!detectHandle())return;
        observer.disconnect();void accessReady();
      });
    });
    observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  }else if(onQoj&&detectHandle())void accessReady();
  else startReader();
})();
