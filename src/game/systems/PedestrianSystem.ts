// Pedestrian AI: IDLE/WALK/FLEE/HIT/DEAD FSM on the sidewalk graph, threat tests (player car, off-lane cars, horns, sprint, panic), tumble/lying/fade, spawn ring, fleeing drivers. Track E.
import type { CameraLike, EngineContext, System } from './System';
import type { World } from '../world/World';
import type { EventBus } from '../core/EventBus';
import type { Random } from '../core/Random';
import type { Vec2 } from '../core/Types';
import type { Entity } from '../entities/Entity';
import { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';
import { BUDGET } from '../core/Budget';
import { PANTS, SHIRTS, SKINS } from '../city/Palette';
import { clamp, dampAngle, yawFromDir } from '../core/math';

export const PED_TUNING = {
  targetCount: BUDGET.PED_TARGET, spawnMin: 30, spawnMax: 130, despawnDist: 170, walkSpeed: 1.4, fleeSpeed: 5.5, fleeTime: 6,
  idleMin: 1, idleMax: 4, threatSpeed: 4, threatApproach: 2.0, hornRadius: 12, panicRadius: 15, lyingTime: 8, fadeTime: 1.5,
  crossChance: 0.25, aiEveryTicks: 3, sprintScare: 2,
  // Extras (not in the spec table)
  spawnInterval: 0.5, spawnPerInterval: 2, spawnAheadMin: 100, spawnClearRadius: 4,
  arriveDist: 0.6, idleChance: 0.12, turnLambda: 10, gravity: 20, groundFriction: 6, tumbleRate: 3,
  lookAhead: 2.5, lookPad: 1.3, movingVehicle: 0.5, // a ped waits while a moving vehicle crosses its next lookAhead metres
  getUpTime: 3,            // survivors get up after this many seconds on the ground
  separation: 0.9,         // ped/ped soft separation distance
  separationPush: 2.5,     // m/s of push at full overlap
  animRate: 2.4,           // animPhase radians per metre
  spawnFadeRate: 2,
  fleeJitter: 0.6,         // radians of random deviation from the away direction
  prefillCount: 24, prefillMin: 12, prefillMax: 80, // one-off fill around the player at newGame/respawn (ignores the in-view rule)
};

const MAX_THREATS = 16;

export class PedestrianSystem implements System {
  readonly name = 'Pedestrian';
  readonly stats = { spawned: 0, despawned: 0, fleeTransitions: 0, hits: 0 };
  private world: World | null = null;
  private events: EventBus | null = null;
  private camera: CameraLike | null = null;
  private rng: Random | null = null;
  private spawnTimer = 0.2;
  private readonly ppos: Vec2 = { x: 0, z: 0 };
  private readonly nodeOut: number[] = [];
  private readonly nearOut: Entity[] = [];
  private readonly threats: Vehicle[] = new Array<Vehicle>(MAX_THREATS);
  private threatCount = 0;

  init(ctx: EngineContext): void {
    this.world = ctx.world;
    this.events = ctx.events;
    this.camera = ctx.camera;
    this.rng = ctx.rng;
    ctx.events.on('horn', this.onHorn);
    ctx.events.on('ped:hit', this.onPedHit);
    ctx.events.on('player:enterVehicle', this.onEnterVehicle);
  }

  dispose(): void {
    if (!this.events) return;
    this.events.off('horn', this.onHorn);
    this.events.off('ped:hit', this.onPedHit);
    this.events.off('player:enterVehicle', this.onEnterVehicle);
  }

  // ---- events ----

  private readonly onHorn = (p: { x: number; z: number }): void => {
    this.scareAround(p.x, p.z, PED_TUNING.hornRadius);
  };

  private readonly onPedHit = (p: { pedId: number; byVehicleId: number | null; x: number; z: number }): void => {
    const world = this.world;
    if (!world) return;
    this.stats.hits++;
    const ped = world.peds.get(p.pedId);
    const v = p.byVehicleId !== null ? world.vehicles.get(p.byVehicleId) : undefined;
    if (ped) {
      ped.threatX = v ? v.curr.x : p.x;
      ped.threatZ = v ? v.curr.z : p.z;
      ped.stateTimer = 0;
      ped.fadeTimer = 0;
      if (ped.health <= 0) ped.state = 'DEAD';
    }
    this.scareAround(p.x, p.z, PED_TUNING.panicRadius);
  };

  private readonly onEnterVehicle = (p: { vehicleId: number; stolen: boolean }): void => {
    const world = this.world;
    if (!world || !p.stolen) return;
    const v = world.vehicles.get(p.vehicleId);
    if (v && v.prevRole === 'traffic') this.spawnFleeingDriver(v);
  };

  /** Every walking/idle ped within `radius` of (x, z) flees from it. */
  private scareAround(x: number, z: number, radius: number): void {
    const world = this.world;
    if (!world) return;
    const r2 = radius * radius;
    const list = world.pedList;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const dx = p.curr.x - x, dz = p.curr.z - z;
      if (dx * dx + dz * dz <= r2) this.flee(p, x, z);
    }
  }

  private flee(p: Pedestrian, fromX: number, fromZ: number): void {
    if (p.state === 'HIT' || p.state === 'DEAD') return;
    if (p.state !== 'FLEE') this.stats.fleeTransitions++;
    p.state = 'FLEE';
    p.threatX = fromX;
    p.threatZ = fromZ;
    p.fleeTimer = PED_TUNING.fleeTime;
    p.stateTimer = 0;
  }

  /** A driver ejected from a stolen car: appears at the driver door already fleeing. */
  spawnFleeingDriver(v: Vehicle): Pedestrian | null {
    const world = this.world;
    const rng = this.rng;
    if (!world || !rng || world.pedList.length >= BUDGET.MAX_PEDS) return null;
    const yaw = v.curr.yaw;
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);
    const off = v.spec.width * 0.5 + 0.9;
    const x = v.curr.x - rx * off, z = v.curr.z - rz * off;
    const node = world.sidewalks.nearestNode(x, z);
    const p = new Pedestrian(x, z, yaw, node.id, rng.pick(SHIRTS), rng.pick(PANTS), rng.pick(SKINS));
    p.targetNode = node.id;
    p.spawnFade = 1;
    world.addPed(p);
    this.stats.spawned++;
    this.flee(p, v.curr.x, v.curr.z);
    return p;
  }

  // ---- per tick ----

  fixedUpdate(dt: number): void {
    const world = this.world;
    if (!world) return;
    const T = PED_TUNING;
    world.playerPos(this.ppos);
    this.collectThreats();
    const tick = world.time.tick;
    const list = world.pedList;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.spawnFade < 1 && p.fadeTimer <= 0) p.spawnFade = Math.min(1, p.spawnFade + T.spawnFadeRate * dt);
      if (this.despawnFar(p)) { i--; continue; }
      if ((tick + p.id) % T.aiEveryTicks === 0) this.evaluateThreats(p);
      switch (p.state) {
        case 'IDLE': this.updateIdle(p, dt); break;
        case 'WALK': this.updateWalk(p, dt); break;
        case 'FLEE': this.updateFlee(p, dt); break;
        default:
          if (this.updateHit(p, dt)) { i--; continue; }
      }
      if (p.state !== 'HIT' && p.state !== 'DEAD') this.separate(p, dt);
    }
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = T.spawnInterval;
      for (let k = 0; k < T.spawnPerInterval && list.length < T.targetCount; k++) if (!this.trySpawn()) break;
    }
  }

  private despawnFar(p: Pedestrian): boolean {
    const world = this.world;
    if (!world) return false;
    const dx = p.curr.x - this.ppos.x, dz = p.curr.z - this.ppos.z;
    if (dx * dx + dz * dz <= PED_TUNING.despawnDist * PED_TUNING.despawnDist) return false;
    world.removePed(p.id);
    this.stats.despawned++;
    return true;
  }

  // ---- threats ----

  /** Once per tick: the player's vehicle plus off-lane (brain-less) cars faster than threatSpeed. */
  private collectThreats(): void {
    const world = this.world;
    if (!world) return;
    const T = PED_TUNING;
    let n = 0;
    const pv = world.playerVehicle();
    if (pv && Math.abs(pv.speed) > T.threatSpeed) this.threats[n++] = pv;
    const list = world.vehicleList;
    for (let i = 0; i < list.length && n < MAX_THREATS; i++) {
      const v = list[i];
      if (v === pv || v.brain !== null || v.sleeping) continue;
      if (v.vx * v.vx + v.vz * v.vz > T.threatSpeed * T.threatSpeed) this.threats[n++] = v;
    }
    this.threatCount = n;
  }

  /** Closest-approach test against the threat list, sprinting player nearby; staggered every aiEveryTicks. */
  private evaluateThreats(p: Pedestrian): void {
    const world = this.world;
    if (!world || p.state === 'HIT' || p.state === 'DEAD') return;
    const T = PED_TUNING;
    for (let i = 0; i < this.threatCount; i++) {
      const v = this.threats[i];
      const rx = p.curr.x - v.curr.x, rz = p.curr.z - v.curr.z;
      const v2 = v.vx * v.vx + v.vz * v.vz;
      if (v2 < 1e-6) continue;
      const tca = clamp((rx * v.vx + rz * v.vz) / v2, 0, 1);
      const cx = rx - v.vx * tca, cz = rz - v.vz * tca;
      const reach = T.threatApproach + v.spec.width * 0.5;
      if (cx * cx + cz * cz < reach * reach) { this.flee(p, v.curr.x, v.curr.z); return; }
    }
    const pl = world.player;
    if (pl.vehicleId === null && pl.sprinting) {
      const dx = p.curr.x - pl.curr.x, dz = p.curr.z - pl.curr.z;
      if (dx * dx + dz * dz < T.sprintScare * T.sprintScare) this.flee(p, pl.curr.x, pl.curr.z);
    }
  }

  // ---- states ----

  private updateIdle(p: Pedestrian, dt: number): void {
    p.stateTimer -= dt;
    p.vx = 0; p.vz = 0; p.speed = 0;
    if (p.stateTimer <= 0) this.startWalk(p);
  }

  private startWalk(p: Pedestrian): void {
    const world = this.world;
    const rng = this.rng;
    if (!world || !rng) return;
    p.state = 'WALK';
    p.stateTimer = 0;
    if (p.targetNode < 0 || p.targetNode >= world.sidewalks.nodes.length) {
      p.targetNode = world.sidewalks.nextNode(p.walkNode, p.dir, rng, PED_TUNING.crossChance);
    }
  }

  private updateWalk(p: Pedestrian, dt: number): void {
    const world = this.world;
    const rng = this.rng;
    if (!world || !rng) return;
    const T = PED_TUNING;
    const node = world.sidewalks.nodes[p.targetNode];
    const dx = node.x - p.curr.x, dz = node.z - p.curr.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < T.arriveDist) {
      p.walkNode = p.targetNode;
      if (rng.chance(T.idleChance)) {
        p.state = 'IDLE';
        p.stateTimer = rng.range(T.idleMin, T.idleMax);
        p.vx = 0; p.vz = 0; p.speed = 0;
        p.targetNode = world.sidewalks.nextNode(p.walkNode, p.dir, rng, T.crossChance);
        return;
      }
      p.targetNode = world.sidewalks.nextNode(p.walkNode, p.dir, rng, T.crossChance);
      return;
    }
    if (this.vehicleOnPath(p, dx / d, dz / d)) { p.vx = 0; p.vz = 0; p.speed = 0; return; }
    this.moveToward(p, dx / d, dz / d, T.walkSpeed, dt);
  }

  /**
   * True when a MOVING vehicle overlaps the ped's next lookAhead metres (peds wait for cars rolling through a crossing).
   * Stationary cars are walked around (CollisionSystem slides the ped along the body), which avoids the
   * ped-waits-for-car / car-waits-for-ped deadlock.
   */
  private vehicleOnPath(p: Pedestrian, dx: number, dz: number): boolean {
    const world = this.world;
    if (!world) return false;
    const T = PED_TUNING;
    const n = world.dynamicHash.querySegment(p.curr.x, p.curr.z, p.curr.x + dx * T.lookAhead, p.curr.z + dz * T.lookAhead, T.lookPad, this.nearOut);
    for (let i = 0; i < n; i++) {
      const e = this.nearOut[i];
      if (e.kind !== 'vehicle') continue;
      if (e.vx * e.vx + e.vz * e.vz > T.movingVehicle * T.movingVehicle) return true;
    }
    return false;
  }

  private updateFlee(p: Pedestrian, dt: number): void {
    const world = this.world;
    const rng = this.rng;
    if (!world || !rng) return;
    const T = PED_TUNING;
    p.fleeTimer -= dt;
    p.stateTimer += dt;
    if (p.fleeTimer <= 0) {
      p.state = 'IDLE';
      p.stateTimer = rng.range(0.5, 1.5);
      p.vx = 0; p.vz = 0; p.speed = 0;
      const node = world.sidewalks.nearestNode(p.curr.x, p.curr.z);
      p.walkNode = node.id;
      p.targetNode = node.id;
      return;
    }
    let ax = p.curr.x - p.threatX, az = p.curr.z - p.threatZ;
    const d = Math.sqrt(ax * ax + az * az);
    if (d < 1e-3) { ax = Math.sin(p.curr.yaw); az = Math.cos(p.curr.yaw); }
    else { ax /= d; az /= d; }
    // Deterministic per-ped jitter so a crowd fans out instead of running in one line.
    const j = Math.sin(p.id * 12.9898) * T.fleeJitter;
    const cj = Math.cos(j), sj = Math.sin(j);
    const fx = ax * cj - az * sj, fz = ax * sj + az * cj;
    this.moveToward(p, fx, fz, T.fleeSpeed, dt);
  }

  private moveToward(p: Pedestrian, dx: number, dz: number, speed: number, dt: number): void {
    const T = PED_TUNING;
    p.vx = dx * speed;
    p.vz = dz * speed;
    p.speed = speed;
    p.curr.x += p.vx * dt;
    p.curr.z += p.vz * dt;
    p.curr.yaw = dampAngle(p.curr.yaw, yawFromDir(dx, dz), T.turnLambda, dt);
    p.animPhase += speed * T.animRate * dt;
    if (p.animPhase > 1e4) p.animPhase -= 1e4;
  }

  /** HIT/DEAD: ballistic tumble, ground slide, lying, then fade (or get up and flee for survivors). Returns true when removed. */
  private updateHit(p: Pedestrian, dt: number): boolean {
    const world = this.world;
    if (!world) return false;
    const T = PED_TUNING;
    if (p.state === 'HIT' && p.health <= 0) p.state = 'DEAD';
    p.stateTimer += dt;
    p.speed = 0;
    if (p.curr.y > 0 || p.vy > 0) {
      p.vy -= T.gravity * dt;
      p.curr.y += p.vy * dt;
      p.curr.x += p.vx * dt;
      p.curr.z += p.vz * dt;
      if (p.curr.y <= 0) { p.curr.y = 0; p.vy = 0; p.vx *= 0.5; p.vz *= 0.5; }
    } else {
      const k = Math.exp(-T.groundFriction * dt);
      p.vx *= k; p.vz *= k;
      p.curr.x += p.vx * dt;
      p.curr.z += p.vz * dt;
    }
    p.tumble = Math.min(2, p.tumble + T.tumbleRate * dt);
    if (p.state === 'HIT' && p.stateTimer > T.getUpTime && p.curr.y <= 0) {
      p.tumble = 0;
      p.vx = 0; p.vz = 0;
      p.state = 'IDLE';
      this.flee(p, p.threatX, p.threatZ);
      return false;
    }
    if (p.stateTimer > T.lyingTime) {
      p.fadeTimer += dt;
      p.spawnFade = Math.max(0, 1 - p.fadeTimer / T.fadeTime);
      if (p.fadeTimer >= T.fadeTime) {
        world.removePed(p.id);
        this.stats.despawned++;
        return true;
      }
    }
    return false;
  }

  /** Soft ped/ped separation (no hard collision). */
  private separate(p: Pedestrian, dt: number): void {
    const world = this.world;
    if (!world) return;
    const T = PED_TUNING;
    const n = world.dynamicHash.queryCircle(p.curr.x, p.curr.z, T.separation, this.nearOut);
    for (let i = 0; i < n; i++) {
      const e = this.nearOut[i];
      if (e === p || e.kind !== 'ped') continue;
      const dx = p.curr.x - e.curr.x, dz = p.curr.z - e.curr.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= T.separation * T.separation || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = ((T.separation - d) / T.separation) * T.separationPush * dt;
      p.curr.x += (dx / d) * push;
      p.curr.z += (dz / d) * push;
    }
  }

  // ---- spawning ----

  /** Ring spawn on sidewalk nodes: hidden (not in view or beyond spawnAheadMin), nothing within spawnClearRadius. */
  private trySpawn(rMin = PED_TUNING.spawnMin, rMax = PED_TUNING.spawnMax, ignoreView = false, fade = 0): boolean {
    const world = this.world;
    const camera = this.camera;
    const rng = this.rng;
    if (!world || !camera || !rng) return false;
    const T = PED_TUNING;
    if (world.pedList.length >= BUDGET.MAX_PEDS) return false;
    const n = world.sidewalks.nodesInRing(this.ppos.x, this.ppos.z, rMin, rMax, this.nodeOut);
    if (n === 0) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const node = world.sidewalks.nodes[this.nodeOut[rng.int(0, n - 1)]];
      const dx = node.x - this.ppos.x, dz = node.z - this.ppos.z;
      if (!ignoreView && camera.isInView(node.x, node.z) && dx * dx + dz * dz < T.spawnAheadMin * T.spawnAheadMin) continue;
      if (world.dynamicHash.queryCircle(node.x, node.z, T.spawnClearRadius, this.nearOut) > 0) continue;
      const dir: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const p = new Pedestrian(node.x, node.z, rng.range(-Math.PI, Math.PI), node.id, rng.pick(SHIRTS), rng.pick(PANTS), rng.pick(SKINS));
      p.dir = dir;
      p.spawnFade = fade;
      p.state = 'WALK';
      p.targetNode = world.sidewalks.nextNode(node.id, dir, rng, T.crossChance);
      world.addPed(p);
      this.stats.spawned++;
      return true;
    }
    return false;
  }

  /** One-off fill of pedestrians around the player (newGame/respawn): ignores the in-view rule so sidewalks are alive from the first frame. */
  prefill(): number {
    const world = this.world;
    if (!world) return 0;
    world.playerPos(this.ppos);
    const T = PED_TUNING;
    const want = Math.min(T.targetCount, T.prefillCount);
    let made = 0;
    for (let i = 0; i < want * 3 && made < want; i++) if (this.trySpawn(T.prefillMin, T.prefillMax, true, 1)) made++;
    return made;
  }
}
