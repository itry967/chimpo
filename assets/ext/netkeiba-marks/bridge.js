// 予想ビューアのページで動く。拡張機能が入っていることをページに知らせ、ページからの転記の頼みを裏の処理(bg.js)に渡し、結果をページに返す。
document.documentElement.dataset.kbmExt = "1.3";
window.addEventListener("message", function (e) {
  if (e.source !== window || !e.data || e.data.type !== "kbm-send" || typeof e.data.url !== "string") return;
  if (!/^https:\/\/race\.netkeiba\.com\/race\/shutuba\.html\?race_id=\d+#kbm=/.test(e.data.url)) return;   // netkeiba の出馬表だけ
  chrome.runtime.sendMessage({ type: "open", url: e.data.url, id: e.data.id });
});
chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === "kbm-result") window.postMessage(msg, "*");
});
