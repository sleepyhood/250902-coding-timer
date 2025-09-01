function isContextAlive() {
  try {
    return !!chrome?.runtime?.id;
  } catch {
    return false;
  }
}

function safeGetLocal(key) {
  return new Promise((resolve) => {
    if (!isContextAlive()) return resolve(undefined);
    try {
      chrome.storage.local.get(key, (o) => {
        if (chrome.runtime.lastError || !isContextAlive())
          return resolve(undefined);
        resolve(o);
      });
    } catch (e) {
      resolve(undefined);
    }
  });
}

function urlInfo() {
  const u = new URL(location.href);
  const host = u.host;
  const ph = (() => {
    if (u.hash && /\/problem\//.test(u.hash)) return u.hash.replace(/^#/, "");
    return u.pathname;
  })();
  return { u, host, path: ph.split("?")[0].replace(/\/+$/, "") };
}
function pageKind() {
  const { host, path } = urlInfo();
  if (
    host.includes("edu.goorm.io") &&
    /\/learn\/lecture\/[^/]+\/cos-pro-/i.test(path)
  )
    return "problem";
  if (/\/problem\//.test(path)) return "problem";
  if (host.includes("edu.goorm.io") && /\/learn\/lecture\//.test(path))
    return "lecture";
  return "other";
}
function getProblemKey() {
  const { host, path } = urlInfo();
  if (pageKind() === "problem" || pageKind() === "lecture")
    return `${host}${path}`;
  return null;
}

const POS_KEY = "pomo.pos";
const UI_KEY = "pomo.ui";
const HIST_KEY = "pomo.history";
const OPT_KEY = "pomo.options";
const DEFAULT_OPTS = {
  history: { maxStore: 150, maxShow: 12 },
  detect: { rules: [] },
};
let OPTS = DEFAULT_OPTS;

async function getSavedPos() {
  return new Promise((r) =>
    chrome.storage.local.get(POS_KEY, (o) => {
      const m = o[POS_KEY] || {};
      r(m[location.host] || null);
    })
  );
}
async function savePos(pos) {
  return new Promise((r) =>
    chrome.storage.local.get(POS_KEY, (o) => {
      const m = o[POS_KEY] || {};
      m[location.host] = pos;
      chrome.storage.local.set({ [POS_KEY]: m }, r);
    })
  );
}
async function getUI() {
  return new Promise((r) =>
    chrome.storage.local.get(UI_KEY, (o) => {
      const m = o[UI_KEY] || {};
      r(m[location.host] || { expanded: false });
    })
  );
}
async function setUI(p) {
  return new Promise((r) =>
    chrome.storage.local.get(UI_KEY, (o) => {
      const m = o[UI_KEY] || {};
      const c = m[location.host] || { expanded: false };
      m[location.host] = { ...c, ...p };
      chrome.storage.local.set({ [UI_KEY]: m }, r);
    })
  );
}

async function getHistory() {
  const o = await safeGetLocal(HIST_KEY);
  return o?.[HIST_KEY]?.items || [];
}
async function setHistory(items) {
  if (!isContextAlive()) return;
  try {
    await new Promise((r) =>
      chrome.storage.local.set({ [HIST_KEY]: { items } }, r)
    );
  } catch {}
}
async function pushHistory(item) {
  const it = await getHistory();
  it.unshift(item);
  await loadOpts();
  await setHistory(it.slice(0, OPTS.history?.maxStore || 150));
}
async function removeHistoryByAt(at) {
  const it = await getHistory();
  await setHistory(it.filter((x) => x.at !== at));
}
async function loadOpts() {
  return new Promise((r) =>
    chrome.storage.local.get(OPT_KEY, (o) => {
      const opt = o[OPT_KEY] || DEFAULT_OPTS;
      const out = JSON.parse(JSON.stringify(DEFAULT_OPTS));
      if (opt.history) Object.assign(out.history, opt.history);
      if (opt.detect && Array.isArray(opt.detect.rules))
        out.detect.rules = opt.detect.rules;
      OPTS = out;
      r(out);
    })
  );
}
chrome.storage.onChanged.addListener((ch) => {
  if (ch[OPT_KEY]) loadOpts();
});

function deriveFocusMinutesByDifficulty() {
  if (pageKind() !== "problem") return null;
  const text = document.body?.innerText || "";
  const mLv = text.match(/Lv\.\s*([1-5])/i);
  if (mLv) {
    const lv = parseInt(mLv[1], 10);
    return { 1: 10, 2: 15, 3: 20, 4: 25, 5: 30 }[lv] || 25;
  }
  const mKo = text.match(/난이도\s*[:：]?\s*(쉬움|보통|어려움)/);
  if (mKo) return { 쉬움: 10, 보통: 20, 어려움: 30 }[mKo[1]];
  const mEn = text.match(/difficulty\s*[:：]?\s*(easy|medium|hard)/i);
  if (mEn) return { easy: 10, medium: 20, hard: 30 }[mEn[1].toLowerCase()];
  return null;
}

let mounted = false,
  problemKey = null,
  state = { status: "idle" },
  prevState = null,
  rafId = null,
  lastHref = location.href;
const PROD_IDLE_MS = 2 * 60 * 1000,
  DEV_IDLE_MS = 10 * 1000;
const idleThreshold = location.host.includes("localhost")
  ? DEV_IDLE_MS
  : PROD_IDLE_MS;
let lastActiveAt = Date.now(),
  activeMs = 0,
  lastBeat = Date.now(),
  heartbeatTimer = null;

// === New: cooldown tracking ===
let cooldownRemaining = 0;
let cooldownTimerId = null;
function startCooldownTicker(updatePauseButtonUI) {
  if (cooldownTimerId) clearInterval(cooldownTimerId);
  if (cooldownRemaining <= 0) return;
  cooldownTimerId = setInterval(() => {
    cooldownRemaining = Math.max(0, cooldownRemaining - 1000);
    updatePauseButtonUI?.();
    if (cooldownRemaining <= 0) {
      clearInterval(cooldownTimerId);
      cooldownTimerId = null;
    }
  }, 1000);
}

// Snackbar
function createSnackbar(shadow) {
  let bar = shadow.getElementById("snackbar");
  if (bar) return bar;
  const el = document.createElement("div");
  el.id = "snackbar";
  el.innerHTML = `
<style>
#snackbar{position:fixed;right:16px;bottom:16px;z-index:2147483647;background:rgba(30,30,30,.95);color:#fff;padding:10px 12px;border-radius:10px;box-shadow:0 6px 14px rgba(0,0,0,.25);display:flex;align-items:center;gap:8px;font:13px ui-sans-serif,system-ui}
#snackbar .btn{background:#4f46e5;border-radius:8px;padding:6px 10px;cursor:pointer}
#snackbar .ghost{background:rgba(255,255,255,.15)}
#snackbar.hidden{display:none}
</style>
<div id="box"><span id="msg"></span><button id="act" class="btn">확인</button><button id="undo" class="btn ghost" style="display:none">되돌리기</button><button id="dismiss" class="btn ghost">닫기</button></div>`;
  shadow.appendChild(el);
  return el;
}
function showConfirm(shadow, msg, onYes) {
  const bar = createSnackbar(shadow);
  bar.classList.remove("hidden");
  bar.querySelector("#msg").textContent = msg;
  bar.querySelector("#undo").style.display = "none";
  const yes = () => {
    onYes?.();
    hide();
  };
  const hide = () => bar.classList.add("hidden");
  const act = bar.querySelector("#act"),
    dis = bar.querySelector("#dismiss");
  act.textContent = "예";
  act.onclick = yes;
  dis.onclick = hide;
  function key(e) {
    if (e.key === "Enter") {
      yes();
      window.removeEventListener("keydown", key, true);
    }
  }
  window.addEventListener("keydown", key, true);
  setTimeout(hide, 5000);
}
function showUndo(shadow, msg, onUndo) {
  const bar = createSnackbar(shadow);
  bar.classList.remove("hidden");
  bar.querySelector("#msg").textContent = msg;
  const undo = bar.querySelector("#undo");
  undo.style.display = "inline-block";
  const hide = () => bar.classList.add("hidden");
  bar.querySelector("#act").textContent = "확인";
  bar.querySelector("#act").onclick = hide;
  bar.querySelector("#dismiss").onclick = hide;
  undo.onclick = () => {
    onUndo?.();
    hide();
  };
  setTimeout(hide, 5000);
}

// Mount
async function mountUI(key) {
  problemKey = key;
  if (mounted) return;
  mounted = true;
  await loadOpts();
  const uiPref = await getUI();
  const compact = !uiPref.expanded;
  const host = document.createElement("div");
  host.id = "pomo-host";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
<style>
:host{ all:initial }
#wrap{
  position:fixed; z-index:2147483647; top:16px; right:16px;
  background:rgba(20,20,20,.92); color:#fff; padding:10px 12px; border-radius:14px;
  overflow:hidden; font-family:ui-sans-serif,system-ui; box-shadow:0 6px 20px rgba(0,0,0,.22);
  user-select:none; touch-action:none; --pct:0.0;
  --c-primary:#4f46e5; --c-ghost:rgba(255,255,255,.12); --c-layout:#2563eb; --c-danger:#ef4444;
}
#wrap.compact .panel{display:none}

#wrap:focus-within{ outline: 2px solid rgba(99,102,241,.6); outline-offset: 2px; border-radius:14px }

.top{ display:flex; align-items:center; gap:10px }

/* === Status pill === */
#status{
  display:inline-flex; align-items:center; gap:6px;
  opacity:.9; font-size:12px; padding:4px 8px; border-radius:999px;
  background:rgba(255,255,255,.08); min-width:72px; text-transform:uppercase;
}
#status .dot{width:8px;height:8px;border-radius:50%;background:#10b981}
#status[data-state="break"] .dot{background:#22c55e}
#status[data-state="idle"]  .dot{background:#f59e0b}
#status[data-state="paused"].dot{background:#ef4444}

/* === Progress ring + remain === */
#ringBtn{
  all:unset; cursor:pointer; position:relative; width:64px; height:64px; flex:0 0 64px;
  display:grid; place-items:center; border-radius:50%;
  background:conic-gradient(var(--c-primary) calc(var(--pct)*1%), rgba(255,255,255,.12) 0);
}
#ringBtn::after{
  content:""; position:absolute; inset:6px; border-radius:50%; background:#171717;
}
#remain{
  position:relative;
  font-size:20px;       /* 기존 14px → 20px */
  font-weight:700;      /* 두껍게 */
  letter-spacing:.5px;
  min-width:60px;       /* 넓이 조금 늘려주기 */
  text-align:center;
  z-index:1;
}


