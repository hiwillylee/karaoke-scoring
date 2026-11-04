// main.js — 畫面狀態機與流程串接。
// 曲庫 → 分析 → 譜面確認 → 演唱 → 結算，另有延遲校準與設定。

import { loadParams, PARAMS, TECHNIQUE_LABELS, techniqueColor, detectTechniques } from './techniques.js';
import { framesToNotes, prepareFrames, toMono } from './dsp.js';
import * as store from './storage.js';
import { KeyPlayer } from './pitchshift.js';
import { MicTracker, listDevices } from './mic.js';
import { LatencyCalibrator, isReliable, persist as persistLatency } from './calibrate.js';
import { LiveScorer } from './score.js';
import { StageRenderer, techniquesByNote, drawTechniqueGlyph, TECHNIQUE_PRIORITY } from './render.js';
import * as result from './result.js';
import { rebuildChart, noteRange, midiToName } from './chart.js';
import { ChartPiano } from './piano.js';
import { ChartEditor } from './editor.js';
import * as api from './api.js';
import { Tour } from './tour.js';
import { LyricsView, describeLyrics } from './lyrics.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  ctx: null,
  player: null,
  mic: null,
  scorer: null,
  renderer: null,
  song: null,          // 目前選中的歌（IndexedDB 紀錄）
  chart: null,         // 目前使用的參考譜
  pendingSong: null,   // 譜面確認中的歌
  keyShift: 0,
  latencyMs: 0,
  manualLatencyMs: 0,
  silenceRms: 0.008,
  guideOn: false,
  serverInfo: null,
  tunnel: null,
  outputLabel: '預設輸出',
  raf: null,
  singing: false,
  finished: false,
  previewPlayer: null,
  previewChart: null,
  previewRaf: null,
  previewDragging: false,
  // 譜面編輯：edits 是目前生效的編輯（逐幀音高位移 + note 覆寫）
  edits: { pitchShifts: [], notes: null },
  editor: null,
  editPiano: null,
  editPlayer: null,
  editRaf: null,
  // 譜面確認畫面的 A/B 試聽：原唱與鋼琴各自可開關
  previewPiano: null,
  pianoOn: false,
  vocalOn: true,
  lastTechCheck: 0,
  lastTechPopMs: -1,
  // 歌詞：演唱畫面與譜面確認畫面各一個顯示器，資料是同一份 lyrics.json
  lyrics: null,
  lyricsView: null,
  previewLyrics: null,
  previewLyricsView: null,
  lyricsPrefs: { ruby: true, romaji: false, karaoke: true, show: true },
};

// ── 基礎 ────────────────────────────────────────────────────

// 曲庫／分析中／譜面確認／演唱／結算都屬於同一條「曲庫」動線，
// 手機底部導覽列與桌面頂列的按鈕都用這張表決定該亮哪一個。
const NAV_GROUP = {
  library: 'library', analyze: 'library', chart: 'library',
  sing: 'library', result: 'library',
  calibrate: 'calibrate', settings: 'settings', connect: 'connect',
};

function show(name) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  // 演唱／結算畫面整頁換成螢幕的深藍（見 css 的 body[data-screen]）
  document.body.dataset.screen = name;
  const group = NAV_GROUP[name];
  $$('button[data-goto]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.goto === group);
  });
  window.scrollTo(0, 0);
}

