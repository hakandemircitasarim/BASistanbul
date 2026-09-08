// Procedural CanvasTexture factory (windows, shopfronts, road, sidewalk, sand, water, grass, plaza, neon atlas, fronds, glows, clouds, stars), cached by key. Track B.
import * as THREE from 'three';
import type { BuildingStyle } from '../city/CityData';
import { Random } from '../core/Random';

export interface WindowTextures { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture; normal: THREE.CanvasTexture; rough: THREE.CanvasTexture }
export interface AtlasRect { u0: number; v0: number; u1: number; v1: number }

/** Window tile: 16 m x 28 m, drawn in a 1024 x 2048 design space (1024 x 1024 for the curtain-wall styles); the top ROOF_STRIP_PX of every WINDOW_TILE_PX_H (v > 0.98) are a plain wall color used by roofs and plain parts. */
export const WINDOW_TILE_W = 16;
export const WINDOW_TILE_H = 28;
export const WINDOW_TILE_PX_H = 1024;
export const ROOF_STRIP_PX = 20;
/** UV v of the plain strip center (used by roofs/landmark plain parts). */
export const ROOF_V = 1 - ROOF_STRIP_PX / 2 / WINDOW_TILE_PX_H;
/** UV u of a cell in the glow atlas (see glowAtlas()): cell 0 is non-emissive, the rest are night-glow colors. Glow parts use their own material. */
export const GLOW_U = { none: 0.0625, magenta: 0.1875, cyan: 0.3125, yellow: 0.4375, orange: 0.5625, red: 0.6875, green: 0.8125, white: 0.9375 } as const;
const GLOW_CELLS: number[] = [0x000000, 0xff2d95, 0x00e5ff, 0xfff03b, 0xff7a00, 0xff2418, 0x2bff6a, 0xf0f4ff];
export const ROAD_TILE_M = 14;
/** Street-level band tiles: the ground-floor shopfront (beach/suburb) and the downtown lobby plinth. u repeats every TILE_W m, v spans the band height exactly (one atlas row for the shopfront). The shop tile carries a pier on every SHOP_BAY_W, where BuildingGeometry's arcade columns stand. */
export const SHOP_TILE_W = 24;
export const SHOP_BAND_H = 4.2;
/** Rows of the shopfront atlas: every row is one 24 m tile of four SHOP_BAY_W bays, so v spans 1 / SHOP_ROWS per row. */
export const SHOP_ROWS = 3;
export const SHOP_BAY_W = 6;
/** Height (m) where the glazing ends and the fascia board starts: the geometry splits the band there so the fascia takes its own tint. */
export const SHOP_FASCIA_Y = 3.1;
/** Width (m) of a shop bay's door cell (BuildingGeometry recesses it into the wall). */
export const SHOP_DOOR_W = 1.3;
/** UV of a plain dark cell of the shopfront atlas (the stall riser of the bottom row): door reveals and soffits sample it under a vertex tint. */
export const SHOP_PLAIN_UV = { u: 0.5, v: 0.17 / SHOP_BAND_H / SHOP_ROWS } as const;
export const PLINTH_TILE_W = 24;
export const PLINTH_BAND_H = 6;
/** The plinth tile holds PLINTH_BAYS equal bays; bay PLINTH_DOOR_BAY (0-based) is the double-door entrance the geometry hangs a canopy over. */
export const PLINTH_BAYS = 5;
export const PLINTH_DOOR_BAY = 2;
export type ShopKind = 'bakkal' | 'eczane' | 'kebap' | 'kuafor' | 'shutter' | 'simit' | 'market' | 'vacant' | 'butik' | 'kahve' | 'lokanta' | 'manav';
/** One 6 m bay of the shopfront atlas: what stands in it, where its door cell starts (m from the bay's left pier, -1 = no door: the shutter is down) and how the fascia is built (painted board / lit sign box / timber board). */
export interface ShopBay { name: string; kind: ShopKind; door: number; sign: 'board' | 'lightbox' | 'wood' | 'none' }
/**
 * Bays of the shopfront atlas in atlas order (row = index / 4, column = index % 4): ten glazed shops, a bay under a
 * rolled shutter and a whitewashed vacant unit. Every bay is SHOP_BAY_W wide with a stone pier on its left edge, so
 * the arcade columns fall on piers whatever bay a facade starts at. Exported so the geometry can deal the bays out per
 * face, recess each door cell, hang an awning per shop and a sign board on the cafe.
 */
export const SHOP_BAYS: readonly ShopBay[] = [
  { name: 'BAKKAL', kind: 'bakkal', door: 4.4, sign: 'board' },
  { name: 'ECZANE', kind: 'eczane', door: 0.3, sign: 'lightbox' },
  { name: 'KEBAP', kind: 'kebap', door: 4.4, sign: 'lightbox' },
  { name: 'KUAFÖR', kind: 'kuafor', door: 2.35, sign: 'board' },
  { name: 'BERBER', kind: 'shutter', door: -1, sign: 'board' },
  { name: 'SİMİT', kind: 'simit', door: 4.4, sign: 'wood' },
  { name: 'MARKET', kind: 'market', door: 0.3, sign: 'lightbox' },
  { name: 'KİRALIK', kind: 'vacant', door: 4.4, sign: 'none' },
  { name: 'BUTİK', kind: 'butik', door: 2.35, sign: 'board' },
  { name: 'KAHVE', kind: 'kahve', door: 0.3, sign: 'wood' },
  { name: 'LOKANTA', kind: 'lokanta', door: 4.4, sign: 'lightbox' },
  { name: 'MANAV', kind: 'manav', door: 0.3, sign: 'board' },
];
/** Road-marking atlas cells (u0,v0,u1,v1): forward arrow, forward+left, forward+right, plain white bar. */
export const MARK_UV = {
  ahead: { u0: 0, v0: 0.5, u1: 0.5, v1: 1 },
  left: { u0: 0.5, v0: 0.5, u1: 1, v1: 1 },
  right: { u0: 0, v0: 0, u1: 0.5, v1: 0.5 },
  bar: { u0: 0.5, v0: 0, u1: 1, v1: 0.5 },
} as const;

function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}

/** Neutral grey at luminance l (0..1), for painting roughness maps directly. */
function grey(l: number): string {
  const v = Math.round(255 * Math.min(1, Math.max(0, l)));
  return rgba(v, v, v, 1);
}

/** Mixes toward white (k > 0) for texture-side highlights. */
function tint(c: number, k: number): string {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  if (k >= 0) return rgba(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k, 1);
  return rgba(r * (1 + k), g * (1 + k), b * (1 + k), 1);
}

export class TextureFactory {
  private readonly cache = new Map<string, THREE.Texture>();
  private atlasRects: Map<string, AtlasRect> | null = null;

