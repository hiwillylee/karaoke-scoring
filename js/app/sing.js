// app/sing.js — 演唱與結算畫面。

import * as api from '../api.js';
import { latencyFor } from '../calibrate.js';
import { rebuildChart, noteRange } from '../chart.js';
import { framesToNotes, prepareFrames, toMono } from '../dsp.js';
import { KeyPlayer } from '../pitchshift.js';
import { StageRenderer, drawTechniqueGlyph } from '../render.js';
import * as result from '../result.js';
import { LiveScorer } from '../score.js';
import * as store from '../storage.js';
import { PARAMS, techniqueColor, detectTechniques } from '../techniques.js';
import { alertBox, confirmBox, toast, icon } from '../ui.js';
import { $, $$, setToggle } from '../util.js';
import { alive, audioCtx, ensureMic, goLibrary, keyLabel, releaseMic, show, state } from './core.js';
import { loadSong, setBackdrop, setCover } from './library.js';
import { forgetDecoded, getDecoded, normalizeEdits, openChartScreen, setupSingLyrics, stemVersion } from './chart.js';
import { findProfile } from './settings.js';

// ── 演唱 ────────────────────────────────────────────────────

/**
 * 組出播放用的音軌。第 0 軌是伴奏，第 1 軌是原唱（導唱）。
 * 兩軌交給同一個 worklet，共用播放位置，開關導唱不會跑掉拍。
 * 兩軌同時下載（以前是一軌抓完才抓下一軌）。
 */
export async function loadTracks(song, ctx, onProgress = null) {
  const [inst, vocals] = await Promise.all([
    getDecoded(song, 'instrumental', ctx,
      (done, total, cached) => onProgress?.('伴奏', done, total, cached)),
    song.hasGuide
      ? getDecoded(song, 'vocals', ctx,
        (done, total, cached) => onProgress?.('原唱', done, total, cached), true)
      : null,
  ]);

  const tracks = [{ buffer: inst, gain: state.backingVol }];
  // 導唱軌是單聲道：人聲本來就置中，這樣可以省下一半記憶體
  if (vocals) tracks.push({ buffer: vocals, gain: state.guideOn ? state.guideVol : 0 });
  return { tracks, hasGuide: !!vocals };
}

export function monoBuffer(ctx, audioBuffer) {
  if (audioBuffer.numberOfChannels === 1) return audioBuffer;
  const out = ctx.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
  out.copyToChannel(toMono(audioBuffer), 0);
  return out;
}

/** 切換導唱。只改那一軌的音量，播放位置不受影響。 */
export function applyGuide(on) {
  state.guideOn = on;
  const btn = $('#guide-toggle');
  btn.textContent = on ? '原唱 開' : '原唱 關';
  setToggle(btn, on);
  if (state.player?.node) state.player.setStemGain(1, on ? state.guideVol : 0);
}

export const SING_BUTTONS = {
  idle: { toggle: [true, '暫停'], restart: true, stop: '取消' },
  prep: { toggle: [true, '暫停'], restart: true, stop: '取消' },
  countdown: { toggle: [true, '暫停'], restart: true, stop: '取消' },
  playing: { toggle: [false, '暫停'], restart: false, stop: '結束並計分' },
  paused: { toggle: [false, '繼續'], restart: false, stop: '結束並計分' },
  resuming: { toggle: [true, '繼續'], restart: true, stop: '結束並計分' },
  done: { toggle: [true, '暫停'], restart: true, stop: '結束並計分' },
};

/** 演唱的階段決定哪些按鈕能按：準備與倒數時不能暫停，「結束」變成「取消」。 */
export function setSingPhase(phase) {
  state.singPhase = phase;
  const b = SING_BUTTONS[phase] || SING_BUTTONS.idle;
  $('#sing-toggle').disabled = b.toggle[0];
  $('#sing-toggle').textContent = b.toggle[1];
  $('#sing-restart').disabled = b.restart;
  $('#sing-stop').textContent = b.stop;
  if (phase === 'playing') requestWakeLock(); else releaseWakeLock();
}

