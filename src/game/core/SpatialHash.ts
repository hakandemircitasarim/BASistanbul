// Uniform-grid spatial hash for AABB items with rect/circle/segment (DDA) queries and stamp-based dedup. Track P0.
export interface HashItem { minX: number; minZ: number; maxX: number; maxZ: number; hashStamp: number }

const OFFSET = 32768;
const cellKey = (cx: number, cz: number): number => (cx + OFFSET) * 65536 + (cz + OFFSET);
const emptyArray = (arr: HashItem[]): void => { arr.length = 0; };

export class SpatialHash<T extends HashItem> {
  private cells = new Map<number, T[]>();
  private stamp = 1;
  private _size = 0;
  private readonly inv: number;
  private count = 0; // query scratch counter
  readonly cellSize: number;

  constructor(cellSize: number) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
  }

  get size(): number { return this._size; }

  insert(item: T): void {
    const x0 = Math.floor(item.minX * this.inv), x1 = Math.floor(item.maxX * this.inv);
    const z0 = Math.floor(item.minZ * this.inv), z1 = Math.floor(item.maxZ * this.inv);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cellKey(cx, cz);
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(item);
      }
    }
    this._size++;
  }

  /** Removes using the item's CURRENT bounds (remove before changing bounds, or use clear()+reinsert). */
  remove(item: T): void {
    const x0 = Math.floor(item.minX * this.inv), x1 = Math.floor(item.maxX * this.inv);
    const z0 = Math.floor(item.minZ * this.inv), z1 = Math.floor(item.maxZ * this.inv);
    let found = false;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.cells.get(cellKey(cx, cz));
        if (!arr) continue;
        const i = arr.indexOf(item);
        if (i >= 0) {
          arr[i] = arr[arr.length - 1];
          arr.length--;
          found = true;
        }
      }
    }
    if (found) this._size--;
  }

  /** Empties every cell but keeps the cell arrays allocated for reuse. */
  clear(): void {
    this.cells.forEach(emptyArray);
    this._size = 0;
  }

  queryRect(minX: number, minZ: number, maxX: number, maxZ: number, out: T[]): number {
    const stamp = ++this.stamp;
    const x0 = Math.floor(minX * this.inv), x1 = Math.floor(maxX * this.inv);
    const z0 = Math.floor(minZ * this.inv), z1 = Math.floor(maxZ * this.inv);
    let n = 0;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.cells.get(cellKey(cx, cz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i];
          if (it.hashStamp === stamp) continue;
          if (it.maxX < minX || it.minX > maxX || it.maxZ < minZ || it.minZ > maxZ) continue;
          it.hashStamp = stamp;
          out[n++] = it;
        }
      }
    }
    return n;
  }

  queryCircle(cx: number, cz: number, r: number, out: T[]): number {
    const stamp = ++this.stamp;
    const x0 = Math.floor((cx - r) * this.inv), x1 = Math.floor((cx + r) * this.inv);
    const z0 = Math.floor((cz - r) * this.inv), z1 = Math.floor((cz + r) * this.inv);
    const r2 = r * r;
    let n = 0;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const arr = this.cells.get(cellKey(ix, iz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i];
          if (it.hashStamp === stamp) continue;
          // distance from circle center to the item's AABB
          const px = cx < it.minX ? it.minX : cx > it.maxX ? it.maxX : cx;
          const pz = cz < it.minZ ? it.minZ : cz > it.maxZ ? it.maxZ : cz;
          const dx = px - cx, dz = pz - cz;
          if (dx * dx + dz * dz > r2) continue;
          it.hashStamp = stamp;
          out[n++] = it;
        }
      }
    }
    return n;
  }

  /**
   * Items whose AABB (expanded by pad) intersects segment a->b. Walks the grid with DDA
   * (Amanatides & Woo) and visits the pad-neighbourhood of every traversed cell.
   */
  querySegment(ax: number, az: number, bx: number, bz: number, pad: number, out: T[]): number {
    const stamp = ++this.stamp;
    this.count = 0;
    const inv = this.inv;
    const padCells = Math.ceil(pad * inv);
    let cx = Math.floor(ax * inv), cz = Math.floor(az * inv);
    const ex = Math.floor(bx * inv), ez = Math.floor(bz * inv);
    const dx = bx - ax, dz = bz - az;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tDeltaX = dx !== 0 ? this.cellSize / Math.abs(dx) : Infinity;
    const tDeltaZ = dz !== 0 ? this.cellSize / Math.abs(dz) : Infinity;
    let tMaxX = dx !== 0 ? ((cx + (stepX > 0 ? 1 : 0)) * this.cellSize - ax) / dx : Infinity;
    let tMaxZ = dz !== 0 ? ((cz + (stepZ > 0 ? 1 : 0)) * this.cellSize - az) / dz : Infinity;
    const maxIter = Math.abs(ex - cx) + Math.abs(ez - cz) + 2;
    for (let iter = 0; iter < maxIter; iter++) {
      this.visitSegmentCells(cx, cz, padCells, stamp, ax, az, bx, bz, pad, out);
      if (cx === ex && cz === ez) break;
      if (tMaxX < tMaxZ) { cx += stepX; tMaxX += tDeltaX; }
      else { cz += stepZ; tMaxZ += tDeltaZ; }
    }
    return this.count;
  }

  private visitSegmentCells(cx: number, cz: number, padCells: number, stamp: number,
    ax: number, az: number, bx: number, bz: number, pad: number, out: T[]): void {
    for (let ix = cx - padCells; ix <= cx + padCells; ix++) {
      for (let iz = cz - padCells; iz <= cz + padCells; iz++) {
        const arr = this.cells.get(cellKey(ix, iz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i];
          if (it.hashStamp === stamp) continue;
          if (!segmentOverlapsAabb(ax, az, bx, bz, it.minX - pad, it.minZ - pad, it.maxX + pad, it.maxZ + pad)) continue;
          it.hashStamp = stamp;
          out[this.count++] = it;
        }
      }
    }
  }
}

/** Slab test: does segment a->b touch the box? */
function segmentOverlapsAabb(ax: number, az: number, bx: number, bz: number, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
  const dx = bx - ax, dz = bz - az;
  let t0 = 0, t1 = 1;
  if (dx === 0) {
    if (ax < minX || ax > maxX) return false;
  } else {
    const inv = 1 / dx;
    let ta = (minX - ax) * inv, tb = (maxX - ax) * inv;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  if (dz === 0) {
    if (az < minZ || az > maxZ) return false;
  } else {
    const inv = 1 / dz;
    let ta = (minZ - az) * inv, tb = (maxZ - az) * inv;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}
