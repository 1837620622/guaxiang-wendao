const tocEl=document.getElementById('toc'), tocMeta=document.getElementById('tocMeta'),
      hitsEl=document.getElementById('hits'),
      reader=document.getElementById('reader'), titleEl=document.getElementById('title'),
      main=document.getElementById('main'), prog=document.getElementById('progress'),
      aside=document.getElementById('aside'), mask=document.getElementById('mask');

/* Safari 底栏会吃掉 100% 高度，用可视高度锁住阅读区。 */
function syncVvh(){
  const h=window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--vvh', Math.round(h)+'px');
}
syncVvh();
window.addEventListener('resize', syncVvh);
if(window.visualViewport) window.visualViewport.addEventListener('resize', syncVvh);

let TOC=[], CUR=null;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function numAttr(n){
  const x=Number(n);
  return Number.isInteger(x)&&x>=0&&x<100000?String(x):'';
}

/* 字号 / 主题持久化 */
let fs=parseFloat(localStorage.getItem('gx_fs')||'18');
document.documentElement.style.setProperty('--fs', fs+'px');
document.getElementById('fontBtn').onclick=()=>{
  fs = fs>=24 ? 16 : fs+2;
  document.documentElement.style.setProperty('--fs', fs+'px');
  localStorage.setItem('gx_fs', fs);
};
const darkBtn=document.getElementById('darkBtn');
if(localStorage.getItem('gx_dark')==='1') document.body.classList.add('dark');
darkBtn.onclick=()=>{
  document.body.classList.toggle('dark');
  localStorage.setItem('gx_dark', document.body.classList.contains('dark')?'1':'0');
};

/* 目录 */
document.getElementById('tocBtn').onclick=()=>{
  aside.classList.toggle('open');
  mask.classList.toggle('show', aside.classList.contains('open'));
};
mask.onclick=()=>{ aside.classList.remove('open'); mask.classList.remove('show'); };

function renderToc(filter=''){
  const q=filter.trim();
  const list = q ? TOC.filter(x=>x.title.includes(q)) : TOC;
  tocMeta.textContent = q ? `匹配 ${list.length} 章` : `共 ${TOC.length} 章`;
  tocEl.innerHTML = list.map(x=>{
    const no=numAttr(x.no), ord=numAttr(x.ord);
    return `<a href="#ch-${ord}" data-no="${no}" data-ord="${ord}" class="${CUR&&String(CUR.ord)===ord?'active':''}">${esc(x.title)}</a>`;
  }).join('');
}
document.getElementById('tocSearch').addEventListener('input',e=>renderToc(e.target.value));
tocEl.addEventListener('click',e=>{
  const a=e.target.closest('a'); if(!a)return;
  e.preventDefault();
  if(window.innerWidth<=820){ aside.classList.remove('open'); mask.classList.remove('show'); }
  loadChapter(Number(a.dataset.no));
});

/* 阅读进度 */
main.addEventListener('scroll',()=>{
  const h=main.scrollHeight-main.clientHeight;
  prog.style.width = h>0 ? (main.scrollTop/h*100)+'%' : '0';
});

async function loadChapter(no){
  reader.innerHTML='<div class="loading"><i></i><i></i><i></i></div>';
  try{
    const r=await fetch('/api/chapter?no='+encodeURIComponent(no));
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'加载失败');
    CUR=d;
    titleEl.textContent=d.title;
    document.title=d.title+' · 改命记实录';
    // 先记下要定位的段落，再改 URL（否则 ?p= 被抹掉）
    const targetPara=Number(new URLSearchParams(location.search).get('p'))||0;
    const chNo=numAttr(d.no);
    history.replaceState(null,'',`?ch=${chNo}`);
    const plist=(d.body||'').split('\n').filter(Boolean);
    const paras=plist.map((p,i)=>`<p id="p${i+1}">${esc(p)}</p>`).join('');
    const prevNo=d.prev?numAttr(d.prev.no):'';
    const nextNo=d.next?numAttr(d.next.no):'';
    reader.innerHTML=`
      <h1 class="ch">${esc(d.title)}</h1>
      <div class="chmeta">第 ${chNo||'—'} 章 · 约 ${(d.body||'').length} 字</div>
      <div class="body">${paras}</div>
      <div class="nav">
        <a href="#" class="${prevNo?'':'disabled'}" data-no="${prevNo}">← ${d.prev?esc(d.prev.title.slice(0,14)):'已是第一章'}</a>
        <a href="#" class="${nextNo?'':'disabled'}" data-no="${nextNo}">${d.next?esc(d.next.title.slice(0,14)):'已是最后一章'} →</a>
      </div>`;
    reader.querySelectorAll('.nav a').forEach(a=>{
      a.onclick=e=>{ e.preventDefault(); if(a.dataset.no) loadChapter(Number(a.dataset.no)); };
    });
    // 定位到引用段落
    const target=targetPara;
    try{ localStorage.setItem('gx_read_ch', String(d.no)); }catch(err){}
    if(target>0){
      const el=document.getElementById('p'+target);
      if(el){
        requestAnimationFrame(()=>setTimeout(()=>{
          const delta=el.getBoundingClientRect().top - main.getBoundingClientRect().top;
          main.scrollTop += delta - main.clientHeight/2 + el.offsetHeight/2;
          el.classList.add('hl');
          setTimeout(()=>el.classList.remove('hl'), 3000);
        }, 120));
      }
    } else {
      main.scrollTop=0;
    }
    prog.style.width='0';
    document.querySelectorAll('#toc a').forEach(a=>{
      a.classList.toggle('active', Number(a.dataset.no)===Number(d.no));
    });
    const act=document.querySelector('#toc a.active');
    if(act){
      const a=act.getBoundingClientRect();
      const box=tocEl.getBoundingClientRect();
      tocEl.scrollTop += (a.top - box.top) - (box.height - a.height) / 2;
    }
  }catch(e){
    reader.innerHTML=`<div class="loading">加载失败：${esc(e.message)}</div>`;
  }
}

