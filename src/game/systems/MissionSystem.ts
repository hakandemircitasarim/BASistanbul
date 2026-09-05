// Mission runtime: start markers + prompt, step machine (goto/enterVehicle/deliverVehicle/loseWanted/wait), timers, rewards, cooldowns, mission vehicle. Track F.
import type { AudioLike, EngineContext, System } from './System';
import type { World } from '../world/World';
import type { EventBus } from '../core/EventBus';
import type { Input } from '../core/Input';
import type { Vec2 } from '../core/Types';
import type { Entity } from '../entities/Entity';
import { Vehicle } from '../entities/Vehicle';
import { SPECS } from '../entities/VehicleSpecs';
import { BUDGET } from '../core/Budget';
import { setStars } from './WantedSystem';
import { createMissionDefs, resolveMissionPositions, formatMoney, FAIL_BUSTED, FAIL_DESTROYED, FAIL_TIME, FAIL_WASTED } from '../missions/definitions';
import type { MissionDef, MissionStep } from '../missions/definitions';

export const MISSION_TUNING = { startRadius: 2.5, deliverMaxSpeed: 0.5, markerCooldownHide: true };

export interface MarkerOut { x: number; z: number }

export class MissionSystem implements System {
  readonly name = 'Mission';
  readonly stats = { started: 0, completed: 0, failed: 0 };
  defs: MissionDef[] = [];
  private world: World | null = null;
  private events: EventBus | null = null;
  private input: Input | null = null;
  private audio: AudioLike | null = null;
  private active: MissionDef | null = null;
  private stepTimer = 0;
  private readonly cooldownLeft: number[] = [];
  private readonly prompts: string[] = [];
  private readonly ppos: Vec2 = { x: 0, z: 0 };
  private readonly clearOut: Entity[] = [];

  init(ctx: EngineContext): void {
    this.world = ctx.world;
    this.events = ctx.events;
    this.input = ctx.input;
    this.audio = ctx.audio;
    this.defs = resolveMissionPositions(createMissionDefs(), ctx.world.city, ctx.world.roads);
    this.cooldownLeft.length = 0;
    this.prompts.length = 0;
    for (let i = 0; i < this.defs.length; i++) {
      this.cooldownLeft.push(0);
      this.prompts.push(`E - Görevi başlat: ${this.defs[i].title}`);
    }
    ctx.events.on('player:wasted', this.onWasted);
    ctx.events.on('player:busted', this.onBusted);
    ctx.events.on('vehicle:destroyed', this.onDestroyed);
    ctx.events.on('player:respawn', this.onRespawn);
  }

  dispose(): void {
    const ev = this.events;
    if (!ev) return;
    ev.off('player:wasted', this.onWasted);
    ev.off('player:busted', this.onBusted);
    ev.off('vehicle:destroyed', this.onDestroyed);
    ev.off('player:respawn', this.onRespawn);
  }

  private readonly onWasted = (): void => { if (this.active) this.fail(FAIL_WASTED); };
  private readonly onBusted = (): void => { if (this.active) this.fail(FAIL_BUSTED); };
  private readonly onDestroyed = (p: { id: number }): void => {
    const world = this.world;
    if (this.active && world && world.mission.missionVehicleId === p.id) this.fail(FAIL_DESTROYED);
  };
  /** A new game resets cooldowns; a wasted/busted respawn keeps them. */
  private readonly onRespawn = (p: { reason: string }): void => {
    if (p.reason !== 'new') return;
    this.active = null;
    for (let i = 0; i < this.cooldownLeft.length; i++) this.cooldownLeft[i] = 0;
  };

  // ---- public API ----

  get activeDef(): MissionDef | null { return this.active; }

  /** Fills `out` (up to out.length entries) with the start markers currently available; returns the count. */
  availableMarkers(out: MarkerOut[]): number {
    if (this.active) return 0;
    let n = 0;
    for (let i = 0; i < this.defs.length && n < out.length; i++) {
      if (this.cooldownLeft[i] > 0) continue;
      out[n].x = this.defs[i].startX;
      out[n].z = this.defs[i].startZ;
      n++;
    }
    return n;
  }

