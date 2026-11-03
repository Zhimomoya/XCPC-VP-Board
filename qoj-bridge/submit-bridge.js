/* Page messages never contain QOJ cookies or native form verification tokens. */
(function(){
  if(!['127.0.0.1','localhost'].includes(location.hostname)||!document.getElementById('qojUrl'))return;
  document.documentElement.dataset.xcpcSubmitBridge='1';
  let relayBusy=false;
  const relay=()=>{
    if(relayBusy)return;
    relayBusy=true;
    try{chrome.runtime.sendMessage({type:'VP_PROCESS_REMOTE_SUBMISSIONS'},()=>{void chrome.runtime.lastError;relayBusy=false})}
    catch{relayBusy=false;clearInterval(relayTimer)}
  };
  const relayTimer=setInterval(relay,2000);
  relay();
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin||event.data?.source!=='xcpc-submit-page')return;
    const {requestId,type,payload}=event.data;
    if(!['VP_INSPECT_QOJ_LANGUAGES','VP_OPEN_SUBMIT_FORM','VP_SEND_SOLUTION','VP_CLOSE_SUBMIT_FORM','VP_FETCH_QOJ_PAGE','VP_FETCH_QOJ_SOURCE'].includes(type))return;
    chrome.runtime.sendMessage({type,payload},response=>{
      const error=chrome.runtime.lastError?.message;
      window.postMessage({source:'xcpc-submit-extension',requestId,ok:response?.ok||false,body:response?.body,error:error||response?.error||''},location.origin);
    });
  });
})();
