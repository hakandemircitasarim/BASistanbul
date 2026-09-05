// Wanted level: heat from player-caused crimes -> stars, police sight tracking, decay when unseen, siren mirror, star notifications. Track F.
import type { EngineContext, System } from './System';
import type { AudioLike } from './System';
import type { World } from '../world/World';
import type { EventBus } from '../core/EventBus';
import type { Vec2 } from '../core/Types';
import type { Vehicle } from '../entities/Vehicle';

export const WANTED_TUNING = {
  heatPerStar: 30, maxStars: 5, heatCap: 165, heatPedHit: 35, heatPedKill: 60, heatVehicleHit: 12, heatVehicleHitMinSpeed: 5,
  heatPoliceHit: 45, heatStealCar: 15, stealWitnessRadius: 20, decayPerSec: 4, decayDelay: 8, sightRange: 70,
  policePerStar: [0, 2, 3, 4, 6, 8],
  // Extras (not in the spec table)
  flashTime: 1.5,          // seconds the HUD stars pulse after a change
  setStarsExtraHeat: 25,   // setStars(n) lands at n*30 + 25 so decay does not drop a star at once
  heatVehicleDestroyed: 20, // wrecking someone else's car
  hardDecayDelay: 30,      // with stars, heat only decays once a unit has come within sightRange since the last crime (or after this many seconds)
};

export const NOTIFY_WANTED = 'Aranıyorsun!';
export const NOTIFY_ESCAPED = 'Kaçtın! Aranma sona erdi';

/** Adds heat (clamped to heatCap) and restarts the crime timer; the system publishes the star change on its next tick. */
export function addHeat(world: World, amount: number): void {
  const w = world.wanted;
  w.heat = Math.min(WANTED_TUNING.heatCap, Math.max(0, w.heat + amount));
  w.lastCrimeTimer = 0;
  w.lastSeenTimer = 0;
  w.stars = starsFromHeat(w.heat);
}

/** Forces a star level (heat = upper part of that star's band so the first decay tick does not drop a star); missions/tests use it. */
export function setStars(world: World, stars: number): void {
  const w = world.wanted;
  const s = Math.max(0, Math.min(WANTED_TUNING.maxStars, Math.floor(stars)));
  w.heat = s === 0 ? 0 : Math.min(WANTED_TUNING.heatCap, s * WANTED_TUNING.heatPerStar + WANTED_TUNING.setStarsExtraHeat);
  w.stars = s;
  w.lastCrimeTimer = 0;
  w.lastSeenTimer = 0;
}

/** Clears heat and stars (busted/respawn); the system emits wanted:changed silently (no escape notification). */
export function clear(world: World): void {
  const w = world.wanted;
  w.heat = 0;
  w.stars = 0;
  w.lastCrimeTimer = 0;
  w.lastSeenTimer = 0;
  w.flash = 0;
}

export function starsFromHeat(heat: number): number {
  return Math.min(WANTED_TUNING.maxStars, Math.floor(heat / WANTED_TUNING.heatPerStar));
}

export class WantedSystem implements System {
  readonly name = 'Wanted';
  readonly stats = { crimes: 0, starChanges: 0 };
  private world: World | null = null;
  private events: EventBus | null = null;
  private audio: AudioLike | null = null;
  /** A police unit has come within sightRange since the last crime: the player had a real chance to be caught, decay may start. */
  private approached = false;
  private reportedStars = 0;
  private sirenState = false;
  /** Set by clear() so the next star drop to 0 does not toast "Kaçtın". */
  private silentClear = false;
  private readonly ppos: Vec2 = { x: 0, z: 0 };

  init(ctx: EngineContext): void {
    this.world = ctx.world;
    this.events = ctx.events;
    this.audio = ctx.audio;
    this.reportedStars = ctx.world.wanted.stars;
    ctx.events.on('ped:hit', this.onPedHit);
    ctx.events.on('vehicle:collision', this.onCollision);
    ctx.events.on('vehicle:destroyed', this.onDestroyed);
    ctx.events.on('player:enterVehicle', this.onEnterVehicle);
    ctx.events.on('player:respawn', this.onRespawn);
  }

