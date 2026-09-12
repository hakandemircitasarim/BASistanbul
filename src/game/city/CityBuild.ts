// Shared generation context, collider helpers and geometric predicates used by the city generator modules. Track A.
import type { Random } from '../core/Random';
import type { StaticCollider } from '../core/Collision';
import { SpatialHash } from '../core/SpatialHash';
import { BLOCK, DISTRICTS, GRID_COLS, INTERSECTION_R, LANDMARK_BLOCKS, LANES_PER_DIR, LANE_W, PITCH, PLAZA_BLOCKS, ROAD_W } from './CityConfig';
import type { Block, Building, CityData, District, Landmark, Lot, LotProp, NeonSign, ParkedCar, ParkedSpec, ParkedSpot, Prop } from './CityData';
import type { RoadGraph, LanePos } from './RoadGraph';
import type { SidewalkGraph } from './SidewalkGraph';

export interface GenContext {
  rng: Random;
  blocks: Block[];
  buildings: Building[];
  colliders: StaticCollider[];
  hash: SpatialHash<StaticCollider>;
  props: Prop[];
  landmarks: Landmark[];
  neonSigns: NeonSign[];
  parkedSpots: ParkedSpot[];
  emptyLots: Lot[];
  parked: ParkedCar[];
  lotProps: LotProp[];
  roads: RoadGraph;
  sidewalks: SidewalkGraph;
  /** Named points, once CityProps.makePoints has produced them (the street dressing keeps clear of them). */
  points?: CityData['points'];
}

export const STATIC_CELL = 32;
/** Asphalt half width: outer lane edge from the road center line (7 m). */
export const ASPHALT_HALF = LANES_PER_DIR * LANE_W;

export function createContext(rng: Random, roads: RoadGraph, sidewalks: SidewalkGraph, blocks: Block[]): GenContext {
  return { rng, blocks, buildings: [], colliders: [], hash: new SpatialHash<StaticCollider>(STATIC_CELL), props: [], landmarks: [], neonSigns: [], parkedSpots: [], emptyLots: [], parked: [], lotProps: [], roads, sidewalks };
}

export function districtOf(col: number, row: number): District {
  if (col >= GRID_COLS - DISTRICTS.beachfrontCols) return 'beachfront';
  const d = DISTRICTS.downtown;
  if (col >= d.col[0] && col <= d.col[1] && row >= d.row[0] && row <= d.row[1]) return 'downtown';
  return 'suburb';
}

export function blockKind(col: number, row: number): Block['kind'] {
  for (const k in LANDMARK_BLOCKS) {
    const cr = LANDMARK_BLOCKS[k as keyof typeof LANDMARK_BLOCKS];
    if (cr[0] === col && cr[1] === row) return k === 'park' ? 'park' : 'landmark';
  }
  for (let i = 0; i < PLAZA_BLOCKS.length; i++) if (PLAZA_BLOCKS[i][0] === col && PLAZA_BLOCKS[i][1] === row) return 'plaza';
  return 'buildings';
}

export const blockIndex = (col: number, row: number): number => row * GRID_COLS + col;

export function makeBlocks(rows: number): Block[] {
  const blocks: Block[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const x0 = ROAD_W + col * PITCH, z0 = ROAD_W + row * PITCH;
      blocks.push({ id: blocks.length, col, row, x0, z0, x1: x0 + BLOCK, z1: z0 + BLOCK, kind: blockKind(col, row), buildings: [] });
    }
  }
  return blocks;
}

export function addAabb(ctx: GenContext, minX: number, minZ: number, maxX: number, maxZ: number, tag: StaticCollider['tag'], height: number): StaticCollider {
  const c: StaticCollider = { id: ctx.colliders.length, shape: { kind: 'aabb', minX, minZ, maxX, maxZ }, tag, height, minX, minZ, maxX, maxZ, hashStamp: 0 };
  ctx.colliders.push(c);
  ctx.hash.insert(c);
  return c;
}

export function addCircle(ctx: GenContext, cx: number, cz: number, r: number, tag: StaticCollider['tag'], height: number): StaticCollider {
  const c: StaticCollider = { id: ctx.colliders.length, shape: { kind: 'circle', cx, cz, r }, tag, height, minX: cx - r, minZ: cz - r, maxX: cx + r, maxZ: cz + r, hashStamp: 0 };
  ctx.colliders.push(c);
  ctx.hash.insert(c);
  return c;
}

/** Collider height per prop kind (scaled by the instance scale for the two tree kinds); 1 m is "anything waist high". */
const PROP_HEIGHT: Record<Prop['kind'], number> = {
  palm: 7, tree: 6.5, lamp: 6, sign: 2.6, shelter: 2.5, pole: 8.4, roadsign: 2.4, dumpster: 1.3, table: 2.2,
  bench: 1, hydrant: 1, bin: 1, bollard: 1, hedge: 1,
};

export function addProp(ctx: GenContext, kind: Prop['kind'], x: number, z: number, yaw: number, scale: number, colliderR: number): void {
  ctx.props.push({ kind, x, z, yaw, scale });
  if (colliderR > 0) addCircle(ctx, x, z, colliderR * scale, 'prop', PROP_HEIGHT[kind] * (kind === 'palm' || kind === 'tree' ? scale : 1));
}

/** Prop with a box footprint (a hedge unit): half sizes `hw` across x `hl` along the nose at a quarter-turn yaw. */
export function addPropBox(ctx: GenContext, kind: Prop['kind'], x: number, z: number, yaw: number, scale: number, halfW: number, halfL: number, height: number): void {
  ctx.props.push({ kind, x, z, yaw, scale });
  addFootprint(ctx, x, z, yaw, halfW * scale, halfL * scale, height);
}

