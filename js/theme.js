// theme.js — 淺色／深色外觀。
//
// 預設跟隨系統（prefers-color-scheme），設定頁可以固定成淺色或深色。
// 不論哪一種，最後都解析成 <html data-theme="light|dark">，CSS 只需要
// 一份深色變數（以前為了「跟隨系統」與「手動深色」兩種情況，同一組
// 變數在 style.css 裡整份寫了兩次）。使用者的選擇記在 data-theme-pref。
// 顏色本身全部定義在 css/style.css 的變數裡，畫布要用的那組是 --cv-*，
// 這裡只負責讀出來給 Canvas 用，並在主題變了的時候通知重畫。

const listeners = new Set();
const media = window.matchMedia('(prefers-color-scheme: dark)');
let cache = null;

function resolved(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return media.matches ? 'dark' : 'light';
}

/** 'auto' | 'light' | 'dark' */
export function applyTheme(pref) {
  const root = document.documentElement;
  root.dataset.themePref = pref === 'light' || pref === 'dark' ? pref : 'auto';
  const next = resolved(pref);
  const prev = root.dataset.theme;
  root.dataset.theme = next;
  if (prev !== next) changed();
}

export function isDark() {
  return document.documentElement.dataset.theme === 'dark';
}

/** 讀一個 CSS 變數（--cv-hit 之類）。結果會快取到主題改變為止。 */
export function cssVar(name) {
  if (!cache) cache = new Map();
  if (!cache.has(name)) {
    cache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  }
  return cache.get(name);
}

/** 主題改變（系統切換或使用者選了別的）時呼叫 fn。 */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  cache = null;
  for (const fn of listeners) fn(isDark());
}

media.addEventListener('change', () => {
  if ((document.documentElement.dataset.themePref || 'auto') === 'auto') applyTheme('auto');
});