  /** Starts a mission by id (markers call this on interact; tests call it directly). Returns false when unavailable. */
  startMission(id: string): boolean {
    const world = this.world;
    if (!world || this.active) return false;
    let idx = -1;
    for (let i = 0; i < this.defs.length; i++) if (this.defs[i].id === id) idx = i;
    if (idx < 0 || this.cooldownLeft[idx] > 0) return false;
    const def = this.defs[idx];
    this.active = def;
    this.stepTimer = 0;
    this.stats.started++;
    const m = world.mission;
    m.activeId = def.id; m.activeTitle = def.title; m.step = 0; m.elapsed = 0; m.timer = 0;
    m.timeLimit = def.timeLimit ?? 0;
    m.missionVehicleId = null;
    if (def.spawnVehicle) this.spawnMissionVehicle(def);
    if (def.setWanted) setStars(world, def.setWanted);
    const ev = this.events;
    if (ev) {
      ev.emit('mission:started', { id: def.id, title: def.title });
      ev.emit('notify', { text: `Yeni görev: ${def.title}`, kind: 'info' });
    }
    if (this.audio) this.audio.playUi('missionStart');
    this.setObjective(def.steps[0]);
    this.updateActive(def, 0); // marker visible on the start tick
    return true;
  }

  // ---- per tick ----

  fixedUpdate(dt: number): void {
    const world = this.world;
    if (!world) return;
    for (let i = 0; i < this.cooldownLeft.length; i++) {
      if (this.cooldownLeft[i] > 0) {
        this.cooldownLeft[i] = Math.max(0, this.cooldownLeft[i] - dt);
        world.mission.cooldowns[this.defs[i].id] = this.cooldownLeft[i];
      }
    }
    world.playerPos(this.ppos);
    if (this.active) this.updateActive(this.active, dt);
    else this.updateMarkers();
  }

  private updateMarkers(): void {
    const world = this.world;
    const input = this.input;
    if (!world || !input) return;
    const p = world.player;
    world.mission.markerVisible = false;
    if (p.vehicleId !== null || !p.alive) return;
    const r2 = MISSION_TUNING.startRadius * MISSION_TUNING.startRadius;
    for (let i = 0; i < this.defs.length; i++) {
      if (this.cooldownLeft[i] > 0) continue;
      const d = this.defs[i];
      const dx = this.ppos.x - d.startX, dz = this.ppos.z - d.startZ;
      if (dx * dx + dz * dz > r2) continue;
      world.hud.prompt = this.prompts[i];
      if (input.consume('interact')) this.startMission(d.id);
      return;
    }
  }

  private updateActive(def: MissionDef, dt: number): void {
    const world = this.world;
    if (!world) return;
    const m = world.mission;
    m.elapsed += dt;
    if (m.timeLimit > 0 && m.elapsed >= m.timeLimit) { this.fail(FAIL_TIME); return; }
    const step = def.steps[m.step];
    if (!step) { this.complete(def); return; }
    const p = world.player;
    const pv = world.playerVehicle();
    let done = false;
    switch (step.kind) {
      case 'goto': {
        this.showMarker(step.x, step.z);
        if (step.onFoot && pv !== null) break;
        const dx = this.ppos.x - step.x, dz = this.ppos.z - step.z;
        done = dx * dx + dz * dz <= step.radius * step.radius;
        break;
      }
      case 'enterVehicle': {
        const mv = m.missionVehicleId !== null ? world.vehicles.get(m.missionVehicleId) : undefined;
        if (mv) this.showMarker(mv.curr.x, mv.curr.z); else m.markerVisible = false;
        done = m.missionVehicleId !== null && p.vehicleId === m.missionVehicleId;
        break;
      }
      case 'deliverVehicle': {
        this.showMarker(step.x, step.z);
        if (pv === null || pv.id !== m.missionVehicleId) break;
        const dx = pv.curr.x - step.x, dz = pv.curr.z - step.z;
        if (dx * dx + dz * dz > step.radius * step.radius || Math.abs(pv.speed) > MISSION_TUNING.deliverMaxSpeed) break;
        if (step.minHealth !== undefined && pv.health < step.minHealth) { this.fail(step.failText ?? FAIL_DESTROYED); return; }
        done = true;
        break;
      }
      case 'loseWanted':
        m.markerVisible = false;
        done = world.wanted.stars === 0;
        break;
      case 'wait':
        m.markerVisible = false;
        this.stepTimer += dt;
        done = this.stepTimer >= (step.duration ?? 0);
        break;
    }
    if (!done) return;
    m.step++;
    this.stepTimer = 0;
    if (m.step >= def.steps.length) this.complete(def);
    else this.setObjective(def.steps[m.step]);
  }

