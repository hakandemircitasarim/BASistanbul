// The only place collisions are resolved: vehicle/vehicle, vehicle/ped+player, vehicle/static (+swept props), circle/static, player/vehicle. Track C.
import type { EngineContext, System } from './System';
import type { World } from '../world/World';
import type { EventBus } from '../core/EventBus';
import type { Vehicle } from '../entities/Vehicle';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Player } from '../entities/Player';
import type { Entity } from '../entities/Entity';
import type { AABB, Circle, Manifold, OBB, StaticCollider } from '../core/Collision';
import { circleVsObb, obbBounds, obbVsObb, segmentVsCircle, staticVsCircle, staticVsObb } from '../core/Collision';
import { clamp } from '../core/math';
import { damagePlayer, PLAYER_TUNING } from './PlayerMoveSystem';

export const COLLISION_TUNING = {
  restitutionStatic: 0.2, restitutionVehicle: 0.3, damageMinSpeed: 3, damagePerMs: 2.5,
  pedHitSpeed: 3.5, pedDamagePerMs: 8, pedKillSpeed: 9, playerHitSpeed: 4, playerDamagePerMs: 6,
  sweepSpeed: 15, iterations: 2, angularKick: 0.35, maxYawRate: 2.5,
  tangentialKeep: 0.92, queryPad: 0.6, playerInvuln: 0.5, sweepSink: 0.06,
};

export class CollisionSystem implements System {
  readonly name = 'Collision';
  private world: World | null = null;
  private events: EventBus | null = null;
  private readonly obbA: OBB = { cx: 0, cz: 0, hw: 0, hl: 0, yaw: 0 };
  private readonly obbB: OBB = { cx: 0, cz: 0, hw: 0, hl: 0, yaw: 0 };
  private readonly circle: Circle = { cx: 0, cz: 0, r: 0 };
  private readonly sweep: Circle = { cx: 0, cz: 0, r: 0 };
  private readonly m: Manifold = { nx: 0, nz: 0, depth: 0 };
  private readonly bounds: AABB = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  private readonly dynOut: Entity[] = [];
  private readonly staticOut: StaticCollider[] = [];
  private readonly sweepOut: StaticCollider[] = [];

  init(ctx: EngineContext): void {
    this.world = ctx.world;
    this.events = ctx.events;
  }

  fixedUpdate(dt: number): void {
    const world = this.world;
    if (!world) return;
    world.rebuildDynamicHash();
    this.vehicleVsVehicle();
    this.vehicleVsCircles();
    this.vehicleVsStatic(true);
    this.vehicleVsStatic(false);
    this.circlesVsStatic();
    this.playerVsVehicle();
    void dt;
  }

  // ---- helpers ----

  /** Re-derives the body-frame speeds after an impulse so HUD/AI see consistent values this tick. */
  private static syncBodyVel(v: Vehicle): void {
    const fx = Math.sin(v.curr.yaw), fz = Math.cos(v.curr.yaw);
    v.speed = v.vx * fx + v.vz * fz;
    v.lateral = v.vx * -fz + v.vz * fx;
  }

  /** Angular kick from an impulse of strength `impact` along (nx, nz) applied at world point (px, pz). */
  private static kick(v: Vehicle, px: number, pz: number, nx: number, nz: number, impact: number): void {
    const T = COLLISION_TUNING;
    const rx = px - v.curr.x, rz = pz - v.curr.z;
    const torque = rz * nx - rx * nz;
    const dw = (T.angularKick * torque * impact) / (v.spec.length * 0.75);
    v.yawRate = clamp(v.yawRate + dw, -T.maxYawRate, T.maxYawRate);
  }

  private applyVehicleDamage(v: Vehicle, dmg: number, byPlayer: boolean): void {
    if (dmg <= 0) return;
    const was = v.destroyed;
    v.applyDamage(dmg);
    if (!was && v.destroyed && this.events) {
      this.events.emit('vehicle:destroyed', { id: v.id, byPlayer, x: v.curr.x, z: v.curr.z });
    }
  }

  private wake(v: Vehicle): void {
    v.sleeping = false;
    v.idleTimer = 0;
  }

  // ---- vehicle vs vehicle ----

