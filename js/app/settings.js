// app/settings.js — 延遲校準、設定、外觀、手機連線、顯示卡加速與導覽。

import * as api from '../api.js';
import { LatencyCalibrator, isReliable, persist as persistLatency } from '../calibrate.js';
import { listDevices } from '../mic.js';
import * as store from '../storage.js';
import { applyTheme, onThemeChange } from '../theme.js';
import { Tour } from '../tour.js';
import { alertBox, confirmBox, toast, trapFocus } from '../ui.js';
import { $, $$, escapeHtml, setToggle } from '../util.js';
import { alive, audioCtx, ensureMic, goBack, releaseMic, show, state } from './core.js';
import { refreshLibrary } from './library.js';
import { decoded, stemChecked } from './chart.js';
import { drawResultCharts } from './sing.js';

// ── 延遲校準 ────────────────────────────────────────────────

export function findProfile(micLabel, outputLabel) {
  const id = `${micLabel || '未知麥克風'}｜${outputLabel || '預設輸出'}`;
  return state.profiles.find((p) => p.id === id) || null;
}

export async function loadProfiles() {
  try { state.profiles = await api.getLatencyProfiles(); } catch { /* 保留舊的 */ }
}

export async function openCalibrate() {
  show('calibrate');
  const flow = state.flowId;
  $('#calib-result').classList.add('hidden');
  $('#calib-status').textContent = '按下開始後會先有 8 拍前導，接著跟著拍 8 下。';
  try {
    await ensureMic();
  } catch (err) {
    if (alive(flow)) $('#calib-status').textContent = err.message;
    return;
  }
  if (!alive(flow)) return;
  const { inputs, outputs } = await listDevices();
  $('#calib-mic').innerHTML = inputs
    .map((d) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || '麥克風')}</option>`).join('');
  $('#calib-mic').value = state.mic?.deviceId || inputs[0]?.deviceId || '';

  // 支援 setSinkId 的瀏覽器可以真的切換輸出裝置；不支援的話這裡只是替設定檔命名
  const canSwitch = !!state.ctx?.setSinkId && outputs.length > 0;
  const sel = $('#calib-out');
  if (canSwitch) {
    sel.innerHTML = outputs.map((d) => `<option value="${escapeHtml(d.deviceId)}"
      data-label="${escapeHtml(d.label || '輸出')}">${escapeHtml(d.label || '輸出')}</option>`).join('');
    sel.value = outputs.some((o) => o.deviceId === state.sinkId) ? state.sinkId : outputs[0].deviceId;
    $('#calib-out-note').textContent = '選了就會真的改從那個裝置發聲。';
  } else {
    const names = outputs.length ? outputs.map((d) => d.label || '輸出') : ['耳機', '筆電喇叭', '外接喇叭', '藍牙耳機'];
    if (state.outputLabel && !names.includes(state.outputLabel)) names.unshift(state.outputLabel);
    sel.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}" data-label="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    sel.value = state.outputLabel && names.includes(state.outputLabel) ? state.outputLabel : names[0];
    $('#calib-out-note').textContent = '這個瀏覽器不能從網頁切換輸出裝置：這裡只用來替設定檔命名，'
      + '實際的輸出請在系統的音效設定裡切換。';
  }
  await applyOutputChoice();
}

export async function applyOutputChoice() {
  const sel = $('#calib-out');
  const opt = sel.selectedOptions[0];
  if (!opt) return;
  state.outputLabel = opt.dataset.label || opt.value;
  store.setSetting('outputLabel', state.outputLabel);
  if (state.ctx?.setSinkId && opt.value !== opt.dataset.label) {
    state.sinkId = opt.value;
    store.setSetting('sinkId', state.sinkId);
    try { await state.ctx.setSinkId(state.sinkId); } catch { /* 裝置不見了 */ }
  }
}

$('#calib-out').addEventListener('change', () => applyOutputChoice());
$('#calib-mic').addEventListener('change', async (e) => {
  state.micDeviceId = e.target.value || null;
  store.setSetting('micDeviceId', state.micDeviceId);
  try {
    await ensureMic(state.micDeviceId);
  } catch (err) {
    $('#calib-status').textContent = err.message;
  }
});

$('#calib-start').addEventListener('click', async () => {
  const btn = $('#calib-start');
  btn.disabled = true;
  state.calibrating = true;
  $('#calib-result').classList.add('hidden');
  $('#calib-status').textContent = '播放中，跟著拍手…';

  const beats = 16, leadIn = 8;
  const dots = $('#beat-dots');
  dots.innerHTML = Array.from({ length: beats },
    (_, i) => `<i class="${i < leadIn ? 'lead' : ''}"></i>`).join('');

  try {
    const ctx = await audioCtx();
    const mic = await ensureMic(state.micDeviceId);
    await applyOutputChoice();
    const calibrator = new LatencyCalibrator(ctx, mic);
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
      const outMs = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
      await persistLatency(res, mic.deviceLabel, state.outputLabel, outMs);
      await loadProfiles();
      box.innerHTML = `
        <div class="value">${res.offsetMs} ms</div>
        <p class="muted small">${res.accepted}/${res.total} 拍有效，離散 ±${Math.round(res.spreadMs / 2)}ms</p>
        <p class="small">已存成設定檔：${escapeHtml(mic.deviceLabel)} × ${escapeHtml(state.outputLabel)}</p>`;
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
    state.calibrating = false;
    btn.disabled = false;
    if (state.screen !== 'calibrate') releaseMic();
  }
});

$('#calib-back').addEventListener('click', () => goBack());

// ── 設定 ────────────────────────────────────────────────────

/** 版本、網址與運算裝置。硬體資訊只給這台電腦看。 */
export async function renderServerInfo() {
  const el = $('#server-info');
  const info = state.serverInfo || {};
  const rows = [['版本', `<dd>${escapeHtml(info.version || '—')}</dd>`],
    ['曲庫', `<dd>${info.songs ?? state.allSongs.length} 首（存在電腦上）</dd>`]];
  if (!info.isLocal) {
    rows.push(['連線', `<dd>${info.public ? '臨時公開網址' : '內網'}</dd>`]);
    el.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt>${v}`).join('');
    return;
  }
  el.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt>${v}`).join('')
    + '<dt>運算裝置</dt><dd class="off">偵測中…</dd>';
  try {
    const full = await api.serverInfoFull();
    rows.push(['這台電腦', `<dd class="url">${escapeHtml(full.localUrl || '')}</dd>`]);
    rows.push(['內網其他裝置', full.lanUrls?.length
      ? full.lanUrls.map((u) => `<dd class="url">${escapeHtml(u)}</dd>`).join('')
      : '<dd class="off">沒有可用的憑證，內網裝置不會有麥克風</dd>']);
    const active = (full.devices || []).find((d) => d.device && d.device === full.device);
    rows.push(['分離運算', `<dd>${escapeHtml(active ? active.label : String(full.device || '偵測中'))}</dd>`]);
    const others = (full.devices || [])
      .filter((d) => d.name !== '_torch' && d.name !== 'cpu')
      .map((d) => `${d.label}${d.available ? '✓' : '✗'}`).join('　');
    if (others) rows.push(['偵測結果', `<dd class="off">${escapeHtml(others)}</dd>`]);
    const torch = (full.devices || []).find((d) => d.name === '_torch');
    rows.push(['套件', `<dd class="off">${torch ? `${escapeHtml(torch.label)}・` : ''}yt-dlp ${escapeHtml(full.downloader || '未安裝')}</dd>`]);
  } catch {
    rows.push(['運算裝置', '<dd class="off">取得失敗</dd>']);
  }
  if (state.screen === 'settings') el.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt>${v}`).join('');
}

