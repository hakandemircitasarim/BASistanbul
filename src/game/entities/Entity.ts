// Entity interface shared by player/vehicles/peds plus the global entity id counter. Track P0.
import type { EntityId, Transform } from '../core/Types';
import type { HashItem } from '../core/SpatialHash';

export type EntityKind = 'player' | 'vehicle' | 'ped';
export interface Entity extends HashItem {
  id: EntityId; kind: EntityKind; prev: Transform; curr: Transform; vx: number; vz: number; alive: boolean;
  renderIndex: number; spawnFade: number; /* 0..1, 1 = fully visible; renderers scale by it; spawners set 0 then it grows 2/s */
  snap(): void;          // prev = curr
  updateBounds(): void;  // recompute minX..maxZ from curr
}

let counter = 1;
export const nextEntityId = (): EntityId => counter++;
export const resetEntityIds = (): void => { counter = 1; };
