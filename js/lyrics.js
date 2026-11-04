// lyrics.js — 演唱畫面的 KTV 歌詞（兩行：目前這句大字、下一句小字）。
//
// 歌詞資料來自伺服器的 lyrics.json（lyrics.py 產生），每句有句時間，
// 多數還有逐字時間 ct（Enhanced LRC 或酷狗／網易雲對齊過來的）。
// 沒有逐字時間的句子，用參考譜的音符估算：每個音節分到幾個音、
// 從那幾個音的起訖決定什麼時候上色——比單純依字數平分準得多，
// 因為長音、拖拍、句中換氣都已經在譜裡了。
//
// 日文另有振假名（ruby）與羅馬拼音，可在設定裡開關。

const SMALL_KANA = new Set('ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ');
const isKana = (c) => (c >= 'ぁ' && c <= 'ゟ') || (c >= 'ァ' && c <= 'ヿ');
const isKanji = (c) => (c >= '一' && c <= '鿿') || (c >= '㐀' && c <= '䶿') || '々〆ヶ〇'.includes(c);
const isHangul = (c) => c >= '가' && c <= '힣';
const isLatin = (c) => /[a-zA-ZÀ-ɏ]/.test(c);

/** 假名讀音的拍數（小寫假名不算一拍）。 */
function moraCount(reading) {
  let n = 0;
  for (const c of reading || '') if (!SMALL_KANA.has(c)) n++;
  return Math.max(1, n);
}

/**
 * 每個字元的「音節權重」：唱的時候大概佔幾個音。
 * 漢字有振假名時依讀音拍數（「明日」＝あ・し・た 三拍），中文一字一拍，
 * 英文依母音群算音節數再分給該單字的字母，標點空白是 0。
 */
function charWeights(line) {
  const text = line.text;
  const w = new Array(text.length).fill(0);
  // 振假名：漢字段的拍數平分給段裡的字
  const rubyW = new Map();
  if (line.ruby) {
    let pos = 0;
    for (const [seg, reading] of line.ruby) {
      if (reading) {
        const per = moraCount(reading) / seg.length;
        for (let k = 0; k < seg.length; k++) rubyW.set(pos + k, per);
      }
      pos += seg.length;
    }
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (rubyW.has(i)) w[i] = rubyW.get(i);
    else if (SMALL_KANA.has(c)) w[i] = 0.15;
    else if (isKana(c) || isKanji(c) || isHangul(c) || /[0-9]/.test(c)) w[i] = 1;
  }
  // 英文：一個單字的音節數 ≈ 母音群數
  const re = /[a-zA-ZÀ-ɏ']+/g;
  let m;
  while ((m = re.exec(text))) {
    const word = m[0];
    const syll = Math.max(1, (word.toLowerCase().replace(/e$/, '').match(/[aeiouy]+/g) || []).length);
    const letters = [...word].filter(isLatin).length || 1;
    for (let k = 0; k < word.length; k++) {
      if (isLatin(word[k])) w[m.index + k] = syll / letters;
    }
  }
  return w;
}

/**
 * 用參考譜的音符估一句的逐字時間，回傳 [s0, e0, s1, e1, …]。
 * 時間都已經是「音訊時間」（套過歌詞位移）。
 */
export function estimateCharTimes(line, notes, nextStart) {
  const text = line.text;
  const weights = charWeights(line);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!text.length || total <= 0) return null;

  const from = line.s - 250;
  const to = Math.min(nextStart ?? Infinity, (line.e ?? Infinity) + 600) - 80;
  const inLine = notes.filter((n) => n.startMs >= from && n.startMs < to);

  let at;
  if (inLine.length) {
    // 第 c 拍落在第 c/total*N 個音上，音內依比例
    const N = inLine.length;
    at = (c) => {
      const p = (c / total) * N;
      const j = Math.min(N - 1, Math.floor(p));
      const n = inLine[j];
      return n.startMs + Math.min(1, p - j) * (n.endMs - n.startMs);
    };
  } else {
    // 譜上這句沒有音（抽譜漏掉）：一拍 300ms，最長到句尾
    const span = Math.min(Math.max(400, (line.e ?? line.s + total * 300) - line.s), total * 300);
    at = (c) => line.s + (c / total) * span;
  }
  const out = [];
  let cum = 0;
  for (let i = 0; i < text.length; i++) {
    const s = at(cum);
    cum += weights[i];
    out.push(s, weights[i] > 0 ? at(cum) : s);
  }
  return out;
}

