// Player entity: on-foot kinematics, stats (health/armor/money), vehicle link and circle bounds. Track P0.
import type { EntityId, Transform } from '../core/Types';
import { createTransform, copyTransform } from '../core/Transform';
import type { Circle } from '../core/Collision';
import type { Entity } from './Entity';
import { nextEntityId } from './Entity';

export class Player implements Entity {
  id: EntityId;
  readonly kind = 'player' as const;
  prev: Transform = createTransform();
  curr: Transform = createTransform();
  vx = 0;
  vy = 0;
  vz = 0;
  grounded = true;
  moving = false;
  sprinting = false;
  animPhase = 0;
  health = 100;
  armor = 0;
  money = 1000;
  vehicleId: EntityId | null = null;
  enterCooldown = 0;
  invulnTimer = 0;
  stumbleTimer = 0;
  alive = true;
  renderIndex = -1;
  spawnFade = 1;
  readonly radius = 0.4;
  readonly height = 1.8;
  minX = 0;
  minZ = 0;
  maxX = 0;
  maxZ = 0;
  hashStamp = 0;

  constructor() {
    this.id = nextEntityId();
    this.updateBounds();
  }

  circle(out: Circle): Circle {
    out.cx = this.curr.x;
    out.cz = this.curr.z;
    out.r = this.radius;
    return out;
  }

  updateBounds(): void {
    this.minX = this.curr.x - this.radius;
    this.maxX = this.curr.x + this.radius;
    this.minZ = this.curr.z - this.radius;
    this.maxZ = this.curr.z + this.radius;
  }

  snap(): void {
    copyTransform(this.prev, this.curr);
  }

  /** Full stats reset (new game) and teleport. */
  reset(x: number, z: number, yaw: number): void {
    this.curr.x = x;
    this.curr.y = 0;
    this.curr.z = z;
    this.curr.yaw = yaw;
    this.snap();
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.grounded = true;
    this.moving = false;
    this.sprinting = false;
    this.animPhase = 0;
    this.health = 100;
    this.armor = 0;
    this.money = 1000;
    this.vehicleId = null;
    this.enterCooldown = 0;
    this.invulnTimer = 0;
    this.stumbleTimer = 0;
    this.alive = true;
    this.spawnFade = 1;
    this.updateBounds();
  }
}
