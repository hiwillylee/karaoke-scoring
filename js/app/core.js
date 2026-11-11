// app/core.js — 共用狀態、畫面切換與生命週期、AudioContext、麥克風。
//
// 所有畫面切換都經過 show()：離開一個畫面時由 leaveScreen() 統一收尾
// （停播放、關麥克風、存調整），而每次切換都讓 state.flowId 加一——
// 還在等網路或解碼的非同步流程醒來時發現 flowId 變了，就知道使用者已經
// 離開，直接放棄，不會在別的畫面突然開始播歌。

import { MicTracker } from '../mic.js';
import { PARAMS } from '../techniques.js';
import { $$ } from '../util.js';
import { refreshLibrary } from './library.js';
import { closeEditScreen, openChartScreen, saveChartSliders, stopPreview } from './chart.js';
import { abortSing, pauseSinging } from './sing.js';
import { maybeStartTour, stopMicTest } from './settings.js';

export const state = {
  ctx: null,
  player: null,
  mic: null,
  scorer: null,
  renderer: null,
  screen: null,
  returnTo: 'library',  // 設定／校準／連線頁按「返回」回到哪裡
  flowId: 0,
  song: null,          // 目前演唱的歌
  chart: null,         // 目前使用的參考譜
  pendingSong: null,   // 譜面確認中的歌
  allSongs: [],        // 整份曲庫清單（搜尋與排序都在前端做）
  libraryError: null,
  sort: 'added',
  jobs: new Map(),     // 伺服器上的處理工作（jobId → 狀態）
  uploads: new Map(),  // 上傳中的檔案（本機編號 → {name, pct}）
  keyShift: 0,
  latencyMs: 0,
  manualLatencyMs: 0,
  silenceRms: 0.008,
  guideOn: false,
  backingVol: 0.9,
  guideVol: 0.75,
  serverInfo: null,
  profiles: [],        // 延遲設定檔（伺服器上）
  micDeviceId: null,   // 使用者在校準頁選的麥克風
  outputLabel: '預設輸出',
  sinkId: '',
  tunnel: null,
  raf: null,
  singing: false,
  singPhase: 'idle',   // idle | prep | countdown | playing | paused | done
  singFrom: 'library',
  finished: false,
  wakeLock: null,
  previewPlayer: null,
  previewChart: null,
  previewRaf: null,
  previewDragging: false,
  chartDirty: false,   // 譜面頁的滑桿動過、還沒存
  // 譜面編輯：edits 是目前生效的編輯（逐幀音高位移 + note 覆寫）
  edits: { pitchShifts: [], notes: null },
  editor: null,
  editPiano: null,
  editPlayer: null,
  editRaf: null,
  editDirty: false,
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
  compareZoom: 40,
  tourPending: false,
};

// ── 畫面切換與生命週期 ───────────────────────────────────────

// 曲庫／譜面確認／編輯／演唱／結算都屬於同一條「曲庫」動線，
// 手機底部導覽列與桌面頂列的按鈕都用這張表決定該亮哪一個。
export const NAV_GROUP = {
  library: 'library', chart: 'library', edit: 'library',
  sing: 'library', result: 'library',
  calibrate: 'calibrate', settings: 'settings', connect: 'connect',
};
export const SIDE_SCREENS = new Set(['calibrate', 'settings', 'connect']);

