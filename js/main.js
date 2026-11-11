// main.js — 進入點：導覽列、舊資料搬家與啟動。
// 各畫面的實作在 js/app/ 底下（core、library、chart、sing、settings）。

import * as api from './api.js';
import * as store from './storage.js';
import { loadParams } from './techniques.js';
import { alertBox, confirmBox } from './ui.js';
import { $, $$, isMac } from './util.js';
import { goLibrary, releaseMic, show, state } from './app/core.js';
import { SORTERS, pollJobs, refreshLibrary, renderLibrary } from './app/library.js';
import { applyLyricsPrefs, confirmDiscardEdits } from './app/chart.js';
import { abortSing, applyGuide, applyVolumeLabels, pauseSinging, resumeSinging } from './app/sing.js';
import { loadProfiles, maybeAskGpu, maybeStartTour, openCalibrate, openSettings, renderConnect, setThemePref } from './app/settings.js';

// ── 導覽列 ──────────────────────────────────────────────────

/** 離開目前畫面前要不要先問（演唱中、編輯還沒存）。 */
async function confirmLeave() {
  if (['playing', 'paused', 'resuming'].includes(state.singPhase)) {
    const wasPlaying = state.singPhase === 'playing';
    if (wasPlaying) pauseSinging();
    const ok = await confirmBox('離開會結束這次演唱，不會計分。', { title: '離開演唱？', ok: '離開', cancel: '繼續唱' });
    if (!ok && wasPlaying) resumeSinging();
    return ok;
  }
  return confirmDiscardEdits();
}

$$('button[data-goto]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.goto;
    if (!(await confirmLeave())) return;
    if (target === 'connect') renderConnect();
    else if (target === 'calibrate') openCalibrate();
    else if (target === 'settings') openSettings();
    else goLibrary();
  });
});

$('#nav-quit').addEventListener('click', async () => {
  const ok = await confirmBox('關掉之後，手機也連不進來了。', {
    title: '關閉這台電腦上的唱歌評分？', ok: '關閉程式', danger: true,
  });
  if (!ok) return;

  const btn = $('#nav-quit');
  btn.disabled = true;
  btn.lastChild.textContent = '關閉中…';
  abortSing();
  releaseMic();
  try {
    await api.quitApp();
    showQuitNotice();
  } catch (err) {
    btn.disabled = false;
    btn.lastChild.textContent = '關閉程式';
    alertBox(`關閉失敗：${err.message}`);
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

// ── 舊資料搬家 ──────────────────────────────────────────────
//
// 舊版把成績與延遲設定檔存在瀏覽器裡（跟著網址走，換網址就不見）。
// 第一次開新版時把這個瀏覽器裡的那份搬到伺服器，搬完清掉。

async function migrateLegacy() {
  if (await store.getSetting('migratedToServer', false)) return;
  const { scores, latency } = await store.legacyData();
  try {
    if (scores.length) {
      await api.importScores(scores.map((s) => ({
        songId: s.songId, total: s.total, breakdown: s.breakdown,
        techniqueCounts: s.techniqueCounts, keyShift: s.keyShift, date: s.date,
      })));
    }
    for (const p of latency) await api.saveLatencyProfile(p);
    await store.setSetting('migratedToServer', true);
    await store.clearLegacyData();
    if (scores.length) refreshLibrary();
  } catch { /* 下次開頁再試 */ }
}

// ── 啟動 ────────────────────────────────────────────────────

(async function boot() {
  // 快捷鍵說明依平台顯示 ⌘ 或 Ctrl
  $$('.mod-key').forEach((el) => { el.textContent = isMac ? '⌘' : 'Ctrl'; });

  show('library');
  await loadParams();
  const [manual, silence, guide, theme, lyricsPrefs, sort, backingVol, guideVol, micId, outLabel, sinkId] =
    await Promise.all([
      store.getSetting('manualLatencyMs', 0), store.getSetting('silenceRms', 0.008),
      store.getSetting('guideVocal', false), store.getSetting('theme', 'auto'),
      store.getSetting('lyricsPrefs', {}), store.getSetting('librarySort', 'added'),
      store.getSetting('backingVol', 0.9), store.getSetting('guideVol', 0.75),
      store.getSetting('micDeviceId', null), store.getSetting('outputLabel', '預設輸出'),
      store.getSetting('sinkId', ''),
    ]);
  state.manualLatencyMs = manual;
  state.silenceRms = silence;
  state.guideOn = guide;
  state.sort = SORTERS[sort] ? sort : 'added';
  state.backingVol = backingVol;
  state.guideVol = guideVol;
  state.micDeviceId = micId;
  state.outputLabel = outLabel;
  state.sinkId = sinkId;
  $('#sort-select').value = state.sort;
  applyGuide(state.guideOn);
  applyVolumeLabels();
  setThemePref(theme);
  state.lyricsPrefs = { ...state.lyricsPrefs, ...lyricsPrefs };
  applyLyricsPrefs();
  $('#manual-latency').value = state.manualLatencyMs;
  $('#manual-latency-value').textContent = `${state.manualLatencyMs} ms`;
  $('#silence-slider').value = state.silenceRms;
  $('#silence-value').textContent = state.silenceRms.toFixed(3);

  // 伺服器資訊很快（不再等 torch），曲庫清單與它一起拿
  const [info] = await Promise.all([api.serverInfo().catch(() => null), refreshLibrary()]);
  state.serverInfo = info;
  // 只有在這台電腦上才顯示「手機連線」——手機是掃 QR 進來的，不需要再看一次
  $('#nav-connect').classList.toggle('hidden', !info?.isLocal);
  if (info?.public) renderLibrary();   // 公開網址上不顯示刪除鈕

  pollJobs();          // 重新整理前還在處理的歌接回來
  loadProfiles();
  migrateLegacy();

  // 先問顯示卡加速（下載要很久，越早開始越好），回答完才進導覽
  await maybeAskGpu();
  maybeStartTour();
})();
