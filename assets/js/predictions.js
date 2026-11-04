
"use strict";
const JYO = {"01":"札幌","02":"函館","03":"福島","04":"新潟","05":"東京","06":"中山","07":"中京","08":"京都","09":"阪神","10":"小倉"};
const RACE_INFO = [  // レースで同じ値の列(展開・馬場)
  "仮柵", "開催日目", "連続開催の何日目", "連続開催の何週目", "仮柵を替えて何日目",
];
const BIAS = [  // 馬場傾向: [表示名, 値の列, 目安の列]
  ["この開催の内外", "この開催の内外(マイナス=内有利)", "この開催の内外の目安"],
  ["この開催の前後", "この開催の前後(マイナス=前有利)", "この開催の前後の目安"],
  ["過去の同じ週の前後", "過去の同じ週の前後(マイナス=前有利)", "過去の同じ週の前後の目安"],
  ["前の開催日の内外", "前の開催日の内外", "前の開催日の内外の目安"],
  ["前の開催日の前後", "前の開催日の前後", "前の開催日の前後の目安"]];
const PACE = [  // 展開の数字: [表示名, 値の列, 目安の列, 値の書き方]
  ["逃げ馬の数", "レースの逃げ馬の数", "逃げ馬の数の目安", v => `${Math.round(v)}頭`],
  ["逃げ・先行馬の数", "レースの逃げ・先行馬の数", "逃げ・先行馬の数の目安", v => `${Math.round(v)}頭`],
  ["ペース予想", "ペース予想(前に行く3頭の前半の速さ)", "ペース予想の目安",
   v => `前に行く3頭のテン: コースの基準より ${Math.abs(v).toFixed(1)}% ${v >= 0 ? "速い" : "遅い"}`]];
const state = { races: new Map(), combos: new Map(), plans: new Map(), odds: new Map(), oddsKind: new Map(), calc: {},
  info: new Map(), results: new Map(), pays: new Map(), review: new Map(), fileUpdated: new Map(),
  band: null, current: null, open: new Set(), actualLapOpen: new Set() };

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

async function readFile(file, path, modifiedTime) {
  const rows = parseCSV(await file.text());
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const name = (path || file.webkitRelativePath || file.name).replace(/\\/g, "/");
  const raceFolder = name.match(/(?:^|\/)([^/]+_\d{2}R)\/[^/]+$/);
  if (raceFolder) {
    const stamp = modifiedTime || (file.lastModified ? new Date(file.lastModified).toISOString() : "");
    if (stamp) {
      const folderKey = raceFolder[1];
      const prev = state.fileUpdated.get(folderKey);
      if (!prev || new Date(stamp) > new Date(prev)) state.fileUpdated.set(folderKey, stamp);
    }
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
    if (!state.current) { try { state.current = sessionStorage.getItem("keiba-viewer:current"); } catch (e) {} }   // 再読み込みの前に見ていたレース
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
    req.onerror = () => reject(req.error);
  });
}
async function consumeDriveTransfer() {
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
        cached.onerror = () => reject(cached.error);
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  if (!payload?.files?.length) return false;
  document.getElementById("status").textContent = "データを読み込み中…";
  const files = payload.files.map(item => [new File([item.blob], item.name, {type:"text/csv"}), item.path, item.modifiedTime]);
  await loadFiles(files);
  updateRaceStatus();
  return true;
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
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}


