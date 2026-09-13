// Player character: one skinned mesh (11 bones) sculpted from lathe tubes, an ellipsoid head with a face and a wrapped
// hair cap. Knees and elbows bend in the walk cycle, the torso breathes and the hips sway. Also exports the sculpting
// helpers PedRenderer builds its instanced crowd from. Track C.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { World } from '../world/World';
import type { Transform } from '../core/Types';
import { createTransform, lerpTransform } from '../core/Transform';
import { clamp, damp, smoothstep } from '../core/math';
import { DAY_TUNING } from '../systems/DayNightSystem';
import { ContactShadows, groundYAt } from './ContactShadows';

const SHIRT = 0xff7a00;
const COLLAR = 0xd95f00;
const SLEEVE = 0xf07000;
const JEANS = 0x2a4d9c;
const BELT = 0x1d2a45;
const SKIN = 0xe3b48f;
const HAIR = 0x2a1d17;
const EYE = 0x1a1410;
const SHOE = 0x1b1b20;
/** Rubber sole under the dark upper, and the belt buckle. */
const SOLE = 0x4a4a52;
const BUCKLE = 0xb9a05c;
/**
 * Contact blob half-width. Bigger than it looks it should be (a 1.4 m ellipse under a 1.8 m figure), because the shared
 * blob texture is only opaque inside `SHADOW_TUNING.core` = 34 % of its radius and fades to nothing at the rim: at the
 * geometrically "correct" 0.56 the whole opaque core hid under the figure's own footprint and the blob read as nothing
 * at all (measured: no change in the pavement pixels under the player at noon). At 0.7 the core is a 48 cm puddle that
 * shows around the shoes, which is what grounds the figure - especially at night, when there is no sun shadow at all.
 */
const SHADOW_R = 0.7;
const SHADOW_LIFT = 0.03;
/** Contact blob shape: `NARROW` of the old radius across the light direction, up to `STRETCH_MAX` along it. */
const SHADOW_NARROW = 1.0;
const SHADOW_STRETCH_MAX = 2.4;
/** How far along the light direction the blob's centre is pushed, as a fraction of (length - width). */
const SHADOW_ANCHOR = 0.5;
const SHADOW_ELEV_FLOOR = 0.26;
/** Second tone break in each garment (see `playerGeometry`): lit chest yoke, shaded back, lit thigh front, knee crease. */
const SHIRT_YOKE = 1.13;
const SHIRT_BACK = 0.88;
const JEANS_FRONT = 1.08;
const JEANS_CREASE = 0.12;
/** Resting elbow angle ACROSS the body (radians): the forearms close back in under the shoulders' outward set. */
const ELBOW_IN = 0.14;

// ---------------------------------------------------------------------------------------------------------------------
// Shared sculpting helpers (also used by PedRenderer). All builders return non-indexed geometry with position, normal
// and color attributes only, so any mix of them merges into one draw call.
// ---------------------------------------------------------------------------------------------------------------------

/** One cross-section of a lathe tube: elliptical radii and an optional centre offset. Listed bottom to top. */
export interface Ring { y: number; rx: number; rz: number; x?: number; z?: number }

const scratchColor = new THREE.Color();
const scratchV = new THREE.Vector3();

/**
 * Smooth-shaded parametric sheet: `rows` x `cols` samples, columns closed around the axis when `wrap` is set.
 * `flip` reverses the winding for sheets whose rows run the other way (a cap sampled pole-down, a lid seen from above).
 */
export function surface(rows: number, cols: number, wrap: boolean, flip: boolean,
  fn: (i: number, j: number, out: THREE.Vector3) => void): THREE.BufferGeometry {
  const v = scratchV;
  const pos = new Float32Array(rows * cols * 3);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      fn(i, j, v);
      const k = (i * cols + j) * 3;
      pos[k] = v.x; pos[k + 1] = v.y; pos[k + 2] = v.z;
    }
  }
  const idx: number[] = [];
  const span = wrap ? cols : cols - 1;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < span; j++) {
      const a = i * cols + j, b = i * cols + ((j + 1) % cols), c = a + cols, d = b + cols;
      if (flip) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const out = g.toNonIndexed();
  g.dispose();
  return out;
}

function disc(r: Ring, radial: number, up: boolean): THREE.BufferGeometry {
  return surface(2, radial, true, up, (i, j, out) => {
    const a = (j / radial) * Math.PI * 2;
    const k = i === 0 ? 0 : 1;
    out.set((r.x ?? 0) + r.rx * Math.sin(a) * k, r.y, (r.z ?? 0) + r.rz * Math.cos(a) * k);
  });
}

/** Lathe tube through `rings` (bottom to top) with optional flat lids; smooth normals so it reads as a rounded limb. */
export function tube(rings: Ring[], radial: number, capTop: boolean, capBot: boolean): THREE.BufferGeometry {
  const side = surface(rings.length, radial, true, false, (i, j, out) => {
    const r = rings[i], a = (j / radial) * Math.PI * 2;
    out.set((r.x ?? 0) + r.rx * Math.sin(a), r.y, (r.z ?? 0) + r.rz * Math.cos(a));
  });
  if (!capTop && !capBot) return side;
  const parts = [side];
  if (capTop) parts.push(disc(rings[rings.length - 1], radial, true));
  if (capBot) parts.push(disc(rings[0], radial, false));
  return fuseBare(parts);
}

/** Ellipsoid skull: a sphere pulled in below the centre line so the jaw is narrower than the brow. */
export function skull(cy: number, rx: number, ry: number, rz: number, segs: number, rings: number, jawK: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, segs, rings);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = 1 - (1 - jawK) * Math.max(0, -y);
    pos.setXYZ(i, pos.getX(i) * k * rx, cy + y * ry, pos.getZ(i) * k * rz);
  }
  g.computeVertexNormals();
  const out = g.toNonIndexed();
  g.dispose();
  out.deleteAttribute('uv');
  return out;
}

/** Depth of the skull surface at (x, y): where eyes, brows and the nose sit so they are proud of the face. */
export function faceZ(x: number, y: number, cy: number, rx: number, ry: number, rz: number, jawK: number): number {
  const ny = (y - cy) / ry;
  const k = 1 - (1 - jawK) * Math.max(0, -ny);
  const t = 1 - (x / (rx * k)) * (x / (rx * k)) - ny * ny;
  return rz * k * Math.sqrt(Math.max(0, t));
}

/**
 * Hair cap wrapped over an ellipsoid: polar extent varies with azimuth (short over the brow = fringe, long at the nape)
 * and a lip ring tucks the edge in toward the skull so the fringe reads as a thick layer, not a paper edge.
 */