  dispose(): void {
    const ev = this.events;
    if (!ev) return;
    ev.off('ped:hit', this.onPedHit);
    ev.off('vehicle:collision', this.onCollision);
    ev.off('vehicle:destroyed', this.onDestroyed);
    ev.off('player:enterVehicle', this.onEnterVehicle);
    ev.off('player:respawn', this.onRespawn);
  }

  // ---- public helpers (instance versions of the exported functions) ----

  addHeat(amount: number): void {
    if (this.world) { addHeat(this.world, amount); this.stats.crimes++; }
  }

  setStars(stars: number): void {
    if (this.world) setStars(this.world, stars);
  }

  clear(): void {
    if (this.world) { clear(this.world); this.silentClear = true; }
  }

  // ---- crime events (only player-caused) ----

  private readonly onPedHit = (p: { byPlayer: boolean; killed: boolean }): void => {
    if (!p.byPlayer) return;
    this.addHeat(p.killed ? WANTED_TUNING.heatPedKill : WANTED_TUNING.heatPedHit);
  };

  private readonly onCollision = (p: { aId: number; bId: number | null; impactSpeed: number; playerInvolved: boolean }): void => {
    const world = this.world;
    if (!world || !p.playerInvolved || p.bId === null) return;
    const T = WANTED_TUNING;
    const pv = world.playerVehicle();
    if (!pv) return;
    const other = world.vehicles.get(p.aId === pv.id ? p.bId : p.aId);
    if (!other) return;
    // Attribute the crash to the player only when the player's car was the faster one (rammed, not rear-ended).
    const ps = Math.abs(pv.speed), os = Math.abs(other.speed);
    if (ps < T.heatVehicleHitMinSpeed || ps < os) return;
    if (p.impactSpeed < T.heatVehicleHitMinSpeed) return;
    this.addHeat(other.isPolice() ? T.heatPoliceHit : T.heatVehicleHit);
  };

  private readonly onDestroyed = (p: { id: number; byPlayer: boolean }): void => {
    const world = this.world;
    if (!world || !p.byPlayer) return;
    const v = world.vehicles.get(p.id);
    if (v && v.occupiedByPlayer) return;
    this.addHeat(WANTED_TUNING.heatVehicleDestroyed);
  };

  /** Stealing an occupied car counts only when witnessed (a live ped or a police car nearby). */
  private readonly onEnterVehicle = (p: { vehicleId: number; stolen: boolean }): void => {
    const world = this.world;
    if (!world || !p.stolen) return;
    const T = WANTED_TUNING;
    const v = world.vehicles.get(p.vehicleId);
    const x = v ? v.curr.x : world.player.curr.x, z = v ? v.curr.z : world.player.curr.z;
    if (this.witnessNear(x, z, T.stealWitnessRadius)) this.addHeat(T.heatStealCar);
  };

  /** Busted/wasted respawns clear the level silently; a new game keeps whatever newGame set (world.reset + ?stars). */
  private readonly onRespawn = (p: { reason: string }): void => {
    const world = this.world;
    if (!world) return;
    if (p.reason !== 'new') clear(world);
    this.silentClear = world.wanted.stars === 0 && this.reportedStars !== 0;
  };