/* 键盘翻章 */
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT')return;
  if(e.key==='ArrowLeft'&&CUR&&CUR.prev) loadChapter(CUR.prev.no);
  if(e.key==='ArrowRight'&&CUR&&CUR.next) loadChapter(CUR.next.no);
});

document.getElementById('askBtn').addEventListener('click',()=>{location.href='/#ask'});

/* 目录过滤仍即时。满两个字再向原文检索，点一条打开对应章和段。 */
let searchTimer=null, searchCtrl=null;
function hideHits(){
  hitsEl.classList.remove('show');
  hitsEl.hidden=true;
  hitsEl.innerHTML='';
}
function showHits(html){
  hitsEl.innerHTML=html;
  hitsEl.hidden=false;
  hitsEl.classList.add('show');
}
function jumpHit(ch, p0){
  if(window.innerWidth<=820){ aside.classList.remove('open'); mask.classList.remove('show'); }
  history.replaceState(null, '', '?ch='+ch+'&p='+p0);
  loadChapter(ch);
}
async function searchBook(q){
  if(searchCtrl) searchCtrl.abort();
  searchCtrl=new AbortController();
  try{
    const r=await fetch('/api/search?q='+encodeURIComponent(q)+'&topK=5', {signal:searchCtrl.signal});
    if(document.getElementById('tocSearch').value.trim()!==q) return;
    const d=await r.json().catch(()=>null);
    if(!r.ok || !d || !Array.isArray(d.citations)){
      showHits('<p>原文检索没连上</p>');
      return;
    }
    const rows=d.citations.slice(0,5);
    if(!rows.length){ showHits('<p>原文里没有这段</p>'); return; }
    showHits(rows.map(c=>{
      const ch=numAttr(c.ch), p0=numAttr(c.p0)||'1';
      const excerpt=esc(String(c.excerpt||'').replace(/\s+/g,' ').slice(0,80));
      return '<button type="button" data-ch="'+ch+'" data-p="'+p0+'"><b>'+esc(c.title||'')+'</b><small>第 '+ch+' 章 · 第 '+p0+' 段</small><small>'+excerpt+'</small></button>';
    }).join(''));
  }catch(e){
    if(e && e.name==='AbortError') return;
    showHits('<p>原文检索没连上</p>');
  }
}
document.getElementById('tocSearch').addEventListener('input', e=>{
  const q=e.target.value.trim();
  clearTimeout(searchTimer);
  if(q.length<2){ hideHits(); return; }
  searchTimer=setTimeout(()=>searchBook(q), 320);
});
hitsEl.addEventListener('click', e=>{
  const b=e.target.closest('button');
  if(!b || !b.dataset.ch) return;
  jumpHit(Number(b.dataset.ch), Number(b.dataset.p)||1);
});

/* 初始化：地址里的章优先，否则打开上次读到的章。 */
(async function(){
  try{
    const r=await fetch('/api/toc');
    const d=await r.json();
    TOC=d.chapters||[];
    renderToc();
    const params=new URLSearchParams(location.search);
    const fromUrl=Number(params.get('ch'));
    let saved=0;
    try{ saved=Number(localStorage.getItem('gx_read_ch'))||0; }catch(err){}
    const ch=(Number.isInteger(fromUrl) && fromUrl>0) ? fromUrl : (saved>0 ? saved : 1);
    loadChapter(ch);
  }catch(e){
    tocMeta.textContent='目录加载失败';
    reader.innerHTML=`<div class="loading">目录加载失败：${esc(e.message)}</div>`;
  }
})();
