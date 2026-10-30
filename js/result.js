// result.js — 結算畫面：分數動畫、五角雷達圖、整曲音程對照圖。

import { noteRange, midiToName } from './chart.js';
import { TECHNIQUE_LABELS } from './techniques.js';

const RADAR_AXES = [
  { key: 'pitch', label: '音程' },
  { key: 'rhythm', label: '節奏' },
  { key: 'stability', label: '安定性' },
  { key: 'technique', label: '技巧' },
  { key: 'completion', label: '完唱度' },
];

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

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
    ctx.strokeStyle = 'rgba(0,229,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const a = angle(i);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.strokeStyle = 'rgba(0,229,255,0.12)';
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
  grad.addColorStop(0, 'rgba(0,229,255,0.42)');
  grad.addColorStop(1, 'rgba(255,43,214,0.42)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(0,229,255,0.7)';
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 標籤
  ctx.font = '12px "Noto Sans TC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  RADAR_AXES.forEach((axis, i) => {
    const a = angle(i);
    const x = cx + Math.cos(a) * (radius + 20);
    const y = cy + Math.sin(a) * (radius + 18);
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText(axis.label, x, y - 7);
    ctx.fillStyle = '#00e5ff';
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.fillText(`${(breakdown[axis.key] || 0).toFixed(0)}`, x, y + 8);
    ctx.font = '12px "Noto Sans TC", sans-serif';
  });
}

/** 整曲音程對照：參考譜（青色長條） vs 實唱（洋紅線）。 */
export function drawPitchCompare(canvas, chart, result) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const notes = chart.notes;
  if (!notes.length) return;
  const shift = result.keyShift || 0;
  const range = noteRange(notes.map((n) => ({ ...n, midi: n.midi + shift })), 2);
  const duration = chart.durationMs;
  const padL = 34, padR = 8, padT = 8, padB = 16;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const xOf = (ms) => padL + (ms / duration) * plotW;
  const yOf = (midi) => padT + plotH - ((midi - range.min) / (range.max - range.min)) * plotH;

  // 八度格線
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let m = Math.ceil(range.min); m <= range.max; m++) {
    if (((m % 12) + 12) % 12 !== 0) continue;
    const y = yOf(m);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText(midiToName(m), padL - 5, y);
  }

  // 參考譜
  for (const note of notes) {
    const y = yOf(note.midi + shift);
    ctx.fillStyle = 'rgba(0,229,255,0.55)';
    ctx.fillRect(xOf(note.startMs), y - 2, Math.max(1.5, xOf(note.endMs) - xOf(note.startMs)), 4);
  }

  // 實唱
  const oct = result.octaveOffset || 0;
  ctx.strokeStyle = 'rgba(255,43,214,0.9)';
  ctx.lineWidth = 1.4;
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
    hue: Math.random() < 0.5 ? '255,213,74' : '0,229,255',
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
      ctx.fillStyle = `rgba(${p.hue},${Math.max(0, p.life)})`;
      ctx.fill();
    }
    if (alive) raf = requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, w, h);
  }
  cancelAnimationFrame(raf);
  tick();
}
