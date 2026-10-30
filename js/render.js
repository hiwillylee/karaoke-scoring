// render.js — 演唱畫面的音程條（横向捲動的 Canvas）。
//
// 參考音是半透明青色長條，實際唱的音以發光線條疊在上面；
// 落在 ±50 cents 內的區段轉成金色，一眼就看得出哪裡唱準了。
//
// 標了技巧的音，長條本身就換成該技巧的顏色，並在上方畫一個小符號
// （しゃくり＝往上的曲線、フォール＝往下的曲線、ビブラート＝波浪），
// 不必再另外疊一條色帶。

import { midiToName } from './chart.js';
import { techniqueColor } from './techniques.js';

// 一個音同時標到多種技巧時，長條顏色取這個順序的第一個
// （ビブラート影響整個音，最能代表這個音的唱法）。符號則是全部都畫。
export const TECHNIQUE_PRIORITY = ['vibrato', 'shakuri', 'fall'];

/** noteIndex → 該音的技巧種類（依 TECHNIQUE_PRIORITY 排序）。 */
export function techniquesByNote(techniques) {
  const map = new Map();
  for (const ev of techniques || []) {
    if (ev.noteIndex == null) continue;
    const list = map.get(ev.noteIndex);
    if (list) { if (!list.includes(ev.type)) list.push(ev.type); }
    else map.set(ev.noteIndex, [ev.type]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => TECHNIQUE_PRIORITY.indexOf(a) - TECHNIQUE_PRIORITY.indexOf(b));
  }
  return map;
}

/**
 * 在 (cx, cy) 畫一個技巧符號，size 是半寬。
 * 形狀直接表達唱法：往上滑、往下滑、來回抖。
 */