  private vehicleVsVehicle(): void {
    const world = this.world;
    if (!world) return;
    const list = world.vehicleList;
    const pad = COLLISION_TUNING.queryPad;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.sleeping || !a.alive) continue;
      a.obb(this.obbA);
      obbBounds(this.obbA, this.bounds);
      const n = world.dynamicHash.queryRect(this.bounds.minX - pad, this.bounds.minZ - pad, this.bounds.maxX + pad, this.bounds.maxZ + pad, this.dynOut);
      for (let k = 0; k < n; k++) {
        const e = this.dynOut[k];
        if (e.kind !== 'vehicle' || e === a) continue;
        const b = e as Vehicle;
        if (!b.alive) continue;
        if (!b.sleeping && b.id < a.id) continue; // awake pairs are handled once, from the lower id
        b.obb(this.obbB);
        if (!obbVsObb(this.obbA, this.obbB, this.m)) continue;
        this.resolvePair(a, b, this.m);
        a.obb(this.obbA);
      }
    }
  }

  private resolvePair(a: Vehicle, b: Vehicle, m: Manifold): void {
    const T = COLLISION_TUNING;
    const invA = 1 / a.spec.mass, invB = 1 / b.spec.mass;
    const total = invA + invB;
    const nx = m.nx, nz = m.nz;
    a.curr.x += (nx * m.depth * invA) / total;
    a.curr.z += (nz * m.depth * invA) / total;
    b.curr.x -= (nx * m.depth * invB) / total;
    b.curr.z -= (nz * m.depth * invB) / total;
    this.wake(a);
    this.wake(b);
    const rvx = a.vx - b.vx, rvz = a.vz - b.vz;
    const vn = rvx * nx + rvz * nz;
    if (vn >= 0) return; // separating
    const impact = -vn;
    const j = (-(1 + T.restitutionVehicle) * vn) / total;
    a.vx += j * nx * invA; a.vz += j * nz * invA;
    b.vx -= j * nx * invB; b.vz -= j * nz * invB;
    const cx = (a.curr.x + b.curr.x) * 0.5, cz = (a.curr.z + b.curr.z) * 0.5;
    CollisionSystem.kick(a, cx, cz, nx, nz, impact);
    CollisionSystem.kick(b, cx, cz, -nx, -nz, impact);
    CollisionSystem.syncBodyVel(a);
    CollisionSystem.syncBodyVel(b);
    let damage = 0;
    if (impact > T.damageMinSpeed) {
      damage = (impact - T.damageMinSpeed) * T.damagePerMs;
      const massSum = a.spec.mass + b.spec.mass;
      this.applyVehicleDamage(a, (damage * 2 * b.spec.mass) / massSum, b.occupiedByPlayer);
      this.applyVehicleDamage(b, (damage * 2 * a.spec.mass) / massSum, a.occupiedByPlayer);
    }
    const playerInvolved = a.occupiedByPlayer || b.occupiedByPlayer;
    if (this.events) {
      // Report the player's car as `a` so listeners can read bIsPolice directly.
      const first = b.occupiedByPlayer ? b : a;
      const second = b.occupiedByPlayer ? a : b;
      this.events.emit('vehicle:collision', { aId: first.id, bId: second.id, impactSpeed: impact, damage, x: cx, z: cz, playerInvolved, bIsPolice: second.isPolice() });
      if (playerInvolved) this.events.emit('camera:shake', { trauma: clamp(impact / 20, 0, 1) });
    }
  }

  // ---- vehicle vs peds / player on foot ----

  private vehicleVsCircles(): void {
    const world = this.world;
    if (!world) return;
    const T = COLLISION_TUNING;
    const list = world.vehicleList;
    const player = world.player;
    const playerOnFoot = player.vehicleId === null;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.alive) continue;
      v.obb(this.obbA);
      const n = world.dynamicHash.queryRect(v.minX, v.minZ, v.maxX, v.maxZ, this.dynOut);
      if (n === 0) continue;
      const vspeed = Math.sqrt(v.vx * v.vx + v.vz * v.vz);
      for (let k = 0; k < n; k++) {
        const e = this.dynOut[k];
        if (e.kind === 'vehicle') continue;
        if (e.kind === 'player' && !playerOnFoot) continue;
        if (e.kind === 'ped') (e as Pedestrian).circle(this.circle);
        else (e as Player).circle(this.circle);
        if (!circleVsObb(this.circle, this.obbA, this.m)) continue; // normal from the car toward the circle
        const m = this.m;
        e.curr.x += m.nx * m.depth;
        e.curr.z += m.nz * m.depth;
        if (e.kind === 'ped') this.hitPed(v, e as Pedestrian, vspeed);
        else this.hitPlayer(v, e as Player, vspeed, m.nx, m.nz);
      }
    }
  }

  private hitPed(v: Vehicle, ped: Pedestrian, vspeed: number): void {
    const T = COLLISION_TUNING;
    if (v.sleeping || vspeed <= T.pedHitSpeed) return;
    if (ped.state === 'HIT' || ped.state === 'DEAD') return;
    ped.state = 'HIT';
    ped.stateTimer = 0;
    ped.vx = v.vx * 0.8;
    ped.vz = v.vz * 0.8;
    ped.vy = 3;
    ped.tumble = 1;
    ped.health -= vspeed * T.pedDamagePerMs;
    const killed = vspeed > T.pedKillSpeed;
    if (killed) ped.health = 0;
    if (ped.health < 0) ped.health = 0;
    if (this.events) {
      this.events.emit('ped:hit', { pedId: ped.id, byVehicleId: v.id, byPlayer: v.occupiedByPlayer, speed: vspeed, killed, x: ped.curr.x, z: ped.curr.z });
      if (v.occupiedByPlayer) this.events.emit('camera:shake', { trauma: 0.25 });
    }
  }

  private hitPlayer(v: Vehicle, p: Player, vspeed: number, nx: number, nz: number): void {
    const T = COLLISION_TUNING;
    const world = this.world;
    const events = this.events;
    if (!world || !events) return;
    if (v.sleeping || vspeed <= T.playerHitSpeed || p.invulnTimer > 0 || !p.alive) return;
    damagePlayer(world, events, (vspeed - T.playerHitSpeed) * T.playerDamagePerMs, 'vehicle');
    p.vx = v.vx * 0.8 + nx * 2;
    p.vz = v.vz * 0.8 + nz * 2;
    p.vy = 3;
    p.grounded = false;
    p.stumbleTimer = PLAYER_TUNING.stumbleTime;
    p.invulnTimer = T.playerInvuln;
    events.emit('camera:shake', { trauma: clamp(vspeed / 15, 0, 1) });
  }

  // ---- vehicle vs static ----

  /** full = responses + damage + events; final pass (false) only guarantees separation. */
  private vehicleVsStatic(full: boolean): void {
    const world = this.world;
    if (!world) return;
    const T = COLLISION_TUNING;
    const list = world.vehicleList;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.sleeping || !v.alive) continue;
      if (full) this.sweepThinProps(v);
      for (let iter = 0; iter < T.iterations; iter++) {
        v.obb(this.obbA);
        obbBounds(this.obbA, this.bounds);
        const n = world.staticHash.queryRect(this.bounds.minX - T.queryPad, this.bounds.minZ - T.queryPad, this.bounds.maxX + T.queryPad, this.bounds.maxZ + T.queryPad, this.staticOut);
        let hit = false;
        for (let k = 0; k < n; k++) {
          const c = this.staticOut[k];
          if (!staticVsObb(c.shape, this.obbA, this.m)) continue; // normal from the car toward the static
          hit = true;
          const m = this.m;
          const px = -m.nx, pz = -m.nz;
          v.curr.x += px * m.depth;
          v.curr.z += pz * m.depth;
          v.obb(this.obbA);
          if (c.tag === 'water') {
            v.vx = 0; v.vz = 0; v.speed = 0; v.lateral = 0;
            continue;
          }
          if (full) this.staticResponse(v, px, pz);
        }
        if (!hit) break;
      }
      v.updateBounds();
    }
  }

  private staticResponse(v: Vehicle, px: number, pz: number): void {
    const T = COLLISION_TUNING;
    const vn = v.vx * px + v.vz * pz;
    if (vn >= 0) return;
    const impact = -vn;
    const tx = v.vx - vn * px, tz = v.vz - vn * pz;
    const nv = impact * T.restitutionStatic;
    v.vx = tx * T.tangentialKeep + px * nv;
    v.vz = tz * T.tangentialKeep + pz * nv;
    // Contact = the corner (or edge midpoint) of the car that reaches furthest toward the static (-p direction).
    const yaw = v.curr.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const rn = -(rx * px + rz * pz), fn = -(fx * px + fz * pz);
    const s1 = rn > 0.05 ? 1 : rn < -0.05 ? -1 : 0;
    const s2 = fn > 0.05 ? 1 : fn < -0.05 ? -1 : 0;
    const hw = v.spec.width * 0.5, hl = v.spec.length * 0.5;
    const cx = v.curr.x + rx * s1 * hw + fx * s2 * hl;
    const cz = v.curr.z + rz * s1 * hw + fz * s2 * hl;
    CollisionSystem.kick(v, cx, cz, px, pz, impact);
    CollisionSystem.syncBodyVel(v);
    let damage = 0;
    if (impact > T.damageMinSpeed) {
      damage = (impact - T.damageMinSpeed) * T.damagePerMs;
      this.applyVehicleDamage(v, damage, false);
    }
    if (this.events) {
      this.events.emit('vehicle:collision', { aId: v.id, bId: null, impactSpeed: impact, damage, x: cx, z: cz, playerInvolved: v.occupiedByPlayer, bIsPolice: false });
      if (v.occupiedByPlayer) this.events.emit('camera:shake', { trauma: clamp(impact / 20, 0, 1) });
    }
  }

  /** Fast cars are swept from prev to curr against thin props (r < 0.5) so lamp posts cannot be tunnelled. */
  private sweepThinProps(v: Vehicle): void {
    const world = this.world;
    if (!world) return;
    const T = COLLISION_TUNING;
    const sp2 = v.vx * v.vx + v.vz * v.vz;
    if (sp2 < T.sweepSpeed * T.sweepSpeed) return;
    const ax = v.prev.x, az = v.prev.z, bx = v.curr.x, bz = v.curr.z;
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-8) return;
    const hw = v.spec.width * 0.5;
    const n = world.staticHash.querySegment(ax, az, bx, bz, hw + 0.5, this.sweepOut);
    let tMin = 2;
    for (let k = 0; k < n; k++) {
      const c = this.sweepOut[k];
      if (c.tag !== 'prop' || c.shape.kind !== 'circle' || c.shape.r >= 0.5) continue;
      this.sweep.cx = c.shape.cx;
      this.sweep.cz = c.shape.cz;
      this.sweep.r = c.shape.r + hw;
      const t = segmentVsCircle(ax, az, bx, bz, this.sweep);
      if (t >= 0 && t < tMin) tMin = t;
    }
    if (tMin > 1) return;
    // Rewind to the impact point and sink a few cm into the post so the discrete pass resolves it.
    const len = Math.sqrt(len2);
    const sink = Math.min(T.sweepSink / len, 1 - tMin);
    const t = Math.max(0, tMin - 1e-3) + sink;
    v.curr.x = ax + dx * t;
    v.curr.z = az + dz * t;
  }

  // ---- circles (peds, player on foot) vs static ----

  private circlesVsStatic(): void {
    const world = this.world;
    if (!world) return;
    const player = world.player;
    if (player.vehicleId === null) this.pushCircleOut(player, player.radius);
    const peds = world.pedList;
    for (let i = 0; i < peds.length; i++) {
      const pd = peds[i];
      if (!pd.alive) continue;
      this.pushCircleOut(pd, pd.radius);
    }
  }

  private pushCircleOut(e: Entity, radius: number): void {
    const world = this.world;
    if (!world) return;
    const T = COLLISION_TUNING;
    const c = this.circle;
    for (let iter = 0; iter < T.iterations; iter++) {
      c.cx = e.curr.x; c.cz = e.curr.z; c.r = radius;
      const n = world.staticHash.queryCircle(c.cx, c.cz, radius + T.queryPad, this.staticOut);
      let hit = false;
      for (let k = 0; k < n; k++) {
        if (!staticVsCircle(this.staticOut[k].shape, c, this.m)) continue;
        hit = true;
        e.curr.x -= this.m.nx * this.m.depth;
        e.curr.z -= this.m.nz * this.m.depth;
        c.cx = e.curr.x; c.cz = e.curr.z;
      }
      if (!hit) break;
    }
    e.updateBounds();
  }

  // ---- player on foot vs vehicles (final separation) ----

  private playerVsVehicle(): void {
    const world = this.world;
    if (!world) return;
    const p = world.player;
    if (p.vehicleId !== null) return;
    const c = this.circle;
    p.circle(c);
    const n = world.dynamicHash.queryCircle(c.cx, c.cz, c.r + COLLISION_TUNING.queryPad, this.dynOut);
    for (let k = 0; k < n; k++) {
      const e = this.dynOut[k];
      if (e.kind !== 'vehicle') continue;
      (e as Vehicle).obb(this.obbA);
      if (!circleVsObb(c, this.obbA, this.m)) continue;
      p.curr.x += this.m.nx * this.m.depth;
      p.curr.z += this.m.nz * this.m.depth;
      p.circle(c);
    }
    p.updateBounds();
  }
}
