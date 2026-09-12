// Landmarks, water/boundary colliders, plaza/park furnishing, street props (lamps, palms, trees, hydrants), kerbside parking, parked spots and named points. Track A.
import { BEACH_X0, BLOCK, CITY_MAX_X, CITY_MAX_Z, CITY_MIN_X, CITY_MIN_Z, LAMP_SPACING, LANDMARK_BLOCKS, LANE_W, OCEAN_SIZE, OCEAN_X0, PALMS_PER_BLOCK_EDGE, PLAZA_BLOCKS, ROAD_W, SIDEWALK_W } from './CityConfig';
import { BUDGET } from '../core/Budget';
import type { Block, CityData, District, Landmark, Lot, NamedPoint, ParkedSpec } from './CityData';
import { ASPHALT_HALF, addAabb, addCircle, addParkedCar, addProp, addPropBox, blockIndex, clearance, distToNearestRoadNode, districtOf, nearestLaneYaw, onRoad, rectClear, spotTooClose } from './CityBuild';
import type { GenContext } from './CityBuild';
import type { Random } from '../core/Random';
import { SPECS } from '../entities/VehicleSpecs';

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

/**
 * Sidewalk trees (downtown / suburb): an irregular pitch along a block edge (12-22 m, seeded), the first one 8-14 m
 * from the corner, offset from the block edge (0.7 m off the kerb, like the palms), scale 0.8-1.3 per tree.
 */
const TREE = { pitchMin: 12, pitchMax: 22, first: 8, firstJitter: 6, offset: 2.3, r: 0.3, clear: 1.2, shelterClear: 4.5, scaleMin: 0.8, scaleMax: 1.3 } as const;
/**
 * Kerbside parking: cars stand on the pavement strip hard against the kerb (their road-side flank `kerbGap` off the
 * asphalt edge, i.e. wholly outside the outer lane), noses along the adjacent lane's direction of travel, in runs
 * between the street furniture. `endClear` keeps them off the corner boxes and crossings, the fill share varies by
 * district, and hydrants / bus shelters / named points get their own no-parking clearances.
 */
const KERB = { kerbGap: 0.08, endClear: 6, gapMin: 0.7, gapMax: 1.8, pad: 0.3, hydrantClear: 1.5, shelterClear: 3.2, pointClear: 3.5, height: 1.5 } as const;

/**
 * Street clutter (all placed after the lamps, trees and hydrants and before the kerbside cars, so the cars leave gaps
 * for it). Poles stand on the kerb line of the suburb streets in runs along one block edge — the renderer strings
 * catenary wires between neighbours on the same edge, which is why the pitch is per-run and never crosses a corner.
 * Signs sit on the intersection approaches, dumpsters in the service alleys between buildings (`depth` inside the
 * block edge: anywhere a building stands, the clearance test rejects the sample), café tables in the arcade strip
 * between the block edge and the shopfronts.
 */
export const POLE = { off: 2.5, first: 15, firstJitter: 5, pitchMin: 23, pitchMax: 33, endClear: 14, r: 0.19, clear: 1.3 } as const;
export const ROADSIGN = { off: 2.45, along: 7.5, alongJitter: 2.5, r: 0.12, clear: 1.4, perBlock: 2 } as const;
export const DUMPSTER = { depth: 5.6, step: 6.5, halfLong: 1.18, halfDeep: 0.74, clear: 1.5, height: 1.35, chance: 0.34, margin: 12 } as const;
export const CAFE = { inset: 1.15, pitch: 2.9, r: 0.52, clear: 0.95, perRun: 3, everyBlocks: 3, margin: 16 } as const;
/**
 * Clearance the clutter keeps from a gameplay parking spot. Spots are placed before this pass and carry no collider
 * of their own, so nothing here would otherwise notice one (validateCity wants a spot 0.6 m clear of every collider).
 */
