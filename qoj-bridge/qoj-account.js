/* Shared by submission syncing and the native Submit form, including fetched HTML. */
function xcpcQojAccount(root=document){
  const norm=value=>String(value||'').replace(/\s+/g,' ').trim();
  const valid=value=>/^[\p{L}\p{N}_.-]{1,64}$/u.test(value);
  const reserved=/^(?:login|logout|profile|settings|account|language|languages|english|chinese|en|zh|qoj|pjudge|简体中文|繁體中文|中文|语言|登录|登出|退出登录|退出)$/i;
  const triggers='.dropdown-toggle,[data-toggle="dropdown"],[data-bs-toggle="dropdown"],[aria-haspopup="true"]';
  const unique=values=>[...new Set(values.filter(Boolean))];
  if(root.querySelector('input[type="password"],form[action*="login"]'))return'';
  const logoutNodes=[...root.querySelectorAll('a,button,[role="button"]')].filter(element=>{
    if(element.closest('table,pre,code'))return false;
    const href=element.getAttribute('href')||'';
    return /\/(?:logout|user\/logout)(?:[/?#]|$)/i.test(href)||/^(?:logout|log\s*out|登出|退出登录)$/i.test(norm(element.textContent));
  });
  if(!logoutNodes.length)return'';
  const profileHandle=element=>{
    try{
      const url=new URL(element.getAttribute('href')||'','https://qoj.ac');
      if(!['qoj.ac','training.qoj.ac','pjudge.ac'].includes(url.hostname)||url.protocol!=='https:')return'';
      const match=url.pathname.match(/^\/user\/profile\/([^/]+)\/?$/);
      const handle=match?decodeURIComponent(match[1]):'';
      return valid(handle)?handle:'';
    }catch{return''}
  };
  const profilesIn=element=>unique([...element.querySelectorAll('a[href*="/user/profile/"]')].filter(link=>!link.closest('table,pre,code')).map(profileHandle));
  const label=element=>{
    if(!element)return'';
    const copy=element.cloneNode(true);
    copy.querySelectorAll('.dropdown-menu,.caret,.fa,.fas,.far,.glyphicon,svg,[aria-hidden="true"]').forEach(node=>node.remove());
    const value=norm(copy.textContent).replace(/\s*[▾▿▼⌄]$/u,'');
    return valid(value)&&!reserved.test(value)?value:'';
  };
  const choose=(profiles,labels)=>{
    const values=unique(profiles.length?profiles:labels);
    return{handle:values.length===1?values[0]:'',ambiguous:values.length>1};
  };
  const candidatesIn=container=>{
    const profiles=[],labels=[];
    // Only the account/navigation branch is searched. Submission owners are never candidates.
    const elements=[container,...container.querySelectorAll(triggers+',a[href*="/user/profile/"]')];
    for(const element of elements){
      if(element.closest('table,pre,code,.dropdown-menu'))continue;
      if(element.matches('a[href*="/user/profile/"]'))profiles.push(profileHandle(element));
      if(!element.matches(triggers))continue;
      labels.push(label(element));
      const sibling=element.nextElementSibling;
      if(sibling?.matches('.dropdown-menu'))profiles.push(...profilesIn(sibling));
    }
    return choose(unique(profiles),unique(labels));
  };
  const handles=[];
  for(const logout of logoutNodes){
    const menu=logout.closest('.dropdown-menu');
    if(menu){
      const previous=menu.previousElementSibling;
      const account=choose(profilesIn(menu),previous?[label(previous)]:[]);
      if(account.ambiguous)return'';
      if(account.handle){handles.push(account.handle);continue}
    }
    for(let container=logout.parentElement;container&&!container.matches('body,html');container=container.parentElement){
      const account=candidatesIn(container);
      if(account.ambiguous)return'';
      if(account.handle){handles.push(account.handle);break}
    }
  }
  const accounts=unique(handles);
  return accounts.length===1?accounts[0]:'';
}
