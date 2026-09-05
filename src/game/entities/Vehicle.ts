// Vehicle entity: kinematic state, controls, damage, role/brain slots and OBB/bounds helpers. Track P0.
import type { EntityId, Transform, Vec2, VehicleControls, VehicleRole } from '../core/Types';
import { zeroControls } from '../core/Types';
import { createTransform, copyTransform } from '../core/Transform';
import { obbBounds } from '../core/Collision';
import type { AABB, OBB } from '../core/Collision';
import type { Entity } from './Entity';
import { nextEntityId } from './Entity';
import type { VehicleSpec } from './VehicleSpecs';

export interface TrafficBrain { lane: number; t: number; nextLane: number; inTurn: boolean; turnS: number; stopTimer: number; waitingAtNode: number; reservedNode: number; targetSpeed: number; blockedTimer: number; decideTick: number; honkTimer: number; yieldTimer: number; prevHeadingErr: number }
export interface PoliceBrain { mode: 'PATH' | 'PURSUE' | 'BUST' | 'RETURN'; traffic: TrafficBrain; path: number[]; pathLen: number; pathIdx: number; repathTimer: number; sightTimer: number; bustTimer: number; stuckTimer: number; reverseTimer: number; siren: boolean; returnTimer: number }

export function makeTrafficBrain(): TrafficBrain {
  return { lane: -1, t: 0, nextLane: -1, inTurn: false, turnS: 0, stopTimer: 0, waitingAtNode: -1, reservedNode: -1, targetSpeed: 0, blockedTimer: 0, decideTick: 0, honkTimer: 0, yieldTimer: 0, prevHeadingErr: 0 };
}

export function makePoliceBrain(): PoliceBrain {
  return { mode: 'PATH', traffic: makeTrafficBrain(), path: new Array<number>(64).fill(-1), pathLen: 0, pathIdx: 0, repathTimer: 0, sightTimer: 0, bustTimer: 0, stuckTimer: 0, reverseTimer: 0, siren: false, returnTimer: 0 };
}

const scratchObb: OBB = { cx: 0, cz: 0, hw: 0, hl: 0, yaw: 0 };
const scratchAabb: AABB = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };

export class Vehicle implements Entity {
  id: EntityId;
  readonly kind = 'vehicle' as const;
  spec: VehicleSpec;
  role: VehicleRole;
  prevRole: VehicleRole;
  color: number;
  prev: Transform;
  curr: Transform;
  vx = 0;
  vz = 0;
  speed = 0; /* signed forward m/s */
  lateral = 0;
  yawRate = 0;
  steerAngle = 0;
  wheelSpin = 0;
  longAccel = 0;
  drifting = false;
  controls: VehicleControls = zeroControls();
  health = 100;
  destroyed = false;
  damageFlash = 0;
  smoke = 0;
  wreckTimer = 0;
  driverId: EntityId | null = null;
  occupiedByPlayer = false;
  brain: TrafficBrain | PoliceBrain | null = null;
  ramCount = 0;
  lightsOn = false;
  sirenOn = false;
  hornTimer = 0;
  alive = true;
  renderIndex = -1;
  spawnFade = 1;
  sleeping = false;
  idleTimer = 0;
  minX = 0;
  minZ = 0;
  maxX = 0;
  maxZ = 0;
  hashStamp = 0;

  constructor(spec: VehicleSpec, x: number, z: number, yaw: number, role: VehicleRole, color: number) {
    this.id = nextEntityId();
    this.spec = spec;
    this.role = role;
    this.prevRole = role;
    this.color = color;
    this.curr = createTransform(x, 0, z, yaw);
    this.prev = createTransform(x, 0, z, yaw);
    this.updateBounds();
  }

  obb(out: OBB): OBB {
    out.cx = this.curr.x;
    out.cz = this.curr.z;
    out.hw = this.spec.width * 0.5;
    out.hl = this.spec.length * 0.5;
    out.yaw = this.curr.yaw;
    return out;
  }

  updateBounds(): void {
    obbBounds(this.obb(scratchObb), scratchAabb);
    this.minX = scratchAabb.minX;
    this.minZ = scratchAabb.minZ;
    this.maxX = scratchAabb.maxX;
    this.maxZ = scratchAabb.maxZ;
  }

  snap(): void {
    copyTransform(this.prev, this.curr);
  }

  forward(out: Vec2): Vec2 {
    out.x = Math.sin(this.curr.yaw);
    out.z = Math.cos(this.curr.yaw);
    return out;
  }

  /** Clamps health to 0..100 and flags destruction at 0. */
  applyDamage(d: number): void {
    if (this.destroyed) return;
    this.health -= d;
    if (this.health < 0) this.health = 0;
    if (this.health > 100) this.health = 100;
    this.damageFlash = 1;
    if (this.health <= 0) {
      this.health = 0;
      this.destroyed = true;
    }
  }

  isPolice(): boolean {
    return this.spec.key === 'police';
  }
}
