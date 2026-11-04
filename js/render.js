// render.js — 演唱畫面的音程條（横向捲動的 Canvas）。
//
// 參考音是白色半透明的長條（點歌機的音程條），實際唱的音以發光線條疊在上面；
// 落在 ±50 cents 內的區段轉成黃色，一眼就看得出哪裡唱準了。
// 目前音高用一個 ▶ 指標標在判定線左側。
//
// 標了技巧的音，長條本身就換成該技巧的顏色，並在上方畫一個小符號
// （しゃくり＝往上的曲線、フォール＝往下的曲線、ビブラート＝波浪），
// 不必再另外疊一條色帶。

import { midiToName } from './chart.js';
import { techniqueColor } from './techniques.js';
import { cssVar } from './theme.js';

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
const TRAIL_GAP_MS = 120;   // 音框間隔超過這麼久（換氣、沒聲音）就斷線

// 音準線的顯示平滑（只影響畫面，評分用的是原始音高）：
// 先取最近 3 框的中位數去掉單框尖刺，再做自適應的指數平滑——
// 小幅抖動（< 0.3 半音）壓得很平，真的換音（差好幾個半音）時幾乎立刻跟上，
// 線才不會在音與音之間拖出一條慢吞吞的斜坡。
const SMOOTH_MIN = 0.22;
const SMOOTH_MAX = 0.85;
// 準／不準的顏色要連續這麼多框才切換，避免邊界上一閃一閃
const HIT_HOLD_FRAMES = 4;

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
    const last = this.trail[this.trail.length - 1];
    const continuous = last && t - last.t < TRAIL_GAP_MS && Math.abs(midi - last.raw) < MAX_TRAIL_JUMP;
    if (!continuous) {
      this.recentRaw = [midi];
      this.hitRun = { value: hit, pending: hit, count: 0 };
      this.trail.push({ t, midi, raw: midi, hit });
    } else {
      this.recentRaw.push(midi);
      if (this.recentRaw.length > 3) this.recentRaw.shift();
      const med = [...this.recentRaw].sort((a, b) => a - b)[Math.floor(this.recentRaw.length / 2)];
      const diff = med - last.midi;
      const a = Math.min(SMOOTH_MAX, SMOOTH_MIN + Math.abs(diff) * 0.35);
      this.trail.push({ t, midi: last.midi + diff * a, raw: midi, hit: this.debounceHit(hit) });
    }
    const cutoff = t - (PAST_MS + 500);
    while (this.trail.length && this.trail[0].t < cutoff) this.trail.shift();
  }

  /** 準／不準要連續 HIT_HOLD_FRAMES 框才改顏色。 */
  debounceHit(hit) {
    const run = this.hitRun;
    if (hit === run.value) { run.count = 0; return run.value; }
    if (hit === run.pending) run.count++;
    else { run.pending = hit; run.count = 1; }
    if (run.count >= HIT_HOLD_FRAMES) { run.value = hit; run.count = 0; }
    return run.value;
  }

  clearTrail() {
    this.trail = [];
    this.recentRaw = [];
  }

  /**
   * 八度對齊基準改變時，把已經畫上去的軌跡一起平移。
   *
   * 軌跡點存的是「已套用位移後」的音高，所以基準一改，舊點與新點就會差
   * 12 半音、整條線在畫面上斷成上下兩截。整條一起平移才能維持連貫。
   */
  shiftTrail(deltaSemitones) {
    if (!deltaSemitones) return;
    for (const p of this.trail) { p.midi += deltaSemitones; p.raw += deltaSemitones; }
    if (this.recentRaw) this.recentRaw = this.recentRaw.map((m) => m + deltaSemitones);
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
      if (BLACK_KEYS.has(pc)) {
        ctx.fillStyle = cssVar('--cv-key');
        ctx.fillRect(0, y, this.w, semiH);
      }
      if (pc === 0) {
        ctx.strokeStyle = cssVar('--cv-octave');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y + semiH);
        ctx.lineTo(this.w, y + semiH);
        ctx.stroke();
        ctx.fillStyle = cssVar('--cv-label');
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
        ? techniqueColor(techs[0], passed ? 0.22 : 0.45)
        : cssVar(passed ? '--cv-note-fill-past' : '--cv-note-fill');
      const stroke = techs
        ? techniqueColor(techs[0], passed ? 0.35 : 0.95)
        : cssVar(passed ? '--cv-note-stroke-past' : '--cv-note-stroke');

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
    ctx.fillStyle = cssVar('--cv-judge');
    ctx.fillRect(x - 1, 0, 2, this.h);
  }

  drawTrail(nowMs) {
    const ctx = this.ctx;
    const trail = this.trail;
    if (trail.length < 2) return;
    ctx.lineWidth = 3.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const joined = (k) => trail[k].t - trail[k - 1].t < TRAIL_GAP_MS &&
      Math.abs(trail[k].midi - trail[k - 1].midi) < MAX_TRAIL_JUMP;

    let i = 0;
    while (i < trail.length - 1) {
      const hit = trail[i].hit;
      // 同一種顏色、沒有斷開的一段 [i, j)
      let j = i + 1;
      while (j < trail.length && trail[j].hit === hit && joined(j)) j++;
      // 換顏色的地方多畫一點接到下一段的第一個點，兩色才不會中間留縫
      const end = j < trail.length && trail[j].hit !== hit && joined(j) ? j : j - 1;
      if (end > i) {
        const pts = [];
        for (let k = i; k <= end; k++) pts.push([this.xOf(trail[k].t, nowMs), this.yOf(trail[k].midi)]);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        // 經過相鄰兩點中點的二次曲線：線條連續、沒有折角
        for (let k = 1; k < pts.length - 1; k++) {
          const mx = (pts[k][0] + pts[k + 1][0]) / 2;
          const my = (pts[k][1] + pts[k + 1][1]) / 2;
          ctx.quadraticCurveTo(pts[k][0], pts[k][1], mx, my);
        }
        ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        ctx.strokeStyle = cssVar(hit ? '--cv-hit' : '--cv-miss');
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      i = j;
    }
  }

  drawCursor(nowMs, opts) {
    const ctx = this.ctx;
    const last = this.trail[this.trail.length - 1];
    if (!last || nowMs - last.t > 200) return;
    const x = this.w * JUDGE_RATIO;
    const y = this.yOf(last.midi);
    // ▶ 指標：尖端貼在判定線上
    ctx.beginPath();
    ctx.moveTo(x - 2, y);
    ctx.lineTo(x - 17, y - 9);
    ctx.lineTo(x - 17, y + 9);
    ctx.closePath();
    ctx.fillStyle = cssVar(last.hit ? '--cv-hit' : '--cv-miss');
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 16;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = cssVar('--cv-cursor-edge');
    ctx.stroke();

    if (opts.showNoteName !== false) {
      ctx.fillStyle = cssVar('--cv-text');
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
