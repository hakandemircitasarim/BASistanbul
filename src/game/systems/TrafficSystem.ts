// Traffic AI: shared lane driver (pure pursuit + PD steer, bezier turns, stop signs, node reservations), car-following, ped braking, siren yielding, spawn/despawn rings, parked cars. Track E.
import type { CameraLike, EngineContext, System } from './System';
import type { World } from '../world/World';
import type { EventBus } from '../core/EventBus';
import type { Random } from '../core/Random';
import type { Lane, LanePos, RoadGraph } from '../city/RoadGraph';
import type { Vec2 } from '../core/Types';
import type { Entity } from '../entities/Entity';
import { Vehicle, makeTrafficBrain } from '../entities/Vehicle';
import type { TrafficBrain } from '../entities/Vehicle';
import { SPECS, TRAFFIC_MIX } from '../entities/VehicleSpecs';
import type { VehicleKey } from '../entities/VehicleSpecs';
import { BUDGET } from '../core/Budget';
import { angleDiff, clamp, yawFromDir } from '../core/math';

export const TRAFFIC_TUNING = {
  targetCount: BUDGET.TRAFFIC_TARGET, spawnMin: 130, spawnMax: 230, spawnAheadMin: 220, despawnDist: 280,
  lookahead: 6, followGapBase: 6, followGapPerMs: 1.0, stopTime: 0.8, nodeApproach: 8, scanLen: 16, scanHalfW: 2.4,
  pedConeLen: 6, pedConeDot: 0.75, steerP: 2.2, steerD: 0.3, spawnInterval: 0.5, blockedTimeout: 6, honkAfter: 2,
  sirenYieldDist: 18, turnSpeed: 6,
  // Extras (not in the spec table)
  despawnViewDist: 320,   // in-view traffic survives up to this distance
  abandonedDespawn: 300,  // abandoned cars despawn beyond this (never the mission vehicle)
  wreckDespawn: 25,       // seconds a destroyed traffic car stays when not in view
  spawnClearRadius: 12,   // no entity within this radius of a spawn point
  spawnSpeed: 8,          // initial speed along the lane
  cruiseMin: 9.5, cruiseMax: 12.5, // per-car preferred speed (m/s)
  holdDecel: 5,           // comfortable decel used to hold at a stop line
  stopLineGap: 1.0,       // hold this far before the lane end
  turnSlowDist: 12,       // slow to turnSpeed within this distance of a non-straight turn
  laneReacquire: 7,       // lateral/behind distance after which the brain re-finds its lane
  yieldTime: 1.2, yieldSpeed: 4, yieldOffset: 1.0,
  unstickAfter: 3,        // blocked seconds before a reverse/bypass manoeuvre
  reverseTicks: 60, bypassTicks: 240, bypassOffset: -2.8, bypassSpeed: 5,
  honkCooldownMin: 2.5, honkCooldownMax: 5,
  nightStart: 18.5, nightEnd: 6.5,
  prefillCount: 16, prefillMin: 45, prefillMax: 200, // one-off fill around the player at newGame/respawn (ignores the in-view rule)
};

/** Picks the successor lane id for a brain leaving `lane` (-1 = none). */
export type ChooseNext = (b: TrafficBrain, lane: Lane, rng: Random) => number;

export interface DriveOptions {
  obeyStops: boolean;   // wait stopTime at stopSign nodes
  obeyLimit: boolean;   // cap cruise speed at lane.speedLimit
  evictAfter: number;   // > 0: release occupants holding the node longer than this before reserving (police)
}
export const TRAFFIC_DRIVE: DriveOptions = { obeyStops: true, obeyLimit: true, evictAfter: 0 };

const target: Vec2 = { x: 0, z: 0 };
const lanePos: LanePos = { lane: 0, t: 0 };
const WEIGHT_STRAIGHT = 0.6, WEIGHT_RIGHT = 0.25, WEIGHT_LEFT = 0.15;

