// editor.js — 譜面編輯器（鋼琴捲軸）。
//
// 自動抽出來的譜不會完美：音高偵測器會整句鎖在二次諧波上（差一個八度）、
// 氣音會被切成碎音、換氣處的殘響會多出幽靈音。這裡讓使用者直接動手改。
//
// 只負責「畫」與「操作」，不碰儲存與播放——那些由 main.js 接。
// 每次變更都呼叫 onChange(notes)，由外面決定要不要重畫預覽、要不要存檔。

import { midiToName } from './chart.js';

const EDGE_PX = 6;          // 邊緣拖曳（改長度）的感應寬度
const MIN_NOTE_MS = 40;
const PAD_SEMITONES = 3;
// 上方的時間尺：點一下或拖曳就跳到那個時間。編輯時常常要反覆聽同一句，
// 沒有這條就只能從頭播。
const RULER_H = 22;
const PLAYHEAD_GRAB_PX = 5;   // 直接抓播放頭那條線的感應寬度

/** 一步 undo 需要的資訊都放在快照裡，簡單但夠用。 */
const MAX_HISTORY = 100;

export class ChartEditor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { onChange(notes), onSelect(note|null), onSeek(ms) }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.onChange = opts.onChange || (() => {});
    this.onSelect = opts.onSelect || (() => {});
    this.onSeek = opts.onSeek || (() => {});

    this.notes = [];
    this.durationMs = 0;
    this.selected = new Set();
    this.history = [];
    this.future = [];

    this.pxPerMs = 0.12;     // 縮放
    this.scrollMs = 0;
    this.midiLo = 48;
    this.midiHi = 84;
    this.playheadMs = 0;

    this.drag = null;
    this.autoScrollRAF = null;
    this.autoScrollMsPerSec = 0;
    this.bind();
  }

  // -- 資料 ---------------------------------------------------------------

  setNotes(notes, durationMs, startAtMs = null) {
    this.notes = notes.map((n) => ({ ...n }));
    this.durationMs = durationMs || 0;
    this.selected.clear();
    this.history = [];
    this.future = [];
    this.fitRange();
    // 開在有東西的地方。前奏動輒二三十秒，停在 0 秒只會看到一片空白。
    const first = this.notes.length ? this.notes[0].startMs : 0;
    this.scrollMs = Math.max(0, (startAtMs ?? first) - 1000);
    this.draw();
  }

  /** 縱軸範圍取譜面本身的音域，上下各留幾個半音。 */
  fitRange() {
    if (!this.notes.length) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of this.notes) {
      lo = Math.min(lo, n.midi);
      hi = Math.max(hi, n.midi);
    }
    this.midiLo = Math.floor(lo) - PAD_SEMITONES;
    this.midiHi = Math.ceil(hi) + PAD_SEMITONES;
    // 音域太窄時撐開一點，不然音符條會胖得很奇怪
    if (this.midiHi - this.midiLo < 18) {
      const mid = (this.midiHi + this.midiLo) / 2;
      this.midiLo = Math.round(mid - 9);
      this.midiHi = Math.round(mid + 9);
    }
  }

  snapshot() {
    this.history.push(JSON.stringify(this.notes));
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future = [];
  }

  undo() {
    if (!this.history.length) return;
    this.future.push(JSON.stringify(this.notes));
    this.notes = JSON.parse(this.history.pop());
    this.selected.clear();
    this.commit(false);
  }

  redo() {
    if (!this.future.length) return;
    this.history.push(JSON.stringify(this.notes));
    this.notes = JSON.parse(this.future.pop());
    this.selected.clear();
    this.commit(false);
  }

  /** 整理並通知外面。sort 保證 note 依時間排序，下游都靠這個前提。 */
  commit(record = true) {
    if (record) this.snapshot();
    // 排序會讓索引失效，所以先記住選取的是哪幾個「物件」再重新定位
    const picked = this.selectedNotes();
    this.notes.sort((a, b) => a.startMs - b.startMs);
    this.selected = new Set(picked.map((n) => this.notes.indexOf(n)).filter((i) => i >= 0));
    this.draw();
    this.onChange(this.notes);
    // 音高／長度改過之後標示要跟著更新，否則會停在編輯前的值
    this.onSelect(this.selectedNotes()[0] || null);
  }

  // -- 編輯動作（給按鈕與快捷鍵用）-----------------------------------------

  selectedNotes() {
    return [...this.selected].map((i) => this.notes[i]).filter(Boolean);
  }

  shiftPitch(semitones) {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    this.snapshot();
    // round 而不是直接加：舊資料可能帶著小數（量化是後來才加的），
    // 只做加法會把小數一路帶下去
    for (const n of sel) {
      n.midi = Math.max(0, Math.min(127, Math.round(n.midi + semitones)));
    }
    this.commit(false);
  }

  stretch(deltaMs, edge = 'end') {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    this.snapshot();
    for (const n of sel) {
      if (edge === 'end') n.endMs = Math.max(n.startMs + MIN_NOTE_MS, n.endMs + deltaMs);
      else n.startMs = Math.min(n.endMs - MIN_NOTE_MS, n.startMs + deltaMs);
    }
    this.commit(false);
  }

  nudgeTime(deltaMs) {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    this.snapshot();
    for (const n of sel) {
      n.startMs = Math.max(0, n.startMs + deltaMs);
      n.endMs = Math.max(n.startMs + MIN_NOTE_MS, n.endMs + deltaMs);
    }
    this.commit(false);
  }

  deleteSelected() {
    if (!this.selected.size) return;
    this.snapshot();
    const keep = this.notes.filter((_, i) => !this.selected.has(i));
    this.notes = keep;
    this.selected.clear();
    this.onSelect(null);
    this.commit(false);
  }

  /** 在游標處新增一個音。長度取鄰近音的中位數，比固定值自然。 */
  addNoteAt(ms, midi) {
    this.snapshot();
    const durs = this.notes.map((n) => n.endMs - n.startMs).sort((a, b) => a - b);
    const dur = durs.length ? durs[durs.length >> 1] : 300;
    const note = {
      startMs: Math.max(0, Math.round(ms)),
      endMs: Math.max(0, Math.round(ms)) + Math.max(MIN_NOTE_MS, Math.round(dur)),
      midi: Math.round(midi),
    };
    this.notes.push(note);
    this.commit(false);
    this.selected = new Set([this.notes.indexOf(note)]);
    this.onSelect(note);
    this.draw();
  }

  selectAll() {
    this.selected = new Set(this.notes.map((_, i) => i));
    this.draw();
  }

  // -- 座標換算 -----------------------------------------------------------

  metrics() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const rollH = Math.max(1, h - RULER_H);   // 音符區＝扣掉上方時間尺
    return { dpr, w, h, rollH, rowH: rollH / (this.midiHi - this.midiLo + 1) };
  }

  xOf(ms) { return (ms - this.scrollMs) * this.pxPerMs; }

  msOf(x) { return Math.max(0, this.scrollMs + x / this.pxPerMs); }

  yOf(midi) {
    const { rollH, rowH } = this.metrics();
    return RULER_H + rollH - (midi - this.midiLo + 0.5) * rowH;
  }

  midiOf(y) {
    const { rollH, rowH } = this.metrics();
    return this.midiLo + (RULER_H + rollH - y) / rowH - 0.5;
  }

  noteAt(x, y) {
    const { rowH } = this.metrics();
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      const x0 = this.xOf(n.startMs);
      const x1 = this.xOf(n.endMs);
      const cy = this.yOf(n.midi);
      if (x >= x0 - 2 && x <= x1 + 2 && Math.abs(y - cy) <= rowH * 0.55) {
        const edge = x <= x0 + EDGE_PX ? 'start' : x >= x1 - EDGE_PX ? 'end' : null;
        return { index: i, note: n, edge };
      }
    }
    return null;
  }

  /** 讓某個時間點落在可視範圍內（播放時跟隨播放頭用）。 */
  scrollTo(ms, ratio = 0.35) {
    const { w } = this.metrics();
    this.scrollMs = Math.max(0, ms - (w * ratio) / this.pxPerMs);
  }

  /** 拖時間尺／抓播放頭時呼叫：先把線畫到新位置，再交給外面真的去 seek。 */
  seekTo(ms) {
    const clamped = Math.max(0, this.durationMs ? Math.min(this.durationMs, ms) : ms);
    this.playheadMs = clamped;
    this.draw();
    this.onSeek(clamped);
  }

  /**
   * 指標拖到畫布邊緣以外時，讓時間軸自動往那個方向捲，指標不動也繼續捲——
   * 這是拖曳類編輯器的標準行為，不然拖到邊界就卡住，看不到後面的音符。
   *
   * x 是指標相對畫布左緣的座標，拖出範圍時可能是負值或大於 w（pointer
   * capture 之下瀏覽器仍會回報畫布外的座標，不需要另外用 document 監聽）。
   */
  updateAutoScroll(x) {
    const { w } = this.metrics();
    const margin = 48;
    let overshoot = 0;
    if (x < margin) overshoot = x - margin;         // 負值＝往左捲
    else if (x > w - margin) overshoot = x - (w - margin);   // 正值＝往右捲

    if (!overshoot) {
      this.stopAutoScroll();
      return;
    }
    // 超出邊緣愈多捲愈快，但設個上限，滑鼠飛到螢幕外不該瞬間捲到天邊
    const pxPerSec = Math.sign(overshoot) * Math.min(1600, 250 + Math.abs(overshoot) * 5);
    this.autoScrollMsPerSec = pxPerSec / this.pxPerMs;
    this.startAutoScroll();
  }

  startAutoScroll() {
    if (this.autoScrollRAF) return;
    let last = performance.now();
    const step = (t) => {
      if (this.drag?.mode !== 'seek') { this.autoScrollRAF = null; return; }
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      this.scrollMs = Math.max(0, this.scrollMs + this.autoScrollMsPerSec * dt);
      // 畫面捲動了，播放頭要跟著指標目前的位置重新換算，不能停在原本的 ms
      this.seekTo(this.msOf(Math.max(0, Math.min(this.metrics().w, this.drag.x))));
      this.autoScrollRAF = requestAnimationFrame(step);
    };
    this.autoScrollRAF = requestAnimationFrame(step);
  }

  stopAutoScroll() {
    if (this.autoScrollRAF) {
      cancelAnimationFrame(this.autoScrollRAF);
      this.autoScrollRAF = null;
    }
  }

  setPlayhead(ms, follow = false) {
    this.playheadMs = ms;
    if (follow) {
      const { w } = this.metrics();
      const x = this.xOf(ms);
      if (x < w * 0.1 || x > w * 0.75) this.scrollTo(ms);
    }
    this.draw();
  }

  // -- 繪製 ---------------------------------------------------------------

  draw() {
    const { dpr, w, h, rowH } = this.metrics();
    const c = this.canvas;
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 鍵盤底色：黑鍵那幾列畫深一點，看得出調性位置
    for (let m = this.midiLo; m <= this.midiHi; m++) {
      const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      ctx.fillStyle = black ? 'rgba(255,255,255,0.028)' : 'rgba(255,255,255,0.055)';
      ctx.fillRect(0, this.yOf(m) - rowH / 2, w, rowH);
      if (((m % 12) + 12) % 12 === 0) {
        ctx.strokeStyle = 'rgba(0,229,255,0.22)';
        ctx.beginPath();
        ctx.moveTo(0, this.yOf(m) + rowH / 2);
        ctx.lineTo(w, this.yOf(m) + rowH / 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(0,229,255,0.5)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(midiToName(m), 4, this.yOf(m) - 2);
      }
    }

    // 時間格線
    const fromMs = this.msOf(0);
    const toMs = this.msOf(w);
    const stepMs = this.pxPerMs > 0.25 ? 500 : this.pxPerMs > 0.1 ? 1000 : 5000;
    for (let t = Math.floor(fromMs / stepMs) * stepMs; t <= toMs; t += stepMs) {
      if (t < 0) continue;
      const x = this.xOf(t);
      const major = t % (stepMs * 2) === 0;
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // 上方時間尺（可拖曳跳轉）
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(w, RULER_H + 0.5);
    ctx.stroke();
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let t = Math.floor(fromMs / stepMs) * stepMs; t <= toMs; t += stepMs) {
      if (t < 0) continue;
      const x = this.xOf(t);
      const major = t % (stepMs * 2) === 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(x, major ? RULER_H - 8 : RULER_H - 4);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        const sec = t / 1000;
        ctx.fillText(`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`,
          x, 10);
      }
    }

    // 音符
    const barH = Math.max(4, rowH * 0.72);
    this.notes.forEach((n, i) => {
      const x0 = this.xOf(n.startMs);
      const x1 = this.xOf(n.endMs);
      if (x1 < -20 || x0 > w + 20) return;
      const y = this.yOf(n.midi) - barH / 2;
      const sel = this.selected.has(i);
      ctx.fillStyle = sel ? 'rgba(255,209,102,0.85)' : 'rgba(0,229,255,0.42)';
      ctx.fillRect(x0, y, Math.max(2, x1 - x0), barH);
      ctx.strokeStyle = sel ? 'rgba(255,209,102,1)' : 'rgba(0,229,255,0.85)';
      ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(2, x1 - x0) - 1, barH - 1);
    });

    // 播放頭：線 + 尺上的把手，讓人看得出這東西可以抓
    const px = this.xOf(this.playheadMs);
    if (px >= -8 && px <= w + 8) {
      ctx.strokeStyle = this.drag?.mode === 'seek'
        ? 'rgba(255,209,102,1)' : 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();

      ctx.fillStyle = this.drag?.mode === 'seek'
        ? 'rgba(255,209,102,1)' : 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(px - 6, RULER_H - 9);
      ctx.lineTo(px + 6, RULER_H - 9);
      ctx.lineTo(px, RULER_H - 1);
      ctx.closePath();
      ctx.fill();
    }
  }

  // -- 操作 ---------------------------------------------------------------

  bind() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    c.addEventListener('pointerdown', (e) => {
      const { x, y } = pos(e);
      // 沒抓到指標也要能繼續編輯（某些觸控／模擬事件會拒絕 capture）
      try { c.setPointerCapture(e.pointerId); } catch { /* 不影響後續 */ }

      // 時間尺上，或直接抓住播放頭那條線 → 跳轉
      if (y <= RULER_H || Math.abs(x - this.xOf(this.playheadMs)) <= PLAYHEAD_GRAB_PX) {
        this.drag = { mode: 'seek', x };
        this.seekTo(this.msOf(x));
        return;
      }

      const hit = this.noteAt(x, y);

      if (!hit) {
        // 空白處：alt/雙擊新增，否則框選
        if (e.altKey) {
          this.addNoteAt(this.msOf(x), this.midiOf(y));
          return;
        }
        if (!e.shiftKey) { this.selected.clear(); this.onSelect(null); }
        this.drag = { mode: 'marquee', x0: x, y0: y, x1: x, y1: y };
        this.draw();
        return;
      }

      if (e.shiftKey) this.selected.add(hit.index);
      else if (!this.selected.has(hit.index)) this.selected = new Set([hit.index]);
      this.onSelect(hit.note);

      this.snapshot();
      this.drag = {
        mode: hit.edge ? `resize-${hit.edge}` : 'move',
        startX: x,
        startY: y,
        // 記下起始狀態，拖曳時一律以「原始值 + 位移」計算，避免累積誤差
        origin: this.selectedNotes().map((n) => ({ n, ...n })),
      };
      this.draw();
    });

    c.addEventListener('pointermove', (e) => {
      const { x, y } = pos(e);
      if (!this.drag) {
        const onRuler = y <= RULER_H
          || Math.abs(x - this.xOf(this.playheadMs)) <= PLAYHEAD_GRAB_PX;
        const hit = onRuler ? null : this.noteAt(x, y);
        c.style.cursor = onRuler ? 'ew-resize'
          : !hit ? 'crosshair' : hit.edge ? 'ew-resize' : 'move';
        return;
      }
      if (this.drag.mode === 'seek') {
        this.drag.x = x;
        // clamp 過的座標才拿來換算時間；原始 x 留給 updateAutoScroll 判斷
        // 有沒有拖出邊界，兩者不能共用同一個值
        this.seekTo(this.msOf(Math.max(0, Math.min(this.metrics().w, x))));
        this.updateAutoScroll(x);
        return;
      }
      if (this.drag.mode === 'marquee') {
        this.drag.x1 = x;
        this.drag.y1 = y;
        this.applyMarquee();
        return;
      }

      const dMs = (x - this.drag.startX) / this.pxPerMs;
      const dMidi = Math.round(this.midiOf(y) - this.midiOf(this.drag.startY));
      for (const o of this.drag.origin) {
        if (this.drag.mode === 'move') {
          o.n.startMs = Math.max(0, o.startMs + dMs);
          o.n.endMs = o.n.startMs + (o.endMs - o.startMs);
          o.n.midi = Math.max(0, Math.min(127, Math.round(o.midi + dMidi)));
        } else if (this.drag.mode === 'resize-end') {
          o.n.endMs = Math.max(o.startMs + MIN_NOTE_MS, o.endMs + dMs);
        } else {
          o.n.startMs = Math.min(o.endMs - MIN_NOTE_MS, Math.max(0, o.startMs + dMs));
        }
      }
      this.draw();
    });

    const endDrag = (e) => {
      if (!this.drag) return;
      const wasEdit = this.drag.mode !== 'marquee' && this.drag.mode !== 'seek';
      this.stopAutoScroll();
      this.drag = null;
      try { c.releasePointerCapture(e.pointerId); } catch { /* 已釋放 */ }
      // 拖曳過程已經改了資料，這裡只要排序＋通知；snapshot 在 pointerdown 就存了
      if (wasEdit) this.commit(false);
      else this.draw();
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);

    c.addEventListener('dblclick', (e) => {
      const { x, y } = pos(e);
      if (y <= RULER_H) return;
      if (!this.noteAt(x, y)) this.addNoteAt(this.msOf(x), this.midiOf(y));
    });

    // 滾輪：橫向捲動；按住 Ctrl/⌘ 縮放
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const { x } = pos(e);
        const anchorMs = this.msOf(x);
        this.pxPerMs = Math.max(0.02, Math.min(2, this.pxPerMs * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        this.scrollMs = anchorMs - x / this.pxPerMs;
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.scrollMs += d / this.pxPerMs;
      }
      this.scrollMs = Math.max(0, this.scrollMs);
      this.draw();
    }, { passive: false });
  }

  applyMarquee() {
    const { x0, y0, x1, y1 } = this.drag;
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bot = Math.max(y0, y1);
    this.selected.clear();
    this.notes.forEach((n, i) => {
      const nx0 = this.xOf(n.startMs);
      const nx1 = this.xOf(n.endMs);
      const ny = this.yOf(n.midi);
      if (nx1 >= lo && nx0 <= hi && ny >= top && ny <= bot) this.selected.add(i);
    });
    this.draw();
  }
}
