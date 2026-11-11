// app/library.js — 曲庫畫面：清單、搜尋、歌手篩選、排序、加歌與背景處理工作。

import * as api from '../api.js';
import * as store from '../storage.js';
import { confirmBox, toast, icon } from '../ui.js';
import { $, escapeHtml, fmtTime, normalize } from '../util.js';
import { state } from './core.js';
import { openChartScreen } from './chart.js';
import { startSinging } from './sing.js';

// ── 曲庫 ────────────────────────────────────────────────────
//
// 曲庫本體（音檔、譜面）存在跑伺服器的那台電腦上。這個畫面只拿中繼資料，
// 音軌要等使用者按下「演唱」或「譜面」才會抓到這台裝置上。

/** 沒有封面時的預設封面：依歌名決定色相，同一首歌每次都同一個顏色。 */
export function coverPlaceholder(song) {
  const name = song?.name || '';
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  const first = [...name.replace(/^[\s【「『（(\[]+/, '')][0] || '♪';
  return `<div class="cover-ph" style="--h:${h}"><b>${escapeHtml(first)}</b><i>♪</i></div>`;
}

export function coverHtml(song, thumb = false) {
  const url = thumb ? api.thumbUrl(song) : api.coverUrl(song);
  return url
    ? `<img class="cover-img" src="${url}" alt="" loading="lazy" decoding="async">`
    : coverPlaceholder(song);
}

// 封面圖讀不到（檔案被刪、網路斷）時換回預設封面，不要留一個破圖示
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('cover-img')) return;
  const holder = img.closest('[data-cover-name]');
  img.outerHTML = coverPlaceholder({ name: holder?.dataset.coverName || '' });
}, true);

export function setCover(el, song) {
  el.dataset.coverName = song?.name || '';
  el.innerHTML = coverHtml(song);
}

/** 演唱／結算畫面的背景：封面放大模糊。沒有封面就只留深藍底。 */
export function setBackdrop(el, song) {
  const url = api.thumbUrl(song);   // 反正要模糊，用小圖就好
  el.classList.toggle('show', !!url);
  el.innerHTML = url ? `<img src="${url}" alt="">` : '';
}

export function songCard(song, matched = false) {
  const tags = [
    song.source ? `<span class="source">${escapeHtml(song.source)}</span>` : '',
    song.lyrics ? '<span class="lyr-tag">♪ 歌詞</span>' : '',
  ].join('');
  const artist = song.artist || song.uploader;
  const plays = song.plays ? `・唱過 ${song.plays} 次` : '';
  const canDelete = !state.serverInfo?.public;
  return `
    <div class="song-card${matched ? ' matched' : ''}" data-id="${escapeHtml(song.id)}">
      <button class="cover" data-act="sing" aria-label="演唱「${escapeHtml(song.name)}」" data-cover-name="${escapeHtml(song.name)}">
        ${coverHtml(song, true)}
        <span class="play" aria-hidden="true">${icon('play')}</span>
        ${song.best != null ? `<span class="best-badge" title="個人最佳">${icon('star')}${Number(song.best).toFixed(1)}</span>` : ''}
      </button>
      <button class="fav-btn${song.favorite ? ' on' : ''}" data-act="fav" aria-pressed="${song.favorite ? 'true' : 'false'}"
        aria-label="${song.favorite ? '從最愛移除' : '加入最愛'}">${icon('star')}</button>
      <div class="info">
        <div class="name" title="${escapeHtml(song.name)}">${escapeHtml(song.name)}</div>
        ${artist ? `<button class="artist" data-artist="${escapeHtml(artist)}" title="列出這位歌手的歌">${escapeHtml(artist)}</button>` : ''}
        ${tags ? `<div class="tags">${tags}</div>` : ''}
        <div class="meta">${fmtTime(song.durationMs)}${plays}</div>
      </div>
      <div class="row">
        <button class="primary tiny" data-act="sing">演唱</button>
        <button class="ghost tiny" data-act="chart">譜面</button>
        ${canDelete ? `<button class="ghost tiny icon-only card-del" data-act="del" aria-label="刪除「${escapeHtml(song.name)}」">${icon('trash')}</button>` : ''}
      </div>
    </div>`;
}

/** 搜尋框目前的關鍵字（網址不算關鍵字）。 */
export function currentQuery() {
  const v = $('#search-input').value.trim();
  return isSupportedUrl(v) ? '' : v;
}

export function filterSongs(songs, query) {
  const words = query.split(/\s+/).map(normalize).filter(Boolean);
  if (!words.length) return songs;
  return songs.filter((m) => {
    const hay = [m.name, m.artist, m.uploader].map(normalize).join(' ');
    return words.every((w) => hay.includes(w));
  });
}

