// 予想ビューア 買い目転記(2026-11-22)。ビューアの「netkeiba(IPAT)に買い目を送る」から開いた IPAT 連動馬券購入の画面(URL に &kbb=… がある)でだけ動く。
// 購入画面は URL に # が付くと中身を出さないので、買い目は # ではなく URL の後ろ(&kbb=)で渡す(1.3.1 で直した)。
// 券種のタブ → 馬のチェック → 金額 → 「追加」を、買い目の数だけくり返して入れる。最後の「IPAT投票」(購入)は押さない(購入は自分で確かめて押す)。
(function () {
  var m = location.search.match(/[?&]kbb=([^&]+)/);
  if (!m) return;
  var d;
  try { d = JSON.parse(decodeURIComponent(m[1])); } catch (e) { alert("買い目転記: 買い目を読めませんでした"); return; }
  var rid = (location.search.match(/race_id=(\d+)/) || [])[1];
  if (d.r && rid && d.r !== rid) { alert("買い目転記: レースが違います(ビューア " + d.r + " / このページ " + rid + ")"); return; }
  var q = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var tab = function (n) { return q("dl.shikibetu dd a").filter(function (a) { return a.textContent.trim() === n; })[0]; };
  var addBtn = function () { return q("button").filter(function (x) { return x.textContent.trim() === "追加"; })[0]; };
  var i = 0, ok = 0, yen = 0, ng = [], okNames = [], tries = 0;
  function clearSel() { q("td.Horse_Select input:checked").forEach(function (x) { (x.parentNode.querySelector("label") || x).click(); }); }
  function step() {
    if (i >= d.b.length) return done();
    var b = d.b[i++], kind = b[0], t = b[1], amt = b[2], name = kind + " " + t.join(kind === "馬単" || kind === "3連単" ? "→" : "-");
    var tb = tab(kind);
    if (!tb) { ng.push(name + "(券種が無い)"); return step(); }
    tb.click();
    setTimeout(function () {
      var rows = q("tr.HorseList").filter(function (tr) { return tr.getClientRects().length && tr.querySelector("td.Horse_Select"); });
      var byU = {};
      rows.forEach(function (tr) { byU[String(+tr.cells[1].textContent.trim())] = tr; });
      var miss = false;
      t.forEach(function (u, k) {
        var tr = byU[String(+u)]; if (!tr) { miss = true; return; }
        var cells = tr.querySelectorAll("td.Horse_Select"), c = cells.length > 1 ? cells[k] : cells[0];
        var inp = c && c.querySelector("input"); if (!inp || inp.disabled) { miss = true; return; }
        if (!inp.checked) (c.querySelector("label") || inp).click();
      });
      var money = document.querySelector("input[name=money]");
      if (money) {
        money.value = String(Math.max(1, Math.round(amt / 100)));
        ["input", "keyup", "change"].forEach(function (ev) { money.dispatchEvent(new Event(ev, { bubbles: true })); });
      }
      setTimeout(function () {
        var add = addBtn();
        if (miss || !money || !add || /disabled/.test(add.className)) {
          ng.push(name + (miss ? "(馬を選べない)" : "(追加できない)"));
          clearSel();
          return setTimeout(step, 500);
        }
        add.click(); ok++; yen += Math.max(1, Math.round(amt / 100)) * 100; okNames.push(name);
        setTimeout(step, 900);
      }, 500);
    }, 900);
  }
  function done() {
    history.replaceState(null, "", location.pathname + location.search.replace(/&kbb=[^&]*/, ""));
    // 拡張機能のときは、入れた結果をビューアに知らせる(ビューアの設定で日別ページの「購入した馬券」に入れる。2026-11-22)
    try { if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) chrome.runtime.sendMessage({ type: "kbb-done", ok: ok > 0, n: ok, yen: yen, ng: ng, okNames: okNames, id: d.id || "" }); } catch (e) {}
    alert("netkeiba の購入画面に買い目を " + ok + " 点入れました(合計 " + yen.toLocaleString() + " 円)。" +
      (ng.length ? "\n入れられなかった買い目: " + ng.join("、") : "") +
      "\n\n右の「投票内容」で買い目と金額を確かめてから、ご自分で「IPAT投票」を押してください(このプログラムは購入を押しません)。");
  }
  (function wait() {   // 画面ができるまで待つ(最大 15 秒)
    if (!tab("単勝") || !document.querySelector("input[name=money]")) {
      if (++tries > 30) { alert("買い目転記: 購入画面が出ませんでした(netkeiba にログインしているか・IPAT 連動の設定を確かめてください)"); return; }
      return setTimeout(wait, 500);
    }
    step();
  })();
})();
