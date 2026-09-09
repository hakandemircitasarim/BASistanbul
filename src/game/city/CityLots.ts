// Lot subdivision and building placement per block: lot grids, merges, empty parking lots, heights, styles, neon signs;
// lot furnishing (static parked cars, kerb islands, planters, street-edge hedges) once the gameplay spots are placed,
// followed by the street dressing (CityProps.furnishStreets). Track A.
import { BLOCK } from './CityConfig';
import { NEONS, SIGN_WORDS, pickStyle } from './Palette';
import type { Block, Building, Lot, NeonSign, ParkedSpec } from './CityData';
import { addAabb, addLotProp, addParkedCar, addPropBox, blockIndex, districtOf, rectClear } from './CityBuild';
import type { GenContext } from './CityBuild';
import { furnishStreets } from './CityProps';
import type { LanePos, RoadGraph } from './RoadGraph';
import type { Random } from '../core/Random';
import { SPECS } from '../entities/VehicleSpecs';

const INSET = 2;
const GAP_NORMAL = 1.5;
const GAP_DOWNTOWN = 2.5;
const P_2X2 = 0.45;
const P_MERGE = 0.35;
const MAX_MERGES = 2;
/** Chance that a 3x3 lot stays empty (becomes an off-street parking lot); tuned so the city lands at 300-400 buildings. */
const P_EMPTY_3X3 = 0.42;
const NEON_MIN_H = 14;
const SIGN_H = 2.2;
/** Storey height: building heights snap to whole floors so the window rows of the facade texture land on real floors. */
const FLOOR_H = 3.5;
/** One window column of the facade texture: plan dimensions snap to it so the bays end on a mullion, never mid-window. */
const BAY_W = 4;
const MIN_SIDE = 8;
/** Chance that a building holds the street wall (facing edge 0.3 m inside its lot) instead of standing 3-5 m back. */
const P_STREET_WALL = 0.6;
const STREET_WALL_SETBACK = 0.3;
/** Neighbouring buildings along a street either share a party wall or leave a service alley between them. */
const P_PARTY_WALL = 0.5;
const PARTY_GAP = 0.02;
const ALLEY_GAP = 5;
/** Downtown slab towers: every fourth tower (by id) gets a 2.2:1 plan when it owns a merged (double) lot. */
const SLAB_RATIO = 2.2;

interface Cell { x0: number; z0: number; x1: number; z1: number; alive: boolean; merged: boolean }

/** A building decided but not yet positioned along its street: `along` runs parallel to the facing street, `depth` away from it. */
interface Plan {
  id: number; cell: Cell; facing: Building['facing']; alongX: boolean; along: number; depth: number; setback: number;
  h: number; style: ReturnType<typeof pickStyle>; roofKind: Building['roofKind']; slab: boolean; district: Building['district'];
  /** Final extent along the street axis (filled by packRuns). */
  a0: number; a1: number;
}

function mergeCells(a: Cell, b: Cell): void {
  a.x0 = Math.min(a.x0, b.x0); a.z0 = Math.min(a.z0, b.z0);
  a.x1 = Math.max(a.x1, b.x1); a.z1 = Math.max(a.z1, b.z1);
  a.merged = true;
  b.alive = false;
}

const snapDown = (v: number): number => Math.floor(v / BAY_W + 1e-6) * BAY_W;
const snapNear = (v: number): number => Math.round(v / BAY_W) * BAY_W;

