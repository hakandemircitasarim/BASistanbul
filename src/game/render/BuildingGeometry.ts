// Building/landmark geometry builders: world-space boxes/tiers/spires with meter UVs and vertex colors. Track B.
import * as THREE from 'three';
import type { Building, BuildingStyle, Landmark } from '../city/CityData';
import type { Random } from '../core/Random';
import { GLOW_U, PLINTH_BAND_H, PLINTH_BAYS, PLINTH_DOOR_BAY, PLINTH_TILE_W, ROOF_SEAM_U, ROOF_STRIP_PX, ROOF_V, SHOP_BAND_H, SHOP_BAYS, SHOP_BAY_W, SHOP_DOOR_W, SHOP_FASCIA_Y, SHOP_PLAIN_UV, SHOP_ROWS, SHOP_TILE_W, WINDOW_CELL, WINDOW_TILE_H, WINDOW_TILE_PX_H, WINDOW_TILE_W } from './TextureFactory';

/** Material key for a landmark part: a windowed building style (plain parts use the white strip UV) or 'glow' (emissive neon parts). */
export type LandmarkStyle = BuildingStyle | 'glow';
const GLOW_V = 0.5;
export interface LandmarkPart { geometry: THREE.BufferGeometry; style: LandmarkStyle; /** Part rotates about local X (ferris wheel); geometry centered on the hub. */ rotating: boolean; hubX: number; hubY: number; hubZ: number }

const BASE_Y = -0.2;
/** Where a building's walls start without an arcade: a hair under the block plane. */
export const BASE_WALL_Y = BASE_Y;
/**
 * Baked ambient occlusion. A street is darker where walls meet the pavement, and without that gradient every box
 * looks pasted onto the ground. The ramp is applied in the vertex colour, so it costs nothing at runtime and it
 * leaves the emissive channel (lit windows, shop interiors, neon) alone.
 */
const AO_HEIGHT = 6;
const AO_FLOOR = 0.5;
const ROOF_DARKEN = 0.75;
const WALL_LIGHTEN = 0.2;
const FLOOR_H = 3.5;
/** Downtown podium height under a chamfered shaft or an offset tower (three floors on the -0.2 base). */
const PODIUM_H = 3 * FLOOR_H + 0.2;
const OCT = Math.PI / 8;
/** Concentric stepped roofs always use two tiers: a third one on tall towers cost a full extra windowed box each. */
const TIERS = 2;
/** Roofs below this height get no parapet walls or clutter: from the street they are never seen, only their edge is. */
const CLUTTER_MIN_H = 12;
/** Face bits for GeoBuilder.boxFaces. */
export const FACE = { pz: 1, nz: 2, px: 4, nx: 8, top: 16, bot: 32, sides: 15, all: 63 } as const;
/**
 * Baked ambient per face orientation for the small plain solids (roof kit, crowns, spires). The sun already shades
 * them, but a sky probe that answers every direction alike leaves a 3 m box on a roof reading as one flat pastel
 * colour at any distance; pulling the north and west faces down gives it form in the silhouette. The noon sun leans
 * south (+Z), so +Z stays full.
 */
const FACE_SHADE = { top: 1, pz: 0.98, px: 0.9, nz: 0.7, nx: 0.78 } as const;
/** FACE_SHADE for an arbitrary outward plan direction: the round crowns, drums and tanks read the same way. */
function dirShade(dx: number, dz: number): number {
  const ax = Math.abs(dx), az = Math.abs(dz), t = ax + az;
  if (t < 1e-9) return FACE_SHADE.top;
  return ((dx >= 0 ? FACE_SHADE.px : FACE_SHADE.nx) * ax + (dz >= 0 ? FACE_SHADE.pz : FACE_SHADE.nz) * az) / t;
}
/** World face bit of building face 0..3 (+Z, +X, -Z, -X). */
const FACE_BIT = [FACE.pz, FACE.px, FACE.nz, FACE.nx];
/** Towers above this height get a crown (chamfered top, cornice at its foot, plant room, mast). */
const CROWN_MIN_H = 42;
/** Crown chamfer: the top CHAMFER_H metres of a tower's corners are cut at 45 degrees, so the roof is inset by the same. */
const CHAMFER_H = 2;
/**
 * Window grid of the facade textures: 4 bays per tile width, 8 rows under a ROOF_STRIP_PX strip per tile height
 * (TextureFactory.windows). The tile is 16 m x 28 m by default; a tower may stretch it (Massing.tw / th) so its rhythm
 * differs from its neighbours'. Ledges, piers, slabs and balconies are placed on this grid so the relief lines up
 * with the painted sills and mullions whatever the UV offset (offsets are whole cells / whole rows).
 */
const ROW_V = (1 - ROOF_STRIP_PX / WINDOW_TILE_PX_H) / 8;
/** Top of the window rows in tile v: above it lies the plain roof strip, which the facade UVs are kept out of. */
const ROWS_V_TOP = 1 - ROOF_STRIP_PX / WINDOW_TILE_PX_H;
const tmpColor = new THREE.Color();
const hslScratch = { h: 0, s: 0, l: 0 };
/**
 * Street faces longer than this get their plan jogged: every other tint segment (GeoBuilder facade) steps back
 * 0.7-1.0 m, so a 60 m hotel front reads as a row of terraces instead of one extruded slab.
 */
const LONG_FACE = 40;
/** Faces longer than this split into tint / UV segments about every WALL_SEG_LEN, at whole window bays. */
const SEG_MIN = 20;
/** Target length of a wall segment: three window bays. */
const WALL_SEG_LEN = 12;
/** Recess of one bay in three on residential / art deco street faces. */
const BAY_RECESS = 0.3;
/** A wall taller than this many rows is cut into bands of BAND_ROWS rows, each with its own window-cell offsets. */
const BAND_ROWS = 4;
/** 45-degree corner cut of a residential / art deco building on a street corner. */
const CHAMFER_MIN = 2.2, CHAMFER_VAR = 0.8;
/** Floor slab projected at every floor line on residential / art deco / suburb concrete street faces. */
const SLAB_OUT = 0.25, SLAB_H = 0.22;
/**
 * Roof-edge cornice shading (see cornice / corniceOutline). The fillet sits under the crown slab's oversail: its foot
 * still sees the sky (CORNICE_LIT), its head is buried under the soffit (CORNICE_SHADE), and the soffit itself faces
 * straight down (CORNICE_SOFFIT). Vertex colour, not geometry - the profile already exists, what it lacked was the
 * shadow line that tells the eye it is 0.35 m proud of the wall rather than painted on it.
 */
const CORNICE_LIT = 0.98, CORNICE_SHADE = 0.6, CORNICE_SOFFIT = 0.52;
/** Parapet: 1.0-1.2 m walls on the cornice with a coping slab on top. */
const PARAPET_MIN = 1.0, PARAPET_VAR = 0.2, COPING_H = 0.12, COPING_OUT = 0.08;
/** Baked occlusion at the head of a parapet, under the coping's oversail (see parapetWalls). */
const PARAPET_AO = 0.66;
/** Door cell of a shop bay steps this far into the wall (dark reveal faces either side, a door leaf and a threshold step at the back). */
const DOOR_RECESS = 1.2;
/** Door leaf: proud of the recess back, inset from the door cell's jambs; the threshold step in front of it. */
const DOOR_LEAF_OUT = 0.06, DOOR_LEAF_INSET = 0.1, DOOR_LEAF_H = 2.35, DOOR_STEP_H = 0.12, DOOR_STEP_D = 0.5;
/**
 * How far the painted shop interior sits BEHIND the fascia plane. The shopfront atlas paints the goods, the shelves
 * and the floor on the same plane as the glass, so from a car the interior is a poster at the wrong perspective:
 * pushing that plane back half a metre gives the head of the opening a real soffit, the bay lines real reveals (the
 * arcade columns already stand on the wall line and simply run back to it) and the whole row parallax when you drive
 * past. The door cell keeps its own, deeper DOOR_RECESS.
 */
const GLASS_RECESS = 0.45;
/** Height (fraction of the glazing band) and depth of the display counter behind each shop window. */
const COUNTER = { y: 0.34, front: 0.1, inset: 0.25 } as const;