export const CLUTTER_SPOT_CLEAR = 3.6;
/** Lamp pitch jitter: +-3.5 m off the LAMP_SPACING picket line, so a street reads as placed rather than stamped. */
const LAMP_JITTER = 3.5;
/** Local +Z of a prop placed on block edge 0..3 points away from the block (at the road), like the bus shelters. */
const EDGE_OUT_YAW = [0, Math.PI / 2, Math.PI, -Math.PI / 2] as const;
const KERB_FILL: Record<District, number> = { downtown: 0.58, suburb: 0.46, beachfront: 0.52 };
const KERB_MIX: { key: ParkedSpec; weight: number }[] = [{ key: 'sedan', weight: 62 }, { key: 'sport', weight: 18 }, { key: 'van', weight: 20 }];

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
  // Own stream, so the jitter never shifts the rest of the city's seeded decisions.
  const jrng = ctx.rng.fork();
  for (let s = 0; s < roads.segments.length; s++) {
    const seg = roads.segments[s];
    const a = roads.nodes[seg.a], b = roads.nodes[seg.b];
    const dx = (b.x - a.x) / seg.length, dz = (b.z - a.z) / seg.length;
    const rx = -dz, rz = dx;
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      const stagger = side === 0 ? 0 : LAMP_SPACING / 2;
      for (let t = LAMP_SPACING / 2 + stagger; t <= seg.length - LAMP_NODE_CLEAR; t += LAMP_SPACING) {
        // The picket line is broken by +-LAMP_JITTER, clamped back inside the node clearance at both ends.
        const tj = Math.min(seg.length - LAMP_NODE_CLEAR, Math.max(LAMP_NODE_CLEAR, t + jrng.range(-LAMP_JITTER, LAMP_JITTER)));
        if (tj < LAMP_NODE_CLEAR) continue;
        const x = a.x + dx * tj + rx * sgn * lampOffset, z = a.z + dz * tj + rz * sgn * lampOffset;
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
  const points: CityData['points'] = {
    playerSpawn: pointAt(ctx, loopOf(SPAWN_BLOCK[0], SPAWN_BLOCK[1])[4], Math.PI / 2),
    hospital: pointAt(ctx, loopOf(LANDMARK_BLOCKS.hospital[0], LANDMARK_BLOCKS.hospital[1])[8], 0),
    policeStation: pointAt(ctx, loopOf(LANDMARK_BLOCKS.police[0], LANDMARK_BLOCKS.police[1])[8], 0),
    pier: { x: PIER_X0 + 3, z: PIER_Z, yaw: Math.PI / 2 },
    missionStarts,
    garage: pointAt(ctx, loopOf(7, 2)[8], 0),
    beachDelivery: { x: prom.x, z: prom.z, yaw: 0 },
  };
  ctx.points = points;
  return points;
}

// ---------------------------------------------------------------------------------------------- street dressing

/**
 * Edge walker: (x, z) of the point `t` along block edge `edge` (0 +Z south, 1 +X east, 2 -Z north, 3 -X west),
 * `off` metres outside the block. `t` runs west to east on the south / north edges, north to south on the others.
 */
function edgePoint(b: Block, edge: number, t: number, off: number, out: { x: number; z: number }): void {
  if (edge === 0) { out.x = b.x0 + t; out.z = b.z1 + off; } else if (edge === 1) { out.x = b.x1 + off; out.z = b.z0 + t; } else if (edge === 2) { out.x = b.x0 + t; out.z = b.z0 - off; } else { out.x = b.x0 - off; out.z = b.z0 + t; }
}
const ep = { x: 0, z: 0 };

/**
 * Round-crown sidewalk trees on the downtown and suburb blocks (the beachfront has its palms): every 12-22 m along
 * every edge (an irregular rhythm rather than a picket line), on the kerb line like the palms, skipped where a lamp,
 * sign, palm, bin or hydrant already stands and within `shelterClear` of a bus shelter (which has no collider); the
 * kerbside cars are placed afterwards and keep clear of them. Seeded from `rng` only.
 */
export function addStreetTrees(ctx: GenContext, rng: Random): void {
  const shelters: { x: number; z: number }[] = [];
  for (let i = 0; i < ctx.props.length; i++) if (ctx.props[i].kind === 'shelter') shelters.push({ x: ctx.props[i].x, z: ctx.props[i].z });
  for (let bi = 0; bi < ctx.blocks.length; bi++) {
    const b = ctx.blocks[bi];
    if (b.kind !== 'buildings' || districtOf(b.col, b.row) === 'beachfront') continue;
    for (let edge = 0; edge < 4; edge++) {
      for (let tt = TREE.first + rng.range(0, TREE.firstJitter); tt <= BLOCK - TREE.first + 1e-6; tt += rng.range(TREE.pitchMin, TREE.pitchMax)) {
        edgePoint(b, edge, tt, TREE.offset, ep);
        const x = ep.x, z = ep.z;
        if (clearance(ctx.hash, x, z, 6) < TREE.clear) continue;
        let nearShelter = false;
        for (let k = 0; k < shelters.length && !nearShelter; k++) nearShelter = Math.hypot(shelters[k].x - x, shelters[k].z - z) < TREE.shelterClear;
        if (nearShelter) continue;
        addProp(ctx, 'tree', x, z, rng.range(0, Math.PI * 2), rng.range(TREE.scaleMin, TREE.scaleMax), TREE.r);
      }
    }
  }
}

function pickKerbSpec(rng: Random): ParkedSpec {
  let total = 0;
  for (let i = 0; i < KERB_MIX.length; i++) total += KERB_MIX[i].weight;
  let r = rng.next() * total;
  for (let i = 0; i < KERB_MIX.length; i++) { r -= KERB_MIX[i].weight; if (r < 0) return KERB_MIX[i].key; }
  return 'sedan';
}

/** Squared distance from (x, z) to the rectangle [x0, x1] x [z0, z1] (0 inside). */
function rectDist2(x0: number, z0: number, x1: number, z1: number, x: number, z: number): number {
  const dx = Math.max(x0 - x, 0, x - x1), dz = Math.max(z0 - z, 0, z - z1);
  return dx * dx + dz * dz;
}

/**
 * Kerbside parking along every block face: the strip walks each edge from `endClear` past the corner to `endClear`
 * before the next one, dropping a car (or an empty slot) at a time with a small gap. A car is kept when its footprint,
 * padded by `pad`, clears every collider (lamps, trees, signs, bins, palms, other cars), stays `hydrantClear` /
 * `shelterClear` / `pointClear` from hydrants, bus shelters and the named points (spawn, hospital, police, garage,
 * mission starts), and its road-side flank sits `kerbGap` outside the asphalt, so the outer lane and the intersection
 * boxes stay free for the AI. Each car gets the footprint collider of the lot cars. Seeded from `rng` only.
 */
export function addKerbsideParking(ctx: GenContext, rng: Random): void {
  const pts = ctx.points;
  const avoid: { x: number; z: number; r: number }[] = [];
  if (pts) {
    for (const k of ['playerSpawn', 'hospital', 'policeStation', 'garage', 'beachDelivery', 'pier'] as const) avoid.push({ x: pts[k].x, z: pts[k].z, r: KERB.pointClear });
    for (let i = 0; i < pts.missionStarts.length; i++) avoid.push({ x: pts.missionStarts[i].x, z: pts.missionStarts[i].z, r: KERB.pointClear });
  }
  for (let i = 0; i < ctx.props.length; i++) {
    const p = ctx.props[i];
    if (p.kind === 'hydrant') avoid.push({ x: p.x, z: p.z, r: KERB.hydrantClear });
    else if (p.kind === 'shelter') avoid.push({ x: p.x, z: p.z, r: KERB.shelterClear });
  }
  const kerbOff = SIDEWALK_W - KERB.kerbGap; // road-side flank this far outside the block edge (0.08 m off the asphalt)
  for (let bi = 0; bi < ctx.blocks.length; bi++) {
    const b = ctx.blocks[bi];
    const fill = KERB_FILL[districtOf(b.col, b.row)];
    for (let edge = 0; edge < 4; edge++) {
      const alongX = edge === 0 || edge === 2;
      let t = KERB.endClear + rng.range(0, 3);
      while (t < BLOCK - KERB.endClear) {
        const key = pickKerbSpec(rng);
        const spec = SPECS[key];
        const len = spec.length, hw = spec.width / 2, hl = len / 2;
        const t1 = t + len;
        if (t1 > BLOCK - KERB.endClear) break;
        const keep = rng.chance(fill);
        const colour = rng.pick(spec.colors);
        // Footprint: centred `hw` inside the road-side flank, spanning [t, t1] along the edge.
        edgePoint(b, edge, (t + t1) / 2, kerbOff - hw, ep);
        const x = ep.x, z = ep.z;
        const x0 = alongX ? x - hl : x - hw, x1 = alongX ? x + hl : x + hw, z0 = alongX ? z - hw : z - hl, z1 = alongX ? z + hw : z + hl;
        let ok = keep && rectClear(ctx.hash, x0, z0, x1, z1, KERB.pad);
        for (let k = 0; k < avoid.length && ok; k++) ok = rectDist2(x0, z0, x1, z1, avoid[k].x, avoid[k].z) >= avoid[k].r * avoid[k].r;
        if (ok) {
          const yaw = nearestLaneYaw(ctx.roads, x, z);
          addParkedCar(ctx, x, z, yaw, key, colour, hw, hl, KERB.height, 'kerb');
        }
        t = t1 + rng.range(KERB.gapMin, KERB.gapMax);
      }
    }
  }
}

/**
 * Utility poles on the kerb line of the suburb streets. One run per block edge (the renderer strings wires between
 * consecutive poles of a run, matching them by their shared edge coordinate), seeded pitch 23-33 m starting 15-20 m
 * past the corner and stopping `endClear` before the next one, so no span ever crosses an intersection. A pole is
 * dropped where a lamp, tree, sign, bin or hydrant already stands.
 */
function addUtilityPoles(ctx: GenContext, rng: Random): void {
  for (let bi = 0; bi < ctx.blocks.length; bi++) {
    const b = ctx.blocks[bi];
    if (b.kind !== 'buildings' || districtOf(b.col, b.row) !== 'suburb') continue;
    for (let edge = 0; edge < 4; edge++) {
      for (let t = POLE.first + rng.range(0, POLE.firstJitter); t <= BLOCK - POLE.endClear; t += rng.range(POLE.pitchMin, POLE.pitchMax)) {
        edgePoint(b, edge, t, POLE.off, ep);
        if (clearance(ctx.hash, ep.x, ep.z, 6) < POLE.clear) continue;
        if (spotTooClose(ctx.parkedSpots, ep.x, ep.z, CLUTTER_SPOT_CLEAR)) continue;
        addProp(ctx, 'pole', ep.x, ep.z, EDGE_OUT_YAW[edge], rng.range(0.94, 1.08), POLE.r);
      }
    }
  }
}

/** Warning / stop plates on the intersection approaches: `perBlock` of a block's four corners, facing the oncoming lane. */
function addRoadSigns(ctx: GenContext, rng: Random): void {
  for (let bi = 0; bi < ctx.blocks.length; bi++) {
    const b = ctx.blocks[bi];
    if (b.kind === 'park') continue;
    const first = rng.int(0, 3);
    for (let k = 0; k < ROADSIGN.perBlock; k++) {
      const edge = (first + k * 2) % 4;
      // Near one end of the edge or the other, a few metres past the corner box.
      const near = rng.chance(0.5);
      const t = near ? ROADSIGN.along + rng.range(0, ROADSIGN.alongJitter) : BLOCK - ROADSIGN.along - rng.range(0, ROADSIGN.alongJitter);
      edgePoint(b, edge, t, ROADSIGN.off, ep);
      if (clearance(ctx.hash, ep.x, ep.z, 5) < ROADSIGN.clear) continue;
      if (spotTooClose(ctx.parkedSpots, ep.x, ep.z, CLUTTER_SPOT_CLEAR)) continue;
      // Plate faces the traffic coming down the street: along the edge, back toward the near corner.
      const yaw = EDGE_OUT_YAW[edge] + (near ? Math.PI / 2 : -Math.PI / 2);
      addProp(ctx, 'roadsign', ep.x, ep.z, yaw, 1, ROADSIGN.r);
    }
  }
}

/**
 * Wheeled dumpsters in the service alleys: samples the band `depth` metres inside each block edge every `step` metres.
 * Anywhere a building stands the clearance test rejects the sample, so what is left is exactly the 5 m alleys between
 * neighbouring buildings (and the odd deep setback).
 */
function addDumpsters(ctx: GenContext, rng: Random): void {
  for (let bi = 0; bi < ctx.blocks.length; bi++) {
    const b = ctx.blocks[bi];
    if (b.kind !== 'buildings') continue;
    for (let edge = 0; edge < 4; edge++) {
      for (let t = DUMPSTER.margin; t <= BLOCK - DUMPSTER.margin; t += DUMPSTER.step) {
        if (!rng.chance(DUMPSTER.chance)) continue;
        edgePoint(b, edge, t + rng.range(-1.2, 1.2), -DUMPSTER.depth, ep);
        if (clearance(ctx.hash, ep.x, ep.z, 6) < DUMPSTER.clear) continue;
        if (spotTooClose(ctx.parkedSpots, ep.x, ep.z, CLUTTER_SPOT_CLEAR + DUMPSTER.halfLong)) continue;
        // Backed against the alley wall: the long side runs across the alley, i.e. along the block edge.
        addPropBox(ctx, 'dumpster', ep.x, ep.z, EDGE_OUT_YAW[edge], 1, DUMPSTER.halfLong, DUMPSTER.halfDeep, DUMPSTER.height);
      }
    }
  }
}

/** Café tables with parasols in the arcade strip between a block edge and its shopfronts, a run of up to 3 per block. */
function addCafeTables(ctx: GenContext, rng: Random): void {
  for (let bi = 0; bi < ctx.blocks.length; bi++) {
    const b = ctx.blocks[bi];
    if (b.kind !== 'buildings' || bi % CAFE.everyBlocks !== 1) continue;
    const edge = rng.int(0, 3);
    const t0 = rng.range(CAFE.margin, BLOCK - CAFE.margin - CAFE.pitch * CAFE.perRun);
    for (let k = 0; k < CAFE.perRun; k++) {
      edgePoint(b, edge, t0 + k * CAFE.pitch, -CAFE.inset, ep);
      if (clearance(ctx.hash, ep.x, ep.z, 5) < CAFE.clear) continue;
      if (spotTooClose(ctx.parkedSpots, ep.x, ep.z, CLUTTER_SPOT_CLEAR)) continue;
      addProp(ctx, 'table', ep.x, ep.z, rng.range(0, Math.PI * 2), rng.range(0.94, 1.06), CAFE.r);
    }
  }
}

/**
 * Street dressing that needs the finished city (props, points): trees, then the batched clutter (poles and their
 * wires, signs, dumpsters, café tables), then the kerbside cars, which keep clear of all of it.
 */
export function furnishStreets(ctx: GenContext): void {
  addStreetTrees(ctx, ctx.rng.fork());
  const clutter = ctx.rng.fork();
  addUtilityPoles(ctx, clutter);
  addRoadSigns(ctx, clutter);
  addDumpsters(ctx, clutter);
  addCafeTables(ctx, clutter);
  addKerbsideParking(ctx, ctx.rng.fork());
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
