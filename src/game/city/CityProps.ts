// Landmarks, water/boundary colliders, plaza/park furnishing, street props (lamps, palms, hydrants), parked spots and named points. Track A.
import { BEACH_X0, BLOCK, CITY_MAX_X, CITY_MAX_Z, CITY_MIN_X, CITY_MIN_Z, LAMP_SPACING, LANDMARK_BLOCKS, LANE_W, OCEAN_SIZE, OCEAN_X0, PALMS_PER_BLOCK_EDGE, PLAZA_BLOCKS, ROAD_W } from './CityConfig';
import { BUDGET } from '../core/Budget';
import type { Block, CityData, Landmark, Lot, NamedPoint } from './CityData';
import { ASPHALT_HALF, addAabb, addCircle, addProp, blockIndex, clearance, distToNearestRoadNode, districtOf, nearestLaneYaw, onRoad, spotTooClose } from './CityBuild';
import type { GenContext } from './CityBuild';

export const PIER_Z = 590;
export const PIER_W = 12;
export const PIER_LEN = 120;
export const PIER_X0 = OCEAN_X0 - 10;
export const PIER_X1 = PIER_X0 + PIER_LEN;
export const SPAWN_BLOCK: [number, number] = [8, 5];
export const PROMENADE_X = BEACH_X0 + 2;

const WALL_T = 10;
const LAMP_CURB_OFFSET = 1; // lamps stand 1 m from the curb (ASPHALT_HALF + 1 from the road center)
const LAMP_NODE_CLEAR = 14;
const LAMP_R = 0.2;
const PALM_R = 0.35;
const BENCH_R = 0.7;
const HYDRANT_R = 0.25;
const BIN_R = 0.3;
const SIGN_R = 0.12;
const SHELTER_R = 0;      // decorative: a collider here would wall off the sidewalk graph
const BOLLARD_R = 0.12;
const BINS_PER_BLOCK = 2;
const SHELTER_EVERY = 3;  // one bus shelter per N building blocks
const BOLLARD_SPACING = 3.5;
const PALM_SIDEWALK_OFFSET = 2.3; // from the block edge (0.7 m from the curb)
const PLAZA_FOUNTAIN_R = 5;
const PLAZA_BENCH_RING = 9;
const PLAZA_PALM_RING = 28;
const PARK_PALMS = 40;
const PARK_BENCHES = 8;
const SPOT_NODE_DIST = 18;
const SPOT_SPACING = 9;
const SPOT_CLEAR = 3.2; // car half length 2.6 + 0.6 margin
const SPOT_LOT_INSET = 3.5;
const SPOT_LOT_CAP = 6;
const SPOT_LOT_CAP_OTHER = 4;
const SPAWN_SPOT_RADIUS = 40;

const blockCenterX = (b: Block): number => (b.x0 + b.x1) / 2;
const blockCenterZ = (b: Block): number => (b.z0 + b.z1) / 2;

function landmarkBox(ctx: GenContext, kind: Landmark['kind'], col: number, row: number, w: number, d: number, h: number, name: string): Landmark {
  const b = ctx.blocks[blockIndex(col, row)];
  const x = blockCenterX(b), z = blockCenterZ(b);
  const l: Landmark = { kind, x, z, yaw: 0, w, d, h, name };
  ctx.landmarks.push(l);
  addAabb(ctx, x - w / 2, z - d / 2, x + w / 2, z + d / 2, 'landmark', h);
  return l;
}

