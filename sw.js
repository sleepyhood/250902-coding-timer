// ===== sw.js (Patched) =====
// Notes:
// - Adds 5-minute cooldown after (re)start: pause is rejected until cooldown ends
// - Fixes undefined variables in pause handler (cur/now)
// - Exposes cooldownRemaining via `pomo:getState` for UI
// - Preserves existing layout helpers & alarm handling

const POMO_COOLDOWN_MS = 5 * 60 * 1000; // 5분

const KEY = "pomo.sessions";
const now = () => Date.now();

async function loadAll() {
  const obj = await chrome.storage.local.get(KEY);
  return obj[KEY] || {};
}
async function saveAll(sessions) {
  await chrome.storage.local.set({ [KEY]: sessions });
}
const alarmName = (k) => `pomo::${k}`;

async function settleIfExpired(problemKey) {
  const sessions = await loadAll();
  const s = sessions[problemKey];
  if (!s) return null;
  if (s.status === "focus" && now() >= s.endAt) {
    const dur = (s.breakMin ?? 5) * 60 * 1000;
    const startedAt = now(),
      endAt = startedAt + dur;
    sessions[problemKey] = { ...s, status: "break", startedAt, endAt };
    await saveAll(sessions);
    await chrome.alarms.create(alarmName(problemKey), { when: endAt });
    try {
      chrome.notifications.create(`done-${problemKey}`, {
        type: "basic",
        iconUrl: "icon128.png",
        title: "포커스 종료",
        message: "쉬는 시간 시작!",
      });
    } catch (e) {}
    broadcast(problemKey);
    return sessions[problemKey];
  }
  if (s.status === "break" && now() >= s.endAt) {
    sessions[problemKey] = { ...s, status: "idle" };
    await saveAll(sessions);
    try {
      chrome.notifications.create(`break-${problemKey}`, {
        type: "basic",
        iconUrl: "icon128.png",
        title: "쉬는 시간 종료",
        message: "다음 포커스를 시작해 볼까요?",
      });
    } catch (e) {}
    broadcast(problemKey);
    return sessions[problemKey];
  }
  return s;
}

function broadcast(problemKey) {
  chrome.tabs.query(
    {
      url: [
        "*://*.acmicpc.net/*",
        "*://programmers.co.kr/*",
        "*://school.programmers.co.kr/*",
        "http://localhost:5173/*",
        "*://edu.doingcoding.com/*",
        "*://edu.goorm.io/learn/lecture/*",
      ],
    },
    (tabs) => {
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs.sendMessage(
          tab.id,
          { type: "pomo:update", problemKey },
          () => void chrome.runtime.lastError
        );
      }
    }
  );
}

