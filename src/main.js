import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';
import { PerfGovernor, storedAutoQuality, PRESET_ORDER } from './core/perf.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing (tools/perf.mjs) need the loop to
// free-run. See the long comment in src/dev/shots.js.
const lockstep = capture && params.get('lockstep') === '1';

const canvas = document.getElementById('game');

// Pick a preset the GPU can actually run. Ultra on an integrated or software
// GPU either takes minutes to compile its shaders (black canvas behind a live
// HUD) or trips the driver watchdog and loses the context. `?q=` still wins.
function autoQuality() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'low';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent);
    if (mobile || /swiftshader|llvmpipe|software|basic render|mali|adreno|powervr/.test(gpu)) return 'low';
    if (/intel|uhd|iris|hd graphics|vega \d|radeon\(tm\) graphics|apple gpu/.test(gpu)) return 'medium';
    return 'high';
  } catch {
    return 'medium';
  }
}

// Precedence: ?q= in the URL, then a preset the player picked in the menu,
// then one the performance governor learned on an earlier visit, then a guess
// from the GPU name.
function storedManualQuality() {
  try {
    const q = localStorage.getItem('ow.quality.manual');
    return PRESET_ORDER.includes(q) ? q : null;
  } catch {
    return null;
  }
}
const manualQuality = storedManualQuality();
const config = createConfig({
  quality: params.get('q') ?? (capture ? 'ultra' : manualQuality ?? storedAutoQuality() ?? autoQuality()),
  deterministic: capture,
});

// Loading screen: boot builds the world and compiles every shader before the
// first frame, which can take a while on slower GPUs. Without this the player
// sees only a black canvas behind the HUD and assumes the game is broken.
const loading = capture ? null : document.createElement('div');
if (loading) {
  loading.style.cssText =
    'position:fixed;inset:0;z-index:9000;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:12px;background:#000;color:#ddd;font:14px/1.5 ui-monospace,monospace;' +
    'letter-spacing:.15em;text-transform:uppercase;text-align:center;padding:16px';
  loading.innerHTML =
    `<div style="font-size:22px;color:#fff">Loading</div><div data-step>Building world…</div>` +
    `<div style="opacity:.5;font-size:11px">Graphics: ${config.quality} · first load can take up to a minute</div>`;
  document.body.appendChild(loading);
}
const loadingStep = (text) => {
  const s = loading?.querySelector('[data-step]');
  if (s) s.textContent = text;
};
// Yield two frames so the browser actually paints the step text before the
// next blocking stretch of work.
const paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const showFatal = (title, body) => {
  loading?.remove();
  const lower = new URL(location.href);
  lower.searchParams.set('q', 'low');
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div style="position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;
       justify-content:center;gap:14px;background:#000;color:#ddd;font:14px/1.6 ui-monospace,monospace;
       text-align:center;padding:16px"><div style="font-size:20px;color:#f66">${title}</div>
       <div style="max-width:560px">${body}</div>
       <a href="${lower.href}" style="color:#000;background:#fff;padding:8px 16px;text-decoration:none">Reload on Low quality</a></div>`
  );
};

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  showFatal(
    'Graphics driver reset',
    `Your GPU stopped responding while running the game on <b>${config.quality}</b> quality. ` +
      'Reloading on a lower preset usually fixes this.'
  );
});

const engine = new Engine({ canvas, config });

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  .add(AiSystem)
  .add(UiSystem)
  .add(AudioSystem);

try {
  await paint();
  await engine.init();
} catch (err) {
  console.error('[boot] init failed', err);
  loading?.remove();
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err.stack ?? err.message}</pre>`
  );
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

// Compile every shader permutation before the frame loop starts. Measured: without
// this, 86 programs compile lazily during play, up to 30 on one frame, producing
// 3.1-3.9 SECOND stalls. See src/core/prewarm.js.
//
// ON BY DEFAULT since the capture path was made frame-deterministic; opt out with
// `?prewarm=0`. It is now PROVEN pixel-neutral: `tools/baseline.mjs` with
// `--query=prewarm=0` vs `--query=prewarm=1` reports identical:true on all 11
// shots (0 changed pixels, maxDelta 0). The two things that previously made the
// ~1.4 s pre-warm spend look like a visual change were both boot-duration
// couplings OUTSIDE the subsystems: (1) the shutter frame index was latency-bound
// because the engine kept stepping through the driver's round trips — fixed by
// lockstep in src/dev/shots.js; (2) `will-change: transform` on the compass strip
// cached a composited-layer raster taken at a wall-clock-dependent moment — fixed
// in src/ui/style.js.
loadingStep('Compiling shaders…');
await paint();
const warmup = params.get('prewarm') === '0' ? { ok: false, reason: 'disabled by ?prewarm=0' } : await prewarm(engine);
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;

// Live dynamic resolution + preset learning. Off for the capture harness,
// whose pixel gate needs a fixed render size; `?perf=1` shows the readout.
if (!capture && params.get('adapt') !== '0') {
  engine.perf = new PerfGovernor(engine, {
    mobile: /android|iphone|ipad|mobile/i.test(navigator.userAgent),
    learn: !params.get('q') && !manualQuality,
    show: params.get('perf') === '1',
  });
  window.__PERF__ = engine.perf;
}

engine.start();

// Capture harness handshake: only flag ready once a frame has actually landed.
//
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at engine frame 3, no
// matter how long boot (or pre-warm) took in wall-clock terms.
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      window.__READY__ = true;
      loading?.remove();
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

window.__ENGINE__ = engine;

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}