/** Subdivides every 'buildings' block into lots and places buildings; the lot nearest the spawn in `spawnBlock` is kept empty for parking. */
export function buildLots(ctx: GenContext, spawnX: number, spawnZ: number, spawnBlock: number): void {
  const rng = ctx.rng;
  const cells: Cell[] = [];
  const plans: Plan[] = [];
  for (let bi = 0; bi < ctx.blocks.length; bi++) {
    const block = ctx.blocks[bi];
    if (block.kind !== 'buildings') continue;
    const district = districtOf(block.col, block.row);
    const n = rng.chance(P_2X2) ? 2 : 3;
    const gap = district === 'downtown' ? GAP_DOWNTOWN : GAP_NORMAL;
    const size = (BLOCK - 2 * INSET - (n - 1) * gap) / n;
    cells.length = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x0 = block.x0 + INSET + i * (size + gap), z0 = block.z0 + INSET + j * (size + gap);
        cells.push({ x0, z0, x1: x0 + size, z1: z0 + size, alive: true, merged: false });
      }
    }
    let merges = 0;
    for (let j = 0; j < n && merges < MAX_MERGES; j++) {
      for (let i = 0; i < n && merges < MAX_MERGES; i++) {
        const a = cells[j * n + i];
        if (!a.alive || a.merged) continue;
        if (i + 1 < n) {
          const b = cells[j * n + i + 1];
          if (b.alive && !b.merged && rng.chance(P_MERGE)) { mergeCells(a, b); merges++; continue; }
        }
        if (j + 1 < n) {
          const b = cells[(j + 1) * n + i];
          if (b.alive && !b.merged && rng.chance(P_MERGE)) { mergeCells(a, b); merges++; }
        }
      }
    }
    let spawnLot = -1;
    if (block.id === spawnBlock) {
      let bd = Infinity;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        if (!c.alive) continue;
        const cx = (c.x0 + c.x1) / 2, cz = (c.z0 + c.z1) / 2;
        const d = (cx - spawnX) * (cx - spawnX) + (cz - spawnZ) * (cz - spawnZ);
        if (d < bd) { bd = d; spawnLot = k; }
      }
    }
    plans.length = 0;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      if (!c.alive) continue;
      const empty = (n === 3 && !c.merged && rng.chance(P_EMPTY_3X3)) || k === spawnLot;
      if (empty) {
        ctx.emptyLots.push({ blockCol: block.col, blockRow: block.row, x: (c.x0 + c.x1) / 2, z: (c.z0 + c.z1) / 2, w: c.x1 - c.x0, d: c.z1 - c.z0 });
        continue;
      }
      plans.push(planBuilding(ctx, ctx.buildings.length + plans.length, block.x0, block.z0, block.x1, block.z1, c, district));
    }
    packRuns(ctx, plans);
    for (let k = 0; k < plans.length; k++) placeBuilding(ctx, block.id, plans[k]);
  }
}

/** Decides everything about a building except its position along the street: size (bay-snapped), floors, style, setback. */
function planBuilding(ctx: GenContext, id: number, bx0: number, bz0: number, bx1: number, bz1: number, c: Cell, district: Building['district']): Plan {
  const rng = ctx.rng;
  const lw = c.x1 - c.x0, ld = c.z1 - c.z0;
  const x = (c.x0 + c.x1) / 2, z = (c.z0 + c.z1) / 2;
  const st = pickStyle(district, rng);
  let roofKind = st.roofKind;
  let h: number;
  if (district === 'downtown') {
    const r = rng.next();
    h = 30 + r * r * 90;
    if (rng.chance(0.05)) h = rng.range(120, 150);
  } else if (district === 'beachfront') {
    h = rng.range(10, 28);
    if (rng.chance(0.6)) roofKind = 'stepped';
  } else {
    h = rng.range(8, 22);
  }
  h = Math.round(h / FLOOR_H) * FLOOR_H + 0.2;
  // facing = nearest block edge: 0 (+Z south), 1 (+X east), 2 (-Z north), 3 (-X west)
  // Ties (corner lots) go to the north/south street so a block front packs into one continuous run of buildings.
  const dS = bz1 - z, dE = bx1 - x, dN = z - bz0, dW = x - bx0;
  let facing: Building['facing'] = dN < dS ? 2 : 0;
  let best = Math.min(dS, dN);
  if (dE < best - 1e-6) { best = dE; facing = 1; }
  if (dW < best - 1e-6) { facing = 3; }
  const alongX = facing === 0 || facing === 2;
  const alongLot = alongX ? lw : ld, depthLot = alongX ? ld : lw;
  const setback = rng.chance(P_STREET_WALL) ? STREET_WALL_SETBACK : rng.range(3, 5);
  const slab = district === 'downtown' && c.merged && id % 4 === 0 && h > 40;
  let along: number, depth: number;
  if (slab) {
    along = Math.max(MIN_SIDE, snapDown(alongLot));
    depth = Math.max(MIN_SIDE, snapDown(along / SLAB_RATIO));
  } else {
    along = Math.max(MIN_SIDE, Math.min(snapDown(alongLot), snapNear(alongLot * rng.range(0.55, 1.0))));
    depth = Math.max(MIN_SIDE, snapNear(depthLot * rng.range(0.7, 1.0)));
  }
  depth = Math.max(MIN_SIDE, Math.min(depth, snapDown(depthLot - setback)));
  return { id, cell: c, facing, alongX, along, depth, setback, h, style: st, roofKind, slab, district, a0: 0, a1: 0 };
}

