// Built facade detail for CityRenderer: window frames with sills and reveals, balconies, split-unit air conditioners
// and downpipes, packed by distance into ONE THREE.BatchedMesh (one draw call, one shadow draw). The painted facade
// tile carries on beyond the range as the LOD. Track B.
//
// BuildingGeometry.appendBuildingDetail lists every unit of every street face once (FacadeCellList: world position on
// the wall plane, outward normal, size, kind / style / variant code, tint); this renderer keeps that list on the CPU and
// writes only the units inside FACADE_RANGE of the camera into the batch, repacked whenever the camera has moved
// FACADE_RANGE.repackMove metres - the same scheme PropRenderer uses for lamps and palms. Units on walls facing away
// from the camera are never packed (the wall hides them), and windows above the sixth floor drop out past
// FACADE_RANGE.highWindow, where a 0.15 m frame is a pixel anyway.
import * as THREE from 'three';
import type { BuildingStyle } from '../city/CityData';
import { CELL_KIND, CELL_STRIDE, CELL_STYLES, FacadeCellList } from './BuildingGeometry';
import { WINDOW_CELL, WINDOW_CELL_FRAME_PX } from './TextureFactory';

/** Pack ranges (m) per unit kind, the sixth-floor cut-off for windows and the camera move that triggers a repack. */
export const FACADE_RANGE = { window: 55, balcony: 90, ac: 45, pipe: 70, highWindow: 30, highFloorY: 20.5, repackMove: 15 } as const;
/** Instance budget of the batch (units inside the ranges are packed nearest-first until it is full). */
const MAX_UNITS = 3000;
/** Frame depth (m proud of the wall), sill depth and thickness, balcony slab / parapet / rail sizes. */
const UNIT = { frameOut: 0.15, sillOut: 0.22, sillH: 0.07, balconyDepth: 0.9, balconyH: 1.15, slabH: 0.14, parapetT: 0.1, railT: 0.06, acD: 0.32, pipeD: 0.1 } as const;
/** Frame / sill colours per style: white PVC on residential, precast on concrete, bronze with stone sills on art deco, charcoal on the neon strip. */
const FRAME_COLOR: Record<BuildingStyle, { frame: number; sill: number }> = {
  residential: { frame: 0xf2eee6, sill: 0xe4e0d8 },
  concrete: { frame: 0xd0d0cc, sill: 0xc4c4c0 },
  artdeco: { frame: 0x4a4640, sill: 0xd8d0c0 },
  neon: { frame: 0x2c3038, sill: 0x3c4048 },
  glass: { frame: 0xb8c4d0, sill: 0xb8c4d0 },
};
const AC_BODY = 0xd8d6d0, AC_GRILLE = 0xa8acb0;

const dummy = new THREE.Object3D();
const mat = new THREE.Matrix4();
const color = new THREE.Color();

/** Non-indexed quad soup with position / normal / colour, the attribute set every unit shares. */
class UnitBuilder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  private r = 1; private g = 1; private b = 1;

  setColor(hex: number, mul = 1): void {
    color.setHex(hex);
    this.r = color.r * mul; this.g = color.g * mul; this.b = color.b * mul;
  }

  /** Quad a-b-c-d counter-clockwise seen from the normal side (two triangles). */
  quad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, nx: number, ny: number, nz: number): void {
    const v = (x: number, y: number, z: number): void => { this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.col.push(this.r, this.g, this.b); };
    v(ax, ay, az); v(bx, by, bz); v(cx, cy, cz);
    v(ax, ay, az); v(cx, cy, cz); v(dx, dy, dz);
  }

  /**
   * Axis-aligned box in unit space (x across the wall, y up, z out of the wall) emitting only the faces in `faces`:
   * bit 1 front (+z), 2 back (-z), 4 right (+x), 8 left (-x), 16 top, 32 bottom.
   */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, faces: number): void {
    if (faces & 1) this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1);
    if (faces & 2) this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1);
    if (faces & 4) this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0);
    if (faces & 8) this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0);
    if (faces & 16) this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0);
    if (faces & 32) this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const F = { front: 1, back: 2, right: 4, left: 8, top: 16, bottom: 32 } as const;