/* idle badge */
#idleBadge{ display:none; padding:2px 6px; font-size:11px; border-radius:6px; background:var(--c-danger); color:#fff }

/* buttons */
/* 버튼 기본 톤 정리 */
button{ all:unset; padding:8px 12px; border-radius:12px; cursor:pointer; line-height:1; text-align:center; font-weight:600 }
button.primary{ background:#4f46e5 }   /* 주버튼: 파랑 */
button.ghost{ background:rgba(255,255,255,.12) }  /* 보조: 중립 */
button.layout{ background:rgba(255,255,255,.10) } /* 레이아웃: 더 연한 중립 */
button:disabled{ opacity:.55; cursor:not-allowed }
button:focus-visible{ outline:2px solid rgba(255,255,255,.56); outline-offset:2px }

#controls{ display:grid; gap:8px }
#controls .xl{ font-size:18px; padding:12px 16px; width:100% }  /* 토글 크게, 한 줄 전체 */
.layout-group{ display:grid; grid-template-columns:repeat(3,1fr); gap:6px }

/* menu grid */
#menuGrid{ display:grid; grid-template-columns:1fr auto; column-gap:12px; row-gap:8px; align-items:center; margin-top:8px }
#title{ font-size:12px; opacity:.88 }
#active{ font-size:12px; opacity:.85 }

/* segmented control (modes) */
#modes{ display:inline-flex; gap:6px }
#modes button{ padding:6px 10px; background:rgba(255,255,255,.10) }
#modes button[aria-pressed="true"]{ background:#0ea5e9 }

/* controls */
#btns{ display:grid; grid-template-columns:repeat(4,auto); gap:6px }

/* history */
#history{ margin-top:8px; max-width:560px }
#histHeader{ display:flex; align-items:center; justify-content:space-between; font-size:12px; opacity:.9; margin-bottom:6px }
#histList{ max-height:160px; overflow:auto; padding:8px; background:rgba(255,255,255,.06); border-radius:10px }
#histList a{ color:#93c5fd; text-decoration:none }
.item{ display:flex; align-items:center; gap:8px; font-size:12px; margin-bottom:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:540px }
.item img.fav{ width:14px; height:14px; border-radius:3px; opacity:.9 }

/* handle / misc */
#handle{ cursor:move; opacity:.7; font-size:12px }

@media (prefers-reduced-motion: reduce){
  #overlay{ transition:none }
}

/* === Idle Overlay === */
#overlay{
  position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 2147483646;
  display: none; align-items: center; justify-content: center; pointer-events: auto;
  opacity: 0; transition: opacity .18s ease;
}
#overlay[aria-hidden="false"]{ opacity:1 }
#overlay .box{
  color:#fff; text-align:center; max-width:520px; padding:20px 24px; border-radius:14px;
  background: rgba(17,17,17,.85); box-shadow: 0 10px 30px rgba(0,0,0,.35);
  font: 14px/1.5 ui-sans-serif,system-ui;
}
#overlay .title{ font-size:16px; font-weight:700; margin-bottom:6px }
#overlay .hint{ opacity:.9; font-size:13px }
</style>

