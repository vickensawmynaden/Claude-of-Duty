/**
 * On-screen touch controls for phones and tablets.
 *
 * Feeds the same Input state the keyboard, mouse and gamepad do, so gameplay
 * code needs no touch-specific branches:
 *   - left half:  floating joystick  -> input.touchStick (merged into `stick`;
 *                 pushing to the rim sprints, same as a gamepad stick)
 *   - right half: drag to look       -> input._rawLook (same path as the mouse)
 *   - buttons:    press/release the key codes the desktop bindings use
 *
 * The FIRE button also steers while held, so you can shoot and aim with one
 * thumb.
 */

/** Pixels of finger travel -> look delta; the mouse path then applies sensitivity. */
const LOOK_GAIN = 2.4;
const STICK_RADIUS = 56;

const BUTTONS = [
  // id, label, key code, position (right/bottom in vmin), size (vmin)
  { id: 'fire', label: 'FIRE', code: 'Mouse0', r: 6, b: 30, s: 21, look: true },
  { id: 'ads', label: 'AIM', code: 'Mouse2', r: 29, b: 27, s: 14, toggle: true },
  { id: 'jump', label: 'JUMP', code: 'Space', r: 4, b: 53, s: 13 },
  { id: 'crouch', label: 'CRCH', code: 'KeyC', r: 19, b: 46, s: 12 },
  { id: 'reload', label: 'RLD', code: 'KeyR', r: 32, b: 43, s: 12 },
  { id: 'swap', label: 'SWAP', code: 'Tab', r: 4, b: 69, s: 11 },
  { id: 'grenade', label: 'NADE', code: 'KeyG', r: 17, b: 61, s: 11 },
  { id: 'melee', label: 'KNIFE', code: 'KeyV', r: 30, b: 58, s: 11 },
];

const CSS = `
.ow-touch { position:fixed; inset:0; z-index:9; touch-action:none; user-select:none;
  -webkit-user-select:none; -webkit-touch-callout:none; -webkit-tap-highlight-color:transparent; }
.ow-touch-btn { position:absolute; border-radius:50%; display:flex; align-items:center;
  justify-content:center; font:700 11px/1 ui-monospace,monospace; letter-spacing:.08em;
  color:rgba(255,255,255,.85); background:rgba(20,22,26,.38); border:1.5px solid rgba(255,255,255,.35);
  backdrop-filter:blur(2px); -webkit-backdrop-filter:blur(2px); }
.ow-touch-btn.on { background:rgba(255,255,255,.32); border-color:#fff; color:#fff; }
.ow-touch-btn[data-id=fire] { font-size:14px; border-color:rgba(255,90,70,.7); }
.ow-touch-btn[data-id=fire].on { background:rgba(255,90,70,.45); }
.ow-touch-pause { position:absolute; top:calc(env(safe-area-inset-top) + 8px); left:50%;
  transform:translateX(-50%); width:44px; height:30px; border-radius:6px; font-size:14px; }
.ow-touch-base, .ow-touch-knob { position:absolute; border-radius:50%; pointer-events:none;
  transform:translate(-50%,-50%); opacity:0; transition:opacity .12s; }
.ow-touch-base { width:${STICK_RADIUS * 2}px; height:${STICK_RADIUS * 2}px;
  border:1.5px solid rgba(255,255,255,.35); background:rgba(20,22,26,.25); }
.ow-touch-knob { width:48px; height:48px; background:rgba(255,255,255,.45); }
.ow-touch.stick .ow-touch-base, .ow-touch.stick .ow-touch-knob { opacity:1; }
.ow-touch-hint { position:absolute; left:50%; bottom:calc(env(safe-area-inset-bottom) + 34%);
  transform:translateX(-50%); padding:8px 14px; border-radius:6px; background:rgba(0,0,0,.6);
  color:#eee; font:12px/1.5 ui-monospace,monospace; text-align:center; pointer-events:none;
  transition:opacity .6s; max-width:86vw; }
`;

export function isTouchDevice() {
  const forced = new URLSearchParams(location.search).get('touch');
  if (forced === '1') return true;
  if (forced === '0') return false;
  return (navigator.maxTouchPoints ?? 0) > 0 && matchMedia('(pointer: coarse)').matches;
}

export class TouchControls {
  constructor(input) {
    this.input = input;
    this.root = document.createElement('div');
    this.root.className = 'ow-touch';
    const style = document.createElement('style');
    style.textContent = CSS;
    this.root.appendChild(style);

    this.base = this._el('ow-touch-base');
    this.knob = this._el('ow-touch-knob');

    /** pointerId -> { kind: 'stick'|'look'|'button', ... } */
    this.pointers = new Map();
    this.buttons = new Map();

    for (const def of BUTTONS) {
      const b = this._el('ow-touch-btn');
      b.dataset.id = def.id;
      b.textContent = def.label;
      Object.assign(b.style, {
        right: `calc(${def.r}vmin + env(safe-area-inset-right))`,
        bottom: `calc(${def.b}vmin + env(safe-area-inset-bottom))`,
        width: `${def.s}vmin`,
        height: `${def.s}vmin`,
      });
      this.buttons.set(b, def);
    }

    const pause = this._el('ow-touch-btn ow-touch-pause');
    pause.textContent = 'II';
    this.buttons.set(pause, { id: 'pause', code: 'Escape' });

    this.hint = this._el('ow-touch-hint');
    this.hint.innerHTML = 'Left thumb: move (push to edge to sprint)<br>Right thumb: drag to look · hold FIRE and drag to aim';
    setTimeout(() => (this.hint.style.opacity = '0'), 6000);

    this._down = this._onDown.bind(this);
    this._move = this._onMove.bind(this);
    this._up = this._onUp.bind(this);
    this._noGesture = (e) => e.preventDefault();
    // Cancelling touchstart stops the browser synthesising mousedown/mouseup
    // after a tap, which Input would otherwise read as a trigger pull.
    this._noMouseCompat = (e) => e.preventDefault();
  }