/** Default successor choice: straight .6 / right .25 / left .15 among the lane's available successors. */
export const chooseNextWeighted: ChooseNext = (b, lane, rng) => {
  void b;
  const n = lane.next.length;
  if (n === 0) return -1;
  let total = 0;
  for (let i = 0; i < n; i++) total += lane.nextKind[i] === 'straight' ? WEIGHT_STRAIGHT : lane.nextKind[i] === 'right' ? WEIGHT_RIGHT : WEIGHT_LEFT;
  let r = rng.next() * total;
  for (let i = 0; i < n; i++) {
    r -= lane.nextKind[i] === 'straight' ? WEIGHT_STRAIGHT : lane.nextKind[i] === 'right' ? WEIGHT_RIGHT : WEIGHT_LEFT;
    if (r <= 0) return lane.next[i];
  }
  return lane.next[n - 1];
};

/** Weighted vehicle key from TRAFFIC_MIX. */
export function pickTrafficKey(rng: Random): VehicleKey {
  let total = 0;
  for (let i = 0; i < TRAFFIC_MIX.length; i++) total += TRAFFIC_MIX[i].weight;
  let r = rng.next() * total;
  for (let i = 0; i < TRAFFIC_MIX.length; i++) {
    r -= TRAFFIC_MIX[i].weight;
    if (r <= 0) return TRAFFIC_MIX[i].key;
  }
  return TRAFFIC_MIX[TRAFFIC_MIX.length - 1].key;
}

export class TrafficSystem implements System {
  readonly name = 'Traffic';
  /** Traffic-role vehicles counted during the last tick. */
  trafficCount = 0;
  readonly stats = { spawned: 0, despawned: 0, honks: 0, blockedDespawns: 0 };
  private world: World | null = null;
  private events: EventBus | null = null;
  private camera: CameraLike | null = null;
  private rng: Random | null = null;
  private spawnTimer = 0.1;
  private readonly ppos: Vec2 = { x: 0, z: 0 };
  private readonly scanOut: Entity[] = [];
  private readonly clearOut: Entity[] = [];
  private readonly laneOut: number[] = [];
  private blocker: Entity | null = null;
  private blockerStationaryCar = false;
  private sirenPresent = false;

  init(ctx: EngineContext): void {
    this.world = ctx.world;
    this.events = ctx.events;
    this.camera = ctx.camera;
    this.rng = ctx.rng;
    ctx.events.on('player:enterVehicle', this.onEnterVehicle);
    ctx.events.on('vehicle:destroyed', this.onDestroyed);
  }

  private readonly onEnterVehicle = (p: { vehicleId: number }): void => {
    if (this.world) this.world.roads.releaseAll(p.vehicleId);
  };

  private readonly onDestroyed = (p: { id: number }): void => {
    if (this.world) this.world.roads.releaseAll(p.id);
  };

  // ---- shared lane driver ----

  /** Finds the lane nearest the car, preferring lanes that roughly match its heading. */
  static acquireLane(v: Vehicle, b: TrafficBrain, roads: RoadGraph): void {
    roads.nearestLane(v.curr.x, v.curr.z, lanePos);
    const seg = roads.segments[roads.lanes[lanePos.lane].segment];
    const fx = Math.sin(v.curr.yaw), fz = Math.cos(v.curr.yaw);
    let best = lanePos.lane, bestT = lanePos.t, bestCost = Infinity;
    for (let i = 0; i < seg.lanes.length; i++) {
      const l = roads.lanes[seg.lanes[i]];
      const ox = v.curr.x - l.start.x, oz = v.curr.z - l.start.z;
      const t = clamp(ox * l.dir.x + oz * l.dir.z, 0, l.length);
      const px = l.start.x + l.dir.x * t - v.curr.x, pz = l.start.z + l.dir.z * t - v.curr.z;
      const cost = Math.sqrt(px * px + pz * pz) + (l.dir.x * fx + l.dir.z * fz < 0 ? 20 : 0);
      if (cost < bestCost) { bestCost = cost; best = l.id; bestT = t; }
    }
    b.lane = best; b.t = bestT; b.nextLane = -1; b.inTurn = false; b.turnS = 0;
    b.reservedNode = -1; b.waitingAtNode = -1; b.stopTimer = 0;
  }

