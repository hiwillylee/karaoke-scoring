// storage.js — 這台裝置自己的 IndexedDB。
//
// 只放「跟這台裝置有關」的東西：抓過的音軌快取，以及外觀、歌詞顯示這類
// 個人偏好。成績與延遲設定檔改存在伺服器上（瀏覽器的儲存空間是跟著網址
// 走的，localhost、內網 https、每次都換的公開網址各算一份，存在這裡的話
// 換個網址進來就全部歸零）。舊版留在這裡的成績會在開頁時搬過去。

const DB_NAME = 'karaoke-scoring';
const DB_VERSION = 2;

// 音軌快取的上限。手機的配額常常只有幾百 MB，超過就先丟最久沒用的。
export const CACHE_LIMIT_BYTES = 400 * 1024 * 1024;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 的 songs 存放整首歌的音檔。曲庫改成存在伺服器端之後，
      // 這裡只保留「這台裝置抓過的音軌」當快取，避免每次演唱都重抓。
      if (db.objectStoreNames.contains('songs')) {
        db.deleteObjectStore('songs');
      }
      if (!db.objectStoreNames.contains('audioCache')) {
        db.createObjectStore('audioCache', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('scores')) {
        const store = db.createObjectStore('scores', { keyPath: 'id', autoIncrement: true });
        store.createIndex('songId', 'songId');
      }
      if (!db.objectStoreNames.contains('latency')) {
        db.createObjectStore('latency', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Safari 私密模式等情況：open 一直不回應。逾時當作不能用。
    setTimeout(() => reject(new Error('IndexedDB 無法使用')), 4000);
  });
  dbPromise.catch(() => {});
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
export const remove = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

// ---- 音軌快取 --------------------------------------------------------------
// 曲庫在伺服器上，但同一首歌在同一台裝置上重唱時不該每次都重抓。
// 用伺服器回的 ETag 當版本，歌曲被重新分析過就會自動失效。
//
// 快取是「有最好、沒有也行」：讀寫失敗（配額滿、私密模式）一律吞掉，
// 絕不能讓已經下載好的音軌因為存不進快取而整個作廢。

export async function cachedAudioEntry(songId, kind) {
  try {
    const entry = await get('audioCache', `${songId}:${kind}`);
    if (entry) {
      // 記下最後使用時間，滿了的時候先丟最久沒唱的
      put('audioCache', { ...entry, usedAt: Date.now() }).catch(() => {});
    }
    return entry;
  } catch {
    return null;
  }
}

/** 存一份音軌。成功回傳 true；存不進去回傳 false（呼叫端照常使用 blob）。 */
export async function cacheAudio(songId, kind, etag, blob) {
  const row = { key: `${songId}:${kind}`, songId, kind, etag, blob,
                cachedAt: Date.now(), usedAt: Date.now() };
  try {
    await evictFor(blob.size);
    await put('audioCache', row);
    return true;
  } catch {
    // 多半是配額滿了：清掉一半再試一次，還是不行就算了
    try {
      await evictFor(blob.size, 0.5);
      await put('audioCache', row);
      return true;
    } catch {
      return false;
    }
  }
}

/** 騰出空間：總量加上這次要存的超過上限（或指定比例）時，從最久沒用的開始丟。 */
async function evictFor(incoming, keepRatio = 1) {
  const rows = await getAll('audioCache');
  let total = rows.reduce((n, r) => n + (r.blob?.size || 0), 0);
  const limit = CACHE_LIMIT_BYTES * keepRatio;
  if (total + incoming <= limit) return;
  rows.sort((a, b) => (a.usedAt || a.cachedAt || 0) - (b.usedAt || b.cachedAt || 0));
  for (const r of rows) {
    if (total + incoming <= limit) break;
    await remove('audioCache', r.key);
    total -= r.blob?.size || 0;
  }
}

export async function dropCachedAudio(songId) {
  try {
    const rows = await getAll('audioCache');
    await Promise.all(rows.filter((r) => r.songId === songId)
                          .map((r) => remove('audioCache', r.key)));
  } catch { /* 快取不能用就沒什麼好清的 */ }
}

export async function cacheSize() {
  try {
    const rows = await getAll('audioCache');
    return rows.reduce((n, r) => n + (r.blob?.size || 0), 0);
  } catch {
    return 0;
  }
}

export async function clearAudioCache() {
  try {
    const rows = await getAll('audioCache');
    await Promise.all(rows.map((r) => remove('audioCache', r.key)));
  } catch { /* 同上 */ }
}

// ---- 舊版資料（搬到伺服器用） ---------------------------------------------

/** 舊版存在這台瀏覽器裡的成績與延遲設定檔。搬完就清掉。 */
export async function legacyData() {
  try {
    const [scores, latency] = await Promise.all([getAll('scores'), getAll('latency')]);
    return { scores: scores || [], latency: latency || [] };
  } catch {
    return { scores: [], latency: [] };
  }
}

export async function clearLegacyData() {
  try {
    await tx('scores', 'readwrite', (s) => s.clear());
    await tx('latency', 'readwrite', (s) => s.clear());
  } catch { /* 清不掉也沒關係，有旗標記著搬過了 */ }
}

// ---- 設定 ----------------------------------------------------------------
//
// IndexedDB 不能用時退回 localStorage，再不行就只存在記憶體裡（重開就沒了，
// 但至少這次能用）。

const memory = new Map();

export async function getSetting(key, fallback = null) {
  try {
    const row = await get('settings', key);
    if (row) return row.value;
  } catch {
    try {
      const raw = localStorage.getItem(`setting:${key}`);
      if (raw !== null) return JSON.parse(raw);
    } catch { /* 都不能用 */ }
  }
  return memory.has(key) ? memory.get(key) : fallback;
}

export async function setSetting(key, value) {
  memory.set(key, value);
  try {
    await put('settings', { key, value });
  } catch {
    try { localStorage.setItem(`setting:${key}`, JSON.stringify(value)); } catch { /* 只存在記憶體 */ }
  }
}