export async function renderCacheInfo() {
  const bytes = await store.cacheSize();
  const mb = bytes / 1048576;
  $('#cache-info').textContent = bytes
    ? `已快取 ${mb.toFixed(1)} MB`
    : '目前沒有快取（下次演唱時才會抓音軌）';
  $('#cache-clear').disabled = !bytes;
}

$('#cache-clear').addEventListener('click', async () => {
  await store.clearAudioCache();
  decoded.clear();
  stemChecked.clear();
  renderCacheInfo();
});

export async function renderProfiles() {
  await loadProfiles();
  const list = $('#profile-list');
  if (!state.profiles.length) {
    list.innerHTML = '<li class="empty">還沒有任何設定檔，先做一次拍手校準。</li>';
    return;
  }
  list.innerHTML = state.profiles.map((p) => `
    <li data-id="${escapeHtml(p.id)}">
      <span class="pname">${escapeHtml(p.micLabel)} × ${escapeHtml(p.outputLabel)}</span>
      <span class="pval">${p.offsetMs} ms</span>
      <button class="ghost tiny danger" data-act="del">刪除</button>
    </li>`).join('');
}

$('#profile-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="del"]');
  if (!btn) return;
  try {
    await api.deleteLatencyProfile(btn.closest('li').dataset.id);
  } catch (err) {
    toast(`刪除失敗：${err.message}`, { kind: 'error' });
  }
  renderProfiles();
});

