const tocEl=document.getElementById('toc'), tocMeta=document.getElementById('tocMeta'),
      reader=document.getElementById('reader'), titleEl=document.getElementById('title'),
      main=document.getElementById('main'), prog=document.getElementById('progress'),
      aside=document.getElementById('aside'), mask=document.getElementById('mask');

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
    if(target>0){
      const el=document.getElementById('p'+target);
      if(el){
        requestAnimationFrame(()=>setTimeout(()=>{
          el.scrollIntoView({block:'center'});
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
    if(act) act.scrollIntoView({block:'nearest'});
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
/* 初始化 */
(async function(){
  try{
    const r=await fetch('/api/toc');
    const d=await r.json();
    TOC=d.chapters||[];
    renderToc();
    const params=new URLSearchParams(location.search);
    const ch=Number(params.get('ch'))||1;
    loadChapter(ch);
  }catch(e){
    tocMeta.textContent='目录加载失败';
    reader.innerHTML=`<div class="loading">目录加载失败：${esc(e.message)}</div>`;
  }
})();
