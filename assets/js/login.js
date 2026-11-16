"use strict";

const GOOGLE_CLIENT_ID = "585615498103-i5804umtma380k2jp4o631uu5mmj1nsb.apps.googleusercontent.com";
const DRIVE_ROOT_ID = "10mpZ9x81Q5I1FOyWS3NF9ojLsIDSTMHT";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email";
const statusEl = document.getElementById("status");
const loginButton = document.getElementById("login");
const selectionPanel = document.getElementById("selection");
const dateSelect = document.getElementById("date");
const categoryList = document.getElementById("categories");
const downloadButton = document.getElementById("download");
let tokenClient = null;
let accessToken = null;
let accountEmail = "";
let accountSelectionRequested = false;
let dateFolders = [];
let busy = false;
let lastFailedCount = 0;   // 直近の取得で取れなかったCSVの数(ビューアに知らせる)
const requestParams = new URLSearchParams(location.search);
const targetDate = requestParams.get("date") || "";
const targetRaceFolder = requestParams.get("raceFolder") || "";
const targetedRaceUpdate = /^\d{8}$/.test(targetDate) && /^.+_\d{2}R$/.test(targetRaceFolder);
// ビューアの裏で動くとき: check=1 は更新の確認だけ、auto=1 はログイン画面を出さずに取得する
const checkMode = requestParams.get("check") === "1";
const autoMode = requestParams.get("auto") === "1";
const SESSION_KEY = "drive-session";       // sessionStorage: タブを閉じると消える。トークンの期限は約1時間
const SCOPE_KEY = "drive-last-scope";      // localStorage: 前回まとめて取得した日付と種類

function status(message, loading=false) {
  statusEl.textContent = message;
  if (loading) statusEl.innerHTML = '<span class="spinner"></span>' + escapeHtml(message);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function waitForGoogleIdentity() {
  if (window.google?.accounts?.oauth2) {
    if (GOOGLE_CLIENT_ID.startsWith("ここに")) {
      status("OAuthクライアントIDが未設定です。");
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      // 初回だけ同意を求め、2回目以降はアカウント選択を表示しない。
      prompt: "",
      callback: handleTokenResponse,
      error_callback: error => {
        busy=false;
        loginButton.disabled=false;
        status("Googleログインを完了できませんでした: " + (error?.message || error?.type || "不明なエラー"));
      }
    });
    loginButton.disabled = false;
    status("Googleアカウントでログインしてください。");
  } else {
    setTimeout(waitForGoogleIdentity, 150);
  }
}
loginButton.addEventListener("click", () => {
  if (!tokenClient || busy) return;
  busy = true;
  loginButton.disabled = true;
  status("Googleログインを待っています…", true);
  // 通常の取得では既存のGoogleセッションを利用する。アカウント変更時だけ選択画面を出す。
  if (accountSelectionRequested) tokenClient.requestAccessToken({prompt:"select_account"});
  else tokenClient.requestAccessToken();
});

async function handleTokenResponse(response) {
  if (response.error || !response.access_token) {
    busy=false;
    loginButton.disabled=false;
    status("Google認証に失敗しました: " + (response.error_description || response.error || "アクセストークンを取得できませんでした"));
    return;
  }
  try {
    accessToken = response.access_token;
    accountEmail = await getAccountEmail(accessToken);
    saveSession(accessToken, accountEmail, response.expires_in);
    status("日付データを確認中…", true);
    await loadDateFolders();
    if (!dateFolders.length) throw new Error("predictions直下にYYYYMMDD形式の日付フォルダが見つかりません。");
    renderDateFolders();
    selectionPanel.hidden = false;
    // 種類を選ぶ欄は使わない(1日分をまとめて取るので。2026-11-15)
    document.querySelector(".selection-heading").hidden = true;
    categoryList.hidden = true;
    if (/^\d{8}$/.test(targetDate) && dateFolders.some(folder => folder.name === targetDate)) {
      for (const o of dateSelect.options) o.selected = o.value === targetDate;     // 「このRのデータを更新」から来たときも、その日の分をまとめて取る(まとめファイル2つで済むため)
      if (targetedRaceUpdate) {
        const note = document.getElementById("targetScopeNote");
        note.hidden = false;
        note.textContent = targetDate.slice(0,4) + "/" + targetDate.slice(4,6) + "/" + targetDate.slice(6,8) + " の分をまとめて更新します(" + targetRaceFolder + " も入ります)。";
      }
    }
    accountSelectionRequested = true;
    loginButton.textContent = "Googleアカウントを変更・再ログイン";
    status("取得する日付を選んでください。");
  } catch (error) {
    console.error(error);
    status("データ一覧情報を取得できませんでした。\n" + (error?.message || error) + "\n\n共有設定を確認してください。");
  } finally {
    busy=false;
    loginButton.disabled=false;
    // 初期チェック状態のままでも、認証処理完了後に取得ボタンを有効化する。
    updateDownloadButton();
  }
}