/**
 * Window unit for a pane `w` x `h` (its centre at the origin on the wall plane): a head bar and two jambs UNIT.frameOut
 * proud of the wall whose faces toward the opening are the dark reveals, and a sill UNIT.sillOut deep under the pane.
 * 11 quads: head front + underside, jambs front + reveal + outer flank, sill front + top + underside.
 */
function windowUnit(w: number, h: number, jamb: number, head: number, style: BuildingStyle): THREE.BufferGeometry {
  const u = new UnitBuilder();
  const c = FRAME_COLOR[style];
  const d = UNIT.frameOut, x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2;
  u.setColor(c.frame);
  u.box(x0 - jamb, y1, 0, x1 + jamb, y1 + head, d, F.front);
  u.box(x0 - jamb, y0, 0, x0, y1 + head, d, F.front | F.left);
  u.box(x1, y0, 0, x1 + jamb, y1 + head, d, F.front | F.right);
  // Reveals: the faces looking into the opening, kept dark whatever the sun does.
  u.setColor(c.frame, 0.5);
  u.box(x0 - jamb, y1, 0, x1 + jamb, y1 + head, d, F.bottom);
  u.box(x0 - jamb, y0, 0, x0, y1 + head, d, F.right);
  u.box(x1, y0, 0, x1 + jamb, y1 + head, d, F.left);
  u.setColor(c.sill);
  u.box(x0 - jamb - 0.05, y0 - UNIT.sillH, 0, x1 + jamb + 0.05, y0, UNIT.sillOut, F.front | F.top);
  u.setColor(c.sill, 0.6);
  u.box(x0 - jamb - 0.05, y0 - UNIT.sillH, 0, x1 + jamb + 0.05, y0, UNIT.sillOut, F.bottom);
  return u.build();
}

/**
 * Balcony `w` wide standing on the floor line (origin = bay centre at floor height on the wall plane): a slab
 * UNIT.balconyDepth deep and, `solid` or not, a parapet wall on three sides or a handrail on four posts. The vertex
 * colours are factors of the instance tint (the building's slab colour): rails and parapet insides darker.
 */
function balconyUnit(w: number, solid: boolean): THREE.BufferGeometry {
  const u = new UnitBuilder();
  const x0 = -w / 2, x1 = w / 2, dep = UNIT.balconyDepth, sh = UNIT.slabH;
  u.setColor(0xffffff);
  u.box(x0, 0, 0, x1, sh, dep, F.front | F.top | F.left | F.right);
  u.setColor(0xffffff, 0.62);
  u.box(x0, 0, 0, x1, sh, dep, F.bottom);
  const top = sh + UNIT.balconyH;
  if (solid) {
    const t = UNIT.parapetT;
    u.setColor(0xffffff, 0.94);
    u.box(x0, sh, dep - t, x1, top, dep, F.front | F.top);
    u.box(x0, sh, 0, x0 + t, top, dep - t, F.left | F.top);
    u.box(x1 - t, sh, 0, x1, top, dep - t, F.right | F.top);
    u.setColor(0xffffff, 0.7);
    u.box(x0, sh, dep - t, x1, top, dep, F.back);
  } else {
    const t = UNIT.railT;
    u.setColor(0xffffff, 0.42);
    u.box(x0, top - t, dep - t, x1, top, dep, F.front | F.top | F.bottom);
    for (let k = 0; k < 4; k++) {
      const px = x0 + 0.03 + (k / 3) * (w - 0.06 - t);
      u.box(px, sh, dep - t, px + t, top - t, dep, F.front | (k < 2 ? F.left : F.right));
    }
    u.box(x0, sh + 0.06, dep - t, x1, sh + 0.06 + t, dep, F.front | F.top);
  }
  return u.build();
}

