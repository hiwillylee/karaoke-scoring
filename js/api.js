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

// ---- 曲庫 -----------------------------------------------------------------

export async function listSongs(query = '') {
  const url = query ? `api/songs?q=${encodeURIComponent(query)}` : 'api/songs';
  const data = await json(url);
  return data.songs || [];
}

export const getSong = (id) => json(`api/song?id=${encodeURIComponent(id)}&kind=meta`);

export const getChart = (id) => json(`api/song?id=${encodeURIComponent(id)}&kind=chart`);

export async function saveSongSettings(id, settings) {
  return json('api/song/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...settings }),
  });
}

export async function deleteSong(id) {
  await json('api/song/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  await store.forgetSong(id);
}

/**
 * 取得音軌。這是「點進去才下載到手機」的實作：曲庫畫面只有中繼資料，
 * 真正的音檔要到這裡才會抓，抓完存進本機快取。
 *
 * @param onProgress 收到的位元組數 / 總位元組數
 */
export async function getStem(songId, kind, onProgress = null) {
  const url = `api/song?id=${encodeURIComponent(songId)}&kind=${kind}`;

  // 帶著本機快取的版本去問，沒變的話伺服器回 304，一趟往返就結束
  const entry = await store.cachedAudioEntry(songId, kind);
  const res = await fetch(url, {
    headers: entry?.etag ? { 'If-None-Match': entry.etag } : {},
  });

  if (res.status === 304 && entry?.blob) {
    onProgress?.(1, 1, true);
    return entry.blob;
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

  await store.cacheAudio(songId, kind, etag, blob);
  return blob;
}

// ---- 從網址取得歌曲 --------------------------------------------------------

/** 先問「這個網址的歌是不是已經下載過了」，不會真的下載。 */
export const resolveUrl = (url) =>
  json(`api/resolve?url=${encodeURIComponent(url)}`);

/** 開始下載並分析。若已存在，回傳的 existing 就是既有那首歌。 */
export const fetchUrl = (url) =>
  json('api/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

export async function uploadFile(file) {
  return json('api/analyze', {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
}

/** 追蹤一件工作的進度，完成時回傳最後的狀態（含 songId）。 */
export function trackJob(jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(`api/progress?id=${jobId}`);
    es.onmessage = (e) => {
      const job = JSON.parse(e.data);
      onProgress?.(job);
      if (job.state === 'done') { es.close(); resolve(job); }
      if (job.state === 'error') { es.close(); reject(new Error(job.message)); }
    };
    es.onerror = () => { es.close(); reject(new Error('進度連線中斷')); };
  });
}

export const serverInfo = () => json('api/info');

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
