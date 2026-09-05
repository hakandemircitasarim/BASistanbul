// Vehicle entry/exit: enter prompt + nearest enterable car, seat mirroring, driving controls from input, exit placement, forced exit on destruction. Track C.
import type { EngineContext, System } from './System';
import type { CameraLike } from './System';
import type { World } from '../world/World';
import type { EventBus } from '../core/EventBus';
import type { Input } from '../core/Input';
import type { Vehicle } from '../entities/Vehicle';
import type { Entity } from '../entities/Entity';
import type { Circle, Manifold, OBB, StaticCollider } from '../core/Collision';
import { staticVsCircle, circleVsObb } from '../core/Collision';
import { resetControls } from '../core/Types';
import { damagePlayer } from './PlayerMoveSystem';

export const ENTRY_TUNING = {
  enterRadius: 3.0, exitPad: 1.0, enterCooldown: 0.6,
  maxEnterSpeed: 8,        // deviation: cannot jump into a car passing faster than this (m/s)
  destroyedExitDamage: 30,
  seatRight: -0.45,        // driver seat offset as a fraction of half width (left-hand drive)
  seatForward: 0.15,       // fraction of half length
};

export const PROMPT_ENTER = 'E - Araca bin';
export const PROMPT_EXIT = 'E - Araçtan in';

export class VehicleEntrySystem implements System {
  readonly name = 'VehicleEntry';
  private world: World | null = null;
  private events: EventBus | null = null;
  private input: Input | null = null;
  private camera: CameraLike | null = null;
  private current: Vehicle | null = null;
  private readonly obb: OBB = { cx: 0, cz: 0, hw: 0, hl: 0, yaw: 0 };
  private readonly circle: Circle = { cx: 0, cz: 0, r: 0 };
  private readonly manifold: Manifold = { nx: 0, nz: 0, depth: 0 };
  private readonly dynOut: Entity[] = [];
  private readonly staticOut: StaticCollider[] = [];

  init(ctx: EngineContext): void {
    this.world = ctx.world;
    this.events = ctx.events;
    this.input = ctx.input;
    this.camera = ctx.camera;
    ctx.events.on('player:respawn', this.onRespawn);
  }

  /** Engine.respawn() already reset the player; release the vehicle the player was sitting in. */
  private readonly onRespawn = (): void => {
    const v = this.current;
    if (v) this.releaseVehicle(v);
    this.current = null;
    const p = this.world ? this.world.player : null;
    if (p) { p.vehicleId = null; p.snap(); }
  };

  /** Heals, clears the vehicle link, teleports and grants invulnerability (used by integrators for custom respawns). */
  respawn(at: { x: number; z: number; yaw: number }, reason: 'wasted' | 'busted' | 'new'): void {
    const world = this.world;
    if (!world) return;
    const v = this.current;
    if (v) this.releaseVehicle(v);
    this.current = null;
    const p = world.player;
    p.vehicleId = null;
    p.health = 100;
    p.alive = true;
    p.curr.x = at.x; p.curr.z = at.z; p.curr.y = 0; p.curr.yaw = at.yaw;
    p.vx = 0; p.vz = 0; p.vy = 0;
    p.snap();
    p.invulnTimer = 3;
    if (this.events) this.events.emit('player:respawn', { x: at.x, z: at.z, reason });
  }

  fixedUpdate(dt: number): void {
    const world = this.world;
    const input = this.input;
    if (!world || !input) return;
    const p = world.player;
    if (p.enterCooldown > 0) p.enterCooldown -= dt;
    if (!p.alive) { this.syncSeat(); return; }

    if (p.vehicleId !== null) {
      const v = world.vehicles.get(p.vehicleId);
      if (!v || !v.alive) {
        p.vehicleId = null;
        this.current = null;
        return;
      }
      this.current = v;
      if (v.destroyed) {
        this.exitVehicle(v, true);
        return;
      }
      this.drive(v, input);
      this.syncSeat();
      world.hud.prompt = PROMPT_EXIT;
      if (p.enterCooldown <= 0 && input.consume('interact')) this.exitVehicle(v, false);
      return;
    }

    const candidate = this.findEnterable();
    world.hud.prompt = candidate ? PROMPT_ENTER : null;
    if (candidate && p.enterCooldown <= 0 && p.stumbleTimer <= 0 && input.consume('interact')) this.enterVehicle(candidate);
  }

  /** Writes v.controls from input; horn and headlight edges become events/toggles. */
  private drive(v: Vehicle, input: Input): void {
    const c = v.controls;
    c.throttle = input.axis('back', 'forward');
    c.steer = input.axis('left', 'right');
    c.brake = 0;
    c.handbrake = input.down('handbrake');
    const horn = input.pressed('horn');
    c.horn = horn;
    if (horn && this.events) {
      v.hornTimer = 0.5;
      this.events.emit('horn', { vehicleId: v.id, x: v.curr.x, z: v.curr.z });
    }
    if (input.consume('headlights')) v.lightsOn = !v.lightsOn;
    c.headlights = v.lightsOn;
    v.sleeping = false;
    v.idleTimer = 0;
  }

  /** Mirrors the player transform onto the driver seat so every system sees the player's position. */
  private syncSeat(): void {
    const world = this.world;
    if (!world) return;
    const p = world.player;
    if (p.vehicleId === null) return;
    const v = world.vehicles.get(p.vehicleId);
    if (!v) return;
    const T = ENTRY_TUNING;
    const yaw = v.curr.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const ox = T.seatRight * v.spec.width * 0.5, oz = T.seatForward * v.spec.length * 0.5;
    p.curr.x = v.curr.x + rx * ox + fx * oz;
    p.curr.z = v.curr.z + rz * ox + fz * oz;
    p.curr.y = 0;
    p.curr.yaw = yaw;
    p.vx = v.vx;
    p.vz = v.vz;
  }