/** 停掉播放與計分（不換畫面）。 */
export function stopSingingAudio() {
  state.singing = false;
  cancelAnimationFrame(state.raf);
  clearInterval(state.countdownTimer);
  if (state.player) {
    state.player.onended = null;
    state.player.pause();
  }
  if (state.mic) { state.mic.onFrame = null; state.mic.refMidiAt = null; }
  $('#skip-intro').classList.add('hidden');
}

/** 離開演唱畫面：不管是怎麼離開的，都要把聲音、麥克風、螢幕恆亮收乾淨。 */
export function abortSing() {
  stopSingingAudio();
  releaseMic();
  setSingPhase('idle');
  $('#countdown').classList.add('hidden');
  $('#volume-panel').classList.add('hidden');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

export async function startSinging(idOrSong, { from = null } = {}) {
  const origin = from || state.screen;
  // 從結算頁「再唱一次」時，返回的地方維持原本的（譜面或曲庫）
  if (origin !== 'result' && origin !== 'sing') state.singFrom = origin === 'chart' ? 'chart' : 'library';
  stopSingingAudio();
  show('sing');
  const flow = state.flowId;
  setSingPhase('prep');

  const known = typeof idOrSong === 'string' ? state.allSongs.find((s) => s.id === idOrSong) : idOrSong;
  $('#sing-song-name').textContent = known?.name || '';
  if (known) { setCover($('#sing-cover'), known); setBackdrop($('#sing-backdrop'), known); }
  $('#live-score').textContent = '0';
  setPitchHint(null, true);
  $('#sing-bar').style.width = '0%';
  $('#countdown').classList.remove('hidden');
  $('#countdown').textContent = '準備中';
  $('#latency-note').textContent = '';

  try {
    const song = typeof idOrSong === 'string' ? await loadSong(idOrSong) : idOrSong;
    if (!alive(flow)) return;
    $('#sing-song-name').textContent = song.name;
    setCover($('#sing-cover'), song);
    setBackdrop($('#sing-backdrop'), song);

    const ctx = await audioCtx();
    state.song = song;
    state.chart = rebuildChart(song.chart, {
      minConfidence: song.minConfidence,
      minLevelDb: song.minLevelDb,
      octaveOffset: song.octaveOffset || 0,
      edits: normalizeEdits(song.chartEdits),
    });
    state.noteStarts = state.chart.notes.map((n) => n.startMs);
    // 升降調跟著歌記住（存在伺服器上），重唱、換裝置都不必重調
    state.keyShift = Math.max(-6, Math.min(6, Number(song.keyShift) || 0));
    $('#key-value').textContent = keyLabel(state.keyShift);

    // 麥克風
    const mic = await ensureMic();
    if (!alive(flow)) return;
    mic.silenceRms = state.silenceRms;

    // 延遲：設定檔是依「麥克風 × 輸出」存的
    const profile = findProfile(mic.deviceLabel, state.outputLabel);
    state.latencyProfile = profile || null;
    const outMs = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
    state.latencyMs = latencyFor(profile, outMs) + state.manualLatencyMs;
    $('#latency-note').textContent = profile
      ? `延遲補償 ${state.latencyMs}ms（${profile.micLabel} × ${profile.outputLabel}）`
      : `延遲補償 ${state.latencyMs}ms（估計值，建議先做一次拍手校準）`;

    // 播放器
    if (!state.player) state.player = new KeyPlayer(ctx);
    const hasGuide = !!song.hasGuide;
    // 播放器裡已經是這首歌的同一版音軌（再唱一次、從譜面回來重唱）就直接沿用：
    // 不必再解碼，也不必再複製一份整首歌的取樣送進音訊執行緒
    const versions = await Promise.all([
      stemVersion(song, 'instrumental'), hasGuide ? stemVersion(song, 'vocals') : '',
    ]);
    if (!alive(flow)) return;
    const loadKey = `${song.id}|${versions.join('|')}`;
    if (state.player.loadedFor !== loadKey) {
      state.player.loadedFor = null;
      const { tracks } = await loadTracks(song, ctx,
        (label, done, total, cached) => {
          if (cached || !total || !alive(flow)) return;
          $('#countdown').textContent = `${label} ${Math.round(done / total * 100)}%`;
        });
      if (!alive(flow)) return;
      $('#countdown').textContent = '準備中';
      await state.player.load(tracks);
      if (!alive(flow)) return;
      state.player.loadedFor = loadKey;
      // 伴奏只有演唱用得到。交給播放器之後主執行緒就不必再留一份解碼結果，
      // 常駐記憶體只剩音訊執行緒裡那一份（人聲軌譜面頁還要用，留著）
      forgetDecoded(song, 'instrumental');
    }
    state.player.seek(0);
    $('#guide-toggle').disabled = !hasGuide;
    $('#guide-vol').disabled = !hasGuide;
    applyGuide(hasGuide && state.guideOn);
    state.player.connect(ctx.destination);
    state.player.setVolume(1);
    state.player.setStemGain(0, state.backingVol);
    state.keyShift = state.player.setSemitones(state.keyShift);

    // 評分與畫面
    resetTake();
    setupSingLyrics(song);

    // 八度旁證：把參考譜當下的音餵給音高偵測器。只影響「判成哪個八度」，
    // 音分仍然完全來自麥克風，唱偏多少照樣扣分。
    mic.refMidiAt = (t, phraseStart) => {
      if (!state.singing) return 0;
      const songMs = state.player.songTimeAt(t) * 1000 - state.latencyMs;
      return songMs < 0 ? 0 : state.scorer.octaveHint(songMs, phraseStart);
    };
    mic.onFrame = onMicFrame;

    await beginTake(flow, 0);
  } catch (err) {
    if (!alive(flow)) return;
    stopSingingAudio();
    await alertBox(err.message || String(err), '無法開始演唱');
    if (alive(flow)) {
      if (state.singFrom === 'chart' && state.pendingSong) backToChartFromSing();
      else goLibrary();
    }
  }
}

/** 一次演唱的計分狀態歸零（開始與「重來」共用）。 */
export function resetTake() {
  state.scorer = new LiveScorer(state.chart, { keyShift: state.keyShift });
  if (!state.renderer) state.renderer = new StageRenderer($('#stage'));
  state.renderer.resize();
  state.renderer.setChart(state.chart.notes, state.chart.techniques,
    noteRange(state.chart.notes, 3));
  state.renderer.setKeyShift(state.keyShift);
  state.renderer.clearTrail();
  state.finished = false;
  state.lastTechCheck = 0;
  state.lastTechPopMs = -1;
  state.shownOct = null;
  state.uiCache = {};
  $('#live-score').textContent = '0';
  $('#sing-bar').style.width = '0%';
  setPitchHint(null, true);
}

/** 倒數後從 fromSec 開始播放。倒數期間離開畫面就什麼都不做。 */
export async function beginTake(flow, fromSec) {
  setSingPhase('countdown');
  const ok = await countdown(flow, 3, 800);
  if (!ok) return;
  await audioCtx();
  state.singing = true;
  state.player.onended = () => finishSinging();
  state.player.play(fromSec);
  setSingPhase('playing');
  loop();
}

export function onMicFrame(frame) {
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
}

/** 倒數。回傳 false 表示使用者在倒數期間離開了。 */
export function countdown(flow, from = 3, stepMs = 800, label = null) {
  const el = $('#countdown');
  return new Promise((resolve) => {
    let n = from;
    el.classList.remove('hidden');
    el.textContent = label ? `${label} ${n}` : n;
    clearInterval(state.countdownTimer);
    state.countdownTimer = setInterval(() => {
      if (!alive(flow)) {
        clearInterval(state.countdownTimer);
        el.classList.add('hidden');
        resolve(false);
        return;
      }
      n -= 1;
      if (n === 0) {
        clearInterval(state.countdownTimer);
        el.classList.add('hidden');
        resolve(true);
      } else {
        el.textContent = label ? `${label} ${n}` : n;
      }
    }, stepMs);
  });
}

// 八度診斷讀數：網址加 ?debug=1，或在演唱畫面按 Shift+D 開關。
// 八度出問題時，光看畫面分不出是 YIN 抓錯、平滑器判錯、還是全域對齊沒收斂。
export let DEBUG_OCTAVE = new URLSearchParams(location.search).get('debug') === '1';

window.addEventListener('keydown', (e) => {
  if (state.screen !== 'sing' || !e.shiftKey || e.key.toLowerCase() !== 'd') return;
  if (e.target.matches('input, textarea, select')) return;
  DEBUG_OCTAVE = !DEBUG_OCTAVE;
  if (!DEBUG_OCTAVE && state.renderer) state.renderer.debugText = '';
  toast(DEBUG_OCTAVE ? '已開啟八度診斷讀數' : '已關閉八度診斷讀數', { duration: 1800 });
});

export function drawOctaveDebug(songMs) {
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

// 「準／偏高／偏低」：同一個判定要維持一小段時間才換，否則在兩個狀態之間
// 每一幀來回切換，整顆膠囊會閃。
export const HINT_HOLD_MS = 140;
export const HINT_TEXT = { good: '準', high: '偏高 ↑', low: '偏低 ↓' };
export function setPitchHint(hint, force = false) {
  const c = state.hintState || (state.hintState = { shown: undefined, cand: null, since: 0 });
  const now = performance.now();
  if (!force) {
    if (hint === c.shown) { c.cand = hint; return; }
    if (hint !== c.cand) { c.cand = hint; c.since = now; return; }
    if (now - c.since < HINT_HOLD_MS) return;
  }
  c.shown = hint;
  c.cand = hint;
  const el = $('#pitch-hint');
  el.className = `pitch-hint ${hint || 'idle'}`;
  el.textContent = HINT_TEXT[hint] || '等待歌聲';
}

/** 下一個音離現在多遠（毫秒）；後面沒有音了回傳 Infinity。 */
export function nextNoteGap(songMs) {
  const starts = state.noteStarts || [];
  let lo = 0, hi = starts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= songMs) lo = mid + 1; else hi = mid; }
  if (lo >= starts.length) return { gap: Infinity, next: null, first: false };
  // 目前還在某個音裡面就不算間奏
  const prev = lo > 0 ? state.chart.notes[lo - 1] : null;
  if (prev && prev.endMs > songMs) return { gap: 0, next: starts[lo], first: false };
  return { gap: starts[lo] - songMs, next: starts[lo], first: lo === 0 };
}