// PC では日付を複数選べる(Ctrl・Shift を押しながら。2026-11-16 ユーザーの指示)。携帯は1日だけ(端末に残す量を抑えるため)
function setupDateSelect() {
  if (MOBILE_DEVICE) return;
  dateSelect.multiple = true;
  dateSelect.size = Math.min(10, Math.max(4, dateFolders.length));
  dateSelect.title = "Ctrl(Mac は ⌘)を押しながらクリックで複数の日付、Shift で範囲を選べます";
  const label = document.querySelector('label[for="date"]');
  if (label) label.textContent = "日付(Ctrl・Shift を押しながらクリックで複数選べます)";
}
function selectedDates() {
  return [...dateSelect.selectedOptions].map(o => o.value).filter(Boolean);
}
function renderDateFolders() {
  setupDateSelect();
  dateSelect.replaceChildren();
  for (const folder of dateFolders) {
    const option = document.createElement("option");
    option.value = folder.name;
    option.textContent = folder.name.slice(0,4) + "/" + folder.name.slice(4,6) + "/" + folder.name.slice(6,8);
    dateSelect.appendChild(option);
  }
  if (dateSelect.options.length) dateSelect.options[0].selected = true;
  updateDownloadButton();
}
function updateDownloadButton() {
  const n = selectedDates().length;
  downloadButton.disabled = !accessToken || !n || busy;
  downloadButton.textContent = n > 1 ? "選んだ" + n + "日分のデータを取得・更新" : "この日のデータを取得・更新";
}
dateSelect.addEventListener("change", updateDownloadButton);
downloadButton.addEventListener("click", async () => {
  if (busy || !accessToken) return;
  const date = selectedDates();
  if (!date.length) return;
  busy = true;
  updateDownloadButton();
  loginButton.disabled = true;
  try {
    await fetchAndTransfer(date);
    if (window.parent !== window && new URLSearchParams(location.search).get("embedded") === "1") {
      status("取得が完了しました。ビューアに反映しています…", true);
      window.parent.postMessage({type:"drive-update-complete", failed:lastFailedCount}, location.origin);
    } else {
      location.href = "./predictions.html";
    }
  } catch (error) {
    console.error(error);
    status("データの取得に失敗しました。\n" + (error?.message || error) + "\n\n共有設定と取得対象を確認してください。");
    busy=false;
    loginButton.disabled=false;
    updateDownloadButton();
  }
});

async function fetchAndTransfer(dates) {
  lastFailedCount = 0;
  dates = (Array.isArray(dates) ? dates : [dates]).filter(Boolean);
  const date = [...dates].sort().at(-1);      // 前回取得した日付として覚えるのは一番新しい日
  const bundles = await fetchDayBundles(accessToken, accountEmail, dates);
  status("データの準備が完了しました。画面を開いています…", true);
  await saveTransfer({bundles});
  try {
    localStorage.setItem(SCOPE_KEY, JSON.stringify({date}));
    for (const d of dates) localStorage.removeItem(dismissKey(accountEmail, d));
  } catch (_) {}
}

async function loadDateFolders() {
  const children = await listChildren(DRIVE_ROOT_ID, accessToken);
  dateFolders = children
    .filter(item => item.mimeType === "application/vnd.google-apps.folder" && /^\d{8}$/.test(item.name))
    .sort((a,b) => b.name.localeCompare(a.name));
}

