// Lot subdivision and building placement per block: lot grids, merges, empty parking lots, heights, styles, neon signs. Track A.
import { BLOCK } from './CityConfig';
import { NEONS, SIGN_WORDS, pickStyle } from './Palette';
import type { Building, NeonSign } from './CityData';
import { addAabb, districtOf } from './CityBuild';
import type { GenContext } from './CityBuild';

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

interface Cell { x0: number; z0: number; x1: number; z1: number; alive: boolean; merged: boolean }

function mergeCells(a: Cell, b: Cell): void {
  a.x0 = Math.min(a.x0, b.x0); a.z0 = Math.min(a.z0, b.z0);
  a.x1 = Math.max(a.x1, b.x1); a.z1 = Math.max(a.z1, b.z1);
  a.merged = true;
  b.alive = false;
}

/** Subdivides every 'buildings' block into lots and places buildings; the lot nearest the spawn in `spawnBlock` is kept empty for parking. */
export function buildLots(ctx: GenContext, spawnX: number, spawnZ: number, spawnBlock: number): void {
  const rng = ctx.rng;
  const cells: Cell[] = [];
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
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      if (!c.alive) continue;
      const empty = (n === 3 && !c.merged && rng.chance(P_EMPTY_3X3)) || k === spawnLot;
      if (empty) {
        ctx.emptyLots.push({ blockCol: block.col, blockRow: block.row, x: (c.x0 + c.x1) / 2, z: (c.z0 + c.z1) / 2, w: c.x1 - c.x0, d: c.z1 - c.z0 });
        continue;
      }
      placeBuilding(ctx, block.id, c, district);
    }
  }
}

function placeBuilding(ctx: GenContext, blockId: number, c: Cell, district: Building['district']): void {
  const rng = ctx.rng;
  const block = ctx.blocks[blockId];
  const lw = c.x1 - c.x0, ld = c.z1 - c.z0;
  const w = lw * (1 - rng.range(0, 0.15)), d = ld * (1 - rng.range(0, 0.15));
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
  h = Math.round(h * 10) / 10;
  // facing = nearest block edge: 0 (+Z south), 1 (+X east), 2 (-Z north), 3 (-X west)
  const dS = block.z1 - z, dE = block.x1 - x, dN = z - block.z0, dW = x - block.x0;
  let facing: Building['facing'] = 0;
  let best = dS;
  if (dE < best) { best = dE; facing = 1; }
  if (dN < best) { best = dN; facing = 2; }
  if (dW < best) { facing = 3; }
  const b: Building = { id: ctx.buildings.length, x, z, w, d, h, style: st.style, color: st.color, accent: st.accent, roofKind, hasNeonSign: false, neonColor: st.accent, district, facing };
  if (h > NEON_MIN_H && (district === 'beachfront' || st.style === 'neon')) {
    const sign = makeSign(rng, b);
    if (sign) { ctx.neonSigns.push(sign); b.hasNeonSign = true; b.neonColor = sign.color; }
  }
  ctx.buildings.push(b);
  block.buildings.push(b.id);
  addAabb(ctx, x - w / 2, z - d / 2, x + w / 2, z + d / 2, 'building', h);
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