export const SKIP_MIN_GAP_MS = 8000;   // 前奏／間奏超過這麼長才給跳過鈕
export const SKIP_LEAD_MS = 3000;      // 跳到下一句前幾秒

export function loop() {
  cancelAnimationFrame(state.raf);
  const ui = state.uiCache || (state.uiCache = {});
  const scoreEl = $('#live-score');
  const barEl = $('#sing-bar');
  const skipEl = $('#skip-intro');
  const skipLabel = skipEl.querySelector('span');
  const step = () => {
    if (!state.singing) return;
    const songMs = state.player.currentTime * 1000;
    // 讀數要在 draw() 之前算好，否則畫出來的永遠是上一幀的數字
    if (DEBUG_OCTAVE) drawOctaveDebug(songMs);
    state.renderer.draw(songMs);
    state.lyricsView?.update(songMs);

    // 只在值變了的時候才寫 DOM：每一幀無條件寫入會觸發多餘的版面計算
    const score = state.scorer.liveScore;
    if (ui.score !== score) { ui.score = score; scoreEl.textContent = score; }
    const pct = Math.min(100, Math.round((songMs / state.chart.durationMs) * 1000) / 10);
    if (ui.pct !== pct) { ui.pct = pct; barEl.style.width = `${pct}%`; }

    const { gap, first } = nextNoteGap(songMs);
    const canSkip = gap >= SKIP_MIN_GAP_MS && gap !== Infinity;
    if (ui.skip !== canSkip || ui.skipFirst !== first) {
      ui.skip = canSkip;
      ui.skipFirst = first;
      skipEl.classList.toggle('hidden', !canSkip);
      skipLabel.textContent = first ? '跳過前奏' : '跳過間奏';
    }

    checkLiveTechnique(songMs);
    setPitchHint(state.scorer.currentHint(songMs));

    state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
}

$('#skip-intro').addEventListener('click', () => {
  if (state.singPhase !== 'playing') return;
  const songMs = state.player.currentTime * 1000;
  const { next } = nextNoteGap(songMs);
  if (next === null) return;
  const target = Math.max(songMs, next - SKIP_LEAD_MS);
  state.player.seek(target / 1000);
  state.lastTechCheck = target;
  state.lyricsView?.update(target);
});

/**
 * 在最近 1.4 秒的演唱上跑一次技巧偵測，做到就彈標籤。
 * 每 400ms 檢查一次，資料量小，不影響畫面更新。
 */
export function checkLiveTechnique(songMs) {
  if (songMs - state.lastTechCheck < 400) return;
  state.lastTechCheck = songMs;
  const from = songMs - 1400;
  const octave = state.scorer.bestOctave();
  const raw = state.scorer.userFrames
    .filter((f) => f.t >= from && f.midi > 0)
    .map((f) => ({ t: f.t, midi: f.midi + octave, conf: f.conf, rms: f.rms }));
  if (raw.length < 20) return;
  // 跟原唱譜面分析、結算計分共用同一套流程：先做信心／音量門檻與八度修正，
  // 再切段偵測技巧。
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
export function popTechnique(type) {
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

/** 暫停。reason 有值時跳提示（被系統中斷之類，不是使用者自己按的）。 */
export function pauseSinging(reason = '') {
  if (state.singPhase !== 'playing') return;
  state.player.pause();
  state.singing = false;
  cancelAnimationFrame(state.raf);
  setSingPhase('paused');
  if (reason) toast(reason, { kind: 'warn', duration: 6000 });
}

/** 繼續：先倒退兩秒再數一個短的預備拍，才接得上句子。 */
export async function resumeSinging() {
  if (state.singPhase !== 'paused') return;
  const flow = state.flowId;
  setSingPhase('resuming');
  const back = Math.max(0, state.player.currentTime - 2);
  state.player.seek(back);
  const ok = await countdown(flow, 2, 600, '預備');
  if (!ok || state.singPhase !== 'resuming') return;
  if (document.hidden) { setSingPhase('paused'); return; }   // 預備拍期間切走了
  await audioCtx();
  state.singing = true;
  state.player.play();
  setSingPhase('playing');
  loop();
}

$('#sing-toggle').addEventListener('click', () => {
  if (state.singPhase === 'playing') pauseSinging();
  else if (state.singPhase === 'paused') resumeSinging();
});

$('#sing-restart').addEventListener('click', async () => {
  if (!['playing', 'paused'].includes(state.singPhase)) return;
  const flow = ++state.flowId;   // 讓進行中的預備拍失效，但不換畫面
  stopSingingAudio();
  state.mic.onFrame = onMicFrame;
  state.mic.refMidiAt = (t, phraseStart) => {
    if (!state.singing) return 0;
    const songMs = state.player.songTimeAt(t) * 1000 - state.latencyMs;
    return songMs < 0 ? 0 : state.scorer.octaveHint(songMs, phraseStart);
  };
  resetTake();
  state.player.seek(0);
  state.lyricsView?.update(0);
  await beginTake(flow, 0);
});

$('#sing-stop').addEventListener('click', () => {
  if (['prep', 'countdown', 'idle'].includes(state.singPhase)) leaveSing();
  else finishSinging();
});

/** 不計分離開演唱畫面，回到進來的地方。 */
export function leaveSing() {
  if (state.singFrom === 'chart' && state.pendingSong) backToChartFromSing();
  else goLibrary();
}

export function backToChartFromSing() {
  openChartScreen(state.pendingSong);
}

$('#sing-exit').addEventListener('click', async () => {
  if (['playing', 'paused', 'resuming'].includes(state.singPhase)) {
    const wasPlaying = state.singPhase === 'playing';
    if (wasPlaying) pauseSinging();
    const ok = await confirmBox('現在離開不會計分。', { title: '離開這次演唱？', ok: '離開', cancel: '繼續唱' });
    if (!ok) { if (wasPlaying) resumeSinging(); return; }
  }
  leaveSing();
});

export function changeKey(delta) {
  if (!state.player || !state.scorer) return;
  state.keyShift = state.player.setSemitones(state.keyShift + delta);
  $('#key-value').textContent = keyLabel(state.keyShift);
  state.renderer.setKeyShift(state.keyShift);
  state.scorer.setKeyShift(state.keyShift, state.player.currentTime * 1000);
  // 跟著歌記住，延後一點再存，連按時不必每下都送
  const song = state.song;
  song.keyShift = state.keyShift;
  const listed = state.allSongs.find((s) => s.id === song.id);
  if (listed) listed.keyShift = state.keyShift;
  clearTimeout(state.keySaveTimer);
  state.keySaveTimer = setTimeout(() => {
    api.saveSongSettings(song.id, { keyShift: song.keyShift }).catch(() => {});
  }, 600);
}
$('#guide-toggle').addEventListener('click', async () => {
  applyGuide(!state.guideOn);
  await store.setSetting('guideVocal', state.guideOn);
});

$('#key-up').addEventListener('click', () => changeKey(1));
$('#key-down').addEventListener('click', () => changeKey(-1));

// 音量：伴奏與原唱各自調
$('#volume-toggle').addEventListener('click', (e) => {
  const panel = $('#volume-panel');
  const open = panel.classList.toggle('hidden') === false;
  e.currentTarget.setAttribute('aria-expanded', String(open));
});
export function applyVolumeLabels() {
  $('#backing-vol').value = state.backingVol;
  $('#guide-vol').value = state.guideVol;
  $('#backing-vol-value').textContent = `${Math.round(state.backingVol * 100)}%`;
  $('#guide-vol-value').textContent = `${Math.round(state.guideVol * 100)}%`;
}
$('#backing-vol').addEventListener('input', (e) => {
  state.backingVol = Number(e.target.value);
  applyVolumeLabels();
  state.player?.setStemGain(0, state.backingVol);
  store.setSetting('backingVol', state.backingVol);
});
$('#guide-vol').addEventListener('input', (e) => {
  state.guideVol = Number(e.target.value);
  applyVolumeLabels();
  if (state.guideOn) state.player?.setStemGain(1, state.guideVol);
  store.setSetting('guideVol', state.guideVol);
});

// 全螢幕（手機橫放唱時，網址列與狀態列都收起來）
if (document.fullscreenEnabled) $('#fullscreen-toggle').classList.remove('hidden');
$('#fullscreen-toggle').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
});

// ── 螢幕恆亮與音訊中斷 ───────────────────────────────────────

export async function requestWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch { /* 省電模式或不支援：沒有就算了 */ }
}

