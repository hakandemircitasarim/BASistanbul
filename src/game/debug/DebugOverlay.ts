// DebugOverlay: F3 toggles store.showDebug and pushes a fresh engine.getDebugStats() sample so the DebugPanel is populated even while paused. Track D.
import type { Engine } from '../Engine';
import type { DebugStats } from '../state/GameStore';

const POLL_MS = 250;

export class DebugOverlay {
  private readonly engine: Engine;
  private attached = false;
  private pollTimer = 0;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  /** Installs the F3 listener on window (idempotent). */
  attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    this.attached = true;
    window.addEventListener('keydown', this.onKey);
    if (this.engine.store.getState().showDebug) this.startPolling();
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKey);
    this.stopPolling();
  }

  toggle(): void {
    this.set(!this.engine.store.getState().showDebug);
  }

  set(show: boolean): void {
    const store = this.engine.store;
    if (show) {
      store.setState({ showDebug: true, debug: this.sample() });
      this.startPolling();
    } else {
      store.setState({ showDebug: false, debug: null });
      this.stopPolling();
    }
  }

  dispose(): void {
    this.detach();
  }

  /** Copies the Engine's pooled stats object so the store gets a fresh reference. */
  private sample(): DebugStats {
    const d = this.engine.getDebugStats();
    return { fps: d.fps, drawCalls: d.drawCalls, triangles: d.triangles, tickMs: d.tickMs, vehicles: d.vehicles, peds: d.peds, police: d.police, traffic: d.traffic };
  }

  /** Low-rate poll (4 Hz) that keeps the panel alive when the sim is paused (menus); HudPublisher covers 'playing'. */
  private startPolling(): void {
    if (this.pollTimer || typeof window === 'undefined') return;
    this.pollTimer = window.setInterval(() => {
      if (this.engine.disposed) { this.stopPolling(); return; }
      if (!this.engine.loop.paused) return; // HudPublisher publishes while ticking
      this.engine.store.setState({ debug: this.sample() });
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = 0;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'F3' || e.repeat) return;
    e.preventDefault();
    this.toggle();
  };
}