export const SORTERS = {
  added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  recent: (a, b) => (b.lastSungAt || 0) - (a.lastSungAt || 0) || SORTERS.added(a, b),
  name: (a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hant'),
  best: (a, b) => (b.best ?? -1) - (a.best ?? -1) || SORTERS.added(a, b),
  fav: (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || SORTERS.added(a, b),
};

/** 從伺服器重新拿清單再畫。 */
export async function refreshLibrary(matchedId = null) {
  try {
    state.allSongs = await api.listSongs();
    state.libraryError = null;
  } catch (err) {
    state.libraryError = err.message;
  }
  renderLibrary(matchedId);
}

/** 用手上的清單畫（搜尋框打字時走這裡，不必問伺服器）。 */
export function renderLibrary(matchedId = null) {
  const list = $('#song-list');
  const query = currentQuery();
  renderArtistBar(query);

  if (state.libraryError && !state.allSongs.length) {
    list.innerHTML = `<div class="empty-state">${icon('warn', 'big')}
      <p>連不上這台電腦的伺服器：${escapeHtml(state.libraryError)}</p>
      <button class="ghost" data-act="retry">再試一次</button></div>`;
    $('#library-count').textContent = '';
    return;
  }

  const songs = filterSongs(state.allSongs, query).sort(SORTERS[state.sort] || SORTERS.added);
  $('#library-count').textContent = state.allSongs.length
    ? (query ? `${songs.length} / ${state.allSongs.length} 首` : `${state.allSongs.length} 首`) : '';

  if (!songs.length) {
    list.innerHTML = query
      ? `<div class="empty-state">${icon('search', 'big')}
          <p>曲庫裡沒有符合「${escapeHtml(query)}」的歌。</p>
          <p class="muted small">想加新歌就貼上 YouTube／YouTube Music／Bilibili 的網址，或按右上的 ＋ 上傳本機音檔。</p></div>`
      : `<div class="empty-state">${icon('library', 'big')}
          <h3>曲庫還是空的</h3>
          <p class="muted">把 YouTube／YouTube Music／Bilibili 的網址貼到上面的搜尋列按 Enter，
          或按 ＋ 上傳音檔。程式會自動分出伴奏、做好音程譜與歌詞。</p>
          <button class="primary" data-act="focus-search">貼上網址加第一首歌</button></div>`;
    return;
  }

  list.innerHTML = songs.map((song) => songCard(song, song.id === matchedId)).join('');
  if (matchedId) {
    $(`.song-card[data-id="${CSS.escape(matchedId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ── 用歌手找歌 ──────────────────────────────────────────────
//
// 曲庫上方一排歌手按鈕（兩首以上才列，避免一長串只有一首的頻道名），
// 按下去等於在搜尋列輸入歌手名；卡片上的歌手名也可以點。

export function searchArtist(name) {
  const input = $('#search-input');
  const same = input.value.trim() === name;
  input.value = same ? '' : name;   // 再按一次同一位就取消篩選
  input.dispatchEvent(new Event('input'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function renderArtistBar(query) {
  const bar = $('#artist-bar');
  const list = api.artists().filter((a) => a.count >= 2);
  bar.classList.toggle('hidden', !list.length);
  const q = (query || '').trim();
  bar.innerHTML = list.map((a) =>
    `<button class="chip${a.name === q ? ' on' : ''}" data-artist="${escapeHtml(a.name)}" aria-pressed="${a.name === q}">`
    + `${escapeHtml(a.name)}<small>${a.count}</small></button>`).join('');
}

$('#artist-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-artist]');
  if (btn) searchArtist(btn.dataset.artist);
});

$('#sort-select').addEventListener('change', (e) => {
  state.sort = e.target.value;
  store.setSetting('librarySort', state.sort);
  renderLibrary();
});

$('#song-list').addEventListener('click', async (e) => {
  const artistBtn = e.target.closest('button[data-artist]');
  if (artistBtn) { searchArtist(artistBtn.dataset.artist); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'retry') { refreshLibrary(); return; }
  if (btn.dataset.act === 'focus-search') { $('#search-input').focus(); return; }
  const id = btn.closest('.song-card')?.dataset.id;
  const song = state.allSongs.find((s) => s.id === id);
  if (!song) return;

  if (btn.dataset.act === 'del') {
    const ok = await confirmBox(`這會從電腦上移除「${song.name}」的音檔、譜面與所有成績紀錄，不能復原。`,
      { title: '刪除這首歌？', ok: '刪除', danger: true });
    if (!ok) return;
    try {
      await api.deleteSong(id);
      toast(`已刪除「${song.name}」`);
    } catch (err) {
      toast(`刪除失敗：${err.message}`, { kind: 'error' });
    }
    refreshLibrary();
  } else if (btn.dataset.act === 'fav') {
    song.favorite = !song.favorite;
    renderLibrary();
    api.saveSongSettings(id, { favorite: song.favorite }).catch((err) => {
      song.favorite = !song.favorite;
      renderLibrary();
      toast(`存不了最愛：${err.message}`, { kind: 'error' });
    });
  } else if (btn.dataset.act === 'chart') {
    openChartScreen(id);
  } else {
    startSinging(id, { from: 'library' });
  }
});

/** 取回整首歌（中繼資料 + 譜面）。音軌不在這裡抓。 */
export async function loadSong(id) {
  const [meta, chart] = await Promise.all([api.getSong(id), api.getChart(id)]);
  return { ...meta, chart };
}

// ── 搜尋列 ──────────────────────────────────────────────────
//
// 一條輸入框兼兩用：貼網址就去三個平台抓歌，打字就在已下載的歌裡面找。

export function setSearchStatus(html, kind = '') {
  const el = $('#search-status');
  if (!html) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.className = `search-status ${kind}`;
  el.innerHTML = html;
}

export const searchInput = $('#search-input');
export let searchTimer = null;

searchInput.addEventListener('input', () => {
  const value = searchInput.value.trim();
  $('#search-clear').classList.toggle('hidden', !value);

  clearTimeout(searchTimer);
  if (isSupportedUrl(value)) {
    // 網址不邊打邊查，等使用者按 Enter 或離開輸入框
    setSearchStatus('看起來是網址，按 <strong>Enter</strong> 取得這首歌。');
    return;
  }
  setSearchStatus('');
  searchTimer = setTimeout(() => renderLibrary(), 120);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const value = searchInput.value.trim();
  if (isSupportedUrl(value)) handleUrl(value);
});

$('#search-clear').addEventListener('click', () => {
  searchInput.value = '';
  $('#search-clear').classList.add('hidden');
  setSearchStatus('');
  renderLibrary();
  searchInput.focus();
});

export function isSupportedUrl(text) {
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const host = new URL(text).hostname.toLowerCase();
    return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|music\.youtube\.com|bilibili\.com|b23\.tv)$/
      .test(host);
  } catch { return false; }
}

export function clearSearch() {
  searchInput.value = '';
  $('#search-clear').classList.add('hidden');
}

/** 貼上網址：先問是不是已經有了，有就標出來，沒有就排進背景處理。 */
export async function handleUrl(url) {
  setSearchStatus('<span class="spinner"></span><span class="grow">讀取網址中…</span>');
  let resolved;
  try {
    resolved = await api.resolveUrl(url);
  } catch (err) {
    setSearchStatus(`讀取失敗：${escapeHtml(err.message)}`, 'error');
    return;
  }

  const { meta, existing } = resolved;

  if (existing) {
    // 這首已經下載過了——把它當成搜尋結果顯示出來
    setSearchStatus(
      `<span class="grow"><strong>${escapeHtml(existing.name)}</strong> 已經在曲庫裡了</span>`);
    clearSearch();
    await refreshLibrary(existing.id);
    return;
  }

  try {
    // 伺服器會沿用剛才 resolve 的結果，不會再問一次 yt-dlp
    const job = await api.fetchUrl(url);
    if (job.existing) { clearSearch(); setSearchStatus(''); await refreshLibrary(job.existing.id); return; }
    clearSearch();
    setSearchStatus('');
    addJob({ jobId: job.jobId, name: meta.title, state: 'queued', pct: 0, stage: 'download',
             source: 'url', message: '排隊中…' });
    toast(`「${meta.title}」已加入處理清單，處理期間可以先唱別首`);
  } catch (err) {
    setSearchStatus(`取得失敗：${escapeHtml(err.message)}`, 'error');
  }
}

// ── 加歌：上傳與背景處理 ─────────────────────────────────────
//
// 分離＋抽音高要 1～3 分鐘。以前整個介面會被鎖在分析畫面；現在工作在
// 伺服器上排隊，曲庫最上面顯示進度卡，可以先唱別首、連續排好幾首、
// 重新整理後也接得回來（進度存在伺服器，不在這個頁面）。

export const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  for (const f of e.dataTransfer.files) handleFile(f);
});
$('#upload-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  for (const f of e.target.files) handleFile(f);
  e.target.value = '';
});

export const STAGE_LABEL = {
  download: '下載音訊', separate: '音源分離（人聲／伴奏）', pitch: '抽取原唱音高', technique: '標記原唱技巧',
};

export let uploadSeq = 0;
export async function handleFile(file) {
  if (file.size > 200 * 1024 * 1024) {
    toast(`「${file.name}」超過 200MB，太大了`, { kind: 'error' });
    return;
  }
  const localId = `u${++uploadSeq}`;
  state.uploads.set(localId, { name: file.name, pct: 0 });
  renderJobs();
  try {
    const job = await api.uploadFile(file, (pct) => {
      const u = state.uploads.get(localId);
      if (u) { u.pct = pct; renderJobs(); }
    });
    state.uploads.delete(localId);
    addJob({ jobId: job.jobId, name: job.name || file.name, state: 'queued', pct: 0,
             stage: 'separate', source: 'upload', message: '排隊中…' });
  } catch (err) {
    state.uploads.delete(localId);
    renderJobs();
    toast(`上傳「${file.name}」失敗：${err.message}`, { kind: 'error', duration: 8000 });
  }
}

export function addJob(job) {
  job.seen = true;   // 這個頁面看過它在跑：完成時才通知
  state.jobs.set(job.jobId, job);
  renderJobs();
  pollJobs();
}

export let jobTimer = null;
/** 有進行中的工作就每秒問一次伺服器（重新整理後也從這裡接回來）。 */
export async function pollJobs() {
  clearTimeout(jobTimer);
  let list;
  try {
    list = await api.listJobs();
  } catch {
    jobTimer = setTimeout(pollJobs, 3000);
    return;
  }
  const byId = new Map(list.map((j) => [j.jobId, j]));
  for (const j of list) {
    const old = state.jobs.get(j.jobId);
    const active = j.state === 'queued' || j.state === 'running';
    if (!old && !active) continue;   // 這個頁面沒看過、已經結束的：不打擾
    const merged = { ...old, ...j, seen: true };
    state.jobs.set(j.jobId, merged);
    if (!active && old && (old.state === 'queued' || old.state === 'running')) onJobFinished(merged);
  }
  // 伺服器那邊已經清掉的（重新啟動過）
  for (const [id, j] of state.jobs) {
    if (!byId.has(id) && (j.state === 'queued' || j.state === 'running')) {
      state.jobs.delete(id);
    }
  }
  renderJobs();
  if ([...state.jobs.values()].some((j) => j.state === 'queued' || j.state === 'running')) {
    jobTimer = setTimeout(pollJobs, 1000);
  }
}

export function onJobFinished(job) {
  if (job.state === 'done') {
    state.jobs.delete(job.jobId);
    refreshLibrary(job.songId);
    toast(`「${job.name}」處理完成`, {
      kind: 'ok', duration: 10000,
      action: { label: '看譜面', run: () => openChartScreen(job.songId) },
    });
  } else if (job.state === 'cancelled') {
    state.jobs.delete(job.jobId);
  }
  // error 留在清單上顯示原因，使用者按 ✕ 才收掉
}

export function renderJobs() {
  const host = $('#job-list');
  const uploads = [...state.uploads.values()].map((u) => `
    <div class="job-card">
      <div class="job-main">
        <div class="job-name">${escapeHtml(u.name)}</div>
        <div class="job-msg">上傳中 ${Math.round(u.pct * 100)}%</div>
        <div class="progress"><div class="progress-bar" style="width:${Math.round(u.pct * 100)}%"></div></div>
      </div>
    </div>`);
  const jobs = [...state.jobs.values()].map((j) => {
    const failed = j.state === 'error';
    const pct = Math.round((j.pct || 0) * 100);
    const stage = j.state === 'queued' ? '排隊中' : STAGE_LABEL[j.stage] || '處理中';
    return `
    <div class="job-card${failed ? ' failed' : ''}" data-job="${escapeHtml(j.jobId)}">
      <div class="job-main">
        <div class="job-name">${escapeHtml(j.name || '未命名')}</div>
        <div class="job-msg">${failed ? `${icon('warn')} 處理失敗：${escapeHtml(j.message)}`
          : `<strong>${escapeHtml(stage)}</strong>・${escapeHtml(j.message || '')}`}</div>
        ${failed ? '' : `<div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>`}
      </div>
      <button class="ghost tiny icon-only" data-job-act="${failed ? 'dismiss' : 'cancel'}"
        aria-label="${failed ? '關閉' : '取消處理'}" title="${failed ? '關閉' : '取消'}">${icon('close')}</button>
    </div>`;
  });
  host.innerHTML = [...uploads, ...jobs].join('');
}

$('#job-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-job-act]');
  if (!btn) return;
  const id = btn.closest('[data-job]').dataset.job;
  const job = state.jobs.get(id);
  if (btn.dataset.jobAct === 'dismiss') {
    state.jobs.delete(id);
    renderJobs();
    return;
  }
  const ok = await confirmBox(`不處理「${job?.name || '這首歌'}」了嗎？`, { ok: '取消處理', cancel: '繼續處理' });
  if (!ok) return;
  try {
    await api.cancelJob(id);
  } catch (err) {
    toast(`取消失敗：${err.message}`, { kind: 'error' });
  }
  pollJobs();
});
