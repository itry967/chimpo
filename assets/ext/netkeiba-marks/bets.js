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
  var i = 0, ok = 0, yen = 0, ng = [], okNames = [], tries = 0, adds = 0, cancelled = false;
  // 入れているあいだは画面に「お待ちください」を出す(1.3.3)。画面の操作はふさぐ。「やめる」で途中で止められる(1.4.0。2026-11-23 ユーザーの指示)
  var wbox = document.createElement("div");
  wbox.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:sans-serif");
  wbox.innerHTML = '<div style="background:#fff;color:#222;border-radius:12px;padding:22px 30px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.4);min-width:280px">' +
    '<div style="font-size:17px;font-weight:700;margin-bottom:8px">予想ビューアから買い目を入れています</div>' +
    '<div id="kbbWaitMsg" style="font-size:14px">しばらくお待ちください(画面ができるのを待っています)</div>' +
    '<div style="font-size:12px;color:#666;margin-top:8px">終わるまで画面に触らないでください。購入(IPAT投票)は押しません。</div>' +
    '<button id="kbbCancel" style="margin-top:12px;padding:6px 18px;border-radius:6px;border:1px solid #999;background:#f4f4f4;cursor:pointer">やめる</button></div>';
  wbox.querySelector("#kbbCancel").onclick = function () { cancelled = true; this.textContent = "やめています…"; this.disabled = true; };
  var showWait = function (t) { if (!wbox.parentNode) document.body.appendChild(wbox); var m = wbox.querySelector("#kbbWaitMsg"); if (m && t) m.textContent = t; };
  var hideWait = function () { if (wbox.parentNode) wbox.parentNode.removeChild(wbox); };
  var ordered = function (k) { return k === "馬単" || k === "3連単"; };
  function clearSel() { q("td.Horse_Select input:checked").forEach(function (x) { (x.parentNode.querySelector("label") || x).click(); }); }
  function houshiki(name) { var a = q("dl.houshiki dd a, .houshiki a").filter(function (x) { return x.textContent.trim() === name; })[0]; if (a) a.click(); return !!a; }
  function kensu() { var e = document.getElementById("kumiawase_kensu"); return e ? +e.textContent.trim() : -1; }
  // 買い目: [券種, 馬番の並び, 金額](通常)か { f: 1, kind, cols: [[馬番…], …], amt, n: 点数, names, t: [[馬番…], …] }(フォーメーション。1.4.0)
  // フォーメーションは中の金額がすべて同じときだけビューアが作る。選んだあとの点数が n と違えば、1点ずつ(通常)に切り替える
  function step() {
    if (cancelled) return done();
    if (i >= d.b.length) return done();
    showWait("しばらくお待ちください(" + (i + 1) + " / " + d.b.length + " 件目)");
    var b = d.b[i++], form = !Array.isArray(b) && b.f;
    var kind = form ? b.kind : b[0], amt = form ? b.amt : b[2];
    var name = form ? kind + " フォーメーション " + b.cols.map(function (c) { return c.join(","); }).join(ordered(kind) ? " → " : " - ") + "(" + b.n + "点)"
                    : kind + " " + b[1].join(ordered(kind) ? "→" : "-");
    var tb = tab(kind);
    if (!tb) { ng.push(name + "(券種が無い)"); return step(); }
    tb.click();
    setTimeout(function () {
      if (!houshiki(form ? "フォーメーション" : "通常") && form) {   // フォーメーションが選べなければ1点ずつ
        d.b.splice.apply(d.b, [i, 0].concat(b.t.map(function (t) { return [kind, t, amt]; }))); return step();
      }
      setTimeout(function () {
        var rows = q("tr.HorseList").filter(function (tr) { return tr.getClientRects().length && tr.querySelector("td.Horse_Select"); });
        var byU = {};
        rows.forEach(function (tr) { byU[String(+tr.cells[1].textContent.trim())] = tr; });
        var miss = false;
        var pick = function (u, k) {
          var tr = byU[String(+u)]; if (!tr) { miss = true; return; }
          var cells = tr.querySelectorAll("td.Horse_Select"), c = cells.length > 1 ? cells[k] : cells[0];
          var inp = c && c.querySelector("input"); if (!inp || inp.disabled) { miss = true; return; }
          if (!inp.checked) (c.querySelector("label") || inp).click();
        };
        if (form) b.cols.forEach(function (col, k) { col.forEach(function (u) { pick(u, k); }); });
        else b[1].forEach(pick);
        var money = document.querySelector("input[name=money]");
        if (money) {
          money.value = String(Math.max(1, Math.round(amt / 100)));
          ["input", "keyup", "change"].forEach(function (ev) { money.dispatchEvent(new Event(ev, { bubbles: true })); });
        }
        setTimeout(function () {
          var add = addBtn(), pts = form ? b.n : 1;
          if (form && !miss && kensu() !== b.n) {   // 点数が合わない: 選びを消して1点ずつにする
            clearSel();
            d.b.splice.apply(d.b, [i, 0].concat(b.t.map(function (t) { return [kind, t, amt]; })));
            return setTimeout(step, 500);
          }
          if (miss || !money || !add || /disabled/.test(add.className)) {
            ng.push(name + (miss ? "(馬を選べない)" : "(追加できない)"));
            clearSel();
            return setTimeout(step, 500);
          }
          add.click(); adds++; ok += pts; yen += Math.max(1, Math.round(amt / 100)) * 100 * pts;
          if (form) okNames.push.apply(okNames, b.names); else okNames.push(name);
          setTimeout(step, 900);
        }, 600);
      }, 600);
    }, 900);
  }
  function done() {
    hideWait();
    history.replaceState(null, "", location.pathname + location.search.replace(/&kbb=[^&]*/, ""));
    var got = stored() - base;   // 「IPAT投票」が読む記録に、実際に入った件数(フォーメーションは1件)
    if (got < adds) {
      ok = 0; okNames = [];
      ng.push("購入画面の記録に入っていない買い目がある(「IPAT投票」で「買い目が入力されていません」になる。ページを読み込み直して、もう一度送ってください)");
    }
    if (cancelled) ng.push("「やめる」で途中で止めた(残り " + (d.b.length - i) + " 件は入れていない。入れた分は投票内容に残っている)");
    try { if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) chrome.runtime.sendMessage({ type: "kbb-done", ok: ok > 0, n: ok, yen: yen, ng: ng, okNames: okNames, id: d.id || "" }); } catch (e) {}
    alert("netkeiba の購入画面に買い目を " + ok + " 点入れました(合計 " + yen.toLocaleString() + " 円)。" +
      (ng.length ? "\n入れられなかった・止めた: " + ng.join("、") : "") +
      "\n\n右の「投票内容」で買い目と金額を確かめてから、ご自分で「IPAT投票」を押してください(このプログラムは購入を押しません)。");
  }
  // 購入画面は買い目を画面とは別にブラウザの記録(localStorage の ndi::bet_<race_id>)にも入れ、「IPAT投票」はその記録を読む。
  // 開いた直後にその記録を作り直す処理が後から走るので、記録ができてから少し待って入れる(1.3.2。11/22 に「買い目が入力されていません」が出た)
  var lsKey = "ndi::bet_" + rid;
  var stored = function () { try { var v = JSON.parse(localStorage.getItem(lsKey) || "null"); return v && v.list ? Object.keys(v.list).length : 0; } catch (e) { return 0; } };
  var base = 0;
  (function wait() {   // 画面と記録ができるまで待つ(最大 20 秒)
    if (document.body) showWait();
    if (!tab("単勝") || !document.querySelector("input[name=money]")) {   // 記録(lsKey)は初めて買い目を入れるまで無いことがあるので、待つ条件に入れない(1.4.0)
      if (++tries > 40) { hideWait(); alert("買い目転記: 購入画面が出ませんでした(netkeiba にログインしているか・IPAT 連動の設定を確かめてください)"); return; }
      return setTimeout(wait, 500);
    }
    setTimeout(function () { base = stored(); step(); }, 2500);   // 画面ができたあと、記録を作り直す処理が済むまで少し待つ
  })();
})();