// Window layout helpers (unchanged)
async function getDisplayForWindow(win) {
  const displays = await chrome.system.display.getInfo();
  const cx = (win.left ?? 0) + (win.width ?? 0) / 2;
  const cy = (win.top ?? 0) + (win.height ?? 0) / 2;
  return (
    displays.find((d) => {
      const wa = d.workArea;
      return (
        cx >= wa.left &&
        cx <= wa.left + wa.width &&
        cy >= wa.top &&
        cy <= wa.top + wa.height
      );
    }) ||
    displays.find((d) => d.isPrimary) ||
    displays[0]
  );
}
async function snapLeft(windowId) {
  const win = await chrome.windows.get(windowId);
  const d = await getDisplayForWindow(win);
  const wa = d.workArea;
  await chrome.windows.update(windowId, { state: "normal" });
  await chrome.windows.update(windowId, {
    left: wa.left,
    top: wa.top,
    width: Math.floor(wa.width / 2),
    height: wa.height,
  });
}
async function snapRight(windowId) {
  const win = await chrome.windows.get(windowId);
  const d = await getDisplayForWindow(win);
  const wa = d.workArea;
  await chrome.windows.update(windowId, { state: "normal" });
  await chrome.windows.update(windowId, {
    left: wa.left + Math.floor(wa.width / 2),
    top: wa.top,
    width: Math.floor(wa.width / 2),
    height: wa.height,
  });
}
async function maximize(windowId) {
  await chrome.windows.update(windowId, { state: "maximized" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const sessions = await loadAll();
    const { problemKey } = msg || {};
    const s = sessions[msg.problemKey];

    // 상태 조회 + 쿨다운 남은 시간
    if (msg?.type === "pomo:getState") {
      const nowTs = Date.now();
      const cooldownRemaining = s?.cooldownUntil
        ? Math.max(0, s.cooldownUntil - nowTs)
        : 0;
      sendResponse({ ok: true, state: s, cooldownRemaining });
      return;
    }

    if (msg?.type === "openOptions") {
      (async () => {
        try {
          if (chrome.runtime.openOptionsPage) {
            await chrome.runtime.openOptionsPage();
          } else {
            await chrome.tabs.create({
              url: chrome.runtime.getURL("options.html"),
            });
          }
          sendResponse({ ok: true });
        } catch (e) {
          try {
            await chrome.tabs.create({
              url: chrome.runtime.getURL("options.html"),
            });
            sendResponse({ ok: true, fallback: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        }
      })();
      return true; // async response
    }

    if (msg?.type === "openOptionsFallback") {
      const url = msg.url || chrome.runtime.getURL("options.html");
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else chrome.tabs.create({ url });
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "pomo:get") {
      await settleIfExpired(problemKey);
      const latest = (await loadAll())[problemKey] || { status: "idle" };
      sendResponse(latest);
      return;
    }

    // === PAUSE ===
    if (msg?.type === "pomo:pause") {
      const all = await loadAll();
      const cur = all[msg.problemKey];
      const nowTs = Date.now();

      if (!cur || cur.status !== "focus") {
        sendResponse({ ok: false, error: "not-in-focus" });
        return;
      }

      // Cooldown enforcement
      if (cur.cooldownUntil && nowTs < cur.cooldownUntil) {
        const remain = cur.cooldownUntil - nowTs;
        sendResponse({
          ok: false,
          error: "cooldown",
          cooldownRemaining: remain,
        });
        return;
      }

      const remainingMs = Math.max(0, (cur.endAt || 0) - nowTs);
      all[msg.problemKey] = {
        ...cur,
        status: "paused",
        remainingMs,
        pausedAt: nowTs,
        pausesCount: (cur.pausesCount || 0) + 1,
      };
      await saveAll(all);
      await chrome.alarms.clear(alarmName(msg.problemKey));
      broadcast(msg.problemKey);
      sendResponse({ ok: true });
      return;
    }

    // === START / RESUME ===
    if (msg?.type === "pomo:start") {
      const focusMin = msg.focusMin ?? 25;
      const breakMin = msg.breakMin ?? 5;
      const all = await loadAll();
      const prior = all[msg.problemKey];

      // Policy: limit pauses, optional min segment, etc. (kept from your version)
      const MIN_SEG_MS = 5 * 60 * 1000;
      const MAX_PAUSES = 2;
      if (prior?.status === "paused") {
        if ((prior.pausesCount || 0) > MAX_PAUSES) {
          sendResponse({ ok: false, error: "too-many-pauses" });
          return;
        }
        if (prior.startedAt && prior.startedAt + MIN_SEG_MS > Date.now()) {
          // Optional: enforce min segment before re-pause; keep behavior
        }
      }

      const durMs =
        prior?.status === "paused"
          ? Number.isFinite(prior.remainingMs)
            ? prior.remainingMs
            : (prior.focusMin ?? focusMin) * 60 * 1000
          : focusMin * 60 * 1000;

      const startedAt =
        prior?.status === "paused" && prior.startedAt
          ? prior.startedAt
          : Date.now();
      const endAt = Date.now() + durMs;

      all[msg.problemKey] = {
        status: "focus",
        startedAt,
        endAt,
        focusMin,
        breakMin,
        pausesCount: prior?.pausesCount || 0,
        remainingMs: null,
        cooldownUntil: Date.now() + POMO_COOLDOWN_MS, // 쿨다운 시작
      };
      await saveAll(all);
      await chrome.alarms.create(alarmName(msg.problemKey), { when: endAt });
      broadcast(msg.problemKey);
      sendResponse({ ok: true });
      return;
    }

    // Layout / Panel / Mark (unchanged)
    if (
      msg?.type === "layout:left" ||
      msg?.type === "layout:right" ||
      msg?.type === "layout:maximize"
    ) {
      const tab = sender?.tab;
      if (!tab?.windowId) {
        sendResponse({ ok: false, error: "no-window" });
        return;
      }
      if (msg.type === "layout:left") await snapLeft(tab.windowId);
      else if (msg.type === "layout:right") await snapRight(tab.windowId);
      else await maximize(tab.windowId);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "toggle-panel") {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        for (const t of tabs) {
          chrome.tabs.sendMessage(
            t.id,
            { type: "pomo:togglePanel" },
            () => void chrome.runtime.lastError
          );
        }
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "mark-solved") {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        for (const t of tabs) {
          chrome.tabs.sendMessage(
            t.id,
            { type: "pomo:markSolved" },
            () => void chrome.runtime.lastError
          );
        }
      });
      sendResponse({ ok: true });
      return;
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab?.windowId) return;
  if (command === "layout-left") await snapLeft(tab.windowId);
  if (command === "layout-right") await snapRight(tab.windowId);
  if (command === "layout-maximize") await maximize(tab.windowId);
  if (command === "toggle-panel")
    chrome.tabs.sendMessage(
      tab.id,
      { type: "pomo:togglePanel" },
      () => void chrome.runtime.lastError
    );
  if (command === "mark-solved")
    chrome.tabs.sendMessage(
      tab.id,
      { type: "pomo:markSolved" },
      () => void chrome.runtime.lastError
    );
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name?.startsWith("pomo::")) return;
  const problemKey = alarm.name.split("pomo::")[1];
  await settleIfExpired(problemKey);
});