  private witnessNear(x: number, z: number, r: number): boolean {
    const world = this.world;
    if (!world) return false;
    const r2 = r * r;
    const peds = world.pedList;
    for (let i = 0; i < peds.length; i++) {
      const pd = peds[i];
      if (pd.state === 'DEAD' || pd.state === 'HIT') continue;
      const dx = pd.curr.x - x, dz = pd.curr.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    const sr = WANTED_TUNING.sightRange;
    const vl = world.vehicleList;
    for (let i = 0; i < vl.length; i++) {
      const v = vl[i];
      if (v.role !== 'police' || v.destroyed) continue;
      const dx = v.curr.x - x, dz = v.curr.z - z;
      if (dx * dx + dz * dz < sr * sr) return true;
    }
    return false;
  }

  // ---- per tick ----

  fixedUpdate(dt: number): void {
    const world = this.world;
    if (!world) return;
    const T = WANTED_TUNING;
    const w = world.wanted;
    world.playerPos(this.ppos);
    const seen = this.policeSeesPlayer();
    if (seen) w.lastSeenTimer = 0; else w.lastSeenTimer += dt;
    if (w.lastCrimeTimer === 0) this.approached = false; // a crime just happened (addHeat/setStars reset the timer)
    w.lastCrimeTimer += dt;
    const near = this.policeNear();
    if (near > 0) this.approached = true;
    const alive = this.policeAlive();
    const mayDecay = w.stars === 0 || this.approached || alive === 0 || w.lastCrimeTimer > T.hardDecayDelay;
    if (w.heat > 0 && mayDecay && w.lastSeenTimer > T.decayDelay && w.lastCrimeTimer > T.decayDelay) {
      w.heat = Math.max(0, w.heat - T.decayPerSec * dt);
    }
    w.stars = starsFromHeat(w.heat);
    if (w.flash > 0) w.flash = Math.max(0, w.flash - dt);
    if (w.stars !== this.reportedStars) this.publishStars(w.stars);
    this.updateSiren();
  }

  private publishStars(stars: number): void {
    const world = this.world;
    const ev = this.events;
    if (!world || !ev) return;
    const prev = this.reportedStars;
    const silent = this.silentClear;
    this.silentClear = false;
    this.reportedStars = stars;
    this.stats.starChanges++;
    world.wanted.flash = WANTED_TUNING.flashTime;
    ev.emit('wanted:changed', { stars, prev });
    if (prev === 0 && stars > 0) {
      ev.emit('notify', { text: NOTIFY_WANTED, kind: 'police' });
      if (this.audio) this.audio.playUi('wanted');
    } else if (stars === 0 && prev > 0) {
      if (!silent) ev.emit('notify', { text: NOTIFY_ESCAPED, kind: 'success' });
      world.wanted.flash = 0;
    } else if (stars > prev && this.audio) {
      this.audio.playUi('star');
    }
  }

  /** Number of live police cars within sightRange of the player (line of sight not required). */
  private policeNear(): number {
    const world = this.world;
    if (!world) return 0;
    const r2 = WANTED_TUNING.sightRange * WANTED_TUNING.sightRange;
    const px = this.ppos.x, pz = this.ppos.z;
    const vl = world.vehicleList;
    let n = 0;
    for (let i = 0; i < vl.length; i++) {
      const v = vl[i];
      if (v.role !== 'police' || v.destroyed) continue;
      const dx = v.curr.x - px, dz = v.curr.z - pz;
      if (dx * dx + dz * dz <= r2) n++;
    }
    return n;
  }

  private policeAlive(): number {
    const world = this.world;
    if (!world) return 0;
    const vl = world.vehicleList;
    let n = 0;
    for (let i = 0; i < vl.length; i++) if (vl[i].role === 'police' && !vl[i].destroyed) n++;
    return n;
  }

  /** Any live police car within sightRange with line of sight to the player. */
  private policeSeesPlayer(): boolean {
    const world = this.world;
    if (!world) return false;
    const r = WANTED_TUNING.sightRange;
    const px = this.ppos.x, pz = this.ppos.z;
    const vl = world.vehicleList;
    for (let i = 0; i < vl.length; i++) {
      const v: Vehicle = vl[i];
      if (v.role !== 'police' || v.destroyed) continue;
      const dx = v.curr.x - px, dz = v.curr.z - pz;
      if (dx * dx + dz * dz > r * r) continue;
      if (world.hasLineOfSight(v.curr.x, v.curr.z, px, pz)) return true;
    }
    return false;
  }

  private updateSiren(): void {
    const world = this.world;
    if (!world) return;
    let active = false;
    const vl = world.vehicleList;
    for (let i = 0; i < vl.length && !active; i++) if (vl[i].sirenOn && !vl[i].destroyed) active = true;
    world.wanted.sirenActive = active ? 1 : 0;
    if (active !== this.sirenState) {
      this.sirenState = active;
      if (this.events) this.events.emit('siren:changed', { active });
    }
  }
}
