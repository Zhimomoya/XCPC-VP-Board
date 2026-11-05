/* Page messages never contain QOJ cookies or native form verification tokens. */
(function(){
  if(!['127.0.0.1','localhost'].includes(location.hostname)||!document.getElementById('qojUrl'))return;
  delete document.documentElement.dataset.xcpcSubmitBridge;
  let relayBusy=false,disconnected=false,relayTimer=null;
  const messageFor=type=>type==='VP_SEND_SOLUTION'?
    '扩展连接已失效，请刷新本页，并核对 QOJ 和提交记录后再重试。':
    type==='VP_OPEN_SUBMIT_FORM'?'扩展连接已失效，请刷新本页重新连接。代码未发送。':'扩展连接已失效，请刷新本页重新连接。';
  const disconnect=()=>{
    if(disconnected)return;
    disconnected=true;
    clearInterval(relayTimer);
    delete document.documentElement.dataset.xcpcSubmitBridge;
    delete document.documentElement.dataset.xcpcQojBridge;
    const status=document.getElementById('qojBridgeStatus');
    if(status){status.textContent='扩展连接已失效，请刷新本页重新连接。';status.classList.add('error')}
    document.dispatchEvent(new Event('xcpc-submit-bridge-disconnected'));
  };
  const available=()=>{
    if(disconnected)return false;
    try{if(chrome.runtime.id)return true}catch{}
    disconnect();return false;
  };
  const transportError=(type,error)=>{
    if(!available()||/extension context invalidated/i.test(String(error))){disconnect();return messageFor(type)}
    // A timed-out old message can lose its port while a newer request is healthy.
    return type==='VP_OPEN_SUBMIT_FORM'?'扩展读取连接中断，代码未发送。请点 Retry 重试。':
      type==='VP_SEND_SOLUTION'?'扩展响应中断，请核对 QOJ 和提交记录后再重试。':'扩展响应中断，请重试。';
  };
  const reply=(requestId,response,error='')=>window.postMessage({
    source:'xcpc-submit-extension',requestId,ok:response?.ok||false,body:response?.body,
    error:error||response?.error||'',
  },location.origin);
  const relay=()=>{
    if(!available())return;
    if(relayBusy)return;
    relayBusy=true;
    try{chrome.runtime.sendMessage({type:'VP_PROCESS_REMOTE_SUBMISSIONS'},()=>{
      relayBusy=false;
      try{if(chrome.runtime.lastError)transportError('',chrome.runtime.lastError.message)}catch{disconnect()}
    })}
    catch(error){relayBusy=false;transportError('',error.message)}
  };
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin||event.data?.source!=='xcpc-submit-page')return;
    const {requestId,type,payload}=event.data;
    if(!['VP_SUBMIT_BRIDGE_PING','VP_INSPECT_QOJ_LANGUAGES','VP_OPEN_SUBMIT_FORM','VP_SEND_SOLUTION','VP_CLOSE_SUBMIT_FORM','VP_FETCH_QOJ_PAGE','VP_FETCH_QOJ_SOURCE'].includes(type))return;
    if(!available()){reply(requestId,null,messageFor(type));return}
    try{chrome.runtime.sendMessage({type,payload},response=>{
      let error;
      try{error=chrome.runtime.lastError?.message}catch{error='Extension context invalidated'}
      if(error){reply(requestId,null,transportError(type,error));return}
      reply(requestId,response);
    })}catch(error){reply(requestId,null,transportError(type,error.message))}
  });
  relayTimer=setInterval(relay,2000);
  try{chrome.runtime.sendMessage({type:'VP_SUBMIT_BRIDGE_PING'},response=>{
    try{
      if(chrome.runtime.lastError||!response?.ok){disconnect();return}
      if(!available())return;
      document.documentElement.dataset.xcpcSubmitBridge='1';
      document.dispatchEvent(new Event('xcpc-submit-bridge-connected'));
    }catch{disconnect()}
  })}catch{disconnect()}
  relay();
})();
