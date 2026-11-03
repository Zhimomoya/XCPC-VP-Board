/* Parse fetched QOJ HTML in the existing host tab's isolated extension world.
 * Never attach remote HTML to the page or execute QOJ's scripts. */
function qojSubmitPage(action,data){
  const norm=value=>String(value||'').replace(/\s+/g,' ').trim();
  try{
    if(data.host_origin&&location.origin!==data.host_origin)throw Error('主机页面已切换，请重新打开 Submit');
    const doc=new DOMParser().parseFromString(data.html,'text/html'),url=new URL(data.url);
    const login=doc.querySelector('input[type="password"],form[action*="login"]')||/^\/login\/?$/.test(url.pathname);
    if(login)return{ready:false,error:'请先在同一浏览器登录 QOJ'};
    if(doc.querySelector('form#challenge-form,div#cf-challenge-running,main#cf-challenge-running,section#cf-challenge-running')||/^(?:just a moment|attention required|security verification|安全验证)/i.test(doc.title))throw Error('QOJ 需要访问验证，请在 QOJ 首页完成验证后重试');
    const timeLabel=/submit(?:ted|ting)?\s*time|submission\s*time|提交时间|提交时刻/i;
    const absoluteTime=value=>{
      const date=norm(value).match(/^(20\d\d)[-/](\d\d?)[-/](\d\d?)[ T](\d\d?):(\d\d):(\d\d)(?:\.\d+)?\s*(?:(Z)|(?:(UTC|GMT)\s*)?([+-])(\d{1,2})(?::?(\d\d))?|(UTC|GMT))?$/i);
      if(!date)return null;
      const [,y,m,d,h,min,s,z,,sign,oh='0',om='0',utc]=date;
      const offset=sign?(sign==='-'?-1:1)*(Number(oh)*60+Number(om)):z||utc?0:480;
      const time=Date.UTC(+y,+m-1,+d,+h,+min,+s),check=new Date(time);
      return +h<24&&+min<60&&+s<60&&+oh<24&&+om<60&&check.getUTCMonth()===+m-1&&check.getUTCDate()===+d?time-offset*60000:null;
    };
    const timeOf=cell=>[cell?.getAttribute('title'),cell?.getAttribute('datetime'),
      ...[...(cell?.querySelectorAll('[title],[datetime]')||[])].flatMap(node=>[node.getAttribute('datetime'),node.getAttribute('title')]),cell?.textContent]
      .map(absoluteTime).find(value=>value!==null)??null;
    if(action==='source'||action==='rejudge_detail'){
      const source=[...doc.querySelectorAll('#source_code,#submission_code,.source-code pre,.submission-source pre,.uoj-code,pre.sh_sourceCode,pre[class*="sh_"],pre code')].find(node=>!node.closest('#compile_error,#compiler_output,.compile-error,.compiler-output'));
      const lines=source?.querySelector('ol.linenums');
      const code=source?.tagName==='TEXTAREA'?source.value:lines?[...lines.children].map(line=>line.textContent==='\u00a0'?'':line.textContent).join('\n'):source?.textContent||'';
      if(new TextEncoder().encode(code).length>262144)throw Error('源码超过 256 KiB，请到 QOJ 查看原记录');
      if(action==='rejudge_detail'){
        for(const tr of doc.querySelectorAll('tr')){
          const cells=[...tr.cells],index=cells.findIndex(cell=>timeLabel.test(norm(cell.textContent)));
          if(index>=0){const at=cells.slice(index+1).map(timeOf).find(value=>value!==null);if(at!==undefined)return{source:code,at}}
        }
        for(const label of doc.querySelectorAll('dt,label,strong,b,.control-label,.form-label')){
          if(!timeLabel.test(norm(label.textContent)))continue;
          const at=[label.nextElementSibling,label.parentElement?.querySelector('dd,time,[datetime],.form-control-static')].map(timeOf).find(value=>value!==null);
          if(at!==undefined)return{source:code,at};
        }
        return{source:code,at:null};
      }
      if(!source)throw Error('QOJ 未提供可查看的源码，请确认主机账号对这条提交有查看权限');
      if(!code)throw Error('QOJ 返回的源码为空');
      let language='';
      for(const table of doc.querySelectorAll('table')){
        const rows=[...table.rows];
        for(const [i,row] of rows.entries()){
          const cells=[...row.cells],index=cells.findIndex(cell=>/^(?:programming language|language|编程语言|语言)\s*[:：]?$/i.test(norm(cell.textContent)));
          if(index<0)continue;
          const next=cells[index+1];
          language=norm((next?.tagName==='TD'?next:rows[i+1]?.cells[index])?.textContent);
          if(language)break;
        }
        if(language)break;
      }
      language||=norm(source.closest('.card,.panel')?.querySelector('.card-footer,.panel-footer')?.textContent)
        .match(/(?:^|[,，])\s*(?:language|语言)\s*[:：]\s*([^,，]+)/i)?.[1]?.trim();
      language||=[source,source.querySelector('code'),source.closest('pre')].flatMap(node=>[...(node?.classList||[])])
        .find(name=>/^(?:language-|sh_)[\w+-]+$/.test(name)&&name!=='sh_sourceCode')?.replace(/^(?:language-|sh_)/,'');
      return{source:code,...(language?{language}:{})};
    }
    const handle=globalThis.xcpcQojAccount?.(doc)||'';
    const showAllLabel=[...doc.querySelectorAll('label')].find(label=>/show all submissions|显示(?:全部|所有)提交/i.test(norm(label.textContent)));
    const showAll=showAllLabel?.querySelector('input[type="checkbox"]')||(showAllLabel?.htmlFor?doc.getElementById(showAllLabel.htmlFor):null);
    const personal=Boolean(showAll&&!showAll.checked);
    if(action==='problem'){
      const row=[...doc.querySelectorAll('tr')].find(tr=>norm(tr.querySelector('td')?.textContent).toUpperCase()===data.label.toUpperCase());
      return{handle,problem_id:row?.querySelector('a[href*="/problem/"]')?.getAttribute('href')?.match(/\/problem\/(\d+)/)?.[1]||''};
    }
    if(action==='rejudge_list'){
      const expected=new URL(data.expected_url);
      const page=value=>Number(value.searchParams.get('page')||1);
      const sameList=value=>value.origin===expected.origin&&value.pathname.replace(/\/$/,'')===expected.pathname.replace(/\/$/,'');
      if(!sameList(url)||page(url)!==page(expected)||!handle)throw Error('QOJ 提交列表或登录状态无法核对');
      const candidates=[...doc.querySelectorAll('table')].map(table=>({table,headers:[...table.querySelectorAll('thead th')].map(cell=>norm(cell.textContent))}));
      const list=candidates.find(({headers})=>headers.some(h=>/^(?:#|id|编号|提交编号)$/i.test(h))&&headers.some(h=>/problem|题目/i.test(h))&&headers.some(h=>/result|verdict|status|结果|状态/i.test(h))&&headers.some(h=>timeLabel.test(h)));
      if(!list)throw Error('无法识别 QOJ 提交列表，未重新发送');
      const timeIndex=list.headers.findIndex(h=>timeLabel.test(h)),ownerIndex=list.headers.findIndex(h=>/submitter|user|owner|提交者|提交人|用户/i.test(h));
      const sameHandle=value=>String(value||'').toLowerCase()===handle.toLowerCase();
      const submissions=[];
      for(const tr of list.table.querySelectorAll('tbody tr')){
        const cells=[...tr.cells];
        const id=tr.querySelector('a[href*="/submission/"]')?.getAttribute('href')?.match(/\/submission\/(\d{1,15})(?:\/|\?|$)/)?.[1];
        if(!id){
          if(!cells.length||cells.length===1&&/暂无|没有|无提交|no (?:data|submissions|records)/i.test(norm(tr.textContent)))continue;
          throw Error('QOJ 列表有无法核对的记录，未重新发送');
        }
        const problem=tr.querySelector('a[href*="/problem/"]')?.getAttribute('href')?.match(/\/problem\/(\d+)/)?.[1];
        const owners=[...tr.querySelectorAll('a[href*="/user/profile/"]')].map(link=>decodeURIComponent(new URL(link.getAttribute('href'),url).pathname.split('/').filter(Boolean).pop()));
        const displayed=norm(cells[ownerIndex]?.textContent);
        const own=owners.length?owners.some(sameHandle):displayed?sameHandle(displayed):personal?true:null;
        submissions.push({id,problem:problem||null,own,at:timeOf(cells[timeIndex])});
      }
      const hasNext=[...doc.querySelectorAll('a[href]')].some(link=>{
        try{const next=new URL(link.getAttribute('href'),url);return sameList(next)&&page(next)>page(expected)}catch{return false}
      });
      return{handle,submissions,hasNext};
    }
    const rows=[...doc.querySelectorAll('tr')].map(tr=>{
      const id=tr.querySelector('a[href*="/submission/"]')?.getAttribute('href')?.match(/\/submission\/(\d+)/)?.[1];
      const problem_id=tr.querySelector('a[href*="/problem/"]')?.getAttribute('href')?.match(/\/problem\/(\d+)/)?.[1];
      const owners=[...tr.querySelectorAll('a[href*="/user/profile/"]')].map(link=>{
        try{return decodeURIComponent(new URL(link.getAttribute('href'),url).pathname.split('/').filter(Boolean).pop())}catch{return''}
      });
      return{id,problem_id,owners};
    }).filter(row=>row.id);
    if(action==='list')return{handle,ids:[...new Set(rows.map(row=>row.id))]};
    if(action==='receipt'){
      const error=doc.querySelector('#form-answer .alert-danger,.uoj-content>.alert-danger,main>.alert-danger,#submission-error,[data-submission-error]');
      if(data.posted&&error&&data.status<500&&data.status!==408)return{outcome:'failed',message:norm(error.textContent).slice(0,300)||'QOJ 未接受本次提交'};
      const idFrom=value=>{
        try{const target=new URL(value,url);return target.origin===url.origin?target.pathname.match(/^\/submission\/(\d+)\/?$/)?.[1]||'':''}catch{return''}
      };
      if(data.posted){
        // Some native forms acknowledge success outside the submissions table.
        let ack=[];
        if(/json/i.test(data.content_type)||/^\s*\{/.test(data.html))try{
          const json=JSON.parse(data.html);
          const ident=String(json.submission_id||'');
          if((json.success===false||json.error)&&data.status<500&&data.status!==408)return{outcome:'failed',message:norm(json.message||json.error).slice(0,300)||'QOJ 未接受本次提交'};
          if(/^\d{1,15}$/.test(ident))ack.push(ident);
          for(const key of ['submission_url','redirect','redirect_url'])if(typeof json[key]==='string')ack.push(idFrom(json[key]));
        }catch{}
        for(const link of doc.querySelectorAll('.alert-success a[href],#submission-success a[href],.alert-success[data-submission-id],#submission-success[data-submission-id],.alert-success [data-submission-id],#submission-success [data-submission-id]')){
          if(link.closest('#tab-statement,.problem-statement,.uoj-markdown,article'))continue;
          ack.push(idFrom(link.getAttribute('href')||''));
          const ident=link.getAttribute('data-submission-id');if(/^\d{1,15}$/.test(ident||''))ack.push(ident);
        }
        for(const script of doc.querySelectorAll('script'))for(const match of script.textContent.matchAll(/(?:location(?:\.href)?\s*=|location\.(?:assign|replace)\s*\()\s*["']([^"']+)["']/g))ack.push(idFrom(match[1]));
        ack=[...new Set(ack.filter(id=>id&&!data.previous.includes(id)))];
        if(ack.length===1)return{qoj_id:ack[0],has_form:false};
        if([400,401,403,404,405,413,415,422,429].includes(data.status)&&!data.redirected)return{outcome:'failed',message:`QOJ 拒绝了本次提交（HTTP ${data.status}），请检查登录、表单验证或提交权限`};
      }
      if(handle!==data.handle)return{};
      const floor=data.previous.reduce((latest,id)=>Math.max(latest,Number(id)||0),0);
      const candidates=rows.filter(row=>/^\d{1,15}$/.test(row.id)&&Number(row.id)>floor&&row.problem_id===data.problem_id&&(row.owners.includes(data.handle)||!row.owners.length&&personal));
      const ids=[...new Set(candidates.map(row=>row.id))];
      return{candidate_id:ids.length===1?ids[0]:null};
    }
    if(action!=='inspect')throw Error('QOJ 解析操作无效');

    // UOJ and QOJ use source_code_form_group(name, label, options, ...settings).
    // Read literal arguments without executing the native initialization script.
    const trivia=(text,start)=>{
      let i=start;
      while(i<text.length){
        if(/\s/.test(text[i])){i++;continue}
        if(text.startsWith('//',i)){const end=text.indexOf('\n',i+2);i=end<0?text.length:end+1;continue}
        if(text.startsWith('/*',i)){const end=text.indexOf('*/',i+2);if(end<0)throw Error('QOJ 提交控件配置注释不完整');i=end+2;continue}
        break;
      }
      return i;
    };
    const literal=(text,start)=>{
      let i=trivia(text,start);
      const quote=text[i++];if(!['"',"'"].includes(quote))throw Error('QOJ 语言配置不是可读取的常量');
      let value='';
      const escapes={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'};
      while(i<text.length){
        let ch=text[i++];if(ch===quote)return{value,end:i};
        if(ch==='\\'){
          ch=text[i++];
          if(ch==='\n')continue;
          if(ch==='\r'){if(text[i]==='\n')i++;continue}
          if(ch==='u'||ch==='x'){
            const count=ch==='u'?4:2,hex=text.slice(i,i+count);
            if(!new RegExp('^[0-9a-f]{'+count+'}$','i').test(hex))throw Error('QOJ 语言配置转义无效');
            value+=String.fromCharCode(parseInt(hex,16));i+=count;
          }else if(ch in escapes)value+=escapes[ch];
          else if(['\\','"',"'",'/'].includes(ch))value+=ch;
          else throw Error('QOJ 语言配置转义不受支持');
        }else{if(ch==='\n'||ch==='\r')throw Error('QOJ 语言配置不完整');value+=ch}
      }
      throw Error('QOJ 语言配置不完整');
    };
    const constant=(text,start,depth=0)=>{
      if(depth>16)throw Error('QOJ 提交控件配置嵌套过深');
      let i=trivia(text,start),ch=text[i];
      if(ch==='"'||ch==="'"){
        let result=literal(text,i);i=trivia(text,result.end);
        while(text[i]==='+'){
          const next=literal(text,i+1);result={value:result.value+next.value,end:next.end};i=trivia(text,next.end);
        }
        return{value:result.value,end:i};
      }
      if(ch==='['||ch==='{'){
        const object=ch==='{',end=object?'}':']';i=trivia(text,i+1);
        while(text[i]!==end){
          if(i>=text.length)throw Error('QOJ 提交控件配置不完整');
          if(object){
            if(text[i]==='"'||text[i]==="'")i=literal(text,i).end;
            else{const key=text.slice(i).match(/^[a-zA-Z_$][\w$]*/);if(!key)throw Error('QOJ 提交控件配置不是可读取的常量');i+=key[0].length}
            i=trivia(text,i);if(text[i]!==':')throw Error('QOJ 提交控件配置不是可读取的常量');i++;
          }
          i=trivia(text,constant(text,i,depth+1).end);
          if(text[i]===end)break;
          if(text[i]!==',')throw Error('QOJ 提交控件配置不是可读取的常量');i=trivia(text,i+1);
        }
        // Optional native editor settings are validated and discarded. In
        // particular, object keys are never assigned to a JavaScript object.
        return{value:null,end:i+1};
      }
      const atom=text.slice(i).match(/^(?:true|false|null|undefined)(?![\w$])|^[+-]?(?:0x[\da-f]+|0b[01]+|0o[0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i);
      if(!atom)throw Error('QOJ 提交控件配置不是可读取的常量');
      return{value:null,end:i+atom[0].length};
    };
    const argumentsOf=(text,start)=>{
      const args=[];let i=trivia(text,start);
      while(text[i]!==')'){
        if(i>=text.length||args.length>=32)throw Error('QOJ 提交控件配置不完整');
        const parsed=constant(text,i);args.push(parsed.value);i=trivia(text,parsed.end);
        if(text[i]===')')break;
        if(text[i]!==',')throw Error('QOJ 提交控件配置不完整');i=trivia(text,i+1);
      }
      return{args,end:i+1};
    };
    const native=doc.querySelector('#form-answer');
    if(native)for(const script of native.querySelectorAll('script')){
      const text=script.textContent,pattern=/\.\s*(source_code_form_group|text_file_form_group)\s*\(/g;
      let match;
      while((match=pattern.exec(text))){
        const call=argumentsOf(text,pattern.lastIndex),[name,label,options]=call.args;pattern.lastIndex=call.end;
        if(typeof name!=='string'||typeof label!=='string'||!/^[a-zA-Z][\w-]{0,80}$/.test(name))throw Error('QOJ 提交控件名称无效');
        const group=doc.getElementById('form-group-'+name);
        if(!group||group.closest('form')!==native)throw Error('QOJ 提交控件与表单不一致');
        const add=(tag,suffix,value)=>{
          const field=doc.createElement(tag);field.name=name+'_'+suffix;
          if(tag==='input')field.type='hidden';if(value!==undefined)field.value=value;
          group.append(field);return field;
        };
        if(match[1]==='source_code_form_group'){
          if(typeof options!=='string')throw Error('QOJ 语言配置不是可读取的常量');
          if(![...native.querySelectorAll('select')].some(select=>select.name===name+'_language')){
            const select=add('select','language');
            const optionDoc=new DOMParser().parseFromString('<select>'+options+'</select>','text/html');
            for(const option of optionDoc.querySelectorAll('select option')){
              const copy=doc.createElement('option');copy.value=option.value;copy.textContent=option.textContent;
              copy.disabled=option.disabled||Boolean(option.closest('optgroup[disabled]'));copy.selected=option.selected;select.append(copy);
            }
            add('textarea','editor');add('input','upload_type','editor');
          }
        }else{
          add('input','upload_type','file');
        }
      }
    }
    const languageSelect=[...doc.querySelectorAll('select')].find(select=>/(?:^|[_-])language$/i.test(select.name||'')||/language|语言/i.test(`${select.name} ${select.id} ${select.getAttribute('aria-label')||''}`));
    const form=languageSelect?.closest('form')||native;
    if(!form||!languageSelect)throw Error('未读取到 QOJ 提交表单，请检查登录或题目提交权限');
    const selects=[...form.querySelectorAll('select')].filter(select=>/(?:^|[_-])language$/i.test(select.name||'')||/language|语言/i.test(`${select.name} ${select.id} ${select.getAttribute('aria-label')||''}`));
    if(selects.length!==1)throw Error('此题不是单源码提交，请在 QOJ 原页面提交');
    const select=selects[0],prefix=(select.name||'').replace(/(?:_|-)language$/i,'');
    const editor=[...form.querySelectorAll('textarea')].find(field=>field.name===prefix+'_editor')||[...form.querySelectorAll('textarea')].find(field=>/editor|source|code|answer/i.test(`${field.name} ${field.id}`));
    if(!select.name||!editor?.name||select.disabled)throw Error('QOJ 提交表单不完整或暂不可用');
    if([...form.querySelectorAll('[name$="_upload_type"]')].some(field=>field.name!==prefix+'_upload_type'))throw Error('此题需要多个文件，请在 QOJ 原页面提交');
    const target=new URL(form.getAttribute('action')||url.href,url);
    if(form.method.toLowerCase()!=='post'||target.origin!==url.origin||target.pathname!==data.pathname)throw Error('QOJ 提交表单地址与所选题目不一致');
    if(!handle)throw Error('未识别到 QOJ 登录账号，请在 QOJ 页面核对登录状态');
    const fields=[...new FormData(form)].filter(([,value])=>typeof value==='string');
    if(!fields.some(([name,value])=>/token|csrf/i.test(name)&&value))throw Error('未读取到 QOJ 表单验证字段，请刷新 QOJ 登录状态后重试');
    const upload=form.querySelector(`[name="${CSS.escape(prefix+'_upload_type')}"]`);
    return{ready:true,handle,languages:[...select.options].filter(option=>!option.disabled&&!option.closest('optgroup[disabled]')&&option.value).map(option=>({value:option.value,label:norm(option.textContent)})),selected:select.value,
      fields,language_name:select.name,editor_name:editor.name,upload_name:upload?.name||'',target:target.href};
  }catch(error){return{ready:false,error:String(error.message)}}
}
