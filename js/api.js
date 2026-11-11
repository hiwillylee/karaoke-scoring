// api.js — 與伺服器曲庫溝通。
//
// 曲庫存在跑伺服器的那台電腦上，這支模組負責取清單、依需求抓音軌，
// 以及把抓下來的音軌快取在本機（同一首歌重唱時就不必再抓一次）。

import * as store from './storage.js';

async function json(url, options) {
  const res = await fetch(url, { cache: 'no-store', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `伺服器回應 ${res.status}`);
  return data;
}

const post = (url, body) => json(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---- 曲庫 -----------------------------------------------------------------

/** 整份曲庫清單。搜尋在前端做（清單本來就在手上，不必每打一個字問一次伺服器）。 */
export async function listSongs() {
  const data = await json('api/songs');
  lastArtists = data.artists || [];
  return data.songs || [];
}

let lastArtists = [];
/** 上一次 listSongs 一起帶回來的歌手清單（{name, count}，依歌數排序）。 */
export const artists = () => lastArtists;

export const getSong = (id) => json(`api/song?id=${encodeURIComponent(id)}&kind=meta`);

// 譜面很大（一首幾百 KB），讓瀏覽器用 ETag 重新驗證，沒變就回 304
export async function getChart(id) {
  const res = await fetch(`api/song?id=${encodeURIComponent(id)}&kind=chart`, { cache: 'no-cache' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `伺服器回應 ${res.status}`);
  return data;
}

// ---- 封面 -----------------------------------------------------------------

/** 封面網址；沒有封面回傳 null。meta.cover 是封面的版本（換了封面網址才會變，快取才會更新）。 */
export const coverUrl = (song) =>
  (song?.cover ? `api/song?id=${encodeURIComponent(song.id)}&kind=cover&v=${song.cover}` : null);

/** 曲庫卡片用的小封面（伺服器縮成正方形）。 */
export const thumbUrl = (song) =>
  (song?.cover ? `api/song?id=${encodeURIComponent(song.id)}&kind=thumb&v=${song.cover}` : null);

/** 上傳封面圖片（jpg/png/webp），回傳更新後的 meta。 */
export const uploadCover = (id, file) => json(`api/song/cover?id=${encodeURIComponent(id)}`, {
  method: 'POST',
  headers: { 'Content-Type': file.type || 'application/octet-stream' },
  body: file,
});

/** 重新自動找封面（YT Music 專輯封面 → 影片縮圖）。 */
export const refetchCover = (id) => json('api/song/cover/refetch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id }),
});

// ---- 歌詞 -----------------------------------------------------------------

/** 這首歌的歌詞；還沒抓過回傳 null。 */
export async function getLyrics(id) {
  const res = await fetch(`api/song?id=${encodeURIComponent(id)}&kind=lyrics`, { cache: 'no-store' });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `伺服器回應 ${res.status}`);
  return data;
}

/** 自動抓（YT Music → LRCLIB → YouTube 字幕）；title／artist 可指定搜尋用的歌名歌手。 */
export const fetchLyrics = (id, title = '', artist = '') =>
  post('api/lyrics/fetch', { id, title, artist });

export const uploadLyrics = (id, lrc, name) => post('api/lyrics/upload', { id, lrc, name });

export const lyricsFromUrl = (id, url) => post('api/lyrics/url', { id, url });

export const setLyricsOffset = (id, offsetMs) => post('api/lyrics/offset', { id, offsetMs });

export const deleteLyrics = (id) => post('api/lyrics/delete', { id });

export const saveSongSettings = (id, settings) => post('api/song/settings', { id, ...settings });

export async function deleteSong(id) {
  await post('api/song/delete', { id });
  await store.dropCachedAudio(id);
}

// ---- 成績與延遲設定檔（存在伺服器上） ---------------------------------------

export const getScores = (id) =>
  json(`api/scores?id=${encodeURIComponent(id)}`).then((d) => d.scores || []);

/** 存一筆成績，回傳更新後的歌曲 meta（含最佳分、演唱次數）。 */
export const saveScore = (id, record) => post('api/scores', { id, record: { ...record, date: Date.now() } });

export const importScores = (items) => post('api/scores/import', { items });

export const getLatencyProfiles = () => json('api/latency').then((d) => d.profiles || []);

export const saveLatencyProfile = (profile) => post('api/latency', { profile });

export const deleteLatencyProfile = (id) => post('api/latency/delete', { id });

/**
 * 取得音軌。這是「點進去才下載到手機」的實作：曲庫畫面只有中繼資料，
 * 真正的音檔要到這裡才會抓，抓完存進本機快取。
 *
 * @param onProgress 收到的位元組數 / 總位元組數
 * @returns { blob, etag }：etag 是版本，解碼後的緩衝用它當快取鍵
 */
export async function getStem(songId, kind, onProgress = null) {
  const url = `api/song?id=${encodeURIComponent(songId)}&kind=${kind}`;

  // 帶著本機快取的版本去問，沒變的話伺服器回 304，一趟往返就結束。
  // cache: 'no-store'：音軌已經存在 IndexedDB 了，不要再讓瀏覽器的 HTTP
  // 快取另外存一份同樣大小的副本。
  const entry = await store.cachedAudioEntry(songId, kind);
  let res;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      headers: entry?.etag ? { 'If-None-Match': entry.etag } : {},
    });
  } catch {
    // 連不上伺服器但本機有快取：照樣能唱
    if (entry?.blob) { onProgress?.(1, 1, true); return { blob: entry.blob, etag: entry.etag }; }
    throw new Error('連不上伺服器，無法取得音軌');
  }

  if (res.status === 304 && entry?.blob) {
    onProgress?.(1, 1, true);
    return { blob: entry.blob, etag: entry.etag };
  }
  if (!res.ok) throw new Error(`下載音軌失敗（${res.status}）`);
  const etag = res.headers.get('ETag') || '';

  const total = Number(res.headers.get('Content-Length')) || 0;
  let blob;
  if (res.body && total && onProgress) {
    const reader = res.body.getReader();
    const chunks = [];
    let done = 0;
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      chunks.push(value);
      done += value.length;
      onProgress(done, total, false);
    }
    blob = new Blob(chunks, { type: res.headers.get('Content-Type') || 'audio/mp4' });
  } else {
    blob = await res.blob();
  }

  // 存不進快取（配額滿、私密模式）不影響這次使用
  await store.cacheAudio(songId, kind, etag, blob);
  return { blob, etag };
}