async function audioCtx() {
  if (!state.ctx) state.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (state.ctx.state === 'suspended') await state.ctx.resume();
  return state.ctx;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function keyLabel(n) {
  if (!n) return '原調';
  return n > 0 ? `♯${n}` : `♭${-n}`;
}

// ── 曲庫 ────────────────────────────────────────────────────
//
// 曲庫本體（音檔、譜面）存在跑伺服器的那台電腦上。這個畫面只拿中繼資料，
// 音軌要等使用者按下「演唱」或「譜面」才會抓到這台裝置上。

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── 封面 ────────────────────────────────────────────────────

/** 沒有封面時的預設封面：依歌名決定色相，同一首歌每次都同一個顏色。 */
function coverPlaceholder(song) {
  const name = song?.name || '';
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  const first = [...name.replace(/^[\s【「『（(\[]+/, '')][0] || '♪';
  return `<div class="cover-ph" style="--h:${h}"><b>${escapeHtml(first)}</b><i>♪</i></div>`;
}

function coverHtml(song) {
  const url = api.coverUrl(song);
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

function setCover(el, song) {
  el.dataset.coverName = song?.name || '';
  el.innerHTML = coverHtml(song);
}

/** 演唱／結算畫面的背景：封面放大模糊。沒有封面就只留深藍底。 */
function setBackdrop(el, song) {
  const url = api.coverUrl(song);
  el.classList.toggle('show', !!url);
  el.innerHTML = url ? `<img src="${url}" alt="">` : '';
}

function songCard(song, best, matched = false) {
  const tags = [
    song.source ? `<span class="source">${escapeHtml(song.source)}</span>` : '',
    song.lyrics ? '<span class="lyr-tag" title="有歌詞">♪ 歌詞</span>' : '',
  ].join('');
  return `
    <div class="song-card${matched ? ' matched' : ''}" data-id="${escapeHtml(song.id)}">
      <button class="cover" data-act="sing" title="演唱" data-cover-name="${escapeHtml(song.name)}">
        ${coverHtml(song)}
        <span class="play">演唱</span>
        ${best ? `<span class="best-badge">${best.total.toFixed(1)}</span>` : ''}
      </button>
      <div class="info">
        <div class="name" title="${escapeHtml(song.name)}">${escapeHtml(song.name)}</div>
        ${song.artist || song.uploader
    ? `<button class="artist" data-artist="${escapeHtml(song.artist || song.uploader)}" title="列出這位歌手的歌">${escapeHtml(song.artist || song.uploader)}</button>`
    : ''}
        ${tags ? `<div class="tags">${tags}</div>` : ''}
        <div class="meta">${fmtDuration(song.durationMs)}・${song.notes} 音</div>
      </div>
      <div class="row">
        <button class="primary tiny" data-act="sing">演唱</button>
        <button class="ghost tiny" data-act="chart">譜面</button>
        <button class="ghost tiny danger icon" data-act="del" title="刪除">✕</button>
      </div>
    </div>`;
}

async function renderLibrary(query = '', matchedId = null) {
  const list = $('#song-list');
  let songs;
  try {
    songs = await api.listSongs(query);
  } catch (err) {
    list.innerHTML = `<p class="muted">連不上伺服器：${escapeHtml(err.message)}</p>`;
    return;
  }
  state.songs = songs;
  $('#library-count').textContent = songs.length ? `${songs.length} 首` : '';
  renderArtistBar(query);

  if (!songs.length) {
    list.innerHTML = query
      ? `<p class="muted">曲庫裡沒有符合「${escapeHtml(query)}」的歌。<br>
         想加新歌就貼上 YouTube／YouTube Music／Bilibili 的網址，或按右邊的 ＋ 上傳本機音檔。</p>`
      : '<p class="muted">曲庫還是空的。<br>貼上 YouTube／YouTube Music／Bilibili 的網址，或按右邊的 ＋ 上傳本機音檔。</p>';
    return;
  }

  const cards = await Promise.all(songs.map(async (song) =>
    songCard(song, await store.bestScore(song.id), song.id === matchedId)));
  list.innerHTML = cards.join('');

  if (matchedId) {
    $(`.song-card[data-id="${matchedId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ── 用歌手找歌 ──────────────────────────────────────────────
//
// 曲庫上方一排歌手按鈕（兩首以上才列，避免一長串只有一首的頻道名），
// 按下去等於在搜尋列輸入歌手名；卡片上的歌手名也可以點。

function searchArtist(name) {
  const input = $('#search-input');
  const same = input.value.trim() === name;
  input.value = same ? '' : name;   // 再按一次同一位就取消篩選
  input.dispatchEvent(new Event('input'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderArtistBar(query) {
  const bar = $('#artist-bar');
  const list = api.artists().filter((a) => a.count >= 2);
  bar.classList.toggle('hidden', !list.length);
  const q = (query || '').trim();
  bar.innerHTML = list.map((a) =>
    `<button class="chip${a.name === q ? ' on' : ''}" data-artist="${escapeHtml(a.name)}">`
    + `${escapeHtml(a.name)}<small>${a.count}</small></button>`).join('');
}

$('#artist-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-artist]');
  if (btn) searchArtist(btn.dataset.artist);
});

$('#song-list').addEventListener('click', async (e) => {
  const artistBtn = e.target.closest('button[data-artist]');
  if (artistBtn) { searchArtist(artistBtn.dataset.artist); return; }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.song-card').dataset.id;
  const song = state.songs.find((s) => s.id === id);
  if (!song) return;

  if (btn.dataset.act === 'del') {
    if (!confirm(`刪除「${song.name}」？這會從電腦上移除音檔，成績紀錄也會一起清掉。`)) return;
    await api.deleteSong(id);
    renderLibrary($('#search-input').value.trim());
  } else if (btn.dataset.act === 'chart') {
    openChartScreen(id);
  } else {
    startSinging(id);
  }
});

/** 取回整首歌（中繼資料 + 譜面）。音軌不在這裡抓。 */
async function loadSong(id) {
  const [meta, chart] = await Promise.all([api.getSong(id), api.getChart(id)]);
  return { ...meta, chart };
}

// ── 搜尋列 ──────────────────────────────────────────────────
//
// 一條輸入框兼兩用：貼網址就去三個平台抓歌，打字就在已下載的歌裡面找。

function setSearchStatus(html, kind = '') {
  const el = $('#search-status');
  if (!html) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.className = `search-status ${kind}`;
  el.innerHTML = html;
}

const searchInput = $('#search-input');
let searchTimer = null;

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
  searchTimer = setTimeout(() => renderLibrary(value), 180);
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

function isSupportedUrl(text) {
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const host = new URL(text).hostname.toLowerCase();
    return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|music\.youtube\.com|bilibili\.com|b23\.tv)$/
      .test(host);
  } catch { return false; }
}

/** 貼上網址：先問是不是已經有了，有就標出來，沒有才下載。 */
async function handleUrl(url) {
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
    searchInput.value = '';
    $('#search-clear').classList.add('hidden');
    await renderLibrary('', existing.id);
    return;
  }

  setSearchStatus(
    `<span class="spinner"></span><span class="grow">從 ${escapeHtml(meta.platformLabel)} 取得
     <strong>${escapeHtml(meta.title)}</strong>…</span>`);

  try {
    const job = await api.fetchUrl(url);
    if (job.existing) { await renderLibrary('', job.existing.id); return; }
    searchInput.value = '';
    $('#search-clear').classList.add('hidden');
    setSearchStatus('');
    await runJob(job.jobId, meta.title);
  } catch (err) {
    setSearchStatus(`取得失敗：${escapeHtml(err.message)}`, 'error');
  }
}

// ── 上傳與分析 ──────────────────────────────────────────────

const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
$('#upload-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
  e.target.value = '';
});

function setStage(name) {
  $$('.stages li').forEach((li) => {
    const order = ['separate', 'pitch', 'technique'];
    const idx = order.indexOf(li.dataset.stage);
    const cur = order.indexOf(name);
    li.classList.toggle('done', idx < cur);
    li.classList.toggle('active', idx === cur);
  });
}

function setProgress(pct, message) {
  $('#analyze-bar').style.width = `${Math.round(pct * 100)}%`;
  if (message) $('#analyze-message').textContent = message;
}

/** 追蹤一件伺服器工作（下載／分析），完成後直接進譜面確認。 */
async function runJob(jobId, title) {
  $('#analyze-title').textContent = title;
  setProgress(0, '排隊中…');
  setStage('separate');
  show('analyze');

  try {
    const job = await api.trackJob(jobId, (j) => {
      setProgress(j.pct, j.message);
      if (j.name) $('#analyze-title').textContent = j.name;
      if (j.pct < 0.62) setStage('separate');
      else if (j.pct < 0.92) setStage('pitch');
      else setStage('technique');
    });
    await renderLibrary($('#search-input').value.trim());
    openChartScreen(job.songId);
  } catch (err) {
    alert(`處理失敗：${err.message || err}`);
    show('library');
    renderLibrary();
  }
}

async function handleFile(file) {
  try {
    const job = await api.uploadFile(file);
    await runJob(job.jobId, file.name);
  } catch (err) {
    alert(`上傳失敗：${err.message || err}`);
    show('library');
  }
}

// ── 譜面確認 ────────────────────────────────────────────────

async function openChartScreen(idOrSong) {
  const song = typeof idOrSong === 'string' ? await loadSong(idOrSong) : idOrSong;
  state.pendingSong = song;
  $('#chart-song-name').textContent = song.name;
  setCover($('#chart-cover'), song);
  $('#cover-status').textContent = song.cover ? '' : '還沒有封面';
  $('#octave-slider').value = song.octaveOffset || 0;
  $('#sens-slider').value = song.minConfidence ?? PARAMS.pitch.minConfidence;
  $('#level-slider').value = song.minLevelDb ?? PARAMS.pitch.minLevelDb;
  state.edits = normalizeEdits(song.chartEdits);
  show('chart');
  // 直接畫，不要透過 requestAnimationFrame——分頁在背景時 rAF 不會觸發，
  // 一次性的繪製會整個消失
  refreshChartPreview();
  loadChartLyrics(song);
  await preparePreviewPlayer(song);
}

/** 譜面畫面的試聽播放器。用人聲軌（簡易模式沒有的話就用原曲）。 */
/**
 * 取人聲軌並建一個播放器。譜面確認與編輯畫面共用。
 * @param onStatus 回報取檔進度／錯誤，讓兩個畫面各自顯示在自己的位置
 */
async function loadPreviewAudio(song, ctx, onStatus = () => {}) {
  if (!song.hasGuide) {
    onStatus('（沒有可試聽的音軌）');
    return null;
  }
  // 音檔在伺服器上，這裡才抓下來（抓過就走本機快取）
  onStatus('取得音軌中…');
  let blob;
  try {
    blob = await api.getStem(song.id, 'vocals', (done, total, fromCache) => {
      if (!fromCache && total) onStatus(`取得音軌中… ${Math.round(done / total * 100)}%`);
    });
  } catch (err) {
    onStatus(`取得音軌失敗：${err.message}`);
    return null;
  }
  const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  const player = new KeyPlayer(ctx);
  await player.load([{ buffer: monoBuffer(ctx, buffer), gain: 1 }]);
  player.connect(ctx.destination);
  return player;
}

async function preparePreviewPlayer(song) {
  stopPreview();
  $('#preview-play').disabled = true;
  const ctx = await audioCtx();
  const player = await loadPreviewAudio(song, ctx, (msg) => {
    $('#preview-time').textContent = msg;
  });
  if (!player) return;
  $('#preview-play').disabled = false;
  player.onended = () => { setPreviewPlaying(false); drawPreviewFrame(); };
  state.previewPlayer = player;
  applyPreviewVocalGain();

  // 鋼琴：把抽到的譜彈出來跟原唱對照。位置直接讀播放器，兩邊自然同步。
  if (!state.previewPiano) {
    state.previewPiano = new ChartPiano(ctx,
      () => (state.previewPlayer?.playing ? previewPositionMs() : null));
    state.previewPiano.connect(ctx.destination);
  }
  state.previewPiano.setNotes(state.previewChart?.notes || []);
  state.previewPiano.setEnabled(state.pianoOn);

  updatePreviewTime();
}

/** 原唱可以關掉，才聽得清楚鋼琴。 */
function applyPreviewVocalGain() {
  state.previewPlayer?.setVolume(state.vocalOn ? 1 : 0);
}

function refreshChartPreview() {
  const song = state.pendingSong;
  const octave = Number($('#octave-slider').value);
  const minConfidence = Number($('#sens-slider').value);
  const minLevelDb = Number($('#level-slider').value);
  $('#octave-value').textContent = octave;
  $('#sens-value').textContent = minConfidence.toFixed(2);
  $('#level-value').textContent = `${minLevelDb} dB`;

  const chart = rebuildChart(song.chart, {
    minConfidence, minLevelDb, octaveOffset: octave, edits: state.edits,
  });
  state.previewChart = chart;
  // 譜變了（滑桿或段落修正），鋼琴要跟著彈新的
  state.previewPiano?.setNotes(chart.notes);
  // 逐字時間的估算靠譜面的音，譜變了就重算
  if (state.previewLyricsView) setPreviewLyrics(state.previewLyrics);

  const counts = chart.techniques.reduce((acc, t) => {
    acc[t.type] = (acc[t.type] || 0) + 1;
    return acc;
  }, {});
  // 文字用該技巧的顏色，跟譜面上的音符條對得起來
  const techHtml = TECHNIQUE_PRIORITY
    .filter((k) => counts[k])
    .map((k) => `<span style="color:${techniqueColor(k)}">${TECHNIQUE_LABELS[k]}×${counts[k]}</span>`)
    .join('　') || '<span class="hint">未偵測到技巧</span>';
  $('#chart-stats').innerHTML = `${chart.notes.length} 個音　${techHtml}`;

  drawPreviewFrame();
}

// 每秒佔多少像素。整首壓進一個畫面會太密，改成固定比例的長條再捲動。
const PREVIEW_PX_PER_SEC = 80;
// 播放頭固定在畫面這個位置，內容從右往左捲——與演唱畫面同一套視覺模型
const PREVIEW_JUDGE_RATIO = 0.3;
const OVERVIEW_PAD = 6;

function previewPositionMs() {
  return state.previewPlayer ? state.previewPlayer.currentTime * 1000 : 0;
}

function drawPreviewFrame() {
  if (!state.previewChart) return;
  const playhead = previewPositionMs();
  drawDetailStrip($('#chart-preview'), state.previewChart, playhead);
  drawOverview($('#chart-overview'), state.previewChart, playhead);
  state.previewLyricsView?.update(playhead);
  updatePreviewTime();
}

function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// -- 段落八度修正 ---------------------------------------------------------
//
// 自動偵測不可能完美：強聲區的二次諧波可以比基頻大好幾倍，pyin 與 CREPE
// 都會整句鎖在諧波上。這裡讓使用者圈一段自己改，是最後的出口。
// 預覽畫布的拖曳已經用來捲動時間軸了，所以改用播放頭設定起訖點。

// ── 編輯譜面 ────────────────────────────────────────────────

/** 從伺服器拿到的編輯資料可能是舊格式或缺欄位，統一成已知形狀。 */
function normalizeEdits(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  return {
    pitchShifts: Array.isArray(e.pitchShifts) ? e.pitchShifts.map((f) => ({ ...f })) : [],
    notes: Array.isArray(e.notes) ? e.notes.map((n) => ({ ...n })) : null,
  };
}

function editStatus(text) {
  $('#edit-status').textContent = text;
}

async function openEditScreen() {
  const song = state.pendingSong;
  stopPreview();
  $('#edit-song-name').textContent = song.name;
  show('edit');

  const ctx = await audioCtx();
  if (!state.editor) {
    state.editor = new ChartEditor($('#edit-roll'), {
      onChange: (notes) => {
        // 結構性編輯一旦發生，就以這份 note 清單為準（見 chart.js 的說明）
        state.edits.notes = notes.map((n) => ({ ...n }));
        state.editPiano?.setNotes(notes);
        editStatus(`已修改，共 ${notes.length} 個音符（尚未儲存）`);
      },
      onSelect: (note) => {
        const n = state.editor.selectedNotes().length;
        $('#edit-sel').textContent = !n ? '未選取'
          : n === 1 ? `已選 ${midiToName(note.midi)}　${fmtTime(note.startMs)}`
            : `已選 ${n} 個音符`;
      },
      onSeek: (ms) => {
        const p = state.editPlayer;
        if (!p) return;
        const wasPlaying = p.playing;
        p.seek(Math.max(0, Math.min(p.duration, ms / 1000)));
        if (wasPlaying) p.play();
        // 跳轉後鋼琴要丟掉排好的音重新對齊，否則會補彈一串過去的音
        state.editPiano?.reschedule();
        $('#edit-time').textContent = `${fmtTime(ms)} / ${fmtTime(p.duration * 1000)}`;
      },
    });
  }

  // 進編輯器就把目前的 note 定住。滑桿是「產生」階段的參數，手動編輯之後
  // 再重新產生會把編輯洗掉，所以編輯期間以這份清單為唯一真相。
  // 從譜面確認畫面的播放位置接續，使用者剛才看到哪就從哪開始編
  state.editor.setNotes(state.previewChart.notes, state.previewChart.durationMs,
    state.previewPlayer ? previewPositionMs() : null);
  $('#edit-sel').textContent = '未選取';
  editStatus(state.edits.notes ? '這首歌已經有編輯過的譜面。' : '');

  // 播放器與鋼琴：與譜面確認畫面用同一套元件
  if (!state.editPiano) {
    state.editPiano = new ChartPiano(ctx,
      () => (state.editPlayer?.playing ? state.editPlayer.currentTime * 1000 : null));
    state.editPiano.connect(ctx.destination);
  }
  state.editPiano.setNotes(state.previewChart.notes);
  state.editPiano.setEnabled($('#edit-piano').classList.contains('on'));

  state.editPlayer = await loadPreviewAudio(song, ctx);
  $('#edit-play').disabled = !state.editPlayer;
  $('#edit-time').textContent = state.editPlayer
    ? `0:00 / ${fmtTime(state.editPlayer.duration * 1000)}` : '（沒有可試聽的音軌）';
  applyEditVocalGain();
  editLoop();
}

function applyEditVocalGain() {
  state.editPlayer?.setVolume($('#edit-vocal').classList.contains('on') ? 1 : 0);
}

function editLoop() {
  cancelAnimationFrame(state.editRaf);
  const step = () => {
    if (!$('#screen-edit').classList.contains('active')) return;
    if (state.editPlayer?.playing) {
      const ms = state.editPlayer.currentTime * 1000;
      state.editor.setPlayhead(ms, true);
      $('#edit-time').textContent =
        `${fmtTime(ms)} / ${fmtTime(state.editPlayer.duration * 1000)}`;
    }
    state.editRaf = requestAnimationFrame(step);
  };
  state.editRaf = requestAnimationFrame(step);
}

function closeEditScreen() {
  cancelAnimationFrame(state.editRaf);
  state.editPiano?.stop();
  if (state.editPlayer) {
    state.editPlayer.stop();
    state.editPlayer.node?.disconnect();
    state.editPlayer.gain.disconnect();
    state.editPlayer = null;
  }
}

function updatePreviewTime() {
  if (!state.previewChart) return;
  $('#preview-time').textContent =
    `${fmtTime(previewPositionMs())} / ${fmtTime(state.previewChart.durationMs)}`;
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, w: rect.width, h: rect.height };
}

/** 目前這個畫布寬度可以看到多少毫秒。 */
function visibleSpanMs(canvas) {
  return (canvas.getBoundingClientRect().width / PREVIEW_PX_PER_SEC) * 1000;
}

/** 捲動式的細部音程條。播放頭固定，內容左右移動。 */
function drawDetailStrip(canvas, chart, playheadMs) {
  const { ctx, w, h } = setupCanvas(canvas);
  const notes = chart.notes;
  if (!notes.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('沒有偵測到旋律，試著到「進階」調低靈敏度', w / 2, h / 2);
    return;
  }

  const range = noteRange(notes, 2);
  const judgeX = w * PREVIEW_JUDGE_RATIO;
  const pxPerMs = PREVIEW_PX_PER_SEC / 1000;
  const xOf = (ms) => judgeX + (ms - playheadMs) * pxPerMs;
  const yOf = (m) => h - 14 - ((m - range.min) / (range.max - range.min)) * (h - 30);
  const fromMs = playheadMs - judgeX / pxPerMs;
  const toMs = fromMs + w / pxPerMs;

  // 每秒一條淡刻度，整十秒標時間
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  const firstSec = Math.floor(fromMs / 1000);
  const lastSec = Math.ceil(toMs / 1000);
  for (let sec = Math.max(0, firstSec); sec <= lastSec; sec++) {
    const x = xOf(sec * 1000);
    const major = sec % 5 === 0;
    ctx.strokeStyle = major ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h - (major ? 14 : 8));
    ctx.stroke();
    if (major) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(fmtTime(sec * 1000), x, h - 3);
    }
  }

  // 八度格線
  ctx.textAlign = 'right';
  for (let m = Math.ceil(range.min); m <= range.max; m++) {
    if (((m % 12) + 12) % 12 !== 0) continue;
    const y = yOf(m);
    ctx.strokeStyle = 'rgba(0,229,255,0.13)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,229,255,0.40)';
    ctx.fillText(midiToName(m), w - 5, y - 3);
  }

  // 音程條。標了技巧的音直接換成該技巧的顏色，並在上方畫小符號
  const semiH = (h - 30) / (range.max - range.min);
  const barH = Math.max(5, Math.min(16, semiH * 0.8));
  const techByNote = techniquesByNote(chart.techniques);
  notes.forEach((note, i) => {
    if (note.endMs < fromMs || note.startMs > toMs) return;
    const x0 = xOf(note.startMs);
    const width = Math.max(2, (note.endMs - note.startMs) * pxPerMs);
    const y = yOf(note.midi) - barH / 2;
    const techs = techByNote.get(i);

    // 播放頭正下方那一格：畫成實心並框起來，讓「+1 八度」按下去時
    // 使用者一眼就知道會改到哪一個音
    const isCurrent = playheadMs >= note.startMs && playheadMs <= note.endMs;

    ctx.fillStyle = isCurrent ? 'rgba(255,209,102,0.85)'
      : techs ? techniqueColor(techs[0], 0.42) : 'rgba(0,229,255,0.34)';
    ctx.fillRect(x0, y, width, barH);
    ctx.strokeStyle = isCurrent ? 'rgba(255,209,102,1)'
      : techs ? techniqueColor(techs[0], 0.9) : 'rgba(0,229,255,0.8)';
    ctx.lineWidth = isCurrent ? 2 : 1;
    ctx.strokeRect(x0 + 0.5, y + 0.5, width - 1, barH - 1);
    if (isCurrent) {
      ctx.strokeStyle = 'rgba(255,209,102,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 - 3.5, y - 4.5, width + 7, barH + 9);
    }

    if (techs) {
      const size = 5;
      const gap = size * 2 + 4;
      let gx = x0 + width / 2 - (gap * (techs.length - 1)) / 2;
      for (const type of techs) {
        drawTechniqueGlyph(ctx, type, gx, y - size - 3, size);
        gx += gap;
      }
    }
  });

  // 播放頭
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillRect(judgeX - 1, 0, 2, h - 14);
  ctx.beginPath();
  ctx.arc(judgeX, 7, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd54a';
  ctx.shadowColor = 'rgba(255,213,74,0.9)';
  ctx.shadowBlur = 10;
  ctx.fill();
  ctx.shadowBlur = 0;
}

/** 全曲總覽：整首壓成一條，用來粗略定位。 */
function drawOverview(canvas, chart, playheadMs) {
  const { ctx, w, h } = setupCanvas(canvas);
  const notes = chart.notes;
  const usable = w - OVERVIEW_PAD * 2;
  const xOf = (ms) => OVERVIEW_PAD + (ms / chart.durationMs) * usable;

  if (notes.length) {
    const range = noteRange(notes, 2);
    const yOf = (m) => h - 6 - ((m - range.min) / (range.max - range.min)) * (h - 12);
    // 總覽只用顏色區分技巧：這裡一個音才幾個像素寬，再擠符號會糊成一團
    const techByNote = techniquesByNote(chart.techniques);
    notes.forEach((note, i) => {
      const techs = techByNote.get(i);
      ctx.fillStyle = techs ? techniqueColor(techs[0], 0.85) : 'rgba(0,229,255,0.55)';
      ctx.fillRect(xOf(note.startMs), yOf(note.midi) - 1,
        Math.max(1, xOf(note.endMs) - xOf(note.startMs)), 2);
    });
  }

  // 目前可視範圍
  const span = visibleSpanMs($('#chart-preview'));
  const viewFrom = playheadMs - span * PREVIEW_JUDGE_RATIO;
  const x0 = xOf(Math.max(0, viewFrom));
  const x1 = xOf(Math.min(chart.durationMs, viewFrom + span));
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x0, 2, Math.max(2, x1 - x0), h - 4);
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, 2.5, Math.max(2, x1 - x0) - 1, h - 5);

  // 播放頭
  const px = xOf(Math.max(0, Math.min(chart.durationMs, playheadMs)));
  ctx.fillStyle = '#ffd54a';
  ctx.fillRect(px - 1, 1, 2, h - 2);
}

/** 總覽畫布的 x 座標換算成歌曲時間。 */
function overviewTimeAtX(canvas, clientX) {
  const rect = canvas.getBoundingClientRect();
  const usable = rect.width - OVERVIEW_PAD * 2;
  const ratio = (clientX - rect.left - OVERVIEW_PAD) / usable;
  return Math.max(0, Math.min(1, ratio)) * state.previewChart.durationMs;
}

/** 抓取指標讓拖曳超出畫布也持續有效；失敗不影響功能。 */
function capturePointer(el, pointerId) {
  try { el.setPointerCapture(pointerId); } catch { /* 指標不可抓取 */ }
}

function seekPreview(ms) {
  const player = state.previewPlayer;
  if (!player) return;
  const wasPlaying = player.playing;
  player.seek(Math.max(0, Math.min(player.duration, ms / 1000)));
  if (wasPlaying) player.play();
  // 跳轉後鋼琴要丟掉正在響的音、重新對齊，否則會補彈一串過去的音
  state.previewPiano?.reschedule();
  drawPreviewFrame();
}

// 視窗大小改變時重畫，否則畫布會維持舊尺寸而變形
window.addEventListener('resize', () => {
  if ($('#screen-chart').classList.contains('active')) drawPreviewFrame();
  if ($('#screen-edit').classList.contains('active')) state.editor?.draw();
});

$('#octave-slider').addEventListener('input', refreshChartPreview);
$('#sens-slider').addEventListener('input', refreshChartPreview);
$('#level-slider').addEventListener('input', refreshChartPreview);

$('#chart-confirm').addEventListener('click', async () => {
  const song = state.pendingSong;
  song.octaveOffset = Number($('#octave-slider').value);
  song.minConfidence = Number($('#sens-slider').value);
  song.minLevelDb = Number($('#level-slider').value);
  song.chartEdits = state.edits;
  // 存回伺服器：調整過的參數跟著歌走，換一台裝置也是同一份
  await api.saveSongSettings(song.id, {
    octaveOffset: song.octaveOffset,
    minConfidence: song.minConfidence,
    minLevelDb: song.minLevelDb,
    chartEdits: song.chartEdits,
  });
  startSinging(song);
});

$('#chart-back').addEventListener('click', () => { stopPreview(); show('library'); });
$('#chart-edit').addEventListener('click', () => openEditScreen());

// -- 編輯譜面 --------------------------------------------------------------

$('#edit-play').addEventListener('click', () => {
  const p = state.editPlayer;
  if (!p) return;
  if (p.playing) { p.pause(); state.editPiano?.reschedule(); } else p.play();
  $('#edit-play').textContent = p.playing ? '暫停' : '播放';
});
$('#edit-vocal').addEventListener('click', (e) => {
  e.currentTarget.classList.toggle('on');
  applyEditVocalGain();
});
$('#edit-piano').addEventListener('click', (e) => {
  e.currentTarget.classList.toggle('on');
  state.editPiano?.setEnabled(e.currentTarget.classList.contains('on'));
});

$('#edit-oct-up').addEventListener('click', () => state.editor?.shiftPitch(12));
$('#edit-oct-down').addEventListener('click', () => state.editor?.shiftPitch(-12));
$('#edit-semi-up').addEventListener('click', () => state.editor?.shiftPitch(1));
$('#edit-semi-down').addEventListener('click', () => state.editor?.shiftPitch(-1));
$('#edit-longer').addEventListener('click', () => state.editor?.stretch(80));
$('#edit-shorter').addEventListener('click', () => state.editor?.stretch(-80));
$('#edit-delete').addEventListener('click', () => state.editor?.deleteSelected());
$('#edit-undo').addEventListener('click', () => state.editor?.undo());
$('#edit-redo').addEventListener('click', () => state.editor?.redo());

$('#edit-save').addEventListener('click', async () => {
  const song = state.pendingSong;
  editStatus('儲存中…');
  try {
    // 存在伺服器上，所以換一台裝置連進來看到的也是編輯過的譜
    await api.saveSongSettings(song.id, { chartEdits: state.edits });
    song.chartEdits = state.edits;
    closeEditScreen();
    refreshChartPreview();
    show('chart');
    await preparePreviewPlayer(song);
  } catch (err) {
    editStatus(`儲存失敗：${err.message}`);
  }
});

$('#edit-revert').addEventListener('click', async () => {
  if (!confirm('會捨棄所有手動編輯，重新從音訊產生譜面。確定嗎？')) return;
  state.edits = { pitchShifts: [], notes: null };
  const song = state.pendingSong;
  editStatus('重新產生中…');
  try {
    await api.saveSongSettings(song.id, { chartEdits: state.edits });
    song.chartEdits = state.edits;
    refreshChartPreview();
    // 從譜面確認畫面的播放位置接續，使用者剛才看到哪就從哪開始編
  state.editor.setNotes(state.previewChart.notes, state.previewChart.durationMs,
    state.previewPlayer ? previewPositionMs() : null);
    state.editPiano?.setNotes(state.previewChart.notes);
    editStatus('已還原成自動抽取的結果。');
  } catch (err) {
    editStatus(`還原失敗：${err.message}`);
  }
});

$('#edit-cancel').addEventListener('click', () => {
  // 取消：把記憶體裡的編輯丟掉，重讀伺服器上那份
  state.edits = normalizeEdits(state.pendingSong.chartEdits);
  closeEditScreen();
  refreshChartPreview();
  show('chart');
  preparePreviewPlayer(state.pendingSong);
});

window.addEventListener('keydown', (e) => {
  if (!$('#screen-edit').classList.contains('active')) return;
  if (e.target.matches('input, textarea')) return;
  const ed = state.editor;
  if (!ed) return;
  const big = e.shiftKey;
  const handlers = {
    ArrowUp: () => ed.shiftPitch(big ? 12 : 1),
    ArrowDown: () => ed.shiftPitch(big ? -12 : -1),
    ArrowLeft: () => ed.nudgeTime(big ? -200 : -20),
    ArrowRight: () => ed.nudgeTime(big ? 200 : 20),
    Delete: () => ed.deleteSelected(),
    Backspace: () => ed.deleteSelected(),
    ' ': () => $('#edit-play').click(),
  };
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) ed.redo(); else ed.undo();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    ed.selectAll();
    return;
  }
  if (handlers[e.key]) {
    e.preventDefault();
    handlers[e.key]();
  }
});


$('#preview-vocal').addEventListener('click', (e) => {
  state.vocalOn = !state.vocalOn;
  e.currentTarget.classList.toggle('on', state.vocalOn);
  applyPreviewVocalGain();
});
$('#preview-piano').addEventListener('click', (e) => {
  state.pianoOn = !state.pianoOn;
  e.currentTarget.classList.toggle('on', state.pianoOn);
  state.previewPiano?.setEnabled(state.pianoOn);
});

// -- 時間軸：播放、跳轉、拖曳 --------------------------------------------

function setPreviewPlaying(playing) {
  $('#preview-play').textContent = playing ? '暫停' : '播放';
  cancelAnimationFrame(state.previewRaf);
  if (playing) {
    const tick = () => {
      drawPreviewFrame();
      state.previewRaf = requestAnimationFrame(tick);
    };
    state.previewRaf = requestAnimationFrame(tick);
  }
}

$('#preview-play').addEventListener('click', async () => {
  const player = state.previewPlayer;
  if (!player) return;
  await audioCtx();
  if (player.playing) {
    player.pause();
    setPreviewPlaying(false);
    drawPreviewFrame();
  } else {
    // 播到底了就從頭再來
    if (player.currentTime >= player.duration - 0.05) player.seek(0);
    player.play();
    setPreviewPlaying(true);
  }
});

function previewSkip(seconds) {
  if (state.previewPlayer) seekPreview((state.previewPlayer.currentTime + seconds) * 1000);
}

$('#preview-back5').addEventListener('click', () => previewSkip(-5));
$('#preview-fwd5').addEventListener('click', () => previewSkip(5));

// 音程條：左右拖曳來捲動（播放頭固定，所以拖多少就是移動多少時間）
{
  const canvas = $('#chart-preview');
  let dragStartX = 0;
  let dragStartMs = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.previewPlayer || !state.previewChart) return;
    state.previewDragging = true;
    dragStartX = e.clientX;
    dragStartMs = previewPositionMs();
    canvas.classList.add('dragging');
    capturePointer(canvas, e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.previewDragging) return;
    // 內容往左拖 = 時間往後
    const deltaMs = ((dragStartX - e.clientX) / PREVIEW_PX_PER_SEC) * 1000;
    seekPreview(dragStartMs + deltaMs);
  });
  const endDrag = (e) => {
    if (!state.previewDragging) return;
    state.previewDragging = false;
    canvas.classList.remove('dragging');
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* 指標已釋放 */ }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // 觸控板橫向滑動 / 滾輪
  canvas.addEventListener('wheel', (e) => {
    if (!state.previewPlayer) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    e.preventDefault();
    seekPreview(previewPositionMs() + (delta / PREVIEW_PX_PER_SEC) * 1000);
  }, { passive: false });
}

// 總覽條：點一下或拖曳做粗定位
{
  const canvas = $('#chart-overview');
  let dragging = false;
  const jump = (clientX) => {
    if (!state.previewChart || !state.previewPlayer) return;
    seekPreview(overviewTimeAtX(canvas, clientX));
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.previewPlayer) return;
    dragging = true;
    // 先跳轉再抓指標：抓取失敗不該讓點擊整個失效
    jump(e.clientX);
    capturePointer(canvas, e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => { if (dragging) jump(e.clientX); });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* 指標已釋放 */ }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function stopPreview() {
  cancelAnimationFrame(state.previewRaf);
  state.previewDragging = false;
  state.previewPiano?.stop();
  if (state.previewPlayer) {
    state.previewPlayer.stop();
    state.previewPlayer.node?.disconnect();
    state.previewPlayer.gain.disconnect();
    state.previewPlayer = null;
  }
  $('#preview-play').textContent = '播放';
}

// ── 演唱 ────────────────────────────────────────────────────

/**
 * 組出播放用的音軌。第 0 軌是伴奏，第 1 軌是原唱（導唱）。
 * 兩軌交給同一個 worklet，共用播放位置，開關導唱不會跑掉拍。
 *
 * 後端模式有分離好的人聲軌，導唱就疊在伴奏上；簡易模式沒有乾淨人聲，
 * 導唱改成直接播原曲，並把 L−R 伴奏靜音，避免兩者疊起來變成怪異的相位。
 */
async function loadTracks(song, ctx, onProgress = null) {
  const guide = state.guideOn;

  // 伴奏與導唱都存在伺服器上，按下演唱才抓；抓過的會走本機快取
  const instBlob = await api.getStem(song.id, 'instrumental',
    (done, total, cached) => onProgress?.('伴奏', done, total, cached));
  const vocalBlob = song.hasGuide
    ? await api.getStem(song.id, 'vocals',
        (done, total, cached) => onProgress?.('原唱', done, total, cached))
    : null;

  const [inst, vocals] = await Promise.all([
    ctx.decodeAudioData(await instBlob.arrayBuffer()),
    vocalBlob ? ctx.decodeAudioData(await vocalBlob.arrayBuffer()) : null,
  ]);

  const tracks = [{ buffer: inst, gain: 1 }];
  // 導唱軌降成單聲道：人聲本來就置中，這樣可以省下一半記憶體
  // （手機上兩軌立體聲的 4 分鐘歌曲會吃掉將近 170MB）
  if (vocals) tracks.push({ buffer: monoBuffer(ctx, vocals), gain: guide ? GUIDE_GAIN : 0 });
  return { tracks, mode: 'backend', hasGuide: !!vocals };
}

const GUIDE_GAIN = 0.75;

function monoBuffer(ctx, audioBuffer) {
  if (audioBuffer.numberOfChannels === 1) return audioBuffer;
  const out = ctx.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
  out.copyToChannel(toMono(audioBuffer), 0);
  return out;
}

/** 切換導唱。依模式調整兩軌的音量，播放位置不受影響。 */
function applyGuide(on) {
  state.guideOn = on;
  const btn = $('#guide-toggle');
  btn.textContent = on ? '原唱 開' : '原唱 關';
  btn.classList.toggle('on', on);
  if (!state.player || !state.playbackMode) return;
  if (state.playbackMode === 'backend') {
    state.player.setStemGain(1, on ? GUIDE_GAIN : 0);
  } else {
    state.player.setStemGain(0, on ? 0 : 1);
    state.player.setStemGain(1, on ? 1 : 0);
  }
}

async function startSinging(idOrSong) {
  stopPreview();
  const song = typeof idOrSong === 'string' ? await loadSong(idOrSong) : idOrSong;
  show('sing');
  $('#sing-song-name').textContent = song.name;
  setCover($('#sing-cover'), song);
  setBackdrop($('#sing-backdrop'), song);
  $('#live-score').textContent = '0';
  $('#pitch-hint').textContent = '—';
  $('#countdown').classList.remove('hidden');
  $('#countdown').textContent = '準備中';

  const ctx = await audioCtx();
  state.song = song;
  state.chart = rebuildChart(song.chart, {
    minConfidence: song.minConfidence,
    minLevelDb: song.minLevelDb,
    octaveOffset: song.octaveOffset || 0,
    edits: normalizeEdits(song.chartEdits),
  });
  state.keyShift = 0;
  $('#key-value').textContent = keyLabel(0);

  // 麥克風
  try {
    if (!state.mic) {
      state.mic = new MicTracker(ctx, {
        silenceRms: state.silenceRms,
        minConfidence: PARAMS.pitch.minConfidence,
      });
      await state.mic.start();
    }
  } catch (err) {
    alert(`無法使用麥克風：${err.message}\n請確認瀏覽器已授權，且網址是 http://localhost。`);
    show('library');
    return;
  }
  state.mic.silenceRms = state.silenceRms;

  // 延遲設定檔
  const profile = await store.getLatencyProfile(state.mic.deviceLabel, state.outputLabel);
  state.latencyProfile = profile || null;
  const baseLatency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  state.latencyMs = profile
    ? profile.offsetMs + state.manualLatencyMs
    : Math.round(baseLatency * 1000) + state.manualLatencyMs;
  $('#latency-note').textContent = profile
    ? `延遲補償 ${state.latencyMs}ms（${profile.micLabel} × ${profile.outputLabel}）`
    : `延遲補償 ${state.latencyMs}ms（估計值，建議先做一次拍手校準）`;

  // 播放器
  if (!state.player) state.player = new KeyPlayer(ctx);
  const { tracks, mode, hasGuide } = await loadTracks(song, ctx,
    (label, done, total, cached) => {
      if (cached || !total) return;
      $('#countdown').textContent = `${label} ${Math.round(done / total * 100)}%`;
    });
  state.playbackMode = mode;
  await state.player.load(tracks);
  $('#guide-toggle').disabled = !hasGuide;
  applyGuide(hasGuide && state.guideOn);
  state.player.connect(ctx.destination);
  state.player.setVolume(0.9);
  state.player.setSemitones(0);

  // 評分與畫面
  state.scorer = new LiveScorer(state.chart, { keyShift: 0 });
  if (!state.renderer) state.renderer = new StageRenderer($('#stage'));
  state.renderer.resize();
  state.renderer.setChart(state.chart.notes, state.chart.techniques,
    noteRange(state.chart.notes, 3));
  state.renderer.setKeyShift(0);
  state.renderer.clearTrail();
  setupSingLyrics(song);

  // 八度旁證：把參考譜當下的音餵給音高偵測器。只影響「判成哪個八度」，
  // 音分仍然完全來自麥克風，唱偏多少照樣扣分。
  state.mic.refMidiAt = (t, phraseStart) => {
    if (!state.singing) return 0;
    const songMs = state.player.songTimeAt(t) * 1000 - state.latencyMs;
    return songMs < 0 ? 0 : state.scorer.octaveHint(songMs, phraseStart);
  };

  state.mic.onFrame = (frame) => {
    if (!state.singing) return;
    const songMs = state.player.songTimeAt(frame.t) * 1000 - state.latencyMs;
    if (songMs < 0) return;
    state.scorer.addFrame({ ...frame, songMs });
    if (frame.midi > 0) {
      // 顯示用的八度基準要穩定，不能每一框都跟著即時最佳解跳動
      const oct = state.scorer.displayOctave();
      if (state.shownOct === null) state.shownOct = oct;
      else if (oct !== state.shownOct) {
        // 基準真的變了：把已畫的軌跡一起搬過去，否則線會斷成上下兩截
        state.renderer.shiftTrail(oct - state.shownOct);
        state.shownOct = oct;
      }
      const hint = state.scorer.currentHint(songMs, oct);
      state.renderer.pushUserFrame(songMs, frame.midi + oct, hint === 'good');
    }
    if (DEBUG_OCTAVE) state.lastDiagFrame = frame;
  };

  state.finished = false;
  state.lastTechCheck = 0;
  state.lastTechPopMs = -1;
  state.shownOct = null;
  await countdown();
  state.singing = true;
  $('#sing-toggle').textContent = '暫停';
  state.player.onended = () => finishSinging();
  state.player.play(0);
  loop();
}

function countdown() {
  const el = $('#countdown');
  return new Promise((resolve) => {
    let n = 3;
    el.textContent = n;
    const timer = setInterval(() => {
      n -= 1;
      if (n === 0) {
        clearInterval(timer);
        el.classList.add('hidden');
        resolve();
      } else {
        el.textContent = n;
      }
    }, 800);
  });
}

// 八度診斷讀數：網址加 ?debug=1，或演唱中直接按 D 鍵開關。
// 八度出問題時，光看畫面分不出是 YIN 抓錯、平滑器判錯、還是全域對齊沒收斂。
let DEBUG_OCTAVE = new URLSearchParams(location.search).get('debug') === '1';

window.addEventListener('keydown', (e) => {
  if (e.key !== 'd' && e.key !== 'D') return;
  if (e.target.matches('input, textarea')) return;
  DEBUG_OCTAVE = !DEBUG_OCTAVE;
  if (!DEBUG_OCTAVE && state.renderer) state.renderer.debugText = '';
});

function drawOctaveDebug(songMs) {
  const sc = state.scorer;
  const f = state.lastDiagFrame;
  const noteIdx = sc.refNoteByBin.get(Math.round(songMs / sc.hopMs));
  const refNote = noteIdx === undefined ? null : sc.refNotes[noteIdx];
  // 0 跟「根本沒有值」要分得出來，否則看到 -- 沒辦法判斷是哪一種
  const n = (v) => (v === undefined || v === null ? 'nil' : v.toFixed(1));
  state.renderer.debugText = [
    f ? `raw ${n(f.raw)}  smooth ${n(f.midi)}  ref ${n(f.ref)}  conf ${n(f.conf)}  rms ${f.rms.toFixed(4)}`
      : 'raw —— 還沒收到任何音框（onFrame 提早 return 了）',
    `songMs ${songMs.toFixed(0)}  latency ${state.latencyMs}  chart ${refNote ? refNote.midi.toFixed(1) : 'nil'}`,
    `disp ${sc.displayOctave()}  best ${sc.bestOctave()}  voiced ${sc.liveVoiced}  count ${sc.liveCount}`,
    `sums [-24/-12/0/+12/+24] ${sc.liveSum.map((v) => Math.round(v)).join(' / ')}`,
  ].join('\n');
}

function loop() {
  cancelAnimationFrame(state.raf);
  const step = () => {
    if (!state.singing) return;
    const songMs = state.player.currentTime * 1000;
    // 讀數要在 draw() 之前算好，否則畫出來的永遠是上一幀的數字
    if (DEBUG_OCTAVE) drawOctaveDebug(songMs);
    state.renderer.draw(songMs);
    state.lyricsView?.update(songMs);
    $('#live-score').textContent = state.scorer.liveScore;
    $('#sing-bar').style.width = `${Math.min(100, (songMs / state.chart.durationMs) * 100)}%`;

    checkLiveTechnique(songMs);

    const hint = state.scorer.currentHint(songMs);
    const el = $('#pitch-hint');
    el.className = `pitch-hint ${hint || ''}`;
    el.textContent = hint === 'good' ? '準' : hint === 'high' ? '偏高 ↑' : hint === 'low' ? '偏低 ↓' : '—';

    state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
}

/**
 * 在最近 1.4 秒的演唱上跑一次技巧偵測，做到就彈標籤。
 * 每 400ms 檢查一次，資料量小，不影響畫面更新。
 */
function checkLiveTechnique(songMs) {
  if (songMs - state.lastTechCheck < 400) return;
  state.lastTechCheck = songMs;
  const from = songMs - 1400;
  const octave = state.scorer.bestOctave();
  const raw = state.scorer.userFrames
    .filter((f) => f.t >= from && f.midi > 0)
    .map((f) => ({ t: f.t, midi: f.midi + octave, conf: f.conf, rms: f.rms }));
  if (raw.length < 20) return;
  // 跟原唱譜面分析、結算計分共用同一套流程：先做信心／音量門檻與八度修正，
  // 再切段偵測技巧。少了這一步，雜訊與八度誤判會被直接當成技巧演出，
  // 唱歌途中會比對照原唱時容易觸發得多。
  const frames = prepareFrames(raw, PARAMS.pitch);
  const notes = framesToNotes(frames, PARAMS.pitch);
  const events = detectTechniques(notes, frames, state.chart.hopMs);
  const latest = events[events.length - 1];
  if (latest && latest.startMs > state.lastTechPopMs) {
    state.lastTechPopMs = latest.startMs;
    popTechnique(latest.type);
  }
}

/** 技巧達成時彈出該技巧的符號，形狀與顏色都跟譜面上的一致。 */
function popTechnique(type) {
  const el = $('#tech-popup');
  const canvas = el.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = 132, h = 66;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.shadowColor = techniqueColor(type, 0.9);
  ctx.shadowBlur = 18;
  drawTechniqueGlyph(ctx, type, w / 2, h / 2, 26);

  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

$('#sing-toggle').addEventListener('click', () => {
  if (!state.player) return;
  if (state.player.playing) {
    state.player.pause();
    state.singing = false;
    cancelAnimationFrame(state.raf);
    $('#sing-toggle').textContent = '繼續';
  } else {
    state.singing = true;
    state.player.play();
    $('#sing-toggle').textContent = '暫停';
    loop();
  }
});

$('#sing-stop').addEventListener('click', () => finishSinging());

function changeKey(delta) {
  if (!state.player) return;
  state.keyShift = state.player.setSemitones(state.keyShift + delta);
  $('#key-value').textContent = keyLabel(state.keyShift);
  state.renderer.setKeyShift(state.keyShift);
  state.scorer.setKeyShift(state.keyShift, state.player.currentTime * 1000);
}
$('#guide-toggle').addEventListener('click', async () => {
  applyGuide(!state.guideOn);
  await store.setSetting('guideVocal', state.guideOn);
});

$('#key-up').addEventListener('click', () => changeKey(1));
$('#key-down').addEventListener('click', () => changeKey(-1));

async function finishSinging() {
  if (!state.scorer || state.finished) return;
  state.finished = true;
  state.singing = false;
  cancelAnimationFrame(state.raf);
  state.player.pause();
  if (state.mic) { state.mic.onFrame = null; state.mic.refMidiAt = null; }

  const res = state.scorer.finish();
  await store.saveScore({
    songId: state.song.id,
    total: res.total,
    breakdown: res.breakdown,
    techniqueCounts: res.techniqueCounts,
    keyShift: res.keyShift,
  });
  showResult(res);
  renderLibrary();
}

// ── 結算 ────────────────────────────────────────────────────

async function showResult(res) {
  show('result');
  setCover($('#result-cover'), state.song);
  setBackdrop($('#result-backdrop'), state.song);
  $('#result-song-name').textContent = state.song?.name || '';
  $('#result-grade').textContent = res.grade;
  $('#result-comment').textContent = res.comment;
  result.animateScore($('#result-score'), res.total);
  result.drawRadar($('#radar'), res.breakdown);
  result.drawPitchCompare($('#compare'), state.chart, res);
  if (res.total >= 80) result.burstParticles($('#particles'), res.total / 100);

  const items = result.techniqueSummary(res);
  $('#tech-list').innerHTML = items.length
    ? items.map((i) => `<li><span style="color:${techniqueColor(i.type)}">${i.label}</span>`
        + `<span>${i.count} 次</span></li>`).join('')
    : '<li class="empty">這次沒有偵測到技巧</li>';
  $('#tech-note').textContent = res.matchedOriginal
    ? `其中 ${res.matchedOriginal} 次與原唱使用技巧的位置吻合，已加分。`
    : '在原唱標記技巧的位置做出同樣的技巧會有額外加分。';

  setupTakeExport(res);

  const best = await store.bestScore(state.song.id);
  const octaveNote = res.octaveOffset ? `（以 ${res.octaveOffset > 0 ? '+' : ''}${res.octaveOffset} 半音的八度對齊計分）` : '';
  $('#best-note').textContent = best
    ? `個人最佳 ${best.total.toFixed(1)} 分${octaveNote}`
    : octaveNote;
}

/**
 * 匯出這次演唱的原始資料（網址加 ?debug=1 才會出現）。
 *
 * 評分的門檻要訂在哪，得看麥克風實際收到什麼：伴奏漏音有多大聲、信心值
 * 掉到多少、八度誤判到底多頻繁。這些只能從真實的一次演唱量，合成訊號量
 * 出來的數字是自己編的假設，拿來調參數等於自己驗證自己。
 */
function setupTakeExport(res) {
  const host = $('#best-note');
  const old = document.getElementById('export-take');
  if (old) old.remove();
  if (!DEBUG_OCTAVE) return;
  const btn = document.createElement('button');
  btn.id = 'export-take';
  btn.className = 'ghost tiny mt';
  btn.textContent = '⬇ 匯出本次演唱原始資料';
  btn.addEventListener('click', () => {
    const take = {
      songId: state.song.id,
      songName: state.song.name,
      recordedAt: new Date().toISOString(),
      // 收音鏈的設定：分數對不對，一半要看這幾個值
      latencyMs: state.latencyMs,
      latencyCalibrated: !!state.latencyProfile,
      guideVocalOn: state.guideOn,
      micLabel: state.mic?.deviceLabel || null,
      outputLabel: state.outputLabel || null,
      silenceRms: state.silenceRms ?? null,
      keyShift: res.keyShift,
      total: res.total,
      breakdown: res.breakdown,
      octaveOffset: res.octaveOffset,
      chartEdits: state.edits,
      pitchParams: PARAMS.pitch,
      // 逐框原始資料：t=歌曲時間, raw=門檻前的偵測音高, midi=過門檻後,
      // conf=偵測信心, rms=音量
      frames: res.userFrames.map((f) => [
        Math.round(f.t),
        f.rawMidi ? Math.round(f.rawMidi * 100) / 100 : 0,
        f.midi ? Math.round(f.midi * 100) / 100 : 0,
        Math.round(f.conf * 1000) / 1000,
        Math.round(f.rms * 100000) / 100000,
      ]),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(take)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `take-${state.song.id}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  host.after(btn);
}

$('#result-retry').addEventListener('click', () => startSinging(state.song));
$('#result-back').addEventListener('click', () => { show('library'); renderLibrary(); });

// ── 延遲校準 ────────────────────────────────────────────────

async function openCalibrate() {
  show('calibrate');
  $('#calib-result').classList.add('hidden');
  try {
    const ctx = await audioCtx();
    if (!state.mic) {
      state.mic = new MicTracker(ctx, {
        silenceRms: state.silenceRms,
        minConfidence: PARAMS.pitch.minConfidence,
      });
      await state.mic.start();
    }
  } catch (err) {
    $('#calib-status').textContent = `無法使用麥克風：${err.message}`;
    return;
  }
  const { inputs, outputs } = await listDevices();
  $('#calib-mic').innerHTML = inputs
    .map((d) => `<option value="${d.deviceId}">${escapeHtml(d.label || '麥克風')}</option>`).join('');
  const outOptions = outputs.length
    ? outputs.map((d) => `<option value="${escapeHtml(d.label || '輸出')}">${escapeHtml(d.label || '輸出')}</option>`).join('')
    : ['耳機', '筆電喇叭', '外接喇叭', '藍牙耳機']
        .map((n) => `<option value="${n}">${n}</option>`).join('');
  $('#calib-out').innerHTML = outOptions;
  $('#calib-out').value = state.outputLabel && outputs.some((o) => o.label === state.outputLabel)
    ? state.outputLabel : $('#calib-out').options[0]?.value || '預設輸出';
}

$('#calib-start').addEventListener('click', async () => {
  const btn = $('#calib-start');
  btn.disabled = true;
  $('#calib-result').classList.add('hidden');
  $('#calib-status').textContent = '播放中，跟著拍手…';

  const beats = 16, leadIn = 8;
  const dots = $('#beat-dots');
  dots.innerHTML = Array.from({ length: beats },
    (_, i) => `<i class="${i < leadIn ? 'lead' : ''}"></i>`).join('');

  const ctx = await audioCtx();
  const micId = $('#calib-mic').value;
  if (micId && state.mic.deviceId !== micId) {
    state.mic.stop();
    state.mic = new MicTracker(ctx, {
        silenceRms: state.silenceRms,
        minConfidence: PARAMS.pitch.minConfidence,
      });
    await state.mic.start(micId);
  }
  state.outputLabel = $('#calib-out').value;

  const calibrator = new LatencyCalibrator(ctx, state.mic);
  try {
    const res = await calibrator.run({
      beats, leadIn,
      onBeat: (i) => {
        const el = dots.children[i];
        if (!el) return;
        el.classList.add('on');
        setTimeout(() => el.classList.remove('on'), 140);
      },
    });
    const ok = isReliable(res);
    const box = $('#calib-result');
    box.classList.remove('hidden');
    box.classList.toggle('bad', !ok);
    if (ok) {
      await persistLatency(res, state.mic.deviceLabel, state.outputLabel);
      box.innerHTML = `
        <div class="value">${res.offsetMs} ms</div>
        <p class="muted small">${res.accepted}/${res.total} 拍有效，離散 ±${Math.round(res.spreadMs / 2)}ms</p>
        <p class="small">已存成設定檔：${escapeHtml(state.mic.deviceLabel)} × ${escapeHtml(state.outputLabel)}</p>`;
      $('#calib-status').textContent = '校準完成。';
    } else {
      box.innerHTML = `
        <div class="value">量測不夠可靠</div>
        <p class="muted small">只對到 ${res.accepted}/${res.total} 拍（離散 ${res.spreadMs}ms）。
        請把音量開大、用力拍手，並確認麥克風收得到拍手聲，再試一次。</p>`;
      $('#calib-status').textContent = '請再試一次。';
    }
  } catch (err) {
    $('#calib-status').textContent = `校準失敗：${err.message}`;
  } finally {
    btn.disabled = false;
    renderProfiles();
  }
});

$('#calib-back').addEventListener('click', () => show('library'));

// ── 設定 ────────────────────────────────────────────────────

/**
 * 顯示內網網址與運算裝置。
 * 打包成應用程式後沒有主控台可看，這些資訊只能從介面上取得。
 */
async function renderServerInfo() {
  const el = $('#server-info');
  try {
    const info = await fetch('api/info', { cache: 'no-store' }).then((r) => r.json());
    const rows = [];
    rows.push(['這台電腦', `<dd class="url">${escapeHtml(info.localUrl || '')}</dd>`]);
    if (info.lanUrls?.length) {
      rows.push(['內網其他裝置',
        info.lanUrls.map((u) => `<dd class="url">${escapeHtml(u)}</dd>`).join('')]);
    } else {
      rows.push(['內網其他裝置', '<dd class="off">沒有可用的憑證，內網裝置不會有麥克風</dd>']);
    }
    const active = (info.devices || []).find((d) => d.device && d.device === info.device);
    rows.push(['分離運算', `<dd>${escapeHtml(active ? active.label : String(info.device || '偵測中'))}</dd>`]);
    const others = (info.devices || [])
      .filter((d) => d.name !== '_torch' && d.name !== 'cpu')
      .map((d) => `${d.label}${d.available ? '✓' : '✗'}`).join('　');
    rows.push(['偵測結果', `<dd class="off">${escapeHtml(others)}</dd>`]);
    rows.push(['曲庫', `<dd>${info.songs ?? 0} 首（存在這台電腦上）</dd>`]);
    const torch = (info.devices || []).find((d) => d.name === '_torch');
    if (torch) rows.push(['版本', `<dd class="off">${escapeHtml(torch.label)}
      ・yt-dlp ${escapeHtml(info.downloader || '未安裝')}</dd>`]);

    el.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt>${v}`).join('');
  } catch {
    el.innerHTML = '<dt>狀態</dt><dd class="off">取得伺服器資訊失敗</dd>';
  }
}

async function renderCacheInfo() {
  const bytes = await store.cacheSize();
  const mb = bytes / 1048576;
  $('#cache-info').textContent = bytes
    ? `已快取 ${mb.toFixed(1)} MB`
    : '目前沒有快取（下次演唱時才會抓音軌）';
  $('#cache-clear').disabled = !bytes;
}

$('#cache-clear').addEventListener('click', async () => {
  await store.clearAudioCache();
  renderCacheInfo();
});

async function renderProfiles() {
  const profiles = await store.listLatencyProfiles();
  const list = $('#profile-list');
  if (!profiles.length) {
    list.innerHTML = '<li class="empty">還沒有任何設定檔，先做一次拍手校準。</li>';
    return;
  }
  list.innerHTML = profiles.map((p) => `
    <li data-id="${escapeHtml(p.id)}">
      <span class="pname">${escapeHtml(p.micLabel)} × ${escapeHtml(p.outputLabel)}</span>
      <span class="pval">${p.offsetMs} ms</span>
      <button class="ghost tiny danger" data-act="del">刪除</button>
    </li>`).join('');
}

$('#profile-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="del"]');
  if (!btn) return;
  await store.deleteLatencyProfile(btn.closest('li').dataset.id);
  renderProfiles();
});

$('#manual-latency').addEventListener('input', async (e) => {
  state.manualLatencyMs = Number(e.target.value);
  $('#manual-latency-value').textContent = `${state.manualLatencyMs} ms`;
  await store.setSetting('manualLatencyMs', state.manualLatencyMs);
});

$('#silence-slider').addEventListener('input', async (e) => {
  state.silenceRms = Number(e.target.value);
  $('#silence-value').textContent = state.silenceRms.toFixed(3);
  if (state.mic) state.mic.silenceRms = state.silenceRms;
  await store.setSetting('silenceRms', state.silenceRms);
});

$('#settings-back').addEventListener('click', () => show('library'));

// ── 封面（譜面頁的更換／重抓） ─────────────────────────────────

function applyCoverMeta(meta) {
  const song = state.pendingSong;
  if (!song || meta?.id !== song.id) return;
  song.cover = meta.cover;
  song.coverSource = meta.coverSource;
  setCover($('#chart-cover'), song);
  const listed = state.songs?.find((s) => s.id === song.id);
  if (listed) { listed.cover = meta.cover; listed.coverSource = meta.coverSource; }
}

const pickCover = () => $('#cover-file').click();
$('#chart-cover').addEventListener('click', pickCover);
$('#cover-upload').addEventListener('click', pickCover);
$('#cover-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const song = state.pendingSong;
  if (!file || !song) return;
  if (file.size > 8 * 1024 * 1024) { $('#cover-status').textContent = '圖片要在 8MB 以內'; return; }
  $('#cover-status').textContent = '上傳中…';
  try {
    applyCoverMeta(await api.uploadCover(song.id, file));
    $('#cover-status').textContent = '已更換';
  } catch (err) {
    $('#cover-status').textContent = `失敗：${err.message}`;
  }
});
$('#cover-refetch').addEventListener('click', async () => {
  const song = state.pendingSong;
  if (!song) return;
  $('#cover-refetch').disabled = true;
  $('#cover-status').textContent = '尋找中…';
  try {
    applyCoverMeta(await api.refetchCover(song.id));
    $('#cover-status').textContent = '已更新';
  } catch (err) {
    $('#cover-status').textContent = err.message;
  } finally {
    $('#cover-refetch').disabled = false;
  }
});

// ── 歌詞 ────────────────────────────────────────────────────
//
// 歌詞存在伺服器上（library/<id>/lyrics.json），加歌時就在背景自動抓。
// 演唱畫面顯示 KTV 兩行歌詞；譜面確認畫面可以重抓、上傳 .lrc、貼網址、
// 調整整首的時間位移，並在試聽時同步顯示，方便對時間。

function applyLyricsPrefs() {
  const p = state.lyricsPrefs;
  $('#lyr-opt-ruby').checked = p.ruby;
  $('#lyr-opt-romaji').checked = p.romaji;
  $('#lyr-opt-karaoke').checked = p.karaoke;
  $('#lyrics-toggle').classList.toggle('on', p.show);
  $('#sing-lyrics').classList.toggle('hidden-lyrics', !p.show);
  const opts = { ruby: p.ruby, romaji: p.romaji, karaoke: p.karaoke };
  state.lyricsView?.setOptions(opts);
  state.previewLyricsView?.setOptions(opts);
}

async function saveLyricsPrefs(patch) {
  state.lyricsPrefs = { ...state.lyricsPrefs, ...patch };
  applyLyricsPrefs();
  await store.setSetting('lyricsPrefs', state.lyricsPrefs);
}

$('#lyr-opt-ruby').addEventListener('change', (e) => saveLyricsPrefs({ ruby: e.target.checked }));
$('#lyr-opt-romaji').addEventListener('change', (e) => saveLyricsPrefs({ romaji: e.target.checked }));
$('#lyr-opt-karaoke').addEventListener('change', (e) => saveLyricsPrefs({ karaoke: e.target.checked }));
$('#lyrics-toggle').addEventListener('click', () => saveLyricsPrefs({ show: !state.lyricsPrefs.show }));

function lyricsViewOpts() {
  const { ruby, romaji, karaoke } = state.lyricsPrefs;
  return { ruby, romaji, karaoke };
}

/** 演唱畫面：先顯示已有的歌詞；從來沒抓過就在背景抓一次，抓到了再補上。 */
async function setupSingLyrics(song) {
  if (!state.lyricsView) {
    state.lyricsView = new LyricsView($('#sing-lyrics'), { ...lyricsViewOpts(), layout: 'dam' });
  }
  state.lyrics = null;
  state.lyricsView.setLyrics(null, [], '');
  let data = null;
  try {
    data = await api.getLyrics(song.id);
  } catch { /* 歌詞拿不到不影響唱歌 */ }
  if (state.song?.id !== song.id) return;
  if (data === null) {
    state.lyricsView.setLyrics(null, [], '正在找歌詞…');
    try { data = await api.fetchLyrics(song.id); } catch { data = null; }
    if (state.song?.id !== song.id) return;
  }
  state.lyrics = data;
  state.lyricsView.setLyrics(data, state.chart.notes,
    data?.lines?.length ? '' : '這首歌沒有歌詞。可以到「譜面」頁上傳 .lrc 或貼網址');
  state.lyricsView.update(state.player ? state.player.currentTime * 1000 : 0);
}

function setPreviewLyrics(data) {
  state.previewLyrics = data;
  if (!state.previewLyricsView) {
    state.previewLyricsView = new LyricsView($('#chart-lyrics'), lyricsViewOpts());
  }
  state.previewLyricsView.setLyrics(data, state.previewChart?.notes || [],
    data?.lines?.length ? '' : (data ? '找不到歌詞' : '還沒有歌詞'));
  state.previewLyricsView.update(previewPositionMs());

  $('#lyrics-status').textContent = describeLyrics(data);
  const offset = Number(data?.offsetMs) || 0;
  $('#lyrics-offset-value').textContent = `${offset > 0 ? '+' : offset < 0 ? '−' : '±'}${(Math.abs(offset) / 1000).toFixed(1)} 秒`;
  const hasLines = !!data?.lines?.length;
  $('#lyrics-earlier').disabled = !hasLines;
  $('#lyrics-later').disabled = !hasLines;
  $('#lyrics-remove').disabled = !hasLines;
  $('#lyrics-log').textContent = (data?.log || []).join('\n') || '（沒有紀錄）';
  if (data?.note) $('#lyrics-status').textContent += `｜${data.note}`;
  if (data?.fetchError) $('#lyrics-status').textContent += `｜重抓失敗，保留原本的歌詞`;
}

async function loadChartLyrics(song) {
  $('#lyrics-status').textContent = '讀取中…';
  let data = null;
  try {
    data = await api.getLyrics(song.id);
  } catch (err) {
    $('#lyrics-status').textContent = `讀取失敗：${err.message}`;
  }
  if (state.pendingSong?.id !== song.id) return;
  $('#lyrics-title').value = data?.title || song.name;
  $('#lyrics-artist').value = data?.artist ?? (song.uploader || '');
  $('#lyrics-url').value = data?.searchUrl || lrclibUrl($('#lyrics-title').value, $('#lyrics-artist').value);
  setPreviewLyrics(data);
}

function lrclibUrl(title, artist) {
  const q = new URLSearchParams({ track_name: title.trim() });
  if (artist.trim()) q.set('artist_name', artist.trim());
  return `https://lrclib.net/api/search?${q}`;
}

/** 歌詞操作共用：鎖按鈕、顯示進度、成功就換上新歌詞。 */
async function lyricsAction(label, fn) {
  const song = state.pendingSong;
  if (!song) return;
  const buttons = $$('.lyrics-card button');
  buttons.forEach((b) => { b.disabled = true; });
  $('#lyrics-status').textContent = label;
  try {
    const data = await fn(song);
    if (state.pendingSong?.id === song.id) setPreviewLyrics(data);
  } catch (err) {
    $('#lyrics-status').textContent = `失敗：${err.message}`;
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    if (state.pendingSong?.id === song.id && !state.previewLyrics?.lines?.length) {
      $('#lyrics-earlier').disabled = $('#lyrics-later').disabled = $('#lyrics-remove').disabled = true;
    }
  }
}

$('#lyrics-fetch').addEventListener('click', () =>
  lyricsAction('自動抓取中…（YT Music → LRCLIB → YouTube 字幕，約 5～20 秒）',
    (song) => api.fetchLyrics(song.id)));

$('#lyrics-research').addEventListener('click', () => {
  const title = $('#lyrics-title').value.trim();
  const artist = $('#lyrics-artist').value.trim();
  if (!title) return;
  $('#lyrics-url').value = lrclibUrl(title, artist);
  lyricsAction(`以「${title}」重新搜尋中…`, (song) => api.fetchLyrics(song.id, title, artist));
});

$('#lyrics-url-go').addEventListener('click', () => {
  const url = $('#lyrics-url').value.trim();
  if (!url) return;
  lyricsAction('從網址抓取中…', (song) => api.lyricsFromUrl(song.id, url));
});

$('#lyrics-upload').addEventListener('click', () => $('#lyrics-file').click());
$('#lyrics-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 512 * 1024) { alert('這個檔案太大了，不像是 .lrc 歌詞檔'); return; }
  const text = await file.text();
  lyricsAction(`處理「${file.name}」中…`, (song) => api.uploadLyrics(song.id, text, file.name));
});

$('#lyrics-remove').addEventListener('click', () => {
  if (!confirm('移除這首歌的歌詞？之後可以再按「自動抓取」或上傳。')) return;
  lyricsAction('移除中…', async (song) => { await api.deleteLyrics(song.id); return null; });
});

// 時間位移：按一下馬上反映在試聽上，存檔延後一點，連按時不必每下都送
let offsetTimer = null;
function nudgeLyrics(deltaMs) {
  const data = state.previewLyrics;
  const song = state.pendingSong;
  if (!data?.lines?.length || !song) return;
  data.offsetMs = Math.max(-15000, Math.min(15000, (Number(data.offsetMs) || 0) + deltaMs));
  setPreviewLyrics(data);
  clearTimeout(offsetTimer);
  offsetTimer = setTimeout(() => {
    api.setLyricsOffset(song.id, data.offsetMs).catch((err) => {
      $('#lyrics-status').textContent = `時間位移存檔失敗：${err.message}`;
    });
  }, 400);
}
$('#lyrics-earlier').addEventListener('click', () => nudgeLyrics(-200));
$('#lyrics-later').addEventListener('click', () => nudgeLyrics(200));

// ── 手機連線（只在這台電腦上顯示） ──────────────────────────

async function renderConnect() {
  const info = state.serverInfo || {};
  const lanUrl = (info.lanUrls || [])[0];

  $('#qr-lan-url').textContent = lanUrl || '（找不到內網位址）';
  $('#qr-lan').innerHTML = lanUrl
    ? '<div class="qr-empty">產生中…</div>'
    : '<div class="qr-empty">這台電腦沒有連上區域網路</div>';
  if (lanUrl) loadQr('lan', '#qr-lan');

  $('#tunnel-on-start').checked = !!(info.settings || {}).tunnelOnStart;
  await refreshTunnel();
}

/** QR 由伺服器產生（純 Python，不連外），這裡把 SVG 直接塞進去。 */
async function loadQr(target, selector) {
  try {
    const svg = await fetch(`api/qr?target=${target}`).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    });
    $(selector).innerHTML = svg;
  } catch {
    $(selector).innerHTML = '<div class="qr-empty">QR 產生失敗</div>';
  }
}

async function refreshTunnel() {
  let st;
  try {
    st = await fetch('api/tunnel', { cache: 'no-store' }).then((r) => r.json());
  } catch {
    return;
  }
  state.tunnel = st;

  const btn = $('#tunnel-toggle');
  const note = $('#tunnel-note');
  const box = $('#qr-tunnel');
  const urlEl = $('#qr-tunnel-url');

  if (!st.available && st.canInstall) {
    // 第一次按的時候伺服器會自己從 Cloudflare 官方下載，不必先打指令
    btn.disabled = !!st.installing;
    btn.classList.remove('on');
    btn.textContent = st.installing ? '下載中…' : '建立公開網址';
    note.innerHTML = '第一次使用會自動從 Cloudflare 官方下載 cloudflared（約 20～55MB，驗證校驗值後才使用），之後就不必再下載。'
      + `也可以自己安裝：<code>${escapeHtml(st.installHint || '')}</code>`;
    box.innerHTML = `<div class="qr-empty">${st.installing
      ? `下載 cloudflared 中… ${Math.round((st.installProgress || 0) * 100)}%`
      : escapeHtml(st.error || '尚未建立')}</div>`;
    urlEl.textContent = st.error || '';
    return;
  }

  if (!st.available) {
    btn.disabled = true;
    btn.textContent = '需要 cloudflared';
    note.innerHTML = `這台電腦還沒有 cloudflared。安裝指令：<code>${escapeHtml(st.installHint || '')}</code>`;
    box.innerHTML = '<div class="qr-empty">未安裝 cloudflared</div>';
    urlEl.textContent = '';
    return;
  }

  btn.disabled = !!st.starting;
  btn.classList.toggle('on', !!st.running);

  if (st.running && st.url) {
    btn.textContent = '關閉公開網址';
    urlEl.textContent = st.url;
    loadQr('tunnel', '#qr-tunnel');
  } else {
    btn.textContent = st.starting ? '建立中…' : '建立公開網址';
    urlEl.textContent = st.error || '';
    box.innerHTML = `<div class="qr-empty">${
      st.starting ? '建立中，請稍候…' : escapeHtml(st.error || '尚未建立')}</div>`;
  }
}

$('#tunnel-toggle').addEventListener('click', async () => {
  const running = state.tunnel?.running;
  const btn = $('#tunnel-toggle');
  btn.disabled = true;
  btn.textContent = running ? '關閉中…' : '建立中…';
  if (!running) {
    $('#qr-tunnel').innerHTML = '<div class="qr-empty">向 Cloudflare 申請中，約需 10 秒…</div>';
  }
  // 第一次要先下載 cloudflared，這段時間輪詢狀態顯示下載進度
  const needsInstall = !running && state.tunnel && !state.tunnel.available;
  const poll = needsInstall ? setInterval(async () => {
    try {
      const st = await fetch('api/tunnel', { cache: 'no-store' }).then((r) => r.json());
      $('#qr-tunnel').innerHTML = st.installing
        ? `<div class="qr-empty">第一次使用，下載 cloudflared 中… ${Math.round((st.installProgress || 0) * 100)}%</div>`
        : '<div class="qr-empty">向 Cloudflare 申請中，約需 10 秒…</div>';
    } catch { /* 下一輪再試 */ }
  }, 500) : null;
  try {
    state.tunnel = await fetch(`api/tunnel/${running ? 'stop' : 'start'}`,
      { method: 'POST' }).then((r) => r.json());
  } catch (err) {
    state.tunnel = { available: true, running: false, error: String(err.message || err) };
  }
  if (poll) clearInterval(poll);
  btn.disabled = false;
  refreshTunnel();
});

$('#tunnel-on-start').addEventListener('change', async (e) => {
  await fetch('api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tunnelOnStart: e.target.checked }),
  });
});

$('#connect-back').addEventListener('click', () => { show('library'); renderLibrary(); });

// ── 顯示卡加速 ──────────────────────────────────────────────
//
// Windows 安裝檔內附的是 CPU 版 PyTorch（CUDA 版太大，放不上 GitHub Releases）。
// 偵測到 N 卡時，第一次開啟就問要不要下載 NVIDIA 加速包，設定頁也能隨時開關。
// 實際的下載、驗證與載入見 gpu_pack.py。

const GPU_BUSY = ['downloading', 'extracting', 'verifying'];
let gpuPoll = null;
let gpuDialogDone = null;   // 第一次詢問的視窗關掉時呼叫，接著才開始導覽

const gb = (bytes) => `${(bytes / 1073741824).toFixed(2)} GB`;

function gpuHtml(st, inDialog) {
  const gpu = st.gpu ? `<span class="gpu-name">${escapeHtml(st.gpu.name)}</span>` : '';
  const note = st.disabledReason
    ? `<p class="gpu-error">上次的加速包無法啟動，已自動停用：${escapeHtml(st.disabledReason)}</p>` : '';

  if (st.loaded) {
    return `<p>正在使用 ${gpu} 加速音源分離。</p>
      ${inDialog ? '' : '<div class="row"><button class="ghost tiny danger" data-gpu="remove">改回 CPU（移除加速包）</button></div>'}`;
  }
  if (st.needRestart || st.state === 'done') {
    return `<p>NVIDIA 加速包已經裝好，重新啟動程式後生效。</p>
      <div class="row">
        ${st.canRestart ? '<button class="primary" data-gpu="restart">立即重新啟動</button>' : '<span class="muted small">請關閉程式後重新開啟</span>'}
        ${inDialog ? '<button class="ghost" data-gpu="close">稍後再說</button>' : ''}
      </div>`;
  }
  if (GPU_BUSY.includes(st.state)) {
    const pct = st.total ? Math.min(100, (st.done / st.total) * 100) : 0;
    const size = st.state === 'downloading' && st.total ? `${gb(st.done)} / ${gb(st.total)}` : '';
    return `<p>${escapeHtml(st.message || '處理中…')}</p>
      <div class="progress"><div class="progress-bar" style="width:${st.state === 'downloading' ? pct : 100}%"></div></div>
      <p class="small">${size}</p>
      <div class="row">
        ${inDialog ? '<button class="ghost" data-gpu="close">在背景下載</button>' : ''}
        <button class="ghost tiny danger" data-gpu="cancel">取消</button>
      </div>`;
  }
  if (!st.available) {
    return `<p>${escapeHtml(st.reason || '這台電腦無法使用 NVIDIA 加速。')}</p>${note}`;
  }

  const error = st.state === 'error' ? `<p class="gpu-error">下載失敗：${escapeHtml(st.error)}</p>` : '';
  const stale = st.stale ? '<p>程式更新過，需要重新下載對應版本的加速包。</p>' : '';
  return `<p>這台電腦有 ${gpu}，可以讓「加歌」時的音源分離快約 5～10 倍。</p>
    <p class="small">需要從 PyTorch 官方伺服器下載約 2 GB（會佔用約 4 GB 磁碟空間），
      下載期間照常可以唱歌。不啟用也能用，只是分離一首歌要 1～3 分鐘。</p>
    ${stale}${note}${error}
    <div class="row">
      <button class="primary" data-gpu="start">${st.state === 'error' ? '重試' : '啟用顯示卡加速'}</button>
      ${inDialog ? '<button class="ghost" data-gpu="skip">先不要</button>' : ''}
    </div>`;
}

async function renderGpu() {
  let st;
  try {
    st = await api.gpuStatus();
  } catch {
    return null;
  }
  // 手機連進來的人不該能替這台電腦下載東西，卡片整個藏起來
  $('#gpu-card').classList.toggle('hidden', !st.isLocal);
  $('#gpu-settings').innerHTML = gpuHtml(st, false);
  if (!$('#gpu-dialog').classList.contains('hidden')) {
    $('#gpu-dialog-body').innerHTML = gpuHtml(st, true);
  }
  clearTimeout(gpuPoll);
  if (GPU_BUSY.includes(st.state)) gpuPoll = setTimeout(renderGpu, 1000);
  return st;
}

function closeGpuDialog() {
  $('#gpu-dialog').classList.add('hidden');
  const done = gpuDialogDone;
  gpuDialogDone = null;
  done?.();
}

/** 第一次開啟、而且真的能用 N 卡加速時才問；回答過（不論是或否）就不再自動跳出。 */
async function maybeAskGpu() {
  if (!state.serverInfo?.isLocal) return;
  const st = await api.gpuStatus().catch(() => null);
  if (!st || !st.available || st.installed || st.promptAnswered) return;
  if (st.state !== 'idle' && st.state !== 'error') return;
  $('#gpu-dialog-body').innerHTML = gpuHtml(st, true);
  $('#gpu-dialog').classList.remove('hidden');
  await new Promise((resolve) => { gpuDialogDone = resolve; });
}

async function onGpuAction(e) {
  const btn = e.target.closest('button[data-gpu]');
  if (!btn) return;
  const act = btn.dataset.gpu;

  if (act === 'skip' || act === 'start') {
    api.saveServerSettings({ gpuPromptAnswered: true }).catch(() => {});
  }
  if (act === 'skip' || act === 'close') {
    closeGpuDialog();
    return;
  }
  if (act === 'remove' && !confirm('要移除 NVIDIA 加速包、改回用 CPU 分離嗎？\n重新啟動程式後生效。')) return;
  if (act === 'restart') {
    if (state.singing && !confirm('正在演唱中，重新啟動會結束這次演唱。確定嗎？')) return;
    btn.disabled = true;
    btn.textContent = '重新啟動中…';
    try {
      await api.restartApp();
      location.reload();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      btn.textContent = '立即重新啟動';
    }
    return;
  }

  btn.disabled = true;
  try {
    await api.gpuAction(act);
  } catch (err) {
    alert(err.message);
  }
  await renderGpu();
}

$('#gpu-dialog').addEventListener('click', onGpuAction);
$('#gpu-settings').addEventListener('click', onGpuAction);

// ── 第一次使用導覽 ──────────────────────────────────────────

async function maybeStartTour(force = false) {
  const seen = await store.getSetting('tourDone', false);
  if (seen && !force) return;
  show('library');
  await renderLibrary();
  // 等版面穩定再量位置，否則高亮框會對不準
  await new Promise((r) => setTimeout(r, 250));
  new Tour({ onFinish: () => store.setSetting('tourDone', true) }).start();
}

$('#tour-restart').addEventListener('click', () => maybeStartTour(true));

// ── 導覽 ────────────────────────────────────────────────────

$$('button[data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.goto;
    if (state.singing) {
      if (!confirm('離開會結束這次演唱，確定嗎？')) return;
      state.singing = false;
      cancelAnimationFrame(state.raf);
      state.player?.pause();
      if (state.mic) { state.mic.onFrame = null; state.mic.refMidiAt = null; }
    }
    stopPreview();
    if (target === 'connect') { renderConnect(); show('connect'); }
    else if (target === 'calibrate') openCalibrate();
    else if (target === 'settings') { renderProfiles(); renderServerInfo(); renderCacheInfo(); renderGpu(); show('settings'); }
    else { renderLibrary(); show('library'); }
  });
});