/** Consecutive lots along one street, all facing that street. */
interface Run { plans: Plan[]; start: number; end: number }

/**
 * Street-wall packing. Lots that sit side by side along the same street form a run; inside a run the buildings either
 * share a party wall (2 cm) or leave a 5 m alley, the left-over slack grows the buildings a bay at a time, and whatever
 * remains becomes a margin at one end. Buildings never leave the run's extent, so the 2 m block inset always holds,
 * and they never overlap because the run is laid out sequentially.
 */
function packRuns(ctx: GenContext, plans: Plan[]): void {
  const rng = ctx.rng;
  const runs: Run[] = [];
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    const lo = p.alongX ? p.cell.x0 : p.cell.z0, hi = p.alongX ? p.cell.x1 : p.cell.z1;
    const d0 = p.alongX ? p.cell.z0 : p.cell.x0, d1 = p.alongX ? p.cell.z1 : p.cell.x1;
    let run: Run | null = null;
    for (let r = 0; r < runs.length; r++) {
      const q = runs[r].plans[runs[r].plans.length - 1];
      const qd0 = q.alongX ? q.cell.z0 : q.cell.x0, qd1 = q.alongX ? q.cell.z1 : q.cell.x1;
      if (q.facing !== p.facing || Math.abs(qd0 - d0) > 1e-6 || Math.abs(qd1 - d1) > 1e-6) continue;
      if (lo - runs[r].end > GAP_DOWNTOWN + 1e-6 || lo < runs[r].end) continue;
      run = runs[r];
      break;
    }
    if (run) { run.plans.push(p); run.end = hi; } else runs.push({ plans: [p], start: lo, end: hi });
  }
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const ps = run.plans, m = ps.length;
    const gaps: number[] = [];
    let total = 0;
    for (let i = 0; i < m; i++) total += ps[i].along;
    for (let i = 0; i + 1 < m; i++) { const g = rng.chance(P_PARTY_WALL) ? PARTY_GAP : ALLEY_GAP; gaps.push(g); total += g; }
    let slack = run.end - run.start - total;
    // Too tight (every lot filled and alleys everywhere): close alleys into party walls until it fits.
    for (let i = 0; i + 1 < m && slack < 0; i++) if (gaps[i] === ALLEY_GAP) { gaps[i] = PARTY_GAP; slack += ALLEY_GAP - PARTY_GAP; }
    // Grow buildings a bay at a time while there is room (slabs keep their ratio, nothing grows past its lot + one bay).
    let grew = true;
    while (slack >= BAY_W && grew) {
      grew = false;
      for (let i = 0; i < m && slack >= BAY_W; i++) {
        const p = ps[i];
        const lotW = p.alongX ? p.cell.x1 - p.cell.x0 : p.cell.z1 - p.cell.z0;
        if (p.slab || p.along + BAY_W > snapDown(lotW) + BAY_W || !rng.chance(0.7)) continue;
        p.along += BAY_W; slack -= BAY_W; grew = true;
      }
    }
    if (slack < 0) slack = 0;
    let a = run.start + (m === 1 ? rng.pick([0, slack / 2, slack]) : rng.chance(0.5) ? 0 : slack);
    for (let i = 0; i < m; i++) {
      ps[i].a0 = a; ps[i].a1 = a + ps[i].along;
      a += ps[i].along + (i + 1 < m ? gaps[i] : 0);
    }
  }
}

