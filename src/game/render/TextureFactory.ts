// Procedural CanvasTexture factory (windows, shopfronts, road, sidewalk, sand, water, grass, plaza, neon atlas, fronds, glows, clouds, stars), cached by key. Track B.
import * as THREE from 'three';
import type { BuildingStyle } from '../city/CityData';
import { Random } from '../core/Random';

export interface WindowTextures { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture; normal: THREE.CanvasTexture; rough: THREE.CanvasTexture }
export interface AtlasRect { u0: number; v0: number; u1: number; v1: number }

/** Window tile: 256x512 px = 16 m x 28 m; the top ROOF_STRIP px (v > 0.98) are a plain wall color used by roofs and plain parts. */
export const WINDOW_TILE_W = 16;
export const WINDOW_TILE_H = 28;
export const ROOF_STRIP_PX = 10;
/** UV v of the plain strip center (used by roofs/landmark plain parts). */
export const ROOF_V = 1 - ROOF_STRIP_PX / 2 / 512;
/** UV u of a cell in the glow atlas (see glowAtlas()): cell 0 is non-emissive, the rest are night-glow colors. Glow parts use their own material. */
export const GLOW_U = { none: 0.0625, magenta: 0.1875, cyan: 0.3125, yellow: 0.4375, orange: 0.5625, red: 0.6875, green: 0.8125, white: 0.9375 } as const;
const GLOW_CELLS: number[] = [0x000000, 0xff2d95, 0x00e5ff, 0xfff03b, 0xff7a00, 0xff2418, 0x2bff6a, 0xf0f4ff];
export const ROAD_TILE_M = 14;
/** Street-level band tiles: the ground-floor shopfront (beach/suburb) and the downtown stone plinth. u repeats every TILE_W m, v spans the band height exactly. */
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
    const ctx = canvas.getContext('2d');
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
    t.anisotropy = 4;
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
   * Weathering pass over a finished facade tile: grime washing down from the sills, soft dirt blotches and a little
   * colour drift. Clean flat panels are the thing that dates a procedural city most, and because the normal and
   * roughness maps are derived from this albedo the streaks show up in the shading too, not just the colour.
   */
  private grime(ctx: CanvasRenderingContext2D, W: number, H: number, rng: Random, rowH: number, top: number): void {
    // Streaks: they start just under a floor line and fade downwards.
    const streaks = Math.round(W / 7);
    for (let i = 0; i < streaks; i++) {
      const x = rng.range(0, W);
      const w = rng.range(1, 4);
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

  /** Albedo + emissive window tiles for a building style. 4 columns x 8 rows per 16 m x 28 m tile; lit windows cluster per floor. */
  windows(style: BuildingStyle, seed = 1): WindowTextures {
    const key = `win:${style}:${seed}`;
    const mk = this.cache.get(key + ':map') as THREE.CanvasTexture | undefined;
    const ek = this.cache.get(key + ':emi') as THREE.CanvasTexture | undefined;
    const nk = this.cache.get(key + ':nrm') as THREE.CanvasTexture | undefined;
    const rk = this.cache.get(key + ':rgh') as THREE.CanvasTexture | undefined;
    if (mk && ek && nk && rk) return { map: mk, emissive: ek, normal: nk, rough: rk };
    const W = 256, H = 512;
    const rng = new Random(seed * 7919 + style.length);
    const m = this.canvas(W, H), e = this.canvas(W, H);
    const wall = style === 'glass' ? 0x9fb4c8 : style === 'concrete' ? 0xb8b8b4 : style === 'artdeco' ? 0xd8d0c0 : style === 'neon' ? 0xe8e0e8 : 0xd4cfc4;
    m.ctx.fillStyle = hex(wall);
    m.ctx.fillRect(0, 0, W, H);
    this.noise(m.ctx, W, H, rng, 1400, 2, 0.12, false);
    this.noise(m.ctx, W, H, rng, 600, 2, 0.1, true);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, H);
    const cols = 4, rows = 8;
    const cw = W / cols, rh = (H - ROOF_STRIP_PX) / rows;
    const top = ROOF_STRIP_PX;
    // Style-specific facade dressing drawn before the glazing.
    if (style === 'artdeco') {
      // Vertical fluting between window columns.
      for (let c = 0; c <= cols; c++) {
        const x = c * cw;
        m.ctx.fillStyle = tint(wall, 0.22);
        m.ctx.fillRect(x - 5, top, 10, H - top);
        m.ctx.fillStyle = rgba(0, 0, 0, 0.16);
        m.ctx.fillRect(x + 5, top, 3, H - top);
      }
    } else if (style === 'concrete') {
      // Precast panel joints.
      m.ctx.fillStyle = rgba(0, 0, 0, 0.2);
      for (let c = 0; c <= cols; c++) m.ctx.fillRect(c * cw - 1, top, 2, H - top);
    } else if (style === 'residential') {
      m.ctx.fillStyle = rgba(0, 0, 0, 0.07);
      for (let i = 0; i < 26; i++) m.ctx.fillRect(0, top + rng.range(0, H), W, 1);
    }
    // Per-style window shapes (fractions of a cell).
    let wx = 0.2, wy = 0.25, ww = 0.6, wh = 0.5;
    if (style === 'glass') { wx = 0.03; wy = 0.04; ww = 0.94; wh = 0.72; }
    else if (style === 'concrete') { wx = 0.26; wy = 0.28; ww = 0.48; wh = 0.44; }
    else if (style === 'artdeco') { wx = 0.28; wy = 0.14; ww = 0.44; wh = 0.66; }
    else if (style === 'neon') { wx = 0.06; wy = 0.24; ww = 0.88; wh = 0.46; }
    else { wx = 0.16; wy = 0.2; ww = 0.68; wh = 0.5; }
    const glassDay = style === 'glass' ? '#43678d' : style === 'neon' ? '#334255' : '#2e3a48';
    for (let r = 0; r < rows; r++) {
      const y0 = top + r * rh;
      const ground = r === rows - 1;
      // Floor bands / cornices.
      if (style === 'artdeco') {
        m.ctx.fillStyle = tint(wall, 0.3);
        m.ctx.fillRect(0, y0 + rh - 6, W, 4);
        m.ctx.fillStyle = rgba(0, 0, 0, 0.22);
        m.ctx.fillRect(0, y0 + rh - 2, W, 3);
        for (let d = 0; d < 16; d++) { m.ctx.fillStyle = rgba(0, 0, 0, 0.12); m.ctx.fillRect(d * (W / 16) + 4, y0 + rh - 10, 6, 4); }
      } else if (style === 'residential') {
        m.ctx.fillStyle = rgba(0, 0, 0, 0.18);
        m.ctx.fillRect(0, y0 + rh - 3, W, 3);
        // Balcony rail on alternating floors: a light band with bars.
        if (r % 2 === 0) {
          m.ctx.fillStyle = tint(wall, 0.35);
          m.ctx.fillRect(0, y0 + rh * 0.62, W, 3);
          m.ctx.fillRect(0, y0 + rh * 0.86, W, 4);
          m.ctx.fillStyle = rgba(70, 62, 54, 0.55);
          for (let bx = 3; bx < W; bx += 9) m.ctx.fillRect(bx, y0 + rh * 0.62, 2, rh * 0.26);
        }
      } else if (style === 'neon') {
        m.ctx.fillStyle = r % 2 === 0 ? rgba(255, 120, 200, 0.4) : rgba(90, 220, 255, 0.4);
        m.ctx.fillRect(0, y0 + rh - 6, W, 3);
        m.ctx.fillStyle = rgba(0, 0, 0, 0.14);
        m.ctx.fillRect(0, y0 + rh - 3, W, 2);
      } else if (style === 'glass') {
        // Opaque spandrel under every floor of the curtain wall.
        m.ctx.fillStyle = rgba(28, 40, 56, 0.85);
        m.ctx.fillRect(0, y0 + rh * 0.78, W, rh * 0.22);
        m.ctx.fillStyle = rgba(210, 226, 240, 0.35);
        m.ctx.fillRect(0, y0 + rh * 0.78, W, 2);
      } else {
        m.ctx.fillStyle = rgba(0, 0, 0, 0.12);
        m.ctx.fillRect(0, y0 + rh - 2, W, 2);
      }
      // Lit windows cluster per floor: pick a density for the whole row.
      const rowLit = ground ? 0.75 : rng.chance(0.25) ? 0.75 : rng.chance(0.4) ? 0.35 : 0.08;
      for (let c = 0; c < cols; c++) {
        const x0 = c * cw;
        let gx = x0 + wx * cw, gy = y0 + wy * rh, gw = ww * cw, gh = wh * rh;
        if (ground && style !== 'glass') { gx = x0 + 0.1 * cw; gy = y0 + 0.12 * rh; gw = 0.8 * cw; gh = 0.86 * rh; }
        m.ctx.fillStyle = glassDay;
        m.ctx.fillRect(gx, gy, gw, gh);
        // Sky reflection: brighter at the top of each pane.
        const grad = m.ctx.createLinearGradient(gx, gy, gx, gy + gh);
        grad.addColorStop(0, 'rgba(255,255,255,0.3)');
        grad.addColorStop(0.45, 'rgba(255,255,255,0.06)');
        grad.addColorStop(1, 'rgba(0,0,0,0.18)');
        m.ctx.fillStyle = grad;
        m.ctx.fillRect(gx, gy, gw, gh);
        if (style === 'glass') {
          m.ctx.fillStyle = rgba(150, 176, 200, 0.7);
          m.ctx.fillRect(gx + gw / 2 - 1, gy, 2, gh);
          m.ctx.fillRect(gx - 1, gy, 2, gh);
        } else if (style === 'neon') {
          m.ctx.fillStyle = rgba(20, 26, 34, 0.7);
          for (let k = 1; k < 4; k++) m.ctx.fillRect(gx + (gw * k) / 4 - 1, gy, 2, gh);
        } else if (style === 'concrete') {
          // Deep reveal: shadow along the top and left of the punched opening.
          m.ctx.fillStyle = rgba(0, 0, 0, 0.35);
          m.ctx.fillRect(gx - 2, gy - 2, gw + 4, 3);
          m.ctx.fillRect(gx - 2, gy - 2, 3, gh + 4);
          m.ctx.fillStyle = tint(wall, 0.3);
          m.ctx.fillRect(gx - 2, gy + gh, gw + 4, 3);
        } else if (style === 'artdeco') {
          m.ctx.fillStyle = tint(wall, 0.45);
          m.ctx.fillRect(gx - 3, gy - 3, gw + 6, 3);
          m.ctx.fillRect(gx - 3, gy + gh, gw + 6, 4);
          m.ctx.fillStyle = rgba(60, 60, 70, 0.7);
          m.ctx.fillRect(gx + gw / 2 - 1, gy, 2, gh);
        } else if (!ground) {
          // Residential: white frame, sill and an occasional shutter.
          m.ctx.fillStyle = rgba(250, 248, 244, 0.9);
          m.ctx.fillRect(gx - 3, gy - 3, gw + 6, 3);
          m.ctx.fillRect(gx - 3, gy + gh, gw + 6, 4);
          m.ctx.fillRect(gx + gw / 2 - 1, gy, 2, gh);
          if (rng.chance(0.3)) { m.ctx.fillStyle = rgba(120, 150, 130, 0.85); m.ctx.fillRect(gx, gy, gw * 0.45, gh); }
        }
        const lit = rng.chance(rowLit);
        if (lit) {
          const warm = rng.chance(style === 'glass' ? 0.45 : 0.85);
          const rr = warm ? 255 : 180, gg = warm ? 200 + rng.int(0, 45) : 220, bb = warm ? 115 + rng.int(0, 65) : 255;
          e.ctx.fillStyle = rgba(rr, gg, bb, 0.9 + rng.next() * 0.1);
          e.ctx.fillRect(gx, gy, gw, gh);
          // Blinds / furniture blocking part of the pane.
          e.ctx.fillStyle = rgba(0, 0, 0, 0.3);
          if (rng.chance(0.45)) e.ctx.fillRect(gx, gy, gw * (0.3 + rng.next() * 0.35), gh);
          if (rng.chance(0.35)) e.ctx.fillRect(gx, gy, gw, gh * 0.3);
        }
      }
    }
    this.grime(m.ctx, W, H, rng, rh, top);
    // Plain strip at the top (v > 0.98): white in the albedo (vertex color shows exactly), black in the emissive.
    // The strip stays fully non-emissive: walls tile through it, so anything lit here would show up as bands on facades.
    m.ctx.fillStyle = '#ffffff';
    m.ctx.fillRect(0, 0, W, ROOF_STRIP_PX);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, ROOF_STRIP_PX);
    const map = this.finish(key + ':map', m.canvas, true);
    const emissive = this.finish(key + ':emi', e.canvas, true);
    const normal = this.normalFromLuminance(key + ':nrm', m.canvas, 6.5);
    const rough = this.roughFromLuminance(key + ':rgh', m.canvas, 0.12, 0.95);
    return { map, emissive, normal, rough };
  }

  /**
   * Derives a tangent-space normal map from a painted albedo, reading luminance as height: dark glass sinks into
   * the wall, bright fluting and cornices stand out. Cheap way to give flat facades per-pixel relief.
   */
  private normalFromLuminance(key: string, src: HTMLCanvasElement, strength: number): THREE.CanvasTexture {
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
    // steps - mullions, sills, fluting, fascia edges - so panes stay flat and their frames get the relief.
    const R = 4;
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

  /** Ground-floor shopfront band (16 m x 4.2 m): four bays of glazing, doors and fascias; emissive = warm shop interiors + fascia glow. */
  shopfront(): WindowTextures {
    const key = 'shop';
    const mk = this.cache.get(key + ':map') as THREE.CanvasTexture | undefined;
    const ek = this.cache.get(key + ':emi') as THREE.CanvasTexture | undefined;
    const nk = this.cache.get(key + ':nrm') as THREE.CanvasTexture | undefined;
    const rk = this.cache.get(key + ':rgh') as THREE.CanvasTexture | undefined;
    if (mk && ek && nk && rk) return { map: mk, emissive: ek, normal: nk, rough: rk };
    const W = 1024, H = 256;
    const rng = new Random(1301);
    const m = this.canvas(W, H), e = this.canvas(W, H);
    m.ctx.fillStyle = '#c8c2b6';
    m.ctx.fillRect(0, 0, W, H);
    this.noise(m.ctx, W, H, rng, 2600, 2, 0.13, false);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, H);
    const FASCIA = [0x1f3a5c, 0x7a2140, 0x1f5a48, 0x6a3a12];
    const GLOWC = [0x59c8ff, 0xff6aa8, 0x62ffc0, 0xffb15c];
    const bays = 4, bw = W / bays;
    // v = 0 at the bottom of the canvas -> canvas y = H is the pavement.
    const kerbY = H - 14, fasciaH = 52;
    for (let i = 0; i < bays; i++) {
      const x = i * bw;
      // Fascia band across the top of the bay.
      m.ctx.fillStyle = hex(FASCIA[i]);
      m.ctx.fillRect(x + 2, 0, bw - 4, fasciaH);
      m.ctx.fillStyle = rgba(255, 255, 255, 0.16);
      m.ctx.fillRect(x + 2, 0, bw - 4, 5);
      m.ctx.fillStyle = rgba(0, 0, 0, 0.35);
      m.ctx.fillRect(x + 2, fasciaH - 6, bw - 4, 6);
      // Abstract lettering on the fascia (bars).
      let lx = x + 26;
      for (let k = 0; k < 5 + (i % 3); k++) {
        const lw = 10 + ((k * 7 + i * 5) % 22);
        m.ctx.fillStyle = rgba(255, 245, 225, 0.9);
        m.ctx.fillRect(lx, 16, lw, 20);
        e.ctx.fillStyle = tint(GLOWC[i], 0.15);
        e.ctx.fillRect(lx, 16, lw, 20);
        lx += lw + 10;
        if (lx > x + bw - 40) break;
      }
      // Stone pier between bays.
      m.ctx.fillStyle = '#a9a396';
      m.ctx.fillRect(x, fasciaH, 16, H - fasciaH);
      m.ctx.fillStyle = rgba(255, 255, 255, 0.18);
      m.ctx.fillRect(x + 1, fasciaH, 4, H - fasciaH);
      // Glazing + door.
      const gx = x + 18, gy = fasciaH + 12, gw = bw - 36, gh = kerbY - gy;
      m.ctx.fillStyle = '#1b2a36';
      m.ctx.fillRect(gx, gy, gw, gh);
      const doorW = 54, doorX = i % 2 === 0 ? gx + gw - doorW - 8 : gx + 8;
      // Warm interior in the emissive.
      e.ctx.fillStyle = rgba(255, 214, 150, 0.95);
      e.ctx.fillRect(gx, gy, gw, gh);
      e.ctx.fillStyle = rgba(0, 0, 0, 0.5);
      e.ctx.fillRect(gx, gy + gh * 0.62, gw, gh * 0.38);
      for (let k = 0; k < 5; k++) {
        if (rng.chance(0.5)) continue;
        const sx = gx + rng.range(6, gw - 40);
        e.ctx.fillStyle = rgba(0, 0, 0, 0.45);
        e.ctx.fillRect(sx, gy + rng.range(4, gh * 0.5), rng.range(14, 34), gh * 0.5);
      }
      // Mullions over the glass in both maps.
      for (const c of [m.ctx, e.ctx]) {
        c.fillStyle = c === m.ctx ? 'rgba(30,38,46,0.95)' : 'rgba(0,0,0,0.85)';
        for (let k = 1; k < 4; k++) c.fillRect(gx + (gw * k) / 4 - 3, gy, 6, gh);
        c.fillRect(gx - 3, gy - 3, gw + 6, 6);
        c.fillRect(doorX, gy, 4, gh);
        c.fillRect(doorX + doorW, gy, 4, gh);
        c.fillRect(doorX, gy + gh * 0.18, doorW, 5);
      }
      // Awning valance stub drawn on the wall (the real awning is geometry).
      m.ctx.fillStyle = rgba(0, 0, 0, 0.28);
      m.ctx.fillRect(x + 2, fasciaH, bw - 4, 7);
    }
    // Kerb / plinth strip along the bottom.
    m.ctx.fillStyle = '#6c6a66';
    m.ctx.fillRect(0, kerbY, W, H - kerbY);
    this.noise(m.ctx, W, H - kerbY + 1, rng, 400, 2, 0.2, true);
    m.ctx.fillStyle = rgba(0, 0, 0, 0.3);
    m.ctx.fillRect(0, kerbY, W, 3);
    this.grime(m.ctx, W, H, rng, H * 0.6, 0);
    const map = this.finish(key + ':map', m.canvas, true, true, true);
    const emissive = this.finish(key + ':emi', e.canvas, true, true, true);
    const normal = this.normalFromLuminance(key + ':nrm', m.canvas, 5.5);
    const rough = this.roughFromLuminance(key + ':rgh', m.canvas, 0.1, 0.92);
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
    const m = this.canvas(W, H), e = this.canvas(W, H);
    m.ctx.fillStyle = '#4a4e58';
    m.ctx.fillRect(0, 0, W, H);
    this.noise(m.ctx, W, H, rng, 4000, 3, 0.18, false);
    this.noise(m.ctx, W, H, rng, 2000, 2, 0.1, true);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, H);
    const cornice = 44, base = H - 26;
    const bays = 8, bw = W / bays, pw = 34;
    for (let i = 0; i < bays; i++) {
      const x = i * bw;
      // Recessed dark glazing between pilasters.
      const gx = x + pw / 2 + 6, gw = bw - pw - 12, gy = cornice + 18, gh = base - gy - 10;
      m.ctx.fillStyle = '#16202c';
      m.ctx.fillRect(gx, gy, gw, gh);
      m.ctx.fillStyle = rgba(120, 160, 200, 0.14);
      m.ctx.fillRect(gx, gy, gw, gh * 0.35);
      e.ctx.fillStyle = rgba(150, 190, 235, 0.6);
      e.ctx.fillRect(gx, gy, gw, gh);
      e.ctx.fillStyle = rgba(0, 0, 0, 0.55);
      e.ctx.fillRect(gx, gy + gh * 0.5, gw, gh * 0.5);
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
    this.noise(m.ctx, W, H, rng, 900, 2, 0.08, true);
    this.grime(m.ctx, W, H, rng, H * 0.6, 0);
    const map = this.finish(key + ':map', m.canvas, true, true, true);
    const emissive = this.finish(key + ':emi', e.canvas, true, true, true);
    const normal = this.normalFromLuminance(key + ':nrm', m.canvas, 5.5);
    const rough = this.roughFromLuminance(key + ':rgh', m.canvas, 0.1, 0.92);
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

  /** Asphalt tile (ROAD_TILE_M x ROAD_TILE_M m): dashed white lane separators at +-3.5 m, double yellow center, patches and wear. u = across, v = along. */
  road(): THREE.CanvasTexture {
    const key = 'road';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 512;
    const { canvas, ctx } = this.canvas(S, S);
    const rng = new Random(11);
    ctx.fillStyle = '#3a3c40';
    ctx.fillRect(0, 0, S, S);
    this.noise(ctx, S, S, rng, 5000, 2, 0.35, false);
    this.noise(ctx, S, S, rng, 2500, 2, 0.2, true);
    // Repair patches (slightly different asphalt) and tar seams.
    for (let i = 0; i < 5; i++) {
      const px = rng.range(0, S), py = rng.range(0, S), pw = rng.range(40, 150), ph = rng.range(30, 120);
      ctx.fillStyle = rgba(0, 0, 0, 0.1 + rng.next() * 0.1);
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = rgba(20, 20, 22, 0.55);
      ctx.lineWidth = 3;
      ctx.strokeRect(px, py, pw, ph);
    }
    ctx.strokeStyle = rgba(24, 24, 26, 0.5);
    ctx.lineWidth = 2;
    for (let i = 0; i < 10; i++) {
      const x = rng.range(0, S), y = rng.range(0, S);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + rng.range(-70, 70), y + rng.range(-70, 70));
      ctx.stroke();
    }
    const px = S / ROAD_TILE_M;
    const cx = S / 2;
    // Darker tyre tracks in the wheel paths.
    ctx.fillStyle = rgba(0, 0, 0, 0.12);
    for (const off of [-5.4, -1.9, 1.9, 5.4]) ctx.fillRect(cx + off * px - 0.5 * px, 0, 1.0 * px, S);
    ctx.fillStyle = '#c9ab3c';
    ctx.fillRect(cx - 0.35 * px, 0, 0.15 * px, S);
    ctx.fillRect(cx + 0.2 * px, 0, 0.15 * px, S);
    ctx.fillStyle = '#c2c2bd';
    for (let side = -1; side <= 1; side += 2) {
      const x = cx + side * 3.5 * px - 0.08 * px;
      for (let y = 0; y < S; y += 3 * px) ctx.fillRect(x, y, 0.16 * px, 1.5 * px);
    }
    // Faded paint: scratch the markings a little.
    this.noise(ctx, S, S, rng, 1800, 2, 0.16, false);
    return this.finish(key, canvas, true);
  }

  /** Intersection tile: asphalt with zebra crossings and stop bars along all four edges. */
  crosswalk(): THREE.CanvasTexture {
    const key = 'crosswalk';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 512;
    const { canvas, ctx } = this.canvas(S, S);
    const rng = new Random(23);
    ctx.fillStyle = '#3a3c40';
    ctx.fillRect(0, 0, S, S);
    this.noise(ctx, S, S, rng, 5000, 2, 0.35, false);
    this.noise(ctx, S, S, rng, 2500, 2, 0.2, true);
    ctx.fillStyle = rgba(0, 0, 0, 0.12);
    for (let i = 0; i < 4; i++) ctx.fillRect(rng.range(0, S), rng.range(0, S), rng.range(40, 120), rng.range(40, 120));
    const px = S / ROAD_TILE_M;
    const band = 2.4 * px, m = 0.6 * px, stripe = 0.6 * px, gap = 0.5 * px;
    ctx.fillStyle = '#bdbdb7';
    for (let x = 1.4 * px; x < S - 1.4 * px; x += stripe + gap) {
      ctx.fillRect(x, m, stripe, band);
      ctx.fillRect(x, S - m - band, stripe, band);
      ctx.fillRect(m, x, band, stripe);
      ctx.fillRect(S - m - band, x, band, stripe);
    }
    // Stop bars just inside the zebra on the approach halves.
    const sb = 0.45 * px, sy = m + band + 0.35 * px;
    ctx.fillStyle = '#b6b6ae';
    ctx.fillRect(S / 2 + 0.2 * px, sy, S / 2 - 1.4 * px, sb);
    ctx.fillRect(1.4 * px, S - sy - sb, S / 2 - 1.6 * px, sb);
    ctx.fillRect(sy, 1.4 * px, sb, S / 2 - 1.6 * px);
    ctx.fillRect(S - sy - sb, S / 2 + 0.2 * px, sb, S / 2 - 1.4 * px);
    this.noise(ctx, S, S, rng, 1500, 2, 0.14, false);
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

  /** Concrete paving tile (4 m) with slab joints and wear. */
  sidewalk(): THREE.CanvasTexture {
    const key = 'sidewalk';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 256;
    const { canvas, ctx } = this.canvas(S, S);
    const rng = new Random(31);
    ctx.fillStyle = '#9b978f';
    ctx.fillRect(0, 0, S, S);
    // Per-slab shade variation (4 x 4 slabs of 1 m).
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const k = rng.range(-0.05, 0.06);
        ctx.fillStyle = k > 0 ? rgba(255, 255, 255, k * 2) : rgba(0, 0, 0, -k * 2);
        ctx.fillRect(i * 64, j * 64, 64, 64);
      }
    }
    this.noise(ctx, S, S, rng, 2500, 2, 0.16, false);
    this.noise(ctx, S, S, rng, 1500, 2, 0.14, true);
    ctx.fillStyle = rgba(0, 0, 0, 0.3);
    for (let i = 0; i < 4; i++) { ctx.fillRect(0, i * 64, S, 2); ctx.fillRect(i * 64, 0, 2, S); }
    ctx.fillStyle = rgba(255, 255, 255, 0.16);
    for (let i = 0; i < 4; i++) { ctx.fillRect(0, i * 64 + 2, S, 1); ctx.fillRect(i * 64 + 2, 0, 1, S); }
    // Stains and cracks.
    ctx.strokeStyle = rgba(0, 0, 0, 0.22);
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) {
      const x = rng.range(0, S), y = rng.range(0, S);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + rng.range(-30, 30), y + rng.range(-30, 30));
      ctx.stroke();
    }
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
    this.noise(ctx, S, S, rng, 3000, 2, 0.1, false);
    this.noise(ctx, S, S, rng, 3000, 2, 0.18, true);
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
    this.noise(ctx, S, S, rng, 1200, 2, 0.12, true);
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
    ctx.fillStyle = '#b8a8b8';
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = '#d8b8c8';
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if ((x + y) % 2 === 0) ctx.fillRect(x * 64, y * 64, 64, 64);
    ctx.fillStyle = '#ff7a00';
    ctx.fillRect(112, 112, 32, 32);
    this.noise(ctx, S, S, rng, 1500, 2, 0.12, false);
    ctx.fillStyle = rgba(0, 0, 0, 0.25);
    for (let i = 0; i < 4; i++) { ctx.fillRect(0, i * 64, S, 2); ctx.fillRect(i * 64, 0, 2, S); }
    return this.finish(key, canvas, true);
  }

  /** One 1024x1024 atlas with a glowing white row per word; tint via vertex colors. Returns per-word UV rects. */
  neonAtlas(words: readonly string[]): { texture: THREE.CanvasTexture; rects: Map<string, AtlasRect> } {
    const key = 'neonAtlas';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c && this.atlasRects) return { texture: c, rects: this.atlasRects };
    const S = 1024;
    const { canvas, ctx } = this.canvas(S, S);
    ctx.clearRect(0, 0, S, S);
    const rows = Math.max(1, words.length);
    const rh = Math.floor(S / rows);
    const fontPx = Math.floor(rh * 0.62);
    ctx.font = `900 ${fontPx}px 'Trebuchet MS', 'Segoe UI', Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const rects = new Map<string, AtlasRect>();
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const y = i * rh + rh / 2;
      const tw = Math.min(S - 40, ctx.measureText(w).width);
      const x = 20;
      ctx.shadowColor = 'rgba(255,255,255,0.95)';
      ctx.shadowBlur = fontPx * 0.5;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(w, x, y, S - 40);
      ctx.fillText(w, x, y, S - 40);
      ctx.fillText(w, x, y, S - 40);
      ctx.shadowBlur = fontPx * 0.12;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(w, x, y, S - 40);
      ctx.shadowBlur = 0;
      const pad = fontPx * 0.35;
      rects.set(w, { u0: (x - pad) / S, u1: (x + tw + pad) / S, v0: 1 - (i * rh + rh) / S, v1: 1 - (i * rh) / S });
    }
    const texture = this.finish(key, canvas, true, false);
    this.atlasRects = rects;
    return { texture, rects };
  }

  /** Palm frond with alpha: a tapered leaf with feathered strips, tip toward +v. */
  palmFrond(): THREE.CanvasTexture {
    const key = 'frond';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const W = 128, H = 256;
    const { canvas, ctx } = this.canvas(W, H);
    ctx.clearRect(0, 0, W, H);
    const rng = new Random(81);
    const cx = W / 2;
    // Leaflets are filled slivers, not hairlines: an alpha-tested texture with thin strokes dissolves in the lower
    // mips and the palm turns into a cloud of speckles a few metres away.
    for (let i = 0; i < 20; i++) {
      const t = i / 20;
      const y = H - 10 - t * (H - 22);
      const len = (1 - t * 0.8) * 54 + 8;
      const drop = 24 + t * 8;
      const wid = 9 - t * 3.5;
      // Bright leaflets on purpose: around midday the sun is nearly overhead, so a near-vertical frond only gets sky
      // fill and a dark green albedo would come out black.
      const g = 156 + rng.int(0, 46);
      ctx.fillStyle = rgba(74 + rng.int(0, 30), g, 72 + rng.int(0, 22), 1);
      for (const dir of [-1, 1]) {
        const ex = cx + dir * len, ey = y - drop;
        ctx.beginPath();
        ctx.moveTo(cx, y + wid * 0.5);
        ctx.quadraticCurveTo(cx + dir * len * 0.55, y - drop * 0.15, ex, ey);
        ctx.quadraticCurveTo(cx + dir * len * 0.5, y - drop * 0.5 + wid, cx, y - wid * 0.5);
        ctx.closePath();
        ctx.fill();
      }
    }
    // Rachis, tapering to the tip.
    ctx.fillStyle = '#87a955';
    ctx.beginPath();
    ctx.moveTo(cx - 5, H);
    ctx.lineTo(cx + 5, H);
    ctx.lineTo(cx + 1.5, 4);
    ctx.lineTo(cx - 1.5, 4);
    ctx.closePath();
    ctx.fill();
    this.bleedAlpha(ctx, W, H, 6);
    return this.finish(key, canvas, true, false);
  }

  /** Roughness for the asphalt: the painted markings are smoother than the aggregate around them. */
  roadRough(): THREE.CanvasTexture {
    const key = 'road:rgh';
    const hit = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (hit) return hit;
    const src = this.road().image as HTMLCanvasElement | undefined;
    if (!src || !src.width) return this.finish(key, this.canvas(4, 4).canvas, false);
    return this.roughFromLuminance(key, src, 0.62, 1);
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

  /** Equirectangular star field (sampled by the sky dome shader): varied magnitudes plus a faint milky band. */
  starField(): THREE.CanvasTexture {
    const key = 'stars';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const W = 2048, H = 1024;
    const { canvas, ctx } = this.canvas(W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const rng = new Random(91);
    // Milky band across the upper hemisphere.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 900; i++) {
      const x = rng.range(0, W);
      const band = H * 0.24 + Math.sin((x / W) * Math.PI * 2) * H * 0.1;
      const y = band + rng.range(-1, 1) * rng.range(0, 1) * H * 0.09;
      if (y < 0 || y > H * 0.55) continue;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rng.range(10, 34));
      g.addColorStop(0, 'rgba(150,160,210,0.10)');
      g.addColorStop(1, 'rgba(120,130,190,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - 34, y - 34, 68, 68);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 2600; i++) {
      const b = rng.range(0.25, 0.8);
      ctx.fillStyle = rgba(255 * b, 255 * b, 255 * Math.min(1, b + 0.1), 1);
      ctx.fillRect(rng.range(0, W), rng.range(0, H * 0.55), 1, 1);
    }
    // A handful of bright stars with a cross flare.
    for (let i = 0; i < 90; i++) {
      const x = rng.range(0, W), y = rng.range(0, H * 0.52);
      const warm = rng.chance(0.3);
      ctx.fillStyle = warm ? 'rgba(255,225,190,1)' : 'rgba(220,236,255,1)';
      ctx.fillRect(x, y, 2, 2);
      ctx.fillStyle = warm ? 'rgba(255,225,190,0.4)' : 'rgba(220,236,255,0.4)';
      ctx.fillRect(x - 2, y, 6, 1);
      ctx.fillRect(x, y - 2, 1, 6);
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
