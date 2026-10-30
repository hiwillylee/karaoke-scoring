// score.js — 精密採點評分引擎。
//
// 五個面向：音程（60%）、節奏（15%）、安定性（15%）、技巧（10%），
// 另外獨立回報完唱度。未唱到的參考音框直接以 0 分計入音程，因此漏唱
// 會確實反映在總分上。
//
// 男女音域不同不應該扣分，所以評分前先做全域八度對齊。

import { framesToNotes, prepareFrames } from './dsp.js';
import { detectTechniques, PARAMS, TECHNIQUE_LABELS } from './techniques.js';
import { expandFrames } from './chart.js';

const OCTAVE_CANDIDATES = [-24, -12, 0, 12, 24];

// 要選八度，得先有這麼多「使用者真的唱出聲」的音框（約 0.6 秒）。
//
// 關鍵是不能拿 liveCount 當條件：參考譜有音但使用者還沒開口時它照樣會增加，
// 而 liveSum 全是 0。這時候 argmax 會挑到候選清單的第一個（-24），畫面上的
// 軌跡就整條被畫到低兩個八度去，而且 displayOctave() 的遲滯還會把這個錯誤
// 鎖住，要累積夠多分數才慢慢一階一階爬回來。
const OCTAVE_MIN_VOICED = 40;
// note 邊界往內縮多少才敢採信。延遲校準有誤差、使用者又會搶拍拖拍，
// 轉音與 note 交界處差個一兩格就差好幾個半音，那裡的參考音不能信。
const OCTAVE_HINT_EDGE_MS = 60;
// 參考音高曲線的平滑窗。要濾掉原唱的顫音（4–7Hz）但留住滑音，
// 不然評分基準會跟著原唱一起抖，變成要求使用者複製顫音的每一個週期。
const REF_SMOOTH_MS = 120;

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * |Δ| ≤ perfect 得滿分，到 zero 歸零，中間以 curve 次方衰減。
 *
 * curve = 1（線性）是分數膨脹的主因：差半個半音是聽得出來的走音，線性
 * 卻還給它一半的分。一整首歌平均下來，唱得準的跟只是「大概對」的都會
 * 落在九十幾分，原唱自己來唱也高不了幾分。curve > 1 把中間地帶壓下去，
 * 滿分區只留給真的咬準的音。
 */
function tolerance(diff, perfect, zero, curve = 1) {
  const d = Math.abs(diff);
  if (d <= perfect) return 1;
  if (d >= zero) return 0;
  const x = 1 - (d - perfect) / (zero - perfect);
  return curve === 1 ? x : Math.pow(x, curve);
}

function movingAverage(values, window) {
  const n = values.length;
  const out = new Float64Array(n);
  const half = Math.max(1, window >> 1);
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      sum += values[j]; count++;
    }
    out[i] = sum / count;
  }
  return out;
}