/** 32-bit integer hash (murmur3 finaliser) of a small integer key. */
function hashU(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
/** Stable pseudo-random in [0, 1) for an integer key (building id, face, bay ...), so a city renders the same everywhere. */
function hash01(n: number): number { return hashU(n) / 4294967296; }

/** Shifts a colour's hue by `dh` turns and scales its lightness by (1 + dv). */
function perturb(color: number, dh: number, dv: number): number {
  tmpColor.setHex(color).getHSL(hslScratch);
  tmpColor.setHSL(hslScratch.h + dh, hslScratch.s, Math.min(1, Math.max(0, hslScratch.l * (1 + dv))));
  return tmpColor.getHex();
}

/**
 * The colour a building is rendered with: its palette colour nudged by a stable hash of its id (hue +-6 deg, value
 * +-8 %). Neighbouring lots often draw the same palette entry, and two identical tints side by side read as one slab.
 */
export function buildingTint(b: Building): number {
  return perturb(b.color, (hash01(b.id * 3 + 1) - 0.5) * (12 / 360), (hash01(b.id * 3 + 2) - 0.5) * 0.16);
}

/**
 * Face-local frame of a wall: start point (sx, sz), unit tangent (tx, tz) running the way the face's u runs, outward
 * normal (nx, nz) = (-tz, tx) and the length. Bays and window columns start at s = 0 from here whatever the UV offset
 * (offsets are whole cells).
 */
export interface FaceFrame { sx: number; sz: number; tx: number; tz: number; nx: number; nz: number; len: number }
const faceOut: FaceFrame = { sx: 0, sz: 0, tx: 0, tz: 0, nx: 0, nz: 0, len: 0 };
/** Frame of rect face `f` (0..3 = +Z, +X, -Z, -X): boxWindows / bandBox u convention. */
function faceFrame(x0: number, z0: number, x1: number, z1: number, f: number, o: FaceFrame = faceOut): FaceFrame {
  if (f === 0) { o.sx = x0; o.sz = z1; o.tx = 1; o.tz = 0; o.nx = 0; o.nz = 1; o.len = x1 - x0; }
  else if (f === 1) { o.sx = x1; o.sz = z1; o.tx = 0; o.tz = -1; o.nx = 1; o.nz = 0; o.len = z1 - z0; }
  else if (f === 2) { o.sx = x1; o.sz = z0; o.tx = -1; o.tz = 0; o.nx = 0; o.nz = -1; o.len = x1 - x0; }
  else { o.sx = x0; o.sz = z0; o.tx = 0; o.tz = 1; o.nx = -1; o.nz = 0; o.len = z1 - z0; }
  return o;
}

/**
 * Convex footprint of a building's base box: corners counter-clockwise seen from above, edge i running from corner i
 * to corner i + 1 with the outward normal (-tz, tx). A rect with up to four 45-degree corner chamfers (eight corners
 * at most). `face[i]` is the building face (0..3 = +Z, +X, -Z, -X) edge i lies on, -1 for a chamfer edge.
 */
export class Outline {
  n = 0;
  readonly x = new Float64Array(8);
  readonly z = new Float64Array(8);
  readonly face = new Int8Array(8);

  /** Rect x0..x1 / z0..z1 with corner k (where face k starts: the corner between face k - 1 and face k) cut back by c[k] metres (0 = square). */
  set(x0: number, z0: number, x1: number, z1: number, c0 = 0, c1 = 0, c2 = 0, c3 = 0): this {
    const px = [x0, x1, x1, x0], pz = [z1, z1, z0, z0], tx = [1, 0, -1, 0], tz = [0, -1, 0, 1], c = [c0, c1, c2, c3];
    this.n = 0;
    for (let k = 0; k < 4; k++) {
      const j = (k + 3) % 4;
      if (c[k] > 0) {
        this.push(px[k] - tx[j] * c[k], pz[k] - tz[j] * c[k], -1);
        this.push(px[k] + tx[k] * c[k], pz[k] + tz[k] * c[k], k);
      } else this.push(px[k], pz[k], k);
    }
    return this;
  }

  private push(x: number, z: number, face: number): void { this.x[this.n] = x; this.z[this.n] = z; this.face[this.n] = face; this.n++; }

  copy(o: Outline): this { this.n = o.n; this.x.set(o.x); this.z.set(o.z); this.face.set(o.face); return this; }

  /** Frame of edge i (corner i to corner i + 1). */
  edge(i: number, o: FaceFrame = faceOut): FaceFrame {
    const j = (i + 1) % this.n;
    const dx = this.x[j] - this.x[i], dz = this.z[j] - this.z[i];
    const len = Math.hypot(dx, dz) || 1;
    o.sx = this.x[i]; o.sz = this.z[i]; o.tx = dx / len; o.tz = dz / len; o.nx = -o.tz; o.nz = o.tx; o.len = len;
    return o;
  }

  /** Every edge moved `d` along its outward normal (d < 0 shrinks), corners mitred, written into `out`. */
  offset(d: number, out: Outline): Outline {
    out.n = this.n;
    for (let i = 0; i < this.n; i++) {
      const p = (i + this.n - 1) % this.n, q = (i + 1) % this.n;
      // Outward normals of the edges ending and starting at corner i.
      let ax = -(this.z[i] - this.z[p]), az = this.x[i] - this.x[p];
      let bx = -(this.z[q] - this.z[i]), bz = this.x[q] - this.x[i];
      const al = Math.hypot(ax, az) || 1, bl = Math.hypot(bx, bz) || 1;
      ax /= al; az /= al; bx /= bl; bz /= bl;
      const k = d / (1 + ax * bx + az * bz);
      out.x[i] = this.x[i] + (ax + bx) * k;
      out.z[i] = this.z[i] + (az + bz) * k;
      out.face[i] = this.face[i];
    }
    return out;
  }

  /** Whether corner i (start of edge i, end of edge i - 1) touches a street: either edge is a street face (a chamfer edge counts through its neighbours). */
  streetCorner(i: number, mask: number): boolean {
    return this.streetEdge((i + this.n - 1) % this.n, mask) || this.streetEdge(i, mask);
  }

  /** Whether edge i sees a street: its face bit is in `mask`; a chamfer edge does when both faces it joins do. */
  streetEdge(i: number, mask: number): boolean {
    const f = this.face[i];
    if (f >= 0) return ((mask >> f) & 1) === 1;
    const fp = this.face[(i + this.n - 1) % this.n], fq = this.face[(i + 1) % this.n];
    return fp >= 0 && fq >= 0 && ((mask >> fp) & 1) === 1 && ((mask >> fq) & 1) === 1;
  }
}
const olA = new Outline(), olB = new Outline(), olC = new Outline(), olD = new Outline(), olE = new Outline();

/** Accumulates indexed quads/triangles with position, normal, uv and color attributes. Build-time only. */
export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private r = 1; private g = 1; private b = 1;
  /** Glow parts skip the ground ramp: a neon sign at street level must not be dimmed by fake occlusion. */
  bakeAo = true;
  /** Sibling builder receiving every glow part (rendered with Materials.glow + the glow atlas); null until first used. */
  private glowSide: GeoBuilder | null = null;

  get glow(): GeoBuilder | null { return this.glowSide; }

  /** Routes this builder's glow parts into a shared sink so many style builders produce a single glow mesh. */
  setGlowSink(sink: GeoBuilder): void { this.glowSide = sink; sink.bakeAo = false; }

  /** Builder + plain UV for a part: glow parts go to the sibling builder with atlas UVs, others stay here on the white strip. */
  private plainTarget(glow: number): { b: GeoBuilder; u: number; v: number } {
    if (glow === GLOW_U.none) return { b: this, u: 0.25, v: ROOF_V };
    if (!this.glowSide) { this.glowSide = new GeoBuilder(); this.glowSide.bakeAo = false; }
    return { b: this.glowSide, u: glow, v: GLOW_V };
  }

  setColor(hexColor: number, mul = 1): void {
    tmpColor.setHex(hexColor);
    this.r = tmpColor.r * mul; this.g = tmpColor.g * mul; this.b = tmpColor.b * mul;
  }

  private vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    if (this.bakeAo && y < AO_HEIGHT) {
      const t = Math.max(0, y) / AO_HEIGHT;
      const k = AO_FLOOR + (1 - AO_FLOOR) * (t * t * (3 - 2 * t));
      this.col.push(this.r * k, this.g * k, this.b * k);
    } else {
      this.col.push(this.r, this.g, this.b);
    }
    return this.pos.length / 3 - 1;
  }

  /** Quad a-b-c-d counter-clockwise seen from the normal side. */
  quad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number, ua: number, va: number, ub: number, vb: number, uc: number, vc: number, ud: number, vd: number): void {
    const i = this.vertex(ax, ay, az, nx, ny, nz, ua, va);
    this.vertex(bx, by, bz, nx, ny, nz, ub, vb);
    this.vertex(cx, cy, cz, nx, ny, nz, uc, vc);
    this.vertex(dx, dy, dz, nx, ny, nz, ud, vd);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, u: number, v: number): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i = this.vertex(ax, ay, az, nx, ny, nz, u, v);
    this.vertex(bx, by, bz, nx, ny, nz, u, v);
    this.vertex(cx, cy, cz, nx, ny, nz, u, v);
    this.idx.push(i, i + 1, i + 2);
  }

  /**
   * Box with window UVs in meters on the sides (tile tw x th) and the plain strip on top (no bottom). `segKey` >= 0 (a
   * building id) lets faces longer than SEG_MIN split into tint segments (wallFace); landmarks pass none and stay one
   * quad a face. Buildings' base boxes go through `facade` instead (jogs, recesses, per-segment cell offsets).
   */
  boxWindows(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, wall: number, roof: number, uOff = 0, vOff = 0, segKey = -1, tw = WINDOW_TILE_W, th = WINDOW_TILE_H): void {
    const va = y0 / th + vOff, vb = y1 / th + vOff;
    // +Z face (south): u along +X; -Z (north): u along -X; +X (east): u along -Z; -X (west): u along +Z.
    this.wallFace(x0, z1, 1, 0, x1 - x0, y0, y1, 0, 1, uOff, va, vb, wall, segKey, 0, tw);
    this.wallFace(x1, z0, -1, 0, x1 - x0, y0, y1, 0, -1, uOff + 0.25, va, vb, wall, segKey, 2, tw);
    this.wallFace(x1, z1, 0, -1, z1 - z0, y0, y1, 1, 0, uOff + 0.5, va, vb, wall, segKey, 1, tw);
    this.wallFace(x0, z0, 0, 1, z1 - z0, y0, y1, -1, 0, uOff + 0.75, va, vb, wall, segKey, 3, tw);
    this.setColor(roof);
    this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, 0.5, ROOF_V, 0.5, ROOF_V, 0.5, ROOF_V, 0.5, ROOF_V);
  }

  /**
   * One windowed wall from (sx, sz) along the unit tangent (tx, tz) for `len` metres between y0 and y1, u starting at
   * `ua` (metres / tile). On a building (segKey >= 0) a face longer than SEG_MIN is split about every WALL_SEG_LEN
   * at whole window bays into quads whose vertex tint drifts a little (hue +-4 deg, value +-5 %): the texture runs on
   * unbroken, but the render reads as a terrace of painted sections rather than one extruded slab.
   */
  private wallFace(sx: number, sz: number, tx: number, tz: number, len: number, y0: number, y1: number, nx: number, nz: number, ua: number, va: number, vb: number, wall: number, segKey: number, face: number, TW: number): void {
    const bayW = TW / 4;
    const n = segKey >= 0 && len > SEG_MIN ? Math.max(2, Math.round(len / WALL_SEG_LEN)) : 1;
    let s0 = 0;
    for (let k = 0; k < n; k++) {
      const s1 = k === n - 1 ? len : Math.min(len, Math.round((((k + 1) * len) / n) / bayW) * bayW);
      if (s1 <= s0 + 1e-6) continue;
      const key = segKey * 4 + face;
      this.setColor(n === 1 ? wall : perturb(wall, (hash01(key * 31 + k) - 0.5) * (8 / 360), (hash01(key * 37 + k) - 0.5) * 0.1));
      const ax = sx + tx * s0, az = sz + tz * s0, bx = sx + tx * s1, bz = sz + tz * s1;
      this.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, nx, 0, nz, ua + s0 / TW, va, ua + s1 / TW, va, ua + s1 / TW, vb, ua + s0 / TW, vb);
      s0 = s1;
    }
  }

  /** Plain-colored box (uses the white strip UV) with all faces; bottom optional; `glow` picks a night-glow cell (GLOW_U). */
  boxPlain(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number, bottom = false, glow: number = GLOW_U.none): void {
    const { b, u, v } = this.plainTarget(glow);
    b.setColor(color);
    b.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, u, v, u, v, u, v, u, v);
    b.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, u, v, u, v, u, v, u, v);
    b.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, u, v, u, v, u, v, u, v);
    b.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, u, v, u, v, u, v, u, v);
    b.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, u, v, u, v, u, v, u, v);
    if (bottom) b.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, u, v, u, v, u, v, u, v);
  }

  /**
   * Hollow rectangular frame (parapet wall): outer faces, inner faces and the top only — 12 quads against the
   * 20 of four separate boxes, and the hidden faces at the corners and the base are never emitted.
   */
  frame(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t: number, color: number): void {
    const u = 0.25, v = ROOF_V;
    this.setColor(color);
    const ix0 = x0 + t, ix1 = x1 - t, iz0 = z0 + t, iz1 = z1 - t;
    // Outer faces.
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, u, v, u, v, u, v, u, v);
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, u, v, u, v, u, v, u, v);
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, u, v, u, v, u, v, u, v);
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, u, v, u, v, u, v, u, v);
    // Inner faces (normals point into the roof).
    this.quad(ix1, y0, iz1, ix0, y0, iz1, ix0, y1, iz1, ix1, y1, iz1, 0, 0, -1, u, v, u, v, u, v, u, v);
    this.quad(ix0, y0, iz0, ix1, y0, iz0, ix1, y1, iz0, ix0, y1, iz0, 0, 0, 1, u, v, u, v, u, v, u, v);
    this.quad(ix1, y0, iz0, ix1, y0, iz1, ix1, y1, iz1, ix1, y1, iz0, -1, 0, 0, u, v, u, v, u, v, u, v);
    this.quad(ix0, y0, iz1, ix0, y0, iz0, ix0, y1, iz0, ix0, y1, iz1, 1, 0, 0, u, v, u, v, u, v, u, v);
    // Top ring.
    this.quad(x0, y1, z1, x1, y1, z1, x1, y1, iz1, x0, y1, iz1, 0, 1, 0, u, v, u, v, u, v, u, v);
    this.quad(x0, y1, iz0, x1, y1, iz0, x1, y1, z0, x0, y1, z0, 0, 1, 0, u, v, u, v, u, v, u, v);
    this.quad(x0, y1, iz1, ix0, y1, iz1, ix0, y1, iz0, x0, y1, iz0, 0, 1, 0, u, v, u, v, u, v, u, v);
    this.quad(ix1, y1, iz1, x1, y1, iz1, x1, y1, iz0, ix1, y1, iz0, 0, 1, 0, u, v, u, v, u, v, u, v);
  }

  /** Single quad with the plain-strip UV (vertex color only); the normal comes from the winding. */
  plainQuad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, color: number, twoSided = false): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const u = 0.25, v = ROOF_V;
    this.setColor(color);
    this.quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, u, v, u, v, u, v, u, v);
    if (twoSided) this.quad(dx, dy, dz, cx, cy, cz, bx, by, bz, ax, ay, az, -nx, -ny, -nz, u, v, u, v, u, v, u, v);
  }

  /**
   * One vertical face of a street-level band from `s0` to `s1` metres along the unit tangent (tx, tz) out of (sx, sz),
   * facing (nx, nz), y0..y1, with u running from u0 to u1 and v spanning 0..1 over the band height.
   */
  bandFace(sx: number, sz: number, tx: number, tz: number, nx: number, nz: number, s0: number, s1: number, y0: number, y1: number, u0: number, u1: number, color: number): void {
    const ax = sx + tx * s0, az = sz + tz * s0, bx = sx + tx * s1, bz = sz + tz * s1;
    this.setColor(color);
    this.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, nx, 0, nz, u0, 0, u1, 0, u1, 1, u0, 1);
  }

  /** Four vertical faces of a street-level band: u repeats every `tileW` meters along the face, v spans 0..1 over the band height. */
  bandBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tileW: number, color: number, uOff = 0): void {
    const ux = (x1 - x0) / tileW, uz = (z1 - z0) / tileW;
    this.setColor(color);
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, uOff, 0, uOff + ux, 0, uOff + ux, 1, uOff, 1);
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, uOff + 0.25, 0, uOff + 0.25 + ux, 0, uOff + 0.25 + ux, 1, uOff + 0.25, 1);
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, uOff + 0.5, 0, uOff + 0.5 + uz, 0, uOff + 0.5 + uz, 1, uOff + 0.5, 1);
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, uOff + 0.75, 0, uOff + 0.75 + uz, 0, uOff + 0.75 + uz, 1, uOff + 0.75, 1);
  }

  /**
   * Plain box emitting only the faces in `mask` (FACE bits). Relief pieces stuck to a wall (ledges, piers, balcony
   * slabs, arcade columns) never need their hidden back / end faces, and a merged city mesh draws every face always.
   */
  boxFaces(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number, mask: number): void {
    const u = 0.25, v = ROOF_V;
    this.setColor(color);
    if (mask & FACE.pz) this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, u, v, u, v, u, v, u, v);
    if (mask & FACE.nz) this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, u, v, u, v, u, v, u, v);
    if (mask & FACE.px) this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, u, v, u, v, u, v, u, v);
    if (mask & FACE.nx) this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, u, v, u, v, u, v, u, v);
    if (mask & FACE.top) this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, u, v, u, v, u, v, u, v);
    if (mask & FACE.bot) this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, u, v, u, v, u, v, u, v);
  }

  /**
   * Two-step cornice around a roof edge: a fillet `out0` proud and `h0` tall under a crown slab `out1` proud and
   * `h1` tall, whose underside is the visible soffit. Outer faces, the soffit ring and a single top quad only
   * (13 quads): the parts buried in the wall and under the roof are never emitted.
   */
  cornice(x0: number, z0: number, x1: number, z1: number, top: number, out0: number, h0: number, out1: number, h1: number, color: number): void {
    const u = 0.25, v = ROOF_V;
    const yb = top - h0 - h1, ym = top - h1;
    const ax0 = x0 - out0, ax1 = x1 + out0, az0 = z0 - out0, az1 = z1 + out0;
    const bx0 = x0 - out1, bx1 = x1 + out1, bz0 = z0 - out1, bz1 = z1 + out1;
    this.setColor(darken(color, 0.92));
    // Fillet: four outer faces.
    this.quad(ax0, yb, az1, ax1, yb, az1, ax1, ym, az1, ax0, ym, az1, 0, 0, 1, u, v, u, v, u, v, u, v);
    this.quad(ax1, yb, az0, ax0, yb, az0, ax0, ym, az0, ax1, ym, az0, 0, 0, -1, u, v, u, v, u, v, u, v);
    this.quad(ax1, yb, az1, ax1, yb, az0, ax1, ym, az0, ax1, ym, az1, 1, 0, 0, u, v, u, v, u, v, u, v);
    this.quad(ax0, yb, az0, ax0, yb, az1, ax0, ym, az1, ax0, ym, az0, -1, 0, 0, u, v, u, v, u, v, u, v);
    // Soffit ring under the slab (faces down): from the fillet's outer edge to the slab's outer edge.
    this.setColor(darken(color, CORNICE_SOFFIT));
    this.quad(bx0, ym, az1, bx1, ym, az1, bx1, ym, bz1, bx0, ym, bz1, 0, -1, 0, u, v, u, v, u, v, u, v);
    this.quad(bx0, ym, bz0, bx1, ym, bz0, bx1, ym, az0, bx0, ym, az0, 0, -1, 0, u, v, u, v, u, v, u, v);
    this.quad(bx0, ym, az0, ax0, ym, az0, ax0, ym, az1, bx0, ym, az1, 0, -1, 0, u, v, u, v, u, v, u, v);
    this.quad(ax1, ym, az0, bx1, ym, az0, bx1, ym, az1, ax1, ym, az1, 0, -1, 0, u, v, u, v, u, v, u, v);
    // Slab: four outer faces and the top.
    this.setColor(color);
    this.quad(bx0, ym, bz1, bx1, ym, bz1, bx1, top, bz1, bx0, top, bz1, 0, 0, 1, u, v, u, v, u, v, u, v);
    this.quad(bx1, ym, bz0, bx0, ym, bz0, bx0, top, bz0, bx1, top, bz0, 0, 0, -1, u, v, u, v, u, v, u, v);
    this.quad(bx1, ym, bz1, bx1, ym, bz0, bx1, top, bz0, bx1, top, bz1, 1, 0, 0, u, v, u, v, u, v, u, v);
    this.quad(bx0, ym, bz0, bx0, ym, bz1, bx0, top, bz1, bx0, top, bz0, -1, 0, 0, u, v, u, v, u, v, u, v);
    this.quad(bx0, top, bz1, bx1, top, bz1, bx1, top, bz0, bx0, top, bz0, 0, 1, 0, u, v, u, v, u, v, u, v);
  }

  /**
   * Chamfered top: four 45-degree slopes from the rect at y0 to the rect inset by `inset` at y1, plus the flat top.
   * The slopes carry FACE_SHADE so a crown has form from 200 m instead of four identical pastel facets.
   */
  chamferTop(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, inset: number, color: number, top: number): void {
    const u = 0.25, v = ROOF_V;
    const ix0 = x0 + inset, ix1 = x1 - inset, iz0 = z0 + inset, iz1 = z1 - inset;
    const n = Math.SQRT1_2;
    this.setColor(color, FACE_SHADE.pz);
    this.quad(x0, y0, z1, x1, y0, z1, ix1, y1, iz1, ix0, y1, iz1, 0, n, n, u, v, u, v, u, v, u, v);
    this.setColor(color, FACE_SHADE.nz);
    this.quad(x1, y0, z0, x0, y0, z0, ix0, y1, iz0, ix1, y1, iz0, 0, n, -n, u, v, u, v, u, v, u, v);
    this.setColor(color, FACE_SHADE.px);
    this.quad(x1, y0, z1, x1, y0, z0, ix1, y1, iz0, ix1, y1, iz1, n, n, 0, u, v, u, v, u, v, u, v);
    this.setColor(color, FACE_SHADE.nx);
    this.quad(x0, y0, z0, x0, y0, z1, ix0, y1, iz1, ix0, y1, iz0, -n, n, 0, u, v, u, v, u, v, u, v);
    this.setColor(top);
    this.quad(ix0, y1, iz1, ix1, y1, iz1, ix1, y1, iz0, ix0, y1, iz0, 0, 1, 0, u, v, u, v, u, v, u, v);
  }

  /** Elliptical frustum (plain UV): radii rx0/rz0 at y0 tapering to rx1/rz1 at y1, with a flat top cap. */
  frustum(cx: number, cz: number, rx0: number, rz0: number, rx1: number, rz1: number, y0: number, y1: number, segments: number, color: number, top: number, phase = 0): void {
    const u = 0.25, v = ROOF_V;
    this.setColor(color);
    const dy = y1 - y0, dr = Math.max(rx0 - rx1, rz0 - rz1);
    const nl = Math.hypot(dy, dr) || 1;
    for (let i = 0; i < segments; i++) {
      const a0 = phase + (i / segments) * Math.PI * 2, a1 = phase + ((i + 1) / segments) * Math.PI * 2, am = (a0 + a1) / 2;
      const nx = Math.cos(am) * dy / nl, nz = Math.sin(am) * dy / nl, ny = dr / nl;
      this.setColor(color, dirShade(Math.cos(am), Math.sin(am)));
      this.quad(cx + Math.cos(a1) * rx0, y0, cz + Math.sin(a1) * rz0, cx + Math.cos(a0) * rx0, y0, cz + Math.sin(a0) * rz0,
        cx + Math.cos(a0) * rx1, y1, cz + Math.sin(a0) * rz1, cx + Math.cos(a1) * rx1, y1, cz + Math.sin(a1) * rz1, nx, ny, nz, u, v, u, v, u, v, u, v);
    }
    this.setColor(top);
    for (let i = 0; i < segments; i++) {
      const a0 = phase + (i / segments) * Math.PI * 2, a1 = phase + ((i + 1) / segments) * Math.PI * 2;
      // Same +Y winding as cylinder's cap: an open cone read as a folded card from any roof or tower.
      this.tri(cx, y1, cz, cx + Math.cos(a1) * rx1, y1, cz + Math.sin(a1) * rz1, cx + Math.cos(a0) * rx1, y1, cz + Math.sin(a0) * rz1, u, v);
    }
  }

  /** Quad with explicit UVs and the normal from its winding (textured single-sided surfaces such as awning canvas). */
  texQuad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    ua: number, va: number, ub: number, vb: number, uc: number, vc: number, ud: number, vd: number): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, ua, va, ub, vb, uc, vc, ud, vd);
  }

  /**
   * Four-sided pyramid over the rectangle x0..x1 / z0..z1 from y0 to apexY. The four faces carry FACE_SHADE, a baked
   * ambient term that keeps the north and west slopes down: a roof cone lit only by the sun and a uniform sky probe
   * comes out as four flat pastel triangles, which is exactly what makes a spire read as a primitive from 200 m.
   */
  pyramid(x0: number, z0: number, x1: number, z1: number, y0: number, apexY: number, color: number): void {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, u = 0.5, v = ROOF_V;
    this.setColor(color, FACE_SHADE.pz);
    this.tri(x0, y0, z1, x1, y0, z1, cx, apexY, cz, u, v);
    this.setColor(color, FACE_SHADE.nz);
    this.tri(x1, y0, z0, x0, y0, z0, cx, apexY, cz, u, v);
    this.setColor(color, FACE_SHADE.px);
    this.tri(x1, y0, z1, x1, y0, z0, cx, apexY, cz, u, v);
    this.setColor(color, FACE_SHADE.nx);
    this.tri(x0, y0, z0, x0, y0, z1, cx, apexY, cz, u, v);
  }

  /**
   * Plain box with the FACE_SHADE ambient baked in (a lit top, mid south / east flanks, dark north / west ones) and no
   * bottom: the rooftop kit and the crown plant rooms are small boxes on a skyline, and without it they are the flat
   * pastel cubes the critic saw. Five quads, the same as boxPlain.
   */
  litBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): void {
    this.setColor(color, FACE_SHADE.top);
    this.boxFacesRaw(x0, y0, z0, x1, y1, z1, FACE.top);
    this.setColor(color, FACE_SHADE.pz);
    this.boxFacesRaw(x0, y0, z0, x1, y1, z1, FACE.pz);
    this.setColor(color, FACE_SHADE.px);
    this.boxFacesRaw(x0, y0, z0, x1, y1, z1, FACE.px);
    this.setColor(color, FACE_SHADE.nz);
    this.boxFacesRaw(x0, y0, z0, x1, y1, z1, FACE.nz);
    this.setColor(color, FACE_SHADE.nx);
    this.boxFacesRaw(x0, y0, z0, x1, y1, z1, FACE.nx);
  }

  /** boxFaces without the setColor: emits the masked faces in whatever colour is current. */
  private boxFacesRaw(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mask: number): void {
    const u = 0.25, v = ROOF_V;
    if (mask & FACE.pz) this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, u, v, u, v, u, v, u, v);
    if (mask & FACE.nz) this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, u, v, u, v, u, v, u, v);
    if (mask & FACE.px) this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, u, v, u, v, u, v, u, v);
    if (mask & FACE.nx) this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, u, v, u, v, u, v, u, v);
    if (mask & FACE.top) this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, u, v, u, v, u, v, u, v);
    if (mask & FACE.bot) this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, u, v, u, v, u, v, u, v);
  }

  /** Elliptical cylinder (rx along X, rz along Z); sides with meter UVs (windows) or plain, optional top cap. */
  cylinder(cx: number, cz: number, rx: number, rz: number, y0: number, y1: number, segments: number, color: number, windows: boolean, top: number | null, glow: number = GLOW_U.none, phase = 0): void {
    const { b, u, v } = this.plainTarget(glow);
    const circ = Math.PI * (rx + rz);
    b.setColor(color);
    for (let i = 0; i < segments; i++) {
      const a0 = phase + (i / segments) * Math.PI * 2, a1 = phase + ((i + 1) / segments) * Math.PI * 2;
      const ax = cx + Math.cos(a0) * rx, az = cz + Math.sin(a0) * rz, bx = cx + Math.cos(a1) * rx, bz = cz + Math.sin(a1) * rz;
      const am = (a0 + a1) / 2;
      let nx = Math.cos(am) / rx, nz = Math.sin(am) / rz;
      const nl = Math.sqrt(nx * nx + nz * nz) || 1;
      nx /= nl; nz /= nl;
      const ua = windows ? (i / segments) * circ / WINDOW_TILE_W : u, ub = windows ? ((i + 1) / segments) * circ / WINDOW_TILE_W : u;
      const va = windows ? y0 / WINDOW_TILE_H : v, vb = windows ? y1 / WINDOW_TILE_H : v;
      // Plain drums (tanks, crown rings) take the same baked ambient as the boxes; a windowed shaft keeps its tile.
      if (!windows && glow === GLOW_U.none) b.setColor(color, dirShade(Math.cos(am), Math.sin(am)));
      b.quad(bx, y0, bz, ax, y0, az, ax, y1, az, bx, y1, bz, nx, 0, nz, ua, va, ub, va, ub, vb, ua, vb);
    }
    if (top !== null) {
      b.setColor(top);
      for (let i = 0; i < segments; i++) {
        const a0 = phase + (i / segments) * Math.PI * 2, a1 = phase + ((i + 1) / segments) * Math.PI * 2;
        // Fan wound so the cap faces +Y: a tank, a drum gallery or a fountain basin is looked down on, and the
        // other winding made every one of them an open tube.
        b.tri(cx, y1, cz, cx + Math.cos(a1) * rx, y1, cz + Math.sin(a1) * rz, cx + Math.cos(a0) * rx, y1, cz + Math.sin(a0) * rz, u, v);
      }
    }
  }

  /** Ring in the YZ plane (axis X) centered at (cx, cy, cz), square tube cross-section. */
  ring(cx: number, cy: number, cz: number, radius: number, tube: number, segments: number, color: number, glow: number = GLOW_U.none): void {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
      const y0 = cy + Math.cos(a0) * radius, z0 = cz + Math.sin(a0) * radius, y1 = cy + Math.cos(a1) * radius, z1 = cz + Math.sin(a1) * radius;
      this.bar(cx, y0, z0, cx, y1, z1, tube, color, glow);
    }
  }

  /** Square-section bar between two points (approximate: axis-aligned thickness in the two perpendicular world axes). */
  bar(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, color: number, glow: number = GLOW_U.none): void {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const ux = dx / l, uy = dy / l, uz = dz / l;
    // Perpendicular vectors.
    let px = 0, py = 0, pz = 0;
    if (Math.abs(ux) < 0.9) { px = 0; py = -uz; pz = uy; } else { px = -uz; py = 0; pz = ux; }
    const pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
    px /= pl; py /= pl; pz /= pl;
    const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
    const h = t / 2;
    const { b, u, v } = this.plainTarget(glow);
    b.setColor(color);
    const c = (sx: number, sy: number, end: number): [number, number, number] => {
      const ox = ax + ux * l * end, oy = ay + uy * l * end, oz = az + uz * l * end;
      return [ox + px * h * sx + qx * h * sy, oy + py * h * sx + qy * h * sy, oz + pz * h * sx + qz * h * sy];
    };
    const faces: [number, number, number, number][] = [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]];
    for (let f = 0; f < 4; f++) {
      const [s0x, s0y, s1x, s1y] = faces[f];
      const A = c(s0x, s0y, 0), B = c(s1x, s1y, 0), C = c(s1x, s1y, 1), D = c(s0x, s0y, 1);
      const nx = px * (s0x + s1x) / 2 + qx * (s0y + s1y) / 2, ny = py * (s0x + s1x) / 2 + qy * (s0y + s1y) / 2, nz = pz * (s0x + s1x) / 2 + qz * (s0y + s1y) / 2;
      b.quad(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2], nx, ny, nz, u, v, u, v, u, v, u, v);
    }
  }


  /** Flat polygon cap over an outline at height y: a quad for a rect, a fan otherwise; `up` picks the facing (+Y / -Y). */
  polyCap(ol: Outline, y: number, color: number, up: boolean): void {
    const u = 0.5, v = ROOF_V;
    this.setColor(color);
    if (ol.n === 4) {
      if (up) this.quad(ol.x[0], y, ol.z[0], ol.x[1], y, ol.z[1], ol.x[2], y, ol.z[2], ol.x[3], y, ol.z[3], 0, 1, 0, u, v, u, v, u, v, u, v);
      else this.quad(ol.x[3], y, ol.z[3], ol.x[2], y, ol.z[2], ol.x[1], y, ol.z[1], ol.x[0], y, ol.z[0], 0, -1, 0, u, v, u, v, u, v, u, v);
      return;
    }
    for (let i = 1; i < ol.n - 1; i++) {
      if (up) this.tri(ol.x[0], y, ol.z[0], ol.x[i], y, ol.z[i], ol.x[i + 1], y, ol.z[i + 1], u, v);
      else this.tri(ol.x[0], y, ol.z[0], ol.x[i + 1], y, ol.z[i + 1], ol.x[i], y, ol.z[i], u, v);
    }
  }

  /**
   * Flat roof deck over an outline: the same quad / fan as polyCap, but mapped across the tile's felt-roll band
   * (ROOF_SEAM_U) along the deck's longer plan axis, so a roof shows roll seams and gravel tone instead of one flat
   * fill. Ten seams span the band, i.e. 1-4 m apart on the roofs this city has.
   */
  roofCap(ol: Outline, y: number, color: number): void {
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (let i = 0; i < ol.n; i++) { bx0 = Math.min(bx0, ol.x[i]); bx1 = Math.max(bx1, ol.x[i]); bz0 = Math.min(bz0, ol.z[i]); bz1 = Math.max(bz1, ol.z[i]); }
    const alongX = bx1 - bx0 >= bz1 - bz0;
    const a0 = alongX ? bx0 : bz0, span = Math.max(1e-3, alongX ? bx1 - bx0 : bz1 - bz0);
    const U = (i: number): number => ROOF_SEAM_U.u0 + (((alongX ? ol.x[i] : ol.z[i]) - a0) / span) * (ROOF_SEAM_U.u1 - ROOF_SEAM_U.u0);
    const v = ROOF_V;
    this.setColor(color);
    if (ol.n === 4) {
      this.quad(ol.x[0], y, ol.z[0], ol.x[1], y, ol.z[1], ol.x[2], y, ol.z[2], ol.x[3], y, ol.z[3], 0, 1, 0, U(0), v, U(1), v, U(2), v, U(3), v);
      return;
    }
    for (let i = 1; i < ol.n - 1; i++) {
      const a = this.vertex(ol.x[0], y, ol.z[0], 0, 1, 0, U(0), v);
      this.vertex(ol.x[i], y, ol.z[i], 0, 1, 0, U(i), v);
      this.vertex(ol.x[i + 1], y, ol.z[i + 1], 0, 1, 0, U(i + 1), v);
      this.idx.push(a, a + 1, a + 2);
    }
  }

  /**
   * Vertical wall around an outline between y0 and y1 (plain UV): one outward quad per edge, the vertices shaded from
   * `kBot` at y0 to `kTop` at y1. The ramp is how a parapet gets the occlusion of the coping that oversails it without
   * a single extra quad; with kBot = kTop = 1 this is the plain wall.
   */
  private polySides(ol: Outline, y0: number, y1: number, color = -1, kBot = 1, kTop = 1): void {
    const u = 0.25, v = ROOF_V;
    const ramp = color >= 0 && kBot !== kTop;
    for (let i = 0; i < ol.n; i++) {
      const j = (i + 1) % ol.n;
      const nx = -(ol.z[j] - ol.z[i]), nz = ol.x[j] - ol.x[i], l = Math.hypot(nx, nz) || 1;
      if (!ramp) {
        this.quad(ol.x[i], y0, ol.z[i], ol.x[j], y0, ol.z[j], ol.x[j], y1, ol.z[j], ol.x[i], y1, ol.z[i], nx / l, 0, nz / l, u, v, u, v, u, v, u, v);
        continue;
      }
      this.setColor(color, kBot);
      const a = this.vertex(ol.x[i], y0, ol.z[i], nx / l, 0, nz / l, u, v);
      this.vertex(ol.x[j], y0, ol.z[j], nx / l, 0, nz / l, u, v);
      this.setColor(color, kTop);
      this.vertex(ol.x[j], y1, ol.z[j], nx / l, 0, nz / l, u, v);
      this.vertex(ol.x[i], y1, ol.z[i], nx / l, 0, nz / l, u, v);
      this.idx.push(a, a + 1, a + 2, a, a + 2, a + 3);
    }
    if (ramp) this.setColor(color);
  }

  /** Plain prism over an outline: sides, optionally the top and the bottom cap. */
  prism(ol: Outline, y0: number, y1: number, color: number, top: boolean, bottom: boolean): void {
    this.setColor(color);
    this.polySides(ol, y0, y1);
    if (top) this.polyCap(ol, y1, color, true);
    if (bottom) this.polyCap(ol, y0, color, false);
  }

  /**
   * Two-step cornice around an outline (the polygon twin of `cornice`): a fillet `out0` proud and `h0` tall under a
   * crown slab `out1` proud and `h1` tall whose underside is the visible soffit; outer faces, the soffit ring and the
   * top only. 3 quads per edge plus the cap.
   */
  corniceOutline(ol: Outline, top: number, out0: number, h0: number, out1: number, h1: number, color: number): void {
    const u = 0.25, v = ROOF_V;
    const yb = top - h0 - h1, ym = top - h1;
    const A = ol.offset(out0, olC), B = ol.offset(out1, olD);
    // The fillet stands under the crown slab's oversail, so it is in shadow, and the shadow is deepest right under
    // the soffit: ramped from CORNICE_LIT at its foot to CORNICE_SHADE at its head, which puts a real dark line along
    // the roof edge for no extra quads. The shadow map cannot draw it at any bias worth using over a 0.2 m oversail,
    // and without it the cornice read as a painted pale stripe with no depth at all.
    this.polySides(A, yb, ym, darken(color, 0.92), CORNICE_LIT, CORNICE_SHADE);
    this.setColor(darken(color, CORNICE_SOFFIT));
    for (let i = 0; i < ol.n; i++) {
      const j = (i + 1) % ol.n;
      this.quad(B.x[i], ym, B.z[i], A.x[i], ym, A.z[i], A.x[j], ym, A.z[j], B.x[j], ym, B.z[j], 0, -1, 0, u, v, u, v, u, v, u, v);
    }
    this.setColor(color);
    this.polySides(B, ym, top);
    // Top ledge as a RING from the slab's outer edge in to the wall line, never a full cap. A full cap laid a pale
    // slab of the cornice colour over the whole roof deck 2 cm beneath it: up close the deck won the depth test and
    // the cap was invisible, but at 150 m the two coplanar caps fought and the roof read as a flat pale lid of the
    // wall tint - the single loudest "pile of pastel boxes" cue in the skyline.
    for (let i = 0; i < ol.n; i++) {
      const j = (i + 1) % ol.n;
      this.quad(B.x[j], top, B.z[j], ol.x[j], top, ol.z[j], ol.x[i], top, ol.z[i], B.x[i], top, B.z[i], 0, 1, 0, u, v, u, v, u, v, u, v);
    }
  }

  /**
   * Hollow wall following an outline (the polygon twin of `frame`): outer faces, inner faces `t` in and the top ring;
   * `inner` false drops the inner faces (a coping seen from the street only).
   */
  frameOutline(ol: Outline, y0: number, y1: number, t: number, color: number, inner = true, kBot = 1, kTop = 1): void {
    const u = 0.25, v = ROOF_V;
    const I = ol.offset(-t, olC);
    this.setColor(color);
    this.polySides(ol, y0, y1, color, kBot, kTop);
    for (let i = 0; i < ol.n; i++) {
      const j = (i + 1) % ol.n;
      if (inner) {
        const nx = (I.z[j] - I.z[i]), nz = -(I.x[j] - I.x[i]), l = Math.hypot(nx, nz) || 1;
        this.quad(I.x[j], y0, I.z[j], I.x[i], y0, I.z[i], I.x[i], y1, I.z[i], I.x[j], y1, I.z[j], nx / l, 0, nz / l, u, v, u, v, u, v, u, v);
      }
      this.quad(ol.x[i], y1, ol.z[i], ol.x[j], y1, ol.z[j], I.x[j], y1, I.z[j], I.x[i], y1, I.z[i], 0, 1, 0, u, v, u, v, u, v, u, v);
    }
  }

  get vertexCount(): number { return this.pos.length / 3; }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function darken(color: number, k: number): number {
  tmpColor.setHex(color).multiplyScalar(k);
  return tmpColor.getHex();
}

