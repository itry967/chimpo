
"use strict";
const JYO = {"01":"札幌","02":"函館","03":"福島","04":"新潟","05":"東京","06":"中山","07":"中京","08":"京都","09":"阪神","10":"小倉"};
const RACE_INFO = [  // レースで同じ値の列(展開・馬場)
  "仮柵", "開催日目", "連続開催の何日目", "連続開催の何週目", "仮柵を替えて何日目",
];
const BIAS = [  // 馬場傾向: [表示名, 値の列, 目安の列]
  ["この開催の内外", "この開催の内外(マイナス=内有利)", "この開催の内外の目安"],
  ["この開催の前後", "この開催の前後(マイナス=前有利)", "この開催の前後の目安"],
  ["過去の同じ週の内外", "過去の同じ週の内外(マイナス=内有利)", "過去の同じ週の内外の目安"],   // 2026-11-23 から
  ["過去の同じ週の前後", "過去の同じ週の前後(マイナス=前有利)", "過去の同じ週の前後の目安"],
  ["前の開催日の内外", "前の開催日の内外", "前の開催日の内外の目安"],
  ["前の開催日の前後", "前の開催日の前後", "前の開催日の前後の目安"]];
const PACE = [  // 展開の数字: [表示名, 値の列, 目安の列, 値の書き方]
  ["逃げ馬の数", "レースの逃げ馬の数", "逃げ馬の数の目安", v => `${Math.round(v)}頭`],
  ["逃げ・先行馬の数", "レースの逃げ・先行馬の数", "逃げ・先行馬の数の目安", v => `${Math.round(v)}頭`],
  ["ペース予想", "ペース予想(前に行く3頭の前半の速さ)", "ペース予想の目安",
   v => `前に行く3頭のテン: コースの基準より ${Math.abs(v).toFixed(1)}% ${v >= 0 ? "速い" : "遅い"}`]];
const state = { races: new Map(), combos: new Map(), plans: new Map(), odds: new Map(), oddsKind: new Map(), calc: {},
  info: new Map(), results: new Map(), pays: new Map(), review: new Map(), fileUpdated: new Map(), fileTime: new Map(),
  band: null, strength: null, current: null, dayPage: null, open: new Set(),
  loaded: new Map() };   // Drive から読んだ CSV: パス → 更新日時|サイズ(次の更新で変わったものだけ読むため)

// 読んだデータを空にする(見ているレースと開いている行はそのまま)
function clearData() {
  for (const k of ["races", "combos", "plans", "odds", "oddsKind", "info", "results", "pays", "review", "fileUpdated", "fileTime", "loaded"]) state[k].clear();
  state.band = null; state.strength = null;
}

// ---------- CSV ----------
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const num = v => (v === "" || v == null || isNaN(+v)) ? null : +v;
const pct = (v, d = 1) => v == null ? "" : (v * 100).toFixed(d) + "%";
const fix = (v, d = 1) => v == null ? "" : (+v).toFixed(d);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const raceKey = rid => rid;  // race_id(16桁)そのもの

// CSV の更新時刻(Drive なら modifiedTime、手元のファイルなら lastModified)を種類 × レースごとに持つ。各欄の見出しに出す
function noteFileTime(kind, rid, stamp) {
  const k = kind + ":" + rid, prev = state.fileTime.get(k);
  if (!prev || new Date(stamp) > new Date(prev)) state.fileTime.set(k, stamp);
}
function fmtStamp(stamp, withDate = false) {
  if (!stamp) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("ja-JP", {timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(new Date(stamp)).map(x => [x.type, x.value]));
  return (withDate ? `${p.month}/${p.day} ` : "") + `${p.hour}:${p.minute}`;
}
function updTag(kinds, rids) {
  // 欄の見出しに付ける「更新 HH:MM」。kinds の CSV のうち一番新しい時刻(rids が複数ならその中の一番新しいもの)。日付が今日でなければ月日も
  let best = "";
  for (const rid of [].concat(rids)) for (const k of [].concat(kinds)) {
    const jyo = JYO[String(rid).slice(8, 10)];   // race_id の列が無い CSV(組み合わせ)は 年月日_場名_R数2桁R で持つ
    const t = state.fileTime.get(k + ":" + rid) ?? (jyo ? state.fileTime.get(`${k}:${rid.slice(0, 8)}_${jyo}_${rid.slice(14, 16)}R`) : null);
    if (t && (!best || new Date(t) > new Date(best))) best = t;
  }
  if (!best) return "";
  const today = fmtStamp(new Date().toISOString(), true).split(" ")[0], d = fmtStamp(best, true);
  return `<span class="sec-upd" title="この欄の CSV(${[].concat(kinds).join("・")})の更新時刻">更新 ${esc(d.startsWith(today + " ") ? d.split(" ")[1] : d)}</span>`;
}

async function readFile(file, path, modifiedTime) {
  const rows = parseCSV(await file.text());
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const name = (path || file.webkitRelativePath || file.name).replace(/\\/g, "/");
  const raceFolder = name.match(/(?:^|\/)([^/]+_\d{2}R)\/[^/]*_(\d{8})_[^/]+$/);
  const stamp = modifiedTime || (file.lastModified ? new Date(file.lastModified).toISOString() : "");
  const kindName = (name.split("/").pop().match(/^([^_]+)_/) || [])[1];   // 予想・推奨買い目・オッズ・組み合わせ・結果・払戻・回顧
  if (stamp && kindName && rows[0].race_id) noteFileTime(kindName, String(rows[0].race_id), stamp);
  else if (stamp && kindName && raceFolder) noteFileTime(kindName, raceFolder[2] + "_" + raceFolder[1], stamp);   // 組み合わせ(race_id の列が無い)
  if (raceFolder) {
    if (stamp) {
      const folderKey = raceFolder[2] + "_" + raceFolder[1];   // 日付も入れる(同じ場・R が別の日にもあるため)
      const prev = state.fileUpdated.get(folderKey);
      if (!prev || new Date(stamp) > new Date(prev)) state.fileUpdated.set(folderKey, stamp);
    }
  }
  if (cols.includes("時計_例年同開催") && cols.includes("芝ダ")) {   // 時計の比べ.csv(V3。2026-11-28)
    const day = (name.match(/(\d{8})\/[^/]+$/) || [])[1];
    if (!day) return 0;
    state.clockCmp = state.clockCmp || new Map();
    state.clockCmp.set(day, rows);
    return 1;
  }
  if (cols.includes("含水率_例年同開催") && cols.includes("芝ダ")) {   // 馬場の比べ.csv(V2。2026-11-28)
    const day = (name.match(/(\d{8})\/[^/]+$/) || [])[1];
    if (!day) return 0;
    state.babaCmp = state.babaCmp || new Map();
    state.babaCmp.set(day, rows);
    return 1;
  }
  if (cols.includes("区分") && cols.includes("コード") && cols.includes("3年")) {   // 人のレーティング.csv(騎手・調教師・馬主。2026-11-28)
    const day = (name.match(/(\d{8})\/[^/]+$/) || [])[1];
    if (!day) return 0;
    state.people = state.people || new Map();
    state.people.set(day, rows);
    return 1;
  }
  if (cols.includes("開催日目") && cols.includes("内外") && cols.includes("jyo_cd")) {   // 馬場傾向の推移.csv(この開催の日ごとの実績。11/23)
    const day = (name.match(/(\d{8})\/[^/]+$/) || [])[1];
    if (!day) return 0;
    state.blockBias = state.blockBias || new Map();
    state.blockBias.set(day, rows);
    return 1;
  }
  if (cols.includes("race_id") && cols.includes("秒差_下") && cols.includes("秒差_上")) {   // タイム_….csv(U69 の走破タイムの予想と幅。2026-11-28)
    const pre = /(^|\/)タイム前_/.test(name);   // 馬体重が出る前の版(タイム前_….csv)
    if (pre) { state.timesPre = state.timesPre || new Map(); }
    else state.times = state.times || new Map();
    (pre ? state.timesPre : state.times).set(rows[0].race_id, new Map(rows.map(r => [String(+r.umaban), { s: num(r["予想秒差"]), lo: num(r["秒差_下"]), hi: num(r["秒差_上"]),
      t: num(r["予想タイム"]), tl: num(r["タイム_下"]), th: num(r["タイム_上"]) }])));
    return 1;
  }
  if (cols.includes("race_id") && cols.includes("平均_勝率")) {
    const rid = rows[0].race_id;
    if (rows.some(r => r.race_id !== rid)) return 0;   // 複数のレースが入った CSV(昔の形)は読まない
    state.races.set(rid, rows);
    return 1;
  }
  if (cols.includes("race_id") && cols.includes("レースの状態")) {      // レース情報.csv(行はレース)
    for (const r of rows) state.info.set(r.race_id, r);
    return 1;
  }
  if (cols.includes("race_id") && cols.includes("着順") && cols.includes("走破タイム")) {   // 結果
    state.results.set(rows[0].race_id, rows);
    return 1;
  }
  if (cols.includes("race_id") && cols.includes("ペース") && cols.includes("ラップ")) {      // 回顧(ラップと基準)
    state.review.set(rows[0].race_id, rows[0]);
    return 1;
  }
  if (cols.includes("race_id") && cols.includes("払戻金") && cols.includes("券種")) {      // 払戻
    state.pays.set(rows[0].race_id, rows);
    return 1;
  }
  if (cols.includes("券種") && cols.includes("組") && cols.includes("オッズ") && cols.includes("race_id")) {
    // 全券種・全組のオッズ(オッズ フォルダ)
    const m = new Map(rows.map(r => [ticketKey(r["券種"], String(r["組"]).split("-")), num(r["オッズ"])]));
    state.odds.set(rows[0].race_id, m);
    state.oddsKind.set(rows[0].race_id, rows[0]["オッズの種類"] || "");
    return 1;
  }
  if (cols.includes("予算") && cols.includes("買い目") && cols.includes("race_id")) {
    state.plans.set(rows[0].race_id, rows);
    return 1;
  }
  if (cols.includes("券種") && cols.includes("組番")) {
    state.combos.set(name.split("/").pop(), rows);
    return 1;
  }
  // 自信の区分ごとの回収率.csv。昔の形の「自信_モデル別.csv」(レースごとの行で race_id があり、回収率の列が無い)は読まない
  if (cols.includes("自信の区分") && cols.includes("モデル") && !cols.includes("race_id") && cols.some(c => c.endsWith("_回収率"))) {
    state.band = rows; return 1;
  }
  // モデルの得意・苦手.csv(検証期間の予想を条件で分けた表。回収率のモーダルに出す)
  if (cols.includes("種類") && cols.includes("他の4本との差") && cols.includes("モデル")) {
    state.strength = rows; return 1;
  }
  return 0;
}

// 読むフォルダ: 日付のフォルダと、その中の R ごとのフォルダ(場名_R数2桁、例: 東京_06R)だけ(bk などは読まない)。
// 昔の形の CSV の置き場(オッズ・組み合わせ…)も読む
const SUBDIRS = new Set(["オッズ", "組み合わせ", "推奨買い目", "結果", "払戻", "回顧"]);
const wantDir = name => /^\d{8}$/.test(name) || /^.+_\d{2}R$/.test(name) || SUBDIRS.has(name);
async function walk(entry, out, path = "", top = true) {
  if (entry.isFile) {
    if (entry.name.toLowerCase().endsWith(".csv")) out.push(await new Promise((res, rej) => entry.file(f => res([f, path + entry.name]), rej)));
  } else if (entry.isDirectory) {
    if (!top && !wantDir(entry.name)) return;
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await walk(e, out, path + entry.name + "/", false);
    } while (batch.length);
  }
}

async function loadFiles(list, keepView = false) {
  let n = 0;
  for (const item of list) {
    const [f, p, modifiedTime] = Array.isArray(item) ? item : [item, null, null];
    if (f.name.toLowerCase().endsWith(".csv")) n += await readFile(f, p, modifiedTime);
  }
  if (!n && !state.races.size && !state.band) {
    document.getElementById("status").textContent = "レースデータがありません。";
  }
  if (state.races.size || state.band) {
    document.getElementById("drop").hidden = true;
    document.getElementById("app").hidden = false;
    if (!state.current) {   // 再読み込みの前に見ていたレースと日別ページ(日別ページを見ていたら、その日の日別ページに戻る)
      try {
        state.current = sessionStorage.getItem("keiba-viewer:current");
        const day = sessionStorage.getItem("keiba-viewer:dayPage");
        if (day && !state.dayPage && sortedRaces().some(rid => rid.slice(0, 8) === day)) state.dayPage = day;
      } catch (e) {}
    }
    if (!state.races.has(state.current)) state.current = sortedRaces()[0] || null;
    if (keepView && document.activeElement?.matches("input, textarea")) return;   // 入力中は書き換えない(次の回に)
    keepView ? render(false) : render();
  }
}
window.loadFiles = loadFiles;

// ---------- Drive取得ページから受け取ったCSV ----------
// index.html がGoogle認証・Drive取得を行い、IndexedDB経由でCSVを引き渡す。
function openDriveTransferDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("predictions-drive-transfer", 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("payload")) req.result.createObjectStore("payload"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("この端末への保存の読み書きが中断されました。もう一度お試しください。"));
  });
}
async function consumeDriveTransfer(keepView = false) {
  if (!window.indexedDB) return false;
  const db = await openDriveTransferDb();
  const payload = await new Promise((resolve, reject) => {
    const tx = db.transaction("payload", "readwrite");
    const store = tx.objectStore("payload");
    const req = store.get("pending");
    let value = null;
    req.onsuccess = () => {
      if (req.result) {
        // 今回Driveから取得したデータを、次回のF5用キャッシュにも保存する。
        value = req.result;
        store.put(value, "cache");
        store.delete("pending");
      } else {
        // F5などで再表示した場合は、前回保存したCSVを使う。
        const cached = store.get("cache");
        cached.onsuccess = () => { value = cached.result || null; };
        cached.onerror = () => reject(cached.error || new Error("この端末への保存の読み書きが中断されました。もう一度お試しください。"));
      }
    };
    req.onerror = () => reject(req.error || new Error("この端末への保存の読み書きが中断されました。もう一度お試しください。"));
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error("この端末への保存の読み書きが中断されました。もう一度お試しください。"));
    tx.onabort = () => reject(tx.error || new Error("この端末への保存の読み書きが中断されました。もう一度お試しください。"));
  });
  db.close();
  if (payload?.bundles?.length) {
    document.getElementById("status").textContent = "データを読み込み中…";
    payload.files = await expandBundles(payload.bundles);
  }
  if (!payload?.files?.length) return false;
  document.getElementById("status").textContent = "データを読み込み中…";
  // 取得データは Drive の保存分すべて(変わらなかった分も入る)。表示中の更新(keepView)なら、前回読んだものと比べて
  // 新しく増えた・中身が変わった CSV だけを読む(CSV 1つが表の1か所を丸ごと持つので、読み直せば置き換わる)。
  // 前回あった CSV が消えていたら、消えた分を表から外すために全部を読み直す。
  const pathOf = item => item.path || item.name;
  const sigOf = item => (item.generation || "") + "|" + (item.modifiedTime || "") + "|" + (item.size ?? item.blob?.size ?? "");
  const now = new Map(payload.files.map(item => [pathOf(item), sigOf(item)]));
  let items = payload.files;
  if (keepView && state.loaded.size) {
    const removed = [...state.loaded.keys()].some(k => !now.has(k));
    if (removed) clearData();
    else items = payload.files.filter(item => state.loaded.get(pathOf(item)) !== sigOf(item));
  } else {
    clearData();
  }
  state.lastLoad = { read: items.length, total: payload.files.length };
  const files = items.map(item => [new File([item.blob], item.name, {type:"text/csv"}), item.path, item.modifiedTime]);
  await loadFiles(files, keepView);
  state.loaded = now;
  updateRaceStatus();
  return true;
}
// 1日分のまとめファイル(gzip の JSON。index.html が Drive から取る。2026-11-15 から)を、CSV 1件ずつの形に戻す。
// 形は {date, kind, files: [{p: 日付のフォルダからのパス, t: CSV の更新時刻, c: CSV の中身}]}
async function expandBundles(bundles) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("このブラウザは圧縮したデータを戻せません。iPhone は iOS 16.4 以降、または新しいブラウザでお試しください。");
  }
  const out = [], versions = new Map();
  for (const b of bundles) {
    if (!b.blob && !b.b64) continue;   // 中身の無い分(前の版のキャッシュ)は飛ばす
    const text = await new Response((b.blob || new Blob([Uint8Array.from(atob(b.b64), ch => ch.charCodeAt(0))])).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    const data = JSON.parse(text);
    const date = data.date || b.date;
    if (!date || (b.date && data.date && data.date !== b.date) || (b.kind && data.kind && b.kind !== data.kind)) throw new Error("まとめファイルの日付・種類が一致しません。");
    const entries = versions.get(date) || new Map();
    const kind = data.kind || b.kind;
    if (entries.has(kind)) throw new Error("まとめファイルの種類が重複しています。");
    entries.set(kind, data.generation || null); versions.set(date, entries);
    for (const f of data.files || []) {
      out.push({ name: f.p.split("/").pop(), path: "predictions/" + date + "/" + f.p, modifiedTime: f.t, generation: data.generation || "", size: f.c.length,
        blob: new Blob([f.c], { type: "text/csv" }) });
    }
  }
  for (const entries of versions.values()) {
    if ([...entries.values()].some(Boolean)) {
      const main = entries.get('main'), odds = entries.get('odds');
      if (!/^[0-9a-f]{64}$/.test(main || '') || main !== odds) throw new Error("予想とオッズの更新がまだ揃っていません。少し待って再取得してください。");
    }
  }
  return out;
}
async function clearDriveTransferCache() {
  if (!window.indexedDB) return;
  const db = await openDriveTransferDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("payload", "readwrite");
    const store = tx.objectStore("payload");
    store.delete("pending");
    store.delete("cache");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("この端末への保存の読み書きが中断されました。もう一度お試しください。"));
    tx.onabort = () => reject(tx.error || new Error("この端末への保存の読み書きが中断されました。もう一度お試しください。"));
  });
  db.close();
}


// ---------- 画面 ----------
const PRE = "枠順時_";     // 枠順確定の時点の値を持ち越した列の頭。モデルの列として数えない
function models(rows) {
  return Object.keys(rows[0]).filter(c => c.endsWith("_勝率") && !c.startsWith("平均") && !c.startsWith(PRE)).map(c => c.slice(0, -3));
}
function sortedRaces() {
  return [...state.races.keys()].sort((a, b) => {
    const ra = state.races.get(a)[0], rb = state.races.get(b)[0];
    const t = r => String(r.hasso_time || "9999").padStart(4, "0");     // 9:45 は "945" なので4桁にそろえて比べる
    return (a.slice(0, 8) + t(ra) + a.slice(8)).localeCompare(b.slice(0, 8) + t(rb) + b.slice(8));
  });
}
// レースの概要(芝ダ・距離・回り・レース名・グレード・馬場)と状態。レース情報.csv が無ければ出さない
const STATUS_TONE = { "結果確定後": "gray", "馬体重発表後": "up", "枠順確定(馬体重未発表)": "", "枠順確定前": "warn", "特別登録発表後": "warn" };
// 当日の馬場傾向が予想に入っているか(2026-11-23 ユーザーの指示「馬体重確定後みたいにわかる表示を追加」)。予想 CSV の「今日のレース数」
// (同じ日・同じ競馬場・同じ芝ダで、このレースより前に結果の出たレースの数)。列が無い昔の CSV では出さない
function j2Chip(rid) {
  const r0 = state.races.get(rid)?.[0];
  if (!r0 || !("今日のレース数" in r0)) return "";
  const n = num(r0["今日のレース数"]);
  return n ? `<span class="chip up" title="当日の馬場傾向(このレースより前の同じ競馬場・芝ダの ${n}レースの結果)を予想に入れている。発走15分前に計算し直す">当日の馬場傾向 反映済(${n}R)</span>`
    : `<span class="chip gray" title="この競馬場・芝ダで、このレースより前に結果の出たレースがまだ無いので、当日の馬場傾向は入っていない">当日の馬場傾向 まだ無し</span>`;
}
function overview(rid) {
  const i = state.info.get(rid);
  if (!i) return "";
  const stage = state.races.get(rid)?.[0]?.["予想の段階"];   // 枠順確定の版か、馬体重を入れた版か
  const course = [i["芝ダ"], i["距離"] ? `${i["距離"]}m` : "", i["回り"] ? `(${i["回り"]})` : ""].join("");
  const venueName = JYO[rid.slice(8, 10)];
  const folderKey = venueName ? `${rid.slice(0, 8)}_${venueName}_${rid.slice(14, 16)}R` : "";
  const updated = state.fileUpdated.get(folderKey);
  const updatedText = updated ? new Intl.DateTimeFormat("ja-JP", {timeZone:"Asia/Tokyo", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23"}).format(new Date(updated)).replace(/年|月/g, "/").replace("日", "") : "";
  return `<div class="overview"><b>${esc(course)}</b><span class="rname">${esc(i["レース名"] || "")}</span>` +
    (i["グレード"] ? `<span class="chip grade">${esc(i["グレード"])}</span>` : "") +
    (i["馬場状態"] ? `<span class="muted">馬場 ${esc(i["馬場状態"])}</span>` : "") +
    (stage ? `<span class="chip ${stage === "馬体重あり" ? "up" : "warn"}" title="予想 CSV の段階。枠順確定の版は馬体重・当日の馬場の計測値を入れる前の予想で、馬体重が出ると作り直す">予想: ${esc(stage)}</span>` : "") +
    `<span class="chip ${STATUS_TONE[i["レースの状態"]] ?? ""}" title="DB にあるデータから決めた状態">${esc(i["レースの状態"] || "")}</span>` +
    j2Chip(rid) +
    (updatedText ? `<span class="data-updated">データ更新：${esc(updatedText)}</span>` : "") + `</div>`;
}

// ---------- レース回顧(結果のあるレースだけ。表示だけで、モデルへのフィードバックはしない) ----------
const lastPos = r => { const v = String(r["通過"] || "").split("-").filter(Boolean); return v.length ? +v[v.length - 1] : null; };
const sec = v => v == null ? "" : `${Math.floor(v / 60) ? Math.floor(v / 60) + ":" + (v % 60).toFixed(1).padStart(4, "0") : v.toFixed(1)}`;
const diffTxt = (v, base, unit = "秒") => v == null || base == null ? "" :
  `<span class="${v - base < 0 ? "up" : v - base > 0 ? "down" : ""}">${v - base >= 0 ? "+" : ""}${(v - base).toFixed(1)}${unit}</span>`;
// 基準の並び: 同じコースの過去3年の平均(全体)と、同じクラス・同じ馬場状態・その両方に絞った平均。かっこ内は今回 − 基準とレース数。
// 5レース未満の基準は少ないので薄く出す(参考)
const BASE_KINDS = [["全体", "基準"], ["クラス", "クラス"], ["馬場", "馬場"], ["馬場クラス", "馬場&クラス"]];
// 速い・遅いの判定: いちばん条件の近い基準(馬場&クラス → クラス → 馬場 → 全体の順に、10レース以上あるもの)と比べ、
// 「今回 − 平均」がいつものばらつき(標準偏差)の何倍かで5段階にする(±0.4倍で「やや」、±1.0倍を超えると「速い・遅い」。
// ふつうのレースの3分の2が ±1.0倍に入る)。乖離率(今回 − 平均)÷ 平均 も一緒に出す
function judgeChip(rv, item, v) {
  if (v == null) return "";
  const k = ["馬場クラス", "クラス", "馬場", "全体"].find(k => (num(rv[`基準_${item}_${k}_数`]) ?? 0) >= 10 && num(rv[`基準_${item}_${k}_ばらつき`]) > 0);
  if (!k) return "";
  const m = num(rv[`基準_${item}_${k}`]), sd = num(rv[`基準_${item}_${k}_ばらつき`]), n = num(rv[`基準_${item}_${k}_数`]);
  const z = (v - m) / sd, rate = (v - m) / m * 100;
  const [word, tone] = z <= -1.0 ? ["速い", "up"] : z <= -0.4 ? ["やや速い", "up"] : z >= 1.0 ? ["遅い", "down"] : z >= 0.4 ? ["やや遅い", "warn"] : ["普通", "gray"];
  const label = BASE_KINDS.find(([kk]) => kk === k)[1];
  return ` <span class="chip ${tone}" title="${esc(`${label}の基準(${n} レース)の平均 ${m.toFixed(2)}・ばらつき ${sd.toFixed(2)} と比べた判定`)}">${word}</span>` +
    `<span class="muted"> 乖離率 ${rate >= 0 ? "+" : ""}${rate.toFixed(1)}%・ばらつきの ${z >= 0 ? "+" : ""}${z.toFixed(1)}倍(${label}と比べて)</span>`;
}
function baseList(rv, item, v, fmt) {
  const parts = BASE_KINDS.map(([k, label]) => {
    const b = num(rv[`基準_${item}_${k}`]), n = num(rv[`基準_${item}_${k}_数`]) ?? 0;
    if (b == null) return `<span class="dim">${label} -</span>`;
    const d = Math.round((v - b) * 10) / 10;   // 表示と同じ 0.1秒で丸めてから色を決める(+0.0 を赤にしない)
    return `<span class="${n < 5 ? "dim" : ""}" title="${label}の基準: 同じコースの過去3年 ${n} レースの平均${n < 5 ? "(少ないので参考)" : ""}">` +
      `${label} ${fmt(b)}(<span class="${n < 5 ? "" : d < 0 ? "up" : d > 0 ? "down" : ""}">${d >= 0 ? "+" : ""}${d.toFixed(1)}</span>・${n})</span>`;
  });
  return `<div class="bases">${parts.join("")}</div>`;
}
// 予想ラップ: コースのいつものラップの形(レース情報.csv の「ラップの形」= 同じ競馬場・芝ダ・距離・馬場状態の過去3年の平均)を、
// 前半1000m の予想と勝ちタイムの予想に合うように、1000m までと 1000m からで別々に伸び縮みさせたもの。
// 1000m 以下や前半1000m の予想が無いときは、勝ちタイムの予想だけで全体を合わせる。途中の形はいつもの形のまま
function lapMarks(distance, n) {
  const first = distance - 200 * (n - 1);
  return [...Array(n)].map((_, i) => first + 200 * i);
}
function predictedLaps(r0, info) {
  const prof = String(info?.["ラップの形"] || "").split(",").filter(Boolean).map(Number), dist = num(info?.["距離"]);
  if (!prof.length || !dist) return null;
  const marks = lapMarks(dist, prof.length), cum = prof.reduce((a, v) => [...a, (a.at(-1) || 0) + v], []);
  const tAt = x => { // 距離 x の通過タイム(区間の中は線形に補う)
    if (x <= marks[0]) return cum[0] * x / marks[0];
    const i = marks.findIndex(m => m >= x);
    return cum[i - 1] + (cum[i] - cum[i - 1]) * (x - marks[i - 1]) / (marks[i] - marks[i - 1]);
  };
  const total = cum.at(-1), p1000 = num(r0["前半1000mの予想"]), pwin = num(info["勝ちタイムの予想"]);
  let a, b;
  if (dist > 1000 && p1000 != null) {
    const t1 = tAt(1000);
    a = p1000 / t1;
    b = pwin != null ? (pwin - p1000) / (total - t1) : a;
  } else if (pwin != null) a = b = pwin / total;
  else return null;
  const t1 = dist > 1000 ? tAt(1000) : total;
  const newCum = marks.map((m, i) => m <= 1000 ? a * cum[i] : a * t1 + b * (cum[i] - t1));
  const laps = newCum.map((v, i) => v - (i ? newCum[i - 1] : 0));
  // 確度: 前半1000m と勝ちタイムの確度の低い方。ラップの形が馬場状態を問わない平均なら一段下げる
  const order = { "高": 2, "中": 1, "低": 0 }, word = ["低", "中", "高"];
  const cs = [r0["前半1000mの確度"], info["勝ちタイムの確度"]].filter(c => c in order);
  let lv = cs.length ? Math.min(...cs.map(c => order[c])) : 0;
  if (info["ラップの形の馬場状態"] !== "馬場状態ごと") lv = Math.max(0, lv - 1);
  const why = `ラップの形: 同じコースの過去3年 ${Math.round(num(info["ラップの形のレース数"]) || 0)} レースの平均(${info["ラップの形の馬場状態"]})。` +
    `前半1000m の予想 ${p1000 != null && dist > 1000 ? p1000.toFixed(1) + "(確度 " + (r0["前半1000mの確度"] || "-") + ")" : "なし"}・` +
    `勝ちタイムの予想 ${pwin != null ? clock(pwin) + "(確度 " + (info["勝ちタイムの確度"] || "-") + ")" : "なし"} に合わせた`;
  return { laps, marks, avg: prof, conf: word[lv], why };
}
// ラップの折れ線グラフ(ラップ推移)。横は距離(200m ごと)、縦は秒で速い方が上。実際は実線、予想ラップは点線、
// いつものラップ(同じコースの過去3年の平均)は薄い線。最初の区間が200mより短い距離は、比べられるように200m あたりに直して描く
// (数字は実際の値のまま)。前半3F の終わりと後半3F の始まりに縦の線。pred があれば下に「実際 − 予想」を出す
function lapSeries(laps, marks) {
  const first = marks[0];
  return laps.map((v, i) => i === 0 && first < 200 ? v * 200 / first : v);
}
function lapLine(opts) {
  const { marks, series } = opts;           // series: [{laps, cls, label, dash, dots, labels}]
  const n = marks.length, dist = marks.at(-1), w = Math.max(30, Math.min(44, 560 / n)), left = 34, top = 18, h = 110;
  const width = left + n * w + 10;
  const all = series.flatMap(sr => lapSeries(sr.laps, marks));
  let lo = Math.floor((Math.min(...all) - 0.2) * 2) / 2, hi = Math.ceil((Math.max(...all) + 0.2) * 2) / 2;
  if (hi - lo < 1.5) hi = lo + 1.5;
  const y = v => top + (v - lo) / (hi - lo) * h;           // 速い(小さい)ほど上
  const x = i => left + i * w + w / 2;
  let g = "";
  for (let t = Math.ceil(lo * 2) / 2; t <= hi + 1e-9; t += 0.5) {   // 縦の目盛り(0.5秒ごと)
    g += `<line x1="${left}" x2="${width - 6}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-width="1"></line>` +
      `<text x="${left - 4}" y="${y(t) + 3}" font-size="9" text-anchor="end" fill="var(--muted)">${t.toFixed(1)}</text>`;
  }
  // 前半3F の終わり(600m)と後半3F の始まり(残り600m)
  const xs = [];
  for (const [m, label] of [[600, "前半3F"], [dist - 600, "後半3F"]]) {
    const i = marks.findIndex(v => v >= m);
    if (i < 0 || i >= n) continue;
    const xx = label === "前半3F" ? x(i) + w / 2 : x(i) - w / 2;
    const near = xs.some(v => Math.abs(v - xx) < 70);      // 短い距離で2本の線が近いときは、後半3F の字をグラフの下の方に出す
    xs.push(xx);
    g += `<line x1="${xx}" x2="${xx}" y1="${top - 6}" y2="${top + h}" stroke="var(--muted)" stroke-dasharray="2 3" opacity="0.6"></line>` +
      `<text x="${label === "前半3F" ? xx - 3 : xx + 3}" y="${near ? top + h - 4 : top - 8}" font-size="9" text-anchor="${label === "前半3F" ? "end" : "start"}" fill="var(--muted)">${label}</text>`;
  }
  marks.forEach((m, i) => { g += `<text x="${x(i)}" y="${top + h + 12}" font-size="9" text-anchor="middle" fill="var(--muted)">${m}</text>`; });
  for (const sr of series) {
    const v = lapSeries(sr.laps, marks);
    g += `<polyline points="${v.map((vv, i) => `${x(i)},${y(vv)}`).join(" ")}" fill="none" stroke="${sr.color}" stroke-width="${sr.width || 2}"` +
      `${sr.dash ? ` stroke-dasharray="${sr.dash}"` : ""} opacity="${sr.opacity || 1}"></polyline>`;
    if (sr.dots) g += v.map((vv, i) => `<circle cx="${x(i)}" cy="${y(vv)}" r="${sr.dots}" fill="${sr.color}"><title>${sr.label} ${sr.laps[i].toFixed(1)}</title></circle>`).join("");
    if (sr.labels) g += v.map((vv, i) => `<text x="${x(i)}" y="${y(vv) - 6}" font-size="10" text-anchor="middle" fill="var(--text)">${sr.laps[i].toFixed(1)}</text>`).join("");
  }
  let extra = 0;
  if (opts.diff) {
    g += opts.diff.map((d, i) => { const r = Math.round(d * 10) / 10;
      return `<text x="${x(i)}" y="${top + h + 26}" font-size="10" text-anchor="middle" fill="${r < 0 ? "var(--up)" : r > 0 ? "var(--down)" : "var(--muted)"}">${r > 0 ? "+" : ""}${r.toFixed(1)}</text>`; }).join("") +
      `<text x="${left - 4}" y="${top + h + 26}" font-size="9" text-anchor="end" fill="var(--muted)">差</text>`;
    extra = 16;
  }
  const H = top + h + 18 + extra;
  return `<svg class="laps" viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" role="img" aria-label="ラップ推移">${g}</svg>`;
}
// 「いつも」の線に使う基準(全体・クラス・馬場・馬場&クラス)。選んだものはこのブラウザに覚えておく。
// 選んでいないとき・選んだものが0レースのときは、馬場&クラス → クラス → 馬場 → 全体 の順に10レース以上あるものを使う。
// 1レースから選べるが、5レース未満は少ないので注意の文を出す
function lapBase(info) {
  if (!info) return null;
  const n = k => num(info[`ラップの形_${k}_数`]) ?? 0;
  let k = null;
  try { k = localStorage.getItem("keiba-viewer:lap-base"); } catch (e) { k = state.lapBase; }
  if (!k || n(k) < 1 || !info[`ラップの形_${k}`]) k = ["馬場クラス", "クラス", "馬場", "全体"].find(x => n(x) >= 10) || null;
  if (!k) return null;
  return { k, laps: String(info[`ラップの形_${k}`]).split(",").filter(Boolean).map(Number), n: n(k) };
}
function lapBaseTabs(info) {
  if (!info || !info["ラップの形_全体"]) return "";
  const base = lapBase(info), cur = base?.k;
  return `<div class="tabs lapbase" style="margin:4px 0">` + BASE_KINDS.map(([k, l]) => {
    const label = k === "全体" ? "全体" : l;
    const n = num(info[`ラップの形_${k}_数`]) ?? 0;
    return `<button data-k="${k}" class="${k === cur ? "on" : ""}" ${n < 1 || !info[`ラップの形_${k}`] ? "disabled" : ""} title="${label}: 同じコースの過去3年 ${n} レースの平均ラップ">${label} ${n}</button>`;
  }).join("") + `<span class="muted" style="font-size:12px;margin-left:6px">灰色の線(いつも)に使う基準</span></div>` +
    (base && base.n < 5 ? `<div class="muted" style="font-size:12px;margin:0 0 4px">基準が ${base.n} レースしかないので、平均は少ないレースの展開に左右されます。参考程度に見てください。</div>` : "");
}
function setupLapBase(root) {
  root.querySelectorAll(".lapbase button").forEach(b => b.onclick = e => {
    e.stopPropagation();
    state.lapBase = b.dataset.k;
    try { localStorage.setItem("keiba-viewer:lap-base", b.dataset.k); } catch (err) {}
    render(false);
  });
}
function lapText(laps, f3, l3) {
  // 数字の並び「12.5-11.2-…」と、前半3F-後半3F
  return `<div class="laptext"><b>${laps.map(v => v.toFixed(1)).join("-")}</b>` +
    (f3 != null && l3 != null ? `<span class="muted">(前半3F-後半3F ${f3.toFixed(1)}-${l3.toFixed(1)})</span>` : "") + `</div>`;
}
function lapChart(laps, pred, marks, avg, base) {
  if (!laps.length) return "";
  const ok = a => a && a.length === laps.length;
  const series = [];
  if (ok(avg)) series.push({ laps: avg, color: "var(--muted)", width: 1.5, opacity: 0.6, label: "いつも" });
  if (ok(pred)) series.push({ laps: pred, color: "var(--warn)", dash: "4 3", dots: 2.5, label: "予想" });
  series.push({ laps, color: "var(--accent)", width: 2.5, dots: 3, labels: true, label: "実際" });
  const legend = `<div class="note" style="margin:0"><span style="color:var(--accent)">━ 実際</span>` +
    (ok(pred) ? `　<span style="color:var(--warn)">┅ 予想ラップ</span>` : "") +
    (ok(avg) ? `　<span class="muted">━ いつも(同じコースの過去3年の${base ? (base.k === "全体" ? "全体" : BASE_KINDS.find(([k]) => k === base.k)[1]) + "で " + base.n + " レースの" : ""}平均)</span>` : "") +
    `。縦は1ハロン(200m)の秒で、上ほど速い。${ok(pred) ? "下の「差」は 実際 − 予想(マイナスの緑は予想より速い)。" : ""}` +
    `${marks[0] < 200 ? `最初の ${marks[0]}m は200m あたりに直して描いている。` : ""}</div>`;
  return lapLine({ marks, series, diff: ok(pred) ? laps.map((v, i) => v - pred[i]) : null }) + legend;
}
function predLapChart(laps, marks, avg) {
  const series = [];
  if (avg && avg.length === laps.length) series.push({ laps: avg, color: "var(--muted)", width: 1.5, opacity: 0.6, label: "いつも" });
  series.push({ laps, color: "var(--warn)", dash: "4 3", dots: 2.5, labels: true, label: "予想" });
  return lapLine({ marks, series });
}
function predLapRow(r0, info) {
  const p = predictedLaps(r0, info);
  if (!p) return "";
  const lb = lapBase(info);
  return `<div class="pace"><div class="pl">予想ラップ</div><div>${lapText(p.laps)}${lapBaseTabs(info)}<div class="scroll">${predLapChart(p.laps, p.marks, lb?.laps ?? p.avg)}</div>` +
    confPie(p.conf, null, p.why) + `<div class="note" style="margin:0">${esc(p.why)}。途中の形はそのコースのいつもの形のまま</div></div></div>`;
}
function lapGap(laps, pred, marks) {
  // ラップのずれ: ハロンごとの 実際 − 予想 の絶対値の平均(最初の短い区間は除く)と、いちばんずれた区間
  if (!pred || pred.length !== laps.length || laps.length < 3) return "";
  const d = laps.map((v, i) => v - pred[i]).slice(1), mae = d.reduce((a, v) => a + Math.abs(v), 0) / d.length;
  const k = d.reduce((m, v, i) => Math.abs(v) > Math.abs(d[m]) ? i : m, 0) + 1;
  const word = mae <= 0.2 ? "ほぼ予想どおり" : mae <= 0.4 ? "ややずれた" : "大きくずれた";
  const tone = mae <= 0.2 ? "up" : mae <= 0.4 ? "warn" : "down";
  const from = k ? marks[k - 1] : 0, dk = laps[k] - pred[k];
  return `<dt>ラップのずれ</dt><dd><span class="chip ${tone}">${word}</span> 1ハロンあたり平均 <b>${mae.toFixed(2)}秒</b>` +
    `<span class="muted">(いちばんずれたのは ${from}〜${marks[k]}m の ${dk > 0 ? "+" : ""}${dk.toFixed(1)}秒。` +
    `平均のずれが 0.2秒以内なら「ほぼ予想どおり」、0.4秒を超えると「大きく」)</span></dd>`;
}
// ---------- 枠順確定 → 馬体重の変化 ----------
// raceday が馬体重の版を作るときに、枠順確定の時点の値を 枠順時_順位・枠順時_勝率・枠順時_自信の段階・枠順時_混戦の段階 の列で持ち越す
const hasPre = rows => rows.some(r => num(r["枠順時_順位"]) != null);
const preCol = c => c === "平均_順位" ? "枠順時_順位" : c === "平均_勝率" ? "枠順時_勝率" : PRE + c;
const curCol = c => c === "枠順時_順位" ? "平均_順位" : c === "枠順時_勝率" ? "平均_勝率" : c.slice(PRE.length);
const decimals = v => (String(v).split(".")[1] || "").length;
function valueMove(b, a, digits = 1, lower = false) {
  if (a == null || b == null) return "";
  const d = b - a;
  if (Math.abs(d) < 0.5 * 10 ** -digits) return "";
  return `<span class="chg ${(d > 0) !== lower ? "up" : "down"}">${d > 0 ? "+" : ""}${d.toFixed(digits)}</span>`;
}
// 数字の変化の印。lower は小さいほど良い列(オッズ・着順・タイム)。枠順時_ の列が無ければ何も出さない
function colMove(r, col, digits = 1, lower = false) {
  return changeView() ? valueMove(num(r[col]), num(r[preCol(col)]), digits, lower) : "";
}
// 馬の詳細の中の、枠順確定の時点と値が違う項目の一覧
function preDiffList(r) {
  const rows = Object.keys(r).filter(c => c.startsWith(PRE) && curCol(c) in r && r[c] !== "" && r[curCol(c)] !== "" && r[c] !== r[curCol(c)]).map(c => {
    const a = r[c], b = r[curCol(c)], x = num(a), y = num(b);
    if (x != null && x === y) return "";
    const d = x != null && y != null ? Math.max(decimals(a), decimals(b)) : null;
    return `<tr><td>${esc(curCol(c))}</td><td class="n">${esc(a)}</td><td class="n">${esc(b)}</td><td class="n">${d == null ? "" : `${y > x ? "+" : ""}${(y - x).toFixed(d)}`}</td></tr>`;
  }).filter(Boolean);
  return rows.length ? `<details style="margin-top:8px"><summary>枠順確定からの変化(${rows.length} 項目)</summary><div class="scroll"><table>` +
    `<tr><th>項目</th><th class="n">枠順確定</th><th class="n">今</th><th class="n">差</th></tr>${rows.join("")}</table></div></details>` : "";
}
// レースで同じ値の列のうち、枠順確定の時点と変わったもの(自信・混戦の段階は別に出す)
function preRaceRows(rows) {
  const first = rows[0];
  const same = c => rows.every(r => r[c] === first[c]);
  return Object.keys(first).filter(c => c.startsWith(PRE) && curCol(c) in first && !["枠順時_自信の段階", "枠順時_混戦の段階"].includes(c) &&
      same(c) && same(curCol(c)) && first[c] !== "" && first[curCol(c)] !== "" && first[c] !== first[curCol(c)] &&
      !(num(first[c]) != null && num(first[c]) === num(first[curCol(c)])))
    .map(c => `<dt>${esc(curCol(c))}</dt><dd>${esc(first[c])} → <b>${esc(first[curCol(c)])}</b></dd>`).join("");
}
function changeView() {
  // 出走馬の表の変化とレース一覧の印を出すか(このブラウザに覚えておく)。得意モデルだけの表示のあいだは出さない
  if (state.favActive) return false;
  try { return localStorage.getItem("keiba-viewer:change") === "1"; } catch (e) { return !!state.change; }
}
function favView() {
  // 得意モデルのみの予想を表示するか(このブラウザに覚えておく)
  try { return localStorage.getItem("keiba-viewer:fav") === "1"; } catch (e) { return !!state.fav; }
}
// そのレースが得意条件に当たるモデル(予想 CSV の「得意モデル」。当日予想のモデルにあるものだけ)
function favModels(rows) {
  const ms = new Set(models(rows));
  return String(rows[0]?.["得意モデル"] || "").split("・").filter(m => ms.has(m));
}
// 得意モデルだけの平均で、予想の項目(勝率・順位・2着内・3着内・妥当オッズ・順位の幅・1〜5着の確率・予想着順)を出し直した行。
// 作り方は予想 CSV と同じ(勝率はモデルの平均をレースの中で合計1にし、1〜5着は勝率の比で1着から順に決める抽選)
function raceFactors(rows) {
  if (!rows.length) return null;
  const get = (name) => {
    if (rows.every(r => !(name in r))) return 1;
    if (rows.some(r => !(name in r))) return null;
    const values = rows.map(r => num(r[name]));
    if (values.some(v => v == null || !Number.isFinite(v) || v <= 0)) return null;
    return values.every(v => Math.abs(v - values[0]) < 1e-12) ? values[0] : null;
  };
  const temp = get("平均の温度"), l2 = get("着順の補正_2着"), l3 = get("着順の補正_3着");
  return temp == null || l2 == null || l3 == null ? null : {temp, l2, l3};
}
function probabilityReady(rows) {
  const active = activeRows(rows), factors = raceFactors(rows);
  if (!active.length || !factors) return false;
  const values = active.map(r => num(r["平均_勝率"]));
  return values.every(v => v != null && Number.isFinite(v) && v >= 0 && v <= 1) && values.some(v => v > 0);
}
function canFavorite(rows, fav) {
  const active = activeRows(rows);
  if (!active.length || !fav.length || !raceFactors(rows) || placeCount(rows) == null) return false;
  const values = active.flatMap(r => fav.map(m => num(r[`${m}_勝率`])));
  return values.every(v => v != null && Number.isFinite(v) && v >= 0 && v <= 1) && values.some(v => v > 0);
}
function favRows(rows, fav) {
  if (!canFavorite(rows, fav)) return [];
  const active = activeRows(rows), factors = raceFactors(rows);
  const mean = (r, suf) => { const v = fav.map(m => num(r[`${m}${suf}`])).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b) / v.length : null; };
  const raw = active.map(r => Math.pow(mean(r, "_勝率"), factors.temp));
  const total = raw.reduce((a, b) => a + b, 0);
  const p = raw.map(v => v / total);
  const order = p.map((v, i) => i).sort((a, b) => p[b] - p[a]);
  const rank = new Array(p.length); order.forEach((i, k) => { rank[i] = k + 1; });
  const fin = finishDist(p, 4000, [factors.l2, factors.l3]);
  const converted = active.map((r, i) => {
    const ranks = fav.map(m => num(r[`${m}_順位`])).filter(x => x != null);
    const top2 = fin.pos[0][i] + fin.pos[1][i], top3 = top2 + fin.pos[2][i];
    const place = placeCount(rows), placeProb = place === 2 ? top2 : place === 3 ? top3 : null;
    const out = { ...r, "平均_勝率": p[i], "平均_順位": rank[i], "平均_2着内": top2, "平均_3着内": top3,
      "妥当オッズ_単勝": p[i] > 0 ? Math.round(10 / p[i]) / 10 : null,
      "妥当オッズ_複勝": placeProb > 0 ? Math.round(10 / placeProb) / 10 : null,
      "順位の幅": ranks.length ? Math.max(...ranks) - Math.min(...ranks) : null, "予想着順": fin.mean[i] };
    for (let k = 1; k <= 5; k++) out[`${k}着の確率`] = fin.pos[k - 1][i];
    return out;
  });
  const mapped = new Map(active.map((r, i) => [r, converted[i]]));
  return rows.map(r => {
    if (mapped.has(r)) return mapped.get(r);
    const cancelled = { ...r, "平均_勝率": null, "平均_順位": null, "平均_2着内": null, "平均_3着内": null,
      "妥当オッズ_単勝": null, "妥当オッズ_複勝": null, "予想着順": null };
    for (let k = 1; k <= 5; k++) cancelled[`${k}着の確率`] = null;
    return cancelled;
  });
}
// 勝率 p から、1〜5着の確率と平均の着順(勝率の比で1着から順に決める抽選を n 回。乱数は毎回同じ)
function finishDist(p, n = 4000, lam = [1, 1]) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed + 0.5) / 2147483648; };
  const pos = [0, 1, 2, 3, 4].map(() => new Array(p.length).fill(0)), sum = new Array(p.length).fill(0);
  const logp = p.map(v => Math.log(Math.max(v, 1e-12)));
  for (let t = 0; t < n; t++) {
    const used = new Set();
    for (let k = 0; k < p.length; k++) {
      const power = k === 0 ? 1 : k === 1 ? lam[0] : lam[1];
      let best = -Infinity, pick = -1;
      for (let i = 0; i < p.length; i++) {
        if (used.has(i)) continue;
        const key = power * logp[i] - Math.log(-Math.log(rnd()));
        if (key > best) { best = key; pick = i; }
      }
      if (pick < 0) break;
      used.add(pick); sum[pick] += k + 1;
      if (k < 5) pos[k][pick]++;
    }
  }
  return { pos: pos.map(a => a.map(v => v / n)), mean: sum.map(v => v / n) };
}
const honmei = (rows, col) => rows.find(r => num(r[col]) === 1);
const honmeiChanged = rows => { const a = honmei(rows, "枠順時_順位"), b = honmei(rows, "平均_順位"); return !!(a && b && +a.umaban !== +b.umaban); };
const rankMove = r => { const a = num(r["枠順時_順位"]), b = num(r["平均_順位"]); return a == null || b == null ? null : a - b; };   // プラスは順位が上がった
const moveMark = d => d == null || d === 0 ? "" : `<span class="chg ${d > 0 ? "up" : "down"}">${d > 0 ? "↑" : "↓"}${Math.abs(d)}</span>`;
function winMove(r) {
  const a = num(r["枠順時_勝率"]), b = num(r["平均_勝率"]);
  if (a == null || b == null) return "";
  const d = (b - a) * 100;
  return Math.abs(d) < 0.05 ? "" : `<span class="chg ${d > 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${d.toFixed(1)}%</span>`;
}
function changeCard(rows) {
  if (!hasPre(rows)) return "";
  const a = honmei(rows, "枠順時_順位"), b = honmei(rows, "平均_順位");
  const who = r => r ? `${esc(r.umaban)}番 ${esc(r.horse_name || "")}` : "-";
  const weight = r => { const w = num(r["馬体重"]), z = num(r["増減"]); return w == null ? "" : `(馬体重 ${w}${z == null ? "" : ` ${z > 0 ? "+" : ""}${z}`})`; };
  const moved = rows.map(r => [r, rankMove(r)]).filter(([, d]) => d);
  const ranks = r => `(${num(r["枠順時_順位"])}位 → <b>${num(r["平均_順位"])}位</b>)`;   // 枠順確定の時点 → 今の予想順位
  const top = (list) => list.slice(0, 3).map(([r, d]) => `${moveMark(d)} ${who(r)} ${ranks(r)}${weight(r)}`).join("<br>") || "なし";
  const stage = (col, now) => { const x = num(rows[0][col]), y = num(rows[0][now]); return x == null || y == null ? "-" : x === y ? `${y}(変わらず)` : `${x} → <b>${y}</b>`; };
  return `<div class="card"><h3>枠順確定 → 馬体重の変化${updTag("予想", rows[0].race_id)}</h3><dl class="kv kv-stack">` +
    `<dt>本命</dt><dd>${a && b && +a.umaban === +b.umaban ? `変わらず(${who(b)})` : `${who(a)} → <b>${who(b)}</b> <span class="chip warn">本命変更</span>`}</dd>` +
    `<dt>順位が上がった馬</dt><dd>${top(moved.filter(([, d]) => d > 0).sort((x, y) => y[1] - x[1]))}</dd>` +
    `<dt>順位が下がった馬</dt><dd>${top(moved.filter(([, d]) => d < 0).sort((x, y) => x[1] - y[1]))}</dd>` +
    `<dt>自信の段階</dt><dd>${stage("枠順時_自信の段階", "自信の段階")}</dd>` +
    `<dt>混戦の段階</dt><dd>${stage("枠順時_混戦の段階", "混戦の段階")}</dd>${preRaceRows(rows)}</dl>` +
    `<div class="note">予想順位を、枠順確定の時点と馬体重を入れた今で比べたもの(↑2 は2つ上がった、↓1 は1つ下がった)。かっこ内は枠順確定の時点 → 今の予想順位と、馬体重と前走からの増減。変化の理由は馬体重だけではない。馬体重の版には、前日の天候・当日のクッション値と含水率・当日の馬場傾向も入っている。</div></div>`;
}

// 当日の馬場傾向(2026-11-22 ユーザーの指示「足したい」「ビューアから見れるようにしたい」)。予想 CSV の「今日の内外・前後・レース数」
// (同じ日・同じ競馬場・同じ芝ダで発走が前のレース)。当日前_ の列があれば、馬体重の版の最初の値からの変化も出す
function todayBiasRows(r0, rid) {
  if (!("今日のレース数" in r0)) return "";
  const n = num(r0["今日のレース数"]), n0 = num(r0["当日前_今日のレース数"]);
  const f = v => v == null ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
  const side = (v, a, b) => v == null ? "" : Math.abs(v) < BIAS_FLAT ? `<span class="chip gray">ほぼ互角</span>` : `<span class="chip ${v < 0 ? "up" : "warn"}">${v < 0 ? a : b}</span>`;
  const row = (label, c, a, b) => {
    const v = num(r0[c]), v0 = num(r0[`当日前_${c}`]);
    const mv = v0 != null && v != null && v0 !== v ? ` <span class="dim">(馬体重の版の最初 ${f(v0)} → 今)</span>` : "";
    const ax = c.includes("内外") ? "inner" : "front", ra = rid ? raceBiasActual(rid) : null;
    return `<div class="pace"><div class="pl">${label}</div><div><b>${f(v)}</b> ${side(v, a, b)}${mv}` +
      `</div></div>`;
  };
  if (!n) return `<div style="margin-top:6px"><div class="pace"><div class="pl">今日のここまで</div><div><span class="muted">この競馬場・芝ダで、このレースより前の結果はまだ無い</span></div></div></div>`;
  return `<div style="margin-top:6px">` + row(`今日の内外(${n}レース)`, "今日の内外", "内有利", "外有利") + row(`今日の前後(${n}レース)`, "今日の前後", "前有利", "後ろ有利") +
    `<div class="note">今日の内外・前後は、同じ日・同じ競馬場・同じ芝ダで、このレースより前に発走したレース(${n}レース${n0 != null && n0 !== n ? `。馬体重の版の最初は ${n0}レース` : ""})の3着以内の馬の位置の平均 − 全馬の平均。` +
    `予想にも使っていて、前のレースの結果が出るたびと発走15分前に計算し直す。レースが少ないうちはぶれが大きい。</div></div>`;
}
// 当日の更新(当日の馬場傾向など)による変化: 馬体重の版の最初(当日前_順位・当日前_勝率)と今の比べ
function todayChangeCard(rows) {
  if (!rows.length || !("当日前_順位" in rows[0])) return "";
  const mv = r => { const a = num(r["当日前_順位"]), b = num(r["平均_順位"]); return a == null || b == null ? 0 : a - b; };
  const wd = r => { const a = num(r["当日前_勝率"]), b = num(r["平均_勝率"]); return a == null || b == null ? 0 : (b - a) * 100; };
  const moved = rows.filter(r => mv(r) !== 0 || Math.abs(wd(r)) >= 0.5);
  const a = honmei(rows, "当日前_順位"), b = honmei(rows, "平均_順位");
  const who = r => r ? `${esc(r.umaban)}番 ${esc(r.horse_name || "")}` : "-";
  const list = moved.sort((x, y) => Math.abs(wd(y)) - Math.abs(wd(x))).slice(0, 6).map(r =>
    `${moveMark(mv(r))} ${who(r)}(${num(r["当日前_順位"])}位 → <b>${num(r["平均_順位"])}位</b>・勝率 ${pct(num(r["当日前_勝率"]))} → <b>${pct(num(r["平均_勝率"]))}</b>)`).join("<br>");
  return `<div class="card day-fold"><h3>当日の更新による変化${updTag("予想", rows[0].race_id)}</h3><dl class="kv">` +
    `<dt>本命</dt><dd>${a && b && +a.umaban === +b.umaban ? `変わらず(${who(b)})` : `${who(a)} → <b>${who(b)}</b> <span class="chip warn">本命変更</span>`}</dd>` +
    `<dt>変わった馬</dt><dd>${list || "なし(順位は同じ、勝率の差は 0.5% 未満)"}</dd></dl>` +
    `<div class="note">馬体重を入れた最初の予想と今の予想の比べ。そのあとの変化は、主に当日の馬場傾向(前のレースの結果)の更新による。取消・騎手変更や当日の馬場の計測値でも変わる。</div></div>`;
}
// ---------- netkeiba への印の転記(2026-11-22 ユーザーの指示。公開用にも 11/22 に入れた) ----------
// ボタン → 確認のダイアログ → netkeiba の出馬表を開く(印は URL の # の後ろに入れて渡す)→ 開いたページでブックマークレット「印転記」を押す。
// ブックマークレットは netkeiba の印の▼のリストの項目を押して付ける(保存は netkeiba 自身の仕組み)。渡した印の無い馬は「--」に戻す
const NK_MARK = { "◎": "◎", "〇": "◯", "▲": "▲", "△": "△", "★": "☆", "✓": "✓", "消": "消" };   // ビューアの印 → netkeiba の印
const NK_EXT_ZIP = "https://itry967.github.io/chimpo/assets/ext/netkeiba-marks.zip";   // 拡張機能(公開用のサイトに置いた zip。2026-11-22)
const NK_BOOKMARKLET = `javascript:(function(){var m=location.hash.match(/kbm=([^&]+)/);if(!m){alert('ビューアの「netkeiba に印を転記」から開いたページで押してください');return;}` +
  `var d;try{d=JSON.parse(decodeURIComponent(m[1]));}catch(e){alert('印を読めませんでした');return;}` +
  `var rid=(location.search.match(/race_id=(\d+)/)||[])[1];if(d.r&&rid&&d.r!==rid){alert('レースが違います(ビューア '+d.r+' / このページ '+rid+')');return;}` +
  `var T=['--','◎','◯','▲','△','☆','✓','消'],q=[];` +
  `document.querySelectorAll('.HorseList .CheckMark select').forEach(function(s){var o=s.options[1];if(!o)return;var u=String(+o.value.split('_')[0]);` +
  `var want=d.m[u]||'--',i=T.indexOf(want);if(i<0)return;var cur=s.options[s.selectedIndex]?s.options[s.selectedIndex].text:'--';if(cur.indexOf('10003')>=0)cur='✓';if(cur===want||(cur==='--'&&want==='--'))return;` +
  `var li=s.parentNode.querySelectorAll('ul.dropDown li')[i];if(li)q.push([li,u,want]);});` +
  `var k=0;(function next(){if(k>=q.length){alert('netkeiba に印を転記しました(変えた馬 '+q.length+'頭)。OK でこのタブを閉じます');history.replaceState(null,'',location.pathname+location.search);setTimeout(function(){try{if(window.opener&&!window.opener.closed)window.opener.focus();}catch(e){}window.close();},800);return;}` +
  `var x=q[k++];if(window.jQuery)jQuery(x[0]).trigger('click');else x[0].click();setTimeout(next,400);})();})();`;
function nkRaceId(rid) { return rid.slice(0, 4) + rid.slice(8, 16); }
// ---------- netkeiba(IPAT 連動馬券購入)への買い目の転記(2026-11-22 ユーザーの指示) ----------
// 「買い目候補」の買い目を、netkeiba の IPAT 連動馬券購入の画面に入れる(券種のタブ → 馬 → 金額 → 追加)。最後の「IPAT投票」(購入)は押さない。
// 拡張機能(1.2 以降)が入っていれば開いた画面で自動で入れる。無ければ開いた画面でブックマーク「買い目転記」を押す。中身は拡張機能の bets.js と同じ
const NK_BET_CODE = "(function () { var m = location.search.match(/[?&]kbb=([^&]+)/); if (!m) return; var d; try { d = JSON.parse(decodeURIComponent(m[1])); } catch (e) { alert(\"買い目転記: 買い目を読めませんでした\"); return; } var rid = (location.search.match(/race_id=(\\d+)/) || [])[1]; if (d.r && rid && d.r !== rid) { alert(\"買い目転記: レースが違います(ビューア \" + d.r + \" / このページ \" + rid + \")\"); return; } var q = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }; var tab = function (n) { return q(\"dl.shikibetu dd a\").filter(function (a) { return a.textContent.trim() === n; })[0]; }; var addBtn = function () { return q(\"button\").filter(function (x) { return x.textContent.trim() === \"追加\"; })[0]; }; var i = 0, ok = 0, yen = 0, ng = [], okNames = [], tries = 0, adds = 0, cancelled = false; var wbox = document.createElement(\"div\"); wbox.setAttribute(\"style\", \"position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:sans-serif\"); wbox.innerHTML = '<div style=\"background:#fff;color:#222;border-radius:12px;padding:22px 30px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.4);min-width:280px\">' + '<div style=\"font-size:17px;font-weight:700;margin-bottom:8px\">予想ビューアから買い目を入れています</div>' + '<div id=\"kbbWaitMsg\" style=\"font-size:14px\">しばらくお待ちください(画面ができるのを待っています)</div>' + '<div style=\"font-size:12px;color:#666;margin-top:8px\">終わるまで画面に触らないでください。購入(IPAT投票)は押しません。</div>' + '<button id=\"kbbCancel\" style=\"margin-top:12px;padding:6px 18px;border-radius:6px;border:1px solid #999;background:#f4f4f4;cursor:pointer\">やめる</button></div>'; wbox.querySelector(\"#kbbCancel\").onclick = function () { cancelled = true; this.textContent = \"やめています…\"; this.disabled = true; }; var showWait = function (t) { if (!wbox.parentNode) document.body.appendChild(wbox); var m = wbox.querySelector(\"#kbbWaitMsg\"); if (m && t) m.textContent = t; }; var hideWait = function () { if (wbox.parentNode) wbox.parentNode.removeChild(wbox); }; var ordered = function (k) { return k === \"馬単\" || k === \"3連単\"; }; function clearSel() { q(\"td.Horse_Select input:checked\").forEach(function (x) { (x.parentNode.querySelector(\"label\") || x).click(); }); } function houshiki(name) { var a = q(\"dl.houshiki dd a, .houshiki a\").filter(function (x) { return x.textContent.trim() === name; })[0]; if (a) a.click(); return !!a; } function kensu() { var e = document.getElementById(\"kumiawase_kensu\"); return e ? +e.textContent.trim() : -1; } function step() { if (cancelled) return done(); if (i >= d.b.length) return done(); showWait(\"しばらくお待ちください(\" + (i + 1) + \" / \" + d.b.length + \" 件目)\"); var b = d.b[i++], form = !Array.isArray(b) && b.f; var kind = form ? b.kind : b[0], amt = form ? b.amt : b[2]; var name = form ? kind + \" フォーメーション \" + b.cols.map(function (c) { return c.join(\",\"); }).join(ordered(kind) ? \" → \" : \" - \") + \"(\" + b.n + \"点)\" : kind + \" \" + b[1].join(ordered(kind) ? \"→\" : \"-\"); var tb = tab(kind); if (!tb) { ng.push(name + \"(券種が無い)\"); return step(); } tb.click(); setTimeout(function () { if (!houshiki(form ? \"フォーメーション\" : \"通常\") && form) { d.b.splice.apply(d.b, [i, 0].concat(b.t.map(function (t) { return [kind, t, amt]; }))); return step(); } setTimeout(function () { var rows = q(\"tr.HorseList\").filter(function (tr) { return tr.getClientRects().length && tr.querySelector(\"td.Horse_Select\"); }); var byU = {}; rows.forEach(function (tr) { byU[String(+tr.cells[1].textContent.trim())] = tr; }); var miss = false; var pick = function (u, k) { var tr = byU[String(+u)]; if (!tr) { miss = true; return; } var cells = tr.querySelectorAll(\"td.Horse_Select\"), c = cells.length > 1 ? cells[k] : cells[0]; var inp = c && c.querySelector(\"input\"); if (!inp || inp.disabled) { miss = true; return; } if (!inp.checked) (c.querySelector(\"label\") || inp).click(); }; if (form) b.cols.forEach(function (col, k) { col.forEach(function (u) { pick(u, k); }); }); else b[1].forEach(pick); var money = document.querySelector(\"input[name=money]\"); if (money) { money.value = String(Math.max(1, Math.round(amt / 100))); [\"input\", \"keyup\", \"change\"].forEach(function (ev) { money.dispatchEvent(new Event(ev, { bubbles: true })); }); } setTimeout(function () { var add = addBtn(), pts = form ? b.n : 1; if (form && !miss && kensu() !== b.n) { clearSel(); d.b.splice.apply(d.b, [i, 0].concat(b.t.map(function (t) { return [kind, t, amt]; }))); return setTimeout(step, 500); } if (miss || !money || !add || /disabled/.test(add.className)) { ng.push(name + (miss ? \"(馬を選べない)\" : \"(追加できない)\")); clearSel(); return setTimeout(step, 500); } add.click(); adds++; ok += pts; yen += Math.max(1, Math.round(amt / 100)) * 100 * pts; if (form) okNames.push.apply(okNames, b.names); else okNames.push(name); setTimeout(step, 900); }, 600); }, 600); }, 900); } function done() { hideWait(); history.replaceState(null, \"\", location.pathname + location.search.replace(/&kbb=[^&]*/, \"\")); var got = stored() - base; if (got < adds) { ok = 0; okNames = []; ng.push(\"購入画面の記録に入っていない買い目がある(「IPAT投票」で「買い目が入力されていません」になる。ページを読み込み直して、もう一度送ってください)\"); } if (cancelled) ng.push(\"「やめる」で途中で止めた(残り \" + (d.b.length - i) + \" 件は入れていない。入れた分は投票内容に残っている)\"); try { if (typeof chrome !== \"undefined\" && chrome.runtime && chrome.runtime.id) chrome.runtime.sendMessage({ type: \"kbb-done\", ok: ok > 0, n: ok, yen: yen, ng: ng, okNames: okNames, id: d.id || \"\" }); } catch (e) {} alert(\"netkeiba の購入画面に買い目を \" + ok + \" 点入れました(合計 \" + yen.toLocaleString() + \" 円)。\" + (ng.length ? \"\\n入れられなかった・止めた: \" + ng.join(\"、\") : \"\") + \"\\n\\n右の「投票内容」で買い目と金額を確かめてから、ご自分で「IPAT投票」を押してください(このプログラムは購入を押しません)。\"); } var lsKey = \"ndi::bet_\" + rid; var stored = function () { try { var v = JSON.parse(localStorage.getItem(lsKey) || \"null\"); return v && v.list ? Object.keys(v.list).length : 0; } catch (e) { return 0; } }; var base = 0; (function wait() { if (document.body) showWait(); if (!tab(\"単勝\") || !document.querySelector(\"input[name=money]\")) { if (++tries > 40) { hideWait(); alert(\"買い目転記: 購入画面が出ませんでした(netkeiba にログインしているか・IPAT 連動の設定を確かめてください)\"); return; } return setTimeout(wait, 500); } setTimeout(function () { base = stored(); step(); }, 2500); })(); })();";
const NK_BET_BOOKMARKLET = "javascript:" + encodeURIComponent(NK_BET_CODE);
const NK_BET_KINDS = ["単勝", "複勝", "馬連", "ワイド", "馬単", "3連複", "3連単"];
// 買い目ごとの IPAT 送信の記録: { "馬連 4-14": { at, st: "sent" | "ok" | "ng" } }
function nkBetItemsOf(rid) { try { return JSON.parse(localStorage.getItem("keiba-viewer:nkBetItems:" + rid) || "{}"); } catch (e) { return {}; } }
function setNkBetItems(rid, names, st, at, amounts) {
  const m = nkBetItemsOf(rid);
  for (const n of names) m[n] = { at: at || m[n]?.at || "", st, amt: amounts?.[n] ?? m[n]?.amt };
  try { localStorage.setItem("keiba-viewer:nkBetItems:" + rid, JSON.stringify(m)); } catch (e) {}
}
function nkBetCell(v) {
  if (!v) return `<span class="dim">-</span>`;
  const am = v.amt ? `・${(+v.amt).toLocaleString()}円` : "";   // 送った金額も出す(2026-11-22 ユーザーの指示)
  if (v.st === "ok") return `<span class="hi" title="拡張機能で購入画面に入ったことを確かめた(${esc(v.at)} に送信。購入したかは分からない)">✔ ${esc(v.at)}${am}</span>`;
  if (v.st === "ng") return `<span class="down" title="購入画面に入れられなかった(${esc(v.at)} に送信)">✖ ${esc(v.at)}${am}</span>`;
  return `<span class="muted" title="購入画面に送った(入ったかはブックマークの方式では分からない)">送信 ${esc(v.at)}${am}</span>`;
}
function nkBetSentOf(rid) { try { return JSON.parse(localStorage.getItem("keiba-viewer:nkBetSent:" + rid) || "null"); } catch (e) { return null; } }
function nkBetSentTag(rid) {
  const v = nkBetSentOf(rid);
  return `<span class="nk-sent muted nk-bet-sent" title="netkeiba の購入画面に買い目を送った時刻(購入したかどうかは分からない)">${v ? `送信 ${esc(v.at)}(${v.n}点・${v.yen.toLocaleString()}円)` : "未送信"}</span>`;
}
async function sendBetsToNetkeiba(rid) {
  const all = basketOf(rid).filter(x => x.sel !== false && (+x.amount || 0) > 0 && ticketEligible(state.races.get(rid), x));
  const ok = all.filter(x => NK_BET_KINDS.includes(x.kind)), bad = all.filter(x => !NK_BET_KINDS.includes(x.kind));
  if (!ok.length) { alert("送れる買い目がありません(金額が 0 円の買い目と、チェックを外した買い目は送らない)"); return; }
  const sep = k => k === "馬単" || k === "3連単" ? "→" : "-";
  const yen = ok.reduce((a, x) => a + Math.max(100, Math.round(x.amount / 100) * 100), 0);
  const list = ok.map(x => `${x.kind} ${x.t.join(sep(x.kind))} ${Math.max(100, Math.round(x.amount / 100) * 100).toLocaleString()}円`).join("\n");
  const msg = `「買い目候補」の買い目を、netkeiba の IPAT 連動馬券購入の画面(${title(rid)})に入れます。

${list}

合計 ${ok.length}点・${yen.toLocaleString()}円` +
    (bad.length ? `
(送れない券種は送りません: ${bad.map(x => x.kind).join("・")})` : "") +
    `

※ 購入(「IPAT投票」)は押しません。入ったあと、netkeiba の画面で買い目と金額を確かめて、ご自分で「IPAT投票」を押してください。` +
    `
※ 拡張機能「予想ビューア 印・買い目転記」(1.4.0 以降)を入れていれば自動で入ります。入れていなければ、開いた画面でブックマーク「買い目転記」を押してください。` +
    `
※ ${NK_POPUP_NOTE}`;
  if (!(await nkConfirm(msg, false))) return;
  if (ok.some(x => !ticketEligible(state.races.get(rid), x))) { alert("確認中に出走馬・発売条件が変わりました。もう一度確認してください"); return; }
  // フォーメーションのまま送る(2026-11-23 ユーザーの指示)。フォーメーションの買い目が全部そろっていて、金額がすべて同じで、
  // ほかのフォーメーションと重なっていない(1つのフォーメーションからだけ入れた)ときだけ。ほかは1点ずつ
  const amtOf = x => Math.max(100, Math.round(x.amount / 100) * 100), keyOf = (k, t) => k + "|" + t.map(String).join("-");
  // 同じ買い目が別のフォーメーションにもあるので、フォーメーションの名前ごとに引く(11/23)
  const byKey = new Map(ok.filter(x => x.fsets?.length === 1).map(x => [x.fsets[0].label + "#" + keyOf(x.kind, x.t), x])), used = new Set(), payload = [];
  for (const x of ok) {
    const fs = x.fsets?.length === 1 ? x.fsets[0] : null;
    if (!fs || used.has(x)) continue;
    const exp = expandTickets(fs.kind, fs.cols), its = exp.map(t => byKey.get(fs.label + "#" + keyOf(fs.kind, t)));
    if (exp.length < 2 || its.some(y => !y || used.has(y)) || new Set(its.map(amtOf)).size !== 1) continue;
    its.forEach(y => used.add(y));
    payload.push({ f: 1, kind: fs.kind, cols: fs.cols.map(c => c.map(String)), amt: amtOf(its[0]), n: exp.length,
      names: its.map(y => y.kind + " " + y.t.join(sep(y.kind))), t: its.map(y => y.t.map(String)) });
  }
  for (const x of ok) if (!used.has(x)) payload.push([x.kind, x.t.map(String), +x.amount]);
  const data = encodeURIComponent(JSON.stringify({ r: nkRaceId(rid), id: rid, b: payload }));
  const w = window.open(`https://race.netkeiba.com/ipat/ipat.html?date=${rid.slice(0, 8)}&race_id=${nkRaceId(rid)}&kbb=${data}`, "_blank");
  if (!w) { nkPopupBlocked(); return; }
  const d = new Date();
  const items = ok.map(x => ({ kind: x.kind, t: x.t.map(String), amount: Math.max(100, Math.round(x.amount / 100) * 100), name: x.kind + " " + x.t.join(sep(x.kind)) }));
  setNkBetItems(rid, items.map(x => x.name), "sent", `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
    Object.fromEntries(items.map(x => [x.name, x.amount])));
  try { localStorage.setItem("keiba-viewer:nkBetSent:" + rid, JSON.stringify({ at: `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, n: ok.length, yen, items })); } catch (e) {}
  document.querySelectorAll(".nk-bet-sent").forEach(x => x.outerHTML = nkBetSentTag(rid));
  if (!state.dayPage) renderRace(rid);   // 買い目候補の IPAT の列を新しくする
}
// 買い目転記が成功したら、日別ページの「購入した馬券」に入れる(2026-11-22 ユーザーの指示。？から外せる。拡張機能 1.3 以降のときだけ。ブックマークでは結果が分からない)
function nkBetToBought() { try { return localStorage.getItem("keiba-viewer:nkBetToBought") !== "0"; } catch (e) { return true; } }
function setNkBetToBought(v) { try { localStorage.setItem("keiba-viewer:nkBetToBought", v ? "1" : "0"); } catch (e) {} }
function nkBetResult(r) {
  const sent = r.id ? nkBetSentOf(r.id) : null;
  if (r.id) {   // 買い目ごとの記録: 入ったもの ✔、入れられなかったもの ✖(名前の後ろの理由は除く)
    setNkBetItems(r.id, r.okNames || [], "ok");
    setNkBetItems(r.id, (r.ng || []).map(x => x.replace(/\(.*\)$/, "")), "ng");
  }
  let note = "";
  if (r.ok && r.id && sent?.items && nkBetToBought()) {
    const done = sent.items.filter(x => (r.okNames || []).includes(x.name) && ticketEligible(state.races.get(r.id), x));
    if (done.length) { sendToBought(r.id, done); note = ` 日別ページの「購入した馬券」に ${done.length}点入れました。`; }
  }
  nkToast(r.ok ? `✔ netkeiba の購入画面に買い目を ${r.n}点(${(r.yen || 0).toLocaleString()}円)入れました。netkeiba の画面で確かめて「IPAT投票」を押してください。${note}` +
    (r.ng?.length ? `(入れられなかった: ${r.ng.join("、")})` : "") : `✖ 買い目を入れられませんでした: ${(r.ng || []).join("、")}`, r.ok ? "ok" : "ng");
  if (state.dayPage) render(); else if (state.current) renderRace(state.current);   // 買い目候補の IPAT・購入した馬券の列も新しくする
}
function nkBetHelpHTML() {
  const pc = !window.matchMedia("(max-width: 760px)").matches;
  return `<p>「買い目候補」の買い目(金額が 0 円より大きいもの)を、netkeiba の IPAT 連動馬券購入の画面に入れる。<b>購入(「IPAT投票」)は押さない</b>ので、入ったあと netkeiba の画面で買い目と合計金額を確かめて、ご自分で押す。</p>` +
    `<p style="margin:8px 0"><label><input type="checkbox" ${nkBetToBought() ? "checked" : ""} onchange="setNkBetToBought(this.checked)"> 買い目を入れられたら、日別ページの「購入した馬券」にも入れる</label>` +
    `<br><span class="muted">拡張機能(1.3 以降)のときだけ。「入れられた」は netkeiba の購入画面に入ったことで、実際に「IPAT投票」で買ったかどうかは分からない。買わなかったときは「購入した馬券」から消す。</span></p>` +
    `<p>送れる券種: ${NK_BET_KINDS.join("・")}(枠連は送らない)。金額は 100円単位にそろえる。netkeiba にログインし、IPAT 連動の設定(IPAT の加入者番号などの登録)を済ませておく。</p>` +
    (pc ? `<h3>おすすめ(PC の Chrome): 拡張機能</h3><p>印転記と同じ拡張機能「予想ビューア 印・買い目転記」(1.2 以降)を入れておくと、開いた購入の画面で自動で買い目が入る。入れ方は、出走馬の欄の「netkeiba に印を転記」の ？ を見る(同じ zip)。</p>` +
      `<p style="margin:10px 0"><a class="nk-bm" href="${NK_EXT_ZIP}" download>拡張機能をダウンロード(zip)</a> <span class="muted">展開して chrome://extensions の「パッケージ化されていない拡張機能を読み込む」で入れる(前の版は上書きして ↻)</span></p><p>` +
      `今の状態: ${document.documentElement.dataset.kbmExt ? `拡張機能 ${esc(document.documentElement.dataset.kbmExt)}${parseFloat(document.documentElement.dataset.kbmExt) < 1.2 ? "(古い版。買い目転記には 1.2 への更新が要る)" : ""}` : "拡張機能は見つからない"}</p>` : "") +
    `<h3>${pc ? "補助: " : ""}ブックマーク「買い目転記」の登録</h3>` +
    `<p style="margin:10px 0"><a class="nk-bm" href="${esc(NK_BET_BOOKMARKLET)}" onclick="alert('ブックマークバーへドラッグして登録してください');return false;">買い目転記</a> <span class="muted">← これをブックマークバーへドラッグ</span></p>` +
    `<p class="muted">ドラッグできないときは、何かのページをブックマークに登録してから編集し、名前を「買い目転記」、URL に下の文をまるごと貼る。</p>` +
    `<textarea readonly style="width:100%;height:80px;font-size:11px" onclick="this.select()">${esc(NK_BET_BOOKMARKLET)}</textarea>` +
    `<h3>使い方</h3><ol><li>「買い目候補」に買い目を溜め、金額を決める。</li><li>「netkeiba(IPAT)に買い目を送る」を押し、確認で送る買い目と合計金額を確かめて OK。</li>` +
    `<li>netkeiba の IPAT 連動馬券購入の画面が新しいタブで開く。拡張機能があれば自動で、無ければブックマーク「買い目転記」を押すと、買い目が1点ずつ入る。</li>` +
    `<li>終わると「買い目を ○点入れました」と出る。右の「投票内容」で確かめて、ご自分で「IPAT投票」を押す。</li></ol>` +
    `<p>${NK_POPUP_NOTE}</p>`;
}
function nkConfirmOff() { try { return localStorage.getItem("keiba-viewer:nkNoConfirm") === "1"; } catch (e) { return false; } }
function setNkConfirmOff(v) { try { localStorage.setItem("keiba-viewer:nkNoConfirm", v ? "1" : "0"); } catch (e) {} }
// 印転記の確認(ブラウザの confirm の代わり。「次から表示しない」のチェック付き)
function nkConfirm(text, allowSkip = true) {
  return new Promise(resolve => {
    const d = document.createElement("dialog");
    d.className = "nk-confirm";
    d.innerHTML = `<div style="white-space:pre-wrap;line-height:1.6">${esc(text)}</div>` +
      (allowSkip ? `<label style="display:block;margin:12px 0 4px"><input type="checkbox" class="nkNoAsk"> 次から確認を表示しない(？の説明からいつでも戻せる)</label>` : "") +
      `<div class="row" style="justify-content:flex-end;gap:8px;margin-top:8px"><button class="nkNo">キャンセル</button><button class="nkYes on">OK(転記する)</button></div>`;
    document.body.appendChild(d);
    const end = v => { if (v && d.querySelector(".nkNoAsk")?.checked) setNkConfirmOff(true); d.close(); d.remove(); resolve(v); };
    d.querySelector(".nkYes").onclick = () => end(true);
    d.querySelector(".nkNo").onclick = () => end(false);
    d.addEventListener("cancel", e => { e.preventDefault(); end(false); });
    d.showModal();
  });
}
async function sendMarksToNetkeiba(rid) {
  const ms = marksOf(rid), rows = state.races.get(rid) || [];
  const list = rows.map(r => [String(+r.umaban), ms[String(r.umaban)] || ms[String(+r.umaban)]]).filter(([, m]) => m && m !== "-")
    .sort((a, b) => +a[0] - +b[0]);
  const bad = list.filter(([, m]) => !NK_MARK[m]);
  const txt = list.length ? list.map(([u, m]) => `${m} ${u}番`).join("・") : "(印なし。netkeiba の印を全部外します)";
  const msg = `このページで付けた印を、netkeiba のこのレース(${title(rid)})に転記します。

${txt}` +
    `${bad.length ? `
(netkeiba に無い印は送りません: ${bad.map(([u, m]) => m + u + "番").join("・")})` : ""}` +
    `

netkeiba で元々付けていた印は消えます(このページの印に置き換わります)。

OK を押すと netkeiba の出馬表を開きます。拡張機能「予想ビューア 印転記」を入れていれば、裏のタブで自動で転記して閉じ、この画面に結果を知らせます(入れていなければ、netkeiba の出馬表が開くので、そこでブックマーク「印転記」を押す)。

※ ${NK_POPUP_NOTE}`;
  // 確認を出さない設定(2026-11-22 ユーザーの指示「表示しないチェックボックス」「？のモーダルから後から選べる」)
  const ok = nkConfirmOff() ? true : await nkConfirm(msg);
  if (!ok) return;
  const m = Object.fromEntries(list.filter(([, x]) => NK_MARK[x]).map(([u, x]) => [u, NK_MARK[x]]));
  const data = encodeURIComponent(JSON.stringify({ r: nkRaceId(rid), m }));
  const url = `https://race.netkeiba.com/race/shutuba.html?race_id=${nkRaceId(rid)}#kbm=${data}`;
  // 拡張機能(1.1 以降)が入っていれば、裏のタブで転記して自動で閉じ、結果をこの画面に知らせる(2026-11-22 ユーザーの指示)
  if (document.documentElement.dataset.kbmExt && document.documentElement.dataset.kbmExt !== "1") {
    nkToast(`⏳ netkeiba に印を転記しています(裏のタブで。${title(rid)})…`, "wait");
    window.postMessage({ type: "kbm-send", url, id: rid }, "*");
    return;
  }
  const w = window.open(url, "_blank");
  if (!w) nkPopupBlocked(); else setNkSent(rid, "open");
}
// ポップアップがブロックされたとき(2026-11-22 ユーザーの指示: このサイトは解除するよう注意書き)
const NK_POPUP_NOTE = "ポップアップがブロックされた場合は、アドレスバーの右端に出るアイコンを押して、このサイトのポップアップとリダイレクトを「常に許可」にしてください(許可したあと、もう一度「netkeiba に印を転記」を押す)。";
function nkPopupBlocked() {
  nkToast("✖ netkeiba のタブが開けませんでした(ポップアップのブロック)。" + NK_POPUP_NOTE, "ng");
  alert("netkeiba のタブが開けませんでした。\n\n" + NK_POPUP_NOTE);
}
// 印を転記した時刻(レースごと。このブラウザに覚えておく。2026-11-22 ユーザーの指示「？の横に印を転記した時間を表示」)
function nkSentOf(rid) { try { return JSON.parse(localStorage.getItem("keiba-viewer:nkSent:" + rid) || "null"); } catch (e) { return null; } }
function setNkSent(rid, how) {
  const d = new Date(), v = { at: `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, how };
  try { localStorage.setItem("keiba-viewer:nkSent:" + rid, JSON.stringify(v)); } catch (e) {}
  document.querySelectorAll(".nk-sent").forEach(x => x.outerHTML = nkSentTag(rid));
}
function nkSentTag(rid) {
  const v = nkSentOf(rid);
  return `<span class="nk-sent muted" title="${v ? (v.how === "ext" ? "拡張機能で転記できた時刻" : "netkeiba の出馬表を開いた時刻(ブックマークでの転記)") : "まだ転記していない"}">${v ? (v.how === "ext" ? "転記 " : "開いた ") + esc(v.at) : "未転記"}</span>`;
}
function nkToast(text, kind) {
  // 転記中は画面の真ん中に「お待ちください」を出す(2026-11-22 ユーザーの指示)。結果が来たら消す
  let w = document.getElementById("nkWait");
  if (kind === "wait") {
    if (!w) { w = document.createElement("div"); w.id = "nkWait"; document.body.appendChild(w); }
    w.innerHTML = `<div class="nk-wait-box"><div class="nk-spin"></div><b>netkeiba に印を転記しています</b><div>しばらくお待ちください(ふつう 10〜20 秒)</div></div>`;
    clearTimeout(w._timer);
    w._timer = setTimeout(() => w.remove(), 70000);   // 拡張機能から返事が無いとき
    return;
  }
  if (w) w.remove();
  let t = document.getElementById("nkToast");
  if (!t) { t = document.createElement("div"); t.id = "nkToast"; document.body.appendChild(t); }
  t.className = "nk-toast " + (kind || "");
  t.innerHTML = `<div>${esc(text)}</div>` + (kind === "wait" ? "" : `<div class="nk-toast-x">押すと閉じる</div>`);
  t.onclick = () => { if (kind !== "wait") t.remove(); };
  clearTimeout(t._timer);
  if (kind === "ok") t._timer = setTimeout(() => t.remove(), 15000);   // 失敗の知らせは押すまで消さない
}
window.addEventListener("message", e => {   // 拡張機能からの転記の結果
  if (e.source !== window || !e.data || e.data.type !== "kbm-result") return;
  if (e.data.kind === "bets") return nkBetResult(e.data);   // 買い目転記の結果(拡張機能 1.3 以降)
  if (e.data.ok && e.data.id) setNkSent(e.data.id, "ext");
  nkToast(e.data.ok ? `✔ 転記できました: ${e.data.message || ""}` : `✖ 転記できませんでした: ${e.data.message || ""}`, e.data.ok ? "ok" : "ng");
});
function nkHelpHTML() {
  // 2026-11-22 ユーザーの指示: PC は拡張機能(自動で転記)を主に、ブックマークは補助。拡張機能の説明は PC の幅のときだけ出す
  const pc = !window.matchMedia("(max-width: 760px)").matches;
  const ext = `<h3>おすすめ(PC の Chrome): 拡張機能を入れる</h3>` +
    `<p>入れておくと、「netkeiba に印を転記」→ OK で、netkeiba の出馬表を<b>裏のタブで</b>開いて自動で印を付け、終わるとタブを閉じて、この画面の右下に結果を知らせる(画面は切り替わらない)。` +
    `ビューアから開いたページのときだけ動き、ふだんの netkeiba の閲覧では何もしない。</p>` +
    `<p style="margin:10px 0"><a class="nk-bm" href="${NK_EXT_ZIP}" download>拡張機能をダウンロード(zip)</a></p>` +
    `<ol><li>ダウンロードした zip を右クリック →「すべて展開」で展開する(中に netkeiba-marks というフォルダができる)。</li>` +
    `<li>Chrome のアドレスバーに <code>chrome://extensions</code> と入力して開く(リンクからは開けないので、下の枠を押してコピーして貼る)。` +
    `<input readonly value="chrome://extensions" onclick="this.select()" style="width:12em;margin-left:6px"></li>` +
    `<li>右上の「デベロッパー モード」をオンにする。</li><li>「パッケージ化されていない拡張機能を読み込む」を押し、展開した netkeiba-marks のフォルダを選ぶ。</li>` +
    `<li>一覧に「予想ビューア 印転記」が出れば完了。展開したフォルダは消さずに置いておく(消すと拡張機能が動かなくなる)。</li>` +
    `<li>ブックマークの方式(拡張機能なし)で netkeiba のタブが開かないときは、ポップアップのブロック。${NK_POPUP_NOTE}</li>` +
    `<li>前の版(1.0)を入れていた場合は、新しい zip を同じ場所に展開し直して上書きし、一覧の「予想ビューア 印転記」の更新ボタン(↻)を押す。この画面も読み込み直す。</li></ol>` +
    `<p class="muted">今の状態: ${document.documentElement.dataset.kbmExt ? `拡張機能 ${esc(document.documentElement.dataset.kbmExt)} を確認${document.documentElement.dataset.kbmExt === "1" ? "(古い版。裏で転記するには更新が要る)" : ""}` : "拡張機能は見つからない"}</p>`;
  const ask = `<p style="margin:8px 0"><label><input type="checkbox" ${nkConfirmOff() ? "" : "checked"} onchange="setNkConfirmOff(!this.checked)"> 転記の前に確認(送る印・元の印が消えること)を表示する</label></p>`;
  return `<p>このビューアで付けた印を、netkeiba の同じレースの印に転記する。</p>${ask}${pc ? ext : ""}<h3>${pc ? "補助: " : ""}ブックマーク(ブックマークレット)の登録${pc ? "(拡張機能を入れられないとき・携帯)" : ""}</h3>` +
    `<p><b>PC:</b> 下の「印転記」をブックマークバーへドラッグする(ブックマークバーが出ていなければ Ctrl+Shift+B)。</p>` +
    `<p style="margin:10px 0"><a class="nk-bm" href="${esc(NK_BOOKMARKLET)}" onclick="alert('ブックマークバーへドラッグして登録してください');return false;">印転記</a> <span class="muted">← これをブックマークバーへドラッグ</span></p>` +
    `<p class="muted">ドラッグできないときは、何かのページをブックマークに登録してから編集し、名前を「印転記」、URL に下の文をまるごと貼る。</p>` +
    `<textarea readonly style="width:100%;height:80px;font-size:11px" onclick="this.select()">${esc(NK_BOOKMARKLET)}</textarea>` +
    `<h3>使い方</h3><ol><li>レースのページの「netkeiba に印を転記」を押す。</li><li>確認のダイアログで、送る印と、netkeiba で元々付けていた印が消えることを確かめて OK を押す(キャンセルなら何もしない)。</li>` +
    `<li>netkeiba の出馬表が新しいタブで開く(netkeiba にログインしておく)。</li><li>拡張機能を入れていれば、裏のタブで自動で転記され、この画面の右下に結果が出る。入れていなければ、netkeiba の出馬表が開くので、ブックマークの「印転記」を押す。印が付いて「転記しました」と出て、OK を押すとそのタブが閉じて、元の予想ビューアのタブに戻る(保存が終わるまで少し待ってから閉じる)。</li></ol><p class="muted">2026-11-22 にタブを閉じる動きを足した。それより前に登録したブックマークは古いままなので、ブックマークの URL を上の文に入れ替える(または登録し直す)。</p>` +
    `<p>印の対応: ◎ → ◎、〇 → ◯、▲ → ▲、△ → △、★ → ☆、✓ → ✓、消 → 消。このページで印の無い馬は、netkeiba でも「--」(印なし)にする。</p>`;
}
function simpleView() {
  // 出走馬の簡易表示(このブラウザに覚えておく)
  // 2026-11-22 ユーザーの指示: PC も携帯も簡易表示を最初の表示にし、チェックは「詳細表示」(✓で前の PC の最初の表示)にした
  try { return localStorage.getItem("keiba-viewer:detail") !== "1"; } catch (e) { return !state.detail; }
}
function hitPayout(rid, kind, t) {
  // 結果が出たレースで、その買い目が当たっていれば 100円あたりの払戻(当たっていなければ null)。馬単・3連単は順番どおり
  const pays = state.pays.get(rid);
  if (!pays) return null;
  const norm = (k, u) => (k === "馬単" || k === "3連単" ? u.map(Number) : u.map(Number).sort((a, b) => a - b)).join("-");
  const key = norm(kind, t);
  const p = pays.find(x => x["券種"] === kind && norm(kind, String(x["組み合わせ"]).split("-")) === key);
  return p ? num(p["払戻金"]) : null;
}
function reviewHits(rid, tickets) {
  tickets = tickets.filter(x => ticketEligible(state.races.get(rid), x));
  // 買い目(券種・馬番・金額)の当たりと払戻。馬単・3連単は順番どおり、ほかは順不同で照らし合わせる
  const pays = state.pays.get(rid) || [];
  const norm = (kind, t) => (kind === "馬単" || kind === "3連単" ? t.map(Number) : t.map(Number).sort((a, b) => a - b)).join("-");
  const table = new Map(pays.map(p => [`${p["券種"]}|${norm(p["券種"], String(p["組み合わせ"]).split("-"))}`, num(p["払戻金"])]));
  let cost = 0, back = 0, hit = 0;
  for (const x of tickets) {
    const amt = num(x.amount) || 0; if (!amt) continue;
    cost += amt;
    const pay = table.get(`${x.kind}|${norm(x.kind, x.t)}`);
    if (pay) { back += pay * amt / 100; hit++; }
  }
  return { cost, back, hit, n: tickets.filter(x => num(x.amount)).length };
}
// 予想の質(0〜100点): 勝ち馬の対数損失と、予想順位と着順の順位相関を、検証期間(2019〜2023年)の全レースの中の位置にして平均する。
// 基準は回顧の CSV の「質の基準_勝ち馬」「質の基準_順番」(0,1,…,100% 点)。計算は raceday.quality_values と同じ
function rankAvg(vals, desc) {
  const idx = vals.map((v, i) => [v, i]).sort((a, b) => desc ? b[0] - a[0] : a[0] - b[0]);
  const out = new Array(vals.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) out[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}
function corr(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y) / n, mb = b.reduce((x, y) => x + y) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}
function posIn(q, v) {
  // 0〜100% 点の並び q の中で、v が下から何%か(間は線形に補う)
  if (v <= q[0]) return 0;
  if (v >= q[q.length - 1]) return 100;
  const i = q.findIndex(x => x >= v);
  const lo = q[i - 1], hi = q[i];
  return (i - 1 + (hi > lo ? (v - lo) / (hi - lo) : 0.5)) * 100 / (q.length - 1);
}
function predictionQuality(rows, res, rv) {
  const qll = String(rv["質の基準_勝ち馬"] || "").split(",").filter(Boolean).map(Number);
  const qrho = String(rv["質の基準_順番"] || "").split(",").filter(Boolean).map(Number);
  if (qll.length < 2 || qrho.length < 2) return null;
  const juni = new Map(res.map(r => [String(+r["馬番"]), num(r["着順"])]));
  const xs = rows.map(r => ({ p: num(r["平均_勝率"]), j: juni.get(String(+r.umaban)) })).filter(x => x.p != null && x.j != null && x.j > 0);
  if (xs.length < 3) return null;
  const tot = xs.reduce((a, x) => a + x.p, 0);
  const winners = xs.filter(x => x.j === 1);
  if (!winners.length) return null;
  const ll = -Math.log(Math.max(1e-6, Math.max(...winners.map(x => x.p)) / tot));
  const rho = corr(rankAvg(xs.map(x => x.p), true), rankAvg(xs.map(x => x.j), false));
  if (rho == null) return null;
  const sWin = 100 - posIn(qll, ll), sOrder = posIn(qrho, rho);
  return { score: Math.round((sWin + sOrder) / 2), sWin: Math.round(sWin), sOrder: Math.round(sOrder), ll, rho };
}
const qualityWord = s => s >= 80 ? ["とても良く当たった", "up"] : s >= 60 ? ["良く当たった", "up"] : s >= 40 ? ["ふつう", "gray"] : s >= 20 ? ["外れた", "warn"] : ["大きく外れた", "down"];

function navQuality(rid, rows) {
  // レース一覧の「質」の印(レース回顧の予想の質。結果と回顧の CSV があるレースだけ)
  const res = state.results.get(rid), rv = state.review.get(rid);
  const q = res && rv ? predictionQuality(rows, res, rv) : null;
  if (!q) return "";
  const [word, tone] = qualityWord(q.score);
  return ` <span class="chip ${tone}" title="予想の質 ${q.score}/100(${word})">質${q.score}</span>`;
}

// ペースのずれ: 前半1000m が出せる距離は「基準より何秒速いか」の予想と実際の差(秒)。出せない距離は、予想のペース
// (前に行く3頭の前半の速さ)と実際のペース(後半3F − 前半3F)の、過去のレースの中の位置(速い方が大きい 0〜100)の差(目安)
function winGap(i, win) {
  // 勝ちタイムのずれ(実際 − 予想。秒)。予想の半分のレースが入る幅の中なら「ほぼ予想どおり」、1.5秒を超えると「大きく」
  const p = num(i?.["勝ちタイムの予想"]);
  if (p == null || win == null) return "";
  const gap = win - p, [lo, hi] = String(i["勝ちタイムの幅"] || "").split("〜").map(Number);
  const inside = lo && hi ? win >= lo && win <= hi : Math.abs(gap) <= 0.6;
  const word = inside ? "ほぼ予想どおり" : `${Math.abs(gap) > 1.5 ? "予想より大きく" : "予想より"}${gap < 0 ? "速い" : "遅い"}`;
  const tone = inside ? "up" : Math.abs(gap) > 1.5 ? "down" : "warn";
  return `<dt>勝ちタイムのずれ</dt><dd><span class="chip ${tone}">${word}</span> <b>${gap <= 0 ? "" : "+"}${gap.toFixed(1)}秒</b>` +
    `<span class="muted">(予想 ${clock(p)} → 実際 ${clock(win)})</span></dd>`;
}
function settleGap(rows, top3, n) {
  // 決着の予想(一番確率の高い形)と実際。実際は回顧の「決着」と同じ(1〜3着のうち4角で前だった頭数)
  const s = settleProbs(rows), pos = top3.map(lastPos).filter(v => v != null);
  if (!s || pos.length < 3) return "";
  const k = pos.filter(v => v <= Math.max(3, Math.round(n * 0.25))).length;
  const real = k >= 2 ? 0 : k === 1 ? 1 : 2, pred = s.p.indexOf(Math.max(...s.p));
  return `<dt>決着の形</dt><dd>予想 ${SETTLE[pred]}(${pct(s.p[pred], 0)}) → 実際 <b>${SETTLE[real]}</b> ` +
    `<span class="chip ${real === pred ? "up" : "warn"}">${real === pred ? "当たり" : "外れ"}</span>` +
    `<span class="muted">(実際の形に付けていた確率 ${pct(s.p[real], 0)})</span></dd>`;
}
function paceGap(r0, rv, t1000, t1000p) {
  const base = num(r0["前半1000mの基準"]);
  if (t1000 != null && t1000p != null && base != null) {
    const gap = t1000 - t1000p, a = Math.abs(gap);
    const word = a <= 0.3 ? "ほぼ予想どおり" : `${a > 1.0 ? "予想より大きく" : "予想より"}${gap < 0 ? "速い" : "遅い"}`;
    const tone = a <= 0.3 ? "up" : a > 1.0 ? "down" : "warn";
    const rel = d => Math.abs(d) < 0.05 ? "基準どおり" : `基準${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(1)}秒`;
    return `<dt>ペースのずれ</dt><dd><span class="chip ${tone}">${word}</span> <b>${gap <= 0 ? "" : "+"}${gap.toFixed(1)}秒</b>` +
      `<span class="muted">(前半1000m 予想 ${t1000p.toFixed(1)}・${rel(t1000p - base)} → 実際 ${t1000.toFixed(1)}・${rel(t1000 - base)}。` +
      `1000m あたり ${(a / t1000p * 100).toFixed(1)}%)</span></dd>`;
  }
  const m = String(r0["ペース予想の目安"] || "").match(/(速い|遅い)方から上位(\d+)%/);
  const real = num(rv["前傾の位置"]);
  if (!m || real == null) return "";
  const pred = m[1] === "速い" ? 100 - +m[2] : +m[2], act = Math.round(real * 100), gap = act - pred;
  const word = Math.abs(gap) <= 15 ? "ほぼ予想どおり" : `${Math.abs(gap) > 35 ? "予想より大きく" : "予想より"}${gap > 0 ? "速い" : "遅い"}`;
  const tone = Math.abs(gap) <= 15 ? "up" : Math.abs(gap) > 35 ? "down" : "warn";
  return `<dt>ペースのずれ</dt><dd><span class="chip ${tone}">${word}</span> <b>${gap >= 0 ? "+" : ""}${gap}</b>` +
    `<span class="muted">(ペースの位置 予想 ${pred} → 実際 ${act}。0〜100 で速いほど大きい。前半1000m が出せない距離なので目安)</span></dd>`;
}

// k着以内の確率(予想 CSV の1〜5着の確率の合計。1〜5着の帯と同じ値)
const upTo = (r, k) => { const v = [...Array(k)].map((_, i) => num(r[`${i + 1}着の確率`])); return v.some(x => x == null) ? null : v.reduce((a, b) => a + b, 0); };

function renderReview(rid, rows) {
  const res = state.results.get(rid);
  if (!res) return "";
  const rv = state.review.get(rid) || {}, r0 = rows[0];
  const pred = new Map(rows.map(r => [String(+r.umaban), r]));
  const fin = res.filter(r => num(r["着順"]) != null);
  const n = res.length;
  // --- レース内容 ---
  const laps = String(rv["ラップ"] || "").split(",").filter(Boolean).map(Number);
  const f3 = num(rv["前半3F"]), l3 = num(rv["後半3F"]), bf3 = num(rv["基準_前半3F"]), bl3 = num(rv["基準_後半3F"]);
  const win = num(rv["勝ちタイム"]), bwin = num(rv["基準_勝ちタイム"]);
  const top3 = fin.filter(r => num(r["着順"]) <= 3);
  const corners = top3.map(lastPos).filter(v => v != null);
  const front = corners.filter(v => v <= Math.max(3, Math.round(n * 0.25))).length;
  const shape = !corners.length ? "" : front >= 2 ? "前に行った馬が残った(前残り)" : front === 0 ? "後ろからの馬が上位を占めた(差し・追込)" : "前と後ろが混ざった決着";
  const umaPos = top3.map(r => num(r["馬番"]) / n).filter(v => v != null);
  const inner = umaPos.length ? umaPos.reduce((a, b) => a + b) / umaPos.length : null;
  const lane = inner == null ? "" : inner < 0.4 ? "内の馬番が上位" : inner > 0.65 ? "外の馬番が上位" : "馬番の偏りは小さい";
  const fastest = Math.min(...fin.map(r => num(r["上がり3F"])).filter(v => v != null));
  const fastHorses = fin.filter(r => num(r["上がり3F"]) === fastest);
  const q = predictionQuality(rows, res, rv);
  let h = `<div class="card review"><h3>レース回顧${updTag(["回顧", "結果", "払戻"], rid)}</h3>`;
  if (q) {
    const [word, tone] = qualityWord(q.score);
    h += `<div class="quality"><span class="ql">予想の質</span><b class="qs">${q.score}</b><span class="muted">/100</span>` +
      `<span class="chip ${tone}">${word}</span><span class="muted">勝ち馬の確率 ${q.sWin} 点(勝率 ${pct(Math.exp(-q.ll))})・` +
      `順番の当たり方 ${q.sOrder} 点(予想順位と着順の相関 ${q.rho.toFixed(2)})</span>` +
      `<div class="bar"><i style="width:${q.score}%"></i></div></div>`;
  }
  const pl = predictedLaps(r0, state.info.get(rid));
  const predLaps = pl && pl.laps.length === laps.length ? pl.laps : null;
  const lapMk = pl && pl.marks.length === laps.length ? pl.marks : (num(state.info.get(rid)?.["距離"]) ? lapMarks(num(state.info.get(rid)["距離"]), laps.length) : laps.map((_, i) => 200 * (i + 1)));
  const lb = lapBase(state.info.get(rid));
  // ラップはレース内容から分けて、回顧の中の独立した欄にする(レース内容と予想との乖離は、その下で上をそろえて並べる)
  if (laps.length) h += `<div class="lapsec"><h4>ラップ</h4>` + lapText(laps, f3, l3) + lapBaseTabs(state.info.get(rid)) +
    `<div class="scroll">${lapChart(laps, predLaps, lapMk, lb?.laps, lb)}</div></div>`;
  h += `<div class="grid2 rvgrid"><div><h4>レース内容</h4><dl class="rv">` +
    (f3 != null ? `<dt>前半3F</dt><dd><b>${f3.toFixed(1)}</b> ${diffTxt(f3, bf3)}${judgeChip(rv, "前半3F", f3)}${baseList(rv, "前半3F", f3, v => v.toFixed(1))}</dd>` : "") +
    (l3 != null ? `<dt>後半3F</dt><dd><b>${l3.toFixed(1)}</b> ${diffTxt(l3, bl3)}${judgeChip(rv, "後半3F", l3)}${baseList(rv, "後半3F", l3, v => v.toFixed(1))}</dd>` : "") +
    (rv["ペース"] ? `<dt>ペース</dt><dd><span class="chip ${/ハイ|速い/.test(rv["ペース"]) ? "warn" : /スロー/.test(rv["ペース"]) ? "" : "gray"}">${esc(rv["ペース"])}</span>` +
      ` <span class="muted">前半の速さ(後半3F − 前半3F)が、同じコースの過去3年 ${esc(rv["基準のレース数"])} レースの中で下から ${Math.round(num(rv["前傾の位置"]) * 100)}%</span></dd>` : "") +
    (win != null ? `<dt>勝ちタイム</dt><dd><b>${sec(win)}</b> ${diffTxt(win, num(rv["基準_勝ちタイム_全体"]) ?? bwin)}${judgeChip(rv, "勝ちタイム", win)}${baseList(rv, "勝ちタイム", win, sec)}</dd>` : "") +
    (shape ? `<dt>決着</dt><dd>${shape}<span class="muted">(1〜3着の4角: ${top3.map(r => `${lastPos(r) ?? "-"}番手`).join("・")})</span></dd>` : "") +
    (lane ? `<dt>馬番</dt><dd>${lane}<span class="muted">(1〜3着: ${top3.map(r => r["馬番"]).join("・")}番 / ${n}頭)</span></dd>` : "") +
    (fastHorses.length && isFinite(fastest) ? `<dt>上がり最速</dt><dd>${fastHorses.map(r => `${esc(r["馬名"])}(${r["着順"]}着)`).join("・")} <b>${fastest.toFixed(1)}</b>` +
      ` ${diffTxt(fastest, num(rv["基準_上がり最速_全体"]))}${judgeChip(rv, "上がり最速", fastest)}${baseList(rv, "上がり最速", fastest, v => v.toFixed(1))}</dd>` : "") +
    `</dl></div>`;
  // --- 予想との乖離 ---
  const rk = r => num(pred.get(String(+r["馬番"]))?.["平均_順位"]);
  const p1 = rows.find(r => num(r["平均_順位"]) === 1), p1res = p1 && res.find(r => +r["馬番"] === +p1.umaban);
  const winner = fin.find(r => num(r["着順"]) === 1), wp = winner && pred.get(String(+winner["馬番"]));
  const inTop3 = rows.filter(r => num(r["平均_順位"]) <= 3).filter(r => { const x = res.find(y => +y["馬番"] === +r.umaban); return x && num(x["着順"]) <= 3; }).length;
  const predEsc = rows.filter(r => styleOf(r) === "逃").map(r => r["horse_name"] || r["馬名"]).filter(Boolean);
  const realEsc = fin.filter(r => r["脚質"] === "逃").map(r => r["馬名"]);
  const t1000p = num(r0["前半1000mの予想"]), t1000 = num(rv["前半1000m"]);
  h += `<div><h4>予想との乖離</h4><dl class="rv">` +
    (p1 ? `<dt>予想1位</dt><dd>${esc(p1.horse_name || "")} → <b>${p1res ? (num(p1res["着順"]) ?? "着外") + "着" : "-"}</b></dd>` : "") +
    (winner ? `<dt>勝ち馬</dt><dd>${esc(winner["馬名"])}: 予想 <b>${rk(winner) ?? "-"}位</b>(勝率 ${pct(num(wp?.["平均_勝率"]))}・${esc(winner["人気"] || "-")}番人気)</dd>` : "") +
    `<dt>予想上位3頭</dt><dd>3着内に <b>${inTop3}頭</b><span class="muted">(1〜3着の予想順位: ${top3.map(r => `${rk(r) ?? "-"}位`).join("・")})</span></dd>` +
    paceGap(r0, rv, t1000, t1000p) + winGap(state.info.get(rid), win) + lapGap(laps, predLaps, pl?.marks || []) + settleGap(rows, top3, n) +
    (r0["ペース予想の目安"] && rv["ペース"] ? `<dt>ペース</dt><dd>予想 ${esc(String(r0["ペース予想の目安"]).split("(")[0])} → 実際 <b>${esc(rv["ペース"])}</b></dd>` : "") +
    `<dt>逃げ</dt><dd>予想 ${esc(predEsc.join("・") || "なし")} → 実際 <b>${esc(realEsc.join("・") || "-")}</b></dd>`;
  const tickets = [["買い目候補", basketOf(rid)], ["推奨買い目(今の予算)", state.planTickets?.[rid] || []]];
  for (const [label, t] of tickets) {
    const x = reviewHits(rid, t);
    if (x.n) h += `<dt>${label}</dt><dd>${x.n}点・${x.cost.toLocaleString()}円 → <b class="${x.back >= x.cost ? "hi" : ""}">${Math.round(x.back).toLocaleString()}円</b>` +
      `(的中 ${x.hit}点・回収率 ${x.cost ? Math.round(x.back / x.cost * 100) : 0}%)</dd>`;
  }
  h += `</dl></div></div>`;
  // 馬ごとの予想と結果
  h += `<div class="scroll"><table class="rvt"><tr><th class="n">着</th><th class="n">馬番</th><th>馬名</th><th class="n">予想</th><th class="n" title="予想順位 − 着順。プラスは予想より上">差</th>` +
    `<th class="n">人気・オッズ</th><th class="n">勝率</th><th class="n" title="1〜2着の確率の合計">2着以内</th><th class="n" title="1〜3着の確率の合計">3着以内</th><th class="n" title="1〜5着の確率の合計">5着以内</th>` +
    `<th class="n">4角 予想→実際</th><th class="n">上がり 予想→実際</th><th>脚質 予想→実際</th></tr>`;
  for (const r of res) {
    const pr = pred.get(String(+r["馬番"])) || {}, k = num(r["着順"]), rank = num(pr["平均_順位"]);
    const d = k != null && rank != null ? rank - k : null;
    const cls = d == null ? "" : d >= 5 ? "up" : d <= -5 ? "down" : "";
    const l3p = num(pr["上がり3Fの予想"]), l3r = num(r["上がり3F"]);
    h += `<tr><td class="n"><b>${k ?? "-"}</b></td><td class="n">${esc(r["馬番"] ?? "")}</td><td>${esc(r["馬名"])}</td><td class="n">${rank ?? "-"}</td>` +
      `<td class="n"><span class="${cls}">${d == null ? "" : (d > 0 ? "+" : "") + d}</span></td>` +
      `<td class="n">${esc(r["人気"] || "-")}人気${num(r["単勝オッズ"]) != null ? ` / ${fix(num(r["単勝オッズ"]))}倍` : ""}</td><td class="n">${pct(num(pr["平均_勝率"]))}</td>` +
      `<td class="n">${pct(upTo(pr, 2))}</td><td class="n">${pct(upTo(pr, 3))}</td><td class="n">${pct(upTo(pr, 5))}</td>` +
      `<td class="n">${num(pr["4角の番手"]) != null ? Math.round(num(pr["4角の番手"])) : "-"}<span class="dim">→</span>${lastPos(r) ?? "-"}</td>` +
      `<td class="n">${l3p != null ? l3p.toFixed(1) : "-"}<span class="dim">→</span>${l3r != null ? l3r.toFixed(1) : "-"}</td>` +
      `<td>${esc(styleOf(pr))}<span class="dim">→</span>${esc(r["脚質"] || "-")}</td></tr>`;
  }
  h += `</table></div><div class="note">予想の質は、勝ち馬に付けていた勝率(対数損失)と、予想順位と着順の順位相関を、` +
    `検証期間(2019〜2023年)の全レースの中で上から何%かの点(0〜100)にして平均したもの。50 がふつうのレース。` +
    `ペースのずれは前半1000m の実際 − 予想(マイナスは予想より速い。±0.3秒以内は「ほぼ予想どおり」、1.0秒を超えると「大きく」)。` +
    `基準は同じ競馬場・芝ダ・距離の過去3年(前日まで)のレース。差は予想順位 − 着順で、緑は予想より5つ以上上、赤は5つ以上下。` +
    `回顧は表示だけで、モデルの学習・評価・選択には使わない。</div>` + hitWhy(rows, res, rv, n) + `</div>`;
  return h;
}
// 当たった・外れた理由(仮)(2026-11-21 ユーザーの指示)。予想と結果の CSV・回顧から、当てはまるものを短い文で並べる(表示だけ。モデルには使わない)
function hitWhy(rows, res, rv, n) {
  const fin = res.filter(r => num(r["着順"]) != null);
  const rowOf = u => res.find(r => +r["馬番"] === +u);
  const p1 = rows.find(r => num(r["平均_順位"]) === 1);
  const p1r = p1 && rowOf(p1.umaban), p1k = p1r ? num(p1r["着順"]) : null;
  const winner = fin.find(r => num(r["着順"]) === 1);
  const wp = winner && rows.find(r => +r.umaban === +winner["馬番"]);
  const top3 = fin.filter(r => num(r["着順"]) <= 3);
  const in3 = rows.filter(r => num(r["平均_順位"]) <= 3).filter(r => { const x = rowOf(r.umaban); return x && num(x["着順"]) <= 3; }).length;
  const why = [];
  // 結論
  const verdict = p1k === 1 ? ["当たり", "hi", "予想1位が1着"] : p1k != null && p1k <= 3 ? ["一部当たり", "", `予想1位は${p1k}着`] :
    ["外れ", "down", `予想1位は${p1k != null ? p1k + "着" : "着外"}`];
  // 展開(前半1000m の予想と実際)
  const t1000p = num(rows[0]?.["前半1000mの予想"]), t1000 = num(rv["前半1000m"]);
  const front = top3.map(lastPos).filter(v => v != null).filter(v => v <= Math.max(3, Math.round(n * 0.25))).length;
  const shape = !top3.length ? "" : front >= 2 ? "前残り" : front === 0 ? "差し・追込" : "";
  if (t1000p != null && t1000 != null) {
    const d = t1000 - t1000p;
    if (Math.abs(d) >= 1.0) why.push(`ペースが予想より${d < 0 ? "速かった" : "遅かった"}(前半1000m 予想 ${t1000p.toFixed(1)}秒 → 実際 ${t1000.toFixed(1)}秒)` +
      (shape === "差し・追込" && d < 0 ? "。速い流れで後ろの馬が届いた" : shape === "前残り" && d > 0 ? "。遅い流れで前の馬が残った" : ""));
    else if (p1k === 1) why.push(`ペースはほぼ予想どおり(前半1000m 予想 ${t1000p.toFixed(1)}秒 → 実際 ${t1000.toFixed(1)}秒)`);
  }
  // 予想1位の走り(位置取り・上がり・展開との相性・馬番)
  if (p1 && p1r) {
    const pos0 = num(p1["4角の番手"]), pos1 = lastPos(p1r), l30 = num(p1["上がり3Fの予想"]), l31 = num(p1r["上がり3F"]);
    if (p1k !== 1) {
      if (pos0 != null && pos1 != null && pos1 - pos0 >= Math.max(3, n * 0.3)) why.push(`予想1位は4角で予想より後ろ(予想 ${Math.round(pos0)}番手 → 実際 ${pos1}番手)。位置取りが響いた可能性`);
      else if (l30 != null && l31 != null && l31 - l30 >= 0.5) why.push(`予想1位は位置はおおむね予想どおりだが、上がりが予想より遅かった(予想 ${l30.toFixed(1)} → 実際 ${l31.toFixed(1)})`);
      if (pos1 != null && shape === "前残り" && pos1 > n / 2) why.push(`前残りの決着で、後ろから行った予想1位(4角 ${pos1}番手)には向かなかった`);
      if (pos1 != null && shape === "差し・追込" && pos1 <= Math.max(3, n * 0.25)) why.push(`差し・追込の決着で、前で運んだ予想1位(4角 ${pos1}番手)には厳しかった`);
    } else if (pos0 != null && pos1 != null && Math.abs(pos1 - pos0) <= 2) why.push(`予想1位は予想どおりの位置(4角 ${pos1}番手)で運べた`);
    const w = num(p1r["増減"]) ?? num(p1["増減"]);
    if (w != null && Math.abs(w) >= 10) why.push(`予想1位の馬体重が大きく変わっていた(${w > 0 ? "+" : ""}${w}kg)`);
  }
  // 馬番の偏り
  const umaPos = top3.map(r => num(r["馬番"]) / n).filter(v => v != null);
  const lane = umaPos.length ? umaPos.reduce((a, b) => a + b) / umaPos.length : null;
  if (lane != null && p1 && p1k !== 1) {
    const mine = +p1.umaban / n;
    if (lane < 0.4 && mine > 0.65) why.push(`内の馬番が上位を占めた中で、予想1位は外の馬番(${p1.umaban}番)だった`);
    if (lane > 0.65 && mine < 0.4) why.push(`外の馬番が上位を占めた中で、予想1位は内の馬番(${p1.umaban}番)だった`);
  }
  // 勝ち馬
  if (winner && wp && p1k !== 1) {
    const wr = num(wp["平均_順位"]), wpr = num(wp["平均_勝率"]);
    if (wpr != null && wpr < 0.05) why.push(`勝ち馬 ${winner["馬名"]} は予想 ${wr ?? "-"}位(勝率 ${pct(wpr)})の穴馬で、予想の上では荒れたレース`);
    else if (wr != null && wr <= 3) why.push(`勝ち馬 ${winner["馬名"]} は予想 ${wr}位で、予想の上位の範囲内`);
  }
  why.push(`予想の上位3頭のうち ${in3}頭が3着以内`);
  // 予想順位と着順が大きくずれた馬(5つ以上)の理由(2026-11-21 ユーザーの指示)
  const gaps = [];
  for (const r of fin) {
    const pr = rows.find(x => +x.umaban === +r["馬番"]);
    const k = num(r["着順"]), rank = pr ? num(pr["平均_順位"]) : null;
    if (k == null || rank == null || Math.abs(rank - k) < 5) continue;
    const up = rank > k, rs = [];
    const pos0 = num(pr["4角の番手"]), pos1 = lastPos(r), l30 = num(pr["上がり3Fの予想"]), l31 = num(r["上がり3F"]);
    if (pos0 != null && pos1 != null && Math.abs(pos1 - pos0) >= Math.max(3, n * 0.3))
      rs.push(`4角が予想より${pos1 < pos0 ? "前" : "後ろ"}(予想 ${Math.round(pos0)}番手 → 実際 ${pos1}番手)`);
    if (l30 != null && l31 != null && Math.abs(l31 - l30) >= 0.5)
      rs.push(`上がりが予想より${l31 < l30 ? "速い" : "遅い"}(予想 ${l30.toFixed(1)} → 実際 ${l31.toFixed(1)})`);
    if (pos1 != null && shape === "前残り") rs.push(pos1 <= Math.max(3, n * 0.25) ? (up ? "前残りの決着で前にいた" : "") : pos1 > n / 2 ? (up ? "" : "前残りの決着で後ろにいた") : "");
    if (pos1 != null && shape === "差し・追込") rs.push(pos1 > n / 2 ? (up ? "差し・追込の決着で後ろにいた" : "") : pos1 <= Math.max(3, n * 0.25) ? (up ? "" : "差し・追込の決着で前にいた") : "");
    const w = num(r["増減"]);
    if (w != null && Math.abs(w) >= 10) rs.push(`馬体重 ${w > 0 ? "+" : ""}${w}kg`);
    const list = rs.filter(Boolean);
    gaps.push({ name: r["馬名"], umaban: r["馬番"], rank, k, up, text: list.length ? list.join("・") : "はっきりした理由は見当たらない(出遅れ・不利など記録に無い要因の可能性)" });
  }
  gaps.sort((a, b) => Math.abs(b.rank - b.k) - Math.abs(a.rank - a.k));
  const gapHtml = !gaps.length ? "" : `<h4 style="margin-top:10px">予想と着順が大きくずれた馬（仮）</h4>` +
    `<ul style="margin:4px 0 0;padding-left:1.4em">${gaps.map(g => `<li><b>${esc(g.name)}</b>(${esc(g.umaban)}番)` +
      ` 予想 ${g.rank}位 → <span class="${g.up ? "up" : "down"}">${g.k}着</span>: ${esc(g.text)}</li>`).join("")}</ul>`;
  return `<div class="rvwhy" style="margin-top:10px"><h4>当たった・外れた理由（仮）</h4>` +
    `<div style="margin-bottom:4px"><span class="chip ${verdict[1]}">${verdict[0]}</span> <span class="muted">${esc(verdict[2])}</span></div>` +
    `<ul style="margin:4px 0 0;padding-left:1.4em">${why.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` + gapHtml +
    `<div class="note">予想と結果(着順・通過順・上がり・馬体重)と回顧のペースを比べて、当てはまりそうなものを並べた仮の理由。大きくずれた馬は、予想順位と着順が5つ以上違った馬。` +
    `<b>出遅れ・道中の不利は記録が無いので反映していない</b>(位置取りは通過順から推し量っただけ)。表示だけで、モデルの学習・評価・選択には使わない。</div></div>`;
}

// 右側の結果の欄(結果の CSV があるレースだけ)
function renderResult(rid) {
  const box = document.getElementById("result");
  const res = state.results.get(rid);
  document.body.classList.toggle("has-result", !!res);
  if (!res) { box.innerHTML = ""; return; }
  const pred = new Map((state.races.get(rid) || []).map(r => [String(+r.umaban), num(r["平均_順位"])]));
  const sep = t => t === "馬単" || t === "3連単" ? "→" : "-";
  let h = `<div class="res-top"><b>結果</b><span class="muted">${esc(title(rid))}</span>${updTag(["結果", "払戻"], rid)}` +
    `<button id="resClose" title="結果の欄をたたむ">→</button></div><div class="scroll"><table class="res">` +
    `<tr><th class="n">着</th><th class="n">馬番</th><th>馬名</th><th class="n" title="予想の順位">予</th><th class="n">タイム</th>` +
    `<th class="n">差</th><th class="n">通過</th><th class="n">上3F</th><th class="n">人気</th><th class="n">単勝</th></tr>`;
  for (const r of res) {
    const k = num(r["着順"]), pr = pred.get(String(+r["馬番"]));
    h += `<tr class="${k != null && k <= 3 ? "in" : ""}"><td class="n"><b>${k ?? "-"}</b></td><td class="n">${esc(r["馬番"])}</td>` +
      `<td title="${esc(r["騎手"] || "")}">${esc(r["馬名"])}</td><td class="n">${pr ?? ""}</td><td class="n">${esc(r["走破タイム"] || "")}</td>` +
      `<td class="n">${r["タイム差"] !== "" && r["タイム差"] != null ? fix(num(r["タイム差"])) : ""}</td><td class="n">${esc(r["通過"] || "")}</td>` +
      `<td class="n">${r["上がり3F"] ? fix(num(r["上がり3F"])) : ""}</td><td class="n">${esc(r["人気"] || "")}</td>` +
      `<td class="n">${r["単勝オッズ"] ? fix(num(r["単勝オッズ"])) : ""}</td></tr>`;
  }
  h += `</table></div>`;
  const pays = state.pays.get(rid) || [];
  if (pays.length) {
    h += `<table class="res pay"><tr><th>券種</th><th>組</th><th class="n">払戻</th><th class="n">人気</th></tr>`;
    let last = "";
    for (const p of pays) {
      const t = p["券種"];
      h += `<tr><td>${t !== last ? esc(t) : ""}</td><td>${esc(String(p["組み合わせ"]).split("-").join(sep(t)))}</td>` +
        `<td class="n">${(num(p["払戻金"]) ?? 0).toLocaleString()}円</td><td class="n">${esc(p["人気"] || "")}</td></tr>`;
      last = t;
    }
    h += `</table>`;
  }
  box.innerHTML = h + `<div class="note">着順・タイム・人気・単勝オッズ・払戻は DB の結果(表示用)。「予」は予想の順位。</div>`;
  const resClose = document.getElementById("resClose");
  resClose.textContent = window.matchMedia("(max-width: 760px)").matches ? (document.body.classList.contains("result-closed") ? "＋" : "−") : "→";
  resClose.onclick = () => {
    if (window.matchMedia("(max-width: 760px)").matches) document.body.classList.toggle("result-closed");
    else document.body.classList.add("result-closed");
    try { localStorage.setItem("keiba-viewer:result-closed", document.body.classList.contains("result-closed") ? "1" : "0"); } catch (e) {}
    resClose.textContent = window.matchMedia("(max-width: 760px)").matches ? (document.body.classList.contains("result-closed") ? "＋" : "−") : "→";
  };
}

function title(rid) {
  return `${JYO[rid.slice(8, 10)] || rid.slice(8, 10)} ${+rid.slice(14, 16)}R`;
}
function ymdw(d) {
  // "20261101" → "2026/11/01(日)"
  const day = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)).getDay();
  const w = "日月火水木金土"[day];
  const tone = day === 6 ? "weekday-sat" : day === 0 ? "weekday-sun" : "";
  return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}(<span class="${tone}">${w}</span>)`;
}
function hhmm(t) {
  const s = String(t ?? "").replace(/\D/g, "");
  if (!s) return "";
  const v = s.padStart(4, "0");
  return `${v.slice(0, 2)}:${v.slice(2, 4)}`;
}
function bandShort(b) { return (b || "").replace("上位", ""); }
function bandTone(b) {
  const top = parseFloat(bandShort(b)); // 「5〜10%」→ 5
  if (isNaN(top)) return "gray";
  return top < 10 ? "up" : top < 30 ? "" : top < 60 ? "gray" : "warn";
}
function avgBand(rows) {
  const ms = models(rows); const r = rows[0];
  const bands = ms.map(m => r[`${m}_自信の区分`]).filter(Boolean);
  const cnt = {}; bands.forEach(b => cnt[b] = (cnt[b] || 0) + 1);
  return Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

// レースページの見出し(11/28 ユーザーの指示): 発走のランプ・PC ではレース名・前後のレースへのボタン・競馬場の切り替え
function sameDayJyo(rid) {
  return [...state.races.keys()].filter(x => x.slice(0, 10) === rid.slice(0, 10)).sort((a, b) => a.slice(14).localeCompare(b.slice(14)));
}
function raceHead(rid) {
  const list = sameDayJyo(rid), i = list.indexOf(rid), prev = list[i - 1] || "", next = list[i + 1] || "";
  const jyos = [...new Set([...state.races.keys()].filter(x => x.slice(0, 8) === rid.slice(0, 8)).map(x => x.slice(8, 10)))].sort();
  const sel = jyos.length > 1 ? `<select class="rhJyo" onclick="event.stopPropagation()" title="競馬場を変える(同じR。無ければ近いR)">` +
    jyos.map(j => `<option value="${j}"${j === rid.slice(8, 10) ? " selected" : ""}>${esc(JYO[j] || j)}</option>`).join("") + `</select>` : esc(JYO[rid.slice(8, 10)] || "");
  const btn = (to, s, t) => `<button class="rhMove" data-to="${to}" ${to ? "" : "disabled"} title="${t}">${s}</button>`;
  const rname = state.info.get(rid)?.["レース名"] || "";
  return `<span class="lamp" data-lamp="${rid}" data-prev="${prev}"></span>${btn(prev, "◀", "前のレース")}${sel} ${+rid.slice(14, 16)}R${btn(next, "▶", "次のレース")}` +
    (rname ? `<span class="rh-name">${esc(rname)}</span>` : "");
}
function bindRaceHead(rid) {
  const go = to => { if (!to) return; state.current = to; state.open.clear(); render(); window.scrollTo(0, 0); };
  document.querySelectorAll("button.rhMove").forEach(b => b.onclick = e => { e.stopPropagation(); go(b.dataset.to); });
  document.querySelectorAll("select.rhJyo").forEach(s => s.onchange = () => {
    const list = [...state.races.keys()].filter(x => x.slice(0, 8) === rid.slice(0, 8) && x.slice(8, 10) === s.value);
    const r = +rid.slice(14, 16);
    go(list.sort((a, b) => Math.abs(+a.slice(14, 16) - r) - Math.abs(+b.slice(14, 16) - r))[0]);
  });
  updateLamps();
}
function renderNav() {
  const nav = document.getElementById("nav");
  let html = `<div class="nav-top"><span class="muted">レース一覧</span><button id="navClose" title="レース一覧を開閉">${window.matchMedia("(max-width: 760px)").matches ? (document.body.classList.contains("mobile-nav-collapsed") ? "＋" : "−") : "←"}</button></div>`,
    lastDay = "", lastJyo = "";
  // 日付は新しい順、同じ日付内の競馬場・発走順は従来どおり
  const byDayJyo = {};
  for (const rid of sortedRaces()) {
    const k = rid.slice(0, 8) + rid.slice(8, 10);
    (byDayJyo[k] = byDayJyo[k] || []).push(rid);
  }
  const days = [...new Set(Object.keys(byDayJyo).map(k => k.slice(0, 8)))].sort((a, b) => b.localeCompare(a));
  // 携帯: 日付の並びはそのままで、競馬場は日付ごとに横並びのタブにする(選んだ場のレースだけ出す。2026-11-15 ユーザーの指示)
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  state.navJyo = state.navJyo || {};
  // 日付の行: 押すとその日のレースをたたむ・開く。日別ページは右の「日別」ボタンで開く(2026-11-16 ユーザーの指示)
  const dayRow = day => {
    const shut = folded(`day:${day}`);
    return `<div class="day day-row fold-h${state.dayPage === day ? " on" : ""}" data-fold="day:${day}" title="押すとこの日のレースをたたむ・開く">` +
      `<span>${shut ? "▸" : "▾"} ${ymdw(day)}</span><button class="day-page-btn" data-day="${day}" title="${day}の日別ページを表示">日別</button></div>`;
  };
  for (const day of days) {
    let dayKeys = Object.keys(byDayJyo).filter(k => k.slice(0, 8) === day).sort();
    html += dayRow(day);
    lastDay = day;
    if (folded(`day:${day}`)) continue;
    if (mobile) {
      const cur = state.current && state.current.slice(0, 8) === day ? day + state.current.slice(8, 10) : "";
      if (cur && state.navJyoSeen !== state.current) state.navJyo[day] = cur;   // ほかの所からレースを開いたら、そのレースの場のタブにする
      if (!dayKeys.includes(state.navJyo[day])) state.navJyo[day] = cur || dayKeys[0];
      html += `<div class="tabs jyo-tabs">` + dayKeys.map(k => `<button data-navjyo="${k}" class="${state.navJyo[day] === k ? "on" : ""}">${JYO[k.slice(8)] || k.slice(8)}</button>`).join("") + `</div>`;
      dayKeys = [state.navJyo[day]];
    }
    for (const k of dayKeys) {
      const jyo = k.slice(8);
      const jyoShut = !mobile && folded(`jyo:${k}`);
      if (!mobile) html += `<div class="jyo fold-h" data-fold="jyo:${k}">${jyoShut ? "▸" : "▾"} ${JYO[jyo] || jyo}</div>`;
      if (jyoShut) continue;
      byDayJyo[k].sort((a, b) => a.slice(14).localeCompare(b.slice(14)));
      byDayJyo[k].forEach((rid, ri) => {
      const rows = state.races.get(rid), r = rows[0], c = confLevel(rows), x = num(r["混戦の段階"]);
      const prev = ri > 0 ? byDayJyo[k][ri - 1] : "";
      html += `<a data-rid="${rid}" class="${state.current === rid ? "on" : ""}"><span class="lamp" data-lamp="${rid}" data-prev="${prev}"></span><span class="r">${+rid.slice(14, 16)}R</span>` +
        `<span class="t">${hhmm(r.hasso_time)}</span><span class="tag">` +
        (c ? `<span class="chip ${c.lv >= 7 ? "up" : c.lv <= 3 ? "gray" : ""}" title="自信 ${c.score}/100(10段階で ${c.lv}・${CONF_WORDS[c.lv]})">自信${c.score}</span>` : "") +
        (x ? ` <span class="chip ${x >= 7 ? "warn" : "gray"}" title="混戦 ${mixScore(r, x)}/100(10段階で ${x}・${MIX_WORDS[x]})">混戦${mixScore(r, x)}</span>` : "") +
        (changeView() && honmeiChanged(rows) ? ` <span class="chip warn" title="枠順確定の時点と馬体重の版で本命が変わった">本命変更</span>` : "") +
        navQuality(rid, rows) + `</span></a>`;
      });
    }
  }
  state.navJyoSeen = state.current;
  nav.innerHTML = html;
  updateLamps();
  nav.querySelectorAll("button[data-day]").forEach(a => a.onclick = e => { e.stopPropagation(); if (window.matchMedia("(max-width: 760px)").matches) document.body.classList.add("mobile-nav-collapsed"); state.dayPage = a.dataset.day; state.open.clear(); render(); });
  nav.querySelectorAll("a[data-rid]").forEach(a => a.onclick = () => { if (window.matchMedia("(max-width: 760px)").matches) document.body.classList.add("mobile-nav-collapsed"); state.dayPage = null; state.current = a.dataset.rid; state.open.clear(); render(); });
  nav.querySelectorAll(".fold-h").forEach(d => d.onclick = () => { toggleFold(d.dataset.fold); renderNav(); });
  nav.querySelectorAll("button[data-navjyo]").forEach(b => b.onclick = () => { state.navJyo[b.dataset.navjyo.slice(0, 8)] = b.dataset.navjyo; renderNav(); });
  document.getElementById("navClose").onclick = () => document.getElementById("navToggle").click();
}

// ---------- レース一覧のランプ(2026-11-22 ユーザーの指示) ----------
// 締め切り = 発走の2分前(JRA の発売締め切り)。前のレースの締め切り(1R は朝 9:00)から: 締め切り15分前までは緑の点灯、
// 15分前〜10分前は緑の点滅、10分前〜5分前はオレンジの点滅、5分前〜締め切りは赤の点滅、締め切りから5分(レース中)は赤の点灯。ほかは消す
const LAMP_CLOSE = 2;
function raceDeadline(rid) {
  const r = state.races.get(rid)?.[0], hm = String(r?.hasso_time ?? "").padStart(4, "0");
  if (!/^\d{4}$/.test(hm)) return null;
  const d = new Date(+rid.slice(0, 4), +rid.slice(4, 6) - 1, +rid.slice(6, 8), +hm.slice(0, 2), +hm.slice(2, 4));
  return new Date(d.getTime() - LAMP_CLOSE * 60000);
}
function lampState(rid, prev, now = new Date()) {
  const dl = raceDeadline(rid);
  if (!dl) return "";
  const start = prev ? raceDeadline(prev) : new Date(dl.getFullYear(), dl.getMonth(), dl.getDate(), 9, 0);
  const m = (dl - now) / 60000;
  if (m < -5 || (start && now < start)) return "";
  if (m < 0) return "rs";        // レース中(締め切りから5分)
  if (m <= 5) return "rb";
  if (m <= 10) return "ob";
  if (m <= 15) return "gb";
  return "gs";
}
const LAMP_TIP = { gs: "発売中(締め切りまで15分より前)", gb: "締め切り15分前", ob: "締め切り10分前", rb: "締め切り5分前", rs: "レース中(締め切りから5分)" };
function updateLamps() {
  const now = new Date();
  document.querySelectorAll(".lamp[data-lamp]").forEach(l => {
    const st = lampState(l.dataset.lamp, l.dataset.prev, now);
    l.className = "lamp" + (st ? " lamp-" + st : "");
    l.title = st ? LAMP_TIP[st] : "";
  });
}
setInterval(updateLamps, 15000);

// ---------- 折りたたみ(レース一覧の開催日・競馬場、レースのカード。このブラウザに覚えておく) ----------
function foldSet() {
  if (!state.folds) {
    try { state.folds = new Set(JSON.parse(localStorage.getItem("keiba-viewer:folds") || "[]")); } catch (e) { state.folds = new Set(); }
  }
  return state.folds;
}
function folded(key) { return foldSet().has(key); }
function toggleFold(key) {
  const f = foldSet();
  f.has(key) ? f.delete(key) : f.add(key);
  try { localStorage.setItem("keiba-viewer:folds", JSON.stringify([...f])); } catch (e) {}
}
function setupHelpButtons(root) {
  root.querySelectorAll("button.help[data-help='baba']").forEach(b => b.onclick = openBabaHelp);
  root.querySelectorAll("button.help[data-help='viz']").forEach(b => b.onclick = e => {   // 2026-11-22 ユーザーの指示: モーダルで出す(PC も同じ画面の中)
    e.stopPropagation();
    document.getElementById("guideTitle").textContent = "ビジュアライズ予想の見方";
    document.getElementById("guideBody").innerHTML = vizHelpHTML();
    const d = document.getElementById("guide");
    if (!d.open) d.showModal();
  });
}
const MOBILE_SHUT = /^card:(展開予想|馬場傾向予想|枠順確定)/;   // 枠順確定 → 馬体重の変化 も(2026-11-16)
// 「個別馬の予想は折りたたむ」(11/28 ユーザーの指示): ✓のとき、個別レースのビジュアライズ予想・出走馬も最初はたたむ(このブラウザに覚えておく)
function foldHorses() { try { return localStorage.getItem("keiba-viewer:foldHorses") === "1"; } catch (e) { return !!state.foldHorses; } }
document.addEventListener("change", e => {
  if (e.target?.id !== "foldHorses") return;
  state.foldHorses = e.target.checked;
  try { localStorage.setItem("keiba-viewer:foldHorses", e.target.checked ? "1" : "0"); } catch (err) {}
  if (state.current && !state.dayPage) keepScroll(() => renderRace(state.current));
});
{ const setFH = () => { const c = document.getElementById("foldHorses"); if (c) c.checked = foldHorses(); }; setFH(); document.addEventListener("DOMContentLoaded", setFH); }
function setupCardFolds(root, sel = ".card", shutByDefault = false) {
  // shutByDefault: 個別レースのページでは、レース概要(h2 の見出し)・出走馬・ビジュアライズ予想のほかは、PC も最初はたたんでおく
  // (2026-11-22 ユーザーの指示)。開いたことは携帯と同じ「mopen:」で覚える
  if (!state.mobileOpen || state.mobileOpenRid !== state.current) { state.mobileOpen = new Set(); state.mobileOpenRid = state.current; }
  // カードの見出し(h2・h3)を押すとたたむ。たたんだ見出しはどのレースでも同じ(見出しの文字で覚える)。sel でたためるカードを絞れる
  root.querySelectorAll(sel).forEach(card => {
    const head = card.querySelector("h2, h3");
    if (!head) return;
    // 見出しの「更新 HH:MM」・ボタン・かっこの中(並び順・件数など)は入れない。更新やレースの切り替えで変わらないように(2026-11-21 ユーザーの指示)
    const hc = head.cloneNode(true);
    hc.querySelectorAll(".sec-upd, button, .fold-mark").forEach(x => x.remove());
    const titleKey = "card:" + hc.textContent.replace(/\s+/g, "").replace(/[(（][^)）]*[)）]/g, "").replace(/^[▾▸]/, "").replace(/？$/, "").slice(0, 20);
    // data-fold があるカードはその名前で覚え、同じ名前のカードはいっしょに開け閉めする(馬場傾向予想と展開予想。2026-11-22 ユーザーの指示)
    const key = card.dataset.fold ? "card:" + card.dataset.fold : titleKey;
    // 携帯: 展開予想・馬場傾向予想は、レースを開いたときはたたんでおく(開いたのはそのレースを見ているあいだだけ。2026-11-15 ユーザーの指示)
    const mob = MOBILE_SHUT.test(titleKey) && window.matchMedia("(max-width: 760px)").matches;
    // 携帯でも開いたことを覚えておき、どのレースでも同じにする(2026-11-21 ユーザーの指示。前はそのレースを見ているあいだだけ)
    const dflt = card.dataset.shut === "1" || mob || (shutByDefault && head.tagName !== "H2" && !(foldHorses() ? /^card:レース回顧/ : /^card:(出走馬|ビジュアライズ予想|レース回顧)/).test(titleKey));
    const isShut = () => dflt ? !folded("mopen:" + key) : folded(key);
    head.classList.add("fold-card");
    head.insertAdjacentHTML("afterbegin", `<span class="fold-mark">${isShut() ? "▸" : "▾"}</span>`);
    card.classList.toggle("folded", isShut());
    card._foldRefresh = () => { card.classList.toggle("folded", isShut()); head.querySelector(".fold-mark").textContent = isShut() ? "▸" : "▾"; };
    head.onclick = e => {
      e.stopPropagation();
      toggleFold(dflt ? "mopen:" + key : key);
      const same = card.dataset.fold ? [...root.querySelectorAll(`[data-fold="${card.dataset.fold}"]`)] : [card];
      same.forEach(c => c._foldRefresh ? c._foldRefresh() : null);
    };
  });
}

// V3(11/23 ユーザーの指示): 時計(勝ちタイム)の、例年の同開催・前週・馬場状態ごとの傾向(時計の比べ.csv。基準との差 %)
function clockCompare(rid) {
  const rows = state.clockCmp?.get(String(rid).slice(0, 8));
  if (!rows) return "";
  const inf = state.info.get(rid) || {};
  const surf = String(inf["芝ダ"] || "").startsWith("芝") ? "芝" : "ダート";
  const c = rows.find(x => String(x.jyo_cd).padStart(2, "0") === String(rid).slice(8, 10) && x["芝ダ"] === surf);
  if (!c) return "";
  const p = v => v == null ? "-" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;
  const same = num(c["時計_例年同開催"]), wk = num(c["時計_前週"]);
  const wd = String(c["時計_前週_日付"] || "").split("・").filter(Boolean).map(d => `${+d.slice(4, 6)}/${+d.slice(6, 8)}`).join("・");
  const cur = String(inf["馬場"] || inf["馬場状態"] || "");
  const states = ["良", "稍重", "重", "不良"].map(s => {
    const v = num(c[`時計_${s}`]), n = num(c[`時計_${s}_レース数`]) || 0;
    const on = cur && cur.includes(s) && (s !== "重" || !cur.includes("稍"));
    return `<span class="${n < 20 ? "dim" : ""}"${on ? ' style="font-weight:700;text-decoration:underline"' : ""}>${s} ${p(v)}<small>(${n})</small></span>`;
  }).join("・");
  return `<div class="pace"><div class="pl">時計の比べ</div><div>` +
    `<div>例年の同開催 <b>${p(same)}</b> <span class="muted">(${num(c["時計_例年同開催_年数"]) || 0}年・${num(c["時計_例年同開催_レース数"]) || 0}レース)</span>` +
    `・前週 <b>${p(wk)}</b> <span class="muted">(${wd || "なし"}・${num(c["時計_前週_レース数"]) || 0}レース)</span></div>` +
    `<div>馬場状態ごと(過去3年): ${states}</div>` +
    `<div class="note" style="margin:0">+ は基準より遅い(時計がかかる)。例年の同開催・前週は勝ちタイムの予想と同じ基準(同じ競馬場・芝ダ・距離・馬場状態の前日までの3年の平均)との差。` +
    `馬場状態ごとは、同じ競馬場・芝ダの過去3年のレースを、馬場状態を問わない基準と比べた平均(かっこはレース数。20未満は薄く)</div></div></div>`;
}
// V2(11/23・11/28 ユーザーの指示): 含水率・クッション値の通年平均・例年の同開催との差と、前回の開催日からの降水量・平均気温(例年も)
function babaCompare(rid) {
  const rows = state.babaCmp?.get(String(rid).slice(0, 8));
  if (!rows) return "";
  const surf = String(state.info.get(rid)?.["芝ダ"] || "").startsWith("芝") ? "芝" : "ダート";
  const c = rows.find(x => String(x.jyo_cd).padStart(2, "0") === String(rid).slice(8, 10) && x["芝ダ"] === surf);
  if (!c) return "";
  const d = (v, base, unit = "") => v == null || base == null ? "" : `${v - base >= 0 ? "+" : "−"}${Math.abs(v - base).toFixed(1)}${unit}`;
  const line = (label, v, all, same, ny, unit, u2) => v == null ? "" :
    `<div>${label} ${v.toFixed(1)}${unit}<span class="muted">(通年平均 ${all == null ? "-" : all.toFixed(1) + unit} との差 ${d(v, all, u2) || "-"}・例年の同開催 ${same == null ? "-" : same.toFixed(1) + unit} との差 ${d(v, same, u2) || "-"}、${ny}年分)</span></div>`;
  const m = line(`含水率(${surf}・ゴール前)`, num(c["含水率"]), num(c["含水率_通年平均"]), num(c["含水率_例年同開催"]), num(c["含水率_例年の年数"]) || 0, "%", "ポイント");
  const k = surf === "芝" ? line("クッション値", num(c["クッション値"]), num(c["クッション値_通年平均"]), num(c["クッション値_例年同開催"]), num(c["クッション値_例年の年数"]) || 0, "", "") : "";
  const st = String(c["前回の開催日の翌日"] || ""), from = st.length === 8 ? `${+st.slice(4, 6)}/${+st.slice(6, 8)}` : "";
  const rain = num(c["降水量"]), rainY = num(c["降水量_例年"]), temp = num(c["平均気温"]), tempY = num(c["平均気温_例年"]), wy = num(c["天気_例年の年数"]) || 0;
  const w = rain == null && temp == null ? "" : `<div>前回の開催日の翌日(${from})〜前日: 降水量 ${rain == null ? "-" : rain.toFixed(1) + "mm"}<span class="muted">(例年 ${rainY == null ? "-" : rainY.toFixed(1) + "mm"})</span>・平均気温 ${temp == null ? "-" : temp.toFixed(1) + "℃"}<span class="muted">(例年 ${tempY == null ? "-" : tempY.toFixed(1) + "℃"}、${wy}年分)</span></div>`;
  if (!m && !k && !w) return "";
  return `<div class="pace"><div class="pl">馬場の比べ</div><div>${m}${k}${w}<div class="note" style="margin:0">通年平均は前日までの3年間の開催日の計測、例年の同開催は過去の年の同じ回次・日次(計測は2018年7月から)。` +
    `降水量・気温は気象庁の近くの観測所の値で、例年は過去の年の同じ回次・日次について同じ決め方の期間の値</div></div></div>`;
}
function babaMeasurement(r) {
  const goal = num(r?.["含水率_ゴール前"]), corner = num(r?.["含水率_4角"]), cushion = num(r?.["クッション値"]);
  const moistDiff = num(r?.["含水率_前日までの平均差"]), cushionDiff = num(r?.["クッション値_前日までの平均差"]);
  if (goal == null && corner == null && cushion == null) return "";
  const diff = (v, unit = "") => v == null ? "" : ` <span class="muted">(前日までの平均差 ${v >= 0 ? "+" : ""}${v.toFixed(1)}${unit})</span>`;
  const moist = goal == null && corner == null ? "" : `含水率 ゴール前 ${goal == null ? "-" : goal.toFixed(1) + "%"}・4角 ${corner == null ? "-" : corner.toFixed(1) + "%"}${diff(moistDiff, "ポイント")}`;
  const cush = cushion == null ? "" : `クッション値 ${cushion.toFixed(1)}${diff(cushionDiff)}`;
  return `<div class="pace"><div class="pl">馬場の計測値</div><div>${[moist, cush].filter(Boolean).join("<br>")}<div class="note" style="margin:0">含水率はこのレースの芝・ダート、平均差は同じ競馬場の前日までの計測平均との比較。</div></div></div>`;
}
function bar(v, max, cls = "") {
  const w = max > 0 && v != null ? Math.max(2, v / max * 100) : 0;
  return `<div class="bar ${cls}"><i style="width:${w}%"></i><span>${pct(v)}</span></div>`;
}
function finBar(r) {
  const cols = ["--f1", "--f2", "--f3", "--f4", "--f5"];
  let s = "", tip = [];
  for (let k = 1; k <= 5; k++) {
    const v = num(r[`${k}着の確率`]); if (v == null) continue;
    s += `<i class="${k >= 4 ? "out" + (k === 4 ? " first" : "") : ""}" style="width:${v * 100}%;background-color:var(${cols[k - 1]})"></i>`;
    tip.push(`${k}着 ${pct(v)}`);
  }
  const top3 = [1, 2, 3].reduce((a, k) => a + (num(r[`${k}着の確率`]) ?? 0), 0);
  return s ? `<div class="fin" title="${tip.join(" / ")}(馬券内 = 3着内 ${pct(top3)})">${s}</div>` : "";
}
function placeBar(top2, top3, max) {
  const w3 = max > 0 && top3 != null ? Math.max(2, top3 / max * 100) : 0;
  const w2 = max > 0 && top2 != null ? Math.max(0, top2 / max * 100) : 0;
  return `<div class="bar place-bar" title="2着内 ${pct(top2)} / 3着内 ${pct(top3)}"><i class="place-top3" style="width:${w3}%"></i><i class="place-top2" style="width:${w2}%"></i><span>2着内 ${pct(top2)} / 3着内 ${pct(top3)}</span></div>`;
}
function parseReasons(text) {
  const out = []; const re = /(.*?)\(([+-]\d+(?:\.\d+)?)\)(?:・|$)/g; let m;
  while ((m = re.exec(text || "")) && m[0]) out.push([m[1], +m[2]]);
  return out;
}
const CATS = ["能力", "適性", "調子", "人", "展開"];
function catChips(r) {
  // 総合・能力・適性・調子・人・展開を2行で出す。1行目は相対値(このレースの中)、2行目は絶対値(検証期間の全出走馬の中)。
  // それぞれ星・点(0〜100)・確度。確度が低いものは薄く出す
  const stars = n => `<span class="stars">${"★".repeat(n)}<span class="dim">${"★".repeat(5 - n)}</span></span>`;
  const cats = ["総合", ...CATS].filter(c => num(r[`${c}_星`]) != null);
  if (!cats.length) return "";
  const cell = (c, st, pts, tip) => {
    const conf = r[`${c}_確度`] || "";
    return `<span class="cat conf-${conf}${c === "総合" ? " total" : ""}" title="${esc(tip)}"><b>${c}</b>${stars(st)}` +
      `<span class="cp">${pts ?? ""}</span><span class="cf">${esc(conf)}</span></span>`;
  };
  const rel = cats.map(c => cell(c, num(r[`${c}_星`]), num(r[`${c}_相対点`]),
    `${c}(相対): このレースで${r[`${c}_順位`]}位、点 ${r[`${c}_相対点`] ?? "-"}(1位が100・最下位が0)、レースの平均との差 ${r[`${c}_点`]}、確度 ${r[`${c}_確度`] || "-"}`));
  const hasAbs = cats.some(c => num(r[`${c}_絶対点`]) != null);
  const abs = hasAbs ? cats.map(c => cell(c, num(r[`${c}_絶対星`]) ?? 1, num(r[`${c}_絶対点`]),
    `${c}(絶対): 検証期間(2019〜2023年)の全出走馬の中で ${r[`${c}_絶対点`] ?? "-"}(上位 ${100 - (num(r[`${c}_絶対点`]) ?? 0)}%)、確度 ${r[`${c}_確度`] || "-"}`)) : [];
  return `<div class="cats2"><span class="cl">相対値</span><div class="cats">${rel.join("")}</div>` +
    (hasAbs ? `<span class="cl">絶対値</span><div class="cats">${abs.join("")}</div>` : "") + `</div>`;
}
function oddsTimes(v) { return Math.exp(v).toFixed(2); }
function reasonText(text) {
  // 「騎手の成績(+0.51)」→「騎手の成績(+0.51 ≒ ×1.67)」
  return parseReasons(text).map(([n, v]) => `${esc(n)}(${v >= 0 ? "+" : ""}${v.toFixed(2)} ≒ ×${oddsTimes(v)})`).join("・");
}
function reasonChips(r) {
  const tip = v => `点数の差 ${v >= 0 ? "+" : ""}${v}(勝つ見込みを約 ×${oddsTimes(v)})`;
  const val = v => `<span class="rv">${v >= 0 ? "+" : ""}${v.toFixed(2)}(×${oddsTimes(v)})</span>`;
  const up = parseReasons(r["根拠_上げた"]).map(([n, v]) => `<span class="chip up" title="${tip(v)}">▲ ${esc(n)} ${val(v)}</span>`);
  const dn = parseReasons(r["根拠_下げた"]).map(([n, v]) => `<span class="chip down" title="${tip(v)}">▼ ${esc(n)} ${val(v)}</span>`);
  return up.length || dn.length ? `<div class="reasons">${up.join("")}${dn.join("")}</div>` : "";
}

function renderRace(rid) {
  const base = [...state.races.get(rid)];
  const fav = favModels(base);
  const favoriteReady = canFavorite(base, fav);
  state.favActive = favoriteReady && favView();
  const rows = (state.favActive ? favRows(base, fav) : base).sort((a, b) =>
    (num(a["オッズで取消"]) === 1 ? 1 : 0) - (num(b["オッズで取消"]) === 1 ? 1 : 0) || (num(a["平均_順位"]) ?? Infinity) - (num(b["平均_順位"]) ?? Infinity));
  const ms = state.favActive ? fav : models(rows), r0 = rows[0];
  // 得意モデルのみの予想を表示するチェック(展開予想と出走馬の欄の両方に出す。どちらで切り替えても同じ)
  const favBox = !fav.length ? "" :
    `<label class="muted fav-box" style="font-size:13px" title="このレースの条件が得意なモデル: ${esc(r0["得意な条件"] || fav.join("・"))}">` +
    `<input type="checkbox" class="favView" ${state.favActive ? "checked" : ""} ${favoriteReady ? "" : "disabled"}> 得意モデルのみの予想を表示</label>`;
  const favNote = state.favActive ? `<div class="note fav-note">得意モデル(${esc(fav.join("・"))})だけの平均で出しています` +
    `(${esc(r0["得意な条件"] || "")})。推奨買い目・組み合わせ・自信の段階・混戦の段階・確度は6モデルの平均のまま。</div>` : "";
  const maxWin = Math.max(...rows.map(r => num(r["平均_勝率"]) || 0));
  // 2着内・3着内: 専門モデル(U20)を重ねた 平均_2着内・平均_3着内 があればそれ(得意モデルだけの平均を出しているときはモデルの平均)
  const stacked = (r, k) => num(r[`平均_${k}`]);
  const top3 = r => { if (num(r["オッズで取消"]) === 1) return null; const s = stacked(r, "3着内"); if (s != null) return s; const v = ms.map(m => num(r[`${m}_3着内`])).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b) / v.length : null; };
  const top2 = r => { if (num(r["オッズで取消"]) === 1) return null; const s = stacked(r, "2着内"); if (s != null) return s; const v = ms.map(m => num(r[`${m}_2着内`])).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b) / v.length : null; };
  const maxTop3 = Math.max(...rows.map(r => top3(r) || 0));
  const has = c => c in r0;

  // 見出し
  let html = `<div class="card"><h2>${title(rid)} <span class="muted" style="font-size:14px;font-weight:400">` +
    `${ymdw(rid.slice(0, 8))} 発走 ${hhmm(r0.hasso_time)}・${rows.length}頭</span>` +
    // netkeiba の同じレース(別のタブで開く。2026-11-22 ユーザーの指示)。見出しを押したときのたたむ動きはさせない
    ` <a class="nk-link" href="https://race.netkeiba.com/race/${state.results.has(rid) ? "result" : "shutuba"}.html?race_id=${nkRaceId(rid)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="netkeiba の${state.results.has(rid) ? "結果" : "出馬表"}を別のタブで開く">netkeiba ↗</a></h2>${overview(rid)}` +
    `<div class="meters">${confMeter(rows)}${mixMeter(rows)}</div></div>` + renderReview(rid, rows);

  // モデルごとの自信
  const roiOf = m => Object.fromEntries((r0[`${m}_区分の回収率`] || "").split(" / ").filter(Boolean)
    .map(s => { const i = s.lastIndexOf(" "); return [s.slice(0, i), parseFloat(s.slice(i + 1))]; }));
  const bets = [...new Set(ms.flatMap(m => Object.keys(roiOf(m))))];
  // モデルごとの自信と区分の回収率(カードの一番下に出す)
  let modelCard = `<div class="card"><h3>モデルごとの自信と、その区分の過去の回収率${updTag("予想", rid)}</h3><div class="scroll"><table>` +
    `<tr><th>モデル</th><th>区分</th>${bets.map(b => `<th class="n">${esc(b)}</th>`).join("")}</tr>`;
  // 総合の行(2026-11-28 ユーザーの指示「自信の区分ごとの回収率みたいに総合を」): 6モデルの平均の自信の上位%から区分を決め、
  // 自信の区分ごとの回収率.csv の「総合」の行の回収率を出す
  {
    const c = confLevel(rows), top = c?.top;
    const edges = [5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 101];
    const labels = ["上位5%", "上位5〜10%", "上位10〜15%", "上位15〜20%", "上位20〜30%", "上位30〜40%", "上位40〜50%", "上位50〜60%", "上位60〜70%", "上位70〜80%", "上位80〜90%", "上位90〜100%"];
    const lab = top == null ? null : labels[edges.findIndex(e => top < e)] ?? labels[labels.length - 1];
    const br = lab && (state.band || []).find(x => x["モデル"] === "総合" && x["自信の区分"] === lab);
    if (br) modelCard += `<tr style="font-weight:600"><td style="font-size:12px">総合(6モデルの平均)</td><td><span class="chip ${bandTone(lab)}" title="上位 ${fix(top)}%${c.exact ? "" : "(各モデルの平均で代用)"}">${esc(bandShort(lab))}</span></td>` +
      bets.map(b => { const v = num(br[`${b}_回収率`]); return `<td class="n"><span class="${v >= 100 ? "hi" : ""}">${v == null ? "" : fix(v) + "%"}</span></td>`; }).join("") + `</tr>`;
  }
  for (const m of ms) {
    const roi = roiOf(m);
    modelCard += `<tr><td style="font-size:12px">${esc(m)}</td><td><span class="chip ${bandTone(r0[`${m}_自信の区分`])}" ` +
      `title="上位 ${fix(num(r0[`${m}_自信の上位%`]))}%">${esc(bandShort(r0[`${m}_自信の区分`]))}</span></td>` +
      bets.map(b => `<td class="n"><span class="${roi[b] >= 100 ? "hi" : ""}">${roi[b] == null ? "" : roi[b] + "%"}</span></td>`).join("") + `</tr>`;
  }
  modelCard += `</table></div><div class="note">回収率は検証期間(2019〜2023年)にその区分だったレースで、予想順位どおりに単勝1位・複勝1位・馬連1-2・馬単1→2・3連複1-2-3 を各1点買ったとき。緑は 100% 以上。区分にのせると自信の上位%。</div></div>`;

  // 展開・馬場
  let pace = PACE.filter(([, c]) => has(c) && num(r0[c]) != null).map(([label, c, g, f]) => {
    const guide = r0[g] || "", i = guide.indexOf("(");
    const word = i > 0 ? guide.slice(0, i) : guide, why = i > 0 ? guide.slice(i + 1, -1) : "";
    return `<div class="pace"><div class="pl">${esc(label)}</div><div><b>${esc(f(num(r0[c])))}</b>` +
      (word ? ` <span class="chip ${paceTone(word)}">${esc(word)}</span>` : "") + confChip(r0, label) +
      (why || r0[`${label}の確度の根拠`] ? `<div class="note" style="margin:0">${esc(why)}${why && r0[`${label}の確度の根拠`] ? "。" : ""}` +
        `${r0[`${label}の確度の根拠`] ? "確度の根拠: " + esc(r0[`${label}の確度の根拠`]) : ""}</div>` : "") + `</div></div>`;
  }).join("");
  const info = RACE_INFO.filter(has).map(c => `<dt>${esc(c)}</dt><dd>${esc(r0[c])}</dd>`).join("");
  pace = levelRow(r0) + t1000Row(r0) + winTimeRow(state.info.get(rid)) + predLapRow(r0, state.info.get(rid)) + settleRow(rows) + pace;
  // 馬場傾向: 3項目 × 内外・前後を、図(縦 内外・横 前後)と表の1枚に(11/23)
  const cell = label => {
    const g = BIAS.find(x => x[0] === label);
    if (!g || !has(g[1]) || num(r0[g[1]]) == null) return null;
    const guide = r0[g[2]] || "", i = guide.indexOf("(");
    const word = i > 0 ? guide.slice(0, i) : guide, why = i > 0 ? guide.slice(i + 1, -1) : "";
    const v = num(r0[g[1]]), src = r0[`${label}の確度`] ? r0 : (state.info.get(rid) || {}), cw = src[`${label}の確度の根拠`];
    return { v, lo: v, hi: v, guide, html: `<span title="${esc(why)}${why && cw ? "。" : ""}${cw ? "確度の根拠: " + esc(cw) : ""}"><b>${v >= 0 ? "+" : ""}${v.toFixed(3)}</b>` +
      (word ? `<br><span class="chip ${biasTone(word)}">${esc(word)}</span>` : "") + confChip(src, label) + `</span>` };
  };
  const bItems = BP_ITEMS.map(([n, color]) => ({ name: n, color, inner: cell(n + "の内外"), front: cell(n + "の前後") })).filter(x => x.inner || x.front);
  const ra = raceBiasActual(rid);
  const nTo = num(r0["今日のレース数"]);
  const todayPt = nTo && num(r0["今日の内外"]) != null && num(r0["今日の前後"]) != null ? [{ name: `今日のここまで(${nTo}レース)`, short: "今日", color: "#ff8a3d",
    inner: { v: num(r0["今日の内外"]), lo: num(r0["今日の内外"]), hi: num(r0["今日の内外"]), html: `<b>${num(r0["今日の内外"]) >= 0 ? "+" : ""}${num(r0["今日の内外"]).toFixed(3)}</b>` },
    front: { v: num(r0["今日の前後"]), lo: num(r0["今日の前後"]), hi: num(r0["今日の前後"]), html: `<b>${num(r0["今日の前後"]) >= 0 ? "+" : ""}${num(r0["今日の前後"]).toFixed(3)}</b>` } }] : [];
  const bNorm = { inner: biasNorm(bItems.find(x => x.inner)?.inner.guide || ""), front: biasNorm(bItems.find(x => x.front)?.front.guide || "") };
  const rSurf = state.info.get(rid)?.["芝ダ"] || r0["芝ダ"] || "";
  const bias = bItems.length ? biasPanel(bItems, bNorm, ra && (ra.inner != null || ra.front != null) ? { ...ra, name: "このレースの結果" } : null, todayPt,
    "馬場傾向マップ", blockTrail(rid.slice(0, 8), rid.slice(8, 10), rSurf)) : "";
  const tenkaiCard = `<div class="card" data-fold="baba-tenkai"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><h3 style="margin:0">展開予想${updTag("予想", rid)}</h3>${favBox}</div>${favNote}` +
    `${pace || `<span class="muted">列がありません</span>`}` +
    (pace ? `<div class="note">目安(札)は検証期間(2019〜2023年)の同じ芝ダのレースと比べたもの。ペース予想の数字はコースの基準タイムとの差で、ふつうのレースでも前に行く馬は基準より少し速い(平均は下の行のとおり)ので、札はそれと比べた速さ。逃げ・先行馬が多くペースが速いと差しが届きやすく、少なく遅いと前が残りやすい。</div>` : "") +
    `</div>`;
  const today = todayBiasRows(r0, rid);
  // 時計のかかり具合(11/23 ユーザーの指示)。予想 = 勝ちタイムの予想、結果 = 実際の勝ちタイム。どちらも基準との差(%)
  const ck = clockPct(rid);
  const clockRow = ck.pred == null ? "" : `<div class="pace"><div class="pl">時計(勝ちタイム)</div><div><b>${pctFmt(ck.pred)}</b> <span class="chip ${ck.pred >= CLOCK_FLAT ? "warn" : ck.pred <= -CLOCK_FLAT ? "up" : "gray"}">${esc(clockWord(ck.pred))}</span>` +
    (ck.act != null ? ` <span class="muted">結果 ${pctFmt(ck.act)}(${esc(clockWord(ck.act))})</span>` : "") + clockGraph(ck.pred, ck.act) +
    `<div class="note" style="margin:0">勝ちタイムの予想と、基準(同じ競馬場・芝ダ・距離・馬場状態${ck.baba ? `「${esc(ck.baba)}」` : ""}の過去3年の平均)との差。プラスは時計がかかる、マイナスは速い。` +
    `基準は馬場状態ごとなので、重・不良そのものの遅さは含まない(同じ馬場状態の中で、さらにかかるか速いか)</div></div></div>`;
  const babaCard = `<div class="card" data-fold="baba-tenkai"><h3>馬場傾向予想（仮）<button class="help" data-help="baba" title="馬場傾向予想の各項目の説明(別ウインドウ)">？</button>${updTag("予想", rid)}</h3>` +
    `${info ? `<dl class="kv">${info}</dl>` : ""}` + babaMeasurement(r0) + babaCompare(rid) + clockCompare(rid) + (clockRow ? `<div style="margin-top:6px">${clockRow}</div>` : "") +
    `<div class="note" style="margin:4px 0">グラフ: <span style="color:var(--accent)">●</span> 予想(帯は幅)、<span style="color:var(--muted)">│</span> そのコースのふだん、<span style="color:#f5c400">◆</span> このレースの結果(結果が出たら)。</div>` +
    (bias ? `<div style="margin-top:6px">${bias}</div><div class="note">馬場傾向の数字は、3着以内の馬の位置の平均 − 全馬の平均。` +
      `内外は馬番÷頭数(0 = 内、1 = 外)、前後は最初のコーナーの順位÷頭数(0 = 前、1 = 後ろ)で、マイナスなら内・前が有利。` +
      `目安の「いつも」は、検証期間(2019〜2023年)の同じ競馬場・同じ芝ダのレースの値(札の「東京芝のふだん」がその平均)。` +
      `そのコースのふだんより内・前が来ているか、外・後ろが来ているかを表す(2026-11-13 までに作った予想は、競馬場を問わない同じ芝ダの全レースと比べている)。</div>` : "") +
    today + (info || bias || today || clockRow ? "" : `<span class="muted">列がありません</span>`) + `</div>`;
  html += `<div class="grid2">${babaCard}${tenkaiCard}</div>`;   // 左に馬場、右に展開

  html += changeCard(base) + todayChangeCard(base);   // 得意モデルだけの表示のときも、枠順確定との比較は6モデルの平均どうしで
  // 出走馬
  html += `<div class="card"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">` +
    `<h3 style="margin:0">出走馬${updTag(["予想", "オッズ"], rid)}</h3>` + favBox + calibrationInfo(rows) +
    `<label class="muted" style="font-size:13px" title="相対値・絶対値・理由を全部の馬に出す。✓が無いとき(簡易表示)は、馬の行を1回押すとそれが出て、2回目で詳細が出る">` +
    `<input type="checkbox" id="simpleView" ${simpleView() ? "" : "checked"}> 詳細表示</label>` +
    `<button id="nkMarks" class="nkMarksBtn" title="このページの印を netkeiba のこのレースに転記する(確認のダイアログが出る)">netkeiba に印を転記</button><button class="help" id="nkHelp" title="netkeiba への印の転記の使い方(ブックマークの登録)">？</button>${nkSentTag(rid)}` +
    (hasPre(rows) ? `<label class="muted" style="font-size:13px" title="予想順位と勝率の横に枠順確定の時点からの変化を出す。レース一覧に、本命が変わったレースの印を出す">` +
      `<input type="checkbox" id="changeView" ${changeView() ? "checked" : ""}> 馬体重確定前からの変化</label>` : "") +
    (r0["オッズの時刻"] ? `<span class="chip gray" title="単複オッズの発表日時と、取った日時(過去のレースは確定オッズ)。オッズは発走まで変わる">${r0["オッズの時刻"] === "確定" ? "確定オッズ" : `オッズ ${esc(r0["オッズの時刻"])} 発表` + (r0["オッズの取得時刻"] ? `・${esc(r0["オッズの取得時刻"])} 取得` : "")}</span>` : "") +
    `</div>` +
    `<div class="legend" style="margin-bottom:6px">` +
    `<span>出走馬バー:</span><span><i style="background:var(--bar)"></i>2着内</span><span><i style="background:var(--bar2)"></i>3着内(2着内を含む)</span><span class="sep"></span>` + `<span>1〜5着の確率:</span><span class="grp">馬券内</span>${[1, 2, 3].map(k => `<span><i style="background:var(--f${k})"></i>${k}着</span>`).join("")}` +
    `<span class="sep"></span><span class="grp">馬券外</span>${[4, 5].map(k => `<span><i class="out" style="background-color:var(--f${k})"></i>${k}着</span>`).join("")}` +
    `<span>・行を押すとモデルごとの数字</span></div><div class="scroll"><table><tr>` +
    horseHead(rid) + `<th class="hide-sm">意見</th></tr>`;
  const ninki = ninkiOf(rid, rows), nUma = Math.max(...rows.map(r => +r.umaban));
  for (const r of sortHorses(rid, rows)) {
    const key = rid + "_" + r.umaban;
    const odds = getOdds(rid, r.umaban, r);
    const spread = num(r["順位の幅"]);
    const split = spread != null && spread >= 4;
    const w = num(r["馬体重"]), z = num(r["増減"]);
    const why = catChips(r) + reasonChips(r);
    html += `<tr class="horse${why ? " has-why" : ""}" data-key="${key}"><td class="rank">${esc(r["平均_順位"])}${changeView() ? moveMark(rankMove(r)) : ""}</td><td class="mark-col">${markSelect(rid, r.umaban)}</td>` +
      `<td>${umaBadge(r.umaban, nUma)}</td><td class="name">${esc(r.horse_name)}${num(r["オッズで取消"]) === 1 ? ' <span class="dim">取消</span>' : ""}${cdot(r, "予想")}</td><td class="n">${ratingCell(r, "馬レーティング")}</td><td>${bar(num(r["平均_勝率"]), maxWin)}${changeView() ? winMove(r) : ""}</td><td>${placeBar(top2(r), top3(r), maxTop3)}${preTops(r, ms)}</td>` +
      `<td class="n hide-sm">${w == null ? "" : w + (z == null ? "" : `<span class="dim">(${z > 0 ? "+" : ""}${z})</span>`)}</td>` +
      `<td class="jk"${jockeyRatingTitle(r) ? ` title="${esc(jockeyRatingTitle(r))}" tabindex="0"` : ""}>${jkLink(rid, r)}</td>` +
      `<td class="n">${ratingCell(r, "騎手レーティング")}</td>` +
      `<td class="n">${odds != null ? `${fix(odds)}<span class="dim ninki">${ninki.get(String(r.umaban))}人気</span>` : `<span class="dim">—</span>`}</td>` +
      `<td class="n">${fix(num(r["妥当オッズ_単勝"]))}${gapMark(getOdds(rid, r.umaban, r), num(r["妥当オッズ_単勝"]), "単勝")}${colMove(r, "妥当オッズ_単勝", 1, true)} / ` +
      `${fix(num(r["妥当オッズ_複勝"]))}${gapMark(num(r["複勝オッズ_下限"]), num(r["妥当オッズ_複勝"]), "複勝(下限)")}${colMove(r, "妥当オッズ_複勝", 1, true)}</td>` +
      `<td class="n ev" data-uma="${esc(r.umaban)}">${evCell(getOdds(rid, r.umaban, r), num(r["妥当オッズ_単勝"]))}${evMove(getOdds(rid, r.umaban, r), r, "妥当オッズ_単勝")}</td>` +
      `<td class="n">${placeOdds(r)}</td><td class="n">${evCell(num(r["複勝オッズ_下限"]), num(r["妥当オッズ_複勝"]))}${evMove(num(r["複勝オッズ_下限"]), r, "妥当オッズ_複勝")}</td><td>${finBar(r)}</td>` +
      `<td class="n">${fix(num(r["予想着順"]))}${colMove(r, "予想着順", 1, true)}${cdot(r, "予想")}</td>` +
      `<td class="n">${bandStr(rankBand(rid, "平均", r.umaban, state.favActive ? rows : null))}</td><td>${esc(styleOf(r))}${cdot(r, "脚質")}</td>` +
      `<td class="n">${passing(r)}${colMove(r, "前半の番手", 0, true)}${colMove(r, "4角の番手", 0, true)}${cdot(r, "通過予想")}</td><td class="n">${lastThree(r)}${colMove(r, "上がり3Fの予想", 1, true)}${cdot(r, "上がり予想")}</td>` +
      `<td class="hide-sm">${split ? `<span class="chip warn" title="モデルの順位の幅 ${spread}">割れ</span>` : ""}</td></tr>`;
    if (why && (!simpleView() || state.whyOpen?.has(key))) html += `<tr class="why" data-key="${key}" title="押すとモデルごとの数字を開く・たたむ" style="cursor:pointer"><td></td><td colspan="21">${why}</td></tr>`;
    if (state.open.has(key)) html += `<tr class="detail"><td colspan="22">${detail(r, ms)}</td></tr>`;
  }
  html += `</table></div>${favNote}<div class="note">勝率・3着内は6モデルの平均。妥当オッズの横の印は実際のオッズとの差(▲▲ 1.5倍以上・▲ 1.2倍以上高い、▼ 0.8倍未満・▼▼ 0.5倍未満に低い。上にのせると比)。期待値 = オッズ ÷ 妥当オッズ(1 を超えると予想の上では得。緑は 1.0 以上、太字は 1.2 以上。複勝は下限のオッズで計算)。単勝オッズの横は人気(オッズの低い順)。「割れ」はモデルの順位の幅が4以上。馬名・予想着順・脚質・通過予想・上がり予想の横の印は確度(○ ◔ ◑ ◕ ● の5段階で、●ほど当たりやすい。色は緑 = 高・灰 = 中・橙 = 低。上にのせると0〜100の点と、検証期間の同じ条件での平均のずれ)。馬名の横は勝率・3着内・期待値を含む予想全体の確度。通過予想は前半(最初のコーナー)→ 4コーナーの番手、上がり予想は秒(かっこ内はレースで速い順、緑は3位まで)。根拠は説明用の LightGBM で、▲が評価を上げた項目、▼が下げた項目。数字は点数の差(レースの平均と比べた分)と、勝つ見込みのおおよその倍率(×)。総合・能力・適性・調子・人・展開は、根拠の項目を分類ごとに足したもの(総合は全部の合計)。1行目の「相対値」はこのレースの中の順位から星(点は1位が100・最下位が0)、2行目の「絶対値」は検証期間 2019〜2023年の全出走馬の中の位置(点は上位何%かで、80以上が★5)。横の高・中・低は確度(元になった出走数・調教などのデータの量。総合は能力・適性・調子のうち一番低いもの)で、低いものは薄く出す。</div></div>`;

  html += renderViz(rid, rows, favBox);
  html += renderPlan(rid);
  html += renderCalc(rid);
  html += renderCombos(rid);
  html += modelCard;
  document.getElementById("main").innerHTML = html;
  state.favActive = false;   // 変化の印を止めるのは出走馬の表を作るあいだだけ(レース一覧の印は止めない)
  // 並び(2026-11-22 ユーザーの指示): レース概要 → (レース回顧)→ ビジュアライズ予想 → 出走馬 → ほか
  {
    const main = document.getElementById("main"), top = main.querySelector(".card");
    const viz = main.querySelector(".viz-card"), horse = main.querySelector("tr.horse")?.closest(".card");
    const review = main.querySelector(".card.review");   // レース回顧が出ていれば概要のすぐ下(2026-11-22 ユーザーの指示)
    const anchor = review ? (top.after(review), review) : top;
    if (anchor && viz) anchor.after(viz);
    if (viz && horse) viz.after(horse); else if (anchor && horse) anchor.after(horse);
  }
  setupCardFolds(document.getElementById("main"), ".card", true);   // 個別レース: 概要・出走馬・ビジュアライズ予想のほかは最初たたむ
  setupHelpButtons(document.getElementById("main"));
  setupLapBase(document.getElementById("main"));
  setupHorseSort(document.getElementById("main"), rid);
  document.querySelectorAll("select.mark").forEach(s => {
    s.onclick = e => e.stopPropagation();
    s.onchange = () => {
      setMark(rid, s.dataset.uma, s.value); s.dataset.m = s.value;
      // 出走馬の表とビジュアライズ予想の印は共通(2026-11-22 ユーザーの指示)。同じ馬のもう片方の印も合わせる
      document.querySelectorAll(`select.mark[data-uma="${s.dataset.uma}"]`).forEach(o => { if (o !== s) { o.value = s.value; o.dataset.m = s.value; } });
      // フォーメーションの馬番の下の印も合わせる
      document.querySelectorAll(`td.gmark[data-u="${s.dataset.uma}"]`).forEach(td => { td.dataset.m = s.value; td.textContent = s.value || "-"; });
    };
  });
  // 相対値・絶対値などの行を押すと、モデルごとの数字(詳細)を開く・たたむ(11/28 ユーザーの指示)
  document.querySelectorAll("tr.why[data-key]").forEach(tr => tr.onclick = e => {
    if (e.target.closest("input, select, a, button")) return;
    const k = tr.dataset.key;
    state.open.has(k) ? state.open.delete(k) : state.open.add(k);
    keepScroll(() => renderRace(rid));
  });
  document.querySelectorAll("tr.horse").forEach(tr => tr.onclick = e => {
    if (e.target.closest("input, select, td.jk")) return;   // 騎手の欄は騎手のレーティング用(馬の詳細は開かない。11/28)
    const k = tr.dataset.key;
    state.whyOpen = state.whyOpen || new Set();
    if (simpleView() && tr.classList.contains("has-why")) {
      // 簡易表示: 1回目で相対値・絶対値・理由、2回目で詳細、3回目でどちらもたたむ
      if (!state.whyOpen.has(k)) state.whyOpen.add(k);
      else if (!state.open.has(k)) state.open.add(k);
      else { state.whyOpen.delete(k); state.open.delete(k); }
    } else state.open.has(k) ? state.open.delete(k) : state.open.add(k);   // 通常: 1回で詳細を開く・たたむ
    renderRace(rid);
  });
  document.getElementById("changeView")?.addEventListener("change", e => {
    try { localStorage.setItem("keiba-viewer:change", e.target.checked ? "1" : "0"); } catch (err) { state.change = e.target.checked; }
    renderNav();
    renderRace(rid);
  });
  document.querySelectorAll(".favView").forEach(box => box.addEventListener("change", e => {
    try { localStorage.setItem("keiba-viewer:fav", e.target.checked ? "1" : "0"); } catch (err) { state.fav = e.target.checked; }
    renderRace(rid);
  }));
  document.querySelectorAll("th.bsort").forEach(th => th.onclick = () => {
    state.basketSort = state.basketSort || {}; const cur = state.basketSort[rid], k = th.dataset.k;
    state.basketSort[rid] = cur?.k === k ? { k, dir: -(cur.dir || (k === "t" ? 1 : -1)) } : { k }; renderRace(rid);
  });
  document.querySelectorAll("th.psort").forEach(th => th.onclick = () => {
    state.calcSort = state.calcSort || {}; const cur = state.calcSort[rid], k = th.dataset.k;
    state.calcSort[rid] = cur?.k === k ? { k, dir: -(cur.dir || (k === "t" ? 1 : -1)) } : { k }; renderRace(rid);
  });
  document.getElementById("bAllocGo")?.addEventListener("click", () => {
    const budget = roundYen(document.getElementById("bAllocBudget").value), mode = document.querySelector('input[name="bAllocMode"]:checked')?.value || "均等";
    if (!probabilityReady(state.races.get(rid) || [])) { alert("予想値を確認できないため自動配分できません。"); return; }
    state.bAlloc = state.bAlloc || {}; state.bAlloc[rid] = { budget, mode };
    const b = basketOf(rid), info = new Map((state.basketRows?.[rid] || []).map(r => [r.i, r]));
    const eligible = b.map((x, i) => ({x, i})).filter(({x}) => x.sel !== false && ticketEligible(state.races.get(rid), x));
    if (!eligible.length) return;
    if (!(budget >= 100 * eligible.length)) { alert(`予算(${budget.toLocaleString()}円)が 有効な買い目 ${eligible.length}点 × 100円 より少ないので、自動では配れません。`); return; }
    const ps = eligible.map(({i}) => info.get(i)?.p || 0), os = eligible.map(({i}) => info.get(i)?.o || 0);
    if (mode === "期待値追求型" && !os.some(o => o)) { alert("オッズのある買い目が無いので、期待値追求では配れません。"); return; }
    const amt = allocate(budget, ps, mode, os);
    eligible.forEach(({x}, i) => x.amount = amt[i] || 0);
    saveBasket(rid); renderRace(rid);
  });
  document.querySelectorAll(".nkBetsBtn").forEach(b => b.onclick = e => { e.stopPropagation(); sendBetsToNetkeiba(rid); });
  document.querySelectorAll(".nkBetHelp").forEach(h => h.onclick = e => {
    e.stopPropagation();
    document.getElementById("guideTitle").textContent = "netkeiba(IPAT)への買い目の転記";
    document.getElementById("guideBody").innerHTML = nkBetHelpHTML();
    const d = document.getElementById("guide"); if (!d.open) d.showModal();
  });
  document.querySelectorAll(".nkMarksBtn").forEach(b => b.onclick = e => { e.stopPropagation(); sendMarksToNetkeiba(rid); });   // 出走馬の欄とビジュアライズ予想の両方(11/22)
  document.querySelectorAll("#nkHelp, .nkHelpBtn").forEach(h => h.addEventListener("click", e => {
    e.stopPropagation();
    document.getElementById("guideTitle").textContent = "netkeiba への印の転記";
    document.getElementById("guideBody").innerHTML = nkHelpHTML();
    const d = document.getElementById("guide"); if (!d.open) d.showModal();
  }));
  document.getElementById("vizPre")?.addEventListener("change", e => { state.vizPre = e.target.checked; renderRace(rid); });
  document.querySelectorAll("button.vizAxis").forEach(b => b.onclick = () => { state.vizAxis = b.dataset.v; renderRace(rid); });
  document.querySelectorAll(".vizSort").forEach(b => b.onclick = () => {
    const cur = ["res", "uma", "ninki", "odds"].includes(state.vizSort) ? state.vizSort : "pred";
    state.vizDir = cur === b.dataset.k && state.vizDir !== -1 ? -1 : 1; state.vizSort = b.dataset.k; renderRace(rid);
  });
  document.getElementById("simpleView")?.addEventListener("change", e => {
    try { localStorage.setItem("keiba-viewer:detail", e.target.checked ? "1" : "0"); } catch (err) { state.detail = e.target.checked; }
    renderRace(rid);
  });
  document.querySelectorAll(".tabs.combo button").forEach(b => b.onclick = () => { state.comboTab = b.dataset.t; renderRace(rid); });
  document.querySelectorAll(".tabs.csort button").forEach(b => b.onclick = () => { state.comboSort = b.dataset.t; renderRace(rid); });
  document.querySelectorAll(".tabs.plan button[data-t]").forEach(b => b.onclick = () => { state.planTab = b.dataset.t; saveBudget(null); saveRaceBudget(rid, null); renderRace(rid); });
  document.getElementById("budgetReset")?.addEventListener("click", () => { saveRaceBudget(rid, null); renderRace(rid); });
  document.querySelectorAll(".tabs.pmode button").forEach(b => b.onclick = () => { state.planMode = b.dataset.t; renderRace(rid); });
  document.querySelectorAll(".tabs.psel button").forEach(b => b.onclick = () => {
    try { localStorage.setItem("keiba-viewer:planSel", b.dataset.t); } catch (e) { state.planSel = b.dataset.t; }
    renderRace(rid);
  });
  document.querySelectorAll(".tabs.pgroup button").forEach(b => b.onclick = () => { state.planGroup = b.dataset.t; renderRace(rid); });
  const bud = document.getElementById("budget");
  if (bud) {
    bud.onclick = e => e.stopPropagation();
    bud.onchange = () => {
      const v = num(bud.value.replace(/[,円\s]/g, ""));
      if (raceBudgetOf(rid)) saveRaceBudget(rid, v); else saveBudget(v);    // このレースだけの金額があれば、そちらを書き換える
      renderRace(rid);
    };
    bud.onkeydown = e => { if (e.key === "Enter") bud.blur(); };
  }
  document.querySelectorAll('input[name="alloc"]').forEach(x => x.onchange = () => { saveMode(x.value); renderRace(rid); });
  const calc = state.calc[rid];
  // 描き直すとフォーメーションの表の横の位置が左に戻るので、前の位置に戻す(携帯で毎回左に戻っていた。2026-11-15 ユーザーの指示)
  const calcUpdate = (f) => {
    const x = document.querySelector("table.grid")?.parentElement?.scrollLeft || 0, y = window.scrollY;
    f(); renderRace(rid);
    const g = document.querySelector("table.grid")?.parentElement;
    if (g) g.scrollLeft = x;
    window.scrollTo(window.scrollX, y);
  };
  document.getElementById("calcKind")?.addEventListener("change", e => calcUpdate(() => calc.kind = e.target.value));
  document.querySelectorAll(".calcBox").forEach(x => x.onchange = () => calcUpdate(() => {
    const row = calc.rows[x.dataset.i - 1];
    if (x.checked) row.push(x.dataset.u); else row.splice(row.indexOf(x.dataset.u), 1);
  }));
  document.querySelectorAll(".calcAll").forEach(x => x.onchange = () => calcUpdate(() => {
    const all = (state.races.get(rid) || []).map(r => String(r.umaban));
    calc.rows[x.dataset.i - 1] = x.checked ? all : [];
  }));
  document.querySelectorAll(".calcMarked").forEach(x => x.onclick = () => {
    const marked = (state.races.get(rid) || []).map(r => String(r.umaban)).filter(u => { const m = markOf(rid, u); return m && m !== "消"; });
    if (!marked.length) { alert("印の付いた馬がいません(出走馬の表かビジュアライズ予想で印を付ける)"); return; }
    calcUpdate(() => { const row = calc.rows[x.dataset.i - 1]; for (const u of marked) if (!row.includes(u)) row.push(u); });
  });
  document.getElementById("calcClear")?.addEventListener("click", () => calcUpdate(() => { calc.rows = [[], [], []]; calc.amt = {}; }));
  document.querySelectorAll("input.calcAmt").forEach(x => {
    x.onclick = e => e.stopPropagation();
    x.onchange = () => calcUpdate(() => { calc.amt = calc.amt || {}; calc.amt[calc.kind + "|" + x.dataset.k] = roundYen(x.value); });
  });
  document.getElementById("calcAddPick")?.addEventListener("click", () => {
    const picked = [...document.querySelectorAll(".prevPick:checked")].map(x => x.dataset.k.split("-"));
    if (picked.length) {
      const horses = (state.races.get(rid) || []).map(r => String(r.umaban));
      const cols = calc.rows.slice(0, CALC_KINDS[calc.kind][0]).map(r => horses.filter(u => r.includes(u)));
      addToBasket(rid, calc.kind, picked, t => calcAmtOf(calc, t), formationLabel(calc.kind, cols) + "(選んだもの)");
    }
    renderRace(rid);
  });
  document.querySelector(".prevAll")?.addEventListener("change", e => document.querySelectorAll(".prevPick").forEach(x => x.checked = e.target.checked));
  document.querySelector(".planAll")?.addEventListener("change", e => document.querySelectorAll(".planPick").forEach(x => x.checked = e.target.checked));
  const sendPlan = (only) => {
    const list = (state.planTickets?.[rid] || []).filter((_, i) => !only || document.querySelector(`.planPick[data-i="${i}"]`)?.checked);
    const b = basketOf(rid);
    for (const x of list) {
      const amount = x.amount || 100;
      const hit = b.find(y => y.kind === x.kind && y.t.join("-") === x.t.join("-"));
      if (hit) { hit.amount += amount; if (!(hit.forms || []).includes("推奨買い目")) hit.forms = [...(hit.forms || []), "推奨買い目"]; }
      else b.push({ kind: x.kind, t: [...x.t], amount, forms: ["推奨買い目"] });
    }
    saveBasket(rid);
    renderRace(rid);
  };
  document.getElementById("planSendAll")?.addEventListener("click", () => sendPlan(false));
  document.getElementById("planSendPick")?.addEventListener("click", () => sendPlan(true));
  document.getElementById("calcAdd")?.addEventListener("click", () => {
    const raceRows = state.races.get(rid) || [];
    const horses = raceRows.map(r => String(r.umaban)).sort((a, b) => a - b);
    const [n] = CALC_KINDS[calc.kind];
    const cols = calc.rows.slice(0, n).map(r => horses.filter(u => r.includes(u)));
    if (cols.every(x => x.length)) addToBasket(rid, calc.kind, expandTickets(calc.kind, cols), t => calcAmtOf(calc, t), formationLabel(calc.kind, cols), cols);
    renderRace(rid);
  });
  document.querySelectorAll("input.amt").forEach(x => {
    x.onclick = e => e.stopPropagation();
    x.onchange = () => { basketOf(rid)[x.dataset.i].amount = roundYen(x.value); saveBasket(rid); keepScroll(() => renderRace(rid)); };
  });
  document.querySelectorAll("button.del").forEach(x => x.onclick = () => { basketOf(rid).splice(+x.dataset.i, 1); saveBasket(rid); keepScroll(() => renderRace(rid)); });
  document.getElementById("basketBuy")?.addEventListener("click", () => {
    const selected = basketOf(rid).filter(x => x.sel !== false && ticketEligible(state.races.get(rid), x));
    sendToBought(rid, selected); renderRace(rid);
  });
  document.querySelectorAll("input.bsel").forEach(x => x.onchange = () => { const it = basketOf(rid)[x.dataset.i]; if (it) it.sel = x.checked; saveBasket(rid); keepScroll(() => renderRace(rid)); });
  document.querySelectorAll("input.bselGrp").forEach(x => x.onchange = () => { const b = basketOf(rid); x.dataset.is.split(",").forEach(i => { if (b[+i]) b[+i].sel = x.checked; }); saveBasket(rid); keepScroll(() => renderRace(rid)); });
  document.getElementById("basketDelSel")?.addEventListener("click", () => {
    const b = basketOf(rid), n = b.filter(x => x.sel !== false).length;
    if (!n) { alert("チェックした買い目がありません"); return; }
    if (!confirm(`チェックした ${n} 点を買い目候補から消します。よろしいですか?`)) return;
    state.basket[rid] = b.filter(x => x.sel === false); saveBasket(rid); keepScroll(() => renderRace(rid));
  });
  document.querySelector("input.bselAll")?.addEventListener("change", e => { basketOf(rid).forEach(x => x.sel = e.target.checked); saveBasket(rid); keepScroll(() => renderRace(rid)); });
  document.querySelectorAll("a.toDay").forEach(a => a.onclick = e => { e.preventDefault(); state.dayPage = a.dataset.day; state.open.clear(); render(); });
  document.getElementById("basketZero")?.addEventListener("click", () => { basketOf(rid).forEach(x => x.amount = 0); saveBasket(rid); renderRace(rid); });
  document.getElementById("basketClear")?.addEventListener("click", () => { state.basket[rid] = []; saveBasket(rid); renderRace(rid); });
  const cu = document.getElementById("calcUnit");
  if (cu) cu.onchange = () => calcUpdate(() => calc.unit = String(roundYen(cu.value)));
  document.getElementById("calcBox")?.addEventListener("click", () => calcUpdate(() => { calc.rows = [0, 1, 2].map(() => [...calc.rows[0]]); }));
}
// ---------- 出走馬の表: 列の見出しで並べ替え・枠の色 ----------
// [見出し, 並べ替えの値, 最初に押したときの向き(1 = 小さい順、-1 = 大きい順), th の class, title]
const STYLE_ORDER = { "逃": 1, "先行": 2, "差": 3, "追込": 4, "自在": 5, "不明": 6 };
function horseCols(rid) {
  const o = r => getOdds(rid, r.umaban, r);
  const ratio = (a, b) => a != null && b ? a / b : null;
  const t3 = r => { const s = num(r["平均_3着内"]); if (s != null) return s; const v = MODELS_OF(r).map(m => num(r[`${m}_3着内`])).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b) / v.length : null; };
  return [
    ["予", r => num(r["平均_順位"]), 1, "rank", "予想の順位"],
    // 2026-11-22 ユーザーの指示: 印を馬番の左に
    ["印", r => { const m = markOf(rid, r.umaban); return m ? MARKS.indexOf(m) : null; }, 1, "mark-col", "自分で付ける印(◎ 〇 ▲ △ ★ ✓ 消)。印の順で並べる"],
    ["馬番", r => +r.umaban, 1, "", ""],
    ["馬名", r => r.horse_name || "", 1, "", ""],
    ["馬<br>レーティング", r => horseRating(r), -1, "n", "前日までの走りと対戦相手から推定した独自の強さ。JRA公式値ではない"],
    ["勝率", r => num(r["平均_勝率"]), -1, "", ""],
    ["2・3着内", t3, -1, "", "3着内の確率で並べる"],
    ["馬体重", r => num(r["馬体重"]), -1, "n hide-sm", ""],
    ["騎手", r => jockeyOf(rid, r), 1, "", "騎手(予想 CSV の時点。騎手変更は予想の作り直しで入る)"],
    ["騎手<br>レーティング", r => jockeyRating(r), -1, "n", "騎乗馬の強さから見込まれる着順と実際の差を50点基準に換算。騎手名に合わせると詳細を表示"],   // 2026-11-22 ユーザーの指示: 2・3着内の右に
    ["単勝<br>オッズ", o, 1, "n", ""],   // 11/28 ユーザーの指示: 妥当オッズと左右を入れ替え
    ["妥当オッズ<br>単/複", r => num(r["妥当オッズ_単勝"]), 1, "n", "単勝の妥当オッズで並べる"],
    ["単勝<br>期待値", r => ratio(o(r), num(r["妥当オッズ_単勝"])), -1, "n", "単勝の期待値 = 単勝オッズ ÷ 妥当オッズ(単勝)"],
    ["複勝<br>オッズ", r => num(r["複勝オッズ_下限"]), 1, "n", "下限で並べる"],
    ["複勝<br>期待値", r => ratio(num(r["複勝オッズ_下限"]), num(r["妥当オッズ_複勝"])), -1, "n", ""],
    ["1〜5着", r => upTo(r, 3), -1, "", "3着以内の確率で並べる"],
    ["予想<br>着順", r => num(r["予想着順"]), 1, "n", ""],
    // 着順の見込み(2026-11-22 ユーザーの指示「予想着順列の右に列を追加して出したい」): 平均の勝率から作った着順の分布の真ん中の半分
    ["着順の<br>見込み", r => -(num(r["平均_勝率"]) ?? 0), 1, "n", "平均の勝率から作った着順の分布の、真ん中の半分(25%〜75%)。実際の着順が半々でこの範囲に入る見込み。勝率の高い順に並べる"],
    ["脚質", r => STYLE_ORDER[styleOf(r)] ?? 9, 1, "", "逃・先行・差・追込・自在・不明の順"],
    ["通過<br>予想", r => num(r["4角の番手"]), 1, "n", "前半(最初のコーナー)→ 4コーナーの予想の番手。4コーナーの番手で並べる"],
    ["上がり<br>予想", r => num(r["上がり3Fの予想"]), 1, "n", "上がり3F の予想(かっこ内はレースの中で速い順)"],
  ];
}
// ---------- 自分で付ける印(◎ 〇 ▲ △ ★ ✓ 消)。表示だけで、予想・モデルには使わない ----------
// このブラウザの localStorage にレースごとに覚えておく: keiba-viewer:marks:<race_id(日付入り)> = {馬番: 印}。「-」は印なし
const MARKS = ["◎", "〇", "▲", "△", "★", "✓", "消"];
function marksOf(rid) {
  if (!state.marks) state.marks = {};
  if (!state.marks[rid]) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(`keiba-viewer:marks:${rid}`) || "null"); } catch (e) {}
    state.marks[rid] = saved && typeof saved === "object" ? saved : {};
  }
  return state.marks[rid];
}
function markOf(rid, uma) { const m = marksOf(rid)[String(uma)]; return MARKS.includes(m) ? m : ""; }
function setMark(rid, uma, m) {
  const ms = marksOf(rid);
  if (MARKS.includes(m)) ms[String(uma)] = m; else delete ms[String(uma)];
  try {
    if (Object.keys(ms).length) localStorage.setItem(`keiba-viewer:marks:${rid}`, JSON.stringify(ms));
    else localStorage.removeItem(`keiba-viewer:marks:${rid}`);
  } catch (e) {}
}
function markSelect(rid, uma) {
  const m = markOf(rid, uma);
  return `<select class="mark" data-uma="${esc(uma)}" data-m="${m}" title="印を付ける(「-」で外す)" aria-label="${esc(uma)}番の印">` +
    ["", ...MARKS].map(x => `<option value="${x}" ${x === m ? "selected" : ""}>${x || "-"}</option>`).join("") + `</select>`;
}
const MODELS_OF = r => Object.keys(r).filter(c => c.endsWith("_3着内") && !c.startsWith("平均") && !c.startsWith(PRE)).map(c => c.slice(0, -4));
function calibrationInfo(rows) {
  const fields = ["平均の温度", "着順の補正_2着", "着順の補正_3着"];
  if (!rows.some(r => fields.some(f => f in r))) return "";
  const values = raceFactors(rows);
  if (!values) return `<span class="chip warn">補正係数が不一致のため計算不可</span>`;
  return `<span class="chip gray" title="予想に使った補正係数">補正: 平均 ${values.temp.toFixed(3)}・2着 ${values.l2.toFixed(3)}・3着 ${values.l3.toFixed(3)}</span>`;
}
function horseRating(r) {
  return num("馬レーティング_U71" in r ? r["馬レーティング_U71"] : r["馬レーティング"]);
}
// 人のレーティング(人のレーティング.csv。2026-11-28 ユーザーの指示「騎手は表示の期間を3年に」「騎手名を押すと通算・1年・3年・芝・ダ・競馬場・距離別」)
function personRow(rid, kind, name) {
  const rows = state.people?.get(String(rid).slice(0, 8));
  return rows && name ? rows.find(x => x["区分"] === kind && x["名前"] === name) || null : null;
}
const personScore = v => v == null || !Number.isFinite(v) ? null : Math.max(0, 50 + v * 100);
function jockeyRating(r) {
  const p = personRow(r.race_id, "騎手", r.jockey_name || jockeyOf(r.race_id, r));
  if (p) { const n = num(p["3年_走数"]); return n > 0 ? num(p["3年"]) : null; }   // 3年(人のレーティング.csv)が無い日は前の1年の列
  const n = num(r["騎手レーティング対象数"]);
  return n != null && n > 0 ? num(r["騎手レーティング"]) : null;
}
function jockeyRatingTitle(r) {
  const v = jockeyRating(r);
  if (v == null || !Number.isFinite(v)) return "";
  const p = personRow(r.race_id, "騎手", r.jockey_name || jockeyOf(r.race_id, r));
  return p ? `騎手レーティング(前日までの3年): ${personScore(v).toFixed(1)}点(基準50点、${num(p["3年_走数"])}走・確度 ${p["確度"]})。騎手名を押すと条件別` :
    `騎手レーティング(前日までの1年): ${personScore(v).toFixed(1)}点(基準50点、対象 ${num(r["騎手レーティング対象数"])}走)`;
}
const JYO_NAME = c => (typeof JYO !== "undefined" && JYO[String(c).padStart(2, "0")]) || c;
function personModal(rid, kind, name) {
  const p = personRow(rid, kind, name);
  if (!p) { alert(`${name} のレーティングがありません(この日の 人のレーティング.csv が無いか、名前が見つからない)`); return; }
  const cols = Object.keys(p).filter(c => !c.endsWith("_走数") && !["区分", "コード", "名前", "確度"].includes(c));
  const label = c => c.startsWith("場") ? JYO_NAME(c.slice(1)) : c === "〜1400" ? "〜1400m" : c === "〜1800" ? "1401〜1800m" : c === "〜2200" ? "1801〜2200m" : c === "2201〜" ? "2201m〜" : c;
  const group = c => ["通算", "1年", "3年"].includes(c) ? "期間" : ["芝", "ダート"].includes(c) ? "芝ダ(3年)" : c.startsWith("場") ? "競馬場(3年)" : "距離(3年)";
  let h = `<div class="bpz-back"><div class="bpz" style="height:auto;max-height:90%;width:min(520px,100%)"><div class="bpz-bar"><b>${esc(kind)} ${esc(name)} のレーティング</b><span style="flex:1"></span><button class="pm-close">閉じる</button></div>` +
    `<div style="padding:10px 14px;overflow:auto"><table><tr><th>区分</th><th>条件</th><th class="n">点数</th><th class="n">走数</th></tr>`;
  for (const c of cols) {
    const v = num(p[c]), n = num(p[c + "_走数"]);
    h += `<tr><td class="muted" style="font-size:12px">${esc(group(c))}</td><td>${esc(label(c))}</td><td class="n">${n > 0 && v != null ? `<b class="${personScore(v) >= 55 ? "hi" : ""}">${personScore(v).toFixed(1)}</b>` : `<span class="dim">-</span>`}</td><td class="n">${n ? n.toLocaleString() : 0}</td></tr>`;
  }
  h += `</table><div class="note">騎乗馬の強さ(前日までの馬のレーティング)から見込まれる着順と、実際の着順の差を、前日までの期間で平均して100倍し、50点を平均とした点数。高いほど見込みより上の着順に持ってきている。` +
    `走数が少ない条件は平均(50点)に寄せている。確度(3年の走数): ${esc(p["確度"] || "-")}。表示のためのもので、予想には使っていない。</div></div></div></div>`;
  const d = document.createElement("div"); d.innerHTML = h; const back = d.firstElementChild;
  back.addEventListener("click", e => { if (e.target === back || e.target.closest(".pm-close")) back.remove(); });
  document.body.appendChild(back);
}
document.addEventListener("click", e => {
  const a = e.target.closest?.(".jkLink");
  if (!a) return;
  e.preventDefault(); e.stopPropagation();
  personModal(a.dataset.rid, "騎手", a.dataset.name);
});
const jkLink = (rid, r) => { const nm = jockeyOf(rid, r); return nm ? `<a href="#" class="jkLink" data-rid="${rid}" data-name="${esc(nm)}" title="押すと条件別のレーティング">${esc(nm)}</a>` : `<span class="dim">-</span>`; };
function ratingCell(r, name) {
  const v = name === "騎手レーティング" ? jockeyRating(r) : horseRating(r);
  if (v == null || !Number.isFinite(v)) return `<span class="dim">-</span>`;
  const n = num(r["騎手レーティング対象数"]);
  if (name === "騎手レーティング") {
    const score = Math.max(0, 50 + v * 100);
    return `<span>${score.toFixed(1)}</span>`;
  }
  const u71 = name === "馬レーティング" && "馬レーティング_U71" in r;
  if (name === "馬レーティング" && !u71) {
    const score = Math.max(0, 50 + 25 * v);
    const title = "U27の試用換算: 0を50点、1を75点とし、下限を0点としています。勝率ではありません";
    return `<span title="${esc(title)}">${score.toFixed(1)}</span>`;
  }
  const title = name === "騎手レーティング" && n != null ? `対象 ${n}走` : u71 ? "U71: 前日までの推定値（JRA公式値ではない）" : "U27: 前日までの馬の強さ（初期値0）";
  return `<span title="${esc(title)}">${!u71 && v >= 0 ? "+" : ""}${v.toFixed(name === "騎手レーティング" ? 3 : 2)}</span>`;
}
// 騎手名: 予想 CSV の列(11/23 から)。無い古い CSV は、結果の CSV の騎手で補う
function jockeyOf(rid, r) {
  if (r.jockey_name) return r.jockey_name;
  const res = state.results?.get(rid), x = (res?.rows || res || []).find?.(y => String(+y["馬番"]) === String(+r.umaban));
  return x?.["騎手"] || "";
}
function horseHead(rid) {
  const cur = state.horseSort || { i: 0, dir: 1 };
  return horseCols(rid).map(([label, , , cls, tip], i) =>
    `<th class="${cls} sortable${cur.i === i ? " sorted" : ""}" data-sort="${i}" title="${esc((tip ? tip + "。" : "") + "押すと並べ替え(もう一度で逆順)")}">` +
    `${label}${cur.i === i ? `<span class="sortmark">${cur.dir === 1 ? "▲" : "▼"}</span>` : ""}</th>`).join("");
}
function sortHorses(rid, rows) {
  const cur = state.horseSort || { i: 0, dir: 1 };
  const f = horseCols(rid)[cur.i][1];
  return [...rows].sort((a, b) => {
    const x = f(a), y = f(b);
    if (x == null || x === "") return 1;                     // 値の無い馬はいつも後ろ
    if (y == null || y === "") return -1;
    const c = typeof x === "string" ? x.localeCompare(y, "ja") : x - y;
    return c * cur.dir || num(a["平均_順位"]) - num(b["平均_順位"]);
  });
}
function setupHorseSort(root, rid) {
  root.querySelectorAll("th.sortable").forEach(th => th.onclick = () => {
    const i = +th.dataset.sort, cur = state.horseSort || { i: 0, dir: 1 };
    state.horseSort = cur.i === i ? { i, dir: -cur.dir } : { i, dir: horseCols(rid)[i][2] };
    renderRace(rid);
  });
}
// 枠の色(JRA の枠番: 8頭以下は馬番 = 枠番。9頭以上は外の枠から1頭ずつ多くなる)
const WAKU_COLORS = { 1: ["#ffffff", "#222"], 2: ["#222222", "#fff"], 3: ["#e53935", "#fff"], 4: ["#1e63c4", "#fff"],
  5: ["#f5d000", "#222"], 6: ["#2e9e4f", "#fff"], 7: ["#f08a00", "#222"], 8: ["#f48fb1", "#222"] };
function wakuOf(uma, n) {
  if (n <= 8) return uma;
  const base = Math.floor(n / 8), extra = n % 8;
  let end = 0;
  for (let w = 1; w <= 8; w++) { end += base + (w > 8 - extra ? 1 : 0); if (uma <= end) return w; }
  return 8;
}
function umaBadge(uma, n) {
  const w = wakuOf(+uma, n), [bg, fg] = WAKU_COLORS[w] || ["", ""];
  return `<span class="uma" style="background:${bg};color:${fg};border-color:${w === 1 ? "var(--line)" : bg}" title="${w}枠">${esc(uma)}</span>`;
}

// ---------- 単勝オッズ(予想 CSV の値。手入力はやめた) ----------
function manualOdds() { return false; }
function placeOdds(r) {
  const a = num(r["複勝オッズ_下限"]), b = num(r["複勝オッズ_上限"]);
  return a == null ? "" : `${a.toFixed(1)}<span class="dim">-${b == null ? "" : b.toFixed(1)}</span>`;
}
function getOdds(rid, uma, r) {
  // 単勝オッズは予想 CSV の値だけを使う(手入力はやめた。前に手で入れてブラウザに残っている値は使わない)
  return r && "単勝オッズ" in r ? num(r["単勝オッズ"]) : null;
}
function ninkiOf(rid, rows) {
  // 単勝オッズの低い順の人気(同じオッズは同じ人気)。馬番 → 人気
  const xs = rows.map(r => [String(r.umaban), getOdds(rid, r.umaban, r)]).filter(([, o]) => o != null);
  return new Map(xs.map(([u, o]) => [u, 1 + xs.filter(([, p]) => p < o).length]));
}
// 期待値の変化: 今のオッズのまま、妥当オッズだけ枠順確定の時点の値にしたときとの差
function evMove(odds, r, col) {
  const a = num(r[preCol(col)]), b = num(r[col]);
  return !changeView() || odds == null || !a || !b ? "" : valueMove(odds / b, odds / a, 2);
}
// 2着内・3着内(モデルの平均)の変化
function preTops(r, ms) {
  if (!changeView()) return "";
  const mean = cols => { const v = cols.map(c => num(r[c])).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const one = name => {
    const a = mean(ms.map(m => `${PRE}${m}_${name}`)), b = mean(ms.map(m => `${m}_${name}`));
    if (a == null || b == null || Math.abs(b - a) < 0.0005) return "";
    return `<span class="chg ${b > a ? "up" : "down"}">${name} ${b > a ? "+" : ""}${((b - a) * 100).toFixed(1)}%</span>`;
  };
  return one("2着内") + one("3着内");
}
function evCell(odds, fair) {
  if (odds == null || !fair) return "";
  const ev = odds / fair;
  return `<span class="${ev >= 1 ? "hi" : "dim"}" style="${ev >= 1.2 ? "font-weight:800" : ""}">${ev.toFixed(2)}</span>`;
}
function styleOf(r) {
  // 脚質の予想。新しい CSV は「脚質の予想」(不明・自在を分ける)、古い CSV の「自在」は分からない馬だったので「不明」にする
  if (r["脚質の予想"]) return r["脚質の予想"];
  const v = styleName(r["脚質(近5走)"]);
  return v === "自在" ? "不明" : v;
}
function styleName(v) {
  // 古い CSV の1文字の書き方も直す。脚質が決まらない馬は「自在」
  return { "逃": "逃", "先": "先行", "差": "差", "追": "追込" }[v] || (["先行", "追込", "自在"].includes(v) ? v : "自在");
}
function gapMark(odds, fair, label) {
  // 実際のオッズと妥当オッズの差の印。比(オッズ ÷ 妥当オッズ = 期待値)で ▲▲ 1.5以上・▲ 1.2以上・▼ 0.8未満・▼▼ 0.5未満
  if (!odds || !fair) return "";
  const r = odds / fair;
  const [mark, cls] = r >= 1.5 ? ["▲▲", "gu2"] : r >= 1.2 ? ["▲", "gu1"] : r < 0.5 ? ["▼▼", "gd2"] : r < 0.8 ? ["▼", "gd1"] : ["", ""];
  if (!mark) return "";
  return `<span class="gap ${cls}" title="${label}: 実際のオッズ ${fix(odds)} ÷ 妥当オッズ ${fix(fair)} = ${r.toFixed(2)}(${r >= 1 ? "妥当より高い = 予想の上では得" : "妥当より低い = 予想の上では損"})">${mark}</span>`;
}
function fairRange(r, ms, col) {
  // 6モデルの確率の最小〜最大から、妥当オッズの幅(1 ÷ 確率)
  const v = ms.map(m => num(r[`${m}_${col}`])).filter(x => x != null && x > 0);
  if (!v.length) return "";
  return `${fix(1 / Math.max(...v))}〜${fix(1 / Math.min(...v))}`;
}
function cdot(r, name) {
  // 予想の数字の確度の印。点(0〜100)があれば5段階の円グラフ(○ ◔ ◑ ◕ ●)、無い古い CSV は3段階(● ◐ ○)。上にのせると点と根拠
  const c = r[`${name}の確度`];
  if (!c) return "";
  const why = r[`${name}の確度の根拠`] || "", pts = num(r[`${name}の確度の点`]);
  const cls = { "高": "h", "中": "m", "低": "l" }[c] || "m";
  const mark = pts != null ? "○◔◑◕●"[Math.min(4, Math.floor(pts / 20))] : { "高": "●", "中": "◐", "低": "○" }[c] || "◐";
  const tip = `${name}の確度 ${pts != null ? pts + "(" + c + ")" : c}${why ? ": " + why : ""}`;
  return `<span class="cdot c${cls}" title="${esc(tip)}">${mark}</span>`;
}
function passing(r) {
  const a = num(r["前半の番手"]), b = num(r["4角の番手"]);
  if (a == null && b == null) return "";
  return `${a ?? "-"}<span class="dim">→</span>${b ?? "-"}`;
}
function lastThree(r) {
  const v = num(r["上がり3Fの予想"]), k = num(r["上がりの順位"]);
  if (v == null) return "";
  return `${v.toFixed(1)}<span class="${k != null && k <= 3 ? "hi" : "dim"}">(${k ?? "-"})</span>`;
}
function confChip(r, name) {
  // 展開・馬場の数字の確度(予想 CSV の「<名前>の確度」)。上にのせると根拠
  const c = r[`${name}の確度`];
  if (!c) return "";
  return ` <span class="chip ${c === "高" ? "up" : c === "低" ? "warn" : "gray"}" title="${esc(r[`${name}の確度の根拠`] || "")}">確度 ${esc(c)}</span>`;
}
function levelRow(r) {
  // このレースのレベル(上位3頭の近5走の最高タイム指数の平均を、同じクラス・芝ダのレースと比べた 0〜100)
  const pts = num(r["レースのレベルの点"]);
  if (pts == null && !r["レースのレベルの確度"]) return "";
  const guide = r["レースのレベルの目安"] || "", i = guide.indexOf("(");
  const word = i > 0 ? guide.slice(0, i) : "", why = i > 0 ? guide.slice(i + 1, -1) : "";
  const tone = /かなり高い/.test(word) ? "warn" : /高い/.test(word) ? "" : /低い/.test(word) ? "up" : "gray";
  return `<div class="pace"><div class="pl">このレースのレベル</div><div><b>${pts != null ? pts : "-"}</b><span class="dim"> / 100</span>` +
    (word ? ` <span class="chip ${tone}">${esc(word)}</span>` : "") + confChip(r, "レースのレベル") +
    `<div class="note" style="margin:0">${esc(why)}${why ? "。" : ""}上位3頭の近5走の最高タイム指数の平均 ${esc(r["レースのレベル"] ?? "-")}。` +
    `${r["レースのレベルの確度の根拠"] ? "確度の根拠: " + esc(r["レースのレベルの確度の根拠"]) : ""}</div></div></div>`;
}
// 勝ちタイムの予想(レース情報.csv。基準 = 同じ競馬場・芝ダ・距離・馬場状態の過去3年の勝ちタイムの平均 + レースのレベルなどの補正)
const clock = v => v == null ? "" : `${Math.floor(v / 60)}:${(v % 60).toFixed(1).padStart(4, "0")}`;
function confPie(c, pts, why) {
  // 確度の印(confChip と同じ見た目に、点があれば5段階の円グラフを足す)。上にのせると点と根拠
  if (!c) return "";
  const mark = pts != null ? "○◔◑◕●"[Math.min(4, Math.floor(pts / 20))] + " " : "";
  return ` <span class="chip ${c === "高" ? "up" : c === "低" ? "warn" : "gray"}" title="${esc(`確度 ${pts != null ? pts + "(" + c + ")" : c}${why ? ": " + why : ""}`)}">${mark}確度 ${esc(c)}</span>`;
}
function settleConf(rows) {
  // 決着予想の確度: 各馬の「通過予想の確度の点」を、その馬が1〜3着に来る確率(Harville の式)で重み付けした平均
  const w = new Map();
  for (const [a, b, c, v] of harville(rows)) for (const x of [a, b, c]) w.set(String(+x), (w.get(String(+x)) || 0) + v);
  let s = 0, t = 0;
  for (const r of rows) {
    const pts = num(r["通過予想の確度の点"]), k = w.get(String(+r.umaban)) || 0;
    if (pts != null) { s += pts * k; t += k; }
  }
  if (!t) return null;
  const pts = Math.round(s / t);
  return { pts, c: pts >= 67 ? "高" : pts >= 34 ? "中" : "低",
    why: "1〜3着に来そうな馬ほど重く、各馬の通過予想(4角の番手)の確度の点を平均(3着内の確率で重み付け)" };
}
function winTimeRow(i) {
  const v = num(i?.["勝ちタイムの予想"]), base = num(i?.["勝ちタイムの基準"]);
  if (v == null) return "";
  const d = base == null ? null : v - base;
  const word = d == null ? "" : d <= -0.8 ? "速い" : d <= -0.3 ? "やや速い" : d >= 0.8 ? "遅い" : d >= 0.3 ? "やや遅い" : "普通";
  return `<div class="pace"><div class="pl">勝ちタイム</div><div><b>${clock(v)}前後</b>` +
    (word ? ` <span class="chip ${paceTone(word)}">${word}</span>` : "") + confPie(i["勝ちタイムの確度"], num(i["勝ちタイムの確度の点"]), i["勝ちタイムの確度の根拠"]) +
    `<div class="note" style="margin:0">${d == null ? "" : Math.abs(d) < 0.05 ? "基準と同じ" : `基準より ${Math.abs(d).toFixed(1)}秒${d < 0 ? "速い" : "遅い"}`}` +
    `${base != null ? `(基準: 同じ競馬場・芝ダ・距離・馬場状態の過去3年の勝ちタイムの平均 ${clock(base)})` : ""}` +
    `${i["勝ちタイムの幅"] ? `。半分のレースは ${esc(String(i["勝ちタイムの幅"]).split("〜").map(x => clock(+x)).join("〜"))} に入る` : ""}。` +
    `レースのレベル(上位3頭の指数)・前に行く馬の速さ・クラス・頭数で補正</div></div></div>`;
}
// 決着の形の予想: 1〜3着の組の確率(Harville の式。組み合わせ馬券と同じ)と予想の4角の番手から、
// 「前残り(1〜3着のうち2頭以上が4角で前)」「混ざった(1頭)」「差し・追込(0頭)」の確率。前 = 4角で max(3, 頭数の1/4) 番手以内。
// レース回顧の「決着」と同じ決め方で、回顧で予想と実際を比べる
const SETTLE = ["前残り", "混ざった", "差し・追込"];
function settleProbs(rows) {
  const n = rows.length, lim = Math.max(3, Math.round(n * 0.25));
  const front = new Set(rows.filter(r => num(r["4角の番手"]) != null && Math.round(num(r["4角の番手"])) <= lim).map(r => +r.umaban));
  if (!front.size) return null;
  const p = [0, 0, 0];
  let tot = 0;
  for (const [a, b, c, v] of harville(rows)) {
    const k = [a, b, c].filter(x => front.has(+x)).length;
    p[k >= 2 ? 0 : k === 1 ? 1 : 2] += v; tot += v;
  }
  return tot ? { p: p.map(x => x / tot), lim, front: [...front].sort((x, y) => x - y) } : null;
}
function settleRow(rows) {
  const s = settleProbs(rows);
  if (!s) return "";
  const i = s.p.indexOf(Math.max(...s.p));
  const sc = settleConf(rows);
  return `<div class="pace"><div class="pl">決着予想</div><div><b>${SETTLE[i]}</b> <span class="chip gray">${pct(s.p[i], 0)}</span>` +
    (sc ? confPie(sc.c, sc.pts, sc.why) : "") +
    `<div class="note" style="margin:0">${SETTLE.map((w, k) => `${w} ${pct(s.p[k], 0)}`).join("・")}。` +
    `4角で${s.lim}番手以内の予想の馬(${s.front.join("・")}番)が1〜3着に何頭入るかで分ける(2頭以上で前残り、0頭で差し・追込)</div></div></div>`;
}
function t1000Row(r) {
  // 前半1000m の通過タイムの予想(基準 = 同じ条件の過去3年の平均)
  const v = num(r["前半1000mの予想"]), base = num(r["前半1000mの基準"]);
  if (v == null) return "";
  const d = base == null ? null : v - base;
  const word = d == null ? "" : d <= -0.8 ? "速い" : d <= -0.3 ? "やや速い" : d >= 0.8 ? "遅い" : d >= 0.3 ? "やや遅い" : "普通";
  const diff = d == null ? "" : Math.abs(d) < 0.05 ? "基準と同じ" : `基準より ${Math.abs(d).toFixed(1)}秒${d < 0 ? "速い" : "遅い"}`;
  return `<div class="pace"><div class="pl">前半1000m</div><div><b>${v.toFixed(1)}秒前後</b>` +
    (word ? ` <span class="chip ${paceTone(word)}">${word}</span>` : "") + confChip(r, "前半1000m") +
    `<div class="note" style="margin:0">${diff}${base == null ? "" : `(基準: 同じ競馬場・芝ダ・距離・馬場状態の過去3年の平均 ${base.toFixed(1)}秒)`}` +
    (r["前半1000mの幅"] ? `。半分のレースは ${esc(r["前半1000mの幅"])}秒に入る` : "") +
    (r["前半1000mの確度の根拠"] ? `。確度の根拠: ${esc(r["前半1000mの確度の根拠"])}` : "") + `</div></div></div>`;
}
function biasTone(w) { return /並み/.test(w) ? "gray" : /やや/.test(w) ? "" : "warn"; }
function paceTone(w) { return /速い|多い/.test(w) ? (w.startsWith("やや") ? "" : "warn") : /遅い|少ない/.test(w) ? "up" : "gray"; }
// ---------- 自信と混戦の10段階 ----------
const CONF_WORDS = {10: "かなり高い", 9: "かなり高い", 8: "高い", 7: "高い", 6: "やや高い", 5: "普通", 4: "やや低い", 3: "低い", 2: "かなり低い", 1: "かなり低い"};
const MIX_WORDS = {10: "大混戦", 9: "大混戦", 8: "混戦", 7: "混戦", 6: "やや混戦", 5: "普通", 4: "やや堅い", 3: "堅い", 2: "かなり堅い", 1: "かなり堅い"};
function confLevel(rows) {
  // 予想 CSV の「自信の段階」(6モデル平均を検証期間と比べたもの)。無い古い CSV は、各モデルの自信の上位%の平均で代わりにする
  const r = rows[0], lv = num(r["自信の段階"]);
  if (lv) return withScore({ lv, top: num(r["自信の上位%(平均)"]), exact: true });
  const tops = models(rows).map(m => num(r[`${m}_自信の上位%`])).filter(v => v != null);
  if (!tops.length) return null;
  const top = tops.reduce((a, b) => a + b) / tops.length;
  return withScore({ lv: Math.min(10, Math.max(1, 10 - Math.floor(top / 10))), top, exact: false });
}
// 自信の100段階(2026-11-16 ユーザーの指示「10段階だけど100段階にできたりする？」)。検証期間のレースの中の上位% から 100 − 上位%(1〜100)。
// 10段階(推奨買い目・資金配分の組分けに使う)はそのまま。100段階は見る用で、買う・買わないの組分けには使わない(組が細かすぎて回収率が当てにならないため)
function withScore(c) {
  c.score = c.top != null ? Math.min(100, Math.max(1, Math.round(100 - c.top))) : c.lv * 10;
  return c;
}
function meter(lv, cls) {
  return `<div class="meter ${cls}">${Array.from({ length: 10 }, (_, i) => `<i class="${i < lv ? "on" : ""}"></i>`).join("")}</div>`;
}
function confMeter(rows) {
  const c = confLevel(rows), r0 = rows[0];
  if (!c) return "";
  return `<div class="mt"><div class="mh"><span class="ml">自信</span><b class="mv">${c.score}</b><span class="dim">/100</span>` +
    `<span class="chip ${c.lv >= 7 ? "up" : c.lv <= 3 ? "gray" : ""}">${CONF_WORDS[c.lv]}</span><span class="dim" title="推奨買い目・資金配分の組分けに使う10段階">(10段階で ${c.lv})</span></div>${meter(c.lv, "conf")}` +
    `<div class="note" style="margin:4px 0 0">予想1位の勝率 ${pct(num(r0["平均_自信"]))}。検証期間(2019〜2023年)のレースの中で上位 ${fix(c.top, 0)}%` +
    (c.exact ? "" : "(各モデルの平均で代用)") + `</div></div>`;
}
function mixScore(r0, lv) { const t = num(r0["混戦の上位%"]); return t != null ? Math.min(100, Math.max(1, Math.round(100 - t))) : lv * 10; }
function mixMeter(rows) {
  const r0 = rows[0], lv = num(r0["混戦の段階"]), n = num(r0["有力頭数"]), gap = num(r0["1位と2位の勝率差"]);
  if (!lv && n == null) return "";
  // 11/28 ユーザーの指示: 自信と同じく100段階で出す(混戦の上位% から。100 に近いほど混戦)
  const mtop = num(r0["混戦の上位%"]), score = mtop != null ? Math.min(100, Math.max(1, Math.round(100 - mtop))) : lv * 10;
  const head = lv ? `<b class="mv">${score}</b><span class="dim">/100</span><span class="chip ${lv >= 7 ? "warn" : "gray"}">${MIX_WORDS[lv]}</span><span class="dim" title="推奨買い目・資金配分の組分けに使う10段階">(10段階で ${lv})</span>` : "";
  return `<div class="mt"><div class="mh"><span class="ml">混戦</span>${head}</div>${lv ? meter(lv, "mix") : ""}` +
    `<div class="note" style="margin:4px 0 0">有力頭数 ${fix(n, 1)}頭(勝率が均等なら頭数と同じ、1強なら 1 に近い)・1位と2位の勝率差 ${pct(gap)}` +
    (lv ? `。混戦の度合いは上位 ${fix(num(r0["混戦の上位%"]), 0)}%` : "") + `</div></div>`;
}
function kpi(v, l) { return `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`; }

// 確率の列の変化(枠順確定の時点からのポイント差。+0.4% など)
function pctMove(r, col) {
  if (!changeView()) return "";
  const a = num(r[preCol(col)]), b = num(r[col]);
  if (a == null || b == null) return "";
  const d = (b - a) * 100;
  return Math.abs(d) < 0.05 ? "" : `<span class="chg ${d > 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${d.toFixed(1)}%</span>`;
}
// 着順の見込み(列の名前は 11/22 に「順位の幅」から変えた。右の欄の「順位の幅」= 6モデルの順位の差とは別。2026-11-22 ユーザーの指示「１～５みたいな感じの幅のある順位も併記して出せる？」「50の表の併記だけで大丈夫」):
// そのモデルの全頭の勝率から、勝率の高い馬から順に残りの馬の勝率の比で着順を決めるくり返し(Plackett-Luce)で着順の分布を作り、
// 25%点〜75%点(真ん中の半分)を出す。乱数は種を固定して、開くたびに同じ値にする。モデルの勝率だけから作った見込みの範囲
const RANK_BAND = new Map();
function rankBand(rid, m, umaban, given = null) {
  // given: 表に出している行(得意モデルだけの平均のときは出し直した行)。無ければ CSV の行
  const key = rid + "|" + m + (given && state.favActive ? "|fav" : "");
  const allRows = given || state.races.get(rid) || [], rows = activeRows(allRows);
  if (!rows.some(r => String(r.umaban) === String(umaban))) return undefined;
  const factors = m === "平均" ? raceFactors(allRows) : {l2: 1, l3: 1};
  if (!factors || rows.some(r => { const p = num(r[`${m}_勝率`]); return p == null || p < 0 || p > 1; })) return undefined;
  const signature = JSON.stringify([factors.l2, factors.l3, rows.map(r => [String(r.umaban), num(r[`${m}_勝率`])])]);
  if (RANK_BAND.get(key)?.signature !== signature) {
    const p = rows.map(x => Math.max(num(x[`${m}_勝率`]) ?? 0, 1e-6)), n = p.length, N = 4000;
    const cnt = rows.map(() => new Array(n).fill(0));
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let k = 0; k < N; k++) {
      const left = p.map((v, i) => i);
      for (let pos = 0; pos < n; pos++) {
        const weights = p.map(v => Math.pow(v, pos === 0 ? 1 : pos === 1 ? factors.l2 : factors.l3));
        const tot = left.reduce((s, i) => s + weights[i], 0);
        let u = rnd() * tot, j = 0;
        while (j < left.length - 1 && (u -= weights[left[j]]) > 0) j++;
        const h = left.splice(j, 1)[0]; cnt[h][pos]++;
      }
    }
    const band = new Map(rows.map((x, i) => {
      // [25%点, 75%点, 10%点, 90%点, 平均の着順](10%・90%・平均はビジュアライズ予想で使う)
      let c = 0, lo = null, hi = null, p10 = null, p90 = null, mean = 0;
      for (let pos = 0; pos < n; pos++) {
        const q = cnt[i][pos] / N; c += q; mean += q * (pos + 1);
        if (p10 == null && c >= 0.10) p10 = pos + 1; if (lo == null && c >= 0.25) lo = pos + 1;
        if (hi == null && c >= 0.75) hi = pos + 1; if (p90 == null && c >= 0.90) p90 = pos + 1;
      }
      return [String(x.umaban), [lo, hi, p10, p90, mean]];
    }));
    RANK_BAND.set(key, {signature, band});
  }
  return RANK_BAND.get(key).band.get(String(umaban));
}
// ビジュアライズ予想(2026-11-22 ユーザーの指示「『出走馬』項目の下の項目として…取りうるであろう順位などを図示する『ビジュアライズ予想』項目を追加したい」)
// 1頭1行。横の軸は着順(左が1着)。太い帯 = 着順の見込み(50%)、細い線 = 80% の範囲、点 = 平均の着順。並びは表と同じ(予想の順位)
function renderViz(rid, rows, favBox = "") {
  // 2026-11-22 ユーザーの指示: 馬体重確定前・後の切り替え、馬名の右に予想着順・実際の着順、予想着順・実際の着順・馬番で並べ替え(最初は予想の順位の並び)
  const n = rows.length;
  if (n < 2) return "";
  const hasPreV = rows.some(r => num(r["枠順時_勝率"]) != null);
  // 2026-11-28: 走破タイムの版(U69 の幅つき)。タイム_….csv があるレースだけ
  const secs = state.times?.get(rid);
  if (secs && state.vizAxis === "sec") return renderVizSec(rid, rows, secs, favBox);
  const pre = hasPreV && !!state.vizPre;
  const m = pre ? "枠順時" : "平均";
  const x = v => ((v - 0.5) / n * 100).toFixed(2) + "%";
  // 結果が出ていれば実際の着順の印(2026-11-22 ユーザーの指示「結果が出ていたら実結果を示す点をそれぞれの項目内に表示してほしい」)
  const res = new Map((state.results.get(rid) || []).map(x => [String(+x["馬番"]), num(x["着順"])]));
  const ticks = [...new Set([1, ...Array.from({ length: Math.floor(n / 5) }, (_, k) => (k + 1) * 5), n])].filter(v => v <= n);
  const gridTicks = [...new Set([...ticks, 2, 3])].filter(v => v <= n).sort((a, b) => a - b);   // 2着・3着の縦の点線も(2026-11-22 ユーザーの指示)
  const items = rows.map((r, i) => ({ r, i, b: rankBand(rid, m, r.umaban, !pre && state.favActive ? rows : null), k: res.get(String(+r.umaban)) }))
    .filter(o => o.b && o.b[0] != null);
  // 単勝オッズと人気(2026-11-22 ユーザーの指示。出走馬の表と同じ getOdds。人気はオッズの低い順)
  for (const o of items) o.o = getOdds(rid, o.r.umaban, o.r);
  const oddsSorted = items.map(o => o.o).filter(v => v != null && v > 0).sort((a, b) => a - b);
  for (const o of items) o.nk = o.o != null && o.o > 0 ? oddsSorted.indexOf(o.o) + 1 : null;
  const sort = ["res", "uma", "ninki", "odds"].includes(state.vizSort) ? state.vizSort : "pred";   // 11/22: 平均の着順の並びはやめた(予想着順とほぼ同じ)
  const big = 999;
  const dir = state.vizDir === -1 ? -1 : 1;   // 同じ見出しをもう一度押すと逆の順(2026-11-22 ユーザーの指示)
  if (sort === "ninki" || sort === "odds") items.sort((a, b) => (a.o ?? big) - (b.o ?? big) || a.b[4] - b.b[4]);
  else if (sort === "res") items.sort((a, b) => (a.k ?? big) - (b.k ?? big) || a.b[4] - b.b[4]);
  else if (sort === "uma") items.sort((a, b) => +a.r.umaban - +b.r.umaban);
  else if (pre) items.sort((a, b) => (num(a.r["枠順時_順位"]) ?? big) - (num(b.r["枠順時_順位"]) ?? big));
  if (dir === -1) {   // 逆の順。結果の無い馬は逆にしても下のまま
    const none = sort === "res" ? items.filter(o => o.k == null) : sort === "ninki" || sort === "odds" ? items.filter(o => o.o == null) : [];
    const rest = items.filter(o => !none.includes(o)).reverse();
    items.splice(0, items.length, ...rest, ...none);
  }
  // 並べ替えは列の見出しを押す(2026-11-22 ユーザーの指示「行のタイトルを押したらソートされる方式にして」)
  const sb = (k, l, tip) => `<span class="vizSort${sort === k ? " on" : ""}" data-k="${k}" title="${tip}で並べる">${l}${sort === k ? (dir === 1 ? " ▲" : " ▼") : ""}</span>`;
  let h = `<div class="card day-fold viz-card"><h3>ビジュアライズ予想<button class="help" data-help="viz" title="ビジュアライズ予想の各項目の説明">？</button>${updTag(["予想"], rid)}</h3>` +
    `<div class="calc" style="margin-bottom:6px;gap:10px">` +
    favBox + (secs ? `<span class="tabs" style="margin:0"><button class="vizAxis on" data-v="rank">着順</button><button class="vizAxis" data-v="sec" title="走破タイムの予想と幅(U69。予想の勝ちタイムを 0 にそろえる)">走破タイム</button></span>` : "") + (hasPreV ? `<label title="馬体重が出る前(枠順確定の時点)の予想の勝率で描く"><input type="checkbox" id="vizPre" ${pre ? "checked" : ""}> 馬体重確定前の予想</label>` : "") +
    `<span class="muted" style="font-size:12px">列の見出し(馬番・人気・単勝・予想着順・結果)を押すと並べ替え</span>` +
    `<button class="nkMarksBtn" title="このページの印を netkeiba のこのレースに転記する(確認のダイアログが出る。使い方は右の ？)">netkeiba に印を転記</button><button class="help nkHelpBtn" title="netkeiba への印の転記の使い方(ブックマークの登録)">？</button>${nkSentTag(rid)}</div>` +
    `<div class="viz"><div class="viz-row viz-axis"><div class="viz-mark muted">印</div><div class="viz-name">${sb("uma", "馬番・馬名", "馬番")}</div><div class="viz-jk muted">騎手</div><div class="viz-n">${sb("ninki", "人気", "人気")}</div><div class="viz-n">${sb("odds", "単勝", "単勝オッズ")}</div><div class="viz-n">${sb("pred", "予想着順", "予想着順")}</div><div class="viz-n">${sb("res", "結果", "結果")}</div><div class="viz-track">` +
    gridTicks.map(t => `<span class="viz-tick" style="left:${x(t)}">${ticks.includes(t) ? `${t}着` : t}</span>`).join("") + `</div><div></div></div>`;
  for (const { r, b, k, o, nk } of items) {
    const [lo, hi, p10, p90, mean] = b, inB = k != null && k >= lo && k <= hi;
    h += `<div class="viz-row" title="${esc(r.horse_name)}: 着順の見込み ${bandStr(b)}(80% の範囲 ${p10}〜${p90}、平均 ${mean.toFixed(1)}着)${k != null ? `・結果 ${k}着` : ""}">` +
      `<div class="viz-mark">${markSelect(rid, r.umaban)}</div><div class="viz-name">${umaBadge(r.umaban, n)} ${esc(r.horse_name)}</div><div class="viz-jk">${jkLink(rid, r)}</div>` +
      `<div class="viz-n">${nk ?? `<span class="dim">-</span>`}</div><div class="viz-n">${o != null ? fix(o) : `<span class="dim">-</span>`}</div><div class="viz-n">${num(r[pre ? "枠順時_順位" : "平均_順位"]) ?? "-"}${cdot(r, "予想")}</div>` +
      `<div class="viz-n">${k != null ? `<b class="${inB ? "hi" : ""}">${k}</b>` : `<span class="dim">-</span>`}</div><div class="viz-track">` +
      gridTicks.map(t => `<span class="viz-grid" style="left:${x(t)}"></span>`).join("") +
      `<span class="viz-w" style="left:${x(p10)};width:calc(${x(p90)} - ${x(p10)})"></span>` +
      `<span class="viz-b" style="left:calc(${x(lo)} - 6px);width:calc(${x(hi)} - ${x(lo)} + 12px)"></span>` +
      `<span class="viz-dot" style="left:${x(mean)}"></span>` +
      (k != null && k >= 1 && k <= n ? `<span class="viz-res${inB ? " in" : ""}" style="left:${x(k)}" title="結果 ${k}着"></span>` : "") +
      `</div><div class="viz-txt">${bandStr(b)}</div></div>`;
  }
  return h + `</div><div class="note">${pre ? "馬体重確定前(枠順確定の時点)" : "今"}の平均の勝率から、勝率の高い馬から順に残りの馬の勝率の比で着順を決めるくり返しで作った着順の分布。` +
    `「予想着順」は予想の順位(勝率の順)、「結果」は実際の着順。太い帯は実際の着順が半々で入る範囲(表の「着順の見込み」)、細い線は 80% の範囲、点は平均の着順。` +
    `結果が出たレースは、実際の着順を黄色の ◆ で出す。帯が短いほど予想がはっきりしている。モデルの勝率だけから作った見込みで、当たり方はまだ確かめていない。</div></div>`;
}
function renderVizSec(rid, rows, secs, favBox) {
  // 走破タイムの版(U69。2026-11-28 ユーザーの指示「着順と同じように騎手・人気・単勝」「予想走破タイムの列」
  // 「グラフの0秒を予想走破タイム(予想の勝ちタイム)にし、結果はそれを基に点を打つ」)。
  // 横の軸 = 予想の勝ちタイム(そのレースで一番速い予想)からの秒。点 = その馬の予想、帯 = 20〜80% の幅、◆ = 実際の走破タイム − 予想の勝ちタイム
  const n = rows.length;
  // 馬体重確定前の版(11/28 ユーザーの指示)。チェックは着順の版と共通(state.vizPre)
  const preT = state.timesPre?.get(rid), usePre = !!(preT && state.vizPre);
  if (usePre) secs = preT;
  const any = [...secs.values()][0] || {};
  const hasT = any.t != null;
  const t0 = hasT ? Math.min(...[...secs.values()].map(v => v.t).filter(v => v != null)) : null;   // 予想の勝ちタイム
  const resRows = state.results.get(rid) || [];
  const win = resRows.find(x => num(x["着順"]) === 1);
  const resOf = u => {
    const x = resRows.find(y => String(+y["馬番"]) === u);
    if (!x) return null;
    if (hasT) { const a = parseRunTime(x["走破タイム"]); return a == null ? null : a - t0; }
    return num(x["着順"]) === 1 ? 0 : num(x["タイム差"]);   // 予想タイムが無いときは 1着からの秒差
  };
  const items = rows.map(r => { const u = String(+r.umaban), v = secs.get(u); return v && v.s != null ? { r, v, k: resOf(u), o: getOdds(rid, r.umaban, r) } : null; }).filter(Boolean);
  const anyRes = items.some(it => it.k != null);   // 11/28 ユーザーの指示: 結果が出ていないときは結果の列ごと出さない
  const oddsSorted = items.map(o => o.o).filter(v => v != null && v > 0).sort((a, b) => a - b);
  for (const o of items) o.nk = o.o != null && o.o > 0 ? oddsSorted.indexOf(o.o) + 1 : null;
  const sort = ["uma", "res", "ninki", "odds"].includes(state.vizSort) ? state.vizSort : "pred";
  const dir = state.vizDir === -1 ? -1 : 1;
  const val = o => sort === "uma" ? +o.r.umaban : sort === "res" ? o.k : sort === "ninki" ? o.nk : sort === "odds" ? o.o : o.v.s;
  items.sort((a, b) => val(a) == null ? (val(b) == null ? +a.r.umaban - +b.r.umaban : 1) :
    val(b) == null ? -1 : dir * (val(a) - val(b)) || +a.r.umaban - +b.r.umaban);
  const sb = (k, label, tip) => `<span class="vizSort${sort === k ? " on" : ""}" data-k="${k}" title="${tip}で並べる">${label}${sort === k ? (dir === 1 ? " ▲" : " ▼") : ""}</span>`;
  // 軸の範囲: 予想の幅と結果がおさまるように(はみ出す結果は端に寄せる)。0.5秒刻みに丸める
  const vals = items.flatMap(o => [o.v.lo, o.v.hi, o.k].filter(v => v != null));
  const lo = Math.floor(Math.min(-0.5, ...vals.filter(v => v > -3)) * 2) / 2, hi = Math.ceil(Math.min(Math.max(1, ...vals), 6) * 2) / 2;
  const x = v => ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo) * 96 + 2).toFixed(2) + "%";
  const step = hi - lo > 4 ? 1 : 0.5, ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(1));
  const lab = v => v === 0 ? (hasT ? clock(t0) : "0秒") : `${v > 0 ? "+" : ""}${v}秒`;
  const tm = v => v == null ? "-" : hasT ? clock(t0 + v) : `${v.toFixed(2)}秒`;
  let h = `<div class="card day-fold viz-card"><h3>ビジュアライズ予想<button class="help" data-help="viz" title="ビジュアライズ予想の各項目の説明">？</button>${updTag(["予想", "タイム"], rid)}</h3>` +
    `<div class="calc" style="margin-bottom:6px;gap:10px">${favBox}<span class="tabs" style="margin:0"><button class="vizAxis" data-v="rank">着順</button><button class="vizAxis on" data-v="sec">走破タイム</button></span>` +
    (preT ? `<label title="馬体重が出る前の特徴量で予想した走破タイムで描く"><input type="checkbox" id="vizPre" ${usePre ? "checked" : ""}> 馬体重確定前の予想</label>` : "") +
    `<span class="muted" style="font-size:12px">列の見出し(馬番・人気・単勝・予想タイム・結果)を押すと並べ替え</span></div>` +
    `<div class="viz${anyRes ? "" : " nores"}"><div class="viz-row viz-axis"><div class="viz-mark muted">印</div><div class="viz-name">${sb("uma", "馬番・馬名", "馬番")}</div><div class="viz-jk muted">騎手</div>` +
    `<div class="viz-n">${sb("ninki", "人気", "人気")}</div><div class="viz-n">${sb("odds", "単勝", "単勝オッズ")}</div><div class="viz-n">${sb("pred", "予想", "予想タイム")}</div>${anyRes ? `<div class="viz-n">${sb("res", "結果", "実際の走破タイム")}</div>` : ""}<div class="viz-track">` +
    ticks.map(t => `<span class="viz-tick" style="left:${x(t)}${t === 0 ? ";font-weight:700;color:var(--text)" : ""}">${lab(t)}</span>`).join("") + `</div><div></div></div>`;
  for (const { r, v, k, o, nk } of items) {
    const inB = k != null && v.lo != null && v.hi != null && k >= v.lo - 1e-9 && k <= v.hi + 1e-9;
    h += `<div class="viz-row" title="${esc(r.horse_name)}: 予想 ${tm(v.s)}(20〜80% ${tm(v.lo)}〜${tm(v.hi)})${k != null ? `・結果 ${tm(k)}` : ""}">` +
      `<div class="viz-mark">${markSelect(rid, r.umaban)}</div><div class="viz-name">${umaBadge(r.umaban, n)} ${esc(r.horse_name)}</div><div class="viz-jk">${jkLink(rid, r)}</div>` +
      `<div class="viz-n">${nk ?? `<span class="dim">-</span>`}</div><div class="viz-n">${o != null ? fix(o) : `<span class="dim">-</span>`}</div>` +
      `<div class="viz-n">${tm(v.s)}</div>${anyRes ? `<div class="viz-n">${k != null ? `<b class="${inB ? "hi" : ""}">${tm(k)}</b>` : `<span class="dim">-</span>`}</div>` : ""}<div class="viz-track">` +
      ticks.map(t => `<span class="viz-grid" style="left:${x(t)}${t === 0 ? ";opacity:.9;border-left-style:solid" : ""}"></span>`).join("") +
      (v.lo != null && v.hi != null ? `<span class="viz-b" style="left:calc(${x(v.lo)} - 6px);width:calc(${x(v.hi)} - ${x(v.lo)} + 12px)"></span>` : "") +
      `<span class="viz-dot" style="left:${x(v.s)}"></span>` + (k != null ? `<span class="viz-res${inB ? " in" : ""}" style="left:${x(k)}" title="結果 ${tm(k)}"></span>` : "") +
      `</div><div class="viz-txt">${v.lo != null ? `${v.lo.toFixed(1)}〜${v.hi.toFixed(1)}` : ""}</div></div>`;
  }
  return h + `</div><div class="note">走破タイムの予想(U69。LightGBM の分位回帰で 1着からの秒差の 20%・50%・80% を予想し、勝ちタイムの予想に足したもの)。` +
    `横の軸の 0 は、このレースの予想の勝ちタイム${hasT ? `(${clock(t0)})` : ""}で、右へいくほど遅い。点は予想、帯は 20〜80% の幅、◆ は実際の走破タイム(結果が出たら。帯の中なら緑)。` +
    `右端の数字は幅(予想の勝ちタイムからの秒)。2023年で確かめると、幅に実際が入った割合は 56%(狙いの 60% より少し狭い)。勝ちタイムの予想のぶれはまだ幅に入っていない。予想(勝率)には使っていない。<br>` +
    `<b>着順の版と並びが違うことがある理由</b>: ①別のモデル(着順の版は本番の6本の平均の勝率、こちらは U69 の1本で、馬のレーティング U71 は入っていない)、` +
    `②予想するものが違う(着順の版は「1着になる確率」、こちらは「ふつうに走ったときのタイム」。ぶれの大きい馬は勝率では上でも、真ん中のタイムでは下になりやすい)、` +
    `③隣の馬との差が 0.1秒未満のことが多く、わずかな差で入れ替わる。${usePre ? "今は馬体重が出る前の版。" : ""}</div></div>`;
}
function vizHelpHTML() {
  return `<p>1頭1行で、その馬が実際に何着くらいに来そうかの見込みを横向きの図で出す。横の軸は着順で、左が1着、右が最下位。</p>` +
    `<h3>図の見方</h3><table>` +
    `<tr><th>太い帯</th><td>着順の見込み。実際の着順が半々(50%)の確率でこの範囲に入る見込み。右端の「1〜4」などの数字と、出走馬の表の「着順の見込み」と同じ。帯が短いほど予想がはっきりしていて、長いほどどこに来てもおかしくない。</td></tr>` +
    `<tr><th>細い線</th><td>80% の確率で入る範囲(広めに見たとき)。</td></tr>` +
    `<tr><th>丸い点</th><td>平均の着順(下の「作り方」のくり返しで出た着順の平均)。行にのせると数字でも出る。</td></tr>` +
    `<tr><th>◆</th><td>結果が出たレースの実際の着順(黄色)。</td></tr></table>` +
    `<h3>列</h3><table>` +
    `<tr><th>予想着順</th><td>予想の順位(6モデルの平均の勝率が高い順)。出走馬の表の「予」の列と同じ。</td></tr>` +
    `<tr><th>結果</th><td>実際の着順(結果が出たレースだけ)。着順の見込みの帯の中なら緑の字。</td></tr></table>` +
    `<h3>並び</h3><table>` +
    `<tr><th>人気・単勝</th><td>単勝オッズと、その低い順の人気(出走馬の表と同じオッズ。発走前は今のオッズ、終わったレースは確定オッズ)。</td></tr>` +
    `<tr><th>並べ替え</th><td>列の見出し(馬番・馬名、人気、単勝、予想着順、結果)を押すと、その順に並ぶ。同じ見出しをもう一度押すと逆の順(▲ 小さい順・▼ 大きい順)。最初は予想着順の小さい順。</td></tr>` +
    `<tr><th>印</th><td>左端の「印」の列で印(◎ 〇 ▲ △ ★ ✓ 消)を付けられる。出走馬の表の印と共通で、どちらで付けても両方に出る。</td></tr>` +
    `<tr><th>予想着順</th><td>予想の順位(6モデルの平均の勝率が高い順)。横の印は確度(○ ◔ ◑ ◕ ● の5段階で、●ほど当たりやすい。出走馬の表の馬名の横と同じ)。</td></tr>` +
    `<tr><th>結果</th><td>実際の着順の順(結果の無い馬は下)。</td></tr>` +
    `<tr><th>馬番</th><td>馬番の順。</td></tr></table>` +
    `<h3>馬体重確定前の予想</h3><p>✓を入れると、馬体重が出る前(枠順確定の時点)の予想の勝率で描き直す。馬体重や当日の馬場傾向で見込みがどう変わったかを比べられる。枠順確定の時点の値が無いレースでは出ない。</p>` +
    `<h3>作り方</h3><p>そのレースの全頭の勝率から、勝率の高い馬から順に、残った馬の勝率の比で次の着順を決める(1着を決めたら、残りの馬で2着を決める…)。` +
    `これを4000回くり返して、馬ごとに何着が何回出たかを数え、着順の分布を作る。乱数は毎回同じなので、開き直しても同じ値になる。` +
    `「得意モデルのみの予想を表示」に✓があるときは、得意モデルだけの平均の勝率から作る。</p>` +
    `<p class="muted">モデルの勝率だけから作った見込みで、実際にこの割合で帯の中に入るかは、まだ確かめていない。予想 CSV は変えず、ビューアの中だけで計算している。</p>`;
}
function bandStr(b) { return b && b[0] != null ? (b[0] === b[1] ? `${b[0]}` : `${b[0]}〜${b[1]}`) : "-"; }
function detail(r, ms) {
  const rankMv = m => { const a = num(r[preCol(`${m}_順位`)]), b = num(r[`${m}_順位`]); return changeView() && a != null && b != null ? moveMark(a - b) : ""; };   // ↑ は順位が上がった
  let t = `<div class="grid2"><div class="scroll"><table><tr><th>モデル</th><th class="n">順位</th><th class="n" title="そのモデルの全頭の勝率から作った着順の分布の、真ん中の半分(25%〜75%)の範囲。実際の着順が半々でこの範囲に入る見込み">着順の見込み</th><th class="n">勝率</th><th class="n">2着内</th><th class="n">3着内</th></tr>`;
  const bandTxt = m => bandStr(rankBand(r.race_id, m, r.umaban));
  for (const m of ms) t += `<tr><td>${esc(m)}</td><td class="n">${esc(r[`${m}_順位`])}${rankMv(m)}</td><td class="n">${bandTxt(m)}</td>` +
    `<td class="n">${pct(num(r[`${m}_勝率`]))}${pctMove(r, `${m}_勝率`)}</td>` +
    `<td class="n">${pct(num(r[`${m}_2着内`]))}${pctMove(r, `${m}_2着内`)}</td><td class="n">${pct(num(r[`${m}_3着内`]))}${pctMove(r, `${m}_3着内`)}</td></tr>`;
  t += `</table></div><dl class="kv">`;
  // 項目 → どの確度を付けるか(勝率のばらつき・順位の幅は、それ自体が予想の確度の目安)
  t += `<dt>妥当オッズ(単勝)</dt><dd>${fix(num(r["妥当オッズ_単勝"]))}${colMove(r, "妥当オッズ_単勝", 1, true)}<span class="dim">(6モデルで ${fairRange(r, ms, "勝率")})</span>${cdot(r, "予想")}</dd>`;
  t += `<dt>妥当オッズ(複勝)</dt><dd>${fix(num(r["妥当オッズ_複勝"]))}${colMove(r, "妥当オッズ_複勝", 1, true)}<span class="dim">(6モデルで ${fairRange(r, ms, "3着内")})</span>${cdot(r, "予想")}</dd>`;
  const extra = [["1着の確率", "予想"], ["2着の確率", "予想"], ["3着の確率", "予想"], ["4着の確率", "予想"], ["5着の確率", "予想"],
    ["勝率のばらつき", "目安"], ["順位の幅", "目安"], ["位置取り(近5走、0=前・1=後ろ)", "脚質"], ["前に行く順位", "脚質"],
    ["前半の速さの順位", "前半の速さ"]];
  for (const [c, k] of extra) if (c in r && r[c] !== "") {
    const mark = k === "目安" ? ` <span class="dim" title="6モデルの意見の割れ具合。小さいほど予想の確度が高い">(確度の目安)</span>` : cdot(r, k);
    // 変化: 確率はポイント差、ばらつき・順位の幅・順位は小さいほど緑、位置取りは数字の増減
    const mv = c.endsWith("確率") ? pctMove(r, c) : c === "勝率のばらつき" ? colMove(r, c, 4, true)
      : c.endsWith("順位") || c === "順位の幅" ? colMove(r, c, 1, true) : colMove(r, c, 3);
    t += `<dt>${esc(c)}</dt><dd>${c.endsWith("確率") ? pct(num(r[c])) : esc(r[c])}${mv}${mark}</dd>`;
  }
  if (r["根拠_上げた"]) t += `<dt>根拠(上げた)</dt><dd>${reasonText(r["根拠_上げた"])}${cdot(r, "予想")}</dd>`;
  if (r["根拠_下げた"]) t += `<dt>根拠(下げた)</dt><dd>${reasonText(r["根拠_下げた"])}${cdot(r, "予想")}</dd>`;
  return t + `</dl>${changeView() ? preDiffList(r) : ""}<div class="note">根拠のかっこ内は、その項目でこの馬の点数が同じレースの平均より上がった・下がった分(説明用の LightGBM の点数)。` +
    `点数の差 d は、勝つ見込みを約 e<sup>d</sup> 倍にする(+0.5 で約1.6倍、+0.2 で約1.2倍、−0.1 で約0.9倍)。</div></div>`;
}

// ---------- 推奨買い目と、入れた予算での資金配分 ----------
const BUDGET_TIERS = [[500, "〜500円"], [1000, "600〜1000円"], [3000, "1100〜3000円"], [5000, "3100〜5000円"], [Infinity, "5100円以上"]];
function savedBudget() { try { return num(localStorage.getItem("keiba-viewer:budget")); } catch (e) { return state.budget ?? null; } }
function saveBudget(v) { state.budget = v; try { localStorage.setItem("keiba-viewer:budget", v ?? ""); } catch (e) {} }
// このレースだけの手入力の予算(日別ページの資金配分案から送ったもの)。あれば共通の手入力より先に使う
function raceBudgetOf(rid) {
  if (!state.raceBudget) state.raceBudget = {};
  if (!(rid in state.raceBudget)) {
    let v = null;
    try { v = num(localStorage.getItem(`keiba-viewer:budget:${rid}`)); } catch (e) {}
    state.raceBudget[rid] = v || null;
  }
  return state.raceBudget[rid];
}
function saveRaceBudget(rid, v) {
  if (!state.raceBudget) state.raceBudget = {};
  state.raceBudget[rid] = v || null;
  try { if (v) localStorage.setItem(`keiba-viewer:budget:${rid}`, v); else localStorage.removeItem(`keiba-viewer:budget:${rid}`); } catch (e) {}
}
function savedMode() { try { return localStorage.getItem("keiba-viewer:alloc") || "均等"; } catch (e) { return state.alloc || "均等"; } }
function saveMode(v) { state.alloc = v; try { localStorage.setItem("keiba-viewer:alloc", v); } catch (e) {} }

function activeRows(rows) { return rows.filter(r => num(r["オッズで取消"]) !== 1); }
function placeCount(rows) {
  const active = activeRows(rows), values = active.map(r => num(r["複勝着払キー"]));
  if (!active.length) return null;
  if (active.every(r => !("複勝着払キー" in r))) return active.length < 5 ? 0 : active.length < 8 ? 2 : 3;
  if (active.some(r => !("複勝着払キー" in r)) || values.some(v => v == null || ![0, 2, 3].includes(v) || v !== values[0])) return null;
  return values[0];
}
function raceBlocked(rid) {
  const rows = state.races.get(rid);
  return !!rows?.length && (activeRows(rows).length !== rows.length || !probabilityReady(rows) || placeCount(rows) == null);
}
function ticketEligible(rows, ticket) {
  return !ticketExclusion(rows, ticket);
}
function ticketExclusion(rows, ticket) {
  if (!rows?.length) return "出走馬未確認";
  const spec = CALC_KINDS[ticket.kind], t = ticket.t;
  if (!spec || !Array.isArray(t) || t.length !== spec[0] || new Set(t.map(String)).size !== t.length) return "買い目不正";
  if (ticket.kind === "複勝" && placeCount(rows) === 0) return "複勝発売無し";
  const valid = new Set(activeRows(rows).map(r => String(r.umaban)));
  if (!t.every(u => valid.has(String(u)))) return "取消扱い";
  if (ticket.kind === "複勝" && placeCount(rows) == null) return "発売条件未確認";
  return "";
}
function harville(raceRows) {
  // 予想に使うモデルの平均の勝率から、着順の上位3頭の並びごとの確率(補正つきの Harville の式)。
  // 1着は勝率の比、2着は残りの馬の 勝率^λ2 の比、3着は 勝率^λ3 の比。λ は予想 CSV の「着順の補正_2着・3着」
  // (2026-11-13 からの予想。それより前の予想には列が無いので λ=1 = もとの Harville の式)
  if (!probabilityReady(raceRows)) return [];
  const {l2, l3} = raceFactors(raceRows);
  const horses = activeRows(raceRows).map(r => [String(r.umaban), Math.max(num(r["平均_勝率"]) || 0, 1e-12)]);
  const total = horses.reduce((a, [, p]) => a + p, 0) || 1;
  const q = horses.map(([u, p]) => [u, p / total, Math.pow(p / total, l2), Math.pow(p / total, l3)]);
  if (q.length === 1) return [[q[0][0], null, null, 1]];
  if (q.length === 2) return q.map(([a, p], i) => [a, q[1 - i][0], null, p]);
  const s2 = q.reduce((a, x) => a + x[2], 0), s3 = q.reduce((a, x) => a + x[3], 0);
  const out = [];
  for (const [a, pa, , ta] of q) for (const [b, , qb, tb] of q) {
    if (b === a) continue;
    const d2 = s2 - q.find(x => x[0] === a)[2], d3 = s3 - ta - tb;
    if (d2 <= 0 || d3 <= 0) continue;
    for (const [c, , , tc] of q) {
      if (c === a || c === b) continue;
      out.push([a, b, c, pa * qb / d2 * tc / d3]);
    }
  }
  return out;
}
function hits(kind, t, [a, b, c], places) {
  // 着順 a-b-c(3着まで)で、買い目 t(馬番の配列)が当たるか
  const top2 = [a, b], top3 = [a, b, c];
  switch (kind) {
    case "単勝": return t[0] === a;
    case "複勝": return top3.slice(0, places).includes(t[0]);
    case "ワイド": return t.every(x => top3.includes(x));
    case "馬連": return t.every(x => top2.includes(x));
    case "馬単": return t[0] === a && t[1] === b;
    case "3連複": return t.every(x => top3.includes(x));
    case "3連単": return t[0] === a && t[1] === b && t[2] === c;
  }
  return false;
}
function allocWeights(mode, probs, odds) {
  // 配分の重み。均等: 同じ。確率比例: 確率。払戻均等化: 1 ÷ オッズ(当たればどれでも払戻がほぼ同じ。オッズが無ければ妥当オッズ)。
  // 期待値追求型: 期待値(確率 × オッズ)が 1 を超える分(1 を超える買い目が無ければ期待値そのもの)。オッズの無い買い目は買わない
  return probs.map((p, i) => {
    const o = odds[i];
    if (mode === "均等") return 1;
    if (mode === "確率比例") return p;
    if (mode === "払戻均等化") return o ? 1 / o : p;
    return o ? p * o : 0;
  }).map((w, i, ws) => {
    if (mode !== "期待値追求型") return w;
    const anyEdge = ws.some(x => x > 1);
    return anyEdge ? Math.max(0, w - 1) : w;
  });
}
function allocate(budget, probs, mode, odds = []) {
  // 100円単位の配分。重みの大きい買い目から1点100円ずつ置き(予算が点数に足りなければ重みの小さい買い目は外す)、残りを重みで分ける。
  // 均等は残りを同じだけ、余りは確率の高い順に100円ずつ。重みが0の買い目(期待値追求型でオッズが無い・期待値が低い)は買わない
  const n = probs.length, units = Math.floor(budget / 100);
  const w = allocWeights(mode, probs, odds);
  const key = mode === "均等" ? probs : w;
  const order = key.map((v, i) => [v, i]).filter(([v]) => mode === "均等" || v > 0).sort((x, y) => y[0] - x[0]).map(([, i]) => i);
  const amt = new Array(n).fill(0);
  const use = order.slice(0, Math.min(order.length, units));
  if (!use.length) return amt;
  let left = units - use.length;
  use.forEach(i => amt[i] = 1);
  if (mode === "均等") {
    const each = Math.floor(left / use.length);
    use.forEach(i => amt[i] += each); left -= each * use.length;
  } else {
    // 1点100円を置いたあとの残りを、重みに合わせて足す(払戻均等化は 金額 ∝ 重み になるように全体で合わせる)
    const ws = use.reduce((s, i) => s + w[i], 0) || 1;
    const target = use.map(i => [i, units * w[i] / ws - 1]);
    const plus = target.map(([i, v]) => [i, Math.max(0, v)]);
    const sum = plus.reduce((s, [, v]) => s + v, 0) || 1;
    const share = plus.map(([i, v]) => [i, left * v / sum]);
    share.forEach(([i, v]) => amt[i] += Math.floor(v));
    left -= share.reduce((s, [, v]) => s + Math.floor(v), 0);
    share.sort((x, y) => (y[1] % 1) - (x[1] % 1));
    for (const [i] of share) { if (left <= 0) break; amt[i]++; left--; }
  }
  for (const i of use) { if (left <= 0) break; amt[i]++; left--; }
  return amt.map(u => u * 100);
}

function planSel() {
  const ok = v => v === "manual" || FUND_MODES.some(([k]) => k === v) ? v : "manual";
  try { return ok(localStorage.getItem("keiba-viewer:planSel")); } catch (e) { return ok(state.planSel); }
}
function renderPlan(rid) {
  if (state.planTickets) state.planTickets[rid] = [];
  const allPlans = state.plans.get(rid);
  const all = allPlans?.filter(x => !(x["券種"] === "複勝" && placeCount(state.races.get(rid) || []) === 0));
  if (!all) return state.plans.size ? "" : `<div class="card muted">推奨買い目は、<code>推奨買い目</code> フォルダの CSV も落とすと出ます。</div>`;
  if (!all.length) return `<div class="card">発売中の券種の推奨買い目はありません。</div>`;
  // 推奨の種類(おすすめ・組み合わせ・券種別)。古い CSV(種類の列なし)は「おすすめ」だけ
  const kindOfRow = x => x["種類"] || "おすすめ";
  const modes = ["おすすめ", "組み合わせ", "券種別"].filter(m => all.some(x => kindOfRow(x) === m));
  const pmode = modes.includes(state.planMode) ? state.planMode : modes[0];
  const inMode = all.filter(x => kindOfRow(x) === pmode);
  const groups = [...new Set(inMode.map(x => x["分け"] || pmode))];     // 券種別のときは券種
  const pgroup = groups.includes(state.planGroup) ? state.planGroup : groups[0];
  const rowsG = inMode.filter(x => (x["分け"] || pmode) === pgroup);
  const tiers = [...new Set(rowsG.map(x => x["予算"]))];
  const own = raceBudgetOf(rid);
  const budget = own ?? savedBudget(), mode = savedMode();
  let tierName = budget ? BUDGET_TIERS.find(([lim]) => budget <= lim)[1] : null;
  if (own) {
    // 資金配分案から送った額: 日別ページと同じく、点数 × 100円 が額を超えるなら収まる下の区分にする
    const pts = t => rowsG.filter(x => x["予算"] === t).reduce((a, x) => a + (num(x["点数"]) || 0), 0);
    for (let k = BUDGET_TIERS.findIndex(([, n]) => n === tierName); k >= 0; k--) {
      const t = BUDGET_TIERS[k][1];
      if (tiers.includes(t) && pts(t) > 0 && pts(t) * 100 <= own) { tierName = t; break; }
    }
  }
  // 手入力の予算があればその金額が入る区分の買い方を使う(区分のボタンは選ばない)。無ければ選んだ区分
  const tab = tierName && tiers.includes(tierName) ? tierName : tiers.includes(state.planTab) ? state.planTab : tiers[0];
  const tierOn = t => !budget && t === tab;
  let parts = rowsG.filter(x => x["予算"] === tab);       // 1つ(組み合わせは2つ)の買い方
  // 買い方の選び方のモード(2026-11-21 ユーザーの指示): 手動(上のタブで選ぶ)のほか、日別ページと同じ 回収率重視・的中重視(ワイド抜き)・ワイド・超的中重視 で自動で選ぶ
  const psel = planSel();
  let autoOpt = null;
  if (psel !== "manual") {
    FUND_MODE_OVERRIDE = psel;
    const opts = fundOptions(rid);
    const amount = budget ?? (BUDGET_TIERS.find(([, n]) => n === tab)?.[0] ?? 500);
    autoOpt = opts.length ? fundChoose(opts, Number.isFinite(amount) ? amount : 100000) : null;
    FUND_MODE_OVERRIDE = null;
    if (autoOpt) parts = autoOpt.parts;
  }
  const r = parts[0];
  const raceRows = state.races.get(rid) || [];
  const tosu = activeRows(raceRows).length, places = placeCount(raceRows);
  if (!probabilityReady(raceRows) || places == null) return `<div class="card">予想値・補正係数または発売条件が不一致のため計算できません</div>`;
  // 買い目を全部の買い方から集める(券種・組・CSV のオッズ)
  const tickets = [];
  for (const x of parts) {
    const odds = (x["買い目のオッズ"] || "").split(" / ");
    (x["買い目"] || "").split(" / ").filter(t => /\d/.test(t)).forEach((t, i) =>
      tickets.push({ kind: x["券種"], t: t.split(/[-→]/), csvOdds: num(odds[i]) }));
  }
  for (let i = tickets.length - 1; i >= 0; i--) if (!ticketEligible(raceRows, tickets[i])) tickets.splice(i, 1);
  const kinds = [...new Set(parts.map(x => x["券種"]))];
  const roi = num(r?.["過去の回収率"]), honest = num(r?.["確かめの回収率"]);
  const fs = favSame(rid);
  let h = `<div class="card"><h3>推奨買い目と資金配分${updTag(["推奨買い目", "オッズ"], rid)}` +
    (fs == null ? "" : ` <span class="chip ${fs ? "gray" : "up"}" title="モデルの1位(平均の勝率)と単勝の1番人気(今のオッズ)。日別ページの「1位≠1番人気だけ」では、同じレースは買わない">${fs ? "1位＝1番人気" : "1位≠1番人気"}</span>`) + `</h3>` +
    `<div class="tabs psel" style="margin-bottom:6px"><span class="muted" style="align-self:center;margin-right:6px">選び方:</span>` +
    [["manual", "手動で選ぶ", "下のタブで買い方を選ぶ"], ...FUND_MODES].map(([k, l, tip]) =>
      `<button data-t="${k}" class="${k === psel ? "on" : ""}" title="${esc(tip)}">${l}</button>`).join("") +
    (autoOpt ? `<span class="muted" style="align-self:center;margin-left:6px">→ ${esc(autoOpt.name)}の${esc(fundLabel(autoOpt))}${autoOpt.hit != null ? `(過去の的中率 ${fix(autoOpt.hit)}%)` : ""}</span>` : "") + `</div>` +
    (psel !== "manual" ? "" : `<div class="tabs pmode" style="margin-bottom:6px">` + modes.map(m => `<button data-t="${m}" class="${m === pmode ? "on" : ""}" title="${
      { "おすすめ": "1つの買い方で一番良かったもの", "組み合わせ": "券種の違う2つの買い方を合わせて一番良かったもの", "券種別": "券種ごとに一番良かった買い方" }[m]}">${
      { "おすすめ": "おすすめ(1券種)", "組み合わせ": "券種を組み合わせ", "券種別": "券種別" }[m]}</button>`).join("") + `</div>`) +
    (psel === "manual" && pmode === "券種別" ? `<div class="tabs pgroup" style="margin-bottom:6px">` +
      groups.map(g => `<button data-t="${esc(g)}" class="${g === pgroup ? "on" : ""}">${esc(g)}</button>`).join("") + `</div>` : "") +
    // 予算: 固定の区分と手入力を同じ列に。手入力を使うと区分の選択は外れる
    `<div class="tabs plan" style="align-items:center">` + tiers.map(t => `<button data-t="${esc(t)}" class="${tierOn(t) ? "on" : ""}">${esc(t)}</button>`).join("") +
    `<label class="budgetbox${budget ? " on" : ""}" title="${own ? "日別ページの資金配分案から送った、このレースだけの金額(書き換えるとこのレースだけ変わる。空にすると共通の手入力に戻る)" : "金額を入れると、その金額が入る区分の買い方を使う(すべてのレースで共通。このブラウザに覚えておく)"}">手入力 ` +
    `<input id="budget" class="odds" style="width:80px" inputmode="numeric" value="${budget ?? ""}" placeholder="例 2300"> 円</label>` +
    (own ? `<span class="chip warn" title="日別ページの資金配分案から送った金額">このレースだけ(資金配分案から)</span><button id="budgetReset" title="このレースだけの金額を消して、共通の手入力(${savedBudget() ? savedBudget().toLocaleString() + "円" : "なし"})に戻す">共通に戻す</button>` : "") +
    `</div>` +
    // 買い方(配分)は予算の下
    `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0 8px">` +
    `<span class="muted">配分:</span><label><input type="radio" name="alloc" value="均等" ${mode === "均等" ? "checked" : ""}> 均等</label>` +
    `<label><input type="radio" name="alloc" value="確率比例" ${mode === "確率比例" ? "checked" : ""}> 確率に比例</label>` +
    `<label title="どの買い目が当たっても払戻がほぼ同じになるように(オッズが低い買い目ほど多く)"><input type="radio" name="alloc" value="払戻均等化" ${mode === "払戻均等化" ? "checked" : ""}> 払戻均等化</label>` +
    `<label title="期待値(確率 × オッズ)が1を超える分に比例して置く。オッズの無い買い目は買わない"><input type="radio" name="alloc" value="期待値追求型" ${mode === "期待値追求型" ? "checked" : ""}> 期待値追求型</label>` +
    `<span class="note" style="margin:0">${budget ? "" : "配分は予算を手入力したときに使う(区分のときは区分の1点の金額で均等)。"}</span></div>`;
  if (!tickets.length) {
    return h + `<div class="muted">${esc(parts.map(x => x["買い方"]).join(" + "))} はこのレースでは買えません(頭数が足りない、複勝の発売なし など)。</div></div>`;
  }
  const tri = harville(raceRows);
  const probs = tickets.map(x => tri.reduce((s, y) => s + (hits(x.kind, x.t, y, places) ? y[3] : 0), 0));
  const money = budget ?? parts.reduce((s, x) => s + Number(x["合計"] || 0), 0);
  const ticketOdds = tickets.map(x => {
    if (x.kind === "単勝") {
      const row = raceRows.find(y => String(y.umaban) === x.t[0]);
      if (row && manualOdds(rid, row.umaban)) return getOdds(rid, row.umaban, row);
    }
    return x.csvOdds;
  });
  const amt = budget ? allocate(budget, probs, mode, ticketOdds) : tickets.map(() => Number(r["1点の金額"]));
  const spent = amt.reduce((a, b) => a + b, 0);
  // どれか当たる確率は、買う(金額が0円でない)買い目だけで数える
  const anyHit = tri.reduce((s, y) => s + (tickets.some((x, i) => amt[i] > 0 && hits(x.kind, x.t, y, places)) ? y[3] : 0), 0);
  const oddsOf = x => {
    if (x.kind === "単勝") {
      const row = raceRows.find(y => String(y.umaban) === x.t[0]);
      if (row && manualOdds(rid, row.umaban)) return getOdds(rid, row.umaban, row);
    }
    return x.csvOdds;
  };
  let back = 0, priced = 0;
  tickets.forEach((x, i) => { const o = oddsOf(x); if (o && amt[i]) { back += probs[i] * o * amt[i]; priced += amt[i]; } });
  h += `<div class="kpis" style="margin:0 0 8px">` +
    kpi(esc(kinds.join(" + ")), `買い方: ${esc(parts.map(x => x["買い方"]).join(" + "))}(予想順位で)`) +
    kpi(`${amt.filter(a => a > 0).length}点・${spent.toLocaleString()}円`, budget ? `予算 ${budget.toLocaleString()}円(${mode})` : `区分の金額 ${money.toLocaleString()}円(均等)`) +
    kpi(pct(anyHit), "どれか当たる確率(買う買い目だけ。予想の上で)") +
    kpi(priced ? `<span class="${back / priced >= 1 ? "hi" : ""}">${fix(back / priced * 100)}%</span>` : "-", "回収率の期待値(このレースのオッズで)") +
    kpi(`<span class="${roi >= 100 ? "hi" : ""}">${fix(roi)}%</span>`, `過去の回収率(的中率 ${fix(num(r["過去の的中率"]))}%)`) +
    kpi(`<span class="${honest >= 100 ? "hi" : ""}">${fix(honest)}%</span>`, "選び方を別の年で確かめた回収率") + `</div>`;
  const kindNote = (r["オッズの種類"] ? `<span class="chip gray" title="オッズは発走まで変わる">オッズ: ${esc(r["オッズの種類"])}</span>` : "") +
    (r["予想の段階"] && r["予想の段階"] !== "馬体重あり" ? `<span class="chip gray" title="朝のオッズで出した、馬体重が入る前の版の推奨買い目。馬体重が入ると(発走55分前ごろ)作り直す">枠順確定の版(馬体重の前)</span>` : "");
  const many = kinds.length > 1;
  state.planTickets = state.planTickets || {};
  state.planTickets[rid] = tickets.map((x, i) => ({ kind: x.kind, t: x.t, amount: amt[i] || 0 }));
  h += `<div class="scroll"><table><tr><th><input type="checkbox" class="planAll" title="全部選ぶ"></th>${many ? "<th>券種</th>" : ""}<th>買い目</th><th class="n">確率</th><th class="n">妥当なオッズ</th><th class="n">オッズ</th>` +
    `<th class="n">期待値</th><th class="n">金額</th><th class="n">当たったときの払戻</th><th class="n" title="結果(払戻の CSV)が出たレースの当たり・はずれ。当たりは今の金額での払戻">結果</th></tr>`;
  tickets.forEach((x, i) => {
    const o = oddsOf(x), p = probs[i], lower = x.kind === "複勝" || x.kind === "ワイド";
    const backI = amt[i] && o ? `${Math.round(amt[i] * o).toLocaleString()}円` + (lower ? "〜" : "") : `<span class="dim">-</span>`;
    const hp = hitPayout(rid, x.kind, x.t);
    h += `<tr class="${amt[i] ? "" : "dim"}${hp != null ? " hit" : ""}"${hp != null ? ` title="的中(100円あたり ${hp.toLocaleString()}円)"` : ""}><td><input type="checkbox" class="planPick" data-i="${i}"></td>${many ? `<td>${esc(x.kind)}</td>` : ""}<td><b>${esc(x.t.join(x.kind === "馬単" || x.kind === "3連単" ? "→" : "-"))}</b></td>` +
      `<td class="n">${pct(p)}</td><td class="n">${p > 0 ? fix(1 / p) + gapMark(o, 1 / p, x.kind + (lower ? "(下限)" : "")) : ""}</td>` +
      `<td class="n">${o ? fix(o) + (lower ? "〜" : "") : `<span class="dim">オッズなし</span>`}</td><td class="n">${o && p ? evCell(o, 1 / p) : ""}</td>` +
      `<td class="n">${amt[i] ? amt[i].toLocaleString() + "円" : "買わない"}</td><td class="n">${backI}</td>` +
      // 当たり・はずれ(2026-11-21 ユーザーの指示)
      `<td class="n">${!state.pays.has(rid) ? `<span class="dim">結果待ち</span>` : hp != null ? `<b class="hi">的中</b>${amt[i] ? ` ${Math.round(hp * amt[i] / 100).toLocaleString()}円` : ""}` : `<span class="dim">はずれ</span>`}</td></tr>`;
  });
  h += `</table></div><div class="calc" style="margin-top:8px"><button id="planSendAll">↓ 全部を買い目候補に送る</button>` +
    `<button id="planSendPick">↓ 選んだものを買い目候補に送る</button>` +
    `<span class="note" style="margin:0">送ると、下の「買い目候補」の欄に今の金額で足す(0円の買い目は100円で送る)。</span></div>` +
    (kindNote ? `<div style="margin-top:6px">${kindNote}</div>` : "") +
    (budget && spent < budget ? `<div class="note">残り ${(budget - spent).toLocaleString()}円は使わない(100円単位にそろえた余り)。</div>` : "") +
    (budget && amt.some(a => !a) ? `<div class="note">予算が点数に足りないので、確率の低い買い目は買わない。</div>` : "") +
    `<div class="note">根拠: ${esc(r["根拠"] || "")}</div>` +
    `<div class="note">買い目の数字は馬番。確率は6モデルの平均の勝率から Harville の式で計算したもの(予想の上の値)。オッズは、終わったレースは確定オッズ、当日は取ってある単勝・複勝だけ(組み合わせ馬券の当日のオッズは取らない)。期待値 = オッズ × 確率。複勝・ワイドは下限のオッズ。` +
    `過去の回収率は100%を下回るものが多く、儲かることを約束するものではない。</div></div>`;
  return h;
}
// ---------- 買い目を入れて計算(フォーメーション) ----------
const CALC_KINDS = { "単勝": [1, true], "複勝": [1, true], "ワイド": [2, false], "馬連": [2, false], "馬単": [2, true],
  "3連複": [3, false], "3連単": [3, true] };   // 券種 → [頭数, 着順の順番が要るか]
function ticketKey(kind, t) { return `${kind}|${t.join("-")}`; }
function parseHorses(text, valid) {
  // 「3,5,7」「3 5 7」「1-4」(1〜4)などを馬番の配列に。出走していない馬番は外す
  const out = new Set();
  for (const part of String(text || "").split(/[,、\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:[-〜~](\d+))?$/);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let u = Math.min(a, b); u <= Math.max(a, b); u++) if (valid.has(String(u))) out.add(String(u));
  }
  return [...out];
}
function expandTickets(kind, cols) {
  const [n, ordered] = CALC_KINDS[kind];
  let combos = [[]];
  for (let i = 0; i < n; i++) {
    const col = cols[Math.min(i, cols.length - 1)] || [];
    combos = combos.flatMap(c => col.filter(u => !c.includes(u)).map(u => [...c, u]));
  }
  if (!ordered) combos = combos.map(c => [...c].sort((a, b) => a - b));
  const seen = new Set();
  return combos.filter(c => { const k = c.join("-"); if (seen.has(k)) return false; seen.add(k); return true; });
}
function renderCalc(rid) {
  const raceRows = state.races.get(rid) || [];
  if (!probabilityReady(raceRows) || placeCount(raceRows) == null) return `<div class="card">予想値・補正係数または発売条件が不一致のため計算できません</div><div class="card basket-card">` + renderBasket(rid, [], placeCount(raceRows), state.odds.get(rid), raceRows) + `</div>`;
  const valid = new Set(activeRows(raceRows).map(r => String(r.umaban)));
  const c = state.calc[rid] || (state.calc[rid] = { kind: "馬連", rows: [[], [], []], unit: "100" });
  const allowedKinds = Object.keys(CALC_KINDS).filter(k => k !== "複勝" || placeCount(raceRows) > 0);
  if (!allowedKinds.includes(c.kind)) { c.kind = allowedKinds[0]; c.rows = [[], [], []]; }
  const [n, ordered] = CALC_KINDS[c.kind];
  const horses = [...valid].sort((a, b) => a - b);
  const cols = c.rows.slice(0, n).map(r => horses.filter(u => r.includes(u)));
  const tickets = cols.every(x => x.length) ? expandTickets(c.kind, cols) : [];
  const unit = roundYen(c.unit);
  const odds = state.odds.get(rid);
  const tri = harville(raceRows), places = placeCount(raceRows);
  const lower = c.kind === "複勝" || c.kind === "ワイド";
  let h = `<div class="card"><h3>買い目を入れて計算(フォーメーション)</h3>` +
    `<div class="calc">` +
    `<label>券種 <select id="calcKind">${allowedKinds.map(k => `<option ${k === c.kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>` +
    `<label>1点 <input id="calcUnit" class="odds" type="number" min="0" step="100" style="width:90px" value="${roundYen(c.unit)}"> 円</label>` +
    `<button id="calcBox" title="1行目の馬を全部の行に入れる(ボックス)">ボックスにする</button>` +
    `<button id="calcClear">チェックを消す</button></div>`;
  // 馬番のチェックボックスの表(行 = 1着・1頭目 / 2着・2頭目 / 3着・3頭目、列 = 馬番と全通り)
  const rowName = i => n === 1 ? "馬番" : ordered ? `${i}着` : `${i}頭目`;
  const nameOf = u => raceRows.find(r => String(r.umaban) === u)?.horse_name || "";
  h += `<div class="scroll"><table class="grid"><tr><th></th>` +
    horses.map(u => `<th class="gc" title="${esc(nameOf(u))}">${u}</th>`).join("") + `<th class="gc">全通り</th><th class="gc" title="印(消 は除く)の付いた馬をその行に入れる">印の馬</th></tr>` +
    // 出走馬の表で付けた印(買い目を選ぶときの目安。印を変えるとここもすぐ変わる)
    `<tr class="gmarks"><th class="gr" title="出走馬の表で付けた印">印</th>` +
    horses.map(u => { const m = markOf(rid, u); return `<td class="gc gmark" data-u="${u}" data-m="${m}" title="${esc(nameOf(u))}">${m || "-"}</td>`; }).join("") + `<td></td><td></td></tr>`;
  for (let i = 1; i <= n; i++) {
    const row = c.rows[i - 1];
    const all = horses.length && horses.every(u => row.includes(u));
    h += `<tr><th class="gr">${rowName(i)}</th>` +
      horses.map(u => `<td class="gc"><input type="checkbox" class="calcBox" data-i="${i}" data-u="${u}" ${row.includes(u) ? "checked" : ""}></td>`).join("") +
      `<td class="gc"><input type="checkbox" class="calcAll" data-i="${i}" ${all ? "checked" : ""}></td>` +
      // 印の付いた馬を選ぶ(2026-11-22 ユーザーの指示。消 の馬は入れない。今の選びに足す)
      `<td class="gc"><button class="calcMarked" data-i="${i}" title="印(消 は除く)の付いた馬をこの行に入れる">印を選択</button></td></tr>`;
  }
  h += `</table></div><div class="note">${n === 1 ? "買う馬にチェック。" : ordered ? "着順ごとに馬にチェック(1着の行が1着、2着の行が2着…)。" :
    "1頭目・2頭目…の行に馬をチェック。順番は問わず、同じ組は1点にまとめる。"}` +
    `ボックスは1行目の馬を全部の行に入れる。流しは1行目に軸、2行目以降に相手をチェック。「印を選択」はその行に印(消 は除く)の付いた馬を足す。馬番にのせると馬名。</div>`;
  // 今の選び方の組(買い目候補に移す前の下見)
  h += `<h3 style="margin-top:14px">選んでいる馬券</h3>`;
  if (!tickets.length) {
    h += `<div class="muted">馬を選ぶと、ここに選んでいる馬券が出ます。</div>`;
  } else {
    let pc = 0, pb = 0;
    const prev = tickets.map(t => {
      const p = tri.reduce((s, x) => s + (hits(c.kind, t, x, places) ? x[3] : 0), 0);
      let o = odds?.get(ticketKey(c.kind, t));
      if (c.kind === "単勝") {
        const row = raceRows.find(x => String(x.umaban) === t[0]);
        if (row && manualOdds(rid, row.umaban)) o = getOdds(rid, row.umaban, row);
      }
      const a = calcAmtOf(c, t);
      if (o && a) { pc += a; pb += p * o * a; }
      return { t, p, o, a };
    }).sort(tSortCmp(state.calcSort?.[rid]) || ((x, y) => y.p - x.p));
    const anyP = tri.reduce((s, x) => s + (tickets.some(t => hits(c.kind, t, x, places)) ? x[3] : 0), 0);
    const sep = CALC_KINDS[c.kind][1] && n > 1 ? "→" : "-";
    h += `<div class="kpis" style="margin:6px 0 8px">` +
      kpi(`${c.kind} ${tickets.length}点・${prev.reduce((s, r) => s + r.a, 0).toLocaleString()}円`, `1点 ${unit.toLocaleString()}円${prev.some(r => r.a !== unit) ? "(金額を変えた買い目あり)" : ""}`) +
      kpi(pct(anyP), "どれか当たる確率(予想の上で)") +
      kpi(pc ? `${Math.round(pb).toLocaleString()}円` : "-", "払戻の期待値") +
      kpi(pc ? `<span class="${pb / pc >= 1 ? "hi" : ""}">${fix(pb / pc * 100)}%</span>` : "-", "回収率の期待値(予想の上で)") + `</div>` +
      `<div class="scroll" style="max-height:320px;overflow-y:auto"><table><tr><th><input type="checkbox" class="prevAll" title="全部選ぶ"></th>${tSortHead("t", "買い目", state.calcSort?.[rid], "psort", "")}${tSortHead("p", "確率", state.calcSort?.[rid], "psort")}<th class="n">妥当オッズ</th>` +
      `${tSortHead("o", "オッズ" + (lower ? "(下限)" : ""), state.calcSort?.[rid], "psort")}${tSortHead("ev", "期待値", state.calcSort?.[rid], "psort")}<th class="n">金額</th><th class="n">当たったときの払戻</th></tr>` +
      prev.map(r => `<tr><td><input type="checkbox" class="prevPick" data-k="${esc(r.t.join("-"))}"></td><td><b>${esc(r.t.join(sep))}</b></td><td class="n">${pct(r.p, 2)}</td><td class="n">${r.p > 0 ? fix(1 / r.p) : ""}</td>` +
        `<td class="n">${r.o ? fix(r.o) : `<span class="dim">オッズなし</span>`}</td><td class="n">${r.o && r.p ? evCell(r.o, 1 / r.p) : ""}</td>` +
        `<td class="n"><input class="odds calcAmt" data-k="${esc(r.t.join("-"))}" type="number" min="0" step="100" value="${r.a}" style="width:90px" title="この買い目の金額(100円単位。0円にすると買い目候補に移さない)"> 円</td>` +
        `<td class="n">${r.o && r.a ? Math.round(r.a * r.o).toLocaleString() + "円" + (lower ? "〜" : "") : "-"}</td></tr>`).join("") +
      `</table></div>`;
  }
  h += `<div class="calc" style="margin-top:8px">` +
    `<button id="calcAdd" ${tickets.length ? "" : "disabled"}>↓ 全部を買い目候補に移す</button>` +
    `<button id="calcAddPick" ${tickets.length ? "" : "disabled"}>↓ 選んだものを買い目候補に移す</button>` +
    `<span class="note" style="margin:0">移すと、下の「買い目候補」の欄に足す(同じ買い目は金額を足し合わせる)。フォーメーションのチェックはそのまま残る。</span></div>`;
  // 買い目候補は「買い目を入れて計算」とは別の欄(自分の見出しでたためる)
  return h + `</div><div class="card basket-card">` + renderBasket(rid, tri, places, odds, raceRows) + `</div>`;
}

// ---------- 買い目候補(券種・フォーメーションをまたいで組み合わせる) ----------
function basketOf(rid) {
  if (!state.basket) state.basket = {};
  if (!state.basket[rid]) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(`keiba-viewer:basket:${rid}`) || "null"); } catch (e) {}
    state.basket[rid] = Array.isArray(saved) ? saved : [];
  }
  return state.basket[rid];
}
function saveBasket(rid) {
  try { localStorage.setItem(`keiba-viewer:basket:${rid}`, JSON.stringify(state.basket[rid] || [])); } catch (e) {}
}
function roundYen(v) { return Math.max(0, Math.round((num(String(v).replace(/[,円\s]/g, "")) || 0) / 100) * 100); }
// 「選んでいる馬券」の1点ごとの金額(2026-11-22 ユーザーの指示「ここでも金額を変更できるようにしてほしい」)。変えていなければ「1点」の金額
function calcAmtOf(c, t) { const v = c.amt?.[c.kind + "|" + t.join("-")]; return v != null ? v : roundYen(c.unit); }
function addToBasket(rid, kind, tickets, unit, form, cols) {
  // form: どこから入れたか(フォーメーションの書き方。買い目候補の「フォーメーション」の列に出す)。unit は金額か、買い目ごとの金額を返す関数
  const b = basketOf(rid);
  for (const t of tickets) {
    if (!ticketEligible(state.races.get(rid), {kind, t})) continue;
    const amt = typeof unit === "function" ? unit(t) : unit;
    if (!(amt > 0)) continue;
    // 同じ買い目でも、別のフォーメーションから入れたものはまとめない(フォーメーションの形を崩さない。11/23 ユーザーの指示)
    const hit = b.find(x => x.kind === kind && x.t.join("-") === t.join("-") && (x.forms || []).join(" / ") === (form || ""));
    if (hit) { hit.amount += amt; if (cols) hit.fsets = [...(hit.fsets || []), { label: form, kind, cols }]; if (form && !(hit.forms || []).includes(form)) hit.forms = [...(hit.forms || []), form]; }
    else b.push({ kind, t, amount: amt, ...(cols ? { fsets: [{ label: form, kind, cols }] } : {}), ...(form ? { forms: [form] } : {}) });
  }
  saveBasket(rid);
}
function formationLabel(kind, cols) {
  // 「買い目を入れて計算」のフォーメーションの書き方。例 3連複 2 - 3,6 - 4,7,10 / 馬連 ボックス 1,3,5
  const [n] = CALC_KINDS[kind];
  const c = cols.slice(0, n).map(x => [...x].sort((a, b) => a - b));
  if (n > 1 && c.every(x => x.join(",") === c[0].join(","))) return `${kind} ボックス ${c[0].join(",")}`;
  return `${kind} ${c.map(x => x.join(",")).join(" - ")}`;
}
// ---------- 購入した馬券(買い目候補から「購入した馬券に送る」で送ったもの。日別ページに出す) ----------
// このブラウザの localStorage に日付ごとに覚えておく: [{rid, kind, t, amount, at}]
function boughtOf(date) {
  if (!state.bought) state.bought = {};
  if (!state.bought[date]) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(`keiba-viewer:bought:${date}`) || "null"); } catch (e) {}
    state.bought[date] = Array.isArray(saved) ? saved : [];
  }
  return state.bought[date];
}
function saveBought(date) {
  try { localStorage.setItem(`keiba-viewer:bought:${date}`, JSON.stringify(state.bought?.[date] || [])); } catch (e) {}
}
// 描き直しの前後で、ページと表(.scroll の箱)のスクロール位置を保つ(11/23 ユーザーの指示「金額を変えるとスクロールが戻る」)
function keepScroll(fn) {
  const main = document.getElementById("main"), y = window.scrollY, my = main?.scrollTop || 0;
  const boxes = [...document.querySelectorAll("#main .scroll")].map(e => [e.scrollTop, e.scrollLeft]);
  fn();
  window.scrollTo(0, y); if (main) main.scrollTop = my;
  document.querySelectorAll("#main .scroll").forEach((e, i) => { if (boxes[i]) { e.scrollTop = boxes[i][0]; e.scrollLeft = boxes[i][1]; } });
}
function sendToBought(rid, tickets) {
  const date = rid.slice(0, 8), b = boughtOf(date);
  for (const x of tickets) {
    if (!(x.amount > 0) || !ticketEligible(state.races.get(rid), x)) continue;
    // フォーメーションの名前も持たせる(日別ページでフォーメーションごとにまとめる。11/23)。同じフォーメーションの同じ買い目だけ金額を足す
    const form = (x.forms || []).join(" / ");
    const hit = b.find(y => y.rid === rid && y.kind === x.kind && y.t.join("-") === x.t.join("-") && (y.form || "") === form);
    if (hit) hit.amount += x.amount; else b.push({ rid, kind: x.kind, t: x.t.map(String), amount: x.amount, at: new Date().toISOString(), ...(form ? { form } : {}) });
  }
  saveBought(date);
}
function ticketValue(rid, kind, t, triCache) {
  // 買い目の確率(補正つきの Harville の式)とオッズ(オッズの CSV。単勝で無ければ予想 CSV の単勝オッズ)。予想を読んでいなければ null
  const rows = state.races.get(rid);
  if (ticketExclusion(rows, {kind, t}) || !probabilityReady(rows)) return { p: null, o: null };
  if (!triCache.has(rid)) triCache.set(rid, harville(rows));
  const tri = triCache.get(rid), places = placeCount(rows);
  const p = tri.reduce((s, y) => s + (hits(kind, t, y, places) ? y[3] : 0), 0);
  let o = state.odds.get(rid)?.get(ticketKey(kind, t));
  if (o == null && kind === "単勝") {
    const r = rows.find(r => String(r.umaban) === String(t[0]));
    o = r ? getOdds(rid, r.umaban, r) : null;
  }
  return { p, o: o ?? null };
}
// 並べ替え(2026-11-23 ユーザーの指示「オッズ・期待値・確率・買い目でソートできるように」)。見出しを押す、もう一度で逆
const TSORT = { p: r => r.p ?? -1, o: r => r.o ?? -1, ev: r => r.o && r.p ? r.o * r.p : -1, t: r => r.t.map(u => String(u).padStart(2, "0")).join("-") };
function tSortCmp(st) {
  if (!st || !TSORT[st.k]) return null;
  const f = TSORT[st.k], d = st.dir || (st.k === "t" ? 1 : -1);
  return (a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * d; };
}
function tSortHead(key, label, st, cls, cls2 = "n") {
  const on = st?.k === key, d = st?.dir || (key === "t" ? 1 : -1);
  return `<th class="${cls2} ${cls}" data-k="${key}" style="cursor:pointer" title="押すとこの順に並べる(もう一度で逆)">${label}${on ? (d > 0 ? " ▲" : " ▼") : ""}</th>`;
}
function renderBasket(rid, tri, places, odds, raceRows) {
  const b = basketOf(rid);
  let h = `<h3>買い目候補</h3>` + (b.length ? `<div class="calc" style="margin:0 0 8px"><button class="nkBetsBtn" title="この買い目を netkeiba の IPAT 連動馬券購入の画面に入れる(購入は押さない)">netkeiba(IPAT)に買い目を送る</button>` +
    `<button class="help nkBetHelp" title="netkeiba(IPAT)への買い目の転記の使い方">？</button>${nkBetSentTag(rid)}</div>` +
    // 予算の自動配分(2026-11-23 ユーザーの指示。0円=買わない もあり)
    `<div class="calc" style="margin:0 0 8px"><label>このレースの予算 <input id="bAllocBudget" class="odds" type="number" min="0" step="100" style="width:100px" value="${state.bAlloc?.[rid]?.budget ?? ""}"> 円</label>` +
    // 配り方はラジオボタン(選べるものがひと目で分かるように。2026-11-23 ユーザーの指示)
    [["均等", "均等", "どの買い目にも同じだけ"], ["確率比例", "確率に比例", "当たる確率の高い買い目ほど多く"], ["払戻均等化", "払戻均等化", "どれが当たっても払戻がほぼ同じになるように(オッズの低い買い目ほど多く)"],
      ["期待値追求型", "期待値追求", "期待値(確率 × オッズ)が1を超える分に比例。期待値の低い買い目は0円(買わない)"]]
      .map(([v, l, tip]) => `<label title="${tip}"><input type="radio" name="bAllocMode" value="${v}" ${(state.bAlloc?.[rid]?.mode || "均等") === v ? "checked" : ""}> ${l}</label>`).join("") +
    `<button id="bAllocGo" title="予算を、選んだ決め方で買い目に配る(100円単位。買わない=0円になる買い目もある)">自動配分</button></div>` : "");
  // 空のとき(11/28 ユーザーの指示「もっと分かりやすく」): 空であることと、入れ方の手順を枠で見せる
  if (!b.length) return h + `<div class="basket-empty"><b>まだ買い目はありません(0点)</b><ol>` +
    `<li>上の「推奨買い目と資金配分」の「→ 買い目候補に送る」、または「買い目を入れて計算」で買い目を作って送る</li>` +
    `<li>ここで金額を決める(予算の自動配分も使える)。券種やフォーメーションを変えて何回でも足せる</li>` +
    `<li>「→ 購入した馬券に送る」で日別ページの「購入した馬券」へ。netkeiba(IPAT)にも送れる</li></ol></div>`;
  let cost = 0, back = 0, priced = 0;
  const rows = b.map((x, i) => {
    const excluded = ticketExclusion(raceRows, x);
    const p = excluded || !probabilityReady(raceRows) ? null : tri.reduce((s, y) => s + (hits(x.kind, x.t, y, places) ? y[3] : 0), 0);
    let o = odds?.get(ticketKey(x.kind, x.t));
    if (x.kind === "単勝") {
      const row = raceRows.find(r => String(r.umaban) === x.t[0]);
      if (row && manualOdds(rid, row.umaban)) o = getOdds(rid, row.umaban, row);
    }
    if (excluded) o = null;
    const on = x.sel !== false && !excluded;
    if (on) cost += x.amount;
    if (on && p != null && o && x.amount) { back += p * o * x.amount; priced += x.amount; }
    return { ...x, i, p, o, excluded, fk: (x.forms || []).join(" / ") };
  });
  // 同じフォーメーションの行を、最初に出てきた順のかたまりにまとめる(かたまりの中は入れた順)
  const order = [...new Set(rows.map(r => r.fk))];
  const bcmp = tSortCmp(state.basketSort?.[rid]);   // フォーメーションのかたまりは崩さず、かたまりの中で並べ替える
  rows.sort((a, b) => order.indexOf(a.fk) - order.indexOf(b.fk) || (bcmp ? bcmp(a, b) : 0) || a.i - b.i);
  state.basketRows = state.basketRows || {}; state.basketRows[rid] = rows.map(r => ({ i: r.i, p: r.p, o: r.o }));
  const live = rows.filter(x => x.amount > 0 && x.sel !== false && !x.excluded), off = b.filter(x => x.sel === false).length;
  const anyP = probabilityReady(raceRows) ? tri.reduce((s, y) => s + (live.some(x => hits(x.kind, x.t, y, places)) ? y[3] : 0), 0) : null;
  h += `<div class="kpis" style="margin:6px 0 8px">` +
    kpi(`${live.length}点・${cost.toLocaleString()}円`, `有効 ${rows.filter(x => !x.excluded).length}点${rows.some(x => x.excluded) ? `・取消等 ${rows.filter(x => x.excluded).length}点は集計外` : ""}${off ? `・チェックを外した ${off}点` : ""}`) +
    kpi(pct(anyP), "どれか当たる確率(予想の上で)") +
    kpi(priced ? `${Math.round(back).toLocaleString()}円` : "-", `払戻の期待値${priced && priced < cost ? `(オッズと確率のある ${priced.toLocaleString()}円分)` : ""}`) +
    kpi(priced ? `<span class="${back / priced >= 1 ? "hi" : ""}">${fix(back / priced * 100)}%</span>` : "-", "回収率の期待値(予想の上で)") +
    (state.oddsKind?.get(rid) ? kpi(esc(state.oddsKind.get(rid)), "オッズの種類") : "") + `</div>`;
  h += `<div class="scroll" style="max-height:460px;overflow-y:auto"><table class="basket-table"><tr><th><input type="checkbox" class="bselAll" title="全部チェック / 全部外す" ${b.every(x => x.sel !== false) ? "checked" : ""}></th><th>券種</th><th title="どのフォーメーションから入れたか(同じフォーメーションはまとめて1つ)">フォーメーション</th>${tSortHead("t", "買い目", state.basketSort?.[rid], "bsort", "")}${tSortHead("p", "確率", state.basketSort?.[rid], "bsort")}<th class="n">妥当オッズ</th>` +
    `${tSortHead("o", "オッズ", state.basketSort?.[rid], "bsort")}${tSortHead("ev", "期待値", state.basketSort?.[rid], "bsort")}<th class="n">金額(100円単位)</th><th class="n">当たったときの払戻</th>` +
    `<th title="netkeiba(IPAT 連動)の購入画面に送ったか(✔ = 拡張機能で入ったと確かめた、送信 = 送ったが入ったかは分からない、✖ = 入れられなかった)">IPAT</th>` +
    `<th title="日別ページの「購入した馬券」に入っているか(入っている金額)">購入した馬券</th><th></th></tr>`;
  // 買い目ごとの送った記録(2026-11-22 ユーザーの指示「買い目一つ一つIPATに送ったかわかるように」「日別ページにおくったかも」)
  const betLog = nkBetItemsOf(rid), boughtList = boughtOf(rid.slice(0, 8)).filter(x => x.rid === rid);
  rows.forEach((r, k) => {
    const lower = r.kind === "複勝" || r.kind === "ワイド";
    const sep = CALC_KINDS[r.kind][1] && r.t.length > 1 ? "→" : "-";
    // フォーメーションの列: かたまりの最初の行にだけ出し、かたまりの行数だけつなげる
    let formCell = "";
    if (k === 0 || rows[k - 1].fk !== r.fk) {
      let span = 1;
      while (k + span < rows.length && rows[k + span].fk === r.fk) span++;
      const gi = rows.slice(k, k + span).map(y => y.i), gOn = gi.every(i => b[i]?.sel !== false);
      // フォーメーション単位のチェック(11/23 ユーザーの指示)
      const gBox = span > 1 ? `<input type="checkbox" class="bselGrp" data-is="${gi.join(",")}" title="このフォーメーションの買い目を全部チェック / 全部外す" ${gOn ? "checked" : ""}> ` : "";
      const validCount = rows.slice(k, k + span).filter(y => !y.excluded).length;
      formCell = `<td class="bform" rowspan="${span}">${gBox}${r.fk ? (r.forms || []).map(esc).join("<br>") : `<span class="dim">-</span>`}${span > 1 ? `<div class="dim">${validCount}点</div>` : ""}</td>`;
    }
    const hp = r.excluded ? null : hitPayout(rid, r.kind, r.t);
    h += `<tr class="${r.amount && r.sel !== false ? "" : "dim"}${hp != null ? " hit" : ""}"${hp != null ? ` title="的中(100円あたり ${hp.toLocaleString()}円)"` : ""}><td><input type="checkbox" class="bsel" data-i="${r.i}" title="チェックした買い目だけ IPAT・購入した馬券に送る" ${b[r.i]?.sel !== false ? "checked" : ""}></td><td>${esc(r.kind)}</td>${formCell}<td><b>${esc(r.t.join(sep))}</b></td>` +
      `<td class="n">${r.excluded ? esc(r.excluded) : pct(r.p, 2)}</td><td class="n">${r.p > 0 ? fix(1 / r.p) : ""}</td>` +
      `<td class="n">${r.o ? fix(r.o) + (lower ? "〜" : "") : `<span class="dim">オッズなし</span>`}</td><td class="n">${r.o && r.p ? evCell(r.o, 1 / r.p) : ""}</td>` +
      `<td class="n"><input class="odds amt" data-i="${r.i}" type="number" min="0" step="100" value="${r.amount}" style="width:90px"> 円</td>` +
      `<td class="n">${r.o && r.amount ? Math.round(r.amount * r.o).toLocaleString() + "円" + (lower ? "〜" : "") : r.amount ? "-" : "買わない"}</td>` +
      `<td>${nkBetCell(betLog[r.kind + " " + r.t.join(sep)])}</td>` +
      `<td>${(() => { const bt = boughtList.find(y => y.kind === r.kind && y.t.join("-") === r.t.join("-")); if (!bt) return `<span class="dim">-</span>`;
        const t = bt.at ? new Date(bt.at) : null, at = t && !isNaN(t) ? `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}・` : "";
        return `<span class="hi" title="購入した馬券に入っている(時刻は最初に入れた時刻)">✔ ${at}${bt.amount.toLocaleString()}円</span>`; })()}</td>` +
      `<td><button class="del" data-i="${r.i}" title="この買い目を消す">×</button></td></tr>`;
  });
  const sent = boughtOf(rid.slice(0, 8)).filter(x => x.rid === rid && ticketEligible(raceRows, x));
  h += `</table></div><div class="calc" style="margin-top:8px"><button id="basketBuy" class="buy" ${live.length ? "" : "disabled"} title="チェックした、金額が0円より大きい買い目を、日別ページの「購入した馬券」に足す(同じ買い目は金額を足し合わせる)">→ 購入した馬券に送る</button>` +
    `<button id="basketZero">全部0円にする</button><button id="basketDelSel" title="チェックした買い目を買い目候補から消す">チェックした買い目を消す</button><button id="basketClear">買い目を全部消す</button>` +
    `<span class="note" style="margin:0">金額は100円単位(入れた値を丸める)。0円は「買わない」(表には残る)。買い目候補はこのブラウザに覚えておく(レースごと)。</span></div>` +
    (sent.length ? `<div class="note bought-note">このレースで購入した馬券に送った分: <b>${sent.length}点・${sent.reduce((s, x) => s + x.amount, 0).toLocaleString()}円</b>` +
      `(<a href="#" class="toDay" data-day="${rid.slice(0, 8)}">日別ページで見る</a>)。送ったあとも買い目候補は残る。</div>` : "") +
    `<div class="note">確率は6モデルの平均の勝率から Harville の式で計算したもの(予想の上の値)。期待値 = オッズ × 確率。` +
    `オッズは オッズ フォルダの CSV(終わったレースは全券種の確定オッズ、当日は取った単勝・複勝だけ)。複勝・ワイドは下限のオッズ。</div>`;
  return h;
}
function comboFor(rid) {
  // 組み合わせの CSV には race_id の列が無いので、ファイル名で探す。今の形は 組み合わせ_年月日_場名_R数2桁R.csv、昔の形は 年月日_場名_R数R.csv
  const jyo = JYO[rid.slice(8, 10)] || rid.slice(8, 10), r = +rid.slice(14, 16);
  const now = `組み合わせ_${rid.slice(0, 8)}_${jyo}_${String(r).padStart(2, "0")}R.csv`, old = `${rid.slice(0, 8)}_${jyo}_${r}R.csv`;
  return state.combos.get(now) ?? state.combos.get(old) ?? [...state.combos].find(([k]) => k.endsWith(old))?.[1];
}
function comboProbs(raceRows) {
  // 全部の組の確率(Harville の式の3着までの並びから一度に集める)。券種 → Map(組 → 確率)
  const tri = harville(raceRows);
  const out = { "馬連": new Map(), "馬単": new Map(), "ワイド": new Map(), "3連複": new Map(), "3連単": new Map() };
  const add = (k, key, v) => out[k].set(key, (out[k].get(key) || 0) + v);
  const two = new Map();                     // 1着-2着 の確率は3着を足し合わせる
  for (const [a, b, c, v] of tri) {
    if (b == null) continue;
    two.set(`${a}-${b}`, (two.get(`${a}-${b}`) || 0) + v);
    if (c == null) continue;
    add("3連単", `${a}-${b}-${c}`, v);
    add("3連複", [a, b, c].sort((x, y) => x - y).join("-"), v);
    for (const [x, y] of [[a, b], [a, c], [b, c]]) add("ワイド", [x, y].sort((p, q) => p - q).join("-"), v);
  }
  for (const [k, v] of two) { add("馬単", k, v); add("馬連", k.split("-").sort((x, y) => x - y).join("-"), v); }
  return out;
}
function renderCombos(rid) {
  const raceRows = state.races.get(rid) || [];
  if (!raceRows.length) return "";
  if (!probabilityReady(raceRows)) return `<div class="card">予想値または補正係数が不一致のため計算できません</div>`;
  const odds = state.odds.get(rid);
  const kinds = ["馬連", "馬単", "ワイド", "3連複", "3連単"];
  const tab = kinds.includes(state.comboTab) ? state.comboTab : kinds[0];
  const sortBy = odds && state.comboSort === "期待値" ? "期待値" : "確率";
  const probs = comboProbs(raceRows)[tab];
  const list = [...probs].map(([k, p]) => {
    const o = odds?.get(ticketKey(tab, k.split("-")));
    return { k, p, o, ev: o ? p * o : null };
  }).sort((x, y) => sortBy === "期待値" ? (y.ev ?? -1) - (x.ev ?? -1) : y.p - x.p).slice(0, 20);
  const max = Math.max(...list.map(r => r.p));
  const sep = tab === "馬単" || tab === "3連単" ? "→" : "-";
  const lower = tab === "ワイド";
  let h = `<div class="card"><h3>組み合わせ馬券(${sortBy === "期待値" ? "期待値の高い順" : "確率の高い順"})${updTag(["組み合わせ", "オッズ"], rid)}</h3><div class="tabs combo">` +
    kinds.map(k => `<button data-t="${esc(k)}" class="${k === tab ? "on" : ""}">${esc(k)}</button>`).join("") + `</div>` +
    `<div class="tabs csort" style="margin-top:6px">` + ["確率", "期待値"].map(x =>
      `<button data-t="${x}" class="${x === sortBy ? "on" : ""}" ${x === "期待値" && !odds ? "disabled title=\"オッズ フォルダの CSV を落とすと使える\"" : ""}>${x}の高い順</button>`).join("") + `</div>` +
    `<div class="scroll"><table><tr><th>組番</th><th>確率</th><th class="n">妥当なオッズ</th><th class="n">オッズ${lower ? "(下限)" : ""}</th><th class="n">期待値</th></tr>`;
  for (const r of list) h += `<tr><td><b>${esc(r.k.split("-").join(sep))}</b></td><td>${bar(r.p, max)}</td><td class="n">${fix(1 / r.p)}</td>` +
    `<td class="n">${r.o ? fix(r.o) : `<span class="dim">オッズなし</span>`}</td><td class="n">${r.o ? evCell(r.o, 1 / r.p) : ""}</td></tr>`;
  return h + `</table></div><div class="note">全部の組から上位20点。確率は6モデルの平均の勝率から Harville の式で計算。妥当なオッズ = 1 ÷ 確率(これより高いオッズなら期待値がプラス)。` +
    `期待値 = オッズ × 確率。オッズは オッズ フォルダの CSV(終わったレースは確定オッズ。当日は組み合わせのオッズは取らないので期待値順は使えない)。</div></div>`;
}

function renderBand(target = document.getElementById("bandBody")) {
  if (!state.band || !target) return;
  const rows = state.band;
  const cols = Object.keys(rows[0]);
  const ms = [...new Set(rows.map(r => r["モデル"]))];
  const tab = ms.includes(state.bandTab) ? state.bandTab : ms[0];
  const list = rows.filter(r => r["モデル"] === tab);
  let h = `<div class="card"><h2>自信の区分ごとの回収率</h2><div class="muted">検証期間(2019〜2023年)の予想を12区分に分け、予想順位どおりに各1点買ったときの回収率(かっこ内は的中率)。</div></div>` +
    `<div class="card"><div class="tabs">${ms.map(m => `<button data-m="${esc(m)}" class="${m === tab ? "on" : ""}">${esc(m)}</button>`).join("")}</div>` +
    `<div class="scroll"><table><tr><th>自信の区分</th>`;
  const bets = cols.filter(c => c.endsWith("_回収率")).map(c => c.slice(0, -4));
  h += bets.map(b => `<th class="n">${esc(b)}</th>`).join("") + `<th class="n">レース数</th></tr>`;
  for (const r of list) {
    h += `<tr><td><span class="chip ${bandTone(r["自信の区分"])}">${esc(bandShort(r["自信の区分"]))}</span></td>`;
    for (const b of bets) {
      const v = num(r[`${b}_回収率`]), hit = num(r[`${b}_的中率`]);
      h += `<td class="n"><span class="${v >= 100 ? "hi" : ""}">${fix(v)}%</span> <span class="dim">(${fix(hit)}%)</span></td>`;
    }
    h += `<td class="n">${esc(r["レース数"])}</td></tr>`;
  }
  h += `</table></div><div class="note">緑は回収率 100% 以上。</div></div>`;
  h += strengthCards(tab);
  target.innerHTML = h;
  target.querySelectorAll(".tabs button").forEach(b => b.onclick = () => { state.bandTab = b.dataset.m; renderBand(target); });
}

// モデルの得意・苦手(モデルの得意・苦手.csv): 選んだモデルの、他のモデルより得意・苦手な条件と、全モデルに共通する得意・苦手
// (CSV の列名・「5本共通」は5本のときのまま。本数は「全体」の行の数で数える)
function strengthCards(model) {
  const rows = state.strength;
  if (!rows) return "";
  const of = kind => rows.filter(r => r["モデル"] === model && r["種類"] === kind);
  const all = of("全体")[0];
  const n = rows.filter(r => r["種類"] === "全体").length || 5;   // モデルの本数(CSV の列名は5本のときのまま)
  const sign = v => v === "" || v == null ? "" : (num(v) > 0 ? "+" : "") + fix(num(v));
  const table = (title, list, tone) => !list.length ? "" :
    `<div class="strength-col"><h3><span class="chip ${tone}">${title}</span></h3><div class="scroll"><table>` +
    `<tr><th>条件</th><th class="n">他の${n - 1}本との差</th><th class="n">1番人気との差</th><th class="n">単勝の回収率</th><th class="n">レース数</th></tr>` +
    list.map(r => `<tr><td><b>${esc(r["条件"])}</b></td><td class="n">${sign(r["他の4本との差"])}</td>` +
      `<td class="n">${sign(r["1番人気との差"])}</td><td class="n">${fix(num(r["単勝の回収率"]))}%</td><td class="n">${esc(r["レース数"])}</td></tr>`).join("") +
    `</table></div></div>`;
  let h = "";
  if (all) {
    h += `<div class="card"><h2>${esc(model)} の得意・苦手な条件</h2><div class="muted">検証期間(2019〜2023年)の予想を条件ごとに分け、` +
      `勝ち馬の対数損失(小さいほど良い)を他の${n - 1}本の平均と比べた。全体の対数損失 ${esc(all["対数損失"])}、` +
      `${esc(all["区分の数"])} 区分のうち${n}本の中で1位が ${esc(all["1位の区分"])}、${n}位が ${esc(all["5位の区分"])}。</div>` +
      `<div class="strength-grid">${table("得意", of("得意"), "up")}${table("苦手", of("苦手"), "warn")}</div>` +
      `<div class="note">他の${n - 1}本との差 = 対数損失の差 × 1000(マイナスなら他より良い)。1番人気との差 = 予想1位の勝率 − 1番人気の勝率(ポイント。比べ物としてだけ使う)。` +
      `400レース以上の区分だけ。${n}本の差は小さく、数百レースの区分の差は偶然の幅に入ることがある。</div></div>`;
  }
  const common = kind => rows.filter(r => r["モデル"] === "5本共通" && r["種類"] === kind)
    .map(r => `${esc(r["条件"])}(${sign(r["1番人気との差"])})`).join("、");
  if (common("共通の苦手")) {
    h += `<div class="card"><h2>${n}本に共通する得意・苦手</h2><div class="muted">予想1位の勝率 − 1番人気の勝率(${n}本の平均、ポイント)。</div>` +
      `<p><span class="chip up">得意</span> ${common("共通の得意")}</p><p><span class="chip warn">苦手</span> ${common("共通の苦手")}</p></div>`;
  }
  return h;
}

function updateRaceStatus() {
  const bandOpen = document.getElementById("bandOpen");
  if (bandOpen) bandOpen.hidden = !state.band;
  const status = document.getElementById("status");
  if (!status) return;
  if (state.dayPage) {
    const date = state.dayPage;
    const fullDate = ymdw(date);
    const shortDate = fullDate.replace(/^\d{4}\//, "");
    status.innerHTML = `<span class="status-date-full">${fullDate}</span><span class="status-date-short">${shortDate}</span>　日別ページ`;
  } else if (state.races.has(state.current)) {
    const rid = state.current;
    const date = rid.slice(0, 8);
    const fullDate = ymdw(date);
    const shortDate = fullDate.replace(/^\d{4}\//, "");
    status.innerHTML = `<span class="status-date-full">${fullDate}</span><span class="status-date-short">${shortDate}</span>　${raceHead(rid)}`;
    bindRaceHead(rid);
  } else {
    status.textContent = "レースを選択してください";
  }
  status.classList.add("race-context");
}

function renderDayPage(date) {
  // 日別ページ: 馬場傾向の予想(場のタブ・芝ダ別)/ 見送り推奨(仮。場のタブ)/ 購入した馬券(集計付き)。
  // 読み込んだ CSV(state)から作るので、days/ の HTML(iframe)ではなく、メインの領域に直接出す
  const label = `${+date.slice(0, 4)}年${+date.slice(4, 6)}月${+date.slice(6, 8)}日`;
  const rids = sortedRaces().filter(rid => rid.slice(0, 8) === date);
  const jyos = [...new Set(rids.map(rid => rid.slice(8, 10)))];
  const jyoName = j => JYO[j] || j;
  const raceNo = rid => `${jyoName(rid.slice(8, 10))} ${+rid.slice(14, 16)}R`;
  const raceLink = rid => `<a href="#" class="dayRace" data-rid="${rid}">${raceNo(rid)}</a>`;
  const jyoTabs = (key, cur) => `<div class="tabs dayTabs" data-k="${key}">` +
    jyos.map(j => `<button data-j="${j}" class="${j === cur ? "on" : ""}">${esc(jyoName(j))}</button>`).join("") + `</div>`;
  const pick = key => jyos.includes(state[key]) ? state[key] : jyos[0];
  const surf = rid => state.info.get(rid)?.["芝ダ"] || state.races.get(rid)?.[0]?.["芝ダ"] || "不明";
  let h = `<div class="card"><h2 style="margin:0">${ymdw(date)} の日別ページ</h2><div class="muted">${label}・${jyos.map(jyoName).join("・") || "レースなし"}・${rids.length}レース</div></div>`;

  // 1. 1日を通した馬場傾向の予想(場ごと・芝ダ別)。予想 CSV の馬場傾向の列は同じ場・芝ダのレースで同じ値なので、芝ダごとにまとめて出す
  const bj = pick("dayBiasJyo");
  h += `<div class="card day-fold" data-shut="1" data-sec="baba"><h3>馬場傾向の予想(1日を通して)（仮）${updTag("予想", rids)}</h3>` + jyoTabs("dayBiasJyo", bj);
  const bRids = rids.filter(rid => rid.slice(8, 10) === bj);
  const surfaces = [...new Set(bRids.map(surf))].sort((a, b) => ["芝", "ダート", "障害"].indexOf(a) - ["芝", "ダート", "障害"].indexOf(b));
  // この場の全レース(最終レースまで)の結果がそろったら、実際の馬場傾向と予想の当否を出す
  const venueDone = bRids.length > 0 && bRids.every(rid => state.results.has(rid));
  const sg = v => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
  const bias = surfaces.map(s => {
    const rs = bRids.filter(rid => surf(rid) === s).sort();
    const r0 = state.races.get(rs[0])[0], src0 = state.info.get(rs[0]) || {};
    const act = s === "障害" ? null : dayBiasActual(rs);
    const final = venueDone && act && act.done === rs.length;
    let hit = 0, near = 0, judged = 0;
    const cellOf = lab => {
      const g = BIAS.find(x => x[0] === lab);
      if (!g || num(r0[g[1]]) == null) return null;
      const [, c] = g, gcol = g[2];
      const vals = rs.map(rid => num(state.races.get(rid)[0][c])).filter(v => v != null);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const guide = r0[gcol] || "", i = guide.indexOf("(");
      const word = i > 0 ? guide.slice(0, i) : guide, why = i > 0 ? guide.slice(i + 1, -1) : "";
      const src = r0[`${lab}の確度`] ? r0 : src0;
      const axis = lab.includes("内外") ? "inner" : "front";
      const j = final && act[axis] != null ? biasJudge(axis, word, act[axis], biasNorm(guide)) : null;
      if (j) { judged++; if (j.mark === "○") hit++; if (j.mark === "△") near++; }
      return { v: (lo + hi) / 2, lo, hi, guide, html: `<span title="${esc(why)}${hi - lo >= 0.0005 ? `。レースで違う(目安は${raceNo(rs[0])}のもの)` : ""}"><b>${hi - lo < 0.0005 ? sg(lo) : `${sg(lo)}〜${sg(hi)}`}</b>` +
        (word ? `<br><span class="chip ${biasTone(word)}">${esc(word)}</span>` : "") + confChip(src, lab) +
        (j ? ` <span class="chip ${j.mark === "○" ? "up" : j.mark === "△" ? "gray" : "down"}" title="${esc(j.why)}">${{ "○": "○ 合っていた", "△": "△ 向きは合っていた", "×": "× 外れ" }[j.mark]}</span>` : "") + `</span>` };
    };
    const dItems = BP_ITEMS.map(([n, color]) => ({ name: n, color, inner: cellOf(n + "の内外"), front: cellOf(n + "の前後") })).filter(x => x.inner || x.front);
    const dNorm = { inner: biasNorm(dItems.find(x => x.inner)?.inner.guide || ""), front: biasNorm(dItems.find(x => x.front)?.front.guide || "") };
    const items = dItems.length ? biasPanel(dItems, dNorm, act?.done && (act.inner != null || act.front != null) ? { inner: act.inner, front: act.front, name: final ? "この日の結果" : "この日の結果(途中)" } : null, [], "馬場傾向マップ",
      blockTrail(date, bj, s)) : "";
    // 実際の馬場傾向(結果)。場の最終レースまで結果がそろうまでは「確定前」(途中の値は薄く出す)
    let res = "";
    if (act) {
      const norm = { inner: biasNorm(r0[BIAS[0][2]] || ""), front: biasNorm(r0[BIAS[1][2]] || "") };
      const show = axis => act[axis] == null ? "-" : `<b>${sg(act[axis])}</b> <span class="chip ${final ? "" : "gray"}">${esc(biasWord(axis, act[axis] - norm[axis]))}</span>`;
      res = `<div class="pace day-bias-result"><div class="pl">結果(この日)</div><div>` +
        (final ? `<span class="chip up">確定</span> ${judged} 項目のうち ○ <b>${hit}</b>${near ? `・△ <b>${near}</b>` : ""}・× <b>${judged - hit - near}</b>` :
          `<span class="chip warn">確定前</span> <span class="muted">結果の出たレース ${act.done} / ${rs.length}${venueDone ? "" : `(場の全 ${bRids.length}レースの結果がそろったら判定)`}</span>`) +
        (act.done ? `<div${final ? "" : ` class="muted"`}>内外 ${show("inner")}・前後 ${show("front")}${final ? "" : "(途中の値)"}</div>` : "") + `</div></div>`;
    }
    // 時計(11/23): レースごとの勝ちタイムの予想・結果の、基準との差(%)。予想は幅、結果は結果の出たレースの平均
    const cks = rs.map(clockPct), cp = cks.map(c => c.pred).filter(v => v != null), ca = cks.map(c => c.act).filter(v => v != null);
    const cAvg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const clockItem = !cp.length ? "" : `<div class="pace"><div class="pl">時計(勝ちタイム)</div><div><b>${pctFmt(cAvg(cp))}</b> <span class="chip ${cAvg(cp) >= CLOCK_FLAT ? "warn" : cAvg(cp) <= -CLOCK_FLAT ? "up" : "gray"}">${esc(clockWord(cAvg(cp)))}</span>` +
      (ca.length ? ` <span class="muted">結果 ${pctFmt(cAvg(ca))}(${esc(clockWord(cAvg(ca)))}・${ca.length}レース)</span>` : "") +
      clockGraph([Math.min(...cp), Math.max(...cp)], cAvg(ca)) +
      `<div class="note" style="margin:0">勝ちタイムの予想の、基準(同じ競馬場・芝ダ・距離・馬場状態の過去3年の平均)との差の平均。帯はレースごとの幅。プラスは時計がかかる</div></div></div>`;
    return `<div class="day-bias"><h4 style="margin:4px 0">${esc(s)}<span class="muted" style="font-weight:400">(${rs.length}レース: ${rs.map(rid => +rid.slice(14, 16) + "R").join("・")})</span></h4>` +
      babaCompare(rs[0]) + res + clockItem + clockCompare(rs[0]) + (items || `<span class="muted">馬場傾向の列がありません</span>`) + `</div>`;
  }).join("");
  h += (bias ? `<div class="day-bias-list">${bias}</div>`   /* 芝 → ダートの順に縦に並べる(11/23 ユーザーの指示) */ : `<div class="muted">この場のレースがありません。</div>`) +
    `<div class="note">予想 CSV の馬場傾向の列(3着以内の馬の位置の平均 − 全馬の平均。マイナスなら内・前が有利)を、場・芝ダごとにまとめたもの。` +
    `前の開催日までのレースから出す値なので、同じ場・芝ダならふつうはその日のどのレースでも同じ(違うときは幅で出す)。<br>` +
    `<b>結果</b>: 結果 CSV(馬番・通過順)から同じ定義で出したその日の値(内外 = 3着以内の馬の 馬番÷頭数 の平均 − 全馬の平均、` +
    `前後 = 3着以内の馬の 最初のコーナーの順位÷頭数 の平均 − 全馬の平均。レースごとに出して、場・芝ダの全レースで平均。障害は除く)。` +
    `<b>合っていたか</b>: 結果からそのコースのふだんの値(目安の「ふだん」)を引いた差の向きと、予想の向き(いつもより内/外・前/後ろ有利)が同じなら ○` +
    `(向きは同じでも差が ±${BIAS_FLAT} 未満でふだん並みなら △)、違えば ×。予想が「いつも並み」のときは、差が ±${BIAS_FLAT} 未満なら ○。場の最終レースまで結果がそろうまでは「確定前」。結果は表示だけで、モデルには使わない。</div></div>`;

  // 2. 見送り推奨のレース(場ごと)
  // 判定は資金配分案と同じ(この日の予算 ÷ 対象のレース数 の額の区分。推奨買い目がまだ無いレースは同じ自信・混戦の組の別のレースの値で仮に)
  const sj = pick("daySkipJyo");
  const sRids = rids.filter(rid => rid.slice(8, 10) === sj);
  const skipJ = skipJudge(date);
  const judged = sRids.map(rid => [rid, skipJ(rid)]);
  const tierNames = [...new Set(judged.map(([, x]) => x?.tier).filter(Boolean))];
  const tierName = tierNames.join("・") || "〜500円";
  // 優先順位で絞る(2026-11-21 ユーザーの指示): 推奨レースのうち、この日(全場)の順位で選んだ数に入らないレースも見送りにする
  const skSel = prioSel("skipSel", "all");   // 最初は「全部」(今までと同じ)
  const skDiff = diffOn("diffSkip");
  const skRank = prioRank(fundPlan(date, { ...fundOf(date), budget: fundOf(date).budget || 5000, picks: {}, past: true, offJyo: [], diffOnly: skDiff }));
  const skKeep = new Set(skRank.slice(0, prioCount(skSel, skRank.length)).map(x => x.rid));
  const skPos = new Map(skRank.map((x, i) => [x.rid, i + 1]));
  for (const j of judged) if (j[1] && !j[1].skip && skDiff && favSame(j[0]) === true) j[1] = { ...j[1], skip: true, outFav: true };
  for (const j of judged) if (j[1] && !j[1].skip && skPos.has(j[0]) && !skKeep.has(j[0])) j[1] = { ...j[1], skip: true, outRank: skPos.get(j[0]) };
  const skips = judged.filter(([, x]) => x?.skip), unknown = judged.filter(([, x]) => !x);
  const fromCsv = judged.some(([, x]) => x?.src === "csv");
  h += `<div class="card day-fold"><h3>見送り推奨のレース（仮）${updTag(["推奨買い目", "予想"], rids)}</h3>` + jyoTabs("daySkipJyo", sj) +
    `<div class="tabs" style="margin-bottom:8px"><span class="muted" style="align-self:center;margin-right:6px">買うレース:</span>` +
    PRIO_SELS.map(([k, l]) => `<button class="simBtn${k === skSel ? " on" : ""}" data-k="skipSel" data-v="${k}">${l}</button>`).join("") +
    `<span class="muted" style="align-self:center;margin-left:6px">この日の推奨 ${skRank.length}レースのうち ${skKeep.size}レースを買い、ほかは見送り</span></div>` +
    `<div class="tabs" style="margin-bottom:8px">${diffBtns("diffSkip")}</div>` +
    `<div class="kpis" style="margin:0 0 8px">${kpi(`${skips.length} / ${sRids.length}`, "見送り推奨（仮） / この場のレース")}` +
    (unknown.length ? kpi(unknown.length, "推奨買い目がまだ無い(判定できない)") : "") + `</div>`;
  if (skips.length) {
    h += `<div class="scroll"><table><tr><th>レース</th><th>発走</th><th>コース</th><th>レース名</th><th class="n" title="自信は100段階、混戦は10段階">自信<small>/100</small></th><th class="n">混戦<small>/10</small></th>` +
      (fromCsv ? `<th>理由</th>` : `<th>おすすめの買い方(${esc(tierName)})</th><th class="n">過去の回収率</th><th class="n">確かめの回収率</th>`) + `</tr>`;
    for (const [rid, x] of skips) {
      const r0 = state.races.get(rid)[0], inf = state.info.get(rid) || {}, c = confLevel(state.races.get(rid));
      h += `<tr><td>${raceLink(rid)}</td><td>${hhmm(r0.hasso_time)}</td><td>${esc((inf["芝ダ"] || "") + (inf["距離"] || ""))}</td><td>${esc(inf["レース名"] || "")}</td>` +
        `<td class="n" title="10段階で ${c?.lv ?? "-"}">${c?.score ?? "-"}</td><td class="n">${esc(r0["混戦の段階"] || "-")}</td>` +
        (x.outFav ? `<td colspan="${fromCsv ? 1 : 3}">${DIFF_WHY}</td>` : x.outRank ? `<td colspan="${fromCsv ? 1 : 3}">優先順位の外(この日の ${x.outRank}位)</td>` : fromCsv ? `<td>${esc(x.why || "")}</td>` : `<td>${esc(x.how || "")}${x.pending ? ` <span class="chip gray" title="推奨買い目がまだ無いので、同じ自信・混戦の組の ${esc(raceName(x.borrowed))} の値">仮</span>` : ""}</td>` +
          `<td class="n">${x.past ?? "-"}%</td><td class="n"><span class="down">${x.honest}%</span></td>`) + `</tr>`;
    }
    h += `</table></div>`;
  } else h += `<div class="muted">${sRids.length && unknown.length === sRids.length ? "推奨買い目の CSV が無いので判定できません。" : "この場に見送り推奨のレースはありません。"}</div>`;
  h += `<div class="note">${fromCsv ? "予想 CSV の「見送り」の列で決めたもの。" :
    `<b>暫定の決め方</b>: 下の資金配分案と同じ。この日の予算 ÷ 対象のレース数 の額が入る区分(いまは ${esc(tierName)}。予算が空なら 〜500円)の推奨買い目「おすすめ」の、` +
    `4年で選んで残りの1年で確かめた回収率(確かめの回収率)が ${SKIP_ROI}% 未満のレースを見送りにしている。推奨買い目がまだ無いレースは、同じ自信・混戦の組の別のレースの値で仮に判定する(「仮」)。` +
    `予想 CSV に「見送り」の列(と「見送りの理由」)ができたら、そちらを使う。`}` +
    `「買うレース」で絞ると、残りの推奨レースに見込みの回収率と期待値の平均で順位を付け(この日の全場で)、選んだ数に入らないレースも見送りにする。</div></div>`;

  // 3. 資金配分案（仮）(発走前のレースに予算を配る)
  h += renderFund(date, raceLink);

  // 4. 購入した馬券(個別レースページの買い目候補から「購入した馬券に送る」で送ったもの)
  const bought = boughtOf(date), tc = new Map();
  let cost = 0, evBack = 0, evCost = 0, setCost = 0, setBack = 0;
  const setRaces = new Set(), allRaces = new Set();
  const rows = bought.map((x, i) => {
    const excluded = ticketExclusion(state.races.get(x.rid), x);
    const { p, o } = ticketValue(x.rid, x.kind, x.t, tc);
    const settled = !excluded && state.pays.has(x.rid), hp = settled ? hitPayout(x.rid, x.kind, x.t) : null;
    const back = settled ? (hp || 0) * x.amount / 100 : null;
    if (!excluded) cost += x.amount; if (!excluded && x.amount > 0) allRaces.add(x.rid);
    if (p != null && o) { evBack += p * o * x.amount; evCost += x.amount; }
    if (settled && x.amount > 0) { setCost += x.amount; setBack += back; setRaces.add(x.rid); }
    return { ...x, i, p, o, settled, back, excluded };
  }).sort((a, b) => a.rid.localeCompare(b.rid) || a.i - b.i);
  h += `<div class="card day-fold" data-sec="bought"><h3>購入した馬券</h3>`;
  // 買い目編集モード(11/28 ユーザーの指示): ✓のときだけ金額の変更・×で消すができる
  if (bought.length) h += `<label class="calc" style="display:block;margin:0 0 6px"><input type="checkbox" id="boughtEdit" ${state.boughtEdit ? "checked" : ""}> 買い目編集モード(金額の変更・削除)</label>`;
  if (!bought.length) h += `<div class="muted">まだありません。個別レースページの「買い目候補」の欄で「→ 購入した馬券に送る」を押すと、ここに出ます。</div>`;
  else {
    // 並び: 総投資金額 → 期待値(予想の上の見込み。結果ではない)→ 実際の結果(払戻の CSV)。期待値と結果は枠で分けて見出しを付ける
    h += `<div class="bought-kpis">` +
      `<div class="kpis">` + kpi(`${cost.toLocaleString()}円`, `総投資金額(${rows.filter(x => x.amount > 0 && !x.excluded).length}点・${allRaces.size}レース。取消等は集計外)`) + `</div>` +
      `<div class="kgroup kg-ev"><div class="kg-h">期待値(予想の上の見込み。結果ではない)</div><div class="kpis">` +
      kpi(evCost ? `${Math.round(evBack).toLocaleString()}円` : "-", `払戻の期待値${evCost < cost ? `(オッズのある ${evCost.toLocaleString()}円分)` : ""}`) +
      kpi(evCost ? `<span class="${evBack / evCost >= 1 ? "hi" : ""}">${fix(evBack / evCost * 100)}%</span>` : "-", "回収率の期待値") + `</div></div>` +
      `<div class="kgroup kg-res"><div class="kg-h">実際の結果(結果の出たレース)</div><div class="kpis">` +
      // 総回収額: 結果の出たレースの払戻の合計(当たった馬券の 100円あたりの払戻 × 金額 ÷ 100)と、総投資金額との差(収支)
      kpi(setCost ? `<span class="${setBack >= setCost ? "hi" : ""}">${Math.round(setBack).toLocaleString()}円</span>` : "-",
        setCost ? `総回収額(${setRaces.size}レース。収支 ${setBack - setCost >= 0 ? "+" : "−"}${Math.abs(Math.round(setBack - setCost)).toLocaleString()}円${setCost < cost ? `・結果待ち ${(cost - setCost).toLocaleString()}円分は入れない` : ""})` : "総回収額(結果が出たら出す)") +
      kpi(setCost ? `<span class="${setBack >= setCost ? "hi" : ""}">${fix(setBack / setCost * 100)}%</span>` : "-",
        setCost ? `回収率(${setCost.toLocaleString()}円 → ${Math.round(setBack).toLocaleString()}円)` : "回収率(結果が出たら出す)") + `</div></div></div>`;
    // レースごと・フォーメーションごとにまとめる。レース合計・場合計の列。レース・結果・金額・レース合計で並べ替え(11/23 ユーザーの指示)
    const bs = state.boughtSort || { k: "race", dir: 1 };
    const raceSum = new Map(), raceBack = new Map(), jyoSum = new Map(), jyoOf = rid => rid.slice(0, 8) + rid.slice(8, 10);
    for (const r of rows) {
      raceSum.set(r.rid, (raceSum.get(r.rid) || 0) + (r.excluded ? 0 : r.amount || 0));
      if (r.settled) raceBack.set(r.rid, (raceBack.get(r.rid) || 0) + (r.back || 0));
      jyoSum.set(jyoOf(r.rid), (jyoSum.get(jyoOf(r.rid)) || 0) + (r.excluded ? 0 : r.amount || 0));
    }
    const rowVal = r => bs.k === "res" ? (r.settled ? r.back || 0 : -1) : bs.k === "amt" ? r.amount || 0 : 0;
    const raceVal = rid => bs.k === "res" ? (raceBack.has(rid) ? raceBack.get(rid) : -1) : bs.k === "amt" || bs.k === "rsum" ? raceSum.get(rid) || 0 : 0;
    const raceOrder = [...new Set(rows.map(r => r.rid))].sort((a, b) => bs.k === "race" ? bs.dir * a.localeCompare(b) : bs.dir * (raceVal(a) - raceVal(b)) || a.localeCompare(b));
    const formOrder = new Map(); rows.forEach(r => { const k = r.rid + "|" + (r.form || ""); if (!formOrder.has(k)) formOrder.set(k, formOrder.size); });
    rows.sort((a, b) => raceOrder.indexOf(a.rid) - raceOrder.indexOf(b.rid) || formOrder.get(a.rid + "|" + (a.form || "")) - formOrder.get(b.rid + "|" + (b.form || ""))
      || (bs.k === "res" || bs.k === "amt" ? bs.dir * (rowVal(a) - rowVal(b)) : 0) || a.i - b.i);
    const sh = (k, label, cls = "n") => `<th class="${cls} bosort" data-k="${k}" style="cursor:pointer" title="押すとこの順に並べる(もう一度で逆)">${label}${bs.k === k ? (bs.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
    h += `<div class="scroll" style="max-height:520px;overflow-y:auto"><table class="basket-table"><tr>${sh("race", "レース", "")}<th>フォーメーション</th><th>券種</th><th>買い目</th>${sh("amt", "金額")}<th class="n">確率</th>` +
      `<th class="n">オッズ</th><th class="n">期待値</th><th class="n">払戻の期待値</th>${sh("res", "結果")}${sh("rsum", "レース合計")}<th class="n" title="同じ競馬場のこの日の購入金額の合計">場の合計</th><th></th></tr>`;
    // 同じ値が続く行をまとめる(rowspan)
    const span = (k, key) => { let n = 1; while (k + n < rows.length && key(rows[k + n]) === key(rows[k])) n++; return n; };
    const first = (k, key) => k === 0 || key(rows[k - 1]) !== key(rows[k]);
    const kRace = r => r.rid, kForm = r => r.rid + "|" + (r.form || ""), kJyo = r => jyoOf(r.rid);
    rows.forEach((r, k) => {
      const lower = r.kind === "複勝" || r.kind === "ワイド", sep = CALC_KINDS[r.kind]?.[1] && r.t.length > 1 ? "→" : "-";
      const cRace = first(k, kRace) ? `<td class="bform" rowspan="${span(k, kRace)}">${raceLink(r.rid)}</td>` : "";
      const cForm = first(k, kForm) ? `<td class="bform" rowspan="${span(k, kForm)}">${r.form ? esc(r.form).replace(/ \/ /g, "<br>") : `<span class="dim">-</span>`}${span(k, kForm) > 1 ? `<div class="dim">${rows.slice(k, k + span(k, kForm)).filter(x => !x.excluded).length}点</div>` : ""}</td>` : "";
      const rb = raceBack.get(r.rid);
      const cRsum = first(k, kRace) ? `<td class="n bform" rowspan="${span(k, kRace)}"><b>${(raceSum.get(r.rid) || 0).toLocaleString()}円</b>${rb != null ? `<div class="${rb ? "hi" : "dim"}">払戻 ${Math.round(rb).toLocaleString()}円</div>` : ""}</td>` : "";
      const cJyo = first(k, kJyo) ? `<td class="n bform" rowspan="${span(k, kJyo)}">${(jyoSum.get(jyoOf(r.rid)) || 0).toLocaleString()}円<div class="dim">${esc(JYO[r.rid.slice(8, 10)] || "")}</div></td>` : "";
      h += `<tr class="${r.amount ? "" : "dim"}${r.settled && r.back ? " hit" : ""}">${cRace}${cForm}<td>${esc(r.kind)}</td><td><b>${esc(r.t.join(sep))}</b></td>` +
        (state.boughtEdit ? `<td class="n"><input class="odds boughtAmt" data-i="${r.i}" type="number" min="0" step="100" value="${r.amount}" style="width:90px"> 円</td>` : `<td class="n">${(r.amount || 0).toLocaleString()}円</td>`) + `<td class="n">${r.p != null ? pct(r.p, 2) : "-"}</td>` +
        `<td class="n">${r.o ? fix(r.o) + (lower ? "〜" : "") : `<span class="dim">オッズなし</span>`}</td><td class="n">${r.o && r.p ? evCell(r.o, 1 / r.p) : ""}</td>` +
        `<td class="n">${r.o && r.p != null ? Math.round(r.p * r.o * r.amount).toLocaleString() + "円" : "-"}</td>` +
        `<td class="n">${r.excluded ? `<span class="dim">${esc(r.excluded)}</span>` : !r.amount ? `<span class="dim">買わない</span>` : !r.settled ? `<span class="dim">結果待ち</span>` : r.back ? `<b class="hi">${Math.round(r.back).toLocaleString()}円</b>` : `<span class="dim">はずれ</span>`}</td>` + cRsum + cJyo +
        `<td>${state.boughtEdit ? `<button class="boughtDel" data-i="${r.i}" title="この馬券を一覧から消す">×</button>` : ""}</td></tr>`;
    });
    h += `</table></div>` + (state.boughtEdit ? `<div class="calc" style="margin-top:8px"><button id="boughtClear">この日の購入した馬券を全部消す</button></div>` : "");
  }
  h += `<div class="note">金額は馬券ごとに変えられる(100円単位に丸める。0円は「買わない」で表には残り、集計には入れない)。購入した馬券はこのブラウザに覚えておく(日付ごと)。実際の購入とはつながっていない(送ったものを買ったものとして数える)。` +
    `期待値 = オッズ × 確率(確率は補正つきの Harville の式、オッズは オッズ フォルダの CSV。複勝・ワイドは下限のオッズ)。回収率は結果(払戻の CSV)が出たレースの分だけで出す。</div></div>`;

  // 5. もし推奨馬券を一日の予算X円で買ったら(2026-11-17 ユーザーの指示)
  h += renderDaySim(date, raceLink);

  const main = document.getElementById("main");
  main.innerHTML = h;
  // 並び(2026-11-22 ユーザーの指示): 馬場傾向の予想のすぐ下に購入した馬券。馬場傾向は最初たたむ(data-shut)、購入した馬券は最初開く
  { const bb = main.querySelector('[data-sec="baba"]'), bo = main.querySelector('[data-sec="bought"]'); if (bb && bo) bb.after(bo); }
  setupCardFolds(main, ".card.day-fold");     // 見送り推奨・資金配分案は見出しを押すとたためる(このブラウザに覚えておく)
  document.body.classList.add("day-page-active");
  main.querySelectorAll(".dayTabs button").forEach(b => b.onclick = () => { state[b.parentElement.dataset.k] = b.dataset.j; renderDayPage(date); });
  main.querySelectorAll("a.dayRace").forEach(a => a.onclick = e => { e.preventDefault(); state.dayPage = null; state.current = a.dataset.rid; state.open.clear(); render(); });
  main.querySelectorAll("th.bosort").forEach(th => th.onclick = () => {
    const k = th.dataset.k, cur = state.boughtSort || { k: "race", dir: 1 };
    state.boughtSort = cur.k === k ? { k, dir: -cur.dir } : { k, dir: k === "race" ? 1 : -1 };
    keepScroll(() => renderDayPage(date));
  });
  { const be = document.getElementById("boughtEdit"); if (be) be.onchange = () => { state.boughtEdit = be.checked; keepScroll(() => renderDayPage(date)); }; }
  main.querySelectorAll("input.boughtAmt").forEach(x => x.onchange = () => {
    const b = boughtOf(date)[+x.dataset.i];
    if (!b) return;
    b.amount = roundYen(x.value); saveBought(date);
    keepScroll(() => renderDayPage(date));
  });
  bindFund(date);
  main.querySelectorAll(".simBtn").forEach(b => b.onclick = () => {
    if (b.dataset.k === "simMode") setSimMode(b.dataset.v);
    else if (b.dataset.k.startsWith("diff")) setDiff(b.dataset.k, b.dataset.v === "1");
    else state[b.dataset.k] = b.dataset.v;
    const y = window.scrollY; renderDayPage(date); window.scrollTo(0, y);
  });
  main.querySelectorAll("button.boughtDel").forEach(b => b.onclick = () => { boughtOf(date).splice(+b.dataset.i, 1); saveBought(date); keepScroll(() => renderDayPage(date)); });
  document.getElementById("boughtClear")?.addEventListener("click", () => {
    if (!confirm("この日の購入した馬券を全部消します。よろしいですか?")) return;
    state.bought[date] = []; saveBought(date); renderDayPage(date);
  });
}
// ---------- 実際の馬場傾向(結果 CSV から。features.py の _race_bias_stats と同じ定義。表示だけで、モデルには使わない) ----------
// 1レース: 内外 = 3着以内の馬の 馬番÷頭数 の平均 − 全馬の平均、前後 = 3着以内の馬の 最初のコーナーの順位÷頭数 の平均 − 全馬の平均。
// 頭数は走った馬(着順か通過順のある馬。取消・除外は入れない)。最初のコーナーは通過順のいちばん前の数字(直線のレースは無い)
function raceBiasActual(rid) {
  const res = state.results.get(rid);
  if (!res) return null;
  const run = res.filter(r => num(r["着順"]) != null || String(r["通過"] || "").trim());
  const n = run.length;
  if (!n) return null;
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const lane = r => num(r["馬番"]) / n;
  const pos = r => { const v = num(String(r["通過"] || "").split("-")[0]); return v > 0 ? v / n : null; };
  const top = run.filter(r => num(r["着順"]) != null && num(r["着順"]) <= 3);
  const ps = run.map(pos).filter(v => v != null), tps = top.map(pos).filter(v => v != null);
  return { inner: top.length ? mean(top.map(lane)) - mean(run.map(lane)) : null,
           front: tps.length && ps.length ? mean(tps) - mean(ps) : null };
}
function dayBiasActual(rids) {
  // 場・芝ダの、結果の出たレースの平均(値の無いレースは除く)。done = 結果の出たレース数
  const xs = rids.map(raceBiasActual).filter(Boolean);
  const avg = k => { const v = xs.map(x => x[k]).filter(v => v != null); return v.length ? v.reduce((s, y) => s + y, 0) / v.length : null; };
  return { inner: avg("inner"), front: avg("front"), done: xs.length };
}
const BIAS_FLAT = 0.03;   // ふだんとの差がこれ未満なら「ふだん並み」
// 馬場傾向を1枚に(2026-11-23 ユーザーの指示「縦軸 内外・横軸 前後で1枚に」「この開催・過去の同じ週・前の開催日の3項目」)。
// items: [{ name, color, inner: {v, lo, hi, html}, front: {...} }]。norm: ふだん、act: 結果(黄色の◆)、extra: 今日など追加の点
const BP_ITEMS = [["この開催", "#4f8cff"], ["過去の同じ週", "#b06cff"], ["前の開催日", "#2fb37a"]];
// この開催の日ごとの実績(馬場傾向の推移.csv)。day の日の CSV のうち、その場・芝ダの行(開催日目の順)
function blockTrail(day, jyo, surface) {
  return (state.blockBias?.get(day) || []).filter(r => String(r.jyo_cd).padStart(2, "0") === jyo && r["芝ダ"] === surface)
    .map(r => ({ inner: num(r["内外"]), front: num(r["前後"]), n: +r["開催日目"], date: String(r["日付"]), races: +r["レース数"] }))
    .filter(r => r.inner != null && r.front != null).sort((a, b) => a.n - b.n);
}
function bpTrailOn() { try { return localStorage.getItem("keiba-viewer:bpTrail") === "1"; } catch (e) { return false; } }
document.addEventListener("change", e => {
  if (!e.target.matches?.("input.bpTrail")) return;
  try { localStorage.setItem("keiba-viewer:bpTrail", e.target.checked ? "1" : "0"); } catch (er) {}
  keepScroll(() => state.dayPage ? renderDayPage(state.dayPage) : renderRace(state.current));
});
// 馬場傾向マップの拡大表示(11/23 ユーザーの指示「拡大表示ボタン・モーダル・＋−でズーム・ドラッグで移動」)
document.addEventListener("click", e => {
  // 「拡大表示」ボタンのほか、図そのものを押したときも開く(11/23 ユーザーの指示)
  const btn = e.target.closest?.("button.bpZoom") || e.target.closest?.(".bp svg");
  if (!btn) return;
  const src = btn.closest(".bp")?.querySelector("svg");
  if (!src) return;
  const base = src.getAttribute("viewBox").split(/\s+/).map(Number);
  let vb = [...base], zoom = 1;
  const wrap = document.createElement("div");
  wrap.className = "bpz-back";
  wrap.innerHTML = `<div class="bpz" role="dialog" aria-label="馬場傾向マップの拡大表示"><div class="bpz-bar"><b>馬場傾向マップ(拡大)</b>` +
    `<span class="muted" style="font-size:12px">＋−・マウスホイールで拡大・縮小、ドラッグで動かす</span><span style="flex:1"></span>` +
    `<button class="bpz-close">閉じる</button></div><div class="bpz-view">` +
    // ＋−・元に戻すは図の右下に重ねて出す(11/23 ユーザーの指示)
    `<div class="bpz-tools"><button class="bpz-in" title="拡大">＋</button><button class="bpz-out" title="縮小">−</button><button class="bpz-reset" title="元の大きさ">元に戻す</button></div></div></div>`;
  const svg = src.cloneNode(true);
  svg.removeAttribute("width"); svg.removeAttribute("height");
  svg.style.width = "100%"; svg.style.height = "100%"; svg.style.cursor = "grab"; svg.style.touchAction = "none";
  wrap.querySelector(".bpz-view").appendChild(svg);
  const apply = () => svg.setAttribute("viewBox", vb.join(" "));
  const zoomBy = f => {
    const nz = Math.max(1, Math.min(8, zoom * f));
    const cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2;
    zoom = nz; vb[2] = base[2] / zoom; vb[3] = base[3] / zoom; vb[0] = cx - vb[2] / 2; vb[1] = cy - vb[3] / 2; clamp(); apply();
  };
  const clamp = () => {
    vb[0] = Math.max(base[0], Math.min(base[0] + base[2] - vb[2], vb[0]));
    vb[1] = Math.max(base[1], Math.min(base[1] + base[3] - vb[3], vb[1]));
  };
  // マウスホイールでも拡大・縮小(11/23)。マウスの下の場所を動かさずに拡大する
  svg.addEventListener("wheel", ev => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect(), s = Math.max(vb[2] / r.width, vb[3] / r.height);
    const ox = (r.width - vb[2] / s) / 2, oy = (r.height - vb[3] / s) / 2;   // 縦横比の余白
    const px = vb[0] + (ev.clientX - r.left - ox) * s, py = vb[1] + (ev.clientY - r.top - oy) * s;
    const nz = Math.max(1, Math.min(8, zoom * (ev.deltaY < 0 ? 1.25 : 1 / 1.25)));
    const k = zoom / nz;
    zoom = nz; vb[0] = px - (px - vb[0]) * k; vb[1] = py - (py - vb[1]) * k; vb[2] = base[2] / zoom; vb[3] = base[3] / zoom; clamp(); apply();
  }, { passive: false });
  let drag = null;
  svg.addEventListener("pointerdown", ev => { drag = { x: ev.clientX, y: ev.clientY, vx: vb[0], vy: vb[1] }; svg.setPointerCapture(ev.pointerId); svg.style.cursor = "grabbing"; });
  svg.addEventListener("pointermove", ev => {
    if (!drag) return;
    const r = svg.getBoundingClientRect(), s = Math.max(vb[2] / r.width, vb[3] / r.height);
    vb[0] = drag.vx - (ev.clientX - drag.x) * s; vb[1] = drag.vy - (ev.clientY - drag.y) * s; clamp(); apply();
  });
  const end = () => { drag = null; svg.style.cursor = "grab"; };
  svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = ev => { if (ev.key === "Escape") close(); else if (ev.key === "+" || ev.key === "=") zoomBy(1.5); else if (ev.key === "-") zoomBy(1 / 1.5); };
  document.addEventListener("keydown", onKey);
  wrap.querySelector(".bpz-in").onclick = () => zoomBy(1.5);
  wrap.querySelector(".bpz-out").onclick = () => zoomBy(1 / 1.5);
  wrap.querySelector(".bpz-reset").onclick = () => { vb = [...base]; zoom = 1; apply(); };
  wrap.querySelector(".bpz-close").onclick = close;
  wrap.addEventListener("click", ev => { if (ev.target === wrap) close(); });
  document.body.appendChild(wrap);
});
const BP_NORM = "このコースの平均(2019〜23年)";   // 「ふだん」の言い換え(11/23 ユーザーの指示「何を示すのかわかりやすく」)
function biasPanel(items, norm, act, extra = [], title = "馬場傾向マップ", trail = []) {
  // 前の開催日は実績の値そのものなので「（予想）」を付けない(11/23 ユーザーの指示)
  items = items.map(it => ({ ...it, name: it.name === "前の開催日" || it.name === "過去の同じ週" ? it.name : it.name + "（予想）" }));   // 表と図の名前は「この開催（予想）」(11/23 ユーザーの指示)
  const R = 0.3, W = 280, P = 30, sz = W + P * 2;
  const x = f => P + (Math.max(-R, Math.min(R, f)) + R) / (2 * R) * W, y = i => P + (Math.max(-R, Math.min(R, i)) + R) / (2 * R) * W;
  const TT = 20;   // 上にタイトルの行
  let g = `<svg width="${sz}" height="${sz + TT}" viewBox="0 0 ${sz} ${sz + TT}" role="img" aria-label="馬場傾向の図(縦 内外・横 前後)">` +
    `<text x="${sz - 2}" y="13" font-size="12" font-weight="700" fill="var(--text)" text-anchor="end">${esc(title)}</text><text x="2" y="13" font-size="10" fill="var(--muted)">縦 内外・横 前後</text><g transform="translate(0 ${TT})">` +
    `<rect x="${P}" y="${P}" width="${W}" height="${W}" fill="none" stroke="var(--line)"/>`;
  for (const t of [-0.2, -0.1, 0.1, 0.2]) g += `<line x1="${x(t)}" y1="${P}" x2="${x(t)}" y2="${P + W}" stroke="var(--line)" stroke-dasharray="2 3"/><line x1="${P}" y1="${y(t)}" x2="${P + W}" y2="${y(t)}" stroke="var(--line)" stroke-dasharray="2 3"/>`;
  g += `<line x1="${x(0)}" y1="${P}" x2="${x(0)}" y2="${P + W}" stroke="var(--muted)"/><line x1="${P}" y1="${y(0)}" x2="${P + W}" y2="${y(0)}" stroke="var(--muted)"/>`;
  const labels = [];
  // 点の名前(点の右上。右端に近いときは左に出す)
  const lbl = (X, Y, t, c) => `<text x="${X > P + W - 60 ? X - 9 : X + 9}" y="${Y - 7}" font-size="10" font-weight="600" fill="${c}" text-anchor="${X > P + W - 60 ? "end" : "start"}" paint-order="stroke" stroke="var(--panel)" stroke-width="3">${esc(t)}</text>`;
  const tx = (X, Y, t, a = "middle") => `<text x="${X}" y="${Y}" font-size="11" fill="var(--muted)" text-anchor="${a}">${t}</text>`;
  g += tx(P + W / 2, P - 8, "↑ 内有利") + tx(P + W / 2, P + W + 18, "↓ 外有利") + tx(P - 4, P + W / 2 + 4, "前", "end") + tx(P + W + 4, P + W / 2 + 4, "後", "start") +
    tx(P, P + W + 18, "← 前有利", "start") + tx(P + W, P + W + 18, "後ろ有利 →", "end");
  for (const it of [...items, ...extra]) {
    const fi = it.front, ii = it.inner;
    if (fi?.v != null && ii?.v != null) labels.push([x(fi.v), y(ii.v), it.short || it.name, it.color]);
    if (fi?.v == null || ii?.v == null) continue;
    const lab = `${it.name}: 内外 ${ii.v >= 0 ? "+" : ""}${ii.v.toFixed(3)}・前後 ${fi.v >= 0 ? "+" : ""}${fi.v.toFixed(3)}`;
    if (fi.hi - fi.lo > 1e-9 || ii.hi - ii.lo > 1e-9)
      g += `<rect x="${x(fi.lo) - 4}" y="${y(ii.lo) - 4}" width="${x(fi.hi) - x(fi.lo) + 8}" height="${y(ii.hi) - y(ii.lo) + 8}" rx="5" fill="${it.color}" fill-opacity=".25" stroke="${it.color}"><title>${esc(lab)}(レースで違う)</title></rect>`;
    g += `<circle cx="${x(fi.v)}" cy="${y(ii.v)}" r="6" fill="${it.color}" stroke="var(--panel)" stroke-width="1.5"><title>${esc(lab)}</title></circle>`;
  }
  if (act && act.inner != null && act.front != null) labels.push([x(act.front), y(act.inner), "結果", "#d4a800"]);
  // この開催の日ごとの実績を線でつなぐ(✓のときだけ。初期は出さない)
  const showTrail = trail.length && bpTrailOn();
  if (showTrail) {
    const pts = trail.map(r => [x(r.front), y(r.inner)]);
    g += `<polyline points="${pts.map(p => p.join(",")).join(" ")}" fill="none" stroke="#2fb37a" stroke-width="1.5" stroke-opacity=".55" stroke-dasharray="4 3"/>`;
    trail.forEach((r, k) => {
      const [px, py] = pts[k], last = k === trail.length - 1;
      g += `<circle cx="${px}" cy="${py}" r="${last ? 4 : 3}" fill="${last ? "#2fb37a" : "var(--panel)"}" stroke="#2fb37a" stroke-width="1.5"><title>${r.n}日目(${+r.date.slice(4, 6)}/${+r.date.slice(6, 8)}・${r.races}レース): 内外 ${r.inner.toFixed(3)}・前後 ${r.front.toFixed(3)}</title></circle>`;
      if (k === 0 || last) labels.push([px, py, `${r.n}日目`, "#2fb37a"]);
    });
  }
  // 名前の置き場所(11/23 ユーザーの指示「点や線となるべく重ならないように」): 点のまわりの 8方向 × 距離の候補から、
  // ほかの点・線・先に置いた名前・図の外と重ならない(重なりが少ない)近い所を選ぶ。離れたときは点と細い線でつなぐ
  if (norm && norm.inner != null && norm.front != null) labels.push([x(norm.front), y(norm.inner), "平均", "var(--muted)"]);
  const obs = [];   // 点 [x, y, 半径]
  for (const it of [...items, ...extra]) if (it.front?.v != null && it.inner?.v != null) obs.push([x(it.front.v), y(it.inner.v), 7]);
  if (norm && norm.inner != null && norm.front != null) obs.push([x(norm.front), y(norm.inner), 7]);
  if (act && act.inner != null && act.front != null) obs.push([x(act.front), y(act.inner), 9]);
  const segs = [];
  if (showTrail) {
    const tp = trail.map(r => [x(r.front), y(r.inner)]);
    tp.forEach(p => obs.push([p[0], p[1], 4]));
    for (let k = 1; k < tp.length; k++) segs.push([tp[k - 1], tp[k]]);
  }
  const boxes = [];
  const textW = t => [...t].reduce((a, ch) => a + (/[ -~]/.test(ch) ? 6 : 10.5), 0);
  const hitPt = (b, [px, py, r]) => px + r > b[0] && px - r < b[0] + b[2] && py + r > b[1] && py - r < b[1] + b[3];
  const hitSeg = (b, [[x1, y1], [x2, y2]]) => { for (let k = 0; k <= 12; k++) { const sx = x1 + (x2 - x1) * k / 12, sy = y1 + (y2 - y1) * k / 12; if (sx > b[0] && sx < b[0] + b[2] && sy > b[1] && sy < b[1] + b[3]) return true; } return false; };
  const over = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  for (const [lx, ly, t, c] of labels) {
    const w = textW(t), h = 12;
    let best = null;
    for (const d of [9, 14, 20, 28, 38, 50]) {
      const e = d * 0.75;
      for (const [bx, by] of [[lx + d, ly - h / 2], [lx - d - w, ly - h / 2], [lx + e, ly - e - h], [lx + e, ly + e], [lx - e - w, ly - e - h], [lx - e - w, ly + e], [lx - w / 2, ly - d - h], [lx - w / 2, ly + d]]) {
        const b = [bx, by, w, h];
        let cost = d * 0.6;
        if (bx < 2 || bx + w > P * 2 + W - 2 || by < 2 || by + h > P * 2 + W - 2) cost += 400;
        for (const o of obs) if (!(Math.abs(o[0] - lx) < 0.5 && Math.abs(o[1] - ly) < 0.5) && hitPt(b, o)) cost += 120;
        for (const sg of segs) if (hitSeg(b, sg)) cost += 60;
        for (const pb of boxes) cost += over(b, pb) * 3;
        if (!best || cost < best.cost) best = { cost, b, d };
      }
      if (best.cost < d * 0.6 + 1) break;   // 何とも重ならない場所が見つかったら、それより遠くは見ない
    }
    const [bx, by] = best.b;
    boxes.push(best.b);
    if (best.d > 14) {   // 離れたときは、点から名前の一番近い所へ細い線
      const cx = Math.max(bx, Math.min(bx + w, lx)), cy = Math.max(by, Math.min(by + h, ly));
      g += `<line x1="${lx}" y1="${ly}" x2="${cx}" y2="${cy}" stroke="${c}" stroke-width="1" opacity=".6"/>`;
    }
    g += `<text x="${bx}" y="${by + h - 2}" font-size="10" font-weight="600" fill="${c}" paint-order="stroke" stroke="var(--panel)" stroke-width="3">${esc(t)}</text>`;
  }
  // 平均の「＋」は、ほかの点の後ろに隠れないよう点のあとに描く(縁取り付き。2026-11-24 ユーザーの指示)
  if (norm && norm.inner != null && norm.front != null) {
    const nx = x(norm.front), ny = y(norm.inner), plus = `<line x1="${nx - 7}" y1="${ny}" x2="${nx + 7}" y2="${ny}"/><line x1="${nx}" y1="${ny - 7}" x2="${nx}" y2="${ny + 7}"/>`;
    g += `<g><g stroke="var(--panel)" stroke-width="3">${plus}</g><g stroke="var(--text)" stroke-width="1.6">${plus}</g><title>${BP_NORM} 内外 ${norm.inner.toFixed(2)}・前後 ${norm.front.toFixed(2)}</title></g>`;
  }
  if (act && act.inner != null && act.front != null)
    g += `<rect x="${x(act.front) - 6}" y="${y(act.inner) - 6}" width="12" height="12" fill="#f5c400" stroke="var(--panel)" transform="rotate(45 ${x(act.front)} ${y(act.inner)})"><title>結果: 内外 ${act.inner.toFixed(3)}・前後 ${act.front.toFixed(3)}</title></rect>`;
  g += `</g></svg>`;
  let t = `<table class="bp-t"><tr><th></th><th>内外</th><th>前後</th></tr>`;
  for (const it of [...items, ...extra]) t += `<tr><th style="white-space:nowrap"><span class="bp-dot" style="background:${it.color}"></span>${esc(it.name)}</th><td>${it.inner?.html || `<span class="dim">-</span>`}</td><td>${it.front?.html || `<span class="dim">-</span>`}</td></tr>`;
  t += `<tr><th style="white-space:nowrap"><span class="bp-dot" style="background:var(--muted);border-radius:0;width:10px;height:2px;vertical-align:3px"></span>${BP_NORM}</th><td>${norm?.inner != null ? (norm.inner >= 0 ? "+" : "") + norm.inner.toFixed(2) : "-"}</td><td>${norm?.front != null ? (norm.front >= 0 ? "+" : "") + norm.front.toFixed(2) : "-"}</td></tr>`;
  if (act) t += `<tr><th style="white-space:nowrap"><span style="color:#f5c400;margin-right:4px">◆</span>${esc(act.name || "結果")}</th><td>${act.inner != null ? `<b>${act.inner >= 0 ? "+" : ""}${act.inner.toFixed(3)}</b>` : "-"}</td><td>${act.front != null ? `<b>${act.front >= 0 ? "+" : ""}${act.front.toFixed(3)}</b>` : "-"}</td></tr>`;
  const opt = trail.length ? `<label class="muted" style="font-size:12px;display:block;margin-bottom:4px" title="この開催(同じ連続開催)の前日までの開催日ごとの実績を、点と線で重ねる。1日目から順に線でつなぎ、塗った点が前日">` +
    `<input type="checkbox" class="bpTrail" ${bpTrailOn() ? "checked" : ""}> この開催の日ごとの実績を線で出す(${trail.length}日)</label>` : "";
  return `<div class="bp"><div>${opt}${g}<div><button class="bpZoom" title="図を大きく表示する(＋−で拡大、ドラッグで動かす)">拡大表示</button></div></div>${t}</table></div>`;
}
// 馬場傾向・時計の横棒グラフ(11/23 ユーザーの指示「数値だとわかりづらいので横のグラフで」「答え合わせを点で重ねて」)。
// pred: 予想(値か [下, 上] の幅。青の点・帯)、norm: ふだん(灰色の縦線)、act: 結果(黄色の◆)。値は min〜max に収める
function biasGraph({ pred, norm, act, min = -0.3, max = 0.3, left = "内", right = "外", fmt = v => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`, ticks = [-0.2, -0.1, 0, 0.1, 0.2] }) {
  const x = v => Math.max(0, Math.min(100, (v - min) / (max - min) * 100));
  let h = `<div class="bg-wrap"><span class="bg-l">← ${esc(left)}</span><div class="viz-track"><div class="bg-axis"></div>` +
    ticks.map(t => `<div class="viz-grid" style="left:${x(t)}%;${t === 0 ? "opacity:.9" : ""}"></div>`).join("");
  if (norm != null) h += `<div class="bg-norm" style="left:${x(norm)}%" title="ふだん ${fmt(norm)}"></div>`;
  const lo = Array.isArray(pred) ? pred[0] : pred, hi = Array.isArray(pred) ? pred[1] : pred;
  if (lo != null) h += hi - lo > 1e-9 ? `<div class="viz-b" style="left:${x(lo)}%;width:${Math.max(1, x(hi) - x(lo))}%" title="予想 ${fmt(lo)}〜${fmt(hi)}"></div>`
    : `<div class="viz-dot" style="left:${x(lo)}%" title="予想 ${fmt(lo)}"></div>`;
  if (act != null) h += `<div class="viz-res" style="left:${x(act)}%" title="結果 ${fmt(act)}"></div>`;
  return h + `</div><span class="bg-r">${esc(right)} →</span>` +
    `<div class="bg-ticks">${ticks.map(t => `<span class="viz-tick" style="left:${x(t)}%">${fmt(t).replace(/\.?0+$/, "") || "0"}</span>`).join("")}</div></div>`;
}
const BG_AXIS = { inner: { left: "内有利", right: "外有利" }, front: { left: "前有利", right: "後ろ有利" } };
// 時計のかかり具合: 勝ちタイム − 基準(同じ競馬場・芝ダ・距離・馬場状態の過去3年の平均)の、基準に対する % 。プラスは時計がかかる
function parseRunTime(t) { const m = String(t || "").match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); return m ? (+(m[1] || 0)) * 60 + +m[2] : null; }
function clockPct(rid) {
  const i = state.info.get(rid) || {}, base = num(i["勝ちタイムの基準"]), v = num(i["勝ちタイムの予想"]);
  const w = (state.results.get(rid) || []).find(r => num(r["着順"]) === 1), a = parseRunTime(w?.["走破タイム"]);
  return { pred: base && v != null ? (v - base) / base * 100 : null, act: base && a != null ? (a - base) / base * 100 : null, baba: i["馬場状態"] || "" };
}
const CLOCK_FLAT = 0.4;   // 基準との差(%)がこれ未満なら「ふつう」
function clockWord(p) { return p == null ? "" : p <= -CLOCK_FLAT * 2 ? "高速(時計が速い)" : p <= -CLOCK_FLAT ? "やや速い" : p >= CLOCK_FLAT * 2 ? "時計がかかる" : p >= CLOCK_FLAT ? "やや時計がかかる" : "ふつう"; }
const pctFmt = v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
function clockGraph(pred, act) {
  return biasGraph({ pred, act, norm: 0, min: -3, max: 3, left: "速い", right: "かかる", fmt: pctFmt, ticks: [-2, -1, 0, 1, 2] });
}
function biasNorm(guide) {
  // 目安の文言の「芝のふだん -0.01」の値(無い古い CSV は 0 = 全馬の平均と同じ)
  const m = String(guide).match(/のふだん\s*([+-]?\d+(?:\.\d+)?)/);
  return m ? +m[1] : 0;
}
function biasWord(axis, d) {
  const [a, b] = axis === "inner" ? ["内", "外"] : ["前", "後ろ"];
  return Math.abs(d) < BIAS_FLAT ? `ふだん並み(わずかに${d < 0 ? a : b})` : `ふだんより${d < 0 ? a : b}有利`;
}
function biasJudge(axis, word, actual, norm) {
  // 予想の向き(目安の言葉)と、実際の値 − ふだん の向きを比べる
  const d = actual - norm;
  const pred = /並み/.test(word) ? 0 : axis === "inner" ? (/内/.test(word) ? -1 : /外/.test(word) ? 1 : null) : (/前/.test(word) ? -1 : /後/.test(word) ? 1 : null);
  if (pred == null) return null;
  const ok = pred === 0 ? Math.abs(d) < BIAS_FLAT : Math.sign(d) === pred;
  // 向きは合っていても、差が小さい(ふだん並み)ときは △
  const mark = !ok ? "×" : pred !== 0 && Math.abs(d) < BIAS_FLAT ? "△" : "○";
  return { ok, mark, why: `結果 ${actual >= 0 ? "+" : ""}${actual.toFixed(3)}(ふだん ${norm >= 0 ? "+" : ""}${norm.toFixed(2)} との差 ${d >= 0 ? "+" : ""}${d.toFixed(3)}: ${biasWord(axis, d)})` };
}
// 見送り推奨(仮): 予想 CSV に「見送り」の列があればそれを使う。無ければ暫定で、推奨買い目の「おすすめ」(今の予算の区分)の
// 確かめの回収率(4年で選んで残りの1年で確かめた回収率)が SKIP_ROI% 未満のレースを見送りにする。推奨買い目が無ければ null(判定できない)
const SKIP_ROI = 80;
// 日別ページの見送り推奨の判定。資金配分案(fundPlan)と同じ額の区分・同じ借り方で、発走済みのレースや対象外の場のレースも判定する
function skipJudge(date) {
  const P = fundPlan(date);
  const first = P.ok.length ? P.budget / P.ok.length : 0;   // 資金配分案の判定に使う額(予算 ÷ 対象のレース数)
  return rid => {
    const r0 = state.races.get(rid)?.[0];
    if (!r0) return null;
    if ("見送り" in r0) return { skip: ["1", "true", "見送り", "○"].includes(String(r0["見送り"]).trim()), why: r0["見送りの理由"] || "", src: "csv" };
    if (raceBlocked(rid)) return null;
    const own = fundOptions(rid), opts = own.length ? own : fundCellOptions(date, rid);
    const o = opts.length ? fundChoose(opts, first) : null;
    if (o?.honest == null) return null;
    return { skip: o.honest < SKIP_ROI, honest: o.honest, past: num(o.parts?.[0]?.["過去の回収率"]) ?? (o.borrowed ? num((state.plans.get(o.borrowed) || [])
        .find(x => (x["種類"] || "おすすめ") === "おすすめ" && x["予算"] === o.name)?.["過去の回収率"]) : null),
      how: o.how, tier: o.name, pending: !own.length, borrowed: o.borrowed, src: "plan" };
  };
}
window.addEventListener("message", event => {
  if (event.origin !== location.origin || event.data?.type !== "day-page-height") return;
  const frame = document.querySelector("#main .day-page-frame");
  if (frame && event.source === frame.contentWindow && Number.isFinite(event.data.height)) {
    frame.style.height = Math.max(160, Math.min(event.data.height, 12000)) + "px";
  }
});
// ---------- 資金配分案（仮）(日別ページ) ----------
// 入れた予算を、その時点で発走前のレースに配る。レースごとに使うのは、配分額が入る予算の区分の推奨買い目「おすすめ」。
// 見込みの回収率 = その「確かめの回収率」(4年で選んで残りの1年で確かめた回収率)。決め方は検証期間(2019〜2023年)の
// 保存済みの予測と払戻だけで ml/fund_plan.py で確かめたもの(docs/fund-plan.md)。当日の予想・結果・払戻はこの決め方の調整に使わない。
//   1. 予算 ÷ 対象のレース数 の額の区分で、各レースの見込みの回収率を出す
//   2. 見込みの回収率が FUND_RULE.skip% 未満なら見送り推奨(✔ なし)、それ以外は購入推奨(✔)。予想 CSV に「見送り」の列があればそちら
//   3. ✔ のレースに 100円単位で配る。power = 0 なら均等(採用)。power > 0 なら重み (見込みの回収率/100 − base)^power、
//      1レースの上限は予算の cap(検証期間では重みを付けても良くならなかったので使っていない。docs/fund-plan.md)
//   4. 配分額の区分のおすすめ(点数 × 100円 が配分額を超えるなら、収まる下の区分)を出す
const FUND_RULE = { skip: SKIP_ROI, power: 0, base: 0.5, cap: null };
function fundOf(date) {
  if (!state.fund) state.fund = {};
  if (!state.fund[date]) {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(`keiba-viewer:fund:${date}`) || "null"); } catch (e) {}
    s = s && typeof s === "object" ? s : {};
    state.fund[date] = { budget: num(s.budget), picks: s.picks && typeof s.picks === "object" ? s.picks : {}, past: !!s.past,
      byJyo: !!s.byJyo, jyo: s.jyo || null,     // byJyo = 一覧を場別のタブで見る、jyo = 選んでいる場
      offJyo: Array.isArray(s.offJyo) ? s.offJyo : [] };   // 資金配分の対象から外した場(場コード。初めは全場が対象)
  }
  return state.fund[date];
}
function saveFund(date) {
  try { localStorage.setItem(`keiba-viewer:fund:${date}`, JSON.stringify(state.fund?.[date] || {})); } catch (e) {}
}
function raceStarted(rid) {
  // 結果・払戻が出た、または発走時刻を過ぎたレース(前の日付は全部、先の日付はどれも発走前)
  if (state.results.has(rid) || state.pays.has(rid)) return true;
  const now = new Date(), d = rid.slice(0, 8);
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  if (d !== today) return d < today;
  const t = String(state.races.get(rid)?.[0]?.hasso_time || "").replace(/\D/g, "");
  return !!t && now.getHours() * 100 + now.getMinutes() >= +t;
}
function fundTierIndex(amount) { return BUDGET_TIERS.findIndex(([lim]) => amount <= lim); }
// 資金配分案のモード(このブラウザに覚えておく)。roi = 回収率重視(区分のおすすめ)、hit = 的中重視(区分の候補のうち過去の的中率が一番高い買い方)
// 的中重視は 2026-11-16 ユーザーの指示「資金配分案に的中重視モードをつけることはできる？」。検証期間での1日ごとの確かめはまだ(docs/fund-plan.md)
let FUND_MODE_OVERRIDE = null;   // 「もし推奨馬券を〜」の計算のあいだだけ、その欄のモードにする(2026-11-21 ユーザーの指示: 資金配分案と別々に動く)
// 2026-11-21 ユーザーの指示: 前の「的中重視」(hit)は「超的中重視」に名前を変え、「的中重視」(hit2)は 馬連・馬単・3連複・ワイド・枠連 の券種別の中で選ぶ
const FUND_MODES = [["roi", "回収率重視", "配分額の区分の推奨買い目「おすすめ」を買う"],
  ["hit2", "的中重視(ワイド抜き)", "配分額の区分の券種別の候補のうち、馬連・馬単・3連複・枠連 で点数が収まり過去の的中率が一番高い買い方を買う(無ければおすすめ)"],
  ["wide", "ワイド", "配分額の区分の券種別のワイドを買う(無ければおすすめ)"],
  ["hit", "超的中重視", "配分額の区分の候補(おすすめ・組み合わせ・券種別)のうち、点数が収まり過去の的中率が一番高い買い方を買う(複勝・ワイドが多くなる)"]];
// ワイドは「ワイド」で切り出し、「的中重視」はワイド抜きにした(2026-11-21 ユーザーの指示「ワイドはワイドで切り出して、ワイド抜きのボタンも」)
const MODE_KINDS = { hit2: new Set(["馬連", "馬単", "3連複", "枠連"]), wide: new Set(["ワイド"]) };
const modeOk = m => FUND_MODES.some(([k]) => k === m) ? m : "roi";
const modeName = m => (FUND_MODES.find(([k]) => k === m) || FUND_MODES[0])[1];
function fundMode() {
  if (FUND_MODE_OVERRIDE) return FUND_MODE_OVERRIDE;
  try { return modeOk(localStorage.getItem("keiba-viewer:fundMode")); } catch (e) { return modeOk(state.fundMode); }
}
function simMode() {
  try { return modeOk(localStorage.getItem("keiba-viewer:simMode")); } catch (e) { return modeOk(state.simMode); }
}
function setSimMode(m) {
  try { localStorage.setItem("keiba-viewer:simMode", m); } catch (e) { state.simMode = m; }
}
// 推奨レースの優先順位(2026-11-21 ユーザーの指示): 見送りでないレースを、見込みの回収率と期待値の平均で並べる(期待値はオッズのあるレースだけ)
const PRIO_SELS = [["n3", "上位3"], ["n5", "上位5"], ["n8", "上位8"], ["p30", "上位30%"], ["p50", "上位50%"], ["all", "全部"]];
function prioSel(k, d = "n5") { return PRIO_SELS.some(([x]) => x === state[k]) ? state[k] : d; }
function prioCount(sel, n) { return sel === "all" ? n : sel[0] === "n" ? Math.min(n, +sel.slice(1)) : Math.max(1, Math.round(n * +sel.slice(1) / 100)); }
function prioRank(P0) {
  const cand = P0.ok.filter(x => x.autoBuy && !x.wait && x.est0 != null);
  for (const x of cand) x.score = x.ev != null ? (x.est0 + x.ev) / 2 : x.est0;
  return cand.sort((a, b) => b.score - a.score);
}
// 「1位≠1番人気だけ」(2026-11-22 ユーザーの指示、docs/model-todo.md P2): モデルの1位(平均の勝率が一番高い馬)が単勝の1番人気と同じレースは買わない。
// 1番人気は予想 CSV の今の単勝オッズ(発走20分前からは1分ごと、発走後は確定)。同じオッズの1番人気が2頭以上なら、そのどれかなら「同じ」。オッズが無ければ判定しない(絞らない)
function favSame(rid) {
  const rows = state.races.get(rid);
  if (!rows?.length) return null;
  // 単勝オッズは 予想 CSV → オッズ CSV の単勝 → 結果の単勝オッズ(確定) の順で使う
  const res = new Map((state.results.get(rid) || []).map(x => [String(+x["馬番"]), num(x["単勝オッズ"])]));
  const oddsOf = r => getOdds(rid, r.umaban, r) ?? state.odds.get(rid)?.get(ticketKey("単勝", [String(+r.umaban)])) ?? res.get(String(+r.umaban)) ?? null;
  const xs = rows.map(r => ({ p: num(r["平均_勝率"]), o: oddsOf(r) }));
  const ps = xs.filter(x => x.p != null), os = xs.filter(x => x.o != null && x.o > 0);
  if (!ps.length || os.length < 2) return null;
  const top = ps.reduce((a, b) => b.p > a.p ? b : a), mo = Math.min(...os.map(x => x.o));
  return top.o != null && top.o === mo;
}
const DIFF_WHY = "モデルの1位が1番人気と同じ(「1位≠1番人気だけ」で外した)";
function diffOn(k) {
  try { return localStorage.getItem("keiba-viewer:" + k) === "1"; } catch (e) { return !!state[k]; }
}
function setDiff(k, v) {
  try { localStorage.setItem("keiba-viewer:" + k, v ? "1" : "0"); } catch (e) { state[k] = v; }
}
function diffBtns(k, cls = "simBtn") {
  const on = diffOn(k);
  return `<span class="muted" style="align-self:center;margin-right:6px">レース:</span>` +
    `<button class="${cls}${on ? "" : " on"}" data-k="${k}" data-v="0">全部</button>` +
    `<button class="${cls}${on ? " on" : ""}" data-k="${k}" data-v="1" title="モデルの1位が単勝の1番人気と違うレースだけ買う(検証 2019〜2023年で回収率 +0.03〜+0.07。1番人気は確定オッズで決めたので少し甘い)">1位≠1番人気だけ</button>`;
}
function setFundMode(m) {
  try { localStorage.setItem("keiba-viewer:fundMode", m); } catch (e) { state.fundMode = m; }
}
function fundLabel(o) { return o?.label || "おすすめ"; }
function fundOptions(rid) {
  const current = state.races.get(rid) || [];
  if (activeRows(current).length !== current.length || !probabilityReady(current) || placeCount(current) == null) return [];
  // 予算の区分ごとの候補: [{tier, name, label, how, n(このレースで買える点数), honest, hit(過去の的中率), parts}]。推奨買い目が無ければ空。
  // 回収率重視は区分ごとにおすすめの1つ。的中重視は、おすすめ・組み合わせ(合わせて1つ)・券種別(1行ずつ)を全部候補にする
  const all = (state.plans.get(rid) || []).map(x => {
    const odds = (x["買い目のオッズ"] || "").split(" / ");
    const kept = (x["買い目"] || "").split(" / ").map((v, i) => ({v, o: odds[i] || ""})).filter(({v}) => /\d/.test(v) && ticketEligible(current, {kind: x["券種"], t: v.split(/[-→]/)}));
    return {...x, "買い目": kept.map(y => y.v).join(" / "), "買い目のオッズ": kept.map(y => y.o).join(" / "), "点数": kept.length};
  }).filter(x => x["点数"] > 0);
  const kindOf = x => x["種類"] || "おすすめ";
  const hitMode = fundMode() !== "roi";
  const make = (tier, name, label, parts) => ({ tier, name, label, how: parts.map(x => x["買い方"]).join(" + "),
    n: parts.reduce((s, x) => s + (num(x["点数"]) || 0), 0), honest: num(parts[0]["確かめの回収率"]), hit: num(parts[0]["過去の的中率"]), parts });
  return BUDGET_TIERS.flatMap(([, name], tier) => {
    const rows = all.filter(x => x["予算"] === name);
    const out = [];
    const rec = rows.filter(x => kindOf(x) === "おすすめ");
    if (rec.length) out.push(make(tier, name, "おすすめ", rec));
    if (hitMode) {
      const mix = rows.filter(x => kindOf(x) === "組み合わせ");
      if (mix.length) out.push(make(tier, name, "組み合わせ", mix));
      rows.filter(x => kindOf(x) === "券種別").forEach(x => out.push(make(tier, name, x["分け"] || x["券種"], [x])));
    }
    return out;
  });
}
function fundChoose(opts, amount) {
  // 配分額の区分の買い方。点数 × 100円 が配分額を超えるなら、収まる下の区分(どれも収まらなければ一番下)。
  // 回収率重視はおすすめ。的中重視は、収まる候補のうち過去の的中率が一番高いもの(同じなら確かめの回収率が高いもの)
  const byHit = xs => [...xs].sort((a, b) => (b.hit ?? -1) - (a.hit ?? -1) || (b.honest ?? -1) - (a.honest ?? -1))[0];
  const kinds2 = MODE_KINDS[fundMode()];
  if (kinds2) {
    // 的中重視(ワイド抜き)・ワイド: 券種別のうち、その券種だけ。収まる区分に無ければ下の区分、どこにも無ければおすすめ
    const ok2 = x => x.label !== "おすすめ" && x.label !== "組み合わせ" && x.parts.every(p => kinds2.has(p["券種"]));
    const t2 = fundTierIndex(amount);
    for (let k = t2; k >= 0; k--) {
      const fit = opts.filter(x => x.tier === k && x.n > 0 && x.n * 100 <= amount && ok2(x));
      if (fit.length) return byHit(fit);
    }
    const low2 = opts.filter(x => x.tier === 0 && ok2(x));
    if (low2.length) return byHit(low2);
  }
  const best = xs => fundMode() === "hit" ?
    [...xs].sort((a, b) => (b.hit ?? -1) - (a.hit ?? -1) || (b.honest ?? -1) - (a.honest ?? -1))[0] :
    (xs.find(x => fundLabel(x) === "おすすめ") || xs[0]);
  const t = fundTierIndex(amount);
  for (let k = t; k >= 0; k--) {
    const fit = opts.filter(x => x.tier === k && x.n > 0 && x.n * 100 <= amount);
    if (fit.length) return best(fit);
  }
  const low = opts.filter(x => x.tier === 0);
  return (low.length ? best(low) : opts[0]) || null;
}
function fundDistribute(budget, weights, cap) {
  // 重みに比例して 100円単位に配る(重み 0 は配らない)。cap は1レースの上限(予算に対する割合)。合計は予算を超えない(ml/fund_plan.py の distribute と同じ)
  const n = weights.length, units = Math.floor(budget / 100);
  const out = new Array(n).fill(0);
  if (units <= 0 || !weights.some(w => w > 0)) return out;
  const capU = cap ? Math.max(1, Math.floor(cap * units)) : units;
  let active = weights.map(w => w > 0);
  if (active.filter(Boolean).length > units) {
    const keep = new Set(weights.map((w, i) => [w, i]).sort((a, b) => b[0] - a[0]).slice(0, units).map(([, i]) => i));
    active = active.map((_, i) => keep.has(i));
  }
  const alloc = new Array(n).fill(0);
  let free = active.slice(), left = units;
  while (left > 1e-9 && free.some(Boolean)) {
    const ws = weights.reduce((s, w, i) => s + (free[i] ? w : 0), 0);
    const share = weights.map((w, i) => free[i] ? left * w / ws : 0);
    const over = share.map((s, i) => free[i] && alloc[i] + s > capU);
    if (over.some(Boolean)) {
      over.forEach((o, i) => { if (o) { alloc[i] = capU; free[i] = false; } });
      left = units - alloc.reduce((a, b) => a + b, 0);
      continue;
    }
    share.forEach((s, i) => alloc[i] += s);
    left = 0;
  }
  const base = alloc.map(a => Math.floor(a + 1e-9));
  let rest = units - base.reduce((a, b) => a + b, 0);
  const frac = alloc.map((a, i) => active[i] && base[i] < capU ? a - base[i] : -1);
  frac.map((f, i) => [f, i]).sort((a, b) => b[0] - a[0]).forEach(([f, i]) => { if (rest > 0 && f >= 0) { base[i]++; rest--; } });
  return base.map(u => u * 100);
}
function fundGroup(lv) { return lv == null ? null : lv <= 3 ? "低" : lv <= 7 ? "中" : "高"; }   // bet_plan.group と同じ
function fundCell(rid) {
  // 推奨表の組(自信の組 × 混戦の組)。予想 CSV の「自信の段階」「混戦の段階」から
  const rows = state.races.get(rid);
  if (!rows) return null;
  const c = fundGroup(confLevel(rows)?.lv), m = fundGroup(num(rows[0]["混戦の段階"]));
  return c && m ? c + m : null;
}
function fundCellOptions(date, rid) {
  if (raceBlocked(rid)) return [];
  // 推奨買い目がまだ無いレース(発走55分前ごろに出る)の見込み: 同じ日・同じ組の別のレースの推奨買い目の区分ごとの値を借りる
  // (推奨表は組 × 予算の区分ごとに1つなので、買い方と確かめの回収率は同じ。点数は頭数で少し変わる)
  const cell = fundCell(rid);
  if (!cell) return [];
  const compatible = r => fundOptions(r).filter(o => placeCount(state.races.get(rid) || []) !== 0 || o.parts.every(p => p["券種"] !== "複勝"));
  const src = sortedRaces().find(r => r !== rid && r.slice(0, 8) === date && state.plans.has(r) && fundCell(r) === cell && compatible(r).length);
  return src ? compatible(src).map(o => ({ ...o, parts: [], borrowed: src })) : [];
}
function fundPlan(date, fOver = null) {
  // その日の資金配分案。open = 対象のレース(発走前。振り返りなら全部)。ok = 対象のうち予想 CSV のあるレース(配分する)
  const f = fOver || fundOf(date);   // fOver: 日別ページの「もし推奨馬券を買ったら」用の仮の設定(覚えておく設定は変えない)
  const rids = sortedRaces().filter(rid => rid.slice(0, 8) === date);
  const jyos = [...new Set(rids.map(rid => rid.slice(8, 10)))];
  const inJyo = rids.filter(rid => !f.offJyo.includes(rid.slice(8, 10)));     // 対象の場のレース
  const open = inJyo.filter(rid => (f.past || !raceStarted(rid)) && !raceBlocked(rid));
  const budget = f.budget || 0;
  const ok = open.map(rid => {
    const own = fundOptions(rid);
    return own.length ? { rid, opts: own, pending: false } : state.plans.has(rid) ? null : { rid, opts: fundCellOptions(date, rid), pending: true };
  }).filter(Boolean);
  const items = ok;
  const first = ok.length ? budget / ok.length : 0;
  for (const x of ok) {
    const o0 = x.opts.length ? fundChoose(x.opts, first) : null;
    x.est0 = o0?.honest ?? null;
    x.tier0 = o0?.name || "";        // 判定に使った区分(予算 ÷ 対象のレース数 の額)
    const csv = state.races.get(x.rid)?.[0];
    if (csv && "見送り" in csv) {
      x.autoBuy = !["1", "true", "見送り", "○"].includes(String(csv["見送り"]).trim());
      x.autoWhy = csv["見送りの理由"] || "予想 CSV の「見送り」の列";
    } else if (x.est0 == null) {
      // 推奨買い目が無く、同じ組の別のレースからも借りられない: 判定待ち(✔ を付けて配分額だけ取っておく)
      x.autoBuy = true;
      x.wait = true;
      x.autoWhy = "推奨買い目がまだ無い(発走55分前ごろに出る)。出たら判定し直す";
    } else {
      x.autoBuy = x.est0 >= FUND_RULE.skip;
      x.autoWhy = `見込みの回収率 ${fix(x.est0)}%(${o0.name}の${fundLabel(o0)}${x.pending ? "。推奨買い目がまだ無いので、同じ自信・混戦の組の " +
        raceName(o0.borrowed) + " の値" : ""})${x.autoBuy ? "" : ` < ${FUND_RULE.skip}%`}`;
    }
    if ((f.diffOnly ?? diffOn("diffFund")) && x.autoBuy && favSame(x.rid) === true) {
      x.autoBuy = false; x.wait = false; x.diffOut = true; x.autoWhy = DIFF_WHY;
    }
    x.pick = f.only ? f.only.has(x.rid) : x.rid in f.picks ? !!f.picks[x.rid] : x.autoBuy;
  }
  // 重み(power > 0 のとき)は、✔ のレースの数で均等に割ったときの額の区分の見込みの回収率から
  const picked = ok.filter(x => x.pick);
  const share = picked.length ? budget / picked.length : 0;
  for (const x of ok) {
    const o = x.opts.length ? fundChoose(x.opts, share || first) : null;
    x.est = o?.honest ?? x.est0;
    x.w = !x.pick ? 0 : f.weightOf ? f.weightOf(x) : FUND_RULE.power ? Math.pow(Math.max((x.est ?? 0) / 100 - FUND_RULE.base, 1e-6), FUND_RULE.power) : 1;
  }
  const amt = fundDistribute(budget, ok.map(x => x.w), picked.length > 1 ? FUND_RULE.cap : null);
  const tc = new Map();
  ok.forEach((x, i) => {
    x.amount = amt[i];
    if (!x.amount) return;
    x.opt = x.opts.length ? fundChoose(x.opts, x.amount) : null;
    x.honestUsed = x.opt?.honest;
    x.spent = x.amount;          // 買い目がまだ無いレースは配分額をそのまま取っておく
    if (x.pending) return;
    // 買い目(推奨買い目 CSV の並び)と、配分額を1点100円から均等に(余りは確率の高い順)
    x.tickets = [];
    for (const part of x.opt.parts) {
      const odds = (part["買い目のオッズ"] || "").split(" / ");
      (part["買い目"] || "").split(" / ").filter(t => /\d/.test(t)).forEach((t, j) => {
        const tk = t.split(/[-→]/), v = ticketValue(x.rid, part["券種"], tk, tc);
        if (ticketEligible(state.races.get(x.rid), {kind: part["券種"], t: tk})) x.tickets.push({ kind: part["券種"], t: tk, p: v.p ?? 0, o: v.o ?? num(odds[j]) });
      });
    }
    const ta = allocate(x.amount, x.tickets.map(y => y.p), "均等");
    x.tickets.forEach((y, j) => y.amount = ta[j]);
    x.spent = ta.reduce((a, b) => a + b, 0);
    const priced = x.tickets.filter(y => y.o && y.amount);
    const pc = priced.reduce((s, y) => s + y.amount, 0);
    x.ev = pc ? priced.reduce((s, y) => s + y.p * y.o * y.amount, 0) / pc * 100 : null;
    x.evPart = pc < x.spent;
    // 期待値に使ったオッズの日時(オッズ CSV があればその「オッズの種類」、無ければ推奨買い目 CSV の「オッズの種類」)と、推奨買い目の予想の段階
    const p0 = x.opt.parts[0] || {};
    x.oddsNote = (state.odds.has(x.rid) && state.oddsKind.get(x.rid)) || p0["オッズの種類"] || "";
    x.stage = p0["予想の段階"] || "";
  });
  return { f, rids, jyos, inJyo, open, items, ok, picked, budget, spent: ok.reduce((s, x) => s + (x.spent || 0), 0) };
}
const SIM_BUDGETS = [1000, 5000, 10000];
function renderDaySim(date, raceLink) {
  const rids = sortedRaces().filter(rid => rid.slice(0, 8) === date);
  const jyos = [...new Set(rids.map(rid => rid.slice(8, 10)))];
  const budget = SIM_BUDGETS.includes(+state.simBudget) ? +state.simBudget : 5000;
  const jyo = state.simJyo === "all" || jyos.includes(state.simJyo) ? state.simJyo : "all";
  const base = { budget, picks: {}, past: true, byJyo: false, jyo: null, offJyo: jyo === "all" ? [] : jyos.filter(j => j !== jyo), diffOnly: diffOn("diffSim") };
  // 優先順位(2026-11-21 ユーザーの指示): 推奨(見送りでない)レースを、見込みの回収率と期待値で並べ、上から選ぶ。
  // 点数 = 見込みの回収率と期待値の平均(期待値はオッズのあるレースだけ。無ければ見込みの回収率だけ)
  const mode = simMode();
  FUND_MODE_OVERRIDE = mode;
  const P0 = fundPlan(date, base);
  const cand = prioRank(P0);
  const SELS = PRIO_SELS, sel = prioSel("simSel");
  const chosen = cand.slice(0, prioCount(sel, cand.length));
  const rank = new Map(cand.map((x, i) => [x.rid, { i: i + 1, score: x.score, ev: x.ev, est: x.est0 }]));
  // 配分: 見込みの回収率が高いほど多く(80% を超えた分に比例)
  const P = fundPlan(date, { ...base, only: new Set(chosen.map(x => x.rid)), weightOf: x => Math.max((x.est0 ?? 0) - 80, 5) });
  FUND_MODE_OVERRIDE = null;
  // 並び(2026-11-22 ユーザーの指示): 順位順(既定)か、レース順(発走の順。同じ時刻なら場の順)
  const simSort = state.simSort === "race" ? "race" : "rank";
  const order = new Map(rids.map((r, i) => [r, i]));
  const hs = rid => String(state.races.get(rid)?.[0]?.hasso_time ?? "").padStart(4, "0");
  P.ok.sort(simSort === "race" ? (a, b) => hs(a.rid).localeCompare(hs(b.rid)) || order.get(a.rid) - order.get(b.rid) :
    (a, b) => (rank.get(a.rid)?.i ?? 999) - (rank.get(b.rid)?.i ?? 999));
  const btn = (k, v, label, on) => `<button class="simBtn${on ? " on" : ""}" data-k="${k}" data-v="${v}">${label}</button>`;
  let h = `<div class="card day-fold"><h3>もし推奨馬券を一日の予算 ${budget.toLocaleString()}円で買ったら${updTag(["推奨買い目", "払戻"], rids)}</h3>` +
    `<div class="tabs" style="margin-bottom:6px"><span class="muted" style="align-self:center;margin-right:6px">予算:</span>` +
    SIM_BUDGETS.map(b => btn("simBudget", b, b.toLocaleString() + "円", b === budget)).join("") + `</div>` +
    `<div class="tabs" style="margin-bottom:8px"><span class="muted" style="align-self:center;margin-right:6px">場:</span>` +
    btn("simJyo", "all", "全場", jyo === "all") + jyos.map(j => btn("simJyo", j, esc(JYO[j] || j), j === jyo)).join("") + `</div>` +
    `<div class="tabs" style="margin-bottom:8px"><span class="muted" style="align-self:center;margin-right:6px">買うレース:</span>` +
    SELS.map(([k, l]) => btn("simSel", k, l, k === sel)).join("") +
    `<span class="muted" style="align-self:center;margin-left:6px">推奨 ${cand.length}レースのうち ${chosen.length}レース</span></div>` +
    `<div class="tabs" style="margin-bottom:8px">${diffBtns("diffSim")}</div>` +
    `<div class="tabs" style="margin-bottom:8px"><span class="muted" style="align-self:center;margin-right:6px">買い方:</span>` +
    FUND_MODES.map(([k, l]) => btn("simMode", k, l, mode === k)).join("") +
    `<span class="muted" style="align-self:center;margin-left:6px">(資金配分案のモードとは別)</span></div>` +
    `<div class="tabs" style="margin-bottom:8px"><span class="muted" style="align-self:center;margin-right:6px">並び:</span>` +
    btn("simSort", "rank", "順位順", simSort === "rank") + btn("simSort", "race", "レース順(発走順)", simSort === "race") + `</div>`;
  const rows = [];
  let cost = 0, back = 0, setCost = 0, hitRaces = 0, setRaces = 0, waitRaces = 0;
  for (const x of P.ok) {
    if (!x.pick) { rows.push({ x, skip: true, out: rank.has(x.rid) }); continue; }
    if (!x.tickets?.length) { rows.push({ x, none: true }); continue; }
    const settled = state.pays.has(x.rid);
    let rc = 0, rb = 0;
    const ts = x.tickets.filter(t => t.amount > 0).map(t => {
      const hp = settled ? hitPayout(x.rid, t.kind, t.t) : null;
      const b = settled ? (hp || 0) * t.amount / 100 : null;
      rc += t.amount; if (b) rb += b;
      return { ...t, back: b };
    });
    cost += rc;
    if (settled) { setCost += rc; back += rb; setRaces++; if (rb > 0) hitRaces++; } else waitRaces++;
    rows.push({ x, ts, rc, rb, settled });
  }
  const sign = v => `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v)).toLocaleString()}円`;
  h += `<div class="kpis" style="margin:0 0 8px">` +
    kpi(`${cost.toLocaleString()}円`, `使った額(${rows.filter(r => r.ts).length}レース。選外 ${rows.filter(r => r.out).length}・見送り ${rows.filter(r => r.skip && !r.out).length}レース)`) +
    kpi(setCost ? `<span class="${back >= setCost ? "hi" : ""}">${Math.round(back).toLocaleString()}円</span>` : "-", `払戻(結果の出た ${setRaces}レース)`) +
    kpi(setCost ? `<span class="${back >= setCost ? "hi" : ""}">${sign(back - setCost)}</span>` : "-", "収支(結果の出たレースだけ)") +
    kpi(setCost ? `<span class="${back >= setCost ? "hi" : ""}">${fix(back / setCost * 100)}%</span>` : "-", "回収率") +
    kpi(setRaces ? `${hitRaces} / ${setRaces}` : "-", "当たったレース") +
    (waitRaces ? kpi(`${waitRaces}レース`, "結果待ち(収支に入れない)") : "") + `</div>`;
  if (!P.ok.length) h += `<div class="muted">この場のレースの予想がありません。</div>`;
  else {
    h += `<div class="scroll" style="max-height:560px;overflow-y:auto"><table><tr><th>レース</th><th class="n" title="見込みの回収率と期待値の平均の順">順位</th><th class="n">見込み</th><th class="n">期待値</th><th>買い方</th><th>券種</th><th>買い目</th><th class="n">金額</th><th class="n">払戻</th><th class="n">レースの収支</th></tr>`;
    for (const r of rows) {
      if (r.skip || r.none) {
        const rk = rank.get(r.x.rid);
        h += `<tr class="dim"><td>${raceLink(r.x.rid)}</td><td class="n">${rk ? rk.i : "-"}</td><td class="n">${rk ? fix(rk.est) + "%" : "-"}</td><td class="n">${rk?.ev != null ? fix(rk.ev) + "%" : "-"}</td>` +
          `<td colspan="6">${r.out ? "優先順位の外(選んだ数に入らない)" : r.skip ? "見送り(" + esc(r.x.autoWhy || "") + ")" : "推奨買い目が無い(買えない)"}</td></tr>`;
        continue;
      }
      r.ts.forEach((t, i) => {
        const sep = (t.kind === "馬単" || t.kind === "3連単") ? "→" : "-";
        h += `<tr class="${t.back ? "hit" : ""}">` +
          (i ? "" : `<td rowspan="${r.ts.length}">${raceLink(r.x.rid)}</td>` +
            [rank.get(r.x.rid)?.i ?? "-", rank.get(r.x.rid) ? fix(rank.get(r.x.rid).est) + "%" : "-", rank.get(r.x.rid)?.ev != null ? fix(rank.get(r.x.rid).ev) + "%" : "-"]
              .map(v => `<td class="n" rowspan="${r.ts.length}">${v}</td>`).join("") +
            `<td rowspan="${r.ts.length}">${esc(r.x.opt?.how || "")}<div class="dim" style="font-size:11px">${r.rc.toLocaleString()}円</div></td>`) +
          `<td>${esc(t.kind)}</td><td><b>${esc(t.t.join(sep))}</b></td><td class="n">${t.amount.toLocaleString()}円</td>` +
          `<td class="n">${!r.settled ? `<span class="dim">結果待ち</span>` : t.back ? `<b class="hi">${Math.round(t.back).toLocaleString()}円</b>` : `<span class="dim">はずれ</span>`}</td>` +
          (i ? "" : `<td class="n" rowspan="${r.ts.length}">${r.settled ? `<b class="${r.rb >= r.rc ? "hi" : ""}">${sign(r.rb - r.rc)}</b>` : `<span class="dim">${r.rc.toLocaleString()}円 結果待ち</span>`}</td>`) + `</tr>`;
      });
    }
    h += `</table></div>`;
  }
  return h + `<div class="note">発走の前後を問わずこの日の全レース(選んだ場)で: 見込みの回収率が ${FUND_RULE.skip}% 未満のレースは見送り、` +
    `残りの推奨レースに、見込みの回収率と期待値(期待値はオッズのあるレースだけ。無ければ見込みの回収率だけ)の平均で順位を付け、「買うレース」で選んだ数だけ上から買う。` +
    `予算は選んだレースに、見込みの回収率が 80% を超えた分に比例して100円単位で配り(見込みの高いレースほど多い)、配分額の区分の推奨買い目(この欄の${modeName(mode)}のモード)を1点ずつ均等に買う。` +
    `資金配分案の ✔ の付け外し・予算とは別で、ここでの選択は覚えておくだけ。推奨買い目は発走55分前ごろの版なので、実際に買えたものとは違うことがある。結果は表示だけで、モデルには使わない。</div></div>`;
}
function raceName(rid) { return rid ? `${JYO[rid.slice(8, 10)] || rid.slice(8, 10)} ${+rid.slice(14, 16)}R` : ""; }
function renderFund(date, raceLink) {
  const P = fundPlan(date), f = P.f;
  const started = P.inJyo.length - P.open.length;
  let h = `<div class="card fund-card day-fold"><h3>資金配分案（仮）<button class="help" id="fundHelp" title="資金配分案の使い方と決め方">？</button>${updTag(["推奨買い目", "予想"], sortedRaces().filter(r => r.slice(0, 8) === date))}</h3>` +
    // 対象の場(✔ の無い場は資金配分の対象から外す)
    `<div class="calc fund-jyos" style="margin-bottom:6px"><span class="muted">対象の場:</span>` +
    P.jyos.map(j => `<label><input type="checkbox" class="fundJyoOn" data-j="${j}" ${f.offJyo.includes(j) ? "" : "checked"}> ${esc(JYO[j] || j)}</label>`).join("") +
    `<button id="fundJyoAll" title="全部の場を資金配分の対象にする" ${f.offJyo.some(j => P.jyos.includes(j)) ? "" : "disabled"}>全場選択</button></div>` +
    `<div class="calc" style="margin-bottom:8px"><label>この日の予算 <input id="fundBudget" class="odds" inputmode="numeric" style="width:110px" value="${f.budget ?? ""}" placeholder="例 10000"> 円</label>` +
    `<button id="fundAuto" title="✔ を最初の自動の選定(購入推奨に ✔、見送り推奨は ✔ なし)に戻す">✔ を自動の選定に戻す</button>` +
    `<span class="tabs fundMode" style="margin:0" title="レースごとに買う買い方の選び方(このブラウザに覚えておく)">` +
    FUND_MODES
      .map(([m, t, tip]) => `<button data-m="${m}" class="${fundMode() === m ? "on" : ""}" title="${tip}">${t}</button>`).join("") + `</span>` +
    `<span class="tabs fundDiff" style="margin:0">${diffBtns("diffFund", "")}</span>` +
    `<label title="前の日付の振り返りや、発走済みのレースも入れて見たいとき"><input type="checkbox" id="fundPast" ${f.past ? "checked" : ""}> 発走済み・結果の出たレースも入れる</label></div>`;
  if (!P.inJyo.length) return h + `<div class="muted">${P.rids.length ? "対象の場が選ばれていません。上の「対象の場」に ✔ を入れるか「全場選択」を押す。" : "この日のレースがありません。"}</div></div>`;
  if (!P.open.length) return h + `<div class="muted">${P.rids.length ? `発走前のレースがありません(この日の ${P.rids.length}レースはどれも発走済み・結果あり)。振り返るときは「発走済み・結果の出たレースも入れる」に ✔ を入れる。` : "この日のレースがありません。"}</div></div>`;
  const pending = P.ok.filter(x => x.pending).length;
  if (!P.budget) h += `<div class="muted" style="margin-bottom:6px">予算を入れると、✔ のレースに配分します(下の表は ✔ と見込みの回収率だけ)。</div>`;
  else {
    const left = P.budget - P.spent;
    h += `<div class="kpis" style="margin:0 0 8px">` +
      kpi(`${P.picked.length} / ${P.ok.length}`, `✔ のレース / 対象のレース(${P.inJyo.length < P.rids.length ? `${P.jyos.filter(j => !f.offJyo.includes(j)).map(j => JYO[j] || j).join("・")}の` : ""}発走前${started && !f.past ? `。発走済み ${started}レースは除く` : ""})`) +
      kpi(`${P.spent.toLocaleString()}円`, `配分の合計(予算 ${P.budget.toLocaleString()}円${left > 0 ? `・残り ${left.toLocaleString()}円` : ""})`) +
      kpi(P.ok.filter(x => x.autoBuy).length, `購入推奨（仮）(見込みの回収率 ${FUND_RULE.skip}%以上)`) +
      (pending ? kpi(pending, "推奨買い目がまだのレース(配分額は取っておく)") : "") + `</div>`;
  }
  if (P.budget && P.spent) h += `<div class="calc" style="margin:0 0 8px"><button id="fundCopyAll" title="✔ のレースの配分額を、各レースの個別ページの推奨買い目の「手入力」に入れる(そのレースだけの金額。✔ の無いレースと、対象から外した場のレースは、前に送った金額を消す)">→ ✔ のレースの配分額を全部、各レースの手入力に送る</button>` +
    (P.ok.some(x => raceBudgetOf(x.rid)) ? `<button id="fundCopyClear" title="この日の各レースの「このレースだけの手入力」を消して、共通の手入力に戻す">送った手入力を消す</button>` : "") + `</div>`;
  // 一覧: 「場別に表示」なら場のタブで切り替える(上のサマリと配分はその日の全部の場のまま)
  const jyos = [...new Set(P.ok.map(x => x.rid.slice(8, 10)))];
  const cur = jyos.includes(f.jyo) ? f.jyo : jyos[0];
  const shown = f.byJyo ? P.ok.filter(x => x.rid.slice(8, 10) === cur) : P.ok;
  h += `<div class="fund-view"><label title="一覧を競馬場ごとのタブで見る(配分はその日の全部の場で計算したまま)"><input type="checkbox" id="fundByJyo" ${f.byJyo ? "checked" : ""}> 場別に表示</label>` +
    (f.byJyo ? `<div class="tabs fundJyo">` + jyos.map(j => {
      const xs = P.ok.filter(x => x.rid.slice(8, 10) === j), amt = xs.reduce((a, x) => a + (x.spent || 0), 0);
      return `<button data-j="${j}" class="${j === cur ? "on" : ""}" title="${esc(JYO[j] || j)}: ✔ ${xs.filter(x => x.pick).length} / ${xs.length}レース・配分 ${amt.toLocaleString()}円">` +
        `${esc(JYO[j] || j)} <span class="muted">✔${xs.filter(x => x.pick).length}/${xs.length}${P.budget ? `・${amt.toLocaleString()}円` : ""}</span></button>`;
    }).join("") + `</div>` : "") + `</div>`;
  h += `<div class="scroll"><table class="fund-table"><tr class="f-head"><th title="買う(✔)/見送り">✔</th><th>レース</th><th>発走</th><th class="n" title="自信は100段階、混戦は10段階">自信<small>/100</small></th><th class="n">混戦<small>/10</small></th>` +
    `<th>自動の判定</th><th class="n" title="購入推奨・見送り推奨の判定に使った値(予算 ÷ 対象のレース数 の額が入る区分のおすすめの確かめの回収率)。配分額の区分の値が違えば下に小さく出す">見込みの回収率</th><th class="n">期待値</th><th class="n">配分額</th><th class="n" title="結果(払戻の CSV)が出たレースの、配分案の買い目の払戻(当たった買い目の 100円あたりの払戻 × 金額 ÷ 100)">払戻</th><th>${fundMode() === "roi" ? "おすすめの買い目" : modeName(fundMode()) + "の買い目"}</th></tr>`;
  for (const x of shown) {
    const r0 = state.races.get(x.rid)[0], c = confLevel(state.races.get(x.rid));
    const changed = x.pick !== x.autoBuy;
    // 見込みの回収率は判定に使った値(判定と同じ数字)。配分額で区分が変わって値が違えば、その値も小さく出す
    const est = x.est0 ?? (x.amount ? x.honestUsed : x.est);
    const after = x.amount && x.honestUsed != null && est != null && Math.abs(x.honestUsed - est) >= 0.05 ?
      `<div class="dim" title="配分額 ${x.amount.toLocaleString()}円 の区分(${esc(x.opt?.name || "")})のおすすめの確かめの回収率。判定には使わない">配分後 ${fix(x.honestUsed)}%</div>` : "";
    const tk = x.tickets?.filter(y => y.amount) || [];
    const sep = y => y.kind === "馬単" || y.kind === "3連単" ? "→" : "-";
    const list = tk.length ? `<div><b>${esc(x.opt.how)}</b> <span class="muted">(${esc(x.opt.name)}・${fundMode() !== "roi" ? `${esc(fundLabel(x.opt))}・的中 ${x.opt.hit != null ? fix(x.opt.hit) + "%" : "-"}・` : ""}${tk.length}点)</span></div>` +
      `<div class="fund-tickets">${tk.map(y => `${esc(y.kind)} <b>${esc(y.t.join(sep(y)))}</b> ${y.amount.toLocaleString()}円`).join("<br>")}</div>` +
      (x.oddsNote || /枠順/.test(x.stage) ? `<div class="fund-odds">${x.oddsNote ? `<span class="chip gray" title="期待値に使ったオッズの発表・取得の日時">オッズ: ${esc(x.oddsNote)}</span>` : ""}` +
        (/枠順/.test(x.stage) ? ` <span class="chip warn" title="馬体重が出る前(枠順確定の版)の予想で作った推奨買い目。馬体重が入ると作り直す">${esc(x.stage)}</span>` : "") + `</div>` : "") :
      x.pending && x.amount ? `<div class="muted">${x.opt ? `<b>${esc(x.opt.how)}</b>(${esc(x.opt.name)})の予定。` : ""}推奨買い目は発走55分前ごろに出る</div>` : "";
    h += `<tr class="${x.pick ? "" : "dim"}"><td class="f-ck"><input type="checkbox" class="fundPick" data-rid="${x.rid}" ${x.pick ? "checked" : ""}></td>` +
      `<td class="f-race">${raceLink(x.rid)}</td><td class="f-i" data-l="発走">${hhmm(r0.hasso_time)}</td><td class="n f-i" data-l="自信" title="10段階で ${c?.lv ?? "-"}">${c?.score ?? "-"}</td><td class="n f-i" data-l="混戦">${esc(r0["混戦の段階"] || "-")}</td>` +
      `<td class="f-auto"><span class="chip ${x.wait ? "warn" : x.autoBuy ? "up" : "gray"}" title="${esc(x.autoWhy)}">${x.wait ? "判定待ち" : x.autoBuy ? "購入推奨" : "見送り推奨"}</span>${x.pending && !x.wait ? ` <span class="chip gray" title="${esc(x.autoWhy)}">仮</span>` : ""}${changed ? ` <span class="chip warn">手で${x.pick ? "✔" : "外した"}</span>` : ""}</td>` +
      `<td class="n f-i" data-l="見込み"><span class="${est >= 100 ? "hi" : est < FUND_RULE.skip ? "down" : ""}" title="${esc(x.tier0 ? `判定に使った値(${x.tier0}のおすすめ)` : "")}">${est != null ? fix(est) + "%" : "-"}</span>${after}</td>` +
      `<td class="n f-i" data-l="期待値">${x.ev != null ? `<span class="${x.ev >= 100 ? "hi" : ""}">${fix(x.ev)}%</span>${x.evPart ? `<span class="dim" title="オッズのある買い目だけ">*</span>` : ""}` : `<span class="dim">-</span>`}</td>` +
      `<td class="n f-amt">${x.amount ? `<b>${x.spent.toLocaleString()}円</b>${x.pending ? `<div class="dim">取っておく</div>` : ""}${x.spent < x.amount ? `<div class="dim" title="100円単位・点数に合わせた余り">配分 ${x.amount.toLocaleString()}円</div>` : ""}` : x.pick && P.budget ? `<span class="dim">0円</span>` : `<span class="dim">-</span>`}` +
        fundCopyCell(x) + `</td>` +
      `<td class="n f-i" data-l="払戻">${fundPayCell(x, tk)}</td>` +
      `<td class="f-tk">${list}</td></tr>`;
  }
  h += `</table></div>`;
  if (P.budget && P.spent) h += `<div class="calc" style="margin-top:8px"><button id="fundSend" title="配分案の買い目を、下の「購入した馬券」に送る(実際の購入とはつながっていない)">↓ 配分案の買い目を購入した馬券に送る</button></div>`;
  h += `<div class="note"><b>決め方(暫定)</b>: 対象は発走前のレース(発走時刻を過ぎた・結果の出たレースは除く。発走時刻はこのパソコン・スマホの時計で見る)。` +
    `①予算 ÷ レース数 の額が入る予算の区分の推奨買い目「おすすめ」の、4年で選んで残りの1年で確かめた回収率(確かめの回収率)を<b>見込みの回収率</b>とする` +
    `(自信の段階・混戦の段階の組ごとに検証期間 2019〜2023年で出したもの。自信・混戦はこの値を通して効く)。` +
    `表の「見込みの回収率」はこの判定に使った値。見送りを除いて配り直すと1レースの額が上がって区分が変わることがあり、そのときは配分額の区分の値を「配分後」として小さく出す(判定には使わない)。` +
    `②見込みの回収率が ${FUND_RULE.skip}% 未満なら見送り推奨(✔ なし)、それ以外は購入推奨(✔)。予想 CSV に「見送り」の列があればそれを使う。` +
    `推奨買い目は各レースの発走55分前ごろに出るので、まだのレースは同じ日・同じ自信と混戦の組の別のレースの値で仮に判定し(「仮」)、それも無ければ「判定待ち」で ✔ を付けて配分額を取っておく(推奨買い目が出たら判定し直す)。` +
    (FUND_RULE.power ? `③ ✔ のレースに、重み(見込みの回収率 − ${FUND_RULE.base * 100}%)${FUND_RULE.power === 1 ? "" : `の${FUND_RULE.power}乗`}に比例して100円単位で配る${FUND_RULE.cap ? `(1レースの上限は予算の ${FUND_RULE.cap * 100}%)` : ""}。` :
      `③ ✔ のレースに均等に100円単位で配る(割り切れない分は発走の早いレースから100円ずつ。予算がレース数 × 100円 に足りなければ、発走の早いレースから100円ずつ)。` +
      `検証期間では、見込みの回収率(自信・混戦の組ごとの値)で重みを付けても均等より良くならなかった(見込みの回収率の高いレースが、別の年で実際に良いとは限らなかった)ので均等にしている。`) +
    `④レースごとに、配分額が入る区分のおすすめを買う(点数 × 100円 が配分額より多ければ、収まる下の区分)。` +
    `<b>的中重視(ワイド抜き)</b>にすると、①④で使う買い方を、その区分の券種別のうち 馬連・馬単・3連複・枠連 で点数が収まり過去の的中率が一番高いものにする(無ければおすすめ)。` +
    `<b>ワイド</b>にすると、その区分の券種別のワイドにする(無ければおすすめ)。` +
    `<b>超的中重視</b>にすると、その区分の候補(おすすめ・組み合わせ・券種別)のうち点数が収まり過去の的中率が一番高いものにする(複勝・ワイドが多くなる。見込みの回収率もその買い方の確かめの回収率。検証期間での1日ごとの確かめはまだ)。` +
    `1点の金額は均等で、余りは確率の高い買い目から100円ずつ。` +
    `✔ は手で付け外しでき、そのときは ✔ のレースだけで配り直す(✔ と予算はこのブラウザに日付ごとに覚えておく)。` +
    `<b>期待値</b>は、オッズのある買い目の 確率 × オッズ の配分額での平均(参考。配分には使わない)。オッズは変わるので、使ったオッズの日時を買い目の下に出す(「オッズ: … 時点・… 取得」)。` +
    `検証期間での確かめ(1日ずつ配ったときの回収率・最大の連敗など)は docs/fund-plan.md。過去の回収率は100%を下回るものが多く、儲かることを約束するものではない。</div></div>`;
  return h;
}
function fundPayCell(x, tk) {
  // 払戻の列(2026-11-22 ユーザーの指示)。結果(払戻の CSV)が出たレースだけ
  if (!state.pays.has(x.rid)) return `<span class="dim">${tk.length ? "結果待ち" : "-"}</span>`;
  if (!tk.length) return `<span class="dim">-</span>`;
  const cost = tk.reduce((a, y) => a + y.amount, 0);
  const back = tk.reduce((a, y) => a + (hitPayout(x.rid, y.kind, y.t) || 0) * y.amount / 100, 0);
  return back ? `<b class="${back >= cost ? "hi" : ""}">${Math.round(back).toLocaleString()}円</b><div class="dim">収支 ${back - cost >= 0 ? "+" : "−"}${Math.abs(Math.round(back - cost)).toLocaleString()}円</div>` :
    `<span class="dim">はずれ</span>`;
}
function fundCopyCell(x) {
  // 個別レースページの推奨買い目の「手入力」へ送るボタンと、送ってある金額
  const sent = raceBudgetOf(x.rid);
  const chip = sent ? `<div><span class="chip ${sent === x.amount ? "up" : "warn"}" title="個別レースページの推奨買い目の「手入力」に入っている、このレースだけの金額${sent === x.amount ? "" : "(今の配分額と違う)"}">手入力 ${sent.toLocaleString()}円</span></div>` : "";
  const btn = x.amount && sent !== x.amount ? `<div><button class="fundCopy" data-rid="${x.rid}" data-a="${x.amount}" title="この配分額を、個別レースページの推奨買い目の「手入力」に入れる(このレースだけ)">→ 手入力へ</button></div>` : "";
  return chip + btn;
}
function fundHelpHTML() {
  return `<h3>使い方</h3><ol>` +
    `<li>日別ページの「この日の予算」に、その日に使う金額を入れる(Enter か欄の外を押すと計算する)。</li>` +
    `<li>その時点で発走前のレースだけを対象に、購入推奨のレースに ✔ が付き、✔ のレースに予算が配られる。見送り推奨のレースは ✔ なし。</li>` +
    `<li>✔ を手で付け外しすると、✔ のレースだけで配り直す(選ぶのは手で、配分額の計算は自動)。「✔ を自動の選定に戻す」で最初の状態に戻る。</li>` +
    `<li>レースが発走したり結果が出たりすると、そのレースは外れ、残りのレースで配り直す(予算はそのまま。使った分を引きたいときは予算を入れ直す)。</li>` +
    `<li>推奨買い目は各レースの発走55分前ごろに出る。まだのレースは、同じ日の同じ自信・混戦の組の別のレースの値で仮に判定し(「仮」)、` +
    `それも無ければ「判定待ち」で ✔ を付けて配分額だけ取っておく。推奨買い目が出ると判定し直すので、✔ と配分額が変わることがある。</li>` +
    `<li>各レースの「おすすめの買い目」は、配分額が入る予算の区分の推奨買い目「おすすめ」を、1点の金額をそろえて配ったもの。レース名を押すと個別レースページへ。</li>` +
    `<li>「対象の場」で ✔ を外した場は、資金配分の対象から外す(その場のレースには配らず、残りの場で予算を配り直す)。「全場選択」で全部の場に戻る。</li>` +
    `<li>「場別に表示」に ✔ を入れると、一覧を競馬場ごとのタブで見られる(タブに場ごとの ✔ の数と配分額)。上のサマリと配分はその日の全部の場のまま。</li>` +
    `<li>「→ 手入力へ」(レースごと)か「→ ✔ のレースの配分額を全部、各レースの手入力に送る」で、配分額を個別レースページの推奨買い目の「手入力」に入れられる。` +
    `そのレースだけの金額で、共通の手入力より先に使い、配分(均等・確率に比例 など)は個別レースページの選び方で計算する。個別レースページの「共通に戻す」か、ここの「送った手入力を消す」で消せる。</li>` +
    `<li>「↓ 配分案の買い目を購入した馬券に送る」で、配分案の買い目を下の「購入した馬券」に入れられる(実際の購入とはつながっていない)。</li></ol>` +
    `<p>✔ と予算はこのブラウザに日付ごとに覚えておく。前の日付を振り返るときは「発走済み・結果の出たレースも入れる」に ✔。</p>` +
    `<h3>決め方と、検証期間での確かめ</h3>` +
    `<p>見込みの回収率は、推奨買い目の「確かめの回収率」(自信の段階・混戦の段階の組ごとに、4年で選んで残りの1年で確かめた回収率)。` +
    `これが ${FUND_RULE.skip}% 未満のレースを見送り推奨にし、✔ のレースには均等に配る。</p>` +
    `<p>検証期間(2019〜2023年の540日)で、1日ずつ朝に配ったとして確かめた(配分の決め方そのものも、その年を抜いた4年だけで作った表で)。` +
    `1日の予算 1万円で、均等に配る 86.1%・今の見送り推奨+均等 86.4%・見込みの回収率で重みを付ける 86.7%。3千円では 84.7%・87.3%・85.0%、3万円では 88.3%・86.2%・85.3%。` +
    `差は年ごとのぶれ(±4ポイントほど)より小さく、重みを強くしたり見送りの基準を 85%・90% に上げたりすると悪くなった。` +
    `見込みの回収率の高いレースが別の年で実際に良いとは限らなかったので、重みは付けず均等にしている。</p>` +
    `<p><b>どの決め方でも回収率は100%を下回る</b>(今の決め方で1万円/日なら、5年で約74万円の負け・最大の連敗は15日で約6.3万円)。` +
    `儲かることを約束するものではなく、使う金額を決めて広く薄く買うための目安。くわしくは docs/fund-plan.md。</p>` +
    `<p class="muted">期待値の列は、オッズのある買い目の 確率 × オッズ の平均(参考。配分には使わない。検証期間の当時のオッズでは確かめていない)。</p>`;
}
function bindFund(date) {
  const f = fundOf(date), y = () => window.scrollY;
  const again = () => { const s = y(); renderDayPage(date); window.scrollTo(0, s); };
  const inp = document.getElementById("fundBudget");
  if (inp) inp.onchange = () => { const v = roundYen(inp.value); f.budget = v || null; saveFund(date); again(); };
  const past = document.getElementById("fundPast");
  if (past) past.onchange = () => { f.past = past.checked; saveFund(date); again(); };
  document.querySelectorAll("input.fundJyoOn").forEach(c => c.onchange = () => {
    const j = c.dataset.j;
    f.offJyo = c.checked ? f.offJyo.filter(x => x !== j) : [...new Set([...f.offJyo, j])];
    saveFund(date); again();
  });
  const jyoAll = document.getElementById("fundJyoAll");
  if (jyoAll) jyoAll.onclick = () => { f.offJyo = []; saveFund(date); again(); };
  const byJyo = document.getElementById("fundByJyo");
  if (byJyo) byJyo.onchange = () => { f.byJyo = byJyo.checked; saveFund(date); again(); };
  document.querySelectorAll(".fundMode button").forEach(b => b.onclick = () => { setFundMode(b.dataset.m); again(); });
  document.querySelectorAll(".fundDiff button").forEach(b => b.onclick = () => { setDiff("diffFund", b.dataset.v === "1"); again(); });
  document.querySelectorAll(".fundJyo button").forEach(b => b.onclick = () => { f.jyo = b.dataset.j; saveFund(date); again(); });
  const help = document.getElementById("fundHelp");
  if (help) help.onclick = e => { e.stopPropagation(); openHelp("keiba-viewer-fund", "資金配分案の説明", "資金配分案（仮）の使い方と決め方", fundHelpHTML()); };
  const auto = document.getElementById("fundAuto");
  if (auto) auto.onclick = () => { f.picks = {}; saveFund(date); again(); };
  document.querySelectorAll("input.fundPick").forEach(c => c.onchange = () => { f.picks[c.dataset.rid] = c.checked; saveFund(date); again(); });
  document.querySelectorAll("button.fundCopy").forEach(b => b.onclick = () => { saveRaceBudget(b.dataset.rid, +b.dataset.a); again(); });
  const copyAll = document.getElementById("fundCopyAll");
  if (copyAll) copyAll.onclick = () => {
    const P = fundPlan(date);
    let n = 0;
    for (const x of P.ok) {
      if (x.pick && x.amount) { saveRaceBudget(x.rid, x.amount); n++; }
      else if (raceBudgetOf(x.rid)) saveRaceBudget(x.rid, null);
    }
    // 対象から外した場のレースに前に送った金額も消す(発走前のものだけ)
    P.rids.filter(r => P.f.offJyo.includes(r.slice(8, 10)) && (P.f.past || !raceStarted(r)) && raceBudgetOf(r)).forEach(r => saveRaceBudget(r, null));
    alert(`${n}レースの配分額を、各レースの手入力に送りました。`);
    again();
  };
  const copyClear = document.getElementById("fundCopyClear");
  if (copyClear) copyClear.onclick = () => {
    if (!confirm("この日の各レースの「このレースだけの手入力」を消します。よろしいですか?")) return;
    sortedRaces().filter(r => r.slice(0, 8) === date).forEach(r => saveRaceBudget(r, null));
    again();
  };
  const send = document.getElementById("fundSend");
  if (send) send.onclick = () => {
    const P = fundPlan(date);
    let n = 0;
    for (const x of P.ok) if (x.tickets?.length) {
      const valid = x.tickets.filter(t => t.amount > 0 && ticketEligible(state.races.get(x.rid), t));
      sendToBought(x.rid, valid); n += valid.length;
    }
    alert(`${n}点を「購入した馬券」に送りました。`);
    again();
  };
}

function render(toTop = true) {
  const y = window.scrollY;
  renderNav();
  document.body.classList.toggle("day-page-active", !!state.dayPage);
  if (state.dayPage) renderDayPage(state.dayPage);
  else if (state.races.has(state.current)) renderRace(state.current);
  renderResult(state.dayPage ? null : state.current);
  updateRaceStatus();
  window.scrollTo(0, toTop ? 0 : y);
  try {
    sessionStorage.setItem("keiba-viewer:current", state.current ?? "");
    sessionStorage.setItem("keiba-viewer:dayPage", state.dayPage ?? "");
  } catch (e) {}
}

// ---------- フォルダを見張る(File System Access API。Chrome・Edge) ----------
async function readDir(dir, path = "", depth = 0) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind === "file" && name.toLowerCase().endsWith(".csv")) out.push([await h.getFile(), path + name]);
    else if (h.kind === "directory" && depth < 2 && wantDir(name)) out.push(...await readDir(h, path + name + "/", depth + 1));
  }
  return out;
}
function startWatch(dir) {
  state.dir = dir;
  const tick = async () => {
    try {
      await loadFiles(await readDir(state.dir), true);
      document.getElementById("status").textContent += `・${new Date().toTimeString().slice(0, 5)} に読み直し`;
    } catch (e) { document.getElementById("status").textContent = "フォルダを読めませんでした: " + e.message; }
  };
  clearInterval(state.watchTimer);
  state.watchTimer = setInterval(tick, 60000);
  document.getElementById("watch").textContent = "見張り中(1分ごと)";
  return tick();
}
async function watchDir() {
  let dir;
  try { dir = await window.showDirectoryPicker(); } catch (e) { return; }   // 選ぶのをやめた
  state.dir = dir; save();
  await startWatch(dir);
}

// ---------- 読み込んだファイル・フォルダを覚えておき、再読み込みのあとに読み直す(IndexedDB) ----------
function idb(mode, fn) {
  return new Promise((res, rej) => {
    const o = indexedDB.open("keiba-viewer", 1);
    o.onupgradeneeded = () => o.result.createObjectStore("kv");
    o.onerror = () => rej(o.error);
    o.onsuccess = () => {
      const tx = o.result.transaction("kv", mode), r = fn(tx.objectStore("kv"));
      tx.oncomplete = () => { o.result.close(); res(r.result); };
      tx.onerror = () => rej(tx.error);
    };
  });
}
// 落とした・選んだものは今までの分に足す(読み込みが足していくのに合わせる)。見張るフォルダ(state.dir)は別に覚える
function save() {
  idb("readwrite", st => st.put({ list: state.sources || [], watch: state.dir || null }, "sources")).catch(() => {});
}
function remember(handles) { state.sources = [...(state.sources || []), ...handles]; save(); }
function forget() {
  state.sources = []; state.dir = null; clearInterval(state.watchTimer);
  if (window.showDirectoryPicker) document.getElementById("watch").textContent = "フォルダを見張る";
  idb("readwrite", st => st.delete("sources")).catch(() => {});
}
async function readHandles(list) {
  const out = [];
  for (const h of list) {
    if (h.kind === "file") out.push([await h.getFile(), h.name]);
    else out.push(...await readDir(h, h.name + "/"));
  }
  return out;
}
async function reopen() {
  if (state.sources.length) await loadFiles(await readHandles(state.sources));
  if (state.dir) await startWatch(state.dir);
}
async function restore() {
  if (!window.showDirectoryPicker || !window.indexedDB) return;
  let saved = null;
  try { saved = await idb("readonly", st => st.get("sources")); } catch (e) { return; }
  if (!saved || (!saved.list?.length && !saved.watch)) return;
  state.sources = saved.list || []; state.dir = saved.watch || null;
  const all = [...state.sources, ...(state.dir ? [state.dir] : [])];
  const perm = await Promise.all(all.map(h => h.queryPermission({ mode: "read" }).catch(() => "denied")));
  if (perm.every(x => x === "granted")) {
    try { await reopen(); return; } catch (e) {}
  }
  // 許可がいる(ブラウザはボタンを押したときにしか聞けない)
  const names = all.map(h => h.name).join("・");
  const box = document.getElementById("restore");
  box.hidden = false;
  box.querySelector("button").textContent = `前回の CSV を読み直す(${names}${state.dir ? "、見張りも続ける" : ""})`;
  box.querySelector("button").onclick = async () => {
    for (const h of all) {
      if (await h.requestPermission({ mode: "read" }).catch(() => "denied") !== "granted") {
        document.getElementById("status").textContent = "読む許可がもらえませんでした。もう一度 CSV を選んでください";
        return;
      }
    }
    box.hidden = true;
    try { await reopen(); } catch (e) { document.getElementById("status").textContent = "前回の CSV を読めませんでした: " + e.message; }
  };
}

// ---------- 指標の説明(分類ごとの項目は explain.CATEGORY と同じ。tests/test_ml_explain.py で確かめる) ----------
const CAT_ABOUT = {
  "能力": "その馬の地力。タイム指数・近走の着順やタイム差・相手のレベル・賞金など、これまでの走りの強さ",
  "適性": "今回の条件(距離・芝ダ・競馬場・コース・馬場状態・天候)に合うか。過去の同じ条件の成績と血統から見る。馬場適性(道悪・洋芝・クッション値など)もここ",
  "調子": "今の状態。休み明けの日数・叩き2戦目・調教の内容・馬体重とその増減・斤量の変化",
  "人": "騎手・調教師・馬主や生産者の成績と、その組み合わせ(騎手×調教師、騎手×その馬)、乗り替わり・見習騎手の減量",
  "展開": "レースの流れと位置取り。脚質・テンの速さ・今回の展開予想・枠と馬番、当日や開催中の馬場の傾向(内外・前後の有利不利)",
};
const CONF_ABOUT = {
  "能力": "通算の出走数: 6走以上で高、2〜5走で中、それ未満は低",
  "適性": "今回と同じ距離帯・同じ芝ダの出走数の少ない方: 4走以上で高、1〜3走で中",
  "調子": "前走から120日以内か・近2週の調教があるか: 両方で高、片方で中",
  "人": "騎手の近1年の騎乗数: 100以上で高、20以上で中",
  "展開": "通算3走以上で脚質が分かれば高、1走以上で中",
  "総合": "能力・適性・調子の確度のうち一番低いもの",
};
function guideHTML() {
  const defs = JSON.parse(document.getElementById("catDefs").textContent);
  const rows = Object.entries(defs).map(([c, items]) =>
    `<tr><th>${esc(c)}</th><td><p>${esc(CAT_ABOUT[c] || "")}</p><div class="items">${items.map(i => `<span>${esc(i)}</span>`).join("")}</div>` +
    `<p class="muted">確度: ${esc(CONF_ABOUT[c] || "")}</p></td></tr>`).join("");
  return `
    <h3>何を数えているか</h3>
    <p>説明用の LightGBM が、各項目で「その馬の勝つ見込みをどれだけ上げ下げしたか」を出し、それを下の5つの分類ごとに足したもの。
    <b>総合</b>は5つ全部(と、どこにも入らない少しの項目)の合計。予想の勝率そのものは予想に使うモデル(深層学習5本と LightGBM 1本。2026/11/17 から2023年末までのデータで学習した版。LightGBM は 2026/11/21 から、2〜4着にも点を付けて学び、過去5走を1走ずつ並べた項目も使う版)の平均で、点はその理由の目安。</p>
    <table><tr><th>総合</th><td><p>下の5つを全部足したもの</p><p class="muted">確度: ${esc(CONF_ABOUT["総合"])}</p></td></tr>${rows}</table>
    <h3>相対値と絶対値</h3>
    <table>
      <tr><th>相対値</th><td>このレースの中での比べ。点はレースの1位が100・最下位が0。星はレース内の順位で5段階(上位から5〜1)。</td></tr>
      <tr><th>絶対値</th><td>検証期間(2019〜2023年)の出走馬(3万頭の抜き出し)の中での位置。点は0〜100(80なら上位20%)。星は20点ごとに1〜5。
        弱いメンバーのレースで1位でも、絶対値は低いことがある。</td></tr>
      <tr><th>確度</th><td>その評価の元になったデータの量(高・中・低)。低いものは薄く表示する。分類ごとの決め方は上の表。</td></tr>
    </table>`;
}
// 別ウインドウで開く(ポップアップを止められたときは、このページの上に出す)
const GUIDE_CSS = `
:root { --bg: #f6f7f9; --panel: #fff; --text: #1d2330; --muted: #6b7385; --line: #e3e6ec; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #14171d; --panel: #1c2028; --text: #e4e7ee; --muted: #9098a9; --line: #2c323d; } }
:root[data-theme="dark"] { --bg: #14171d; --panel: #1c2028; --text: #e4e7ee; --muted: #9098a9; --line: #2c323d; }
body { margin: 0; padding: 8px 16px 24px; background: var(--panel); color: var(--text); font: 13px/1.6 system-ui, sans-serif; }
h2 { font-size: 16px; margin: 8px 0; } h3 { font-size: 14px; margin: 16px 0 4px; } p { margin: 4px 0; } .muted { color: var(--muted); }
table { border-collapse: collapse; width: 100%; margin: 4px 0; }
td, th { border-top: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: normal; white-space: nowrap; }
.items { display: flex; flex-wrap: wrap; gap: 4px; } .items span { background: var(--bg); border-radius: 999px; padding: 0 8px; font-size: 12px; }`;
function openHelp(name, title, heading, body) {
  // SPでは同じ画面内のモーダル、PCでは従来どおり別ウインドウで表示する。
  if (window.matchMedia("(max-width: 760px)").matches) {
    document.getElementById("guideTitle").textContent = heading;
    document.getElementById("guideBody").innerHTML = body;
    const dialog = document.getElementById("guide");
    if (!dialog.open) dialog.showModal();
    return;
  }
  const w = window.open("", name, "width=900,height=820,resizable=yes,scrollbars=yes");
  if (!w) {
    document.getElementById("guideTitle").textContent = heading;
    document.getElementById("guideBody").innerHTML = body;
    document.getElementById("guide").showModal();
    return;
  }
  const theme = document.documentElement.dataset.theme;
  w.document.open();
  w.document.write(`<!doctype html><html lang="ja"${theme ? ` data-theme="${theme}"` : ""}><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${GUIDE_CSS}</style></head>` +
    `<body><h2>${heading}</h2>${body}</body></html>`);
  w.document.close();
  w.focus();
}
document.getElementById("guideBtn").onclick = () =>
  openHelp("keiba-viewer-guide", "指標の説明", "指標の説明(総合・能力・適性・調子・人・展開)", guideHTML());

// 馬場の欄の各項目の説明(馬場の欄の右上の ? で開く)
const BABA_HELP = [
  ["開催の並び", [
    ["仮柵", "芝のコース区分(A〜E)。内ラチ沿いに仮柵を立てて、走る場所を外へずらしている位置。A がいちばん内で、B・C… と外へ。",
     "仮柵を外へ動かすと、それまで傷んでいた内側を使わなくなるので、内の馬場がきれいになって内が有利に戻りやすい。"],
    ["開催日目", "その回(第○回)の開催の何日目か(JRA の開催日目)。", "日目が進むほど芝が傷み、内が荒れて外・差しが有利になりやすい。"],
    ["連続開催の何日目・何週目", "同じ競馬場で間が10日以内の開催をひとつながりの「連続開催」とみなし、その何日目(開催日の数)・何週目(初日からの日数 ÷ 7 + 1)か。" +
      "東京の第4回と第5回のように、回が変わっても続けて開催していれば数え続ける。", "開催日目より、芝が休まず使われ続けた長さに近い。後半ほど内が荒れやすい。"],
    ["仮柵を替えて何日目", "芝の仮柵(コース区分)が今の位置になってから何日目の開催日か。芝のレースだけ。",
      "小さいほど、内側の傷んでいない部分を走れるので内・前が有利になりやすい。"],
  ]],
  ["馬場傾向(数字の見方)", [
    ["数字の作り方", "1〜3着の馬の位置の平均 − 出走した全馬の位置の平均。内外は「馬番 ÷ 頭数」(0 = いちばん内、1 = いちばん外)、" +
      "前後は「最初のコーナーの順位 ÷ 頭数」(0 = 先頭、1 = 最後方)。", "マイナスなら内・前の馬が上位に来ていた(内・前が有利)、プラスなら外・後ろが有利。"],
    ["「いつも」とは", "検証期間(2019〜2023年)の、同じ競馬場・同じ芝ダのレースの馬場傾向の値(東京の芝なら東京の芝の全レース)。" +
      "札のかっこ内の「東京芝のふだん −0.08」がその平均。基準のレースが200に満たない競馬場・芝ダでは、競馬場を問わない同じ芝ダの全レースにする。",
      "競馬場ごとに比べるので、もともと前が残りやすいコースでも、ふだん並みなら「いつも並み」になる。" +
      "2026-11-13 までに作った予想は、競馬場を問わない同じ芝ダの全レースと比べている(そのころの札は「芝のふだん」と出る)。"],
    ["目安(札)", "数字を「いつも」の値の中で並べた位置で5段階にしたもの。20・40・60・80% の点で区切る" +
      "(「いつもより内有利」「いつもよりやや内有利」「いつも並み」「いつもよりやや外有利」「いつもより外有利」。前後も同じ)。" +
      "かっこ内の「前有利の方から上位30%」は、いつもの値のうち、それより前有利だったレースの割合。",
      "「いつもより外有利」なら、そのコースのふだんより外の馬が来ている。"],
    ["確度", "その数字の元になったデータの量。高・中・低(上にのせると根拠)。", "低いものは、少ないレースから出した値なので当てにしすぎない。"],
  ]],
  ["馬場傾向の各項目", [
    ["この開催の内外・前後", "同じ連続開催・同じ芝ダの、前日までの開催日の馬場傾向の平均(連続開催の初日は無い)。",
      "今の開催で内・前が残っているか、外・差しが来ているか。確度は前日までの開催日の数(3日以上で高、1〜2日で中)。"],
    ["過去の同じ週の前後", "前日までの3年の、同じ競馬場・同じ芝ダ・連続開催の同じ週(何週目)の馬場傾向(前後)の平均。",
      "例年この時期はどうなりやすいか(開催が進むと差しが届きやすい、など)。確度は元にした開催日の数(6日以上で高、2日以上で中)。"],
    ["前の開催日の内外・前後", "同じ競馬場・同じ芝ダの、前の開催日(7日以内)の全レースの馬場傾向。",
      "直近の傾向。前日の傾向が翌日も続くことが多い(雨や仮柵の移動で変わることもある)。確度は前の開催日のレース数(5以上で高、3以上で中)。"],
  ]],
];
function babaHelpHTML() {
  return BABA_HELP.map(([group, items]) => `<h3>${esc(group)}</h3><table>` +
    items.map(([name, what, read]) => `<tr><th>${esc(name)}</th><td><p>${esc(what)}</p><p class="muted">読み方: ${esc(read)}</p></td></tr>`).join("") +
    `</table>`).join("") +
    `<p class="muted">どの数字も前日までの結果と出馬表から作っていて、そのレースの結果は使っていない。当日の馬場傾向(その日の前のレース)は、` +
    `予想の J2 に入っている(当日の予想で、レースのたびに計算し直す)。</p>`;
}
function openBabaHelp(e) {
  e.stopPropagation();   // 見出しを押したときのたたむ動きをさせない
  openHelp("keiba-viewer-baba", "馬場傾向予想の項目の説明", "馬場傾向予想の項目の説明", babaHelpHTML());
}
document.getElementById("guideClose").onclick = () => document.getElementById("guide").close();
document.getElementById("updateTimingOpen").onclick = () => document.getElementById("updateTimingDialog").showModal();
document.getElementById("updateTimingClose").onclick = () => document.getElementById("updateTimingDialog").close();
document.getElementById("updateTimingDialog").addEventListener("click", e => {
  if (e.target.id === "updateTimingDialog") e.target.close();
});
document.getElementById("guide").addEventListener("click", e => { if (e.target.id === "guide") e.target.close(); });

// ---------- 読み込みの操作 ----------
let dragDepth = 0;
addEventListener("dragenter", e => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add("dragging"); });
addEventListener("dragleave", e => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", async e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
  // 覚えておけるハンドル(Chrome・Edge)は、await の前にまとめて受け取る(あとでは取れない)
  const handles = [...(e.dataTransfer.items || [])].filter(i => i.kind === "file" && i.getAsFileSystemHandle).map(i => i.getAsFileSystemHandle());
  const items = [...(e.dataTransfer.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (handles.length) {
    const hs = (await Promise.all(handles.map(h => h.catch(() => null)))).filter(Boolean);
    if (hs.length) { remember(hs); await loadFiles(await readHandles(hs)); return; }
  }
  if (items.length) { const out = []; for (const en of items) await walk(en, out); await loadFiles(out); }
  else await loadFiles([...e.dataTransfer.files]);
});
// 共有向けビューアでは、ローカルのファイル・フォルダ選択機能を表示しない。
// 結果の欄の開閉(このブラウザに覚えておく)
try { if (localStorage.getItem("keiba-viewer:result-closed") === "1") document.body.classList.add("result-closed"); } catch (e) {}
document.getElementById("resOpen").onclick = () => {
  // PCではヘッダーの「結果」ボタンで表示・非表示を切り替える。SPでは従来どおり開く。
  if (window.matchMedia("(max-width: 760px)").matches) {
    document.body.classList.remove("result-closed");
  } else {
    document.body.classList.toggle("result-closed");
  }
  try {
    localStorage.setItem("keiba-viewer:result-closed", document.body.classList.contains("result-closed") ? "1" : "0");
  } catch (e) {}
};
// 携帯の幅と PC の幅を行き来したら一覧を描き直す(携帯は競馬場がタブ、PC は見出し)
try { window.matchMedia("(max-width: 760px)").addEventListener("change", () => { if (state.races && state.races.size) renderNav(); }); } catch (e) {}
// レース一覧の開閉(このブラウザに覚えておく)
try { if (localStorage.getItem("keiba-viewer:nav-closed") === "1") document.body.classList.add("nav-closed"); } catch (e) {}
// 携帯: ヘッダの表示中のレース(青い欄)を押すと、レース一覧を開く・たたむ(2026-11-16 ユーザーの指示)
document.getElementById("status").addEventListener("click", () => {
  if (!window.matchMedia("(max-width: 760px)").matches || !state.races.size) return;
  document.getElementById("navToggle").click();
  if (!document.body.classList.contains("mobile-nav-collapsed")) document.getElementById("nav").scrollIntoView({ block: "start" });
});
document.getElementById("navToggle").onclick = () => {
  if (window.matchMedia("(max-width: 760px)").matches) {
    document.body.classList.toggle("mobile-nav-collapsed");
    renderNav();
    return;
  }
  const closed = document.body.classList.toggle("nav-closed");
  try { localStorage.setItem("keiba-viewer:nav-closed", closed ? "1" : "0"); } catch (e) {}
};
// 共有向けビューアでは、手動クリア機能を表示しない。
async function initializeStartup() {
  try {
    const loadedFromDrive = await consumeDriveTransfer();
    if (!loadedFromDrive) await restore();
  } catch (e) {
    document.getElementById("status").textContent = "Driveから受け取ったCSVを読み込めませんでした: " + e.message;
    await restore();
  }
}
initializeStartup().finally(checkDriveUpdate);
const driveUpdateDialog = document.getElementById("driveUpdateDialog");
const driveUpdateFrame = document.getElementById("driveUpdateFrame");
const driveAskDialog = document.getElementById("driveAskDialog");
const driveDoneDialog = document.getElementById("driveDoneDialog");
const driveToastEl = document.getElementById("driveToast");
let driveBgFrame = null;     // 画面に出さない確認・取得用のフレーム
let driveAskMode = false;    // ポップアップの「はい」から取得している
let driveAsked = null;       // ポップアップで聞いている更新
let driveToastTimer = null;

function showDriveToast(text, {button = "", onButton = null, hideAfter = 0} = {}) {
  clearTimeout(driveToastTimer);
  driveToastEl.replaceChildren(document.createTextNode(text));
  if (button) {
    const action = document.createElement("button");
    action.textContent = button;
    action.onclick = onButton;
    driveToastEl.append(action);
  }
  driveToastEl.hidden = false;
  if (hideAfter) driveToastTimer = setTimeout(() => { driveToastEl.hidden = true; }, hideAfter);
}
function stopBackgroundFrame() {
  driveBgFrame?.remove();
  driveBgFrame = null;
}
function startBackgroundFrame(params) {
  stopBackgroundFrame();
  params.set("embedded", "1");
  driveBgFrame = document.createElement("iframe");
  driveBgFrame.hidden = true;
  driveBgFrame.title = "データの更新の確認";
  driveBgFrame.src = "./index.html?" + params.toString();
  document.body.append(driveBgFrame);
}
// リロードのたびに、裏で更新の有無を確かめる。開催日は、開いている間も数分おきと、ほかのアプリから戻ったときに確かめる
const DRIVE_CHECK_EVERY = 5 * 60000;     // 開催日に、開いている間に確かめる間隔
const DRIVE_CHECK_NEAR_POST = 60000;     // 発走20分前〜発走のレースがあるあいだの間隔(2026-11-21)
const DRIVE_CHECK_ON_RETURN = 60000;     // ほかのアプリから戻ったとき、前の確認からこれだけ経っていれば確かめる
let driveLastCheck = 0;                  // 最後に確認か取得を始めた時刻
let driveCheckPeriodic = false;          // いまの確認が、リロード以外(数分おき・戻ったとき)のものか
let driveNeedsLogin = false;             // ログインが切れている(再ログインするまで、数分おきの確認をしない)
function checkDriveUpdate(periodic = false) {
  driveLastCheck = Date.now();
  driveCheckPeriodic = periodic;
  startBackgroundFrame(new URLSearchParams({check:"1"}));
}
function jstTodayYmd() {
  return new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Tokyo"}).format(new Date()).replaceAll("-", "");
}
// 数分おき・戻ったときの確認をしてよいか: 画面に出ていて、今日のレースを読み込んでいて、ほかの確認・取得・ダイアログの最中でない
function canCheckDriveNow() {
  if (driveBgFrame && Date.now() - driveLastCheck > 10 * 60000) stopBackgroundFrame();   // 返事の来ないまま10分たった確認・取得は捨てる
  if (document.visibilityState !== "visible" || driveNeedsLogin || driveBgFrame) return false;
  if (driveUpdateDialog.open || driveAskDialog.open || driveDoneDialog.open) return false;
  const today = jstTodayYmd();
  return [...state.races.keys()].some(rid => rid.slice(0, 8) === today);
}
// 発走20分前〜発走2分後のレースがあれば、1分ごとに確かめる(単複オッズを20分前から1分ごとに取っているため。2026-11-21 ユーザーの指示)
function nearPostTime() {
  const [hh, mm] = new Intl.DateTimeFormat("en-GB", {timeZone:"Asia/Tokyo", hour:"2-digit", minute:"2-digit", hourCycle:"h23"}).format(new Date()).split(":").map(Number);
  const now = hh * 60 + mm, today = jstTodayYmd();
  for (const [rid, rows] of state.races) {
    if (rid.slice(0, 8) !== today) continue;
    const t = String(rows[0]?.hasso_time || "").padStart(4, "0");
    if (!/^\d{4}$/.test(t)) continue;
    const post = Number(t.slice(0, 2)) * 60 + Number(t.slice(2));
    if (now >= post - 21 && now <= post + 2) return true;
  }
  return false;
}
setInterval(() => {
  const every = nearPostTime() ? DRIVE_CHECK_NEAR_POST : DRIVE_CHECK_EVERY;
  if (canCheckDriveNow() && Date.now() - driveLastCheck >= every) checkDriveUpdate(true);
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (canCheckDriveNow() && Date.now() - driveLastCheck >= DRIVE_CHECK_ON_RETURN) checkDriveUpdate(true);
});
function handleDriveCheck(check) {
  const periodic = driveCheckPeriodic;
  driveCheckPeriodic = false;
  if (check.result === "login") {
    driveNeedsLogin = true;
    if (state.races.size) showDriveToast("更新の確認には再ログインが必要です", {button:"再ログイン", onButton:() => openDriveUpdate()});
    return;
  }
  if (check.result !== "update") return;
  if (periodic && !check.raceDay) return;   // 数分おきの確認では、開催日以外の「更新しますか？」は出さない
  driveLastCheck = Date.now();
  const params = new URLSearchParams({auto:"1", date:check.date, categories:check.categories.join(",")});
  if (check.raceDay) {
    showDriveToast("データを自動更新中…");
    startBackgroundFrame(params);
    return;
  }
  driveAsked = {check, params};
  driveAskDialog.showModal();
}
document.getElementById("driveAskYes").onclick = () => {
  const asked = driveAsked;
  driveAskDialog.close();
  if (!asked) return;
  openDriveUpdate(asked.params);
  driveAskMode = true;
};
document.getElementById("driveAskNo").onclick = () => driveAskDialog.close();
driveAskDialog.addEventListener("close", () => {
  // 「いいえ」: 次に新しい更新が来るまで聞かない
  if (driveAsked && !driveAskMode && !driveUpdateDialog.open) {
    try { localStorage.setItem(driveAsked.check.dismissKey, driveAsked.check.dismissToken); } catch (e) {}
  }
  driveAsked = null;
});
document.getElementById("driveDoneOk").onclick = () => driveDoneDialog.close();
driveDoneDialog.addEventListener("close", () => applyDriveUpdate());

function openDriveUpdate(params = new URLSearchParams()) {
  stopBackgroundFrame();
  driveToastEl.hidden = true;
  params.set("embedded", "1");
  driveUpdateFrame.src = "./index.html?" + params.toString();
  driveUpdateDialog.showModal();
}
document.getElementById("driveUpdateClose").onclick = () => driveUpdateDialog.close();
driveUpdateDialog.addEventListener("click", event => {
  if (event.target === driveUpdateDialog) driveUpdateDialog.close();
});
driveUpdateDialog.addEventListener("close", () => { driveAskMode = false; driveUpdateFrame.src = "about:blank"; });
window.addEventListener("message", async event => {
  if (event.origin !== location.origin) return;
  const fromDialog = event.source === driveUpdateFrame.contentWindow;
  const fromBackground = !!driveBgFrame && event.source === driveBgFrame.contentWindow;
  if (!fromDialog && !fromBackground) return;
  const type = event.data?.type;
  if (type === "drive-check-result" && fromBackground) {
    stopBackgroundFrame();
    handleDriveCheck(event.data);
  } else if (type === "drive-update-failed" && fromBackground) {
    stopBackgroundFrame();
    showDriveToast("自動更新できませんでした。前のデータを表示しています", {hideAfter:8000});
  } else if (type === "drive-update-complete") {
    driveNeedsLogin = false;
    driveLastCheck = Date.now();
    if (fromDialog && driveAskMode) {
      driveUpdateDialog.close();
      driveDoneDialog.showModal();      // OK を押してから画面を描き直す
      return;
    }
    if (fromBackground) stopBackgroundFrame();
    const applied = await applyDriveUpdate();
    if (fromBackground && applied) {
      const now = new Date();
      showDriveToast(`${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")} に更新しました` +
        (event.data?.failed ? `(${event.data.failed}件は取れず、前の分のまま。次の更新で取り直します)` : ""), {hideAfter:event.data?.failed ? 10000 : 5000});
    }
  }
});
async function applyDriveUpdate() {
  // 失敗したら元に戻せるように控えておく(表は消さない。変わった CSV だけを読み直すため。consumeDriveTransfer を見る)
  const keys = ["races", "combos", "plans", "odds", "oddsKind", "info", "results", "pays", "review", "fileUpdated", "fileTime", "loaded"];
  const previous = Object.fromEntries(keys.map(key => [key, new Map(state[key])]));
  const previousBand = state.band, previousStrength = state.strength;
  const previousCurrent = state.current;
  try {
    const loaded = await consumeDriveTransfer(true);
    if (!loaded) throw new Error("取得データを受け取れませんでした。");
    driveUpdateDialog.close();
    return true;
  } catch (error) {
    for (const key of keys) state[key] = previous[key];
    state.band = previousBand; state.strength = previousStrength;
    state.current = previousCurrent;
    render(false);
    updateRaceStatus();
    document.getElementById("status").textContent = "更新データを反映できませんでした: " + (error?.message || error);
    return false;
  }
}
document.getElementById("driveReload").onclick = () => {
  if (window.confirm("その日のデータを Google Drive から取得・更新します。よろしいですか？")) openDriveUpdate();
};
document.getElementById("bandOpen").onclick = () => {
  if (!state.band) return;
  renderBand();
  document.getElementById("bandDialog").showModal();
};
document.getElementById("bandClose").onclick = () => document.getElementById("bandDialog").close();
document.getElementById("bandDialog").addEventListener("click", e => {
  if (e.target.id === "bandDialog") e.target.close();
});
document.getElementById("theme").onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
};

// 自動更新のランプ(2026-11-21 ユーザーの指示): ヘッダの右側。緑=自動更新が有効、灰=無効(理由はランプにのせると出る)
const autoLamp = document.createElement("span");
autoLamp.id = "autoLamp";
autoLamp.innerHTML = '<i></i><span class="lbl-l">自動更新</span>';
document.getElementById("driveReload").before(autoLamp);
// データの更新の知らせ(再ログインなど)は、画面の右下ではなくヘッダの「自動更新」の右に出す(2026-11-22 ユーザーの指示)
autoLamp.after(driveToastEl);
driveToastEl.classList.add("in-header");
function updateAutoLamp() {
  const today = jstTodayYmd();
  const hasToday = [...state.races.keys()].some(rid => rid.slice(0, 8) === today);
  let on = false, why;
  if (driveNeedsLogin) why = "再ログインが必要なため止まっています";
  else if (!hasToday) why = "今日のレースのデータを読み込んでいないため止まっています";
  else if (document.visibilityState !== "visible") why = "画面が隠れているあいだは止まっています";
  else { on = true; why = "数分おきに新しいデータを確かめて自動で更新します"; }
  autoLamp.className = on ? "on" : "off";
  autoLamp.title = `自動更新: ${on ? "有効" : "無効"}。${why}`;
}
setInterval(updateAutoLamp, 5000);
document.addEventListener("visibilitychange", updateAutoLamp);
updateAutoLamp();