<div id="wrap" class="${compact ? "compact" : "expanded"}">
  <div class="top">
    <span id="handle" title="드래그하여 이동">⠿</span>
    <div id="status" data-state="idle" aria-live="polite"><span class="dot"></span><span class="label">FOCUS</span></div>

    <!-- Progress ring always visible -->
    <button id="ringBtn" title="메뉴 열기/닫기 (Alt+Shift+M)" aria-expanded="${!compact}">
      <strong id="remain">--:--</strong>
    </button>

    <span id="idleBadge" aria-hidden="true">IDLE</span>

    <button id="more" class="ghost" title="메뉴 열기/닫기 (Alt+Shift+M)" aria-controls="panel">⋯</button>
    <button id="settings" class="ghost" title="옵션 열기">⚙️</button>
  </div>

  <div id="panel" class="panel" role="region" aria-label="타이머 패널">
    <div id="menuGrid">
      <div>
        <div id="title"></div>
        <div id="active">활동 00:00 (0%)</div>
      </div>

      <!-- Mode segmented control -->
      <div id="modes" role="group" aria-label="모드">
        <button id="modeFocus" aria-pressed="true" title="집중">Focus</button>
        <button id="modeShort" aria-pressed="false" title="짧은 휴식">Short</button>
        <button id="modeLong"  aria-pressed="false" title="긴 휴식">Long</button>
      </div>

