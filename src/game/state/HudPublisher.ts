// HudPublisher: sim system that mirrors World -> GameStore at <= 10 Hz (every 6 ticks + publishNow on key events), patching only changed fields. Track D.
import type { System, EngineContext } from '../systems/System';
import type { DebugStats, HudState } from './GameStore';
import type { World } from '../world/World';

export const HUD_PUBLISH_TICKS = 6;
const FPS_PUBLISH_TICKS = 30;

/** Optional providers the Engine hands in; kept as callbacks so this file stays Three-free and Node-safe. */
export interface HudPublisherHooks {
  /** Smoothed loop fps (Engine: loop.fps). */
  fps?: () => number;
  /** Renderer/loop statistics; only sampled while `showDebug` is on. */
  debugStats?: () => DebugStats;
}

/** Formats a fractional hour as `HH:MM`. */
export function formatClock(hour: number): string {
  const minute = Math.floor((((hour % 24) + 24) % 24) * 60) % (24 * 60);
  const hh = Math.floor(minute / 60), mm = minute % 60;
  return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
}

/** Money as `$1.250` (tr-TR grouping, no decimals). */
export function formatMoney(m: number): string {
  const v = Math.round(Math.abs(m));
  let s = String(v);
  let out = '';
  while (s.length > 3) {
    out = '.' + s.slice(-3) + out;
    s = s.slice(0, -3);
  }
  return (m < 0 ? '-$' : '$') + s + out;
}

export class HudPublisher implements System {
  readonly name = 'HudPublisher';
  private ctx: EngineContext | null = null;
  private counter = 0;
  private clockMinute = -1;
  private clockText = '';
  private lastFpsTick = -1;
  private fpsValue = 0;
  private readonly hooks: HudPublisherHooks;
  private unsubs: (() => void)[] = [];
  private debugCache: DebugStats | null = null;

  constructor(hooks: HudPublisherHooks = {}) {
    this.hooks = hooks;
  }

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    const ev = ctx.events;
    const now = (): void => this.publishNow();
    this.unsubs.push(
      ev.on('phase:changed', now),
      ev.on('wanted:changed', now),
      ev.on('mission:started', now),
      ev.on('mission:objective', now),
      ev.on('mission:failed', now),
      ev.on('money:changed', now),
      ev.on('player:damaged', now),
      ev.on('mission:completed', (p) => { ctx.store.setState({ lastReward: p.reward }); this.publishNow(); }),
      ev.on('notify', (p) => { ctx.store.notify(p.text, p.kind); this.publishNow(); }),
    );
    this.publishNow();
  }

  fixedUpdate(): void {
    this.counter++;
    if (this.counter % HUD_PUBLISH_TICKS === 0) this.publish();
  }

  /** Publishes immediately (used after events and by the Engine after newGame/respawn). */
  publishNow(): void {
    this.publish();
  }

  dispose(): void {
    for (let i = 0; i < this.unsubs.length; i++) this.unsubs[i]();
    this.unsubs.length = 0;
    this.ctx = null;
  }

  private clock(w: World): string {
    const minute = Math.floor((((w.time.hour % 24) + 24) % 24) * 60) % (24 * 60);
    if (minute !== this.clockMinute) {
      this.clockMinute = minute;
      this.clockText = formatClock(w.time.hour);
    }
    return this.clockText;
  }

  private publish(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = ctx.world;
    const p = w.player;
    const v = w.playerVehicle();
    const s = ctx.store.getState();
    // One small patch literal per publish (<= 10 Hz) is the accepted allocation; only changed keys are written.
    const patch: Partial<HudState> = {};
    let changed = false;
    const phase = w.phase;
    if (s.phase !== phase) { patch.phase = phase; changed = true; }
    const health = Math.max(0, Math.round(p.health));
    if (s.health !== health) { patch.health = health; changed = true; }
    const armor = Math.max(0, Math.round(p.armor));
    if (s.armor !== armor) { patch.armor = armor; changed = true; }
    const money = Math.round(p.money);
    if (s.money !== money) { patch.money = money; changed = true; }
    const wanted = w.wanted.stars;
    if (s.wanted !== wanted) { patch.wanted = wanted; changed = true; }
    const wantedFlash = w.wanted.flash > 0;
    if (s.wantedFlash !== wantedFlash) { patch.wantedFlash = wantedFlash; changed = true; }
    const inVehicle = v !== null;
    if (s.inVehicle !== inVehicle) { patch.inVehicle = inVehicle; changed = true; }
    const speedKmh = v ? Math.round(Math.abs(v.speed) * 3.6) : 0;
    if (s.speedKmh !== speedKmh) { patch.speedKmh = speedKmh; changed = true; }
    const vehicleHealth = v ? Math.max(0, Math.round(v.health)) : 100;
    if (s.vehicleHealth !== vehicleHealth) { patch.vehicleHealth = vehicleHealth; changed = true; }
    const vehicleName = v ? v.spec.name : '';
    if (s.vehicleName !== vehicleName) { patch.vehicleName = vehicleName; changed = true; }
    const prompt = w.hud.prompt;
    if (s.prompt !== prompt) { patch.prompt = prompt; changed = true; }
    const m = w.mission;
    const missionTitle = m.activeId ? m.activeTitle : null;
    if (s.missionTitle !== missionTitle) { patch.missionTitle = missionTitle; changed = true; }
    const missionObjective = m.activeId ? m.objective : null;
    if (s.missionObjective !== missionObjective) { patch.missionObjective = missionObjective; changed = true; }
    const missionTimer = m.activeId && m.timeLimit > 0 ? Math.max(0, Math.ceil(m.timeLimit - m.elapsed)) : null;
    if (s.missionTimer !== missionTimer) { patch.missionTimer = missionTimer; changed = true; }
    const clock = this.clock(w);
    if (s.clock !== clock) { patch.clock = clock; changed = true; }
    const pointerLocked = ctx.input.pointerLocked;
    if (s.pointerLocked !== pointerLocked) { patch.pointerLocked = pointerLocked; changed = true; }
    const hitFlashAt = w.hud.hitFlashAt;
    if (s.hitFlashAt !== hitFlashAt) { patch.hitFlashAt = hitFlashAt; changed = true; }
    const tick = w.time.tick;
    if (this.hooks.fps && (this.lastFpsTick < 0 || tick - this.lastFpsTick >= FPS_PUBLISH_TICKS)) {
      this.lastFpsTick = tick;
      this.fpsValue = Math.round(this.hooks.fps());
    }
    if (s.fps !== this.fpsValue) { patch.fps = this.fpsValue; changed = true; }
    if (s.showDebug && this.hooks.debugStats) {
      const d = this.hooks.debugStats();
      const c = this.debugCache;
      if (!c || c.fps !== d.fps || c.drawCalls !== d.drawCalls || c.triangles !== d.triangles || c.tickMs !== d.tickMs
        || c.vehicles !== d.vehicles || c.peds !== d.peds || c.police !== d.police || c.traffic !== d.traffic) {
        // Copy so the store never aliases the Engine's pooled stats object (Object.is would miss in-place updates).
        this.debugCache = { fps: d.fps, drawCalls: d.drawCalls, triangles: d.triangles, tickMs: d.tickMs, vehicles: d.vehicles, peds: d.peds, police: d.police, traffic: d.traffic };
        patch.debug = this.debugCache;
        changed = true;
      }
    } else if (s.debug !== null) {
      patch.debug = null;
      this.debugCache = null;
      changed = true;
    }
    if (changed) ctx.store.setState(patch);
  }
}