$('#nav-quit').addEventListener('click', async () => {
  if (state.singing && !confirm('正在演唱中，關閉程式會結束這次演唱。確定嗎？')) return;
  if (!confirm('要關閉這台電腦上的唱歌評分程式嗎？\n關掉之後，手機也連不進來了。')) return;

  const btn = $('#nav-quit');
  btn.disabled = true;
  btn.textContent = '關閉中…';
  state.singing = false;
  cancelAnimationFrame(state.raf);
  state.player?.pause();
  state.mic?.stop();
  try {
    await api.quitApp();
    showQuitNotice();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '⏻ 關閉程式';
    alert(`關閉失敗：${err.message}`);
  }
});

/** 程式關掉後整頁都沒用了，蓋一層說明避免使用者以為當掉。 */
function showQuitNotice() {
  const el = document.createElement('div');
  el.className = 'quit-notice';
  el.innerHTML = '<div><h2>程式已關閉</h2>'
    + '<p>唱歌評分已經從這台電腦上結束了，這個分頁可以直接關掉。</p>'
    + '<p class="hint">要再開的話，重新啟動唱歌評分程式即可。</p></div>';
  document.body.appendChild(el);
}

// ── 啟動 ────────────────────────────────────────────────────

(async function boot() {
  await loadParams();
  state.manualLatencyMs = await store.getSetting('manualLatencyMs', 0);
  state.silenceRms = await store.getSetting('silenceRms', 0.008);
  state.guideOn = await store.getSetting('guideVocal', false);
  applyGuide(state.guideOn);
  state.lyricsPrefs = { ...state.lyricsPrefs, ...(await store.getSetting('lyricsPrefs', {})) };
  applyLyricsPrefs();
  $('#manual-latency').value = state.manualLatencyMs;
  $('#manual-latency-value').textContent = `${state.manualLatencyMs} ms`;
  $('#silence-slider').value = state.silenceRms;
  $('#silence-value').textContent = state.silenceRms.toFixed(3);
  await renderLibrary();
  await renderProfiles();
  show('library');

  // 只有在這台電腦上才顯示「手機連線」——手機是掃 QR 進來的，不需要再看一次
  try {
    state.serverInfo = await api.serverInfo();
  } catch { /* 伺服器資訊拿不到就當作非本機 */ }
  $('#nav-connect').classList.toggle('hidden', !state.serverInfo?.isLocal);
  // 關閉程式同理：從手機按沒有意義，伺服器那邊也會擋掉
  $('#nav-quit').classList.toggle('hidden', !state.serverInfo?.isLocal);

  // 先問顯示卡加速（下載要很久，越早開始越好），回答完才進導覽
  await maybeAskGpu();
  maybeStartTour();
})();