/** Walls are multiplied by the window albedo (~0.7 avg), so lift the palette color toward white first. */
function lighten(color: number, k: number): number {
  tmpColor.setHex(color);
  tmpColor.r += (1 - tmpColor.r) * k; tmpColor.g += (1 - tmpColor.g) * k; tmpColor.b += (1 - tmpColor.b) * k;
  return tmpColor.getHex();
}

/** Linear blend from `a` (k = 0) to `b` (k = 1). */
function mix(a: number, b: number, k: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((((ar + (br - ar) * k) | 0) << 16) | (((ag + (bg - ag) * k) | 0) << 8) | ((ab + (bb - ab) * k) | 0));
}

/**
 * Roof deck colour. A roof is felt, bitumen sheet or gravel, never the wall render: darkening the wall tint left every
 * flat top a pale slab of the building's own pastel, which from 60 m turned the skyline into a heap of tinted boxes.
 * Each deck keeps ROOF_TINT_KEEP of its building's hue over a bitumen grey, so roofs still differ from each other
 * without ever reading as wall.
 */
const ROOF_GREY = 0x55565a, ROOF_TINT_KEEP = 0.2;
function roofTint(base: number): number { return mix(ROOF_GREY, darken(base, ROOF_DARKEN), ROOF_TINT_KEEP); }

/**
 * Massing of one building, decided from its id so the render is deterministic and the same plan feeds the base
 * geometry (appendBuilding) and the dressing (appendBuildingDetail). Downtown towers cycle four silhouettes; low
 * buildings vary their roofline; stepped roofs alternate concentric tiers and a one-sided setback. The window grid
 * (tw x th metres per texture tile) is part of the massing: most buildings use the 16 x 28 m tile, downtown towers
 * cycle a slender 12 m tile (3 m cells), a wide 20 m one and, on curtain walls, a 56 m tall one whose rows span two
 * storeys, so the skyline stops sharing one window rhythm.
 */
export interface Massing {
  kind: 'box' | 'tiers' | 'setback' | 'octagon' | 'podium' | 'twin';
  /** Topmost box tier (roof clutter, parapet band and crown live here); the octagon's top rect is its bounding box. */
  tx0: number; tz0: number; tx1: number; tz1: number; top: number;
  /** Height up to which the full-footprint walls stand: facade dressing (ledges, fins, sign panels) must stay below. */
  wallTop: number;
  /** Height of the intermediate roof (setback terrace / podium top), 0 when there is none. */
  stepY: number;
  /** Low-building roofline variant: 0 plain, 1 raised street-side wing, 2 penthouse box. */
  roofVariant: number;
  /** Window texture tile size in metres (u = s / tw, v = y / th) and the cell grid it implies. */
  tw: number; th: number; bayW: number; rowH: number;
}
/** Window-tile widths / heights a low-rise building picks from (16 x 28 stays the most common). */
const LOW_TW = [12, 14, 16, 16, 20] as const;
const LOW_TH = [24, 28, 28, 32] as const;
const massingOut: Massing = { kind: 'box', tx0: 0, tz0: 0, tx1: 0, tz1: 0, top: 0, wallTop: 0, stepY: 0, roofVariant: 0, tw: WINDOW_TILE_W, th: WINDOW_TILE_H, bayW: WINDOW_TILE_W / 4, rowH: ROW_V * WINDOW_TILE_H };

/** Fills `massingOut` for the building (shared scratch: copy the fields you need before calling it again). */
export function massingOf(b: Building): Massing {
  const m = massingOut;
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  m.tx0 = x0; m.tz0 = z0; m.tx1 = x1; m.tz1 = z1; m.top = b.h; m.wallTop = b.h; m.stepY = 0; m.roofVariant = 0;
  m.tw = WINDOW_TILE_W; m.th = WINDOW_TILE_H;
  const tower = b.district === 'downtown' && b.h > 40 && b.roofKind === 'flat';
  if (tower) {
    const rhythm = (b.id >> 2) % 3;
    if (rhythm === 1) { if (b.style === 'glass' || b.style === 'neon') m.th = 2 * WINDOW_TILE_H; else m.tw = 20; }
    else if (rhythm === 2) m.tw = 12;
  } else {
    // Low-rise grids vary too. Every block using the same 4 m bay and the same 3.43 m storey is what turns a mid-
    // distance street into one repeated box: these give 3.0-5.0 m bays and 2.9-3.9 m storeys, all whole tiles, so the
    // painted cells, the built window units and the floor slabs still line up exactly.
    const g = hashU(b.id * 23 + 5);
    m.tw = LOW_TW[g % LOW_TW.length];
    m.th = LOW_TH[(g >>> 3) % LOW_TH.length];
  }
  m.bayW = m.tw / 4; m.rowH = ROW_V * m.th;
  if (b.roofKind === 'stepped' && b.h > 9) {
    if (b.id % 2 === 1) {
      m.kind = 'setback';
      let yS = Math.round((0.75 * b.h) / FLOOR_H) * FLOOR_H + 0.2;
      if (yS > b.h - 3.4) yS -= FLOOR_H;
      m.stepY = yS; m.wallTop = yS;
      const back = Math.max(3, (b.facing === 0 || b.facing === 2 ? b.d : b.w) * 0.28);
      if (b.facing === 0) m.tz1 = z1 - back; else if (b.facing === 2) m.tz0 = z0 + back; else if (b.facing === 1) m.tx1 = x1 - back; else m.tx0 = x0 + back;
    } else {
      m.kind = 'tiers';
      const inset = Math.min(b.w, b.d) * 0.14 * (TIERS - 1);
      m.tx0 = x0 + inset; m.tx1 = x1 - inset; m.tz0 = z0 + inset; m.tz1 = z1 - inset;
    }
    return m;
  }
  if (tower) {
    const tv = b.id % 4;
    if (tv === 1) { m.kind = 'octagon'; m.stepY = PODIUM_H; m.wallTop = PODIUM_H; return m; }
    if (tv === 2) {
      m.kind = 'podium'; m.stepY = PODIUM_H; m.wallTop = PODIUM_H;
      const alongX = b.facing === 0 || b.facing === 2;
      const along = alongX ? b.w : b.d;
      const tw = Math.max(8, Math.round((along * 0.65) / 4) * 4);
      const left = (b.id >> 2) % 2 === 0;
      if (alongX) { if (left) m.tx1 = x0 + tw; else m.tx0 = x1 - tw; } else if (left) m.tz1 = z0 + tw; else m.tz0 = z1 - tw;
      return m;
    }
    if (tv === 3) {
      // Twin street-side setbacks stacked above the box: two extra tiers, each pulled back from the street.
      m.kind = 'twin'; m.top = b.h + 2 * FLOOR_H * 2; m.stepY = b.h;
      twinRect(b, 2, m);
      return m;
    }
    m.kind = 'box';
    return m;
  }
  m.kind = 'box';
  if (b.roofKind === 'flat') {
    const v = (b.id * 7) % 5;
    m.roofVariant = v < 2 ? 1 : v === 2 ? 2 : 0;
  }
  return m;
}

/** Rect of twin-setback tier `n` (1 or 2) written into m.tx0..tz1: recessed from the street and both sides. */
function twinRect(b: Building, n: number, m: Massing): void {
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  const back = (b.facing === 0 || b.facing === 2 ? b.d : b.w) * 0.22 * n;
  const side = (b.facing === 0 || b.facing === 2 ? b.w : b.d) * 0.09 * n;
  if (b.facing === 0 || b.facing === 2) { m.tx0 = x0 + side; m.tx1 = x1 - side; m.tz0 = z0; m.tz1 = z1; if (b.facing === 0) m.tz1 = z1 - back; else m.tz0 = z0 + back; }
  else { m.tz0 = z0 + side; m.tz1 = z1 - side; m.tx0 = x0; m.tx1 = x1; if (b.facing === 1) m.tx1 = x1 - back; else m.tx0 = x0 + back; }
}

/** Whether a tower gets a crown: chamfered top, cornice at its foot, plant room and mast (spires keep their pyramid). */
export function hasCrown(b: Building, top: number): boolean { return top > CROWN_MIN_H && b.roofKind !== 'spire'; }

/** Whether a building's street faces get plan jogs, recessed bays and floor slabs (the punched-window low-rise styles). */
function reliefStyle(b: Building): boolean {
  return b.district !== 'downtown' && (b.style === 'residential' || b.style === 'artdeco' || b.style === 'concrete');
}

/**
 * Footprint of the building's base box: its rect, with the street corners of a residential / art deco building cut at
 * 45 degrees (2.2-3 m, seven corners in ten) when both faces meeting there are long enough and no upper tier sits on
 * the corner. `mask` = FACE_BIT bits of the faces that see a street; `m` is the building's massing (read before the
 * shared scratch is reused).
 */
