// On-foot player movement: camera-relative walk/sprint, jump/gravity, stumble, fall damage, wasted detection; shared damagePlayer helper. Track C.
import type { EngineContext, System } from './System';
import type { CameraLike } from './System';
import type { World } from '../world/World';
import type { EventBus } from '../core/EventBus';
import type { Input } from '../core/Input';
import type { Vec2 } from '../core/Types';
import { dampAngle, forwardOf, rightOf, yawFromDir } from '../core/math';

export const PLAYER_TUNING = {
  walkSpeed: 4.2, sprintSpeed: 7.5, accel: 30, decel: 40, jumpVel: 6.5, gravity: 20, turnLambda: 14,
  fallDamageSpeed: 12, stumbleTime: 0.4,
  airControl: 0.25,       // accel/decel multiplier while airborne (keeps knockback alive)
  fallDamagePerMs: 5,     // damage per m/s above fallDamageSpeed
  animRate: 1.9,          // animPhase advance per meter travelled (radians)
  spawnFadeRate: 2,
};

/**
 * Applies damage to the player (armor absorbs first), emits `player:damaged` and flags the HUD hit flash.
 * Returns the amount actually applied (0 while invulnerable or already dead).
 */
export function damagePlayer(world: World, events: EventBus, amount: number, source: 'vehicle' | 'police' | 'fall' | 'explosion'): number {
  const p = world.player;
  if (!p.alive || amount <= 0 || p.invulnTimer > 0) return 0;
  let left = amount;
  if (p.armor > 0) {
    const absorbed = Math.min(p.armor, left * 0.7);
    p.armor -= absorbed;
    left -= absorbed;
  }
  p.health = Math.max(0, p.health - left);
  world.hud.hitFlashAt = world.time.elapsed;
  events.emit('player:damaged', { amount, source });
  return amount;
}

export class PlayerMoveSystem implements System {
  readonly name = 'PlayerMove';
  private world: World | null = null;
  private events: EventBus | null = null;
  private input: Input | null = null;
  private camera: CameraLike | null = null;
  private readonly fwd: Vec2 = { x: 0, z: 0 };
  private readonly right: Vec2 = { x: 0, z: 0 };
  private wastedEmitted = false;

  init(ctx: EngineContext): void {
    this.world = ctx.world;
    this.events = ctx.events;
    this.input = ctx.input;
    this.camera = ctx.camera;
    ctx.events.on('player:respawn', this.onRespawn);
  }

  private readonly onRespawn = (): void => {
    this.wastedEmitted = false;
  };

  fixedUpdate(dt: number): void {
    const world = this.world;
    const input = this.input;
    const events = this.events;
    if (!world || !input || !events) return;
    const p = world.player;
    const T = PLAYER_TUNING;

    if (p.invulnTimer > 0) p.invulnTimer -= dt;
    if (p.stumbleTimer > 0) p.stumbleTimer -= dt;
    if (p.spawnFade < 1) p.spawnFade = Math.min(1, p.spawnFade + T.spawnFadeRate * dt);

    // Wasted: emit once, then the player lies still until respawn.
    if (p.health <= 0 && p.alive) {
      p.alive = false;
      p.vx = 0; p.vz = 0; p.vy = 0;
      p.moving = false; p.sprinting = false;
      if (!this.wastedEmitted) {
        this.wastedEmitted = true;
        events.emit('player:wasted', { reason: 'wasted' });
      }
      return;
    }
    if (!p.alive) return;

    if (p.vehicleId !== null) {
      p.moving = false;
      p.sprinting = false;
      p.vx = 0; p.vz = 0; p.vy = 0;
      p.grounded = true;
      return;
    }

    // Camera-relative input (blocked while stumbling).
    const camYaw = this.camera ? this.camera.yawForMovement : 0;
    let ax = 0, ay = 0;
    const canControl = p.stumbleTimer <= 0;
    if (canControl) {
      ax = input.axis('left', 'right');
      ay = input.axis('back', 'forward');
    }
    forwardOf(camYaw, this.fwd);
    rightOf(camYaw, this.right);
    let mx = this.fwd.x * ay + this.right.x * ax;
    let mz = this.fwd.z * ay + this.right.z * ax;
    const mlen = Math.sqrt(mx * mx + mz * mz);
    const hasInput = mlen > 1e-6;
    if (hasInput) { mx /= mlen; mz /= mlen; }
    const wantsSprint = hasInput && input.down('sprint');
    const targetSpeed = wantsSprint ? T.sprintSpeed : T.walkSpeed;
    const tvx = hasInput ? mx * targetSpeed : 0;
    const tvz = hasInput ? mz * targetSpeed : 0;

    // Velocity approach: accel toward the target, decel when idle; reduced control in the air.
    const airMul = p.grounded ? 1 : T.airControl;
    const rate = (hasInput ? T.accel : T.decel) * airMul * dt;
    const dvx = tvx - p.vx, dvz = tvz - p.vz;
    const dlen = Math.sqrt(dvx * dvx + dvz * dvz);
    if (dlen <= rate) { p.vx = tvx; p.vz = tvz; }
    else { p.vx += (dvx / dlen) * rate; p.vz += (dvz / dlen) * rate; }

    // Facing follows the movement direction.
    if (hasInput) p.curr.yaw = dampAngle(p.curr.yaw, yawFromDir(mx, mz), T.turnLambda, dt);

    // Jump + gravity
    if (canControl && p.grounded && input.consume('jump')) {
      p.vy = T.jumpVel;
      p.grounded = false;
    }
    p.vy -= T.gravity * dt;
    p.curr.y += p.vy * dt;
    if (p.curr.y <= 0) {
      p.curr.y = 0;
      if (!p.grounded && p.vy < -T.fallDamageSpeed) {
        damagePlayer(world, events, (-p.vy - T.fallDamageSpeed) * T.fallDamagePerMs, 'fall');
        p.stumbleTimer = T.stumbleTime;
      }
      p.vy = 0;
      p.grounded = true;
    }

    p.curr.x += p.vx * dt;
    p.curr.z += p.vz * dt;

    const speed = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    p.moving = speed > 0.3;
    p.sprinting = wantsSprint && speed > T.walkSpeed * 0.9;
    p.animPhase += speed * T.animRate * dt;
    if (p.animPhase > 1e4) p.animPhase -= 1e4;
  }
}
