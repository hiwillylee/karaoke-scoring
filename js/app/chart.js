// app/chart.js — 譜面確認與編輯畫面，以及兩者共用的解碼音軌快取、封面與歌詞操作。

import * as api from '../api.js';
import { rebuildChart, noteRange, midiToName } from '../chart.js';
import { ChartEditor } from '../editor.js';
import { LyricsView, describeLyrics } from '../lyrics.js';
import { ChartPiano } from '../piano.js';
import { KeyPlayer } from '../pitchshift.js';
import { techniquesByNote, drawTechniqueGlyph, TECHNIQUE_PRIORITY } from '../render.js';
import * as store from '../storage.js';
import { PARAMS, TECHNIQUE_LABELS, techniqueColor } from '../techniques.js';
import { confirmBox, toast } from '../ui.js';
import { $, $$, fmtTime, setupCanvas, setToggle } from '../util.js';
import { alive, audioCtx, goLibrary, show, state } from './core.js';
import { loadSong, setCover } from './library.js';
import { drawResultCharts, monoBuffer, startSinging } from './sing.js';

// ── 譜面確認 ────────────────────────────────────────────────

export async function openChartScreen(idOrSong) {
  show('chart');
  const flow = state.flowId;
  const known = typeof idOrSong === 'string' ? state.allSongs.find((s) => s.id === idOrSong) : idOrSong;
  $('#chart-song-name').textContent = known?.name || '讀取中…';
  $('#chart-stats').textContent = '';
  $('#preview-play').disabled = true;
  if (known) setCover($('#chart-cover'), known);

  let song;
  try {
    song = typeof idOrSong === 'string' ? await loadSong(idOrSong) : idOrSong;
  } catch (err) {
    if (!alive(flow)) return;
    toast(`讀取譜面失敗：${err.message}`, { kind: 'error' });
    goLibrary();
    return;
  }
  if (!alive(flow)) return;

  state.pendingSong = song;
  $('#chart-song-name').textContent = song.name;
  setCover($('#chart-cover'), song);
  $('#cover-status').textContent = song.cover ? '' : '還沒有封面';
  $('#octave-slider').value = song.octaveOffset || 0;
  $('#sens-slider').value = song.minConfidence ?? PARAMS.pitch.minConfidence;
  $('#level-slider').value = song.minLevelDb ?? PARAMS.pitch.minLevelDb;
  state.edits = normalizeEdits(song.chartEdits);
  state.chartDirty = false;
  updateAdvancedLock();
  // 直接畫，不要透過 requestAnimationFrame——分頁在背景時 rAF 不會觸發，
  // 一次性的繪製會整個消失
  refreshChartPreview();
  loadChartLyrics(song);
  await preparePreviewPlayer(song, flow);
}

/** 手動編輯過譜面之後，「進階」的三個滑桿就不再有作用：灰掉並說明。 */
export function updateAdvancedLock() {
  const locked = !!state.edits.notes;
  $('#advanced-locked').classList.toggle('hidden', !locked);
  $$('#advanced-controls input').forEach((el) => { el.disabled = locked; });
}

/** 把譜面頁滑桿的值存回伺服器（離開畫面時自動存，不必另外按）。 */
export async function saveChartSliders() {
  const song = state.pendingSong;
  if (!song || !state.chartDirty) return;
  state.chartDirty = false;
  song.octaveOffset = Number($('#octave-slider').value);
  song.minConfidence = Number($('#sens-slider').value);
  song.minLevelDb = Number($('#level-slider').value);
  try {
    await api.saveSongSettings(song.id, {
      octaveOffset: song.octaveOffset,
      minConfidence: song.minConfidence,
      minLevelDb: song.minLevelDb,
    });
  } catch (err) {
    toast(`譜面調整沒有存成功：${err.message}`, { kind: 'error' });
    throw err;
  }
}

// ── 解碼後音軌的快取 ─────────────────────────────────────────
//
// 譜面 → 編輯 → 存檔 → 演唱 → 再唱一次，用的都是同一組音軌。以前每一步
// 都重新抓（至少一趟 304）再整份重新解碼，四分鐘的歌每次要一兩秒。
// 這裡依「歌曲＋音軌＋版本」記住解碼結果，只留最近幾份（手機記憶體有限）。

export const decoded = new Map();      // key → Promise<AudioBuffer>
export const stemChecked = new Map();  // `${id}:${kind}` → { etag, at }
export const DECODED_LIMIT = 3;
export const STEM_RECHECK_MS = 5 * 60 * 1000;