export function footprint(b: Building, mask: number, m: Massing, out: Outline): Outline {
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  const eligible = b.district !== 'downtown' && (b.style === 'residential' || b.style === 'artdeco')
    && ((m.kind === 'box' && m.roofVariant === 0) || m.kind === 'setback' || m.kind === 'tiers');
  if (!eligible || mask === 0) return out.set(x0, z0, x1, z1);
  const c = [0, 0, 0, 0];
  const px = [x0, x1, x1, x0], pz = [z1, z1, z0, z0];
  for (let k = 0; k < 4; k++) {
    const j = (k + 3) % 4;
    if (((mask >> j) & 1) === 0 || ((mask >> k) & 1) === 0) continue;
    const lenJ = j === 0 || j === 2 ? b.w : b.d, lenK = k === 0 || k === 2 ? b.w : b.d;
    if (lenJ < 12 || lenK < 12) continue;
    if (hashU(b.id * 9 + k) % 10 >= 7) continue;
    // A setback's upper box stands on the back corners: leave those square.
    if (m.kind === 'setback' && (Math.abs(px[k] - m.tx0) < 1e-6 || Math.abs(px[k] - m.tx1) < 1e-6) && (Math.abs(pz[k] - m.tz0) < 1e-6 || Math.abs(pz[k] - m.tz1) < 1e-6)) continue;
    c[k] = CHAMFER_MIN + CHAMFER_VAR * hash01(b.id * 9 + k + 40);
  }
  return out.set(x0, z0, x1, z1, c[0], c[1], c[2], c[3]);
}

/**
 * Plan of one wall along its face: pieces (whole window bays or groups of them) with a depth each (0 = the wall
 * plane, negative = stepped back), grouped into tint / UV segments. `segS` are the segment boundaries, `segDepth`
 * the jog of each segment (0 or -0.7..-1.0 on a long street face, alternating, the end segments always flush so the
 * corners and the cornice stay intact); a recessed bay (BAY_RECESS) is its own piece inside a flush segment.
 */
interface FaceLayout { n: number; s: Float64Array; depth: Float64Array; seg: Int8Array; nSeg: number; segS: Float64Array; segDepth: Float64Array; segTint: Int8Array; nTint: number }
const layoutScratch: FaceLayout = { n: 0, s: new Float64Array(40), depth: new Float64Array(40), seg: new Int8Array(40), nSeg: 0, segS: new Float64Array(12), segDepth: new Float64Array(12), segTint: new Int8Array(12), nTint: 1 };
function layoutFace(len: number, bayW: number, key: number, jog: boolean, recess: boolean, out: FaceLayout = layoutScratch): FaceLayout {
  // Segments at whole bays.
  let nSeg = len > SEG_MIN ? Math.min(10, Math.max(2, Math.round(len / WALL_SEG_LEN))) : 1;
  out.segS[0] = 0;
  let k = 1;
  for (let i = 1; i < nSeg; i++) {
    const s = Math.min(len, Math.round((((i * len) / nSeg)) / bayW) * bayW);
    if (s > out.segS[k - 1] + bayW - 1e-6 && s < len - bayW + 1e-6) out.segS[k++] = s;
  }
  out.segS[k] = len;
  nSeg = k;
  out.nSeg = nSeg;
  const jogParity = hashU(key * 5 + 1) % 2;
  for (let i = 0; i < nSeg; i++) {
    out.segDepth[i] = 0;
    if (jog && nSeg >= 3 && i > 0 && i < nSeg - 1 && (i + jogParity) % 2 === 1) out.segDepth[i] = -(0.7 + 0.3 * hash01(key * 7 + i));
  }
  // Tint groups. Segments exist to break the window rhythm, and their UV offsets may change at any boundary (the
  // cells stay on the bay grid, so nothing moves), but the WALL TINT may only change where the plan actually steps:
  // a tone step across a flat wall reads as a rendering seam, the same step on the reveal of a jog reads as two
  // blocks built at different times. Flush neighbours therefore share one tint group.
  let tg = 0;
  for (let i = 0; i < nSeg; i++) {
    if (i > 0 && Math.abs(out.segDepth[i] - out.segDepth[i - 1]) > 1e-6) tg++;
    out.segTint[i] = tg;
  }
  out.nTint = tg + 1;
  // Pieces: walk the bays, cutting at segment boundaries and around recessed bays.
  const nBays = Math.floor(len / bayW + 1e-6);
  const phase = hashU(key * 11 + 3) % 3;
  let n = 0, s0 = 0, seg = 0;
  out.s[0] = 0;
  const push = (s1: number, depth: number): void => {
    if (s1 <= s0 + 1e-6) return;
    out.s[n + 1] = s1; out.depth[n] = depth; out.seg[n] = seg; n++; s0 = s1;
  };
  for (let c = 0; c < nBays && n < 38; c++) {
    const a = c * bayW, e = Math.min(len, (c + 1) * bayW);
    while (seg < nSeg - 1 && out.segS[seg + 1] <= a + 1e-6) seg++;
    const inSeg = e <= out.segS[seg + 1] + 1e-6;
    const rec = recess && c > 0 && c < nBays - 1 && inSeg && out.segDepth[seg] === 0 && (c + phase) % 3 === 0;
    if (rec) { push(a, 0); push(e, -BAY_RECESS); }
    else if (seg < nSeg - 1 && Math.abs(out.segS[seg + 1] - e) < 1e-6) push(e, out.segDepth[seg]);
  }
  push(len, out.segDepth[nSeg - 1]);
  out.n = n;
  return out;
}

/**
 * Vertical bands of a wall between y0 and y1: BAND_ROWS rows each on walls taller than ~5 rows, split at row lines.
 * Each band gets its own whole-row v offset `kv` (v = (y + kv * rowH) / th), chosen so the band stays inside the
 * window rows of one tile (never crossing the plain roof strip), which keeps the sills of every band on the same
 * y = m * rowH lines while the cell contents differ.
 */
interface BandRows { n: number; y: Float64Array; kv: Int32Array }
const bandScratch: BandRows = { n: 0, y: new Float64Array(40), kv: new Int32Array(40) };
function bandRows(y0: number, y1: number, rowH: number, th: number, key: number, out: BandRows = bandScratch): BandRows {
  let n = 0;
  out.y[0] = y0;
  if (y1 - y0 > (BAND_ROWS + 1.5) * rowH) {
    for (let y = (Math.ceil(y0 / rowH - 1e-6) + BAND_ROWS) * rowH; y < y1 - 1.5 * rowH && n < 38; y += BAND_ROWS * rowH) out.y[++n] = y;
  }
  out.y[++n] = y1;
  out.n = n;
  for (let j = 0; j < n; j++) {
    const ya = out.y[j], yb = out.y[j + 1];
    let lo = Math.ceil((-ya - 0.02 * th) / rowH - 1e-6);
    const hi = Math.floor((ROWS_V_TOP * th - yb) / rowH + 1e-6);
    // The tile's ground row (big shop-like panes, lit at night) only ever lands on the ground: a band that starts
    // above the first floor line stays off it, otherwise the top floor of a tower came out with stretched cells.
    if (ya > 0.6 * rowH) lo = Math.max(lo, Math.ceil(1 - ya / rowH - 1e-6));
    let kv = lo;
    if (hi > lo) {
      const h = hashU(key * 13 + j * 3 + 7);
      // The bottom band keeps the tile's ground row on the ground half the time (its big panes suit a street).
      kv = j === 0 && lo <= 0 && h % 2 === 0 ? 0 : lo + (h % (hi - lo + 1));
    }
    out.kv[j] = kv;
  }
  return out;
}

const FACADE_MAX_LEN = 4096;
/**
 * Windowed walls around an outline from y0 to y1 plus the flat roof cap: every edge is laid out into segments and
 * pieces (layoutFace) and vertical bands (bandRows); each piece x band is one quad whose cells come from a hashed
 * whole-cell / whole-row offset of the tile, so no two segments show the same run of windows. Pieces stepped back
 * from the wall plane (jogs, recessed bays) get dark reveal faces where the depth changes and a soffit under the
 * roof edge. `jog` / `recess` enable those on the street faces in `mask`; chamfer edges are always one flat piece.
 */
function facade(gb: GeoBuilder, b: Building, ol: Outline, y0: number, y1: number, wall: number, roof: number, m: Massing, mask: number, jog: boolean, recess: boolean): void {
  const tw = m.tw, th = m.th, rowH = m.rowH, bayW = m.bayW;
  const reveal = darken(wall, 0.72), soffit = darken(wall, 0.6);
  for (let i = 0; i < ol.n; i++) {
    const fr = ol.edge(i);
    if (fr.len < 0.5 || fr.len > FACADE_MAX_LEN) continue;
    const f = ol.face[i];
    const street = ol.streetEdge(i, mask);
    const key = b.id * 8 + i;
    const lay = f >= 0 ? layoutFace(fr.len, bayW, key, jog && street && fr.len > LONG_FACE, recess && street) : layoutFace(fr.len, fr.len, key, false, false);
    const bands = bandRows(y0, y1, rowH, th, key);
    const P = (s: number, o: number, y: number, out: number[]): number[] => { out[0] = fr.sx + fr.tx * s + fr.nx * o; out[1] = y; out[2] = fr.sz + fr.tz * s + fr.nz * o; return out; };
    const a = [0, 0, 0], c = [0, 0, 0], d = [0, 0, 0], e = [0, 0, 0];
    for (let p = 0; p < lay.n; p++) {
      const s0 = lay.s[p], s1 = lay.s[p + 1], dep = lay.depth[p], seg = lay.seg[p];
      const tg = lay.segTint[seg];
      const col = lay.nTint === 1 ? wall : perturb(wall, (hash01(key * 31 + tg) - 0.5) * (8 / 360), (hash01(key * 37 + tg) - 0.5) * 0.1);
      gb.setColor(col);
      for (let j = 0; j < bands.n; j++) {
        const ya = bands.y[j], yb = bands.y[j + 1], kv = bands.kv[j];
        const uc = hashU(key * 17 + seg * 5 + j * 3) % 4;
        const u0 = uc / 4 + s0 / tw, u1 = uc / 4 + s1 / tw, v0 = (ya + kv * rowH) / th, v1 = (yb + kv * rowH) / th;
        P(s0, dep, ya, a); P(s1, dep, ya, c); P(s1, dep, yb, d); P(s0, dep, yb, e);
        gb.quad(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], e[0], e[1], e[2], fr.nx, 0, fr.nz, u0, v0, u1, v0, u1, v1, u0, v1);
      }
    }
    // Reveals where the depth steps, soffits over the stepped-back pieces (the roof cap spans the full outline).
    for (let p = 1; p < lay.n; p++) {
      const dA = lay.depth[p - 1], dB = lay.depth[p];
      if (Math.abs(dA - dB) < 1e-6) continue;
      const s = lay.s[p], dIn = Math.min(dA, dB), dOut = Math.max(dA, dB);
      gb.setColor(reveal);
      if (dA > dB) { P(s, dOut, y0, a); P(s, dIn, y0, c); P(s, dIn, y1, d); P(s, dOut, y1, e); }
      else { P(s, dIn, y0, a); P(s, dOut, y0, c); P(s, dOut, y1, d); P(s, dIn, y1, e); }
      gb.texQuad(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], e[0], e[1], e[2], 0.25, ROOF_V, 0.25, ROOF_V, 0.25, ROOF_V, 0.25, ROOF_V);
    }
    for (let p = 0; p < lay.n; p++) {
      const dep = lay.depth[p];
      if (dep >= 0) continue;
      const s0 = lay.s[p], s1 = lay.s[p + 1];
      gb.setColor(soffit);
      P(s0, 0.2, y1, a); P(s0, dep, y1, c); P(s1, dep, y1, d); P(s1, 0.2, y1, e);
      gb.texQuad(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], e[0], e[1], e[2], 0.25, ROOF_V, 0.25, ROOF_V, 0.25, ROOF_V, 0.25, ROOF_V);
    }
  }
  gb.roofCap(ol, y1, roof);
}

/**
 * Appends the building to a builder (box / stepped tiers / one-sided setback / podium variants / box + spire) at world
 * coordinates. `y0` is where the full-footprint walls start: BASE_Y normally, the arcade ceiling for a shopfront
 * building whose ground floor is recessed behind columns (appendStreetLevel). `streetMask` = FACE_BIT bits of the
 * faces that see a street: those get the plan jogs, recessed bays and corner chamfers (footprint). Crown towers stop
 * CHAMFER_H short of the top so appendBuildingDetail can cut the corners.
 */
export function appendBuilding(gb: GeoBuilder, b: Building, y0 = BASE_Y, streetMask = 0): void {
  const base = buildingTint(b);
  const roof = roofTint(base);
  const wall = lighten(base, WALL_LIGHTEN);
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  const m = massingOf(b);
  const ol = footprint(b, streetMask, m, olA);
  const topY = hasCrown(b, m.top) ? b.h - CHAMFER_H : b.h;
  const relief = reliefStyle(b);
  const recess = b.style === 'residential' || b.style === 'artdeco';
  if (m.kind === 'tiers') {
    const fr = [0.65, 0.35];
    let y = y0;
    let inset = 0;
    for (let t = 0; t < TIERS; t++) {
      const y1 = t === TIERS - 1 ? topY : y + b.h * fr[t];
      if (t === 0) facade(gb, b, ol, y, y1, wall, roof, m, streetMask, relief, recess && relief);
      else facade(gb, b, olB.set(x0 + inset, z0 + inset, x1 - inset, z1 - inset), y, y1, wall, roof, m, 0, false, false);
      if (b.style === 'artdeco' && t < TIERS - 1) gb.corniceOutline(t === 0 ? ol : olB, y1, 0.15, 0.3, 0.4, 0.3, darken(wall, 0.85));
      y = y1;
      inset += Math.min(b.w, b.d) * 0.14;
    }
  } else if (m.kind === 'setback') {
    facade(gb, b, ol, y0, m.stepY, wall, roof, m, streetMask, relief, recess && relief);
    facade(gb, b, olB.set(m.tx0, m.tz0, m.tx1, m.tz1), m.stepY, topY, wall, roof, m, 0, false, false);
    if (b.style === 'artdeco') gb.corniceOutline(ol, m.stepY, 0.15, 0.3, 0.4, 0.3, darken(wall, 0.85));
  } else if (m.kind === 'octagon') {
    facade(gb, b, ol, y0, PODIUM_H, wall, roof, m, streetMask, false, false);
    const rx = (b.w / 2 - 0.4) / Math.cos(OCT), rz = (b.d / 2 - 0.4) / Math.cos(OCT);
    gb.cylinder(b.x, b.z, rx, rz, PODIUM_H, topY, 8, wall, true, roof, GLOW_U.none, OCT);
  } else if (m.kind === 'podium') {
    facade(gb, b, ol, y0, PODIUM_H, wall, roof, m, streetMask, false, false);
    facade(gb, b, olB.set(m.tx0, m.tz0, m.tx1, m.tz1), PODIUM_H, topY, wall, roof, m, 0, false, false);
  } else {
    // Twin towers keep their full-height base box: the chamfer sits on the top tier built by the detail pass.
    facade(gb, b, ol, y0, m.kind === 'twin' ? b.h : topY, wall, roof, m, streetMask, relief, recess && relief);
    if (b.roofKind === 'spire') {
      const in2 = Math.min(b.w, b.d) * 0.2;
      gb.pyramid(x0 + in2, z0 + in2, x1 - in2, z1 - in2, b.h, b.h + Math.max(4, b.h * 0.18), darken(b.accent, 0.8));
    }
  }
}

export function buildingGeometry(b: Building): THREE.BufferGeometry {
  const gb = new GeoBuilder();
  appendBuilding(gb, b);
  return gb.build();
}

const WHITE = 0xffffff, RED = 0xe0202a, BLUE = 0x2050d8, WOOD = 0x9a7a52, DARK = 0x2a2c30, STEEL = 0xc8ccd4;