export function hairCap(cy: number, rx: number, ry: number, rz: number, segs: number, rows: number, front: number, side: number, back: number, lip: number, scallop = 0): THREE.BufferGeometry {
  return surface(rows + (lip > 0 ? 1 : 0), segs, true, true, (i, j, out) => {
    const a = (j / segs) * Math.PI * 2;
    const f = (1 - Math.cos(a)) * 0.5;
    let max = f < 0.5 ? front + (side - front) * (f * 2) : side + (back - side) * ((f - 0.5) * 2);
    // Scalloped edge: the hairline is not a drawn arc. Three locks over the brow (cos 3a, strongest at the front) and
    // a lifted neckline at the nape (the negative lobe of the same term where f is high) turn the smooth cap the last
    // critic called a helmet into a fringe with a parting and a hairline the neck comes out of.
    if (scallop > 0) max *= 1 + scallop * (Math.cos(a * 3) * (1 - f * 0.55) - 0.35 * Math.max(0, f - 0.72) / 0.28);
    const isLip = i >= rows;
    const th = isLip ? max + lip : (max * i) / (rows - 1);
    const k = isLip ? 0.965 : 1;
    out.set(rx * k * Math.sin(th) * Math.sin(a), cy + ry * k * Math.cos(th), rz * k * Math.sin(th) * Math.cos(a));
  });
}

/** Non-indexed box without uvs (eyes, brows, straps). */
export function block(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const out = g.toNonIndexed();
  g.dispose();
  out.deleteAttribute('uv');
  return out;
}

/** Bevelled box (shoes, bag) without uvs. */
export function rounded(w: number, h: number, d: number, r: number, segs = 2): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, segs, r);
  g.deleteAttribute('uv');
  return g;
}

/**
 * Shoe as a rounded loaf: elliptical cross-sections from heel to toe (a tall heel, the widest section at the ball of
 * the foot, closing down to the toe), flat-ish sole, no box edges. Origin at the ankle on the sole, toe toward +z;
 * `s` scales the figure and `lean` shifts it across to follow the shin (legRings leans the shins inward).
 *
 * Five sections and a 10 cm heel, because the old four-section 7 cm one disappeared behind the calf from the angle
 * the player is actually seen from: the leg ended in a blue tube with a dark spike under it instead of a foot.
 * About 96 triangles a foot at radial 8.
 */
export function shoe(s: number, radial: number, lean = 0): THREE.BufferGeometry {
  const sec = [
    { z: -0.10, rx: 0.054, ry: 0.052 }, { z: -0.05, rx: 0.066, ry: 0.058 }, { z: 0.03, rx: 0.072, ry: 0.052 },
    { z: 0.12, rx: 0.066, ry: 0.036 }, { z: 0.19, rx: 0.046, ry: 0.020 },
  ];
  const at = (c: { z: number; rx: number; ry: number }, a: number, q: number, out: THREE.Vector3): void => {
    // Sole plate: the cross-section is flared toward the bottom of the ellipse (SOLE_FLARE on cos a) and the bottom
    // 1.4 cm is pushed down flat, so the foot ends in a plate 13-19 cm across against a 9 cm ankle instead of the
    // rounded wedge narrower than the shin that the last critic measured. `shoeSole` paints that band lighter.
    const c0 = Math.max(0, Math.cos(a));
    const flare = 1 + SOLE_FLARE * c0 * c0;
    const y = c.ry * s * (1 - Math.cos(a) * q) * 0.98;
    out.set(lean * s + c.rx * s * Math.sin(a) * q * flare, Math.max(y, y * (1 - c0 * 0.55)), (c.z + 0.02) * s);
  };
  const side = surface(sec.length, radial, true, false, (i, j, out) => at(sec[i], ((j + 0.5) / radial) * Math.PI * 2, 1, out));
  const cap = (k: number, flip: boolean): THREE.BufferGeometry => surface(2, radial, true, flip, (i, j, out) => at(sec[k], ((j + 0.5) / radial) * Math.PI * 2, i === 0 ? 0 : 1, out));
  return fuseBare([side, cap(0, false), cap(sec.length - 1, true)]);
}

/** How far the shoe's cross-section flares at the sole line: a 34 % wider plate than the upper it carries. */
const SOLE_FLARE = 0.34;
/** Height (in figure units, before `s`) up to which a shoe vertex belongs to the rubber sole rather than the upper. */
export const SOLE_H = 0.016;

/**
 * Shoe colours: a lighter rubber sole under a dark upper. The value break along the sole line is what makes the plate
 * read as a sole at 2 m rather than as the bottom of one dark lump, and it grounds the figure: the lightest part of
 * the shoe is the bit that touches the pavement.
 */
export function paintShoe(g: THREE.BufferGeometry, s: number, upper: number, sole: number): THREE.BufferGeometry {
  return paintFn(g, (_x, y, _z, out) => out.setHex(y <= SOLE_H * s ? sole : upper));
}

/** Four-sided pyramid pointing along +z and tilted down by `tilt`: the nose. */
export function nose(r: number, len: number, tilt: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, len, 4);
  g.rotateY(Math.PI / 4);
  g.rotateX(Math.PI / 2 + tilt);
  const out = g.toNonIndexed();
  g.dispose();
  out.deleteAttribute('uv');
  return out;
}

/** Small ellipsoid (ears). */
export function blob(rx: number, ry: number, rz: number, segs = 6, rings = 5): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, segs, rings);
  g.scale(rx, ry, rz);
  const out = g.toNonIndexed();
  g.dispose();
  out.deleteAttribute('uv');
  return out;
}

/** Writes a colour per vertex from a callback (gradients, bands). */
export function paintFn(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number, out: THREE.Color) => void): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    fn(pos.getX(i), pos.getY(i), pos.getZ(i), scratchColor);
    c[i * 3] = scratchColor.r; c[i * 3 + 1] = scratchColor.g; c[i * 3 + 2] = scratchColor.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Paints a whole part one colour. */
export function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  return paintFn(g, (_x, _y, _z, out) => out.setHex(hex));
}

/** Adds a constant single-float attribute (variant masks, colour-mode flags). */
export function fillAttr(g: THREE.BufferGeometry, name: string, value: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const a = new Float32Array(n);
  a.fill(value);
  g.setAttribute(name, new THREE.BufferAttribute(a, 1));
  return g;
}

/**
 * Rotates everything below `pivotY` about the x axis through (0, pivotY, 0), blending in over `blend` metres so a
 * tube bends at a joint instead of snapping. Used to pre-bend pedestrian knees and elbows in geometry.
 */
