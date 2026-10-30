// tour.js — 第一次使用的簡短導覽。
//
// 目的只是讓人知道「哪個功能在哪」，不是教學。所以步驟很少、可以隨時略過，
// 而且看過一次就不再自動出現（設定頁可以重看）。

const STEPS = [
  {
    target: '#search-input',
    title: '加歌與找歌都在這一條',
    body: '貼上 YouTube、YouTube Music 或 Bilibili 的網址按 Enter，就會自動抓下來做成伴奏與音程譜。'
          + '直接打字則是在已經下載的歌裡面搜尋。',
  },
  {
    target: '#upload-btn',
    title: '也可以上傳自己的檔案',
    body: '手邊已經有音檔就按這裡選檔案，或直接把檔案拖進搜尋列。',
  },
  {
    target: '.song-card .row',
    title: '演唱與譜面',
    body: '「演唱」開始唱並即時計分；「譜面」可以先播來對照音程條準不準，'
          + '對不上時展開「進階」微調。歌曲存在這台電腦上，手機是按下去才下載。',
  },
  {
    target: '[data-goto="calibrate"]',
    title: '第一次唱之前，先校準',
    body: '麥克風收到的聲音會比實際晚一點。跟著節拍拍手 8 下，系統會量出這段延遲，'
          + '評分才會準。換耳機時再測一次就好。',
  },
  {
    target: '#nav-connect',
    title: '讓手機一起加入',
    body: '掃 QR 就能用手機連上這台電腦的曲庫。也可以開一組臨時公開網址，讓不在同一個 Wi-Fi 的人連進來。',
  },
  {
    target: '[data-goto="settings"]',
    title: '其他設定都在這裡',
    body: '延遲微調、麥克風靈敏度、本機快取，以及這份導覽的重看入口。開始唱吧！',
  },
];

const PADDING = 8;

/**
 * 找出這個選擇器底下第一個「真的看得見」的元素。
 *
 * 用 checkVisibility 而不是量尺寸：分頁在背景或版面尚未穩定時，
 * getBoundingClientRect 會回 0，拿它判斷會誤刪步驟。
 *
 * 會挑「第一個可見的」而不是「第一個」，是因為導覽列在桌面版與手機版
 * 各有一份同名按鈕（頂列 / 底部），另一份是 display:none。
 */
function findVisible(selector) {
  for (const el of document.querySelectorAll(selector)) {
    const ok = el.checkVisibility
      ? el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true,
                             visibilityProperty: true })
      : getComputedStyle(el).display !== 'none';
    if (ok) return el;
  }
  return null;
}