<!-- Controls (간소화) -->
<div id="controls" style="grid-column:1 / -1">
  <button id="toggle" class="primary xl" title="시작/일시정지 (Space)">▶</button>
  <div class="layout-group">
    <button id="left" class="layout" title="왼쪽 반 (Alt+Shift+Left)">⬅️</button>
    <button id="max" class="layout" title="최대화 (Alt+Shift+F)">⛶</button>
    <button id="right" class="layout" title="오른쪽 반 (Alt+Shift+Right)">➡️</button>
  </div>
</div>
    </div>

    <!-- History -->
    <div id="history">
      <div id="histHeader">
        <span>최근 활동</span>
        <button id="histToggle" class="ghost" aria-expanded="true" title="히스토리 접기/펼치기">접기</button>
      </div>
      <div id="histList" role="list"></div>
    </div>
  </div> <!-- /panel -->
</div> <!-- /wrap -->

<!-- Idle Overlay -->
<div id="overlay" aria-hidden="true">
  <div class="box">
    <div class="title">집중 시간 멈춤</div>
    <div>최근 2분간 키보드/마우스/스크롤 활동이 없어 화면을 잠시 가렸어요.</div>
    <div class="hint">마우스 움직임, 키 입력, 스크롤 등 활동이 감지되면 자동으로 해제됩니다.</div>
  </div>