export function bendBelow(g: THREE.BufferGeometry, pivotY: number, angle: number, blend: number): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y >= pivotY + blend) continue;
    const t = clamp((pivotY + blend - y) / (blend * 2), 0, 1);
    const th = angle * t, c = Math.cos(th), s = Math.sin(th);
    const dy = y - pivotY, dz = pos.getZ(i);
    pos.setY(i, pivotY + dy * c - dz * s);
    pos.setZ(i, dy * s + dz * c);
    const ny = nor.getY(i), nz = nor.getZ(i);
    nor.setY(i, ny * c - nz * s);
    nor.setZ(i, ny * s + nz * c);
  }
  return g;
}

function fuseBare(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('character geometry merge failed (attribute mismatch)');
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  return merged;
}

/** Merges finished (painted, attributed) parts into one geometry. */
export function fuse(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return fuseBare(parts);
}

/** Interpolates the ring radii of a tube at height y (for props that have to hug the torso). */
export function ringAt(rings: Ring[], y: number, out: Ring): Ring {
  if (y <= rings[0].y) { Object.assign(out, rings[0]); return out; }
  for (let i = 1; i < rings.length; i++) {
    const a = rings[i - 1], b = rings[i];
    if (y <= b.y) {
      const t = (y - a.y) / Math.max(1e-6, b.y - a.y);
      out.y = y; out.rx = a.rx + (b.rx - a.rx) * t; out.rz = a.rz + (b.rz - a.rz) * t;
      out.x = (a.x ?? 0) + ((b.x ?? 0) - (a.x ?? 0)) * t; out.z = (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * t;
      return out;
    }
  }
  Object.assign(out, rings[rings.length - 1]);
  return out;
}

/**
 * Body profiles in metres from the ground for a 1.8 m figure, scaled by `s`. The torso is a barrel (widest at the chest,
 * narrower at waist and neck) that ends in a trapezius slope; limbs swell at the deltoid/thigh/calf and pinch at wrist
 * and ankle. Rings closer than 5 mm double up so colour bands (belt, hem, sleeve cuff) stay crisp.
 */
export const PROFILE = {
  hipY: 0.86, crotchY: 0.74, kneeY: 0.47, shoulderY: 1.40, shoulderX: 0.222, elbowY: 1.14, neckY: 1.50,
  headCY: 1.665, headRX: 0.113, headRY: 0.135, headRZ: 0.123, jawK: 0.8,
  // Hip half separation. At 0.11 the two thighs (rx 0.098 at the top) left 2.4 cm between them, which at any distance
  // past a couple of metres closes up: the figure read as one blue column with a seam down it. 0.124 opens a real
  // 5 cm gap at the thigh, and legRings leans the shins back inward so the stance stays narrow at the ankle.
  hipX: 0.124,
  beltLo: 0.86, beltHi: 0.90, collarY: 1.44, sleeveY: 1.253,
} as const;

function scaled(rings: Ring[], s: number): Ring[] {
  return rings.map((r) => ({ y: r.y * s, rx: r.rx * s, rz: r.rz * s, x: (r.x ?? 0) * s, z: (r.z ?? 0) * s }));
}

export function torsoRings(s: number): Ring[] {
  return scaled([
    // The two rings below the belt stay INSIDE the thigh tubes (legRings tops at 0.098 x 0.112 about x = +-0.124, i.e.
    // a back surface at z = 0.112): at the old 0.115 / 0.125 the torso's own seat poked a hard-edged lighter panel out
    // through the back of the trousers. The legs model the hips; the torso only has to reach them.
    // The crotch tapers down BETWEEN the thighs to 0.66 and closes there, so its end cap and the value step at it are
    // behind the legs from every angle the character is seen from instead of being a hard-edged panel on the seat.
    { y: 0.66, rx: 0.112, rz: 0.074 },
    { y: 0.71, rx: 0.136, rz: 0.088 },
    { y: 0.74, rx: 0.150, rz: 0.098 },
    { y: 0.80, rx: 0.172, rz: 0.108 },
    { y: 0.858, rx: 0.19, rz: 0.124 },
    // Belt: 1.5 cm proud of the trousers below it and the shirt above, so the waist line is a step in the SILHOUETTE
    // and not just a dark band painted on a straight tube (round 8's belt was 8 mm and invisible past 3 m).
    { y: 0.862, rx: 0.205, rz: 0.145 },
    { y: 0.90, rx: 0.205, rz: 0.145 },
    // Shirt hem, also proud: the shirt hangs OVER the belt and breaks the torso in two at the waist.
    { y: 0.906, rx: 0.196, rz: 0.137 },
    { y: 0.925, rx: 0.191, rz: 0.131 },
    // Waist: 15 % narrower than the hip and 27 % narrower than the chest. At round 8's 0.185 against a 0.198 hip the
    // lower torso was a straight column: no waist meant no figure, whatever the shading did.
    { y: 1.00, rx: 0.168, rz: 0.112 },
    { y: 1.09, rx: 0.192, rz: 0.130 },
    { y: 1.20, rx: 0.215, rz: 0.142, z: 0.006 },
    { y: 1.30, rx: 0.23, rz: 0.138 },
    { y: 1.385, rx: 0.25, rz: 0.13, z: -0.006 },
    { y: 1.425, rx: 0.212, rz: 0.114 },
    { y: 1.442, rx: 0.132, rz: 0.092 },
    // Collar: a short stand of two proud rings (0.118 over the 0.104 band above it) around the neck tube, so the
    // shirt ends in a rim the head sits inside instead of closing smoothly onto the neck like a bottle.
    { y: 1.447, rx: 0.118, rz: 0.100 },
    { y: 1.470, rx: 0.113, rz: 0.096 },
    { y: 1.474, rx: 0.092, rz: 0.079 },
    // The collar closes 4 cm lower than it used to (1.49 instead of 1.50): the jaw sits at ~1.53, so the old shirt
    // left 3 cm of neck and the head read as bolted straight onto the shoulders. Six centimetres is a neck.
    { y: 1.49, rx: 0.082, rz: 0.071 },
  ], s);
}

/**
 * Arm hanging straight down, centred on x = 0 (translate to the shoulder); the sleeve ends just above the elbow.
 * `side` is the sign of the shoulder x the arm goes to: the deltoid leans inward and the top ring sits inside the
 * torso's trapezius slope, so the sleeve top is buried in the shoulder instead of standing proud of it.
 * The forearm swells at the belly just under the elbow and closes to a 3 cm wrist — the old arm ran at a near
 * constant 4.5 cm from elbow to hand, which is the straight tube with a blob on the end the critic saw.
 */
export function armRings(s: number, side = 1): Ring[] {
  const inw = -side;
  return scaled([
    { y: 0.79, rx: 0.029, rz: 0.022 },
    { y: 0.86, rx: 0.036, rz: 0.029 },
    { y: 0.94, rx: 0.044, rz: 0.038 },
    { y: 1.00, rx: 0.050, rz: 0.045 },
    { y: 1.06, rx: 0.051, rz: 0.048 },
    { y: 1.14, rx: 0.05, rz: 0.05 },
    { y: 1.25, rx: 0.052, rz: 0.05 },
    { y: 1.255, rx: 0.06, rz: 0.058 },
    { y: 1.33, rx: 0.068, rz: 0.066, x: inw * 0.004 },
    { y: 1.37, rx: 0.066, rz: 0.064, x: inw * 0.016 },
    { y: 1.40, rx: 0.05, rz: 0.05, x: inw * 0.04 },
  ], s);
}

/**
 * Mitten hand hanging from the wrist ring: a flattened ellipsoid (thin across x, long down, palm facing the thigh)
 * with a thumb bud on the inner side. Origin at the wrist (0, 0.79, 0) of an arm going to shoulder side `side`.
 */
export function hand(s: number, side: number, segs: number, rings: number): THREE.BufferGeometry {
  const wrist = 0.79 * s;
  // A hand hanging at the side is a flat paddle: thin across the body (x), wide front to back (z), and it must be
  // WIDER than the wrist it hangs off or it reads as the rounded stub the critic saw. The wrist ring is 0.029 x 0.022,
  // so the palm at 0.034 x 0.062 is a little thicker and nearly three times as deep - a mitten with a visible step at
  // the cuff. The thumb bud stands out of the leading edge, which is what tells the eye which way the hand faces.
  const palm = blob(0.034 * s, 0.062 * s, 0.062 * s, segs, rings);
  palm.rotateY(side * 0.22);
  palm.translate(-side * 0.004 * s, wrist - 0.046 * s, 0.010 * s);
  // Finger mass: a second, narrower lobe hanging off the palm and curled a little forward. Without it the hand ended
  // at the palm and the arm read as a tube with a bud on it - the "rounded stub" of the critic's list. Twelve
  // triangles a hand at the crowd's tessellation, twenty-four at the player's.
  const fingers = blob(0.030 * s, 0.040 * s, 0.046 * s, Math.max(4, segs - 2), Math.max(3, rings - 2));
  fingers.rotateX(-0.30);
  fingers.rotateY(side * 0.22);
  fingers.translate(-side * 0.006 * s, wrist - 0.106 * s, 0.020 * s);
  const thumb = blob(0.016 * s, 0.032 * s, 0.018 * s, Math.max(4, segs - 2), Math.max(3, rings - 2));
  thumb.rotateZ(-side * 0.55);
  thumb.translate(-side * 0.032 * s, wrist - 0.032 * s, 0.040 * s);
  return fuseBare([palm, fingers, thumb]);
}

/** Everything below this (in figure units, before `s`) is the hand rather than the forearm; see `HAND_TONE`. */
export const HAND_Y = 0.77;
/**
 * The hand is painted a touch deeper and warmer than the forearm above it. Two masses the same flat skin value read as
 * one tube however well they are sculpted; a 12 % value break at the wrist is what makes the hand a separate object at
 * the six to ten metres the player is actually seen from.
 */
export const HAND_TONE = 0.88;

/**
 * Ambient-occlusion bake for a standing figure scaled by `s`: multiplies existing vertex colours down in the crevices
 * a real body shades itself in — under the armpits, between the thighs, under the chin, inside the collar and along
 * the hair line. Positions are in figure space (feet at y = 0, facing +z), so call it before a part is re-pivoted.
 */
export function bakeAO(g: THREE.BufferGeometry, s: number): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = g.attributes.color as THREE.BufferAttribute;
  const P = PROFILE;
  const cy = P.headCY * s, rx = P.headRX * s, ry = P.headRY * s, rz = P.headRZ * s;
  const pocket = (x: number, y: number, z: number, px: number, py: number, pz: number, r: number, k: number): number => {
    const dx = x - px, dy = y - py, dz = z - pz;
    return 1 - k * (1 - smoothstep(0, r, Math.sqrt(dx * dx + dy * dy + dz * dz)));
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let ao = 1;
    ao *= pocket(x, y, z, -0.215 * s, 1.33 * s, 0, 0.11 * s, 0.24); // armpits
    ao *= pocket(x, y, z, 0.215 * s, 1.33 * s, 0, 0.11 * s, 0.24);
    ao *= pocket(x, y, z, 0, 0.76 * s, 0, 0.17 * s, 0.30); // between the thighs (wider now that the legs are apart)
    ao *= pocket(x, y, z, 0, 1.51 * s, 0.02 * s, 0.1 * s, 0.22); // under the chin
    ao *= 1 - 0.14 * smoothstep(1.44 * s, 1.5 * s, y) * (1 - smoothstep(1.52 * s, 1.58 * s, y)); // inside the collar
    // Hair line: skin just below the cap edge (fringe over the brow, deeper at the temples and the nape).
    const nx = x / rx, ny = (y - cy) / ry, nz = z / rz;
    const rr = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (rr > 0.9 && rr < 1.06 && Math.abs(y - cy) < ry * 1.2) {
      const a = Math.atan2(nx, nz), f = (1 - Math.cos(a)) * 0.5;
      const edge = f < 0.5 ? HAIR_FRONT * 0.95 + (1.7 - HAIR_FRONT * 0.95) * (f * 2) : 1.7 + 0.55 * ((f - 0.5) * 2);
      const th = Math.acos(clamp(ny / Math.max(1e-6, rr), -1, 1));
      ao *= 1 - 0.18 * (1 - smoothstep(edge - 0.02, edge + 0.32, th));
    }
    if (ao < 1) col.setXYZ(i, col.getX(i) * ao, col.getY(i) * ao, col.getZ(i) * ao);
  }
  return g;
}