  /** Nearest vehicle whose OBB expanded by enterRadius contains the player and that may be entered. */
  private findEnterable(): Vehicle | null {
    const world = this.world;
    if (!world) return null;
    const p = world.player;
    const T = ENTRY_TUNING;
    const px = p.curr.x, pz = p.curr.z;
    const n = world.dynamicHash.queryCircle(px, pz, T.enterRadius + 3.5, this.dynOut);
    let best: Vehicle | null = null;
    let bestD2 = Infinity;
    for (let i = 0; i < n; i++) {
      const e = this.dynOut[i];
      if (e.kind !== 'vehicle') continue;
      const v = e as Vehicle;
      if (!v.alive || v.destroyed || v.occupiedByPlayer) continue;
      const absSpeed = Math.abs(v.speed);
      if (v.role === 'police' && v.brain !== null && absSpeed >= 1) continue;
      if (absSpeed > T.maxEnterSpeed) continue;
      const yaw = v.curr.yaw;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const rx = -fz, rz = fx;
      const wx = px - v.curr.x, wz = pz - v.curr.z;
      const lx = wx * rx + wz * rz, lz = wx * fx + wz * fz;
      if (Math.abs(lx) > v.spec.width * 0.5 + T.enterRadius || Math.abs(lz) > v.spec.length * 0.5 + T.enterRadius) continue;
      const d2 = wx * wx + wz * wz;
      if (d2 < bestD2) { bestD2 = d2; best = v; }
    }
    return best;
  }

  private enterVehicle(v: Vehicle): void {
    const world = this.world;
    if (!world) return;
    const p = world.player;
    const prevRole = v.role;
    const stolen = prevRole !== 'parked' && prevRole !== 'abandoned' && prevRole !== 'mission';
    p.vehicleId = v.id;
    p.enterCooldown = ENTRY_TUNING.enterCooldown;
    p.vx = 0; p.vz = 0; p.vy = 0;
    p.grounded = true;
    p.moving = false;
    p.sprinting = false;
    p.curr.y = 0;
    v.occupiedByPlayer = true;
    v.driverId = p.id;
    v.prevRole = prevRole;
    v.role = 'player';
    v.brain = null;
    v.sirenOn = false; // a commandeered police car stops being a siren source
    v.sleeping = false;
    v.idleTimer = 0;
    resetControls(v.controls);
    v.controls.headlights = v.lightsOn;
    this.current = v;
    this.syncSeat();
    p.snap();
    world.hud.prompt = PROMPT_EXIT;
    if (this.events) {
      this.events.emit('player:enterVehicle', { vehicleId: v.id, stolen });
      if (stolen) this.events.emit('notify', { text: 'Araç çalındı', kind: 'danger' });
    }
    if (this.camera) this.camera.snapBehind();
  }

  private releaseVehicle(v: Vehicle): void {
    v.occupiedByPlayer = false;
    v.driverId = null;
    v.role = 'abandoned';
    v.sirenOn = false;
    resetControls(v.controls);
    v.controls.headlights = v.lightsOn;
  }

  /** Places the player beside the car (right, then left, then behind) on the first spot free of statics/vehicles. */
  private exitVehicle(v: Vehicle, forced: boolean): void {
    const world = this.world;
    if (!world) return;
    const p = world.player;
    const T = ENTRY_TUNING;
    const yaw = v.curr.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const side = v.spec.width * 0.5 + 0.4 + T.exitPad;
    const back = v.spec.length * 0.5 + 0.4 + T.exitPad;
    const cx = v.curr.x, cz = v.curr.z;
    let ex = cx + rx * side, ez = cz + rz * side;
    if (!this.spotFree(ex, ez, v)) {
      const lx = cx - rx * side, lz = cz - rz * side;
      if (this.spotFree(lx, lz, v)) { ex = lx; ez = lz; }
      else {
        const bx = cx - fx * back, bz = cz - fz * back;
        if (this.spotFree(bx, bz, v)) { ex = bx; ez = bz; }
      }
    }
    this.releaseVehicle(v);
    this.current = null;
    p.vehicleId = null;
    p.enterCooldown = T.enterCooldown;
    p.curr.x = ex; p.curr.z = ez; p.curr.y = 0; p.curr.yaw = yaw;
    p.vx = 0; p.vz = 0; p.vy = 0;
    p.grounded = true;
    p.snap();
    world.hud.prompt = null;
    if (this.events) this.events.emit('player:exitVehicle', { vehicleId: v.id });
    if (forced && this.events) {
      p.stumbleTimer = 0.6;
      damagePlayer(world, this.events, T.destroyedExitDamage, 'explosion');
    }
    if (this.camera) this.camera.snapBehind();
  }

  private spotFree(x: number, z: number, self: Vehicle): boolean {
    const world = this.world;
    if (!world) return true;
    const c = this.circle;
    c.cx = x; c.cz = z; c.r = world.player.radius;
    const ns = world.staticHash.queryCircle(x, z, c.r + 0.5, this.staticOut);
    for (let i = 0; i < ns; i++) {
      if (staticVsCircle(this.staticOut[i].shape, c, this.manifold)) return false;
    }
    const nd = world.dynamicHash.queryCircle(x, z, c.r + 0.5, this.dynOut);
    for (let i = 0; i < nd; i++) {
      const e = this.dynOut[i];
      if (e.kind !== 'vehicle' || e === self) continue;
      (e as Vehicle).obb(this.obb);
      if (circleVsObb(c, this.obb, this.manifold)) return false;
    }
    return true;
  }
}