/** Tower, arena, hospital, police, lighthouse, pier (+ rails) and ferris wheel. Landmark w/d are world X/Z extents. */
export function addLandmarks(ctx: GenContext): void {
  const tower = landmarkBox(ctx, 'tower', LANDMARK_BLOCKS.tower[0], LANDMARK_BLOCKS.tower[1], 40, 40, 160, 'Turuncu Kule');
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    addProp(ctx, 'palm', tower.x + Math.cos(a) * 36, tower.z + Math.sin(a) * 36, a, 1, PALM_R);
  }
  // Arena: the spec's 150x90 footprint would cover the surrounding roads, so it is clamped to the block (90x70).
  landmarkBox(ctx, 'arena', LANDMARK_BLOCKS.arena[0], LANDMARK_BLOCKS.arena[1], 90, 70, 28, 'Arena');
  landmarkBox(ctx, 'hospital', LANDMARK_BLOCKS.hospital[0], LANDMARK_BLOCKS.hospital[1], 60, 60, 24, 'Hastane');
  landmarkBox(ctx, 'police', LANDMARK_BLOCKS.police[0], LANDMARK_BLOCKS.police[1], 60, 50, 18, 'Polis Merkezi');
  const lx = BEACH_X0 + 45, lz = 40;
  ctx.landmarks.push({ kind: 'lighthouse', x: lx, z: lz, yaw: 0, w: 10, d: 10, h: 35, name: 'Deniz Feneri' });
  addCircle(ctx, lx, lz, 5, 'landmark', 35);
  // Pier: walkable deck (no collider), two rail boxes along the long edges.
  ctx.landmarks.push({ kind: 'pier', x: (PIER_X0 + PIER_X1) / 2, z: PIER_Z, yaw: Math.PI / 2, w: PIER_LEN, d: PIER_W, h: 1.2, name: 'İskele' });
  addAabb(ctx, PIER_X0, PIER_Z - PIER_W / 2, PIER_X1, PIER_Z - PIER_W / 2 + 0.4, 'prop', 1.1);
  addAabb(ctx, PIER_X0, PIER_Z + PIER_W / 2 - 0.4, PIER_X1, PIER_Z + PIER_W / 2, 'prop', 1.1);
  const fx = PIER_X1 + 14;
  ctx.landmarks.push({ kind: 'ferris', x: fx, z: PIER_Z, yaw: Math.PI / 2, w: 8, d: 36, h: 40, name: 'Dönme Dolap' });
  addCircle(ctx, fx, PIER_Z, 6, 'landmark', 40);
}

/** Ocean water (split around the pier deck) and 10 m boundary walls (N/S/W, and E beyond the beach with a gap for the pier). */
export function addWaterAndBounds(ctx: GenContext): void {
  const wx = OCEAN_X0 + 6;
  const zn = PIER_Z - PIER_W / 2, zs = PIER_Z + PIER_W / 2;
  addAabb(ctx, wx, -OCEAN_SIZE, wx + OCEAN_SIZE, zn, 'water', 0);
  addAabb(ctx, wx, zs, wx + OCEAN_SIZE, CITY_MAX_Z + OCEAN_SIZE, 'water', 0);
  addAabb(ctx, PIER_X1, zn, wx + OCEAN_SIZE, zs, 'water', 0);
  addAabb(ctx, CITY_MIN_X - WALL_T, CITY_MIN_Z - WALL_T, wx + WALL_T, CITY_MIN_Z, 'boundary', 6);
  addAabb(ctx, CITY_MIN_X - WALL_T, CITY_MAX_Z, wx + WALL_T, CITY_MAX_Z + WALL_T, 'boundary', 6);
  addAabb(ctx, CITY_MIN_X - WALL_T, CITY_MIN_Z, CITY_MIN_X, CITY_MAX_Z, 'boundary', 6);
  addAabb(ctx, wx, CITY_MIN_Z, wx + WALL_T, zn, 'boundary', 6);
  addAabb(ctx, wx, zs, wx + WALL_T, CITY_MAX_Z, 'boundary', 6);
  addAabb(ctx, PIER_X1, zn, PIER_X1 + WALL_T, zs, 'boundary', 6);
}