/** 這首歌某條音軌目前的版本（ETag）。最近確認過就不再問伺服器。 */
export async function stemVersion(song, kind) {
  const base = `${song.id}:${kind}`;
  const recent = stemChecked.get(base);
  if (recent && Date.now() - recent.at < STEM_RECHECK_MS) return recent.etag;
  const { etag } = await api.getStem(song.id, kind);
  stemChecked.set(base, { etag, at: Date.now() });
  return etag;
}

/** 把某條音軌的解碼結果從快取放掉（已經交給播放器、主執行緒用不到時）。 */
export function forgetDecoded(song, kind) {
  for (const key of [...decoded.keys()]) {
    if (key.startsWith(`${song.id}:${kind}:`)) decoded.delete(key);
  }
}

export async function getDecoded(song, kind, ctx, onProgress = null, mono = false) {
  const base = `${song.id}:${kind}`;
  const recent = stemChecked.get(base);
  let key = recent ? `${base}:${recent.etag}:${mono ? 'm' : 's'}` : null;
  // 剛確認過版本的就不必再問伺服器
  if (key && decoded.has(key) && Date.now() - recent.at < STEM_RECHECK_MS) {
    const p = decoded.get(key);
    decoded.delete(key); decoded.set(key, p);   // 移到最新
    onProgress?.(1, 1, true);
    return p;
  }
  const { blob, etag } = await api.getStem(song.id, kind, onProgress);
  stemChecked.set(base, { etag, at: Date.now() });
  key = `${base}:${etag}:${mono ? 'm' : 's'}`;
  if (decoded.has(key)) {
    const p = decoded.get(key);
    decoded.delete(key); decoded.set(key, p);
    return p;
  }
  const p = (async () => {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    return mono ? monoBuffer(ctx, buf) : buf;
  })();
  decoded.set(key, p);
  p.catch(() => decoded.delete(key));
  while (decoded.size > DECODED_LIMIT) decoded.delete(decoded.keys().next().value);
  return p;
}

/**
 * 取人聲軌並建一個播放器。譜面確認與編輯畫面共用。
 * @param onStatus 回報取檔進度／錯誤，讓兩個畫面各自顯示在自己的位置
 */
export async function loadPreviewAudio(song, ctx, onStatus = () => {}) {
  if (!song.hasGuide) {
    onStatus('（沒有可試聽的音軌）');
    return null;
  }
  // 音檔在伺服器上，這裡才抓下來（抓過就走本機快取）
  onStatus('取得音軌中…');
  let buffer;
  try {
    buffer = await getDecoded(song, 'vocals', ctx, (done, total, fromCache) => {
      if (!fromCache && total) onStatus(`取得音軌中… ${Math.round(done / total * 100)}%`);
    }, true);
  } catch (err) {
    onStatus(`取得音軌失敗：${err.message}`);
    return null;
  }
  const player = new KeyPlayer(ctx);
  await player.load([{ buffer, gain: 1 }]);
  player.connect(ctx.destination);
  return player;
}