/**
 * Leg centred on x = 0 (translate to the hip by `side` * PROFILE.hipX): thigh, knee pinch, calf swell, ankle. The
 * shin leans back in toward the centre line (`inw`), so the wider hips open a gap at the thigh without splaying the
 * feet: a stance, not a compass. The ankle ends at 0.10 rather than 0.07, where the shoe now takes over.
 */
export function legRings(s: number, side = 1): Ring[] {
  const inw = -side;
  return scaled([
    { y: 0.10, rx: 0.045, rz: 0.052, x: inw * 0.020 },
    { y: 0.16, rx: 0.050, rz: 0.056, x: inw * 0.019 },
    { y: 0.28, rx: 0.066, rz: 0.076, x: inw * 0.017 },
    { y: 0.40, rx: 0.074, rz: 0.086, x: inw * 0.015 },
    { y: 0.47, rx: 0.072, rz: 0.080, x: inw * 0.013 },
    { y: 0.54, rx: 0.078, rz: 0.088, x: inw * 0.011 },
    { y: 0.66, rx: 0.090, rz: 0.102, x: inw * 0.007 },
    { y: 0.78, rx: 0.098, rz: 0.112, x: inw * 0.002 },
    { y: 0.87, rx: 0.098, rz: 0.108 },
  ], s);
}

