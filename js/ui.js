// ui.js — 對話框、提示訊息與圖示。
//
// 取代瀏覽器原生的 alert／confirm：那兩個長得跟介面完全不一樣，在手機上
// 還會顯示網址，而且會卡住整個頁面（播放中的動畫、計時器全停）。

import { escapeHtml } from './util.js';

/** 內嵌 SVG 圖示（圖形定義在 index.html 的 #icon-sprite）。 */
export function icon(name, cls = '') {
  return `<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

// ── 對話框 ───────────────────────────────────────────────────

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 讓一個對話框可以用 Esc 關閉，並把 Tab 鎖在裡面。回傳解除函式。
 * 關掉時焦點回到打開前的元素，鍵盤使用者不會迷路。
 */
export function trapFocus(root, onEscape) {
  const before = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape' && onEscape) {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => {
    const target = root.querySelector('[data-autofocus]') || root.querySelector(FOCUSABLE);
    target?.focus();
  });
  return () => {
    document.removeEventListener('keydown', onKey, true);
    if (before && typeof before.focus === 'function' && document.contains(before)) before.focus();
  };
}

let dialogQueue = Promise.resolve();

/**
 * 顯示一個對話框，回傳使用者按的按鈕值。
 * @param opts { title, message, html, buttons: [{label, value, kind:'primary'|'danger'|'ghost'}] }
 */
export function dialog(opts) {
  // 同時只顯示一個，後來的排隊
  const run = () => new Promise((resolve) => {
    const root = document.getElementById('app-dialog');
    const card = root.querySelector('.dialog-card');
    const buttons = opts.buttons || [{ label: '好', value: true, kind: 'primary' }];
    const cancelValue = opts.cancelValue ?? (buttons.length > 1 ? false : true);
    card.innerHTML = `
      ${opts.title ? `<h3 id="app-dialog-title">${escapeHtml(opts.title)}</h3>` : ''}
      <div class="dialog-body">${opts.html ?? `<p>${escapeHtml(opts.message || '').replace(/\n/g, '<br>')}</p>`}</div>
      <div class="row dialog-actions">${buttons.map((b, i) => `<button class="${b.kind || 'ghost'}"
        data-i="${i}" ${b.kind === 'primary' || b.kind === 'danger-primary' ? 'data-autofocus' : ''}>${escapeHtml(b.label)}</button>`).join('')}</div>`;
    root.classList.remove('hidden');
    let release = null;
    const close = (value) => {
      root.classList.add('hidden');
      root.removeEventListener('click', onClick);
      release?.();
      resolve(value);
    };
    const onClick = (e) => {
      if (e.target === root) { close(cancelValue); return; }
      const btn = e.target.closest('button[data-i]');
      if (btn) close(buttons[Number(btn.dataset.i)].value);
    };
    root.addEventListener('click', onClick);
    release = trapFocus(card, () => close(cancelValue));
  });
  const p = dialogQueue.then(run, run);
  dialogQueue = p.catch(() => {});
  return p;
}

export function alertBox(message, title = '') {
  return dialog({ title, message, buttons: [{ label: '好', value: true, kind: 'primary' }] });
}

/** 確認框。danger=true 時確定鍵是紅色（刪除這類不能復原的操作）。 */
export function confirmBox(message, { title = '', ok = '確定', cancel = '取消', danger = false } = {}) {
  return dialog({
    title, message,
    buttons: [
      { label: cancel, value: false, kind: 'ghost' },
      { label: ok, value: true, kind: danger ? 'danger-primary' : 'primary' },
    ],
  });
}

// ── 提示訊息 ─────────────────────────────────────────────────

/**
 * 畫面下方短暫出現的提示。action 可以帶一個按鈕（例如「看譜面」）。
 * @returns 關掉它的函式
 */
export function toast(message, { kind = '', action = null, duration = 4200 } = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="grow">${escapeHtml(message)}</span>`
    + (action ? `<button class="ghost tiny">${escapeHtml(action.label)}</button>` : '')
    + `<button class="toast-x" aria-label="關閉">${icon('close')}</button>`;
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  el.querySelector('.toast-x').addEventListener('click', close);
  if (action) {
    el.querySelector('button.ghost').addEventListener('click', () => { close(); action.run(); });
  }
  host.appendChild(el);
  if (duration) setTimeout(close, duration);
  return close;
}