export function drawTechniqueGlyph(ctx, type, cx, cy, size, alpha = 1) {
  const s = size;
  ctx.save();
  ctx.strokeStyle = techniqueColor(type, alpha);
  ctx.lineWidth = Math.max(1.2, s * 0.34);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (type === 'shakuri') {
    // 由低到高：先貼著低點，再往上甩
    ctx.moveTo(cx - s, cy + s * 0.55);
    ctx.quadraticCurveTo(cx + s * 0.15, cy + s * 0.55, cx + s, cy - s * 0.55);
  } else if (type === 'fall') {
    // 由高到低：先撐在高點，再往下掉
    ctx.moveTo(cx - s, cy - s * 0.55);
    ctx.quadraticCurveTo(cx + s * 0.15, cy - s * 0.55, cx + s, cy + s * 0.55);
  } else {
    // 波浪：兩個完整週期
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const x = cx - s + (2 * s * i) / steps;
      const y = cy - Math.sin((i / steps) * Math.PI * 4) * s * 0.5;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

const PAST_MS = 2500;
const FUTURE_MS = 3500;
const JUDGE_RATIO = PAST_MS / (PAST_MS + FUTURE_MS);
const HIT_CENTS = 50;
const MAX_TRAIL_JUMP = 5;   // 相鄰音框超過 5 半音就不連線

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

export class StageRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.notes = [];
    this.techniques = [];
    this.techByNote = new Map();
    this.range = { min: 55, max: 79 };
    this.keyShift = 0;
    this.trail = [];       // { t, midi, hit }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
  }

  setChart(notes, techniques, range) {
    this.notes = notes;
    this.techniques = techniques || [];
    this.techByNote = techniquesByNote(this.techniques);
    this.range = range;
    this.trail = [];
  }

  setKeyShift(n) {
    this.keyShift = n;
  }

  /** midi 為已做八度對齊後的使用者音高；hit 由呼叫端判定。 */
  pushUserFrame(t, midi, hit) {
    this.trail.push({ t, midi, hit });
    const cutoff = t - (PAST_MS + 500);
    while (this.trail.length && this.trail[0].t < cutoff) this.trail.shift();
  }

  clearTrail() {
    this.trail = [];
  }

  /**
   * 八度對齊基準改變時，把已經畫上去的軌跡一起平移。
   *
   * 軌跡點存的是「已套用位移後」的音高，所以基準一改，舊點與新點就會差
   * 12 半音、整條線在畫面上斷成上下兩截。整條一起平移才能維持連貫。
   */
  shiftTrail(deltaSemitones) {
    if (!deltaSemitones) return;
    for (const p of this.trail) p.midi += deltaSemitones;
  }

  yOf(midi) {
    const { min, max } = this.range;
    return this.h - ((midi - min) / (max - min)) * this.h;
  }

  xOf(songMs, nowMs) {
    return ((songMs - nowMs + PAST_MS) / (PAST_MS + FUTURE_MS)) * this.w;
  }

  draw(nowMs, opts = {}) {
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);

    this.drawKeyboard();
    this.drawNotes(nowMs);
    this.drawJudgeLine();
    this.drawTrail(nowMs);
    this.drawCursor(nowMs, opts);
    this.drawDebug();
  }

  /**
   * 診斷讀數畫在畫布裡而不是畫布外的 DOM，是為了截圖——只框畫布的截圖
   * 一樣會拍到，不會漏掉。平常 debugText 是空的，什麼也不畫。
   */
  drawDebug() {
    if (!this.debugText) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const lines = this.debugText.split('\n');
    const width = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 16;
    ctx.fillStyle = 'rgba(0, 0, 0, .72)';
    ctx.fillRect(6, 6, width, lines.length * 16 + 10);
    ctx.fillStyle = '#7CFFB2';
    lines.forEach((s, i) => ctx.fillText(s, 14, 12 + i * 16));
    ctx.restore();
  }

  drawKeyboard() {
    const ctx = this.ctx;
    const { min, max } = this.range;
    const semiH = this.h / (max - min);
    for (let m = Math.ceil(min); m <= Math.floor(max); m++) {
      const y = this.yOf(m + 0.5);
      const pc = ((m % 12) + 12) % 12;
      ctx.fillStyle = BLACK_KEYS.has(pc) ? 'rgba(255,255,255,0.028)' : 'rgba(255,255,255,0.008)';
      ctx.fillRect(0, y, this.w, semiH);
      if (pc === 0) {
        ctx.strokeStyle = 'rgba(0,229,255,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y + semiH);
        ctx.lineTo(this.w, y + semiH);
        ctx.stroke();
        ctx.fillStyle = 'rgba(0,229,255,0.45)';
        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(midiToName(m), this.w - 6, y + semiH - 4);
      }
    }
  }

  drawNotes(nowMs) {
    const ctx = this.ctx;
    const { min, max } = this.range;
    const semiH = this.h / (max - min);
    const barH = Math.max(6, Math.min(20, semiH * 0.72));
    const from = nowMs - PAST_MS;
    const to = nowMs + FUTURE_MS;

    this.notes.forEach((note, i) => {
      if (note.endMs < from || note.startMs > to) return;
      const midi = note.midi + this.keyShift;
      const x0 = this.xOf(note.startMs, nowMs);
      const x1 = this.xOf(note.endMs, nowMs);
      const y = this.yOf(midi) - barH / 2;
      const width = Math.max(3, x1 - x0);
      const passed = note.endMs < nowMs;

      // 有標技巧的音，長條直接換成該技巧的顏色；其餘維持青色
      const techs = this.techByNote.get(i);
      const fill = techs
        ? techniqueColor(techs[0], passed ? 0.20 : 0.42)
        : (passed ? 'rgba(0,229,255,0.14)' : 'rgba(0,229,255,0.30)');
      const stroke = techs
        ? techniqueColor(techs[0], passed ? 0.35 : 0.9)
        : (passed ? 'rgba(0,229,255,0.25)' : 'rgba(0,229,255,0.75)');

      ctx.fillStyle = fill;
      roundRect(ctx, x0, y, width, barH, barH / 2);
      ctx.fill();

      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.2;
      roundRect(ctx, x0, y, width, barH, barH / 2);
      ctx.stroke();

      if (techs) this.drawGlyphs(techs, (x0 + x1) / 2, y - 4, passed);
    });
  }

  /** 技巧符號畫在長條正上方，多種技巧就並排。 */
  drawGlyphs(types, cx, bottomY, passed) {
    const size = 5;
    const gap = size * 2 + 4;
    let x = cx - (gap * (types.length - 1)) / 2;
    for (const type of types) {
      drawTechniqueGlyph(this.ctx, type, x, bottomY - size, size, passed ? 0.4 : 1);
      x += gap;
    }
  }

  drawJudgeLine() {
    const ctx = this.ctx;
    const x = this.w * JUDGE_RATIO;
    const grad = ctx.createLinearGradient(x - 2, 0, x + 2, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - 2, 0, 4, this.h);
  }

  drawTrail(nowMs) {
    const ctx = this.ctx;
    if (this.trail.length < 2) return;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    let i = 0;
    while (i < this.trail.length - 1) {
      const hit = this.trail[i].hit;
      ctx.beginPath();
      ctx.moveTo(this.xOf(this.trail[i].t, nowMs), this.yOf(this.trail[i].midi));
      let j = i + 1;
      // 時間斷開或音高突然跳很遠時就斷線，避免畫出貫穿整個畫面的假尖刺
      while (j < this.trail.length && this.trail[j].hit === hit &&
             this.trail[j].t - this.trail[j - 1].t < 120 &&
             Math.abs(this.trail[j].midi - this.trail[j - 1].midi) < MAX_TRAIL_JUMP) {
        ctx.lineTo(this.xOf(this.trail[j].t, nowMs), this.yOf(this.trail[j].midi));
        j++;
      }
      ctx.strokeStyle = hit ? '#ffd54a' : '#ff2bd6';
      ctx.shadowColor = hit ? 'rgba(255,213,74,0.9)' : 'rgba(255,43,214,0.8)';
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;
      i = j - 1 > i ? j - 1 : i + 1;
    }
  }

  drawCursor(nowMs, opts) {
    const ctx = this.ctx;
    const last = this.trail[this.trail.length - 1];
    if (!last || nowMs - last.t > 200) return;
    const x = this.w * JUDGE_RATIO;
    const y = this.yOf(last.midi);
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = last.hit ? '#ffd54a' : '#ff2bd6';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.shadowBlur = 0;

    if (opts.showNoteName !== false) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(midiToName(last.midi), x + 12, y - 10);
    }
  }

  /** 判定使用者音高是否算命中（供呼叫端共用同一個門檻）。 */
  static isHit(userMidi, targetMidi) {
    return Math.abs(userMidi - targetMidi) * 100 <= HIT_CENTS;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export { HIT_CENTS };