function placeBuilding(ctx: GenContext, blockId: number, p: Plan): void {
  const rng = ctx.rng;
  const block = ctx.blocks[blockId];
  const c = p.cell;
  // Facing edge sits `setback` inside the lot on the street side; the far side follows from the depth.
  let x0: number, x1: number, z0: number, z1: number;
  if (p.alongX) {
    x0 = p.a0; x1 = p.a1;
    if (p.facing === 0) { z1 = c.z1 - p.setback; z0 = z1 - p.depth; } else { z0 = c.z0 + p.setback; z1 = z0 + p.depth; }
  } else {
    z0 = p.a0; z1 = p.a1;
    if (p.facing === 1) { x1 = c.x1 - p.setback; x0 = x1 - p.depth; } else { x0 = c.x0 + p.setback; x1 = x0 + p.depth; }
  }
  const x = (x0 + x1) / 2, z = (z0 + z1) / 2, w = Math.round((x1 - x0) * 1000) / 1000, d = Math.round((z1 - z0) * 1000) / 1000;
  const st = p.style;
  const b: Building = { id: ctx.buildings.length, x, z, w, d, h: p.h, style: st.style, color: st.color, accent: st.accent, roofKind: p.roofKind, hasNeonSign: false, neonColor: st.accent, district: p.district, facing: p.facing };
  if (p.h > NEON_MIN_H && (p.district === 'beachfront' || st.style === 'neon')) {
    const sign = makeSign(rng, b);
    if (sign) { ctx.neonSigns.push(sign); b.hasNeonSign = true; b.neonColor = sign.color; }
  }
  ctx.buildings.push(b);
  block.buildings.push(b.id);
  addAabb(ctx, x0, z0, x1, z1, 'building', p.h);
}

const FACING_DIR: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const FACING_YAW = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

function makeSign(rng: { range(a: number, b: number): number; pick<T>(a: readonly T[]): T }, b: Building): NeonSign | null {
  const facadeW = b.facing === 0 || b.facing === 2 ? b.w : b.d;
  const w = Math.min(rng.range(8, 14), facadeW - 1);
  if (w < 4) return null;
  const dir = FACING_DIR[b.facing];
  const off = (b.facing === 0 || b.facing === 2 ? b.d : b.w) / 2 + 0.15;
  return { x: b.x + dir[0] * off, y: rng.range(6, b.h - 2), z: b.z + dir[1] * off, yaw: FACING_YAW[b.facing], text: rng.pick(SIGN_WORDS), color: rng.pick(NEONS), w, h: SIGN_H };
}

// ---------------------------------------------------------------------------------------------- lot furnishing

/**
 * Bay geometry of a lot, shared with the painted bays of CityRenderer (STREET.stripInset / stripPitch / bayPitch /
 * bayLen / lotGateW mirror these — the render layer cannot be imported here). Strips run along the heading of the
 * nearest lane at the parked-spot pitch (so every gameplay spot lands on a bay centre), bays step across it.
 */
export const LOT_BAYS = { inset: 3.5, stripPitch: 9, bayPitch: 3, bayLen: 5.6, gateW: 7, gateDepth: 12, kerbW: 0.3 } as const;
/** Share of the free bays that get a static car. */
const P_PARKED = 0.4;
/** Bays kept free around every gameplay spot, in bay pitches along the driver's exit side (negative = far side). */
const SPOT_CLEAR_BAYS = [1, 2, -1] as const;
const PARKED_MIX: { key: ParkedSpec; weight: number }[] = [{ key: 'sedan', weight: 60 }, { key: 'sport', weight: 20 }, { key: 'van', weight: 20 }];
/** Kerb island at a strip head: bay-long, a car door wide, kerb high. Planters (r 0.45) stand on the islands. */
const ISLAND = { w: 1.5, l: 5.6, h: 0.16, p: 0.5, p2: 0.3 } as const;
const PARKED_H = 1.5;
/**
 * Clipped hedge units screening a lot from the street: 1.9 m colliders at a 2 m pitch (a 10 cm seam so each unit
 * clears its neighbour's box; the renderer's unit is longer than the pitch, so a row reads as one continuous hedge),
 * 0.62 m high, standing `off` outside the lot's kerb ring in the block's inset band (the pavement between the lot and
 * the sidewalk), broken at the gate (`gateClear` either side of the drive lane) and short of the lot corners by `cornerClear`.
 */