/**
 * AABB collider of a box of half sizes `hw` (across) x `hl` (along the nose) at a quarter-turn yaw: the footprint of a
 * parked car or a kerb island. (right = (-cos yaw, sin yaw), forward = (sin yaw, cos yaw).)
 */
function addFootprint(ctx: GenContext, x: number, z: number, yaw: number, hw: number, hl: number, height: number): void {
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  const ex = hw * c + hl * s, ez = hw * s + hl * c;
  addAabb(ctx, x - ex, z - ez, x + ex, z + ez, 'prop', height);
}

/** Static parked car (lot or kerb set dressing) with its footprint collider, like the sign / shelter props. */
export function addParkedCar(ctx: GenContext, x: number, z: number, yaw: number, spec: ParkedSpec, colour: number, halfW: number, halfL: number, height: number, at: ParkedCar['at']): void {
  ctx.parked.push({ x, z, yaw, spec, colour, at });
  addFootprint(ctx, x, z, yaw, halfW, halfL, height);
}

/** Lot furniture; a zero footprint (planters standing on an island already inside its collider) adds no collider. */
export function addLotProp(ctx: GenContext, kind: LotProp['kind'], x: number, z: number, yaw: number, halfW: number, halfL: number, height: number): void {
  ctx.lotProps.push({ kind, x, z, yaw });
  if (halfW > 0 && halfL > 0) addFootprint(ctx, x, z, yaw, halfW, halfL, height);
}

/** Distance from a point to a collider's surface (negative when inside an AABB / circle). */
export function colliderDistance(c: StaticCollider, x: number, z: number): number {
  const s = c.shape;
  if (s.kind === 'circle') return Math.sqrt((x - s.cx) * (x - s.cx) + (z - s.cz) * (z - s.cz)) - s.r;
  const dx = Math.max(s.minX - x, 0, x - s.maxX), dz = Math.max(s.minZ - z, 0, z - s.maxZ);
  if (dx === 0 && dz === 0) return -Math.min(x - s.minX, s.maxX - x, z - s.minZ, s.maxZ - z);
  return Math.sqrt(dx * dx + dz * dz);
}

const queryOut: StaticCollider[] = [];

/** Smallest distance from (x,z) to any collider surface within `radius` (Infinity when none). */
export function clearance(hash: SpatialHash<StaticCollider>, x: number, z: number, radius: number, ignoreWater = false): number {
  const n = hash.queryCircle(x, z, radius, queryOut);
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const c = queryOut[i];
    if (ignoreWater && c.tag === 'water') continue;
    const d = colliderDistance(c, x, z);
    if (d < best) best = d;
  }
  return best;
}

/**
 * True when the axis-aligned rectangle, grown by `pad`, touches no collider (water and boundary walls ignored): the
 * footprint test for kerbside cars and hedge units.
 */
export function rectClear(hash: SpatialHash<StaticCollider>, x0: number, z0: number, x1: number, z1: number, pad: number): boolean {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const r = Math.hypot(x1 - x0, z1 - z0) / 2 + pad + 1;
  const n = hash.queryCircle(cx, cz, r, queryOut);
  for (let i = 0; i < n; i++) {
    const c = queryOut[i];
    if (c.tag === 'water' || c.tag === 'boundary') continue;
    const s = c.shape;
    if (s.kind === 'aabb') {
      if (s.minX < x1 + pad && s.maxX > x0 - pad && s.minZ < z1 + pad && s.maxZ > z0 - pad) return false;
    } else {
      const dx = Math.max(x0 - s.cx, 0, s.cx - x1), dz = Math.max(z0 - s.cz, 0, s.cz - z1);
      if (dx * dx + dz * dz < (s.r + pad) * (s.r + pad)) return false;
    }
  }
  return true;
}

const lanePos: LanePos = { lane: 0, t: 0 };

/** True when (x,z) lies inside the nearest lane's rectangle (half width `halfW`) or inside an intersection's asphalt square. */
export function onRoad(roads: RoadGraph, x: number, z: number, halfW: number): boolean {
  const node = roads.nearestNode(x, z);
  const pad = INTERSECTION_R - 1 + (halfW - LANE_W / 2);
  if (Math.abs(x - node.x) < pad && Math.abs(z - node.z) < pad) return true;
  roads.nearestLane(x, z, lanePos);
  const l = roads.lanes[lanePos.lane];
  const t = (x - l.start.x) * l.dir.x + (z - l.start.z) * l.dir.z;
  const px = l.start.x + l.dir.x * t, pz = l.start.z + l.dir.z * t;
  const perp = Math.sqrt((px - x) * (px - x) + (pz - z) * (pz - z));
  return perp <= halfW && t >= -halfW && t <= l.length + halfW;
}

export function distToNearestRoadNode(roads: RoadGraph, x: number, z: number): number {
  const n = roads.nearestNode(x, z);
  return Math.sqrt((n.x - x) * (n.x - x) + (n.z - z) * (n.z - z));
}

/** Yaw of the nearest lane's direction of travel. */
export function nearestLaneYaw(roads: RoadGraph, x: number, z: number): number {
  roads.nearestLane(x, z, lanePos);
  const d = roads.lanes[lanePos.lane].dir;
  return Math.atan2(d.x, d.z);
}

export function landmarkOf(ctx: GenContext, kind: Landmark['kind']): Landmark | null {
  for (let i = 0; i < ctx.landmarks.length; i++) if (ctx.landmarks[i].kind === kind) return ctx.landmarks[i];
  return null;
}

export function spotTooClose(spots: ParkedSpot[], x: number, z: number, minDist: number): boolean {
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    if ((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < minDist * minDist) return true;
  }
  return false;
}
