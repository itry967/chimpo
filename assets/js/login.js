"use strict";

const GOOGLE_CLIENT_ID = "585615498103-i5804umtma380k2jp4o631uu5mmj1nsb.apps.googleusercontent.com";
const DRIVE_ROOT_ID = "10mpZ9x81Q5I1FOyWS3NF9ojLsIDSTMHT";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email";
const CATEGORIES = [
  {name:"レース単位CSV", root:true},
  {name:"オッズ"},
  {name:"回顧"},
  {name:"結果"},
  {name:"推奨買い目"},
  {name:"組み合わせ"},
  {name:"払戻"}
];
const statusEl = document.getElementById("status");
const loginButton = document.getElementById("login");
const selectionPanel = document.getElementById("selection");
const dateSelect = document.getElementById("date");
const categoryList = document.getElementById("categories");
const downloadButton = document.getElementById("download");
const selectAllButton = document.getElementById("selectAll");
const clearAllButton = document.getElementById("clearAll");
let tokenClient = null;
let accessToken = null;
let accountEmail = "";
let accountSelectionRequested = false;
let dateFolders = [];
let busy = false;
const requestParams = new URLSearchParams(location.search);
const targetDate = requestParams.get("date") || "";
const targetRaceFolder = requestParams.get("raceFolder") || "";
const targetedRaceUpdate = /^\d{8}$/.test(targetDate) && /^.+_\d{2}R$/.test(targetRaceFolder);

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
    status("日付データを確認中…", true);
    const children = await listChildren(DRIVE_ROOT_ID, accessToken);
    dateFolders = children
      .filter(item => item.mimeType === "application/vnd.google-apps.folder" && /^\d{8}$/.test(item.name))
      .sort((a,b) => b.name.localeCompare(a.name));
    if (!dateFolders.length) throw new Error("predictions直下にYYYYMMDD形式の日付フォルダが見つかりません。");
    renderDateFolders();
    selectionPanel.hidden = false;
    if (targetedRaceUpdate) {
      const matchingDate = dateFolders.some(folder => folder.name === targetDate);
      if (!matchingDate) throw new Error("指定された日付フォルダが見つかりません: " + targetDate);
      dateSelect.value = targetDate;
      categoryList.querySelectorAll('input[type="checkbox"]').forEach(input => input.checked = true);
      document.querySelector("#selection h2").hidden = true;
      document.querySelector('label[for="date"]').hidden = true;
      dateSelect.hidden = true;
      document.querySelector(".selection-heading").hidden = true;
      categoryList.hidden = true;
      const note = document.getElementById("targetScopeNote");
      note.hidden = false;
      note.textContent = targetDate.slice(0,4) + "/" + targetDate.slice(4,6) + "/" + targetDate.slice(6,8) + " の " + targetRaceFolder + " のデータだけを更新します。";
      downloadButton.textContent = "このRのデータを取得・更新";
    }
    accountSelectionRequested = true;
    loginButton.textContent = "Googleアカウントを変更・再ログイン";
    status(targetedRaceUpdate ? "表示中のレースだけを更新します。" : "取得する日付とフォルダを選択してください。");
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