export function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // 切到別的 App（接電話、看訊息）：畫面停了計分也該停
    if (state.singPhase === 'playing') pauseSinging('切到別的畫面，已暫停');
  } else if (state.singPhase === 'playing') {
    requestWakeLock();
  }
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (state.singPhase === 'playing') pauseSinging('音訊裝置改變了（例如拔掉或接上耳機），已暫停');
});

window.addEventListener('beforeunload', (e) => {
  const busy = ['playing', 'paused'].includes(state.singPhase) || state.uploads.size
    || (state.screen === 'edit' && state.editDirty);
  if (busy) { e.preventDefault(); e.returnValue = ''; }
});

// ── 結算 ────────────────────────────────────────────────────

// 唱不到這麼久就不列入紀錄（以前唱 5 秒按結束也會存一筆，還會變成個人最佳）
export const MIN_SAVE_MS = 30000;
export const MIN_SAVE_RATIO = 0.25;

export async function finishSinging() {
  if (!state.scorer || state.finished) return;
  if (!['playing', 'paused', 'resuming'].includes(state.singPhase)) return;
  state.finished = true;
  const sungMs = Math.round((state.player?.currentTime || 0) * 1000);
  stopSingingAudio();
  setSingPhase('done');

  const res = state.scorer.finish();
  const song = state.song;
  const tooShort = sungMs < Math.min(MIN_SAVE_MS, state.chart.durationMs * MIN_SAVE_RATIO);
  let saved = null;
  if (!tooShort) {
    try {
      saved = await api.saveScore(song.id, {
        total: res.total,
        breakdown: res.breakdown,
        techniqueCounts: res.techniqueCounts,
        keyShift: res.keyShift,
        sungMs,
      });
      const listed = state.allSongs.find((s) => s.id === song.id);
      if (listed && saved) Object.assign(listed, { best: saved.best, plays: saved.plays, lastSungAt: saved.lastSungAt });
    } catch (err) {
      toast(`成績沒有存成功：${err.message}`, { kind: 'error' });
    }
  }
  showResult(res, { tooShort, saved });
}