  /** Releases occupants that have held `nodeId` longer than `after` seconds. */
  static evictStale(roads: RoadGraph, nodeId: number, now: number, after: number): void {
    const n = roads.nodes[nodeId];
    for (let i = n.occupantCount - 1; i >= 0; i--) if (now - n.occupants[i].since > after) roads.release(nodeId, n.occupants[i].id);
  }

  /**
   * Drives `v` along its brain's lane: pure pursuit toward a point `lookahead` ahead (on the lane or the turn bezier),
   * PD steering, speed control to min(limit, targetSpeed), turnSpeed near turns, one stop at stop signs, node reservation
   * (hold at the stop line while refused), bezier traversal, then lane = next + release. Returns the lane-desired speed
   * BEFORE `speedCap` (so callers can tell "wants to go but cannot" from "legitimately waiting").
   */
  static driveAlongLane(v: Vehicle, b: TrafficBrain, roads: RoadGraph, world: World, dt: number, now: number, chooseNext: ChooseNext,
    speedCap = Infinity, opts: DriveOptions = TRAFFIC_DRIVE, lateralOffset = 0): number {
    const T = TRAFFIC_TUNING;
    const lanes = roads.lanes;
    const px = v.curr.x, pz = v.curr.z;
    if (b.lane < 0 || b.lane >= lanes.length) TrafficSystem.acquireLane(v, b, roads);
    let lane = lanes[b.lane];
    if (!b.inTurn) {
      const ox = px - lane.start.x, oz = pz - lane.start.z;
      const along = ox * lane.dir.x + oz * lane.dir.z;
      const lat = Math.abs(-ox * lane.dir.z + oz * lane.dir.x);
      if (lat > T.laneReacquire || along < -T.laneReacquire) {
        roads.releaseAll(v.id);
        TrafficSystem.acquireLane(v, b, roads);
        lane = lanes[b.lane];
      }
    }
    if (b.nextLane < 0 || b.nextLane >= lanes.length) {
      b.nextLane = chooseNext(b, lane, world.rng);
      b.turnS = 0;
      if (b.nextLane < 0) b.nextLane = lane.next.length > 0 ? lane.next[0] : b.lane;
    }
    const straight = roads.turnKind(b.lane, b.nextLane) === 'straight';
    const limit = opts.obeyLimit ? lane.speedLimit : Infinity;
    const cruise = b.targetSpeed > 0 ? Math.min(limit, b.targetSpeed) : Math.min(limit, lane.speedLimit);
    let desired = cruise;

    if (!b.inTurn) {
      const raw = (px - lane.start.x) * lane.dir.x + (pz - lane.start.z) * lane.dir.z;
      const t = clamp(raw, 0, lane.length);
      b.t = t;
      const remaining = lane.length - t;
      if (!straight && remaining < T.turnSlowDist) desired = Math.min(desired, T.turnSpeed);
      let mayGo = b.reservedNode === lane.to;
      if (!mayGo && remaining <= T.nodeApproach) {
        if (b.waitingAtNode !== lane.to) { b.waitingAtNode = lane.to; b.stopTimer = 0; }
        let stopDone = true;
        if (opts.obeyStops && roads.nodes[lane.to].stopSign && b.stopTimer < T.stopTime) {
          stopDone = false;
          if (Math.abs(v.speed) < 0.3 && remaining < T.stopLineGap + 2.5) b.stopTimer += dt;
        }
        if (stopDone) {
          mayGo = roads.reserve(lane.to, v.id, lane.axis, straight, now);
          if (!mayGo && opts.evictAfter > 0) {
            TrafficSystem.evictStale(roads, lane.to, now, opts.evictAfter);
            mayGo = roads.reserve(lane.to, v.id, lane.axis, straight, now);
          }
          if (mayGo) b.reservedNode = lane.to;
        }
      }
      if (!mayGo && remaining <= T.nodeApproach) {
        const stopDist = remaining - T.stopLineGap;
        desired = stopDist <= 0.25 ? 0 : Math.min(desired, Math.sqrt(2 * T.holdDecel * stopDist));
      }
      if (mayGo && raw >= lane.length) { b.inTurn = true; b.turnS = 0; }
      const ahead = t + T.lookahead;
      if (ahead <= lane.length) roads.pointOnLane(b.lane, ahead, target);
      else {
        const tl = Math.max(1, roads.turnLength(b.lane, b.nextLane));
        const s = (ahead - lane.length) / tl;
        if (s <= 1) roads.turnPoint(b.lane, b.nextLane, s, target);
        else roads.pointOnLane(b.nextLane, (s - 1) * tl, target);
      }
    }
    if (b.inTurn) {
      const tl = Math.max(1, roads.turnLength(b.lane, b.nextLane));
      b.turnS += (Math.max(0, v.speed) * dt) / tl;
      if (!straight) desired = Math.min(desired, T.turnSpeed);
      const s = b.turnS + T.lookahead / tl;
      if (s <= 1) roads.turnPoint(b.lane, b.nextLane, s, target);
      else roads.pointOnLane(b.nextLane, (s - 1) * tl, target);
      if (b.turnS >= 1) {
        roads.release(lane.to, v.id);
        b.lane = b.nextLane; b.nextLane = -1; b.t = 0; b.inTurn = false; b.turnS = 0;
        b.reservedNode = -1; b.waitingAtNode = -1; b.stopTimer = 0;
      }
    }

    // Lateral offsets: siren yield pulls right, callers may request a bypass offset.
    let offset = lateralOffset;
    if (b.yieldTimer > 0) { b.yieldTimer -= dt; offset += T.yieldOffset; desired = Math.min(desired, T.yieldSpeed); }
    if (offset !== 0) {
      const d = lanes[b.lane].dir;
      target.x += -d.z * offset;
      target.z += d.x * offset;
    }

    // PD steering on the heading error toward the pursuit point.
    const dx = target.x - px, dz = target.z - pz;
    const err = angleDiff(v.curr.yaw, yawFromDir(dx, dz));
    const dErr = (err - b.prevHeadingErr) / dt;
    b.prevHeadingErr = err;
    const c = v.controls;
    c.steer = clamp(T.steerP * err + T.steerD * dErr, -1, 1);
    c.handbrake = false;

    // Speed control toward min(desired, cap).
    const want = Math.min(desired, speedCap);
    const sp = v.speed;
    const e = want - sp;
    if (want <= 0.05 && sp < 0.5) { c.throttle = 0; c.brake = 1; }
    else if (e > -0.3) { c.throttle = clamp(0.28 + e * 0.6, 0, 1); c.brake = 0; }
    else { c.throttle = 0; c.brake = clamp(-e * 0.3, 0.15, 1); }
    return desired;
  }

