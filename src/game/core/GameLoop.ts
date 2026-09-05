// Fixed-timestep game loop with accumulator, sub-step cap, interpolation alpha and smoothed FPS. Track P0.
export interface LoopCallbacks { fixed: (dt: number) => void; render: (alpha: number, frameDt: number) => void }

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class GameLoop {
  paused = false;
  timeScale = 1;
  readonly maxSubSteps = 5;
  readonly maxFrameDt = 0.1;

  private _fps = 60;
  private _tick = 0;
  private _lastFixedMs = 0;
  private fixedDt: number;
  private cb: LoopCallbacks;
  private acc = 0;
  private last = -1;
  private running = false;
  private rafId = 0;
  private timerId: ReturnType<typeof setTimeout> | null = null;

  private readonly frame = (): void => {
    if (!this.running) return;
    const t = now();
    if (this.last < 0) this.last = t;
    let frameDt = (t - this.last) / 1000;
    this.last = t;
    if (frameDt > this.maxFrameDt) frameDt = this.maxFrameDt;
    if (frameDt > 0) {
      const inst = 1 / frameDt;
      this._fps += (inst - this._fps) * 0.1;
    }

    let alpha = 0;
    if (!this.paused) {
      this.acc += frameDt * this.timeScale;
      const t0 = now();
      let steps = 0;
      while (this.acc >= this.fixedDt && steps < this.maxSubSteps) {
        this.cb.fixed(this.fixedDt);
        this.acc -= this.fixedDt;
        this._tick++;
        steps++;
      }
      // Spiral-of-death guard: drop time we could not simulate.
      if (steps >= this.maxSubSteps && this.acc >= this.fixedDt) this.acc = 0;
      this._lastFixedMs = now() - t0;
      alpha = this.acc / this.fixedDt;
    } else {
      this._lastFixedMs = 0;
    }
    this.cb.render(alpha, frameDt);
    this.schedule();
  };

  constructor(cb: LoopCallbacks, fixedDt = 1 / 60) {
    this.cb = cb;
    this.fixedDt = fixedDt;
  }

  get fps(): number { return this._fps; }
  get tick(): number { return this._tick; }
  get lastFixedMs(): number { return this._lastFixedMs; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = -1;
    this.acc = 0;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.timerId !== null) clearTimeout(this.timerId);
    this.timerId = null;
  }

  private schedule(): void {
    if (typeof requestAnimationFrame === 'function') this.rafId = requestAnimationFrame(this.frame);
    else this.timerId = setTimeout(this.frame, 16);
  }
}
