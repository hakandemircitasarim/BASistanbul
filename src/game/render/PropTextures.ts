// Procedural textures owned by the street props: the leaf albedo of the solid foliage (tree crowns, cypresses, hedges
// and the far palm LOD). Kept out of TextureFactory, which serves the city shell. Track B.
import * as THREE from 'three';
import { Random } from '../core/Random';

/**
 * World size in metres one tile of the leaf texture covers. The crowns and hedges are UV-mapped in world metres
 * (see `leafSurface` in CityRendererProps), so this is the only knob for the leaf scale. At 1.6 m a 256 px tile is
 * 160 px/m, which puts the drawn leaves at 3-8 cm: real leaf size. Half this and the mass reads as fine speckle -
 * sandpaper, the one grain a stylised city must never have.
 */
export const LEAF_TILE_M = 1.6;

/**
 * Leaf albedo: a leaf-coloured multiplier over the vertex colours the foliage already bakes, so the species (broad
 * crown, cypress, hedge, far frond) keeps the hue ITS palette sets and this tile decides the value structure.
 *
 * It is NOT a near-white wash, and the difference matters when retuning the foliage palette: measured over the
 * 256 px tile the luma is mean 0.45, min 0.20, max 0.99 sRGB, 95 % of it under 0.72, with a green lean
 * (mean rgb 0.41 / 0.47 / 0.36). So every mapped surface reads about half the value its vertex colour states, and
 * FURN.crown / .hedge / .conifer are chosen against the tile, not against the shading alone. That is also why bark
 * must stay out of the mapped pass: FURN.bark through this tile is a moss-green column, not a brown trunk (the
 * foliage material masks it per vertex with `leafMix`, see Materials.leafMapMixPatch).
 *
 * Three layers, each seamless by drawing every mark a second time wrapped across the edges:
 *  1. a broad clump mottle (soft radial blobs, +-9 %), which is what breaks a flat-shaded mass at 5-15 m;
 *  2. individual leaves — short ellipses at random angles in three value bands, the light ones carrying a warm lean
 *     and the dark ones a cool one, which is what breaks it at 1-3 m;
 *  3. a fine pepper of dark gaps between leaves, so the mass never looks airbrushed.
 *
 * Band values (before the +-14 % per-leaf jitter): the ground is 0.73, the three leaf bands 0.91 / 0.65 / 0.38, each
 * over a 0.55-alpha 0.20 halo, and the gap pepper darker still. Keep the lightest band under ~0.95: a leaf that
 * reaches 1.0 makes the lit top of a crown blow out past the sky, and the dark band is what separates the blades.
 */
export function leafTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const rng = new Random(0x1eaf);
  ctx.fillStyle = '#b9bfb4';
  ctx.fillRect(0, 0, S, S);
  // Wrapped draw: every mark is stamped in the 3x3 neighbourhood that can reach the tile, so the texture tiles.
  const wrapped = (x: number, y: number, r: number, draw: (px: number, py: number) => void): void => {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const px = x + ox * S, py = y + oy * S;
        if (px + r < 0 || px - r > S || py + r < 0 || py - r > S) continue;
        draw(px, py);
      }
    }
  };
  // 1. Clump mottle.
  for (let i = 0; i < 90; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(20, 72);
    const v = rng.range(-0.09, 0.09);
    wrapped(x, y, r, (px, py) => {
      const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
      const a = Math.abs(v);
      grad.addColorStop(0, v > 0 ? `rgba(255,255,240,${a})` : `rgba(20,34,16,${a})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  // 2. Leaves: three value bands, drawn light-to-dark so the dark ones sit on top and separate the light mass into
  // individual blades. Each leaf is opaque over a slightly larger dark ellipse, i.e. it carries its own shadow edge:
  // translucent overlapping ellipses just average back into the mottle and the mass came out looking like marble.
  const bands = [
    { n: 560, rgb: [224, 236, 198] },
    { n: 560, rgb: [156, 172, 138] },
    { n: 420, rgb: [86, 106, 78] },
  ];
  for (let b = 0; b < bands.length; b++) {
    const band = bands[b];
    for (let i = 0; i < band.n; i++) {
      const x = rng.range(0, S), y = rng.range(0, S);
      const rx = rng.range(5, 12), ry = rx * rng.range(0.34, 0.6);
      const rot = rng.range(0, Math.PI);
      const j = rng.range(0.86, 1.14);
      const face = `rgb(${Math.round(band.rgb[0] * j)},${Math.round(band.rgb[1] * j)},${Math.round(band.rgb[2] * j)})`;
      wrapped(x, y, rx + 2, (px, py) => {
        ctx.fillStyle = 'rgba(44,58,38,0.55)';
        ctx.beginPath();
        ctx.ellipse(px, py + 0.9, rx + 1.1, ry + 1.1, rot, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = face;
        ctx.beginPath();
        ctx.ellipse(px, py, rx, ry, rot, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }
  // 3. Gaps between the leaves.
  for (let i = 0; i < 700; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(1.2, 3.2);
    ctx.fillStyle = `rgba(38,52,32,${rng.range(0.25, 0.55)})`;
    wrapped(x, y, r + 1, (px, py) => {
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