/** Plazas: fountain (circle collider r 5), 8 benches facing it, 12 palms on an outer ring. */
export function furnishPlazas(ctx: GenContext): void {
  const rng = ctx.rng;
  for (let i = 0; i < PLAZA_BLOCKS.length; i++) {
    const b = ctx.blocks[blockIndex(PLAZA_BLOCKS[i][0], PLAZA_BLOCKS[i][1])];
    const cx = blockCenterX(b), cz = blockCenterZ(b);
    addCircle(ctx, cx, cz, PLAZA_FOUNTAIN_R, 'landmark', 3);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      const x = cx + Math.cos(a) * PLAZA_BENCH_RING, z = cz + Math.sin(a) * PLAZA_BENCH_RING;
      addProp(ctx, 'bench', x, z, Math.atan2(cx - x, cz - z), 1, BENCH_R);
    }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      addProp(ctx, 'palm', cx + Math.cos(a) * PLAZA_PALM_RING, cz + Math.sin(a) * PLAZA_PALM_RING, rng.range(0, Math.PI * 2), rng.range(0.9, 1.15), PALM_R);
    }
  }
}

/** Park: 40 palms and 8 benches scattered with minimum spacing. */
export function furnishPark(ctx: GenContext): void {
  const rng = ctx.rng;
  const b = ctx.blocks[blockIndex(LANDMARK_BLOCKS.park[0], LANDMARK_BLOCKS.park[1])];
  let palms = 0, tries = 0;
  while (palms < PARK_PALMS && tries++ < 2000) {
    const x = rng.range(b.x0 + 5, b.x1 - 5), z = rng.range(b.z0 + 5, b.z1 - 5);
    if (clearance(ctx.hash, x, z, 8) < 5) continue;
    addProp(ctx, 'palm', x, z, rng.range(0, Math.PI * 2), rng.range(0.85, 1.2), PALM_R);
    palms++;
  }
  let benches = 0;
  tries = 0;
  while (benches < PARK_BENCHES && tries++ < 2000) {
    const x = rng.range(b.x0 + 8, b.x1 - 8), z = rng.range(b.z0 + 8, b.z1 - 8);
    if (clearance(ctx.hash, x, z, 8) < 3) continue;
    addProp(ctx, 'bench', x, z, rng.range(0, Math.PI * 2), 1, BENCH_R);
    benches++;
  }
}

/** Lamps every LAMP_SPACING along every segment (staggered per side, >= 14 m from nodes), beachfront sidewalk palms, hydrants. */
export function addStreetProps(ctx: GenContext): void {
  const roads = ctx.roads;
  const lampOffset = ASPHALT_HALF + LAMP_CURB_OFFSET;
  for (let s = 0; s < roads.segments.length; s++) {
    const seg = roads.segments[s];
    const a = roads.nodes[seg.a], b = roads.nodes[seg.b];
    const dx = (b.x - a.x) / seg.length, dz = (b.z - a.z) / seg.length;
    const rx = -dz, rz = dx;
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      const stagger = side === 0 ? 0 : LAMP_SPACING / 2;
      for (let t = LAMP_SPACING / 2 + stagger; t <= seg.length - LAMP_NODE_CLEAR; t += LAMP_SPACING) {
        if (t < LAMP_NODE_CLEAR) continue;
        const x = a.x + dx * t + rx * sgn * lampOffset, z = a.z + dz * t + rz * sgn * lampOffset;
        addProp(ctx, 'lamp', x, z, Math.atan2(-rx * sgn, -rz * sgn), 1, LAMP_R);
      }
    }
  }
  const rng = ctx.rng;
  for (let bi = 0; bi < ctx.blocks.length; bi++) {
    const b = ctx.blocks[bi];
    if (b.kind !== 'buildings') continue;
    if (districtOf(b.col, b.row) === 'beachfront') {
      for (let k = 0; k < PALMS_PER_BLOCK_EDGE; k++) {
        const f = (k + 0.5) / PALMS_PER_BLOCK_EDGE;
        const ax = b.x0 + BLOCK * f, az = b.z0 + BLOCK * f;
        const o = PALM_SIDEWALK_OFFSET;
        tryPalm(ctx, ax, b.z0 - o); tryPalm(ctx, ax, b.z1 + o); tryPalm(ctx, b.x0 - o, az); tryPalm(ctx, b.x1 + o, az);
      }
    }
    const edge = rng.int(0, 3), t = rng.chance(0.5) ? 12 : BLOCK - 12, o = 0.7;
    const hx = edge === 0 ? b.x0 + t : edge === 1 ? b.x1 + o : edge === 2 ? b.x0 + t : b.x0 - o;
    const hz = edge === 0 ? b.z0 - o : edge === 1 ? b.z0 + t : edge === 2 ? b.z1 + o : b.z0 + t;
    if (clearance(ctx.hash, hx, hz, 4) >= 0.8) addProp(ctx, 'hydrant', hx, hz, 0, 1, HYDRANT_R);
    addBlockFurniture(ctx, b, bi);
  }
}

