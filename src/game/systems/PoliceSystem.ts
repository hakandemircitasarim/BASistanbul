// Police AI: star-scaled unit spawning, A* PATH driving to the last known player position, whisker-steered PURSUE with ramming, BUST timers, stuck reverse, RETURN/despawn, sirens. Track F.
import type { AudioLike, CameraLike, EngineContext, System } from './System';
import type { World } from '../world/World';
import type { EventBus } from '../core/EventBus';
import type { Random } from '../core/Random';
import type { Vec2 } from '../core/Types';
import type { Entity } from '../entities/Entity';
import type { Lane } from '../city/RoadGraph';
import type { Circle, Manifold, OBB, StaticCollider } from '../core/Collision';
import { circleVsObb, obbVsObb, segmentVsAabb, segmentVsCircle } from '../core/Collision';
import { Vehicle, makePoliceBrain } from '../entities/Vehicle';
import type { PoliceBrain, TrafficBrain } from '../entities/Vehicle';
import { SPECS } from '../entities/VehicleSpecs';
import { BUDGET } from '../core/Budget';
import { angleDiff, clamp, yawFromDir } from '../core/math';
import { TrafficSystem, TRAFFIC_DRIVE, chooseNextWeighted } from './TrafficSystem';
import type { ChooseNext, DriveOptions } from './TrafficSystem';
import { WANTED_TUNING } from './WantedSystem';

export const POLICE_TUNING = {
  spawnMin: 90, spawnMax: 160, spawnAheadMin: 220, despawnDist: 320, repathInterval: 1.5, pursueRange: 50, losePursuitRange: 90,
  predictTime: 0.5, ramSpeed: 20, bustRadiusFoot: 3.5, bustRadiusCar: 4.5, bustPlayerMaxSpeed: 1.5, bustTime: 2.0, bustTimeCar: 3.0,
  stuckTime: 3, reverseTime: 1.2, laneSpeed: 24, whiskerLen: 12, whiskerAngle: 0.44, returnTime: 10, evictAfter: 1.5,
  // Extras (not in the spec table)
  spawnInterval: 0.7, replaceDelay: 20, loseSightTime: 4, spawnClearRadius: 12, spawnSpeed: 10, hardDespawn: 420, wreckDespawn: 25,
  footApproach: 3.0, footStopDist: 6, creepSpeed: 1.3, brakeDecel: 9, scanLen: 24, scanHalfW: 2.2, followGap: 5, pedStopGap: 5,
  whiskerBrakeDist: 8, whiskerBrakeMinSpeed: 2.5, returnSpeed: 12, pursueNotifyCooldown: 20, searchRadius: 40,
  nightStart: 18.5, nightEnd: 6.5,
};

export const NOTIFY_PURSUIT = 'Polis peşinde!';
const POLICE_DRIVE: DriveOptions = { obeyStops: false, obeyLimit: false, evictAfter: POLICE_TUNING.evictAfter };
const MAX_PATH = 64;

export class PoliceSystem implements System {
  readonly name = 'Police';
  readonly stats = { spawned: 0, despawned: 0, busts: 0, pursuits: 0 };
  /** Tests may switch the spawner off ("police despawned" scenarios). */
  spawnEnabled = true;
  /** Last position where a unit saw the player (or where the last crime happened). */
  lastKnownX = 0;
  lastKnownZ = 0;
  private lastKnownValid = false;
  private world: World | null = null;
  private events: EventBus | null = null;
  private camera: CameraLike | null = null;
  private audio: AudioLike | null = null;
  private rng: Random | null = null;
  private spawnTimer = 0.2;
  private bustEmitted = false;
  private pursuitNotifyTimer = 0;
  private currentBrain: PoliceBrain | null = null;
  private readonly ppos: Vec2 = { x: 0, z: 0 };
  private readonly laneOut: number[] = [];
  private readonly clearOut: Entity[] = [];
  private readonly scanOut: Entity[] = [];
  private readonly staticOut: StaticCollider[] = [];
  private readonly nodePath: number[] = new Array<number>(256).fill(-1);
  private readonly lanePath: number[] = new Array<number>(256).fill(-1);
  private readonly sirenPos: Vec2[] = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
  private readonly replaceTimers: number[] = new Array<number>(BUDGET.POLICE_MAX).fill(0);
  private readonly obbA: OBB = { cx: 0, cz: 0, hw: 0, hl: 0, yaw: 0 };
  private readonly obbB: OBB = { cx: 0, cz: 0, hw: 0, hl: 0, yaw: 0 };
  private readonly circle: Circle = { cx: 0, cz: 0, r: 0 };
  private readonly manifold: Manifold = { nx: 0, nz: 0, depth: 0 };
  private readonly target: Vec2 = { x: 0, z: 0 };
  private readonly whiskerHits = [1, 1, 1];