export class Tour {
  constructor({ onFinish = null } = {}) {
    this.steps = [];
    this.index = 0;
    this.done = false;
    this.onFinish = onFinish;
    this.el = document.getElementById('tour');
    this.ring = document.getElementById('tour-ring');
    this.card = document.getElementById('tour-card');
    this.mask = {};
    for (const div of document.querySelectorAll('#tour-mask > div')) {
      this.mask[div.dataset.side] = div;
    }

    // 所有監聽器都掛在同一個 AbortController 上，finish() 一次全部解除。
    // 否則每次「重看使用說明」都會再疊一組按鈕監聽器，按一次「下一步」
    // 會同時推進所有舊實例，其中先走完的那個就把導覽整個關掉。
    this.abort = new AbortController();
    const opts = { signal: this.abort.signal };

    document.getElementById('tour-next').addEventListener('click', () => this.next(), opts);
    document.getElementById('tour-skip').addEventListener('click', () => this.finish(), opts);
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.finish(); }, opts);
    // 版面尺寸或捲動位置一變，遮罩與高亮框就得重算。只監聽 resize 不夠：
    // 分頁從背景切回來、字體載入完成、內容撐開高度都會改變版面，
    // 那時量到的舊座標會讓遮罩對不準（框到一塊空白）。
    const replace = () => this.place();
    window.addEventListener('resize', replace, opts);
    window.addEventListener('scroll', replace, { passive: true, ...opts });
    document.addEventListener('visibilitychange', replace, opts);
    this._observer = new ResizeObserver(replace);
    this._observer.observe(document.documentElement);
  }

  start() {
    // 同時只能有一份導覽。上一份若還開著就先收掉——兩個實例並存時，
    // 按一次「下一步」會同時推進兩邊，先走完的那個會把畫面關掉。
    if (Tour.active && Tour.active !== this) Tour.active.finish();
    Tour.active = this;

    // 只留下當下真的指得到東西的步驟。曲庫還是空的時候就不介紹歌曲卡片，
    // 不是本機時就不介紹「手機連線」——與其框一塊空白說「這裡是什麼」，
    // 不如整步跳過。
    this.steps = STEPS.filter((s) => findVisible(s.target));
    if (!this.steps.length) { this.onFinish?.(); return; }

    this.index = 0;
    this.el.classList.remove('hidden');
    this.render();
    // 版面剛顯示時量到的位置可能還沒穩定，下一幀再校正一次
    requestAnimationFrame(() => this.place());
  }

  next() {
    if (this.index >= this.steps.length - 1) { this.finish(); return; }
    this.index += 1;
    this.render();
  }

  finish() {
    if (this.done) return;      // 略過與最後一步可能同時觸發，只收一次
    this.done = true;
    this.el.classList.add('hidden');
    this.el.classList.remove('no-target');
    this.abort.abort();         // 解除本實例掛過的所有監聽器
    this._observer?.disconnect();
    if (Tour.active === this) Tour.active = null;
    this.onFinish?.();
  }

  render() {
    const step = this.steps[this.index];
    const last = this.index === this.steps.length - 1;

    document.getElementById('tour-step').textContent =
      `${this.index + 1} / ${this.steps.length}`;
    document.getElementById('tour-title').textContent = step.title;
    document.getElementById('tour-body').textContent = step.body;
    document.getElementById('tour-next').textContent = last ? '開始使用' : '下一步';
    document.getElementById('tour-dots').innerHTML =
      this.steps.map((_, i) => `<i class="${i === this.index ? 'on' : ''}"></i>`).join('');

    this.place();
  }

  /**
   * 把四塊遮罩排成「中間留一個洞」的形狀。
   *
   *   ┌──────────top──────────┐
   *   │left│    目標元素     │right│
   *   └─────────bottom────────┘
   */
  placeMask(hole) {
    const top = Math.max(0, hole.top - PADDING);
    const left = Math.max(0, hole.left - PADDING);
    const right = Math.max(0, hole.right + PADDING);
    const bottom = Math.max(0, hole.bottom + PADDING);

    Object.assign(this.mask.top.style,
      { left: '0px', top: '0px', width: '100%', height: `${top}px` });
    Object.assign(this.mask.bottom.style,
      { left: '0px', top: `${bottom}px`, width: '100%', bottom: '0px', height: 'auto' });
    Object.assign(this.mask.left.style,
      { left: '0px', top: `${top}px`, width: `${left}px`, height: `${bottom - top}px` });
    Object.assign(this.mask.right.style,
      { left: `${right}px`, top: `${top}px`, right: '0px', width: 'auto',
        height: `${bottom - top}px` });
  }

  /** 把高亮框移到目標元素上，並讓說明卡片避開它。 */
  place() {
    const step = this.steps[this.index];
    const target = findVisible(step.target);

    if (!target || !target.getBoundingClientRect().width) {
      // 目標不存在（例如曲庫還是空的）就只顯示說明。這時沒有高亮框可以
      // 壓暗周圍，改由覆蓋層自己上底色。
      this.ring.classList.remove('show');
      this.el.classList.add('no-target');
      this.card.style.top = '';
      this.card.style.bottom = '';
      return;
    }
    this.el.classList.remove('no-target');

    // 目標可能在畫面外（例如要捲動才看得到的卡片），先帶到可視範圍
    const rect = target.getBoundingClientRect();
    if (rect.top < 80 || rect.bottom > window.innerHeight - 80) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
    }

    const r = target.getBoundingClientRect();
    Object.assign(this.ring.style, {
      left: `${r.left - PADDING}px`,
      top: `${r.top - PADDING}px`,
      width: `${r.width + PADDING * 2}px`,
      height: `${r.height + PADDING * 2}px`,
    });
    this.ring.classList.add('show');
    this.placeMask(r);

    // 目標在畫面上半部就把卡片放下面，反之放上面，不要蓋住要看的東西
    const cardH = this.card.offsetHeight || 220;
    const below = r.bottom + 20;
    if (below + cardH < window.innerHeight - 12) {
      this.card.style.top = `${below}px`;
      this.card.style.bottom = 'auto';
    } else {
      this.card.style.top = `${Math.max(12, r.top - cardH - 20)}px`;
      this.card.style.bottom = 'auto';
    }
  }
}