/** Split-unit condenser box hung under a sill: front (grille), top, bottom and both flanks. */
function acUnit(w: number, h: number): THREE.BufferGeometry {
  const u = new UnitBuilder();
  u.setColor(AC_BODY);
  u.box(-w / 2, -h / 2, 0, w / 2, h / 2, UNIT.acD, F.top | F.bottom | F.left | F.right);
  u.setColor(AC_GRILLE);
  u.box(-w / 2, -h / 2, 0, w / 2, h / 2, UNIT.acD, F.front);
  return u.build();
}

/** Rainwater downpipe: a square-section pipe of unit height (y 0..1, scaled per instance), front and both flanks. */
function pipeUnit(): THREE.BufferGeometry {
  const u = new UnitBuilder();
  const r = UNIT.pipeD / 2;
  u.setColor(0xffffff);
  u.box(-r, 0, 0.02, r, 1, 0.02 + UNIT.pipeD, F.front | F.left | F.right);
  return u.build();
}

export class FacadeDetailRenderer {
  private readonly mesh: THREE.BatchedMesh;
  private readonly cells: FacadeCellList;
  private readonly geometryIds = new Map<string, number>();
  private readonly geometries: THREE.BufferGeometry[] = [];
  /** Batch geometry id of every unit in the list, resolved once (repack then allocates nothing). */
  private readonly geomOf: Int32Array;
  private lastX = Infinity;
  private lastZ = Infinity;
  private _packed = 0;

  constructor(scene: THREE.Scene, cells: FacadeCellList, material: THREE.Material) {
    this.cells = cells;
    // Vertex budget: every unit variant the city needs (a few per style) at ~70 vertices each.
    this.mesh = new THREE.BatchedMesh(MAX_UNITS, 24000, 48000, material);
    this.mesh.name = 'facadeDetail';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    // The whole batch spans the city: cull per unit instead, and never sort (opaque).
    this.mesh.frustumCulled = false;
    this.mesh.perObjectFrustumCulled = true;
    this.mesh.sortObjects = false;
    // Register every variant the list needs up front (the batch's geometry ids are stable afterwards).
    const d = cells.data;
    this.geomOf = new Int32Array(Math.max(1, cells.n));
    for (let i = 0; i < cells.n; i++) this.geomOf[i] = this.geometryFor(d[i * CELL_STRIDE + 7], d[i * CELL_STRIDE + 5], d[i * CELL_STRIDE + 6]);
    const first = this.geometryIds.size > 0 ? 0 : this.geometryFor(CELL_KIND.pipe, 0.1, 1);
    for (let i = 0; i < MAX_UNITS; i++) {
      const id = this.mesh.addInstance(first);
      this.mesh.setVisibleAt(id, false);
    }
    // Allocates the colour texture before the first compile so the shader is built with per-instance colour.
    color.setRGB(1, 1, 1);
    this.mesh.setColorAt(0, color);
    scene.add(this.mesh);
    this.repack(0, 0);
  }

  /** Units currently written into the batch (debug / tests). */
  get packed(): number { return this._packed; }