// ---------- 画面 ----------
function models(rows) {
  return Object.keys(rows[0]).filter(c => c.endsWith("_勝率") && !c.startsWith("平均")).map(c => c.slice(0, -3));
}
function sortedRaces() {
  return [...state.races.keys()].sort((a, b) => {
    const ra = state.races.get(a)[0], rb = state.races.get(b)[0];
    return (a.slice(0, 8) + (ra.hasso_time || "9999") + a.slice(8)).localeCompare(b.slice(0, 8) + (rb.hasso_time || "9999") + b.slice(8));
  });
}
// レースの概要(芝ダ・距離・回り・レース名・グレード・馬場)と状態。レース情報.csv が無ければ出さない
const STATUS_TONE = { "結果確定後": "gray", "馬体重発表後": "up", "枠順確定(馬体重未発表)": "", "枠順確定前": "warn", "特別登録発表後": "warn" };
function overview(rid) {
  const i = state.info.get(rid);
  if (!i) return "";
  const course = [i["芝ダ"], i["距離"] ? `${i["距離"]}m` : "", i["回り"] ? `(${i["回り"]})` : ""].join("");
  const venueName = JYO[rid.slice(8, 10)];
  const folderKey = venueName ? `${venueName}_${rid.slice(14, 16)}R` : "";
  const updated = state.fileUpdated.get(folderKey);
  const updatedText = updated ? new Intl.DateTimeFormat("ja-JP", {timeZone:"Asia/Tokyo", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23"}).format(new Date(updated)).replace(/年|月/g, "/").replace("日", "") : "";
  return `<div class="overview"><b>${esc(course)}</b><span class="rname">${esc(i["レース名"] || "")}</span>` +
    (i["グレード"] ? `<span class="chip grade">${esc(i["グレード"])}</span>` : "") +
    (i["馬場状態"] ? `<span class="muted">馬場 ${esc(i["馬場状態"])}</span>` : "") +
    `<span class="chip ${STATUS_TONE[i["レースの状態"]] ?? ""}" title="DB にあるデータから決めた状態">${esc(i["レースの状態"] || "")}</span>` +
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
// 選んでいないとき・選んだものが3レース未満のときは、馬場&クラス → クラス → 馬場 → 全体 の順に10レース以上あるものを使う
function lapBase(info) {
  if (!info) return null;
  const n = k => num(info[`ラップの形_${k}_数`]) ?? 0;
  let k = null;
  try { k = localStorage.getItem("keiba-viewer:lap-base"); } catch (e) { k = state.lapBase; }
  if (!k || n(k) < 3 || !info[`ラップの形_${k}`]) k = ["馬場クラス", "クラス", "馬場", "全体"].find(x => n(x) >= 10) || null;
  if (!k) return null;
  return { k, laps: String(info[`ラップの形_${k}`]).split(",").filter(Boolean).map(Number), n: n(k) };
}
function lapBaseTabs(info) {
  if (!info || !info["ラップの形_全体"]) return "";
  const cur = lapBase(info)?.k;
  return `<div class="tabs lapbase" style="margin:4px 0">` + BASE_KINDS.map(([k, l]) => {
    const label = k === "全体" ? "全体" : l;
    const n = num(info[`ラップの形_${k}_数`]) ?? 0;
    return `<button data-k="${k}" class="${k === cur ? "on" : ""}" ${n < 3 ? "disabled" : ""} title="${label}: 同じコースの過去3年 ${n} レースの平均ラップ">${label} ${n}</button>`;
  }).join("") + `<span class="muted" style="font-size:12px;margin-left:6px">灰色の線(いつも)に使う基準</span></div>`;
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
function simpleView() {
  // 出走馬の簡易表示(このブラウザに覚えておく)
  try { return localStorage.getItem("keiba-viewer:simple") === "1"; } catch (e) { return !!state.simple; }
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
  let h = `<div class="card review"><h3>レース回顧</h3>`;
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
  const tickets = [["溜めた買い目", basketOf(rid)], ["推奨買い目(今の予算)", state.planTickets?.[rid] || []]];
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
    `回顧は表示だけで、モデルの学習・評価・選択には使わない。</div></div>`;
  return h;
}

// 右側の結果の欄(結果の CSV があるレースだけ)
function renderResult(rid) {
  const box = document.getElementById("result");
  const res = state.results.get(rid);
  document.body.classList.toggle("has-result", !!res);
  if (!res) { box.innerHTML = ""; return; }
  const pred = new Map((state.races.get(rid) || []).map(r => [String(+r.umaban), num(r["平均_順位"])]));
  const sep = t => t === "馬単" || t === "3連単" ? "→" : "-";
  let h = `<div class="res-top"><b>結果</b><span class="muted">${esc(title(rid))}</span>` +
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

function renderNav() {
  const nav = document.getElementById("nav");
  let html = `<div class="nav-top"><span class="muted">レース一覧</span><button id="navClose" title="レース一覧を開閉">${window.matchMedia("(max-width: 760px)").matches ? (document.body.classList.contains("mobile-nav-collapsed") ? "＋" : "−") : "←"}</button></div>`,
    lastDay = "", lastJyo = "";
  // 日付 → 競馬場 → 発走順
  const byDayJyo = {};
  for (const rid of sortedRaces()) {
    const k = rid.slice(0, 8) + rid.slice(8, 10);
    (byDayJyo[k] = byDayJyo[k] || []).push(rid);
  }
  for (const k of Object.keys(byDayJyo).sort()) {
    const day = k.slice(0, 8), jyo = k.slice(8);
    const dayShut = folded(`day:${day}`), jyoShut = folded(`jyo:${k}`);
    if (day !== lastDay) {
      html += `<div class="day fold-h" data-fold="day:${day}">${dayShut ? "▸" : "▾"} ${ymdw(day)}</div>`;
      lastDay = day;
    }
    if (dayShut) continue;
    html += `<div class="jyo fold-h" data-fold="jyo:${k}">${jyoShut ? "▸" : "▾"} ${JYO[jyo] || jyo}</div>`;
    if (jyoShut) continue;
    byDayJyo[k].sort((a, b) => a.slice(14).localeCompare(b.slice(14)));
    for (const rid of byDayJyo[k]) {
      const rows = state.races.get(rid), r = rows[0], c = confLevel(rows), x = num(r["混戦の段階"]);
      html += `<a data-rid="${rid}" class="${state.current === rid ? "on" : ""}"><span class="r">${+rid.slice(14, 16)}R</span>` +
        `<span class="t">${hhmm(r.hasso_time)}</span><span class="tag">` +
        (c ? `<span class="chip ${c.lv >= 7 ? "up" : c.lv <= 3 ? "gray" : ""}" title="自信 ${c.lv}/10(${CONF_WORDS[c.lv]})">自信${c.lv}</span>` : "") +
        (x ? ` <span class="chip ${x >= 7 ? "warn" : "gray"}" title="混戦 ${x}/10(${MIX_WORDS[x]})">混戦${x}</span>` : "") +
        navQuality(rid, rows) + `</span></a>`;
    }
  }
  nav.innerHTML = html;
  nav.querySelectorAll("a[data-rid]").forEach(a => a.onclick = () => { if (window.matchMedia("(max-width: 760px)").matches) document.body.classList.add("mobile-nav-collapsed"); state.current = a.dataset.rid; state.open.clear(); render(); });
  nav.querySelectorAll(".fold-h").forEach(d => d.onclick = () => { toggleFold(d.dataset.fold); renderNav(); });
  document.getElementById("navClose").onclick = () => document.getElementById("navToggle").click();
}

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
}
function setupCardFolds(root) {
  // カードの見出し(h2・h3)を押すとたたむ。たたんだ見出しはどのレースでも同じ(見出しの文字で覚える)
  root.querySelectorAll(".card").forEach(card => {
    const head = card.querySelector("h2, h3");
    if (!head) return;
    const key = "card:" + head.textContent.replace(/\s+/g, "").replace(/^[▾▸]/, "").replace(/？$/, "").slice(0, 20);   // ? ボタンの字は入れない
    head.classList.add("fold-card");
    head.insertAdjacentHTML("afterbegin", `<span class="fold-mark">${folded(key) ? "▸" : "▾"}</span>`);
    card.classList.toggle("folded", folded(key));
    head.onclick = e => {
      e.stopPropagation();
      toggleFold(key);
      card.classList.toggle("folded", folded(key));
      head.querySelector(".fold-mark").textContent = folded(key) ? "▸" : "▾";
    };
  });
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
  const rows = [...state.races.get(rid)].sort((a, b) => num(a["平均_順位"]) - num(b["平均_順位"]));
  const ms = models(rows), r0 = rows[0];
  const maxWin = Math.max(...rows.map(r => num(r["平均_勝率"]) || 0));
  const top3 = r => { const v = ms.map(m => num(r[`${m}_3着内`])).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b) / v.length : null; };
  const top2 = r => { const v = ms.map(m => num(r[`${m}_2着内`])).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b) / v.length : null; };
  const maxTop3 = Math.max(...rows.map(r => top3(r) || 0));
  const has = c => c in r0;

  // 見出し
  let html = `<div class="card"><h2>${title(rid)} <span class="muted" style="font-size:14px;font-weight:400">` +
    `${ymdw(rid.slice(0, 8))} 発走 ${hhmm(r0.hasso_time)}・${rows.length}頭</span></h2>${overview(rid)}` +
    `<div class="meters">${confMeter(rows)}${mixMeter(rows)}</div></div>` + renderReview(rid, rows);

  // モデルごとの自信
  const roiOf = m => Object.fromEntries((r0[`${m}_区分の回収率`] || "").split(" / ").filter(Boolean)
    .map(s => { const i = s.lastIndexOf(" "); return [s.slice(0, i), parseFloat(s.slice(i + 1))]; }));
  const bets = [...new Set(ms.flatMap(m => Object.keys(roiOf(m))))];
  // モデルごとの自信と区分の回収率(カードの一番下に出す)
  let modelCard = `<div class="card"><h3>モデルごとの自信と、その区分の過去の回収率</h3><div class="scroll"><table>` +
    `<tr><th>モデル</th><th>区分</th>${bets.map(b => `<th class="n">${esc(b)}</th>`).join("")}</tr>`;
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
  const bias = BIAS.filter(([, c]) => has(c) && num(r0[c]) != null).map(([label, c, g]) => {
    const guide = r0[g] || "", i = guide.indexOf("(");
    const word = i > 0 ? guide.slice(0, i) : guide, why = i > 0 ? guide.slice(i + 1, -1) : "";
    const v = num(r0[c]);
    // 予想 CSV に確度が無い項目(過去の同じ週の前後)はレース情報.csv の確度を使う
    const src = r0[`${label}の確度`] ? r0 : (state.info.get(rid) || {});
    const cw = src[`${label}の確度の根拠`];
    return `<div class="pace"><div class="pl">${esc(label)}</div><div><b>${v >= 0 ? "+" : ""}${v.toFixed(3)}</b>` +
      (word ? ` <span class="chip ${biasTone(word)}">${esc(word)}</span>` : "") + confChip(src, label) +
      (why || cw ? `<div class="note" style="margin:0">${esc(why)}${why && cw ? "。" : ""}${cw ? "確度の根拠: " + esc(cw) : ""}</div>` : "") + `</div></div>`;
  }).join("");
  const tenkaiCard = `<div class="card"><h3>展開予想</h3>${pace || `<span class="muted">列がありません</span>`}` +
    (pace ? `<div class="note">目安(札)は検証期間(2019〜2023年)の同じ芝ダのレースと比べたもの。ペース予想の数字はコースの基準タイムとの差で、ふつうのレースでも前に行く馬は基準より少し速い(平均は下の行のとおり)ので、札はそれと比べた速さ。逃げ・先行馬が多くペースが速いと差しが届きやすく、少なく遅いと前が残りやすい。</div>` : "") +
    `</div>`;
  const babaCard = `<div class="card"><h3>馬場傾向予想<button class="help" data-help="baba" title="馬場傾向予想の各項目の説明(別ウインドウ)">？</button></h3>` +
    `${info ? `<dl class="kv">${info}</dl>` : ""}` +
    (bias ? `<div style="margin-top:6px">${bias}</div><div class="note">馬場傾向の数字は、3着以内の馬の位置の平均 − 全馬の平均。` +
      `内外は馬番÷頭数(0 = 内、1 = 外)、前後は最初のコーナーの順位÷頭数(0 = 前、1 = 後ろ)で、マイナスなら内・前が有利。` +
      `目安は検証期間(2019〜2023年)の同じ芝ダの値と比べたもので、ふだんから少し前有利なので「いつも」と比べている。</div>` : "") +
    (info || bias ? "" : `<span class="muted">列がありません</span>`) + `</div>`;
  html += `<div class="grid2">${babaCard}${tenkaiCard}</div>`;   // 左に馬場、右に展開

  // 出走馬
  html += `<div class="card"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">` +
    `<h3 style="margin:0">出走馬</h3>` +
    `<label class="muted" style="font-size:13px" title="相対値・絶対値・理由をたたむ。馬の行を1回押すとそれが出て、2回目で詳細が出る">` +
    `<input type="checkbox" id="simpleView" ${simpleView() ? "checked" : ""}> 簡易表示</label>` +
    (r0["オッズの時刻"] ? `<span class="chip gray" title="単複オッズの発表時刻(過去のレースは確定オッズ)">${r0["オッズの時刻"] === "確定" ? "確定オッズ" : `オッズ ${esc(r0["オッズの時刻"])} 時点`}</span>` : "") +
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
    html += `<tr class="horse${why ? " has-why" : ""}" data-key="${key}"><td class="rank">${esc(r["平均_順位"])}</td><td>${umaBadge(r.umaban, nUma)}</td>` +
      `<td class="name">${esc(r.horse_name)}${cdot(r, "予想")}</td><td>${bar(num(r["平均_勝率"]), maxWin)}</td><td>${placeBar(top2(r), top3(r), maxTop3)}</td>` +
      `<td class="n">${fix(num(r["妥当オッズ_単勝"]))}${gapMark(getOdds(rid, r.umaban, r), num(r["妥当オッズ_単勝"]), "単勝")} / ` +
      `${fix(num(r["妥当オッズ_複勝"]))}${gapMark(num(r["複勝オッズ_下限"]), num(r["妥当オッズ_複勝"]), "複勝(下限)")}</td>` +
      `<td class="n">${odds != null ? `${fix(odds)}<span class="dim ninki">${ninki.get(String(r.umaban))}人気</span>` : `<span class="dim">—</span>`}</td>` +
      `<td class="n ev" data-uma="${esc(r.umaban)}">${evCell(getOdds(rid, r.umaban, r), num(r["妥当オッズ_単勝"]))}</td>` +
      `<td class="n">${placeOdds(r)}</td><td class="n">${evCell(num(r["複勝オッズ_下限"]), num(r["妥当オッズ_複勝"]))}</td><td>${finBar(r)}</td>` +
      `<td class="n">${fix(num(r["予想着順"]))}${cdot(r, "予想")}</td><td>${esc(styleOf(r))}${cdot(r, "脚質")}</td>` +
      `<td class="n">${passing(r)}${cdot(r, "通過予想")}</td><td class="n">${lastThree(r)}${cdot(r, "上がり予想")}</td>` +
      `<td class="n hide-sm">${w == null ? "" : w + (z == null ? "" : `<span class="dim">(${z > 0 ? "+" : ""}${z})</span>`)}</td>` +
      `<td class="hide-sm">${split ? `<span class="chip warn" title="モデルの順位の幅 ${spread}">割れ</span>` : ""}</td></tr>`;
    if (why && (!simpleView() || state.whyOpen?.has(key))) html += `<tr class="why"><td></td><td colspan="16">${why}</td></tr>`;
    if (state.open.has(key)) html += `<tr class="detail"><td colspan="17">${detail(r, ms, r0, state.info.get(rid), rid)}</td></tr>`;
  }
  html += `</table></div><div class="note">勝率・3着内は5モデルの平均。妥当オッズの横の印は実際のオッズとの差(▲▲ 1.5倍以上・▲ 1.2倍以上高い、▼ 0.8倍未満・▼▼ 0.5倍未満に低い。上にのせると比)。期待値 = オッズ ÷ 妥当オッズ(1 を超えると予想の上では得。緑は 1.0 以上、太字は 1.2 以上。複勝は下限のオッズで計算)。単勝オッズの横は人気(オッズの低い順)。「割れ」はモデルの順位の幅が4以上。馬名・予想着順・脚質・通過予想・上がり予想の横の印は確度(○ ◔ ◑ ◕ ● の5段階で、●ほど当たりやすい。色は緑 = 高・灰 = 中・橙 = 低。上にのせると0〜100の点と、検証期間の同じ条件での平均のずれ)。馬名の横は勝率・3着内・期待値を含む予想全体の確度。通過予想は前半(最初のコーナー)→ 4コーナーの番手、上がり予想は秒(かっこ内はレースで速い順、緑は3位まで)。根拠は説明用の LightGBM で、▲が評価を上げた項目、▼が下げた項目。数字は点数の差(レースの平均と比べた分)と、勝つ見込みのおおよその倍率(×)。総合・能力・適性・調子・人・展開は、根拠の項目を分類ごとに足したもの(総合は全部の合計)。1行目の「相対値」はこのレースの中の順位から星(点は1位が100・最下位が0)、2行目の「絶対値」は検証期間 2019〜2023年の全出走馬の中の位置(点は上位何%かで、80以上が★5)。横の高・中・低は確度(元になった出走数・調教などのデータの量。総合は能力・適性・調子のうち一番低いもの)で、低いものは薄く出す。</div></div>`;

  html += renderPlan(rid);
  html += renderCalc(rid);
  html += renderCombos(rid);
  html += modelCard;
  document.getElementById("main").innerHTML = html;
  setupCardFolds(document.getElementById("main"));
  setupHelpButtons(document.getElementById("main"));
  setupLapBase(document.getElementById("main"));
  document.querySelectorAll(".actual-lap-check").forEach(input => {
    input.onclick = e => e.stopPropagation();
    input.onchange = () => {
      const key = input.dataset.horseKey;
      if (input.checked) state.actualLapOpen.add(key);
      else state.actualLapOpen.delete(key);
      renderRace(rid);
    };
  });
  setupHorseSort(document.getElementById("main"), rid);
  document.querySelectorAll("tr.horse").forEach(tr => tr.onclick = e => {
    if (e.target.closest("input")) return;
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
  document.getElementById("simpleView")?.addEventListener("change", e => {
    try { localStorage.setItem("keiba-viewer:simple", e.target.checked ? "1" : "0"); } catch (err) { state.simple = e.target.checked; }
    renderRace(rid);
  });
  document.querySelectorAll(".tabs.combo button").forEach(b => b.onclick = () => { state.comboTab = b.dataset.t; renderRace(rid); });
  document.querySelectorAll(".tabs.csort button").forEach(b => b.onclick = () => { state.comboSort = b.dataset.t; renderRace(rid); });
  document.querySelectorAll(".tabs.plan button").forEach(b => b.onclick = () => { state.planTab = b.dataset.t; saveBudget(null); renderRace(rid); });
  document.querySelectorAll(".tabs.pmode button").forEach(b => b.onclick = () => { state.planMode = b.dataset.t; renderRace(rid); });
  document.querySelectorAll(".tabs.pgroup button").forEach(b => b.onclick = () => { state.planGroup = b.dataset.t; renderRace(rid); });
  const bud = document.getElementById("budget");
  if (bud) {
    bud.onclick = e => e.stopPropagation();
    bud.onchange = () => { saveBudget(num(bud.value.replace(/[,円\s]/g, ""))); renderRace(rid); };
    bud.onkeydown = e => { if (e.key === "Enter") bud.blur(); };
  }
  document.querySelectorAll('input[name="alloc"]').forEach(x => x.onchange = () => { saveMode(x.value); renderRace(rid); });
  const calc = state.calc[rid];
  const calcUpdate = (f) => { f(); renderRace(rid); };
  document.getElementById("calcKind")?.addEventListener("change", e => calcUpdate(() => calc.kind = e.target.value));
  document.querySelectorAll(".calcBox").forEach(x => x.onchange = () => calcUpdate(() => {
    const row = calc.rows[x.dataset.i - 1];
    if (x.checked) row.push(x.dataset.u); else row.splice(row.indexOf(x.dataset.u), 1);
  }));
  document.querySelectorAll(".calcAll").forEach(x => x.onchange = () => calcUpdate(() => {
    const all = (state.races.get(rid) || []).map(r => String(r.umaban));
    calc.rows[x.dataset.i - 1] = x.checked ? all : [];
  }));
  document.getElementById("calcClear")?.addEventListener("click", () => calcUpdate(() => { calc.rows = [[], [], []]; }));
  document.getElementById("calcAddPick")?.addEventListener("click", () => {
    const picked = [...document.querySelectorAll(".prevPick:checked")].map(x => x.dataset.k.split("-"));
    if (picked.length) addToBasket(rid, calc.kind, picked, roundYen(calc.unit));
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
      if (hit) hit.amount += amount; else b.push({ kind: x.kind, t: [...x.t], amount });
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
    if (cols.every(x => x.length)) addToBasket(rid, calc.kind, expandTickets(calc.kind, cols), roundYen(calc.unit));
    renderRace(rid);
  });
  document.querySelectorAll("input.amt").forEach(x => {
    x.onclick = e => e.stopPropagation();
    x.onchange = () => { basketOf(rid)[x.dataset.i].amount = roundYen(x.value); saveBasket(rid); renderRace(rid); };
  });
  document.querySelectorAll("button.del").forEach(x => x.onclick = () => { basketOf(rid).splice(+x.dataset.i, 1); saveBasket(rid); renderRace(rid); });
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
  const t3 = r => { const v = MODELS_OF(r).map(m => num(r[`${m}_3着内`])).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b) / v.length : null; };
  return [
    ["予", r => num(r["平均_順位"]), 1, "rank", "予想の順位"],
    ["馬番", r => +r.umaban, 1, "", ""],
    ["馬名", r => r.horse_name || "", 1, "", ""],
    ["勝率", r => num(r["平均_勝率"]), -1, "", ""],
    ["2・3着内", t3, -1, "", "3着内の確率で並べる"],
    ["妥当オッズ<br>単/複", r => num(r["妥当オッズ_単勝"]), 1, "n", "単勝の妥当オッズで並べる"],
    ["単勝<br>オッズ", o, 1, "n", ""],
    ["期待値", r => ratio(o(r), num(r["妥当オッズ_単勝"])), -1, "n", ""],
    ["複勝<br>オッズ", r => num(r["複勝オッズ_下限"]), 1, "n", "下限で並べる"],
    ["複勝<br>期待値", r => ratio(num(r["複勝オッズ_下限"]), num(r["妥当オッズ_複勝"])), -1, "n", ""],
    ["1〜5着", r => upTo(r, 3), -1, "", "3着以内の確率で並べる"],
    ["予想<br>着順", r => num(r["予想着順"]), 1, "n", ""],
    ["脚質", r => STYLE_ORDER[styleOf(r)] ?? 9, 1, "", "逃・先行・差・追込・自在・不明の順"],
    ["通過<br>予想", r => num(r["4角の番手"]), 1, "n", "前半(最初のコーナー)→ 4コーナーの予想の番手。4コーナーの番手で並べる"],
    ["上がり<br>予想", r => num(r["上がり3Fの予想"]), 1, "n", "上がり3F の予想(かっこ内はレースの中で速い順)"],
    ["馬体重", r => num(r["馬体重"]), -1, "n hide-sm", ""],
  ];
}
const MODELS_OF = r => Object.keys(r).filter(c => c.endsWith("_3着内") && !c.startsWith("平均")).map(c => c.slice(0, -4));
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
  // 5モデルの確率の最小〜最大から、妥当オッズの幅(1 ÷ 確率)
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
  // 予想 CSV の「自信の段階」(5モデル平均を検証期間と比べたもの)。無い古い CSV は、各モデルの自信の上位%の平均で代わりにする
  const r = rows[0], lv = num(r["自信の段階"]);
  if (lv) return { lv, top: num(r["自信の上位%(平均)"]), exact: true };
  const tops = models(rows).map(m => num(r[`${m}_自信の上位%`])).filter(v => v != null);
  if (!tops.length) return null;
  const top = tops.reduce((a, b) => a + b) / tops.length;
  return { lv: Math.min(10, Math.max(1, 10 - Math.floor(top / 10))), top, exact: false };
}
function meter(lv, cls) {
  return `<div class="meter ${cls}">${Array.from({ length: 10 }, (_, i) => `<i class="${i < lv ? "on" : ""}"></i>`).join("")}</div>`;
}
function confMeter(rows) {
  const c = confLevel(rows), r0 = rows[0];
  if (!c) return "";
  return `<div class="mt"><div class="mh"><span class="ml">自信</span><b class="mv">${c.lv}</b><span class="dim">/10</span>` +
    `<span class="chip ${c.lv >= 7 ? "up" : c.lv <= 3 ? "gray" : ""}">${CONF_WORDS[c.lv]}</span></div>${meter(c.lv, "conf")}` +
    `<div class="note" style="margin:4px 0 0">予想1位の勝率 ${pct(num(r0["平均_自信"]))}。検証期間(2019〜2023年)のレースの中で上位 ${fix(c.top, 0)}%` +
    (c.exact ? "" : "(各モデルの平均で代用)") + `</div></div>`;
}
function mixMeter(rows) {
  const r0 = rows[0], lv = num(r0["混戦の段階"]), n = num(r0["有力頭数"]), gap = num(r0["1位と2位の勝率差"]);
  if (!lv && n == null) return "";
  const head = lv ? `<b class="mv">${lv}</b><span class="dim">/10</span><span class="chip ${lv >= 7 ? "warn" : "gray"}">${MIX_WORDS[lv]}</span>` : "";
  return `<div class="mt"><div class="mh"><span class="ml">混戦</span>${head}</div>${lv ? meter(lv, "mix") : ""}` +
    `<div class="note" style="margin:4px 0 0">有力頭数 ${fix(n, 1)}頭(勝率が均等なら頭数と同じ、1強なら 1 に近い)・1位と2位の勝率差 ${pct(gap)}` +
    (lv ? `。混戦の度合いは上位 ${fix(num(r0["混戦の上位%"]), 0)}%` : "") + `</div></div>`;
}
function kpi(v, l) { return `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`; }

function horseLapPanel(r0, info, rid, horseKey) {
  const p = predictedLaps(r0, info), rv = state.review.get(rid) || {};
  const actual = String(rv["ラップ"] || "").split(",").filter(Boolean).map(Number);
  const hasActual = state.results.has(rid) && actual.length > 0 && actual.every(Number.isFinite);
  const showActual = hasActual && state.actualLapOpen.has(horseKey);
  const lb = lapBase(info);
  const dist = num(info?.["距離"]);
  const actualMarks = hasActual ? (dist ? lapMarks(dist, actual.length) : actual.map((_, i) => 200 * (i + 1))) : [];
  const comparablePred = p && p.laps.length === actual.length ? p.laps : null;

  const heading = showActual
    ? `<div class="horse-lap-head"><h4>レース全体の実際のラップ</h4>${p ? `<span class="chip ${p.conf === "高" ? "up" : p.conf === "低" ? "warn" : "gray"}">予想確度 ${p.conf}</span>` : ""}</div>`
    : p
      ? `<div class="horse-lap-head"><h4>レース全体の予想ラップ</h4><span class="chip ${p.conf === "高" ? "up" : p.conf === "低" ? "warn" : "gray"}">確度 ${p.conf}</span></div>`
      : `<h4>レース全体の予想ラップ</h4>`;

  const lapContent = showActual
    ? lapText(actual, num(rv["前半3F"]), num(rv["後半3F"])) +
      `<div class="scroll horse-lap-chart">${lapChart(actual, comparablePred, actualMarks, lb?.laps, lb)}</div>`
    : p
      ? lapText(p.laps) + lapBaseTabs(info) +
        `<div class="scroll horse-lap-chart">${predLapChart(p.laps, p.marks, lb?.laps ?? p.avg)}</div>` +
        `<div class="note">${esc(p.why)}。途中の形は同じコースの過去のラップ傾向を使っています。</div>`
      : `<p class="muted">予想ラップを計算する材料がありません。</p>`;

  const toggle = hasActual
    ? `<label class="actual-lap-toggle"><input type="checkbox" class="actual-lap-check" data-horse-key="${esc(horseKey)}" ${showActual ? "checked" : ""}> 実際のラップを表示</label>`
    : "";
  return `<section class="horse-lap-panel">${heading}${toggle}${lapContent}</section>`;
}

function detail(r, ms, raceRow, info, rid) {
  let t = `<div class="horse-detail-layout"><div class="horse-detail-data"><div class="grid2"><div class="scroll"><table><tr><th>モデル</th><th class="n">順位</th><th class="n">勝率</th><th class="n">2着内</th><th class="n">3着内</th></tr>`;
  for (const m of ms) t += `<tr><td>${esc(m)}</td><td class="n">${esc(r[`${m}_順位`])}</td><td class="n">${pct(num(r[`${m}_勝率`]))}</td>` +
    `<td class="n">${pct(num(r[`${m}_2着内`]))}</td><td class="n">${pct(num(r[`${m}_3着内`]))}</td></tr>`;
  t += `</table></div><dl class="kv">`;
  // 項目 → どの確度を付けるか(勝率のばらつき・順位の幅は、それ自体が予想の確度の目安)
  t += `<dt>妥当オッズ(単勝)</dt><dd>${fix(num(r["妥当オッズ_単勝"]))}<span class="dim">(5モデルで ${fairRange(r, ms, "勝率")})</span>${cdot(r, "予想")}</dd>`;
  t += `<dt>妥当オッズ(複勝)</dt><dd>${fix(num(r["妥当オッズ_複勝"]))}<span class="dim">(5モデルで ${fairRange(r, ms, "3着内")})</span>${cdot(r, "予想")}</dd>`;
  const extra = [["1着の確率", "予想"], ["2着の確率", "予想"], ["3着の確率", "予想"], ["4着の確率", "予想"], ["5着の確率", "予想"],
    ["勝率のばらつき", "目安"], ["順位の幅", "目安"], ["位置取り(近5走、0=前・1=後ろ)", "脚質"], ["前に行く順位", "脚質"],
    ["前半の速さの順位", "前半の速さ"]];
  for (const [c, k] of extra) if (c in r && r[c] !== "") {
    const mark = k === "目安" ? ` <span class="dim" title="5モデルの意見の割れ具合。小さいほど予想の確度が高い">(確度の目安)</span>` : cdot(r, k);
    t += `<dt>${esc(c)}</dt><dd>${c.endsWith("確率") ? pct(num(r[c])) : esc(r[c])}${mark}</dd>`;
  }
  if (r["根拠_上げた"]) t += `<dt>根拠(上げた)</dt><dd>${reasonText(r["根拠_上げた"])}${cdot(r, "予想")}</dd>`;
  if (r["根拠_下げた"]) t += `<dt>根拠(下げた)</dt><dd>${reasonText(r["根拠_下げた"])}${cdot(r, "予想")}</dd>`;
  return t + `</dl><div class="note">根拠のかっこ内は、その項目でこの馬の点数が同じレースの平均より上がった・下がった分(説明用の LightGBM の点数)。` +
    `点数の差 d は、勝つ見込みを約 e<sup>d</sup> 倍にする(+0.5 で約1.6倍、+0.2 で約1.2倍、−0.1 で約0.9倍)。</div></div></div>` + horseLapPanel(raceRow, info, rid, `${rid}_${r.umaban}`) + `</div>`;
}

// ---------- 推奨買い目と、入れた予算での資金配分 ----------
const BUDGET_TIERS = [[500, "〜500円"], [1000, "600〜1000円"], [3000, "1100〜3000円"], [5000, "3100〜5000円"], [Infinity, "5100円以上"]];
function savedBudget() { try { return num(localStorage.getItem("keiba-viewer:budget")); } catch (e) { return state.budget ?? null; } }
function saveBudget(v) { state.budget = v; try { localStorage.setItem("keiba-viewer:budget", v ?? ""); } catch (e) {} }
function savedMode() { try { return localStorage.getItem("keiba-viewer:alloc") || "均等"; } catch (e) { return state.alloc || "均等"; } }
function saveMode(v) { state.alloc = v; try { localStorage.setItem("keiba-viewer:alloc", v); } catch (e) {} }

function harville(raceRows) {
  // 5モデルの平均の勝率から、着順の上位3頭の並びごとの確率(Harville の式)
  const horses = raceRows.map(r => [String(r.umaban), num(r["平均_勝率"]) || 0]);
  const total = horses.reduce((a, [, p]) => a + p, 0) || 1;
  const q = horses.map(([u, p]) => [u, p / total]);
  const out = [];
  for (const [a, pa] of q) for (const [b, pb] of q) {
    if (b === a || 1 - pa <= 0) continue;
    for (const [c, pc] of q) {
      if (c === a || c === b || 1 - pa - pb <= 0) continue;
      out.push([a, b, c, pa * pb / (1 - pa) * pc / (1 - pa - pb)]);
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

function renderPlan(rid) {
  const all = state.plans.get(rid);
  if (!all) return state.plans.size ? "" : `<div class="card muted">推奨買い目は、<code>推奨買い目</code> フォルダの CSV も落とすと出ます。</div>`;
  // 推奨の種類(おすすめ・組み合わせ・券種別)。古い CSV(種類の列なし)は「おすすめ」だけ
  const kindOfRow = x => x["種類"] || "おすすめ";
  const modes = ["おすすめ", "組み合わせ", "券種別"].filter(m => all.some(x => kindOfRow(x) === m));
  const pmode = modes.includes(state.planMode) ? state.planMode : modes[0];
  const inMode = all.filter(x => kindOfRow(x) === pmode);
  const groups = [...new Set(inMode.map(x => x["分け"] || pmode))];     // 券種別のときは券種
  const pgroup = groups.includes(state.planGroup) ? state.planGroup : groups[0];
  const rowsG = inMode.filter(x => (x["分け"] || pmode) === pgroup);
  const tiers = [...new Set(rowsG.map(x => x["予算"]))];
  const budget = savedBudget(), mode = savedMode();
  const tierName = budget ? BUDGET_TIERS.find(([lim]) => budget <= lim)[1] : null;
  // 手入力の予算があればその金額が入る区分の買い方を使う(区分のボタンは選ばない)。無ければ選んだ区分
  const tab = tierName && tiers.includes(tierName) ? tierName : tiers.includes(state.planTab) ? state.planTab : tiers[0];
  const tierOn = t => !budget && t === tab;
  const parts = rowsG.filter(x => x["予算"] === tab);       // 1つ(組み合わせは2つ)の買い方
  const r = parts[0];
  const raceRows = state.races.get(rid) || [];
  const tosu = raceRows.length, places = tosu <= 7 ? 2 : 3;
  // 買い目を全部の買い方から集める(券種・組・CSV のオッズ)
  const tickets = [];
  for (const x of parts) {
    const odds = (x["買い目のオッズ"] || "").split(" / ");
    (x["買い目"] || "").split(" / ").filter(t => /\d/.test(t)).forEach((t, i) =>
      tickets.push({ kind: x["券種"], t: t.split(/[-→]/), csvOdds: num(odds[i]) }));
  }
  const kinds = [...new Set(parts.map(x => x["券種"]))];
  const roi = num(r?.["過去の回収率"]), honest = num(r?.["確かめの回収率"]);
  let h = `<div class="card"><h3>推奨買い目と資金配分</h3>` +
`<div class="tabs pmode" style="margin-bottom:6px">` + modes.map(m => `<button data-t="${m}" class="${m === pmode ? "on" : ""}" title="${
      { "おすすめ": "1つの買い方で一番良かったもの", "組み合わせ": "券種の違う2つの買い方を合わせて一番良かったもの", "券種別": "券種ごとに一番良かった買い方" }[m]}">${
      { "おすすめ": "おすすめ(1券種)", "組み合わせ": "券種を組み合わせ", "券種別": "券種別" }[m]}</button>`).join("") + `</div>` +
    (pmode === "券種別" ? `<div class="tabs pgroup" style="margin-bottom:6px">` +
      groups.map(g => `<button data-t="${esc(g)}" class="${g === pgroup ? "on" : ""}">${esc(g)}</button>`).join("") + `</div>` : "") +
    // 予算: 固定の区分と手入力を同じ列に。手入力を使うと区分の選択は外れる
    `<div class="tabs plan" style="align-items:center">` + tiers.map(t => `<button data-t="${esc(t)}" class="${tierOn(t) ? "on" : ""}">${esc(t)}</button>`).join("") +
    `<label class="budgetbox${budget ? " on" : ""}" title="金額を入れると、その金額が入る区分の買い方を使う(すべてのレースで共通。このブラウザに覚えておく)">手入力 ` +
    `<input id="budget" class="odds" style="width:80px" inputmode="numeric" value="${budget ?? ""}" placeholder="例 2300"> 円</label></div>` +
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
  const kindNote = r["オッズの種類"] ? `<span class="chip gray">オッズ: ${esc(r["オッズの種類"])}</span>` : "";
  const many = kinds.length > 1;
  state.planTickets = state.planTickets || {};
  state.planTickets[rid] = tickets.map((x, i) => ({ kind: x.kind, t: x.t, amount: amt[i] || 0 }));
  h += `<div class="scroll"><table><tr><th><input type="checkbox" class="planAll" title="全部選ぶ"></th>${many ? "<th>券種</th>" : ""}<th>買い目</th><th class="n">確率</th><th class="n">妥当なオッズ</th><th class="n">オッズ</th>` +
    `<th class="n">期待値</th><th class="n">金額</th><th class="n">当たったときの払戻</th></tr>`;
  tickets.forEach((x, i) => {
    const o = oddsOf(x), p = probs[i], lower = x.kind === "複勝" || x.kind === "ワイド";
    const backI = amt[i] && o ? `${Math.round(amt[i] * o).toLocaleString()}円` + (lower ? "〜" : "") : `<span class="dim">-</span>`;
    const hp = hitPayout(rid, x.kind, x.t);
    h += `<tr class="${amt[i] ? "" : "dim"}${hp != null ? " hit" : ""}"${hp != null ? ` title="的中(100円あたり ${hp.toLocaleString()}円)"` : ""}><td><input type="checkbox" class="planPick" data-i="${i}"></td>${many ? `<td>${esc(x.kind)}</td>` : ""}<td><b>${esc(x.t.join(x.kind === "馬単" || x.kind === "3連単" ? "→" : "-"))}</b></td>` +
      `<td class="n">${pct(p)}</td><td class="n">${p > 0 ? fix(1 / p) + gapMark(o, 1 / p, x.kind + (lower ? "(下限)" : "")) : ""}</td>` +
      `<td class="n">${o ? fix(o) + (lower ? "〜" : "") : `<span class="dim">オッズなし</span>`}</td><td class="n">${o && p ? evCell(o, 1 / p) : ""}</td>` +
      `<td class="n">${amt[i] ? amt[i].toLocaleString() + "円" : "買わない"}</td><td class="n">${backI}</td></tr>`;
  });
  h += `</table></div><div class="calc" style="margin-top:8px"><button id="planSendAll">↓ 全部を溜めた分に送る</button>` +
    `<button id="planSendPick">↓ 選んだものを溜めた分に送る</button>` +
    `<span class="note" style="margin:0">送ると、下の「買い目を入れて計算」の「買い目(溜めた分)」に今の金額で足す(0円の買い目は100円で送る)。</span></div>` +
    (kindNote ? `<div style="margin-top:6px">${kindNote}</div>` : "") +
    (budget && spent < budget ? `<div class="note">残り ${(budget - spent).toLocaleString()}円は使わない(100円単位にそろえた余り)。</div>` : "") +
    (budget && amt.some(a => !a) ? `<div class="note">予算が点数に足りないので、確率の低い買い目は買わない。</div>` : "") +
    `<div class="note">根拠: ${esc(r["根拠"] || "")}</div>` +
    `<div class="note">買い目の数字は馬番。確率は5モデルの平均の勝率から Harville の式で計算したもの(予想の上の値)。オッズは、終わったレースは確定オッズ、当日は取ってある単勝・複勝だけ(組み合わせ馬券の当日のオッズは取らない)。期待値 = オッズ × 確率。複勝・ワイドは下限のオッズ。` +
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
  const valid = new Set(raceRows.map(r => String(r.umaban)));
  const c = state.calc[rid] || (state.calc[rid] = { kind: "馬連", rows: [[], [], []], unit: "100" });
  const [n, ordered] = CALC_KINDS[c.kind];
  const horses = [...valid].sort((a, b) => a - b);
  const cols = c.rows.slice(0, n).map(r => horses.filter(u => r.includes(u)));
  const tickets = cols.every(x => x.length) ? expandTickets(c.kind, cols) : [];
  const unit = roundYen(c.unit);
  const odds = state.odds.get(rid);
  const tri = harville(raceRows), places = raceRows.length <= 7 ? 2 : 3;
  const lower = c.kind === "複勝" || c.kind === "ワイド";
  let h = `<div class="card"><h3>買い目を入れて計算(フォーメーション)</h3>` +
    `<div class="calc">` +
    `<label>券種 <select id="calcKind">${Object.keys(CALC_KINDS).map(k => `<option ${k === c.kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>` +
    `<label>1点 <input id="calcUnit" class="odds" type="number" min="0" step="100" style="width:90px" value="${roundYen(c.unit)}"> 円</label>` +
    `<button id="calcBox" title="1行目の馬を全部の行に入れる(ボックス)">ボックスにする</button>` +
    `<button id="calcClear">チェックを消す</button></div>`;
  // 馬番のチェックボックスの表(行 = 1着・1頭目 / 2着・2頭目 / 3着・3頭目、列 = 馬番と全通り)
  const rowName = i => n === 1 ? "馬番" : ordered ? `${i}着` : `${i}頭目`;
  const nameOf = u => raceRows.find(r => String(r.umaban) === u)?.horse_name || "";
  h += `<div class="scroll"><table class="grid"><tr><th></th>` +
    horses.map(u => `<th class="gc" title="${esc(nameOf(u))}">${u}</th>`).join("") + `<th class="gc">全通り</th></tr>`;
  for (let i = 1; i <= n; i++) {
    const row = c.rows[i - 1];
    const all = horses.length && horses.every(u => row.includes(u));
    h += `<tr><th class="gr">${rowName(i)}</th>` +
      horses.map(u => `<td class="gc"><input type="checkbox" class="calcBox" data-i="${i}" data-u="${u}" ${row.includes(u) ? "checked" : ""}></td>`).join("") +
      `<td class="gc"><input type="checkbox" class="calcAll" data-i="${i}" ${all ? "checked" : ""}></td></tr>`;
  }
  h += `</table></div><div class="note">${n === 1 ? "買う馬にチェック。" : ordered ? "着順ごとに馬にチェック(1着の行が1着、2着の行が2着…)。" :
    "1頭目・2頭目…の行に馬をチェック。順番は問わず、同じ組は1点にまとめる。"}` +
    `ボックスは1行目の馬を全部の行に入れる。流しは1行目に軸、2行目以降に相手をチェック。馬番にのせると馬名。</div>`;
  // 今の選び方の組(溜めた分に移す前の下見)
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
      if (o && unit) { pc += unit; pb += p * o * unit; }
      return { t, p, o };
    }).sort((x, y) => y.p - x.p);
    const anyP = tri.reduce((s, x) => s + (tickets.some(t => hits(c.kind, t, x, places)) ? x[3] : 0), 0);
    const sep = CALC_KINDS[c.kind][1] && n > 1 ? "→" : "-";
    h += `<div class="kpis" style="margin:6px 0 8px">` +
      kpi(`${c.kind} ${tickets.length}点・${(tickets.length * unit).toLocaleString()}円`, `1点 ${unit.toLocaleString()}円`) +
      kpi(pct(anyP), "どれか当たる確率(予想の上で)") +
      kpi(pc ? `${Math.round(pb).toLocaleString()}円` : "-", "払戻の期待値") +
      kpi(pc ? `<span class="${pb / pc >= 1 ? "hi" : ""}">${fix(pb / pc * 100)}%</span>` : "-", "回収率の期待値(予想の上で)") + `</div>` +
      `<div class="scroll" style="max-height:320px;overflow-y:auto"><table><tr><th><input type="checkbox" class="prevAll" title="全部選ぶ"></th><th>買い目</th><th class="n">確率</th><th class="n">妥当オッズ</th>` +
      `<th class="n">オッズ${lower ? "(下限)" : ""}</th><th class="n">期待値</th><th class="n">金額</th><th class="n">当たったときの払戻</th></tr>` +
      prev.map(r => `<tr><td><input type="checkbox" class="prevPick" data-k="${esc(r.t.join("-"))}"></td><td><b>${esc(r.t.join(sep))}</b></td><td class="n">${pct(r.p, 2)}</td><td class="n">${r.p > 0 ? fix(1 / r.p) : ""}</td>` +
        `<td class="n">${r.o ? fix(r.o) : `<span class="dim">オッズなし</span>`}</td><td class="n">${r.o && r.p ? evCell(r.o, 1 / r.p) : ""}</td>` +
        `<td class="n">${unit.toLocaleString()}円</td><td class="n">${r.o && unit ? Math.round(unit * r.o).toLocaleString() + "円" + (lower ? "〜" : "") : "-"}</td></tr>`).join("") +
      `</table></div>`;
  }
  h += `<div class="calc" style="margin-top:8px">` +
    `<button id="calcAdd" ${tickets.length ? "" : "disabled"}>↓ 全部を溜めた分に移す</button>` +
    `<button id="calcAddPick" ${tickets.length ? "" : "disabled"}>↓ 選んだものを溜めた分に移す</button>` +
    `<span class="note" style="margin:0">移すと、下の「買い目(溜めた分)」に足す(同じ買い目は金額を足し合わせる)。フォーメーションのチェックはそのまま残る。</span></div>`;
  return h + renderBasket(rid, tri, places, odds, raceRows) + `</div>`;
}

// ---------- 溜めた買い目(券種・フォーメーションをまたいで組み合わせる) ----------
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
function addToBasket(rid, kind, tickets, unit) {
  const b = basketOf(rid);
  for (const t of tickets) {
    const hit = b.find(x => x.kind === kind && x.t.join("-") === t.join("-"));
    if (hit) hit.amount += unit; else b.push({ kind, t, amount: unit });
  }
  saveBasket(rid);
}
function renderBasket(rid, tri, places, odds, raceRows) {
  const b = basketOf(rid);
  let h = `<h3 style="margin-top:16px">買い目(溜めた分)</h3>`;
  if (!b.length) return h + `<div class="muted">上で馬を選んで「買い目に足す」を押すと、ここに溜まります。券種やフォーメーションを変えて何回でも足せます。</div>`;
  let cost = 0, back = 0, priced = 0;
  const rows = b.map((x, i) => {
    const p = tri.reduce((s, y) => s + (hits(x.kind, x.t, y, places) ? y[3] : 0), 0);
    let o = odds?.get(ticketKey(x.kind, x.t));
    if (x.kind === "単勝") {
      const row = raceRows.find(r => String(r.umaban) === x.t[0]);
      if (row && manualOdds(rid, row.umaban)) o = getOdds(rid, row.umaban, row);
    }
    cost += x.amount;
    if (o && x.amount) { back += p * o * x.amount; priced += x.amount; }
    return { ...x, i, p, o };
  });
  const live = b.filter(x => x.amount > 0);
  const anyP = tri.reduce((s, y) => s + (live.some(x => hits(x.kind, x.t, y, places)) ? y[3] : 0), 0);
  h += `<div class="kpis" style="margin:6px 0 8px">` +
    kpi(`${live.length}点・${cost.toLocaleString()}円`, `全 ${b.length}点(0円の買い目は買わない)`) +
    kpi(pct(anyP), "どれか当たる確率(予想の上で)") +
    kpi(priced ? `${Math.round(back).toLocaleString()}円` : "-", `払戻の期待値${priced < cost ? `(オッズのある ${priced.toLocaleString()}円分)` : ""}`) +
    kpi(priced ? `<span class="${back / priced >= 1 ? "hi" : ""}">${fix(back / priced * 100)}%</span>` : "-", "回収率の期待値(予想の上で)") +
    (state.oddsKind?.get(rid) ? kpi(esc(state.oddsKind.get(rid)), "オッズの種類") : "") + `</div>`;
  h += `<div class="scroll" style="max-height:460px;overflow-y:auto"><table><tr><th>券種</th><th>買い目</th><th class="n">確率</th><th class="n">妥当オッズ</th>` +
    `<th class="n">オッズ</th><th class="n">期待値</th><th class="n">金額(100円単位)</th><th class="n">当たったときの払戻</th><th></th></tr>`;
  for (const r of rows) {
    const lower = r.kind === "複勝" || r.kind === "ワイド";
    const sep = CALC_KINDS[r.kind][1] && r.t.length > 1 ? "→" : "-";
    const hp = hitPayout(rid, r.kind, r.t);
    h += `<tr class="${r.amount ? "" : "dim"}${hp != null ? " hit" : ""}"${hp != null ? ` title="的中(100円あたり ${hp.toLocaleString()}円)"` : ""}><td>${esc(r.kind)}</td><td><b>${esc(r.t.join(sep))}</b></td>` +
      `<td class="n">${pct(r.p, 2)}</td><td class="n">${r.p > 0 ? fix(1 / r.p) : ""}</td>` +
      `<td class="n">${r.o ? fix(r.o) + (lower ? "〜" : "") : `<span class="dim">オッズなし</span>`}</td><td class="n">${r.o && r.p ? evCell(r.o, 1 / r.p) : ""}</td>` +
      `<td class="n"><input class="odds amt" data-i="${r.i}" type="number" min="0" step="100" value="${r.amount}" style="width:90px"> 円</td>` +
      `<td class="n">${r.o && r.amount ? Math.round(r.amount * r.o).toLocaleString() + "円" + (lower ? "〜" : "") : r.amount ? "-" : "買わない"}</td>` +
      `<td><button class="del" data-i="${r.i}" title="この買い目を消す">×</button></td></tr>`;
  }
  h += `</table></div><div class="calc" style="margin-top:8px"><button id="basketZero">全部0円にする</button><button id="basketClear">買い目を全部消す</button>` +
    `<span class="note" style="margin:0">金額は100円単位(入れた値を丸める)。0円は「買わない」(表には残る)。溜めた買い目はこのブラウザに覚えておく(レースごと)。</span></div>` +
    `<div class="note">確率は5モデルの平均の勝率から Harville の式で計算したもの(予想の上の値)。期待値 = オッズ × 確率。` +
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
    add("3連単", `${a}-${b}-${c}`, v);
    add("3連複", [a, b, c].sort((x, y) => x - y).join("-"), v);
    two.set(`${a}-${b}`, (two.get(`${a}-${b}`) || 0) + v);
    for (const [x, y] of [[a, b], [a, c], [b, c]]) add("ワイド", [x, y].sort((p, q) => p - q).join("-"), v);
  }
  for (const [k, v] of two) { add("馬単", k, v); add("馬連", k.split("-").sort((x, y) => x - y).join("-"), v); }
  return out;
}
function renderCombos(rid) {
  const raceRows = state.races.get(rid) || [];
  if (!raceRows.length) return "";
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
  let h = `<div class="card"><h3>組み合わせ馬券(${sortBy === "期待値" ? "期待値の高い順" : "確率の高い順"})</h3><div class="tabs combo">` +
    kinds.map(k => `<button data-t="${esc(k)}" class="${k === tab ? "on" : ""}">${esc(k)}</button>`).join("") + `</div>` +
    `<div class="tabs csort" style="margin-top:6px">` + ["確率", "期待値"].map(x =>
      `<button data-t="${x}" class="${x === sortBy ? "on" : ""}" ${x === "期待値" && !odds ? "disabled title=\"オッズ フォルダの CSV を落とすと使える\"" : ""}>${x}の高い順</button>`).join("") + `</div>` +
    `<div class="scroll"><table><tr><th>組番</th><th>確率</th><th class="n">妥当なオッズ</th><th class="n">オッズ${lower ? "(下限)" : ""}</th><th class="n">期待値</th></tr>`;
  for (const r of list) h += `<tr><td><b>${esc(r.k.split("-").join(sep))}</b></td><td>${bar(r.p, max)}</td><td class="n">${fix(1 / r.p)}</td>` +
    `<td class="n">${r.o ? fix(r.o) : `<span class="dim">オッズなし</span>`}</td><td class="n">${r.o ? evCell(r.o, 1 / r.p) : ""}</td></tr>`;
  return h + `</table></div><div class="note">全部の組から上位20点。確率は5モデルの平均の勝率から Harville の式で計算。妥当なオッズ = 1 ÷ 確率(これより高いオッズなら期待値がプラス)。` +
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
  target.innerHTML = h;
  target.querySelectorAll(".tabs button").forEach(b => b.onclick = () => { state.bandTab = b.dataset.m; renderBand(target); });
}

function updateRaceStatus() {
  const bandOpen = document.getElementById("bandOpen");
  if (bandOpen) bandOpen.hidden = !state.band;
  const status = document.getElementById("status");
  if (!status) return;
  if (state.races.has(state.current)) {
    const rid = state.current;
    const date = rid.slice(0, 8);
    const fullDate = ymdw(date);
    const shortDate = fullDate.replace(/^\d{4}\//, "");
    status.innerHTML = `<span class="status-date-full">${fullDate}</span><span class="status-date-short">${shortDate}</span>　${JYO[rid.slice(8, 10)] || rid.slice(8, 10)}　${+rid.slice(14, 16)}R`;
  } else {
    status.textContent = "レースを選択してください";
  }
  status.classList.add("race-context");
  const raceReload = document.getElementById("driveReloadRace");
  if (raceReload) raceReload.disabled = !state.races.has(state.current);
}

function render(toTop = true) {
  const y = window.scrollY;
  renderNav();
  if (state.races.has(state.current)) renderRace(state.current);
  renderResult(state.current);
  updateRaceStatus();
  window.scrollTo(0, toTop ? 0 : y);
  try { sessionStorage.setItem("keiba-viewer:current", state.current ?? ""); } catch (e) {}
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
    <b>総合</b>は5つ全部(と、どこにも入らない少しの項目)の合計。予想の勝率そのものは深層学習5本の平均で、点はその理由の目安。</p>
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
    ["目安(札)", "検証期間(2019〜2023年)の同じ芝ダの値と比べた位置。ふだんから少し前が有利なので「いつもより」で言う。",
      "「いつもより外有利」なら、ふつうのレースより外の馬が来ている。"],
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
// レース一覧の開閉(このブラウザに覚えておく)
try { if (localStorage.getItem("keiba-viewer:nav-closed") === "1") document.body.classList.add("nav-closed"); } catch (e) {}
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
initializeStartup();
document.getElementById("driveReload").onclick = () => {
  if (window.confirm("全体のデータをまとめて更新します。よろしいですか？")) {
    // 取得画面のファイル名を明示して、相対URLの解決先に依存しないようにする。
    window.location.assign("./index.html");
  }
};
document.getElementById("driveReloadRace").onclick = () => {
  const rid = state.current;
  if (!state.races.has(rid)) return;
  const date = rid.slice(0, 8);
  const venue = JYO[rid.slice(8, 10)];
  const raceNo = rid.slice(14, 16);
  if (!/^\d{8}$/.test(date) || !venue || !/^\d{2}$/.test(raceNo)) {
    alert("表示中のレースを特定できませんでした。");
    return;
  }
  const raceFolder = `${venue}_${raceNo}R`;
  const params = new URLSearchParams({date, raceFolder});
  if (window.confirm(`${date.slice(0,4)}/${date.slice(4,6)}/${date.slice(6,8)} ${venue} ${+raceNo}R のデータだけを更新しますか？`)) {
    window.location.assign("./index.html?" + params.toString());
  }
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