  // ---- per tick ----

  fixedUpdate(dt: number): void {
    const world = this.world;
    if (!world) return;
    const T = TRAFFIC_TUNING;
    const now = world.time.elapsed;
    world.roads.expireReservations(now, 4);
    world.playerPos(this.ppos);
    this.sirenPresent = this.anySiren();
    const list = world.vehicleList;
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.role === 'traffic') {
        count++;
        if (this.updateTraffic(v, dt, now)) { count--; i--; }
      } else if (v.role === 'abandoned' && this.despawnAbandoned(v)) {
        i--;
      }
    }
    this.trafficCount = count;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = T.spawnInterval;
      if (count < T.targetCount) this.trySpawn();
    }
  }

  /** Returns true when the vehicle was removed. */
  private updateTraffic(v: Vehicle, dt: number, now: number): boolean {
    const world = this.world;
    const camera = this.camera;
    if (!world || !camera) return false;
    const T = TRAFFIC_TUNING;
    const dx = v.curr.x - this.ppos.x, dz = v.curr.z - this.ppos.z;
    const d2 = dx * dx + dz * dz;
    const inView = camera.isInView(v.curr.x, v.curr.z);
    if (d2 > T.despawnViewDist * T.despawnViewDist || (d2 > T.despawnDist * T.despawnDist && !inView)) { this.remove(v); return true; }
    if (v.destroyed) {
      if (v.wreckTimer > T.wreckDespawn && !inView) { this.remove(v); return true; }
      return false;
    }
    if (v.brain === null) v.brain = makeTrafficBrain();
    const b = v.brain as TrafficBrain;
    const tick = world.time.tick;
    let mode = 0; // 0 normal, 1 reverse, 2 bypass
    if (b.decideTick !== 0) {
      if (tick >= Math.abs(b.decideTick)) b.decideTick = 0;
      else mode = b.decideTick < 0 ? 1 : 2;
    }
    const cap = this.scanAhead(v, mode === 2);
    this.checkSiren(v, b);
    if (mode === 1) {
      const c = v.controls;
      c.throttle = -0.6; c.steer = 0; c.brake = 0; c.handbrake = false;
      return false;
    }
    const desired = TrafficSystem.driveAlongLane(v, b, world.roads, world, dt, now, chooseNextWeighted,
      mode === 2 ? Math.min(cap, T.bypassSpeed) : cap, TRAFFIC_DRIVE, mode === 2 ? T.bypassOffset : 0);

    // Blocked bookkeeping: wants to go but stands still, and no AI car ahead is the reason.
    const blocker = this.blocker;
    const aiBlocker = blocker !== null && blocker.kind === 'vehicle' && (blocker as Vehicle).brain !== null && !(blocker as Vehicle).destroyed;
    const pedBlocker = blocker !== null && blocker.kind === 'ped'; // peds pass or fade; waiting for them is not "blocked"
    if (desired > 2 && Math.abs(v.speed) < 0.3 && !aiBlocker && !pedBlocker) b.blockedTimer += dt;
    else b.blockedTimer = Math.max(0, b.blockedTimer - dt);
    if (b.honkTimer > 0) b.honkTimer -= dt;
    const byPlayer = blocker !== null && (blocker.kind === 'player' || (blocker.kind === 'vehicle' && (blocker as Vehicle).occupiedByPlayer));
    if (b.blockedTimer > T.honkAfter && byPlayer && b.honkTimer <= 0 && this.events && this.rng) {
      this.events.emit('horn', { vehicleId: v.id, x: v.curr.x, z: v.curr.z });
      v.hornTimer = 0.5;
      b.honkTimer = this.rng.range(T.honkCooldownMin, T.honkCooldownMax);
      this.stats.honks++;
    }
    if (b.blockedTimer > T.blockedTimeout && !inView) { this.stats.blockedDespawns++; this.remove(v); return true; }
    if (b.blockedTimer > T.unstickAfter && !byPlayer && mode === 0 && (blocker === null || blocker.kind === 'vehicle')) {
      // Nothing sensed (static/wreck) -> back up; a stationary car -> pass on the left.
      b.decideTick = this.blockerStationaryCar ? tick + T.bypassTicks : -(tick + T.reverseTicks);
      b.blockedTimer = 0;
    }
    return false;
  }

  /**
   * Car-following / ped braking: scans a corridor scanLen ahead (scanHalfW half width) through the dynamic hash.
   * Same-heading vehicles and stationary cars are followed (gap-based), peds and the on-foot player in the cone
   * cap the speed and force a stop inside pedConeLen. Returns the speed cap and stores the closest blocker.
   */
  private scanAhead(v: Vehicle, bypass: boolean): number {
    const world = this.world;
    if (!world) return Infinity;
    const T = TRAFFIC_TUNING;
    const inTurn = v.brain !== null && (v.brain as TrafficBrain).inTurn;
    const yaw = v.curr.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const hl = v.spec.length * 0.5;
    const ax = v.curr.x + fx * hl, az = v.curr.z + fz * hl;
    const bx = ax + fx * T.scanLen, bz = az + fz * T.scanLen;
    const qx = inTurn ? v.curr.x - fx * hl : ax, qz = inTurn ? v.curr.z - fz * hl : az;
    const n = world.dynamicHash.querySegment(qx, qz, bx, bz, T.scanHalfW, this.scanOut);
    let cap = Infinity;
    let bestGap = Infinity;
    let bestRel = 0;
    this.blocker = null;
    this.blockerStationaryCar = false;
    const playerDriving = world.player.vehicleId !== null;
    for (let i = 0; i < n; i++) {
      const e = this.scanOut[i];
      if (e === v || !e.alive) continue;
      const wx = e.curr.x - ax, wz = e.curr.z - az;
      const lz = wx * fx + wz * fz;
      const lx = wx * rx + wz * rz;
      let gap: number;
      let relSpeed = 0;
      let stationaryCar = false;
      if (e.kind === 'vehicle') {
        const o = e as Vehicle;
        const oyaw = o.curr.yaw;
        const ofx = Math.sin(oyaw), ofz = Math.cos(oyaw);
        const along = Math.abs(ofx * fx + ofz * fz);
        const ext = along * o.spec.length * 0.5 + (1 - along) * o.spec.width * 0.5;
        if (lz < -ext || lz > T.scanLen + ext) continue;
        if (Math.abs(lx) > T.scanHalfW + o.spec.width * 0.25) continue;
        const sameHeading = Math.abs(angleDiff(yaw, oyaw)) < 0.8;
        const oSpeed = Math.abs(o.speed);
        if (!sameHeading && oSpeed > 1) continue; // crossing traffic is handled by reservations
        stationaryCar = oSpeed < 0.5 && (o.brain === null || o.destroyed) && !o.occupiedByPlayer;
        if (bypass && stationaryCar) continue;
        gap = lz - ext;
        relSpeed = v.speed - (o.vx * fx + o.vz * fz);
      } else {
        if (e.kind === 'player' && playerDriving) continue;
        const r = 0.4;
        // A turning car also yields to peds beside it (its swinging body would sweep them).
        const back = inTurn ? -hl * 2 : -r;
        if (lz < back || lz > T.scanLen) continue;
        if (Math.abs(lx) > T.scanHalfW + r) continue;
        const dist = Math.sqrt(lz * lz + lx * lx);
        if (!inTurn && dist > 1.5 && lz / dist < T.pedConeDot) continue; // in a turn the whole corridor counts
        gap = lz - r;
        if (gap < T.pedConeLen) cap = 0;
      }
      if (gap < bestGap) { bestGap = gap; bestRel = relSpeed; this.blocker = e; this.blockerStationaryCar = stationaryCar; }
    }
    if (bestGap < Infinity) {
      const need = T.followGapBase + T.followGapPerMs * Math.max(0, bestRel);
      const c = bestGap < 2 ? 0 : Math.max(0, (bestGap - need) * 1.5);
      if (c < cap) cap = c;
    }
    return cap;
  }

  /** A police car with its siren on within sirenYieldDist behind us -> yield (pull right, slow down). */
  private checkSiren(v: Vehicle, b: TrafficBrain): void {
    const world = this.world;
    if (!world || !this.sirenPresent) return;
    const T = TRAFFIC_TUNING;
    const fx = Math.sin(v.curr.yaw), fz = Math.cos(v.curr.yaw);
    const list = world.vehicleList;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.sirenOn || p === v) continue;
      const dx = p.curr.x - v.curr.x, dz = p.curr.z - v.curr.z;
      if (dx * dx + dz * dz > T.sirenYieldDist * T.sirenYieldDist) continue;
      if (dx * fx + dz * fz < 0) { b.yieldTimer = T.yieldTime; return; }
    }
  }

  private anySiren(): boolean {
    const world = this.world;
    if (!world) return false;
    const list = world.vehicleList;
    for (let i = 0; i < list.length; i++) if (list[i].sirenOn) return true;
    return false;
  }

  // ---- spawn / despawn ----

  private isNight(): boolean {
    const h = this.world ? this.world.time.hour : 12;
    return h >= TRAFFIC_TUNING.nightStart || h < TRAFFIC_TUNING.nightEnd;
  }

  /** Hidden rule: not in view OR beyond spawnAheadMin; no entity within spawnClearRadius; budget asserted. */
  private trySpawn(rMin = TRAFFIC_TUNING.spawnMin, rMax = TRAFFIC_TUNING.spawnMax, ignoreView = false, fade = 0): boolean {
    const world = this.world;
    const camera = this.camera;
    const rng = this.rng;
    if (!world || !camera || !rng) return false;
    const T = TRAFFIC_TUNING;
    if (world.vehicleList.length >= BUDGET.MAX_VEHICLES) return false;
    const roads = world.roads;
    const n = roads.lanesInRing(this.ppos.x, this.ppos.z, rMin, rMax, this.laneOut);
    if (n === 0) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const laneId = this.laneOut[rng.int(0, n - 1)];
      const lane = roads.lanes[laneId];
      const t = rng.range(6, Math.max(6, lane.length - 6));
      roads.pointOnLane(laneId, t, target);
      const dx = target.x - this.ppos.x, dz = target.z - this.ppos.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (!ignoreView && camera.isInView(target.x, target.z) && d < T.spawnAheadMin) continue;
      if (world.dynamicHash.queryCircle(target.x, target.z, T.spawnClearRadius, this.clearOut) > 0) continue;
      const key = pickTrafficKey(rng);
      const spec = SPECS[key];
      const v = new Vehicle(spec, target.x, target.z, yawFromDir(lane.dir.x, lane.dir.z), 'traffic', rng.pick(spec.colors));
      const b = makeTrafficBrain();
      b.lane = laneId;
      b.t = t;
      b.targetSpeed = rng.range(T.cruiseMin, T.cruiseMax);
      v.brain = b;
      v.spawnFade = fade;
      v.vx = lane.dir.x * T.spawnSpeed;
      v.vz = lane.dir.z * T.spawnSpeed;
      v.speed = T.spawnSpeed;
      v.lightsOn = this.isNight();
      v.controls.headlights = v.lightsOn;
      world.addVehicle(v);
      this.stats.spawned++;
      return true;
    }
    return false;
  }

  /** One-off fill of traffic around the player (newGame/respawn): ignores the in-view rule so the street is alive from the first frame. */
  prefill(): number {
    const world = this.world;
    if (!world) return 0;
    world.playerPos(this.ppos);
    const T = TRAFFIC_TUNING;
    const want = Math.min(T.targetCount, T.prefillCount);
    let made = 0;
    for (let i = 0; i < want * 3 && made < want; i++) if (this.trySpawn(T.prefillMin, T.prefillMax, true, 1)) made++;
    return made;
  }

  private remove(v: Vehicle): void {
    const world = this.world;
    if (!world) return;
    world.roads.releaseAll(v.id);
    world.removeVehicle(v.id);
    this.stats.despawned++;
  }

  /** Abandoned cars go away beyond abandonedDespawn (never the mission vehicle, never the player's). */
  private despawnAbandoned(v: Vehicle): boolean {
    const world = this.world;
    if (!world || v.occupiedByPlayer || v.id === world.mission.missionVehicleId) return false;
    const T = TRAFFIC_TUNING;
    const dx = v.curr.x - this.ppos.x, dz = v.curr.z - this.ppos.z;
    if (dx * dx + dz * dz <= T.abandonedDespawn * T.abandonedDespawn) return false;
    this.remove(v);
    return true;
  }

  /** Fills every city.parkedSpots with a sleeping parked car (role 'parked', brain null). Call at newGame. */
  spawnParkedCars(): number {
    const world = this.world;
    const rng = this.rng;
    if (!world || !rng) return 0;
    const spots = world.city.parkedSpots;
    let n = 0;
    for (let i = 0; i < spots.length; i++) {
      if (world.vehicleList.length >= BUDGET.MAX_VEHICLES) break;
      const s = spots[i];
      const spec = SPECS[pickTrafficKey(rng)];
      const v = new Vehicle(spec, s.x, s.z, s.yaw, 'parked', rng.pick(spec.colors));
      v.brain = null;
      v.sleeping = true;
      v.idleTimer = 2;
      world.addVehicle(v);
      n++;
    }
    return n;
  }

  dispose(): void {
    if (this.events) {
      this.events.off('player:enterVehicle', this.onEnterVehicle);
      this.events.off('vehicle:destroyed', this.onDestroyed);
    }
  }
}
