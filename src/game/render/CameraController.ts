// Third-person camera (orbit on foot, chase in vehicle, cinematic in menu): mouse/Q-R input, auto-align, reverse cam, speed FOV, trauma shake, occlusion pull-in. Track C.
import type { PerspectiveCamera } from 'three';
import type { CameraLike } from '../systems/System';
import type { World } from '../world/World';
import type { Input } from '../core/Input';
import type { Settings } from '../state/GameStore';
import type { Transform } from '../core/Types';
import type { EventBus } from '../core/EventBus';
import type { AABB, StaticCollider } from '../core/Collision';
import { pointInAabb, segmentVsAabb } from '../core/Collision';
import { createTransform, lerpTransform } from '../core/Transform';
import { clamp, damp, dampAngle, lerp, wrapAngle } from '../core/math';
import { LANDMARK_BLOCKS, PITCH, ROAD_W, BLOCK } from '../city/CityConfig';

export type CameraMode = 'orbit' | 'chase' | 'cinematic';

export const CAMERA_TUNING = {
  orbitDist: 5.5, orbitHeight: 1.6, pitchMin: -0.35, pitchMax: 1.1, pitchDefault: 0.22, mouseSens: 0.0022, keyYawSpeed: 2.4,
  chaseDists: [7.5, 11, 3.2], chaseHeight: 2.8, chaseLookAhead: 3, posLambda: 6, yawLambda: 4,
  autoAlignDelay: 1.0, autoAlignRate: 2.5, reverseDelay: 0.5,
  fovBase: 65, fovMax: 80, fovSpeedRef: 45, fovLambda: 4,
  shakeDecay: 1.6, shakeMaxPos: 0.45, shakeMaxRot: 0.03, occlusionPad: 0.4, occlusionMin: 0.12,
  cinematicRadius: 140, cinematicHeight: 55, cinematicRate: 0.06,
  chaseTargetHeight: 1.0, minEyeY: 0.5, pullInLambda: 14, releaseLambda: 3,
};

const TOWER_X = ROAD_W + LANDMARK_BLOCKS.tower[0] * PITCH + BLOCK / 2;
const TOWER_Z = ROAD_W + LANDMARK_BLOCKS.tower[1] * PITCH + BLOCK / 2;

export class CameraController implements CameraLike {
  mode: CameraMode = 'cinematic';
  yaw = 0;
  pitch = CAMERA_TUNING.pitchDefault;
  chaseIndex = 0;
  private trauma = 0;
  private cinAngle = 0;
  private fwdX = 0;
  private fwdZ = 1;
  private shakeSeed = 0;
  private baseYaw = 0;       // smoothed vehicle heading in chase mode
  private offsetYaw = 0;     // free-look offset on top of baseYaw (auto-aligns back to 0)
  private idleTimer = 0;
  private reverseTimer = 0;
  private reversing = false;
  private occl = 1;          // occlusion pull-in factor (1 = no pull-in)
  private fov = CAMERA_TUNING.fovBase;
  private vHeld = false;
  private lastMode: CameraMode = 'cinematic';
  private unsubscribe: (() => void) | null = null;
  private readonly tmp: Transform = createTransform();
  private readonly aabb: AABB = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  private readonly colliders: StaticCollider[] = [];
  private readonly camera: PerspectiveCamera;
  private readonly world: World;
  private readonly input: Input;
  private readonly settings: () => Settings;

  constructor(camera: PerspectiveCamera, world: World, input: Input, settings: () => Settings, events?: EventBus) {
    this.camera = camera;
    this.world = world;
    this.input = input;
    this.settings = settings;
    if (events) this.unsubscribe = events.on('camera:shake', this.onShake);
  }

  private readonly onShake = (p: { trauma: number }): void => {
    this.addTrauma(p.trauma);
  };

  get yawForMovement(): number { return this.yaw; }
  get x(): number { return this.camera.position.x; }
  get z(): number { return this.camera.position.z; }
  get forwardX(): number { return this.fwdX; }
  get forwardZ(): number { return this.fwdZ; }