$('#manual-latency').addEventListener('input', async (e) => {
  state.manualLatencyMs = Number(e.target.value);
  $('#manual-latency-value').textContent = `${state.manualLatencyMs} ms`;
  await store.setSetting('manualLatencyMs', state.manualLatencyMs);
});

export const METER_MAX = 0.06;   // 音量表滿格對應的 RMS
export function placeMeterMark() {
  $('#mic-meter-mark').style.left = `${Math.min(100, (state.silenceRms / METER_MAX) * 100)}%`;
}

$('#silence-slider').addEventListener('input', async (e) => {
  state.silenceRms = Number(e.target.value);
  $('#silence-value').textContent = state.silenceRms.toFixed(3);
  if (state.mic) state.mic.silenceRms = state.silenceRms;
  placeMeterMark();
  await store.setSetting('silenceRms', state.silenceRms);
});

// 麥克風測試：即時音量表，對照靜音門檻（以前只能盲調一個 0.008 的數字）
export let meterRaf = null;
export async function startMicTest() {
  const btn = $('#mic-test');
  try {
    await ensureMic();
  } catch (err) {
    $('#mic-test-note').textContent = err.message;
    return;
  }
  if (state.screen !== 'settings') { releaseMic(); return; }
  btn.classList.add('on');
  btn.setAttribute('aria-pressed', 'true');
  btn.lastChild.textContent = '停止測試';
  const fill = $('#mic-meter-fill');
  const tick = () => {
    const level = state.mic?.level || 0;
    fill.style.width = `${Math.min(100, (level / METER_MAX) * 100)}%`;
    fill.classList.toggle('voice', level >= state.silenceRms);
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

export function stopMicTest() {
  if (meterRaf === null && !$('#mic-test').classList.contains('on')) return;
  cancelAnimationFrame(meterRaf);
  meterRaf = null;
  const btn = $('#mic-test');
  btn.classList.remove('on');
  btn.setAttribute('aria-pressed', 'false');
  btn.lastChild.textContent = '測試麥克風';
  $('#mic-meter-fill').style.width = '0%';
  releaseMic();
}

$('#mic-test').addEventListener('click', () => {
  if ($('#mic-test').classList.contains('on')) stopMicTest(); else startMicTest();
});

$('#settings-back').addEventListener('click', () => goBack());

// 曲庫備份與還原（只限這台電腦）
$('#restore-btn').addEventListener('click', () => $('#restore-file').click());
$('#restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const ok = await confirmBox(`從「${file.name}」還原？曲庫裡已經有的歌會保留不動，只會加入備份裡多出來的歌。`,
    { title: '從備份還原', ok: '開始還原' });
  if (!ok) return;
  const status = $('#restore-status');
  status.textContent = '上傳中…';
  try {
    const res = await api.restoreLibrary(file, (p) => { status.textContent = `上傳中 ${Math.round(p * 100)}%`; });
    status.textContent = `還原完成：加入 ${res.added} 首${res.skipped ? `，略過 ${res.skipped} 首（已存在或檔案不完整）` : ''}。`;
    refreshLibrary();
  } catch (err) {
    status.textContent = `還原失敗：${err.message}`;
  }
});