export const HEDGE = { len: 1.9, depth: 0.6, h: 0.62, off: 1.0, pitch: 2.0, gateClear: 1.5, cornerClear: 0.4 } as const;

/** Axis-aligned rectangle in world space. */
export interface Rect { x0: number; z0: number; x1: number; z1: number }

export interface LotLayout {
  /** Strips (and car noses) run along x when true, along z otherwise. */
  alongX: boolean;
  /** Yaw of the nearest lane (the heading every bay follows). */
  yaw: number;
  /** Strip centres along the heading axis and bay centres across it. */
  strips: number[];
  bays: number[];
  /** Nearest block edge the lot opens onto (0 +Z, 1 +X, 2 -Z, 3 -X) and the drive lane behind the gate. */
  gate: 0 | 1 | 2 | 3;
  gateRect: Rect;
}

const overlaps = (a: Rect, b: Rect, pad: number): boolean => a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.z0 < b.z1 + pad && a.z1 > b.z0 - pad;
const inside = (r: Rect, lot: Lot, margin: number): boolean =>
  r.x0 >= lot.x - lot.w / 2 + margin && r.x1 <= lot.x + lot.w / 2 - margin && r.z0 >= lot.z - lot.d / 2 + margin && r.z1 <= lot.z + lot.d / 2 - margin;

/** World rectangle of a bay-shaped box centred at (along, across) in a lot's heading frame: `l` along, `w` across. */
function bayRect(lay: LotLayout, along: number, across: number, l: number, w: number): Rect {
  const x = lay.alongX ? along : across, z = lay.alongX ? across : along;
  const ex = lay.alongX ? l / 2 : w / 2, ez = lay.alongX ? w / 2 : l / 2;
  return { x0: x - ex, z0: z - ez, x1: x + ex, z1: z + ez };
}

/** Bay grid, heading and gate of a lot (exported so the tests can check the placements against it). */
export function lotLayout(roads: RoadGraph, blocks: Block[], lot: Lot): LotLayout {
  const B = LOT_BAYS;
  roads.nearestLane(lot.x, lot.z, laneScratch);
  const dir = roads.lanes[laneScratch.lane].dir;
  const alongX = Math.abs(dir.x) >= Math.abs(dir.z);
  const yaw = Math.atan2(dir.x, dir.z);
  const along0 = (alongX ? lot.x - lot.w / 2 : lot.z - lot.d / 2) + B.inset, along1 = (alongX ? lot.x + lot.w / 2 : lot.z + lot.d / 2) - B.inset;
  const across0 = (alongX ? lot.z - lot.d / 2 : lot.x - lot.w / 2) + B.inset, across1 = (alongX ? lot.z + lot.d / 2 : lot.x + lot.w / 2) - B.inset;
  const strips: number[] = [], bays: number[] = [];
  for (let a = along0; a <= along1 + 1e-6; a += B.stripPitch) strips.push(a);
  for (let c = across0; c <= across1 + 1e-6; c += B.bayPitch) bays.push(c);
  const x0 = lot.x - lot.w / 2, x1 = lot.x + lot.w / 2, z0 = lot.z - lot.d / 2, z1 = lot.z + lot.d / 2;
  const blk = blocks[blockIndex(lot.blockCol, lot.blockRow)];
  const dS = blk.z1 - z1, dN = z0 - blk.z0, dE = blk.x1 - x1, dW = x0 - blk.x0;
  let gate: 0 | 1 | 2 | 3 = dN < dS ? 2 : 0, best = Math.min(dS, dN);
  if (dE < best) { best = dE; gate = 1; }
  if (dW < best) gate = 3;
  const g = B.gateW / 2 + 1, dpt = B.gateDepth;
  const gateRect: Rect = gate === 0 ? { x0: lot.x - g, x1: lot.x + g, z0: z1 - dpt, z1 }
    : gate === 2 ? { x0: lot.x - g, x1: lot.x + g, z0, z1: z0 + dpt }
      : gate === 1 ? { x0: x1 - dpt, x1, z0: lot.z - g, z1: lot.z + g }
        : { x0, x1: x0 + dpt, z0: lot.z - g, z1: lot.z + g };
  return { alongX, yaw, strips, bays, gate, gateRect };
}

