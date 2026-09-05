// Plain-data types describing a generated city (buildings, blocks, props, landmarks, colliders, points). Track P0.
import type { AABB, StaticCollider } from '../core/Collision';

export type BuildingStyle = 'artdeco' | 'glass' | 'concrete' | 'neon' | 'residential';
export type District = 'downtown' | 'beachfront' | 'suburb';
export interface Building { id: number; x: number; z: number; w: number; d: number; h: number; style: BuildingStyle; color: number; accent: number; roofKind: 'flat' | 'stepped' | 'spire'; hasNeonSign: boolean; neonColor: number; district: District; facing: 0 | 1 | 2 | 3 /* +Z, +X, -Z, -X */ }
export interface Lot { blockCol: number; blockRow: number; x: number; z: number; w: number; d: number }
export interface Block { id: number; col: number; row: number; x0: number; z0: number; x1: number; z1: number; kind: 'buildings' | 'park' | 'landmark' | 'plaza'; buildings: number[] }
export interface Prop { kind: 'palm' | 'lamp' | 'bench' | 'hydrant' | 'bin' | 'sign' | 'shelter' | 'bollard'; x: number; z: number; yaw: number; scale: number }
export interface Landmark { kind: 'tower' | 'arena' | 'lighthouse' | 'ferris' | 'hospital' | 'police' | 'pier'; x: number; z: number; yaw: number; w: number; d: number; h: number; name: string }
export interface ParkedSpot { x: number; z: number; yaw: number }
export interface NeonSign { x: number; y: number; z: number; yaw: number; text: string; color: number; w: number; h: number }
export interface NamedPoint { x: number; z: number; yaw: number }
export interface CityData {
  seed: number; buildings: Building[]; blocks: Block[]; props: Prop[]; landmarks: Landmark[]; parkedSpots: ParkedSpot[];
  staticColliders: StaticCollider[]; neonSigns: NeonSign[]; bounds: AABB;
  /** Empty lot cells used as off-street parking (kerb ring, bays and wheel stops are drawn from these). */
  lots?: Lot[];
  points: { playerSpawn: NamedPoint; hospital: NamedPoint; policeStation: NamedPoint; pier: NamedPoint; missionStarts: NamedPoint[]; garage: NamedPoint; beachDelivery: NamedPoint };
}