// ---- 從網址取得歌曲 --------------------------------------------------------

/** 先問「這個網址的歌是不是已經下載過了」，不會真的下載。 */
export const resolveUrl = (url) =>
  json(`api/resolve?url=${encodeURIComponent(url)}`);

/** 開始下載並分析。若已存在，回傳的 existing 就是既有那首歌。 */
export const fetchUrl = (url) => post('api/fetch', { url });

/**
 * 上傳音檔。用 XMLHttpRequest 而不是 fetch：fetch 拿不到上傳進度，
 * 手機傳幾十 MB 的檔案時畫面會像當掉一樣。
 */
export function uploadFile(file, onProgress = null, url = 'api/analyze') {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* 不是 JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `伺服器回應 ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('上傳時連線中斷'));
    xhr.send(file);
  });
}

/** 進行中與剛結束的工作。 */
export const listJobs = () => json('api/jobs').then((d) => d.jobs || []);

export const cancelJob = (id) => post('api/jobs/cancel', { id });

/** 從備份 zip 還原曲庫（只限這台電腦）。 */
export const restoreLibrary = (file, onProgress) => uploadFile(file, onProgress, 'api/restore');

export const serverInfoFull = () => json('api/info?full=1');

export const serverInfo = () => json('api/info');

// ---- 顯示卡加速包（只有這台電腦能操作） -------------------------------------

export const gpuStatus = () => json('api/gpu');
export const gpuAction = (action) => json(`api/gpu/${action}`, { method: 'POST' });

export const saveServerSettings = (patch) => post('api/settings', patch);

/** 請伺服器重新啟動自己，等新的那份起來後才回傳。 */
export async function restartApp() {
  // 用行程編號分辨新舊：舊的那份收尾期間可能還會回應
  const oldPid = (await json('api/info').catch(() => ({}))).pid;
  try {
    await json('api/restart', { method: 'POST' });
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;   // 連線中斷＝已經在關了
  }
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const info = await json('api/info').catch(() => null);
    if (info && info.pid !== oldPid) return;
  }
  throw new Error('等了 90 秒程式還沒重新啟動，請手動開啟');
}

/**
 * 請伺服器關掉自己。
 *
 * 伺服器是先回覆再結束行程，但關閉的時機仍可能讓連線在收到回應前就斷掉，
 * 所以連線錯誤要當成「關成功了」，不是失敗。
 */
export async function quitApp() {
  try {
    await json('api/quit', { method: 'POST' });
  } catch (err) {
    if (err instanceof TypeError) return;   // 連線中斷＝行程已經結束
    throw err;
  }
}
