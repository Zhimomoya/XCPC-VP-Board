const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('qoj-bridge/qoj-response.js','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(saved={},contentScript=false){
  let clock=1000000,epoch=1800000000000,active=0,maxActive=0;
  const calls=[],storage=saved;
  let response={status:200,html:'<table><th>Result</th></table>',headers:{}};
  const context={URL,Date:class extends Date{static now(){return epoch+clock}},performance:{timeOrigin:epoch,now:()=>clock},
    setTimeout:(fn,delay)=>{clock+=delay;queueMicrotask(fn)},
    chrome:{storage:{session:{get:async()=>storage,set:async value=>Object.assign(storage,structuredClone(value))}}},
    fetch:async(url,options)=>{
      calls.push({url,at:clock});maxActive=Math.max(maxActive,++active);
      assert.equal(options.credentials,'include');assert.equal(options.cache,'no-store');
      await tick();active--;
      if(response instanceof Error)throw response;
      return{url,ok:response.status<400,status:response.status,headers:{get:name=>response.headers[name]??null},text:async()=>response.html};
    },
  };
  if(contentScript)context.document={};
  vm.createContext(context);vm.runInContext(source,context);
  return{context,calls,storage,advance:ms=>clock+=ms,set:value=>response=value,now:()=>epoch+clock,max:()=>maxActive};
}
(async()=>{
  const f=fixture(),c=f.context,url='https://qoj.ac/contest/123/submissions';
  for(const html of ['<title>Just a moment...</title>','<form id="challenge-form"></form>','<div id="cf-challenge-running"></div>'])assert.equal(c.xcpcQojPageIssue(html,url).kind,'verification');
  for(const html of ['<script src="/cdn-cgi/challenge-platform/h/g/jsd/r/abc"></script>','<pre>const id="challenge-form";</pre>','<script>const sample=\'<form id="challenge-form"></form>\';</script>','<!-- <title>Just a moment...</title> -->'])assert.equal(c.xcpcQojPageIssue(html,url),null);
  assert.equal(c.xcpcQojPageIssue('<table></table>',url,200,'challenge').kind,'verification');
  assert.equal(c.xcpcQojPageIssue('<input type="password">',url).kind,'login');
  await Promise.all(Array.from({length:6},()=>c.xcpcReadQojPage(url)));assert.equal(f.calls.length,1,'simultaneous live reads did not merge');
  await c.xcpcReadQojPage(url);assert.equal(f.calls.length,2,'submission polling was served stale HTML');
  await c.xcpcReadQojPage(url,{fresh:true});assert.equal(f.calls.length,3,'Submit did not read fresh HTML');
  assert(f.calls.every(call=>call.at===f.calls[0].at),'live requests were artificially paced');
  const root='https://qoj.ac/contest/123';
  const first=await c.xcpcReadQojPage(root);f.advance(4000);
  const next=await c.xcpcReadQojPage(root);assert.equal(next.sampled_at_ms-first.sampled_at_ms,4000);
  assert.equal(next.sample_age_ms,0,'fresh response inherited a stale sampling time');
  const challenge=fixture(),q=challenge.context;let opens=0;
  q.xcpcOpenQojVerification=async()=>{opens++;return{opened:false,homeAccessible:true}};
  challenge.set({status:403,html:'<title>Just a moment...</title>',headers:{}});
  await assert.rejects(q.xcpcReadQojPage(url),e=>e.qojKind==='verification'&&e.retryAfterMs===5000&&e.message.includes('首页可访问'));
  await assert.rejects(q.xcpcReadQojPage(url));assert.equal(challenge.calls.length,1,'challenged page ignored its cooldown');assert.equal(opens,1);
  challenge.set({status:200,html:'<table></table>',headers:{}});
  await q.xcpcReadQojPage(root);assert.equal(challenge.calls.length,2,'a challenged detail blocked a healthy contest page');
  await assert.rejects(q.xcpcReadQojPage(url));assert.equal(challenge.calls.length,2,'a healthy different page cleared the challenged URL');
  await q.xcpcResumeQojReads('https://qoj.ac');
  challenge.set({status:403,html:'<title>Just a moment...</title>',headers:{}});
  await assert.rejects(q.xcpcReadQojPage(url),e=>e.retryAfterMs===5000,'manual verification retained the old backoff');
  challenge.advance(5001);await assert.rejects(q.xcpcReadQojPage(url),e=>e.retryAfterMs===15000,'unverified repeated challenges did not back off');
  challenge.advance(15001);challenge.set({status:200,html:'<table></table>',headers:{}});await q.xcpcReadQojPage(url);
  const limited=fixture(),l=limited.context;limited.set({status:429,html:'Too many requests',headers:{'Retry-After':'300'}});
  await assert.rejects(l.xcpcReadQojPage(url),e=>e.qojKind==='rate_limit'&&e.retryAfterMs===300000);
  await l.xcpcResumeQojReads('https://qoj.ac');await assert.rejects(l.xcpcReadQojPage(root));assert.equal(limited.calls.length,1,'homepage cancelled Retry-After');
  const pageContext=fixture(limited.storage,true);
  await pageContext.context.xcpcResumeQojReads('https://qoj.ac');
  const restarted=fixture(limited.storage);await assert.rejects(restarted.context.xcpcReadQojPage(url),e=>e.retryAfterMs===300000);assert.equal(restarted.calls.length,0,'worker restart lost its cooldown');
  limited.advance(300001);limited.set({status:200,html:'<table></table>',headers:{}});await l.xcpcReadQojPage(url);
  const dated=fixture(),d=dated.context;dated.set({status:429,html:'Limited',headers:{'Retry-After':new Date(dated.now()+450000).toUTCString()}});
  await assert.rejects(d.xcpcReadQojPage(url),e=>e.retryAfterMs>=449000&&e.retryAfterMs<=450000,'HTTP-date Retry-After ignored');
  const skewed=fixture(),realNow=skewed.now();skewed.context.performance.timeOrigin+=3600000;
  skewed.set({status:429,html:'Limited',headers:{'Date':new Date(realNow).toUTCString(),'Retry-After':new Date(realNow+300000).toUTCString()}});
  await assert.rejects(skewed.context.xcpcReadQojPage(url),e=>e.retryAfterMs===300000,'clock skew shortened HTTP-date Retry-After');
  const combined=fixture();combined.set({status:429,html:'<title>Just a moment...</title>',headers:{'Retry-After':'300'}});
  await assert.rejects(combined.context.xcpcReadQojPage(url));await combined.context.xcpcResumeQojReads('https://qoj.ac');
  await assert.rejects(combined.context.xcpcReadQojPage(root));assert.equal(combined.calls.length,1,'challenge acknowledgement bypassed a 429 cooldown');
  const down=fixture(),n=down.context;down.set(Error('offline'));
  await assert.rejects(n.xcpcReadQojPage(url),e=>e.qojKind==='network'&&e.retryAfterMs===2000);
  down.advance(2001);await assert.rejects(n.xcpcReadQojPage(url),e=>e.retryAfterMs===5000);
  down.set({status:200,html:'<table></table>',headers:{}});await n.xcpcReadQojPage('https://pjudge.ac/contest/123');
  const late=fixture();let release,lateOpens=0;
  const gate=new Promise(resolve=>release=resolve);
  late.context.xcpcOpenQojVerification=async()=>{lateOpens++;return{opened:true}};
  late.context.fetch=async()=>{await gate;return{url,status:403,headers:{get:()=>null},text:async()=>'<title>Just a moment...</title>'}};
  const staleRead=late.context.xcpcReadQojPage(url);await tick();
  await late.context.xcpcResumeQojReads('https://qoj.ac');release();
  await assert.rejects(staleRead,error=>error.qojKind==='verification'&&error.retryAfterMs===0,'old in-flight challenge reinstalled a cooldown after verification');
  assert.equal(lateOpens,0,'old in-flight challenge reopened verification');
  late.context.fetch=async()=>({url,status:200,headers:{get:()=>null},text:async()=>'<table>AC</table>'});
  await late.context.xcpcReadQojPage(url);
  console.log('PASS: fresh live reads, per-page verification cooldown, unaffected healthy lists, immediate verified recovery, exponential unverified backoff, persisted Retry-After seconds/date, independent origins and network recovery.');
})().catch(error=>{console.error(error);process.exitCode=1});
