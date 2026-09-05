// Building/landmark geometry builders: world-space boxes/tiers/spires with meter UVs and vertex colors. Track B.
import * as THREE from 'three';
import type { Building, BuildingStyle, Landmark } from '../city/CityData';
import type { Random } from '../core/Random';
import { GLOW_U, PLINTH_BAND_H, PLINTH_TILE_W, ROOF_V, SHOP_BAND_H, SHOP_TILE_W, WINDOW_TILE_H, WINDOW_TILE_W } from './TextureFactory';

/** Material key for a landmark part: a windowed building style (plain parts use the white strip UV) or 'glow' (emissive neon parts). */
export type LandmarkStyle = BuildingStyle | 'glow';
const GLOW_V = 0.5;
export interface LandmarkPart { geometry: THREE.BufferGeometry; style: LandmarkStyle; /** Part rotates about local X (ferris wheel); geometry centered on the hub. */ rotating: boolean; hubX: number; hubY: number; hubZ: number }

const BASE_Y = -0.2;
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
const tmpColor = new THREE.Color();

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

  /** Box with window UVs in meters on the sides and the plain strip on top (no bottom). */
  boxWindows(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, wall: number, roof: number, uOff = 0, vOff = 0): void {
    const TW = WINDOW_TILE_W, TH = WINDOW_TILE_H;
    const va = y0 / TH + vOff, vb = y1 / TH + vOff;
    const ux = (x1 - x0) / TW, uz = (z1 - z0) / TW;
    this.setColor(wall);
    // +Z face (south): u along +X
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, uOff, va, uOff + ux, va, uOff + ux, vb, uOff, vb);
    // -Z face (north): u along -X
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, uOff + 0.25, va, uOff + 0.25 + ux, va, uOff + 0.25 + ux, vb, uOff + 0.25, vb);
    // +X face (east): u along -Z
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, uOff + 0.5, va, uOff + 0.5 + uz, va, uOff + 0.5 + uz, vb, uOff + 0.5, vb);
    // -X face (west): u along +Z
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, uOff + 0.75, va, uOff + 0.75 + uz, va, uOff + 0.75 + uz, vb, uOff + 0.75, vb);
    this.setColor(roof);
    this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, 0.5, ROOF_V, 0.5, ROOF_V, 0.5, ROOF_V, 0.5, ROOF_V);
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

  /** Four vertical faces of a street-level band: u repeats every `tileW` meters along the face, v spans 0..1 over the band height. */
  bandBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tileW: number, color: number, uOff = 0): void {
    const ux = (x1 - x0) / tileW, uz = (z1 - z0) / tileW;
    this.setColor(color);
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, uOff, 0, uOff + ux, 0, uOff + ux, 1, uOff, 1);
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, uOff + 0.25, 0, uOff + 0.25 + ux, 0, uOff + 0.25 + ux, 1, uOff + 0.25, 1);
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, uOff + 0.5, 0, uOff + 0.5 + uz, 0, uOff + 0.5 + uz, 1, uOff + 0.5, 1);
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, uOff + 0.75, 0, uOff + 0.75 + uz, 0, uOff + 0.75 + uz, 1, uOff + 0.75, 1);
  }

  /** Four-sided pyramid over the rectangle x0..x1 / z0..z1 from y0 to apexY. */
  pyramid(x0: number, z0: number, x1: number, z1: number, y0: number, apexY: number, color: number): void {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, u = 0.5, v = ROOF_V;
    this.setColor(color);
    this.tri(x0, y0, z1, x1, y0, z1, cx, apexY, cz, u, v);
    this.tri(x1, y0, z0, x0, y0, z0, cx, apexY, cz, u, v);
    this.tri(x1, y0, z1, x1, y0, z0, cx, apexY, cz, u, v);
    this.tri(x0, y0, z0, x0, y0, z1, cx, apexY, cz, u, v);
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
      b.quad(bx, y0, bz, ax, y0, az, ax, y1, az, bx, y1, bz, nx, 0, nz, ua, va, ub, va, ub, vb, ua, vb);
    }
    if (top !== null) {
      b.setColor(top);
      for (let i = 0; i < segments; i++) {
        const a0 = phase + (i / segments) * Math.PI * 2, a1 = phase + ((i + 1) / segments) * Math.PI * 2;
        b.tri(cx, y1, cz, cx + Math.cos(a0) * rx, y1, cz + Math.sin(a0) * rz, cx + Math.cos(a1) * rx, y1, cz + Math.sin(a1) * rz, u, v);
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

/**
 * Massing of one building, decided from its id so the render is deterministic and the same plan feeds the base
 * geometry (appendBuilding) and the dressing (appendBuildingDetail). Downtown towers cycle four silhouettes; low
 * buildings vary their roofline; stepped roofs alternate concentric tiers and a one-sided setback.
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
}
const massingOut: Massing = { kind: 'box', tx0: 0, tz0: 0, tx1: 0, tz1: 0, top: 0, wallTop: 0, stepY: 0, roofVariant: 0 };

/** Fills `massingOut` for the building (shared scratch: copy the fields you need before calling it again). */
export function massingOf(b: Building): Massing {
  const m = massingOut;
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  m.tx0 = x0; m.tz0 = z0; m.tx1 = x1; m.tz1 = z1; m.top = b.h; m.wallTop = b.h; m.stepY = 0; m.roofVariant = 0;
  const tower = b.district === 'downtown' && b.h > 40 && b.roofKind === 'flat';
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
      const tiers = b.h > 40 ? 3 : 2;
      const inset = Math.min(b.w, b.d) * 0.14 * (tiers - 1);
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

/** Appends the building to a builder (box / stepped tiers / one-sided setback / podium variants / box + spire) at world coordinates. */
export function appendBuilding(gb: GeoBuilder, b: Building): void {
  const roof = darken(b.color, ROOF_DARKEN);
  const wall = lighten(b.color, WALL_LIGHTEN);
  // Per-building whole-window UV offsets so buildings sharing a style texture do not share the lit pattern.
  const uOff = ((b.id * 7) % 4) / 4, vOff = ((b.id * 13) % 8) / 8;
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  const m = massingOf(b);
  if (m.kind === 'tiers') {
    const tiers = b.h > 40 ? 3 : 2;
    const fr = tiers === 3 ? [0.55, 0.3, 0.15] : [0.65, 0.35];
    let y = BASE_Y;
    let inset = 0;
    for (let t = 0; t < tiers; t++) {
      const y1 = t === tiers - 1 ? b.h : y + b.h * fr[t];
      gb.boxWindows(x0 + inset, y, z0 + inset, x1 - inset, y1, z1 - inset, wall, roof, uOff, vOff);
      if (b.style === 'artdeco') gb.boxPlain(x0 + inset - 0.4, y1 - 0.5, z0 + inset - 0.4, x1 - inset + 0.4, y1, z1 - inset + 0.4, roof);
      y = y1;
      inset += Math.min(b.w, b.d) * 0.14;
    }
  } else if (m.kind === 'setback') {
    gb.boxWindows(x0, BASE_Y, z0, x1, m.stepY, z1, wall, roof, uOff, vOff);
    gb.boxWindows(m.tx0, m.stepY, m.tz0, m.tx1, b.h, m.tz1, wall, roof, uOff, vOff);
    if (b.style === 'artdeco') {
      gb.boxPlain(x0 - 0.4, m.stepY - 0.5, z0 - 0.4, x1 + 0.4, m.stepY, z1 + 0.4, roof);
      gb.boxPlain(m.tx0 - 0.4, b.h - 0.5, m.tz0 - 0.4, m.tx1 + 0.4, b.h, m.tz1 + 0.4, roof);
    }
  } else if (m.kind === 'octagon') {
    gb.boxWindows(x0, BASE_Y, z0, x1, PODIUM_H, z1, wall, roof, uOff, vOff);
    const rx = (b.w / 2 - 0.4) / Math.cos(OCT), rz = (b.d / 2 - 0.4) / Math.cos(OCT);
    gb.cylinder(b.x, b.z, rx, rz, PODIUM_H, b.h, 8, wall, true, roof, GLOW_U.none, OCT);
  } else if (m.kind === 'podium') {
    gb.boxWindows(x0, BASE_Y, z0, x1, PODIUM_H, z1, wall, roof, uOff, vOff);
    gb.boxWindows(m.tx0, PODIUM_H, m.tz0, m.tx1, b.h, m.tz1, wall, roof, uOff, vOff);
  } else {
    gb.boxWindows(x0, BASE_Y, z0, x1, b.h, z1, wall, roof, uOff, vOff);
    if (b.style === 'artdeco') gb.boxPlain(x0 - 0.4, b.h - 0.5, z0 - 0.4, x1 + 0.4, b.h, z1 + 0.4, roof);
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

/** Street-level band geometry constants: band heights come from the band textures, `out` is how far the band steps in front of the wall. */
export const BAND = { shopH: SHOP_BAND_H, shopTile: SHOP_TILE_W, shopOut: 0.16, plinthH: PLINTH_BAND_H, plinthTile: PLINTH_TILE_W, plinthOut: 0.34 } as const;

const FACE_DIR: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const FACE_YAW = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const AWNING_COLORS: [number, number][] = [[0xd83b46, 0xf0e6d8], [0x1f7a5a, 0xf0e6d8], [0x2a5aa8, 0xf0e6d8], [0xe07a1f, 0x3a2a20], [0x8a2f70, 0xf0e6d8]];

/** Nearest glow-atlas cell for an accent color (used by crowns and neon fins). */
function glowCellFor(color: number): number {
  const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
  if (r > 190 && b > 150 && g < 140) return GLOW_U.magenta;
  if (b > 190 && g > 150 && r < 140) return GLOW_U.cyan;
  if (r > 190 && g > 190 && b < 140) return GLOW_U.yellow;
  if (g > 190 && r < 150) return GLOW_U.green;
  return GLOW_U.orange;
}

/**
 * Ground floor: a band in front of the wall (shopfront glazing or downtown stone plinth) plus a cornice cap in the
 * building mesh, and fabric awnings over the shop bays on the street-facing side.
 */
export function appendStreetLevel(styleGb: GeoBuilder, bandGb: GeoBuilder, b: Building, rng: Random, plinthStyle: boolean): void {
  const out = plinthStyle ? BAND.plinthOut : BAND.shopOut;
  const tile = plinthStyle ? BAND.plinthTile : BAND.shopTile;
  const h = Math.min(plinthStyle ? BAND.plinthH : BAND.shopH, Math.max(3, b.h - 2.5));
  const x0 = b.x - b.w / 2 - out, x1 = b.x + b.w / 2 + out, z0 = b.z - b.d / 2 - out, z1 = b.z + b.d / 2 + out;
  // Slight tint from the building color so blocks do not all share one shopfront hue.
  const tintK = plinthStyle ? 0.62 : 0.78;
  bandGb.bandBox(x0, 0, z0, x1, h, z1, tile, lighten(b.color, tintK));
  // Cornice capping the band (also hides the step back to the wall).
  const cap = lighten(b.color, plinthStyle ? 0.3 : 0.55);
  styleGb.boxPlain(x0 - 0.18, h - 0.32, z0 - 0.18, x1 + 0.18, h + 0.16, z1 + 0.18, cap);
  if (plinthStyle) return;
  const face = b.facing;
  const along = face === 0 || face === 2 ? b.w : b.d;
  if (along < 6) return;
  const dir = FACE_DIR[face];
  const nx = dir[0], nz = dir[1];
  const tx = nz, tz = -nx;
  const wall = (face === 0 || face === 2 ? b.d : b.w) / 2 + out;
  const pal = AWNING_COLORS[rng.int(0, AWNING_COLORS.length - 1)];
  const segs = 4;
  const yTop = h - 0.85, yOut = yTop - 0.5, depth = 1.35, hang = 0.42;
  const span = along - 1.2;
  const px = (t: number, o: number): number => b.x + tx * t + nx * o;
  const pz = (t: number, o: number): number => b.z + tz * t + nz * o;
  for (let i = 0; i < segs; i++) {
    const t0 = -span / 2 + (span * i) / segs, t1 = -span / 2 + (span * (i + 1)) / segs;
    const c = i % 2 === 0 ? pal[0] : pal[1];
    styleGb.plainQuad(px(t0, wall), yTop, pz(t0, wall), px(t1, wall), yTop, pz(t1, wall),
      px(t1, wall + depth), yOut, pz(t1, wall + depth), px(t0, wall + depth), yOut, pz(t0, wall + depth), c, true);
    styleGb.plainQuad(px(t0, wall + depth), yOut, pz(t0, wall + depth), px(t1, wall + depth), yOut, pz(t1, wall + depth),
      px(t1, wall + depth), yOut - hang, pz(t1, wall + depth), px(t0, wall + depth), yOut - hang, pz(t0, wall + depth), c, true);
  }
}

/** Coping band around a roof edge: 0.3 m overhang, 0.6 m deep, a shade darker than the wall so the roofline reads as a solid edge. */
function parapetBand(gb: GeoBuilder, x0: number, z0: number, x1: number, z1: number, top: number, wall: number): void {
  gb.boxPlain(x0 - 0.3, top - 0.6, z0 - 0.3, x1 + 0.3, top - 0.02, z1 + 0.3, darken(wall, 0.85));
}

/** Low parapet walls standing on the coping (skipped on tiny roofs). */
function parapetWalls(gb: GeoBuilder, x0: number, z0: number, x1: number, z1: number, top: number, ph: number, cap: number): void {
  if (x1 - x0 <= 4 || z1 - z0 <= 4) return;
  const t = 0.4;
  gb.boxPlain(x0 - 0.25, top - 0.15, z0 - 0.25, x1 + 0.25, top + ph, z0 + t, cap);
  gb.boxPlain(x0 - 0.25, top - 0.15, z1 - t, x1 + 0.25, top + ph, z1 + 0.25, cap);
  gb.boxPlain(x0 - 0.25, top - 0.15, z0 + t, x0 + t, top + ph, z1 - t, cap);
  gb.boxPlain(x1 - t, top - 0.15, z0 + t, x1 + 0.25, top + ph, z1 - t, cap);
}

/** Plant room / AC enclosure with a louvre screen (two dark slats around it). */
function plantBox(gb: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): void {
  gb.boxPlain(x0, y0, z0, x1, y1, z1, color);
  const slat = darken(color, 0.55), o = 0.06;
  const ya = y0 + (y1 - y0) * 0.35, yb = y0 + (y1 - y0) * 0.65;
  gb.boxPlain(x0 - o, ya - 0.08, z0 - o, x1 + o, ya + 0.08, z1 + o, slat);
  gb.boxPlain(x0 - o, yb - 0.08, z0 - o, x1 + o, yb + 0.08, z1 + o, slat);
}

/** Roof clutter, parapets, pilasters, ledges, crowns and blank-wall sign panels for one building (all plain-strip geometry). */
export function appendBuildingDetail(gb: GeoBuilder, b: Building, rng: Random, signs: WallSign[]): void {
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  const roof = darken(b.color, ROOF_DARKEN);
  const wall = lighten(b.color, WALL_LIGHTEN);
  const h = b.h;
  const downtown = b.district === 'downtown';
  const mm = massingOf(b);
  const kind = mm.kind, wallTop = mm.wallTop, stepY = mm.stepY, roofVariant = mm.roofVariant;
  let rx0 = mm.tx0, rx1 = mm.tx1, rz0 = mm.tz0, rz1 = mm.tz1;
  const top = mm.top;
  const uOff = ((b.id * 7) % 4) / 4, vOff = ((b.id * 13) % 8) / 8;
  const alongX = b.facing === 0 || b.facing === 2;
  const cap = lighten(b.color, 0.28);
  const ph = downtown ? 1.05 : 0.8;

  // --- Massing extras stacked on the base box --------------------------------------------------
  if (kind === 'twin') {
    // Two more tiers, each pulled back from the street and the sides; the crown then sits on the top one.
    const t1 = h + 2 * FLOOR_H;
    parapetBand(gb, x0, z0, x1, z1, h, wall);
    twinRect(b, 1, mm);
    gb.boxWindows(mm.tx0, h, mm.tz0, mm.tx1, t1, mm.tz1, wall, roof, uOff, vOff);
    parapetBand(gb, mm.tx0, mm.tz0, mm.tx1, mm.tz1, t1, wall);
    twinRect(b, 2, mm);
    gb.boxWindows(mm.tx0, t1, mm.tz0, mm.tx1, top, mm.tz1, wall, roof, uOff, vOff);
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
    parapetBand(gb, x0, z0, x1, z1, h, wall);
    parapetWalls(gb, x0, z0, x1, z1, h, ph, cap);
    gb.boxWindows(wx0, h, wz0, wx1, wingH, wz1, wall, roof, uOff, vOff);
    parapetBand(gb, wx0, wz0, wx1, wz1, wingH, wall);
    parapetWalls(gb, wx0, wz0, wx1, wz1, wingH, ph, cap);
    // Clutter goes on the lower roof, away from the wing.
    if (alongX) { if (b.facing === 0) rz1 = wz0; else rz0 = wz1; } else if (b.facing === 1) rx1 = wx0; else rx0 = wx1;
  } else if (kind === 'box' && roofVariant === 2 && b.w > 12 && b.d > 12 && b.roofKind === 'flat') {
    // Penthouse box on 35% of the footprint, pushed to the back of the roof.
    const pw = Math.max(6, b.w * 0.6), pd = Math.max(5, b.d * 0.58);
    let px0 = b.x - pw / 2, pz0 = b.z - pd / 2;
    if (b.facing === 0) pz0 = z0 + 1.2; else if (b.facing === 2) pz0 = z1 - 1.2 - pd; else if (b.facing === 1) px0 = x0 + 1.2; else px0 = x1 - 1.2 - pw;
    gb.boxWindows(px0, h, pz0, px0 + pw, h + FLOOR_H, pz0 + pd, wall, roof, uOff, vOff);
    parapetBand(gb, px0, pz0, px0 + pw, pz0 + pd, h + FLOOR_H, wall);
    parapetBand(gb, x0, z0, x1, z1, h, wall);
    parapetWalls(gb, x0, z0, x1, z1, h, ph, cap);
    if (b.facing === 0) rz0 = pz0 + pd; else if (b.facing === 2) rz1 = pz0; else if (b.facing === 1) rx0 = px0 + pw; else rx1 = px0;
  } else if (kind === 'octagon') {
    // Chamfered shaft: a coping ring on the podium edge and on the shaft top.
    parapetBand(gb, x0, z0, x1, z1, PODIUM_H, wall);
    const rx = (b.w / 2 - 0.4) / Math.cos(OCT), rz = (b.d / 2 - 0.4) / Math.cos(OCT);
    gb.cylinder(b.x, b.z, rx + 0.3, rz + 0.3, h - 0.6, h - 0.02, 8, darken(wall, 0.85), false, darken(wall, 0.85), GLOW_U.none, OCT);
    const k = 0.62;
    rx0 = b.x - (b.w / 2) * k; rx1 = b.x + (b.w / 2) * k; rz0 = b.z - (b.d / 2) * k; rz1 = b.z + (b.d / 2) * k;
  } else if (kind === 'podium') {
    parapetBand(gb, x0, z0, x1, z1, PODIUM_H, wall);
    parapetWalls(gb, x0, z0, x1, z1, PODIUM_H, ph, cap);
    parapetBand(gb, rx0, rz0, rx1, rz1, h, wall);
  } else if (kind === 'setback') {
    parapetBand(gb, x0, z0, x1, z1, stepY, wall);
    parapetBand(gb, rx0, rz0, rx1, rz1, h, wall);
    parapetWalls(gb, rx0, rz0, rx1, rz1, h, ph, cap);
  } else if (b.roofKind !== 'spire') {
    parapetBand(gb, rx0, rz0, rx1, rz1, top, wall);
    parapetWalls(gb, rx0, rz0, rx1, rz1, top, ph, cap);
  }
  const rw = rx1 - rx0, rd = rz1 - rz0;
  const crown = top > 42 && b.roofKind !== 'spire';

  // --- Roof clutter -----------------------------------------------------------------------------
  if (b.roofKind !== 'spire' && rw > 9 && rd > 9 && !crown) {
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const cx = rng.range(rx0 + 2.2, rx1 - 2.2), cz = rng.range(rz0 + 2.2, rz1 - 2.2);
      const kindR = rng.int(0, 3);
      if (kindR === 0) {
        // Water tank on a short cradle.
        gb.boxPlain(cx - 1.15, top, cz - 1.15, cx + 1.15, top + 0.65, cz + 1.15, 0x5f5a55);
        gb.cylinder(cx, cz, 1.2, 1.2, top + 0.65, top + 3.1, 8, 0x8a6742, false, 0x6d5238);
      } else if (kindR === 1) {
        const m = rng.int(1, 2);
        for (let k = 0; k < m; k++) {
          const ox = cx + k * 2.2;
          if (ox + 0.95 > rx1) break;
          gb.boxPlain(ox - 0.95, top, cz - 0.65, ox + 0.95, top + 0.95, cz + 0.65, 0xacb2b8);
          gb.boxPlain(ox - 0.7, top + 0.95, cz - 0.45, ox + 0.7, top + 1.05, cz + 0.45, 0x8b9198);
        }
      } else if (kindR === 2) {
        // Roof access box with a door.
        gb.boxPlain(cx - 1.5, top, cz - 1.25, cx + 1.5, top + 2.5, cz + 1.25, lighten(roof, 0.3));
        gb.boxPlain(cx - 0.55, top, cz + 1.25, cx + 0.55, top + 1.8, cz + 1.4, 0x39332c);
      } else {
        gb.cylinder(cx, cz, 0.36, 0.36, top, top + 1.5, 6, 0x9aa0a6, false, 0x767c82);
        gb.cylinder(cx + 1.3, cz + 0.9, 0.28, 0.28, top, top + 1.05, 6, 0x9aa0a6, false, 0x767c82);
      }
    }
  }
  // Plant / AC enclosure on one roof in three.
  if (b.roofKind !== 'spire' && rw > 8 && rd > 8 && !crown && rng.chance(1 / 3)) {
    const cx = rng.range(rx0 + 2.5, rx1 - 2.5), cz = rng.range(rz0 + 2.2, rz1 - 2.2);
    plantBox(gb, cx - 1.5, top, cz - 1.25, cx + 1.5, top + 2, cz + 1.25, 0x9a948c);
  }
  if (top > 26 && top <= 42 && b.roofKind !== 'spire' && rng.chance(0.5)) {
    const ax = (rx0 + rx1) / 2 + rng.range(-rw * 0.22, rw * 0.22), az = (rz0 + rz1) / 2 + rng.range(-rd * 0.22, rd * 0.22);
    const mastTop = top + rng.range(5, 13);
    gb.bar(ax, top, az, ax, mastTop, az, 0.34, 0xb0b4ba);
    for (let k = 0; k < 3; k++) {
      const y = top + (mastTop - top) * (0.42 + k * 0.18);
      gb.bar(ax - 1.2, y, az, ax + 1.2, y, az, 0.2, 0xb0b4ba);
    }
    gb.boxPlain(ax - 0.2, mastTop, az - 0.2, ax + 0.2, mastTop + 0.55, az + 0.2, 0xff2418, false, GLOW_U.red);
  }

  // --- Facade dressing --------------------------------------------------------------------------
  if (downtown && kind === 'box' && b.roofKind === 'flat' && h >= 26) {
    // Vertical pilaster strips running the full shaft.
    const yb = BAND.plinthH + 0.3, yt = h - 1.4, t = 0.3, hw = 0.6, col = lighten(b.color, 0.5);
    if (yt > yb + 4) {
      const nX = Math.max(1, Math.round(b.w / 8) - 1);
      for (let i = 1; i <= nX; i++) {
        const px = x0 + (b.w * i) / (nX + 1);
        gb.boxPlain(px - hw, yb, z0 - t, px + hw, yt, z0, col);
        gb.boxPlain(px - hw, yb, z1, px + hw, yt, z1 + t, col);
      }
      const nZ = Math.max(1, Math.round(b.d / 8) - 1);
      for (let i = 1; i <= nZ; i++) {
        const pz = z0 + (b.d * i) / (nZ + 1);
        gb.boxPlain(x0 - t, yb, pz - hw, x0, yt, pz + hw, col);
        gb.boxPlain(x1, yb, pz - hw, x1 + t, yt, pz + hw, col);
      }
    }
  }
  if (crown) {
    // Crown: a 1.2 m overhanging slab under the roof edge, a deep accent band that glows at night, a mechanical
    // penthouse with a louvre screen on the roof, and a spire on one tower in four.
    const slab = lighten(b.color, 0.32), accent = darken(b.accent, 0.72), glow = glowCellFor(b.accent);
    if (kind === 'octagon') {
      const rx = (b.w / 2 - 0.4) / Math.cos(OCT), rz = (b.d / 2 - 0.4) / Math.cos(OCT);
      gb.cylinder(b.x, b.z, rx + 1.2, rz + 1.2, top - 1.1, top - 0.02, 8, slab, false, slab, GLOW_U.none, OCT);
      gb.cylinder(b.x, b.z, rx + 0.5, rz + 0.5, top - 3.6, top - 1.1, 8, accent, false, null, glow, OCT);
    } else {
      gb.boxPlain(rx0 - 1.2, top - 1.1, rz0 - 1.2, rx1 + 1.2, top - 0.02, rz1 + 1.2, slab);
      gb.boxPlain(rx0 - 0.5, top - 3.6, rz0 - 0.5, rx1 + 0.5, top - 1.1, rz1 + 0.5, accent, false, glow);
    }
    const mw = rw * 0.4, md = rd * 0.4, mx = (rx0 + rx1) / 2, mz = (rz0 + rz1) / 2;
    if (mw > 3 && md > 3) plantBox(gb, mx - mw / 2, top, mz - md / 2, mx + mw / 2, top + 4, mz + md / 2, darken(b.color, 0.7));
    if (b.id % 4 === 2) {
      const sh = Math.max(10, top * 0.14);
      gb.bar(mx, top + 4, mz, mx, top + 4 + sh, mz, 0.7, 0xb0b4ba);
      gb.bar(mx, top + 4 + sh, mz, mx, top + 4 + sh + 3, mz, 0.3, 0xd0d4da);
      gb.boxPlain(mx - 0.25, top + 6.9 + sh, mz - 0.25, mx + 0.25, top + 7.5 + sh, mz + 0.25, 0xff2418, false, GLOW_U.red);
    }
  }
  if (b.style === 'artdeco' && !downtown) {
    // Balcony ledges every couple of floors, with a rail on the street side.
    const led = lighten(b.color, 0.5);
    const dir = FACE_DIR[b.facing];
    const front = (alongX ? b.d : b.w) / 2;
    let band = 0;
    for (let y = 7; y < wallTop - 3.5; y += 6.5) {
      gb.boxPlain(x0 - 0.5, y, z0 - 0.5, x1 + 0.5, y + 0.34, z1 + 0.5, led);
      if (band < 3) {
        const o = front + 0.5, oi = front + 0.14;
        if (dir[0] === 0) gb.boxPlain(x0 - 0.3, y + 0.34, b.z + dir[1] * oi, x1 + 0.3, y + 1.05, b.z + dir[1] * o, darken(b.color, 0.8));
        else gb.boxPlain(b.x + dir[0] * oi, y + 0.34, z0 - 0.3, b.x + dir[0] * o, y + 1.05, z1 + 0.3, darken(b.color, 0.8));
      }
      band++;
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
  if (b.style === 'residential' || b.style === 'concrete') {
    // A string course splitting the facade, plus a chimney-ish vent block.
    if (wallTop > 13) gb.boxPlain(x0 - 0.35, wallTop * 0.5, z0 - 0.35, x1 + 0.35, wallTop * 0.5 + 0.3, z1 + 0.35, lighten(b.color, 0.45));
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
      const panel = darken(b.color, 0.45);
      if (dir[0] === 0) {
        const zf = b.z + dir[1] * off;
        gb.boxPlain(b.x - w / 2, cy - sh / 2, Math.min(zf, zf + dir[1] * 0.28), b.x + w / 2, cy + sh / 2, Math.max(zf, zf + dir[1] * 0.28), panel);
      } else {
        const xf = b.x + dir[0] * off;
        gb.boxPlain(Math.min(xf, xf + dir[0] * 0.28), cy - sh / 2, b.z - w / 2, Math.max(xf, xf + dir[0] * 0.28), cy + sh / 2, b.z + w / 2, panel);
      }
      signs.push({ x: b.x + dir[0] * (off + 0.36), y: cy, z: b.z + dir[1] * (off + 0.36), yaw: FACE_YAW[face], w: w * 0.88, h: sh * 0.62, color: b.accent, word: rng.int(0, 999) });
    }
  }
}