const laneScratch: LanePos = { lane: 0, t: 0 };

function pickParkedSpec(rng: Random): ParkedSpec {
  let total = 0;
  for (let i = 0; i < PARKED_MIX.length; i++) total += PARKED_MIX[i].weight;
  let r = rng.next() * total;
  for (let i = 0; i < PARKED_MIX.length; i++) { r -= PARKED_MIX[i].weight; if (r < 0) return PARKED_MIX[i].key; }
  return 'sedan';
}

/**
 * Fills the lots after the gameplay spots are placed: kerb islands (with planters) at both heads of every bay strip,
 * then a static car in about 40 % of the bays that are free. A bay stays free when it is a gameplay spot, the bay to
 * the right of one (where `?nearcar=1` and the exit put the player), lies in the gate's drive lane, or touches an
 * island. Everything gets a collider, so the player cannot drive through the dressing. Seeded from the city stream.
 */
export function furnishLots(ctx: GenContext): void {
  const rng = ctx.rng.fork();
  const B = LOT_BAYS;
  const lots = ctx.emptyLots, spots = ctx.parkedSpots;
  const blocked: Rect[] = [];
  for (let li = 0; li < lots.length; li++) {
    const lot = lots[li];
    const lay = lotLayout(ctx.roads, ctx.blocks, lot);
    blocked.length = 0;
    blocked.push(lay.gateRect);
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      if (Math.abs(s.x - lot.x) > lot.w / 2 || Math.abs(s.z - lot.z) > lot.d / 2) continue;
      const along = lay.alongX ? s.x : s.z, across = lay.alongX ? s.z : s.x;
      blocked.push(bayRect(lay, along, across, B.bayLen, B.bayPitch));
      // right(yaw) = (-cos yaw, sin yaw): the driver's exit side. Keep two bays free there (the player stands in the
      // first one at spawn / on exit) and one on the far side, so the cheap parked shells never sit a metre from the
      // camera at the start of the game.
      for (const k of SPOT_CLEAR_BAYS) {
        const rx = s.x - Math.cos(s.yaw) * B.bayPitch * k, rz = s.z + Math.sin(s.yaw) * B.bayPitch * k;
        blocked.push(bayRect(lay, lay.alongX ? rx : rz, lay.alongX ? rz : rx, B.bayLen, B.bayPitch));
      }
    }
    // Islands at the two heads of every strip: just outside the first / last bay line, inside the kerb ring.
    const first = lay.bays[0] - B.bayPitch / 2, last = lay.bays[lay.bays.length - 1] + B.bayPitch / 2;
    for (let si = 0; si < lay.strips.length; si++) {
      for (let end = 0; end < 2; end++) {
        const across = end === 0 ? first - 0.1 - ISLAND.w / 2 : last + 0.1 + ISLAND.w / 2;
        const r = bayRect(lay, lay.strips[si], across, ISLAND.l, ISLAND.w);
        if (!inside(r, lot, B.kerbW + 0.1)) continue;
        let hit = false;
        for (let k = 0; k < blocked.length && !hit; k++) hit = overlaps(r, blocked[k], 0.3);
        if (hit) continue;
        const x = (r.x0 + r.x1) / 2, z = (r.z0 + r.z1) / 2;
        const yaw = lay.alongX ? Math.PI / 2 : 0;
        addLotProp(ctx, 'island', x, z, yaw, ISLAND.w / 2, ISLAND.l / 2, ISLAND.h);
        blocked.push(r);
        if (rng.chance(ISLAND.p)) {
          const two = rng.chance(ISLAND.p2);
          const off = two ? 1.6 : 0;
          for (let k = 0; k < (two ? 2 : 1); k++) {
            const o = off * (k === 0 ? -1 : 1);
            addLotProp(ctx, 'planter', x + (lay.alongX ? o : 0), z + (lay.alongX ? 0 : o), yaw, 0, 0, 0);
          }
        }
      }
    }
    // Static cars in the free bays, nose in or out at random, along the heading.
    for (let si = 0; si < lay.strips.length; si++) {
      for (let bi = 0; bi < lay.bays.length; bi++) {
        const r = bayRect(lay, lay.strips[si], lay.bays[bi], B.bayLen, B.bayPitch);
        let hit = false;
        for (let k = 0; k < blocked.length && !hit; k++) hit = overlaps(r, blocked[k], 0);
        if (hit || !rng.chance(P_PARKED)) continue;
        const key = pickParkedSpec(rng);
        const spec = SPECS[key];
        const colour = rng.pick(spec.colors);
        const forward = rng.chance(0.5);
        const yaw = lay.alongX ? (forward ? Math.PI / 2 : -Math.PI / 2) : (forward ? 0 : Math.PI);
        const x = (r.x0 + r.x1) / 2, z = (r.z0 + r.z1) / 2;
        addParkedCar(ctx, x, z, yaw, key, colour, spec.width / 2, spec.length / 2, PARKED_H, 'lot');
        blocked.push(r);
      }
    }
    addLotHedges(ctx, rng, lot, lay);
  }
  // Everything that needs the finished lots and the named points hangs off this last generation step
  // (CityGenerator's call order is fixed): the sidewalk trees, then the kerbside cars that keep clear of them.
  furnishStreets(ctx);
}

