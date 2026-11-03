const $=id=>document.getElementById(id);
const keys=['serverUrl','handle'];
function session(){
  chrome.runtime.sendMessage({type:'VP_GET_SESSION'},response=>{
    if(!response?.ok){$('session').textContent='无法连接主机：'+(response?.error||chrome.runtime.lastError?.message||'未知错误');return}
    const s=response.body.session;
    $('session').textContent=s?`${s.name}\nQOJ #${s.qoj_contest_id} · ${s.mode.toUpperCase()}\nVP 开始：${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(new Date(s.start_at_ms))}`:'主机尚未启动 VP。';
    if(s)$('openSubmissions').href=new URL(`/contest/${s.qoj_contest_id}/submissions`,s.qoj_url).href;
  });
}
chrome.storage.local.get([...keys,'detectedHandle','lastResult','vpStartStatus'],values=>{
  for(const key of keys)$(key).value=values[key]||'';
  if(!$('serverUrl').value)$('serverUrl').value='http://127.0.0.1:8770';
  if(!$('handle').value)$('handle').value=values.detectedHandle||'';
  $('status').textContent=(values.detectedHandle?'识别账号：'+values.detectedHandle+'\n':'')+(values.lastResult||'尚未同步');
  $('vpStartStatus').textContent=values.vpStartStatus||'等待识别 VP 起点…';
  session();
});
$('save').onclick=()=>{
  const values=Object.fromEntries(keys.map(key=>[key,$(key).value.trim()]));
  chrome.storage.local.set(values,()=>{$('status').textContent='设置已保存。刷新本地榜单页即可开始同步。';session()});
};
