// storage.js — IndexedDB 曲庫。
// 音軌以 Blob 存（localStorage 5MB 上限放不下），分析結果、成績與
// 延遲設定檔也一併放這裡，關掉後端也能繼續唱。

const DB_NAME = 'karaoke-scoring';
const DB_VERSION = 2;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
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
  });
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

export const cachedAudioEntry = (songId, kind) => get('audioCache', `${songId}:${kind}`);

export async function cacheAudio(songId, kind, etag, blob) {
  await put('audioCache', { key: `${songId}:${kind}`, songId, kind, etag, blob,
                            cachedAt: Date.now() });
}

export async function dropCachedAudio(songId) {
  const rows = await getAll('audioCache');
  await Promise.all(rows.filter((r) => r.songId === songId)
                        .map((r) => remove('audioCache', r.key)));
}

export async function cacheSize() {
  const rows = await getAll('audioCache');
  return rows.reduce((n, r) => n + (r.blob?.size || 0), 0);
}

export async function clearAudioCache() {
  const rows = await getAll('audioCache');
  await Promise.all(rows.map((r) => remove('audioCache', r.key)));
}

export async function forgetSong(id) {
  await dropCachedAudio(id);
  const scores = await listScores(id);
  await Promise.all(scores.map((s) => remove('scores', s.id)));
}

// ---- 成績 ----------------------------------------------------------------

export async function saveScore(record) {
  return put('scores', { ...record, date: Date.now() });
}

export async function listScores(songId = null) {
  const all = await getAll('scores');
  const rows = songId ? all.filter((s) => s.songId === songId) : all;
  return rows.sort((a, b) => b.date - a.date);
}

export async function bestScore(songId) {
  const rows = await listScores(songId);
  return rows.reduce((best, r) => (best === null || r.total > best.total ? r : best), null);
}

// ---- 延遲設定檔 -----------------------------------------------------------

/** 設定檔以「麥克風 × 輸出裝置」為 key，換一組耳機就是另一份設定。 */
export function latencyProfileId(micLabel, outputLabel) {
  return `${micLabel || '未知麥克風'}｜${outputLabel || '預設輸出'}`;
}

export async function saveLatencyProfile(micLabel, outputLabel, offsetMs, extra = {}) {
  const profile = {
    id: latencyProfileId(micLabel, outputLabel),
    micLabel: micLabel || '未知麥克風',
    outputLabel: outputLabel || '預設輸出',
    offsetMs,
    measuredAt: Date.now(),
    ...extra,
  };
  await put('latency', profile);
  return profile;
}

export function getLatencyProfile(micLabel, outputLabel) {
  return get('latency', latencyProfileId(micLabel, outputLabel));
}

export const listLatencyProfiles = () => getAll('latency');
export const deleteLatencyProfile = (id) => remove('latency', id);

// ---- 設定 ----------------------------------------------------------------

export async function getSetting(key, fallback = null) {
  const row = await get('settings', key);
  return row ? row.value : fallback;
}

export const setSetting = (key, value) => put('settings', { key, value });
