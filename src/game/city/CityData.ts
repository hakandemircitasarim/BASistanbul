// Plain-data types describing a generated city (buildings, blocks, props, landmarks, colliders, points). Track P0.
import type { AABB, StaticCollider } from '../core/Collision';

export type BuildingStyle = 'artdeco' | 'glass' | 'concrete' | 'neon' | 'residential';
export type District = 'downtown' | 'beachfront' | 'suburb';
export interface Building { id: number; x: number; z: number; w: number; d: number; h: number; style: BuildingStyle; color: number; accent: number; roofKind: 'flat' | 'stepped' | 'spire'; hasNeonSign: boolean; neonColor: number; district: District; facing: 0 | 1 | 2 | 3 /* +Z, +X, -Z, -X */ }
export interface Lot { blockCol: number; blockRow: number; x: number; z: number; w: number; d: number }
export interface Block { id: number; col: number; row: number; x0: number; z0: number; x1: number; z1: number; kind: 'buildings' | 'park' | 'landmark' | 'plaza'; buildings: number[] }
/**
 * Street prop; `tree` is the sidewalk tree of the downtown / suburb blocks (two species, picked by the renderer from
 * the placement index), `hedge` a 2 m clipped hedge unit on a lot's street edge. The clutter kinds: `pole` is a timber
 * utility pole (the renderer strings catenary wires between neighbouring ones), `roadsign` a warning / stop plate on a
 * post at an intersection approach, `dumpster` a wheeled bin in a service alley, `table` a café table with a parasol
 * under an arcade.
 */
export interface Prop { kind: 'palm' | 'lamp' | 'bench' | 'hydrant' | 'bin' | 'sign' | 'shelter' | 'bollard' | 'tree' | 'hedge' | 'pole' | 'roadsign' | 'dumpster' | 'table'; x: number; z: number; yaw: number; scale: number }
export interface Landmark { kind: 'tower' | 'arena' | 'lighthouse' | 'ferris' | 'hospital' | 'police' | 'pier'; x: number; z: number; yaw: number; w: number; d: number; h: number; name: string }
export interface ParkedSpot { x: number; z: number; yaw: number }
export interface NeonSign { x: number; y: number; z: number; yaw: number; text: string; color: number; w: number; h: number }
export interface NamedPoint { x: number; z: number; yaw: number }
export type ParkedSpec = 'sedan' | 'sport' | 'van';
/**
 * A static car filling a lot bay (`at: 'lot'`, on the lot floor) or parked along a kerb (`at: 'kerb'`, up on the
 * pavement strip against the kerb): set dressing with a collider, never a Vehicle (CityRendererProps draws a cheap
 * shell of `spec` tinted `colour`). The nose points along `yaw` (0 = +Z), always a multiple of a quarter turn.
 */
export interface ParkedCar { x: number; z: number; yaw: number; spec: ParkedSpec; colour: number; at: 'lot' | 'kerb' }
/** Lot furniture: kerb islands at the heads of the bay strips and the planters standing on them (`booth` is reserved). */
export interface LotProp { kind: 'planter' | 'island' | 'booth'; x: number; z: number; yaw: number }
export interface CityData {
  seed: number; buildings: Building[]; blocks: Block[]; props: Prop[]; landmarks: Landmark[]; parkedSpots: ParkedSpot[];
  staticColliders: StaticCollider[]; neonSigns: NeonSign[]; bounds: AABB;
  /** Empty lot cells used as off-street parking (kerb ring, bays and wheel stops are drawn from these). */
  lots?: Lot[];
  /** Static cars in the lot bays (about 40 % of the bays gameplay does not use) and along the kerbs, and the lot furniture. */
  parked?: ParkedCar[];
  lotProps?: LotProp[];
  points: { playerSpawn: NamedPoint; hospital: NamedPoint; policeStation: NamedPoint; pier: NamedPoint; missionStarts: NamedPoint[]; garage: NamedPoint; beachDelivery: NamedPoint };
}