  init(ctx: EngineContext): void {
    this.world = ctx.world;
    this.events = ctx.events;
    this.camera = ctx.camera;
    this.audio = ctx.audio;
    this.rng = ctx.rng;
    ctx.events.on('vehicle:destroyed', this.onDestroyed);
    ctx.events.on('wanted:changed', this.onWanted);
    ctx.events.on('player:respawn', this.onRespawn);
  }

  dispose(): void {
    const ev = this.events;
    if (!ev) return;
    ev.off('vehicle:destroyed', this.onDestroyed);
    ev.off('wanted:changed', this.onWanted);
    ev.off('player:respawn', this.onRespawn);
  }

  private readonly onDestroyed = (p: { id: number }): void => {
    const world = this.world;
    if (!world) return;
    const v = world.vehicles.get(p.id);
    if (!v || v.role !== 'police') return;
    world.roads.releaseAll(v.id);
    for (let i = 0; i < this.replaceTimers.length; i++) if (this.replaceTimers[i] <= 0) { this.replaceTimers[i] = POLICE_TUNING.replaceDelay; break; }
  };

  /** A star gain marks the crime scene as the last known position. */
  private readonly onWanted = (p: { stars: number; prev: number }): void => {
    const world = this.world;
    if (!world) return;
    if (p.stars > p.prev) { this.lastKnownX = world.player.curr.x; this.lastKnownZ = world.player.curr.z; this.lastKnownValid = true; }
    if (p.stars === 0) this.lastKnownValid = false;
  };

  private readonly onRespawn = (): void => {
    this.bustEmitted = false;
    this.lastKnownValid = false;
  };

