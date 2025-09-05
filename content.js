

(function(){
  if (window.__codingTimerInjected) return;
  window.__codingTimerInjected = true;

  // ---- guards for extension disconnect ----
  function hasExt(){
    return typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.id === 'string';
  }
  function safeSendMessage(msg){
    if (!hasExt()) return false;
    try { chrome.runtime.sendMessage(msg); return true; } catch(e){ return false; }
  }

  // ---------- Utils ----------
  const TWO_MIN = 2*60*1000;
  const todayStr = () => {
    const d = new Date();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  };
  const fmt = (ms) => {
    const s = Math.floor(ms/1000);
    const hh = String(Math.floor(s/3600)).padStart(2,'0');
    const mm = String(Math.floor((s%3600)/60)).padStart(2,'0');
    const ss = String(s%60).padStart(2,'0');
    return `${hh}:${mm}:${ss}`;
  };
  const hash = (s) => { let h=0; for (let i=0;i<s.length;i++){ h=(h<<5)-h+s.charCodeAt(i); h|=0; } return (h>>>0).toString(36); };

  // ---------- Domain rules ----------
  const H = location.host;
  const rules = {
    "edu.doingcoding.com": {
      isProblem: (url) => /^\/problem(\/|$)/.test(url.pathname),
      isList:    (url) => !/^\/problem(\/|$)/.test(url.pathname),
      key: (url) => `${url.host}:${url.pathname}`
    },
    "www.acmicpc.net": {
      isProblem: (url) => /^\/problem\/\d+/.test(url.pathname),
      isList:    (url) => !/^\/problem\/\d+/.test(url.pathname),
      key: (url) => `${url.host}:${url.pathname}`
    },
    "acmicpc.net": {
      isProblem: (url) => /^\/problem\/\d+/.test(url.pathname),
      isList:    (url) => !/^\/problem\/\d+/.test(url.pathname),
      key: (url) => `${url.host}:${url.pathname}`
    },
    "edu.goorm.io": {
      isProblem: (url) => /^\/learn\/lecture\/[^/]+\/cos-pro-/.test(url.pathname),
      isList:    (url) => !/^\/learn\/lecture\/[^/]+\/cos-pro-/.test(url.pathname),
      key: (url) => `${url.host}:${url.pathname}`
    },
    "school.programmers.co.kr": {
      isProblem: (url) => /^\/learn\/courses\/[^/]+\/lessons\/[^/]+/.test(url.pathname),
      isList:    (url) => /^\/learn\/challenges/.test(url.pathname),
      key: (url) => `${url.host}:${url.pathname}`
    }
  };
  const getUrl = (u) => { try { return new URL(u || location.href); } catch(_) { return new URL(location.href); } };
  const R = () => rules[H] || {
    isProblem:(url)=>/problem|lessons/.test(url.pathname),
    isList:(url)=>!/problem|lessons/.test(url.pathname),
    key:(url)=>`${url.host}:${url.pathname}`
  };
  const getProblemKey = (u) => {
    const url = getUrl(u), r=R();
    return r.key(url) || `${url.host}:${url.pathname}#${hash(url.pathname)}`;
  };
  const getPageMode = (u) => {
    const url=getUrl(u), r=R();
    return r.isProblem(url) ? "problem" : (r.isList(url) ? "list" : "other");
  };

  // ---------- State ----------
  let CURRENT_KEY = getProblemKey();
  let MODE = getPageMode();
  const HOSTPOS = 'ct.pos.' + location.host;

  const S = {
    running: true, lastTick: Date.now(),
    totalMs: 0, focusMs: 0,
    lastKeyAt: 0, lastMouseAt: 0,
    day: todayStr(), todayTotal: 0, todayFocus: 0
  };

  // ---------- Storage ----------
  function loadProblemAcc(key){
    try { const raw = localStorage.getItem(`ct.acc.${key}`); return raw? JSON.parse(raw) : {totalMs:0, focusMs:0}; }
    catch(_) { return {totalMs:0, focusMs:0}; }
  }
  function saveProblemAcc(key, acc){
    try { localStorage.setItem(`ct.acc.${key}`, JSON.stringify(acc)); } catch(_) {}
  }
  function loadTodayTotals(){
    try {
      const raw = localStorage.getItem(`ct.day.${location.host}.${S.day}`);
      return raw? JSON.parse(raw) : {totalMs:0, focusMs:0};
    } catch(_) { return {totalMs:0, focusMs:0}; }
  }
  function saveTodayTotals(tot){
    try { localStorage.setItem(`ct.day.${location.host}.${S.day}`, JSON.stringify(tot)); } catch(_) {}
  }

  // init from current key/day
  (function initFromKey(){
    const acc = loadProblemAcc(CURRENT_KEY);
    S.totalMs = acc.totalMs||0; S.focusMs = acc.focusMs||0;
    const day = loadTodayTotals(); S.todayTotal = day.totalMs||0; S.todayFocus = day.focusMs||0;
  })();

  // ---------- HUD in Shadow DOM ----------
  const host = document.createElement('div');

// host 만들자마자 추가 (content.js)
const force = (prop, val) => host.style.setProperty(prop, val, 'important');
force('background', 'transparent');
force('border', 'none');
force('outline', 'none');
force('box-shadow', 'none');
force('border-radius', '0');
force('padding', '0');
force('margin', '0');
force('filter', 'none');



  host.id = 'ct-hud-host';
  Object.assign(host.style, {
    position:'fixed', top:'16px', left:'50%', transform:'translateX(-50%)',
    zIndex: 2147483000
  });
  const shadow = host.attachShadow({mode:'open'});
  document.documentElement.appendChild(host);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; contain: layout paint style; }
    .row { display:flex; align-items:center; gap:10px; padding:8px 10px;
           background: rgba(12,12,14,.88); color:#fff; font: 13px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
           border-radius:12px; box-shadow: 0 2px 16px rgba(0,0,0,.35); backdrop-filter: saturate(1.2) blur(6px); }
    .pill { padding:4px 8px; border-radius:8px; background:#2b2f36; font-weight:700; white-space:nowrap; }
    .small { opacity:.85; }
    .btn { all: unset; display:inline-flex; align-items:center; justify-content:center;
           padding:6px 9px; border-radius:8px; background:#2b2f36; cursor:pointer; user-select:none; }
    .btn:hover { background:#3b414b; }
    .btn svg { width:16px; height:16px; display:block; }
    .panel { position:fixed; top:64px; right:16px; max-width:460px; max-height:60vh; overflow:auto; background:rgba(12,12,14,.96); color:#fff; border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.45); padding:12px; display:none; z-index:2147483001; }
    .grid { display:grid; grid-template-columns:1fr auto auto; gap:8px 12px; }
    .name { opacity:.9; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .num { font-weight:700; }
  `;

  const row = document.createElement('div');
  row.className = 'row';

  function pill(label){ const s=document.createElement('span'); s.className='pill'; s.textContent=label; return s; }
  const aEl = pill('총: 00:00:00');
  const bEl = pill('집중: 00:00:00');
  const small = document.createElement('span'); small.className='small';

  function icon(name){
    const ns='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 24 24');
    const path=document.createElementNS(ns,'path');
    path.setAttribute('fill','currentColor');
    if (name==='left')  path.setAttribute('d','M14 7l-5 5 5 5V7z');
    if (name==='right') path.setAttribute('d','M10 17l5-5-5-5v10z');
    if (name==='max')   path.setAttribute('d','M4 6h16v12H4z M6 8v8h12V8z');
    svg.appendChild(path); return svg;
  }
  function btnIcon(name, tip, handler){
    const b=document.createElement('button'); b.className='btn'; b.title=tip||'';
    b.appendChild(icon(name)); b.addEventListener('click', handler); return b;
  }
  const btnLeft  = btnIcon('left','창 왼쪽',  ()=> safeSendMessage({type:'layout:left'}));
  const btnMax   = btnIcon('max', '최대화',   ()=> safeSendMessage({type:'layout:maximize'}));
  const btnRight = btnIcon('right','창 오른쪽',()=> safeSendMessage({type:'layout:right'}));

  const btnExpand = document.createElement('button');
  btnExpand.className='btn'; btnExpand.title='문제별 기록 보기'; btnExpand.textContent='▾';

  row.append(aEl, bEl, small, btnLeft, btnMax, btnRight, btnExpand);
  wrap.appendChild(row);
  shadow.append(style, wrap);

  function applyMode(){
    MODE = getPageMode();
    btnExpand.style.display = (MODE === 'list') ? '' : 'none';
    small.style.display     = (MODE === 'list') ? '' : 'none';
  }
  applyMode();

  // Drag (host element is in main DOM)
  let dragging=false, dx=0, dy=0;
  function clamp(left, top){
    const r=host.getBoundingClientRect(); const W=innerWidth, H=innerHeight, M=8;
    return { left: Math.max(M, Math.min(W - r.width  - M, left)),
             top:  Math.max(M, Math.min(H - r.height - M, top )) };
  }
  (async ()=>{
    try{
      const saved = await chrome.storage.local.get(HOSTPOS);
      if (saved && saved[HOSTPOS]){
        const p=saved[HOSTPOS];
        host.style.left=p.left+'px'; host.style.top=p.top+'px'; host.style.transform='translateX(0)';
      }
    }catch(_){}
  })();
  host.addEventListener('mousedown', (e)=>{
    dragging=true; host.style.cursor='grabbing';
    const r=host.getBoundingClientRect();
    dx=e.clientX-r.left; dy=e.clientY-r.top; e.preventDefault();
  });
  addEventListener('mousemove', (e)=>{
    if(!dragging) return;
    const p=clamp(e.clientX-dx, e.clientY-dy);
    host.style.left=p.left+'px'; host.style.top=p.top+'px'; host.style.transform='translateX(0)';
  });
  addEventListener('mouseup', ()=>{
    if(!dragging) return; dragging=false; host.style.cursor='';
    const r=host.getBoundingClientRect(); const pos={left:Math.round(r.left), top:Math.round(r.top)};
    try{ chrome.storage.local.set({[HOSTPOS]:pos}); }catch(_){}
  });

  // Expand panel (Shadow DOM)
  const panel = document.createElement('div');
  panel.className='panel';
  const title = document.createElement('div'); title.textContent='문제별 누적 (전체)'; title.style.cssText='font-weight:700;margin-bottom:8px';
  const grid = document.createElement('div'); grid.className='grid';
  panel.append(title, grid);
  shadow.append(panel);

  function renderPanel(){
    grid.innerHTML='';
    const prefix = `ct.acc.${location.host}:`;
    const rows = [];
    for (let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)){
        try {
          const v = JSON.parse(localStorage.getItem(k) || '{}');
          const label = k.substring(prefix.length);
          rows.push({label, totalMs:v.totalMs||0, focusMs:v.focusMs||0});
        } catch(_) {}
      }
    }
    rows.sort((a,b)=> b.totalMs - a.totalMs);
    rows.slice(0,300).forEach(r=>{
      const n=document.createElement('div'); n.className='name'; n.textContent=r.label;
      const t=document.createElement('div'); t.className='num';  t.textContent=fmt(r.totalMs);
      const f=document.createElement('div'); f.className='num';  f.textContent=fmt(r.focusMs);
      grid.append(n,t,f);
    });
  }
  btnExpand.addEventListener('click', ()=>{
    if (panel.style.display==='none'){ renderPanel(); panel.style.display='block'; }
    else panel.style.display='none';
  });

  // ---------- Activity tracking ----------
  const markKey=()=>{ S.lastKeyAt=Date.now(); };
  const markMouse=()=>{ S.lastMouseAt=Date.now(); };
  ['keydown','keyup'].forEach(ev=>addEventListener(ev,markKey,{passive:true}));
  ['mousemove','mousedown','wheel','touchstart','touchmove'].forEach(ev=>addEventListener(ev,markMouse,{passive:true}));
  document.addEventListener('visibilitychange', ()=>{ if (document.hidden){ S.lastKeyAt=0; S.lastMouseAt=0; } });

  // ---------- URL change detection ----------
  const _push = history.pushState, _replace = history.replaceState;
  function onUrlMaybeChanged(){
    const newKey = getProblemKey();
    const newMode = getPageMode();
    if (newKey !== CURRENT_KEY){
      saveProblemAcc(CURRENT_KEY, { totalMs: S.totalMs, focusMs: S.focusMs });
      CURRENT_KEY = newKey;
      const acc = loadProblemAcc(CURRENT_KEY);
      S.totalMs = acc.totalMs||0; S.focusMs = acc.focusMs||0;
    }
    if (newMode !== MODE){
      MODE = newMode; applyMode();
      if (MODE === 'list'){
        const d = loadTodayTotals();
        S.todayTotal = d.totalMs||0; S.todayFocus = d.focusMs||0;
      }
    }
  }
  history.pushState = function(...args){ _push.apply(this,args); setTimeout(onUrlMaybeChanged,0); };
  history.replaceState = function(...args){ _replace.apply(this,args); setTimeout(onUrlMaybeChanged,0); };
  addEventListener('popstate', onUrlMaybeChanged);
  addEventListener('hashchange', onUrlMaybeChanged);
  setInterval(onUrlMaybeChanged, 1000);

  // ---------- Main loop ----------
  function loop(){
    const now = Date.now(); const dt = now - S.lastTick; S.lastTick = now;
    const effectiveRun = S.running && (getPageMode() === 'problem');

    if (effectiveRun){
      S.totalMs += dt;
      const bothRecent = (now - S.lastKeyAt < TWO_MIN) && (now - S.lastMouseAt < TWO_MIN) && !document.hidden;
      if (bothRecent) S.focusMs += dt;

      if (S.day !== todayStr()){ S.day = todayStr(); S.todayTotal = 0; S.todayFocus = 0; }
      S.todayTotal += dt; if (bothRecent) S.todayFocus += dt;

      if (!bothRecent && (now % 15000 < dt)) safeSendMessage({ type: 'notify:idle' });
    }

    if (getPageMode() === 'problem'){
      aEl.textContent = '총: ' + fmt(S.totalMs);
      bEl.textContent = '집중: ' + fmt(S.focusMs);
      small.textContent = '';
    } else {
      const d = loadTodayTotals();
      aEl.textContent = '오늘 총: ' + fmt(d.totalMs||0);
      bEl.textContent = '오늘 집중: ' + fmt(d.focusMs||0);
      small.textContent = '';
    }

    if (now % 3000 < dt){
      saveProblemAcc(CURRENT_KEY, { totalMs: S.totalMs, focusMs: S.focusMs });
      const d = loadTodayTotals();
      if (getPageMode() === 'problem'){ d.totalMs = S.todayTotal; d.focusMs = S.todayFocus; }
      saveTodayTotals(d);
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // listen to SW commands if available
  if (hasExt()) {
    try {
      chrome.runtime.onMessage.addListener((msg)=>{
        if (!msg || !msg.type) return;
        if (msg.type === 'layout:left')  btnLeft.click();
        if (msg.type === 'layout:right') btnRight.click();
        if (msg.type === 'layout:maximize') btnMax.click();
      });
    } catch(_){}
  }
})();