/** lyrics.json → 播放用的句子（套上整首位移、補齊逐字時間）。 */
export function prepareLines(data, notes = []) {
  if (!data?.lines?.length) return [];
  const off = Number(data.offsetMs) || 0;
  const synced = data.synced !== false && data.lines.some((l) => l.s != null);
  const lines = data.lines.map((l) => ({
    text: l.text || '',
    ruby: l.ruby || null,
    romaji: l.romaji || '',
    s: l.s != null ? l.s + off : null,
    e: l.e != null ? l.e + off : null,
    ct: l.ct ? l.ct.map((t) => t + off) : null,
    estimated: false,
  }));
  if (!synced) return lines;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.ct || l.s == null || !l.text.trim()) continue;
    l.ct = estimateCharTimes(l, notes, lines[i + 1]?.s);
    l.estimated = !!l.ct;
  }
  return lines;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const isInterlude = (text) => !text.replace(/[\s♪♫♬・…~～]/g, '');

export class LyricsView {
  /**
   * @param root 放歌詞的容器
   * @param opts { ruby, romaji, karaoke } 顯示選項
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = { ruby: true, romaji: true, karaoke: true, ...opts };
    this.lines = [];
    this.synced = true;
    this.bigIdx = -2;
    this.root.classList.add('lyrics-view');
    this.root.innerHTML = '';
  }

  setOptions(opts) {
    this.opts = { ...this.opts, ...opts };
    this.bigIdx = -2;   // 下次 update 重建
    if (!this.synced) this.renderPlain();
  }

  /** data 為 lyrics.json（或 null＝沒有歌詞）；notes 是參考譜（估逐字時間用）。 */
  setLyrics(data, notes = [], emptyText = '') {
    this.data = data;
    this.lines = prepareLines(data, notes);
    this.synced = !!data && data.synced !== false && this.lines.some((l) => l.s != null);
    this.bigIdx = -2;
    this.cursor = 0;
    this.root.classList.toggle('empty', !this.lines.length);
    if (!this.lines.length) {
      this.root.innerHTML = emptyText ? `<div class="lyr-empty">${escapeHtml(emptyText)}</div>` : '';
    } else if (!this.synced) {
      this.renderPlain();
    }
  }

  /** 沒有時間軸的歌詞：整首列出來讓人自己看。 */
  renderPlain() {
    this.root.innerHTML = `<div class="lyr-plain">${this.lines.map((l) =>
      `<div>${this.lineHtml(l, false) || '&nbsp;'}</div>`).join('')}</div>
      <div class="lyr-note">這份歌詞沒有時間軸，不會跟著捲動</div>`;
  }

  /** 一句的 HTML：每個字一個 span（逐字上色用），漢字段包成 ruby。 */
  lineHtml(line, withChars) {
    const text = line.text;
    const showRuby = this.opts.ruby && line.ruby;
    const segs = showRuby ? line.ruby : [[text, null]];
    let pos = 0;
    let html = '';
    for (const [seg, reading] of segs) {
      let inner = '';
      for (let k = 0; k < seg.length; k++) {
        const ch = escapeHtml(seg[k]);
        inner += withChars ? `<span class="ch" data-i="${pos + k}">${ch}</span>` : ch;
      }
      html += reading
        ? `<ruby data-a="${pos}" data-b="${pos + seg.length}">${inner}<rt>${escapeHtml(reading)}</rt></ruby>`
        : inner;
      pos += seg.length;
    }
    return html;
  }