  private showMarker(x: number, z: number): void {
    const m = this.world ? this.world.mission : null;
    if (!m) return;
    m.markerX = x; m.markerZ = z; m.markerVisible = true;
  }

  private setObjective(step: MissionStep): void {
    const world = this.world;
    if (!world) return;
    world.mission.objective = step.objective;
    if (this.events) this.events.emit('mission:objective', { id: world.mission.activeId ?? '', text: step.objective });
  }

  // ---- end states ----

  private complete(def: MissionDef): void {
    const world = this.world;
    if (!world) return;
    const m = world.mission;
    const reward = def.reward;
    let bonus = 0;
    if (def.timeBonus && m.elapsed < def.timeBonus.under) bonus = def.timeBonus.bonus;
    const p = world.player;
    p.money += reward + bonus;
    this.stats.completed++;
    m.completed[def.id] = (m.completed[def.id] ?? 0) + 1;
    this.endMission(def);
    const ev = this.events;
    if (ev) {
      ev.emit('mission:completed', { id: def.id, reward: reward + bonus });
      ev.emit('money:changed', { money: p.money, delta: reward + bonus });
      ev.emit('notify', { text: `Görev tamamlandı: +${formatMoney(reward)}`, kind: 'success' });
      if (bonus > 0) ev.emit('notify', { text: `Süre bonusu: +${formatMoney(bonus)}`, kind: 'success' });
    }
    if (this.audio) this.audio.playUi('missionComplete');
  }

  private fail(reason: string): void {
    const def = this.active;
    if (!def) return;
    this.stats.failed++;
    this.endMission(def);
    const ev = this.events;
    if (ev) {
      ev.emit('mission:failed', { id: def.id, reason });
      ev.emit('notify', { text: `Görev başarısız: ${reason}`, kind: 'danger' });
    }
    if (this.audio) this.audio.playUi('fail');
  }

  /** Clears the active state, starts the cooldown and releases the mission vehicle (becomes abandoned). */
  private endMission(def: MissionDef): void {
    const world = this.world;
    if (!world) return;
    const m = world.mission;
    for (let i = 0; i < this.defs.length; i++) if (this.defs[i] === def) { this.cooldownLeft[i] = def.cooldown; m.cooldowns[def.id] = def.cooldown; }
    if (m.missionVehicleId !== null) {
      const mv = world.vehicles.get(m.missionVehicleId);
      if (mv && mv.role === 'mission') mv.role = 'abandoned';
      if (mv && mv.prevRole === 'mission') mv.prevRole = 'abandoned';
    }
    m.activeId = null; m.activeTitle = null; m.step = 0; m.timer = 0; m.timeLimit = 0; m.elapsed = 0; m.objective = null;
    m.markerVisible = false; m.missionVehicleId = null;
    this.active = null;
    this.stepTimer = 0;
  }

  /** Spawns the mission car on its resolved spot, evicting a parked car sitting there. */
  private spawnMissionVehicle(def: MissionDef): void {
    const world = this.world;
    const sv = def.spawnVehicle;
    if (!world || !sv) return;
    const n = world.dynamicHash.queryCircle(sv.x, sv.z, 4, this.clearOut);
    for (let i = 0; i < n; i++) {
      const e = this.clearOut[i];
      if (e.kind !== 'vehicle') continue;
      const o = e as Vehicle;
      if ((o.role === 'parked' || o.role === 'abandoned') && !o.occupiedByPlayer) { world.roads.releaseAll(o.id); world.removeVehicle(o.id); }
    }
    if (world.vehicleList.length >= BUDGET.MAX_VEHICLES) return;
    const spec = SPECS[sv.key];
    const v = new Vehicle(spec, sv.x, sv.z, sv.yaw, 'mission', sv.color);
    v.brain = null;
    v.spawnFade = 0;
    v.lightsOn = false;
    world.addVehicle(v);
    world.mission.missionVehicleId = v.id;
  }
}