/**
 * Neck: a short column from inside the collar (1.425, under the shirt's new top ring) up into the skull, pinched at
 * the throat and flaring into the trapezius at the base, so the six centimetres of it that now show below the jaw
 * read as a neck and not as a peg.
 */
export function neckRings(s: number): Ring[] {
  return scaled([
    { y: 1.425, rx: 0.080, rz: 0.074 }, { y: 1.47, rx: 0.062, rz: 0.059 },
    { y: 1.53, rx: 0.057, rz: 0.055 }, { y: 1.6, rx: 0.064, rz: 0.062 },
  ], s);
}

export type HeadRole = 'skin' | 'hair' | 'eye' | 'brow';

/** Head parts for a figure scaled by `s`: skull, ears, nose (skin); eyes; brows; hair cap. Colouring is the caller's. */
export function headParts(s: number, segs: number, rings: number, hairRows: number, emit: (role: HeadRole, g: THREE.BufferGeometry) => void): void {
  const P = PROFILE;
  const cy = P.headCY * s, rx = P.headRX * s, ry = P.headRY * s, rz = P.headRZ * s, jaw = P.jawK;
  emit('skin', skull(cy, rx, ry, rz, segs, rings, jaw));
  // Ears.
  for (const side of [-1, 1]) {
    const ear = blob(rx * 0.16, ry * 0.24, rz * 0.18, segs > 12 ? 6 : 4, segs > 12 ? 5 : 3);
    ear.translate(side * rx * 0.97, cy - ry * 0.02, -rz * 0.05);
    emit('skin', ear);
  }
  // Nose: pyramid on the centre line, tip tilted down.
  const ns = nose(rx * 0.15, rz * 0.34, 0.45);
  const nz = faceZ(0, cy - ry * 0.06, cy, rx, ry, rz, jaw);
  ns.translate(0, cy - ry * 0.08, nz + rz * 0.06);
  emit('skin', ns);
  // Eyes: dark blocks set just proud of the face so the head has an unmistakable front. They sit at `EYE_Y`, a third
  // of a head radius LOWER than they used to: with the eyes at 0.12 and the brows at 0.30 the whole face furniture
  // stood inside the fringe (the cap's lowest scalloped point was 0.23), so at any distance the eyes merged into the
  // hair mass and what was left below was a blank oval — the mannequin the last critic read.
  for (const side of [-1, 1]) {
    const ex = side * rx * 0.38, ey = cy + ry * EYE_Y;
    const eye = block(rx * 0.27, ry * 0.15, rz * 0.14);
    eye.translate(ex, ey, faceZ(ex, ey, cy, rx, ry, rz, jaw) - rz * 0.04);
    emit('eye', eye);
    const by = cy + ry * BROW_Y, bx = side * rx * 0.4;
    const brow = block(rx * 0.36, ry * 0.08, rz * 0.12);
    brow.rotateZ(side * 0.18);
    brow.translate(bx, by, faceZ(bx, by, cy, rx, ry, rz, jaw) - rz * 0.05);
    emit('brow', brow);
  }
  // Mouth: one flat block on the centre line under the nose, a hair proud of the jaw. Twelve triangles, and it is the
  // difference between a head with a front and a head with two dots on it.
  const my = cy - ry * 0.42;
  const mouth = block(rx * 0.30, ry * 0.055, rz * 0.10);
  mouth.translate(0, my, faceZ(0, my, cy, rx, ry, rz, jaw) - rz * 0.045);
  emit('brow', mouth);
  // Hair: the fringe stops at HAIR_FRONT (a real forehead above the brows) and the nape keeps its long edge.
  emit('hair', hairCap(cy + ry * 0.02, rx * 1.075 + 0.003, ry * 1.09, rz * 1.075 + 0.003, segs, hairRows, HAIR_FRONT, 1.76, 2.06, 0.15, 0.17));
}

/** Face furniture heights, in head radii about the skull centre: eyes, brows and the front hairline (polar, radians). */
const EYE_Y = 0.02;
const BROW_Y = 0.20;
const HAIR_FRONT = 1.0;

/**
 * Lifts the crown of a hair cap and sinks its underside, multiplying whatever colour the caller painted it.
 *
 * A hair cap painted ONE value is a block of black plastic on top of the head — the "solid block cap" of the critic's
 * list — because the two things that make hair read are a lit crown and a dark mass at the nape and behind the ears.
 * One multiply per vertex, no triangles.
 */
export function hairShade(g: THREE.BufferGeometry, cy: number, ry: number): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = g.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = clamp((pos.getY(i) - cy) / Math.max(1e-4, ry * 1.3), -1, 1);
    // Crown up to 1.34, nape and the tuck behind the ears down to 0.62, with the break at the ear line.
    const k = t > 0 ? 1 + 0.34 * t * t : 1 - 0.38 * t * t;
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  return g;
}

/**
 * Ground direction and length of a character's contact blob, driven by the scene's own shadow-casting light.
 *
 * The blob used to be a circle centred under the figure: it pointed nowhere, so it read as a detached disc lying
 * beside the feet rather than as a shadow, and it disagreed with every cast shadow in the frame. Reading the scene's
 * DirectionalLight (rather than re-deriving the sun path here) keeps the blobs and the shadow map in agreement for
 * free, and follows SkySystem's swap to moon shadows after dark.
 */
export interface GroundShadow {
  /** Unit ground direction the light casts toward. */
  dirX: number; dirZ: number;
  /** Blob length along that direction as a multiple of its half-width. */
  stretch: number;
  light: THREE.DirectionalLight | null;
}

export function makeGroundShadow(): GroundShadow {
  return { dirX: 0, dirZ: 1, stretch: 1, light: null };
}