export async function preparePreviewPlayer(song, flow = state.flowId) {
  stopPreview();
  $('#preview-play').disabled = true;
  const ctx = await audioCtx();
  const player = await loadPreviewAudio(song, ctx, (msg) => {
    if (alive(flow)) $('#preview-time').textContent = msg;
  });
  if (!player) return;
  if (!alive(flow)) {
    // 使用者在下載期間離開了：這個播放器用不到了
    player.node?.disconnect();
    player.gain.disconnect();
    return;
  }
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
export function applyPreviewVocalGain() {
  state.previewPlayer?.setVolume(state.vocalOn ? 1 : 0);
}

export function refreshChartPreview() {
  const song = state.pendingSong;
  if (!song) return;
  const octave = Number($('#octave-slider').value);
  const minConfidence = Number($('#sens-slider').value);
  const minLevelDb = Number($('#level-slider').value);
  $('#octave-value').textContent = octave;
  $('#sens-value').textContent = minConfidence.toFixed(2);
  $('#level-value').textContent = `${minLevelDb} dB`;

  const chart = rebuildChart(song.chart, {
    minConfidence, minLevelDb, octaveOffset: octave, edits: state.edits,
  });
  chart.techByNote = techniquesByNote(chart.techniques);   // 每幀重畫都要用，先算好
  state.previewChart = chart;
  // 譜變了，鋼琴要跟著彈新的
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
export const PREVIEW_PX_PER_SEC = 80;
// 播放頭固定在畫面這個位置，內容從右往左捲——與演唱畫面同一套視覺模型
export const PREVIEW_JUDGE_RATIO = 0.3;
export const OVERVIEW_PAD = 6;

export function previewPositionMs() {
  return state.previewPlayer ? state.previewPlayer.currentTime * 1000 : 0;
}

export function drawPreviewFrame() {
  if (!state.previewChart) return;
  const playhead = previewPositionMs();
  drawDetailStrip($('#chart-preview'), state.previewChart, playhead);
  drawOverview($('#chart-overview'), state.previewChart, playhead);
  state.previewLyricsView?.update(playhead);
  updatePreviewTime();
}

// ── 編輯譜面 ────────────────────────────────────────────────

/** 從伺服器拿到的編輯資料可能是舊格式或缺欄位，統一成已知形狀。 */
export function normalizeEdits(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  return {
    pitchShifts: Array.isArray(e.pitchShifts) ? e.pitchShifts.map((f) => ({ ...f })) : [],
    notes: Array.isArray(e.notes) ? e.notes.map((n) => ({ ...n })) : null,
  };
}

export function editStatus(text) {
  $('#edit-status').textContent = text;
}

export async function openEditScreen() {
  const song = state.pendingSong;
  // 先記下譜面頁的播放位置再停掉播放器，進編輯頁才接得上剛才看到的地方
  const resumeMs = state.previewPlayer ? previewPositionMs() : null;
  if (state.chartDirty) saveChartSliders().catch(() => {});
  show('edit');
  const flow = state.flowId;
  $('#edit-song-name').textContent = song.name;
  $('#edit-play').disabled = true;
  $('#edit-play').textContent = '播放';
  $('#edit-time').textContent = '載入音軌中…';

  const ctx = await audioCtx();
  if (!state.editor) {
    state.editor = new ChartEditor($('#edit-roll'), {
      onChange: (notes) => {
        // 結構性編輯一旦發生，就以這份 note 清單為準（見 chart.js 的說明）
        state.edits.notes = notes.map((n) => ({ ...n }));
        state.editPiano?.setNotes(notes);
        state.editDirty = true;
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
  state.editor.setNotes(state.previewChart.notes, state.previewChart.durationMs, resumeMs);
  if (resumeMs !== null) state.editor.setPlayhead(resumeMs);
  state.editDirty = false;
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

  const player = await loadPreviewAudio(song, ctx, (msg) => {
    if (alive(flow)) $('#edit-time').textContent = msg;
  });
  if (!alive(flow)) {
    if (player) { player.node?.disconnect(); player.gain.disconnect(); }
    return;
  }
  state.editPlayer = player;
  if (player && resumeMs !== null) player.seek(Math.min(player.duration, resumeMs / 1000));
  $('#edit-play').disabled = !player;
  if (player) {
    $('#edit-time').textContent =
      `${fmtTime((resumeMs || 0))} / ${fmtTime(player.duration * 1000)}`;
    player.onended = () => { $('#edit-play').textContent = '播放'; };
  }
  applyEditVocalGain();
  editLoop();
}

export function applyEditVocalGain() {
  state.editPlayer?.setVolume($('#edit-vocal').classList.contains('on') ? 1 : 0);
}

export function editLoop() {
  cancelAnimationFrame(state.editRaf);
  const step = () => {
    if (state.screen !== 'edit') return;
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

export function closeEditScreen() {
  cancelAnimationFrame(state.editRaf);
  state.editPiano?.stop();
  if (state.editPlayer) {
    state.editPlayer.stop();
    state.editPlayer.node?.disconnect();
    state.editPlayer.gain.disconnect();
    state.editPlayer = null;
  }
}

/** 回到譜面確認畫面（編輯存檔或取消之後）。 */
export async function backToChart() {
  show('chart');
  updateAdvancedLock();
  refreshChartPreview();
  await preparePreviewPlayer(state.pendingSong);
}

export function updatePreviewTime() {
  if (!state.previewChart) return;
  $('#preview-time').textContent =
    `${fmtTime(previewPositionMs())} / ${fmtTime(state.previewChart.durationMs)}`;
}

/** 目前這個畫布寬度可以看到多少毫秒。 */
export function visibleSpanMs(canvas) {
  return (canvas.getBoundingClientRect().width / PREVIEW_PX_PER_SEC) * 1000;
}

/** 捲動式的細部音程條。播放頭固定，內容左右移動。 */
export function drawDetailStrip(canvas, chart, playheadMs) {
  const { ctx, w, h } = setupCanvas(canvas);
  const notes = chart.notes;
  if (!notes.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('沒有偵測到旋律，試著到「進階」調低靈敏度', w / 2, h / 2);
    return;
  }

  const range = chart.range || (chart.range = noteRange(notes, 2));
  const judgeX = w * PREVIEW_JUDGE_RATIO;
  const pxPerMs = PREVIEW_PX_PER_SEC / 1000;
  const xOf = (ms) => judgeX + (ms - playheadMs) * pxPerMs;
  const yOf = (m) => h - 14 - ((m - range.min) / (range.max - range.min)) * (h - 30);
  const fromMs = playheadMs - judgeX / pxPerMs;
  const toMs = fromMs + w / pxPerMs;

  // 每秒一條淡刻度，整五秒標時間
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
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
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
    ctx.fillStyle = 'rgba(0,229,255,0.5)';
    ctx.fillText(midiToName(m), w - 5, y - 3);
  }

  // 音程條。標了技巧的音直接換成該技巧的顏色，並在上方畫小符號
  const semiH = (h - 30) / (range.max - range.min);
  const barH = Math.max(5, Math.min(16, semiH * 0.8));
  const techByNote = chart.techByNote || techniquesByNote(chart.techniques);
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (note.endMs < fromMs) continue;
    if (note.startMs > toMs) break;   // 依時間排序，後面都不在畫面內
    const x0 = xOf(note.startMs);
    const width = Math.max(2, (note.endMs - note.startMs) * pxPerMs);
    const y = yOf(note.midi) - barH / 2;
    const techs = techByNote.get(i);

    // 播放頭正下方那一格：畫成實心並框起來
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
  }

  // 播放頭
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillRect(judgeX - 1, 0, 2, h - 14);
  ctx.beginPath();
  ctx.arc(judgeX, 7, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd54a';
  ctx.fill();
}

/** 全曲總覽：整首壓成一條，用來粗略定位。音符部分不會變，畫一次存成點陣重用。 */
export function drawOverview(canvas, chart, playheadMs) {
  const { ctx, w, h } = setupCanvas(canvas);
  const usable = w - OVERVIEW_PAD * 2;
  const xOf = (ms) => OVERVIEW_PAD + (ms / chart.durationMs) * usable;
  const dpr = window.devicePixelRatio || 1;

  const cacheKey = `${w}x${h}@${dpr}`;
  if (!chart.overviewCache || chart.overviewCache.key !== cacheKey) {
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.round(w * dpr));
    off.height = Math.max(1, Math.round(h * dpr));
    const octx = off.getContext('2d');
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const notes = chart.notes;
    if (notes.length) {
      const range = noteRange(notes, 2);
      const yOf = (m) => h - 6 - ((m - range.min) / (range.max - range.min)) * (h - 12);
      // 總覽只用顏色區分技巧：這裡一個音才幾個像素寬，再擠符號會糊成一團
      const techByNote = chart.techByNote || techniquesByNote(chart.techniques);
      notes.forEach((note, i) => {
        const techs = techByNote.get(i);
        octx.fillStyle = techs ? techniqueColor(techs[0], 0.85) : 'rgba(0,229,255,0.55)';
        octx.fillRect(xOf(note.startMs), yOf(note.midi) - 1,
          Math.max(1, xOf(note.endMs) - xOf(note.startMs)), 2);
      });
    }
    chart.overviewCache = { key: cacheKey, canvas: off };
  }
  ctx.drawImage(chart.overviewCache.canvas, 0, 0, w, h);

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
export function overviewTimeAtX(canvas, clientX) {
  const rect = canvas.getBoundingClientRect();
  const usable = rect.width - OVERVIEW_PAD * 2;
  const ratio = (clientX - rect.left - OVERVIEW_PAD) / usable;
  return Math.max(0, Math.min(1, ratio)) * state.previewChart.durationMs;
}

/** 抓取指標讓拖曳超出畫布也持續有效；失敗不影響功能。 */
export function capturePointer(el, pointerId) {
  try { el.setPointerCapture(pointerId); } catch { /* 指標不可抓取 */ }
}

export function seekPreview(ms) {
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
  if (state.screen === 'chart') drawPreviewFrame();
  if (state.screen === 'edit') state.editor?.draw();
  if (state.screen === 'result' && state.lastResult) drawResultCharts();
});

for (const id of ['#octave-slider', '#sens-slider', '#level-slider']) {
  $(id).addEventListener('input', () => { state.chartDirty = true; refreshChartPreview(); });
}

$('#chart-confirm').addEventListener('click', async () => {
  const song = state.pendingSong;
  if (!song) return;
  const btn = $('#chart-confirm');
  btn.disabled = true;
  try {
    if (state.chartDirty) await saveChartSliders();
  } catch {
    // 存不進去也讓人照樣唱：這次用畫面上的值，toast 已經說明了
  } finally {
    btn.disabled = false;
  }
  song.octaveOffset = Number($('#octave-slider').value);
  song.minConfidence = Number($('#sens-slider').value);
  song.minLevelDb = Number($('#level-slider').value);
  song.chartEdits = state.edits;
  startSinging(song, { from: 'chart' });
});

$('#chart-back').addEventListener('click', () => goLibrary());
$('#chart-edit').addEventListener('click', () => openEditScreen());

// -- 編輯譜面 --------------------------------------------------------------

$('#edit-play').addEventListener('click', async () => {
  const p = state.editPlayer;
  if (!p) return;
  await audioCtx();
  if (p.playing) { p.pause(); state.editPiano?.reschedule(); } else {
    if (p.currentTime >= p.duration - 0.05) p.seek(0);
    p.play();
  }
  $('#edit-play').textContent = p.playing ? '暫停' : '播放';
});
$('#edit-vocal').addEventListener('click', (e) => {
  setToggle(e.currentTarget, !e.currentTarget.classList.contains('on'));
  applyEditVocalGain();
});
$('#edit-piano').addEventListener('click', (e) => {
  setToggle(e.currentTarget, !e.currentTarget.classList.contains('on'));
  state.editPiano?.setEnabled(e.currentTarget.classList.contains('on'));
});

$('#edit-add').addEventListener('click', () => state.editor?.addNoteAtPlayhead());
$('#edit-zoom-in').addEventListener('click', () => state.editor?.zoom(1.4));
$('#edit-zoom-out').addEventListener('click', () => state.editor?.zoom(1 / 1.4));
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
    state.editDirty = false;
    await backToChart();
  } catch (err) {
    editStatus(`儲存失敗：${err.message}`);
  }
});

$('#edit-revert').addEventListener('click', async () => {
  const ok = await confirmBox('會捨棄所有手動編輯，重新從音訊產生譜面。', {
    title: '捨棄所有編輯？', ok: '捨棄並重新產生', danger: true,
  });
  if (!ok) return;
  state.edits = { pitchShifts: [], notes: null };
  const song = state.pendingSong;
  editStatus('重新產生中…');
  try {
    await api.saveSongSettings(song.id, { chartEdits: state.edits });
    song.chartEdits = state.edits;
    refreshChartPreview();
    state.editor.setNotes(state.previewChart.notes, state.previewChart.durationMs,
      state.editPlayer ? state.editPlayer.currentTime * 1000 : null);
    state.editPiano?.setNotes(state.previewChart.notes);
    state.editDirty = false;
    editStatus('已還原成自動抽取的結果。');
  } catch (err) {
    editStatus(`還原失敗：${err.message}`);
  }
});

/** 有沒存的編輯時問一下；回傳 true 表示可以離開。 */
export async function confirmDiscardEdits() {
  if (state.screen !== 'edit' || !state.editDirty) return true;
  return confirmBox('剛才的修改還沒儲存，離開就會不見。', {
    title: '放棄未儲存的編輯？', ok: '放棄修改', cancel: '繼續編輯', danger: true,
  });
}

$('#edit-cancel').addEventListener('click', async () => {
  if (!(await confirmDiscardEdits())) return;
  // 取消：把記憶體裡的編輯丟掉，重讀伺服器上那份
  state.edits = normalizeEdits(state.pendingSong.chartEdits);
  state.editDirty = false;
  await backToChart();
});

window.addEventListener('keydown', (e) => {
  if (state.screen !== 'edit') return;
  if (e.target.matches('input, textarea, select')) return;
  if (!$('#app-dialog').classList.contains('hidden')) return;
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
  setToggle(e.currentTarget, state.vocalOn);
  applyPreviewVocalGain();
});
$('#preview-piano').addEventListener('click', (e) => {
  state.pianoOn = !state.pianoOn;
  setToggle(e.currentTarget, state.pianoOn);
  state.previewPiano?.setEnabled(state.pianoOn);
});

// -- 時間軸：播放、跳轉、拖曳 --------------------------------------------

export function setPreviewPlaying(playing) {
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

export function previewSkip(seconds) {
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

export function stopPreview() {
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


// ── 封面（譜面頁的更換／重抓） ─────────────────────────────────

export function applyCoverMeta(meta) {
  const song = state.pendingSong;
  if (!song || meta?.id !== song.id) return;
  song.cover = meta.cover;
  song.coverSource = meta.coverSource;
  setCover($('#chart-cover'), song);
  const listed = state.allSongs.find((s) => s.id === song.id);
  if (listed) { listed.cover = meta.cover; listed.coverSource = meta.coverSource; }
}

export const pickCover = () => $('#cover-file').click();
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

export function applyLyricsPrefs() {
  const p = state.lyricsPrefs;
  $('#lyr-opt-ruby').checked = p.ruby;
  $('#lyr-opt-romaji').checked = p.romaji;
  $('#lyr-opt-karaoke').checked = p.karaoke;
  setToggle($('#lyrics-toggle'), p.show);
  $('#sing-lyrics').classList.toggle('hidden-lyrics', !p.show);
  const opts = { ruby: p.ruby, romaji: p.romaji, karaoke: p.karaoke };
  state.lyricsView?.setOptions(opts);
  state.previewLyricsView?.setOptions(opts);
}

export async function saveLyricsPrefs(patch) {
  state.lyricsPrefs = { ...state.lyricsPrefs, ...patch };
  applyLyricsPrefs();
  await store.setSetting('lyricsPrefs', state.lyricsPrefs);
}

$('#lyr-opt-ruby').addEventListener('change', (e) => saveLyricsPrefs({ ruby: e.target.checked }));
$('#lyr-opt-romaji').addEventListener('change', (e) => saveLyricsPrefs({ romaji: e.target.checked }));
$('#lyr-opt-karaoke').addEventListener('change', (e) => saveLyricsPrefs({ karaoke: e.target.checked }));
$('#lyrics-toggle').addEventListener('click', () => saveLyricsPrefs({ show: !state.lyricsPrefs.show }));

export function lyricsViewOpts() {
  const { ruby, romaji, karaoke } = state.lyricsPrefs;
  return { ruby, romaji, karaoke };
}

/** 演唱畫面：先顯示已有的歌詞；從來沒抓過就在背景抓一次，抓到了再補上。 */
export async function setupSingLyrics(song) {
  if (!state.lyricsView) {
    state.lyricsView = new LyricsView($('#sing-lyrics'), { ...lyricsViewOpts(), layout: 'dam' });
  }
  if (state.lyrics && state.lyricsSongId === song.id) {
    // 重來／再唱一次：同一首歌的歌詞不必再抓
    state.lyricsView.setLyrics(state.lyrics, state.chart.notes,
      state.lyrics?.lines?.length ? '' : '這首歌沒有歌詞。可以到「譜面」頁上傳 .lrc 或貼網址');
    state.lyricsView.update(0);
    return;
  }
  state.lyrics = null;
  state.lyricsSongId = song.id;
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

export function setPreviewLyrics(data) {
  state.previewLyrics = data;
  if (state.pendingSong && state.lyricsSongId === state.pendingSong.id) state.lyrics = data;
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
  if (data?.fetchError) $('#lyrics-status').textContent += '｜重抓失敗，保留原本的歌詞';
}

export async function loadChartLyrics(song) {
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

export function lrclibUrl(title, artist) {
  const q = new URLSearchParams({ track_name: title.trim() });
  if (artist.trim()) q.set('artist_name', artist.trim());
  return `https://lrclib.net/api/search?${q}`;
}

/** 歌詞操作共用：鎖按鈕、顯示進度、成功就換上新歌詞。 */
export async function lyricsAction(label, fn) {
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
  if (file.size > 512 * 1024) { toast('這個檔案太大了，不像是 .lrc 歌詞檔', { kind: 'error' }); return; }
  const text = await file.text();
  lyricsAction(`處理「${file.name}」中…`, (song) => api.uploadLyrics(song.id, text, file.name));
});

$('#lyrics-remove').addEventListener('click', async () => {
  const ok = await confirmBox('之後可以再按「自動抓取」或上傳。', { title: '移除這首歌的歌詞？', ok: '移除', danger: true });
  if (!ok) return;
  lyricsAction('移除中…', async (song) => { await api.deleteLyrics(song.id); return null; });
});

// 時間位移：按一下馬上反映在試聽上，存檔延後一點，連按時不必每下都送
export let offsetTimer = null;
export function nudgeLyrics(deltaMs) {
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