export async function openSettings() {
  show('settings');
  const local = !!state.serverInfo?.isLocal;
  $('#backup-card').classList.toggle('hidden', !local);
  $('#quit-card').classList.toggle('hidden', !local);
  placeMeterMark();
  renderProfiles();
  renderServerInfo();
  renderCacheInfo();
  if (local) renderGpu();
}

// ── 外觀（跟隨系統／淺色／深色）─────────────────────────────

export function setThemePref(pref) {
  applyTheme(pref);
  // 頁首的小段腳本在樣式載入前讀這個值，避免開頁時先閃一下另一種顏色
  try { localStorage.setItem('theme', pref); } catch { /* 私密模式等讀寫不了就算了 */ }
  $$('#theme-switch button').forEach((b) => setToggle(b, b.dataset.themePref === pref));
}

$('#theme-switch').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-theme-pref]');
  if (!btn) return;
  setThemePref(btn.dataset.themePref);
  await store.setSetting('theme', btn.dataset.themePref);
});

// 畫布不會自己跟著 CSS 變色：結算圖表畫一次就不動了，主題一換要重畫。
// 演唱畫面每一幀都重畫，不用另外處理。
onThemeChange(() => {
  if (state.screen === 'result') drawResultCharts();
});


// ── 手機連線（只在這台電腦上顯示） ──────────────────────────

export async function renderConnect() {
  show('connect');
  let info = state.serverInfo || {};
  try { info = state.serverInfo = { ...info, ...(await api.serverInfo()) }; } catch { /* 用舊的 */ }
  const lanUrls = info.lanUrls || [];

  // 電腦有好幾張網卡（VPN、虛擬機）時讓使用者換，第一個是對外連線用的那張
  $('#lan-pick').classList.toggle('hidden', lanUrls.length < 2);
  $('#lan-select').innerHTML = lanUrls.map((u, i) => `<option value="${i}">${escapeHtml(u)}</option>`).join('');
  showLanQr(0);

  $('#tunnel-on-start').checked = !!(info.settings || {}).tunnelOnStart;
  await refreshTunnel();
}

export function showLanQr(idx) {
  const lanUrl = (state.serverInfo?.lanUrls || [])[idx];
  $('#qr-lan-url').textContent = lanUrl || '（找不到內網位址）';
  $('#qr-lan').innerHTML = lanUrl
    ? '<div class="qr-empty">產生中…</div>'
    : '<div class="qr-empty">這台電腦沒有連上區域網路</div>';
  if (lanUrl) loadQr(`lan&i=${idx}`, '#qr-lan');
}

$('#lan-select').addEventListener('change', (e) => showLanQr(Number(e.target.value)));

/** QR 由伺服器產生（純 Python，不連外），這裡把 SVG 直接塞進去。 */
export async function loadQr(target, selector) {
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

export async function refreshTunnel() {
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
  $('#tunnel-copy').classList.toggle('hidden', !(st.running && st.shareUrl));

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
    urlEl.textContent = st.shareUrl || st.url;
    loadQr('tunnel', '#qr-tunnel');
  } else {
    btn.textContent = st.starting ? '建立中…' : '建立公開網址';
    urlEl.textContent = st.error || '';
    box.innerHTML = `<div class="qr-empty">${
      st.starting ? '建立中，請稍候…' : escapeHtml(st.error || '尚未建立')}</div>`;
  }
}

$('#tunnel-copy').addEventListener('click', async () => {
  const url = state.tunnel?.shareUrl;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    toast('已複製公開網址（含存取碼）');
  } catch {
    toast('無法自動複製，請手動選取網址', { kind: 'warn' });
  }
});

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
    const res = await fetch(`api/tunnel/${running ? 'stop' : 'start'}`, { method: 'POST' });
    state.tunnel = await res.json();
  } catch (err) {
    state.tunnel = { available: true, running: false, error: String(err.message || err) };
  }
  if (poll) clearInterval(poll);
  btn.disabled = false;
  refreshTunnel();
});