async function listChildren(parentId, accessToken) {
  const all=[];
  let pageToken="";
  do {
    const params=new URLSearchParams({
      q:"'" + parentId + "' in parents and trashed = false",
      pageSize:"1000",
      fields:"nextPageToken,files(id,name,mimeType,modifiedTime,size)",
      supportsAllDrives:"true",
      includeItemsFromAllDrives:"true",
      corpora:"allDrives"
    });
    if(pageToken) params.set("pageToken",pageToken);
    const response=await fetch(DRIVE_API + "?" + params,{headers:{Authorization:"Bearer " + accessToken}});
    if(!response.ok) {
      let detail="";
      try{detail=(await response.json()).error?.message||"";}catch(_){}
      const error=new Error("データ一覧情報を取得できません (" + response.status + ") " + detail);
      error.status=response.status;
      throw error;
    }
    const data=await response.json();
    all.push(...(data.files||[]));
    pageToken=data.nextPageToken||"";
  } while(pageToken);
  return all;
}

async function getAccountEmail(accessToken) {
  const response=await fetch("https://www.googleapis.com/oauth2/v3/userinfo",{headers:{Authorization:"Bearer " + accessToken}});
  if(!response.ok) throw new Error("Googleアカウント情報を取得できませんでした。再ログインしてください。");
  const data=await response.json();
  if(!data.email) throw new Error("Googleアカウントのメールアドレスを確認できませんでした。");
  return data.email.toLowerCase();
}

// ---------- 1日分のまとめファイル(2026-11-15 から) ----------
// PC が日付のフォルダに、その日の CSV を圧縮してまとめた2つ(本体とオッズ)を置く。CSV を1件ずつ(1日 200件超)取りに行くと
// 止まりやすかったので、日付のフォルダの一覧1回 + 変わったまとめファイルだけ(多くて2回)で済ませる。
// 端末には、まとめファイル(圧縮のまま。1日 1.3MB ほど)だけを残す。携帯は直近7日分だけ。
const BUNDLE_NAMES = {main:"_viewer_main.json.gz", odds:"_viewer_odds.json.gz"};
const BUNDLE_CACHE_KEY = email => "bundle-cache:" + email;

// 携帯(iPhone・iPad・Android)は、最近の日付だけを残す(2026-11-14 に、全部残して iPhone の Safari で保存が中断された)
const MOBILE_DEVICE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const MOBILE_KEEP_DAYS = 7;     // 今日を入れて7日(その週の開催日の分)。取得している日付はいつでも残す
function mobileKeepFrom() {
  const t = jstToday(), d = new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8) - (MOBILE_KEEP_DAYS - 1)));
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}
function keepDateOnDevice(day, dates) {
  return !MOBILE_DEVICE || !day || dates.includes(day) || day >= mobileKeepFrom();
}

// 日付のフォルダにあるまとめファイル {main: {id,name,modifiedTime,size}, odds: {...}}
async function listDayBundles(accessToken, date) {
  const folder = dateFolders.find(item => item.name === date);
  if (!folder) throw new Error("選択した日付フォルダが見つかりません: " + date);
  const children = await listChildren(folder.id, accessToken);
  const found = {};
  for (const [kind, name] of Object.entries(BUNDLE_NAMES)) {
    const item = children.find(x => x.name === name && x.mimeType !== "application/vnd.google-apps.folder");
    if (item) found[kind] = item;
  }
  if (!found.main) throw new Error("この日付のまとめファイル(" + BUNDLE_NAMES.main + ")がまだありません。PC の当日の処理が Drive に置くまでお待ちください。");
  return found;
}
function bundleSignature(found) {
  return Object.keys(BUNDLE_NAMES).map(kind => kind + ":" + (found[kind]?.modifiedTime || "")).join("|");
}