/** Refreshes `g` from the scene's shadow light. Allocation-free after the first lookup; call once a frame. */
export function updateGroundShadow(g: GroundShadow, scene: THREE.Scene, minStretch: number, maxStretch: number, elevFloor: number): void {
  if (!g.light || !g.light.parent) {
    let found: THREE.DirectionalLight | null = null;
    scene.traverse((o) => {
      if (!found && o instanceof THREE.DirectionalLight) found = o;
    });
    g.light = found;
  }
  const l = g.light;
  if (!l) return;
  // The direction the light travels, flattened onto the ground, and its elevation as a slope.
  const dx = l.target.position.x - l.position.x, dz = l.target.position.z - l.position.z;
  const dy = l.position.y - l.target.position.y;
  const len = Math.hypot(dx, dz);
  if (len > 1e-4) { g.dirX = dx / len; g.dirZ = dz / len; }
  const elev = Math.max(elevFloor, dy / Math.max(1e-4, len));
  g.stretch = clamp(1.0 / elev, minStretch, maxStretch);
}

/** Night factor from the clock alone (the renderer has no sun vector to hand): fades in around lights-on, out at lights-off. */
export function nightFromHour(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const on = smoothstep(DAY_TUNING.lightsOnHour - 0.25, DAY_TUNING.lightsOnHour + 0.75, h);
  const off = 1 - smoothstep(DAY_TUNING.lightsOffHour - 0.5, DAY_TUNING.lightsOffHour + 0.5, h);
  return Math.max(on, off);
}

/** Uniforms shared by the character materials: rim strength and colour (cool by day, dimmed at night). */
export interface RimUniforms { uRim: { value: number }; uRimColor: { value: THREE.Color } }

export function makeRimUniforms(): RimUniforms {
  return { uRim: { value: 0.35 }, uRimColor: { value: new THREE.Color(0.62, 0.76, 1.0) } };
}

/** Rim strength for a night factor: the cool sky rim only makes sense under a sky; at night it drops to a hint. */
export function setRimNight(u: RimUniforms, night: number): void {
  u.uRim.value = 0.35 * (1 - 0.72 * night);
}

/** Fresnel rim folded into the indirect diffuse term: lifts silhouettes off the background without a second pass. */
export const RIM_FRAGMENT = `#include <lights_fragment_end>
{
  float rimK = pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), 3.0 ) * uRim;
  reflectedLight.indirectDiffuse += rimK * uRimColor * ( 0.35 + 0.65 * diffuseColor.rgb );
}`;

// ---------------------------------------------------------------------------------------------------------------------
// Player rig
// ---------------------------------------------------------------------------------------------------------------------

const HIPS = 0, SPINE = 1, HEAD = 2, SH_L = 3, EL_L = 4, SH_R = 5, EL_R = 6, HIP_L = 7, KNEE_L = 8, HIP_R = 9, KNEE_R = 10;
const BONES = 11;
const RADIAL = 12;

/** Skin weights by height: full `boneA` above yA, full `boneB` below yB, blended between (smooth joints). */
function skin(g: THREE.BufferGeometry, boneA: number, boneB: number, yA: number, yB: number): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const idx = new Uint16Array(n * 4);
  const w = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    const t = boneA === boneB ? 1 : clamp((y - yB) / Math.max(1e-6, yA - yB), 0, 1);
    idx[i * 4] = boneA; idx[i * 4 + 1] = boneB;
    w[i * 4] = t; w[i * 4 + 1] = 1 - t;
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
  return g;
}

function playerGeometry(): THREE.BufferGeometry {
  const P = PROFILE;
  const parts: THREE.BufferGeometry[] = [];
  // Torso: jeans below the belt, belt, shirt with a darker hem climbing to full colour at the chest, collar band.
  // Two tone breaks in the shirt, not one: the hem-to-chest ramp it already had, plus a lit yoke across the chest and
  // shoulders (`SHIRT_YOKE` from y 1.26 up) and a shaded panel down the back. A garment in ONE flat colour with a
  // single vertical ramp is the thing that reads as a shop mannequin whatever the silhouette does; the yoke gives the
  // chest a plane change and the back panel separates the figure from its own arms.
  const torso = paintFn(tube(torsoRings(1), RADIAL, true, true), (_x, y, z, out) => {
    // `face` is 0 at the back of the body and 1 at the front, eased over a few centimetres: a hard step at z = 0 draws
    // a seam straight down the flank of every garment.
    const face = smoothstep(-0.05, 0.05, z);
    if (y < P.beltLo) out.setHex(JEANS).multiplyScalar((0.96 + 0.04 * smoothstep(P.crotchY, P.beltLo, y)) * (0.9 + 0.1 * face));
    else if (y < P.beltHi + 0.002) out.setHex(BELT);
    else if (y < P.collarY) {
      const yoke = 1 + (SHIRT_YOKE - 1) * smoothstep(1.26, 1.38, y);
      out.setHex(SHIRT).multiplyScalar((0.64 + 0.36 * smoothstep(P.beltHi, 1.24, y)) * yoke * (SHIRT_BACK + (1 - SHIRT_BACK) * face));
    } else out.setHex(COLLAR);
  });
  parts.push(skin(torso, SPINE, HIPS, 0.98, 0.84));
  // Belt buckle: a brass plate on the centre line of the proud belt ring. Twelve triangles, and it is the one thing
  // that says "belt" from the front rather than "a dark stripe".
  const buckle = paint(block(0.062, 0.040, 0.016), BUCKLE);
  buckle.translate(0, (P.beltLo + P.beltHi) * 0.5, 0.142);
  parts.push(skin(buckle, HIPS, HIPS, 0, 0));
  parts.push(skin(paint(tube(neckRings(1), 8, false, false), SKIN), HEAD, SPINE, 1.57, 1.47));
  headParts(1, 14, 10, 7, (role, g) => {
    const hex = role === 'skin' ? SKIN : role === 'eye' ? EYE : HAIR;
    const painted = paint(g, hex);
    if (role === 'hair') hairShade(painted, P.headCY + P.headRY * 0.02, P.headRY);
    parts.push(skin(painted, HEAD, HEAD, 0, 0));
  });
  for (const side of [-1, 1]) {
    // Arm tube plus the mitten hand at the wrist; the hand rides the elbow bone through the y-threshold weights.
    const arm = paintFn(fuse([tube(armRings(1, side), RADIAL, false, false), hand(1, side, 8, 6)]), (_x, y, _z, out) => {
      if (y >= P.sleeveY) out.setHex(SLEEVE).multiplyScalar(0.88 + 0.12 * smoothstep(P.sleeveY, 1.36, y));
      else out.setHex(SKIN).multiplyScalar(y < HAND_Y ? HAND_TONE : 1);
    });
    arm.translate(side * P.shoulderX, 0, 0);
    parts.push(skin(arm, side < 0 ? SH_L : SH_R, side < 0 ? EL_L : EL_R, 1.19, 1.09));
    // Trousers get their second break here: the ramp up the shin, a lighter plane down the FRONT of the thigh and a
    // shadow crease at the back of the knee, so the leg has a form instead of being one blue tube.
    const leg = paintFn(tube(legRings(1, side), RADIAL, false, true), (_x, y, z, out) => {
      const face = smoothstep(-0.045, 0.045, z);
      const crease = 1 - JEANS_CREASE * (1 - smoothstep(0, 0.09, Math.abs(y - P.kneeY))) * (1 - 0.75 * face);
      out.setHex(JEANS).multiplyScalar((0.86 + 0.14 * smoothstep(0.1, 0.5, y)) * (0.93 + (JEANS_FRONT - 0.93) * face) * crease);
    });
    leg.translate(side * P.hipX, 0, 0);
    parts.push(skin(leg, side < 0 ? HIP_L : HIP_R, side < 0 ? KNEE_L : KNEE_R, 0.52, 0.42));
    // The shoe carries the shin's inward lean, so it stands under the ankle rather than beside it.
    const foot = paintShoe(shoe(1, 10, -side * 0.020), 1, SHOE, SOLE);
    foot.translate(side * P.hipX, 0, 0);
    parts.push(skin(foot, side < 0 ? KNEE_L : KNEE_R, side < 0 ? KNEE_L : KNEE_R, 0, 0));
  }
  return bakeAO(fuse(parts), 1);
}