export function show(name) {
  const prev = state.screen;
  if (prev && prev !== name) leaveScreen(prev, name);
  if (SIDE_SCREENS.has(name) && !SIDE_SCREENS.has(prev)) {
    state.returnTo = prev === 'chart' && state.pendingSong ? 'chart' : 'library';
  }
  state.flowId += 1;
  state.screen = name;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  // 演唱／結算畫面整頁換成螢幕的深藍（見 css 的 body[data-screen]）
  document.body.dataset.screen = name;
  const group = NAV_GROUP[name];
  $$('button[data-goto]').forEach((btn) => {
    const on = btn.dataset.goto === group;
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  if (name === 'library' && state.tourPending) {
    state.tourPending = false;
    setTimeout(() => maybeStartTour(), 400);
  }
}

/** 離開一個畫面時要收的東西都在這裡，不管是從哪個按鈕離開的。 */
export function leaveScreen(prev) {
  if (prev === 'chart') {
    stopPreview();
    if (state.chartDirty) saveChartSliders().catch(() => {});
  } else if (prev === 'edit') {
    closeEditScreen();
  } else if (prev === 'sing') {
    abortSing();
  } else if (prev === 'calibrate') {
    if (!state.calibrating) releaseMic();
  } else if (prev === 'settings') {
    stopMicTest();
  }
}

/** 非同步流程用：從開始到現在，使用者有沒有切換過畫面。 */
export const alive = (flow) => flow === state.flowId;

/** 設定／校準／連線頁的「返回」：回到進來之前的地方。 */
export function goBack() {
  if (state.returnTo === 'chart' && state.pendingSong) openChartScreen(state.pendingSong);
  else goLibrary();
}

export function goLibrary() {
  show('library');
  refreshLibrary();
}

export async function audioCtx() {
  if (!state.ctx) {
    state.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (state.sinkId && state.ctx.setSinkId) state.ctx.setSinkId(state.sinkId).catch(() => {});
    // 來電、拔耳機、其他 App 搶走音訊時 context 會被暫停：演唱中就跟著暫停，
    // 不要讓伴奏停了計分卻繼續跑
    state.ctx.addEventListener('statechange', () => {
      if (state.singPhase === 'playing' && state.ctx.state !== 'running') {
        pauseSinging('音訊被系統中斷（例如來電或切換音訊裝置），已暫停');
      }
    });
  }
  if (state.ctx.state !== 'running') {
    try { await state.ctx.resume(); } catch { /* 下一次使用者操作時再試 */ }
  }
  return state.ctx;
}

export function keyLabel(n) {
  if (!n) return '原調';
  return n > 0 ? `♯${n}` : `♭${-n}`;
}

// ── 麥克風 ──────────────────────────────────────────────────
//
// 只在需要時開（演唱、校準、設定頁測試），離開那個畫面就關掉，
// 瀏覽器的錄音指示燈才不會一直亮著。

export function micErrorText(err) {
  if (!window.isSecureContext) {
    return '這個網址不是 https，瀏覽器不會給網頁麥克風。'
      + '手機請改用「手機連線」頁上的 https 網址或公開網址；這台電腦請用 http://localhost。';
  }
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    return '麥克風權限被拒絕了。請在瀏覽器網址列旁的權限設定裡允許麥克風，再重新整理。';
  }
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
    return '找不到麥克風。請確認麥克風已接上，或到「延遲校準」頁換一個。';
  }
  if (err?.name === 'NotReadableError') {
    return '麥克風被其他程式占用中（例如視訊會議軟體），請先關掉它再試。';
  }
  return `無法使用麥克風：${err?.message || err}`;
}

export async function ensureMic(deviceId = state.micDeviceId) {
  const ctx = await audioCtx();
  if (state.mic?.running && (!deviceId || state.mic.deviceId === deviceId)) return state.mic;
  releaseMic();
  const make = () => new MicTracker(ctx, {
    silenceRms: state.silenceRms,
    minConfidence: PARAMS.pitch.minConfidence,
  });
  let mic = make();
  try {
    await mic.start(deviceId || null);
  } catch (err) {
    // 記住的那支麥克風不見了（拔掉了）：退回預設的
    if (deviceId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
      mic = make();
      try { await mic.start(null); } catch (err2) { throw new Error(micErrorText(err2)); }
    } else {
      throw new Error(micErrorText(err));
    }
  }
  mic.onEnded = () => {
    if (state.singPhase === 'playing') pauseSinging('麥克風斷線了（拔掉或藍牙中斷），已暫停');
  };
  state.mic = mic;
  return mic;
}

export function releaseMic() {
  state.mic?.stop();
  state.mic = null;
}