  /** Removes every police unit (tests / scene resets). */
  despawnAll(): void {
    const world = this.world;
    if (!world) return;
    const list = world.vehicleList;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'police') this.remove(list[i]);
  }

  policeCount(): number {
    return this.world ? this.world.countByRole('police') : 0;
  }

  // ---- per tick ----

  fixedUpdate(dt: number): void {
    const world = this.world;
    if (!world) return;
    const T = POLICE_TUNING;
    const stars = world.wanted.stars;
    world.playerPos(this.ppos);
    if (this.pursuitNotifyTimer > 0) this.pursuitNotifyTimer -= dt;
    let pending = 0;
    for (let i = 0; i < this.replaceTimers.length; i++) {
      if (this.replaceTimers[i] > 0) { this.replaceTimers[i] -= dt; if (this.replaceTimers[i] > 0) pending++; }
    }
    const list = world.vehicleList;
    let active = 0;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.role !== 'police') continue;
      if (this.updateUnit(v, dt, stars)) { i--; continue; }
      if (!v.destroyed && (v.brain as PoliceBrain).mode !== 'RETURN') active++;
    }
    this.feedSirens();
    const desired = Math.min(BUDGET.POLICE_MAX, WANTED_TUNING.policePerStar[Math.min(stars, WANTED_TUNING.policePerStar.length - 1)]);
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = T.spawnInterval;
      if (this.spawnEnabled && stars > 0 && active + pending < desired) this.trySpawn();
    }
  }

  /** Returns true when the unit was removed. */
  private updateUnit(v: Vehicle, dt: number, stars: number): boolean {
    const world = this.world;
    const camera = this.camera;
    if (!world || !camera) return false;
    const T = POLICE_TUNING;
    const dx = v.curr.x - this.ppos.x, dz = v.curr.z - this.ppos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const inView = camera.isInView(v.curr.x, v.curr.z);
    if (dist > T.hardDespawn || (dist > T.despawnDist && !inView)) { this.remove(v); return true; }
    if (v.destroyed) {
      v.sirenOn = false;
      if (v.wreckTimer > T.wreckDespawn && !inView) { this.remove(v); return true; }
      return false;
    }
    if (v.brain === null || !('mode' in v.brain)) {
      const nb = makePoliceBrain();
      nb.traffic.targetSpeed = T.laneSpeed;
      v.brain = nb;
    }
    const b = v.brain as PoliceBrain;
    const now = world.time.elapsed;
    const c = v.controls;
    c.horn = false;

    // Star transitions: 0 -> everyone returns; > 0 -> returning units rejoin.
    if (stars === 0 && b.mode !== 'RETURN') { b.mode = 'RETURN'; b.returnTimer = T.returnTime; b.bustTimer = 0; b.traffic.targetSpeed = T.returnSpeed; }
    else if (stars > 0 && b.mode === 'RETURN') { b.mode = 'PATH'; b.repathTimer = 0; b.traffic.targetSpeed = T.laneSpeed; }

    // Sight bookkeeping (any unit within sightRange with LOS refreshes the last known position).
    const los = dist < WANTED_TUNING.sightRange && world.hasLineOfSight(v.curr.x, v.curr.z, this.ppos.x, this.ppos.z);
    if (los && b.mode !== 'RETURN') { this.lastKnownX = this.ppos.x; this.lastKnownZ = this.ppos.z; this.lastKnownValid = true; }

    // Stuck -> reverse with the opposite steer.
    if (b.reverseTimer > 0) {
      b.reverseTimer -= dt;
      c.throttle = -0.7; c.brake = 0; c.handbrake = false;
      if (b.reverseTimer <= 0) { b.stuckTimer = 0; c.steer = 0; }
      b.siren = b.mode !== 'RETURN';
      v.sirenOn = b.siren;
      return false;
    }

    if (b.mode === 'RETURN') this.driveReturn(v, b, dt, now, inView);
    else if (b.mode === 'PATH') this.drivePath(v, b, dt, now, dist, los);
    else this.drivePursue(v, b, dt, dist, los);
    if (!v.alive) return true;

    if (b.mode !== 'RETURN' && Math.abs(v.speed) < 0.5 && c.throttle > 0.3) {
      b.stuckTimer += dt;
      if (b.stuckTimer > T.stuckTime) { b.reverseTimer = T.reverseTime; c.steer = -c.steer; b.stuckTimer = 0; }
    } else if (b.stuckTimer > 0) b.stuckTimer = Math.max(0, b.stuckTimer - dt);

    b.siren = b.mode !== 'RETURN';
    v.sirenOn = b.siren;
    return false;
  }

  // ---- PATH ----

  /** Successor choice that follows the brain's lane path (-1 lets driveAlongLane take the first successor). */
  private readonly followPath: ChooseNext = (b: TrafficBrain, lane: Lane, rng: Random): number => {
    const pb = this.currentBrain;
    if (!pb) return chooseNextWeighted(b, lane, rng);
    while (pb.pathIdx < pb.pathLen && pb.path[pb.pathIdx] === b.lane) pb.pathIdx++;
    if (pb.pathIdx < pb.pathLen) {
      const cand = pb.path[pb.pathIdx];
      for (let i = 0; i < lane.next.length; i++) if (lane.next[i] === cand) return cand;
    }
    return chooseNextWeighted(b, lane, rng);
  };

  private drivePath(v: Vehicle, b: PoliceBrain, dt: number, now: number, dist: number, los: boolean): void {
    const world = this.world;
    if (!world) return;
    const T = POLICE_TUNING;
    if (dist < T.pursueRange && los) { this.enterPursue(b); this.drivePursue(v, b, dt, dist, los); return; }
    const tb = b.traffic;
    if (tb.lane < 0) TrafficSystem.acquireLane(v, tb, world.roads);
    b.repathTimer -= dt;
    if (b.repathTimer <= 0 || b.pathLen === 0) { b.repathTimer = T.repathInterval; this.repath(v, b); }
    tb.targetSpeed = T.laneSpeed;
    const cap = this.scanAhead(v);
    this.currentBrain = b;
    TrafficSystem.driveAlongLane(v, tb, world.roads, world, dt, now, this.followPath, cap, POLICE_DRIVE, 0);
    this.currentBrain = null;
  }

  /** A* from the node ahead to the node nearest the last known player position (or a search node around it). */
  private repath(v: Vehicle, b: PoliceBrain): void {
    const world = this.world;
    const rng = this.rng;
    if (!world || !rng) return;
    const roads = world.roads;
    const tb = b.traffic;
    const curLane = tb.inTurn && tb.nextLane >= 0 ? tb.nextLane : tb.lane;
    if (curLane < 0) return;
    const fromNode = roads.lanes[curLane].to;
    const gx = this.lastKnownValid ? this.lastKnownX : this.ppos.x;
    const gz = this.lastKnownValid ? this.lastKnownZ : this.ppos.z;
    let target = roads.nearestNode(gx, gz);
    const ddx = v.curr.x - gx, ddz = v.curr.z - gz;
    if (ddx * ddx + ddz * ddz < POLICE_TUNING.searchRadius * POLICE_TUNING.searchRadius) {
      // Reached the last known position without a sighting: search a nearby intersection.
      const col = clamp(target.col + rng.int(-2, 2), 0, roads.cols);
      const row = clamp(target.row + rng.int(-2, 2), 0, roads.rows);
      target = roads.nodeAt(col, row);
    }
    const n = roads.findPath(fromNode, target.id, this.nodePath);
    const m = n > 0 ? roads.lanePathFromNodePath(curLane, this.nodePath, n, this.lanePath) : 0;
    const count = Math.min(m, MAX_PATH);
    for (let i = 0; i < count; i++) b.path[i] = this.lanePath[i];
    b.pathLen = count;
    b.pathIdx = 0;
    // Re-choose the successor unless the car is already committed to a turn or holds a reservation.
    if (!tb.inTurn && tb.reservedNode < 0 && count > 0 && tb.nextLane !== b.path[0]) tb.nextLane = -1;
  }

  /** Corridor scan for same-heading/stationary vehicles and peds ahead; returns a speed cap (Infinity = free). */
  private scanAhead(v: Vehicle): number {
    const world = this.world;
    if (!world) return Infinity;
    const T = POLICE_TUNING;
    const yaw = v.curr.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const hl = v.spec.length * 0.5;
    const ax = v.curr.x + fx * hl, az = v.curr.z + fz * hl;
    const n = world.dynamicHash.querySegment(ax, az, ax + fx * T.scanLen, az + fz * T.scanLen, T.scanHalfW, this.scanOut);
    let cap = Infinity;
    const pv = world.playerVehicle();
    for (let i = 0; i < n; i++) {
      const e = this.scanOut[i];
      if (e === v || !e.alive || e.kind === 'player' || e === pv) continue;
      const wx = e.curr.x - ax, wz = e.curr.z - az;
      const lz = wx * fx + wz * fz;
      const lx = wx * rx + wz * rz;
      let gap: number;
      if (e.kind === 'vehicle') {
        const o = e as Vehicle;
        const ofx = Math.sin(o.curr.yaw), ofz = Math.cos(o.curr.yaw);
        const along = Math.abs(ofx * fx + ofz * fz);
        const ext = along * o.spec.length * 0.5 + (1 - along) * o.spec.width * 0.5;
        if (lz < -ext || lz > T.scanLen + ext) continue;
        if (Math.abs(lx) > T.scanHalfW + o.spec.width * 0.25) continue;
        if (Math.abs(angleDiff(yaw, o.curr.yaw)) > 0.8 && Math.abs(o.speed) > 1) continue;
        gap = lz - ext;
        const rel = Math.max(0, v.speed - (o.vx * fx + o.vz * fz));
        const c = gap < 2.5 ? 0 : Math.max(0, (gap - T.followGap - rel * 0.6) * 1.8);
        if (c < cap) cap = c;
      } else {
        if (lz < -0.4 || lz > T.scanLen || Math.abs(lx) > T.scanHalfW + 0.4) continue;
        gap = lz - 0.4;
        const c = gap < T.pedStopGap ? 0 : Math.max(0, (gap - T.pedStopGap) * 1.5);
        if (c < cap) cap = c;
      }
    }
    return cap;
  }

  // ---- PURSUE / BUST ----

  private enterPursue(b: PoliceBrain): void {
    b.mode = 'PURSUE';
    b.sightTimer = 0;
    b.bustTimer = 0;
    this.stats.pursuits++;
    if (this.pursuitNotifyTimer <= 0 && this.events) {
      this.pursuitNotifyTimer = POLICE_TUNING.pursueNotifyCooldown;
      this.events.emit('notify', { text: NOTIFY_PURSUIT, kind: 'police' });
    }
  }

  private drivePursue(v: Vehicle, b: PoliceBrain, dt: number, dist: number, los: boolean): void {
    const world = this.world;
    if (!world) return;
    const T = POLICE_TUNING;
    if (los) b.sightTimer = 0; else b.sightTimer += dt;
    if (dist > T.losePursuitRange || b.sightTimer > T.loseSightTime) {
      b.mode = 'PATH'; b.repathTimer = 0; b.bustTimer = 0;
      world.roads.releaseAll(v.id);
      TrafficSystem.acquireLane(v, b.traffic, world.roads);
      return;
    }
    const p = world.player;
    const pv = world.playerVehicle();
    const onFoot = pv === null;
    const c = v.controls;

    // Bust condition (expanded police OBB vs the player's circle / car OBB).
    const inBustRange = this.withinBust(v, pv);
    const busting = inBustRange && (onFoot ? Math.abs(v.speed) < 1.5 : Math.abs(pv.speed) < T.bustPlayerMaxSpeed);
    if (busting && p.alive) {
      b.mode = 'BUST';
      b.bustTimer += dt;
      c.throttle = 0; c.brake = 1; c.steer = 0; c.handbrake = true;
      if (b.bustTimer >= (onFoot ? T.bustTime : T.bustTimeCar) && !this.bustEmitted && this.events) {
        this.bustEmitted = true;
        this.stats.busts++;
        this.events.emit('player:busted', { reason: 'busted' });
      }
      return;
    }
    if (b.mode === 'BUST') { b.mode = 'PURSUE'; b.bustTimer = 0; }

    // Predictive target and whisker avoidance.
    const tx = this.ppos.x + p.vx * T.predictTime, tz = this.ppos.z + p.vz * T.predictTime;
    const yaw = v.curr.yaw;
    const err = angleDiff(yaw, yawFromDir(tx - v.curr.x, tz - v.curr.z));
    let steer = clamp(err * 2.0, -1, 1);
    this.castWhiskers(v, pv);
    const hL = this.whiskerHits[0], hC = this.whiskerHits[1], hR = this.whiskerHits[2];
    steer += (hR - hL) * 1.2;
    if (hC < 1) steer += (hL >= hR ? 1 : -1) * (1 - hC) * 0.8;
    c.steer = clamp(steer, -1, 1);
    c.handbrake = false;

    // Speed target.
    let want: number;
    const maxSpeed = v.spec.maxSpeed;
    if (onFoot) {
      if (dist < T.footStopDist) want = dist < T.footApproach || inBustRange ? 0 : T.creepSpeed;
      else want = Math.min(maxSpeed, Math.sqrt(2 * T.brakeDecel * (dist - T.footApproach)));
    } else if (Math.abs(pv.speed) < T.bustPlayerMaxSpeed) {
      want = inBustRange ? 0 : Math.min(maxSpeed, Math.sqrt(2 * T.brakeDecel * Math.max(0, dist - 4.5)));
    } else {
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const rvx = v.vx - p.vx, rvz = v.vz - p.vz;
      const toX = this.ppos.x - v.curr.x, toZ = this.ppos.z - v.curr.z;
      const closing = rvx * toX + rvz * toZ > 0 && fx * toX + fz * toZ > 0;
      want = closing ? maxSpeed : T.ramSpeed;
    }
    // Facing away at low speed: let the steer work (reverse handles true stalls).
    if (Math.abs(err) > 2.2 && dist > T.footStopDist) want = Math.min(want, 6);
    const sp = v.speed;
    const e = want - sp;
    if (want <= 0.05 && sp < 0.5) { c.throttle = 0; c.brake = 1; }
    else if (e > -0.3) { c.throttle = clamp(0.3 + e * 0.5, 0, 1); c.brake = 0; }
    else { c.throttle = 0; c.brake = clamp(-e * 0.3, 0.2, 1); }
    if (hC * T.whiskerLen < T.whiskerBrakeDist && sp > T.whiskerBrakeMinSpeed) { c.throttle = 0; c.brake = Math.max(c.brake, 0.5); }
  }

  /** Expanded police OBB (by the bust radius) overlaps the player's circle (on foot) or car OBB. */
  private withinBust(v: Vehicle, pv: Vehicle | null): boolean {
    const world = this.world;
    if (!world) return false;
    const T = POLICE_TUNING;
    const o = v.obb(this.obbA);
    if (pv === null) {
      o.hw += T.bustRadiusFoot; o.hl += T.bustRadiusFoot;
      return circleVsObb(world.player.circle(this.circle), o, this.manifold);
    }
    o.hw += T.bustRadiusCar; o.hl += T.bustRadiusCar;
    return obbVsObb(o, pv.obb(this.obbB), this.manifold);
  }

  /** Three whiskers from the front bumper; whiskerHits[i] = hit fraction 0..1 (1 = clear). */
  private castWhiskers(v: Vehicle, pv: Vehicle | null): void {
    const world = this.world;
    if (!world) return;
    const T = POLICE_TUNING;
    const hl = v.spec.length * 0.5, hw = v.spec.width * 0.5;
    const yaw = v.curr.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const ax = v.curr.x + fx * hl, az = v.curr.z + fz * hl;
    for (let k = 0; k < 3; k++) {
      const a = yaw + (k - 1) * T.whiskerAngle;
      const dxw = Math.sin(a), dzw = Math.cos(a);
      const bx = ax + dxw * T.whiskerLen, bz = az + dzw * T.whiskerLen;
      let best = 1;
      const ns = world.staticHash.querySegment(ax, az, bx, bz, 1, this.staticOut);
      for (let i = 0; i < ns; i++) {
        const s = this.staticOut[i].shape;
        const t = s.kind === 'aabb' ? segmentVsAabb(ax, az, bx, bz, s) : segmentVsCircle(ax, az, bx, bz, s);
        if (t >= 0 && t < best) best = t;
      }
      const nd = world.dynamicHash.querySegment(ax, az, bx, bz, 1.5, this.scanOut);
      for (let i = 0; i < nd; i++) {
        const e = this.scanOut[i];
        if (e === v || !e.alive || e.kind === 'player' || e === pv) continue;
        const wx = e.curr.x - ax, wz = e.curr.z - az;
        const lz = wx * dxw + wz * dzw;
        const lx = Math.abs(-wx * dzw + wz * dxw);
        let ext = 0.4, half = 0.35;
        if (e.kind === 'vehicle') { const o = e as Vehicle; ext = o.spec.length * 0.5; half = o.spec.width * 0.5; }
        if (lz < -ext || lz > T.whiskerLen + ext || lx > half + hw) continue;
        const t = Math.max(0, lz - ext) / T.whiskerLen;
        if (t < best) best = t;
      }
      this.whiskerHits[k] = best;
    }
  }

  // ---- RETURN ----

  private driveReturn(v: Vehicle, b: PoliceBrain, dt: number, now: number, inView: boolean): void {
    const world = this.world;
    if (!world) return;
    b.returnTimer -= dt;
    if (b.returnTimer <= 0 && !inView) { this.remove(v); return; }
    const tb = b.traffic;
    tb.targetSpeed = POLICE_TUNING.returnSpeed;
    const cap = this.scanAhead(v);
    TrafficSystem.driveAlongLane(v, tb, world.roads, world, dt, now, chooseNextWeighted, cap, TRAFFIC_DRIVE, 0);
  }

  // ---- sirens / spawn / despawn ----

  /** The two nearest siren units feed the audio system. */
  private feedSirens(): void {
    const world = this.world;
    const audio = this.audio;
    if (!world || !audio) return;
    let n = 0;
    let d0 = Infinity, d1 = Infinity;
    const list = world.vehicleList;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.sirenOn) continue;
      const dx = v.curr.x - this.ppos.x, dz = v.curr.z - this.ppos.z;
      const d = dx * dx + dz * dz;
      if (d < d0) {
        d1 = d0; this.sirenPos[1].x = this.sirenPos[0].x; this.sirenPos[1].z = this.sirenPos[0].z;
        d0 = d; this.sirenPos[0].x = v.curr.x; this.sirenPos[0].z = v.curr.z;
      } else if (d < d1) {
        d1 = d; this.sirenPos[1].x = v.curr.x; this.sirenPos[1].z = v.curr.z;
      }
      if (n < 2) n++;
    }
    audio.setSirens(this.sirenPos, n);
  }

  private isNight(): boolean {
    const h = this.world ? this.world.time.hour : 12;
    return h >= POLICE_TUNING.nightStart || h < POLICE_TUNING.nightEnd;
  }

  /** Hidden spawn rule shared with traffic: not in view or beyond spawnAheadMin; clear radius; budget asserted. */
  private trySpawn(): void {
    const world = this.world;
    const camera = this.camera;
    const rng = this.rng;
    if (!world || !camera || !rng) return;
    const T = POLICE_TUNING;
    if (world.vehicleList.length >= BUDGET.MAX_VEHICLES || world.countByRole('police') >= BUDGET.POLICE_MAX) return;
    const roads = world.roads;
    const n = roads.lanesInRing(this.ppos.x, this.ppos.z, T.spawnMin, T.spawnMax, this.laneOut);
    if (n === 0) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const laneId = this.laneOut[rng.int(0, n - 1)];
      const lane = roads.lanes[laneId];
      const t = rng.range(6, Math.max(6, lane.length - 6));
      roads.pointOnLane(laneId, t, this.target);
      const dx = this.target.x - this.ppos.x, dz = this.target.z - this.ppos.z;
      if (camera.isInView(this.target.x, this.target.z) && Math.sqrt(dx * dx + dz * dz) < T.spawnAheadMin) continue;
      if (world.dynamicHash.queryCircle(this.target.x, this.target.z, T.spawnClearRadius, this.clearOut) > 0) continue;
      const spec = SPECS.police;
      const v = new Vehicle(spec, this.target.x, this.target.z, yawFromDir(lane.dir.x, lane.dir.z), 'police', spec.colors[0]);
      const b = makePoliceBrain();
      b.traffic.lane = laneId;
      b.traffic.t = t;
      b.traffic.targetSpeed = T.laneSpeed;
      b.mode = 'PATH';
      b.siren = true;
      v.brain = b;
      v.sirenOn = true;
      v.spawnFade = 0;
      v.vx = lane.dir.x * T.spawnSpeed;
      v.vz = lane.dir.z * T.spawnSpeed;
      v.speed = T.spawnSpeed;
      v.lightsOn = this.isNight();
      v.controls.headlights = v.lightsOn;
      world.addVehicle(v);
      this.stats.spawned++;
      return;
    }
  }

  private remove(v: Vehicle): void {
    const world = this.world;
    if (!world) return;
    world.roads.releaseAll(v.id);
    v.sirenOn = false;
    world.removeVehicle(v.id);
    this.stats.despawned++;
  }
}