function renderDateFolders() {
  dateSelect.replaceChildren();
  for (const folder of dateFolders) {
    const option = document.createElement("option");
    option.value = folder.name;
    option.textContent = folder.name.slice(0,4) + "/" + folder.name.slice(4,6) + "/" + folder.name.slice(6,8);
    dateSelect.appendChild(option);
  }
  categoryList.replaceChildren();
  for (const category of CATEGORIES) {
    const label = document.createElement("label");
    label.className = "category";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = category.name;
    input.checked = true;
    const text = document.createElement("span");
    text.textContent = category.name;
    label.append(input, text);
    categoryList.appendChild(label);
  }
  updateDownloadButton();
}
function selectedCategories() {
  return [...categoryList.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
}
function updateDownloadButton() {
  downloadButton.disabled = !accessToken || !dateSelect.value || selectedCategories().length === 0 || busy;
}
categoryList.addEventListener("change", updateDownloadButton);
dateSelect.addEventListener("change", updateDownloadButton);
selectAllButton.addEventListener("click", () => {
  categoryList.querySelectorAll('input[type="checkbox"]').forEach(input => input.checked = true);
  updateDownloadButton();
});
clearAllButton.addEventListener("click", () => {
  categoryList.querySelectorAll('input[type="checkbox"]').forEach(input => input.checked = false);
  updateDownloadButton();
});
downloadButton.addEventListener("click", async () => {
  if (busy || !accessToken) return;
  const date = dateSelect.value;
  const categories = selectedCategories();
  if (!date || !categories.length) return;
  busy = true;
  updateDownloadButton();
  loginButton.disabled = true;
  try {
    const files = await fetchSelectedCsv(accessToken, accountEmail, date, categories, targetedRaceUpdate ? targetRaceFolder : "");
    if (!files.length) throw new Error("取得済みキャッシュを含め、表示できるCSVがありません。日付・フォルダを確認してください。");
    status("データの準備が完了しました。画面を開いています…", true);
    await saveTransfer(files);
    if (window.parent !== window && new URLSearchParams(location.search).get("embedded") === "1") {
      status("取得が完了しました。ビューアに反映しています…", true);
      window.parent.postMessage({type:"drive-update-complete"}, location.origin);
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
      throw new Error("データ一覧情報を取得できません (" + response.status + ") " + detail);
    }
    const data=await response.json();
    all.push(...(data.files||[]));
    pageToken=data.nextPageToken||"";
  } while(pageToken);
  return all;
}

async function collectFolder(folder, accessToken, output, visited, prefix, depth=0) {
  if(visited.has(folder.id)) return;
  if(depth>20) throw new Error("フォルダ階層が深すぎるため取得を中止しました。");
  visited.add(folder.id);
  const children=await listChildren(folder.id,accessToken);
  for(const item of children) {
    if(item.mimeType==="application/vnd.google-apps.folder") {
      await collectFolder(item,accessToken,output,visited,prefix+item.name+"/",depth+1);
    } else if(item.name?.toLowerCase().endsWith(".csv") && item.mimeType!=="application/vnd.google-apps.shortcut") {
      output.push({id:item.id,name:item.name,path:prefix+item.name,modifiedTime:item.modifiedTime||"",size:Number(item.size||0)});
      if(output.length>5000) throw new Error("選択した範囲のCSVが5,000件を超えました。取得対象を分けてください。");
    }
  }
}

async function getAccountEmail(accessToken) {
  const response=await fetch("https://www.googleapis.com/oauth2/v3/userinfo",{headers:{Authorization:"Bearer " + accessToken}});
  if(!response.ok) throw new Error("Googleアカウント情報を取得できませんでした。再ログインしてください。");
  const data=await response.json();
  if(!data.email) throw new Error("Googleアカウントのメールアドレスを確認できませんでした。");
  return data.email.toLowerCase();
}

// 日付フォルダの中のパスがどのカテゴリか。今の形は <場名>_<R2桁>R/<種類>_<年月日>_<場名>_<R2桁>R.csv(予想本体の種類は「予想」)。
// 日付フォルダ直下のCSV(レース情報.csv・自信の区分ごとの回収率.csv)と予想は「レース単位CSV」。昔の形の <種類>/… も見分ける。
const RACE_FOLDER = /^.+_\d{2}R$/;
function categoryOf(rest) {
  const parts = rest.split("/");
  if (parts.length === 1) return "レース単位CSV";
  if (parts.length === 2 && RACE_FOLDER.test(parts[0])) {
    const kind = parts[1].split("_")[0];
    return kind === "予想" ? "レース単位CSV" : kind;
  }
  return parts[0];
}

function pathIsInSelectedScope(path, date, categories) {
  const datePrefix = "predictions/" + date + "/";
  if (!path.startsWith(datePrefix)) return false;
  return categories.includes(categoryOf(path.slice(datePrefix.length)));
}

function pathIsInRaceScope(path, date, raceFolder) {
  const prefix = "predictions/" + date + "/";
  return path.startsWith(prefix) && path.slice(prefix.length).split("/")[0] === raceFolder;
}

async function listSelectedMetadata(accessToken, date, categories, raceFolder = "") {
  const dateFolder = dateFolders.find(folder => folder.name === date);
  if (!dateFolder) throw new Error("選択した日付フォルダが見つかりません。");
  const datePrefix = "predictions/" + date + "/";
  const children = await listChildren(dateFolder.id, accessToken);
  const metas = [];
  const selectedSet = new Set(categories);
  const isCsv = item => item.name?.toLowerCase().endsWith(".csv") && item.mimeType !== "application/vnd.google-apps.shortcut";
  const pushFile = (item, path) => metas.push({id:item.id,name:item.name,path,modifiedTime:item.modifiedTime||"",size:Number(item.size||0)});
  if (raceFolder) {
    const folder = children.find(item => item.mimeType === "application/vnd.google-apps.folder" && item.name === raceFolder);
    if (!folder) throw new Error("指定されたレースフォルダが見つかりません: " + raceFolder);
    const files = await listChildren(folder.id, accessToken);
    for (const item of files) {
      if (isCsv(item) && selectedSet.has(categoryOf(raceFolder + "/" + item.name))) {
        pushFile(item, datePrefix + raceFolder + "/" + item.name);
      }
    }
    return [...new Map(metas.map(item => [item.id,item])).values()];
  }
  const raceFolders = [];
  for (const item of children) {
    if (item.mimeType === "application/vnd.google-apps.folder") {
      if (RACE_FOLDER.test(item.name)) raceFolders.push(item);              // 今の形: R ごとのフォルダ
      else if (selectedSet.has(item.name) && item.name !== "レース単位CSV") {   // 昔の形: 種類ごとのフォルダ
        await collectFolder(item, accessToken, metas, new Set(), datePrefix + item.name + "/");
      }
    } else if (isCsv(item) && selectedSet.has("レース単位CSV")) {
      pushFile(item, datePrefix + item.name);
    }
  }
  // R ごとのフォルダは4つずつ並べて一覧を取り、選んだカテゴリのCSVだけ残す
  for (let i = 0; i < raceFolders.length; i += 4) {
    const batch = raceFolders.slice(i, i + 4);
    const lists = await Promise.all(batch.map(folder => listChildren(folder.id, accessToken)));
    batch.forEach((folder, j) => {
      for (const item of lists[j]) {
        const rest = folder.name + "/" + item.name;
        if (isCsv(item) && selectedSet.has(categoryOf(rest))) pushFile(item, datePrefix + rest);
      }
    });
    status("選択したデータを確認中… " + Math.min(raceFolders.length, i + 4) + "/" + raceFolders.length, true);
  }
  return [...new Map(metas.map(item => [item.id,item])).values()];
}

async function getDriveStartPageToken(accessToken) {
  const params = new URLSearchParams({fields:"startPageToken",supportsAllDrives:"true"});
  const response = await fetch("https://www.googleapis.com/drive/v3/changes/startPageToken?" + params,
    {headers:{Authorization:"Bearer " + accessToken}});
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).error?.message || ""; } catch (_) {}
    throw new Error("変更履歴の起点を取得できません (" + response.status + ") " + detail);
  }
  const data = await response.json();
  if (!data.startPageToken) throw new Error("変更履歴の起点が返されませんでした。");
  return data.startPageToken;
}

