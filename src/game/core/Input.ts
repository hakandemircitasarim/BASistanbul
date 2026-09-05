// Keyboard/mouse input with action bindings, edge latching per fixed tick and pointer lock handling. Track P0.
export type Action = 'forward' | 'back' | 'left' | 'right' | 'sprint' | 'jump' | 'interact' | 'handbrake' | 'horn'
  | 'camLeft' | 'camRight' | 'pause' | 'mute' | 'headlights' | 'debug' | 'cameraToggle';

export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  handbrake: ['Space'],
  interact: ['KeyE', 'KeyF'],
  horn: ['KeyH'],
  camLeft: ['KeyQ'],
  camRight: ['KeyR'],
  pause: ['Escape'],
  mute: ['KeyM'],
  headlights: ['KeyL'],
  debug: ['F3'],
  cameraToggle: ['KeyV'],
};

/** Every key code that appears in a binding (used to clear edges without iterating object keys). */
const ALL_CODES: string[] = [];
for (const a in DEFAULT_BINDINGS) {
  const codes = DEFAULT_BINDINGS[a as Action];
  for (let i = 0; i < codes.length; i++) if (ALL_CODES.indexOf(codes[i]) < 0) ALL_CODES.push(codes[i]);
}

/** Codes whose browser default (scrolling, find, etc.) must be suppressed while the game has focus. */
const PREVENT_DEFAULT_CODES = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3', 'Tab'];

export class Input {
  mouseDX = 0;
  mouseDY = 0;
  pointerLocked = false;
  onPointerLockChange: ((locked: boolean) => void) | null = null;
  enabled = true;

  private held: Record<string, boolean> = Object.create(null);
  private edges: Record<string, boolean> = Object.create(null);
  private accDX = 0;
  private accDY = 0;
  private target: HTMLElement | null = null;

  // Bound DOM handlers (created once so detach() can remove them).
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.enabled && PREVENT_DEFAULT_CODES.indexOf(e.code) >= 0) e.preventDefault(); // menus keep Space/Tab/arrow defaults
    if (e.repeat) return;
    this.setKey(e.code, true);
  };
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.setKey(e.code, false);
  };
  private readonly onMouseMove = (e: MouseEvent): void => {
    if (this.pointerLocked) this.addMouseDelta(e.movementX, e.movementY);
  };
  private readonly onLockChange = (): void => {
    const doc = this.target ? this.target.ownerDocument : null;
    const locked = !!doc && doc.pointerLockElement === this.target;
    if (locked === this.pointerLocked) return;
    this.pointerLocked = locked;
    if (!locked) this.clearAll();
    if (this.onPointerLockChange) this.onPointerLockChange(locked);
  };
  private readonly onBlur = (): void => {
    this.clearAll();
  };
  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.clearAll();
  };

  /** Keys listen on window; mouse movement and pointer lock are bound to the target element. */
  attach(target: HTMLElement): void {
    this.detach();
    this.target = target;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', this.onLockChange);
  }

  detach(): void {
    if (!this.target) return;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockChange);
    this.target = null;
    this.clearAll();
  }

  /** Used by DOM listeners and by headless tests. A down transition latches a "pressed" edge until endTick(). */
  setKey(code: string, down: boolean): void {
    if (down) {
      if (!this.held[code]) this.edges[code] = true;
      this.held[code] = true;
    } else {
      this.held[code] = false;
    }
  }

  addMouseDelta(dx: number, dy: number): void {
    this.accDX += dx;
    this.accDY += dy;
  }

  /** Once per animation frame: publish the accumulated mouse delta. */
  beginFrame(): void {
    this.mouseDX = this.accDX;
    this.mouseDY = this.accDY;
    this.accDX = 0;
    this.accDY = 0;
  }

  /** After each fixed tick: clear all pressed edges so exactly one tick observes a key press. */
  endTick(): void {
    for (let i = 0; i < ALL_CODES.length; i++) this.edges[ALL_CODES[i]] = false;
  }

  down(a: Action): boolean {
    if (!this.enabled) return false;
    const codes = DEFAULT_BINDINGS[a];
    for (let i = 0; i < codes.length; i++) if (this.held[codes[i]]) return true;
    return false;
  }

  pressed(a: Action): boolean {
    if (!this.enabled) return false;
    const codes = DEFAULT_BINDINGS[a];
    for (let i = 0; i < codes.length; i++) if (this.edges[codes[i]]) return true;
    return false;
  }

  /** pressed() and clears that edge (so a second consumer in the same tick sees false). */
  consume(a: Action): boolean {
    if (!this.pressed(a)) return false;
    const codes = DEFAULT_BINDINGS[a];
    for (let i = 0; i < codes.length; i++) this.edges[codes[i]] = false;
    return true;
  }

  axis(neg: Action, pos: Action): number {
    return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0);
  }

  /** Never throws: the returned promise rejection (no user gesture, headless) is swallowed. */
  requestPointerLock(): void {
    const t = this.target;
    if (!t || typeof t.requestPointerLock !== 'function') return;
    try {
      const r: unknown = t.requestPointerLock();
      if (r instanceof Promise) r.catch(() => { /* rejected: no gesture / unsupported */ });
    } catch {
      /* unsupported */
    }
  }

  exitPointerLock(): void {
    if (typeof document === 'undefined' || typeof document.exitPointerLock !== 'function') return;
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch {
      /* ignore */
    }
  }

  /** All keys up, all edges and mouse deltas cleared. */
  clearAll(): void {
    for (let i = 0; i < ALL_CODES.length; i++) {
      this.held[ALL_CODES[i]] = false;
      this.edges[ALL_CODES[i]] = false;
    }
    for (const k in this.held) this.held[k] = false;
    for (const k in this.edges) this.edges[k] = false;
    this.accDX = 0;
    this.accDY = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