  /** Geometry id for a unit code and size, building the variant on first use. */
  private geometryFor(code: number, w: number, h: number): number {
    const kind = code & 7, style = CELL_STYLES[(code >> 3) & 7] ?? 'residential', ground = ((code >> 6) & 1) === 1, variant = (code >> 8) & 255;
    let key: string, make: () => THREE.BufferGeometry;
    if (kind === CELL_KIND.window) {
      const wr = Math.round(w * 100), hr = Math.round(h * 100);
      key = `w:${style}:${ground ? 1 : 0}:${wr}:${hr}`;
      // Frame bar widths follow the painted frame: WINDOW_CELL_FRAME_PX px of a 256 px (one bay) / 251 px (one row)
      // cell, at whatever bay width and row height this tile has (the pane is a known fraction of the cell).
      const px = ground ? WINDOW_CELL_FRAME_PX.ground : WINDOW_CELL_FRAME_PX[style];
      const wc = ground ? WINDOW_CELL.ground : WINDOW_CELL[style];
      const jamb = (px / 256) * (w / wc.ww), head = (px / 251) * (h / wc.wh);
      make = () => windowUnit(w, h, jamb, head, style);
    } else if (kind === CELL_KIND.balcony) {
      const solid = (variant & 1) === 0;
      key = `b:${Math.round(w * 100)}:${solid ? 1 : 0}`;
      make = () => balconyUnit(w, solid);
    } else if (kind === CELL_KIND.ac) {
      key = `ac:${Math.round(w * 100)}:${Math.round(h * 100)}`;
      make = () => acUnit(w, h);
    } else {
      key = 'pipe';
      make = () => pipeUnit();
    }
    let id = this.geometryIds.get(key);
    if (id === undefined) {
      const g = make();
      this.geometries.push(g);
      id = this.mesh.addGeometry(g);
      this.geometryIds.set(key, id);
    }
    return id;
  }

  /** Refills the batch if the camera has moved FACADE_RANGE.repackMove metres since the last pack. */
  update(camX: number, camZ: number): void {
    const dx = camX - this.lastX, dz = camZ - this.lastZ;
    if (dx * dx + dz * dz < FACADE_RANGE.repackMove * FACADE_RANGE.repackMove) return;
    this.repack(camX, camZ);
  }

  private repack(camX: number, camZ: number): void {
    this.lastX = camX;
    this.lastZ = camZ;
    const d = this.cells.data, n = this.cells.n, mesh = this.mesh;
    const rW = FACADE_RANGE.window * FACADE_RANGE.window, rB = FACADE_RANGE.balcony * FACADE_RANGE.balcony, rA = FACADE_RANGE.ac * FACADE_RANGE.ac, rP = FACADE_RANGE.pipe * FACADE_RANGE.pipe;
    const rHigh = FACADE_RANGE.highWindow * FACADE_RANGE.highWindow;
    let k = 0;
    // Two passes, the near half first, so a crowded street fills the budget with its nearest units.
    for (let pass = 0; pass < 2 && k < MAX_UNITS; pass++) {
      for (let i = 0; i < n && k < MAX_UNITS; i++) {
        const o = i * CELL_STRIDE;
        const x = d[o], y = d[o + 1], z = d[o + 2], nx = d[o + 3], nz = d[o + 4];
        const ddx = x - camX, ddz = z - camZ;
        const d2 = ddx * ddx + ddz * ddz;
        const code = d[o + 7], kind = code & 7;
        const range = kind === CELL_KIND.window ? rW : kind === CELL_KIND.balcony ? rB : kind === CELL_KIND.ac ? rA : rP;
        if (pass === 0 ? d2 > range * 0.25 : d2 <= range * 0.25 || d2 > range) continue;
        // The wall hides anything on a face turned away from the camera.
        if (-ddx * nx - ddz * nz < 0) continue;
        if (kind === CELL_KIND.window && y > FACADE_RANGE.highFloorY && d2 > rHigh) continue;
        const h = d[o + 6];
        dummy.position.set(x, y, z);
        dummy.rotation.set(0, Math.atan2(nx, nz), 0);
        if (kind === CELL_KIND.pipe) dummy.scale.set(1, h, 1); else dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mat.copy(dummy.matrix);
        mesh.setGeometryIdAt(k, this.geomOf[i]);
        mesh.setMatrixAt(k, mat);
        color.setHex(d[o + 8]);
        mesh.setColorAt(k, color);
        mesh.setVisibleAt(k, true);
        k++;
      }
    }
    for (let i = k; i < MAX_UNITS; i++) mesh.setVisibleAt(i, false);
    this._packed = k;
  }

  dispose(): void {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.dispose();
    for (let i = 0; i < this.geometries.length; i++) this.geometries[i].dispose();
    this.geometries.length = 0;
    this.geometryIds.clear();
  }
}