async function listDriveChanges(accessToken,startPageToken) {
  let pageToken = startPageToken;
  let hasChanges = false;
  let newStartPageToken = "";
  do {
    const params = new URLSearchParams({
      pageToken,
      pageSize:"1000",
      fields:"nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,size,parents,trashed))",
      supportsAllDrives:"true",
      includeItemsFromAllDrives:"true"
    });
    const response = await fetch("https://www.googleapis.com/drive/v3/changes?" + params,
      {headers:{Authorization:"Bearer " + accessToken}});
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).error?.message || ""; } catch (_) {}
      const error = new Error("変更履歴を取得できません (" + response.status + ") " + detail);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    if ((data.changes || []).length) hasChanges = true;
    pageToken = data.nextPageToken || "";
    if (data.newStartPageToken) newStartPageToken = data.newStartPageToken;
  } while (pageToken);
  return {hasChanges,newStartPageToken};
}

async function fetchSelectedCsv(accessToken, accountEmail, date, categories, raceFolder = "") {
  status("データ変更履歴を確認中…",true);
  const cache = await loadDriveCache(accountEmail).catch(error => {
    console.warn("Drive CSVキャッシュを読み込めません。選択範囲を再取得します:",error);
    return {files:[],scannedScopes:[],changePageToken:""};
  });
  const cachedFiles = cache.files || [];
  let changePageToken = cache.changePageToken || "";
  let hasDriveChanges = true;
  if (changePageToken) {
    try {
      const changes = await listDriveChanges(accessToken,changePageToken);
      changePageToken = changes.newStartPageToken || changePageToken;
      hasDriveChanges = changes.hasChanges;
    } catch (error) {
      if (error.status === 410) {
        // トークン期限切れ。新しい起点を取り直して、選択範囲を全件確認する。
        changePageToken = await getDriveStartPageToken(accessToken);
      } else {
        // changes.list が一時的に使えない場合も、従来のフォルダ走査で取得を続ける。
        console.warn("Drive変更履歴を利用できないため、フォルダ一覧を確認します:",error);
      }
      hasDriveChanges = true;
    }
  } else {
    // 初回だけ起点を先に記録。走査中に発生した変更は次回の changes.list で拾う。
    changePageToken = await getDriveStartPageToken(accessToken);
    hasDriveChanges = true;
  }

  const scopeKeys = categories.map(category => raceFolder ? date + "|" + raceFolder + "|" + category : date + "|" + category);
  const scopeReady = scopeKeys.every(key => (cache.scannedScopes || []).includes(key));
  const canUseCache = !hasDriveChanges && scopeReady;
  let metas;
  let scannedScopes;
  if (canUseCache) {
    status("変更なし。保存済みCSVを使用します…",true);
    metas = cachedFiles.filter(item => raceFolder ? pathIsInRaceScope(item.path||"",date,raceFolder) : pathIsInSelectedScope(item.path||"",date,categories));
    scannedScopes = cache.scannedScopes || [];
  } else {
    status("選択したデータを確認中…",true);
    metas = await listSelectedMetadata(accessToken,date,categories,raceFolder);
    // changes.list はユーザー全体の変更履歴なので、変更があれば他の日付の確認済み状態も無効化する。
    scannedScopes = hasDriveChanges ? [] : (cache.scannedScopes || []);
    for (const key of scopeKeys) if (!scannedScopes.includes(key)) scannedScopes.push(key);
  }

  if (raceFolder && !metas.length) throw new Error("指定したレースフォルダにCSVがありません: " + raceFolder);

  const cachedById = new Map(cachedFiles.map(item => [item.id,item]));
  const retained = cachedFiles.filter(item => !(raceFolder ? pathIsInRaceScope(item.path||"",date,raceFolder) : pathIsInSelectedScope(item.path||"",date,categories)));
  const unchanged = [];
  const toDownload = [];
  for (const meta of metas) {
    const old = cachedById.get(meta.id);
    if (old?.blob && meta.modifiedTime && old.modifiedTime===meta.modifiedTime && Number(old.size||0)===Number(meta.size||0)) {
      unchanged.push({...meta,blob:old.blob});
    } else {
      toDownload.push(meta);
    }
  }

  const downloaded = [];
  status("データを取得中… " + (toDownload.length ? 0 : 100) + "%",true);
  for (let i=0;i<toDownload.length;i+=4) {
    const batch=toDownload.slice(i,i+4);
    const blobs=await Promise.all(batch.map(async meta => {
      const url=DRIVE_API + "/" + encodeURIComponent(meta.id) + "?alt=media&supportsAllDrives=true";
      const response=await fetch(url,{headers:{Authorization:"Bearer " + accessToken}});
      if(!response.ok) throw new Error("データの取得に失敗しました (" + response.status + "): " + meta.name);
      return {...meta,blob:await response.blob()};
    }));
    downloaded.push(...blobs);
    const percent=Math.min(100,Math.round(downloaded.length/toDownload.length*100));
    status("データを取得中… " + percent + "%",true);
  }

  const merged = [...retained,...unchanged,...downloaded];
  const result = [...new Map(merged.map(item => [item.id,item])).values()]
    .sort((a,b) => (a.path||"").localeCompare(b.path||""));
  await saveDriveCache(accountEmail,result,{changePageToken,scannedScopes});
  status("取得データをまとめています…",true);
  return result;
}

