// 裏の処理: 頼まれた netkeiba の出馬表を見えないタブで開き、転記が終わったら(content.js から知らせが来たら)タブを閉じて、頼んだビューアのタブに結果を返す。
const jobs = {};   // netkeiba のタブ id → { viewer: ビューアのタブ id, id: 頼みの id, timer }
function finish(tabId, result) {
  const j = jobs[tabId];
  if (!j) return;
  clearTimeout(j.timer);
  delete jobs[tabId];
  chrome.tabs.remove(tabId).catch(() => {});
  chrome.tabs.sendMessage(j.viewer, { type: "kbm-result", id: j.id, ...result }).catch(() => {});
}
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === "open" && sender.tab) {
    chrome.tabs.create({ url: msg.url.includes("&bg=1") ? msg.url : msg.url + "&bg=1", active: false }, tab => {
      jobs[tab.id] = { viewer: sender.tab.id, id: msg.id,
        timer: setTimeout(() => finish(tab.id, { ok: false, message: "60 秒たっても終わらなかったので止めました(netkeiba が開けない・遅いなど)" }), 60000) };
    });
  } else if (msg.type === "kbb-done") {   // 買い目転記の結果を、開いている予想ビューアのタブに知らせる
    chrome.tabs.query({ url: ["http://localhost:8770/*", "http://127.0.0.1:8770/*", "https://itry967.github.io/chimpo/*"] }, tabs => {
      for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "kbm-result", kind: "bets", ...msg }).catch(() => {});
    });
  } else if (msg.type === "kbm-done" && sender.tab) {
    finish(sender.tab.id, { ok: msg.ok, message: msg.message });
  }
});
chrome.tabs.onRemoved.addListener(tabId => { if (jobs[tabId]) finish(tabId, { ok: false, message: "転記の途中で netkeiba のタブが閉じられました" }); });