async function fetchDayBundles(accessToken, accountEmail, dates) {
  const cache = await loadBundleCache(accountEmail).catch(error => {
    console.warn("保存済みのまとめファイルを読み込めません。取り直します:", error);
    return {days:{}};
  });
  const days = cache.days || {};
  for (const [i, date] of dates.entries()) {
    const head = dates.length > 1 ? date.slice(4,6) + "/" + date.slice(6,8) + " (" + (i + 1) + "/" + dates.length + "日目) " : "";
    status(head + "データの更新を確認中…", true);
    const found = await listDayBundles(accessToken, date);
    const day = {};
    const kinds = Object.keys(found);
    let done = 0;
    status(head + "データを取得中… 0/" + kinds.length, true);
    for (const kind of kinds) {
      const item = found[kind], old = days[date]?.[kind];
      if (old?.blob && old.modifiedTime === item.modifiedTime && Number(old.size || 0) === Number(item.size || 0)) {
        day[kind] = old;
      } else {
        day[kind] = {modifiedTime:item.modifiedTime || "", size:Number(item.size || 0), blob:await downloadCsv(item, accessToken)};
      }
      status(head + "データを取得中… " + (++done) + "/" + kinds.length, true);
    }
    days[date] = day;
  }
  for (const d of Object.keys(days)) if (!keepDateOnDevice(d, dates)) delete days[d];
  try {
    await saveBundleCache(accountEmail, {days});
  } catch (error) {
    // 端末への保存は次の F5 を速くするためだけのもの。保存できなくても、取ったデータはそのまま出す
    console.warn("まとめファイルを端末に保存できませんでした:", error);
  }
  return Object.entries(days).sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([d, kinds]) => Object.entries(kinds).map(([kind, x]) => ({date:d, kind, modifiedTime:x.modifiedTime, blob:x.blob})));
}

// CSVを1件取る。回数制限(429・403)・Drive側の一時的なエラー(5xx)・通信の途切れは、待ってから3回までやり直す
async function downloadCsv(meta, accessToken) {
  const url=DRIVE_API + "/" + encodeURIComponent(meta.id) + "?alt=media&supportsAllDrives=true";
  let lastError=null;
  for (let attempt=0; attempt<4; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** (attempt-1) + Math.random()*500));
    let response;
    try {
      response=await fetch(url,{headers:{Authorization:"Bearer " + accessToken}});
    } catch (error) {
      lastError=error;        // 通信の途切れ
      continue;
    }
    if (response.ok) return await response.blob();
    const error=new Error("データの取得に失敗しました (" + response.status + "): " + meta.name);
    error.status=response.status;
    if (response.status !== 429 && response.status !== 403 && response.status < 500) throw error;   // 404 など、やり直しても変わらないもの
    lastError=error;
  }
  throw lastError;
}

// IndexedDB のエラー。iPhone の Safari は理由を付けずに(error が null のまま)中断することがあるので、分かる文にする
function idbError(error, what) {
  if (error && error.message) return error;
  return new Error("この端末への保存(" + what + ")が中断されました。画面を消したりほかのアプリに切り替えたりせずに、もう一度お試しください。");
}
// 書き込みが中断されたら、データベースを開き直して1回だけやり直す
async function idbRetry(fn) {
  try { return await fn(); }
  catch (error) {
    console.warn("IndexedDB への保存をやり直します:", error);
    await new Promise(resolve => setTimeout(resolve, 500));
    return await fn();
  }
}
function openTransferDb() {
  return new Promise((resolve,reject) => {
    const request=indexedDB.open("predictions-drive-transfer",1);
    request.onupgradeneeded=() => {if(!request.result.objectStoreNames.contains("payload"))request.result.createObjectStore("payload");};
    request.onsuccess=() => resolve(request.result);
    request.onerror=() => reject(idbError(request.error,"開く"));
    request.onblocked=() => reject(idbError(null,"開く"));
  });
}
async function loadBundleCache(accountEmail) {
  const db=await openTransferDb();
  try {
    return await new Promise((resolve,reject) => {
      const tx=db.transaction("payload","readwrite");
      const store=tx.objectStore("payload");
      store.delete("drive-cache:"+accountEmail);    // 前の形(CSV を1件ずつ全部の日付ぶん)。大きいので消す
      const request=store.get(BUNDLE_CACHE_KEY(accountEmail));
      let value={days:{}};
      request.onsuccess=() => { value=request.result || {days:{}}; };
      tx.oncomplete=() => resolve(value);
      tx.onerror=() => reject(idbError(tx.error,"キャッシュの読み込み"));
      tx.onabort=() => reject(idbError(tx.error,"キャッシュの読み込み"));
    });
  } finally { db.close(); }
}
async function saveBundleCache(accountEmail,value) {
  return idbRetry(() => saveBundleCacheOnce(accountEmail,value));
}
async function saveBundleCacheOnce(accountEmail,value) {
  const db=await openTransferDb();
  try {
    await new Promise((resolve,reject) => {
      const tx=db.transaction("payload","readwrite");
      tx.objectStore("payload").put({updatedAt:Date.now(),days:value.days||{}},BUNDLE_CACHE_KEY(accountEmail));
      tx.oncomplete=resolve;
      tx.onerror=() => reject(idbError(tx.error,"キャッシュ"));
      tx.onabort=() => reject(idbError(tx.error,"キャッシュ"));
    });
  } finally { db.close(); }
}
async function saveTransfer(payload) {
  return idbRetry(() => saveTransferOnce(payload));
}
async function saveTransferOnce(payload) {
  const db=await openTransferDb();
  try {
    await new Promise((resolve,reject) => {
      const tx=db.transaction("payload","readwrite");
      tx.objectStore("payload").put({createdAt:Date.now(),...payload},"pending");
      tx.oncomplete=resolve;
      tx.onerror=() => reject(idbError(tx.error,"ビューアへの受け渡し"));
      tx.onabort=() => reject(idbError(tx.error,"ビューアへの受け渡し"));
    });
  } finally { db.close(); }
}

