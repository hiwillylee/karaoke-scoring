// theme.js — 淺色／深色外觀。
//
// 預設跟隨系統（prefers-color-scheme），設定頁可以固定成淺色或深色，
// 結果寫在 <html data-theme="light|dark">；跟隨系統時不設這個屬性。
// 顏色本身全部定義在 css/style.css 的變數裡，畫布要用的那組是 --cv-*，
// 這裡只負責讀出來給 Canvas 用，並在主題變了的時候通知重畫。

const listeners = new Set();
const media = window.matchMedia('(prefers-color-scheme: dark)');
let cache = null;

/** 'auto' | 'light' | 'dark' */
export function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') root.dataset.theme = pref;
  else delete root.dataset.theme;
  changed();
}

export function isDark() {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === 'dark' : media.matches;
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
  if (!document.documentElement.dataset.theme) changed();
});