/**
 * Sidewalk dressing for one building block: a street-name sign on the corner nearest the intersection, a couple of
 * litter bins along random edges and, every few blocks, a bus shelter facing the road. Everything is placed with a
 * clearance test so nothing lands inside a building, a lamp or a parked car.
 */
function addBlockFurniture(ctx: GenContext, b: Block, bi: number): void {
  const rng = ctx.rng;
  // Street-name sign just off the block's south-west corner. It has to clear the intersection box (INTERSECTION_R
  // around the node), so it sits a few metres up the side street rather than on the corner itself.
  const sx = b.x0 - 1.15, sz = b.z0 + 4;
  if (clearance(ctx.hash, sx, sz, 4) >= 0.7) addProp(ctx, 'sign', sx, sz, Math.PI / 4, 1, SIGN_R);
  for (let k = 0; k < BINS_PER_BLOCK; k++) {
    const edge = rng.int(0, 3), t = rng.range(11, BLOCK - 11), e = 0.85;
    const x = edge === 0 ? b.x0 + t : edge === 1 ? b.x1 + e : edge === 2 ? b.x0 + t : b.x0 - e;
    const z = edge === 0 ? b.z0 - e : edge === 1 ? b.z0 + t : edge === 2 ? b.z1 + e : b.z0 + t;
    if (clearance(ctx.hash, x, z, 4) >= 0.7) addProp(ctx, 'bin', x, z, rng.range(0, Math.PI * 2), 1, BIN_R);
  }
  if (bi % SHELTER_EVERY !== 0) return;
  // Bus shelter set back from the curb, its back to the block and its opening on the road side.
  const side = (bi / SHELTER_EVERY) % 4;
  const mid = BLOCK / 2 + rng.range(-8, 8), s = 1.6;
  const hx = side === 0 ? b.x0 + mid : side === 1 ? b.x1 + s : side === 2 ? b.x0 + mid : b.x0 - s;
  const hz = side === 0 ? b.z0 - s : side === 1 ? b.z0 + mid : side === 2 ? b.z1 + s : b.z0 + mid;
  // The shelter's glazed back is its local +Z, so each side turns it towards the block and leaves the opening
  // facing the road.
  const yaw = side === 0 ? 0 : side === 1 ? -Math.PI / 2 : side === 2 ? Math.PI : Math.PI / 2;
  if (clearance(ctx.hash, hx, hz, 6) >= 2.2) addProp(ctx, 'shelter', hx, hz, yaw, 1, SHELTER_R);
}

function tryPalm(ctx: GenContext, x: number, z: number): void {
  if (clearance(ctx.hash, x, z, 4) < 1) return;
  addProp(ctx, 'palm', x, z, ctx.rng.range(0, Math.PI * 2), ctx.rng.range(0.85, 1.15), PALM_R);
}

/** Bollards along the promenade edge, keeping cars off the beach walk. */
export function addPromenadeBollards(ctx: GenContext): void {
  // On the beach side of the boundary road, and never inside an intersection box.
  const x = BEACH_X0 + 1.4;
  for (let z = 16; z <= CITY_MAX_Z - 16; z += BOLLARD_SPACING) {
    if (distToNearestRoadNode(ctx.roads, x, z) < 14) continue;
    if (clearance(ctx.hash, x, z, 4) < 0.6) continue;
    addProp(ctx, 'bollard', x, z, 0, 1, BOLLARD_R);
  }
}