export async function showResult(res, { tooShort = false, saved = null } = {}) {
  state.lastResult = res;
  show('result');
  const flow = state.flowId;
  setCover($('#result-cover'), state.song);
  setBackdrop($('#result-backdrop'), state.song);
  $('#result-song-name').textContent = state.song?.name || '';
  $('#result-grade').textContent = res.grade;
  $('#result-comment').textContent = res.comment;
  const flag = $('#result-flag');
  flag.classList.toggle('hidden', !tooShort);
  flag.textContent = tooShort ? '唱的時間太短，這次不列入紀錄' : '';
  result.animateScore($('#result-score'), res.total);
  drawResultCharts();
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

  const octaveNote = res.octaveOffset ? `（以 ${res.octaveOffset > 0 ? '+' : ''}${res.octaveOffset} 半音的八度對齊計分）` : '';
  const best = saved?.best ?? state.allSongs.find((s) => s.id === state.song.id)?.best;
  const isNewBest = saved && best != null && res.total >= best && saved.plays > 1;
  $('#best-note').textContent = (best != null
    ? `個人最佳 ${Number(best).toFixed(1)} 分${isNewBest ? '（刷新紀錄！）' : ''}` : '') + octaveNote;

  // 歷史成績：最近五次
  $('#history-list').innerHTML = '';
  try {
    const rows = await api.getScores(state.song.id);
    if (!alive(flow)) return;
    $('#history-list').innerHTML = rows.slice(-5).reverse().map((r) => {
      const d = new Date(r.date);
      const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `<li><span>${when}${r.keyShift ? `　${keyLabel(r.keyShift)}` : ''}</span><b>${Number(r.total).toFixed(1)}</b></li>`;
    }).join('');
  } catch { /* 歷史拿不到不影響結算 */ }
}