/**
 * Hedge rows on the street-facing edges of one lot (the edges on the block's inset line): a run of 2 m units in the
 * inset band, with a break at the gate. Units carry a box collider, so the player walks around them.
 */
function addLotHedges(ctx: GenContext, rng: Random, lot: Lot, lay: LotLayout): void {
  const blk = ctx.blocks[blockIndex(lot.blockCol, lot.blockRow)];
  const x0 = lot.x - lot.w / 2, x1 = lot.x + lot.w / 2, z0 = lot.z - lot.d / 2, z1 = lot.z + lot.d / 2;
  const H = HEDGE;
  for (let edge = 0; edge < 4; edge++) {
    // Street-facing = the lot edge sits on the block's inset line.
    const street = edge === 0 ? blk.z1 - z1 <= INSET + 1e-3 : edge === 1 ? blk.x1 - x1 <= INSET + 1e-3 : edge === 2 ? z0 - blk.z0 <= INSET + 1e-3 : x0 - blk.x0 <= INSET + 1e-3;
    if (!street) continue;
    const alongX = edge === 0 || edge === 2;
    const a0 = (alongX ? x0 : z0) + H.cornerClear, a1 = (alongX ? x1 : z1) - H.cornerClear;
    const across = edge === 0 ? z1 + H.off : edge === 1 ? x1 + H.off : edge === 2 ? z0 - H.off : x0 - H.off;
    const gateA = alongX ? lot.x : lot.z, gateHalf = lay.gate === edge ? LOT_BAYS.gateW / 2 + H.gateClear : -1;
    const yaw = alongX ? Math.PI / 2 : 0;
    for (let a = a0 + H.len / 2; a + H.len / 2 <= a1 + 1e-6; a += H.pitch) {
      if (gateHalf > 0 && Math.abs(a - gateA) < gateHalf + H.len / 2) continue;
      const x = alongX ? a : across, z = alongX ? across : a;
      const ex = alongX ? H.len / 2 : H.depth / 2, ez = alongX ? H.depth / 2 : H.len / 2;
      if (!rectClear(ctx.hash, x - ex, z - ez, x + ex, z + ez, 0.04)) continue;
      addPropBox(ctx, 'hedge', x, z, yaw, rng.range(0.94, 1.06), H.depth / 2, H.len / 2, H.h);
    }
  }
}
