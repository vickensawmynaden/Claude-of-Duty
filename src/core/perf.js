/**
 * Adaptive performance governor.
 *
 * Two loops, at two time scales:
 *
 *  1. Dynamic resolution (live). Every window of frames the median frame time
 *     is compared with the target; `config.q.renderScale` is moved down when the
 *     GPU is behind and back up when it has headroom, then the engine re-sizes
 *     its targets. renderScale is the one quality knob that is safe to change
 *     mid-game — the pass chain (GTAO, SSR, TAA, ...) is built once at init.
 *
 *  2. Preset learning (next boot). If the frame rate stays bad even at the
 *     resolution floor, the next lower preset is remembered; if it stays well
 *     inside budget at full resolution, the next higher one is. main.js reads
 *     that back before boot, so each device settles on what it can run.
 *
 * Median, not mean: shader compiles and GC pauses produce single huge frames
 * that must not be read as "this GPU is slow".
 */

export const PRESET_ORDER = ['low', 'medium', 'high', 'ultra'];
const STORE_AUTO = 'ow.quality.auto';
/** Never auto-promote to ultra: it is a deliberate, opt-in choice. */
const AUTO_MAX = 'high';

const WINDOW_S = 1.0;
const WARMUP_S = 4.0;
const COOLDOWN_S = 2.0;
const MIN_SCALE = 0.5;
const STEP_UP = 0.05;

export function storedAutoQuality() {
  try {
    const q = localStorage.getItem(STORE_AUTO);
    return PRESET_ORDER.includes(q) ? q : null;
  } catch {
    return null;
  }
}

function storeAutoQuality(q) {
  try {
    localStorage.setItem(STORE_AUTO, q);
  } catch {
    /* private mode: learning just does not persist */
  }
}

export class PerfGovernor {
  constructor(engine, { mobile = false, learn = true, show = false } = {}) {
    this.engine = engine;
    this.config = engine.config;
    /** Phones are held to 30 fps: chasing 60 there costs far too much image. */
    this.targetMs = mobile ? 1000 / 30 : 1000 / 60;
    this.maxScale = this.config.q.renderScale;
    this.scale = this.maxScale;

    this.samples = [];
    this.windowT = 0;
    this.sinceStart = 0;
    this.sinceChange = COOLDOWN_S;
    this.fastStreak = 0;
    this.strugglingT = 0;
    this.headroomT = 0;
    /** A preset forced by URL or picked in the menu is respected, not second-guessed. */
    this.suggested = !learn;
    this.medianMs = 0;

    this.hud = show ? this._makeHud() : null;
  }

  /** Called once per rendered frame with the real (unclamped) frame time in seconds. */
  sample(frameS) {
    if (document.hidden || frameS <= 0) return;
    // A gap this long is a backgrounded tab or a debugger, not a frame rate.
    if (frameS > 2) return;
    this.sinceStart += frameS;
    if (this.sinceStart < WARMUP_S) return;
    this.sinceChange += frameS;
    this.windowT += frameS;
    // One-off stalls (shader compile, GC) are rejected by the median below.
    this.samples.push(frameS * 1000);
    // Close the window on time, but insist on a few frames so the median
    // means something even when the device manages only a handful per second.
    if (this.windowT < WINDOW_S || this.samples.length < 3) return;

    this.windowT = 0;
    this.samples.sort((a, b) => a - b);
    const ms = this.samples[this.samples.length >> 1];
    this.lastWindowS = this.samples.reduce((a, b) => a + b, 0) / 1000;
    this.samples.length = 0;
    this.medianMs = ms;
    this._adjustScale(ms);
    this._learnPreset(ms);
    this._paintHud();
  }

  _adjustScale(ms) {
    const t = this.targetMs;
    if (this.sinceChange < COOLDOWN_S) return;

    if (ms > t * 1.15 && this.scale > MIN_SCALE) {
      // GPU cost tracks pixel count, i.e. scale squared — so take the square
      // root of the overshoot, and never more than one big step at a time.
      const k = Math.max(0.75, Math.sqrt(t / ms));
      this._setScale(this.scale * k);
      this.fastStreak = 0;
    } else if (ms < t * 0.8 && this.scale < this.maxScale) {
      // Climb only after sustained headroom so we do not oscillate.
      if (++this.fastStreak >= 3) {
        this._setScale(this.scale + STEP_UP);
        this.fastStreak = 0;
      }
    } else {
      this.fastStreak = 0;
    }
  }

  _setScale(s) {
    s = Math.min(this.maxScale, Math.max(MIN_SCALE, Math.round(s * 20) / 20));
    if (s === this.scale) return;
    this.scale = s;
    this.config.q.renderScale = s;
    this.engine.resize();
    this.sinceChange = 0;
  }

  _learnPreset(ms) {
    if (this.suggested) return;
    const t = this.targetMs;
    const cur = PRESET_ORDER.indexOf(this.config.quality);

    const w = this.lastWindowS;
    if (this.scale <= MIN_SCALE && ms > t * 1.15) this.strugglingT += w;
    else this.strugglingT = Math.max(0, this.strugglingT - w * 0.5);

    if (this.scale >= this.maxScale && ms < t * 0.6) this.headroomT += w;
    else this.headroomT = Math.max(0, this.headroomT - w);

    if (this.strugglingT >= 8 && cur > 0) {
      this._suggest(PRESET_ORDER[cur - 1], 'Running slow');
    } else if (this.headroomT >= 30 && cur < PRESET_ORDER.indexOf(AUTO_MAX)) {
      this._suggest(PRESET_ORDER[cur + 1], 'Running smoothly');
    }
  }

  _suggest(q, why) {
    this.suggested = true;
    storeAutoQuality(q);
    const t = document.createElement('div');
    t.style.cssText =
      'position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 48px);transform:translateX(-50%);' +
      'z-index:9500;padding:8px 14px;border-radius:6px;background:rgba(0,0,0,.72);color:#eee;' +
      'font:12px/1.5 ui-monospace,monospace;text-align:center;max-width:88vw;cursor:pointer';
    t.innerHTML = `${why} — graphics will use <b>${q.toUpperCase()}</b> next time.<br><u>Tap to apply now</u>`;
    t.addEventListener('click', () => {
      const u = new URL(location.href);
      u.searchParams.delete('q');
      location.href = u.href;
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 9000);
  }

  _makeHud() {
    const h = document.createElement('div');
    h.style.cssText =
      'position:fixed;right:8px;top:calc(env(safe-area-inset-top) + 8px);z-index:9500;padding:4px 8px;' +
      'background:rgba(0,0,0,.6);color:#9f9;font:11px/1.4 ui-monospace,monospace;pointer-events:none';
    document.body.appendChild(h);
    return h;
  }

  _paintHud() {
    if (!this.hud) return;
    const fps = this.medianMs ? (1000 / this.medianMs).toFixed(0) : '–';
    this.hud.textContent = `${fps} fps · ${this.config.quality} · res ${(this.scale * 100).toFixed(0)}%`;
  }
}
