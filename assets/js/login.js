
"use strict";

// Google Cloud Consoleで作成した「ウェブアプリケーション」OAuthクライアントIDに置き換える。
const GOOGLE_CLIENT_ID = "585615498103-i5804umtma380k2jp4o631uu5mmj1nsb.apps.googleusercontent.com";

// 共有された3つの親フォルダ。①は直下のYYYYMMDDフォルダから取得し、②③は直下から再帰取得。
const DRIVE_ROOT_ID = "10mpZ9x81Q5I1FOyWS3NF9ojLsIDSTMHT"; // predictions フォルダ
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email";
const statusEl = document.getElementById("status");
const loginButton = document.getElementById("login");
let tokenClient = null;
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
      status("OAuthクライアントIDが未設定です。index.html内の GOOGLE_CLIENT_ID を設定してください。");
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: handleTokenResponse,
      error_callback: error => { busy=false; loginButton.disabled=false; status("Googleログインを完了できませんでした: " + (error?.message || error?.type || "不明なエラー")); }
    });
    loginButton.disabled = false;
    status("準備完了。共有されたGoogleアカウントでログインしてください。");
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
    busy=false; loginButton.disabled=false;
    status("Google認証に失敗しました: " + (response.error_description || response.error || "アクセストークンを取得できませんでした"));
    return;
  }
  try {
    const files = await fetchAllCsv(response.access_token);
    if (!files.length) throw new Error("共有フォルダ内にCSVが見つかりませんでした。");
    status(`CSV ${files.length}件を画面へ渡しています…`, true);
    await saveTransfer(files);
    location.href = "./predictions.html";
  } catch (error) {
    console.error(error);
    status("CSV取得に失敗しました。\n" + (error?.message || error) + "\n\n3つのフォルダがこのGoogleアカウントに閲覧者として共有されているか確認してください。");
    busy=false; loginButton.disabled=false;
  }
}

async function listChildren(parentId, accessToken) {
  const all=[]; let pageToken="";
  do {
    const params=new URLSearchParams({
      q:`'${parentId}' in parents and trashed = false`,
      pageSize:"1000",
      fields:"nextPageToken,files(id,name,mimeType,modifiedTime,size)",
      supportsAllDrives:"true",
      includeItemsFromAllDrives:"true",
      corpora:"allDrives"
    });
    if(pageToken) params.set("pageToken",pageToken);
    const response=await fetch(`${DRIVE_API}?${params}`,{headers:{Authorization:`Bearer ${accessToken}`}});
    if(!response.ok) {
      let detail=""; try{detail=(await response.json()).error?.message||"";}catch(_){}
      throw new Error(`Driveのフォルダ一覧を取得できません (${response.status}) ${detail}`);
    }
    const data=await response.json();
    all.push(...(data.files||[])); pageToken=data.nextPageToken||"";
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
      if(output.length>5000) throw new Error("CSVが5,000件を超えました。取得対象フォルダを確認してください。");
    }
  }
}

async function getAccountEmail(accessToken) {
  const response=await fetch("https://www.googleapis.com/oauth2/v3/userinfo",{headers:{Authorization:`Bearer ${accessToken}`}});
  if(!response.ok) throw new Error("Googleアカウント情報を取得できませんでした。再ログインして確認してください。");
  const data=await response.json();
  if(!data.email) throw new Error("Googleアカウントのメールアドレスを確認できませんでした。");
  return data.email.toLowerCase();
}

async function fetchAllCsv(accessToken) {
  const accountEmail=await getAccountEmail(accessToken);
  const metas=[]; const visited=new Set();
  status("predictions フォルダ以下を確認中…",true);
  await collectFolder(
    {id:DRIVE_ROOT_ID,name:"predictions"},
    accessToken,
    metas,
    visited,
    "predictions/"
  );

  const unique=[...new Map(metas.map(x=>[x.id,x])).values()];
  const cachedFiles=await loadDriveCache(accountEmail).catch(error=>{
    console.warn("Drive CSVキャッシュを読み込めませんでした。全件取得します:",error);
    return [];
  });
  const cachedById=new Map(cachedFiles.map(item=>[item.id,item]));
  const unchanged=[];
  const toDownload=[];
  for(const meta of unique) {
    const old=cachedById.get(meta.id);
    if(old?.blob && meta.modifiedTime && old.modifiedTime===meta.modifiedTime && Number(old.size||0)===Number(meta.size||0)) {
      unchanged.push({...meta,blob:old.blob});
    } else {
      toDownload.push(meta);
    }
  }

  const downloaded=[];
  for(let i=0;i<toDownload.length;i+=4) {
    const batch=toDownload.slice(i,i+4);
    const blobs=await Promise.all(batch.map(async meta=>{
      const url=`${DRIVE_API}/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`;
      const response=await fetch(url,{headers:{Authorization:`Bearer ${accessToken}`}});
      if(!response.ok) throw new Error(`${meta.path} の取得に失敗しました (${response.status})`);
      return {...meta,blob:await response.blob()};
    }));
    downloaded.push(...blobs);
    status(`更新CSVを取得中… ${downloaded.length}/${toDownload.length}件（変更なし ${unchanged.length}件）`,true);
  }

  const result=[...unchanged,...downloaded].sort((a,b)=>a.path.localeCompare(b.path));
  // 現在Driveに存在するファイルだけを書き戻し、削除済みCSVはキャッシュから除外する。
  await saveDriveCache(accountEmail,result).catch(error=>{
    console.warn("Drive CSVキャッシュを保存できませんでした:",error);
  });
  status(`CSV一覧を確認しました。新規・更新 ${downloaded.length}件、キャッシュ再利用 ${unchanged.length}件`,true);
  return result;
}

function openTransferDb() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open("predictions-drive-transfer",1);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains("payload"))request.result.createObjectStore("payload");};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function loadDriveCache(accountEmail) {
  const db=await openTransferDb();
  try {
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction("payload","readonly");
      const request=tx.objectStore("payload").get("drive-cache:"+accountEmail);
      request.onsuccess=()=>resolve(request.result?.files||[]);
      request.onerror=()=>reject(request.error);
    });
  } finally { db.close(); }
}
async function saveDriveCache(accountEmail,files) {
  const db=await openTransferDb();
  try {
    await new Promise((resolve,reject)=>{
      const tx=db.transaction("payload","readwrite");
      tx.objectStore("payload").put({updatedAt:Date.now(),files},"drive-cache:"+accountEmail);
      tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error);
    });
  } finally { db.close(); }
}

async function saveTransfer(files) {
  const db=await openTransferDb();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction("payload","readwrite");
    tx.objectStore("payload").put({createdAt:Date.now(),files},"pending");
    tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error);
  });
  db.close();
}

waitForGoogleIdentity();