/** Builds a landmark as a list of parts (one mesh each); the ferris wheel returns an extra rotating part centered on its hub. */
export function landmarkGeometries(l: Landmark): LandmarkPart[] {
  const gb = new GeoBuilder();
  const parts: LandmarkPart[] = [];
  const x0 = l.x - l.w / 2, x1 = l.x + l.w / 2, z0 = l.z - l.d / 2, z1 = l.z + l.d / 2;
  const part = (style: LandmarkStyle): void => {
    parts.push({ geometry: gb.build(), style, rotating: false, hubX: 0, hubY: 0, hubZ: 0 });
    if (gb.glow) parts.push({ geometry: gb.glow.build(), style: 'glow', rotating: false, hubX: 0, hubY: 0, hubZ: 0 });
  };
  switch (l.kind) {
    case 'tower': {
      const col = lighten(0x5a6b80, 0.45), roof = 0x2c3a4a, accent = 0xff7a00;
      const h = l.h;
      gb.boxWindows(x0, BASE_Y, z0, x1, h * 0.55, z1, col, roof);
      gb.boxPlain(x0 - 0.6, h * 0.55 - 0.8, z0 - 0.6, x1 + 0.6, h * 0.55, z1 + 0.6, accent, false, GLOW_U.orange);
      const i1 = l.w * 0.12;
      gb.boxWindows(x0 + i1, h * 0.55, z0 + i1, x1 - i1, h * 0.8, z1 - i1, col, roof);
      gb.boxPlain(x0 + i1 - 0.6, h * 0.8 - 0.8, z0 + i1 - 0.6, x1 - i1 + 0.6, h * 0.8, z1 - i1 + 0.6, accent, false, GLOW_U.orange);
      const i2 = l.w * 0.25;
      gb.boxWindows(x0 + i2, h * 0.8, z0 + i2, x1 - i2, h * 0.94, z1 - i2, col, roof);
      const i3 = l.w * 0.34;
      gb.pyramid(x0 + i3, z0 + i3, x1 - i3, z1 - i3, h * 0.94, h + 10, accent);
      gb.bar(l.x, h + 8, l.z, l.x, h + 9.5, l.z, 2.4, 0xff2d95, GLOW_U.magenta);
      gb.bar(l.x, h + 8, l.z, l.x, h + 26, l.z, 0.8, STEEL);
      part('glass');
      break;
    }
    case 'arena': {
      const rx = l.w / 2, rz = l.d / 2;
      gb.cylinder(l.x, l.z, rx, rz, BASE_Y, l.h * 0.7, 32, 0xb8b0a8, true, null);
      gb.cylinder(l.x, l.z, rx * 0.92, rz * 0.92, l.h * 0.7, l.h, 32, 0xd8d0c8, false, 0x6a6470);
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const cx = l.x + Math.cos(a) * rx, cz = l.z + Math.sin(a) * rz;
        gb.bar(cx, BASE_Y, cz, l.x + Math.cos(a) * rx * 0.9, l.h + 2, l.z + Math.sin(a) * rz * 0.9, 1.6, 0xff7a00, GLOW_U.orange);
      }
      part('concrete');
      break;
    }
    case 'hospital': {
      gb.boxWindows(x0, BASE_Y, z0, x1, l.h, z1, 0xf4f4f0, 0xb0b0b0);
      const cw = l.w * 0.2, ct = 1.2;
      gb.boxPlain(l.x - cw / 2, l.h, l.z - ct, l.x + cw / 2, l.h + 1.5, l.z + ct, RED);
      gb.boxPlain(l.x - ct, l.h, l.z - cw / 2, l.x + ct, l.h + 1.5, l.z + cw / 2, RED);
      gb.boxPlain(l.x - 4, l.h * 0.55, z1, l.x + 4, l.h * 0.55 + 1.6, z1 + 0.3, RED, false, GLOW_U.magenta);
      gb.boxPlain(l.x - 0.8, l.h * 0.55 - 3.2, z1, l.x + 0.8, l.h * 0.55 + 4.8, z1 + 0.3, RED, false, GLOW_U.magenta);
      gb.boxPlain(x0 - 3, BASE_Y, z1 - 1, x1 + 3, 4, z1 + 6, 0xdcdcd8);
      part('concrete');
      break;
    }
    case 'police': {
      gb.boxWindows(x0, BASE_Y, z0, x1, l.h, z1, 0xd8dce4, 0x6a6e78);
      gb.boxPlain(x0 - 0.3, l.h * 0.45, z0 - 0.3, x1 + 0.3, l.h * 0.45 + 2.2, z1 + 0.3, BLUE, false, GLOW_U.cyan);
      gb.boxPlain(x0 - 0.3, l.h - 1.5, z0 - 0.3, x1 + 0.3, l.h, z1 + 0.3, BLUE);
      gb.bar(x1 - 3, l.h, z1 - 3, x1 - 3, l.h + 12, z1 - 3, 0.5, STEEL);
      part('concrete');
      break;
    }
    case 'lighthouse': {
      const r = 4.5, bands = 6;
      for (let i = 0; i < bands; i++) {
        const y0 = BASE_Y + (l.h * 0.85 * i) / bands, y1 = BASE_Y + (l.h * 0.85 * (i + 1)) / bands;
        const k = 1 - i * 0.06;
        gb.cylinder(l.x, l.z, r * k, r * k, y0, y1, 16, i % 2 === 0 ? WHITE : RED, false, null);
      }
      gb.cylinder(l.x, l.z, r * 0.8, r * 0.8, l.h * 0.85, l.h * 0.85 + 0.6, 16, DARK, false, DARK);
      gb.cylinder(l.x, l.z, r * 0.5, r * 0.5, l.h * 0.85 + 0.6, l.h, 12, 0xfff4c0, false, null, GLOW_U.yellow);
      gb.cylinder(l.x, l.z, r * 0.7, r * 0.7, l.h, l.h + 1.2, 12, RED, false, RED);
      gb.cylinder(l.x, l.z, r * 1.6, r * 1.6, BASE_Y, 1.2, 16, 0xc8c0b0, false, 0xd8d0c0);
      part('concrete');
      break;
    }
    case 'pier': {
      const deckY = l.h;
      gb.boxPlain(x0, deckY - 0.3, z0, x1, deckY, z1, WOOD);
      for (let i = 0; i < 6; i++) gb.boxPlain(x0, deckY - 0.02, z0 + i * (l.d / 6), x1, deckY + 0.02, z0 + i * (l.d / 6) + 0.12, 0x6a5238);
      for (let px = x0 + 4; px < x1; px += 8) {
        gb.bar(px, -3, z0 + 0.6, px, deckY + 1.1, z0 + 0.6, 0.5, 0x5a4230);
        gb.bar(px, -3, z1 - 0.6, px, deckY + 1.1, z1 - 0.6, 0.5, 0x5a4230);
      }
      gb.boxPlain(x0, deckY + 0.95, z0 + 0.4, x1, deckY + 1.1, z0 + 0.6, 0x8a6a48);
      gb.boxPlain(x0, deckY + 0.95, z1 - 0.6, x1, deckY + 1.1, z1 - 0.4, 0x8a6a48);
      gb.boxPlain(x1 - 12, deckY, l.z - 3, x1 - 4, deckY + 3.2, l.z + 3, 0xff7a00, false, GLOW_U.orange);
      gb.pyramid(x1 - 13, l.z - 4, x1 - 3, l.z + 4, deckY + 3.2, deckY + 5.5, 0xff2d95);
      part('concrete');
      break;
    }
    case 'ferris': {
      const R = l.d / 2 - 1, hubY = R + 3;
      gb.bar(l.x - 3, -3, l.z - 9, l.x - 0.5, hubY, l.z, 1.0, STEEL);
      gb.bar(l.x - 3, -3, l.z + 9, l.x - 0.5, hubY, l.z, 1.0, STEEL);
      gb.bar(l.x + 3, -3, l.z - 9, l.x + 0.5, hubY, l.z, 1.0, STEEL);
      gb.bar(l.x + 3, -3, l.z + 9, l.x + 0.5, hubY, l.z, 1.0, STEEL);
      gb.boxPlain(l.x - 6, -3, l.z - 12, l.x + 6, 1.4, l.z + 12, WOOD);
      part('concrete');
      const wheel = new GeoBuilder();
      wheel.ring(-1, 0, 0, R, 0.5, 24, 0xff2d95, GLOW_U.magenta);
      wheel.ring(1, 0, 0, R, 0.5, 24, 0xff2d95, GLOW_U.magenta);
      wheel.bar(-1.4, 0, 0, 1.4, 0, 0, 1.6, STEEL);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const y = Math.cos(a) * R, z = Math.sin(a) * R;
        wheel.bar(-1, 0, 0, -1, y, z, 0.3, STEEL);
        wheel.bar(1, 0, 0, 1, y, z, 0.3, STEEL);
        wheel.boxPlain(-1.3, y - 2.2, z - 1.1, 1.3, y - 0.2, z + 1.1, i % 2 === 0 ? 0x00e5ff : 0xfff03b, true, i % 2 === 0 ? GLOW_U.cyan : GLOW_U.yellow);
      }
      parts.push({ geometry: wheel.build(), style: 'concrete', rotating: true, hubX: l.x, hubY, hubZ: l.z });
      if (wheel.glow) parts.push({ geometry: wheel.glow.build(), style: 'glow', rotating: true, hubX: l.x, hubY, hubZ: l.z });
      break;
    }
  }
  return parts;
}

/** A big painted/neon wall sign derived deterministically for a blank facade (CityRenderer turns it into an atlas quad). */
export interface WallSign { x: number; y: number; z: number; yaw: number; w: number; h: number; color: number; word: number }

/** Kinds of built facade detail listed for FacadeDetailRenderer (low bits of a cell's code). */
export const CELL_KIND = { window: 0, balcony: 1, ac: 2, pipe: 3 } as const;
/** Style index of a cell's code (bits 3..5), in this order. */
export const CELL_STYLES: readonly BuildingStyle[] = ['artdeco', 'glass', 'concrete', 'neon', 'residential'];
/** Floats per unit in FacadeCellList.data: x, y, z (unit origin on the wall plane), nx, nz (outward wall normal), w, h (size in the wall plane; a pipe's h is its length), code, colour (0xRRGGBB). */
export const CELL_STRIDE = 9;
/** Packs a unit's kind, style index, ground-row flag and an 8-bit variant into one float (exact: it stays under 2^24). */
export function cellCode(kind: number, style: number, ground: boolean, variant: number): number {
  return kind | (style << 3) | ((ground ? 1 : 0) << 6) | ((variant & 255) << 8);
}
/**
 * Every built facade unit of the city (window frames, balconies, AC units, downpipes) as a flat float list, filled by
 * appendBuildingDetail and packed by distance at runtime (FacadeDetailRenderer). ~15 k units for the whole city.
 */
export class FacadeCellList {
  data = new Float32Array(CELL_STRIDE * 4096);
  n = 0;

  push(x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, code: number, color: number): void {
    if ((this.n + 1) * CELL_STRIDE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const o = this.n * CELL_STRIDE, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = nx; d[o + 4] = nz; d[o + 5] = w; d[o + 6] = h; d[o + 7] = code; d[o + 8] = color;
    this.n++;
  }

  /** Field `k` (0..CELL_STRIDE-1) of unit i. */
  get(i: number, k: number): number { return this.data[i * CELL_STRIDE + k]; }
}
/** Rectangle of a rect face (0..3) in that face's frame (s along it from its start corner, y up) that no built unit may overlap: a neon sign box, a painted sign panel. */
export interface FacadeKeepOut { face: number; s0: number; s1: number; y0: number; y1: number }
function keptOut(keep: FacadeKeepOut[] | null, face: number, s0: number, s1: number, y0: number, y1: number): boolean {
  if (!keep) return false;
  for (let i = 0; i < keep.length; i++) {
    const k = keep[i];
    if (k.face === face && s1 > k.s0 && s0 < k.s1 && y1 > k.y0 && y0 < k.y1) return true;
  }
  return false;
}

/** Street-level band geometry constants: band heights come from the band textures, `out` is how far the band steps in front of the wall, `doorRecess` how far a shop door cell steps back. */
export const BAND = { shopH: SHOP_BAND_H, shopTile: SHOP_TILE_W, shopOut: 0.16, plinthH: PLINTH_BAND_H, plinthTile: PLINTH_TILE_W, plinthOut: 0.34, doorRecess: DOOR_RECESS, glassRecess: GLASS_RECESS } as const;

const FACE_DIR: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const FACE_YAW = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
/** Plinth bay pitch (m); faces stretch the tile a hair so a whole number of bays fits between the corners. */
const PLINTH_BAY_W = PLINTH_TILE_W / PLINTH_BAYS;
/** Constant UV inside a cream stripe of the awning canvas: plain colour for boards and box canopies. */
const CANVAS_PLAIN_U = 0.06, CANVAS_PLAIN_V = 0.5;
/** Shop bay kinds dealt per face: a start bay hashed per building and face, then a stride coprime with the bay count, so a run of bays visits every kind before it repeats. */
const BAY_STRIDES = [5, 7, 11];

/** Nearest glow-atlas cell for an accent color (used by crowns and neon fins). */
function glowCellFor(color: number): number {
  const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
  if (r > 190 && b > 150 && g < 140) return GLOW_U.magenta;
  if (b > 190 && g > 150 && r < 140) return GLOW_U.cyan;
  if (r > 190 && g > 190 && b < 140) return GLOW_U.yellow;
  if (g > 190 && r < 150) return GLOW_U.green;
  return GLOW_U.orange;
}

/** Height of a building's ground-floor band (band texture height, clamped for very low buildings). */
export function bandHeight(b: Building, plinthStyle: boolean): number {
  return Math.min(plinthStyle ? BAND.plinthH : BAND.shopH, Math.max(3, b.h - 2.5));
}

/** Arcade geometry: the shopfront band steps back behind a row of columns standing on the wall line, one per shop bay (SHOP_BAY_W, stretched a little per face so whole bays fit). */
export const ARCADE = { recess: 0.35, colW: 0.5, bay: SHOP_BAY_W, awningRepeat: 4 } as const;

/**
 * The two or three hues a building's shop fascias and awnings are tinted with: its wall hue saturated, an accent
 * across the colour wheel from it, and a neutral (cream or charcoal). The fascia texture is painted in value only, so
 * these multiply straight onto the boards and sign boxes.
 */
const PALETTE_CREAM = 0xe6dcc6, PALETTE_CHARCOAL = 0x30343a;
const palScratch = [0, 0, 0];
export function fasciaPalette(b: Building, out: number[] = palScratch): number[] {
  tmpColor.setHex(buildingTint(b)).getHSL(hslScratch);
  const h = hslScratch.h;
  tmpColor.setHSL(h, 0.55, 0.46);
  out[0] = tmpColor.getHex();
  tmpColor.setHSL((h + 0.42 + 0.16 * hash01(b.id * 5 + 2)) % 1, 0.5, 0.44);
  out[1] = tmpColor.getHex();
  out[2] = hashU(b.id * 5 + 3) % 2 === 0 ? PALETTE_CREAM : PALETTE_CHARCOAL;
  return out;
}

const bandFr: FaceFrame = { sx: 0, sz: 0, tx: 0, tz: 0, nx: 0, nz: 0, len: 0 };
const wallFr: FaceFrame = { sx: 0, sz: 0, tx: 0, tz: 0, nx: 0, nz: 0, len: 0 };
const pA = [0, 0, 0], pB = [0, 0, 0], pC = [0, 0, 0], pD = [0, 0, 0];
/** World point `s` along a frame, `o` in front of its wall plane (negative = behind), at height y. */
function at(fr: FaceFrame, s: number, o: number, y: number, out: number[]): number[] {
  out[0] = fr.sx + fr.tx * s + fr.nx * o; out[1] = y; out[2] = fr.sz + fr.tz * s + fr.nz * o;
  return out;
}

/**
 * Box stuck to a wall given by its frame: along it from s0 to s1, from `in_` behind the wall plane to `out` in front,
 * y0..y1, with plain UVs. `front` / `bottom` / `top` / `ends` pick the faces (a slab on a wall never needs its back).
 * Works on chamfer edges too, unlike faceBox, which rotates FACE bits into world faces.
 */
function frameBox(gb: GeoBuilder, fr: FaceFrame, s0: number, s1: number, y0: number, y1: number, in_: number, out: number, color: number, front: boolean, bottom: boolean, top: boolean, ends: boolean): void {
  const u = 0.25, v = ROOF_V;
  gb.setColor(color);
  const q = (a: number[], b: number[], c: number[], d: number[]): void => gb.texQuad(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2], u, v, u, v, u, v, u, v);
  if (front) q(at(fr, s0, out, y0, pA), at(fr, s1, out, y0, pB), at(fr, s1, out, y1, pC), at(fr, s0, out, y1, pD));
  if (bottom) q(at(fr, s0, -in_, y0, pA), at(fr, s1, -in_, y0, pB), at(fr, s1, out, y0, pC), at(fr, s0, out, y0, pD));
  if (top) q(at(fr, s0, out, y1, pA), at(fr, s1, out, y1, pB), at(fr, s1, -in_, y1, pC), at(fr, s0, -in_, y1, pD));
  if (ends) {
    q(at(fr, s0, -in_, y0, pA), at(fr, s0, out, y0, pB), at(fr, s0, out, y1, pC), at(fr, s0, -in_, y1, pD));
    q(at(fr, s1, out, y0, pA), at(fr, s1, -in_, y0, pB), at(fr, s1, -in_, y1, pC), at(fr, s1, out, y1, pD));
  }
}

/**
 * Box stuck to face `f` of a rect: along the face from s0 to s1, from `in_` behind the wall to `out` in front of it,
 * y0..y1. `mask` names the faces in face-local terms (FACE.pz = front, FACE.nz = back, px/nx = the two ends, top, bot).
 */
function faceBox(gb: GeoBuilder, fr: FaceFrame, s0: number, s1: number, y0: number, y1: number, in_: number, out: number, color: number, mask: number, f: number): void {
  const ax = fr.sx + fr.tx * s0 - fr.nx * in_, az = fr.sz + fr.tz * s0 - fr.nz * in_;
  const bx = fr.sx + fr.tx * s1 + fr.nx * out, bz = fr.sz + fr.tz * s1 + fr.nz * out;
  // Rotate the local mask into world faces: front = this face, back = the opposite one, ends = the neighbours.
  let m = mask & (FACE.top | FACE.bot);
  if (mask & FACE.pz) m |= FACE_BIT[f];
  if (mask & FACE.nz) m |= FACE_BIT[(f + 2) % 4];
  if (mask & FACE.px) m |= FACE_BIT[(f + 1) % 4];
  if (mask & FACE.nx) m |= FACE_BIT[(f + 3) % 4];
  gb.boxFaces(Math.min(ax, bx), y0, Math.min(az, bz), Math.max(ax, bx), y1, Math.max(az, bz), color, m);
}

/** One textured quad of a street band: s0..s1 along the frame at plane offset `depth`, y0..y1, u0..u1 x v0..v1. */
function bandQuad(gb: GeoBuilder, fr: FaceFrame, s0: number, s1: number, depth: number, y0: number, y1: number, u0: number, u1: number, v0: number, v1: number, color: number): void {
  gb.setColor(color);
  at(fr, s0, depth, y0, pA); at(fr, s1, depth, y0, pB); at(fr, s1, depth, y1, pC); at(fr, s0, depth, y1, pD);
  gb.quad(pA[0], pA[1], pA[2], pB[0], pB[1], pB[2], pC[0], pC[1], pC[2], pD[0], pD[1], pD[2], fr.nx, 0, fr.nz, u0, v0, u1, v0, u1, v1, u0, v1);
}

/** Dark reveal face of a door recess at band position `s`, between depths dIn (back) and dOut (front), facing +t (`plus`) or -t. Samples the atlas' plain cell. */
function revealQuad(gb: GeoBuilder, fr: FaceFrame, s: number, dIn: number, dOut: number, y0: number, y1: number, plus: boolean, color: number): void {
  gb.setColor(color);
  const u = SHOP_PLAIN_UV.u, v = SHOP_PLAIN_UV.v;
  if (plus) { at(fr, s, dOut, y0, pA); at(fr, s, dIn, y0, pB); at(fr, s, dIn, y1, pC); at(fr, s, dOut, y1, pD); }
  else { at(fr, s, dIn, y0, pA); at(fr, s, dOut, y0, pB); at(fr, s, dOut, y1, pC); at(fr, s, dIn, y1, pD); }
  gb.texQuad(pA[0], pA[1], pA[2], pB[0], pB[1], pB[2], pC[0], pC[1], pC[2], pD[0], pD[1], pD[2], u, v, u, v, u, v, u, v);
}

/**
 * Horizontal quad of a street band facing DOWN (a recess soffit) or UP (a display counter top): s0..s1 along the
 * frame, between plane offsets dIn (further into the building) and dOut, at height y. Samples the atlas' plain cell.
 */
function flatBandQuad(gb: GeoBuilder, fr: FaceFrame, s0: number, s1: number, dIn: number, dOut: number, y: number, up: boolean, color: number): void {
  gb.setColor(color);
  const u = SHOP_PLAIN_UV.u, v = SHOP_PLAIN_UV.v;
  at(fr, s0, dIn, y, pA); at(fr, s1, dIn, y, pB); at(fr, s1, dOut, y, pC); at(fr, s0, dOut, y, pD);
  if (up) gb.texQuad(pD[0], pD[1], pD[2], pC[0], pC[1], pC[2], pB[0], pB[1], pB[2], pA[0], pA[1], pA[2], u, v, u, v, u, v, u, v);
  else gb.texQuad(pA[0], pA[1], pA[2], pB[0], pB[1], pB[2], pC[0], pC[1], pC[2], pD[0], pD[1], pD[2], u, v, u, v, u, v, u, v);
}

/**
 * The doorway behind a shop door cell dL..dR (band frame coordinates): a door leaf DOOR_LEAF_OUT proud of the recess
 * back and DOOR_LEAF_INSET inside its jambs carrying the painted door (the back wall around it keeps the frame), and
 * a threshold step (top and front). Three quads a door: ~2700 doorways sit in one always-drawn mesh, so the leaf's
 * 6 cm flanks and a soffit the arcade cap already stands in for were not worth their triangles.
 */