// ---------- ビューアの裏での確認と取得 ----------
function saveSession(token, email, expiresIn) {
  const seconds = Number(expiresIn) || 3600;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({token, email, expiresAt:Date.now() + seconds*1000}));
  } catch (_) {}
}
function loadSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    return session?.token && session.expiresAt - Date.now() > 60000 ? session : null;   // 残り1分未満は切れたものとして扱う
  } catch (_) { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
}
function lastScope() {
  try { return JSON.parse(localStorage.getItem(SCOPE_KEY) || "null"); } catch (_) { return null; }
}
function dismissKey(email, date) {
  return "drive-dismissed:" + email + ":" + date;
}
function readDismissed(key) {
  try { return localStorage.getItem(key) || ""; } catch (_) { return ""; }
}
function jstToday() {
  return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Tokyo"}).format(new Date()).replaceAll("-", "");
}
function useSession() {
  const session = loadSession();
  if (!session) return false;
  accessToken = session.token;
  accountEmail = session.email;
  return true;
}

// 更新があるかだけを調べる(フォルダの一覧2回)。今日の日付フォルダがあればレース日として今日を見る。無ければ前回取得した日付を見る。
// 「いいえ」を選んだときは、その時点のまとめファイルの更新時刻を覚えておき、それより後に変わったときだけ聞く
async function checkForUpdate() {
  if (!useSession()) return {result:"login"};
  await loadDateFolders();
  const scope = lastScope();
  const today = jstToday();
  const raceDay = dateFolders.some(folder => folder.name === today);
  const date = raceDay ? today : scope?.date;
  if (!date || !dateFolders.some(folder => folder.name === date)) return {result:"none"};
  let found;
  try { found = await listDayBundles(accessToken, date); }
  catch (error) { if (error.status) throw error; return {result:"none"}; }    // まとめファイルがまだ無い
  const sig = bundleSignature(found);
  const cache = await loadBundleCache(accountEmail).catch(() => ({days:{}}));
  const have = cache.days?.[date] || {};
  const same = Object.keys(found).every(kind => have[kind]?.blob && have[kind].modifiedTime === found[kind].modifiedTime);
  if (same) return {result:"none"};
  const key = dismissKey(accountEmail, date);
  if (!raceDay && readDismissed(key) === sig) return {result:"none"};
  return {result:"update", date, categories:[], raceDay, dismissKey:key, dismissToken:sig};
}

async function runBackground() {
  document.querySelectorAll("main > :not(#status)").forEach(element => { element.hidden = true; });
  if (checkMode) {
    let result;
    try {
      result = await checkForUpdate();
    } catch (error) {
      console.warn("更新を確認できませんでした:", error);
      if (error.status === 401) clearSession();
      result = {result:error.status === 401 ? "login" : "error"};
    }
    window.parent.postMessage({type:"drive-check-result", ...result}, location.origin);
    return;
  }
  try {
    if (!useSession()) throw new Error("再ログインが必要です。");
    await loadDateFolders();
    await fetchAndTransfer(targetDate);
    status("取得が完了しました。", false);
    window.parent.postMessage({type:"drive-update-complete", failed:lastFailedCount}, location.origin);
  } catch (error) {
    console.error(error);
    status("データの取得に失敗しました。\n" + (error?.message || error));
    window.parent.postMessage({type:"drive-update-failed", message:String(error?.message || error)}, location.origin);
  }
}

if (checkMode || autoMode) runBackground();
else waitForGoogleIdentity();
