/* One extension-driven scanner. Hidden webpage timers never drive live sync. */
(function(){
  const key='qojSyncReaders',readers=new Map();
  let loaded=null,timer=null,running=false,queued=false,selected=null,scan=null,nextScanAt=0;
  const now=()=>globalThis.performance?.now?.()??Date.now();
  const area=chrome.storage?.session;
  const safeReader=value=>{
    const url=new URL(value);
    if(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&!url.username&&!url.password)return{origin:url.origin,kind:'host'};
    if(url.protocol==='https:'&&['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname)&&!url.port&&!url.username&&!url.password)return{origin:url.origin,kind:'qoj'};
    throw Error('只接受主机或 QOJ 页面注册同步');
  };
  const save=()=>area?area.set({[key]:Object.fromEntries(readers)}).catch(()=>{}):Promise.resolve();
  async function load(){
    if(!loaded)loaded=area?area.get(key).then(saved=>{
      for(const [id,record] of Object.entries(saved[key]||{}))if(Number.isInteger(Number(id))&&record?.origin){
        try{readers.set(Number(id),safeReader(record.origin))}catch{}
      }
    }).catch(()=>{}):Promise.resolve();
    await loaded;
  }
  function schedule(delay=1000){
    if(timer!==null)clearTimeout(timer);
    timer=setTimeout(()=>{timer=null;void tick()},delay);
  }
  async function choose(){
    const valid=[];
    for(const [id,reader] of readers){
      const tab=await chrome.tabs.get(id).catch(()=>null);
      if(!tab||tab.discarded){readers.delete(id);continue}
      let actual;try{actual=safeReader(tab.url)}catch{readers.delete(id);continue}
      if(actual.origin!==reader.origin){readers.delete(id);continue}
      valid.push({...reader,id,tab});
    }
    valid.sort((a,b)=>(a.kind==='host'?0:1)-(b.kind==='host'?0:1)||(a.id===selected?-1:b.id===selected?1:a.id-b.id));
    return valid[0];
  }
  async function tick(){
    if(running){queued=true;return}
    running=true;
    try{
      await load();const reader=await choose();
      if(!reader){selected=null;await save();return}
      if(selected!==reader.id)nextScanAt=0;
      selected=reader.id;
      // LAN jobs keep working when the host is in another browser tab as well.
      if(reader.kind==='host'&&typeof globalThis.processRemoteSubmissions==='function')void processRemoteSubmissions({url:reader.tab.url,tab:reader.tab}).catch(()=>{});
      if(!scan&&now()>=nextScanAt){
        const flight={tabId:reader.id,startedAt:now()};scan=flight;
        let timeout;
        const deadline=new Promise((resolve,reject)=>{timeout=setTimeout(()=>reject(Error('同步页面响应超时')),120000)});
        void Promise.race([chrome.tabs.sendMessage(reader.id,{type:'VP_QOJ_SYNC_TICK'}),deadline]).then(reply=>{
          if(!reply?.ok)throw Error('同步页面尚未就绪');
          nextScanAt=Math.max(now(),flight.startedAt+Math.max(250,Math.min(10000,Number(reply.delay_ms)||1000)));
        }).catch(()=>{
          readers.delete(flight.tabId);if(selected===flight.tabId)selected=null;void save();
        }).finally(()=>{clearTimeout(timeout);if(scan===flight)scan=null;if(queued){queued=false;globalThis.xcpcKickQojSync()}});
      }
    }catch{if(selected!==null){readers.delete(selected);selected=null;await save()}}
    finally{running=false;if(readers.size){const next=queued?0:1000;queued=false;schedule(next)}else queued=false}
  }
  async function register(sender){
    if(!Number.isInteger(sender.tab?.id))throw Error('同步页面标签无效');
    const reader=safeReader(sender.url||sender.tab.url);await load();
    const fresh=!readers.has(sender.tab.id);readers.set(sender.tab.id,reader);await save();
    if(fresh||timer===null){if(running)queued=true;else schedule(0)}
    return{driven:true};
  }
  globalThis.xcpcKickQojSync=()=>{nextScanAt=0;if(running)queued=true;else schedule(0)};
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message?.type!=='VP_QOJ_READER_READY')return false;
    register(sender).then(body=>reply({ok:true,body}),error=>reply({ok:false,error:error.message}));return true;
  });
  chrome.tabs.onRemoved?.addListener(id=>{if(readers.delete(id)){void save();if(selected===id){selected=null;globalThis.xcpcKickQojSync()}}});
  // Session storage survives a worker restart, but not a browser restart.
  void load().then(()=>{if(readers.size)schedule(0)});
})();