function doorLeaf(gb: GeoBuilder, fr: FaceFrame, dL: number, dR: number, yF: number, uAt: (s: number) => number, v0: number, v1: number, tint: number, dark: number): void {
  const u = SHOP_PLAIN_UV.u, v = SHOP_PLAIN_UV.v;
  const back = -DOOR_RECESS, front = back + DOOR_LEAF_OUT;
  const lL = dL + DOOR_LEAF_INSET, lR = dR - DOOR_LEAF_INSET, ins = DOOR_LEAF_INSET / (dR - dL);
  const uL = uAt(dL) + (uAt(dR) - uAt(dL)) * ins, uR = uAt(dR) - (uAt(dR) - uAt(dL)) * ins;
  bandQuad(gb, fr, lL, lR, front, DOOR_STEP_H, DOOR_LEAF_H, uL, uR, v0 + (v1 - v0) * (DOOR_STEP_H / yF), v0 + (v1 - v0) * (DOOR_LEAF_H / yF), tint);
  gb.setColor(lighten(dark, 0.55));
  at(fr, dL, back, DOOR_STEP_H, pA); at(fr, dR, back, DOOR_STEP_H, pB); at(fr, dR, back + DOOR_STEP_D, DOOR_STEP_H, pC); at(fr, dL, back + DOOR_STEP_D, DOOR_STEP_H, pD);
  gb.texQuad(pD[0], pD[1], pD[2], pC[0], pC[1], pC[2], pB[0], pB[1], pB[2], pA[0], pA[1], pA[2], u, v, u, v, u, v, u, v);
  at(fr, dL, back + DOOR_STEP_D, 0, pA); at(fr, dR, back + DOOR_STEP_D, 0, pB); at(fr, dR, back + DOOR_STEP_D, DOOR_STEP_H, pC); at(fr, dL, back + DOOR_STEP_D, DOOR_STEP_H, pD);
  gb.texQuad(pA[0], pA[1], pA[2], pB[0], pB[1], pB[2], pC[0], pC[1], pC[2], pD[0], pD[1], pD[2], u, v, u, v, u, v, u, v);
}

/**
 * One shop's awning over band run s0..s1 of the frame, hung `front` in front of the band plane just under the fascia
 * foot `yTop`. Three in four are sloped striped canvas (slope + valance, u along the span, v down the drop: 0.8 m of
 * fall over 1.5-1.8 m and a 0.4 m valance, 1.2 m in all) in one of the building's hues; the rest flat box canopies.
 */
function awningBay(gb: GeoBuilder, fr: FaceFrame, front: number, s0: number, s1: number, yTop: number, hv: number, color: number): void {
  const px = (t: number, o: number): number => fr.sx + fr.tx * t + fr.nx * o;
  const pz = (t: number, o: number): number => fr.sz + fr.tz * t + fr.nz * o;
  if ((hv >>> 4) % 4 === 0) {
    // Top, underside and fascia only: the end slivers are never noticed and the mesh is drawn twice a frame.
    const depth = 1.4, thick = 0.25, yLow = yTop - thick, o1 = front + depth;
    const u = CANVAS_PLAIN_U, v = CANVAS_PLAIN_V;
    gb.setColor(darken(color, 0.55));
    gb.texQuad(px(s0, o1), yTop, pz(s0, o1), px(s1, o1), yTop, pz(s1, o1), px(s1, front), yTop, pz(s1, front), px(s0, front), yTop, pz(s0, front), u, v, u, v, u, v, u, v);
    gb.texQuad(px(s0, front), yLow, pz(s0, front), px(s1, front), yLow, pz(s1, front), px(s1, o1), yLow, pz(s1, o1), px(s0, o1), yLow, pz(s0, o1), u, v, u, v, u, v, u, v);
    gb.texQuad(px(s0, o1), yLow, pz(s0, o1), px(s1, o1), yLow, pz(s1, o1), px(s1, o1), yTop, pz(s1, o1), px(s0, o1), yTop, pz(s0, o1), u, v, u, v, u, v, u, v);
    return;
  }
  const depth = 1.5 + ((hv >>> 16) % 3) * 0.15, hang = 0.4, yOut = yTop - 0.8;
  gb.setColor(color);
  const u0 = s0 / ARCADE.awningRepeat, u1 = s1 / ARCADE.awningRepeat;
  const slope = Math.hypot(depth, yTop - yOut), total = slope + hang;
  const vMid = hang / total;
  // Slope (normal up and out), then the valance hanging from its outer edge (normal out).
  gb.texQuad(px(s0, front), yTop, pz(s0, front), px(s1, front), yTop, pz(s1, front), px(s1, front + depth), yOut, pz(s1, front + depth), px(s0, front + depth), yOut, pz(s0, front + depth),
    u0, 1, u1, 1, u1, vMid, u0, vMid);
  gb.texQuad(px(s0, front + depth), yOut, pz(s0, front + depth), px(s1, front + depth), yOut, pz(s1, front + depth), px(s1, front + depth), yOut - hang, pz(s1, front + depth), px(s0, front + depth), yOut - hang, pz(s0, front + depth),
    u0, vMid, u1, vMid, u1, 0, u0, 0);
}

/**
 * Hanging sign board at band position `s`: a bracket bar out from the column line at the fascia top with a board
 * hanging under it, all on the awning canvas' cream stripe (the vertex tint is the colour). Eight quads: the bar's
 * four long faces, the board and its gold panel as two-sided planes (the board is 5 cm thick - no edges needed).
 */
function hangingSign(gb: GeoBuilder, fr: FaceFrame, front: number, s: number, h: number, color: number): void {
  const px = (t: number, o: number): number => fr.sx + fr.tx * t + fr.nx * o;
  const pz = (t: number, o: number): number => fr.sz + fr.tz * t + fr.nz * o;
  const yBar = h - 0.42, bh = 0.5, o0 = front + 0.15, o1 = front + 0.95;
  const u = CANVAS_PLAIN_U, v = CANVAS_PLAIN_V, t = 0.03;
  // Bar: a 6 cm square section from the column line to o1, no end caps.
  const ax = px(s - t, front), az = pz(s - t, front), bx = px(s + t, front), bz = pz(s + t, front);
  const cx = px(s + t, o1), cz = pz(s + t, o1), dx = px(s - t, o1), dz = pz(s - t, o1);
  gb.setColor(0x3a3a40);
  gb.quad(ax, yBar + 0.06, az, bx, yBar + 0.06, bz, cx, yBar + 0.06, cz, dx, yBar + 0.06, dz, 0, 1, 0, u, v, u, v, u, v, u, v);
  gb.quad(dx, yBar, dz, cx, yBar, cz, bx, yBar, bz, ax, yBar, az, 0, -1, 0, u, v, u, v, u, v, u, v);
  gb.texQuad(ax, yBar, az, dx, yBar, dz, dx, yBar + 0.06, dz, ax, yBar + 0.06, az, u, v, u, v, u, v, u, v);
  gb.texQuad(cx, yBar, cz, bx, yBar, bz, bx, yBar + 0.06, bz, cx, yBar + 0.06, cz, u, v, u, v, u, v, u, v);
  // Board and panel: planes in the wall's normal direction, both faces.
  const plane = (oa: number, ob: number, y0: number, y1: number, off: number, col: number): void => {
    const p0x = px(s + off, oa), p0z = pz(s + off, oa), p1x = px(s + off, ob), p1z = pz(s + off, ob);
    gb.setColor(col);
    gb.texQuad(p0x, y0, p0z, p1x, y0, p1z, p1x, y1, p1z, p0x, y1, p0z, u, v, u, v, u, v, u, v);
    const q0x = px(s - off, oa), q0z = pz(s - off, oa), q1x = px(s - off, ob), q1z = pz(s - off, ob);
    gb.texQuad(q1x, y0, q1z, q0x, y0, q0z, q0x, y1, q0z, q1x, y1, q1z, u, v, u, v, u, v, u, v);
  };
  plane(o0, o1 - 0.06, yBar - bh - 0.08, yBar - 0.08, 0.025, color);
  plane(o0 + 0.08, o1 - 0.14, yBar - bh, yBar - 0.16, 0.035, 0xf0d090);
}

/**
 * Entrance of a downtown plinth at band position `tc` (bay centre): a dark canopy slab 2.5 m deep on two thin posts
 * over the door bay, a planter with a clipped shrub on either side of it.
 */
function plinthEntrance(gb: GeoBuilder, fr: FaceFrame, tc: number, bayW: number, f: number): void {
  const cw = Math.min(bayW - 0.5, 4.2), depth = 2.5, yTop = 4.0, thick = 0.3, post = 0.12;
  const s0 = tc - cw / 2, s1 = tc + cw / 2;
  const slab = 0x33353a, metal = 0x2a2b2f, pot = 0x3a3c40, leaf = 0x3f7a3a;
  faceBox(gb, fr, s0, s1, yTop - thick, yTop, -0.02, depth, slab, FACE.pz | FACE.px | FACE.nx | FACE.top | FACE.bot, f);
  // Posts: front and both ends (the back looks at the door), planters: pot sides under a clipped box shrub.
  faceBox(gb, fr, s0 + 0.15, s0 + 0.15 + post, 0, yTop - thick, -(depth - 0.2 - post), depth - 0.2, metal, FACE.pz | FACE.px | FACE.nx, f);
  faceBox(gb, fr, s1 - 0.15 - post, s1 - 0.15, 0, yTop - thick, -(depth - 0.2 - post), depth - 0.2, metal, FACE.pz | FACE.px | FACE.nx, f);
  for (const side of [-1, 1]) {
    const sc = tc + side * (cw / 2 + 0.75);
    if (sc - 0.45 < 0.3 || sc + 0.45 > fr.len - 0.3) continue;
    faceBox(gb, fr, sc - 0.45, sc + 0.45, 0, 0.55, -0.25, 1.15, pot, FACE.sides, f);
    faceBox(gb, fr, sc - 0.4, sc + 0.4, 0.55, 1.15, -0.3, 1.1, leaf, FACE.sides | FACE.top, f);
  }
}

/**
 * Arcade corner column on outline corner i: at a square corner the old box from (corner - rec - 0.1) to (corner + out)
 * on both axes, at a chamfer corner a square of the same size centred on the corner point.
 */
function cornerColumn(gb: GeoBuilder, ol: Outline, i: number, inset: number, out: number, yTop: number, color: number): void {
  const p = (i + ol.n - 1) % ol.n, q = (i + 1) % ol.n;
  let ax = -(ol.z[i] - ol.z[p]), az = ol.x[i] - ol.x[p];
  let bx = -(ol.z[q] - ol.z[i]), bz = ol.x[q] - ol.x[i];
  const al = Math.hypot(ax, az) || 1, bl = Math.hypot(bx, bz) || 1;
  ax /= al; az /= al; bx /= bl; bz /= bl;
  const cx = ol.x[i], cz = ol.z[i];
  if (Math.abs(ax * bx + az * bz) < 1e-6) {
    const ox = cx + (ax + bx) * out, oz = cz + (az + bz) * out, ix = cx - (ax + bx) * inset, iz = cz - (az + bz) * inset;
    gb.boxFaces(Math.min(ox, ix), 0, Math.min(oz, iz), Math.max(ox, ix), yTop, Math.max(oz, iz), color, FACE.sides);
  } else {
    const hs = (inset + out) / 2;
    gb.boxFaces(cx - hs, 0, cz - hs, cx + hs, yTop, cz + hs, color, FACE.sides);
  }
}

/**
 * Ground floor. Downtown: the lobby plinth band stands in front of the wall under a cornice cap, its tile stretched to
 * whole bays per face with the entrance bay put near the middle of the facing wall; every door bay on a street face
 * gets a canopy on posts and two planters (plinthEntrance). Shops: the glazed band steps back ARCADE.recess behind the
 * wall line (following the building's footprint, chamfers included) and a column on every bay line of the faces that
 * hold a street stands in front of it under the cap's soffit, so the ground floor is an arcade with real shadow. Each
 * face is dealt whole SHOP_BAY_W bays (stretched a hair so they fit; the kinds walk the atlas with a hashed start and
 * stride, so neighbours never show the same row of signs); on a street face every shop's door cell steps DOOR_RECESS
 * into the wall between dark reveals. The fascia strip over each bay is its own quad tinted from the building's
 * two-or-three-hue palette (fasciaPalette). Awnings hang full-bay over about half the shops of every street face
 * (awningBay: palette colour, 1.2 m drop, some flat canopies) and the cafes get a hanging sign board; both live in the
 * awning builder (Materials.awning). `streetMask` = bits of the faces (FACE_BIT order) that see a street; hidden faces
 * get flat bays and no columns, doors or entrances.
 */
export function appendStreetLevel(styleGb: GeoBuilder, bandGb: GeoBuilder, b: Building, rng: Random, plinthStyle: boolean, awningGb: GeoBuilder | null = null, streetMask = 15): void {
  const out = plinthStyle ? BAND.plinthOut : BAND.shopOut;
  const h = bandHeight(b, plinthStyle);
  const base = buildingTint(b);
  const wx0 = b.x - b.w / 2, wx1 = b.x + b.w / 2, wz0 = b.z - b.d / 2, wz1 = b.z + b.d / 2;
  const rec = plinthStyle ? -out : ARCADE.recess;
  // Slight tint from the building color so blocks do not all share one shopfront hue.
  const tint = lighten(base, plinthStyle ? 0.66 : 0.78);
  // Cornice capping the band (also hides the step back to the wall); its underside is the arcade soffit.
  const cap = lighten(base, plinthStyle ? 0.3 : 0.55);
  if (plinthStyle) {
    const x0 = wx0 + rec, x1 = wx1 - rec, z0 = wz0 + rec, z1 = wz1 - rec;
    styleGb.boxPlain(wx0 - out - 0.18, h - 0.32, wz0 - out - 0.18, wx1 + out + 0.18, h + 0.16, wz1 + out + 0.18, cap, false);
    for (let f = 0; f < 4; f++) {
      const fr = faceFrame(x0, z0, x1, z1, f);
      const nBays = Math.max(1, Math.round(fr.len / PLINTH_BAY_W)), bayW = fr.len / nBays;
      // Bay index at the band's start corner: on the facing wall it puts the door near the middle (hashed a bay
      // either way), elsewhere it is hashed so the side walls do not copy the front.
      let off: number;
      if (f === b.facing) {
        const d = Math.min(nBays - 1, Math.max(0, Math.floor(nBays / 2) + (hashU(b.id * 5 + 1) % 3) - 1));
        off = (((PLINTH_DOOR_BAY - d) % PLINTH_BAYS) + PLINTH_BAYS) % PLINTH_BAYS;
      } else off = hashU(b.id * 5 + f + 11) % PLINTH_BAYS;
      const u0 = off / PLINTH_BAYS;
      bandGb.bandFace(fr.sx, fr.sz, fr.tx, fr.tz, fr.nx, fr.nz, 0, fr.len, 0, h, u0, u0 + nBays / PLINTH_BAYS, tint);
      // Canopies on the facing wall only (a side face keeps bare doors): the frame budget, not the look, draws the line.
      if (f !== b.facing || ((streetMask >> f) & 1) === 0) continue;
      for (let d = (((PLINTH_DOOR_BAY - off) % PLINTH_BAYS) + PLINTH_BAYS) % PLINTH_BAYS; d < nBays; d += PLINTH_BAYS) plinthEntrance(styleGb, fr, (d + 0.5) * bayW, bayW, f);
    }
    return;
  }
  const m = massingOf(b);
  const ol = footprint(b, streetMask, m, olA);
  // Cap prism on the footprint (top and soffit), then the band outline ARCADE.recess inside the wall line.
  styleGb.prism(ol.offset(out + 0.18, olB), h - 0.32, h + 0.16, cap, true, true);
  const bandOl = ol.offset(-rec, olB);
  const pal = fasciaPalette(b);
  const yF = h * (SHOP_FASCIA_Y / SHOP_BAND_H);
  const col = darken(cap, 0.9), cw = ARCADE.colW, yTop = h - 0.3;
  const revealCol = darken(tint, 0.5);
  // The glazing plane runs GLASS_RECESS behind the fascia plane on street faces, and the painted interior on it is
  // dimmed a quarter: it is half a metre deeper into the building and under its own soffit, so it must not read at
  // the same brightness as the sunlit fascia above it.
  const interiorCol = darken(tint, 0.74);
  const counterCol = darken(tint, 0.46);
  const front = rec + out;
  const rowV = 1 / SHOP_ROWS, fasciaV = (SHOP_FASCIA_Y / SHOP_BAND_H) * rowV;
  // Fabric in open air over the door: the ground occlusion ramp does not apply to it.
  const ao = awningGb ? awningGb.bakeAo : true;
  if (awningGb) awningGb.bakeAo = false;
  for (let i = 0; i < bandOl.n; i++) {
    const fr = bandOl.edge(i, bandFr);
    const f = bandOl.face[i];
    const street = bandOl.streetEdge(i, streetMask);
    const key = b.id * 8 + i;
    if (f < 0) {
      // Chamfer edge: the tail of one hashed bay (its right pier lands on the corner), no door, no columns.
      const k = hashU(key * 3 + 1) % SHOP_BAYS.length, row = k >> 2, colI = k & 3;
      const uB1 = ((colI + 1) * SHOP_BAY_W) / SHOP_TILE_W, uB0 = uB1 - Math.min(fr.len, SHOP_BAY_W) / SHOP_TILE_W;
      const vG0 = (SHOP_ROWS - 1 - row) * rowV;
      bandQuad(bandGb, fr, 0, fr.len, 0, 0, yF, uB0, uB1, vG0, vG0 + fasciaV, tint);
      bandQuad(bandGb, fr, 0, fr.len, 0, yF, h, uB0, uB1, vG0 + fasciaV, vG0 + rowV, pal[hashU(key * 3 + 2) % 3]);
      continue;
    }
    const nBays = Math.max(1, Math.round(fr.len / SHOP_BAY_W)), pitch = fr.len / nBays, scale = pitch / SHOP_BAY_W;
    const start = (hashU(b.id * 7 + 3) + f * 3 + (hashU(key * 7 + 5) % 2)) % SHOP_BAYS.length;
    if (!street) {
      // A face that sees no street: one run of consecutive atlas bays (the row wraps in u), two quads, one fascia hue.
      const row = start >> 2, u0 = ((start & 3) * SHOP_BAY_W) / SHOP_TILE_W, u1 = u0 + nBays * (SHOP_BAY_W / SHOP_TILE_W);
      const vG0 = (SHOP_ROWS - 1 - row) * rowV;
      bandQuad(bandGb, fr, 0, fr.len, 0, 0, yF, u0, u1, vG0, vG0 + fasciaV, tint);
      bandQuad(bandGb, fr, 0, fr.len, 0, yF, h, u0, u1, vG0 + fasciaV, vG0 + rowV, pal[hashU(key * 3 + 2) % 3]);
      continue;
    }
    const stride = BAY_STRIDES[hashU(key * 7 + 9) % BAY_STRIDES.length];
    // Head of the recess: one quad for the whole run, from the recessed glazing plane forward to the fascia plane.
    // Without it the strip between the fascia foot and the glazing head is an open slot showing sky from any eye
    // height under the fascia. One quad a run, not a bay - the run recesses as a whole.
    flatBandQuad(bandGb, fr, 0, fr.len, -GLASS_RECESS, 0, yF, false, revealCol);
    for (let j = 0; j < nBays; j++) {
      const k = (start + j * stride) % SHOP_BAYS.length, bay = SHOP_BAYS[k], row = k >> 2, colI = k & 3;
      const s0 = j * pitch, s1 = s0 + pitch;
      const uB0 = (colI * SHOP_BAY_W) / SHOP_TILE_W;
      const uAt = (s: number): number => uB0 + (s - s0) / scale / SHOP_TILE_W;
      const vG0 = (SHOP_ROWS - 1 - row) * rowV, vF0 = vG0 + fasciaV, vT = vG0 + rowV;
      const hv = hashU(b.id * 131 + i * 977 + j * 17 + k);
      // Widest run of glazing in the bay (the door cell splits it): where the display counter goes.
      let gL = s0, gR = s1;
      if (bay.door >= 0) {
        const dL = s0 + bay.door * scale, dR = dL + SHOP_DOOR_W * scale;
        bandQuad(bandGb, fr, s0, dL, -GLASS_RECESS, 0, yF, uAt(s0), uAt(dL), vG0, vF0, interiorCol);
        bandQuad(bandGb, fr, dL, dR, -DOOR_RECESS, 0, yF, uAt(dL), uAt(dR), vG0, vF0, interiorCol);
        bandQuad(bandGb, fr, dR, s1, -GLASS_RECESS, 0, yF, uAt(dR), uAt(s1), vG0, vF0, interiorCol);
        revealQuad(bandGb, fr, dL, -DOOR_RECESS, -GLASS_RECESS, 0, yF, true, revealCol);
        revealQuad(bandGb, fr, dR, -DOOR_RECESS, -GLASS_RECESS, 0, yF, false, revealCol);
        doorLeaf(bandGb, fr, dL, dR, yF, uAt, vG0, vF0, tint, revealCol);
        if (dL - s0 >= s1 - dR) gR = dL; else gL = dR;
      } else bandQuad(bandGb, fr, s0, s1, -GLASS_RECESS, 0, yF, uAt(s0), uAt(s1), vG0, vF0, interiorCol);
      // Display counter: one horizontal plate across the widest glazing run, from the interior plane almost out to
      // the glass. It is the only piece of the shop that is not on the painted plane, so it is what gives the row
      // parallax as you drive past - two triangles a bay, and none behind a shutter or a vacant unit.
      if (bay.kind !== 'shutter' && bay.kind !== 'vacant' && gR - gL > 1.2) {
        flatBandQuad(bandGb, fr, gL + COUNTER.inset, gR - COUNTER.inset, -GLASS_RECESS, -COUNTER.front, yF * COUNTER.y, true, counterCol);
      }
      // Fascia in one of the building's hues (the vacant panel keeps a faded neutral; a sign box never takes the
      // charcoal, whose dark letters would vanish on it).
      let fc = bay.sign === 'none' ? 0xd0cabc : pal[(hv >>> 20) % 3];
      if (bay.sign === 'lightbox' && fc === PALETTE_CHARCOAL) fc = pal[(hv >>> 22) & 1];
      bandQuad(bandGb, fr, s0, s1, 0, yF, h, uAt(s0), uAt(s1), vF0, vT, fc);
      if (!awningGb) continue;
      if (bay.kind !== 'shutter' && bay.kind !== 'vacant' && (hv >>> 2) % 5 < 3) awningBay(awningGb, fr, front, s0 + 0.25, s1 - 0.25, yF - 0.05, hv, pal[(hv >>> 24) % 3]);
      if (bay.kind === 'kahve') hangingSign(awningGb, fr, front, s1 - 0.3, h, pal[(hv >>> 8) % 3]);
    }
    // Arcade columns on the bay lines, standing on the wall line (the band edge runs ARCADE.recess behind it).
    const wfr = ol.edge(i, wallFr);
    const shift = (fr.sx - wfr.sx) * wfr.tx + (fr.sz - wfr.sz) * wfr.tz;
    for (let j = 1; j < nBays; j++) {
      const s = j * pitch + shift;
      if (s < 1 || s > wfr.len - 1) continue;
      faceBox(styleGb, wfr, s - cw / 2, s + cw / 2, 0, yTop, rec + GLASS_RECESS - 0.02, out, col, FACE.pz | FACE.px | FACE.nx, f);
    }
  }
  // A square pier on every corner that touches a street, from the pavement up into the cap.
  // The corner piers run back past the recessed glazing plane too: they are what closes the end of every run, where
  // the band steps from GLASS_RECESS back to the wall of a face that sees no street. No extra quads, a fatter pier.
  for (let i = 0; i < ol.n; i++) if (ol.streetCorner(i, streetMask)) cornerColumn(styleGb, ol, i, rec + GLASS_RECESS + 0.1, out, yTop, col);
  if (awningGb) awningGb.bakeAo = ao;
}

