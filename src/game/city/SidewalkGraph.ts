// Sidewalk walk graph: one 12-node loop per block, corner crossings, a beach promenade loop, bucketed lookups. Track A.
import type { Random } from '../core/Random';
import type { Block } from './CityData';

export interface WalkNode { id: number; x: number; z: number; block: number; corner: boolean; loopNext: number; loopPrev: number; crossings: number[] }

const PROMENADE_STEP = 24;
const PROMENADE_BACK_OFFSET = 7; // second promenade line (northbound) sits this far east of the first
const PROMENADE_SNAP = 6; // a promenade node within this distance of a block corner is moved onto the corner's z
const CELL = 48;

export class SidewalkGraph {
  readonly nodes: WalkNode[] = [];
  readonly loops: number[][] = []; // one loop per block: 4 corners + 2 per edge = 12 nodes; plus one beach promenade loop
  /** Index of the promenade loop in `loops`, or -1. */
  promenadeLoop = -1;
  // Uniform bucket grid (CSR layout) for nearestNode / nodesInRing.
  private gridMinX = 0;
  private gridMinZ = 0;
  private gridCols = 1;
  private gridRows = 1;
  private cellStart = new Int32Array(2);
  private cellItems = new Int32Array(0);

  static build(blocks: Block[], roadW: number, sidewalkW: number, beach: { x: number; z0: number; z1: number } | null): SidewalkGraph {
    const g = new SidewalkGraph();
    const s = sidewalkW / 2;
    const byBlock = new Map<number, number>(); // (col,row) packed -> loop index
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      // Clockwise from the NW corner: top edge (+x), right edge (+z), bottom edge (-x), left edge (-z).
      const pts: [number, number, boolean][] = [
        [b.x0 - s, b.z0 - s, true], [b.x0 + w / 3, b.z0 - s, false], [b.x0 + (2 * w) / 3, b.z0 - s, false],
        [b.x1 + s, b.z0 - s, true], [b.x1 + s, b.z0 + d / 3, false], [b.x1 + s, b.z0 + (2 * d) / 3, false],
        [b.x1 + s, b.z1 + s, true], [b.x0 + (2 * w) / 3, b.z1 + s, false], [b.x0 + w / 3, b.z1 + s, false],
        [b.x0 - s, b.z1 + s, true], [b.x0 - s, b.z0 + (2 * d) / 3, false], [b.x0 - s, b.z0 + d / 3, false],
      ];
      const loop = g.addLoop(pts, bi);
      byBlock.set(b.col * 1024 + b.row, loop);
    }
    // Crossings straight across the road between corners of adjacent blocks.
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      const me = g.loops[bi];
      const east = byBlock.get((b.col + 1) * 1024 + b.row);
      if (east !== undefined) { g.link(me[3], g.loops[east][0]); g.link(me[6], g.loops[east][9]); }
      const south = byBlock.get(b.col * 1024 + (b.row + 1));
      if (south !== undefined) { g.link(me[9], g.loops[south][0]); g.link(me[6], g.loops[south][3]); }
    }
    if (beach) g.buildPromenade(blocks, beach, s);
    // Outer corners of the grid (no block across either road) are plain loop bends, not crossing points.
    for (let i = 0; i < g.nodes.length; i++) if (g.nodes[i].corner && g.nodes[i].crossings.length === 0) g.nodes[i].corner = false;
    void roadW;
    g.buildGrid();
    return g;
  }

  /** Promenade: a southbound line at beach.x and a northbound line 7 m east, closed at both ends; corner-aligned nodes get crossings. */
  private buildPromenade(blocks: Block[], beach: { x: number; z0: number; z1: number }, s: number): void {
    let maxCol = 0;
    for (let bi = 0; bi < blocks.length; bi++) if (blocks[bi].col > maxCol) maxCol = blocks[bi].col;
    const zs: number[] = [];
    for (let z = beach.z0; z <= beach.z1 + 1e-6; z += PROMENADE_STEP) zs.push(z);
    // Snap/insert nodes at the z of every east-facing block corner so crossings run straight across the road.
    const cornerZ: number[] = [];
    for (let bi = 0; bi < blocks.length; bi++) {
      if (blocks[bi].col !== maxCol) continue;
      cornerZ.push(blocks[bi].z0 - s, blocks[bi].z1 + s);
    }
    for (let i = 0; i < cornerZ.length; i++) {
      const cz = cornerZ[i];
      let best = -1, bd = Infinity;
      for (let k = 0; k < zs.length; k++) { const d = Math.abs(zs[k] - cz); if (d < bd) { bd = d; best = k; } }
      if (bd <= PROMENADE_SNAP) zs[best] = cz; else zs.push(cz);
    }
    zs.sort((a, b) => a - b);
    const pts: [number, number, boolean][] = [];
    for (let i = 0; i < zs.length; i++) pts.push([beach.x, zs[i], false]);
    for (let i = zs.length - 1; i >= 0; i--) pts.push([beach.x + PROMENADE_BACK_OFFSET, zs[i], false]);
    this.promenadeLoop = this.addLoop(pts, -1);
    const prom = this.loops[this.promenadeLoop];
    for (let bi = 0; bi < blocks.length; bi++) {
      if (blocks[bi].col !== maxCol) continue;
      const loop = this.loops[bi];
      this.link(loop[3], this.nearestIn(prom, zs.length, this.nodes[loop[3]].z));
      this.link(loop[6], this.nearestIn(prom, zs.length, this.nodes[loop[6]].z));
    }
  }

  private addLoop(pts: [number, number, boolean][], block: number): number {
    const base = this.nodes.length;
    const ids: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const id = base + i;
      ids.push(id);
      this.nodes.push({ id, x: pts[i][0], z: pts[i][1], block, corner: pts[i][2], loopNext: base + ((i + 1) % pts.length), loopPrev: base + ((i - 1 + pts.length) % pts.length), crossings: [] });
    }
    this.loops.push(ids);
    return this.loops.length - 1;
  }

  private link(a: number, b: number): void {
    const na = this.nodes[a], nb = this.nodes[b];
    if (na.crossings.indexOf(b) < 0) na.crossings.push(b);
    if (nb.crossings.indexOf(a) < 0) nb.crossings.push(a);
    na.corner = true;
    nb.corner = true;
  }

  /** Nearest (by z) among the first `count` ids of the list. */
  private nearestIn(ids: number[], count: number, z: number): number {
    let best = ids[0], bd = Infinity;
    for (let i = 0; i < count; i++) {
      const d = Math.abs(this.nodes[ids[i]].z - z);
      if (d < bd) { bd = d; best = ids[i]; }
    }
    return best;
  }

  private buildGrid(): void {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.z < minZ) minZ = n.z; if (n.z > maxZ) maxZ = n.z;
    }
    if (this.nodes.length === 0) { minX = minZ = 0; maxX = maxZ = 1; }
    this.gridMinX = minX - 1;
    this.gridMinZ = minZ - 1;
    this.gridCols = Math.max(1, Math.ceil((maxX - this.gridMinX + 1) / CELL));
    this.gridRows = Math.max(1, Math.ceil((maxZ - this.gridMinZ + 1) / CELL));
    const cellCount = this.gridCols * this.gridRows;
    const counts = new Int32Array(cellCount);
    for (let i = 0; i < this.nodes.length; i++) counts[this.cellOf(this.nodes[i].x, this.nodes[i].z)]++;
    this.cellStart = new Int32Array(cellCount + 1);
    for (let c = 0; c < cellCount; c++) this.cellStart[c + 1] = this.cellStart[c] + counts[c];
    this.cellItems = new Int32Array(this.nodes.length);
    const fill = new Int32Array(cellCount);
    for (let i = 0; i < this.nodes.length; i++) {
      const c = this.cellOf(this.nodes[i].x, this.nodes[i].z);
      this.cellItems[this.cellStart[c] + fill[c]++] = i;
    }
  }

  private cellOf(x: number, z: number): number {
    let cx = Math.floor((x - this.gridMinX) / CELL), cz = Math.floor((z - this.gridMinZ) / CELL);
    if (cx < 0) cx = 0; else if (cx >= this.gridCols) cx = this.gridCols - 1;
    if (cz < 0) cz = 0; else if (cz >= this.gridRows) cz = this.gridRows - 1;
    return cz * this.gridCols + cx;
  }

  randomNode(rng: Random): WalkNode {
    return this.nodes[rng.int(0, this.nodes.length - 1)];
  }

  /** Bucketed nearest node: expands square rings of cells until a hit is found (one extra ring for exactness). */
  nearestNode(x: number, z: number): WalkNode {
    let cx = Math.floor((x - this.gridMinX) / CELL), cz = Math.floor((z - this.gridMinZ) / CELL);
    if (cx < 0) cx = 0; else if (cx >= this.gridCols) cx = this.gridCols - 1;
    if (cz < 0) cz = 0; else if (cz >= this.gridRows) cz = this.gridRows - 1;
    let best = -1, bd = Infinity;
    const maxRing = Math.max(this.gridCols, this.gridRows);
    let foundRing = -1;
    for (let ring = 0; ring <= maxRing; ring++) {
      if (foundRing >= 0 && ring > foundRing + 1) break;
      for (let gz = cz - ring; gz <= cz + ring; gz++) {
        if (gz < 0 || gz >= this.gridRows) continue;
        for (let gx = cx - ring; gx <= cx + ring; gx++) {
          if (gx < 0 || gx >= this.gridCols) continue;
          if (Math.abs(gx - cx) !== ring && Math.abs(gz - cz) !== ring) continue; // ring perimeter only
          const c = gz * this.gridCols + gx;
          for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
            const n = this.nodes[this.cellItems[k]];
            const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
            if (d < bd) { bd = d; best = n.id; }
          }
        }
      }
      if (best >= 0 && foundRing < 0) foundRing = ring;
    }
    return this.nodes[best < 0 ? 0 : best];
  }

  nodesInRing(cx: number, cz: number, rMin: number, rMax: number, out: number[]): number {
    let n = 0;
    const r0 = rMin * rMin, r1 = rMax * rMax;
    let gx0 = Math.floor((cx - rMax - this.gridMinX) / CELL), gx1 = Math.floor((cx + rMax - this.gridMinX) / CELL);
    let gz0 = Math.floor((cz - rMax - this.gridMinZ) / CELL), gz1 = Math.floor((cz + rMax - this.gridMinZ) / CELL);
    if (gx0 < 0) gx0 = 0; if (gx1 >= this.gridCols) gx1 = this.gridCols - 1;
    if (gz0 < 0) gz0 = 0; if (gz1 >= this.gridRows) gz1 = this.gridRows - 1;
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gz * this.gridCols + gx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const nd = this.nodes[this.cellItems[k]];
          const d = (nd.x - cx) * (nd.x - cx) + (nd.z - cz) * (nd.z - cz);
          if (d >= r0 && d <= r1) out[n++] = nd.id;
        }
      }
    }
    return n;
  }

  /** Next node along the loop; at corners with crossings, may cross the road with probability crossChance. */
  nextNode(current: number, direction: 1 | -1, rng: Random, crossChance: number): number {
    const n = this.nodes[current];
    if (n.corner && n.crossings.length > 0 && rng.chance(crossChance)) return n.crossings[rng.int(0, n.crossings.length - 1)];
    return direction === 1 ? n.loopNext : n.loopPrev;
  }
}