</div>
`;

  document.documentElement.appendChild(host);

  // ✅ 교체 후
  const $ = (s) => shadow.querySelector(s);

  // 그다음에
  const wrap = $("#wrap"),
    toggleBtn = $("#toggle"),
    statusEl = $("#status"),
    remainEl = $("#remain"),
    ringBtn = $("#ringBtn"),
    histToggle = $("#histToggle");

  const idleBadge = $("#idleBadge"),
    handle = $("#handle");
  const btnLeft = $("#left"),
    btnRight = $("#right"),
    btnMax = $("#max"),
    btnMore = $("#more"),
    btnSettings = $("#settings");
  const titleEl = $("#title"),
    histList = $("#histList");

  const pos = await getSavedPos();
  if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
    wrap.style.right = "auto";
    wrap.style.left = `${pos.left}px`;
    wrap.style.top = `${pos.top}px`;
  }
  const guessTitle = () => {
    // 1) 사이트별 커스텀(있으면 최우선) — 옵션화 안 되어 있으면 하드코딩도 OK
    const siteSel = document.querySelector(
      // 필요한 셀렉터를 쉼표로 추가
      "h1,h2,.title,.lecture-title,.problem-title,.lesson-title,.problem__title, .panel-title"
    );
    if (siteSel) return (siteSel.textContent || "").trim().slice(0, 80);

    // 2) 메타 og:title
    const og = document.querySelector('meta[property="og:title"]')?.content;
    if (og) return og.trim().slice(0, 80);

    // 3) <title>
    if (document.title) return document.title.trim().slice(0, 80);

    return "";
  };
  titleEl.textContent = guessTitle();

  let dragging = false,
    startX = 0,
    startY = 0,
    baseLeft = 0,
    baseTop = 0;
  function beginDrag(e) {
    dragging = true;
    const r = wrap.getBoundingClientRect();
    baseLeft = r.left;
    baseTop = r.top;
    startX = e.clientX;
    startY = e.clientY;
    wrap.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }
  function onDrag(e) {
    if (!dragging) return;
    const dx = e.clientX - startX,
      dy = e.clientY - startY;
    const left = Math.max(0, Math.min(window.innerWidth - 40, baseLeft + dx));
    const top = Math.max(0, Math.min(window.innerHeight - 40, baseTop + dy));
    wrap.style.right = "auto";
    wrap.style.left = `${left}px`;
    wrap.style.top = `${top}px`;
  }
  async function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    wrap.releasePointerCapture?.(e.pointerId);
    const r = wrap.getBoundingClientRect();
    await savePos({ left: r.left, top: r.top });
  }
  [handle, wrap].forEach((el) =>
    el.addEventListener("pointerdown", (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "button" || e.button !== 0) return;
      beginDrag(e);
    })
  );
  window.addEventListener("pointermove", onDrag, { passive: true });
  window.addEventListener("pointerup", endDrag, { passive: true });

  const activity = () => {
    lastActiveAt = Date.now();
  };
  [
    "mousemove",
    "mousedown",
    "wheel",
    "keydown",
    "touchstart",
    "pointerdown",
    "scroll",
  ].forEach((evt) => window.addEventListener(evt, activity, { passive: true }));

  // startBtn.onclick = () =>
  //   chrome.runtime.sendMessage({
  //     type: "pomo:start",
  //     problemKey,
  //     focusMin: defaultFocusMin(),
  //     breakMin: defaultBreakMin(),
  //   });
  const updateToggleButtonUI = () => {
    const running = state?.status === "focus";
    const underCooldown = cooldownRemaining > 0;

    toggleBtn.disabled = running && underCooldown;
    if (running) {
      if (underCooldown) {
        const secs = Math.ceil(cooldownRemaining / 1000);
        toggleBtn.textContent = `⏸ (${secs}s)`;
        toggleBtn.title = `시작 후 5분은 일시정지할 수 없어요. 남은 ${secs}초`;
      } else {
        toggleBtn.textContent = "⏸";
        toggleBtn.title = "일시정지";
      }
    } else {
      toggleBtn.textContent = "▶";
      toggleBtn.title = "시작";
    }
  };

  // start(▶)는 상태별로 “재개/새로시작”을 자동 처리(sw.js가 판단)
  // ✅ 추가: ▶/⏸ 토글
  // 시작/일시정지 토글
  toggleBtn.onclick = () => {
    if (state?.status === "focus") {
      // 실행 중 → (쿨다운이 0이면) 일시정지
      if (cooldownRemaining > 0) return; // UI에서 disabled 처리도 함께 함
      chrome.runtime.sendMessage({ type: "pomo:pause", problemKey }, (res) => {
        if (!res?.ok) {
          if (res?.error === "cooldown") {
            const secs = Math.ceil((res.cooldownRemaining || 0) / 1000);
            cooldownRemaining = res.cooldownRemaining || 0;
            updateToggleButtonUI();
            startCooldownTicker(updateToggleButtonUI);
            showUndo(
              shadow,
              `시작 후 5분은 일시정지할 수 없어요. 남은 ${secs}초`,
              null
            );
          }
        }
      });
      return;
    }

    // idle/break → 시작
    chrome.runtime.sendMessage(
      {
        type: "pomo:start",
        problemKey,
        focusMin: defaultFocusMin(),
        breakMin: defaultBreakMin(),
      },
      (res) => {
        if (res?.error === "too-many-pauses") {
          showUndo(shadow, "일시정지 횟수를 초과했습니다.", null);
        } else if (res?.error === "min-segment-not-met") {
          showUndo(
            shadow,
            "집중 시작 후 5분이 지나야 일시정지/재개가 가능합니다.",
            null
          );
        }
        // 쿨다운 갱신
        chrome.runtime.sendMessage(
          { type: "pomo:getState", problemKey },
          (r2) => {
            if (r2?.ok) {
              cooldownRemaining = r2.cooldownRemaining || 0;
              updateToggleButtonUI();
              startCooldownTicker(updateToggleButtonUI);
            }
          }
        );
      }
    );
  };

  btnLeft.onclick = () => chrome.runtime.sendMessage({ type: "layout:left" });
  btnRight.onclick = () => chrome.runtime.sendMessage({ type: "layout:right" });
  btnMax.onclick = () =>
    chrome.runtime.sendMessage({ type: "layout:maximize" });
  const toggle = () => {
    const exp = !wrap.classList.contains("expanded");
    wrap.classList.toggle("expanded", exp);
    wrap.classList.toggle("compact", !exp);
    setUI({ expanded: exp });
  };
  btnMore.onclick = toggle;
  ringBtn.addEventListener("click", toggle);

  // remainEl.addEventListener("click", toggle);
  if (btnSettings)
    btnSettings.onclick = () => {
      console.log("[pomo] settings click → ask SW to open options");
      chrome.runtime.sendMessage({ type: "openOptions" }, (res) => {
        console.log(
          "[pomo] openOptions response:",
          res,
          "lastError=",
          chrome.runtime.lastError
        );
        // SW에서 응답이 없거나 에러면 폴백으로 직접 열기
        if (!res?.ok) {
          const url = chrome.runtime.getURL("options.html");
          try {
            window.open(url, "_blank", "noopener");
          } catch (e) {}
        }
      });
    };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "pomo:togglePanel") toggle();
    if (msg.type === "pomo:markSolved") manualMark();
  });
  let histCollapsed = false;

  async function refreshHistory() {
    const items = await getHistory();
    const maxShow = OPTS.history?.maxShow ?? 12;
    const list = histCollapsed ? [] : items.slice(0, maxShow);

    histList.innerHTML = list
      .map((it) => {
        const d = new Date(it.at);
        const t = d.toLocaleString();
        const title = it.title ? ` - ${it.title}` : "";
        const url = `${location.protocol}//${it.host}${it.path}`;
        const auto = it.auto ? " (auto)" : "";
        const fav = `https://www.google.com/s2/favicons?domain=${it.host}&sz=32`;
        return `
      <div class="item" role="listitem">
        <img class="fav" src="${fav}" alt="">
        <a href="${url}" target="_blank" rel="noopener">${it.host}${it.path}</a>${title} — ${t}${auto}
      </div>`;
      })
      .join("");

    histToggle.textContent = histCollapsed ? "펼치기" : "접기";
    histToggle.setAttribute("aria-expanded", String(!histCollapsed));
  }

  histToggle.addEventListener("click", () => {
    histCollapsed = !histCollapsed;
    refreshHistory();
  });

  // btnMark.onclick = () => manualMark();
  // function manualMark() {
  //   const { host, path } = urlInfo();
  //   const title = guessTitle();
  //   const at = Date.now();
  //   const item = { key: problemKey, title, at, auto: false, host, path };
  //   pushHistory(item).then(() => {
  //     refreshHistory();
  //     showUndo(shadow, "기록됨 — 되돌리기", () =>
  //       removeHistoryByAt(at).then(refreshHistory)
  //     );
  //   });
  // }

  // Selector-based auto-detect
  function getRuleForHost() {
    const rules = (OPTS.detect && OPTS.detect.rules) || [];
    for (const r of rules) {
      if (!r.host) continue;
      if (r.host.startsWith("*.")) {
        const suf = r.host.slice(1);
        if (location.host.endsWith(suf)) return r;
      } else if (r.host === location.host) {
        return r;
      }
    }
    return null;
  }
  function buildKeywordRegex(rule) {
    const list =
      rule && Array.isArray(rule.keywords) && rule.keywords.length
        ? rule.keywords
        : [
            "맞았습니다",
            "정답입니다",
            "성공",
            "통과",
            "Accepted",
            "Correct",
            "정확한풀이",
          ];
    const esc = list.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(esc.join("|"), "i");
  }
  let selectionTargets = [];
  function refreshTargets(rule) {
    selectionTargets = [];
    const sels = rule && Array.isArray(rule.selectors) ? rule.selectors : [];
    if (!sels.length) return;
    sels.forEach((sel) =>
      document.querySelectorAll(sel).forEach((el) => selectionTargets.push(el))
    );
  }
  function withinTargets(el) {
    if (!selectionTargets.length) return true;
    for (const t of selectionTargets) if (t.contains(el)) return true;
    return false;
  }
  let currentRule = getRuleForHost();
  let kwRe = buildKeywordRegex(currentRule);
  refreshTargets(currentRule);
  const refreshTimer = setInterval(() => refreshTargets(currentRule), 3000);

  const mo = new MutationObserver(async (muts) => {
    for (const m of muts) {
      const txt =
        (m.target?.textContent || "") +
        (m.addedNodes
          ? Array.from(m.addedNodes)
              .map((n) => n.textContent || "")
              .join("")
          : "");
      if (!txt) continue;
      if (!withinTargets(m.target)) continue;
      if (kwRe.test(txt)) {
        const { host, path } = urlInfo();
        const at = Date.now();
        await pushHistory({
          key: problemKey,
          title: guessTitle(),
          at,
          auto: true,
          host,
          path,
        });
        await refreshHistory();
        mo.disconnect();
        clearInterval(refreshTimer);
        break;
      }
    }
  });
  mo.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  // === New: Pause button UI updater respecting cooldown
  // const updatePauseButtonUI = () => {
  //   const inFocus = state?.status === "focus";
  //   const underCooldown = cooldownRemaining > 0;
  //   stopBtn.disabled = !inFocus || underCooldown;
  //   if (underCooldown) {
  //     const secs = Math.ceil(cooldownRemaining / 1000);
  //     stopBtn.textContent = `⏸ (${secs}s)`;
  //     stopBtn.title = `시작 후 5분은 일시정지할 수 없어요. 남은 시간: ${secs}초`;
  //   } else {
  //     stopBtn.textContent = inFocus ? "⏸" : "■";
  //     stopBtn.title = inFocus ? "일시정지" : "정지";
  //   }
  // };

  // Auto-start + initial state load
  chrome.runtime.sendMessage({ type: "pomo:get", problemKey }, async (s) => {
    if (chrome.runtime.lastError) return;
    state = s || { status: "idle" };
    prevState = null;
    if (state.status === "idle" && pageKind() === "problem") {
      const derived = deriveFocusMinutesByDifficulty();
      const focusMin = location.host.includes("localhost")
        ? 0.1
        : derived || 15;
      chrome.runtime.sendMessage(
        {
          type: "pomo:start",
          problemKey,
          focusMin,
          breakMin: defaultBreakMin(),
        },
        () => {
          chrome.runtime.sendMessage(
            { type: "pomo:getState", problemKey },
            (res) => {
              if (res?.ok) {
                cooldownRemaining = res.cooldownRemaining || 0;
                updateToggleButtonUI();
                startCooldownTicker(updateToggleButtonUI);
              }
            }
          );
        }
      );
    } else {
      chrome.runtime.sendMessage(
        { type: "pomo:getState", problemKey },
        (res) => {
          if (res?.ok) {
            cooldownRemaining = res.cooldownRemaining || 0;
            updateToggleButtonUI();
            startCooldownTicker(updateToggleButtonUI);
          }
        }
      );
    }
    render();
    startHeartbeat(shadow);
  });

  // Broadcast → refresh state + cooldown
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "pomo:update" && msg.problemKey === problemKey) {
      chrome.runtime.sendMessage(
        { type: "pomo:get", problemKey },
        async (s) => {
          if (chrome.runtime.lastError) return;
          prevState = state;
          state = s || { status: "idle" };
          // ask SW for current cooldownRemaining
          chrome.runtime.sendMessage(
            { type: "pomo:getState", problemKey },
            (res) => {
              if (res?.ok) {
                cooldownRemaining = res.cooldownRemaining || 0;
                updateToggleButtonUI();
                startCooldownTicker(updateToggleButtonUI);
              }
            }
          );
          // (Keep your history confirm-on-break logic)
          if (
            prevState &&
            prevState.status === "focus" &&
            state.status === "break"
          ) {
            const items = await getHistory();
            const hadSolved = items.some(
              (it) =>
                it.key === problemKey &&
                it.at >= prevState.startedAt &&
                it.at <= Date.now()
            );
            if (!hadSolved) {
              showConfirm(shadow, "풀이 완료로 기록할까요?", () => {
                const { host, path } = urlInfo();
                const at = Date.now();
                const item = {
                  key: problemKey,
                  title: guessTitle(),
                  at,
                  auto: false,
                  host,
                  path,
                };
                pushHistory(item).then(() => {
                  refreshHistory();
                  showUndo(shadow, "기록됨 — 되돌리기", () =>
                    removeHistoryByAt(at).then(refreshHistory)
                  );
                });
              });
            }
          }
          render();
        }
      );
    }
  });

  function render() {
    const labelEl = statusEl.querySelector(".label");

    const updateRemainAndProgress = () => {
      let remainMs = 0,
        totalMs = 0;
      const now = Date.now();

      if (state.status === "focus" || state.status === "break") {
        remainMs = Math.max(0, (state.endAt || 0) - now);
        totalMs = Math.max(1, (state.endAt || 0) - (state.startedAt || now));
      }

      // 남은 시간 mm:ss
      if (remainMs > 0) {
        const mm = String(Math.floor(remainMs / 60000)).padStart(2, "0");
        const ss = String(Math.floor((remainMs % 60000) / 1000)).padStart(
          2,
          "0"
        );
        remainEl.textContent = `${mm}:${ss}`;
      } else {
        remainEl.textContent = "--:--";
      }

      // 원형 링 진행률
      const pct = totalMs ? Math.max(0, Math.min(1, remainMs / totalMs)) : 0;
      wrap.style.setProperty("--pct", (pct * 100).toFixed(2));
    };

    // 라벨/상태 색
    const label =
      state.status === "focus"
        ? "FOCUS"
        : state.status === "break"
        ? "BREAK"
        : "IDLE";
    labelEl.textContent = label;
    statusEl.dataset.state = state.status || "idle";

    updateRemainAndProgress();
    updateToggleButtonUI();

    if (rafId) cancelAnimationFrame(rafId);
    const loop = () => {
      updateRemainAndProgress();
      updateToggleButtonUI();
      rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  function startHeartbeat(shadow) {
    lastBeat = Date.now();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const dt = now - lastBeat;
      lastBeat = now;
      const running = state.status === "focus";
      const isIdle = document.hidden || now - lastActiveAt >= idleThreshold;
      const idleBadge = shadow.querySelector("#idleBadge");
      const overlay = shadow.getElementById("overlay");

      idleBadge.style.display = running && isIdle ? "inline-block" : "none";
      if (overlay) {
        const show = running && isIdle;
        document.documentElement.style.overflow = show ? "hidden" : "";
        overlay.style.display = show ? "flex" : "none";
        overlay.setAttribute("aria-hidden", show ? "false" : "true");
      }
      if (running && !isIdle) activeMs += dt;
      let percent = 0,
        elapsed = 0;
      if (state.status === "focus") {
        elapsed = Math.max(1, now - state.startedAt);
        percent = Math.min(100, Math.round((activeMs / elapsed) * 100));
      }
      const mm = String(Math.floor(activeMs / 60000)).padStart(2, "0");
      const ss = String(Math.floor((activeMs % 60000) / 1000)).padStart(2, "0");
      const activeEl = shadow.querySelector("#active");
      if (activeEl) activeEl.textContent = `활동 ${mm}:${ss} (${percent}%)`;
    }, 1000);
  }
}

function unmountUI() {
  const host = document.getElementById("pomo-host");
  if (host) host.remove();
  mounted = false;
  problemKey = null;
  if (rafId) cancelAnimationFrame(rafId);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function tryMount() {
  const key = getProblemKey();
  if (!mounted && key) {
    mountUI(key);
  } else if (mounted && !key) {
    unmountUI();
  } else if (mounted && key && key !== problemKey) {
    unmountUI();
    mountUI(key);
  }
}
(function () {
  const p = history.pushState;
  const r = history.replaceState;
  const on = () => setTimeout(tryMount, 0);
  history.pushState = function (...a) {
    const o = p.apply(this, a);
    on();
    return o;
  };
  history.replaceState = function (...a) {
    const o = r.apply(this, a);
    on();
    return o;
  };
  window.addEventListener("popstate", on);
  window.addEventListener("hashchange", on);
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      on();
    }
  }, 800);
})();
document.addEventListener("DOMContentLoaded", tryMount);
tryMount();

function defaultFocusMin() {
  return location.host.includes("localhost") ? 0.1 : 25;
}
function defaultBreakMin() {
  return location.host.includes("localhost") ? 0.1 : 5;
}