function stdev(values) {
  if (values.length < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  let acc = 0;
  for (const v of values) acc += (v - mean) ** 2;
  return Math.sqrt(acc / values.length);
}

export class LiveScorer {
  /**
   * @param {object} chart 參考譜（已含 notes / frames）
   * @param {object} opts  { keyShift }
   */
  constructor(chart, opts = {}) {
    this.chart = chart;
    this.hopMs = chart.hopMs;
    this.keyShift = opts.keyShift || 0;
    // rebuildChart 已經把八度修正與逐幀編輯套進去了，優先用它的結果；
    // 沒有的話（測試、舊資料）才自己展開原始音框。
    this.refFrames = chart.refFrames || expandFrames(chart);
    this.refNotes = chart.notes;
    this.minConf = PARAMS.pitch.minConfidence;

    // 參考譜上「有音」的音框（分母）
    this.refVoicedBins = new Set();
    for (const note of this.refNotes) {
      const i0 = Math.round(note.startMs / this.hopMs);
      const i1 = Math.round(note.endMs / this.hopMs);
      for (let i = i0; i <= i1; i++) this.refVoicedBins.add(i);
    }
    this.refNoteByBin = new Map();
    this.refNotes.forEach((note, idx) => {
      const i0 = Math.round(note.startMs / this.hopMs);
      const i1 = Math.round(note.endMs / this.hopMs);
      for (let i = i0; i <= i1; i++) this.refNoteByBin.set(i, idx);
    });
    this.refTargetByBin = new Map();
    this.buildRefTargets();

    this.userFrames = [];
    this.userByBin = new Map();
    // 結算時才建立：前處理（音量門檻＋八度跳躍修正）過的音框索引
    this.scoredByBin = null;
    // 演唱中可以換 key，因此記下每次變更的時間點
    this.shiftEvents = [{ songMs: -Infinity, shift: this.keyShift }];

    // 即時分數：五種八度位移各自累積，取當下最好的那個
    this.liveSum = OCTAVE_CANDIDATES.map(() => 0);
    this.liveCount = 0;
    // liveCount 是即時分數的分母（沒唱到要算漏唱），liveVoiced 才是「真的
    // 唱了幾框」。選八度只能看後者，見 OCTAVE_MIN_VOICED 的說明。
    this.liveVoiced = 0;
    this.lastBin = -1;
    // 畫面用的八度位移，帶遲滯，見 displayOctave()
    this.displayOct = null;
  }

  /**
   * 每個音框的評分基準 = 原唱在那一刻實際唱的音高（平滑後）。
   *
   * 以前是拿 note.midi 當基準，但那是量化到整數半音的「標籤」——原唱實際
   * 唱的是 62.76 這種值。實測三首歌，原唱自己的音框有 17–30% 偏離所屬
   * note 超過 30 cents，也就是說把原唱的錄音原封不動餵回來，音程也只有
   * 85–94 分。扣掉的是切段時的量化誤差，跟唱得準不準無關。
   *
   * 只在 note.midi ± refTargetMaxOffsetCents 之內採信音框：人工編輯過音高、
   * 或抽取時就有八度誤判的地方，音框與 note 會對不起來，那時要以 note 為準。
   */
  buildRefTargets() {
    const maxOff = (PARAMS.scoring.refTargetMaxOffsetCents ?? 100) / 100;
    const half = Math.max(1, Math.round(REF_SMOOTH_MS / this.hopMs) >> 1);
    for (const note of this.refNotes) {
      const i0 = Math.round(note.startMs / this.hopMs);
      const i1 = Math.round(note.endMs / this.hopMs);
      for (let i = i0; i <= i1; i++) {
        let sum = 0, count = 0;
        // 平滑窗不跨越 note 邊界，否則交界處的基準會被隔壁的音拉走
        for (let j = Math.max(i0, i - half); j <= Math.min(i1, i + half); j++) {
          const f = this.refFrames[j];
          if (f && f.midi > 0) { sum += f.midi; count++; }
        }
        // 參考譜這一框沒抽到音高（氣音、被伴奏蓋掉）就退回量化值
        const raw = count ? sum / count : note.midi;
        this.refTargetByBin.set(
          i, Math.max(note.midi - maxOff, Math.min(note.midi + maxOff, raw)));
      }
    }
  }

  /** 某個音框的評分基準，已含當下生效的升降調。 */
  targetAt(bin, songMs) {
    const base = this.refTargetByBin.get(bin);
    if (base !== undefined) return base + this.shiftAt(songMs);
    const idx = this.refNoteByBin.get(bin);
    return idx === undefined ? null : this.refNotes[idx].midi + this.shiftAt(songMs);
  }

  /**
   * 以參考音高當錨點，修掉殘留的八度誤判。
   *
   * dsp 的 fixOctaveJumps 是拿「前一框」當錨點，所以只要句子之間混進幾框
   * 伴奏漏音（用喇叭放伴奏時很常見），基準就被帶歪，後面真正的八度跳躍
   * 反而看起來不像跳躍而修不掉。實測光是這一項，殘留的八度誤判就從 2.7%
   * 變成 11.1%，安定性從 91 掉到 32。這裡改用參考譜當錨點——原唱那一刻
   * 唱什麼是已知的，不會被雜訊帶走。
   *
   * 只修「短暫」的偏離。整段唱低八度是使用者真的降 key 唱（唱不上去），
   * 那要照實扣分；全首都低八度則本來就有 bestOctave() 全域對齊在處理。
   */
  repairOctaves(frames, octave) {
    const maxMs = PARAMS.scoring.octaveRepairMaxMs;
    const TOL = 1.5;  // 半音；含抖動與滑音的餘裕
    const offsetAt = (f) => {
      if (!f.midi) return null;
      const target = this.targetAt(Math.round(f.t / this.hopMs), f.t);
      if (target === null) return null;
      const err = f.midi + octave - target;
      for (const o of [12, -12, 24, -24]) if (Math.abs(err - o) < TOL) return o;
      return 0;
    };
    let i = 0;
    while (i < frames.length) {
      const off = offsetAt(frames[i]);
      if (!off) { i += 1; continue; }
      // 這個八度偏離連續持續到哪裡
      let j = i + 1;
      while (j < frames.length && offsetAt(frames[j]) === off) j += 1;
      if (frames[j - 1].t - frames[i].t <= maxMs) {
        for (let k = i; k < j; k++) frames[k].midi -= off;
      }
      i = j;
    }
  }

  /** 演唱途中變更升降調。之後的音框會以新的基準計分。 */
  setKeyShift(semitones, songMs) {
    this.keyShift = semitones;
    this.shiftEvents.push({ songMs, shift: semitones });
  }

  /** 某個歌曲時間點當下生效的升降調。 */
  shiftAt(songMs) {
    let shift = this.shiftEvents[0].shift;
    for (const ev of this.shiftEvents) {
      if (ev.songMs <= songMs) shift = ev.shift;
      else break;
    }
    return shift;
  }

  /** 加入一個已做過延遲補償的麥克風音框。songMs 為歌曲時間。 */
  addFrame(frame) {
    const bin = Math.round(frame.songMs / this.hopMs);
    if (bin < 0) return;
    const voiced = frame.midi > 0 && frame.conf >= this.minConf;
    // rawMidi 是門檻前的偵測值。診斷收音問題時要看的正是「被信心門檻擋掉
    // 的那些框，偵測器本來抓到什麼」，只留 0 就沒得查了。
    const record = { bin, t: frame.songMs, midi: voiced ? frame.midi : 0,
      rawMidi: frame.midi, conf: frame.conf, rms: frame.rms };
    this.userFrames.push(record);
    if (voiced && !this.userByBin.has(bin)) this.userByBin.set(bin, record);

    // 即時分數：只在參考譜有音的位置累積
    if (bin !== this.lastBin && this.refVoicedBins.has(bin)) {
      this.lastBin = bin;
      const target = this.targetAt(bin, frame.songMs);
      OCTAVE_CANDIDATES.forEach((oct, i) => {
        if (!voiced) return;
        const cents = (frame.midi + oct - target) * 100;
        this.liveSum[i] += tolerance(
          cents, PARAMS.scoring.pitchPerfectCents, PARAMS.scoring.pitchZeroCents,
          PARAMS.scoring.pitchCurve);
      });
      this.liveCount += 1;
      if (voiced) this.liveVoiced += 1;
    }
  }

  /** 目前的即時分數（0–100），畫面上的跳動數字。 */
  get liveScore() {
    if (!this.liveCount) return 0;
    return Math.round((Math.max(...this.liveSum) / this.liveCount) * 100);
  }

  /** 目前這一刻唱得準不準：'high' | 'low' | 'good' | null */
  currentHint(songMs, octaveOffset = null) {
    const bin = Math.round(songMs / this.hopMs);
    const noteIdx = this.refNoteByBin.get(bin);
    if (noteIdx === undefined) return null;
    const user = this.userAt(bin);
    if (!user || !user.midi) return null;
    const oct = octaveOffset ?? this.bestOctave();
    const cents = (user.midi + oct - this.targetAt(bin, songMs)) * 100;
    if (Math.abs(cents) <= PARAMS.scoring.pitchPerfectCents) return 'good';
    return cents > 0 ? 'high' : 'low';
  }

  /**
   * 取某個音框位置的使用者音高。
   * 麥克風的取樣時點不會剛好落在譜面的音框格點上，因此允許 ±1 格
   * （約 16ms，遠低於聽感可辨的程度）；少了這層容忍，會有一成多的
   * 參考音框被誤判成「沒唱到」。
   */
  userAt(bin) {
    // 結算時用前處理過的索引（見 finish()）；演唱途中還沒有，就用原始的。
    const src = this.scoredByBin || this.userByBin;
    return src.get(bin) || src.get(bin - 1) || src.get(bin + 1) || null;
  }

  /** 分數最高的八度候選；平手時偏向「不位移」而不是清單的第一個。 */
  bestOctaveIdx() {
    let best = OCTAVE_CANDIDATES.indexOf(0);
    for (let i = 0; i < this.liveSum.length; i++) {
      if (this.liveSum[i] > this.liveSum[best]) best = i;
    }
    return best;
  }

  bestOctave() {
    // 使用者還沒真的唱出東西之前一律不位移，理由見 OCTAVE_MIN_VOICED。
    if (this.liveVoiced < OCTAVE_MIN_VOICED) return 0;
    return OCTAVE_CANDIDATES[this.bestOctaveIdx()];
  }

  /**
   * 給即時音高偵測的八度旁證：參考譜這一刻的音，換算到使用者自己的
   * 八度座標系。沒有可信參考時回傳 0。
   *
   * 座標系轉換是必要的——評分時是把使用者 +bestOctave() 去對參考譜，
   * 這裡反過來把參考譜 -bestOctave() 搬到使用者這邊。少了這一步，音域與
   * 原唱差一個八度的人每一框都會被推回原唱的八度。
   */
  octaveHint(songMs, phraseStart = false) {
    if (this.liveVoiced < OCTAVE_MIN_VOICED) return 0;
    const noteIdx = this.refNoteByBin.get(Math.round(songMs / this.hopMs));
    if (noteIdx === undefined) return 0;
    const note = this.refNotes[noteIdx];
    // 平常只採信長音的中段：邊界附近棄權的成本很低，反正麥克風端還有歷史
    // 可以判斷。但樂句第一框沒有歷史，棄權等於讓那一框隨機決定整句的八度，
    // 所以只要落在參考 note 內就採信——真正把關的是平滑器那邊「差超過
    // refMaxSemitones 就不表示意見」，對齊歪掉時它自己會棄權。
    const edge = phraseStart ? 0 : OCTAVE_HINT_EDGE_MS;
    if (songMs - note.startMs < edge) return 0;
    if (note.endMs - songMs < edge) return 0;
    return note.midi + this.shiftAt(songMs) - this.bestOctave();
  }

  /**
   * 畫面用的八度位移。與 bestOctave() 分開的原因是顯示需要「穩定」勝過
   * 「隨時最佳」——兩個候選分數接近時，argmax 可能在框與框之間來回換冠軍，
   * 每換一次新畫的軌跡就整段平移 12 半音，看起來就是音高在亂跳。
   * 這裡要求挑戰者明顯領先才換，換過之後也不會因為些微差距又翻回去。
   */
  displayOctave() {
    // 證據不足時先不要定案——一旦定了，下面的遲滯就會把它鎖住。
    if (this.liveVoiced < OCTAVE_MIN_VOICED) return this.displayOct ?? 0;
    const bestIdx = this.bestOctaveIdx();
    if (this.displayOct === null) {
      this.displayOct = OCTAVE_CANDIDATES[bestIdx];
      return this.displayOct;
    }
    const curIdx = OCTAVE_CANDIDATES.indexOf(this.displayOct);
    // 領先幅度要隨資料量成長，否則開頭幾框的雜訊就足以觸發切換。
    // 這裡也只能算有唱的框：沒開口的時間讓門檻愈墊愈高的話，真的要換八度
    // 時會換不動。
    const margin = Math.max(2, this.liveVoiced * 0.08);
    if (this.liveSum[bestIdx] > this.liveSum[curIdx] + margin) {
      this.displayOct = OCTAVE_CANDIDATES[bestIdx];
    }
    return this.displayOct;
  }

  // ---- 結算 ---------------------------------------------------------------

  finish() {
    const s = PARAMS.scoring;
    const octave = this.bestOctave();

    // --- 使用者音框的前處理 ---
    // 音量門檻 + 八度跳躍修正，跟參考譜與技巧偵測走的是同一套流程。
    //
    // 以前只有技巧／節奏那一支跑 prepareFrames，音程與安定性直接讀
    // addFrame 存下來的原始音框，只過了信心門檻。結果是麥克風的八度誤判
    // （用喇叭放伴奏時，偵測器很容易抓到低八度的貝斯或泛音）完全沒被修，
    // 而且對安定性是毀滅性的——一個長音裡跳一次八度，中心線的標準差就是
    // 1200 cents。實測只要 1.5% 的音框判錯八度，安定性就從 100 掉到 33、
    // 總分從 98 掉到 79。
    const cleaned = prepareFrames(
      this.userFrames
        .filter((f) => f.midi > 0)
        .map((f) => ({ t: f.t, midi: f.midi, conf: f.conf, rms: f.rms })),
      PARAMS.pitch);
    this.repairOctaves(cleaned, octave);
    // 依音框位置重新索引。麥克風約 10ms 一框、參考譜 16ms，會有多對一，
    // 取落在該格的第一框即可（userAt 另外還容忍 ±1 格）。
    this.scoredByBin = new Map();
    for (const f of cleaned) {
      if (!f.midi) continue;
      const b = Math.round(f.t / this.hopMs);
      if (!this.scoredByBin.has(b)) this.scoredByBin.set(b, f);
    }

    // --- 使用者的切段 ---
    // 節奏與技巧要的是「對齊到參考譜八度」之後的版本。整體平移不影響切段
    // 與技巧偵測（兩者看的都是相對變化），但 note.midi 要落在參考譜的座標
    // 系上，與原唱技巧位置比對時才對得起來。
    const userFramesForTech = cleaned.map(
      (f) => ({ ...f, midi: f.midi ? f.midi + octave : 0 }));
    userFramesForTech.prepared = true;
    const userNotes = framesToNotes(userFramesForTech, PARAMS.pitch);

    // --- 音程 ---
    // 完唱度看的是全部參考音框，音程只看「換音穩定之後」的音框：兩者
    // 分母不同，所以分開累計。
    let pitchSum = 0;
    let pitchDenom = 0;
    let sungBins = 0;
    let compDenom = 0;
    for (const bin of this.refVoicedBins) {
      const note = this.refNotes[this.refNoteByBin.get(bin)];
      const user = this.userAt(bin);
      compDenom += 1;
      if (user && user.midi) sungBins += 1;
      // 換音的頭幾框不計分。延遲校準本來就有誤差，人聲又是滑進去的，
      // 那幾框的音高不代表唱得準不準。pitchPerfectCents 收緊之後如果不
      // 擋掉，扣掉的分數大半是機器的帳而不是使用者的。
      const guard = Math.min(s.pitchOnsetGuardMs, (note.endMs - note.startMs) * 0.3);
      if (bin * this.hopMs - note.startMs < guard) continue;
      pitchDenom += 1;
      if (!user || !user.midi) continue;  // 沒唱到＝0 分，計入分母
      const cents = (user.midi + octave - this.targetAt(bin, note.startMs)) * 100;
      pitchSum += tolerance(cents, s.pitchPerfectCents, s.pitchZeroCents, s.pitchCurve);
    }
    const pitch = pitchDenom ? pitchSum / pitchDenom : 0;
    const completion = compDenom ? sungBins / compDenom : 0;

    // --- 節奏 ---
    // 起音要取「每一個唱出來的音」的起點。只認靜音後的第一個音框的話，
    // 一口氣唱完的樂句整段只會產生一個起音，句中的換音全部對不到參考音，
    // 就算完全照譜唱節奏也只有五十幾分。
    //
    // 配對刻意是「多對一」的：同一個使用者起音可以被好幾個參考音認領。
    // 一對一看似比較嚴謹，實際上是錯的——參考譜與使用者的切段是兩次獨立
    // 的切段，本來就不會一一對應（實測參考譜自己抽到的音高有 38% 根本沒
    // 被切成 note）。強制一對一時，數量少的一邊會有一批參考音配不到東西
    // 各記 0 分：實測真實演唱有 19% 的參考音因此掛零，把原唱自己的音框
    // 餵回去也只剩 70 分。多對一的上限才是 100。
    //
    // 代價是「密集亂唱」能騙到節奏分。實測那種唱法總分 26–33（音程只有
    // 12），多拿到的幾分不影響結論，比起真的照譜唱卻被扣 10 分划算。
    const userOnsets = userNotes.map((n) => n.startMs);
    let rhythmSum = 0;
    for (const note of this.refNotes) {
      let best = Infinity;
      for (const onset of userOnsets) {
        const d = Math.abs(onset - note.startMs);
        if (d < best) best = d;
        if (onset > note.startMs + s.rhythmZeroMs) break;
      }
      rhythmSum += tolerance(best, s.rhythmPerfectMs, s.rhythmZeroMs, s.rhythmCurve);
    }
    let rhythm = this.refNotes.length ? rhythmSum / this.refNotes.length : 0;
    // 譜上完全沒有對應位置的起音（離每個參考起音都超過 rhythmZeroMs）才算
    // 「多唱」。實測真實演唱只有 18 個，扣分乘數 0.986——它擋的是整段亂加
    // 東西，不會動到正常演唱。
    const refStarts = this.refNotes.map((n) => n.startMs);
    let extraOnsets = 0;
    for (const onset of userOnsets) {
      if (!refStarts.some((r) => Math.abs(r - onset) <= s.rhythmZeroMs)) extraOnsets += 1;
    }
    if (this.refNotes.length) {
      rhythm *= clamp01(1 - (extraOnsets / this.refNotes.length) * s.rhythmExtraPenalty);
    }

    // --- 安定性 ---
    // 取長音的音高中心線（移動平均已濾掉 4–7Hz 的刻意顫音），
    // 中心線的標準差就是「音抖不抖」。
    //
    // 每個長音先各自評分再平均，與音程／節奏一致。若改成先把原始標準差
    // 平均起來再評分，單一個音的標準差是沒有上限的（八度誤判一個音就
    // 1200 cents），幾個爛音就足以把整首的平均拉過歸零線，於是不管唱得
    // 多穩安定性都是 0。
    let stabilitySum = 0;
    let stabilityDenom = 0;
    const deviations = [];
    const smoothWindow = Math.max(3, Math.round(180 / this.hopMs));
    for (const note of this.refNotes) {
      if (note.endMs - note.startMs < s.sustainedNoteMs) continue;
      const cents = this.userCentsIn(note.startMs, note.endMs, octave);
      // 整個長音都沒出聲：音程與完唱度已經扣過了，這裡不重複扣。
      if (cents.length === 0) continue;
      stabilityDenom += 1;
      // 有出聲但撐不滿一個長音（斷斷續續、破音掉出去）本身就是不安定，
      // 以前是 continue 跳過，等於把唱壞的長音從分母裡刪掉，越唱壞分數
      // 反而越好看。
      if (cents.length < 8) continue;
      const dev = stdev(Array.from(movingAverage(cents, smoothWindow)));
      deviations.push(dev);
      stabilitySum += tolerance(dev, s.stabilityPerfectCents, s.stabilityZeroCents, s.stabilityCurve);
    }
    const stability = stabilityDenom ? stabilitySum / stabilityDenom : 0;
    // 回報用的代表值同樣要抗離群，取中位數而非平均
    const stabilityRaw = deviations.length
      ? [...deviations].sort((a, b) => a - b)[deviations.length >> 1]
      : null;

    // --- 技巧 ---
    const events = detectTechniques(userNotes, userFramesForTech, this.hopMs);

    const counts = { vibrato: 0, shakuri: 0, fall: 0 };
    for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;

    // 與原唱技巧位置重合者加權
    const original = this.chart.techniques || [];
    let matched = 0;
    for (const e of events) {
      const hit = original.some(
        (o) => o.type === e.type && e.startMs < o.endMs + 300 && e.endMs > o.startMs - 300
      );
      if (hit) matched += 1;
    }
    // 對到原唱位置的技巧值兩倍，沒對到的則設上限。
    //
    // 原本是 events.length 直接除以固定目標值，結果是「整首一直抖」就能拿
    // 滿分——偵測器本來就會把換音誤判成しゃくり／フォール，所以連唱不準的
    // 人技巧都是 100，這一項等於白送 10 分。技巧要看的是「在該用的地方
    // 用了」，所以未對上原唱的部分只採計到目標值的一半。
    const unmatched = events.length - matched;
    const target = Math.min(
      s.techniqueTargetCount,
      Math.max(s.techniqueMinTarget, original.length));
    const effective = matched * (1 + s.originalMatchBonus)
      + Math.min(unmatched, target * s.unmatchedTechniqueCap);
    const technique = clamp01(effective / target);

    const w = s.weights;
    const raw =
      pitch * w.pitch + rhythm * w.rhythm + stability * w.stability + technique * w.technique;
    // 完唱度做總分的乘數。音程分母已經含未唱的音框，但節奏／安定性／技巧
    // 只看唱出來的部分——只唱副歌就能靠那三項把總分撐住，這裡把它壓回去。
    const completionFactor = completion >= s.completionFullMark
      ? 1
      : Math.max(s.completionFloor, completion / s.completionFullMark);
    const rawTotal = 100 * raw * completionFactor;
    // 85 分以上的差距拉大 1.5 倍，直觀理解是「越接近滿分，一分要扣得
    // 越明顯」；85 分以下維持原樣，上限封在 100。
    const stretched = s.pivotStretch
      ? s.pivotScore + s.pivotStretch * (rawTotal - s.pivotScore)
      : rawTotal;
    const total = Math.max(0, Math.min(100, stretched));

    return {
      total: Math.round(total * 10) / 10,
      rawTotal: Math.round(rawTotal * 10) / 10,
      grade: gradeOf(total),
      comment: commentOf(total, { pitch, rhythm, stability, technique, completion }),
      breakdown: {
        pitch: Math.round(pitch * 1000) / 10,
        rhythm: Math.round(rhythm * 1000) / 10,
        stability: Math.round(stability * 1000) / 10,
        technique: Math.round(technique * 1000) / 10,
        completion: Math.round(completion * 1000) / 10,
      },
      completionFactor: Math.round(completionFactor * 1000) / 1000,
      stabilityCents: stabilityRaw === null ? null : Math.round(stabilityRaw * 10) / 10,
      techniqueCounts: counts,
      techniqueEvents: events,
      matchedOriginal: matched,
      octaveOffset: octave,
      keyShift: this.keyShift,
      userNotes,
      userFrames: this.userFrames,
    };
  }

  /**
   * 一段區間內，使用者與原唱音高曲線的逐框差距（cents）。
   *
   * 零點是原唱那一刻的音高而不是固定的 note 音高，所以原唱自己的滑音與
   * 音高走勢會被抵銷掉。用固定音高當零點時，原唱在長音裡的自然起伏（實測
   * 中位數就有 26–58 cents 的標準差）會被算成「音不穩」，原唱自己的錄音
   * 安定性也只有 66–85 分。
   */
  userCentsIn(startMs, endMs, octave) {
    const out = [];
    const i0 = Math.round(startMs / this.hopMs);
    const i1 = Math.round(endMs / this.hopMs);
    for (let i = i0; i <= i1; i++) {
      const u = this.userAt(i);
      const target = this.targetAt(i, startMs);
      if (!u || !u.midi || target === null) continue;
      const cents = (u.midi + octave - target) * 100;
      // 大幅走音是音程要扣的帳，不該再由安定性扣第二次——而且是無上限地
      // 扣：一框八度誤判就是 1200 cents，足以讓整個長音的標準差爆掉。
      // 安定性只管「音穩不穩」，所以超出這個範圍的框直接不計。
      // （框數因此不足 8 的長音仍會被記 0 分，見上面的分母說明。）
      if (Math.abs(cents) > PARAMS.scoring.stabilityOutlierCents) continue;
      out.push(cents);
    }
    return out;
  }
}

export function gradeOf(total) {
  if (total >= 95) return '完璧';
  if (total >= 90) return '極上';
  if (total >= 85) return '優秀';
  if (total >= 78) return '上手';
  if (total >= 70) return '良好';
  if (total >= 60) return '普通';
  return '再挑戰';
}

export function commentOf(total, b) {
  const weakest = Object.entries({
    音程: b.pitch,
    節奏: b.rhythm,
    安定性: b.stability,
  }).sort((x, y) => x[1] - y[1])[0];

  if (b.completion < 0.7) return '有不少段落沒唱到，先把整首唱完分數會拉高不少。';
  if (total >= 95) return '幾乎無可挑剔，音程與節奏都咬得非常準。';
  if (total >= 90) return `唱得很穩，再把${weakest[0]}磨細一點就是滿分等級了。`;
  if (total >= 80) return `整體掌握不錯，${weakest[0]}是目前最明顯的進步空間。`;
  if (total >= 70) return `旋律大致抓到了，${weakest[0]}再加強會有明顯進步。`;
  return `先專注在${weakest[0]}，跟著音程條慢慢對準再求速度。`;
}

export { TECHNIQUE_LABELS };