$('#tunnel-on-start').addEventListener('change', async (e) => {
  try {
    await api.saveServerSettings({ tunnelOnStart: e.target.checked });
  } catch (err) {
    toast(`設定沒有存成功：${err.message}`, { kind: 'error' });
  }
});

$('#connect-back').addEventListener('click', () => goBack());

// ── 顯示卡加速 ──────────────────────────────────────────────
//
// Windows 安裝檔內附的是 CPU 版 PyTorch（CUDA 版太大，放不上 GitHub Releases）。
// 偵測到 N 卡時，第一次開啟就問要不要下載 NVIDIA 加速包，設定頁也能隨時開關。
// 實際的下載、驗證與載入見 gpu_pack.py。

export const GPU_BUSY = ['downloading', 'extracting', 'verifying'];
export let gpuPoll = null;
export let gpuDialogDone = null;   // 第一次詢問的視窗關掉時呼叫，接著才開始導覽
export let gpuDialogRelease = null;

export const gb = (bytes) => `${(bytes / 1073741824).toFixed(2)} GB`;

export function gpuHtml(st, inDialog) {
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

export async function renderGpu() {
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

export function closeGpuDialog() {
  $('#gpu-dialog').classList.add('hidden');
  gpuDialogRelease?.();
  gpuDialogRelease = null;
  const done = gpuDialogDone;
  gpuDialogDone = null;
  done?.();
}

/** 第一次開啟、而且真的能用 N 卡加速時才問；回答過（不論是或否）就不再自動跳出。 */
export async function maybeAskGpu() {
  if (!state.serverInfo?.isLocal) return;
  const st = await api.gpuStatus().catch(() => null);
  if (!st || !st.available || st.installed || st.promptAnswered) return;
  if (st.state !== 'idle' && st.state !== 'error') return;
  $('#gpu-dialog-body').innerHTML = gpuHtml(st, true);
  $('#gpu-dialog').classList.remove('hidden');
  gpuDialogRelease = trapFocus($('#gpu-dialog .dialog-card'), () => closeGpuDialog());
  await new Promise((resolve) => { gpuDialogDone = resolve; });
}

export async function onGpuAction(e) {
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
  if (act === 'remove' && !(await confirmBox('重新啟動程式後生效。', {
    title: '移除 NVIDIA 加速包、改回用 CPU 分離？', ok: '移除', danger: true }))) return;
  if (act === 'restart') {
    if (['playing', 'paused'].includes(state.singPhase)
      && !(await confirmBox('重新啟動會結束這次演唱。', { title: '正在演唱中', ok: '重新啟動' }))) return;
    btn.disabled = true;
    btn.textContent = '重新啟動中…';
    try {
      await api.restartApp();
      location.reload();
    } catch (err) {
      alertBox(err.message);
      btn.disabled = false;
      btn.textContent = '立即重新啟動';
    }
    return;
  }

  btn.disabled = true;
  try {
    await api.gpuAction(act);
  } catch (err) {
    alertBox(err.message);
  }
  await renderGpu();
}

$('#gpu-dialog').addEventListener('click', onGpuAction);
$('#gpu-settings').addEventListener('click', onGpuAction);

// ── 第一次使用導覽 ──────────────────────────────────────────
//
// 導覽要等伺服器資訊與顯示卡詢問之後才開始，那時使用者可能已經在唱歌了。
// 不在曲庫畫面就先記著，等回到曲庫再開始——不能蓋在演唱畫面上擋住按鈕。

export async function maybeStartTour(force = false) {
  const seen = await store.getSetting('tourDone', false);
  if (seen && !force) return;
  if (!force && state.screen !== 'library') { state.tourPending = true; return; }
  if (force) { show('library'); await refreshLibrary(); }
  // 等版面穩定再量位置，否則高亮框會對不準
  await new Promise((r) => setTimeout(r, 250));
  if (state.screen !== 'library') { state.tourPending = !force; return; }
  new Tour({ onFinish: () => store.setSetting('tourDone', true) }).start();
}

$('#tour-restart').addEventListener('click', () => maybeStartTour(true));
