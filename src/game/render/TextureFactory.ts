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
/** Street-level band tiles: the ground-floor shopfront (beach/suburb) and the downtown stone plinth. u repeats every TILE_W m, v spans the band height exactly. The shop tile carries a pier on every quarter (4 m), where BuildingGeometry's arcade columns stand. */
export const SHOP_TILE_W = 16;
export const SHOP_BAND_H = 4.2;
export const PLINTH_TILE_W = 16;
export const PLINTH_BAND_H = 6;
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
        const roll = rng.next();
        const blinds = roll < (style === 'glass' ? 0.3 : 0.26);
        let blindH = 0, curtainX = -1, curtainW = 0;
        if (blinds) {
          // Slats are 4 px (6 cm) apart: a faint stripe on a cream pane, pulled down to somewhere between a third and all the way.
          blindH = gh * rng.range(0.35, 1);
          m.ctx.fillStyle = rgba(232, 226, 214, style === 'glass' ? 0.45 : 0.55);
          m.ctx.fillRect(gx, gy, gw, blindH);
          m.ctx.fillStyle = rgba(110, 104, 94, 0.2);
          for (let yy = gy + 4; yy < gy + blindH - 4; yy += 6) m.ctx.fillRect(gx, yy, gw, 2);
          m.ctx.fillStyle = rgba(140, 132, 120, 0.7);
          m.ctx.fillRect(gx, gy + blindH - 5, gw, 5);
          if (blindH < gh) {
            m.ctx.fillStyle = rgba(0, 0, 0, 0.22);
            m.ctx.fillRect(gx, gy + blindH, gw, gh - blindH);
          }
        } else if (roll < 0.44 && style !== 'glass') {
          curtainW = gw * rng.range(0.3, 0.5);
          curtainX = rng.chance(0.5) ? gx : gx + gw - curtainW;
          m.ctx.fillStyle = rgba(236, 226, 210, 0.7);
          m.ctx.fillRect(curtainX, gy, curtainW, gh);
          m.ctx.fillStyle = rgba(90, 80, 70, 0.14);
          for (let xx = curtainX + 4; xx < curtainX + curtainW - 3; xx += 10) m.ctx.fillRect(xx, gy, 3, gh);
          if (rng.chance(0.35)) {
            // Both sides drawn, a gap of room between them.
            const ox = curtainX === gx ? gx + gw - curtainW : gx;
            m.ctx.fillStyle = rgba(236, 226, 210, 0.7);
            m.ctx.fillRect(ox, gy, curtainW, gh);
            m.ctx.fillStyle = rgba(90, 80, 70, 0.14);
            for (let xx = ox + 4; xx < ox + curtainW - 3; xx += 10) m.ctx.fillRect(xx, gy, 3, gh);
          }
        } else if (roll < 0.64) {
          m.ctx.fillStyle = rgba(0, 0, 0, style === 'glass' ? 0.16 : 0.25);
          m.ctx.fillRect(gx, gy, gw, gh);
        } else if (roll < 0.76) {
          m.ctx.fillStyle = rgba(205, 228, 255, 0.3);
          m.ctx.fillRect(gx, gy, gw, gh);
        } else if (roll < 0.83 && style !== 'glass' && !ground) {
          // A plant on the sill: a dark green mound with a lighter top, low in the pane.
          const pw = gw * rng.range(0.2, 0.32), px = gx + rng.range(6, gw - pw - 6);
          m.ctx.fillStyle = rgba(46, 96, 52, 0.85);
          m.ctx.fillRect(px, gy + gh - 24, pw, 24);
          m.ctx.fillStyle = rgba(96, 150, 78, 0.6);
          m.ctx.fillRect(px + 4, gy + gh - 24, pw - 8, 8);
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
          if (rng.chance(0.3)) {
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
        // A fifth of the sills carry a split-unit air conditioner, hung to one side.
        if (sillY > 0 && rng.chance(0.2)) acUnit(rng.chance(0.5) ? gx + 4 : gx + gw - 48, sillY + 4);
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
   * Ground-floor shopfront band (16 m x 4.2 m at 2048 x 512 px, 128 px/m): eight shops with painted interiors
   * behind the glass - shelving, counters, a doner spit, mannequins, tiled floors - plus a bay under a rolled steel
   * shutter and a recessed apartment doorway, with Turkish names lettered on the fascias. The interior scene is
   * drawn once on a scratch canvas and used twice: dimmed through the glass in the albedo, and under a warm ceiling
   * light in the emissive, so the same shelves that show by day glow at night. Relief comes from a structure canvas
   * (piers, fascias, frames, slats), not the albedo, so a poster does not read as a bump.
   */
  shopfront(): WindowTextures {
    const key = 'shop';
    const mk = this.cache.get(key + ':map') as THREE.CanvasTexture | undefined;
    const ek = this.cache.get(key + ':emi') as THREE.CanvasTexture | undefined;
    const nk = this.cache.get(key + ':nrm') as THREE.CanvasTexture | undefined;
    const rk = this.cache.get(key + ':rgh') as THREE.CanvasTexture | undefined;
    if (mk && ek && nk && rk) return { map: mk, emissive: ek, normal: nk, rough: rk };
    const W = 2048, H = 512;
    const sx = W / SHOP_TILE_W, sy = H / SHOP_BAND_H;
    const X = (mx: number): number => mx * sx;
    const Y = (my: number): number => (SHOP_BAND_H - my) * sy;
    const rng = new Random(1301);
    const m = this.canvas(W, H), e = this.canvas(W / 2, H / 2), r = this.canvas(W / 4, H / 4), n = this.canvas(W / 2, H / 2), scene = this.canvas(W, H);
    e.ctx.scale(0.5, 0.5);
    r.ctx.scale(0.25, 0.25);
    n.ctx.scale(0.5, 0.5);
    m.ctx.fillStyle = '#cdc6b8';
    m.ctx.fillRect(0, 0, W, H);
    this.mottle(m.ctx, W, H, rng, 90, 30, 90, 0.05, 0, 0, true);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, H);
    r.ctx.fillStyle = grey(0.9);
    r.ctx.fillRect(0, 0, W, H);
    n.ctx.fillStyle = grey(0.5);
    n.ctx.fillRect(0, 0, W, H);
    scene.ctx.clearRect(0, 0, W, H);
    type Kind = 'bakkal' | 'eczane' | 'kebap' | 'door' | 'kuafor' | 'shutter' | 'simit' | 'market' | 'butik';
    // Widths sum to 16 m in four 4 m groups, so a pier falls on every quarter of the tile (the arcade column line).
    const bays: { name: string; w: number; kind: Kind; fascia: number; text: number; glow: number }[] = [
      { name: 'BAKKAL', w: 2.3, kind: 'bakkal', fascia: 0x1f5a48, text: 0xfff4dc, glow: 0x62ffc0 },
      { name: 'ECZANE', w: 1.7, kind: 'eczane', fascia: 0xf0f2ee, text: 0x1e8a4c, glow: 0x3cf080 },
      { name: 'KEBAP', w: 2.2, kind: 'kebap', fascia: 0x8c2020, text: 0xffe6b0, glow: 0xffb15c },
      { name: 'KUAFÖR', w: 1.8, kind: 'kuafor', fascia: 0x6a2050, text: 0xffe0f0, glow: 0xff6aa8 },
      { name: 'BERBER', w: 1.6, kind: 'shutter', fascia: 0x1f3a5c, text: 0xf0f4ff, glow: 0x59c8ff },
      { name: '', w: 0.9, kind: 'door', fascia: 0x8c8478, text: 0, glow: 0 },
      { name: 'SİMİT', w: 1.5, kind: 'simit', fascia: 0xb87a1c, text: 0x3a2408, glow: 0xffd070 },
      { name: 'MARKET', w: 2.2, kind: 'market', fascia: 0x1c4fa8, text: 0xffffff, glow: 0x7fb4ff },
      { name: 'BUTİK', w: 1.8, kind: 'butik', fascia: 0x2a2a30, text: 0xf4e8d8, glow: 0xffe0b0 },
    ];
    // Heights above the pavement (m): stall riser, glazing, fascia.
    const RISER = 0.35, GLASS_TOP = 3.3, FASCIA_Y = 3.4, PIER = 0.24;
    const floorY = Y(0.85);
    const sc = scene.ctx;
    // Palette for goods on shelves.
    const GOODS = ['#e04a2a', '#f2b632', '#2e8ad8', '#43b05c', '#f4f0e6', '#d94f8a', '#7b4ad6', '#ff8a2a'];
    const shelves = (x0: number, x1: number, ys: number[], dense: boolean, wallCol: string): void => {
      sc.fillStyle = wallCol;
      sc.fillRect(x0, Y(GLASS_TOP), x1 - x0, floorY - Y(GLASS_TOP));
      for (const yb of ys) {
        const y = Y(yb);
        sc.fillStyle = '#d9cfbf';
        sc.fillRect(x0, y, x1 - x0, 5);
        sc.fillStyle = rgba(0, 0, 0, 0.25);
        sc.fillRect(x0, y + 5, x1 - x0, 4);
        for (let x = x0 + 6; x < x1 - 12;) {
          const w = rng.range(10, dense ? 18 : 24), h = rng.range(16, 34);
          sc.fillStyle = GOODS[rng.int(0, GOODS.length - 1)];
          sc.fillRect(x, y - h, w, h);
          sc.fillStyle = rgba(255, 255, 255, 0.25);
          sc.fillRect(x, y - h, w, 4);
          x += w + rng.range(2, dense ? 4 : 10);
        }
      }
    };
    const counter = (x0: number, x1: number, col: string, topCol: string): void => {
      const y = Y(0.95);
      sc.fillStyle = col;
      sc.fillRect(x0, y, x1 - x0, Y(0.4) - y);
      sc.fillStyle = topCol;
      sc.fillRect(x0 - 3, y - 6, x1 - x0 + 6, 8);
      sc.fillStyle = rgba(0, 0, 0, 0.3);
      sc.fillRect(x0 - 3, y + 2, x1 - x0 + 6, 5);
    };
    const poster = (x: number, y: number, w: number, h: number, col: string): void => {
      sc.fillStyle = '#f6f2ea';
      sc.fillRect(x, y, w, h);
      sc.fillStyle = col;
      sc.fillRect(x + 4, y + 4, w - 8, h * 0.55);
      sc.fillStyle = rgba(40, 40, 44, 0.7);
      for (let yy = y + h * 0.62; yy < y + h - 6; yy += 7) sc.fillRect(x + 6, yy, w - 12 - rng.range(0, w * 0.4), 3);
    };
    const floor = (x0: number, x1: number, light: string, dark: string): void => {
      // Tiled floor seen through the glass: rows closer together toward the back, a skirting line at the wall.
      sc.fillStyle = light;
      sc.fillRect(x0, floorY, x1 - x0, Y(RISER) - floorY);
      sc.fillStyle = dark;
      const rowsY = [0.85, 0.74, 0.62, 0.48];
      for (let i = 0; i < rowsY.length; i++) sc.fillRect(x0, Y(rowsY[i]), x1 - x0, 2);
      for (let x = x0; x < x1; x += 0.36 * sx) sc.fillRect(x, floorY, 2, Y(RISER) - floorY);
      sc.fillStyle = rgba(0, 0, 0, 0.45);
      sc.fillRect(x0, floorY - 5, x1 - x0, 6);
    };
    const doorStep = (dx0: number, dx1: number): void => {
      sc.fillStyle = rgba(0, 0, 0, 0.2);
      sc.fillRect(dx0, Y(0.62), dx1 - dx0, Y(RISER) - Y(0.62));
    };
    const spots = (x0: number, x1: number, count: number): void => {
      // Ceiling: a darker strip with recessed spots drawn as bright discs (they bloom in the emissive).
      sc.fillStyle = '#6a625a';
      sc.fillRect(x0, Y(GLASS_TOP), x1 - x0, Y(3.05) - Y(GLASS_TOP));
      for (let k = 0; k < count; k++) {
        const cx = x0 + ((k + 0.5) / count) * (x1 - x0);
        sc.fillStyle = '#fff4dc';
        sc.beginPath();
        sc.arc(cx, Y(3.16), 7, 0, Math.PI * 2);
        sc.fill();
      }
    };
    let mx = 0;
    const fasciaFont = `900 ${Math.round(0.42 * sy)}px 'Trebuchet MS', 'Segoe UI', 'DejaVu Sans', Arial, sans-serif`;
    for (const bay of bays) {
      const bx0 = X(mx), bx1 = X(mx + bay.w);
      const ix0 = X(mx + PIER / 2), ix1 = X(mx + bay.w - PIER / 2);
      mx += bay.w;
      if (bay.kind === 'door') {
        // Recessed apartment entrance: dark reveal, a panelled timber door with a fanlight, a step and a number plate.
        m.ctx.fillStyle = '#2a2622';
        m.ctx.fillRect(ix0, Y(FASCIA_Y), ix1 - ix0, Y(0) - Y(FASCIA_Y));
        const dw = Math.min(0.9 * sx, ix1 - ix0 - 12), dx = (ix0 + ix1) / 2 - dw / 2;
        m.ctx.fillStyle = '#6a4426';
        m.ctx.fillRect(dx, Y(2.5), dw, Y(0.42) - Y(2.5));
        for (const [py0, py1] of [[2.3, 1.55], [1.35, 0.6]]) {
          this.softRect(m.ctx, dx + 10, Y(py0), dw - 20, Y(py1) - Y(py0), '#000', 0.3);
          this.softRect(m.ctx, dx + 14, Y(py0) + 4, dw - 28, Y(py1) - Y(py0) - 8, '#8a5c34', 1);
        }
        m.ctx.fillStyle = '#c8a040';
        m.ctx.fillRect(dx + dw - 16, Y(1.05), 6, 12);
        // Fanlight and its dim lamp.
        m.ctx.fillStyle = '#9fb0b8';
        m.ctx.fillRect(dx, Y(2.95), dw, Y(2.55) - Y(2.95));
        e.ctx.fillStyle = rgba(150, 120, 80, 1);
        e.ctx.fillRect(dx, Y(2.95), dw, Y(2.55) - Y(2.95));
        // Step and number plate.
        m.ctx.fillStyle = '#8a8478';
        m.ctx.fillRect(ix0, Y(0.42), ix1 - ix0, Y(0) - Y(0.42));
        this.softRect(m.ctx, ix0, Y(0.42), ix1 - ix0, 3, '#fff', 0.35);
        m.ctx.fillStyle = '#1a3c8c';
        m.ctx.fillRect(dx - 22, Y(2.2), 18, 14);
        // Lintel band where the fascia would be.
        m.ctx.fillStyle = hex(bay.fascia);
        m.ctx.fillRect(bx0, Y(SHOP_BAND_H), bx1 - bx0, Y(FASCIA_Y));
        // Structure: the recess sits back, the door step forward.
        n.ctx.fillStyle = grey(0.22);
        n.ctx.fillRect(ix0, Y(FASCIA_Y), ix1 - ix0, Y(0.42) - Y(FASCIA_Y));
        n.ctx.fillStyle = grey(0.35);
        n.ctx.fillRect(dx, Y(2.95), dw, Y(0.42) - Y(2.95));
        r.ctx.fillStyle = grey(0.55);
        r.ctx.fillRect(dx, Y(2.5), dw, Y(0.42) - Y(2.5));
      } else if (bay.kind === 'shutter') {
        // Rolled steel shutter down over the whole opening: a housing box, slats, a tag sprayed low.
        m.ctx.fillStyle = '#5a5e62';
        m.ctx.fillRect(ix0, Y(GLASS_TOP + 0.05), ix1 - ix0, Y(3.0) - Y(GLASS_TOP + 0.05));
        this.softRect(m.ctx, ix0, Y(3.0), ix1 - ix0, 6, '#000', 0.35);
        for (let y = Y(3.0); y < Y(RISER); y += 10) {
          m.ctx.fillStyle = '#9ca2a6';
          m.ctx.fillRect(ix0, y, ix1 - ix0, 10);
          this.softRect(m.ctx, ix0, y, ix1 - ix0, 3, '#fff', 0.3);
          this.softRect(m.ctx, ix0, y + 6, ix1 - ix0, 4, '#000', 0.3);
          n.ctx.fillStyle = grey(0.58);
          n.ctx.fillRect(ix0, y, ix1 - ix0, 5);
          n.ctx.fillStyle = grey(0.42);
          n.ctx.fillRect(ix0, y + 5, ix1 - ix0, 5);
        }
        m.ctx.lineCap = 'round';
        m.ctx.lineWidth = 9;
        m.ctx.strokeStyle = rgba(230, 40, 120, 0.8);
        m.ctx.beginPath();
        m.ctx.moveTo(ix0 + 30, Y(1.1));
        m.ctx.quadraticCurveTo(ix0 + 70, Y(0.5), ix0 + 110, Y(1.05));
        m.ctx.lineTo(ix0 + 150, Y(0.6));
        m.ctx.stroke();
        m.ctx.strokeStyle = rgba(40, 60, 200, 0.7);
        m.ctx.beginPath();
        m.ctx.moveTo(ix0 + 90, Y(0.9));
        m.ctx.quadraticCurveTo(ix0 + 140, Y(1.4), ix0 + 190, Y(0.85));
        m.ctx.stroke();
        r.ctx.fillStyle = grey(0.5);
        r.ctx.fillRect(ix0, Y(GLASS_TOP + 0.05), ix1 - ix0, Y(RISER) - Y(GLASS_TOP + 0.05));
      } else {
        // Glazed shop: interior scene, then the glass over it.
        const gx0 = ix0 + 6, gx1 = ix1 - 6, gy0 = Y(GLASS_TOP), gy1 = Y(RISER);
        const doorLeft = rng.chance(0.5);
        // Inner width in metres; the narrow bays (< 2 m) get one mirror / mannequin and shorter counters.
        const bw = (gx1 - gx0) / sx, narrow = bw < 2.0;
        const dw = 0.8 * sx;
        const dx0 = doorLeft ? gx0 + 6 : gx1 - 6 - dw, dx1 = dx0 + dw;
        sc.save();
        sc.beginPath();
        sc.rect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        sc.clip();
        switch (bay.kind) {
          case 'bakkal': {
            shelves(gx0, gx1, [1.35, 1.95, 2.55], false, '#c9b48a');
            spots(gx0, gx1, 2);
            floor(gx0, gx1, '#b8ae9e', rgba(60, 50, 40, 0.5));
            // Fruit crates stacked at the window.
            const cx = doorLeft ? gx1 - 0.9 * sx : gx0 + 10;
            for (let row = 0; row < 2; row++) {
              for (let k = 0; k < 2; k++) {
                const x = cx + k * 0.42 * sx, y = Y(0.85 + row * 0.32);
                sc.fillStyle = '#a8804a';
                sc.fillRect(x, y - 0.3 * sy, 0.38 * sx, 0.3 * sy);
                sc.fillStyle = ['#ff8a2a', '#d8302a', '#5cc040', '#f2d040'][rng.int(0, 3)];
                for (let b = 0; b < 4; b++) { sc.beginPath(); sc.arc(x + 6 + b * 8, y - 0.3 * sy + 5, 5, 0, Math.PI * 2); sc.fill(); }
              }
            }
            counter(doorLeft ? gx0 + dw + 16 : gx0 + 10, doorLeft ? gx0 + dw + 16 + 0.6 * sx : gx0 + 10 + 0.6 * sx, '#7a5a3a', '#e0d6c4');
            break;
          }
          case 'eczane': {
            sc.fillStyle = '#eef2ee';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            for (const yb of [1.4, 2.0, 2.6]) {
              const y = Y(yb);
              sc.fillStyle = '#d8dcd8';
              sc.fillRect(gx0, y, gx1 - gx0, 5);
              for (let x = gx0 + 8; x < gx1 - 14;) {
                const w = rng.range(10, 16), h = rng.range(14, 26);
                sc.fillStyle = rng.chance(0.6) ? '#f8fafc' : rng.chance(0.5) ? '#3b78c8' : '#3cb060';
                sc.fillRect(x, y - h, w, h);
                sc.fillStyle = rgba(0, 0, 0, 0.12);
                sc.fillRect(x, y - h, w, 3);
                x += w + 4;
              }
            }
            spots(gx0, gx1, 3);
            floor(gx0, gx1, '#d4d6d2', rgba(70, 76, 80, 0.35));
            counter(doorLeft ? gx1 - 0.7 * sx : gx0 + 12, doorLeft ? gx1 - 12 : gx0 + 0.7 * sx, '#e8ece8', '#b8c4c8');
            // Green cross on the side wall.
            const cxp = doorLeft ? gx0 + 24 : gx1 - 64;
            sc.fillStyle = '#1e9a4c';
            sc.fillRect(cxp, Y(2.75), 40, 40);
            sc.fillStyle = '#ffffff';
            sc.fillRect(cxp + 16, Y(2.75) + 6, 8, 28);
            sc.fillRect(cxp + 6, Y(2.75) + 16, 28, 8);
            break;
          }
          case 'kebap': {
            sc.fillStyle = '#8a3628';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            // Menu board on the back wall.
            const mbx = doorLeft ? gx1 - 1.0 * sx : gx0 + 16;
            sc.fillStyle = '#2a1a14';
            sc.fillRect(mbx, Y(2.9), 0.85 * sx, Y(2.05) - Y(2.9));
            sc.fillStyle = rgba(255, 236, 200, 0.85);
            for (let yy = Y(2.8); yy < Y(2.1); yy += 12) sc.fillRect(mbx + 8, yy, rng.range(30, 70), 4);
            spots(gx0, gx1, 2);
            floor(gx0, gx1, '#b09a80', rgba(60, 40, 30, 0.5));
            // Counter with a steel top and the doner spit standing on it.
            const kx0 = doorLeft ? gx0 + dw + 16 : gx0 + 10, kx1 = doorLeft ? gx1 - 10 : gx1 - dw - 16;
            counter(kx0, kx1, '#4a3a30', '#c8ccd0');
            const sxp = (kx0 + kx1) / 2;
            const spit = sc.createLinearGradient(sxp - 18, 0, sxp + 18, 0);
            spit.addColorStop(0, '#7a4218');
            spit.addColorStop(0.45, '#d89048');
            spit.addColorStop(1, '#8a4c1c');
            sc.fillStyle = spit;
            sc.beginPath();
            sc.moveTo(sxp - 12, Y(2.35));
            sc.lineTo(sxp + 12, Y(2.35));
            sc.lineTo(sxp + 20, Y(1.15));
            sc.lineTo(sxp - 20, Y(1.15));
            sc.closePath();
            sc.fill();
            sc.fillStyle = '#c0c4c8';
            sc.fillRect(sxp - 2, Y(2.55), 4, Y(1.0) - Y(2.55));
            sc.fillStyle = rgba(255, 120, 40, 0.5);
            sc.fillRect(sxp + 24, Y(2.3), 10, Y(1.2) - Y(2.3));
            break;
          }
          case 'kuafor': {
            sc.fillStyle = '#caa8bc';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            spots(gx0, gx1, 3);
            floor(gx0, gx1, '#c8c0c4', rgba(60, 40, 60, 0.35));
            // Two mirrors with chairs in front of them.
            for (let k = 0; k < (narrow ? 1 : 2); k++) {
              const x = (doorLeft ? gx0 + dw + 0.15 * sx : gx0 + 0.15 * sx) + k * 0.8 * sx;
              sc.fillStyle = '#3a3038';
              sc.fillRect(x - 4, Y(2.55), 0.62 * sx + 8, Y(1.45) - Y(2.55) + 8);
              const mg = sc.createLinearGradient(0, Y(2.55), 0, Y(1.45));
              mg.addColorStop(0, '#eef4f8');
              mg.addColorStop(1, '#b8c8d4');
              sc.fillStyle = mg;
              sc.fillRect(x, Y(2.55) + 4, 0.62 * sx, Y(1.45) - Y(2.55));
              sc.fillStyle = '#26262c';
              sc.fillRect(x + 8, Y(1.3), 0.46 * sx, Y(0.7) - Y(1.3));
              sc.fillStyle = '#9aa0a6';
              sc.fillRect(x + 0.24 * sx, Y(0.7), 10, Y(0.5) - Y(0.7));
              sc.fillRect(x + 0.1 * sx, Y(0.5), 0.3 * sx, 6);
            }
            poster(doorLeft ? gx0 + 16 : gx1 - 66, Y(2.7), 50, 70, '#d8407a');
            break;
          }
          case 'simit': {
            sc.fillStyle = '#d9b070';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            spots(gx0, gx1, 2);
            floor(gx0, gx1, '#c4b49a', rgba(70, 50, 30, 0.45));
            // Back shelves and a glass display case, both stacked with simit rings.
            const ring = (x: number, y: number): void => {
              sc.fillStyle = '#c98a3a';
              sc.beginPath(); sc.arc(x, y, 9, 0, Math.PI * 2); sc.fill();
              sc.fillStyle = '#7a4c18';
              sc.beginPath(); sc.arc(x, y, 3.5, 0, Math.PI * 2); sc.fill();
              sc.fillStyle = rgba(255, 240, 200, 0.35);
              sc.beginPath(); sc.arc(x - 2, y - 3, 4, 0, Math.PI * 2); sc.fill();
            };
            for (const yb of [1.7, 2.2, 2.7]) {
              sc.fillStyle = '#8a6030';
              sc.fillRect(gx0, Y(yb), gx1 - gx0, 5);
              for (let x = gx0 + 14; x < gx1 - 10; x += 20) ring(x, Y(yb) - 9);
            }
            const cx0 = doorLeft ? gx0 + dw + 12 : gx0 + 10, cx1 = doorLeft ? gx1 - 10 : gx1 - dw - 12;
            counter(cx0, cx1, '#e8e2d8', '#b0aca4');
            sc.fillStyle = rgba(200, 230, 240, 0.35);
            sc.fillRect(cx0, Y(1.45), cx1 - cx0, Y(0.95) - Y(1.45));
            for (let x = cx0 + 14; x < cx1 - 10; x += 20) ring(x, Y(1.1));
            break;
          }
          case 'market': {
            shelves(gx0, gx1, [1.15, 1.65, 2.15, 2.65], true, '#e6e6de');
            spots(gx0, gx1, 3);
            floor(gx0, gx1, '#d0d2cc', rgba(60, 64, 70, 0.35));
            // Drinks fridge by the door.
            const fw = 0.6 * sx, fx = doorLeft ? gx0 + dw + 14 : gx1 - 14 - fw;
            sc.fillStyle = '#e4e8ec';
            sc.fillRect(fx, Y(2.3), fw, Y(0.45) - Y(2.3));
            sc.fillStyle = '#24405c';
            sc.fillRect(fx + 6, Y(2.15), fw - 12, Y(0.6) - Y(2.15));
            sc.fillStyle = rgba(120, 200, 255, 0.6);
            sc.fillRect(fx + 6, Y(2.15), fw - 12, 4);
            for (let yy = Y(1.95); yy < Y(0.7); yy += 22) for (let x = fx + 12; x < fx + fw - 16; x += 12) { sc.fillStyle = GOODS[rng.int(0, 3)]; sc.fillRect(x, yy, 8, 16); }
            break;
          }
          case 'butik': {
            sc.fillStyle = '#efe6d8';
            sc.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            spots(gx0, gx1, 3);
            floor(gx0, gx1, '#c8b8a0', rgba(80, 60, 40, 0.4));
            // Clothes rail across the back.
            sc.fillStyle = '#8a8a90';
            sc.fillRect(gx0 + 10, Y(2.3), gx1 - gx0 - 20, 4);
            for (let x = gx0 + 20; x < gx1 - 30; x += 22) {
              sc.fillStyle = GOODS[rng.int(0, GOODS.length - 1)];
              sc.fillRect(x, Y(2.3) + 8, 16, Y(1.3) - Y(2.3));
            }
            // Mannequins in the window: torso on a stand.
            for (let k = 0; k < (narrow ? 1 : 2); k++) {
              const x = doorLeft ? gx1 - 0.5 * sx - k * 0.55 * sx : gx0 + 0.12 * sx + k * 0.55 * sx;
              sc.fillStyle = '#3a3a40';
              sc.fillRect(x + 0.14 * sx, Y(0.85), 6, Y(0.42) - Y(0.85));
              sc.fillRect(x + 0.04 * sx, Y(0.42), 0.26 * sx, 6);
              sc.fillStyle = k === 0 ? '#d84060' : '#3868b8';
              sc.beginPath();
              sc.moveTo(x, Y(1.95));
              sc.lineTo(x + 0.34 * sx, Y(1.95));
              sc.lineTo(x + 0.3 * sx, Y(0.9));
              sc.lineTo(x + 0.04 * sx, Y(0.9));
              sc.closePath();
              sc.fill();
              sc.fillStyle = '#e8d8c8';
              sc.beginPath(); sc.arc(x + 0.17 * sx, Y(2.1), 11, 0, Math.PI * 2); sc.fill();
            }
            poster(doorLeft ? gx0 + 16 : gx1 - 66, Y(2.85), 50, 70, '#e0a030');
            break;
          }
          default:
            break;
        }
        doorStep(dx0, dx1);
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
        const shx = gx0 + (gx1 - gx0) * rng.range(0.2, 0.6);
        const sheen = m.ctx.createLinearGradient(shx, gy0, shx + 90, gy1);
        sheen.addColorStop(0, rgba(255, 255, 255, 0));
        sheen.addColorStop(0.45, rgba(255, 255, 255, 0.1));
        sheen.addColorStop(0.55, rgba(255, 255, 255, 0.1));
        sheen.addColorStop(1, rgba(255, 255, 255, 0));
        m.ctx.fillStyle = sheen;
        m.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
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
        // Frames: head and jambs, the door's frame and push bar, one mullion per ~1.1 m; black in the emissive.
        const mullions: number[] = [];
        for (let x = gx0 + 0.9 * sx; x < gx1 - 0.4 * sx; x += 0.9 * sx) if (x < dx0 - 12 || x > dx1 + 12) mullions.push(x);
        for (const c of [m.ctx, e.ctx]) {
          c.fillStyle = c === m.ctx ? '#2a3038' : '#000';
          c.fillRect(gx0 - 6, gy0 - 6, gx1 - gx0 + 12, 8);
          c.fillRect(gx0 - 6, gy0, 6, gy1 - gy0);
          c.fillRect(gx1, gy0, 6, gy1 - gy0);
          for (const x of mullions) c.fillRect(x - 3, gy0, 6, gy1 - gy0);
          c.fillRect(dx0 - 5, gy0, 5, gy1 - gy0);
          c.fillRect(dx1, gy0, 5, gy1 - gy0);
          c.fillRect(dx0, Y(1.05), dw, 5);
          c.fillRect(dx0, Y(2.35), dw, 4);
        }
        this.softRect(m.ctx, gx0 - 6, gy0 - 6, gx1 - gx0 + 12, 3, '#9aa8b4', 0.7);
        for (const x of mullions) this.softRect(m.ctx, x - 3, gy0, 3, gy1 - gy0, '#9aa8b4', 0.5);
        this.softRect(m.ctx, dx0, Y(1.05), dw, 2, '#c8d0d8', 0.7);
        // Structure: glass recessed, frames raised. Roughness: glass smooth, frames satin.
        n.ctx.fillStyle = grey(0.36);
        n.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        n.ctx.fillStyle = grey(0.62);
        n.ctx.fillRect(gx0 - 6, gy0 - 6, gx1 - gx0 + 12, 8);
        for (const x of mullions) n.ctx.fillRect(x - 3, gy0, 6, gy1 - gy0);
        n.ctx.fillRect(dx0 - 5, gy0, 5, gy1 - gy0);
        n.ctx.fillRect(dx1, gy0, 5, gy1 - gy0);
        r.ctx.fillStyle = grey(0.22);
        r.ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        r.ctx.fillStyle = grey(0.55);
        for (const x of mullions) r.ctx.fillRect(x - 3, gy0, 6, gy1 - gy0);
      }
      // Fascia: a painted sign box with the shop name, a lit top edge and a shadow under it; dimly backlit at night.
      if (bay.kind !== 'door') {
        const fy0 = Y(SHOP_BAND_H), fy1 = Y(FASCIA_Y);
        m.ctx.fillStyle = hex(bay.fascia);
        m.ctx.fillRect(bx0 + 3, fy0, bx1 - bx0 - 6, fy1 - fy0);
        this.softRect(m.ctx, bx0 + 3, fy0, bx1 - bx0 - 6, 4, '#fff', 0.2);
        this.softRect(m.ctx, bx0 + 3, fy1 - 8, bx1 - bx0 - 6, 8, '#000', 0.35);
        const fg = e.ctx.createLinearGradient(0, fy0, 0, fy1);
        fg.addColorStop(0, tint(bay.fascia, -0.55));
        fg.addColorStop(1, tint(bay.fascia, -0.7));
        e.ctx.fillStyle = fg;
        e.ctx.fillRect(bx0 + 3, fy0, bx1 - bx0 - 6, fy1 - fy0);
        for (const c of [m.ctx, e.ctx]) {
          c.font = fasciaFont;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillStyle = c === m.ctx ? hex(bay.text) : tint(bay.glow, 0.25);
          c.fillText(bay.name, (bx0 + bx1) / 2, (fy0 + fy1) / 2 + 2, bx1 - bx0 - 40);
        }
        n.ctx.fillStyle = grey(0.56);
        n.ctx.fillRect(bx0 + 3, fy0, bx1 - bx0 - 6, fy1 - fy0);
        r.ctx.fillStyle = grey(0.55);
        r.ctx.fillRect(bx0 + 3, fy0, bx1 - bx0 - 6, fy1 - fy0);
        // Awning valance shadow just under the fascia (the real awning is geometry, and only on the street face).
        this.softRect(m.ctx, bx0 + 3, fy1, bx1 - bx0 - 6, 8, '#000', 0.25);
      }
      // Stone piers between the bays (each bay owns the pier on its left; the last one wraps to the seam).
      const pxl = bx0 - X(PIER / 2), pw = X(PIER);
      m.ctx.fillStyle = '#a9a396';
      m.ctx.fillRect(pxl, Y(FASCIA_Y), pw, Y(0) - Y(FASCIA_Y));
      this.softRect(m.ctx, pxl, Y(FASCIA_Y), 4, Y(0) - Y(FASCIA_Y), '#fff', 0.22);
      this.softRect(m.ctx, pxl + pw - 5, Y(FASCIA_Y), 5, Y(0) - Y(FASCIA_Y), '#000', 0.28);
      if (pxl < 0) {
        m.ctx.fillRect(W + pxl, Y(FASCIA_Y), -pxl, Y(0) - Y(FASCIA_Y));
        this.softRect(m.ctx, W + pxl, Y(FASCIA_Y), 4, Y(0) - Y(FASCIA_Y), '#fff', 0.22);
      }
      e.ctx.fillStyle = '#000';
      e.ctx.fillRect(pxl, 0, pw, H);
      if (pxl < 0) e.ctx.fillRect(W + pxl, 0, -pxl, H);
      n.ctx.fillStyle = grey(0.64);
      n.ctx.fillRect(pxl, Y(FASCIA_Y), pw, Y(0) - Y(FASCIA_Y));
      if (pxl < 0) n.ctx.fillRect(W + pxl, Y(FASCIA_Y), -pxl, Y(0) - Y(FASCIA_Y));
    }
    // Stall riser / plinth strip along the bottom (under the glazing, the piers stand on it).
    m.ctx.fillStyle = '#6c6a66';
    m.ctx.fillRect(0, Y(RISER), W, H - Y(RISER));
    this.softRect(m.ctx, 0, Y(RISER), W, 4, '#000', 0.3);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, Y(RISER), W, H - Y(RISER));
    n.ctx.fillStyle = grey(0.56);
    n.ctx.fillRect(0, Y(RISER), W, H - Y(RISER));
    r.ctx.fillStyle = grey(0.85);
    r.ctx.fillRect(0, Y(RISER), W, H - Y(RISER));
    this.grime(m.ctx, W, H, rng, H * 0.6, 0, 2);
    this.soften(m.ctx, W, H);
    const map = this.finish(key + ':map', m.canvas, true, true, true);
    const emissive = this.finish(key + ':emi', e.canvas, true, true, true);
    const normal = this.normalFromLuminance(key + ':nrm', n.canvas, 5, 8);
    const rough = this.finish(key + ':rgh', r.canvas, false, true, true);
    return { map, emissive, normal, rough };
  }

  /** Downtown stone plinth band (16 m x 6 m): pilasters, recessed dark glazing, brass trim; emissive = dim lobby light. */
  plinth(): WindowTextures {
    const key = 'plinth';
    const mk = this.cache.get(key + ':map') as THREE.CanvasTexture | undefined;
    const ek = this.cache.get(key + ':emi') as THREE.CanvasTexture | undefined;
    const nk = this.cache.get(key + ':nrm') as THREE.CanvasTexture | undefined;
    const rk = this.cache.get(key + ':rgh') as THREE.CanvasTexture | undefined;
    if (mk && ek && nk && rk) return { map: mk, emissive: ek, normal: nk, rough: rk };
    const W = 1024, H = 384;
    const rng = new Random(1607);
    // The emissive only carries pane-sized lobby shapes: half resolution through a scaled context.
    const m = this.canvas(W, H), e = this.canvas(W / 2, H / 2);
    e.ctx.scale(0.5, 0.5);
    m.ctx.fillStyle = '#4a4e58';
    m.ctx.fillRect(0, 0, W, H);
    this.mottle(m.ctx, W, H, rng, 70, 20, 60, 0.06, 4000, 0.03, false);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, H);
    const cornice = 44, base = H - 26;
    const bays = 8, bw = W / bays, pw = 34;
    for (let i = 0; i < bays; i++) {
      const x = i * bw;
      // Recessed dark glazing between pilasters.
      const gx = x + pw / 2 + 6, gw = bw - pw - 12, gy = cornice + 18, gh = base - gy - 10;
      m.ctx.fillStyle = '#243040';
      m.ctx.fillRect(gx, gy, gw, gh);
      m.ctx.fillStyle = rgba(120, 160, 200, 0.14);
      m.ctx.fillRect(gx, gy, gw, gh * 0.35);
      // Lobby: cool base light with two ceiling spots and a reception desk / column silhouettes.
      e.ctx.fillStyle = rgba(70, 92, 118, 1);
      e.ctx.fillRect(gx, gy, gw, gh);
      for (let k = 0; k < 2; k++) {
        const sx = gx + gw * (0.28 + k * 0.44) + rng.range(-8, 8), sy = gy + gh * 0.1, sr = gh * 0.55;
        const g = e.ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
        g.addColorStop(0, rgba(225, 238, 255, 1));
        g.addColorStop(0.4, rgba(170, 200, 240, 0.5));
        g.addColorStop(1, rgba(150, 190, 235, 0));
        e.ctx.fillStyle = g;
        e.ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
      }
      e.ctx.fillStyle = rgba(0, 0, 0, 0.4);
      e.ctx.fillRect(gx, gy + gh * 0.6, gw, gh * 0.4);
      for (let k = 0; k < 3; k++) {
        const sw = rng.range(10, 30), sh = gh * rng.range(0.3, 0.55);
        const sx = gx + rng.range(4, gw - sw - 4);
        e.ctx.fillStyle = rgba(0, 0, 0, 0.65);
        e.ctx.fillRect(sx, gy + gh - sh, sw, sh);
      }
      for (const c of [m.ctx, e.ctx]) {
        c.fillStyle = c === m.ctx ? 'rgba(24,30,38,0.95)' : 'rgba(0,0,0,0.9)';
        for (let k = 1; k < 3; k++) c.fillRect(gx + (gw * k) / 3 - 3, gy, 6, gh);
        c.fillRect(gx - 4, gy - 4, gw + 8, 7);
        c.fillRect(gx - 4, gy + gh - 3, gw + 8, 7);
      }
      // Pilaster column.
      m.ctx.fillStyle = '#5d626d';
      m.ctx.fillRect(x - pw / 2, cornice, pw, base - cornice);
      m.ctx.fillStyle = rgba(255, 255, 255, 0.16);
      m.ctx.fillRect(x - pw / 2 + 3, cornice, 8, base - cornice);
      m.ctx.fillStyle = rgba(0, 0, 0, 0.3);
      m.ctx.fillRect(x + pw / 2 - 6, cornice, 6, base - cornice);
      // Brass capital + base.
      m.ctx.fillStyle = '#a8873c';
      m.ctx.fillRect(x - pw / 2 - 3, cornice, pw + 6, 7);
      m.ctx.fillRect(x - pw / 2 - 3, base - 10, pw + 6, 6);
    }
    // Cornice band along the top and a dark granite base at the bottom.
    m.ctx.fillStyle = '#6b707c';
    m.ctx.fillRect(0, 0, W, cornice);
    m.ctx.fillStyle = rgba(0, 0, 0, 0.35);
    m.ctx.fillRect(0, cornice - 8, W, 8);
    m.ctx.fillStyle = rgba(255, 255, 255, 0.12);
    m.ctx.fillRect(0, 4, W, 5);
    m.ctx.fillStyle = '#2f333b';
    m.ctx.fillRect(0, base, W, H - base);
    this.grime(m.ctx, W, H, rng, H * 0.6, 0);
    this.soften(m.ctx, W, H);
    const map = this.finish(key + ':map', m.canvas, true, true, true);
    const emissive = this.finish(key + ':emi', e.canvas, true, true, true);
    // Relief and roughness only need the mullion / pier steps: derive both from a half-res copy.
    const half = this.canvas(W / 2, H / 2);
    half.ctx.drawImage(m.canvas, 0, 0, W / 2, H / 2);
    const normal = this.normalFromLuminance(key + ':nrm', half.canvas, 5.5, 8);
    const rough = this.roughFromLuminance(key + ':rgh', half.canvas, 0.26, 0.92);
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