export class PlayerRenderer {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.SkinnedMesh;
  private readonly bones: THREE.Bone[] = [];
  private readonly shadows: ContactShadows;
  private readonly groundShadow = makeGroundShadow();
  private readonly rim = makeRimUniforms();
  // Low probe weight: the dark hair otherwise mirrors whatever neon the reflection probe caught (green at night).
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.03, envMapIntensity: 0.22 });
  private readonly interp: Transform = createTransform();
  private readonly scene: THREE.Scene;
  private swing = 0;
  private airPose = 0;
  private time = 0;
  // Idle head look-around: a new target yaw/pitch every few seconds, eased toward.
  /**
   * Smoothed height of the cosmetic ground under the figure. The simulation runs on one flat plane (player.curr.y is
   * 0 on the pavement and on the road alike) while the city's pavements are modelled CURB_H above it, so a character
   * placed straight at the simulation y stands 15 cm INSIDE every sidewalk: the shoes and the bottom of the shins are
   * buried, which is why the player had "a thin dark spike instead of feet" — the only thing above the paving was the
   * toe. The contact shadow already used groundYAt for exactly this reason; the mesh now does too, eased over ~0.1 s
   * so stepping off a kerb does not snap the whole figure.
   */
  private groundY = NaN;
  private lookTimer = 2.5;
  private lookTargetY = 0;
  private lookTargetX = 0;
  private lookY = 0;
  private lookX = 0;
  private lookSeed = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const P = PROFILE;
    this.mat.onBeforeCompile = (shader) => {
      shader.uniforms.uRim = this.rim.uRim;
      shader.uniforms.uRimColor = this.rim.uRimColor;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uRim;\nuniform vec3 uRimColor;')
        .replace('#include <lights_fragment_end>', RIM_FRAGMENT);
    };
    this.mat.customProgramCacheKey = () => 'characterRim';

    const bone = (parent: THREE.Bone | null, x: number, y: number, z: number): THREE.Bone => {
      const b = new THREE.Bone();
      b.position.set(x, y, z);
      if (parent) parent.add(b);
      this.bones.push(b);
      return b;
    };
    const hips = bone(null, 0, P.hipY, 0);
    const spine = bone(hips, 0, 0, 0);
    bone(spine, 0, P.neckY - P.hipY, 0);
    const shL = bone(spine, -P.shoulderX, P.shoulderY - P.hipY, 0);
    bone(shL, 0, P.elbowY - P.shoulderY, 0);
    const shR = bone(spine, P.shoulderX, P.shoulderY - P.hipY, 0);
    bone(shR, 0, P.elbowY - P.shoulderY, 0);
    const hipL = bone(hips, -P.hipX, 0, 0);
    bone(hipL, 0, P.kneeY - P.hipY, 0);
    const hipR = bone(hips, P.hipX, 0, 0);
    bone(hipR, 0, P.kneeY - P.hipY, 0);
    if (this.bones.length !== BONES) throw new Error('player rig bone count');

    this.mesh = new THREE.SkinnedMesh(playerGeometry(), this.mat);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.add(hips);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.group.add(this.mesh);
    this.group.rotation.order = 'YXZ';
    scene.add(this.group);
    this.shadows = new ContactShadows(scene, 1);
  }

  sync(world: World, alpha: number, frameDt: number): void {
    const p = world.player;
    const g = this.group;
    g.visible = p.vehicleId === null;
    this.shadows.begin();
    if (!g.visible) { this.shadows.end(); return; }
    lerpTransform(this.interp, p.prev, p.curr, alpha);
    const dt = Math.min(frameDt, 0.1);
    this.time += dt;
    const sc = Math.max(0.01, p.spawnFade);
    const gy = groundYAt(this.interp.x, this.interp.z);
    this.groundY = Number.isNaN(this.groundY) ? gy : damp(this.groundY, gy, 14, dt);
    g.position.set(this.interp.x, this.interp.y + this.groundY, this.interp.z);
    g.rotation.y = this.interp.yaw;
    g.scale.set(sc, sc, sc);
    setRimNight(this.rim, nightFromHour(world.time.hour));

    // Contact blob: an ellipse laid along the direction the scene's own shadow light casts, its near end under the
    // feet (see GroundShadow). A downed player keeps the old round-but-wider blob, which is its own silhouette.
    updateGroundShadow(this.groundShadow, this.scene, SHADOW_NARROW, SHADOW_STRETCH_MAX, SHADOW_ELEV_FLOOR);
    const gs = this.groundShadow;
    const gyS = this.groundY + SHADOW_LIFT;
    if (!p.alive) this.shadows.add(this.interp.x, gyS, this.interp.z, SHADOW_R, SHADOW_R * 1.8, this.interp.yaw, sc);
    else {
      // See PED_RENDER.shadowAnchor: the full (rz - rx) offset walks the blob's opaque core away from the feet.
      const rx = SHADOW_R * SHADOW_NARROW, rz = SHADOW_R * gs.stretch, push = (rz - rx) * SHADOW_ANCHOR;
      this.shadows.add(this.interp.x + gs.dirX * push, gyS, this.interp.z + gs.dirZ * push, rx, rz, Math.atan2(gs.dirX, gs.dirZ), sc);
    }
    this.shadows.end();

    if (!p.alive) {
      g.rotation.x = -Math.PI / 2;
      g.position.y += 0.25;
      this.time = 0; // no idle weight shift or glances on the ground
      this.lookY = 0; this.lookX = 0;
      this.setPose(0, 0, 0);
      return;
    }
    g.rotation.x = 0;
    const targetAmp = p.moving ? (p.sprinting ? 0.95 : 0.6) : 0;
    this.swing = damp(this.swing, targetAmp, 10, dt);
    this.airPose = damp(this.airPose, p.grounded ? 0 : 1, 12, dt);
    this.updateLook(dt, this.swing);
    this.setPose(p.animPhase, this.swing, this.airPose);
  }

  /** Idle head look-around: every ~4 s pick a new glance (yaw up to +-0.25 rad, a little pitch), ease there. */
  private updateLook(dt: number, amp: number): void {
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookSeed = (this.lookSeed * 1103515245 + 12345) % 2147483648;
      const r1 = this.lookSeed / 2147483648;
      this.lookSeed = (this.lookSeed * 1103515245 + 12345) % 2147483648;
      const r2 = this.lookSeed / 2147483648;
      // Glance left, right or back to centre; centre more often so it reads as looking around, not scanning.
      this.lookTargetY = r1 < 0.25 ? 0 : (r1 - 0.625) * 0.667;
      this.lookTargetX = (r2 - 0.5) * 0.12;
      this.lookTimer = 3 + r2 * 2.5;
    }
    // Walking straightens the gaze; the ease is quick enough to read as a glance, slow enough not to snap.
    const idle = 1 - Math.min(1, amp * 2);
    this.lookY = damp(this.lookY, this.lookTargetY * idle, 4, dt);
    this.lookX = damp(this.lookX, this.lookTargetX * idle, 4, dt);
  }

  /**
   * Walk cycle. Hips swing the legs (sin), the knee folds while the leg swings forward (foot off the ground) and is
   * straight through the stance; arms counter-swing from a relaxed rest pose (elbows soft, hands by the thighs).
   * Idle: weight shifts from hip to hip with the spine countering so the head stays put, the chest breathes, the
   * arms drift a touch and the head glances around.
   */
  private setPose(phase: number, amp: number, air: number): void {
    const B = this.bones;
    const P = PROFILE;
    const sn = Math.sin(phase), cs = Math.cos(phase);
    const s = sn * amp;
    const ground = 1 - air;
    const idle = 1 - Math.min(1, amp * 2);
    const t = this.time;
    const shift = Math.sin(t * 0.7) * idle; // slow weight shift, -1..1
    const breath = (0.5 + 0.5 * Math.sin(t * 1.8)) * idle;
    B[HIP_L].rotation.x = s * ground + 0.55 * air;
    B[HIP_R].rotation.x = -s * ground - 0.15 * air;
    // The unloaded leg softens at the knee as the weight leaves it.
    B[KNEE_L].rotation.x = (0.08 + 1.05 * Math.max(0, -cs)) * amp * ground + 0.9 * air + 0.06 * Math.max(0, shift);
    B[KNEE_R].rotation.x = (0.08 + 1.05 * Math.max(0, cs)) * amp * ground + 0.4 * air + 0.06 * Math.max(0, -shift);
    // Arms: rest slightly forward of the hip line with a soft elbow, hang close to the body, swing opposite the legs
    // when moving, reach up in the air; a slow sway while idle keeps them from freezing.
    const swayA = 0.03 * Math.sin(t * 0.9 + 0.6) * idle;
    // `spread` is 0.115 at rest, not 0.04. The elbow bend the arms already had is a rotation about X: it swings the
    // forearm forward, which from the front or from behind - the two angles a third-person player is ever seen from -
    // changes NOTHING in the silhouette, so the arms read as two straight lines hanging off the shoulders. Standing
    // the upper arms off the ribs and closing the forearms back in (`ELBOW_IN` about Z) puts the bend where it shows.
    const spread = 0.115 + 0.02 * Math.min(1, Math.abs(s) * 4) + 0.012 * breath;
    B[SH_L].rotation.x = (-0.05 - s * 0.8 + swayA) * ground - 2.4 * air;
    B[SH_R].rotation.x = (-0.05 + s * 0.8 - swayA) * ground - 2.4 * air;
    B[SH_L].rotation.z = -spread - 0.01 * shift;
    B[SH_R].rotation.z = spread - 0.01 * shift;
    B[EL_L].rotation.x = -(0.3 + 0.45 * Math.max(0, s) + 0.03 * breath) * ground - 1.1 * air;
    B[EL_R].rotation.x = -(0.3 + 0.45 * Math.max(0, -s) + 0.03 * breath) * ground - 1.1 * air;
    B[EL_L].rotation.z = (ELBOW_IN + 0.012 * breath) * ground;
    B[EL_R].rotation.z = -(ELBOW_IN + 0.012 * breath) * ground;
    // Hips tilt and twist with the stride, shoulders counter-twist; a bounce at twice the stride frequency.
    // Idle weight shift: the pelvis tips and slides over the loaded leg, the spine leans back the other way.
    const hips = B[HIPS], spine = B[SPINE];
    hips.rotation.z = 0.05 * s + 0.035 * shift;
    hips.rotation.y = -0.07 * s;
    hips.position.x = 0.02 * shift;
    hips.position.y = P.hipY + 0.025 * amp * (0.5 - 0.5 * Math.cos(phase * 2)) - 0.004 * Math.abs(shift);
    spine.rotation.y = 0.14 * s;
    spine.rotation.z = -0.04 * s - 0.03 * shift;
    spine.rotation.x = 0.08 * Math.abs(s) + 0.12 * air;
    // Idle breathing: the chest swells a touch and the head lifts with it; glances add yaw and a little pitch.
    spine.scale.set(1 + 0.012 * breath, 1 + 0.005 * breath, 1 + 0.022 * breath);
    B[HEAD].rotation.x = -0.05 * Math.abs(s) - 0.02 * breath + this.lookX;
    B[HEAD].rotation.y = this.lookY;
    B[HEAD].rotation.z = -0.012 * shift + 0.08 * this.lookY;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.mesh.geometry.dispose();
    this.mesh.skeleton.dispose();
    this.shadows.dispose();
    this.mat.dispose();
  }
}