/** Roof-edge cornice around an outline: a two-step profile (0.15 m fillet under a 0.35 m slab) a shade darker than the wall so the roofline reads as a solid edge. */
function parapetBand(gb: GeoBuilder, ol: Outline, top: number, wall: number): void {
  gb.corniceOutline(ol, top - 0.02, 0.15, 0.3, 0.35, 0.35, darken(wall, 0.85));
}
const olR = new Outline();
function parapetBandRect(gb: GeoBuilder, x0: number, z0: number, x1: number, z1: number, top: number, wall: number): void {
  parapetBand(gb, olR.set(x0, z0, x1, z1), top, wall);
}

/**
 * Parapet walls standing on the coping: a 0.65 m hollow wall `ph` (1.0-1.2 m) tall with a lighter coping slab on top,
 * COPING_OUT proud on both sides, so the roof reads as a lid. Skipped on tiny roofs and on roofs too low to be seen.
 */
function parapetWalls(gb: GeoBuilder, ol: Outline, top: number, ph: number, cap: number): void {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < ol.n; i++) { x0 = Math.min(x0, ol.x[i]); x1 = Math.max(x1, ol.x[i]); z0 = Math.min(z0, ol.z[i]); z1 = Math.max(z1, ol.z[i]); }
  if (x1 - x0 <= 4 || z1 - z0 <= 4 || top < CLUTTER_MIN_H) return;
  // The coping oversails the parapet by COPING_OUT, so the head of the wall never sees the sky: the outer ring is
  // ramped from full at its foot to PARAPET_AO under the coping. That band is what tells a roofline apart from the
  // wall below it at 60 m, and it costs nothing - the quads were already there.
  gb.frameOutline(ol.offset(0.25, olE), top - 0.15, top + ph, 0.65, cap, true, 1, PARAPET_AO);
  gb.frameOutline(ol.offset(0.25 + COPING_OUT, olE), top + ph, top + ph + COPING_H, 0.65 + 2 * COPING_OUT, lighten(cap, 0.3), false);
}
function parapetWallsRect(gb: GeoBuilder, x0: number, z0: number, x1: number, z1: number, top: number, ph: number, cap: number): void {
  parapetWalls(gb, olR.set(x0, z0, x1, z1), top, ph, cap);
}

/** Plant room / AC enclosure with a louvre screen (one dark slat band around it). */
function plantBox(gb: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): void {
  gb.litBox(x0, y0, z0, x1, y1, z1, color);
  const slat = darken(color, 0.55), o = 0.06;
  const ya = y0 + (y1 - y0) * 0.5;
  gb.boxPlain(x0 - o, ya - 0.1, z0 - o, x1 + o, ya + 0.1, z1 + o, slat);
}

/** Margin kept between the rooftop kit and the parapet's inner face, and the colours the kit is built from. */
const KIT = { margin: 2.4, tank: 0xe8e4da, cradle: 0x6a6560, ac: 0xb0b6bc, acBase: 0x8e8a84, hut: 0xc8c2b6, door: 0x39332c, mast: 0xb0b4ba } as const;

/**
 * One rooftop kit item centred at (cx, cz) on a deck at `top`, laid out along the deck's long axis (`alongX`).
 * Kind 0 stair bulkhead, 1 water tanks on a cradle (the flat-roof staple of any Istanbul block), 2 a bank of
 * condensers on a low plinth, 3 an aerial mast with a dish. 6-19 quads each, all baked-shaded (GeoBuilder.litBox)
 * and all inside the city-wide trim mesh, which stays out of the shadow pass.
 */
function roofKitItem(gb: GeoBuilder, rng: Random, kind: number, cx: number, cz: number, top: number, alongX: boolean): void {
  // Long axis of the item follows the deck's, so a bank of condensers runs along the roof instead of across it.
  const L = (l: number, w: number, k: 0 | 1): number => (alongX === (k === 0) ? l : w);
  if (kind === 0) {
    const hw = L(1.6, 1.3, 0), hd = L(1.6, 1.3, 1), h = rng.range(2.3, 2.9);
    gb.litBox(cx - hw, top, cz - hd, cx + hw, top + h, cz + hd, KIT.hut);
    // Door on the +Z face (or +X when the hut is turned), and a coping lip so the box is not a bare cube.
    if (alongX) gb.plainQuad(cx - 0.5, top, cz + hd + 0.01, cx + 0.5, top, cz + hd + 0.01, cx + 0.5, top + 1.9, cz + hd + 0.01, cx - 0.5, top + 1.9, cz + hd + 0.01, KIT.door);
    else gb.plainQuad(cx + hw + 0.01, top, cz + 0.5, cx + hw + 0.01, top, cz - 0.5, cx + hw + 0.01, top + 1.9, cz - 0.5, cx + hw + 0.01, top + 1.9, cz + 0.5, KIT.door);
    gb.litBox(cx - hw - 0.12, top + h, cz - hd - 0.12, cx + hw + 0.12, top + h + 0.16, cz + hd + 0.12, darken(KIT.hut, 0.8));
    return;
  }
  if (kind === 1) {
    const n = 1 + rng.int(0, 1), r = 0.82, pitch = 1.95;
    // Both halves take the same (long, cross) pair; `k` alone does the flipping, so the cradle runs under the row.
    const cl = n * pitch * 0.5 + 0.35, cc = r + 0.35;
    const hw = L(cl, cc, 0), hd = L(cl, cc, 1);
    gb.litBox(cx - hw, top, cz - hd, cx + hw, top + 0.55, cz + hd, KIT.cradle);
    for (let i = 0; i <= n; i++) {
      const o = (i - n / 2) * pitch;
      gb.cylinder(cx + (alongX ? o : 0), cz + (alongX ? 0 : o), r, r, top + 0.55, top + 0.55 + rng.range(1.5, 1.9), 6, KIT.tank, false, lighten(KIT.tank, 0.25));
    }
    return;
  }
  if (kind === 2) {
    const n = 2 + rng.int(0, 1), pitch = 1.5;
    const pl = n * pitch * 0.5 + 0.3;
    const hw = L(pl, 0.9, 0), hd = L(pl, 0.9, 1);
    gb.litBox(cx - hw, top, cz - hd, cx + hw, top + 0.22, cz + hd, KIT.acBase);
    for (let i = 0; i < n; i++) {
      const o = (i - (n - 1) / 2) * pitch;
      const ax = cx + (alongX ? o : 0), az = cz + (alongX ? 0 : o);
      const bw = L(0.62, 0.72, 0), bd = L(0.62, 0.72, 1);
      gb.litBox(ax - bw, top + 0.22, az - bd, ax + bw, top + 0.22 + rng.range(0.8, 1.0), az + bd, KIT.ac);
    }
    return;
  }
  const mh = rng.range(3.4, 5.2);
  gb.bar(cx, top, cz, cx, top + mh, cz, 0.16, KIT.mast);
  gb.bar(cx - 0.9, top + mh * 0.62, cz, cx + 0.9, top + mh * 0.62, cz, 0.1, KIT.mast);
  gb.bar(cx, top + mh * 0.82, cz - 0.7, cx, top + mh * 0.82, cz + 0.7, 0.1, KIT.mast);
  // Satellite dish on a short stand beside the mast: a shallow open cone, six sides.
  const dx = cx + (alongX ? 1.25 : 0), dz = cz + (alongX ? 0 : 1.25);
  gb.litBox(dx - 0.18, top, dz - 0.18, dx + 0.18, top + 0.75, dz + 0.18, KIT.cradle);
  gb.frustum(dx, dz, 0.28, 0.28, 0.72, 0.72, top + 0.75, top + 1.25, 6, lighten(KIT.tank, 0.1), KIT.tank);
}

/**
 * Rooftop kit on the deck rx0..rx1 / rz0..rz1. Items are dealt without repeats into disjoint slots down the deck's
 * long axis (so they can never intersect) and jittered across it. A flat roof in this city is seen from the towers,
 * from the promenade and from every hill in the skyline shot: a bare deck behind a parapet is the single clearest
 * "untextured box" cue a stylised city can give, and one to three small solids per roof buy the whole mid-distance read.
 */
function roofKit(gb: GeoBuilder, rng: Random, rx0: number, rz0: number, rx1: number, rz1: number, top: number): void {
  const alongX = rx1 - rx0 >= rz1 - rz0;
  const len = (alongX ? rx1 - rx0 : rz1 - rz0) - 2 * KIT.margin;
  const cross = (alongX ? rz1 - rz0 : rx1 - rx0) - 2 * KIT.margin;
  if (len < 5 || cross < 3) return;
  // One item per ~9 m of deck, so a 90 m block roof is not dressed like a 12 m one. Three is the cap: the kit reads
  // from a tower at two items a roof already, and every extra slot is paid for on every roof in view at once.
  const slots = Math.max(1, Math.min(3, Math.floor(len / 9)));
  const a0 = (alongX ? rx0 : rz0) + KIT.margin, mid = alongX ? (rz0 + rz1) / 2 : (rx0 + rx1) / 2;
  const deck = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) { const j = rng.int(0, i); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
  const jitter = Math.max(0, cross / 2 - 1.7);
  for (let s = 0; s < slots; s++) {
    const a = a0 + ((s + 0.5) / slots) * len, c = mid + rng.range(-jitter, jitter);
    roofKitItem(gb, rng, deck[s % 4], alongX ? a : c, alongX ? c : a, top, alongX);
  }
}

/** Depth (0 or negative) of the wall at position s along a laid-out face. */
function depthAt(lay: FaceLayout, s: number): number {
  for (let p = 0; p < lay.n; p++) if (s < lay.s[p + 1]) return lay.depth[p];
  return lay.depth[Math.max(0, lay.n - 1)];
}

const keepFr: FaceFrame = { sx: 0, sz: 0, tx: 0, tz: 0, nx: 0, nz: 0, len: 0 };
/** Balcony: width per bay (capped), the height its unit spans (slab + parapet) for the keep-out test. */
const BALCONY_W_MAX = 2.6, BALCONY_UNIT_H = 1.3;
/** Downpipe diameter and the split-unit condenser box hung under a sill. */
const PIPE_D = 0.1, AC_W = 0.82, AC_H = 0.56;

/**
 * Lists the built detail of one street wall for FacadeDetailRenderer: a window unit on every painted cell (the tile's
 * cell grid with the same per-band row offsets `facade` mapped the texture with, so the frame lands on the painted
 * opening), a balcony on four bays in five of every residential floor above the ground band (flush bays only), a
 * split-unit air conditioner under one sill in six, and a downpipe 0.25 m past every wall segment line plus one at
 * the far end of the face. Units overlapping a `keep` rectangle (sign boxes, sign panels) are left out; nothing is
 * listed under `hiddenBelow` (the ground-floor band). Every hash is stable per building, edge, row and bay.
 */
function facadeUnits(cells: FacadeCellList, keep: FacadeKeepOut[] | null, b: Building, fr: FaceFrame, f: number, edge: number, lay: FaceLayout, m: Massing, wallY0: number, wallY1: number, yBase: number, yTop: number, hiddenBelow: number, base: number): void {
  const rowH = m.rowH, bayW = m.bayW;
  const key = b.id * 8 + edge;
  const bands = bandRows(wallY0, wallY1, rowH, m.th, key);
  // Keep-outs are given in the rect face's frame; a chamfered corner shortens this edge from that corner.
  const rf = faceFrame(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2, f, keepFr);
  const off = (fr.sx - rf.sx) * rf.tx + (fr.sz - rf.sz) * rf.tz;
  const styleI = CELL_STYLES.indexOf(b.style);
  const win = WINDOW_CELL[b.style];
  const balconies = b.style === 'residential';
  const balSlab = lighten(base, 0.45), pipeCol = darken(lighten(base, WALL_LIGHTEN), 0.62);
  // Frames come in the style's colour, nudged a little darker on some buildings so a row of blocks is not one white.
  const frameTint = perturb(0xffffff, 0, -0.08 * (hashU(b.id * 5 + 7) % 3));
  const nCols = Math.floor(fr.len / bayW + 1e-6);
  const bw = Math.min(bayW - 0.7, BALCONY_W_MAX);
  for (let j = 0; j < bands.n; j++) {
    const kv = bands.kv[j];
    for (let r = Math.ceil(bands.y[j] / rowH - 1e-6); (r + 1) * rowH <= bands.y[j + 1] + 1e-6; r++) {
      const tileRow = r + kv;
      if (tileRow < 0 || tileRow > 7) continue;
      const ground = tileRow === 0;
      const wc = ground ? WINDOW_CELL.ground : win;
      const cy = (r + 1 - wc.wy - wc.wh / 2) * rowH, hh = wc.wh * rowH;
      if (cy - hh / 2 < hiddenBelow) continue;
      const floorY = r * rowH;
      const balconyRow = balconies && !ground && floorY >= yBase && floorY < yTop;
      for (let c = 0; c < nCols; c++) {
        const sMid = (c + 0.5) * bayW, dep = depthAt(lay, sMid);
        const sc = (c + wc.wx + wc.ww / 2) * bayW, ww = wc.ww * bayW;
        if (keptOut(keep, f, sc + off - ww / 2, sc + off + ww / 2, cy - hh / 2, cy + hh / 2)) continue;
        const hv = hashU(b.id * 131 + edge * 977 + r * 17 + c * 3);
        at(fr, sc, dep, cy, pA);
        cells.push(pA[0], pA[1], pA[2], fr.nx, fr.nz, ww, hh, cellCode(CELL_KIND.window, styleI, ground, hv & 255), frameTint);
        if (balconyRow && dep === 0 && hv % 5 !== 0 && !keptOut(keep, f, sMid + off - bw / 2, sMid + off + bw / 2, floorY, floorY + BALCONY_UNIT_H)) {
          at(fr, sMid, 0, floorY, pA);
          cells.push(pA[0], pA[1], pA[2], fr.nx, fr.nz, bw, BALCONY_UNIT_H, cellCode(CELL_KIND.balcony, styleI, false, (b.id >> 1) & 255), balSlab);
        } else if (!ground && b.style !== 'neon' && (hv >>> 4) % 6 === 0) {
          const side = (hv & 8) === 0 ? -1 : 1;
          at(fr, sc + side * (ww / 2 - AC_W / 2 - 0.04), dep, cy - hh / 2 - 0.12 - AC_H / 2, pA);
          cells.push(pA[0], pA[1], pA[2], fr.nx, fr.nz, AC_W, AC_H, cellCode(CELL_KIND.ac, styleI, false, 0), 0xffffff);
        }
      }
    }
  }
  // Downpipes from the band cap to under the cornice; the unit's origin is its foot, h its length.
  const py0 = hiddenBelow > 0 ? hiddenBelow + 0.05 : 0.05, py1 = wallY1 - 0.85;
  if (py1 - py0 < 2.5) return;
  for (let k = 1; k <= lay.nSeg; k++) {
    const s = k === lay.nSeg ? fr.len - 0.3 : lay.segS[k] + 0.25;
    if (s < 0.3 || s > fr.len - 0.2) continue;
    at(fr, s, depthAt(lay, s), py0, pA);
    cells.push(pA[0], pA[1], pA[2], fr.nx, fr.nz, PIPE_D, py1 - py0, cellCode(CELL_KIND.pipe, styleI, false, 0), pipeCol);
  }
}

/**
 * Roof clutter, parapets, ledges, piers, slabs, balconies, crowns and blank-wall sign panels for one building.
 * Textured tiers, facade relief and sign panels go to `gb` (the building's style mesh, casts shadows); cornices,
 * roof clutter and crown trim go to `trim` (one city-wide plain mesh that stays out of the shadow pass — nothing on
 * a roof throws a shadow the street can see). Glow parts of both land in whatever glow sink the builders share.
 * `streetMask` = faces that see a street (FACE_BIT order; relief goes only there), `bandTop` = height of the
 * ground-floor band the relief must clear (0 without one). The relief follows the same footprint / face layout /
 * band offsets as appendBuilding, so slabs step with the jogs and the built window units (listed into `cells` for
 * FacadeDetailRenderer, see facadeUnits) land on the painted cells. `keep` holds the rectangles no unit may overlap
 * (the building's neon sign boxes, in the rect faces' frames); the painted side-wall sign panel is pushed onto it.
 */
