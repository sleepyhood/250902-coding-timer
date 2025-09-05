const MATCH_URLS = [
  "http://edu.doingcoding.com/*",
  "https://edu.doingcoding.com/*",
  "https://www.acmicpc.net/*",
  "https://acmicpc.net/*",
  "https://edu.goorm.io/*",
  "https://school.programmers.co.kr/learn/challenges*",
  "https://school.programmers.co.kr/learn/courses/*/lessons/*"
];

async function ensureInjected(tabId) {
  try { await chrome.scripting.executeScript({target: {tabId}, files: ["content.js"]}); }
  catch(e) {}
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.tabs.query({}, (tabs)=>{
    tabs.forEach(t=>{
      if (t.url && MATCH_URLS.some(p => new URLPattern(p).test(t.url))) {
        try { chrome.scripting.executeScript({target:{tabId: t.id}, files:["content.js"]}); } catch(e){}
      }
    });
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    if (MATCH_URLS.some(p => new URLPattern(p).test(tab.url))) {
      await ensureInjected(tabId);
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;
  if (msg.type.startsWith('layout:') && sender.tab) {
    const which = msg.type.split(':')[1];
    chrome.windows.get(sender.tab.windowId, {populate:false}, (w) => {
      if (!w) return;
      const screenW = w.width, screenH = w.height;
      if (which === 'left' || which === 'right') {
        const left = which === 'left' ? 0 : Math.max(0, Math.floor(screenW/2));
        chrome.windows.update(w.id, {left, top:0, width: Math.floor(screenW/2), height: screenH, state: "normal"});
      } else if (which === 'maximize') {
        chrome.windows.update(w.id, {state: "maximized"});
      }
    });
  }
  if (msg.type === 'notify:idle') {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: '집중모드 해제',
        message: '키보드+마우스 입력이 2분간 없어 집중 타이머가 멈췄습니다.'
      });
    } catch(e) {}
  }
});