  /** 目前該大字顯示哪一句：已開始的最後一句；它唱完了而下一句快來了就先秀下一句。 */
  pickIndex(t) {
    const lines = this.lines;
    let i = Math.min(this.cursor || 0, lines.length - 1);
    while (i > 0 && (lines[i].s ?? 0) > t) i--;
    while (i + 1 < lines.length && (lines[i + 1].s ?? Infinity) <= t) i++;
    this.cursor = i;
    if ((lines[0].s ?? 0) > t) return 0;
    const cur = lines[i];
    const next = lines[i + 1];
    const end = cur.ct ? cur.ct[cur.ct.length - 1] : (cur.e ?? cur.s + 4000);
    if (next && (t > end + 400 || isInterlude(cur.text))) return i + 1;
    return i;
  }

  update(t) {
    if (!this.synced || !this.lines.length) return;
    const idx = this.pickIndex(t);
    if (idx !== this.bigIdx) this.build(idx);
    const line = this.lines[idx];
    if (!line || !this.chars) return;

    const active = t >= (line.s ?? 0) - 50;
    this.bigEl.classList.toggle('active', active);
    if (!this.opts.karaoke || !line.ct) {
      if (this.wipeMode) { for (const c of this.chars) c.el.style.removeProperty('--p'); this.wipeMode = false; }
      return;
    }
    this.wipeMode = true;
    for (const c of this.chars) {
      const p = c.e <= c.s ? (t >= c.s ? 1 : 0) : Math.min(1, Math.max(0, (t - c.s) / (c.e - c.s)));
      if (p !== c.p) {
        c.p = p;
        c.el.style.setProperty('--p', `${(p * 100).toFixed(1)}%`);
      }
    }
    for (const r of this.rubies) {
      const sung = t >= r.s;
      if (sung !== r.sung) { r.sung = sung; r.el.classList.toggle('sung', sung); }
    }
  }

  build(idx) {
    this.bigIdx = idx;
    const line = this.lines[idx];
    const next = this.lines[idx + 1];
    const romaji = (l) => (this.opts.romaji && l?.romaji ? `<div class="lyr-romaji">${escapeHtml(l.romaji)}</div>` : '');
    const interlude = (l) => isInterlude(l.text);
    this.root.innerHTML = `
      <div class="lyr-line big${this.opts.karaoke && line.ct ? ' wipe' : ''}${interlude(line) ? ' interlude' : ''}">
        <div class="lyr-text">${interlude(line) ? '♪' : this.lineHtml(line, true)}</div>${romaji(line)}
      </div>
      <div class="lyr-line next">${next ? `<div class="lyr-text">${interlude(next) ? '♪' : this.lineHtml(next, false)}</div>${romaji(next)}` : ''}</div>`;
    this.bigEl = this.root.querySelector('.lyr-line.big');
    this.chars = [];
    this.rubies = [];
    if (line.ct) {
      for (const el of this.bigEl.querySelectorAll('.ch')) {
        const i = Number(el.dataset.i);
        this.chars.push({ el, s: line.ct[i * 2], e: line.ct[i * 2 + 1], p: -1 });
      }
      for (const el of this.bigEl.querySelectorAll('ruby')) {
        this.rubies.push({ el, s: line.ct[Number(el.dataset.a) * 2], sung: null });
      }
    }
  }
}

/** 給 UI 顯示的來源說明。 */
export function describeLyrics(data) {
  if (!data) return '還沒有歌詞';
  if (!data.lines?.length) return '找不到歌詞';
  const parts = [data.source || '歌詞'];
  if (data.synced === false) parts.push('沒有時間軸');
  else if (data.wordTiming) parts.push(`逐字時間：${data.wordTiming}`);
  else parts.push('逐字時間依譜面估算');
  if (data.japanese) parts.push('含振假名');
  return parts.join('・');
}