export function appendBuildingDetail(gb: GeoBuilder, trim: GeoBuilder, b: Building, rng: Random, signs: WallSign[], streetMask = 15, bandTop = 0, cells: FacadeCellList | null = null, keep: FacadeKeepOut[] | null = null): void {
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  const base = buildingTint(b);
  const roof = roofTint(base);
  const wall = lighten(base, WALL_LIGHTEN);
  const h = b.h;
  const downtown = b.district === 'downtown';
  const mm = massingOf(b);
  const kind = mm.kind, wallTop = mm.wallTop, stepY = mm.stepY, roofVariant = mm.roofVariant;
  let rx0 = mm.tx0, rx1 = mm.tx1, rz0 = mm.tz0, rz1 = mm.tz1;
  const top = mm.top;
  const bayW = mm.bayW, rowH = mm.rowH;
  const ol = footprint(b, streetMask, mm, olA);
  const alongX = b.facing === 0 || b.facing === 2;
  const cap = lighten(base, 0.28);
  const ph = PARAPET_MIN + PARAPET_VAR * hash01(b.id * 3 + 5);
  const crown = hasCrown(b, top);
  const topY = crown ? top - CHAMFER_H : top;
  // Where the full-footprint walls start (mirrors CityRenderer: shop arcades lift the walls to the cap).
  const wallY0 = bandTop > 0 && !downtown ? bandTop - 0.3 : BASE_Y;

  // --- Massing extras stacked on the base box --------------------------------------------------
  if (kind === 'twin') {
    // Two more tiers, each pulled back from the street and the sides; the crown then sits on the top one.
    const t1 = h + 2 * FLOOR_H;
    parapetBand(trim, ol, h, wall);
    twinRect(b, 1, mm);
    facade(gb, b, olB.set(mm.tx0, mm.tz0, mm.tx1, mm.tz1), h, t1, wall, roof, mm, 0, false, false);
    parapetBandRect(trim, mm.tx0, mm.tz0, mm.tx1, mm.tz1, t1, wall);
    twinRect(b, 2, mm);
    facade(gb, b, olB.set(mm.tx0, mm.tz0, mm.tx1, mm.tz1), t1, topY, wall, roof, mm, 0, false, false);
    rx0 = mm.tx0; rx1 = mm.tx1; rz0 = mm.tz0; rz1 = mm.tz1;
  } else if (kind === 'box' && roofVariant === 1 && b.w > 10 && b.d > 10 && b.roofKind === 'flat') {
    // Raised street-side wing: 55% of the frontage x 45% of the depth climbs two more floors, so the plan reads as an L.
    const wingH = h + 2 * FLOOR_H;
    const along = alongX ? b.w : b.d, depth = alongX ? b.d : b.w;
    const aw = Math.max(8, Math.round((along * 0.55) / 4) * 4), dw = Math.max(6, depth * 0.45);
    const left = (b.id >> 1) % 2 === 0;
    let wx0 = x0, wx1 = x1, wz0 = z0, wz1 = z1;
    if (alongX) { if (left) wx1 = x0 + aw; else wx0 = x1 - aw; if (b.facing === 0) wz0 = z1 - dw; else wz1 = z0 + dw; }
    else { if (left) wz1 = z0 + aw; else wz0 = z1 - aw; if (b.facing === 1) wx0 = x1 - dw; else wx1 = x0 + dw; }
    parapetBand(trim, ol, h, wall);
    parapetWalls(trim, ol, h, ph, cap);
    facade(gb, b, olB.set(wx0, wz0, wx1, wz1), h, wingH, wall, roof, mm, 0, false, false);
    parapetBandRect(trim, wx0, wz0, wx1, wz1, wingH, wall);
    // Clutter goes on the lower roof, away from the wing.
    if (alongX) { if (b.facing === 0) rz1 = wz0; else rz0 = wz1; } else if (b.facing === 1) rx1 = wx0; else rx0 = wx1;
  } else if (kind === 'box' && roofVariant === 2 && b.w > 12 && b.d > 12 && b.roofKind === 'flat') {
    // Penthouse box on 35% of the footprint, pushed to the back of the roof.
    const pw = Math.max(6, b.w * 0.6), pd = Math.max(5, b.d * 0.58);
    let px0 = b.x - pw / 2, pz0 = b.z - pd / 2;
    if (b.facing === 0) pz0 = z0 + 1.2; else if (b.facing === 2) pz0 = z1 - 1.2 - pd; else if (b.facing === 1) px0 = x0 + 1.2; else px0 = x1 - 1.2 - pw;
    facade(gb, b, olB.set(px0, pz0, px0 + pw, pz0 + pd), h, h + FLOOR_H, wall, roof, mm, 0, false, false);
    parapetBandRect(trim, px0, pz0, px0 + pw, pz0 + pd, h + FLOOR_H, wall);
    parapetBand(trim, ol, h, wall);
    parapetWalls(trim, ol, h, ph, cap);
    if (b.facing === 0) rz0 = pz0 + pd; else if (b.facing === 2) rz1 = pz0; else if (b.facing === 1) rx0 = px0 + pw; else rx1 = px0;
  } else if (kind === 'octagon') {
    // Chamfered shaft: a coping ring on the podium edge; the crown handles the shaft top.
    parapetBand(trim, ol, PODIUM_H, wall);
    const rx = (b.w / 2 - 0.4) / Math.cos(OCT), rz = (b.d / 2 - 0.4) / Math.cos(OCT);
    // The coping ring's own cap is the deck it sits on: in the wall tint it laid a pale disc over the whole octagon roof.
    if (!crown) trim.cylinder(b.x, b.z, rx + 0.3, rz + 0.3, h - 0.6, h - 0.02, 8, darken(wall, 0.85), false, roof, GLOW_U.none, OCT);
    const k = 0.62;
    rx0 = b.x - (b.w / 2) * k; rx1 = b.x + (b.w / 2) * k; rz0 = b.z - (b.d / 2) * k; rz1 = b.z + (b.d / 2) * k;
  } else if (kind === 'podium') {
    parapetBand(trim, ol, PODIUM_H, wall);
    parapetWalls(trim, ol, PODIUM_H, ph, cap);
    if (!crown) parapetBandRect(trim, rx0, rz0, rx1, rz1, h, wall);
  } else if (kind === 'setback') {
    parapetBand(trim, ol, stepY, wall);
    if (!crown) { parapetBandRect(trim, rx0, rz0, rx1, rz1, h, wall); parapetWallsRect(trim, rx0, rz0, rx1, rz1, h, ph, cap); }
  } else if (kind === 'tiers') {
    if (b.roofKind !== 'spire' && !crown) { parapetBandRect(trim, rx0, rz0, rx1, rz1, top, wall); parapetWallsRect(trim, rx0, rz0, rx1, rz1, top, ph, cap); }
  } else if (b.roofKind !== 'spire' && !crown) {
    parapetBand(trim, ol, top, wall);
    parapetWalls(trim, ol, top, ph, cap);
  }
  let rw = rx1 - rx0, rd = rz1 - rz0;

  // --- Crown: chamfered corners over a cornice, plant room and mast ------------------------------
  if (crown) {
    // The top CHAMFER_H metres of the shaft are cut back at 45 degrees (a lighter wall tint on the slopes), with a
    // two-step cornice and a darker string band at the foot of the cut. No saturated accent band: only the neon
    // style keeps a glowing strip there.
    // 0.2, not 0.42: a chalk-pale chamfer is what made a crown read as a pastel primitive against the sky. The slopes
    // stay close to the wall and take their form from FACE_SHADE and the sun instead.
    const slope = lighten(base, 0.2), band = darken(wall, 0.72);
    if (kind === 'octagon') {
      const rx = (b.w / 2 - 0.4) / Math.cos(OCT), rz = (b.d / 2 - 0.4) / Math.cos(OCT);
      gb.frustum(b.x, b.z, rx, rz, rx - CHAMFER_H, rz - CHAMFER_H, topY, top, 8, slope, roof, OCT);
      trim.cylinder(b.x, b.z, rx + 0.35, rz + 0.35, topY - 0.45, topY, 8, darken(wall, 0.85), false, darken(wall, 0.85), GLOW_U.none, OCT);
      trim.cylinder(b.x, b.z, rx + 0.2, rz + 0.2, topY - 1.2, topY - 0.55, 8, b.style === 'neon' ? b.neonColor : band, false, null, b.style === 'neon' ? glowCellFor(b.neonColor) : GLOW_U.none, OCT);
      rx0 += CHAMFER_H * 0.6; rx1 -= CHAMFER_H * 0.6; rz0 += CHAMFER_H * 0.6; rz1 -= CHAMFER_H * 0.6;
    } else {
      gb.chamferTop(rx0, rz0, rx1, rz1, topY, top, CHAMFER_H, slope, roof);
      parapetBandRect(trim, rx0, rz0, rx1, rz1, topY, wall);
      if (b.style === 'neon') trim.boxPlain(rx0 - 0.25, topY - 1.2, rz0 - 0.25, rx1 + 0.25, topY - 0.7, rz1 + 0.25, b.neonColor, false, glowCellFor(b.neonColor));
      else trim.boxFaces(rx0 - 0.2, topY - 1.2, rz0 - 0.2, rx1 + 0.2, topY - 0.7, rz1 + 0.2, band, FACE.sides);
      rx0 += CHAMFER_H; rx1 -= CHAMFER_H; rz0 += CHAMFER_H; rz1 -= CHAMFER_H;
    }
    rw = rx1 - rx0; rd = rz1 - rz0;
    const mw = rw * 0.4, md = rd * 0.4, mx = (rx0 + rx1) / 2, mz = (rz0 + rz1) / 2;
    if (mw > 3 && md > 3) plantBox(trim, mx - mw / 2, top, mz - md / 2, mx + mw / 2, top + 4, mz + md / 2, darken(base, 0.7));
    // A crown deck is the most-seen roof in the city (every taller tower looks down on it), and the plant room alone
    // left it bare: an aerial and a tank stand flank it, clear of the middle 40 % the plant room takes.
    if (rw > 15 && rd > 8) {
      roofKitItem(trim, rng, 3, rx0 + 3.2, mz, top, false);
      roofKitItem(trim, rng, 1, rx1 - 3.2, mz, top, false);
    }
    if (b.id % 4 === 2) {
      const sh = Math.max(10, top * 0.14);
      trim.bar(mx, top + 4, mz, mx, top + 4 + sh, mz, 0.7, 0xb0b4ba);
      trim.bar(mx, top + 4 + sh, mz, mx, top + 4 + sh + 3, mz, 0.3, 0xd0d4da);
      trim.boxPlain(mx - 0.25, top + 6.9 + sh, mz - 0.25, mx + 0.25, top + 7.5 + sh, mz + 0.25, 0xff2418, false, GLOW_U.red);
    }
  }

  // --- Rooftop kit (roofs under CLUTTER_MIN_H are never seen from the street) --------------------------
  // Everything stays inside the parapet's inner face (KIT.margin in from the roof edge) with room to spare.
  if (b.roofKind !== 'spire' && rw > 9 && rd > 9 && !crown && top >= CLUTTER_MIN_H) roofKit(trim, rng, rx0, rz0, rx1, rz1, top);
  if (top > 26 && top <= CROWN_MIN_H && b.roofKind !== 'spire' && rng.chance(0.5)) {
    const ax = (rx0 + rx1) / 2 + rng.range(-rw * 0.22, rw * 0.22), az = (rz0 + rz1) / 2 + rng.range(-rd * 0.22, rd * 0.22);
    const mastTop = top + rng.range(5, 13);
    trim.bar(ax, top, az, ax, mastTop, az, 0.34, 0xb0b4ba);
    for (let k = 0; k < 2; k++) {
      const y = top + (mastTop - top) * (0.45 + k * 0.25);
      trim.bar(ax - 1.2, y, az, ax + 1.2, y, az, 0.2, 0xb0b4ba);
    }
    trim.boxPlain(ax - 0.2, mastTop, az - 0.2, ax + 0.2, mastTop + 0.55, az + 0.2, 0xff2418, false, GLOW_U.red);
  }

  // --- Blank side wall with a big painted sign ---------------------------------------------------
  if (!b.hasNeonSign && wallTop >= 16 && rng.chance(0.24)) {
    const face = ((b.facing + (rng.chance(0.5) ? 1 : 3)) % 4) as 0 | 1 | 2 | 3;
    const fw = face === 0 || face === 2 ? b.w : b.d;
    const w = Math.min(fw - 2.5, 15);
    const sh = Math.min(w * 0.4, wallTop - 11);
    if (w >= 6 && sh >= 3) {
      const dir = FACE_DIR[face];
      const off = (face === 0 || face === 2 ? b.d : b.w) / 2;
      const cy = rng.range(9 + sh / 2, wallTop - 2.5 - sh / 2);
      const panel = darken(base, 0.45);
      if (dir[0] === 0) {
        const zf = b.z + dir[1] * off;
        gb.boxPlain(b.x - w / 2, cy - sh / 2, Math.min(zf, zf + dir[1] * 0.28), b.x + w / 2, cy + sh / 2, Math.max(zf, zf + dir[1] * 0.28), panel);
      } else {
        const xf = b.x + dir[0] * off;
        gb.boxPlain(Math.min(xf, xf + dir[0] * 0.28), cy - sh / 2, b.z - w / 2, Math.max(xf, xf + dir[0] * 0.28), cy + sh / 2, b.z + w / 2, panel);
      }
      signs.push({ x: b.x + dir[0] * (off + 0.36), y: cy, z: b.z + dir[1] * (off + 0.36), yaw: FACE_YAW[face], w: w * 0.88, h: sh * 0.62, color: b.accent, word: rng.int(0, 999) });
      // No built unit under the panel (the face's frame starts at its rect corner: s runs along the face from there).
      if (keep) keep.push({ face, s0: fw / 2 - w / 2 - 0.3, s1: fw / 2 + w / 2 + 0.3, y0: cy - sh / 2 - 0.3, y1: cy + sh / 2 + 0.3 });
    }
  }

  // --- Facade relief on the faces that see a street ---------------------------------------------
  // Relief runs on the full-footprint walls from above the ground-floor band to under the roof edge.
  const yBase = bandTop > 0 ? bandTop + 0.3 : 0.4;
  // Below this the wall is hidden by the ground-floor band and its cap (or, without one, nothing).
  const hiddenBelow = bandTop > 0 ? bandTop + 0.18 : 0;
  const yTop = Math.min(wallTop, topY) - 0.9;
  const wallY1 = kind === 'setback' ? stepY : kind === 'tiers' ? wallY0 + h * 0.65 : kind === 'octagon' || kind === 'podium' ? PODIUM_H : kind === 'twin' ? h : topY;
  const slabStyle = reliefStyle(b);
  const recessStyle = slabStyle && (b.style === 'residential' || b.style === 'artdeco');
  const ledgeStyle = downtown || b.style === 'glass';
  if (yTop > yBase + 3 && streetMask !== 0) {
    // Tints stay close to the wall (a chalk-white strip on dark glass read as a toy): the relief comes from the shadow.
    const glass = b.style === 'glass';
    const ledCol = lighten(base, glass ? 0.2 : 0.34), pierCol = lighten(base, glass ? 0.12 : 0.26);
    const slabCol = lighten(base, 0.4), balSlab = lighten(base, 0.45), rail = darken(base, 0.7);
    // Window bottom as a fraction of the row from the row's top (TextureFactory.windows: wy + wh per style).
    const wyh = b.style === 'glass' ? 0.76 : b.style === 'concrete' ? 0.72 : b.style === 'artdeco' ? 0.8 : 0.7;
    for (let i = 0; i < ol.n; i++) {
      if (!ol.streetEdge(i, streetMask)) continue;
      const fr = ol.edge(i, wallFr);
      const f = ol.face[i];
      if (fr.len < 3) continue;
      const key = b.id * 8 + i;
      // The same layout appendBuilding drew the wall with (its jog / recess flags mirror `facade`'s).
      const lay = f >= 0 ? layoutFace(fr.len, bayW, key, slabStyle && fr.len > LONG_FACE, recessStyle) : layoutFace(fr.len, fr.len, key, false, false);
      if (slabStyle) {
        // Floor slab at every floor line, stepping with the jogs (front and underside; the top is a sliver).
        for (let r = Math.ceil((yBase + 0.5) / rowH); r * rowH < yTop; r++) {
          const y = r * rowH;
          for (let k = 0; k < lay.nSeg; k++) {
            const d = lay.segDepth[k];
            frameBox(gb, fr, lay.segS[k], lay.segS[k + 1], y - SLAB_H, y, -d + 0.02, d + SLAB_OUT, slabCol, true, true, false, false);
          }
        }
      }
      if (cells && f >= 0 && b.style !== 'glass') facadeUnits(cells, keep, b, fr, f, i, lay, mm, wallY0, wallY1, yBase, yTop, hiddenBelow, base);
      if (ledgeStyle) {
        // Spandrel ledge under every window row (0.12 m proud, 0.25 m tall: front and underside) and a pier strip on
        // every bay line (0.18 m proud: front and both flanks). The ledge passes behind the piers.
        for (let r = Math.floor((yBase + 0.3) / rowH) - 1; ; r++) {
          const ys = (r + 1 - wyh) * rowH;
          if (ys > yTop) break;
          if (ys < yBase + 0.3) continue;
          frameBox(gb, fr, 0, fr.len, ys - 0.25, ys, 0, 0.12, ledCol, true, true, false, false);
        }
        if (f >= 0) for (let s = bayW; s < fr.len - 1; s += bayW) frameBox(gb, fr, s - 0.25, s + 0.25, yBase, yTop, 0, 0.18, pierCol, true, false, false, true);
      }
    }
    // Tower shafts standing on a podium / setback keep the piers (no ledges: the shaft is seen from far below).
    if (ledgeStyle && (kind === 'podium' || kind === 'setback') && topY - stepY > 8) {
      const sy0 = stepY + 1.2, sy1 = topY - 0.9;
      for (let f = 0; f < 4; f++) {
        if (((streetMask >> f) & 1) === 0) continue;
        const fr = faceFrame(mm.tx0, mm.tz0, mm.tx1, mm.tz1, f, wallFr);
        for (let s = bayW; s < fr.len - 1; s += bayW) frameBox(gb, fr, s - 0.25, s + 0.25, sy0, sy1, 0, 0.18, pierCol, true, false, false, true);
      }
    }
  }
  if (b.style === 'neon' && wallTop > 12) {
    // Vertical neon fin down the street-facing corner.
    const dir = FACE_DIR[b.facing];
    const off = (alongX ? b.d : b.w) / 2 + 0.2;
    const fx = b.x + dir[0] * off, fz = b.z + dir[1] * off;
    const ex = dir[0] !== 0 ? 0.45 : (b.w / 2) * 0.55;
    const ez = dir[1] !== 0 ? 0.45 : (b.d / 2) * 0.55;
    gb.boxPlain(fx - Math.max(0.3, ex * 0.12), BAND.shopH + 1, fz - Math.max(0.3, ez * 0.12), fx + Math.max(0.3, ex * 0.12), wallTop - 1, fz + Math.max(0.3, ez * 0.12), b.neonColor, false, glowCellFor(b.neonColor));
  }
}