/** Promenade palms: two rows (BEACH_X0 + 4 and + 14), every 12 m. */
export function addPromenadePalms(ctx: GenContext): void {
  const rng = ctx.rng;
  for (let row = 0; row < 2; row++) {
    const x = BEACH_X0 + (row === 0 ? 4 : 14);
    for (let z = 20; z <= CITY_MAX_Z - 20; z += 12) {
      if (clearance(ctx.hash, x, z, 8) < 2) continue;
      addProp(ctx, 'palm', x, z, rng.range(0, Math.PI * 2), rng.range(0.9, 1.2), PALM_R);
    }
  }
}

function trySpot(ctx: GenContext, x: number, z: number, yaw: number): boolean {
  if (x < CITY_MIN_X + 5 || z < CITY_MIN_Z + 5 || z > CITY_MAX_Z - 5 || x > OCEAN_X0) return false;
  if (distToNearestRoadNode(ctx.roads, x, z) < SPOT_NODE_DIST) return false;
  if (onRoad(ctx.roads, x, z, LANE_W / 2 + 1.2)) return false;
  if (clearance(ctx.hash, x, z, SPOT_CLEAR + 6) < SPOT_CLEAR) return false;
  if (spotTooClose(ctx.parkedSpots, x, z, SPOT_SPACING)) return false;
  ctx.parkedSpots.push({ x, z, yaw });
  return true;
}

function fillLot(ctx: GenContext, lot: Lot, cap: number, nearX: number, nearZ: number): number {
  const x0 = lot.x - lot.w / 2 + SPOT_LOT_INSET, x1 = lot.x + lot.w / 2 - SPOT_LOT_INSET;
  const z0 = lot.z - lot.d / 2 + SPOT_LOT_INSET, z1 = lot.z + lot.d / 2 - SPOT_LOT_INSET;
  const yaw = nearestLaneYaw(ctx.roads, lot.x, lot.z);
  const cand: { x: number; z: number; d: number }[] = [];
  for (let z = z0; z <= z1 + 1e-6; z += SPOT_SPACING) for (let x = x0; x <= x1 + 1e-6; x += SPOT_SPACING) cand.push({ x, z, d: (x - nearX) * (x - nearX) + (z - nearZ) * (z - nearZ) });
  cand.sort((a, b) => a.d - b.d);
  let placed = 0;
  for (let i = 0; i < cand.length && placed < cap && ctx.parkedSpots.length < BUDGET.PARKED; i++) if (trySpot(ctx, cand[i].x, cand[i].z, yaw)) placed++;
  return placed;
}

/**
 * BUDGET.PARKED off-street spots: the spawn lot first (>= 3 within 40 m of the spawn), plaza edges, the beach near the pier,
 * then empty lots (beachfront first, nearest to the spawn first). Spots are never on a lane, >= 18 m from nodes, >= 9 m apart.
 */
