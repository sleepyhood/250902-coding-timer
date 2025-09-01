const KEY = "pomo.options";
const DEFAULTS = {
  history: { maxStore: 150, maxShow: 12 },
  detect: {
    rules: [
      {
        host: "*.acmicpc.net",
        selectors: [
          ".result",
          "div.alert",
          "div.result",
          "section#status-table",
        ],
        keywords: ["맞았습니다", "정답", "Accepted"],
      },
      {
        host: "edu.doingcoding.com",
        selectors: ["#status", ".alert-success", ".toast", ".result"],
        keywords: ["맞았습니다", "정확한풀이"],
      },
      {
        host: "edu.goorm.io",
        selectors: [".result", ".alert", ".toast", ".modal"],
        keywords: ["정답", "정답입니다.", "성공", "Accepted"],
      },
    ],
  },
};
function loadOptions() {
  return new Promise((r) =>
    chrome.storage.local.get(KEY, (o) => {
      const opt = o[KEY] || DEFAULTS;
      const out = JSON.parse(JSON.stringify(DEFAULTS));
      if (opt.history) Object.assign(out.history, opt.history);
      if (opt.detect && Array.isArray(opt.detect.rules))
        out.detect.rules = opt.detect.rules;
      r(out);
    })
  );
}
function saveOptions(opts) {
  return new Promise((r) => chrome.storage.local.set({ [KEY]: opts }, r));
}
function renderRule(rule) {
  const div = document.createElement("div");
  div.className = "rule";
  div.innerHTML = `
  <div class="row"><label>호스트</label><input class="host wide" type="text" placeholder="예: *.acmicpc.net" value="${
    rule.host || ""
  }"></div>
  <div class="row"><label>선택자(쉼표 구분)</label><input class="selectors wide" type="text" placeholder=".result, .alert-success" value="${(
    rule.selectors || []
  ).join(", ")}"></div>
  <div class="row"><label>키워드(쉼표 구분)</label><input class="keywords wide" type="text" placeholder="맞았습니다, 정답, Accepted" value="${(
    rule.keywords || []
  ).join(", ")}"></div>
  <div class="row"><button class="ghost remove">규칙 삭제</button></div>`;
  div.querySelector(".remove").onclick = () => {
    div.remove();
  };
  return div;
}
function readRules(container) {
  const rules = [];
  container.querySelectorAll(".rule").forEach((div) => {
    const host = div.querySelector(".host").value.trim();
    if (!host) return;
    const selectors = div
      .querySelector(".selectors")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const keywords = div
      .querySelector(".keywords")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    rules.push({ host, selectors, keywords });
  });
  return rules;
}
async function init() {
  const opts = await loadOptions();
  document.getElementById("maxStore").value = opts.history.maxStore;
  document.getElementById("maxShow").value = opts.history.maxShow;
  const rulesDiv = document.getElementById("rules");
  rulesDiv.innerHTML = "";
  (opts.detect.rules || []).forEach((r) => rulesDiv.appendChild(renderRule(r)));
  document.getElementById("addRule").onclick = () =>
    rulesDiv.appendChild(renderRule({ host: "", selectors: [], keywords: [] }));
  document.getElementById("save").onclick = async () => {
    const newOpts = {
      history: {
        maxStore: Math.max(
          10,
          parseInt(document.getElementById("maxStore").value || 150, 10)
        ),
        maxShow: Math.max(
          5,
          parseInt(document.getElementById("maxShow").value || 12, 10)
        ),
      },
      detect: { rules: readRules(rulesDiv) },
    };
    await saveOptions(newOpts);
    const s = document.getElementById("status");
    s.textContent = "저장됨";
    setTimeout(() => (s.textContent = ""), 1200);
  };
  document.getElementById("reset").onclick = async () => {
    await saveOptions(DEFAULTS);
    await init();
    const s = document.getElementById("status");
    s.textContent = "기본값으로 복원됨";
    setTimeout(() => (s.textContent = ""), 1200);
  };
}
document.addEventListener("DOMContentLoaded", init);
