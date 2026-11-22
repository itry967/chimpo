// 予想ビューア 印転記(2026-11-22)。ビューアの「netkeiba に印を転記」から開いた出馬表(URL の # に kbm=… がある)でだけ動く。
// ふだんの netkeiba の閲覧では何もしない。印は netkeiba の印の▼のリストの項目を押して付ける(保存は netkeiba 自身の仕組み)。
// ビューアで印の無い馬は「--」に戻す。
// 裏のタブ(# に bg=1)では知らせを出さず、終わったら裏の処理(bg.js)に結果を返す(タブは bg.js が閉じる)。
// 前に開いたタブ(bg=1 が無い)では、終わったら知らせて、このタブを閉じ、元の予想ビューアのタブに戻る。
(function () {
  var m = location.hash.match(/kbm=([^&]+)/);
  if (!m) return;
  var bg = /(^|[#&])bg=1/.test(location.hash);
  function done(ok, message) {
    if (bg) { chrome.runtime.sendMessage({ type: "kbm-done", ok: ok, message: message }); return; }
    alert(message + (ok ? "。OK でこのタブを閉じます" : ""));
    if (!ok) return;
    history.replaceState(null, "", location.pathname + location.search);
    setTimeout(function () {
      try { if (window.opener && !window.opener.closed) window.opener.focus(); } catch (e) {}
      window.close();
    }, 800);
  }
  var d;
  try { d = JSON.parse(decodeURIComponent(m[1])); } catch (e) { return done(false, "印転記: 印を読めませんでした"); }
  var rid = (location.search.match(/race_id=(\d+)/) || [])[1];
  if (d.r && rid && d.r !== rid) return done(false, "印転記: レースが違います(ビューア " + d.r + " / このページ " + rid + ")");
  var T = ["--", "◎", "◯", "▲", "△", "☆", "✓", "消"];
  var tries = 0;
  (function wait() {   // 出馬表の印の欄が出るまで待つ(最大 15 秒)
    var sels = document.querySelectorAll(".HorseList .CheckMark select");
    if (!sels.length || !document.querySelector(".HorseList .CheckMark ul.dropDown li")) {
      if (++tries > 30) return done(false, "印転記: 印の欄が見つかりませんでした(netkeiba にログインしているか確かめてください)");
      return setTimeout(wait, 500);
    }
    var q = [];
    sels.forEach(function (s) {
      var o = s.options[1]; if (!o) return;
      var u = String(+o.value.split("_")[0]);
      var want = d.m[u] || "--", i = T.indexOf(want); if (i < 0) return;
      var cur = s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : "--";
      if (cur.indexOf("10003") >= 0 || cur === "✓") cur = "✓";
      if (cur === want) return;
      var li = s.parentNode.querySelectorAll("ul.dropDown li")[i];
      if (li) q.push(li);
    });
    var k = 0;
    (function next() {
      if (k >= q.length) return setTimeout(function () { done(true, "netkeiba に印を転記しました(変えた馬 " + q.length + "頭)"); }, 800);   // 最後の保存を待つ
      q[k++].click();
      setTimeout(next, 400);
    })();
  })();
})();