  private canvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    // willReadFrequently: the normal and roughness generators read every one of these canvases back with getImageData.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas unavailable');
    return { canvas, ctx };
  }

  private finish(key: string, canvas: HTMLCanvasElement, srgb: boolean, repeat = true, clampV = false): THREE.CanvasTexture {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.wrapT = repeat && !clampV ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 8;
    t.needsUpdate = true;
    this.cache.set(key, t);
    return t;
  }

  /**
   * Bleeds colour outwards into fully transparent pixels, leaving alpha untouched. Mipmapping averages RGB and alpha
   * independently, so a shape drawn on a cleared (transparent black) canvas darkens towards black in the lower mips
   * and an alpha-tested material grows black fringes at distance. Filling the empty pixels with the neighbouring
   * colour removes them without changing the silhouette.
   */
  private bleedAlpha(ctx: CanvasRenderingContext2D, W: number, H: number, passes: number): void {
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const n = W * H;
    const filled = new Uint8Array(n);
    for (let i = 0; i < n; i++) filled[i] = d[i * 4 + 3] > 0 ? 1 : 0;
    const added: number[] = [];
    for (let p = 0; p < passes; p++) {
      added.length = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const k = y * W + x;
          if (filled[k]) continue;
          let r = 0, g = 0, b = 0, c = 0;
          for (let oy = -1; oy <= 1; oy++) {
            const yy = y + oy;
            if (yy < 0 || yy >= H) continue;
            for (let ox = -1; ox <= 1; ox++) {
              const xx = x + ox;
              if (xx < 0 || xx >= W) continue;
              const j = yy * W + xx;
              if (!filled[j]) continue;
              r += d[j * 4]; g += d[j * 4 + 1]; b += d[j * 4 + 2]; c++;
            }
          }
          if (!c) continue;
          d[k * 4] = r / c; d[k * 4 + 1] = g / c; d[k * 4 + 2] = b / c;
          added.push(k);
        }
      }
      if (!added.length) break;
      for (let i = 0; i < added.length; i++) filled[added[i]] = 1;
    }
    ctx.putImageData(img, 0, 0);
  }

  private noise(ctx: CanvasRenderingContext2D, w: number, h: number, rng: Random, count: number, size: number, alpha: number, light: boolean): void {
    for (let i = 0; i < count; i++) {
      const v = light ? 255 : 0;
      ctx.fillStyle = rgba(v, v, v, alpha * rng.next());
      ctx.fillRect(rng.range(0, w), rng.range(0, h), size, size);
    }
  }

  /**
   * Soft tonal mottle: overlapping radial gradients of low alpha (drawn wrapped so the tile stays seamless) plus a
   * 1 px grain that vanishes in the first mip. This replaces the 2 px speckle that used to sit on every surface -
   * speckle reads as video static at any distance, a mottle reads as render, stucco or aggregate.
   */
  private mottle(ctx: CanvasRenderingContext2D, W: number, H: number, rng: Random, count: number, rMin: number, rMax: number, alpha: number, grain: number, grainAlpha: number, warm: boolean): void {
    for (let i = 0; i < count; i++) {
      const x = rng.range(0, W), y = rng.range(0, H), r = rng.range(rMin, rMax);
      const light = rng.chance(0.5);
      const a = alpha * (0.5 + rng.next() * 0.5);
      const cr = light ? 255 : warm ? 40 : 0, cg = light ? (warm ? 246 : 255) : warm ? 30 : 0, cb = light ? (warm ? 228 : 255) : warm ? 20 : 0;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cx = x + ox * W, cy = y + oy * H;
          if (cx < -r || cx > W + r || cy < -r || cy > H + r) continue;
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, rgba(cr, cg, cb, a));
          g.addColorStop(1, rgba(cr, cg, cb, 0));
          ctx.fillStyle = g;
          ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
      }
    }
    for (let i = 0; i < grain; i++) {
      const v = rng.chance(0.5) ? 255 : 0;
      ctx.fillStyle = rgba(v, v, v, grainAlpha * rng.next());
      ctx.fillRect(rng.range(0, W), rng.range(0, H), 1, 1);
    }
  }

  /** In-place wrapping 3 x 3 box blur of a canvas (softens 1 px flecks into aggregate). */
  private blur3(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const img = ctx.getImageData(0, 0, W, H);
    const s = img.data, d = new Uint8ClampedArray(s.length);
    for (let y = 0; y < H; y++) {
      const up = (y === 0 ? H - 1 : y - 1) * W, dn = (y === H - 1 ? 0 : y + 1) * W, row = y * W;
      for (let x = 0; x < W; x++) {
        const xl = x === 0 ? W - 1 : x - 1, xr = x === W - 1 ? 0 : x + 1;
        for (let ch = 0; ch < 3; ch++) {
          const sum = s[(up + xl) * 4 + ch] + s[(up + x) * 4 + ch] + s[(up + xr) * 4 + ch]
            + s[(row + xl) * 4 + ch] + s[(row + x) * 4 + ch] + s[(row + xr) * 4 + ch]
            + s[(dn + xl) * 4 + ch] + s[(dn + x) * 4 + ch] + s[(dn + xr) * 4 + ch];
          d[(row + x) * 4 + ch] = sum / 9;
        }
        d[(row + x) * 4 + 3] = 255;
      }
    }
    img.data.set(d);
    ctx.putImageData(img, 0, 0);
  }

  /**
   * Per-pixel two-tone grain: every texel is nudged by +-amp, light flecks pulled warm and dark flecks pulled cool
   * (tone), which is how sand, cement and bitumen aggregate read at arm's length. Written through ImageData because a
   * 1024 px tile is a million texels and fillRect per fleck would take seconds. Follow with blur3 so the grain sits at
   * 2-3 px and averages out in the first mip instead of shimmering.
   */
  private grain(ctx: CanvasRenderingContext2D, W: number, H: number, rng: Random, amp: number, tone: number): void {
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const a = amp * 255;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rng.next() - 0.5) * 2 * a;
      d[i] += n * (1 + tone);
      d[i + 1] += n;
      d[i + 2] += n * (1 - tone);
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Aggregate specks: dark stones and a few pale quartz chips, 2-4 px, kept away from a wrap seam by nothing (they tile fine). */
  private specks(ctx: CanvasRenderingContext2D, W: number, H: number, rng: Random, dark: number, light: number, size: number): void {
    for (let i = 0; i < dark; i++) {
      const s = rng.range(size * 0.6, size * 1.4);
      ctx.fillStyle = rgba(14, 12, 10, rng.range(0.16, 0.34));
      ctx.fillRect(rng.range(0, W), rng.range(0, H), s, s * rng.range(0.6, 1.2));
    }
    for (let i = 0; i < light; i++) {
      const s = rng.range(size * 0.5, size);
      ctx.fillStyle = rgba(230, 222, 205, rng.range(0.08, 0.2));
      ctx.fillRect(rng.range(0, W), rng.range(0, H), s, s);
    }
  }

  /**
   * Crack polylines: a wandering dark hairline with a lighter, offset edge (the lip the light catches), and an
   * occasional branch. Kept inside a margin so nothing crosses the wrap seam. `scale` is px per design px (1 at 512).
   */
  private cracks(ctx: CanvasRenderingContext2D, W: number, H: number, rng: Random, n: number, scale: number, darkA: number, lightA: number, margin = 0.06): void {
    const walk = (x: number, y: number, ang: number, steps: number, len: number): [number, number][] => {
      const pts: [number, number][] = [[x, y]];
      for (let k = 0; k < steps; k++) {
        ang += rng.range(-0.7, 0.7);
        x += Math.cos(ang) * len * rng.range(0.6, 1.4);
        y += Math.sin(ang) * len * rng.range(0.6, 1.4);
        x = Math.min(W * (1 - margin), Math.max(W * margin, x));
        y = Math.min(H * (1 - margin), Math.max(H * margin, y));
        pts.push([x, y]);
      }
      return pts;
    };
    const stroke = (pts: [number, number][], ox: number, oy: number, w: number, style: string): void => {
      ctx.strokeStyle = style;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0][0] + ox, pts[0][1] + oy);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0] + ox, pts[k][1] + oy);
      ctx.stroke();
    };
    for (let i = 0; i < n; i++) {
      const pts = walk(rng.range(W * margin, W * (1 - margin)), rng.range(H * margin, H * (1 - margin)), rng.range(0, Math.PI * 2), rng.int(6, 14), 9 * scale);
      // Lit lip: a wider light stroke offset down-right, then the dark fissure over it.
      stroke(pts, 0.8 * scale, 0.8 * scale, 1.9 * scale, rgba(255, 244, 228, lightA));
      stroke(pts, 0, 0, 1.15 * scale, rgba(8, 6, 4, darkA));
      if (rng.chance(0.45)) {
        const k = rng.int(1, pts.length - 2);
        const br = walk(pts[k][0], pts[k][1], rng.range(0, Math.PI * 2), rng.int(3, 6), 7 * scale);
        stroke(br, 0.7 * scale, 0.7 * scale, 1.5 * scale, rgba(255, 244, 228, lightA * 0.8));
        stroke(br, 0, 0, 0.9 * scale, rgba(8, 6, 4, darkA * 0.9));
      }
    }
  }

  /**
   * Erodes a painted-marking layer (drawn on a cleared canvas): chips punched out along the edges and a scatter of
   * missing flakes inside, ~5-8% of the area, so lane paint reads as worn thermoplastic rather than a vector overlay.
   * `rects` are the painted rectangles (x, y, w, h) the edge chips follow.
   */
  private wearPaint(ctx: CanvasRenderingContext2D, rng: Random, rects: number[][], scale: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < rects.length; i++) {
      const [x, y, w, h] = rects[i];
      const area = w * h;
      // Edge nibbles: small ellipses straddling each of the four edges.
      const perim = 2 * (w + h);
      const edgeN = Math.round(perim / (6 * scale));
      for (let k = 0; k < edgeN; k++) {
        const t = rng.range(0, perim);
        let ex: number, ey: number;
        if (t < w) { ex = x + t; ey = y; } else if (t < w + h) { ex = x + w; ey = y + (t - w); } else if (t < 2 * w + h) { ex = x + (t - w - h); ey = y + h; } else { ex = x; ey = y + (t - 2 * w - h); }
        const r = rng.range(0.6, 1.7) * scale;
        ctx.fillStyle = rgba(0, 0, 0, rng.range(0.5, 1));
        ctx.beginPath();
        ctx.ellipse(ex, ey, r, r * rng.range(0.5, 1.5), rng.range(0, Math.PI), 0, Math.PI * 2);
        ctx.fill();
      }
      // Interior flakes: about 6% of the area.
      const flakeN = Math.round((area * 0.05) / (5 * scale * scale));
      for (let k = 0; k < flakeN; k++) {
        const r = rng.range(0.6, 1.8) * scale;
        ctx.fillStyle = rgba(0, 0, 0, rng.range(0.35, 0.9));
        ctx.beginPath();
        ctx.ellipse(x + rng.range(0, w), y + rng.range(0, h), r, r * rng.range(0.5, 1.4), rng.range(0, Math.PI), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Cast-iron manhole cover: bitumen seal ring, machined rim, dished lid with a radial tread and two lifting slots. Also paints its roughness (r). */
  private manhole(ctx: CanvasRenderingContext2D, r: CanvasRenderingContext2D | null, rng: Random, cx: number, cy: number, rad: number): void {
    // Tar seal around the frame.
    ctx.fillStyle = rgba(10, 9, 8, 0.5);
    ctx.beginPath(); ctx.arc(cx, cy, rad * 1.22, 0, Math.PI * 2); ctx.fill();
    // Frame rim: light on the sun side (top-left), dark below.
    ctx.fillStyle = '#5c5a56';
    ctx.beginPath(); ctx.arc(cx, cy, rad * 1.08, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = rgba(255, 250, 240, 0.28);
    ctx.beginPath(); ctx.arc(cx - rad * 0.03, cy - rad * 0.03, rad * 1.05, Math.PI * 0.9, Math.PI * 1.9); ctx.lineTo(cx, cy); ctx.fill();
    ctx.fillStyle = rgba(0, 0, 0, 0.5);
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
    // Lid.
    const lid = ctx.createRadialGradient(cx - rad * 0.25, cy - rad * 0.25, rad * 0.1, cx, cy, rad * 0.92);
    lid.addColorStop(0, '#4c4b48');
    lid.addColorStop(1, '#2f2e2c');
    ctx.fillStyle = lid;
    ctx.beginPath(); ctx.arc(cx, cy, rad * 0.92, 0, Math.PI * 2); ctx.fill();
    // Radial tread: alternating raised wedges, and two concentric rings.
    const wedges = 24;
    for (let k = 0; k < wedges; k++) {
      const a0 = (k / wedges) * Math.PI * 2, a1 = ((k + 0.5) / wedges) * Math.PI * 2;
      ctx.fillStyle = rgba(255, 245, 230, 0.09);
      ctx.beginPath(); ctx.arc(cx, cy, rad * 0.86, a0, a1); ctx.arc(cx, cy, rad * 0.32, a1, a0, true); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = rgba(0, 0, 0, 0.45);
    ctx.lineWidth = Math.max(1, rad * 0.05);
    for (const k of [0.86, 0.6, 0.32]) { ctx.beginPath(); ctx.arc(cx, cy, rad * k, 0, Math.PI * 2); ctx.stroke(); }
    ctx.strokeStyle = rgba(255, 245, 230, 0.14);
    for (const k of [0.83, 0.57, 0.29]) { ctx.beginPath(); ctx.arc(cx, cy, rad * k, Math.PI * 0.95, Math.PI * 1.85); ctx.stroke(); }
    // Lifting slots.
    ctx.fillStyle = '#0c0b0a';
    const sw = rad * 0.18, sh = rad * 0.08;
    ctx.fillRect(cx - sw / 2, cy - rad * 0.7 - sh / 2, sw, sh);
    ctx.fillRect(cx - sw / 2, cy + rad * 0.7 - sh / 2, sw, sh);
    // Rust bloom off the rim.
    ctx.fillStyle = rgba(120, 70, 30, 0.12 + rng.next() * 0.1);
    ctx.beginPath(); ctx.arc(cx + rad * 0.5, cy + rad * 0.9, rad * 0.5, 0, Math.PI * 2); ctx.fill();
    if (r) {
      r.fillStyle = grey(0.55);
      r.beginPath(); r.arc(cx, cy, rad * 1.08, 0, Math.PI * 2); r.fill();
    }
  }

  /** Kerb-side storm drain: concrete surround, dark recess with cast slots; paints its roughness (r) too. */
  private drain(ctx: CanvasRenderingContext2D, r: CanvasRenderingContext2D | null, x: number, y: number, w: number, h: number, scale: number): void {
    ctx.fillStyle = rgba(8, 7, 6, 0.45);
    ctx.fillRect(x - 5 * scale, y - 5 * scale, w + 10 * scale, h + 10 * scale);
    ctx.fillStyle = '#7d7a72';
    ctx.fillRect(x - 3 * scale, y - 3 * scale, w + 6 * scale, h + 6 * scale);
    ctx.fillStyle = rgba(255, 250, 240, 0.22);
    ctx.fillRect(x - 3 * scale, y - 3 * scale, w + 6 * scale, 1.2 * scale);
    ctx.fillStyle = '#1a1917';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#4a4946';
    const bars = Math.max(3, Math.round(w / (6 * scale)));
    for (let k = 0; k < bars; k++) {
      const bx = x + ((k + 0.5) / bars) * w;
      ctx.fillRect(bx - 1.2 * scale, y, 2.4 * scale, h);
      ctx.fillStyle = rgba(255, 250, 240, 0.18);
      ctx.fillRect(bx - 1.2 * scale, y, 0.8 * scale, h);
      ctx.fillStyle = '#4a4946';
    }
    ctx.fillStyle = rgba(0, 0, 0, 0.5);
    ctx.fillRect(x, y, w, 1.5 * scale);
    if (r) {
      r.fillStyle = grey(0.5);
      r.fillRect(x - 3 * scale, y - 3 * scale, w + 6 * scale, h + 6 * scale);
    }
  }

  /**
   * Weathering pass over a finished facade tile: grime washing down from the sills, soft dirt blotches and a little
   * colour drift. Clean flat panels are the thing that dates a procedural city most, and because the normal and
   * roughness maps are derived from this albedo the streaks show up in the shading too, not just the colour.
   */
  private grime(ctx: CanvasRenderingContext2D, W: number, H: number, rng: Random, rowH: number, top: number, scale = 1): void {
    // Streaks: they start just under a floor line and fade downwards.
    const streaks = Math.round(W / 7);
    for (let i = 0; i < streaks; i++) {
      const x = rng.range(0, W);
      const w = rng.range(1, 4) * scale;
      const row = Math.floor(rng.range(0, Math.max(1, (H - top) / rowH)));
      const y = top + row * rowH + rowH * rng.range(0.55, 0.95);
      const len = rowH * rng.range(0.3, 1.4);
      const g = ctx.createLinearGradient(0, y, 0, y + len);
      const a = 0.05 + rng.next() * 0.09;
      g.addColorStop(0, rgba(30, 26, 22, a));
      g.addColorStop(1, rgba(30, 26, 22, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, len);
    }
    // Soft blotches of dirt and damp.
    for (let i = 0; i < 14; i++) {
      const x = rng.range(0, W), y = rng.range(top, H), r = rng.range(W * 0.08, W * 0.3);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.03 + rng.next() * 0.05;
      const warm = rng.chance(0.35);
      g.addColorStop(0, warm ? rgba(96, 74, 46, a) : rgba(28, 30, 34, a));
      g.addColorStop(1, rgba(0, 0, 0, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  /**
   * Soft-edged stroke: the body at alpha `a` plus a 1 px skirt at 40 %, so the edge lands between two texels and the
   * mip chain averages it into a tone. A 1 px full-alpha highlight line survives three mip levels as a lone bright
   * texel, which is the white sparkle every tower used to carry at 100-300 m.
   */
  private softRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, col: string, a: number): void {
    c.fillStyle = col;
    c.globalAlpha = a * 0.4;
    c.fillRect(x - 1, y - 1, w + 2, h + 2);
    c.globalAlpha = a;
    c.fillRect(x, y, w, h);
    c.globalAlpha = 1;
  }

  /** In-place wrapping 1 px soften ([1 2 1] / 4, separable) of a canvas' RGB, alpha untouched: every edge then sits between texels and mips average instead of sparkling. */
  private soften(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const img = ctx.getImageData(0, 0, W, H);
    const s = img.data, t = new Uint8ClampedArray(s.length);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const l = (row + (x === 0 ? W - 1 : x - 1)) * 4, c = (row + x) * 4, rr = (row + (x === W - 1 ? 0 : x + 1)) * 4;
        t[c] = (s[l] + 2 * s[c] + s[rr] + 2) >> 2;
        t[c + 1] = (s[l + 1] + 2 * s[c + 1] + s[rr + 1] + 2) >> 2;
        t[c + 2] = (s[l + 2] + 2 * s[c + 2] + s[rr + 2] + 2) >> 2;
        t[c + 3] = s[c + 3];
      }
    }
    for (let y = 0; y < H; y++) {
      const up = (y === 0 ? H - 1 : y - 1) * W, dn = (y === H - 1 ? 0 : y + 1) * W, row = y * W;
      for (let x = 0; x < W; x++) {
        const u = (up + x) * 4, c = (row + x) * 4, d = (dn + x) * 4;
        s[c] = (t[u] + 2 * t[c] + t[d] + 2) >> 2;
        s[c + 1] = (t[u + 1] + 2 * t[c + 1] + t[d + 1] + 2) >> 2;
        s[c + 2] = (t[u + 2] + 2 * t[c + 2] + t[d + 2] + 2) >> 2;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /**
   * Albedo + emissive window tiles for a building style: 4 columns x 8 rows per 16 m x 28 m tile, drawn in one design
   * space of 1024 x 2048 px (64 px/m, so a 4 m bay gets 256 px and a frame is a 4-6 px stroke rather than a smear).
   * The punched-window styles keep that resolution; the curtain-wall styles (glass, neon: tall panes and vertical
   * mullions, whose horizontal edges are long bands) drop to 1024 x 1024 through a scaled context. The emissive and
   * roughness maps carry pane-sized shapes and are drawn at a quarter, the relief is derived from a half-res copy.
   * No 1 px highlight survives: every lit edge is a 3 px feathered stroke and the albedo gets a 1 px soften before
   * upload, so the lower mips average to a calm tone instead of the white sparkle of the old 1 px lines. Per cell
   * the pane shows something different behind it (a blind at its own height, curtains, a dark or a cool room), a
   * fifth of the sills carry an AC unit and the curtain walls carry a baked sky-to-slate reflection with a rooftop
   * band, so a glass tower reads cyan / slate instead of navy plastic.
   */
  windows(style: BuildingStyle, seed = 1): WindowTextures {
    const key = `win:${style}:${seed}`;
    const mk = this.cache.get(key + ':map') as THREE.CanvasTexture | undefined;
    const ek = this.cache.get(key + ':emi') as THREE.CanvasTexture | undefined;
    const nk = this.cache.get(key + ':nrm') as THREE.CanvasTexture | undefined;
    const rk = this.cache.get(key + ':rgh') as THREE.CanvasTexture | undefined;
    if (mk && ek && nk && rk) return { map: mk, emissive: ek, normal: nk, rough: rk };
    // Design space: 1024 x 2048 for the 16 m x 28 m tile. P = px per design px of the original 256 x 512 layout.
    const W = 1024, H = 2048, P = 4;
    const curtainWall = style === 'glass' || style === 'neon';
    const mapH = curtainWall ? H / 2 : H;
    const rng = new Random(seed * 7919 + style.length);
    const m = this.canvas(W, mapH), e = this.canvas(W / 4, H / 4), r = this.canvas(W / 4, H / 4);
    // Structure canvas for the relief (half res): frames, sills, mullions, piers and spandrels as height steps, and
    // nothing else - a relief derived from the albedo turned every reflection and blind into a bump.
    const n = this.canvas(W / 2, mapH / 2);
    if (curtainWall) m.ctx.scale(1, 0.5);
    n.ctx.scale(0.5, curtainWall ? 0.25 : 0.5);
    e.ctx.scale(0.25, 0.25);
    r.ctx.scale(0.25, 0.25);
    n.ctx.fillStyle = grey(0.5);
    n.ctx.fillRect(0, 0, W, H);
    const wall = style === 'glass' ? 0x9fb4c8 : style === 'concrete' ? 0xb8b8b4 : style === 'artdeco' ? 0xd8d0c0 : style === 'neon' ? 0xe8e0e8 : 0xd4cfc4;
    m.ctx.fillStyle = hex(wall);
    m.ctx.fillRect(0, 0, W, H);
    // Render / stucco: broad soft tonal patches. No 1 px grain here - the soften pass and the mips would only turn it into shimmer.
    this.mottle(m.ctx, W, H, rng, 150, 40, 130, 0.035, 0, 0, true);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, H);
    r.ctx.fillStyle = grey(0.92);
    r.ctx.fillRect(0, 0, W, H);
    const cols = 4, rows = 8;
    const top = ROOF_STRIP_PX * (H / WINDOW_TILE_PX_H);
    const cw = W / cols, rh = (H - top) / rows;
    // Colour-temperature banding every 3-4 floors (rendered floors against plastered ones, a change of contractor,
    // a later extension) so a 20-storey wall is not one flat tint. Faint enough to read as material, not stripes.
    const bandRows = 3 + (seed % 2);
    for (let row = 0; row < rows; row++) {
      const warmBand = Math.floor((row + seed) / bandRows) % 2 === 0;
      m.ctx.fillStyle = warmBand ? rgba(255, 222, 182, 0.09) : rgba(192, 206, 234, 0.08);
      m.ctx.fillRect(0, top + row * rh, W, rh);
      m.ctx.fillStyle = warmBand ? rgba(255, 255, 255, 0.03) : rgba(0, 0, 0, 0.03);
      m.ctx.fillRect(0, top + row * rh, W, rh);
    }
    // Style-specific facade dressing drawn before the glazing.
    if (style === 'artdeco') {
      // Pilasters between the window columns: a light 44 px pier with three fluting grooves and a shadow on its right.
      for (let c = 0; c <= cols; c++) {
        const x = c * cw;
        m.ctx.fillStyle = tint(wall, 0.2);
        m.ctx.fillRect(x - 22, top, 44, H - top);
        for (let g = -1; g <= 1; g++) {
          this.softRect(m.ctx, x + g * 12 - 3, top, 4, H - top, '#000', 0.16);
          this.softRect(m.ctx, x + g * 12 + 1, top, 3, H - top, '#fff', 0.26);
        }
        this.softRect(m.ctx, x + 22, top, 6, H - top, '#000', 0.2);
        r.ctx.fillStyle = grey(0.82);
        r.ctx.fillRect(x - 22, top, 44, H - top);
        n.ctx.fillStyle = grey(0.62);
        n.ctx.fillRect(x - 22, top, 44, H - top);
        n.ctx.fillStyle = grey(0.5);
        for (let g = -1; g <= 1; g++) n.ctx.fillRect(x + g * 12 - 3, top, 4, H - top);
      }
    } else if (style === 'concrete') {
      // Precast panel joints: a 6 px groove with a lit lip.
      for (let c = 0; c <= cols; c++) {
        this.softRect(m.ctx, c * cw - 3, top, 6, H - top, '#000', 0.28);
        this.softRect(m.ctx, c * cw + 3, top, 3, H - top, '#fff', 0.18);
        n.ctx.fillStyle = grey(0.38);
        n.ctx.fillRect(c * cw - 3, top, 6, H - top);
      }
    }
    // Per-style window shapes (fractions of a cell).
    let wx = 0.2, wy = 0.25, ww = 0.6, wh = 0.5;
    if (style === 'glass') { wx = 0.03; wy = 0.04; ww = 0.94; wh = 0.72; }
    else if (style === 'concrete') { wx = 0.26; wy = 0.28; ww = 0.48; wh = 0.44; }
    else if (style === 'artdeco') { wx = 0.28; wy = 0.14; ww = 0.44; wh = 0.66; }
    else if (style === 'neon') { wx = 0.06; wy = 0.24; ww = 0.88; wh = 0.46; }
    else { wx = 0.16; wy = 0.2; ww = 0.68; wh = 0.5; }
    // Punched windows are a slate that still reads as glass beside a light wall; the curtain wall bakes its own sky.
    const glassBase = '#5c728c';
    // Bright on purpose: downtown vertex colours (0x3e4a5e, 0x4c5a6e) multiply these down to a slate by the time they are lit.
    const GLASS_TONES = ['#a8ccec', '#a4dadc', '#b8c4d0'];
    // Night colour temperatures: warm white, tungsten, cool fluorescent. Each seed favours one of them so two towers
    // side by side do not light identically.
    const HUES: [number, number, number][] = [[255, 240, 200], [255, 210, 138], [217, 232, 255]];
    const bias = seed % 3;
    // Mullion: a 6 px bar with a 3 px lighter stroke along its top or left, so it reads as a lit frame and not a black line.
    const frame = (x: number, y: number, w: number, h: number, dark: string, light: string, lightA: number): void => {
      m.ctx.fillStyle = dark;
      m.ctx.fillRect(x, y, w, h);
      if (w >= h) this.softRect(m.ctx, x, y, w, 3, light, lightA); else this.softRect(m.ctx, x, y, 3, h, light, lightA);
      e.ctx.fillStyle = '#000';
      e.ctx.fillRect(x, y, w, h);
      r.ctx.fillStyle = grey(0.6);
      r.ctx.fillRect(x, y, w, h);
      n.ctx.fillStyle = grey(0.6);
      n.ctx.fillRect(x, y, w, h);
    };
    // Frame with depth: an f px frame around the opening with lit top / left edges and a shaded right edge, a dark
    // reveal (fake occlusion) along the head and the left jamb of the glass, and optionally a sill below with a lit
    // top and a shadow beneath. Frames are painted rough (0.6) beside the 0.26 glass and cut out of the emissive.
    const reveal = (gx: number, gy: number, gw: number, gh: number, f: number, frameCol: string, sill: boolean, revealA: number, edgeA = 0.3): void => {
      const x0 = gx - f, w0 = gw + 2 * f, hh = gh + (sill ? f : 2 * f);
      for (const c of [m.ctx, e.ctx, r.ctx, n.ctx]) {
        c.fillStyle = c === m.ctx ? frameCol : c === e.ctx ? '#000' : c === r.ctx ? grey(0.6) : grey(0.62);
        c.fillRect(x0, gy - f, w0, f);
        c.fillRect(x0, gy, f, gh);
        c.fillRect(gx + gw, gy, f, gh);
        if (!sill) c.fillRect(x0, gy + gh, w0, f);
      }
      n.ctx.fillStyle = grey(0.42);
      n.ctx.fillRect(gx, gy, gw, gh);
      this.softRect(m.ctx, x0, gy - f, w0, 3, '#fff', edgeA);
      this.softRect(m.ctx, x0, gy - f, 3, hh, '#fff', edgeA);
      this.softRect(m.ctx, gx + gw + f - 3, gy - f, 3, hh, '#000', 0.22);
      m.ctx.fillStyle = rgba(0, 0, 0, revealA);
      m.ctx.fillRect(gx, gy, gw, 8);
      m.ctx.fillRect(gx, gy, 8, gh);
      m.ctx.fillStyle = rgba(0, 0, 0, revealA * 0.5);
      m.ctx.fillRect(gx, gy + 8, gw, 5);
      m.ctx.fillRect(gx + 8, gy, 5, gh);
      if (sill) {
        const sy = gy + gh, sx = x0 - 6, sw = w0 + 12;
        m.ctx.fillStyle = tint(wall, 0.42);
        m.ctx.fillRect(sx, sy, sw, 14);
        this.softRect(m.ctx, sx, sy, sw, 3, '#fff', 0.4);
        this.softRect(m.ctx, sx, sy + 14, sw, 8, '#000', 0.3);
        this.softRect(m.ctx, sx, sy + 22, sw, 8, '#000', 0.1);
        e.ctx.fillStyle = '#000';
        e.ctx.fillRect(sx, sy, sw, 24);
        r.ctx.fillStyle = grey(0.7);
        r.ctx.fillRect(sx, sy, sw, 14);
        n.ctx.fillStyle = grey(0.66);
        n.ctx.fillRect(sx, sy, sw, 14);
      }
    };
    // Baked reflection: a horizon at 55 % of the pane with a haze band along it and a jagged line of reflected
    // rooftops below - what a facade shows at street level, and what the sky probe alone cannot (it has no city in it).
    const skyline = (gx: number, gy: number, gw: number, gh: number, k: number): void => {
      const hy = gy + gh * 0.55;
      const haze = m.ctx.createLinearGradient(0, hy - 16, 0, hy + 2);
      haze.addColorStop(0, rgba(232, 246, 252, 0));
      haze.addColorStop(0.85, rgba(232, 246, 252, 0.4 * k));
      haze.addColorStop(1, rgba(232, 246, 252, 0));
      m.ctx.fillStyle = haze;
      m.ctx.fillRect(gx, hy - 16, gw, 18);
      m.ctx.fillStyle = rgba(38, 54, 70, 0.3 * k);
      for (let x = gx; x < gx + gw;) {
        const w = rng.range(10, 28), h = rng.range(6, 30);
        m.ctx.fillRect(x, hy, Math.min(w, gx + gw - x), h);
        x += w;
      }
      const wash = m.ctx.createLinearGradient(0, hy, 0, gy + gh);
      wash.addColorStop(0, rgba(38, 54, 70, 0.2 * k));
      wash.addColorStop(1, rgba(38, 54, 70, 0.05 * k));
      m.ctx.fillStyle = wash;
      m.ctx.fillRect(gx, hy, gw, gy + gh - hy);
    };
    // Split-unit air conditioner hung under a sill: a pale box with a louvre grille, a shadow beneath.
    const acUnit = (ax: number, ay: number): void => {
      const aw = 44, ah = 30;
      this.softRect(m.ctx, ax - 2, ay + ah, aw + 4, 8, '#000', 0.3);
      m.ctx.fillStyle = '#cfccc3';
      m.ctx.fillRect(ax, ay, aw, ah);
      this.softRect(m.ctx, ax, ay, aw, 3, '#fff', 0.5);
      this.softRect(m.ctx, ax + aw - 4, ay, 4, ah, '#000', 0.25);
      m.ctx.fillStyle = rgba(60, 60, 64, 0.5);
      for (let yy = ay + 12; yy < ay + ah - 3; yy += 4) m.ctx.fillRect(ax + 4, yy, aw - 8, 2);
      e.ctx.fillStyle = '#000';
      e.ctx.fillRect(ax, ay, aw, ah);
      r.ctx.fillStyle = grey(0.55);
      r.ctx.fillRect(ax, ay, aw, ah);
      n.ctx.fillStyle = grey(0.64);
      n.ctx.fillRect(ax, ay, aw, ah);
    };
    // One variant per cell of the tile, dealt from a shuffled deck, so no two cells of a tile draw the same window:
    // what stands behind the glass, how far a blind is down, the curtain colour, an open sash, a shutter, an AC box
    // or a flower box all follow the variant, and the deck never repeats inside a tile.
    const deck: number[] = [];
    for (let i = 0; i < cols * rows; i++) deck.push(i);
    for (let i = deck.length - 1; i > 0; i--) { const j = rng.int(0, i); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    const CURTAINS: [number, number, number][] = [[236, 226, 210], [196, 118, 88], [128, 146, 96], [248, 246, 240]];
    const BLIND_DROP = [0.4, 0.6, 0.8, 1];
    for (let row = 0; row < rows; row++) {
      const y0 = top + row * rh;
      const ground = row === rows - 1;
      // Floor bands / cornices.
      if (style === 'artdeco') {
        m.ctx.fillStyle = tint(wall, 0.3);
        m.ctx.fillRect(0, y0 + rh - 6 * P, W, 4 * P);
        this.softRect(m.ctx, 0, y0 + rh - 6 * P, W, 3, '#fff', 0.35);
        this.softRect(m.ctx, 0, y0 + rh - 2 * P, W, 3 * P, '#000', 0.22);
        for (let d = 0; d < 16; d++) this.softRect(m.ctx, d * (W / 16) + 4 * P, y0 + rh - 10 * P, 6 * P, 4 * P, '#000', 0.12);
        n.ctx.fillStyle = grey(0.62);
        n.ctx.fillRect(0, y0 + rh - 6 * P, W, 4 * P);
      } else if (style === 'residential') {
        this.softRect(m.ctx, 0, y0 + rh - 3 * P, W, 3 * P, '#000', 0.18);
      } else if (style === 'neon') {
        m.ctx.fillStyle = row % 2 === 0 ? rgba(255, 120, 200, 0.4) : rgba(90, 220, 255, 0.4);
        m.ctx.fillRect(0, y0 + rh - 6 * P, W, 3 * P);
        this.softRect(m.ctx, 0, y0 + rh - 3 * P, W, 2 * P, '#000', 0.14);
      } else if (style === 'glass') {
        // Opaque spandrel under every floor of the curtain wall; two tones alternate per floor, and each bay drifts a little.
        const dark = row % 2 === 0;
        for (let c = 0; c < cols; c++) {
          const d = rng.range(-10, 10);
          m.ctx.fillStyle = dark ? rgba(56 + d, 68 + d, 84 + d, 0.9) : rgba(104 + d, 118 + d, 134 + d, 0.9);
          m.ctx.fillRect(c * cw, y0 + rh * 0.78, cw, rh * 0.22);
        }
        this.softRect(m.ctx, 0, y0 + rh * 0.78, W, 4, '#d2e2f0', 0.4);
        this.softRect(m.ctx, 0, y0 + rh * 0.78 + 4, W, 6, '#000', 0.2);
        r.ctx.fillStyle = grey(0.5);
        r.ctx.fillRect(0, y0 + rh * 0.78, W, rh * 0.22);
        n.ctx.fillStyle = grey(0.47);
        n.ctx.fillRect(0, y0 + rh * 0.78, W, rh * 0.22);
      } else {
        this.softRect(m.ctx, 0, y0 + rh - 2 * P, W, 2 * P, '#000', 0.12);
      }
      // Per-row luminance drift: eight identical floors stacked read as stripes, a few percent either way breaks it.
      const rowLum = rng.range(-0.06, 0.06);
      // Lit windows cluster per floor: pick a density for the whole row.
      const rowLit = ground ? 0.75 : rng.chance(0.25) ? 0.75 : rng.chance(0.4) ? 0.35 : 0.08;
      for (let c = 0; c < cols; c++) {
        const x0 = c * cw;
        const variant = deck[row * cols + c];
        const behind = variant % 5;
        const openSash = !ground && style !== 'glass' && variant >= 16 && (variant & 1) === 1;
        const extra = variant % 7 === 3 ? 2 : variant % 7 === 5 ? 1 : 0;
        let gx = x0 + wx * cw, gy = y0 + wy * rh, gw = ww * cw, gh = wh * rh;
        if (ground && style !== 'glass') { gx = x0 + 0.1 * cw; gy = y0 + 0.12 * rh; gw = 0.8 * cw; gh = 0.86 * rh; }
        if (style === 'glass') {
          // Curtain wall pane: a random tone (blue / teal / grey) under a sky-to-slate gradient and a reflected skyline.
          m.ctx.fillStyle = GLASS_TONES[rng.int(0, 2)];
          m.ctx.fillRect(gx, gy, gw, gh);
          const sky = m.ctx.createLinearGradient(0, gy, 0, gy + gh);
          sky.addColorStop(0, rgba(200, 240, 250, 0.65));
          sky.addColorStop(0.5, rgba(200, 240, 250, 0));
          sky.addColorStop(0.55, rgba(40, 52, 66, 0));
          sky.addColorStop(1, rgba(40, 52, 66, 0.4));
          m.ctx.fillStyle = sky;
          m.ctx.fillRect(gx, gy, gw, gh);
        } else {
          m.ctx.fillStyle = glassBase;
          m.ctx.fillRect(gx, gy, gw, gh);
        }
        m.ctx.fillStyle = rowLum > 0 ? rgba(255, 255, 255, rowLum) : rgba(0, 0, 0, -rowLum);
        m.ctx.fillRect(gx, gy, gw, gh);
        // What is behind the glass: a blind at its own height, curtains, a dark room, a cool office - so panes stop
        // being one flat tone and no two cells of a column match.
        const blinds = behind === 0 || (style === 'glass' && behind === 1);
        let blindH = 0, curtainX = -1, curtainW = 0;
        if (blinds) {
          // Slats are 4 px (6 cm) apart: a stripe on a cream pane, pulled down to one of four heights with a heavy rail.
          blindH = gh * BLIND_DROP[(variant >> 1) & 3];
          m.ctx.fillStyle = rgba(236, 230, 218, style === 'glass' ? 0.55 : 0.72);
          m.ctx.fillRect(gx, gy, gw, blindH);
          m.ctx.fillStyle = rgba(110, 104, 94, 0.22);
          for (let yy = gy + 4; yy < gy + blindH - 4; yy += 6) m.ctx.fillRect(gx, yy, gw, 2);
          m.ctx.fillStyle = rgba(120, 112, 100, 0.85);
          m.ctx.fillRect(gx, gy + blindH - 6, gw, 6);
          if (blindH < gh) {
            m.ctx.fillStyle = rgba(0, 0, 0, 0.3);
            m.ctx.fillRect(gx, gy + blindH, gw, gh - blindH);
          }
        } else if (behind === 1) {
          // Curtains in one of four colours, drawn to one side or both, a slice of lit room between them.
          const cc = CURTAINS[(variant >> 2) & 3];
          curtainW = gw * (0.3 + 0.05 * ((variant >> 1) & 3));
          curtainX = (variant & 2) === 0 ? gx : gx + gw - curtainW;
          const both = (variant >> 4) % 3 === 0;
          m.ctx.fillStyle = rgba(cc[0], cc[1], cc[2], 0.82);
          m.ctx.fillRect(curtainX, gy, curtainW, gh);
          m.ctx.fillStyle = rgba(60, 50, 40, 0.16);
          for (let xx = curtainX + 4; xx < curtainX + curtainW - 3; xx += 10) m.ctx.fillRect(xx, gy, 3, gh);
          if (both) {
            const ox = curtainX === gx ? gx + gw - curtainW : gx;
            m.ctx.fillStyle = rgba(cc[0], cc[1], cc[2], 0.82);
            m.ctx.fillRect(ox, gy, curtainW, gh);
            m.ctx.fillStyle = rgba(60, 50, 40, 0.16);
            for (let xx = ox + 4; xx < ox + curtainW - 3; xx += 10) m.ctx.fillRect(xx, gy, 3, gh);
          } else {
            m.ctx.fillStyle = rgba(0, 0, 0, 0.18);
            m.ctx.fillRect(curtainX === gx ? gx + curtainW : gx, gy, gw - curtainW, gh);
          }
        } else if (behind === 2) {
          // A dark room.
          m.ctx.fillStyle = rgba(0, 0, 0, style === 'glass' ? 0.16 : 0.34);
          m.ctx.fillRect(gx, gy, gw, gh);
        } else if (behind === 3) {
          // A cool, lit office.
          m.ctx.fillStyle = rgba(205, 228, 255, 0.34);
          m.ctx.fillRect(gx, gy, gw, gh);
        } else if (style !== 'glass' && !ground) {
          // A warm room with a plant on the sill: a dark green mound with a lighter top, low in the pane.
          m.ctx.fillStyle = rgba(255, 236, 200, 0.16);
          m.ctx.fillRect(gx, gy, gw, gh);
          const pw = gw * (0.2 + 0.04 * ((variant >> 1) & 3)), px = gx + 6 + ((variant >> 3) & 1) * (gw - pw - 12);
          m.ctx.fillStyle = rgba(46, 96, 52, 0.9);
          m.ctx.fillRect(px, gy + gh - 24, pw, 24);
          m.ctx.fillStyle = rgba(96, 150, 78, 0.7);
          m.ctx.fillRect(px + 4, gy + gh - 24, pw - 8, 8);
        }
        if (openSash) {
          // One leaf swung open: the outer half of the pane reads as a pale leaf catching the light, with a dark slot
          // into the room along its hinge and a bright edge on its free side.
          const sx0 = (variant & 4) === 0 ? gx + gw / 2 : gx, sw = gw / 2;
          m.ctx.fillStyle = tint(wall, 0.3);
          m.ctx.fillRect(sx0, gy, sw, gh);
          m.ctx.fillStyle = rgba(0, 0, 0, 0.5);
          m.ctx.fillRect(sx0 === gx ? gx + sw - 8 : sx0, gy, 8, gh);
          this.softRect(m.ctx, sx0 === gx ? gx : gx + gw - 4, gy, 4, gh, '#fff', 0.5);
          e.ctx.fillStyle = rgba(0, 0, 0, 0.6);
          e.ctx.fillRect(sx0, gy, sw, gh);
        }
        // Sky reflection: light at the head, dark at the foot, the horizon band in between (strong on the curtain wall).
        const grad = m.ctx.createLinearGradient(0, gy, 0, gy + gh);
        grad.addColorStop(0, rgba(255, 255, 255, style === 'glass' ? 0.14 : 0.1));
        grad.addColorStop(0.45, rgba(255, 255, 255, 0));
        grad.addColorStop(1, rgba(0, 0, 0, 0.08));
        m.ctx.fillStyle = grad;
        m.ctx.fillRect(gx, gy, gw, gh);
        skyline(gx, gy, gw, gh, style === 'glass' ? 1 : blinds ? 0.25 : 0.45);
        // Glazing is glass whatever sits behind it: 0.26 keeps the sky probe as a broad sheen, not a pinpoint.
        r.ctx.fillStyle = grey(blinds ? 0.32 : 0.26);
        r.ctx.fillRect(gx, gy, gw, gh);
        // Night: a lit pane is brightest at the ceiling and falls off to the floor; hue and level vary per pane.
        if (rng.chance(rowLit)) {
          const hue = rng.chance(0.55) ? HUES[bias] : HUES[rng.int(0, 2)];
          // Big ground-floor panes at full level saturate to flat white after tone mapping: keep them lower.
          const I = ground && style !== 'glass' ? rng.range(0.32, 0.6) : rng.range(0.5, 1.0);
          const g = e.ctx.createLinearGradient(0, gy, 0, gy + gh);
          g.addColorStop(0, rgba(hue[0] * I, hue[1] * I, hue[2] * I, 1));
          g.addColorStop(0.2, rgba(hue[0] * I, hue[1] * I, hue[2] * I, 1));
          g.addColorStop(1, rgba(hue[0] * I * 0.45, hue[1] * I * 0.45, hue[2] * I * 0.45, 1));
          e.ctx.fillStyle = g;
          e.ctx.fillRect(gx, gy, gw, gh);
          if (blinds) {
            // The blind glows through as stripes; below its rail the room is bare.
            e.ctx.fillStyle = rgba(0, 0, 0, 0.35);
            e.ctx.fillRect(gx, gy, gw, blindH);
            e.ctx.fillStyle = rgba(0, 0, 0, 0.3);
            for (let yy = gy + 4; yy < gy + blindH - 4; yy += 6) e.ctx.fillRect(gx, yy, gw, 2);
          }
          if (curtainX >= 0) {
            e.ctx.fillStyle = rgba(0, 0, 0, 0.5);
            e.ctx.fillRect(curtainX, gy, curtainW, gh);
          }
          if (rng.chance(0.3)) {
            e.ctx.fillStyle = rgba(0, 0, 0, 0.7);
            e.ctx.fillRect(gx, gy + gh * rng.range(0.1, 0.5), gw, 6);
          }
        }
        // Frames, reveals, sills and mullions (all cut black out of the emissive too).
        let sillY = -1;
        if (style === 'glass') {
          // Curtain wall: slim aluminium mullion, shallow reveal, spandrel instead of a sill.
          frame(gx + gw / 2 - 3, gy, 6, gh, rgba(150, 176, 200, 0.75), '#e0ecf6', 0.45);
          reveal(gx, gy, gw, gh, 6, rgba(196, 210, 222, 0.95), false, 0.14, 0.14);
        } else if (style === 'neon') {
          for (let k = 1; k < 4; k++) frame(gx + (gw * k) / 4 - 3, gy, 6, gh, rgba(20, 26, 34, 0.75), '#78828c', 0.7);
          reveal(gx, gy, gw, gh, 8, rgba(44, 48, 56, 0.95), !ground, 0.3);
          if (!ground) sillY = gy + gh + 22;
        } else if (style === 'concrete') {
          // Deep punched opening: precast frame, a strong reveal shadow, a sill.
          frame(gx + gw / 2 - 3, gy, 6, gh, rgba(40, 44, 50, 0.8), '#969692', 0.8);
          reveal(gx, gy, gw, gh, 14, tint(wall, 0.14), !ground, 0.42);
          if (!ground) sillY = gy + gh + 22;
        } else if (style === 'artdeco') {
          frame(gx + gw / 2 - 3, gy, 6, gh, rgba(60, 60, 70, 0.75), '#b4b0a8', 0.8);
          reveal(gx, gy, gw, gh, 12, tint(wall, 0.45), !ground, 0.3);
          if (!ground) sillY = gy + gh + 22;
        } else if (!ground) {
          // Residential: white frame, sill and an occasional shutter (under the reveal so it is shadowed too).
          frame(gx + gw / 2 - 3, gy, 6, gh, rgba(236, 232, 226, 0.9), '#fff', 0.9);
          if (variant % 4 === 1 && !openSash) {
            const sw = gw * 0.45;
            m.ctx.fillStyle = rgba(120, 150, 130, 0.88);
            m.ctx.fillRect(gx, gy, sw, gh);
            m.ctx.fillStyle = rgba(0, 0, 0, 0.2);
            for (let yy = gy + 8; yy < gy + gh - 4; yy += 8) m.ctx.fillRect(gx + 4, yy, sw - 8, 3);
            e.ctx.fillStyle = '#000';
            e.ctx.fillRect(gx, gy, sw, gh);
            r.ctx.fillStyle = grey(0.7);
            r.ctx.fillRect(gx, gy, sw, gh);
          }
          reveal(gx, gy, gw, gh, 12, rgba(250, 248, 244, 0.92), true, 0.3);
          sillY = gy + gh + 22;
        } else {
          frame(gx + gw / 2 - 3, gy, 6, gh, rgba(40, 44, 50, 0.8), '#969692', 0.8);
          reveal(gx, gy, gw, gh, 12, rgba(52, 56, 62, 0.92), false, 0.3);
        }
        // A seventh of the sills carry a split-unit air conditioner hung to one side, another seventh a flower box.
        if (sillY > 0 && extra === 2) acUnit((variant & 8) === 0 ? gx + 4 : gx + gw - 48, sillY + 4);
        if (sillY > 0 && extra === 1) {
          const fw = gw * 0.6, fx = gx + (gw - fw) / 2;
          m.ctx.fillStyle = '#4a3a2c';
          m.ctx.fillRect(fx, sillY - 12, fw, 14);
          this.softRect(m.ctx, fx, sillY + 2, fw, 6, '#000', 0.3);
          const bloom = (variant & 8) === 0 ? '#d8404a' : '#e070a0';
          for (let bx = fx + 4; bx < fx + fw - 6; bx += 9) {
            m.ctx.fillStyle = '#4c8a3c';
            m.ctx.fillRect(bx, sillY - 22, 7, 12);
            m.ctx.fillStyle = bloom;
            m.ctx.fillRect(bx + 1, sillY - 26, 5, 6);
          }
          e.ctx.fillStyle = '#000';
          e.ctx.fillRect(fx, sillY - 26, fw, 28);
        }
      }
      if (style === 'residential' && row % 2 === 0 && !ground) {
        // Balcony parapet on alternating floors: a handrail, bars and a bottom rail standing on the slab, in front of the wall.
        const ry0 = y0 + rh * 0.74, ry1 = y0 + rh * 0.96;
        this.softRect(m.ctx, 0, ry0, W, 6, tint(wall, 0.45), 1);
        this.softRect(m.ctx, 0, ry0, W, 2, '#fff', 0.35);
        this.softRect(m.ctx, 0, ry1 - 5, W, 5, tint(wall, 0.4), 1);
        m.ctx.fillStyle = rgba(70, 62, 54, 0.6);
        for (let bx = 10; bx < W; bx += 28) m.ctx.fillRect(bx, ry0 + 6, 4, ry1 - ry0 - 11);
        this.softRect(m.ctx, 0, ry1, W, 6, '#000', 0.22);
        e.ctx.fillStyle = rgba(0, 0, 0, 0.5);
        e.ctx.fillRect(0, ry0, W, ry1 - ry0);
        n.ctx.fillStyle = grey(0.6);
        n.ctx.fillRect(0, ry0, W, 6);
        n.ctx.fillRect(0, ry1 - 5, W, 5);
      }
    }
    this.grime(m.ctx, W, H, rng, rh, top, P);
    // Plain strip at the top (v > 0.98): white in the albedo (vertex color shows exactly), black in the emissive.
    // The strip stays fully non-emissive: walls tile through it, so anything lit here would show up as bands on facades.
    m.ctx.fillStyle = '#ffffff';
    m.ctx.fillRect(0, 0, W, top);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, top);
    r.ctx.fillStyle = grey(0.9);
    r.ctx.fillRect(0, 0, W, top);
    this.soften(m.ctx, W, mapH);
    const map = this.finish(key + ':map', m.canvas, true);
    const emissive = this.finish(key + ':emi', e.canvas, true);
    const normal = this.normalFromLuminance(key + ':nrm', n.canvas, 4.5, 8);
    const rough = this.finish(key + ':rgh', r.canvas, false);
    return { map, emissive, normal, rough };
  }

  /**
   * Derives a tangent-space normal map from a painted albedo, reading luminance as height: dark glass sinks into
   * the wall, bright fluting and cornices stand out. Cheap way to give flat facades per-pixel relief.
   */
  private normalFromLuminance(key: string, src: HTMLCanvasElement, strength: number, highPass = 4): THREE.CanvasTexture {
    const hit = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (hit) return hit;
    const W = src.width, H = src.height;
    const sctx = src.getContext('2d');
    const out = this.canvas(W, H);
    if (!sctx) return this.finish(key, out.canvas, false);
    const img = sctx.getImageData(0, 0, W, H).data;
    const n = W * H;
    const lum = new Float32Array(n), wide = new Float32Array(n), tmp = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = (img[p] * 0.2126 + img[p + 1] * 0.7152 + img[p + 2] * 0.0722) / 255;
    // High pass: the painted albedo has broad gradients (a glass pane shaded top to bottom, a wall gradient) that would
    // read as a curved surface and make every window look like a pillow. Subtracting a wide blur keeps only the sharp
    // steps - mullions, sills, fluting, fascia edges - so panes stay flat and their frames get the relief. Facades
    // pass 8 (their strokes are 3-6 px wide and their sills 14 px), the ground tiles keep the tight 4.
    const R = highPass;
    wide.set(lum);
    this.boxBlur(wide, tmp, W, H, R);
    for (let i = 0; i < n; i++) tmp[i] = lum[i] - wide[i];
    // One 3-tap pass to take the edge off the albedo speckle noise; tiles wrap, so the taps wrap too.
    const h = wide;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) h[row + x] = (tmp[row + (x === 0 ? W - 1 : x - 1)] + 2 * tmp[row + x] + tmp[row + (x === W - 1 ? 0 : x + 1)]) * 0.25;
    }
    for (let y = 0; y < H; y++) {
      const up = (y === 0 ? H - 1 : y - 1) * W, dn = (y === H - 1 ? 0 : y + 1) * W, row = y * W;
      for (let x = 0; x < W; x++) tmp[row + x] = (h[up + x] + 2 * h[row + x] + h[dn + x]) * 0.25;
    }
    const dst = out.ctx.createImageData(W, H);
    const d = dst.data;
    for (let y = 0; y < H; y++) {
      const up = (y === 0 ? H - 1 : y - 1) * W, dn = (y === H - 1 ? 0 : y + 1) * W, row = y * W;
      for (let x = 0; x < W; x++) {
        const xl = x === 0 ? W - 1 : x - 1, xr = x === W - 1 ? 0 : x + 1;
        // Sobel over the height field. +Y in the normal map points up the texture, matching three's tangent frame.
        const gx = (tmp[up + xr] + 2 * tmp[row + xr] + tmp[dn + xr]) - (tmp[up + xl] + 2 * tmp[row + xl] + tmp[dn + xl]);
        const gy = (tmp[dn + xl] + 2 * tmp[dn + x] + tmp[dn + xr]) - (tmp[up + xl] + 2 * tmp[up + x] + tmp[up + xr]);
        const nx = -gx * strength, ny = gy * strength;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        const i = (row + x) * 4;
        d[i] = (nx * inv * 0.5 + 0.5) * 255;
        d[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
        d[i + 2] = (inv * 0.5 + 0.5) * 255;
        d[i + 3] = 255;
      }
    }
    out.ctx.putImageData(dst, 0, 0);
    return this.finish(key, out.canvas, false);
  }

  /**
   * Turns an albedo into a roughness map by reading luminance: the dark parts of these facade textures are glazing
   * (smooth, so the sky reflects in them) and the light parts are render, stone or concrete (rough). Without this
   * every surface answers the sky probe identically and the city reads as one flat plastic material.
   */
  private roughFromLuminance(key: string, src: HTMLCanvasElement, lo: number, hi: number): THREE.CanvasTexture {
    const hit = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (hit) return hit;
    const W = src.width, H = src.height;
    const sctx = src.getContext('2d');
    const out = this.canvas(W, H);
    if (!sctx) return this.finish(key, out.canvas, false);
    const img = sctx.getImageData(0, 0, W, H).data;
    const dst = out.ctx.createImageData(W, H);
    const d = dst.data;
    for (let i = 0; i < W * H; i++) {
      const p = i * 4;
      const lum = (img[p] * 0.2126 + img[p + 1] * 0.7152 + img[p + 2] * 0.0722) / 255;
      const r = Math.round(255 * Math.min(1, Math.max(0, lo + (hi - lo) * lum)));
      d[p] = r; d[p + 1] = r; d[p + 2] = r; d[p + 3] = 255;
    }
    out.ctx.putImageData(dst, 0, 0);
    return this.finish(key, out.canvas, false);
  }

  /** Separable wrapping box blur of radius r, in place (tmp is scratch of the same size). */
  private boxBlur(a: Float32Array, tmp: Float32Array, W: number, H: number, r: number): void {
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += a[row + ((x + k + W * 2) % W)];
        tmp[row + x] = sum * inv;
      }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += tmp[((y + k + H * 2) % H) * W + x];
        a[y * W + x] = sum * inv;
      }
    }
  }

  /**
   * Ground-floor shopfront atlas: SHOP_ROWS rows of one 24 m x 4.2 m tile each (2048 x 1152 px, 85 px/m), every tile
   * four SHOP_BAY_W bays between stone piers, so each of the twelve SHOP_BAYS kinds owns a whole 6 m bay: a 1.3 m door
   * cell (SHOP_DOOR_W at bay.door, the geometry recesses it) beside big glazing with a painted interior behind it
   * (shelving, counters, a doner spit, mannequins, cafe tables, tiled floors), a bay under a rolled steel shutter with
   * tags sprayed over it and a whitewashed vacant unit with a KİRALIK notice. The fascia (SHOP_FASCIA_Y..4.2 m; its top
   * 0.32 m sits behind the arcade cap) carries 0.45 m letters and is painted in VALUE only - a dark board with light
   * letters, a light sign-box face with dark letters, a grained timber board - so the geometry can tint it per bay
   * from the building's own palette and a street's signs share two or three hues instead of twelve. The interior scene
   * is drawn once on a scratch canvas and used twice: dimmed through the glass in the albedo and under a warm ceiling
   * light in the emissive, so the same shelves that show by day glow at night. Relief comes from a structure canvas
   * (piers, frames, slats), not the albedo, so a poster does not read as a bump. The emissive, structure and roughness
   * canvases are a quarter / an eighth of the albedo: they carry pane-sized shapes, and the door reveals are geometry.
   */
  shopfront(): WindowTextures {
    const key = 'shop';
    const mk = this.cache.get(key + ':map') as THREE.CanvasTexture | undefined;
    const ek = this.cache.get(key + ':emi') as THREE.CanvasTexture | undefined;
    const nk = this.cache.get(key + ':nrm') as THREE.CanvasTexture | undefined;
    const rk = this.cache.get(key + ':rgh') as THREE.CanvasTexture | undefined;
    if (mk && ek && nk && rk) return { map: mk, emissive: ek, normal: nk, rough: rk };
    const W = 2048, RH = 384, H = RH * SHOP_ROWS;
    const sx = W / SHOP_TILE_W, sy = RH / SHOP_BAND_H;
    let rowTop = 0;
    const X = (mx: number): number => mx * sx;
    const Y = (my: number): number => rowTop + (SHOP_BAND_H - my) * sy;
    const rng = new Random(1301);
    const m = this.canvas(W, H), e = this.canvas(W / 4, H / 4), r = this.canvas(W / 8, H / 8), n = this.canvas(W / 4, H / 4), scene = this.canvas(W, H);
    e.ctx.scale(0.25, 0.25);
    r.ctx.scale(0.125, 0.125);
    n.ctx.scale(0.25, 0.25);
    m.ctx.fillStyle = '#cdc6b8';
    m.ctx.fillRect(0, 0, W, H);
    this.mottle(m.ctx, W, H, rng, 160, 30, 90, 0.05, 0, 0, true);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, H);
    r.ctx.fillStyle = grey(0.9);
    r.ctx.fillRect(0, 0, W, H);
    n.ctx.fillStyle = grey(0.5);
    n.ctx.fillRect(0, 0, W, H);
    scene.ctx.clearRect(0, 0, W, H);
    const bays = SHOP_BAYS;
    // Heights above the pavement (m): stall riser, glazing head, fascia foot (the fascia runs to the band top).
    const RISER = 0.35, GLASS_TOP = 3.0, FASCIA_Y = SHOP_FASCIA_Y, PIER = 0.3;
    const sc = scene.ctx;
    // Palette for goods on shelves.
    const GOODS = ['#e04a2a', '#f2b632', '#2e8ad8', '#43b05c', '#f4f0e6', '#d94f8a', '#7b4ad6', '#ff8a2a'];
    const floorY = (): number => Y(0.85);
    const shelves = (x0: number, x1: number, ys: number[], dense: boolean, wallCol: string): void => {
      sc.fillStyle = wallCol;
      sc.fillRect(x0, Y(GLASS_TOP), x1 - x0, floorY() - Y(GLASS_TOP));
      for (const yb of ys) {
        const y = Y(yb);
        sc.fillStyle = '#d9cfbf';
        sc.fillRect(x0, y, x1 - x0, 4);
        sc.fillStyle = rgba(0, 0, 0, 0.25);
        sc.fillRect(x0, y + 4, x1 - x0, 3);
        for (let x = x0 + 4; x < x1 - 8;) {
          const w = rng.range(7, dense ? 12 : 16), h = rng.range(11, 24);
          sc.fillStyle = GOODS[rng.int(0, GOODS.length - 1)];
          sc.fillRect(x, y - h, w, h);
          sc.fillStyle = rgba(255, 255, 255, 0.25);
          sc.fillRect(x, y - h, w, 3);
          x += w + rng.range(2, dense ? 3 : 7);
        }
      }
    };
    const counter = (x0: number, x1: number, col: string, topCol: string): void => {
      const y = Y(0.95);
      sc.fillStyle = col;
      sc.fillRect(x0, y, x1 - x0, Y(0.4) - y);
      sc.fillStyle = topCol;
      sc.fillRect(x0 - 2, y - 4, x1 - x0 + 4, 6);
      sc.fillStyle = rgba(0, 0, 0, 0.3);
      sc.fillRect(x0 - 2, y + 2, x1 - x0 + 4, 4);
    };
    const poster = (x: number, y: number, w: number, h: number, col: string): void => {
      sc.fillStyle = '#f6f2ea';
      sc.fillRect(x, y, w, h);
      sc.fillStyle = col;
      sc.fillRect(x + 3, y + 3, w - 6, h * 0.55);
      sc.fillStyle = rgba(40, 40, 44, 0.7);
      for (let yy = y + h * 0.62; yy < y + h - 4; yy += 5) sc.fillRect(x + 4, yy, w - 8 - rng.range(0, w * 0.4), 2);
    };
    const floor = (x0: number, x1: number, light: string, dark: string): void => {
      // Tiled floor seen through the glass: rows closer together toward the back, a skirting line at the wall.
      const fy = floorY();
      sc.fillStyle = light;
      sc.fillRect(x0, fy, x1 - x0, Y(RISER) - fy);
      sc.fillStyle = dark;
      const rowsY = [0.85, 0.74, 0.62, 0.48];
      for (let i = 0; i < rowsY.length; i++) sc.fillRect(x0, Y(rowsY[i]), x1 - x0, 2);
      for (let x = x0; x < x1; x += 0.36 * sx) sc.fillRect(x, fy, 2, Y(RISER) - fy);
      sc.fillStyle = rgba(0, 0, 0, 0.45);
      sc.fillRect(x0, fy - 4, x1 - x0, 5);
    };
    const spots = (x0: number, x1: number, count: number): void => {
      // Ceiling: a darker strip with recessed spots drawn as bright discs (they bloom in the emissive).
      sc.fillStyle = '#6a625a';
      sc.fillRect(x0, Y(GLASS_TOP), x1 - x0, Y(2.78) - Y(GLASS_TOP));
      for (let k = 0; k < count; k++) {
        const cx = x0 + ((k + 0.5) / count) * (x1 - x0);
        sc.fillStyle = '#fff4dc';
        sc.beginPath();
        sc.arc(cx, Y(2.88), 5, 0, Math.PI * 2);
        sc.fill();
      }
    };
    const pendants = (x0: number, x1: number, count: number, cord: string): void => {
      // Pendant lamps on cords: a shade with a bright underside, hung a little lower than the recessed spots.
      for (let k = 0; k < count; k++) {
        const cx = x0 + ((k + 0.5) / count) * (x1 - x0);
        sc.fillStyle = cord;
        sc.fillRect(cx - 1, Y(GLASS_TOP), 2, Y(2.45) - Y(GLASS_TOP));
        sc.fillStyle = '#3a2c22';
        sc.beginPath();
        sc.moveTo(cx - 10, Y(2.28));
        sc.lineTo(cx + 10, Y(2.28));
        sc.lineTo(cx + 6, Y(2.45));
        sc.lineTo(cx - 6, Y(2.45));
        sc.closePath();
        sc.fill();
        sc.fillStyle = '#ffe9b8';
        sc.fillRect(cx - 9, Y(2.28), 18, 4);
      }
    };
    const table = (cx: number, round: boolean, cloth: string | null): void => {
      // A table with two chairs seen from the pavement: top at 0.75 m, a stem or four legs, chairs as dark backs.
      const tw = round ? 0.62 * sx : 0.9 * sx, y = Y(0.75);
      sc.fillStyle = '#3a3034';
      if (round) sc.fillRect(cx - 2, y, 4, Y(0.42) - y);
      else { sc.fillRect(cx - tw / 2 + 3, y, 3, Y(0.42) - y); sc.fillRect(cx + tw / 2 - 6, y, 3, Y(0.42) - y); }
      sc.fillStyle = cloth ?? '#8a5c34';
      sc.fillRect(cx - tw / 2, y - 4, tw, cloth ? 16 : 5);
      sc.fillStyle = rgba(0, 0, 0, 0.35);
      sc.fillRect(cx - tw / 2, y + (cloth ? 12 : 1), tw, 2);
      for (const s of [-1, 1]) {
        const x = cx + s * (tw / 2 + 9);
        sc.fillStyle = '#2c2428';
        sc.fillRect(x - 5, Y(1.0), 10, Y(0.7) - Y(1.0));
        sc.fillRect(x - 4, Y(0.7), 2, Y(0.42) - Y(0.7));
        sc.fillRect(x + 2, Y(0.7), 2, Y(0.42) - Y(0.7));
      }
    };
    const crates = (x: number, rows: number, cols: number): void => {
      // Fruit crates stacked at the window.
      for (let row = 0; row < rows; row++) {
        for (let k = 0; k < cols; k++) {
          const cx = x + k * 0.42 * sx, y = Y(0.85 + row * 0.32);
          sc.fillStyle = '#a8804a';
          sc.fillRect(cx, y - 0.3 * sy, 0.38 * sx, 0.3 * sy);
          sc.fillStyle = ['#ff8a2a', '#d8302a', '#5cc040', '#f2d040'][rng.int(0, 3)];
          for (let b = 0; b < 4; b++) { sc.beginPath(); sc.arc(cx + 4 + b * 6, y - 0.3 * sy + 4, 3.5, 0, Math.PI * 2); sc.fill(); }
        }
      }
    };
    // Value-only fascia lettering: 0.45 m capitals (a 0.62 m em) so the name reads from the street, not the pavement.
    const fasciaFont = `900 ${Math.round(0.62 * sy)}px 'Trebuchet MS', 'Segoe UI', 'DejaVu Sans', Arial, sans-serif`;
    const woodFont = `bold ${Math.round(0.6 * sy)}px Georgia, 'Times New Roman', 'DejaVu Serif', serif`;
    const stairDoor = (dx: number, dw: number): void => {
      // Painted stair entrance (the geometry does not recess it): a dark reveal with a lit jamb, two granite risers
      // climbing into it, a panelled timber door with a fanlight and a number plate.
      m.ctx.fillStyle = '#2a2622';
      m.ctx.fillRect(dx, Y(GLASS_TOP), dw, Y(0) - Y(GLASS_TOP));
      this.softRect(m.ctx, dx, Y(GLASS_TOP), 6, Y(0.34) - Y(GLASS_TOP), '#a29a8c', 0.55);
      for (let k = 0; k < 2; k++) {
        const ry0 = Y((k + 1) * 0.17), ry1 = Y(k * 0.17);
        m.ctx.fillStyle = k === 0 ? '#8a8478' : '#7c766a';
        m.ctx.fillRect(dx + 3 + k * 4, ry0, dw - 6 - k * 8, ry1 - ry0);
        this.softRect(m.ctx, dx + 3 + k * 4, ry0, dw - 6 - k * 8, 2, '#fff', 0.4);
        n.ctx.fillStyle = grey(0.42 + k * 0.08);
        n.ctx.fillRect(dx + 3 + k * 4, ry0, dw - 6 - k * 8, ry1 - ry0);
      }
      const lw = dw - 16, lx = dx + 8;
      m.ctx.fillStyle = '#6a4426';
      m.ctx.fillRect(lx, Y(2.5), lw, Y(0.34) - Y(2.5));
      for (const [py0, py1] of [[2.3, 1.55], [1.35, 0.6]]) {
        this.softRect(m.ctx, lx + 7, Y(py0), lw - 14, Y(py1) - Y(py0), '#000', 0.3);
        this.softRect(m.ctx, lx + 10, Y(py0) + 3, lw - 20, Y(py1) - Y(py0) - 6, '#8a5c34', 1);
      }
      m.ctx.fillStyle = '#c8a040';
      m.ctx.fillRect(lx + lw - 11, Y(1.05), 4, 8);
      m.ctx.fillStyle = '#9fb0b8';
      m.ctx.fillRect(lx, Y(2.95), lw, Y(2.55) - Y(2.95));
      e.ctx.fillStyle = rgba(150, 120, 80, 1);
      e.ctx.fillRect(lx, Y(2.95), lw, Y(2.55) - Y(2.95));
      m.ctx.fillStyle = '#1a3c8c';
      m.ctx.fillRect(dx - 14, Y(2.2), 12, 9);
      m.ctx.fillStyle = '#b8b4a8';
      m.ctx.fillRect(dx - 13, Y(1.7), 8, 18);
      n.ctx.fillStyle = grey(0.22);
      n.ctx.fillRect(dx, Y(GLASS_TOP), dw, Y(0.34) - Y(GLASS_TOP));
      r.ctx.fillStyle = grey(0.55);
      r.ctx.fillRect(lx, Y(2.5), lw, Y(0.34) - Y(2.5));
    };
    for (let i = 0; i < bays.length; i++) {
      const bay = bays[i];
      const row = Math.floor(i / 4), col = i % 4;
      rowTop = row * RH;
      const mx = col * SHOP_BAY_W;
      const bx0 = X(mx), bx1 = X(mx + SHOP_BAY_W);
      const ix0 = X(mx + PIER / 2), ix1 = X(mx + SHOP_BAY_W - PIER / 2);
      // Door cell (the geometry pushes it 0.6 m into the wall): the glazing runs up to its jambs on either side.
      const hasDoor = bay.door >= 0;
      const dx0 = hasDoor ? X(mx + bay.door) : 0, dx1 = hasDoor ? X(mx + bay.door + SHOP_DOOR_W) : 0;
      const gy0 = Y(GLASS_TOP), gy1 = Y(RISER);
      if (bay.kind === 'shutter') {
        // Rolled steel shutter down over the whole opening: a housing box, slats, tags sprayed low and a torn poster.
        m.ctx.fillStyle = '#5a5e62';
        m.ctx.fillRect(ix0, Y(GLASS_TOP + 0.05), ix1 - ix0, Y(2.75) - Y(GLASS_TOP + 0.05));
        this.softRect(m.ctx, ix0, Y(2.75), ix1 - ix0, 5, '#000', 0.35);
        for (let y = Y(2.75); y < Y(RISER); y += 8) {
          m.ctx.fillStyle = '#9ca2a6';
          m.ctx.fillRect(ix0, y, ix1 - ix0, 8);
          this.softRect(m.ctx, ix0, y, ix1 - ix0, 2, '#fff', 0.3);
          this.softRect(m.ctx, ix0, y + 5, ix1 - ix0, 3, '#000', 0.3);
          n.ctx.fillStyle = grey(0.58);
          n.ctx.fillRect(ix0, y, ix1 - ix0, 4);
          n.ctx.fillStyle = grey(0.42);
          n.ctx.fillRect(ix0, y + 4, ix1 - ix0, 4);
        }
        m.ctx.lineCap = 'round';
        m.ctx.lineWidth = 7;
        m.ctx.strokeStyle = rgba(230, 40, 120, 0.8);
        m.ctx.beginPath();
        m.ctx.moveTo(ix0 + 40, Y(1.2));
        m.ctx.quadraticCurveTo(ix0 + 90, Y(0.5), ix0 + 140, Y(1.15));
        m.ctx.lineTo(ix0 + 190, Y(0.6));
        m.ctx.stroke();
        m.ctx.strokeStyle = rgba(40, 60, 200, 0.7);
        m.ctx.beginPath();
        m.ctx.moveTo(ix0 + 200, Y(0.9));
        m.ctx.quadraticCurveTo(ix0 + 270, Y(1.6), ix0 + 340, Y(0.85));
        m.ctx.stroke();
        m.ctx.lineWidth = 5;
        m.ctx.strokeStyle = rgba(250, 230, 40, 0.75);
        m.ctx.beginPath();
        m.ctx.moveTo(ix0 + 60, Y(1.9));
        m.ctx.lineTo(ix0 + 110, Y(2.4));
        m.ctx.lineTo(ix0 + 130, Y(1.8));
        m.ctx.stroke();
        m.ctx.fillStyle = '#e8e2d4';
        m.ctx.fillRect(ix1 - 70, Y(2.5), 44, 56);
        m.ctx.fillStyle = '#c83a2a';
        m.ctx.fillRect(ix1 - 66, Y(2.5) + 4, 36, 26);
        r.ctx.fillStyle = grey(0.5);
        r.ctx.fillRect(ix0, Y(GLASS_TOP + 0.05), ix1 - ix0, Y(RISER) - Y(GLASS_TOP + 0.05));
      } else if (bay.kind === 'vacant') {
        // Whitewashed vacant unit: the panes painted over from inside in streaky white, a taped KİRALIK notice with a
        // phone line, and a blank fascia carrying the ghost of the sign that came down. Nothing lit at night.
        const gx0 = ix0 + 6, gx1 = ix1 - 6;
        m.ctx.fillStyle = '#d6d2c6';
        m.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        for (let x = gx0; x < gx1;) {
          const w = rng.range(4, 12);
          m.ctx.fillStyle = rng.chance(0.55) ? rgba(255, 255, 255, rng.range(0.1, 0.32)) : rgba(110, 100, 86, rng.range(0.06, 0.18));
          m.ctx.fillRect(x, gy0 + rng.range(0, 24), w, gy1 - gy0);
          x += w;
        }
        const wash = m.ctx.createLinearGradient(0, gy0, 0, gy1);
        wash.addColorStop(0, rgba(190, 205, 215, 0.3));
        wash.addColorStop(0.5, rgba(190, 205, 215, 0));
        wash.addColorStop(1, rgba(70, 62, 50, 0.22));
        m.ctx.fillStyle = wash;
        m.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        // The notice: an A3 sheet with a red heading and a phone line, a strip of tape at each top corner.
        const nw = 0.42 * sx, nh = 0.58 * sy, nx = gx0 + (dx0 - gx0) / 2 - nw / 2, ny = Y(2.05);
        m.ctx.fillStyle = '#f8f6f0';
        m.ctx.fillRect(nx, ny, nw, nh);
        m.ctx.font = `900 ${Math.round(0.14 * sy)}px 'Trebuchet MS', 'Segoe UI', 'DejaVu Sans', Arial, sans-serif`;
        m.ctx.textAlign = 'center';
        m.ctx.textBaseline = 'middle';
        m.ctx.fillStyle = '#c8241e';
        m.ctx.fillText('KİRALIK', nx + nw / 2, ny + nh * 0.28, nw - 6);
        m.ctx.fillStyle = '#2a2a30';
        for (let k = 0; k < 3; k++) m.ctx.fillRect(nx + 5, ny + nh * (0.52 + k * 0.14), nw - 10 - k * 6, 2);
        m.ctx.fillStyle = rgba(255, 240, 200, 0.7);
        m.ctx.fillRect(nx - 3, ny - 2, 9, 4);
        m.ctx.fillRect(nx + nw - 6, ny - 2, 9, 4);
        // Boarded door in the door cell: plywood with a padlocked hasp.
        m.ctx.fillStyle = '#a88a5a';
        m.ctx.fillRect(dx0 + 4, Y(2.5), dx1 - dx0 - 8, Y(RISER) - Y(2.5));
        m.ctx.fillStyle = rgba(0, 0, 0, 0.18);
        for (let yy = Y(2.3); yy < Y(0.5); yy += 22) m.ctx.fillRect(dx0 + 4, yy, dx1 - dx0 - 8, 3);
        m.ctx.fillStyle = '#4a4a50';
        m.ctx.fillRect(dx1 - 22, Y(1.15), 10, 8);
        m.ctx.fillStyle = '#9fb0b8';
        m.ctx.fillRect(dx0 + 4, Y(2.95), dx1 - dx0 - 8, Y(2.55) - Y(2.95));
        // Frame, mullions and the door jambs.
        for (const c of [m.ctx, e.ctx]) {
          c.fillStyle = c === m.ctx ? '#3a3e44' : '#000';
          c.fillRect(gx0 - 6, gy0 - 8, gx1 - gx0 + 12, 8);
          c.fillRect(gx0 - 6, gy0, 6, gy1 - gy0);
          c.fillRect(gx1, gy0, 6, gy1 - gy0);
          for (let x = gx0 + 1.2 * sx; x < dx0 - 20; x += 1.2 * sx) c.fillRect(x - 3, gy0, 6, gy1 - gy0);
          c.fillRect(dx0 - 5, gy0, 5, gy1 - gy0);
          c.fillRect(dx1, gy0, 5, gy1 - gy0);
        }
        this.softRect(m.ctx, gx0 - 6, gy0 - 8, gx1 - gx0 + 12, 3, '#9aa8b4', 0.5);
        n.ctx.fillStyle = grey(0.4);
        n.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        n.ctx.fillStyle = grey(0.62);
        n.ctx.fillRect(gx0 - 6, gy0 - 8, gx1 - gx0 + 12, 8);
        r.ctx.fillStyle = grey(0.5);
        r.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
      } else {
        // Glazed shop: interior scene across the whole bay (the door glass shows it too), then the glass over it.
        const gx0 = ix0 + 6, gx1 = ix1 - 6;
        const doorLeft = bay.door < SHOP_BAY_W / 2 - 0.5, doorMid = !doorLeft && bay.door < SHOP_BAY_W / 2 + 0.5;
        // Clear floor space: the run of window between the door and the far pier (the display side).
        const wx0 = doorLeft ? dx1 + 8 : gx0, wx1 = doorLeft ? gx1 : dx0 - 8;
        // A narrow stair entrance painted beside the simit shop: its window ends at the stair jamb.
        const stairW = bay.kind === 'simit' ? 1.15 * sx : 0;
        const sx0 = gx0 + stairW;
        sc.save();
        sc.beginPath();
        sc.rect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        sc.clip();
        switch (bay.kind) {
          case 'bakkal': {
            shelves(gx0, gx1, [1.35, 1.95, 2.55], false, '#c9b48a');
            spots(gx0, gx1, 4);
            floor(gx0, gx1, '#b8ae9e', rgba(60, 50, 40, 0.5));
            crates(wx0 + 0.2 * sx, 2, 3);
            counter(wx1 - 1.5 * sx, wx1 - 0.2 * sx, '#7a5a3a', '#e0d6c4');
            poster(wx0 + 1.7 * sx, Y(2.7), 40, 56, '#d8a030');
            break;
          }
          case 'manav': {
            // Greengrocer: green wall, tiered produce racks, crates under them and a scale on the counter.
            sc.fillStyle = '#7f9a68';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            spots(gx0, gx1, 4);
            floor(gx0, gx1, '#a8a08c', rgba(50, 46, 40, 0.5));
            for (const yb of [1.15, 1.55, 1.95]) {
              const y = Y(yb);
              sc.fillStyle = '#8a6a40';
              sc.fillRect(wx0, y, wx1 - wx0, 4);
              for (let x = wx0 + 6; x < wx1 - 12; x += 0.32 * sx) {
                sc.fillStyle = ['#ff8a2a', '#d8302a', '#5cc040', '#f2d040', '#8a2a8a', '#e86a3a'][rng.int(0, 5)];
                for (let b = 0; b < 3; b++) { sc.beginPath(); sc.arc(x + 4 + b * 7, y - 5, 4.5, 0, Math.PI * 2); sc.fill(); }
              }
            }
            crates(wx0 + 0.3 * sx, 1, Math.floor((wx1 - wx0) / (0.42 * sx)) - 1);
            counter(doorLeft ? wx1 - 1.2 * sx : wx0 + 0.2 * sx, doorLeft ? wx1 - 0.2 * sx : wx0 + 1.2 * sx, '#5a4a3a', '#d8d0c0');
            break;
          }
          case 'eczane': {
            sc.fillStyle = '#eef2ee';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            for (const yb of [1.4, 2.0, 2.6]) {
              const y = Y(yb);
              sc.fillStyle = '#d8dcd8';
              sc.fillRect(gx0, y, gx1 - gx0, 4);
              for (let x = gx0 + 6; x < gx1 - 10;) {
                const w = rng.range(7, 12), h = rng.range(10, 20);
                sc.fillStyle = rng.chance(0.6) ? '#f8fafc' : rng.chance(0.5) ? '#3b78c8' : '#3cb060';
                sc.fillRect(x, y - h, w, h);
                sc.fillStyle = rgba(0, 0, 0, 0.12);
                sc.fillRect(x, y - h, w, 2);
                x += w + 3;
              }
            }
            spots(gx0, gx1, 5);
            floor(gx0, gx1, '#d4d6d2', rgba(70, 76, 80, 0.35));
            counter(wx0 + 0.4 * sx, wx0 + 2.2 * sx, '#e8ece8', '#b8c4c8');
            // Green cross on the back wall.
            const cxp = wx1 - 1.1 * sx;
            sc.fillStyle = '#1e9a4c';
            sc.fillRect(cxp, Y(2.7), 40, 40);
            sc.fillStyle = '#ffffff';
            sc.fillRect(cxp + 16, Y(2.7) + 6, 8, 28);
            sc.fillRect(cxp + 6, Y(2.7) + 16, 28, 8);
            poster(wx1 - 0.7 * sx, Y(2.0), 34, 48, '#3b78c8');
            break;
          }
          case 'kebap': {
            sc.fillStyle = '#8a3628';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            // Menu board on the back wall.
            const mbx = wx0 + 0.3 * sx;
            sc.fillStyle = '#2a1a14';
            sc.fillRect(mbx, Y(2.85), 1.3 * sx, Y(2.05) - Y(2.85));
            sc.fillStyle = rgba(255, 236, 200, 0.85);
            for (let yy = Y(2.75); yy < Y(2.1); yy += 9) sc.fillRect(mbx + 6, yy, rng.range(30, 90), 3);
            spots(gx0, gx1, 4);
            floor(gx0, gx1, '#b09a80', rgba(60, 40, 30, 0.5));
            // Counter with a steel top and the doner spit standing on it; tables beyond it.
            const kx0 = wx0 + 0.2 * sx, kx1 = wx0 + 2.4 * sx;
            counter(kx0, kx1, '#4a3a30', '#c8ccd0');
            const sxp = (kx0 + kx1) / 2;
            const spit = sc.createLinearGradient(sxp - 14, 0, sxp + 14, 0);
            spit.addColorStop(0, '#7a4218');
            spit.addColorStop(0.45, '#d89048');
            spit.addColorStop(1, '#8a4c1c');
            sc.fillStyle = spit;
            sc.beginPath();
            sc.moveTo(sxp - 9, Y(2.3));
            sc.lineTo(sxp + 9, Y(2.3));
            sc.lineTo(sxp + 15, Y(1.15));
            sc.lineTo(sxp - 15, Y(1.15));
            sc.closePath();
            sc.fill();
            sc.fillStyle = '#c0c4c8';
            sc.fillRect(sxp - 1, Y(2.5), 3, Y(1.0) - Y(2.5));
            sc.fillStyle = rgba(255, 120, 40, 0.5);
            sc.fillRect(sxp + 18, Y(2.25), 8, Y(1.2) - Y(2.25));
            table(kx1 + 0.7 * sx, false, '#e8dcc0');
            if (kx1 + 2.0 * sx < wx1 - 0.3 * sx) table(kx1 + 1.8 * sx, false, '#e8dcc0');
            break;
          }
          case 'kuafor': {
            sc.fillStyle = '#caa8bc';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            spots(gx0, gx1, 5);
            floor(gx0, gx1, '#c8c0c4', rgba(60, 40, 60, 0.35));
            // Mirrors with chairs in front of them on both sides of the centre door.
            for (const [a, b] of [[gx0, dx0 - 8], [dx1 + 8, gx1]]) {
              for (let x = a + 0.15 * sx; x + 0.7 * sx < b; x += 0.9 * sx) {
                sc.fillStyle = '#3a3038';
                sc.fillRect(x - 3, Y(2.5), 0.62 * sx + 6, Y(1.45) - Y(2.5) + 6);
                const mg = sc.createLinearGradient(0, Y(2.5), 0, Y(1.45));
                mg.addColorStop(0, '#eef4f8');
                mg.addColorStop(1, '#b8c8d4');
                sc.fillStyle = mg;
                sc.fillRect(x, Y(2.5) + 3, 0.62 * sx, Y(1.45) - Y(2.5));
                sc.fillStyle = '#26262c';
                sc.fillRect(x + 6, Y(1.3), 0.46 * sx, Y(0.7) - Y(1.3));
                sc.fillStyle = '#9aa0a6';
                sc.fillRect(x + 0.24 * sx, Y(0.7), 7, Y(0.5) - Y(0.7));
                sc.fillRect(x + 0.1 * sx, Y(0.5), 0.3 * sx, 4);
              }
            }
            poster(gx0 + 12, Y(2.7), 36, 50, '#d8407a');
            break;
          }
          case 'simit': {
            sc.fillStyle = '#d9b070';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            spots(sx0, gx1, 3);
            floor(sx0, gx1, '#c4b49a', rgba(70, 50, 30, 0.45));
            // Back shelves and a glass display case, both stacked with simit rings.
            const ring = (x: number, y: number): void => {
              sc.fillStyle = '#c98a3a';
              sc.beginPath(); sc.arc(x, y, 6.5, 0, Math.PI * 2); sc.fill();
              sc.fillStyle = '#7a4c18';
              sc.beginPath(); sc.arc(x, y, 2.5, 0, Math.PI * 2); sc.fill();
              sc.fillStyle = rgba(255, 240, 200, 0.35);
              sc.beginPath(); sc.arc(x - 1.5, y - 2, 3, 0, Math.PI * 2); sc.fill();
            };
            for (const yb of [1.7, 2.2, 2.7]) {
              sc.fillStyle = '#8a6030';
              sc.fillRect(sx0, Y(yb), gx1 - sx0, 4);
              for (let x = sx0 + 10; x < gx1 - 8; x += 15) ring(x, Y(yb) - 7);
            }
            const cx0 = sx0 + 0.3 * sx, cx1 = wx1 - 0.3 * sx;
            counter(cx0, cx1, '#e8e2d8', '#b0aca4');
            sc.fillStyle = rgba(200, 230, 240, 0.35);
            sc.fillRect(cx0, Y(1.45), cx1 - cx0, Y(0.95) - Y(1.45));
            for (let x = cx0 + 10; x < cx1 - 8; x += 15) ring(x, Y(1.1));
            break;
          }
          case 'market': {
            shelves(gx0, gx1, [1.15, 1.65, 2.15, 2.65], true, '#e6e6de');
            spots(gx0, gx1, 5);
            floor(gx0, gx1, '#d0d2cc', rgba(60, 64, 70, 0.35));
            // Drinks fridges by the door and a till at the far end.
            for (let k = 0; k < 2; k++) {
              const fw = 0.6 * sx, fx = wx0 + 0.15 * sx + k * (fw + 8);
              sc.fillStyle = '#e4e8ec';
              sc.fillRect(fx, Y(2.3), fw, Y(0.45) - Y(2.3));
              sc.fillStyle = '#24405c';
              sc.fillRect(fx + 4, Y(2.15), fw - 8, Y(0.6) - Y(2.15));
              sc.fillStyle = rgba(120, 200, 255, 0.6);
              sc.fillRect(fx + 4, Y(2.15), fw - 8, 3);
              for (let yy = Y(1.95); yy < Y(0.7); yy += 16) for (let x = fx + 8; x < fx + fw - 12; x += 9) { sc.fillStyle = GOODS[rng.int(0, 3)]; sc.fillRect(x, yy, 6, 12); }
            }
            counter(wx1 - 1.4 * sx, wx1 - 0.2 * sx, '#c8c4bc', '#e8e8e0');
            break;
          }
          case 'butik': {
            sc.fillStyle = '#efe6d8';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            spots(gx0, gx1, 5);
            floor(gx0, gx1, '#c8b8a0', rgba(80, 60, 40, 0.4));
            // Clothes rail across the back.
            sc.fillStyle = '#8a8a90';
            sc.fillRect(gx0 + 8, Y(2.3), gx1 - gx0 - 16, 3);
            for (let x = gx0 + 14; x < gx1 - 20; x += 16) {
              sc.fillStyle = GOODS[rng.int(0, GOODS.length - 1)];
              sc.fillRect(x, Y(2.3) + 6, 12, Y(1.3) - Y(2.3));
            }
            // Mannequins in both windows: torso on a stand.
            let k = 0;
            for (const [a, b] of [[gx0, dx0 - 8], [dx1 + 8, gx1]]) {
              for (let x = a + 0.25 * sx; x + 0.4 * sx < b; x += 0.9 * sx, k++) {
                sc.fillStyle = '#3a3a40';
                sc.fillRect(x + 0.14 * sx, Y(0.85), 4, Y(0.42) - Y(0.85));
                sc.fillRect(x + 0.04 * sx, Y(0.42), 0.26 * sx, 4);
                sc.fillStyle = ['#d84060', '#3868b8', '#e8c040', '#40a878'][k % 4];
                sc.beginPath();
                sc.moveTo(x, Y(1.95));
                sc.lineTo(x + 0.34 * sx, Y(1.95));
                sc.lineTo(x + 0.3 * sx, Y(0.9));
                sc.lineTo(x + 0.04 * sx, Y(0.9));
                sc.closePath();
                sc.fill();
                sc.fillStyle = '#e8d8c8';
                sc.beginPath(); sc.arc(x + 0.17 * sx, Y(2.1), 8, 0, Math.PI * 2); sc.fill();
              }
            }
            poster(gx1 - 50, Y(2.85), 36, 50, '#e0a030');
            break;
          }
          case 'kahve': {
            // Cafe: dark timber wall with a chalkboard menu, an espresso counter, pendants and small round tables.
            sc.fillStyle = '#5c4232';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            sc.fillStyle = rgba(0, 0, 0, 0.2);
            for (let x = gx0; x < gx1; x += 0.22 * sx) sc.fillRect(x, gy0, 2, gy1 - gy0);
            const cbx = wx0 + 0.2 * sx;
            sc.fillStyle = '#243428';
            sc.fillRect(cbx, Y(2.85), 1.2 * sx, Y(2.0) - Y(2.85));
            sc.fillStyle = rgba(255, 244, 220, 0.8);
            for (let yy = Y(2.75); yy < Y(2.05); yy += 8) sc.fillRect(cbx + 6, yy, rng.range(24, 90), 2);
            pendants(gx0, gx1, 4, '#1a1410');
            floor(gx0, gx1, '#a89078', rgba(50, 36, 28, 0.5));
            const kx0 = wx0 + 0.2 * sx, kx1 = wx0 + 1.8 * sx;
            counter(kx0, kx1, '#3a2a20', '#d8cdbc');
            // Espresso machine: a steel box with a chrome top and a red switch light.
            const ex = (kx0 + kx1) / 2 - 0.2 * sx;
            sc.fillStyle = '#b8bcc2';
            sc.fillRect(ex, Y(1.4), 0.4 * sx, Y(0.95) - Y(1.4));
            sc.fillStyle = '#e8ecf0';
            sc.fillRect(ex - 2, Y(1.45), 0.4 * sx + 4, 4);
            sc.fillStyle = '#e02020';
            sc.fillRect(ex + 4, Y(1.25), 4, 4);
            for (let tx = kx1 + 0.75 * sx; tx + 0.4 * sx < wx1; tx += 1.0 * sx) table(tx, true, null);
            break;
          }
          case 'lokanta': {
            // Restaurant: pale wall with framed pictures, tables under white cloths, a display counter at the door.
            sc.fillStyle = '#d8c8a8';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            sc.fillStyle = '#8a4a30';
            sc.fillRect(gx0, Y(1.35), gx1 - gx0, Y(0.85) - Y(1.35));
            for (let k = 0; k < 4; k++) {
              const px = gx0 + 0.4 * sx + k * 1.25 * sx;
              if (px + 44 > gx1) break;
              sc.fillStyle = '#3a2a1c';
              sc.fillRect(px, Y(2.7), 42, 34);
              sc.fillStyle = ['#5c9ad8', '#d8a050', '#7ab070', '#c85a40'][k];
              sc.fillRect(px + 4, Y(2.7) + 4, 34, 26);
            }
            spots(gx0, gx1, 6);
            floor(gx0, gx1, '#d4c8b4', rgba(80, 60, 40, 0.35));
            for (let tx = wx0 + 0.65 * sx; tx + 0.5 * sx < wx1 - 1.2 * sx; tx += 1.15 * sx) table(tx, false, '#f4f0e6');
            const cx0 = wx1 - 1.1 * sx, cx1 = wx1 - 0.15 * sx;
            counter(cx0, cx1, '#6a4a34', '#c8ccd0');
            sc.fillStyle = rgba(200, 230, 240, 0.35);
            sc.fillRect(cx0, Y(1.5), cx1 - cx0, Y(0.95) - Y(1.5));
            for (let x = cx0 + 8; x < cx1 - 10; x += 16) { sc.fillStyle = ['#c86a30', '#e8d090', '#a03828'][rng.int(0, 2)]; sc.fillRect(x, Y(1.25), 10, 9); }
            break;
          }
          default:
            break;
        }
        // Door mat and threshold shadow inside the door cell.
        sc.fillStyle = rgba(0, 0, 0, 0.2);
        sc.fillRect(dx0, Y(0.62), dx1 - dx0, Y(RISER) - Y(0.62));
        sc.restore();
        // Albedo: dark glass, the scene seen through it, a sky gradient and a diagonal sheen over it.
        m.ctx.fillStyle = '#2c3e4e';
        m.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        m.ctx.globalAlpha = 0.78;
        m.ctx.drawImage(scene.canvas, gx0, gy0, gx1 - gx0, gy1 - gy0, gx0, gy0, gx1 - gx0, gy1 - gy0);
        m.ctx.globalAlpha = 1;
        const refl = m.ctx.createLinearGradient(0, gy0, 0, gy1);
        refl.addColorStop(0, rgba(200, 228, 244, 0.28));
        refl.addColorStop(0.4, rgba(200, 228, 244, 0.04));
        refl.addColorStop(1, rgba(20, 30, 40, 0.16));
        m.ctx.fillStyle = refl;
        m.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        m.ctx.save();
        m.ctx.beginPath();
        m.ctx.rect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        m.ctx.clip();
        for (const sh of [0.2, 0.7]) {
          const shx = gx0 + (gx1 - gx0) * (sh + rng.range(-0.08, 0.08));
          const sheen = m.ctx.createLinearGradient(shx, gy0, shx + 70, gy1);
          sheen.addColorStop(0, rgba(255, 255, 255, 0));
          sheen.addColorStop(0.45, rgba(255, 255, 255, 0.1));
          sheen.addColorStop(0.55, rgba(255, 255, 255, 0.1));
          sheen.addColorStop(1, rgba(255, 255, 255, 0));
          m.ctx.fillStyle = sheen;
          m.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        }
        m.ctx.restore();
        // Emissive: the scene under a warm ceiling light that falls off toward the floor.
        e.ctx.drawImage(scene.canvas, gx0, gy0, gx1 - gx0, gy1 - gy0, gx0, gy0, gx1 - gx0, gy1 - gy0);
        e.ctx.save();
        e.ctx.globalCompositeOperation = 'multiply';
        const warm = e.ctx.createLinearGradient(0, gy0, 0, gy1);
        warm.addColorStop(0, rgba(255, 226, 180, 1));
        warm.addColorStop(0.55, rgba(230, 190, 140, 1));
        warm.addColorStop(1, rgba(120, 90, 60, 1));
        e.ctx.fillStyle = warm;
        e.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        e.ctx.restore();
        // Frames: head and jambs, the door's frame, push bar and kick plate, a mullion every ~1.2 m; black in the emissive.
        const mullions: number[] = [];
        for (let x = gx0 + 1.2 * sx; x < gx1 - 0.5 * sx; x += 1.2 * sx) if ((x < dx0 - 14 || x > dx1 + 14) && x > sx0 + 10) mullions.push(x);
        for (const c of [m.ctx, e.ctx]) {
          c.fillStyle = c === m.ctx ? '#2a3038' : '#000';
          c.fillRect(gx0 - 6, gy0 - 8, gx1 - gx0 + 12, 8);
          c.fillRect(gx0 - 6, gy0, 6, gy1 - gy0);
          c.fillRect(gx1, gy0, 6, gy1 - gy0);
          for (const x of mullions) c.fillRect(x - 3, gy0, 6, gy1 - gy0);
          c.fillRect(dx0 - 5, gy0, 5, gy1 - gy0);
          c.fillRect(dx1, gy0, 5, gy1 - gy0);
          c.fillRect(dx0, Y(1.05), dx1 - dx0, 4);
          c.fillRect(dx0, Y(2.45), dx1 - dx0, 4);
          c.fillRect(dx0, Y(0.62), dx1 - dx0, Y(RISER) - Y(0.62));
        }
        this.softRect(m.ctx, gx0 - 6, gy0 - 8, gx1 - gx0 + 12, 3, '#9aa8b4', 0.7);
        for (const x of mullions) this.softRect(m.ctx, x - 3, gy0, 3, gy1 - gy0, '#9aa8b4', 0.5);
        this.softRect(m.ctx, dx0, Y(1.05), dx1 - dx0, 2, '#c8d0d8', 0.7);
        m.ctx.fillStyle = '#8c9298';
        m.ctx.fillRect(dx0, Y(0.62), dx1 - dx0, Y(RISER) - Y(0.62));
        if (stairW > 0) stairDoor(gx0, stairW);
        // Structure: glass recessed, frames raised. Roughness: glass smooth, frames satin.
        n.ctx.fillStyle = grey(0.36);
        n.ctx.fillRect(sx0, gy0, gx1 - sx0, gy1 - gy0);
        n.ctx.fillStyle = grey(0.62);
        n.ctx.fillRect(gx0 - 6, gy0 - 8, gx1 - gx0 + 12, 8);
        for (const x of mullions) n.ctx.fillRect(x - 3, gy0, 6, gy1 - gy0);
        n.ctx.fillRect(dx0 - 5, gy0, 5, gy1 - gy0);
        n.ctx.fillRect(dx1, gy0, 5, gy1 - gy0);
        r.ctx.fillStyle = grey(0.22);
        r.ctx.fillRect(sx0, gy0, gx1 - sx0, gy1 - gy0);
        r.ctx.fillStyle = grey(0.55);
        for (const x of mullions) r.ctx.fillRect(x - 3, gy0, 6, gy1 - gy0);
      }
      // Fascia, painted in value only (the geometry tints it): a dark board with light letters, a sign box whose
      // light face glows as a whole at night behind dark letters, a grained timber board with light serif lettering
      // under a spotlight. The vacant unit keeps a faded panel with the ghost of the old sign.
      {
        const fy0 = Y(SHOP_BAND_H), fy1 = Y(FASCIA_Y);
        const fx0 = bx0 + 3, fw = bx1 - bx0 - 6;
        // Letters sit in the visible part of the board (the top 0.32 m hides behind the arcade cap).
        const ty = (Y(SHOP_BAND_H - 0.32) + fy1) / 2 + 2;
        m.ctx.letterSpacing = '3px';
        if (bay.sign === 'none') {
          m.ctx.fillStyle = '#a4a4a0';
          m.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
          this.softRect(m.ctx, fx0, fy1 - 6, fw, 6, '#000', 0.25);
          m.ctx.font = fasciaFont;
          m.ctx.textAlign = 'center';
          m.ctx.textBaseline = 'middle';
          m.ctx.fillStyle = rgba(255, 252, 240, 0.35);
          m.ctx.fillText('MANAV', (bx0 + bx1) / 2, ty, fw - 40);
          // Rust tears from the old bracket holes.
          for (let k = 0; k < 4; k++) {
            const hx = fx0 + fw * (0.14 + k * 0.24);
            m.ctx.fillStyle = '#5a4a40';
            m.ctx.fillRect(hx - 2, fy0 + 30, 5, 5);
            const rust = m.ctx.createLinearGradient(0, fy0 + 34, 0, fy1 + 20);
            rust.addColorStop(0, rgba(120, 60, 20, 0.5));
            rust.addColorStop(1, rgba(120, 60, 20, 0));
            m.ctx.fillStyle = rust;
            m.ctx.fillRect(hx - 1, fy0 + 34, 3, fy1 - fy0);
          }
          n.ctx.fillStyle = grey(0.54);
          n.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
          r.ctx.fillStyle = grey(0.8);
          r.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
        } else if (bay.sign === 'lightbox') {
          // Acrylic sign box: a dark frame, the light face and dark letters; at night the whole face is lit.
          m.ctx.fillStyle = '#26282c';
          m.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
          m.ctx.fillStyle = '#ececea';
          m.ctx.fillRect(fx0 + 5, fy0 + 5, fw - 10, fy1 - fy0 - 10);
          this.softRect(m.ctx, fx0 + 5, fy0 + 5, fw - 10, 3, '#fff', 0.5);
          this.softRect(m.ctx, fx0 + 5, fy1 - 10, fw - 10, 5, '#000', 0.12);
          e.ctx.fillStyle = '#f4e4c4';
          e.ctx.fillRect(fx0 + 5, fy0 + 5, fw - 10, fy1 - fy0 - 10);
          for (const c of [m.ctx, e.ctx]) {
            c.font = fasciaFont;
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillStyle = c === m.ctx ? '#1c1c20' : '#000';
            c.fillText(bay.name, (bx0 + bx1) / 2, ty, fw - 44);
          }
          n.ctx.fillStyle = grey(0.6);
          n.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
          r.ctx.fillStyle = grey(0.35);
          r.ctx.fillRect(fx0 + 5, fy0 + 5, fw - 10, fy1 - fy0 - 10);
        } else if (bay.sign === 'wood') {
          // Timber board: grain lines, a bevelled edge, light serif lettering with a drop shadow, a spotlight wash.
          m.ctx.fillStyle = '#767472';
          m.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
          for (let yy = fy0 + 5; yy < fy1 - 3; yy += rng.range(4, 9)) {
            m.ctx.fillStyle = rgba(0, 0, 0, rng.range(0.08, 0.2));
            m.ctx.fillRect(fx0 + rng.range(0, 20), yy, fw - rng.range(0, 40), 2);
          }
          this.softRect(m.ctx, fx0, fy0, fw, 4, '#fff', 0.22);
          this.softRect(m.ctx, fx0, fy1 - 5, fw, 5, '#000', 0.4);
          this.softRect(m.ctx, fx0, fy0, 4, fy1 - fy0, '#fff', 0.15);
          const wash = e.ctx.createLinearGradient(0, fy0, 0, fy1);
          wash.addColorStop(0, '#3a3228');
          wash.addColorStop(1, '#141210');
          e.ctx.fillStyle = wash;
          e.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
          for (const c of [m.ctx, e.ctx]) {
            c.font = woodFont;
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            if (c === m.ctx) {
              c.fillStyle = rgba(0, 0, 0, 0.45);
              c.fillText(bay.name, (bx0 + bx1) / 2 + 3, ty + 3, fw - 40);
            }
            c.fillStyle = c === m.ctx ? '#f6ecd6' : '#c8b48c';
            c.fillText(bay.name, (bx0 + bx1) / 2, ty, fw - 40);
          }
          n.ctx.fillStyle = grey(0.58);
          n.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
          r.ctx.fillStyle = grey(0.7);
          r.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
        } else {
          // Painted board: a mid-dark panel with a lit top edge, light letters that stay lit at night.
          m.ctx.fillStyle = '#5e5e5e';
          m.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
          this.softRect(m.ctx, fx0, fy0, fw, 3, '#fff', 0.2);
          this.softRect(m.ctx, fx0, fy1 - 7, fw, 7, '#000', 0.35);
          e.ctx.fillStyle = '#161412';
          e.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
          for (const c of [m.ctx, e.ctx]) {
            c.font = fasciaFont;
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            if (c === m.ctx) {
              c.fillStyle = rgba(0, 0, 0, 0.35);
              c.fillText(bay.name, (bx0 + bx1) / 2 + 3, ty + 3, fw - 40);
            }
            c.fillStyle = c === m.ctx ? '#f8f4ea' : '#d8cca8';
            c.fillText(bay.name, (bx0 + bx1) / 2, ty, fw - 40);
          }
          n.ctx.fillStyle = grey(0.56);
          n.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
          r.ctx.fillStyle = grey(0.55);
          r.ctx.fillRect(fx0, fy0, fw, fy1 - fy0);
        }
        m.ctx.letterSpacing = '0px';
        // Awning bracket shadow just under the fascia (the real awnings are geometry).
        this.softRect(m.ctx, fx0, fy1, fw, 6, '#000', 0.18);
      }
      // Stone pier on the bay's left edge (the last bay's right pier wraps to the tile seam).
      const pxl = bx0 - X(PIER / 2), pw = X(PIER);
      const pierY0 = Y(FASCIA_Y), pierH = Y(0) - Y(FASCIA_Y);
      m.ctx.fillStyle = '#a9a396';
      m.ctx.fillRect(pxl, pierY0, pw, pierH);
      this.softRect(m.ctx, pxl, pierY0, 3, pierH, '#fff', 0.22);
      this.softRect(m.ctx, pxl + pw - 4, pierY0, 4, pierH, '#000', 0.28);
      if (pxl < 0) {
        m.ctx.fillRect(W + pxl, pierY0, -pxl, pierH);
        this.softRect(m.ctx, W + pxl, pierY0, 3, pierH, '#fff', 0.22);
      }
      e.ctx.fillStyle = '#000';
      e.ctx.fillRect(pxl, rowTop, pw, RH);
      if (pxl < 0) e.ctx.fillRect(W + pxl, rowTop, -pxl, RH);
      n.ctx.fillStyle = grey(0.64);
      n.ctx.fillRect(pxl, pierY0, pw, pierH);
      if (pxl < 0) n.ctx.fillRect(W + pxl, pierY0, -pxl, pierH);
    }
    // Stall riser / plinth strip along the bottom of every row (under the glazing, the piers stand on it). It doubles
    // as the plain cell for the door reveals (SHOP_PLAIN_UV).
    for (let row = 0; row < SHOP_ROWS; row++) {
      rowTop = row * RH;
      m.ctx.fillStyle = '#6c6a66';
      m.ctx.fillRect(0, Y(RISER), W, Y(0) - Y(RISER));
      this.softRect(m.ctx, 0, Y(RISER), W, 3, '#000', 0.3);
      e.ctx.fillStyle = '#000';
      e.ctx.fillRect(0, Y(RISER), W, Y(0) - Y(RISER));
      n.ctx.fillStyle = grey(0.56);
      n.ctx.fillRect(0, Y(RISER), W, Y(0) - Y(RISER));
      r.ctx.fillStyle = grey(0.85);
      r.ctx.fillRect(0, Y(RISER), W, Y(0) - Y(RISER));
      this.grime(m.ctx, W, rowTop + RH, rng, RH * 0.6, rowTop, 2);
    }
    this.soften(m.ctx, W, H);
    const map = this.finish(key + ':map', m.canvas, true, true, true);
    const emissive = this.finish(key + ':emi', e.canvas, true, true, true);
    const normal = this.normalFromLuminance(key + ':nrm', n.canvas, 5, 6);
    const rough = this.finish(key + ':rgh', r.canvas, false, true, true);
    return { map, emissive, normal, rough };
  }

  /**
   * Downtown lobby plinth band (24 m x 6 m at 1536 x 384 px, 64 px/m): PLINTH_BAYS bays of 4.8 m between wide pale
   * limestone piers standing on a polished granite base course, tall clear glazing with a baked lobby behind it
   * (reception desk, pendant lights, planters, lift doors, a seating group, a logo wall) and one double-door
   * entrance bay (PLINTH_DOOR_BAY) with a lit address number over the transom. The interior is drawn once on a scratch
   * canvas: dimmed behind the glass in the albedo, warm-lit in the emissive. Relief comes from a structure canvas
   * (piers, base course, frames), so the glazing reads as recessed between real piers rather than a corrugated wall.
   */
  plinth(): WindowTextures {
    const key = 'plinth';
    const mk = this.cache.get(key + ':map') as THREE.CanvasTexture | undefined;
    const ek = this.cache.get(key + ':emi') as THREE.CanvasTexture | undefined;
    const nk = this.cache.get(key + ':nrm') as THREE.CanvasTexture | undefined;
    const rk = this.cache.get(key + ':rgh') as THREE.CanvasTexture | undefined;
    if (mk && ek && nk && rk) return { map: mk, emissive: ek, normal: nk, rough: rk };
    const W = 1536, H = 384;
    const sx = W / PLINTH_TILE_W, sy = H / PLINTH_BAND_H;
    const X = (mx: number): number => mx * sx;
    const Y = (my: number): number => (PLINTH_BAND_H - my) * sy;
    const rng = new Random(1607);
    const m = this.canvas(W, H), e = this.canvas(W / 2, H / 2), n = this.canvas(W / 2, H / 2), r = this.canvas(W / 4, H / 4), scene = this.canvas(W, H);
    e.ctx.scale(0.5, 0.5);
    n.ctx.scale(0.5, 0.5);
    r.ctx.scale(0.25, 0.25);
    // Pale limestone ground with a soft mottle; the piers and bands are cut from it.
    m.ctx.fillStyle = '#c6beae';
    m.ctx.fillRect(0, 0, W, H);
    this.mottle(m.ctx, W, H, rng, 60, 24, 70, 0.05, 0, 0, true);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, H);
    n.ctx.fillStyle = grey(0.5);
    n.ctx.fillRect(0, 0, W, H);
    r.ctx.fillStyle = grey(0.85);
    r.ctx.fillRect(0, 0, W, H);
    // Heights above the pavement (m): granite base course, glazing head, cornice band. Pier width in metres.
    const BASE = 0.6, GLASS_TOP = 5.3, CORNICE = 5.5, PIER = 0.7, BAY = PLINTH_TILE_W / PLINTH_BAYS, DOOR_TOP = 3.0, TRANSOM = 3.6;
    const floorY = Y(1.35);
    // --- Lobby scene, one continuous room behind the whole tile -------------------------------------------------
    const sc = scene.ctx;
    sc.fillStyle = '#b9a88c';
    sc.fillRect(0, Y(GLASS_TOP), W, floorY - Y(GLASS_TOP));
    // Ceiling strip with a cove light line under it.
    sc.fillStyle = '#6a6058';
    sc.fillRect(0, Y(GLASS_TOP), W, Y(5.0) - Y(GLASS_TOP));
    sc.fillStyle = '#ffe6bc';
    sc.fillRect(0, Y(5.0), W, 4);
    // Polished stone floor: pale slabs with joint lines converging toward the back, lit blobs reflecting the pendants.
    sc.fillStyle = '#d6cec2';
    sc.fillRect(0, floorY, W, Y(0) - floorY);
    sc.fillStyle = rgba(60, 54, 48, 0.4);
    for (const yb of [1.35, 1.15, 0.95, 0.75]) sc.fillRect(0, Y(yb), W, 2);
    for (let x = 0; x < W; x += 0.6 * sx) sc.fillRect(x, floorY, 2, Y(0) - floorY);
    sc.fillStyle = rgba(0, 0, 0, 0.35);
    sc.fillRect(0, floorY - 4, W, 5);
    const planter = (x: number, w: number): void => {
      sc.fillStyle = '#2e2c2a';
      sc.fillRect(x, Y(1.25), w, Y(0.62) - Y(1.25));
      sc.fillStyle = rgba(255, 255, 255, 0.12);
      sc.fillRect(x, Y(1.25), w, 3);
      sc.fillStyle = '#3f7a3a';
      sc.beginPath();
      sc.ellipse(x + w / 2, Y(1.55), w * 0.62, 0.42 * sy, 0, 0, Math.PI * 2);
      sc.fill();
      sc.fillStyle = '#5a9a48';
      sc.beginPath();
      sc.ellipse(x + w * 0.4, Y(1.7), w * 0.35, 0.25 * sy, 0, 0, Math.PI * 2);
      sc.fill();
    };
    const pendant = (cx: number, y: number): void => {
      sc.fillStyle = '#1a1614';
      sc.fillRect(cx - 1, Y(5.0), 2, Y(y + 0.2) - Y(5.0));
      sc.fillStyle = '#2c2624';
      sc.beginPath();
      sc.arc(cx, Y(y), 12, 0, Math.PI * 2);
      sc.fill();
      sc.fillStyle = '#ffe2b0';
      sc.beginPath();
      sc.arc(cx, Y(y) + 4, 8, 0, Math.PI * 2);
      sc.fill();
    };
    const sofa = (x: number, w: number, col: string): void => {
      sc.fillStyle = col;
      sc.fillRect(x, Y(1.5), w, Y(0.95) - Y(1.5));
      sc.fillStyle = rgba(255, 255, 255, 0.14);
      sc.fillRect(x, Y(1.5), w, 4);
      sc.fillStyle = rgba(0, 0, 0, 0.3);
      sc.fillRect(x, Y(1.15), w, 3);
      sc.fillStyle = '#2a2624';
      sc.fillRect(x + 4, Y(0.95), 6, Y(0.75) - Y(0.95));
      sc.fillRect(x + w - 10, Y(0.95), 6, Y(0.75) - Y(0.95));
    };
    // Bay 0: a waiting corner - sofa, a framed print, a tall planter.
    sofa(X(0.9), 1.5 * sx, '#5c6a78');
    sc.fillStyle = '#3a2e26';
    sc.fillRect(X(1.2), Y(3.9), 1.1 * sx, Y(2.9) - Y(3.9));
    sc.fillStyle = '#c89a58';
    sc.fillRect(X(1.2) + 6, Y(3.9) + 6, 1.1 * sx - 12, Y(2.9) - Y(3.9) - 12);
    planter(X(3.3), 0.8 * sx);
    pendant(X(1.6), 3.6);
    pendant(X(3.6), 3.6);
    // Bay 1: reception desk with a lit front, the logo wall behind it.
    sc.fillStyle = '#4a3a2c';
    sc.fillRect(X(5.2), Y(4.4), 3.6 * sx, Y(2.6) - Y(4.4));
    sc.fillStyle = '#e8dcc4';
    sc.fillRect(X(5.7), Y(3.75), 2.6 * sx, Y(3.3) - Y(3.75));
    sc.fillStyle = '#3a2e26';
    for (let x = X(5.9); x < X(8.1); x += 30) sc.fillRect(x, Y(3.68), 20, Y(3.37) - Y(3.68));
    sc.fillStyle = '#e4dccc';
    sc.fillRect(X(5.0), Y(1.65), 3.9 * sx, Y(0.85) - Y(1.65));
    sc.fillStyle = '#ffd9a0';
    sc.fillRect(X(5.0), Y(1.15), 3.9 * sx, 6);
    sc.fillStyle = '#2a2624';
    sc.fillRect(X(4.95), Y(1.68), 3.95 * sx + 4, 6);
    sc.fillStyle = rgba(0, 0, 0, 0.3);
    sc.fillRect(X(5.0), Y(0.85), 3.9 * sx, 4);
    pendant(X(5.7), 3.9);
    pendant(X(7.0), 3.9);
    pendant(X(8.3), 3.9);
    // Bay 2: the entrance - a doormat inside, a directory panel on the far wall.
    sc.fillStyle = '#4a4440';
    sc.fillRect(X(10.7), Y(1.05), 2.6 * sx, Y(0.55) - Y(1.05));
    sc.fillStyle = '#2e2a28';
    sc.fillRect(X(11.4), Y(4.1), 1.2 * sx, Y(2.4) - Y(4.1));
    sc.fillStyle = rgba(255, 244, 220, 0.8);
    for (let yy = Y(3.9); yy < Y(2.5); yy += 12) sc.fillRect(X(11.5), yy, rng.range(30, 62), 3);
    pendant(X(12.0), 4.0);
    // Bay 3: two lift doors in brushed steel with a lit floor indicator, a planter beside them.
    for (let k = 0; k < 2; k++) {
      const lx = X(15.0 + k * 1.45);
      sc.fillStyle = '#2c2a2c';
      sc.fillRect(lx - 6, Y(3.85), 1.15 * sx + 12, Y(1.3) - Y(3.85));
      const steel = sc.createLinearGradient(lx, 0, lx + 1.15 * sx, 0);
      steel.addColorStop(0, '#9ea4aa');
      steel.addColorStop(0.5, '#c8cdd2');
      steel.addColorStop(1, '#8a9096');
      sc.fillStyle = steel;
      sc.fillRect(lx, Y(3.75), 1.15 * sx, Y(1.35) - Y(3.75));
      sc.fillStyle = '#1e1c1e';
      sc.fillRect(lx + 0.56 * sx, Y(3.75), 4, Y(1.35) - Y(3.75));
      sc.fillStyle = '#ff9a3a';
      sc.fillRect(lx + 0.45 * sx, Y(4.05), 16, 8);
    }
    planter(X(18.3), 0.75 * sx);
    pendant(X(15.4), 4.0);
    pendant(X(17.8), 4.0);
    // Bay 4: armchairs around a low table, a floor lamp and a wide planter, a second print.
    sofa(X(19.9), 0.9 * sx, '#8a5a3a');
    sofa(X(22.0), 0.9 * sx, '#8a5a3a');
    sc.fillStyle = '#3a3230';
    sc.fillRect(X(21.0), Y(1.05), 0.8 * sx, 5);
    sc.fillRect(X(21.35), Y(1.05), 6, Y(0.7) - Y(1.05));
    sc.fillStyle = '#2a2624';
    sc.fillRect(X(23.3), Y(2.9), 3, Y(0.7) - Y(2.9));
    sc.fillStyle = '#ffe2b0';
    sc.fillRect(X(23.1), Y(3.1), 0.4 * sx, Y(2.85) - Y(3.1));
    sc.fillStyle = '#3a2e26';
    sc.fillRect(X(20.5), Y(4.0), 1.6 * sx, Y(3.0) - Y(4.0));
    sc.fillStyle = '#6a9ac8';
    sc.fillRect(X(20.5) + 6, Y(4.0) + 6, 1.6 * sx - 12, Y(3.0) - Y(4.0) - 12);
    pendant(X(20.4), 3.7);
    pendant(X(22.5), 3.7);
    // --- Glazing per bay, the piers, the base course and the cornice ------------------------------------------
    const frame = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void => { c.fillRect(x, y, w, h); };
    for (let i = 0; i < PLINTH_BAYS; i++) {
      const door = i === PLINTH_DOOR_BAY;
      const gx0 = X(i * BAY + PIER / 2) + 5, gx1 = X((i + 1) * BAY - PIER / 2) - 5;
      const gy0 = Y(GLASS_TOP), gy1 = door ? Y(0.08) : Y(BASE);
      // Albedo: light glass, the lobby behind it, a sky reflection at the top and a darker foot.
      m.ctx.fillStyle = '#6f7d8a';
      m.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
      m.ctx.globalAlpha = 0.66;
      m.ctx.drawImage(scene.canvas, gx0, gy0, gx1 - gx0, gy1 - gy0, gx0, gy0, gx1 - gx0, gy1 - gy0);
      m.ctx.globalAlpha = 1;
      const refl = m.ctx.createLinearGradient(0, gy0, 0, gy1);
      refl.addColorStop(0, rgba(205, 226, 240, 0.34));
      refl.addColorStop(0.45, rgba(205, 226, 240, 0.05));
      refl.addColorStop(1, rgba(20, 28, 36, 0.18));
      m.ctx.fillStyle = refl;
      m.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
      // Emissive: the lobby under warm light, brighter at the ceiling.
      e.ctx.drawImage(scene.canvas, gx0, gy0, gx1 - gx0, gy1 - gy0, gx0, gy0, gx1 - gx0, gy1 - gy0);
      e.ctx.save();
      e.ctx.globalCompositeOperation = 'multiply';
      const warm = e.ctx.createLinearGradient(0, gy0, 0, gy1);
      warm.addColorStop(0, rgba(255, 222, 176, 1));
      warm.addColorStop(0.6, rgba(215, 178, 130, 1));
      warm.addColorStop(1, rgba(130, 100, 70, 1));
      e.ctx.fillStyle = warm;
      e.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
      e.ctx.restore();
      // Frames: head, jambs, a transom at TRANSOM and one centre mullion; the door bay gets two glazed leaves with
      // brass push bars, a meeting stile and the address box over the transom.
      const mid = (gx0 + gx1) / 2;
      for (const c of [m.ctx, e.ctx]) {
        c.fillStyle = c === m.ctx ? '#2e3238' : '#000';
        frame(c, gx0 - 5, gy0 - 5, gx1 - gx0 + 10, 7);
        frame(c, gx0 - 5, gy0, 5, gy1 - gy0);
        frame(c, gx1, gy0, 5, gy1 - gy0);
        frame(c, gx0, Y(TRANSOM) - 3, gx1 - gx0, 6);
        frame(c, mid - 3, gy0, 6, Y(TRANSOM) - gy0);
        if (door) {
          frame(c, gx0, Y(DOOR_TOP) - 4, gx1 - gx0, 8);
          frame(c, mid - 4, Y(DOOR_TOP), 8, gy1 - Y(DOOR_TOP));
          frame(c, gx0, gy1 - 6, gx1 - gx0, 6);
          const dl0 = mid - 1.05 * sx, dl1 = mid + 1.05 * sx;
          frame(c, dl0 - 4, Y(DOOR_TOP), 6, gy1 - Y(DOOR_TOP));
          frame(c, dl1 - 2, Y(DOOR_TOP), 6, gy1 - Y(DOOR_TOP));
          frame(c, dl0, Y(0.45), dl1 - dl0, 6);
        } else {
          frame(c, mid - 3, Y(TRANSOM), 6, gy1 - Y(TRANSOM));
        }
      }
      this.softRect(m.ctx, gx0 - 5, gy0 - 5, gx1 - gx0 + 10, 3, '#a8b4c0', 0.6);
      this.softRect(m.ctx, gx0, Y(TRANSOM) - 3, gx1 - gx0, 2, '#a8b4c0', 0.5);
      n.ctx.fillStyle = grey(0.36);
      n.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
      n.ctx.fillStyle = grey(0.6);
      n.ctx.fillRect(gx0 - 5, gy0 - 5, gx1 - gx0 + 10, 7);
      n.ctx.fillRect(gx0, Y(TRANSOM) - 3, gx1 - gx0, 6);
      n.ctx.fillRect(mid - 3, gy0, 6, gy1 - gy0);
      r.ctx.fillStyle = grey(0.2);
      r.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
      if (door) {
        // Push bars, a threshold and the lit address number in a small box on the transom.
        m.ctx.fillStyle = '#b8923c';
        m.ctx.fillRect(mid - 0.9 * sx, Y(1.05), 0.7 * sx, 5);
        m.ctx.fillRect(mid + 0.2 * sx, Y(1.05), 0.7 * sx, 5);
        m.ctx.fillStyle = '#4a4d54';
        m.ctx.fillRect(gx0, Y(0.08), gx1 - gx0, Y(0) - Y(0.08));
        const ax = mid - 0.42 * sx, ay = Y(TRANSOM) + 8, aw = 0.84 * sx, ah = Y(DOOR_TOP) - Y(TRANSOM) - 16;
        m.ctx.fillStyle = '#1e2024';
        m.ctx.fillRect(ax - 3, ay - 3, aw + 6, ah + 6);
        m.ctx.fillStyle = '#f2ecd8';
        m.ctx.fillRect(ax, ay, aw, ah);
        e.ctx.fillStyle = rgba(255, 236, 200, 1);
        e.ctx.fillRect(ax, ay, aw, ah);
        for (const c of [m.ctx, e.ctx]) {
          c.font = `900 ${Math.round(ah * 0.8)}px 'Trebuchet MS', 'Segoe UI', 'DejaVu Sans', Arial, sans-serif`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillStyle = c === m.ctx ? '#1e2024' : '#2a2018';
          c.fillText('No 47', mid, ay + ah / 2 + 1, aw - 8);
        }
        n.ctx.fillStyle = grey(0.62);
        n.ctx.fillRect(ax - 3, ay - 3, aw + 6, ah + 6);
        n.ctx.fillRect(gx0, Y(DOOR_TOP) - 4, gx1 - gx0, 8);
        r.ctx.fillStyle = grey(0.45);
        r.ctx.fillRect(gx0, Y(0.08), gx1 - gx0, Y(0) - Y(0.08));
      }
    }
    // Piers: pale limestone with a lit left arris, a shadowed right one and coursing joints every 0.6 m.
    for (let i = 0; i <= PLINTH_BAYS; i++) {
      const px0 = X(i * BAY - PIER / 2), pw = X(PIER);
      const draw = (x: number, w: number): void => {
        m.ctx.fillStyle = '#cfc8b8';
        m.ctx.fillRect(x, Y(CORNICE), w, Y(BASE) - Y(CORNICE));
        this.softRect(m.ctx, x, Y(CORNICE), 5, Y(BASE) - Y(CORNICE), '#fff', 0.3);
        this.softRect(m.ctx, x + w - 6, Y(CORNICE), 6, Y(BASE) - Y(CORNICE), '#000', 0.3);
        m.ctx.fillStyle = rgba(0, 0, 0, 0.14);
        for (let yb = BASE + 0.6; yb < CORNICE - 0.1; yb += 0.6) m.ctx.fillRect(x, Y(yb), w, 2);
        e.ctx.fillStyle = '#000';
        e.ctx.fillRect(x, 0, w, H);
        n.ctx.fillStyle = grey(0.66);
        n.ctx.fillRect(x, Y(CORNICE), w, Y(BASE) - Y(CORNICE));
        r.ctx.fillStyle = grey(0.85);
        r.ctx.fillRect(x, 0, w, H);
      };
      if (px0 < 0) { draw(0, pw + px0); draw(W + px0, -px0); } else if (px0 + pw > W) { draw(px0, W - px0); draw(0, px0 + pw - W); } else draw(px0, pw);
    }
    // Base course: polished dark granite with a light top edge; the door threshold interrupts it.
    const dgx0 = X(PLINTH_DOOR_BAY * BAY + PIER / 2) + 5, dgx1 = X((PLINTH_DOOR_BAY + 1) * BAY - PIER / 2) - 5;
    for (const [bx0, bx1] of [[0, dgx0], [dgx1, W]]) {
      m.ctx.fillStyle = '#3b3e46';
      m.ctx.fillRect(bx0, Y(BASE), bx1 - bx0, Y(0) - Y(BASE));
      this.softRect(m.ctx, bx0, Y(BASE), bx1 - bx0, 4, '#fff', 0.3);
      m.ctx.fillStyle = rgba(120, 140, 160, 0.12);
      m.ctx.fillRect(bx0, Y(BASE) + 6, bx1 - bx0, Y(0.35) - Y(BASE));
      e.ctx.fillStyle = '#000';
      e.ctx.fillRect(bx0, Y(BASE), bx1 - bx0, Y(0) - Y(BASE));
      n.ctx.fillStyle = grey(0.62);
      n.ctx.fillRect(bx0, Y(BASE), bx1 - bx0, Y(0) - Y(BASE));
      r.ctx.fillStyle = grey(0.45);
      r.ctx.fillRect(bx0, Y(BASE), bx1 - bx0, Y(0) - Y(BASE));
    }
    // Cornice band along the top: a lighter stone fillet with a shadow line under it and a lit top edge.
    m.ctx.fillStyle = '#d4cdbd';
    m.ctx.fillRect(0, 0, W, Y(CORNICE));
    this.softRect(m.ctx, 0, Y(CORNICE) - 7, W, 7, '#000', 0.32);
    this.softRect(m.ctx, 0, 3, W, 5, '#fff', 0.2);
    m.ctx.fillStyle = '#2e3238';
    m.ctx.fillRect(0, Y(GLASS_TOP) - 5, W, Y(GLASS_TOP) - Y(CORNICE) + 5);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, Y(GLASS_TOP) - 5);
    n.ctx.fillStyle = grey(0.66);
    n.ctx.fillRect(0, 0, W, Y(CORNICE));
    n.ctx.fillStyle = grey(0.5);
    n.ctx.fillRect(0, Y(CORNICE), W, Y(GLASS_TOP) - Y(CORNICE));
    this.grime(m.ctx, W, H, rng, H * 0.6, 0);
    this.soften(m.ctx, W, H);
    const map = this.finish(key + ':map', m.canvas, true, true, true);
    const emissive = this.finish(key + ':emi', e.canvas, true, true, true);
    const normal = this.normalFromLuminance(key + ':nrm', n.canvas, 5, 8);
    const rough = this.finish(key + ':rgh', r.canvas, false, true, true);
    return { map, emissive, normal, rough };
  }

  /** Emissive atlas for landmark/traffic-light glow parts: eight 16 px cells (black, magenta, cyan, yellow, orange, red, green, white); sample centers via GLOW_U. */
  glowAtlas(): THREE.Texture {
    const key = 'glowAtlas';
    const hit = this.cache.get(key);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 8;
    const ctx = c.getContext('2d');
    if (ctx) for (let i = 0; i < GLOW_CELLS.length; i++) { ctx.fillStyle = hex(GLOW_CELLS[i]); ctx.fillRect(i * 16, 0, 16, 8); }
    const t = this.finish(key, c, true, false);
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  /**
   * Shared asphalt base at any tile size: dark warm bitumen, broad tonal mottle, a fine two-tone grain and larger dark
   * aggregate specks softened by a 3 x 3 blur so they sit at stone size (2-4 cm at 1024 px / 14 m) and average out in
   * the first mip. Fills the roughness canvas (r) with a near-flat 1.0 base with a little variation.
   */
  private asphalt(ctx: CanvasRenderingContext2D, r: CanvasRenderingContext2D | null, S: number, rng: Random): void {
    const k = S / 512;
    ctx.fillStyle = '#2c2a27';
    ctx.fillRect(0, 0, S, S);
    this.mottle(ctx, S, S, rng, 70, 30 * k, 100 * k, 0.06, 0, 0, true);
    this.grain(ctx, S, S, rng, 0.055, 0.3);
    this.specks(ctx, S, S, rng, Math.round(2600 * k * k), Math.round(700 * k * k), 2.2 * k);
    this.blur3(ctx, S, S);
    if (r) {
      r.fillStyle = grey(1);
      r.fillRect(0, 0, S, S);
      // Polished wheel paths and oily patches are a touch smoother than fresh aggregate.
      this.mottle(r, S, S, rng, 30, 40 * k, 120 * k, 0.05, 0, 0, false);
    }
  }

  /** Repair patch: an irregular polygon of slightly different asphalt with a soft edge (three fills, shrinking) and a tar-sealed outline. */
  private patch(ctx: CanvasRenderingContext2D, rng: Random, cx: number, cy: number, radius: number, dark: boolean, scale = 1): void {
    const n = rng.int(6, 8);
    const ang: number[] = [], rad: number[] = [];
    for (let k = 0; k < n; k++) { ang.push((k / n) * Math.PI * 2 + rng.range(-0.2, 0.2)); rad.push(radius * rng.range(0.6, 1)); }
    const path = (s: number): void => {
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const x = cx + Math.cos(ang[k]) * rad[k] * s, y = cy + Math.sin(ang[k]) * rad[k] * s * 0.7;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };
    for (let pass = 0; pass < 3; pass++) {
      path(1 - pass * 0.07);
      ctx.fillStyle = dark ? rgba(0, 0, 0, 0.06) : rgba(255, 250, 240, 0.035);
      ctx.fill();
    }
    path(1);
    ctx.strokeStyle = rgba(6, 5, 4, 0.5);
    ctx.lineWidth = 2.2 * scale;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /**
   * Draws the lane paint of a tile into a cleared layer, wears it, then composites it onto the asphalt and, at a fixed
   * grey, onto the roughness canvas (paint is smoother than aggregate). `draw` paints the markings and returns their
   * rectangles for the edge wear.
   */
  private paintLayer(ctx: CanvasRenderingContext2D, r: CanvasRenderingContext2D | null, S: number, rng: Random, draw: (p: CanvasRenderingContext2D) => number[][]): void {
    const layer = this.canvas(S, S);
    layer.ctx.clearRect(0, 0, S, S);
    const rects = draw(layer.ctx);
    this.wearPaint(layer.ctx, rng, rects, S / 512);
    // Thermoplastic sits proud of the road and picks up a dusting of tyre grime.
    layer.ctx.save();
    layer.ctx.globalCompositeOperation = 'source-atop';
    this.mottle(layer.ctx, S, S, rng, 40, 20 * (S / 512), 90 * (S / 512), 0.14, 0, 0, true);
    layer.ctx.restore();
    ctx.drawImage(layer.canvas, 0, 0);
    if (r) {
      layer.ctx.save();
      layer.ctx.globalCompositeOperation = 'source-in';
      layer.ctx.fillStyle = grey(0.65);
      layer.ctx.fillRect(0, 0, S, S);
      layer.ctx.restore();
      r.drawImage(layer.canvas, 0, 0);
    }
  }

  /** Finishes a painted roughness canvas at half resolution (roughness needs far less detail than the albedo or relief). */
  private finishRoughHalf(key: string, src: HTMLCanvasElement): THREE.CanvasTexture {
    const half = this.canvas(src.width / 2, src.height / 2);
    half.ctx.drawImage(src, 0, 0, src.width / 2, src.height / 2);
    return this.finish(key, half.canvas, false);
  }

  /**
   * Asphalt tile (ROAD_TILE_M x ROAD_TILE_M m, 1024 px = 73 px/m): dashed white lane separators at +-3.5 m, double
   * yellow centre line, worn paint, repair patches, tar seams, crack polylines, a manhole in the inner lane and a
   * kerb-side drain. u = across, v = along. Also builds the road roughness map (cached as road:rgh) while drawing.
   */
  road(): THREE.CanvasTexture {
    const key = 'road';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 1024, k = S / 512;
    const { canvas, ctx } = this.canvas(S, S);
    const r = this.canvas(S, S).ctx;
    const rng = new Random(11);
    this.asphalt(ctx, r, S, rng);
    const px = S / ROAD_TILE_M;
    const cx = S / 2;
    // Two repair patches (kept away from the edges so the tile still wraps) and a few tar seams.
    this.patch(ctx, rng, rng.range(130, 220) * k, rng.range(120, 390) * k, rng.range(50, 90) * k, true, k);
    this.patch(ctx, rng, rng.range(300, 390) * k, rng.range(120, 390) * k, rng.range(40, 80) * k, rng.chance(0.5), k);
    ctx.strokeStyle = rgba(12, 10, 8, 0.45);
    ctx.lineWidth = 2.4 * k;
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const x = rng.range(60, S / k - 60) * k, y = rng.range(60, S / k - 60) * k;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + rng.range(-60, 60) * k, y + rng.range(-60, 60) * k);
      ctx.stroke();
    }
    // Darker tyre tracks in the wheel paths, plus faint full-height streaks so the surface reads as driven along.
    ctx.fillStyle = rgba(0, 0, 0, 0.1);
    for (const off of [-5.4, -1.9, 1.9, 5.4]) ctx.fillRect(cx + off * px - 0.5 * px, 0, 1.0 * px, S);
    for (let i = 0; i < 26; i++) {
      const light = rng.chance(0.4), v = light ? 255 : 0;
      ctx.fillStyle = rgba(v, v, v, rng.range(0.02, 0.05));
      ctx.fillRect(rng.range(0, S), 0, rng.range(1, 4) * k, S);
    }
    // Cracks: alligator cracking in the wheel paths and a couple of long transverse ones.
    this.cracks(ctx, S, S, rng, 5, k, 0.45, 0.05);
    // Manhole in the inner lane, drain against one kerb.
    this.manhole(ctx, r, rng, cx + (rng.chance(0.5) ? 1 : -1) * rng.range(1.6, 2.4) * px, rng.range(0.2, 0.8) * S, 0.34 * px);
    const dSide = rng.chance(0.5) ? 0.35 * px : S - 0.35 * px - 0.36 * px;
    this.drain(ctx, r, dSide, rng.range(0.15, 0.85) * S, 0.36 * px, 0.62 * px, k);
    this.paintLayer(ctx, r, S, rng, (p) => {
      const rects: number[][] = [];
      p.fillStyle = '#d0b043';
      for (const x of [cx - 0.35 * px, cx + 0.2 * px]) { p.fillRect(x, 0, 0.15 * px, S); rects.push([x, 0, 0.15 * px, S]); }
      p.fillStyle = '#d6d6cf';
      for (let side = -1; side <= 1; side += 2) {
        const x = cx + side * 3.5 * px - 0.08 * px;
        for (let y = 0; y < S; y += 3 * px) { p.fillRect(x, y, 0.16 * px, 1.5 * px); rects.push([x, y, 0.16 * px, 1.5 * px]); }
      }
      return rects;
    });
    this.finishRoughHalf(key + ':rgh', r.canvas);
    return this.finish(key, canvas, true);
  }

  /** Intersection tile (1024 px): asphalt with worn zebra crossings and stop bars along all four edges. */
  crosswalk(): THREE.CanvasTexture {
    const key = 'crosswalk';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 1024, k = S / 512;
    const { canvas, ctx } = this.canvas(S, S);
    const rng = new Random(23);
    this.asphalt(ctx, null, S, rng);
    this.patch(ctx, rng, rng.range(150, 360) * k, rng.range(150, 360) * k, rng.range(50, 90) * k, true, k);
    this.patch(ctx, rng, rng.range(150, 360) * k, rng.range(150, 360) * k, rng.range(40, 70) * k, false, k);
    this.cracks(ctx, S, S, rng, 4, k, 0.45, 0.05, 0.2);
    const px = S / ROAD_TILE_M;
    this.manhole(ctx, null, rng, S / 2 + rng.range(-1.5, 1.5) * px, S / 2 + rng.range(-1.5, 1.5) * px, 0.34 * px);
    const band = 2.4 * px, m = 0.6 * px, stripe = 0.6 * px, gap = 0.5 * px;
    this.paintLayer(ctx, null, S, rng, (p) => {
      const rects: number[][] = [];
      p.fillStyle = '#d2d2ca';
      for (let x = 1.4 * px; x < S - 1.4 * px; x += stripe + gap) {
        p.fillRect(x, m, stripe, band); rects.push([x, m, stripe, band]);
        p.fillRect(x, S - m - band, stripe, band); rects.push([x, S - m - band, stripe, band]);
        p.fillRect(m, x, band, stripe); rects.push([m, x, band, stripe]);
        p.fillRect(S - m - band, x, band, stripe); rects.push([S - m - band, x, band, stripe]);
      }
      // Stop bars just inside the zebra on the approach halves.
      const sb = 0.45 * px, sy = m + band + 0.35 * px;
      p.fillStyle = '#c8c8c0';
      const bars = [[S / 2 + 0.2 * px, sy, S / 2 - 1.4 * px, sb], [1.4 * px, S - sy - sb, S / 2 - 1.6 * px, sb], [sy, 1.4 * px, sb, S / 2 - 1.6 * px], [S - sy - sb, S / 2 + 0.2 * px, sb, S / 2 - 1.4 * px]];
      for (const b of bars) { p.fillRect(b[0], b[1], b[2], b[3]); rects.push(b); }
      return rects;
    });
    return this.finish(key, canvas, true);
  }

  /** Road-marking decal atlas (2x2 cells with alpha): forward arrow, forward+left, forward+right, plain bar. Cells point toward +v. */
  roadMarks(): THREE.CanvasTexture {
    const key = 'roadMarks';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 256, half = S / 2;
    const { canvas, ctx } = this.canvas(S, S);
    ctx.clearRect(0, 0, S, S);
    const paint = 'rgba(232,232,222,0.92)';
    // Cell origin (ox, oy) in canvas space; the arrow points toward canvas -y (= +v).
    const arrow = (ox: number, oy: number, side: 0 | -1 | 1): void => {
      ctx.fillStyle = paint;
      const cx = ox + half / 2;
      ctx.fillRect(cx - 8, oy + 40, 16, half - 52);
      ctx.beginPath();
      ctx.moveTo(cx, oy + 12);
      ctx.lineTo(cx + 26, oy + 52);
      ctx.lineTo(cx + 9, oy + 52);
      ctx.lineTo(cx + 9, oy + 62);
      ctx.lineTo(cx - 9, oy + 62);
      ctx.lineTo(cx - 9, oy + 52);
      ctx.lineTo(cx - 26, oy + 52);
      ctx.closePath();
      ctx.fill();
      if (side !== 0) {
        const sx = cx + side * 30;
        ctx.fillRect(cx - 8, oy + half - 46, side > 0 ? 34 : -34, 14);
        ctx.beginPath();
        ctx.moveTo(sx + side * 14, oy + half - 39);
        ctx.lineTo(sx - side * 4, oy + half - 60);
        ctx.lineTo(sx - side * 4, oy + half - 18);
        ctx.closePath();
        ctx.fill();
      }
    };
    arrow(0, 0, 0);          // top-left cell -> MARK_UV.ahead
    arrow(half, 0, -1);      // top-right    -> MARK_UV.left
    arrow(0, half, 1);       // bottom-left  -> MARK_UV.right
    ctx.fillStyle = paint;   // bottom-right -> MARK_UV.bar
    ctx.fillRect(half + 6, half + 6, half - 12, half - 12);
    const t = this.finish(key, canvas, true, false);
    return t;
  }

  /**
   * Concrete paving tile (8 m, 1024 px = 128 px/m): running-bond 2 m x 1 m slabs, each with its own colour
   * temperature and tone, a 3 px joint with a lit lip, expansion joints every fourth course, chipped corners, the odd
   * replaced (darker, newer) slab, a few special slabs (granite, drain grate, tactile strip), cracks and grime. The
   * bottom 2% of the rows (v 0..0.02) is a kerb-stone band: CityRenderer's curb boxes map exactly that strip onto the
   * kerb sides, so kerb and pavement share one texture and one grid. Also builds the roughness map (sidewalk:rgh).
   */
  sidewalk(): THREE.CanvasTexture {
    const key = 'sidewalk';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 1024, PM = S / 8, k = S / 512; // 128 px per metre
    const { canvas, ctx } = this.canvas(S, S);
    const r = this.canvas(S, S).ctx;
    const rng = new Random(31);
    ctx.fillStyle = '#b9b2a5';
    ctx.fillRect(0, 0, S, S);
    r.fillStyle = grey(0.95);
    r.fillRect(0, 0, S, S);
    // Cement: broad mottle, a fine sandy grain and a sparse scatter of aggregate showing through the trowelled top.
    this.mottle(ctx, S, S, rng, 40, 24 * k, 80 * k, 0.05, 0, 0, true);
    this.grain(ctx, S, S, rng, 0.035, 0.25);
    this.specks(ctx, S, S, rng, 900, 500, 1.6 * k);
    this.blur3(ctx, S, S);
    const SW = 2 * PM, SH = PM, rows = 8, cols = 4;
    const kb = Math.round(S * 0.02);
    // Special slabs: (row, col, kind) - kept off the kerb row.
    const special: { r: number; c: number; kind: number }[] = [];
    for (let kk = 0; kk < 4; kk++) special.push({ r: rng.int(0, rows - 2), c: rng.int(0, cols - 1), kind: kk });
    for (let j = 0; j < rows; j++) {
      const off = (j % 2) * (SW / 2);
      const y = j * SH;
      for (let i = -1; i < cols; i++) {
        const x = i * SW + off;
        // Per-slab tone and colour temperature: pours from different days never match.
        const lum = rng.range(-0.035, 0.035);
        ctx.fillStyle = lum > 0 ? rgba(255, 255, 255, lum * 2) : rgba(0, 0, 0, -lum * 2);
        ctx.fillRect(x, y, SW, SH);
        const warm = rng.range(-1, 1);
        ctx.fillStyle = warm > 0 ? rgba(255, 226, 190, warm * 0.09) : rgba(190, 206, 232, -warm * 0.09);
        ctx.fillRect(x, y, SW, SH);
        const sp = special.find((s) => s.r === j && s.c === ((i + cols) % cols));
        if (sp && i >= 0) {
          if (sp.kind === 0 || sp.kind === 3) {
            // Darker granite slab: flecked, slightly smoother.
            ctx.fillStyle = rgba(60, 58, 60, 0.45);
            ctx.fillRect(x, y, SW, SH);
            for (let g = 0; g < 240; g++) { ctx.fillStyle = rgba(255, 255, 255, rng.range(0.05, 0.18)); ctx.fillRect(x + rng.range(0, SW), y + rng.range(0, SH), 2, 2); }
            r.fillStyle = grey(0.72);
            r.fillRect(x, y, SW, SH);
          } else if (sp.kind === 1) {
            // Drain grate set into the slab.
            const gw = 0.6 * PM, gh = 0.36 * PM;
            this.drain(ctx, r, x + SW / 2 - gw / 2, y + SH / 2 - gh / 2, gw, gh, k);
          } else {
            // Tactile strip: rows of raised domes, light on top with a shadow below.
            for (let yy = y + 12; yy < y + SH - 8; yy += 16) {
              for (let xx = x + 12; xx < x + SW - 8; xx += 16) {
                ctx.fillStyle = rgba(0, 0, 0, 0.28);
                ctx.beginPath(); ctx.ellipse(xx + 4, yy + 5, 5, 4, 0, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = rgba(255, 250, 240, 0.4);
                ctx.beginPath(); ctx.ellipse(xx + 3.5, yy + 3, 4.5, 3.5, 0, 0, Math.PI * 2); ctx.fill();
              }
            }
          }
        } else if (i >= 0 && j < rows - 1 && rng.chance(0.07)) {
          // Replaced slab: newer, darker, cleaner pour with a crisp edge.
          ctx.fillStyle = rgba(58, 54, 50, 0.32);
          ctx.fillRect(x, y, SW, SH);
          r.fillStyle = grey(0.82);
          r.fillRect(x, y, SW, SH);
        }
        // Chipped corners: a small spall at one or two corners, dark with a lit lip.
        if (rng.chance(0.3)) {
          const cxk = rng.chance(0.5) ? x : x + SW, cyk = rng.chance(0.5) ? y : y + SH;
          const sx = cxk === x ? 1 : -1, sy = cyk === y ? 1 : -1;
          const a = rng.range(5, 13) * k, b = rng.range(5, 13) * k;
          ctx.fillStyle = rgba(255, 246, 232, 0.35);
          ctx.beginPath(); ctx.moveTo(cxk, cyk); ctx.lineTo(cxk + sx * (a + 1.5 * k), cyk); ctx.lineTo(cxk, cyk + sy * (b + 1.5 * k)); ctx.closePath(); ctx.fill();
          ctx.fillStyle = rgba(30, 26, 22, 0.4);
          ctx.beginPath(); ctx.moveTo(cxk, cyk); ctx.lineTo(cxk + sx * a, cyk); ctx.lineTo(cxk + sx * a * 0.55, cyk + sy * b * 0.6); ctx.lineTo(cxk, cyk + sy * b); ctx.closePath(); ctx.fill();
        }
        // Vertical joint at the slab's left edge: dark groove with a lit lip on the far side.
        ctx.fillStyle = rgba(0, 0, 0, 0.34);
        ctx.fillRect(x, y, 3, SH);
        ctx.fillStyle = rgba(255, 250, 240, 0.14);
        ctx.fillRect(x + 3, y, 1, SH);
        r.fillStyle = grey(1);
        r.fillRect(x, y, 3, SH);
      }
      // Horizontal joint; every fourth course is a sealed expansion joint (wider, with a dark filler line).
      const expansion = j % 4 === 0;
      ctx.fillStyle = rgba(0, 0, 0, expansion ? 0.3 : 0.34);
      ctx.fillRect(0, y, S, expansion ? 6 : 3);
      if (expansion) { ctx.fillStyle = rgba(10, 8, 6, 0.5); ctx.fillRect(0, y + 2, S, 2); }
      ctx.fillStyle = rgba(255, 250, 240, 0.14);
      ctx.fillRect(0, y + (expansion ? 6 : 3), S, 1);
      r.fillStyle = grey(1);
      r.fillRect(0, y, S, expansion ? 6 : 3);
    }
    // Hairline cracks across a few slabs (kept above the kerb band).
    this.cracks(ctx, S, S, rng, 4, k * 0.7, 0.3, 0.08, 0.05);
    // Grime blotches (damp, gum, rust) kept off the edges so the tile still wraps.
    for (let i = 0; i < 14; i++) {
      const rad = rng.range(14, 50) * k, x = rng.range(rad, S - rad), y = rng.range(rad, S - rad - kb);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      const warm = rng.chance(0.4);
      g.addColorStop(0, warm ? rgba(96, 74, 46, 0.06 + rng.next() * 0.06) : rgba(30, 32, 36, 0.05 + rng.next() * 0.06));
      g.addColorStop(1, rgba(0, 0, 0, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    // Gum spots: small dark discs, the signature of a real pavement.
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = rgba(20, 18, 16, rng.range(0.18, 0.35));
      ctx.beginPath(); ctx.arc(rng.range(0, S), rng.range(0, S - kb - 4), rng.range(1.5, 3.5) * k, 0, Math.PI * 2); ctx.fill();
    }
    // Kerb-stone band: v 0..0.02 -> the bottom 2% of rows. Lighter grey stone, dark chamfer line along its top,
    // a joint every metre.
    ctx.fillStyle = '#b9b7b1';
    ctx.fillRect(0, S - kb, S, kb);
    ctx.fillStyle = rgba(0, 0, 0, 0.35);
    ctx.fillRect(0, S - kb, S, 2);
    ctx.fillStyle = rgba(255, 255, 255, 0.18);
    ctx.fillRect(0, S - kb + 2, S, 2);
    ctx.fillStyle = rgba(0, 0, 0, 0.3);
    for (let x = 0; x < S; x += PM) ctx.fillRect(x, S - kb, 2, kb);
    r.fillStyle = grey(0.9);
    r.fillRect(0, S - kb, S, kb);
    this.finishRoughHalf(key + ':rgh', r.canvas);
    return this.finish(key, canvas, true);
  }

  sand(): THREE.CanvasTexture {
    const key = 'sand';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 256;
    const { canvas, ctx } = this.canvas(S, S);
    const rng = new Random(41);
    ctx.fillStyle = '#dcc48e';
    ctx.fillRect(0, 0, S, S);
    // Dry sand: broad wind-sorted tone patches, a fine grain and a few shell / pebble specks, blurred to grain size.
    this.mottle(ctx, S, S, rng, 30, 16, 60, 0.06, 0, 0, true);
    this.grain(ctx, S, S, rng, 0.05, 0.3);
    this.specks(ctx, S, S, rng, 120, 160, 1.6);
    this.blur3(ctx, S, S);
    ctx.strokeStyle = rgba(160, 130, 80, 0.18);
    ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * 32 + 8);
      ctx.bezierCurveTo(S * 0.3, i * 32 - 6, S * 0.6, i * 32 + 22, S, i * 32 + 8);
      ctx.stroke();
    }
    return this.finish(key, canvas, true);
  }

  water(): THREE.CanvasTexture {
    const key = 'water';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 256;
    const { canvas, ctx } = this.canvas(S, S);
    const rng = new Random(51);
    ctx.fillStyle = '#1b6f9a';
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = rgba(180, 230, 255, 0.35);
    ctx.lineWidth = 2;
    for (let i = 0; i < 40; i++) {
      const y = rng.range(0, S), x = rng.range(0, S), len = rng.range(12, 40);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + len / 2, y + rng.range(-4, 4), x + len, y);
      ctx.stroke();
    }
    this.noise(ctx, S, S, rng, 300, 6, 0.08, true);
    return this.finish(key, canvas, true);
  }

  /** Tangent-space wave normal map for the sea (scrolled for a moving specular). */
  waterNormal(): THREE.CanvasTexture {
    const key = 'waterN';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 256;
    const { canvas, ctx } = this.canvas(S, S);
    const img = ctx.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x / S) * Math.PI * 2, v = (y / S) * Math.PI * 2;
        // Height field from a few tileable sine waves; slope -> normal.
        const dhdx = 0.55 * Math.cos(u * 3 + v) * 3 + 0.3 * Math.cos(u * 7 - v * 2) * 7 + 0.16 * Math.cos(u * 13 + v * 5) * 13;
        const dhdy = 0.55 * Math.cos(u * 3 + v) + 0.3 * Math.cos(u * 7 - v * 2) * -2 + 0.16 * Math.cos(u * 13 + v * 5) * 5;
        let nx = -dhdx * 0.06, ny = -dhdy * 0.06, nz = 1;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= l; ny /= l; nz /= l;
        const i = (y * S + x) * 4;
        d[i] = (nx * 0.5 + 0.5) * 255;
        d[i + 1] = (ny * 0.5 + 0.5) * 255;
        d[i + 2] = (nz * 0.5 + 0.5) * 255;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return this.finish(key, canvas, false);
  }

  /** Shoreline foam strip with alpha; tiles along u (the shore direction), v across the surf. */
  foam(): THREE.CanvasTexture {
    const key = 'foam';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const W = 512, H = 128;
    const { canvas, ctx } = this.canvas(W, H);
    ctx.clearRect(0, 0, W, H);
    const rng = new Random(1913);
    // Wave edge: a soft band whose centre wanders along the strip.
    for (let x = 0; x < W; x++) {
      const t = (x / W) * Math.PI * 2;
      const centre = H * 0.5 + Math.sin(t * 2) * 12 + Math.sin(t * 5 + 1.1) * 7 + Math.sin(t * 9 + 2.3) * 4;
      const g = ctx.createLinearGradient(0, centre - 34, 0, centre + 34);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.68, 'rgba(255,255,255,0.4)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 1, H);
    }
    // Bubble speckle.
    for (let i = 0; i < 900; i++) {
      const x = rng.range(0, W), t = (x / W) * Math.PI * 2;
      const centre = H * 0.5 + Math.sin(t * 2) * 12 + Math.sin(t * 5 + 1.1) * 7 + Math.sin(t * 9 + 2.3) * 4;
      ctx.fillStyle = rgba(255, 255, 255, rng.range(0.2, 0.85));
      ctx.fillRect(x, centre + rng.range(-26, 26), rng.range(1, 4), rng.range(1, 3));
    }
    return this.finish(key, canvas, true, true, true);
  }

  /** Seamless cloud density (red channel) used by the sky dome shader; tiles in both axes. */
  clouds(): THREE.CanvasTexture {
    const key = 'clouds';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 512;
    const { canvas, ctx } = this.canvas(S, S);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    const rng = new Random(2027);
    const blob = (x: number, y: number, r: number, a: number): void => {
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cx = x + ox * S, cy = y + oy * S;
          if (cx < -r || cx > S + r || cy < -r || cy > S + r) continue;
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, `rgba(255,255,255,${a})`);
          g.addColorStop(0.55, `rgba(255,255,255,${a * 0.45})`);
          g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g;
          ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
      }
    };
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 26; i++) blob(rng.range(0, S), rng.range(0, S), rng.range(60, 130), 0.34);
    for (let i = 0; i < 70; i++) blob(rng.range(0, S), rng.range(0, S), rng.range(22, 60), 0.26);
    for (let i = 0; i < 160; i++) blob(rng.range(0, S), rng.range(0, S), rng.range(8, 24), 0.18);
    ctx.globalCompositeOperation = 'source-over';
    return this.finish(key, canvas, false);
  }

  /** Moon disc with maria and a soft limb (sprite map). */
  moonDisk(): THREE.CanvasTexture {
    const key = 'moon';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 128;
    const { canvas, ctx } = this.canvas(S, S);
    ctx.clearRect(0, 0, S, S);
    // Outer halo.
    const halo = ctx.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S / 2);
    halo.addColorStop(0, 'rgba(200,215,255,0.55)');
    halo.addColorStop(0.5, 'rgba(170,190,255,0.16)');
    halo.addColorStop(1, 'rgba(160,180,255,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, S, S);
    // Disc.
    const disc = ctx.createRadialGradient(S * 0.44, S * 0.42, 2, S / 2, S / 2, S * 0.3);
    disc.addColorStop(0, 'rgba(255,255,252,1)');
    disc.addColorStop(0.75, 'rgba(228,234,250,1)');
    disc.addColorStop(1, 'rgba(205,214,238,1)');
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = disc;
    ctx.fill();
    const rng = new Random(77);
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S * 0.3, 0, Math.PI * 2);
    ctx.clip();
    for (let i = 0; i < 10; i++) {
      const a = rng.range(0, Math.PI * 2), d = rng.range(0, S * 0.24);
      ctx.fillStyle = rgba(190, 200, 224, rng.range(0.18, 0.4));
      ctx.beginPath();
      ctx.arc(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, rng.range(3, 10), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return this.finish(key, canvas, true, false);
  }

  grass(): THREE.CanvasTexture {
    const key = 'grass';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 256;
    const { canvas, ctx } = this.canvas(S, S);
    const rng = new Random(61);
    ctx.fillStyle = '#4f8a3c';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 4000; i++) {
      const g = rng.int(110, 170);
      ctx.fillStyle = rgba(g * 0.45, g, g * 0.3, 0.6);
      ctx.fillRect(rng.range(0, S), rng.range(0, S), 2, 3);
    }
    return this.finish(key, canvas, true);
  }

  /** Decorative plaza paving (8 m tile, diagonal pattern). */
  plaza(): THREE.CanvasTexture {
    const key = 'plaza';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 256;
    const { canvas, ctx } = this.canvas(S, S);
    const rng = new Random(71);
    const CELL = 64; // 2 m slabs on an 8 m tile
    ctx.fillStyle = '#b0a9a6';
    ctx.fillRect(0, 0, S, S);
    // Two slab tones laid in a check, then a per-slab tonal jitter so the pattern does not read as a chessboard.
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = (i + j) % 2 === 0 ? '#c2b6ad' : '#a89f9c';
        ctx.fillRect(i * CELL, j * CELL, CELL, CELL);
        const k = rng.range(-0.06, 0.07);
        ctx.fillStyle = k > 0 ? rgba(255, 255, 255, k * 1.8) : rgba(0, 0, 0, -k * 1.8);
        ctx.fillRect(i * CELL, j * CELL, CELL, CELL);
      }
    }
    this.mottle(ctx, S, S, rng, 24, 12, 40, 0.05, 1500, 0.03, true);
    // Joints: a dark line with a light lip on the far side, so the slabs read as laid rather than painted.
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = rgba(0, 0, 0, 0.28);
      ctx.fillRect(0, i * CELL, S, 2);
      ctx.fillRect(i * CELL, 0, 2, S);
      ctx.fillStyle = rgba(255, 255, 255, 0.14);
      ctx.fillRect(0, i * CELL + 2, S, 1);
      ctx.fillRect(i * CELL + 2, 0, 1, S);
    }
    // Cracks running across a couple of slabs, and damp patches.
    ctx.strokeStyle = rgba(0, 0, 0, 0.2);
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      let x = rng.range(0, S), y = rng.range(0, S);
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += rng.range(-16, 16); y += rng.range(-16, 16); ctx.lineTo(x, y); }
      ctx.stroke();
    }
    for (let i = 0; i < 9; i++) {
      const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(10, 34);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(40, 36, 34, 0.09 + rng.next() * 0.06));
      g.addColorStop(1, rgba(0, 0, 0, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    return this.finish(key, canvas, true);
  }

  /** One 512 x 1024 atlas (2 MB) with a glowing white row per word - the words are short, so half the width of the old square atlas keeps the same 52 px row height; tint via vertex colors. Returns per-word UV rects. */
  neonAtlas(words: readonly string[]): { texture: THREE.CanvasTexture; rects: Map<string, AtlasRect> } {
    const key = 'neonAtlas';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c && this.atlasRects) return { texture: c, rects: this.atlasRects };
    const SW = 512, SH = 1024;
    const { canvas, ctx } = this.canvas(SW, SH);
    ctx.clearRect(0, 0, SW, SH);
    const rows = Math.max(1, words.length);
    const rh = Math.floor(SH / rows);
    const fontPx = Math.floor(rh * 0.62);
    ctx.font = `900 ${fontPx}px 'Trebuchet MS', 'Segoe UI', Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const rects = new Map<string, AtlasRect>();
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const y = i * rh + rh / 2;
      const tw = Math.min(SW - 40, ctx.measureText(w).width);
      const x = 20;
      ctx.shadowColor = 'rgba(255,255,255,0.95)';
      ctx.shadowBlur = fontPx * 0.5;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(w, x, y, SW - 40);
      ctx.fillText(w, x, y, SW - 40);
      ctx.fillText(w, x, y, SW - 40);
      ctx.shadowBlur = fontPx * 0.12;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(w, x, y, SW - 40);
      ctx.shadowBlur = 0;
      const pad = fontPx * 0.35;
      rects.set(w, { u0: (x - pad) / SW, u1: (x + tw + pad) / SW, v0: 1 - (i * rh + rh) / SH, v1: 1 - (i * rh) / SH });
    }
    const texture = this.finish(key, canvas, true, false);
    this.atlasRects = rects;
    return { texture, rects };
  }

  /**
   * Palm frond with alpha (256 x 512, tip toward +v): 34 leaflet pairs, each split along its own vein into a lit
   * upper half and a shaded lower half with a lighter vein between them, sweeping forward and hooking down at the
   * tip. Leaflets are filled slivers, not hairlines: an alpha-tested texture with thin strokes dissolves in the lower
   * mips and the palm turns into a cloud of speckles a few metres away. A fifth of the tips have dried.
   */
  palmFrond(): THREE.CanvasTexture {
    const key = 'frond';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const W = 256, H = 512;
    const { canvas, ctx } = this.canvas(W, H);
    ctx.clearRect(0, 0, W, H);
    const rng = new Random(81);
    const cx = W / 2;
    const N = 34;
    for (let i = 0; i < N; i++) {
      const t = i / N;
      const y = H - 16 - t * (H - 36);
      const len = (1 - t * 0.78) * 112 + 14;
      const sweep = 46 + t * 22;
      const wid = 13 - t * 6;
      const j = rng.int(-10, 10);
      for (const dir of [-1, 1]) {
        const dry = rng.chance(0.18);
        const curl = rng.range(5, 12);
        const ex = cx + dir * len, ey = y - sweep + curl;
        // Control points: the vein bows forward, the tip hooks back down.
        const vcx = cx + dir * len * 0.58, vcy = y - sweep * 0.42;
        const tipCol = dry ? [156, 120, 58] : [116 + j, 160 + j, 72];
        const tipShade = dry ? [118, 88, 40] : [80 + j, 122 + j, 54];
        // Upper (lit) half.
        let g = ctx.createLinearGradient(cx, y, ex, ey);
        g.addColorStop(0, rgba(66 + j, 108 + j, 54, 1));
        g.addColorStop(dry ? 0.6 : 1, rgba(tipCol[0] + (dry ? -20 : 0), tipCol[1] + (dry ? 20 : 0), tipCol[2], 1));
        if (dry) g.addColorStop(1, rgba(tipCol[0], tipCol[1], tipCol[2], 1));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(cx, y - wid * 0.5);
        ctx.quadraticCurveTo(cx + dir * len * 0.5, y - sweep * 0.62 - wid * 0.4, ex, ey);
        ctx.quadraticCurveTo(vcx, vcy, cx, y);
        ctx.closePath();
        ctx.fill();
        // Lower (shaded) half.
        g = ctx.createLinearGradient(cx, y, ex, ey);
        g.addColorStop(0, rgba(44 + j, 80 + j, 42, 1));
        g.addColorStop(1, rgba(tipShade[0], tipShade[1], tipShade[2], 1));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(cx, y);
        ctx.quadraticCurveTo(vcx, vcy, ex, ey);
        ctx.quadraticCurveTo(cx + dir * len * 0.5, y - sweep * 0.12 + wid * 0.5, cx, y + wid * 0.5);
        ctx.closePath();
        ctx.fill();
        // Lighter vein between the halves, fading toward the tip.
        const vg = ctx.createLinearGradient(cx, y, ex, ey);
        vg.addColorStop(0, rgba(180 + j, 206 + j, 120, 0.7));
        vg.addColorStop(1, rgba(180 + j, 206 + j, 120, 0.15));
        ctx.strokeStyle = vg;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(cx, y);
        ctx.quadraticCurveTo(vcx, vcy, ex, ey);
        ctx.stroke();
      }
    }
    // Rachis, tapering to the tip, with a lit left edge.
    const rg = ctx.createLinearGradient(0, H, 0, 0);
    rg.addColorStop(0, '#6f8a44');
    rg.addColorStop(1, '#93b05c');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.moveTo(cx - 8, H);
    ctx.lineTo(cx + 8, H);
    ctx.lineTo(cx + 2, 6);
    ctx.lineTo(cx - 2, 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = rgba(220, 232, 170, 0.45);
    ctx.beginPath();
    ctx.moveTo(cx - 8, H);
    ctx.lineTo(cx - 4, H);
    ctx.lineTo(cx - 1, 6);
    ctx.lineTo(cx - 2, 6);
    ctx.closePath();
    ctx.fill();
    this.bleedAlpha(ctx, W, H, 8);
    return this.finish(key, canvas, true, false);
  }

  /**
   * Striped awning canvas (256 x 128, tiles both ways): two-tone stripes along u with a woven grain, a sun-faded top
   * and a grubby hem. Kept near-neutral (cream and a mid grey) so the geometry's vertex colour sets the awning's
   * hue: a saturated tint gives colour / dark-colour stripes, a pale tint keeps it near cream / grey.
   */
  awningTex(): THREE.CanvasTexture {
    const key = 'awning';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const W = 256, H = 128;
    const { canvas, ctx } = this.canvas(W, H);
    const rng = new Random(1123);
    const stripes = 8, sw = W / stripes;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#f4efe4' : '#8d857a';
      ctx.fillRect(i * sw, 0, sw, H);
      // Stitched stripe seam: a hairline shadow and a lighter thread beside it.
      ctx.fillStyle = rgba(0, 0, 0, 0.16);
      ctx.fillRect(i * sw, 0, 1, H);
      ctx.fillStyle = rgba(255, 255, 255, 0.18);
      ctx.fillRect(i * sw + 1, 0, 1, H);
    }
    // Weave: a 2 px warp/weft grid at low alpha, then a fine grain, blurred so it reads as cloth rather than a screen.
    ctx.fillStyle = rgba(0, 0, 0, 0.06);
    for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    ctx.fillStyle = rgba(255, 255, 255, 0.05);
    for (let x = 0; x < W; x += 3) ctx.fillRect(x, 0, 1, H);
    this.grain(ctx, W, H, rng, 0.05, 0.1);
    this.blur3(ctx, W, H);
    // Sun fade at the top (v = 1) and a grubby, damp hem at the bottom (v = 0).
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgba(255, 250, 240, 0.16));
    g.addColorStop(0.5, rgba(255, 250, 240, 0));
    g.addColorStop(0.85, rgba(40, 32, 24, 0));
    g.addColorStop(1, rgba(40, 32, 24, 0.2));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    return this.finish(key, canvas, true);
  }

  /**
   * Palm trunk bark (128 x 512, tiles both ways): fibrous brown with wide, soft leaf-scar chevrons - a lit ridge, a
   * darker fibrous band under it with short vertical fibres in it, and a shadow tail - softened 1 px so the bands
   * read as bark at arm's length and average to a calm tone up the trunk.
   */
  palmBark(): THREE.CanvasTexture {
    const key = 'bark';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const W = 128, H = 512;
    const { canvas, ctx } = this.canvas(W, H);
    const rng = new Random(83);
    ctx.fillStyle = '#8a6a44';
    ctx.fillRect(0, 0, W, H);
    this.mottle(ctx, W, H, rng, 30, 12, 40, 0.08, 0, 0, true);
    // Vertical fibres: long faint strands and shorter darker ones.
    for (let i = 0; i < 90; i++) {
      const light = rng.chance(0.5), v = light ? 255 : 0;
      ctx.fillStyle = rgba(v, v * 0.9, v * 0.75, rng.range(0.03, 0.08));
      const y = rng.range(0, H), h = rng.range(H * 0.2, H);
      ctx.fillRect(rng.range(0, W), y, rng.range(1, 3), h);
      if (y + h > H) ctx.fillRect(rng.range(0, W), 0, rng.range(1, 3), y + h - H);
    }
    // Leaf scars: chevrons (so the band meets itself across the u seam), alternating direction per band.
    const bandH = 32;
    const bands = H / bandH;
    for (let k = 0; k < bands; k++) {
      const y0 = k * bandH + rng.range(-3, 3);
      const rise = (k % 2 === 0 ? 1 : -1) * rng.range(7, 11);
      const chevron = (y: number, h: number): void => {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W / 2, y + rise);
        ctx.lineTo(W, y);
        ctx.lineTo(W, y + h);
        ctx.lineTo(W / 2, y + rise + h);
        ctx.lineTo(0, y + h);
        ctx.closePath();
        ctx.fill();
      };
      ctx.fillStyle = rgba(236, 208, 160, 0.3);
      chevron(y0, 6);
      ctx.fillStyle = rgba(250, 232, 196, 0.22);
      chevron(y0 + 1, 2);
      ctx.fillStyle = rgba(40, 24, 12, 0.42);
      chevron(y0 + 6, 10);
      ctx.fillStyle = rgba(40, 24, 12, 0.16);
      chevron(y0 + 16, 7);
      // Fibres inside the dark band: the torn edge of the old leaf base.
      for (let f = 0; f < 14; f++) {
        const x = rng.range(0, W);
        const yy = y0 + 6 + rise * (1 - Math.abs(x - W / 2) / (W / 2));
        ctx.fillStyle = rng.chance(0.7) ? rgba(20, 10, 4, 0.35) : rgba(230, 200, 150, 0.2);
        ctx.fillRect(x, yy - rng.range(0, 3), rng.range(1, 2), rng.range(8, 16));
      }
    }
    this.soften(ctx, W, H);
    return this.finish(key, canvas, true);
  }

  /** Roughness for the asphalt: painted by road() itself (aggregate 1.0, paint 0.65, iron 0.55 - times the material's 0.85). */
  roadRough(): THREE.CanvasTexture {
    return this.groundRough('road', 0.62, 1);
  }

  /** Tangent-space relief derived from a ground albedo: slab joints, the kerb chamfer, cracks, lane-paint edges. */
  groundNormal(name: 'sidewalk' | 'plaza' | 'road', strength: number): THREE.CanvasTexture {
    const key = name + ':nrm';
    const hit = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (hit) return hit;
    const src = this[name]().image as HTMLCanvasElement | undefined;
    if (!src || !src.width) return this.finish(key, this.canvas(4, 4).canvas, false);
    return this.normalFromLuminance(key, src, strength);
  }

  /**
   * Ground roughness map. road() and sidewalk() paint theirs directly while drawing (so paint and iron come out
   * smoother than aggregate, not the other way round); the plaza's is still derived from luminance, remapped into lo..hi.
   */
  groundRough(name: 'sidewalk' | 'plaza' | 'road', lo: number, hi: number): THREE.CanvasTexture {
    const key = name + ':rgh';
    const src = this[name]().image as HTMLCanvasElement | undefined;
    const hit = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (hit) return hit;
    if (!src || !src.width) return this.finish(key, this.canvas(4, 4).canvas, false);
    return this.roughFromLuminance(key, src, lo, hi);
  }

  /** Soft radial white glow (sprites, light pools, particles, neon bloom). */
  radialGlow(): THREE.CanvasTexture {
    const key = 'glow';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 128;
    const { canvas, ctx } = this.canvas(S, S);
    ctx.clearRect(0, 0, S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.7)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return this.finish(key, canvas, true, false);
  }

  /**
   * Equirectangular star field (sampled by the sky dome shader): varied magnitudes plus a faint milky band.
   * 1024 x 512 (2 MB): the dome shader maps the lower half to the hemisphere below the horizon, which stays black, and
   * a star is a single texel either way - at this size it lands as a soft 3-4 px point on a 720p frame.
   */
  starField(): THREE.CanvasTexture {
    const key = 'stars';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const W = 1024, H = 512;
    const { canvas, ctx } = this.canvas(W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const rng = new Random(91);
    // Milky band across the upper hemisphere.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 700; i++) {
      const x = rng.range(0, W);
      const band = H * 0.24 + Math.sin((x / W) * Math.PI * 2) * H * 0.1;
      const y = band + rng.range(-1, 1) * rng.range(0, 1) * H * 0.09;
      if (y < 0 || y > H * 0.55) continue;
      const rad = rng.range(5, 17);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(150,160,210,0.10)');
      g.addColorStop(1, 'rgba(120,130,190,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - 17, y - 17, 34, 34);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 2000; i++) {
      const b = rng.range(0.22, 0.75);
      ctx.fillStyle = rgba(255 * b, 255 * b, 255 * Math.min(1, b + 0.1), 1);
      ctx.fillRect(rng.range(0, W), rng.range(0, H * 0.55), 1, 1);
    }
    // A handful of bright stars with a short cross flare.
    for (let i = 0; i < 70; i++) {
      const x = Math.floor(rng.range(1, W - 1)), y = Math.floor(rng.range(1, H * 0.52));
      const warm = rng.chance(0.3);
      ctx.fillStyle = warm ? 'rgba(255,225,190,1)' : 'rgba(220,236,255,1)';
      ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = warm ? 'rgba(255,225,190,0.45)' : 'rgba(220,236,255,0.45)';
      ctx.fillRect(x - 1, y, 3, 1);
      ctx.fillRect(x, y - 1, 1, 3);
    }
    return this.finish(key, canvas, true);
  }

  /** White body with a blue band and 'POLİS' lettering (available for vehicle decals). */
  policeLivery(): THREE.CanvasTexture {
    const key = 'police';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const W = 256, H = 128;
    const { canvas, ctx } = this.canvas(W, H);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1f4fd8';
    ctx.fillRect(0, 48, W, 32);
    ctx.fillStyle = '#ffffff';
    ctx.font = "900 26px 'Trebuchet MS', Arial, sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('POLİS', W / 2, 64);
    return this.finish(key, canvas, true, false);
  }

  dispose(): void {
    this.cache.forEach((t) => t.dispose());
    this.cache.clear();
    this.atlasRects = null;
  }
}