export function drawResultCharts() {
  const res = state.lastResult;
  if (!res) return;
  result.drawRadar($('#radar'), res.breakdown);
  result.drawPitchCompare($('#compare'), state.chart, res, { pxPerSec: state.compareZoom });
}

$('#compare-zoom').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-zoom]');
  if (!btn) return;
  state.compareZoom = Number(btn.dataset.zoom);
  $$('#compare-zoom button').forEach((b) => setToggle(b, b === btn));
  drawResultCharts();
  $('#compare-wrap').scrollLeft = 0;
});

// 音程對照圖放大後可以用滑鼠拖著捲（觸控本來就能滑）
{
  const wrap = $('#compare-wrap');
  let drag = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    drag = { x: e.clientX, left: wrap.scrollLeft };
    wrap.classList.add('dragging');
  });
  window.addEventListener('pointermove', (e) => {
    if (drag) wrap.scrollLeft = drag.left - (e.clientX - drag.x);
  });
  window.addEventListener('pointerup', () => { drag = null; wrap.classList.remove('dragging'); });
}

/**
 * 匯出這次演唱的原始資料（網址加 ?debug=1 才會出現）。
 *
 * 評分的門檻要訂在哪，得看麥克風實際收到什麼：伴奏漏音有多大聲、信心值
 * 掉到多少、八度誤判到底多頻繁。這些只能從真實的一次演唱量。
 */
export function setupTakeExport(res) {
  const host = $('#best-note');
  const old = document.getElementById('export-take');
  if (old) old.remove();
  if (!DEBUG_OCTAVE) return;
  const btn = document.createElement('button');
  btn.id = 'export-take';
  btn.className = 'ghost tiny mt';
  btn.innerHTML = `${icon('download')}匯出本次演唱原始資料`;
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

$('#result-retry').addEventListener('click', () => startSinging(state.song, { from: 'result' }));
$('#result-back').addEventListener('click', () => goLibrary());
