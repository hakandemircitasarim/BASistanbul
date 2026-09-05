// Procedural CanvasTexture factory (windows, road, sidewalk, sand, water, grass, plaza, neon atlas, fronds, glows, stars), cached by key. Track B.
import * as THREE from 'three';
import type { BuildingStyle } from '../city/CityData';
import { Random } from '../core/Random';

export interface WindowTextures { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture }
export interface AtlasRect { u0: number; v0: number; u1: number; v1: number }

/** Window tile: 256x512 px = 16 m x 28 m; the top ROOF_STRIP px (v > 0.98) are a plain wall color used by roofs and plain parts. */
export const WINDOW_TILE_W = 16;
export const WINDOW_TILE_H = 28;
export const ROOF_STRIP_PX = 10;
/** UV v of the plain strip center (used by roofs/landmark plain parts). */
export const ROOF_V = 1 - ROOF_STRIP_PX / 2 / 512;
/** UV u of a cell in the glow atlas (see glowAtlas()): cell 0 is non-emissive, cells 1-4 are night-glow colors. Glow parts use their own material. */
export const GLOW_U = { none: 0.1, magenta: 0.3, cyan: 0.5, yellow: 0.7, orange: 0.9 } as const;
const GLOW_CELLS: number[] = [0x000000, 0xff2d95, 0x00e5ff, 0xfff03b, 0xff7a00];
export const ROAD_TILE_M = 14;