function openTransferDb() {
  return new Promise((resolve,reject) => {
    const request=indexedDB.open("predictions-drive-transfer",1);
    request.onupgradeneeded=() => {if(!request.result.objectStoreNames.contains("payload"))request.result.createObjectStore("payload");};
    request.onsuccess=() => resolve(request.result);
    request.onerror=() => reject(request.error);
  });
}
async function loadDriveCache(accountEmail) {
  const db=await openTransferDb();
  try {
    return await new Promise((resolve,reject) => {
      const tx=db.transaction("payload","readonly");
      const request=tx.objectStore("payload").get("drive-cache:"+accountEmail);
      request.onsuccess=() => resolve(request.result || {files:[],scannedScopes:[],changePageToken:""});
      request.onerror=() => reject(request.error);
    });
  } finally { db.close(); }
}
async function saveDriveCache(accountEmail,files,extra={}) {
  const db=await openTransferDb();
  try {
    await new Promise((resolve,reject) => {
      const tx=db.transaction("payload","readwrite");
      tx.objectStore("payload").put({updatedAt:Date.now(),files,
        changePageToken:extra.changePageToken||"",scannedScopes:extra.scannedScopes||[]},"drive-cache:"+accountEmail);
      tx.oncomplete=resolve;
      tx.onerror=() => reject(tx.error);
      tx.onabort=() => reject(tx.error);
    });
  } finally { db.close(); }
}
async function saveTransfer(files) {
  const db=await openTransferDb();
  try {
    await new Promise((resolve,reject) => {
      const tx=db.transaction("payload","readwrite");
      tx.objectStore("payload").put({createdAt:Date.now(),files},"pending");
      tx.oncomplete=resolve;
      tx.onerror=() => reject(tx.error);
      tx.onabort=() => reject(tx.error);
    });
  } finally { db.close(); }
}

waitForGoogleIdentity();