  _el(cls) {
    const e = document.createElement('div');
    e.className = cls;
    this.root.appendChild(e);
    return e;
  }

  attach() {
    document.body.appendChild(this.root);
    this.root.addEventListener('pointerdown', this._down);
    this.root.addEventListener('touchstart', this._noMouseCompat, { passive: false });
    addEventListener('pointermove', this._move, { passive: false });
    addEventListener('pointerup', this._up);
    addEventListener('pointercancel', this._up);
    // iOS Safari ignores user-scalable=no; block pinch/double-tap zoom directly.
    document.addEventListener('gesturestart', this._noGesture);
    document.addEventListener('dblclick', this._noGesture);
  }

  detach() {
    this.root.remove();
    removeEventListener('pointermove', this._move);
    removeEventListener('pointerup', this._up);
    removeEventListener('pointercancel', this._up);
    document.removeEventListener('gesturestart', this._noGesture);
    document.removeEventListener('dblclick', this._noGesture);
  }

  _onDown(e) {
    e.preventDefault();
    const input = this.input;
    const def = this.buttons.get(e.target);
    if (def) {
      if (def.toggle) {
        const on = !input.down.has(def.code);
        (on ? input._pendingDown : input._pendingUp).add(def.code);
        e.target.classList.toggle('on', on);
        return;
      }
      input._pendingDown.add(def.code);
      e.target.classList.add('on');
      this.pointers.set(e.pointerId, { kind: 'button', el: e.target, def, x: e.clientX, y: e.clientY });
      return;
    }
    // Free space: left side is the joystick (one at a time), right side looks.
    const stickTaken = [...this.pointers.values()].some((p) => p.kind === 'stick');
    if (e.clientX < innerWidth * 0.45 && !stickTaken) {
      this.pointers.set(e.pointerId, { kind: 'stick', ox: e.clientX, oy: e.clientY });
      this._placeStick(e.clientX, e.clientY, e.clientX, e.clientY);
      this.root.classList.add('stick');
    } else {
      this.pointers.set(e.pointerId, { kind: 'look', x: e.clientX, y: e.clientY });
    }
  }

  _onMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    if (p.kind === 'stick') {
      let dx = e.clientX - p.ox;
      let dy = e.clientY - p.oy;
      const len = Math.hypot(dx, dy);
      // Let the base trail the finger so the stick never "runs out".
      if (len > STICK_RADIUS * 1.6) {
        const k = (len - STICK_RADIUS * 1.6) / len;
        p.ox += dx * k;
        p.oy += dy * k;
        dx = e.clientX - p.ox;
        dy = e.clientY - p.oy;
      }
      const cl = Math.min(1, Math.hypot(dx, dy) / STICK_RADIUS);
      const ang = Math.atan2(dy, dx);
      // Small dead zone so a resting thumb does not creep.
      const mag = cl < 0.12 ? 0 : (cl - 0.12) / 0.88;
      this.input.touchStick.x = Math.cos(ang) * mag;
      this.input.touchStick.y = Math.sin(ang) * mag;
      this._placeStick(p.ox, p.oy, p.ox + Math.cos(ang) * cl * STICK_RADIUS, p.oy + Math.sin(ang) * cl * STICK_RADIUS);
    } else if (p.kind === 'look' || (p.kind === 'button' && p.def.look)) {
      if (!this.input.frozen) {
        this.input._rawLook.x += (e.clientX - p.x) * LOOK_GAIN;
        this.input._rawLook.y += (e.clientY - p.y) * LOOK_GAIN;
      }
      p.x = e.clientX;
      p.y = e.clientY;
    }
  }

  _onUp(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.kind === 'stick') {
      this.input.touchStick.x = 0;
      this.input.touchStick.y = 0;
      this.root.classList.remove('stick');
    } else if (p.kind === 'button') {
      this.input._pendingUp.add(p.def.code);
      p.el.classList.remove('on');
    }
  }

  _placeStick(bx, by, kx, ky) {
    this.base.style.left = `${bx}px`;
    this.base.style.top = `${by}px`;
    this.knob.style.left = `${kx}px`;
    this.knob.style.top = `${ky}px`;
  }

  /** Called when the game releases every held input (blur, pause). */
  reset() {
    for (const [, p] of this.pointers) if (p.kind === 'button') p.el.classList.remove('on');
    for (const [b, def] of this.buttons) if (def.toggle) b.classList.remove('on');
    this.pointers.clear();
    this.input.touchStick.x = 0;
    this.input.touchStick.y = 0;
    this.root.classList.remove('stick');
  }
}