  /** Puts the camera directly behind the player/vehicle at the default pitch. */
  snapBehind(): void {
    this.yaw = this.world.playerYaw();
    this.baseYaw = this.yaw;
    this.offsetYaw = 0;
    this.pitch = CAMERA_TUNING.pitchDefault;
    this.idleTimer = 0;
    this.reverseTimer = 0;
    this.reversing = false;
    this.occl = 1;
  }

  addTrauma(t: number): void {
    this.trauma = clamp(this.trauma + t, 0, 1);
  }

  isInView(x: number, z: number): boolean {
    const dx = x - this.camera.position.x, dz = z - this.camera.position.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-6) return true;
    return (dx * this.fwdX + dz * this.fwdZ) / d > 0.25;
  }

  dispose(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  update(alpha: number, frameDt: number): void {
    const cam = this.camera;
    const T = CAMERA_TUNING;
    const dt = Math.min(frameDt, 0.1);
    if (this.mode === 'cinematic') {
      this.cinAngle += T.cinematicRate * dt;
      cam.position.set(TOWER_X + Math.cos(this.cinAngle) * T.cinematicRadius, T.cinematicHeight, TOWER_Z + Math.sin(this.cinAngle) * T.cinematicRadius);
      cam.lookAt(TOWER_X, 40, TOWER_Z);
      this.setFov(T.fovBase);
      this.setForwardFrom(TOWER_X, TOWER_Z);
      this.lastMode = 'cinematic';
      return;
    }
    const s = this.settings();
    const world = this.world;
    const pv = world.playerVehicle();
    const src = pv ? pv : world.player;
    lerpTransform(this.tmp, src.prev, src.curr, alpha);
    const target = this.tmp;

    // Mode transitions
    const wantMode: CameraMode = pv ? 'chase' : 'orbit';
    if (wantMode !== this.lastMode) {
      this.mode = wantMode;
      this.lastMode = wantMode;
      this.baseYaw = pv ? target.yaw : this.yaw;
      this.offsetYaw = 0;
      this.idleTimer = 0;
      this.reversing = false;
      this.reverseTimer = 0;
    }
    this.mode = wantMode;

    // Input: mouse when locked, Q/R otherwise; V cycles the chase distance (edge detected on held state).
    let dyaw = 0, dpitch = 0;
    if (this.input.pointerLocked) {
      const sens = T.mouseSens * s.mouseSensitivity;
      dyaw = -this.input.mouseDX * sens;
      dpitch = this.input.mouseDY * sens * (s.invertY ? -1 : 1);
    } else {
      const k = (this.input.down('camRight') ? 1 : 0) - (this.input.down('camLeft') ? 1 : 0);
      dyaw = -k * T.keyYawSpeed * dt;
    }
    const vDown = this.input.down('cameraToggle');
    if (vDown && !this.vHeld) this.chaseIndex = (this.chaseIndex + 1) % T.chaseDists.length;
    this.vHeld = vDown;

    let dist: number;
    let tx = target.x, ty: number, tz = target.z;
    // Pivot the eye orbits around (vehicle/player centre); the look target may be offset ahead of it.
    const px = target.x, pz = target.z;
    if (pv) {
      // Chase: smoothed heading + free-look offset that auto-aligns after idle; reverse cam when deliberately backing up.
      // Hysteresis: once reversing, stay in reverse cam while still rolling backwards even after the throttle is released.
      if (pv.speed < -0.5 && (pv.controls.throttle < 0 || this.reversing)) this.reverseTimer += dt; else this.reverseTimer = 0;
      this.reversing = this.reverseTimer > T.reverseDelay;
      if (dyaw !== 0 || dpitch !== 0) {
        this.offsetYaw = wrapAngle(this.offsetYaw + dyaw);
        this.pitch += dpitch;
        this.idleTimer = 0;
      } else {
        this.idleTimer += dt;
        if (this.idleTimer > T.autoAlignDelay) {
          this.offsetYaw = damp(this.offsetYaw, 0, T.autoAlignRate, dt);
          this.pitch = damp(this.pitch, T.pitchDefault, T.autoAlignRate, dt);
        }
      }
      const heading = this.reversing ? target.yaw + Math.PI : target.yaw;
      this.baseYaw = dampAngle(this.baseYaw, heading, T.yawLambda, dt);
      this.yaw = wrapAngle(this.baseYaw + this.offsetYaw);
      dist = T.chaseDists[this.chaseIndex % T.chaseDists.length];
      const ahead = this.reversing ? -T.chaseLookAhead : T.chaseLookAhead;
      tx += Math.sin(target.yaw) * ahead;
      tz += Math.cos(target.yaw) * ahead;
      ty = target.y + T.chaseTargetHeight;
    } else {
      this.yaw = wrapAngle(this.yaw + dyaw);
      this.pitch += dpitch;
      dist = T.orbitDist;
      ty = target.y + T.orbitHeight;
    }
    this.pitch = clamp(this.pitch, T.pitchMin, T.pitchMax);

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    let ex = px - fx * dist * cp;
    let ez = pz - fz * dist * cp;
    let ey = pv ? ty + T.chaseHeight - T.chaseTargetHeight + dist * sp * 0.5 : ty + dist * sp;
    if (ey < T.minEyeY) ey = T.minEyeY;

    // Occlusion pull-in against buildings/landmarks between the target and the eye.
    const want = this.occlusionFactor(tx, tz, ex, ez, ey);
    this.occl = want < this.occl ? damp(this.occl, want, T.pullInLambda, dt) : damp(this.occl, want, T.releaseLambda, dt);
    if (this.occl < 0.999) {
      ex = tx + (ex - tx) * this.occl;
      ez = tz + (ez - tz) * this.occl;
      ey = ty + (ey - ty) * this.occl;
    }

    // Speed FOV
    const speed01 = pv ? clamp(Math.abs(pv.speed) / T.fovSpeedRef, 0, 1) : 0;
    this.fov = damp(this.fov, lerp(T.fovBase, T.fovMax, speed01), T.fovLambda, dt);
    this.setFov(this.fov);

    // Trauma shake (position jitter + roll)
    let roll = 0;
    if (this.trauma > 0) {
      this.shakeSeed += dt * 40;
      const a = this.trauma * this.trauma;
      ex += Math.sin(this.shakeSeed * 1.3) * a * T.shakeMaxPos;
      ey += Math.sin(this.shakeSeed * 1.7 + 1) * a * T.shakeMaxPos;
      ez += Math.cos(this.shakeSeed * 1.1 + 2) * a * T.shakeMaxPos;
      roll = Math.sin(this.shakeSeed * 2.3 + 0.5) * a * T.shakeMaxRot;
      this.trauma = Math.max(0, this.trauma - T.shakeDecay * dt);
    }
    cam.position.set(ex, ey, ez);
    cam.lookAt(tx, ty, tz);
    if (roll !== 0) cam.rotateZ(roll);
    this.setForwardFrom(tx, tz);
  }

  /** Fraction of the target->eye segment that is unobstructed by buildings taller than the eye (1 = clear). */
  private occlusionFactor(tx: number, tz: number, ex: number, ez: number, ey: number): number {
    const T = CAMERA_TUNING;
    const n = this.world.staticHash.querySegment(tx, tz, ex, ez, T.occlusionPad, this.colliders);
    let tMin = 1;
    for (let i = 0; i < n; i++) {
      const c = this.colliders[i];
      if (c.tag !== 'building' && c.tag !== 'landmark') continue;
      if (c.shape.kind !== 'aabb' || c.height <= ey) continue;
      const a = this.aabb;
      a.minX = c.shape.minX - T.occlusionPad; a.maxX = c.shape.maxX + T.occlusionPad;
      a.minZ = c.shape.minZ - T.occlusionPad; a.maxZ = c.shape.maxZ + T.occlusionPad;
      if (pointInAabb(tx, tz, a)) continue; // the look target itself is inside (nose against a wall): do not collapse onto the hood
      const t = segmentVsAabb(tx, tz, ex, ez, a);
      if (t >= 0 && t < tMin) tMin = t;
    }
    return Math.max(tMin, T.occlusionMin);
  }

  private setFov(fov: number): void {
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private setForwardFrom(tx: number, tz: number): void {
    const dx = tx - this.camera.position.x, dz = tz - this.camera.position.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-6) { this.fwdX = dx / d; this.fwdZ = dz / d; }
  }
}
