// Vehicle physics: single-engine-curve longitudinal model, steering/yaw, lateral grip, sleep handling, skid/smoke bookkeeping. Track C.
import type { EngineContext, System } from './System';
import type { World } from '../world/World';
import type { EventBus } from '../core/EventBus';
import type { Vehicle } from '../entities/Vehicle';
import { clamp, damp, lerp, sign } from '../core/math';

export const PHYSICS_TUNING = {
  sleepSpeed: 0.05,      // |v| below this counts as idle
  sleepAfter: 1.0,       // seconds idle before a parked/abandoned vehicle sleeps
  lowSpeedGrip: 1.6,     // grip multiplier below 4 m/s (no low-speed sliding)
  lowSpeedRef: 4,
  authorityRef: 12,      // lateral speed at which yaw authority would reach 0 (clamped to authorityMin)
  authorityMin: 0.35,
  handbrakeAuthorityMin: 0.8, // deviation: the handbrake keeps the front tyres in charge so the car actually rotates
  handbrakeYawMul: 1.25,
  yawRateLambda: 12,     // yawRate is low-pass filtered so collision angular kicks persist for a few ticks
  wheelRadius: 0.33,
  driftLateral: 3.5,
  driftForward: 6,
  skidMinSpeed: 4,
  skidEveryTicks: 4,
  damageFlashDecay: 3,
  smokeHealth: 50,
  spawnFadeRate: 2,
};

/** Sleeps parked/abandoned vehicles that sit still; any non-zero control wakes them. */
function updateSleep(v: Vehicle, dt: number): void {
  const c = v.controls;
  const active = c.throttle !== 0 || c.brake !== 0 || c.handbrake || c.steer !== 0;
  if (active || v.occupiedByPlayer || v.brain !== null) {
    v.sleeping = false;
    v.idleTimer = 0;
    return;
  }
  if (v.role !== 'parked' && v.role !== 'abandoned') {
    v.sleeping = false;
    v.idleTimer = 0;
    return;
  }
  const sp = Math.sqrt(v.vx * v.vx + v.vz * v.vz);
  if (sp < PHYSICS_TUNING.sleepSpeed) {
    v.idleTimer += dt;
    if (v.idleTimer > PHYSICS_TUNING.sleepAfter) {
      v.sleeping = true;
      v.vx = 0;
      v.vz = 0;
      v.speed = 0;
      v.lateral = 0;
    }
  } else {
    v.idleTimer = 0;
    v.sleeping = false;
  }
}

export class VehiclePhysicsSystem implements System {
  readonly name = 'VehiclePhysics';
  private world: World | null = null;
  private events: EventBus | null = null;

  init(ctx: EngineContext): void {
    this.world = ctx.world;
    this.events = ctx.events;
  }

  /**
   * One fixed step of the car model, all in the car's frame.
   * Longitudinal: single engine curve accel * throttle * (1 - vf/maxSpeed); brake/reverse/coast/roll/drag/handbrake decels.
   * Lateral: slip decays with grip; yaw from bicycle kinematics scaled by yaw authority.
   * Velocity is recomposed on the tick-start axes so it keeps its world direction while the body rotates:
   * the next decomposition yields the slip that grip then removes (this is what makes the car drift).
   */
  static integrate(v: Vehicle, dt: number): void {
    const s = v.spec;
    const c = v.controls;
    const T = PHYSICS_TUNING;
    const yaw = v.curr.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    let vf = v.vx * fx + v.vz * fz;
    let vl = v.vx * rx + v.vz * rz;
    const prevVf = vf;
    const absVf = Math.abs(vf);
    const sg = sign(vf);
    const invDt = 1 / dt;

    if (v.destroyed) {
      c.throttle = 0;
      c.brake = 1;
    }
    const throttle = clamp(c.throttle, -1, 1);
    const brake = clamp(c.brake, 0, 1);
    const steer = clamp(c.steer, -1, 1);
    const hb = c.handbrake;

    // Steering
    const steerMax = lerp(s.steerMaxLow, s.steerMaxHigh, clamp(absVf / s.maxSpeed, 0, 1));
    v.steerAngle = damp(v.steerAngle, steer * steerMax, s.steerLambda, dt);

    // Longitudinal acceleration
    let a = 0;
    let driving = false;
    if (throttle > 0) {
      a = s.accel * throttle * Math.max(0, 1 - vf / s.maxSpeed);
      driving = true;
    } else if (throttle < 0) {
      if (vf > 0.5) a = -s.brakeDecel;
      else if (vf > -s.reverseSpeed) { a = -s.accel * 0.6; driving = true; }
      else a = 0;
    } else {
      a = -sg * Math.min(absVf * invDt, s.coastDecel);
    }
    a -= sg * Math.min(absVf * invDt, s.rollDecel + s.dragQuad * vf * vf);
    a -= sg * s.brakeDecel * brake;
    if (hb) a -= sg * Math.min(absVf * invDt, s.handbrakeDecel);
    vf += a * dt;
    // Decelerations never flip the sign of vf; only engine force may cross zero.
    if (!driving && sg !== 0 && sign(vf) !== sg) vf = 0;

    // Lateral grip
    let grip = hb ? s.gripHandbrake : s.gripNormal;
    if (absVf < T.lowSpeedRef) grip *= T.lowSpeedGrip;
    vl *= Math.exp(-grip * dt);

    // Yaw
    let authority = clamp(1 - Math.abs(vl) / T.authorityRef, T.authorityMin, 1);
    if (hb && authority < T.handbrakeAuthorityMin) authority = T.handbrakeAuthorityMin;
    let targetYawRate = (vf / s.wheelbase) * Math.tan(v.steerAngle) * authority;
    if (hb) targetYawRate *= T.handbrakeYawMul;
    v.yawRate = damp(v.yawRate, targetYawRate, T.yawRateLambda, dt);
    v.curr.yaw += v.yawRate * dt;

    // Recompose on the tick-start axes and integrate the position.
    v.vx = fx * vf + rx * vl;
    v.vz = fz * vf + rz * vl;
    v.speed = vf;
    v.lateral = vl;
    v.curr.x += v.vx * dt;
    v.curr.z += v.vz * dt;
    v.wheelSpin += (vf / T.wheelRadius) * dt;
    v.drifting = Math.abs(vl) > T.driftLateral && Math.abs(vf) > T.driftForward;
    v.longAccel = (vf - prevVf) * invDt;
  }

  fixedUpdate(dt: number): void {
    const world = this.world;
    if (!world) return;
    const list = world.vehicleList;
    const T = PHYSICS_TUNING;
    const tick = world.time.tick;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.spawnFade < 1) v.spawnFade = Math.min(1, v.spawnFade + T.spawnFadeRate * dt);
      if (v.damageFlash > 0) v.damageFlash = Math.max(0, v.damageFlash - T.damageFlashDecay * dt);
      v.smoke = v.health < T.smokeHealth && !v.destroyed ? 1 : v.destroyed ? 1 : Math.max(0, v.smoke - dt);
      if (v.hornTimer > 0) v.hornTimer -= dt;
      if (v.destroyed) v.wreckTimer += dt;
      updateSleep(v, dt);
      if (v.sleeping) continue;
      VehiclePhysicsSystem.integrate(v, dt);
      if (this.events && (v.drifting || v.controls.handbrake) && Math.abs(v.speed) > T.skidMinSpeed && (tick + v.id) % T.skidEveryTicks === 0) {
        this.events.emit('fx:skid', { vehicleId: v.id, intensity: clamp(Math.abs(v.lateral) / 8, 0, 1) });
      }
    }
  }
}
