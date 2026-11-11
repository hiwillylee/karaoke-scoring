// util.js — 各畫面共用的小工具。以前在 main.js、result.js、lyrics.js 各有一份。

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 毫秒 → m:ss */
export function fmtTime(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 讓畫布的像素尺寸跟著 CSS 尺寸與螢幕密度，回傳已套好縮放的 context。
 *
 * 尺寸沒變就不重設 width/height：重設會重新配置整塊點陣，播放中每一幀
 * 都這樣做很浪費。clear=false 時由呼叫端自己清。
 */
export function setupCanvas(canvas, clear = true) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const pw = Math.max(1, Math.round(rect.width * dpr));
  const ph = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (clear) ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, w: rect.width, h: rect.height };
}

/** 搜尋用的正規化：全形轉半形、不分大小寫、去掉空白（與伺服器 library.normalize 相同）。 */
export function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 開關型按鈕：外觀與 aria-pressed 一起改，螢幕報讀器才知道狀態。 */
export function setToggle(btn, on) {
  btn.classList.toggle('on', !!on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
