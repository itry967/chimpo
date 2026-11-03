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
let dateFolders = [];
let busy = false;

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
  tokenClient.requestAccessToken({prompt:"select_account"});
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
    status("日付フォルダを確認中…", true);
    const children = await listChildren(DRIVE_ROOT_ID, accessToken);
    dateFolders = children
      .filter(item => item.mimeType === "application/vnd.google-apps.folder" && /^\d{8}$/.test(item.name))
      .sort((a,b) => b.name.localeCompare(a.name));
    if (!dateFolders.length) throw new Error("predictions直下にYYYYMMDD形式の日付フォルダが見つかりません。");
    renderDateFolders();
    selectionPanel.hidden = false;
    loginButton.textContent = "Googleアカウントを変更・再ログイン";
    status("取得する日付とフォルダを選択してください。");
  } catch (error) {
    console.error(error);
    status("Driveのフォルダ一覧を取得できませんでした。\n" + (error?.message || error) + "\n\n共有設定を確認してください。");
  } finally {
    busy=false;
    loginButton.disabled=false;
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
    const files = await fetchSelectedCsv(accessToken, accountEmail, date, categories);
    if (!files.length) throw new Error("取得済みキャッシュを含め、表示できるCSVがありません。日付・フォルダを確認してください。");
    status("データの準備が完了しました。画面を開いています…", true);
    await saveTransfer(files);
    location.href = "./predictions.html";
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
      throw new Error("Driveのフォルダ一覧を取得できません (" + response.status + ") " + detail);
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

function pathIsInSelectedScope(path, date, categories) {
  const datePrefix = "predictions/" + date + "/";
  if (!path.startsWith(datePrefix)) return false;
  const rest = path.slice(datePrefix.length);
  return categories.some(category => {
    if (category === "レース単位CSV") return !rest.includes("/");
    return rest.startsWith(category + "/");
  });
}

async function listSelectedMetadata(accessToken, date, categories) {
  const dateFolder = dateFolders.find(folder => folder.name === date);
  if (!dateFolder) throw new Error("選択した日付フォルダが見つかりません。");
  const datePrefix = "predictions/" + date + "/";
  const children = await listChildren(dateFolder.id, accessToken);
  const metas = [];
  const selectedSet = new Set(categories);
  for (const item of children) {
    if (item.mimeType === "application/vnd.google-apps.folder") {
      if (selectedSet.has(item.name) && item.name !== "レース単位CSV") {
        await collectFolder(item, accessToken, metas, new Set(), datePrefix + item.name + "/");
      }
    } else if (item.name?.toLowerCase().endsWith(".csv") && selectedSet.has("レース単位CSV") &&
               item.mimeType !== "application/vnd.google-apps.shortcut") {
      metas.push({id:item.id,name:item.name,path:datePrefix+item.name,modifiedTime:item.modifiedTime||"",size:Number(item.size||0)});
    }
  }
  return [...new Map(metas.map(item => [item.id,item])).values()];
}

async function fetchSelectedCsv(accessToken, accountEmail, date, categories) {
  status("選択したフォルダを確認中…",true);
  const metas = await listSelectedMetadata(accessToken,date,categories);
  const cachedFiles = await loadDriveCache(accountEmail).catch(error => {
    console.warn("Drive CSVキャッシュを読み込めませんでした。選択範囲を再取得します:",error);
    return [];
  });
  const cachedById = new Map(cachedFiles.map(item => [item.id,item]));
  const retained = cachedFiles.filter(item => !pathIsInSelectedScope(item.path||"",date,categories));
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
  await saveDriveCache(accountEmail,result);
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
      request.onsuccess=() => resolve(request.result?.files||[]);
      request.onerror=() => reject(request.error);
    });
  } finally { db.close(); }
}
async function saveDriveCache(accountEmail,files) {
  const db=await openTransferDb();
  try {
    await new Promise((resolve,reject) => {
      const tx=db.transaction("payload","readwrite");
      tx.objectStore("payload").put({updatedAt:Date.now(),files},"drive-cache:"+accountEmail);
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
