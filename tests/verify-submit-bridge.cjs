/* Exercise the actual content bridge, including Chrome's invalidated-context failures. */
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('qoj-bridge/submit-bridge.js','utf8');
function fixture(options={}){
  const document=new EventTarget(),window=new EventTarget(),dataset={xcpcQojBridge:'fixture'},posts=[],calls=[],intervals=new Map();
  const status={textContent:'',classList:{add(){}}};
  document.documentElement={dataset};document.getElementById=id=>id==='qojUrl'?{}:id==='qojBridgeStatus'?status:null;
  window.postMessage=(value,origin)=>{assert.equal(origin,'http://127.0.0.1:8770');posts.push(value)};
  const state={id:'fixture',throwSend:false,lastError:null,throwLastError:false,...options};
  let initialReply=null,disconnects=0,nextTimer=0;
  document.addEventListener('xcpc-submit-bridge-disconnected',()=>disconnects++);
  const runtime={
    get id(){return state.id},
    get lastError(){if(state.throwLastError)throw Error('Extension context invalidated.');return state.lastError},
    sendMessage(message,reply){
      calls.push(message);
      if(state.throwSend)throw Error('Extension context invalidated.');
      if(message.type==='VP_SUBMIT_BRIDGE_PING'&&state.holdPing){initialReply=reply;return}
      if(message.type==='VP_PROCESS_REMOTE_SUBMISSIONS'&&state.holdRelay)return;
      reply(state.response||{ok:true,body:{connected:true}});
    },
  };
  vm.runInNewContext(source,{document,window,chrome:{runtime},location:{hostname:'127.0.0.1',origin:'http://127.0.0.1:8770'},Event,
    setInterval(fn){const id=++nextTimer;intervals.set(id,fn);return id},clearInterval:id=>intervals.delete(id),
  });
  return{state,dataset,posts,calls,status,intervals,get disconnects(){return disconnects},
    handshake:()=>initialReply({ok:true,body:{connected:true}}),
    tick:()=>{for(const fn of [...intervals.values()])fn()},
    request(type,origin='http://127.0.0.1:8770'){
      const event=new Event('message');Object.assign(event,{source:window,origin,data:{source:'xcpc-submit-page',requestId:'request-'+posts.length,type,payload:{}}});
      window.dispatchEvent(event);return posts.at(-1);
    },
  };
}
function assertDisconnected(f){
  assert.equal(f.dataset.xcpcSubmitBridge,undefined);assert.equal(f.dataset.xcpcQojBridge,undefined);
  assert.equal(f.intervals.size,0,'invalid bridge kept polling');assert.equal(f.disconnects,1);
  assert(f.status.textContent.includes('刷新本页'));
}
const handshake=fixture({holdPing:true});
assert.equal(handshake.dataset.xcpcSubmitBridge,undefined,'the untested bridge advertised a connection');
handshake.handshake();assert.equal(handshake.dataset.xcpcSubmitBridge,'1');
const normal=fixture();
assert(normal.request('VP_SUBMIT_BRIDGE_PING').ok);
normal.state.response={ok:false,error:'QOJ 表单暂时不可用'};
assert.equal(normal.request('VP_OPEN_SUBMIT_FORM').error,'QOJ 表单暂时不可用');
assert.equal(normal.dataset.xcpcSubmitBridge,'1','a QOJ application error disconnected a healthy extension');
const before=normal.calls.length;normal.request('VP_SEND_SOLUTION','http://untrusted.invalid');normal.request('VP_UNKNOWN');
assert.equal(normal.calls.length,before,'untrusted or unknown messages reached the worker');
const oldPort=fixture();oldPort.state.lastError={message:'The message port closed before a response was received.'};
assert(oldPort.request('VP_OPEN_SUBMIT_FORM').error.includes('代码未发送'));
assert.equal(oldPort.dataset.xcpcSubmitBridge,'1','an old closed message port invalidated a live extension');
assert.equal(oldPort.disconnects,0);oldPort.state.lastError=null;
assert(oldPort.request('VP_SUBMIT_BRIDGE_PING').ok,'a transient transport error prevented recovery');
for(const type of ['VP_OPEN_SUBMIT_FORM','VP_SEND_SOLUTION','VP_FETCH_QOJ_SOURCE']){
  const f=fixture();f.state.throwSend=true;
  const reply=f.request(type);assertDisconnected(f);assert.equal(reply.ok,false);assert(reply.error.includes('刷新本页'));
  assert.equal(reply.error.includes('代码未发送'),type==='VP_OPEN_SUBMIT_FORM','send uncertainty was reported as definitely not sent');
  const count=f.calls.length;assert.equal(f.request(type).ok,false);f.tick();assert.equal(f.calls.length,count);
}
for(const variant of ['missing-id','last-error','throw-last-error']){
  const f=fixture({holdRelay:true});
  if(variant==='missing-id'){f.state.id=undefined;f.tick()}
  else{
    if(variant==='last-error')f.state.lastError={message:'Extension context invalidated.'};else f.state.throwLastError=true;
    assert.equal(f.request('VP_OPEN_SUBMIT_FORM').ok,false);
  }
  assertDisconnected(f);
}
console.log('PASS: verified handshake, invalidation during a busy relay, synchronous and callback failures, immediate safe replies, trusted messages and no stale connected marker.');