function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
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

  private finish(key: string, canvas: HTMLCanvasElement, srgb: boolean, repeat = true): THREE.CanvasTexture {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 4;
    t.needsUpdate = true;
    this.cache.set(key, t);
    return t;
  }

  private noise(ctx: CanvasRenderingContext2D, w: number, h: number, rng: Random, count: number, size: number, alpha: number, light: boolean): void {
    for (let i = 0; i < count; i++) {
      const v = light ? 255 : 0;
      ctx.fillStyle = rgba(v, v, v, alpha * rng.next());
      ctx.fillRect(rng.range(0, w), rng.range(0, h), size, size);
    }
  }

  /** Albedo + emissive window tiles for a building style. 4 columns x 8 rows per 16 m x 28 m tile; ~35 % of windows lit (warm). */
  windows(style: BuildingStyle, seed = 1): WindowTextures {
    const key = `win:${style}:${seed}`;
    const mk = this.cache.get(key + ':map') as THREE.CanvasTexture | undefined;
    const ek = this.cache.get(key + ':emi') as THREE.CanvasTexture | undefined;
    if (mk && ek) return { map: mk, emissive: ek };
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
    // Per-style window shapes (fractions of a cell).
    let wx = 0.2, wy = 0.25, ww = 0.6, wh = 0.5;
    if (style === 'glass') { wx = 0.04; wy = 0.06; ww = 0.92; wh = 0.88; }
    else if (style === 'concrete') { wx = 0.28; wy = 0.3; ww = 0.44; wh = 0.42; }
    else if (style === 'artdeco') { wx = 0.3; wy = 0.15; ww = 0.4; wh = 0.68; }
    else if (style === 'neon') { wx = 0.14; wy = 0.22; ww = 0.72; wh = 0.5; }
    const glassDay = style === 'glass' ? '#4a6f96' : '#2e3a48';
    for (let r = 0; r < rows; r++) {
      const y0 = top + r * rh;
      const ground = r === rows - 1;
      if (style === 'artdeco' || style === 'residential') {
        m.ctx.fillStyle = rgba(0, 0, 0, 0.18);
        m.ctx.fillRect(0, y0 + rh - 3, W, 3);
      }
      if (style === 'neon') {
        m.ctx.fillStyle = rgba(255, 120, 200, 0.35);
        m.ctx.fillRect(0, y0 + rh - 5, W, 2);
      }
      for (let c = 0; c < cols; c++) {
        const x0 = c * cw;
        let gx = x0 + wx * cw, gy = y0 + wy * rh, gw = ww * cw, gh = wh * rh;
        if (ground && style !== 'glass') { gx = x0 + 0.1 * cw; gy = y0 + 0.12 * rh; gw = 0.8 * cw; gh = 0.86 * rh; }
        m.ctx.fillStyle = glassDay;
        m.ctx.fillRect(gx, gy, gw, gh);
        m.ctx.fillStyle = rgba(255, 255, 255, 0.18);
        m.ctx.fillRect(gx, gy, gw, gh * 0.3);
        if (style === 'glass') {
          m.ctx.fillStyle = rgba(20, 30, 40, 0.5);
          m.ctx.fillRect(gx + gw / 2 - 1, gy, 2, gh);
        } else if (style === 'residential' && !ground) {
          m.ctx.fillStyle = rgba(90, 80, 70, 0.9);
          m.ctx.fillRect(x0 + 0.1 * cw, y0 + rh * 0.78, cw * 0.8, 3);
        }
        const lit = ground ? rng.chance(0.7) : rng.chance(0.35);
        if (lit) {
          const warm = rng.chance(0.8);
          const rr = warm ? 255 : 190, gg = warm ? 205 + rng.int(0, 40) : 225, bb = warm ? 120 + rng.int(0, 60) : 255;
          e.ctx.fillStyle = rgba(rr, gg, bb, 0.92 + rng.next() * 0.08);
          e.ctx.fillRect(gx, gy, gw, gh);
          e.ctx.fillStyle = rgba(0, 0, 0, 0.25);
          if (rng.chance(0.5)) e.ctx.fillRect(gx, gy, gw * 0.5, gh);
        }
      }
    }
    // Plain strip at the top (v > 0.98): white in the albedo (vertex color shows exactly), black in the emissive.
    // The strip stays fully non-emissive: walls tile through it, so anything lit here would show up as bands on facades.
    m.ctx.fillStyle = '#ffffff';
    m.ctx.fillRect(0, 0, W, ROOF_STRIP_PX);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, ROOF_STRIP_PX);
    const map = this.finish(key + ':map', m.canvas, true);
    const emissive = this.finish(key + ':emi', e.canvas, true);
    return { map, emissive };
  }

  /** Emissive atlas for landmark neon parts: five 16 px cells (black, magenta, cyan, yellow, orange); sample the cell centers via GLOW_U. */
  glowAtlas(): THREE.Texture {
    const key = 'glowAtlas';
    const hit = this.cache.get(key);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = 80; c.height = 8;
    const ctx = c.getContext('2d');
    if (ctx) for (let i = 0; i < GLOW_CELLS.length; i++) { ctx.fillStyle = hex(GLOW_CELLS[i]); ctx.fillRect(i * 16, 0, 16, 8); }
    const t = this.finish(key, c, true, false);
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  /** Asphalt tile (ROAD_TILE_M x ROAD_TILE_M m): dashed white lane separators at +-3.5 m, double yellow center. u = across, v = along. */
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
    const px = S / ROAD_TILE_M;
    const cx = S / 2;
    ctx.fillStyle = '#e8c840';
    ctx.fillRect(cx - 0.35 * px, 0, 0.15 * px, S);
    ctx.fillRect(cx + 0.2 * px, 0, 0.15 * px, S);
    ctx.fillStyle = '#e6e6e0';
    for (let side = -1; side <= 1; side += 2) {
      const x = cx + side * 3.5 * px - 0.08 * px;
      for (let y = 0; y < S; y += 3 * px) ctx.fillRect(x, y, 0.16 * px, 1.5 * px);
    }
    return this.finish(key, canvas, true);
  }

  /** Intersection tile: asphalt with zebra crossings along all four edges. */
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
    const px = S / ROAD_TILE_M;
    const band = 2.4 * px, m = 0.6 * px, stripe = 0.6 * px, gap = 0.5 * px;
    ctx.fillStyle = '#e0e0da';
    for (let x = 1.4 * px; x < S - 1.4 * px; x += stripe + gap) {
      ctx.fillRect(x, m, stripe, band);
      ctx.fillRect(x, S - m - band, stripe, band);
      ctx.fillRect(m, x, band, stripe);
      ctx.fillRect(S - m - band, x, band, stripe);
    }
    return this.finish(key, canvas, true);
  }

  /** Concrete paving tile (4 m). */
  sidewalk(): THREE.CanvasTexture {
    const key = 'sidewalk';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const S = 256;
    const { canvas, ctx } = this.canvas(S, S);
    const rng = new Random(31);
    ctx.fillStyle = '#9b978f';
    ctx.fillRect(0, 0, S, S);
    this.noise(ctx, S, S, rng, 2500, 2, 0.16, false);
    this.noise(ctx, S, S, rng, 1500, 2, 0.14, true);
    ctx.fillStyle = rgba(0, 0, 0, 0.28);
    for (let i = 0; i < 2; i++) { ctx.fillRect(0, i * S / 2, S, 2); ctx.fillRect(i * S / 2, 0, 2, S); }
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
    for (let i = 0; i < 26; i++) {
      const t = i / 26;
      const y = H - 8 - t * (H - 16);
      const len = (1 - t * 0.85) * 52 + 6;
      const g = 120 + rng.int(0, 60);
      ctx.strokeStyle = rgba(40 + rng.int(0, 30), g, 40, 1);
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(W / 2, y);
      ctx.lineTo(W / 2 - len, y - 26 - t * 6);
      ctx.moveTo(W / 2, y);
      ctx.lineTo(W / 2 + len, y - 26 - t * 6);
      ctx.stroke();
    }
    ctx.strokeStyle = '#6b8c3a';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(W / 2, H);
    ctx.lineTo(W / 2, 4);
    ctx.stroke();
    const t = this.finish(key, canvas, true, false);
    return t;
  }

  /** Soft radial white glow (sprites, light pools, particles). */
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

  /** Equirectangular star field (sampled by the sky dome shader). */
  starField(): THREE.CanvasTexture {
    const key = 'stars';
    const c = this.cache.get(key) as THREE.CanvasTexture | undefined;
    if (c) return c;
    const W = 2048, H = 1024;
    const { canvas, ctx } = this.canvas(W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const rng = new Random(91);
    for (let i = 0; i < 2600; i++) {
      const b = rng.range(0.25, 0.8);
      const s = 1;
      ctx.fillStyle = rgba(255 * b, 255 * b, 255 * Math.min(1, b + 0.1), 1);
      ctx.fillRect(rng.range(0, W), rng.range(0, H * 0.55), s, s);
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