export function placeParkedSpots(ctx: GenContext, spawn: NamedPoint): void {
  const lots = ctx.emptyLots;
  const spawnBlock = blockIndex(SPAWN_BLOCK[0], SPAWN_BLOCK[1]);
  let spawnLot: Lot | null = null, bd = Infinity;
  for (let i = 0; i < lots.length; i++) {
    const l = lots[i];
    if (blockIndex(l.blockCol, l.blockRow) !== spawnBlock) continue;
    const d = (l.x - spawn.x) * (l.x - spawn.x) + (l.z - spawn.z) * (l.z - spawn.z);
    if (d < bd) { bd = d; spawnLot = l; }
  }
  if (spawnLot) fillLot(ctx, spawnLot, SPOT_LOT_CAP, spawn.x, spawn.z);
  for (let i = 0; i < PLAZA_BLOCKS.length; i++) {
    const b = ctx.blocks[blockIndex(PLAZA_BLOCKS[i][0], PLAZA_BLOCKS[i][1])];
    const z = b.z1 - 4.5, cx = blockCenterX(b);
    for (let k = -1; k <= 1; k++) trySpot(ctx, cx + k * 12, z, nearestLaneYaw(ctx.roads, cx + k * 12, z));
  }
  const bx = BEACH_X0 + 24;
  for (let k = 0; k < 10 && ctx.parkedSpots.length < BUDGET.PARKED; k++) trySpot(ctx, bx, PIER_Z - 120 + k * 12, nearestLaneYaw(ctx.roads, bx, PIER_Z - 120 + k * 12));
  const ordered: Lot[] = [];
  for (let i = 0; i < lots.length; i++) if (lots[i] !== spawnLot) ordered.push(lots[i]);
  const rank = (l: Lot): number => (districtOf(l.blockCol, l.blockRow) === 'beachfront' ? 0 : 1e7) + (l.x - spawn.x) * (l.x - spawn.x) + (l.z - spawn.z) * (l.z - spawn.z);
  ordered.sort((a, b) => rank(a) - rank(b));
  for (let i = 0; i < ordered.length && ctx.parkedSpots.length < BUDGET.PARKED; i++) fillLot(ctx, ordered[i], SPOT_LOT_CAP_OTHER, spawn.x, spawn.z);
  // Safety net: more beach spots if the lots could not supply the budget.
  for (let k = 0; k < 60 && ctx.parkedSpots.length < BUDGET.PARKED; k++) trySpot(ctx, bx + (k % 2) * 12, 60 + k * 18, 0);
  if (ctx.parkedSpots.length > BUDGET.PARKED) ctx.parkedSpots.length = BUDGET.PARKED;
}

function pointAt(ctx: GenContext, nodeId: number, yaw: number): NamedPoint {
  const n = ctx.sidewalks.nodes[nodeId];
  return { x: n.x, z: n.z, yaw };
}

/** All named points come from sidewalk/promenade nodes (loop index 4 = east-edge mid node, 8 = south-edge mid node). */
export function makePoints(ctx: GenContext): CityData['points'] {
  const loopOf = (col: number, row: number): number[] => ctx.sidewalks.loops[blockIndex(col, row)];
  const missionStarts: NamedPoint[] = [];
  for (let i = 0; i < PLAZA_BLOCKS.length; i++) missionStarts.push(pointAt(ctx, loopOf(PLAZA_BLOCKS[i][0], PLAZA_BLOCKS[i][1])[8], 0));
  const prom = ctx.sidewalks.nearestNode(PROMENADE_X, PIER_Z);
  return {
    playerSpawn: pointAt(ctx, loopOf(SPAWN_BLOCK[0], SPAWN_BLOCK[1])[4], Math.PI / 2),
    hospital: pointAt(ctx, loopOf(LANDMARK_BLOCKS.hospital[0], LANDMARK_BLOCKS.hospital[1])[8], 0),
    policeStation: pointAt(ctx, loopOf(LANDMARK_BLOCKS.police[0], LANDMARK_BLOCKS.police[1])[8], 0),
    pier: { x: PIER_X0 + 3, z: PIER_Z, yaw: Math.PI / 2 },
    missionStarts,
    garage: pointAt(ctx, loopOf(7, 2)[8], 0),
    beachDelivery: { x: prom.x, z: prom.z, yaw: 0 },
  };
}

export function spawnSpotCount(ctx: GenContext, spawn: NamedPoint): number {
  let n = 0;
  for (let i = 0; i < ctx.parkedSpots.length; i++) {
    const s = ctx.parkedSpots[i];
    if ((s.x - spawn.x) * (s.x - spawn.x) + (s.z - spawn.z) * (s.z - spawn.z) <= SPAWN_SPOT_RADIUS * SPAWN_SPOT_RADIUS) n++;
  }
  return n;
}

void CITY_MAX_X;
void ROAD_W;
