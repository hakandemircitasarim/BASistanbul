// Building/landmark geometry builders: world-space boxes/tiers/spires with meter UVs and vertex colors. Track B.
import * as THREE from 'three';
import type { Building, BuildingStyle, Landmark } from '../city/CityData';
import { GLOW_U, ROOF_V, WINDOW_TILE_H, WINDOW_TILE_W } from './TextureFactory';

/** Material key for a landmark part: a windowed building style (plain parts use the white strip UV) or 'glow' (emissive neon parts). */
export type LandmarkStyle = BuildingStyle | 'glow';
const GLOW_V = 0.5;
export interface LandmarkPart { geometry: THREE.BufferGeometry; style: LandmarkStyle; /** Part rotates about local X (ferris wheel); geometry centered on the hub. */ rotating: boolean; hubX: number; hubY: number; hubZ: number }

const BASE_Y = -0.2;
const ROOF_DARKEN = 0.62;
const WALL_LIGHTEN = 0.35;
const tmpColor = new THREE.Color();

/** Accumulates indexed quads/triangles with position, normal, uv and color attributes. Build-time only. */
export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private r = 1; private g = 1; private b = 1;
  /** Sibling builder receiving every glow part (rendered with Materials.glow + the glow atlas); null until first used. */
  private glowSide: GeoBuilder | null = null;

  get glow(): GeoBuilder | null { return this.glowSide; }

  /** Builder + plain UV for a part: glow parts go to the sibling builder with atlas UVs, others stay here on the white strip. */
  private plainTarget(glow: number): { b: GeoBuilder; u: number; v: number } {
    if (glow === GLOW_U.none) return { b: this, u: 0.25, v: ROOF_V };
    if (!this.glowSide) this.glowSide = new GeoBuilder();
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
    this.col.push(this.r, this.g, this.b);
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
  cylinder(cx: number, cz: number, rx: number, rz: number, y0: number, y1: number, segments: number, color: number, windows: boolean, top: number | null, glow: number = GLOW_U.none): void {
    const { b, u, v } = this.plainTarget(glow);
    const circ = Math.PI * (rx + rz);
    b.setColor(color);
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
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
        const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
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

/** Appends the building to a builder (box / stepped tiers / box + spire) at world coordinates. */
export function appendBuilding(gb: GeoBuilder, b: Building): void {
  const roof = darken(b.color, ROOF_DARKEN);
  const wall = lighten(b.color, WALL_LIGHTEN);
  // Per-building whole-window UV offsets so buildings sharing a style texture do not share the lit pattern.
  const uOff = ((b.id * 7) % 4) / 4, vOff = ((b.id * 13) % 8) / 8;
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  if (b.roofKind === 'stepped' && b.h > 9) {
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
