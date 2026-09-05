// Pedestrian entity: walk/flee FSM state, ragdoll timers, colors and circle bounds. Track P0.
import type { EntityId, PedState, Transform } from '../core/Types';
import { createTransform, copyTransform } from '../core/Transform';
import type { Circle } from '../core/Collision';
import type { Entity } from './Entity';
import { nextEntityId } from './Entity';

export class Pedestrian implements Entity {
  id: EntityId;
  readonly kind = 'ped' as const;
  prev: Transform;
  curr: Transform;
  vx = 0;
  vz = 0;
  vy = 0;
  state: PedState = 'IDLE';
  stateTimer = 0;
  walkNode: number;
  targetNode = -1;
  dir: 1 | -1 = 1;
  speed = 0;
  health = 100;
  threatX = 0;
  threatZ = 0;
  fleeTimer = 0;
  tumble = 0;
  fadeTimer = 0;
  alive = true;
  renderIndex = -1;
  spawnFade = 1;
  colors: { shirt: number; pants: number; skin: number };
  animPhase = 0;
  decideTick = 0;
  readonly radius = 0.35;
  readonly height = 1.75;
  minX = 0;
  minZ = 0;
  maxX = 0;
  maxZ = 0;
  hashStamp = 0;

  constructor(x: number, z: number, yaw: number, walkNode: number, shirt: number, pants: number, skin: number) {
    this.id = nextEntityId();
    this.curr = createTransform(x, 0, z, yaw);
    this.prev = createTransform(x, 0, z, yaw);
    this.walkNode = walkNode;
    this.colors = { shirt, pants, skin };
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
}
