// result.js — 結算畫面：分數動畫、五角雷達圖、整曲音程對照圖。

import { cssVar } from './theme.js';
import { noteRange, midiToName } from './chart.js';
import { TECHNIQUE_LABELS } from './techniques.js';
import { setupCanvas, fmtTime } from './util.js';

const RADAR_AXES = [
  { key: 'pitch', label: '音程' },
  { key: 'rhythm', label: '節奏' },
  { key: 'stability', label: '安定性' },
  { key: 'technique', label: '技巧' },
  { key: 'completion', label: '完唱度' },
];

// 畫布上的字用介面同一套字型（以前寫死了沒有載入的 Noto Sans TC）
const FONT = () => getComputedStyle(document.body).fontFamily || 'sans-serif';

/** 分數由 0 跑上去，帶輕微緩動。 */
export function animateScore(el, target, durationMs = 1600) {
  const start = performance.now();
  function step(now) {
    const p = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = (target * eased).toFixed(1);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = target.toFixed(1);
  }
  requestAnimationFrame(step);
}

export function drawRadar(canvas, breakdown) {
  const { ctx, w, h } = setupCanvas(canvas);
  const cx = w / 2;
  const cy = h / 2 + 4;
  const radius = Math.min(w, h) / 2 - 34;
  const n = RADAR_AXES.length;
  const angle = (i) => (-Math.PI / 2) + (i * 2 * Math.PI) / n;

  ctx.clearRect(0, 0, w, h);

  // 網格
  for (let ring = 1; ring <= 4; ring++) {
    const r = (radius * ring) / 4;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = angle(i);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = cssVar('--cv-grid');
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const a = angle(i);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.strokeStyle = cssVar('--cv-grid');
    ctx.stroke();
  }

  // 數值多邊形
  ctx.beginPath();
  RADAR_AXES.forEach((axis, i) => {
    const v = Math.max(0, Math.min(100, breakdown[axis.key] || 0)) / 100;
    const a = angle(i);
    const x = cx + Math.cos(a) * radius * v;
    const y = cy + Math.sin(a) * radius * v;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();
  const grad = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
  grad.addColorStop(0, cssVar('--cv-ref'));
  grad.addColorStop(1, cssVar('--cv-user'));
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.42;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = cssVar('--cv-ref');
  ctx.lineWidth = 2;
  ctx.shadowColor = cssVar('--cv-ref');
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 標籤
  const font = FONT();
  ctx.font = `12px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  RADAR_AXES.forEach((axis, i) => {
    const a = angle(i);
    const x = cx + Math.cos(a) * (radius + 20);
    const y = cy + Math.sin(a) * (radius + 18);
    ctx.fillStyle = cssVar('--cv-text');
    ctx.fillText(axis.label, x, y - 7);
    ctx.fillStyle = cssVar('--cv-ref');
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.fillText(`${(breakdown[axis.key] || 0).toFixed(0)}`, x, y + 8);
    ctx.font = `12px ${font}`;
  });
}

/**
 * 整曲音程對照：參考譜（長條） vs 實唱（線）。
 *
 * 四分鐘壓進一個卡片寬度時根本看不出東西，所以預設用固定的時間比例
 * 畫成長條，外層容器可以左右捲動；pxPerSec=0 時才整首壓成一條（總覽）。
 */
export function drawPitchCompare(canvas, chart, result, { pxPerSec = 0 } = {}) {
  const duration = chart.durationMs || 1;
  if (pxPerSec > 0) {
    canvas.style.width = `${Math.max(canvas.parentElement?.clientWidth || 0,
      Math.round((duration / 1000) * pxPerSec))}px`;
  } else {
    canvas.style.width = '100%';
  }
  const { ctx, w, h } = setupCanvas(canvas);

  const notes = chart.notes;
  if (!notes.length) return;
  const shift = result.keyShift || 0;
  const range = noteRange(notes.map((n) => ({ ...n, midi: n.midi + shift })), 2);
  const padL = 34, padR = 8, padT = 8, padB = 18;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const xOf = (ms) => padL + (ms / duration) * plotW;
  const yOf = (midi) => padT + plotH - ((midi - range.min) / (range.max - range.min)) * plotH;
  const semiH = plotH / Math.max(1, range.max - range.min);

  // 八度格線
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let m = Math.ceil(range.min); m <= range.max; m++) {
    if (((m % 12) + 12) % 12 !== 0) continue;
    const y = yOf(m);
    ctx.strokeStyle = cssVar('--cv-grid');
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillStyle = cssVar('--cv-label');
    ctx.fillText(midiToName(m), padL - 5, y);
  }

  // 時間刻度：放大時每 10 秒一格，總覽時每 30 秒
  const stepMs = pxPerSec > 0 ? 10000 : 30000;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = cssVar('--cv-label');
  for (let t = stepMs; t < duration; t += stepMs) {
    const x = xOf(t);
    ctx.strokeStyle = cssVar('--cv-grid');
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(fmtTime(t), x, h - 4);
  }

  // 參考譜：至少半個半音高，放大時是看得出長短的長條
  const barH = Math.max(3, Math.min(10, semiH * 0.7));
  ctx.fillStyle = cssVar('--cv-ref');
  ctx.globalAlpha = 0.5;
  for (const note of notes) {
    const y = yOf(note.midi + shift);
    ctx.fillRect(xOf(note.startMs), y - barH / 2, Math.max(2, xOf(note.endMs) - xOf(note.startMs)), barH);
  }
  ctx.globalAlpha = 1;

  // 實唱
  const oct = result.octaveOffset || 0;
  ctx.strokeStyle = cssVar('--cv-user');
  ctx.lineWidth = pxPerSec > 0 ? 2.2 : 1.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let pen = false;
  let prevT = -1e9;
  for (const f of result.userFrames) {
    if (!f.midi) { pen = false; continue; }
    const x = xOf(f.t);
    const y = yOf(f.midi + oct);
    if (!pen || f.t - prevT > 120) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    pen = true;
    prevT = f.t;
  }
  ctx.stroke();
}

/** 技巧計數（含與原唱重合的次數）。type 供畫面上色用。 */
export function techniqueSummary(result) {
  return Object.entries(result.techniqueCounts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, label: TECHNIQUE_LABELS[type] || type, count }));
}

/** 結算畫面的金色粒子。 */
export function burstParticles(canvas, strength = 1) {
  const { ctx, w, h } = setupCanvas(canvas);
  const count = Math.round(70 * strength);
  const parts = Array.from({ length: count }, () => ({
    x: w / 2,
    y: h / 2,
    vx: (Math.random() - 0.5) * 7,
    vy: (Math.random() - 0.5) * 7 - 1.5,
    life: 1,
    color: Math.random() < 0.5 ? cssVar('--cv-hit') : cssVar('--cv-ref'),
  }));

  let raf;
  function tick() {
    ctx.clearRect(0, 0, w, h);
    let alive = false;
    for (const p of parts) {
      if (p.life <= 0) continue;
      alive = true;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.12;
      p.life -= 0.012;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (alive) raf = requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, w, h);
  }
  cancelAnimationFrame(raf);
  tick();
}
