// Instanced vehicle rendering: per-spec merged low-poly bodies (paint + fixed-colour glass/chrome/lamps), rims,
// light quads, contact shadows, player headlight spotlights. Track C.
//
// Every body is merged ONCE at construction: one smooth lofted shell (a side silhouette and a plan curve sampled at
// ~20 stations x 28 ring points, with duplicated rings for the belt and drip-rail creases) whose glass, gaskets, lamps
// and valances are coloured regions of the same surface, plus a few small parts (pillars, mirrors, handles, grille,
// plates, arches, lamp bezels, bumper strip, exhaust). Every vertex carries a base colour and a `paintMix` weight, and
// the patched Physical shader blends the per-instance paint only where paintMix > 0 (a negative paintMix marks a lamp
// lens, which glows per instance when the lights are on), so glass stays dark and lamps stay red on a bright yellow
// taxi while the whole spec still costs one draw call. The paint is a clearcoated metallic with a view-angle rim, so
// the shell reads as lacquered metal against the sky probe instead of clay. `parkedShellGeometry` is the same loft at
// a coarser ring and fewer stations for the static parked cars of the lots (CityRendererProps).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { World } from '../world/World';
import type { Vehicle } from '../entities/Vehicle';
import type { VehicleKey, VehicleSpec } from '../entities/VehicleSpecs';
import { SPECS } from '../entities/VehicleSpecs';
import { BUDGET } from '../core/Budget';
import type { Transform } from '../core/Types';
import { createTransform, lerpTransform } from '../core/Transform';
import { clamp } from '../core/math';
import { ContactShadows, groundYAt } from './ContactShadows';
import { surface, tube } from './PlayerRenderer';
import type { Ring } from './PlayerRenderer';

export const VEHICLE_RENDER = {
  cullDist: 260, clearance: 0.30, wheelRadius: 0.33, wheelWidth: 0.24, lightsPerVehicle: 6, wheelsPerVehicle: 4,
  /** Past this the lathed wheels (~320 triangles each) are a few pixels inside a dark arch; they are simply not written. */
  wheelDist: 110,
  /** Beyond this distance a vehicle is drawn as its parked-shell LOD (baked wheel discs, no shadow-map pass). */
  bodyLodDist: 75,
  /**
   * Player headlights: physically-decaying spots (decay 2). 45 cd puts a readable pool on the road 5-10 m ahead and
   * falls to a few percent on a facade 25 m away; the old 90 cd / decay 1.2 pair whited out every shopfront it faced.
   */
  headlightIntensity: 45, headlightDistance: 35, headlightAngle: 0.5, headlightPenumbra: 0.45, headlightDecay: 2, sirenHz: 4,
  /** Body pitch (dive/squat) and roll (lean) limits in radians, and how hard longAccel / yawRate push them. */
  pitchGain: 0.010, pitchMax: 0.036, rollGain: 0.0035, rollMax: 0.055,
  shadowLift: 0.045,
} as const;

const KEYS: VehicleKey[] = ['sedan', 'sport', 'van', 'police', 'taxi'];
/** Head / tail light quads are drawn a little smaller than their anchor so the lamp bezel and lens rim show around them. */
const LIGHT_QUAD_SCALE = 0.86;

// ---------------------------------------------------------------------------------------------- geometry primitives

/** Paint = tinted by the instance colour, everything else keeps its authored colour. */
const PAINT = 0xffffff;
const PAINT_DARK = 0xd2d2d2;
const PAINT_SHADE = 0xa8a8a8;
const GLASS = 0x1a2432;
const GLASS_DEEP = 0x10161f;
const CHROME = 0x9aa2ac;
const DARK = 0x33373d;
const BLACK = 0x1b1d20;
/** Rubber gasket / frit band around the glass and the lamp bezels: a hair off black so the clearcoat still catches. */
const SEAL = 0x15171a;
const BEZEL = 0x1e2024;
const LAMP = 0x97a5b0;
const LAMP_LENS = 0xeef3f2;
const TAIL = 0x8c1a12;
const TAIL_LENS = 0xe0503c;
const POLICE_BLUE = 0x1638b4;
const SIGN = 0xf6edd2;
/** Number plates: a muted warm grey-white in a dark frame, not a bright cream rectangle. */
const PLATE = 0xd8d2c0;
const PLATE_FRAME = 0x2a2c30;
const EXHAUST = 0x3a3d42;
/** Rubbing strip across the rear bumper: the horizontal bumper line the tail was missing. */
const BUMPER_STRIP = 0x111315;
/** paintMix value that marks a lamp lens: no paint tint, and emissive when the vehicle's lights are on. */
const LENS_MIX = -1;

/** A box deformed into a frustum: independent z / half-width / y for the (bottom, top) x (back, front) corners. */
interface PrismDef {
  /** bottom face: back z, front z, back half-width, front half-width, back y, front y (y defaults to flat). */
  bz0: number; bz1: number; bw0: number; bw1: number; by0: number; by1?: number;
  /** top face, same layout. */
  tz0: number; tz1: number; tw0: number; tw1: number; ty0: number; ty1?: number;
  /** centre offset on x (mirrored pairs push ±); `txc` lets the top face lean (raked pillars, strips on a leaning flank). */
  xc?: number; txc?: number;
  col: number;
  /** 0 = authored colour, 1 = fully tinted by the vehicle paint. */
  paint?: number;
  /** Corner radius in unit-cube space (default PRISM_BEVEL); >= PRISM_BEVEL_SOFT gets the finer 2-segment bevel. */
  bevel?: number;
  /** Plan-view rounding of the front / back end (only the bevel-ring vertices move). */
  noseTaper?: number;
  tailTaper?: number;
  /** Force a plain 12-triangle box (hidden or edge-on panels where a bevel would never be seen). */
  plain?: boolean;
}

const authorColor = new THREE.Color();

/** Bevel on the few remaining small parts (mirrors, spoiler): a sharp cube corner is what reads as "boxy". */
const PRISM_BEVEL = 0.085;
const PRISM_SEGMENTS = 1;
const PRISM_BEVEL_SOFT = 0.16;
const PRISM_SEGMENTS_SOFT = 2;

/** Panels smaller than this stay plain boxes: a bevel would be invisible and 9x the triangles. */
const PRISM_BEVEL_MIN_SIZE = 0.55;

/** The body material has no maps: dropping uv lets sculpted sheets (no uv) and stock geometries merge into one buffer. */
function stripUv(g: THREE.BufferGeometry): void {
  if (g.attributes.uv) g.deleteAttribute('uv');
}

function prism(p: PrismDef): THREE.BufferGeometry {
  const by1p = p.by1 ?? p.by0;
  const ty1p = p.ty1 ?? p.ty0;
  const spanZ = Math.max(p.bz1 - p.bz0, p.tz1 - p.tz0);
  const spanY = Math.max(p.ty0 - p.by0, ty1p - by1p);
  const spanX = 2 * Math.max(p.bw0, p.bw1, p.tw0, p.tw1);
  const big = !p.plain && Math.max(spanX, spanY, spanZ) >= PRISM_BEVEL_MIN_SIZE;
  const bevel = p.bevel ?? PRISM_BEVEL;
  const segments = bevel >= PRISM_BEVEL_SOFT ? PRISM_SEGMENTS_SOFT : PRISM_SEGMENTS;
  // RoundedBoxGeometry is non-indexed; keep the plain boxes non-indexed too or mergeGeometries rejects the mix.
  const g: THREE.BufferGeometry = big
    ? new RoundedBoxGeometry(1, 1, 1, segments, bevel)
    : new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const pos = g.attributes.position;
  const n = pos.count;
  const colors = new Float32Array(n * 3);
  const paints = new Float32Array(n);
  const xc = p.xc ?? 0;
  const txc = p.txc ?? xc;
  const by1 = p.by1 ?? p.by0;
  const ty1 = p.ty1 ?? p.ty0;
  const noseTaper = big ? (p.noseTaper ?? 0) : 0;
  const tailTaper = big ? (p.tailTaper ?? 0) : 0;
  const ringZ = 0.5 - bevel;
  authorColor.setHex(p.col);
  const paint = p.paint ?? 1;
  for (let i = 0; i < n; i++) {
    // Unit cube coords -> 0..1 weights. Rounded corners sit slightly inside, so the bevel survives the taper.
    const u = pos.getX(i) * 2;                       // -1..1 across the width
    const v = Math.min(1, Math.max(0, pos.getY(i) + 0.5)); // 0 bottom, 1 top
    const pz = pos.getZ(i);
    const w = Math.min(1, Math.max(0, pz + 0.5)); // 0 back, 1 front
    let hw = (p.bw0 * (1 - w) + p.bw1 * w) * (1 - v) + (p.tw0 * (1 - w) + p.tw1 * w) * v;
    if (noseTaper > 0 && pz > ringZ) { const e = Math.min(1, (pz - ringZ) / bevel); hw *= 1 - noseTaper * e * e; }
    else if (tailTaper > 0 && pz < -ringZ) { const e = Math.min(1, (-pz - ringZ) / bevel); hw *= 1 - tailTaper * e * e; }
    const z = (p.bz0 * (1 - w) + p.bz1 * w) * (1 - v) + (p.tz0 * (1 - w) + p.tz1 * w) * v;
    const y = (p.by0 * (1 - w) + by1 * w) * (1 - v) + (p.ty0 * (1 - w) + ty1 * w) * v;
    pos.setXYZ(i, xc * (1 - v) + txc * v + u * hw, y, z);
    colors[i * 3] = authorColor.r; colors[i * 3 + 1] = authorColor.g; colors[i * 3 + 2] = authorColor.b;
    paints[i] = paint;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('paintMix', new THREE.BufferAttribute(paints, 1));
  stripUv(g);
  g.computeVertexNormals();
  return g;
}

/** Gives a stock three geometry the vehicle attributes (colour + paintMix) and makes it mergeable with the shell. */
function decorate(src: THREE.BufferGeometry, hex: number, paint: number): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src;
  if (g !== src) src.dispose();
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  const paints = new Float32Array(n);
  authorColor.setHex(hex);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = authorColor.r; colors[i * 3 + 1] = authorColor.g; colors[i * 3 + 2] = authorColor.b;
    paints[i] = paint;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('paintMix', new THREE.BufferAttribute(paints, 1));
  stripUv(g);
  return g;
}

/** Scales the baked colour of every vertex by `k(x, y, z)` (per-part shading such as a sooty exhaust tip or a rim disc). */
function shade(g: THREE.BufferGeometry, k: (x: number, y: number, z: number) => number): THREE.BufferGeometry {
  const pos = g.attributes.position, col = g.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const f = k(pos.getX(i), pos.getY(i), pos.getZ(i));
    col.setXYZ(i, col.getX(i) * f, col.getY(i) * f, col.getZ(i) * f);
  }
  return g;
}

/** Simple axis-aligned block helper (constant width, flat top/bottom). */
function block(z0: number, z1: number, hw: number, y0: number, y1: number, col: number, paint: number, xc = 0): PrismDef {
  return { bz0: z0, bz1: z1, bw0: hw, bw1: hw, by0: y0, tz0: z0, tz1: z1, tw0: hw, tw1: hw, ty0: y1, col, paint, xc };
}

/** Pushes a prism and its mirror image across x. */
function pair(out: PrismDef[], p: PrismDef): void {
  const xc = p.xc ?? 0;
  const txc = p.txc ?? xc;
  out.push({ ...p, xc, txc });
  out.push({ ...p, xc: -xc, txc: -txc });
}

/** Painted, raked pillar: a 9 cm post from the (z, x) base corner to the (z, x) top corner of a glasshouse, in one prism. */
function pillar(out: PrismDef[], bz: number, bx: number, y0: number, tz: number, tx: number, y1: number): void {
  const t = PILLAR_W;
  pair(out, {
    bz0: bz - t, bz1: bz, bw0: t * 0.5, bw1: t * 0.5, by0: y0, tz0: tz - t, tz1: tz, tw0: t * 0.5, tw1: t * 0.5, ty0: y1,
    xc: bx - t * 0.5 + PILLAR_PROUD, txc: tx - t * 0.5 + PILLAR_PROUD, col: PAINT, paint: 1, bevel: 0.2,
  });
}

/** Thin black panel-gap line on a leaning flank: follows the shell from half-width `bx` at y0 to `tx` at y1. */
function shutLine(out: PrismDef[], z: number, bx: number, y0: number, tx: number, y1: number): void {
  pair(out, {
    bz0: z - 0.008, bz1: z + 0.008, bw0: 0.012, bw1: 0.012, by0: y0, tz0: z - 0.008, tz1: z + 0.008, tw0: 0.012, tw1: 0.012, ty0: y1,
    xc: bx + 0.004, txc: tx + 0.004, col: BLACK, paint: 0,
  });
}

/**
 * Number plate: a muted plate face 6 mm proud of a dark frame that overhangs it by 2 cm all round, so the plate reads
 * as a bordered rectangle set into the bumper. The face is toward +z when `zFace > zBack`.
 */
function plate(out: PrismDef[], zBack: number, zFace: number, hw: number, y0: number, y1: number): void {
  const d = zFace > zBack ? 1 : -1;
  const zFrame = zFace - d * 0.006;
  out.push({ ...block(Math.min(zBack, zFrame), Math.max(zBack, zFrame), hw + 0.025, y0 - 0.02, y1 + 0.02, PLATE_FRAME, 0), plain: true });
  out.push({ ...block(Math.min(zBack, zFace), Math.max(zBack, zFace), hw, y0, y1, PLATE, 0), plain: true });
}

/** Rear plate recess; the exhaust tube itself is lathed in `bodyGeometry` from the profile's `exhaust` anchor. */
function rearDetails(out: PrismDef[], zFace: number, plateY: number): void {
  plate(out, zFace + 0.06, zFace - 0.012, 0.19, plateY, plateY + 0.11);
}

/** Exhaust: a 2 cm dark tube under the bumper (6-sided lathe, closed), its rearmost 2 cm sootier. */
function exhaustGeometry(x: number, y: number, zFace: number): THREE.BufferGeometry {
  const len = 0.19;
  const g = new THREE.CylinderGeometry(0.021, 0.021, len, 6, 1, false);
  g.rotateX(Math.PI / 2); // axis y -> z
  g.translate(x, y, zFace + len / 2 - 0.07);
  return shade(decorate(g, EXHAUST, 0), (_x, _y, z) => (z < zFace - 0.05 ? 0.45 : 1));
}

/**
 * A flank-hugging strip (mirrored): its outer face sits `proud` metres off the shell at all four corners, so it follows
 * the shell's lean, its front/back taper and the plan rounding at the ends. `depth` = how far it reaches into the body.
 */
function flankStrip(out: PrismDef[], width: (y: number, z: number) => number, z0: number, z1: number, y0: number, y1: number, proud: number, depth: number, col: number, paint: number): void {
  const xb0 = width(y0, z0) + proud, xb1 = width(y0, z1) + proud;
  const xt0 = width(y1, z0) + proud, xt1 = width(y1, z1) + proud;
  const xc = Math.min(xb0, xb1) - depth, txc = Math.min(xt0, xt1) - depth;
  pair(out, {
    bz0: z0, bz1: z1, bw0: xb0 - xc, bw1: xb1 - xc, by0: y0, tz0: z0, tz1: z1, tw0: xt0 - txc, tw1: xt1 - txc, ty0: y1,
    xc, txc, col, paint, plain: true,
  });
}

/** Door handle: a 2 cm chrome bump standing off the flank at belt height (z0..z1 along the door). */
function handle(out: PrismDef[], z0: number, z1: number, flankX: number, y: number): void {
  pair(out, { ...block(z0, z1, 0.012, y - 0.015, y + 0.015, CHROME, 0, flankX + 0.008) });
  pair(out, { ...block(z0 + 0.02, z1 - 0.02, 0.006, y - 0.03, y - 0.015, BLACK, 0, flankX + 0.004) });
}

/** Door mirror: a short stalk from the glasshouse flank (`xGlass`) out to a painted shell with dark glass on its trailing face. */
function mirror(out: PrismDef[], z0: number, z1: number, xGlass: number, y: number, h: number, w: number): void {
  const cx = xGlass + 0.06 + w;
  pair(out, { ...block(z0 + 0.015, z1 - 0.015, 0.045, y + h * 0.35, y + h * 0.6, PAINT_SHADE, 1, xGlass + 0.025) });
  pair(out, {
    bz0: z0, bz1: z1, bw0: w, bw1: w * 0.9, by0: y, tz0: z0 + 0.01, tz1: z1 - 0.01, tw0: w * 0.9, tw1: w * 0.8, ty0: y + h,
    col: PAINT_SHADE, paint: 1, xc: cx, txc: cx,
  });
  pair(out, { ...block(z0 - 0.008, z0 + 0.004, w * 0.8, y + 0.015, y + h - 0.015, GLASS_DEEP, 0, cx) });
}

/** Wheel centre x = half width - half tyre width + this: the tyre face ends 1 cm inside the spec width, flush with the arch lip. */
const WHEEL_INSET = -0.01;
/** Shell plan widths are authored against hw * PLAN: the doors stay 5 % inside the arch lips, so the arches read as flares. */
const PLAN = 0.947;
const PILLAR_W = 0.09;
const PILLAR_PROUD = 0.012;
/** Glass sits this far inside the pillars and sills (the gasket bands slope in to meet it). */
const GLASS_INSET = 0.02;
/** Width of the rubber gasket band at the belt and drip rail, and of the frit band at the screen ends. */
const SEAL_W = 0.03;

// ---------------------------------------------------------------------------------------------- lofted shell

/** Authored colour + paint weight of one band of shell cells. */
interface Tone { col: number; paint: number }
const T = {
  paint: { col: PAINT, paint: 1 }, dark: { col: PAINT_DARK, paint: 1 }, shade: { col: PAINT_SHADE, paint: 1 },
  glass: { col: GLASS, paint: 0.15 }, seal: { col: SEAL, paint: 0 }, bezel: { col: BEZEL, paint: 0 }, black: { col: BLACK, paint: 0 }, grey: { col: DARK, paint: 0 },
  tail: { col: TAIL, paint: 0 }, tailLens: { col: TAIL_LENS, paint: LENS_MIX }, lamp: { col: LAMP, paint: 0 }, lampLens: { col: LAMP_LENS, paint: LENS_MIX },
} as const satisfies Record<string, Tone>;

/**
 * Tones of the cell bands of the shell segment that starts at a station and runs to the next one: `sill` (underside and
 * rocker), `low` (sill to lower flank), `flank` (the middle of the flank: doors, lamp lenses), `side` (belt to roof edge:
 * glass or pillars) and `top` (roof edge to centre line: bonnet, screens, roof, boot). `bezel` colours the two flank
 * cells above and below the lens cell (lamp clusters frame their lens with it; body segments leave it undefined = flank),
 * `seal` the gasket bands at the belt and drip rail (glass segments set it black; undefined = side). `lens` recolours the
 * lens-cell vertices on one end station so a lamp cluster gets a lighter inner lens.
 */
interface SegTone { sill: Tone; low: Tone; flank: Tone; side: Tone; top: Tone; bezel?: Tone; seal?: Tone; lens?: { at: 0 | 1; tone: Tone } }
const BODY: SegTone = { sill: T.paint, low: T.paint, flank: T.paint, side: T.paint, top: T.paint };
/** Door-glass segment: glass between black gaskets. */
const GLAZED: SegTone = { ...BODY, side: T.glass, seal: T.seal };
/** Screen segments (top band glass) and the 3 cm frit bands at their ends. */
const SCREEN: SegTone = { ...BODY, top: T.glass };
const SCREEN_EDGE: SegTone = { ...BODY, top: T.seal };
const GLAZED_SCREEN: SegTone = { ...GLAZED, top: T.glass };
const GLAZED_SCREEN_EDGE: SegTone = { ...GLAZED, top: T.seal };
/** B pillar: black, flush with the (inset) glass on both sides of it. */
const B_PILLAR: SegTone = { ...BODY, side: T.black, seal: T.seal };

/**
 * One cross-section of the shell at depth z: floor, sill, lower flank, belt, roof edge and centre line, from which the
 * ring layout derives its points. End faces reuse the neighbouring ring scaled about (0, shrinkY) by `shrink`
 * (0 collapses it to the centre point).
 */
interface Station {
  z: number;
  yFloor: number; wFloor: number;
  yLow: number; wLow: number;
  yBelt: number; wBelt: number;
  yTop: number; wTop: number;
  /** The roof edge sits `edge` below yTop; the centre line is lifted by `crown`; `bulge` pushes the tumblehome mid outward. */
  edge: number; crown: number; bulge: number;
  /** Glass inset: the side points between the belt and drip-rail gaskets sit this far inside the tumblehome line. */
  inset: number;
  /** Screen inset: the top-band points (crown) sit this far lower, so a screen steps down from the roof it meets. */
  topInset: number;
  shrink?: number; shrinkY?: number;
  seg: SegTone;
  /** Kept by the coarse parked-car shell (`parkedShellGeometry`). */
  lod?: boolean;
}

interface StationOpts {
  yFloor?: number; wFloor?: number; yLow?: number; wLow?: number; edge?: number; crown?: number; bulge?: number; inset?: number; topInset?: number; seg?: SegTone; lod?: boolean;
}

/** A full ring; defaults: floor at `c`, floor 5 cm narrower than the belt, lower-flank point 42 % of the way up. */
function station(z: number, c: number, yTop: number, wTop: number, yBelt: number, wBelt: number, o: StationOpts = {}): Station {
  const yFloor = o.yFloor ?? c;
  return {
    z, yFloor, wFloor: o.wFloor ?? wBelt - 0.05, yLow: o.yLow ?? yFloor + (yBelt - yFloor) * 0.42, wLow: o.wLow ?? wBelt - 0.012,
    yBelt, wBelt, yTop, wTop, edge: o.edge ?? 0.04, crown: o.crown ?? 0.02, bulge: o.bulge ?? 0.02, inset: o.inset ?? 0, topInset: o.topInset ?? 0,
    seg: o.seg ?? BODY, lod: o.lod,
  };
}

/** End-face ring: `base` scaled by k about (0, yC) at depth z. */
function shrunk(base: Station, z: number, k: number, yC: number, seg: SegTone, lod = false): Station {
  return { ...base, z, shrink: k, shrinkY: yC, seg, lod };
}

/**
 * Ring point kinds, bottom centre to top centre along one side; a layout mirrors its half across x. `belt` and `edge`
 * appear twice for the crease (duplicated vertices, so the smooth normals stop at the belt line and the drip rail
 * and nowhere else). `lensLo`/`lensHi` split the flank into bezel / lens / bezel cells for the lamp clusters,
 * `sealLo`/`sealHi` bound the gasket bands, `topMid` rounds the crown of the roof, bonnet and screens.
 */
type PointKind = 'bottom' | 'sill' | 'lowFloor' | 'low' | 'lensLo' | 'lensHi' | 'belt' | 'sealLo' | 'mid' | 'sealHi' | 'edge' | 'topMid' | 'top';
type Band = 'sill' | 'low' | 'bezelLo' | 'flank' | 'bezelHi' | 'sealLo' | 'side' | 'sealHi' | 'top';

interface RingLayout { half: PointKind[]; ring: number; /** Band of the cell between half points k and k+1 (null = crease). */ bands: (Band | null)[] }

function bandBetween(a: PointKind, b: PointKind): Band | null {
  switch (a) {
    case 'bottom': case 'sill': return 'sill';
    case 'lowFloor': return 'low';
    case 'low': return b === 'lensLo' ? 'bezelLo' : 'flank';
    case 'lensLo': return 'flank';
    case 'lensHi': return 'bezelHi';
    case 'belt': return b === 'belt' ? null : b === 'sealLo' ? 'sealLo' : 'side';
    case 'sealLo': case 'mid': return 'side';
    case 'sealHi': return 'sealHi';
    case 'edge': return b === 'edge' ? null : 'top';
    default: return 'top';
  }
}

function makeLayout(half: PointKind[]): RingLayout {
  const bands: (Band | null)[] = [];
  for (let k = 0; k + 1 < half.length; k++) bands.push(bandBetween(half[k], half[k + 1]));
  return { half, ring: 2 * (half.length - 1), bands };
}

/** Full ring: 15 half points (28 around) with both creases, the lens split, the gasket bands and a rounded crown. */
const FULL_RING = makeLayout(['bottom', 'sill', 'lowFloor', 'low', 'lensLo', 'lensHi', 'belt', 'belt', 'sealLo', 'mid', 'sealHi', 'edge', 'edge', 'topMid', 'top']);
/** Parked-car ring: 8 half points (14 around), belt crease only, no gaskets or lens split. */
const LOD_RING = makeLayout(['bottom', 'lowFloor', 'low', 'belt', 'belt', 'mid', 'edge', 'top']);

/** Band of ring cell j (points j -> j+1) in a layout: the second half mirrors the first. */
function cellBand(lay: RingLayout, j: number): Band | null {
  const n = lay.half.length;
  return lay.bands[j < n - 1 ? j : lay.ring - 1 - j];
}

/** Position of one ring point of kind `kind` on the +x side of station `s` (before shrink / mirror). */
function pointOfKind(s: Station, kind: PointKind, out: { x: number; y: number }): void {
  let x = 0, y = 0;
  switch (kind) {
    case 'bottom': y = s.yFloor; break;
    case 'sill': x = s.wFloor - 0.09; y = s.yFloor; break;
    case 'lowFloor': x = s.wFloor; y = s.yFloor + 0.07; break;
    case 'low': x = s.wLow; y = s.yLow; break;
    case 'lensLo': x = s.wLow + (s.wBelt - s.wLow) * 0.22; y = s.yLow + (s.yBelt - s.yLow) * 0.22; break;
    case 'lensHi': x = s.wLow + (s.wBelt - s.wLow) * 0.78; y = s.yLow + (s.yBelt - s.yLow) * 0.78; break;
    case 'belt': x = s.wBelt; y = s.yBelt; break;
    case 'sealLo': case 'mid': case 'sealHi': {
      // Along the tumblehome line from the belt to the roof edge; `n` is its outward normal.
      const ex = s.wTop, ey = s.yTop - s.edge;
      const dx = ex - s.wBelt, dy = ey - s.yBelt;
      const len = Math.max(1e-4, Math.hypot(dx, dy));
      const ux = dx / len, uy = dy / len, nx = uy, ny = -ux;
      const seal = Math.min(SEAL_W, len * 0.3);
      if (kind === 'mid') {
        const off = s.bulge - s.inset;
        x = s.wBelt + dx * 0.55 + nx * off; y = s.yBelt + dy * 0.55 + ny * off;
      } else if (kind === 'sealLo') {
        x = s.wBelt + ux * seal - nx * s.inset; y = s.yBelt + uy * seal - ny * s.inset;
      } else {
        x = ex - ux * seal - nx * s.inset; y = ey - uy * seal - ny * s.inset;
      }
      break;
    }
    case 'edge': x = s.wTop; y = s.yTop - s.edge; break;
    case 'topMid': {
      const ey = s.yTop - s.edge, cy = s.yTop + s.crown;
      x = s.wTop * 0.5; y = ey + (cy - ey) * 0.8 - s.topInset;
      break;
    }
    default: y = s.yTop + s.crown - s.topInset; break;
  }
  out.x = x; out.y = y;
}

const ringPt = { x: 0, y: 0 };
function ringPoint(s: Station, lay: RingLayout, j: number, out: { x: number; y: number }): void {
  const n = lay.half.length;
  let side = 1, k = j;
  if (j >= n) { side = -1; k = lay.ring - j; }
  pointOfKind(s, lay.half[k], out);
  out.x *= side;
  if (s.shrink !== undefined) {
    const cy = s.shrinkY ?? (s.yFloor + s.yTop) * 0.5;
    out.x *= s.shrink;
    out.y = cy + (out.y - cy) * s.shrink;
  }
}

function toneFor(seg: SegTone, band: Band | null): Tone {
  switch (band) {
    case 'sill': return seg.sill;
    case 'low': return seg.low;
    case 'bezelLo': case 'bezelHi': return seg.bezel ?? seg.flank;
    case 'sealLo': case 'sealHi': return seg.seal ?? seg.side;
    case 'side': return seg.side;
    case 'top': return seg.top;
    default: return seg.flank;
  }
}

/** Glass darkens over its top 35 % (a tint band under the roof), like a sun strip: 1 at the belt, 0.45 at the roof. */
function glassShade(y: number, yBelt: number, roofY: number): number {
  const t = clamp((y - yBelt) / Math.max(0.05, roofY - yBelt), 0, 1);
  const f = clamp((t - 0.62) / 0.38, 0, 1);
  return 1 - 0.55 * f * f * (3 - 2 * f);
}

/**
 * The shell: one smooth sheet through every station, coloured per cell so glass, gaskets, lamps and valances are regions
 * of the same surface rather than slabs. Cell order reproduces `surface()` (two triangles a-b-c / b-d-c per cell, rows =
 * stations) and is verified against the sampled positions, so a change to the helper fails loudly here instead of
 * mis-painting.
 */
function loft(stations: Station[], lay: RingLayout): THREE.BufferGeometry {
  const rows = stations.length, cols = lay.ring;
  let roofY = -Infinity;
  for (let i = 0; i < rows; i++) roofY = Math.max(roofY, stations[i].yTop + stations[i].crown);
  const g = surface(rows, cols, true, false, (i, j, out) => {
    ringPoint(stations[i], lay, j, ringPt);
    out.set(ringPt.x, ringPt.y, stations[i].z);
  });
  const pos = g.attributes.position;
  const n = pos.count;
  if (n !== (rows - 1) * cols * 6) throw new Error('vehicle loft: unexpected surface() layout');
  const colors = new Float32Array(n * 3);
  const paints = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = (k / 3) | 0, tri = t & 1, cell = t >> 1, i = (cell / cols) | 0, j = cell % cols, corner = k % 3;
    const far = tri === 0 ? corner === 2 : corner !== 0;
    const nextJ = tri === 0 ? corner === 1 : corner !== 2;
    const gi = far ? i + 1 : i, gj = nextJ ? (j + 1) % cols : j;
    ringPoint(stations[gi], lay, gj, ringPt);
    if (Math.abs(pos.getX(k) - ringPt.x) > 1e-5 || Math.abs(pos.getY(k) - ringPt.y) > 1e-5 || Math.abs(pos.getZ(k) - stations[gi].z) > 1e-5) {
      throw new Error('vehicle loft: surface() cell order changed');
    }
    const seg = stations[i].seg;
    const band = cellBand(lay, j);
    let tone: Tone = toneFor(seg, band);
    if (band === 'flank' && seg.lens && (seg.lens.at === 1) === far) tone = seg.lens.tone;
    authorColor.setHex(tone.col);
    const shadeK = tone === T.glass ? glassShade(ringPt.y, stations[gi].yBelt, roofY) : 1;
    colors[k * 3] = authorColor.r * shadeK; colors[k * 3 + 1] = authorColor.g * shadeK; colors[k * 3 + 2] = authorColor.b * shadeK;
    paints[k] = tone.paint;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('paintMix', new THREE.BufferAttribute(paints, 1));
  return g;
}

/** Outer half-width of the shell at (y, z), interpolated between the two full stations around z. */
function shellWidth(stations: Station[], y: number, z: number): number {
  let a: Station | null = null, b: Station | null = null;
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    if (s.shrink !== undefined) continue;
    if (s.z <= z) a = s;
    if (s.z >= z && !b) b = s;
  }
  if (!a) a = b; if (!b) b = a;
  if (!a || !b) return 0;
  const wa = ringWidth(a, y), wb = ringWidth(b, y);
  const t = b.z > a.z ? clamp((z - a.z) / (b.z - a.z), 0, 1) : 0;
  return wa + (wb - wa) * t;
}
const ringA = { x: 0, y: 0 }, ringB = { x: 0, y: 0 };
function ringWidth(s: Station, y: number): number {
  const half = FULL_RING.half;
  pointOfKind(s, half[1], ringA);
  for (let k = 2; k < half.length; k++) {
    pointOfKind(s, half[k], ringB);
    if (y <= ringB.y) {
      const t = clamp((y - ringA.y) / Math.max(1e-4, ringB.y - ringA.y), 0, 1);
      return ringA.x + (ringB.x - ringA.x) * t;
    }
    ringA.x = ringB.x; ringA.y = ringB.y;
  }
  return ringA.x;
}

// ---------------------------------------------------------------------------------------------- per-spec profiles

interface Anchor { x: number; y: number; z: number; w: number; h: number; sweep: number }
/** Half-cylinder wheel arch over one axle (mirrored across x): tube radius, axle x/z and outboard half-width. */
interface ArchDef { x: number; z: number; r: number; w: number; /** x of the black well backing, just proud of the flank. */ wellX: number }
interface VehicleProfile {
  stations: Station[];
  parts: PrismDef[];
  /** Sculpted extras (lamp bezels, bumper strip) merged with the parts. */
  extras: THREE.BufferGeometry[];
  arches: ArchDef[];
  /** Exhaust tube anchor: x, y and the bumper face z it pokes out of. */
  exhaust: { x: number; y: number; zFace: number };
  head: Anchor;
  tail: Anchor;
  /** Roof lamps: police lightbar halves, or the taxi sign faces. */
  roof: Anchor;
  roofKind: 'siren' | 'sign' | 'none';
  wheelScale: number;
  shadowW: number;
  shadowL: number;
  /** Shading ramp: vertices darken from `belt` down to `floor` (sills / lower doors sit in the car's own shadow). */
  floor: number;
  belt: number;
}

/** Wheel arches: one fender definition per axle (mirrored across x when the geometry is built). */
function arches(archOut: ArchDef[], width: (y: number, z: number) => number, wheelX: number, wheelZ: number, r: number, wide: number): void {
  const ar = r * ARCH_R, y = VEHICLE_RENDER.wheelRadius;
  for (let i = 0; i < 2; i++) {
    const z = i === 0 ? wheelZ : -wheelZ;
    // The backing sits 6 mm outside the widest bit of flank inside the arch circle (the flank leans out toward the belt).
    let wellX = 0;
    for (let k = -2; k <= 2; k++) wellX = Math.max(wellX, width(y + ar * 0.98, z + ar * 0.45 * k), width(y + ar * 0.6, z + ar * 0.45 * k));
    archOut.push({ x: wheelX, z, r: ar, w: wide, wellX: wellX + 0.006 });
  }
}
/** Arch opening radius over the tyre radius (real cars sit around 1.15-1.25; anything bigger reads as a toy). */
const ARCH_R = 1.22;
const ARCH_SEG = 16;
/** Arch lip face this far inside the spec width: 2 cm proud of the widest flank, a real fender flare. */
const ARCH_INSET = 0.025;

/**
 * Builds one arch fender: a painted open half-tube with an annular lip on the outboard end, a black inward-facing
 * half-tube just inside it and a black half-disc backing proud of the flank, so the arch reads as a dark wheel well cut
 * into the body (the lofted shell itself has no hole) with the rim standing in front of it.
 */
function archGeometry(a: ArchDef, side: number): THREE.BufferGeometry[] {
  const y = VEHICLE_RENDER.wheelRadius;
  const tube = new THREE.CylinderGeometry(a.r, a.r, a.w * 2, ARCH_SEG, 1, true, 0, Math.PI);
  tube.rotateZ(Math.PI / 2); // axis along x, open half facing +y
  tube.translate(side * a.x, y, a.z);
  const lip = new THREE.RingGeometry(a.r * 0.86, a.r, ARCH_SEG, 1, 0, Math.PI);
  lip.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2); // face outboard
  lip.translate(side * (a.x + a.w), y, a.z);
  const well = new THREE.CylinderGeometry(a.r * 0.97, a.r * 0.97, a.w * 2, ARCH_SEG, 1, true, 0, Math.PI);
  well.scale(1, 1, -1); // mirror flips the winding: the visible face is now the inside of the tube
  const wn = well.attributes.normal;
  for (let i = 0; i < wn.count; i++) wn.setXYZ(i, -wn.getX(i), -wn.getY(i), -wn.getZ(i));
  well.rotateZ(Math.PI / 2);
  well.translate(side * a.x, y, a.z);
  const back = new THREE.CircleGeometry(a.r * 0.99, ARCH_SEG, 0, Math.PI);
  back.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2); // face outboard
  back.translate(side * a.wellX, y, a.z);
  return [decorate(tube, PAINT_DARK, 1), decorate(lip, PAINT_DARK, 1), decorate(well, BLACK, 0), decorate(back, BLACK, 0)];
}

/** Segment tones of the end faces and their wraps onto the flanks: a dark bezel above and below every lens cell. */
// The `low` band (sill to lower flank) is the bumper: PAINT_SHADE, so it reads as a separate moulded part under the
// lamp clusters and the boot / bonnet, with the dark bezel band above it as the seam.
const REAR_WRAP: SegTone = { ...BODY, flank: T.tail, bezel: T.bezel, low: T.shade, sill: T.black };
const REAR_FACE: SegTone = { sill: T.black, low: T.shade, flank: T.tail, bezel: T.bezel, lens: { at: 0, tone: T.tailLens }, side: T.paint, top: T.paint };
const FRONT_WRAP: SegTone = { ...BODY, flank: T.lamp, bezel: T.bezel, low: T.shade, sill: T.black };
const FRONT_FACE: SegTone = { sill: T.black, low: T.shade, flank: T.lamp, bezel: T.bezel, lens: { at: 1, tone: T.lampLens }, side: T.paint, top: T.paint };
/** End-face fan (shrunk ring to the centre point): the bumper band and the black sill continue across the middle. */
const FAN: SegTone = { sill: T.black, low: T.shade, flank: T.dark, bezel: T.bezel, side: T.dark, top: T.dark };

/**
 * Light quad anchored on a lamp cluster: centred on the flank band of the end face, a hair in front of the swept face
 * (which runs from the outer ring at `outer.z` to the shrunk ring at `inner.z`), yawed to follow that sweep.
 */
function lampAnchor(outer: Station, inner: Station, dir: number, w: number, h: number): Anchor {
  const k = inner.shrink ?? 0.5, cy = inner.shrinkY ?? 0;
  const xo = outer.wBelt, xi = outer.wBelt * k;
  const yo = (outer.yLow + outer.yBelt) * 0.5, yi = cy + (yo - cy) * k;
  const zMid = (outer.z + inner.z) * 0.5;
  return { x: (xo + xi) * 0.5, y: (yo + yi) * 0.5, z: zMid + dir * 0.035, w, h, sweep: Math.atan2(Math.abs(inner.z - outer.z), xo - xi) };
}

/**
 * Lamp bezel: a dark frame 1.6 cm proud of the swept lamp face with a lens plate standing another 1.4 cm out of it,
 * both yawed to follow the face like the light quad, which sits just in front of the plate. From outside the lamp is
 * a bevelled cluster (frame, lens rim, lit face) instead of a flat rectangle; the plate is a lens (LENS_MIX), so it
 * glows around the quad when the lights are on.
 */
function lampBevel(a: Anchor, dir: 1 | -1, lensCol: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let side = -1; side <= 1; side += 2) {
    const fw = a.w * 1.28, fh = a.h * 1.45, lw = a.w * 1.1, lh = a.h * 1.16;
    const frame = new THREE.BoxGeometry(fw, fh, 0.016);
    frame.translate(0, 0, dir * 0.008);
    const lens = new THREE.BoxGeometry(lw, lh, 0.02);
    lens.translate(0, 0, dir * 0.022);
    for (const g of [frame, lens]) {
      g.rotateY(dir * side * a.sweep);
      g.translate(side * a.x, a.y, a.z - dir * 0.03);
    }
    out.push(decorate(frame, BEZEL, 0), decorate(lens, lensCol, LENS_MIX));
  }
  return out;
}

const stripT = new THREE.Vector3(), stripN = new THREE.Vector3(), stripB = new THREE.Vector3();

/**
 * Rear bumper strip: a 1.2 cm rubbing strip swept across the tail 1 cm proud of the fanned end face, so the rear gets
 * the horizontal bumper line a flat loft cannot give it. `faceZ(x)` returns the depth of the end face at half-width x.
 */
function bumperStrip(faceZ: (x: number) => number, y: number, halfW: number): THREE.BufferGeometry {
  const n = 9, pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const x = -halfW + (2 * halfW * i) / (n - 1);
    pts.push(new THREE.Vector3(x, y, faceZ(x) - 0.012));
  }
  const radial = 6, r = 0.012;
  const g = surface(n, radial, true, true, (i, j, out) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    stripT.subVectors(b, a).normalize();
    stripN.crossVectors(stripT, stripB.set(0, 1, 0)).normalize();
    stripB.crossVectors(stripT, stripN);
    const ang = (j / radial) * Math.PI * 2;
    out.copy(pts[i]).addScaledVector(stripN, Math.sin(ang) * r).addScaledVector(stripB, Math.cos(ang) * r);
  });
  return decorate(g, BUMPER_STRIP, 0);
}

/**
 * Depth of a fanned end face at half-width x: linear from the outer ring (`zOuter`, half-width `wOuter`) through the
 * shrunk ring (`zMid`, at `kMid` of the width) to the apex (`zApex`).
 */
function fanDepth(zOuter: number, wOuter: number, zMid: number, kMid: number, zApex: number): (x: number) => number {
  return (x: number): number => {
    const f = Math.min(1, Math.abs(x) / Math.max(1e-4, wOuter));
    if (f >= kMid) return zMid + (zOuter - zMid) * ((f - kMid) / (1 - kMid));
    return zApex + (zMid - zApex) * (f / kMid);
  };
}

/**
 * Rear screen stations between the deck station (`base`, top band = frit) and the roof station at `roofZ`: a 3 cm frit
 * band, two glass segments meeting at a station bulged `bulge` above the straight line (so the screen curves), and the
 * 3 cm frit band under the roof. `wTop` and `edge`/`crown` are interpolated between the two ends.
 */
function rearScreen(out: Station[], base: Station, roofZ: number, roofY: number, roofW: number, roofEdge: number, roofCrown: number, bulge: number): void {
  const z0 = base.z, z1 = roofZ, y0 = base.yTop, y1 = roofY;
  const at = (z: number, lift: number, seg: SegTone, extra: StationOpts): Station => {
    const t = (z - z0) / (z1 - z0);
    return station(z, base.yFloor, y0 + (y1 - y0) * t + lift, base.wTop + (roofW - base.wTop) * t, base.yBelt, base.wBelt, {
      wFloor: base.wFloor, yLow: base.yLow, wLow: base.wLow, edge: base.edge + (roofEdge - base.edge) * t, crown: base.crown + (roofCrown - base.crown) * t, seg, ...extra,
    });
  };
  out.push(at(z0 + SEAL_W, 0, SCREEN, { topInset: GLASS_INSET, lod: true }));
  out.push(at((z0 + z1) * 0.5, bulge, SCREEN, { topInset: GLASS_INSET }));
  out.push(at(z1 - SEAL_W, 0, SCREEN_EDGE, {}));
}

/** Three-box saloon: sloped bonnet, raked glasshouse, boot lip. Shared by sedan / police / taxi. */
function sedanProfile(s: VehicleSpec, kind: 'sedan' | 'police' | 'taxi'): VehicleProfile {
  const L = s.length, hl = L / 2, hw = s.width / 2, H = s.height;
  const c = VEHICLE_RENDER.clearance;
  const belt = H * 0.62;
  const roof = H - 0.03;
  const wz = s.wheelbase / 2;
  const wx = hw - VEHICLE_RENDER.wheelWidth * 0.5 + WHEEL_INSET;
  const hp = hw * PLAN;
  const IN = GLASS_INSET;
  const parts: PrismDef[] = [];
  const archDefs: ArchDef[] = [];
  // End faces shrink about lamp height, so the clusters stay level and the bumper below leans out under them.
  const yCRear = belt - 0.07, yCFront = belt - 0.22;
  // Side silhouette rear -> front: boot lip, rear screen, roof, windscreen, cowl, bonnet, nose; plan curve widest at the B pillar.
  const rear = station(-hl, c, belt + 0.10, hp * 0.74, belt + 0.04, hp * 0.86, { yFloor: c + 0.03, wFloor: hp * 0.78, yLow: belt - 0.17, wLow: hp * 0.85, edge: 0.025, crown: 0.01, seg: REAR_WRAP, lod: true });
  const nose = station(hl - 0.05, c, belt - 0.10, hp * 0.62, belt - 0.13, hp * 0.83, { yFloor: c + 0.03, wFloor: hp * 0.76, yLow: belt - 0.30, wLow: hp * 0.83, edge: 0.03, crown: 0.01, seg: FRONT_FACE, lod: true });
  const cowlZ = L * 0.145, roofFrontZ = -0.02, roofRearZ = -L * 0.215, screenBaseZ = -L * 0.31;
  const deck = station(screenBaseZ, c, belt + 0.10, hp * 0.72, belt + 0.025, hp * 0.95, { edge: 0.02, crown: 0.01, seg: SCREEN_EDGE });
  const stations: Station[] = [
    shrunk(rear, -hl - 0.07, 0, yCRear, FAN, true),
    shrunk(rear, -hl - 0.05, 0.5, yCRear, REAR_FACE, true),
    rear,
    station(-hl + 0.24, c, belt + 0.115, hp * 0.76, belt + 0.035, hp * 0.925, { wFloor: hp * 0.86, yLow: belt - 0.17, wLow: hp * 0.91, edge: 0.03, crown: 0.015, lod: true }),
    deck,
  ];
  rearScreen(stations, deck, roofRearZ, roof, hp * 0.72, 0.05, 0.025, 0.03);
  stations.push(
    station(roofRearZ, c, roof, hp * 0.72, belt + 0.015, hp * 0.94, { edge: 0.05, crown: 0.025, seg: GLAZED, inset: IN, lod: true }),
    station(-0.27, c, roof, hp * 0.73, belt + 0.005, hp * 0.945, { edge: 0.05, crown: 0.025, seg: B_PILLAR, inset: IN }),
    station(-0.18, c, roof, hp * 0.73, belt + 0.005, hp * 0.945, { edge: 0.05, crown: 0.025, seg: GLAZED, inset: IN }),
    station(roofFrontZ - SEAL_W, c, roof - 0.005, hp * 0.71, belt, hp * 0.94, { edge: 0.05, crown: 0.025, seg: GLAZED_SCREEN_EDGE, inset: IN }),
    station(roofFrontZ, c, roof - 0.01, hp * 0.71, belt, hp * 0.94, { edge: 0.05, crown: 0.025, seg: GLAZED_SCREEN, inset: IN, topInset: IN, lod: true }),
    station(0.33, c, belt + 0.29, hp * 0.75, belt - 0.005, hp * 0.945, { edge: 0.04, crown: 0.01, seg: GLAZED_SCREEN, inset: IN, topInset: IN }),
    station(cowlZ - SEAL_W, c, belt + 0.105, hp * 0.78, belt - 0.012, hp * 0.93, { edge: 0.03, crown: 0.01, seg: SCREEN_EDGE, topInset: IN * 0.5 }),
    station(cowlZ, c, belt + 0.085, hp * 0.78, belt - 0.012, hp * 0.93, { edge: 0.03, crown: 0.01, lod: true }),
    station(1.45, c, belt + 0.02, hp * 0.70, belt - 0.04, hp * 0.90, { edge: 0.04, crown: 0.02, bulge: 0.03 }),
    station(hl - 0.30, c, belt - 0.05, hp * 0.66, belt - 0.09, hp * 0.87, { wFloor: hp * 0.80, yLow: belt - 0.28, wLow: hp * 0.86, edge: 0.04, crown: 0.015, seg: FRONT_WRAP, lod: true }),
    nose,
    shrunk(nose, hl + 0.05, 0.5, yCFront, FAN, true),
    shrunk(nose, hl + 0.06, 0, yCFront, FAN, true),
  );
  const width = (y: number, z: number): number => shellWidth(stations, y, z);
  // A pillars (raked posts over the quarter glass), rocker strip, door shut lines, bonnet gap.
  pillar(parts, cowlZ + 0.02, width(belt, cowlZ), belt - 0.01, roofFrontZ + 0.03, hp * 0.71, roof - 0.055);
  flankStrip(parts, width, -L * 0.33, L * 0.33, c + 0.02, c + 0.15, 0.010, 0.04, DARK, 0.25);
  shutLine(parts, L * 0.13, width(c + 0.17, L * 0.13), c + 0.17, width(belt - 0.02, L * 0.13), belt - 0.02);
  shutLine(parts, -L * 0.19, width(c + 0.17, -L * 0.19), c + 0.17, width(belt - 0.02, -L * 0.19), belt - 0.02);
  parts.push({ ...block(cowlZ + 0.02, cowlZ + 0.036, hw * 0.76, belt + 0.05, belt + 0.10, BLACK, 0), plain: true });
  arches(archDefs, width, wx, wz, VEHICLE_RENDER.wheelRadius, hw - ARCH_INSET - wx);
  // Grille, plates, mirrors, handles.
  parts.push({ ...block(hl + 0.03, hl + 0.075, hw * 0.36, c + 0.25, belt - 0.19, BLACK, 0), plain: true });
  plate(parts, hl + 0.04, hl + 0.085, hw * 0.18, c + 0.08, c + 0.19);
  rearDetails(parts, -hl - 0.07, c + 0.31);
  mirror(parts, cowlZ - 0.20, cowlZ - 0.06, width(belt + 0.02, cowlZ - 0.13), belt + 0.01, 0.11, 0.05);
  handle(parts, -L * 0.03, L * 0.04, width(belt - 0.11, 0), belt - 0.11);
  handle(parts, -L * 0.34, -L * 0.27, width(belt - 0.11, -L * 0.3), belt - 0.11);

  const head = lampAnchor(nose, stations[stations.length - 2], 1, 0.22, 0.09);
  const tail = lampAnchor(rear, stations[1], -1, 0.24, 0.10);
  const extras = [...lampBevel(head, 1, LAMP_LENS), ...lampBevel(tail, -1, TAIL_LENS)];
  extras.push(bumperStrip(fanDepth(-hl, rear.wLow, -hl - 0.05, 0.5, -hl - 0.07), rear.yLow + 0.045, rear.wLow * 0.9));
  const profile: VehicleProfile = {
    stations,
    parts,
    extras,
    arches: archDefs,
    exhaust: { x: hw * 0.55, y: c + 0.01, zFace: -hl - 0.07 },
    head,
    tail,
    roof: { x: 0, y: H, z: 0, w: 0.3, h: 0.12, sweep: 0 },
    roofKind: 'none',
    wheelScale: 1,
    shadowW: hw * 1.55,
    shadowL: hl * 1.14,
    floor: c,
    belt,
  };

  if (kind === 'police') {
    // Bull bar, roof lightbar housing and a blue side flash fitted to the shell (the upper flash ends on the flush C
    // pillar, before the glass steps in).
    pair(parts, { ...block(hl + 0.06, hl + 0.18, hw * 0.08, c + 0.10, belt - 0.06, DARK, 0, hw * 0.40), plain: true });
    parts.push({ ...block(hl + 0.08, hl + 0.17, hw * 0.50, belt - 0.26, belt - 0.14, DARK, 0), plain: true });
    parts.push({ ...block(-L * 0.05, L * 0.05, hw * 0.46, roof + 0.01, roof + 0.12, BLACK, 0), plain: true });
    flankStrip(parts, width, -L * 0.30, L * 0.24, belt - 0.30, belt - 0.10, 0.006, 0.05, POLICE_BLUE, 0);
    flankStrip(parts, width, -L * 0.29, roofRearZ - SEAL_W, belt + 0.02, roof - 0.10, 0.006, 0.05, POLICE_BLUE, 0);
    profile.roof = { x: 0.24, y: roof + 0.065, z: 0.03, w: 0.3, h: 0.12, sweep: 0 };
    profile.roofKind = 'siren';
  } else if (kind === 'taxi') {
    // Roof sign box + a dark chequer band along the doors.
    parts.push({
      bz0: -L * 0.03, bz1: L * 0.05, bw0: hw * 0.34, bw1: hw * 0.34, by0: roof + 0.01,
      tz0: -L * 0.02, tz1: L * 0.04, tw0: hw * 0.30, tw1: hw * 0.30, ty0: roof + 0.21, col: SIGN, paint: 0,
    });
    flankStrip(parts, width, -L * 0.32, L * 0.30, belt - 0.30, belt - 0.16, 0.006, 0.05, BLACK, 0);
    profile.roof = { x: 0, y: roof + 0.12, z: L * 0.045, w: 0.46, h: 0.15, sweep: 0 };
    profile.roofKind = 'sign';
  }
  return profile;
}

/** Low, wide wedge: long bonnet, cab-back glasshouse, fastback rear screen into a high Kamm tail with a wing. */
function sportProfile(s: VehicleSpec): VehicleProfile {
  const L = s.length, hl = L / 2, hw = s.width / 2, H = s.height;
  const c = VEHICLE_RENDER.clearance - 0.05;
  const belt = H * 0.58;
  const roof = H - 0.03;
  const wz = s.wheelbase / 2;
  const wx = hw - VEHICLE_RENDER.wheelWidth * 0.5 + WHEEL_INSET;
  const hp = hw * PLAN;
  const IN = GLASS_INSET;
  const parts: PrismDef[] = [];
  const archDefs: ArchDef[] = [];
  const yCRear = belt + 0.01, yCFront = belt - 0.22;
  const rear = station(-hl, c, belt + 0.17, hp * 0.80, belt + 0.07, hp * 0.90, { yFloor: c + 0.03, wFloor: hp * 0.84, yLow: belt - 0.06, wLow: hp * 0.89, edge: 0.03, crown: 0, seg: REAR_WRAP, lod: true });
  const nose = station(hl - 0.05, c, belt - 0.14, hp * 0.60, belt - 0.16, hp * 0.84, { yFloor: c + 0.03, wFloor: hp * 0.78, yLow: belt - 0.27, wLow: hp * 0.84, edge: 0.02, crown: 0.01, seg: FRONT_FACE, lod: true });
  const cowlZ = 0.58, roofFrontZ = -0.12, roofRearZ = -0.55, deckZ = -1.30;
  const deck = station(deckZ, c, belt + 0.17, hp * 0.78, belt + 0.045, hp * 0.945, { edge: 0.02, crown: 0.005, seg: SCREEN_EDGE });
  const stations: Station[] = [
    shrunk(rear, -hl - 0.06, 0, yCRear, FAN, true),
    shrunk(rear, -hl - 0.045, 0.5, yCRear, REAR_FACE, true),
    rear,
    station(-hl + 0.28, c, belt + 0.19, hp * 0.82, belt + 0.06, hp * 0.95, { wFloor: hp * 0.88, yLow: belt - 0.06, wLow: hp * 0.94, edge: 0.03, crown: 0.005, lod: true }),
    deck,
  ];
  rearScreen(stations, deck, roofRearZ, roof, hp * 0.70, 0.05, 0.02, 0.035);
  stations.push(
    station(roofRearZ, c, roof, hp * 0.70, belt + 0.025, hp * 0.95, { edge: 0.05, crown: 0.02, seg: GLAZED, inset: IN, lod: true }),
    station(roofFrontZ - SEAL_W, c, roof - 0.005, hp * 0.69, belt + 0.01, hp * 0.945, { edge: 0.05, crown: 0.02, seg: GLAZED_SCREEN_EDGE, inset: IN }),
    station(roofFrontZ, c, roof - 0.01, hp * 0.69, belt + 0.01, hp * 0.945, { edge: 0.05, crown: 0.02, seg: GLAZED_SCREEN, inset: IN, topInset: IN, lod: true }),
    station(0.25, c, belt + 0.30, hp * 0.74, belt, hp * 0.94, { edge: 0.04, crown: 0.01, seg: GLAZED_SCREEN, inset: IN, topInset: IN }),
    station(cowlZ - SEAL_W, c, belt + 0.105, hp * 0.78, belt - 0.015, hp * 0.94, { edge: 0.03, crown: 0.01, seg: SCREEN_EDGE, topInset: IN * 0.5 }),
    station(cowlZ, c, belt + 0.085, hp * 0.78, belt - 0.015, hp * 0.94, { edge: 0.03, crown: 0.01, lod: true }),
    station(1.40, c, belt - 0.01, hp * 0.70, belt - 0.06, hp * 0.91, { edge: 0.04, crown: 0.02, bulge: 0.03 }),
    station(hl - 0.32, c, belt - 0.08, hp * 0.66, belt - 0.12, hp * 0.88, { wFloor: hp * 0.82, yLow: belt - 0.24, wLow: hp * 0.87, edge: 0.03, crown: 0.015, seg: FRONT_WRAP, lod: true }),
    nose,
    shrunk(nose, hl + 0.045, 0.5, yCFront, FAN, true),
    shrunk(nose, hl + 0.055, 0, yCFront, FAN, true),
  );
  const width = (y: number, z: number): number => shellWidth(stations, y, z);
  pillar(parts, cowlZ + 0.02, width(belt + 0.01, cowlZ), belt, roofFrontZ + 0.03, hp * 0.69, roof - 0.055);
  // Wing on two dark uprights, boot shut line, single long door, rocker, bonnet gap, grille, plates, mirrors, handle.
  pair(parts, { ...block(-hl - 0.02, -hl + 0.16, hw * 0.06, belt + 0.14, belt + 0.30, DARK, 0, hw * 0.56), plain: true });
  parts.push({ ...block(-hl - 0.06, -hl + 0.18, hw * 0.90, belt + 0.30, belt + 0.36, PAINT_SHADE, 1), tailTaper: 0.12 });
  parts.push({ ...block(deckZ + 0.02, deckZ + 0.036, hw * 0.76, belt + 0.14, belt + 0.20, BLACK, 0), plain: true });
  shutLine(parts, L * 0.02, width(c + 0.15, L * 0.02), c + 0.15, width(belt - 0.02, L * 0.02), belt - 0.02);
  flankStrip(parts, width, -L * 0.35, L * 0.35, c + 0.02, c + 0.13, 0.010, 0.04, BLACK, 0.2);
  arches(archDefs, width, wx, wz, VEHICLE_RENDER.wheelRadius * 1.08, hw - ARCH_INSET - wx);
  parts.push({ ...block(cowlZ + 0.02, cowlZ + 0.036, hw * 0.78, belt + 0.05, belt + 0.10, BLACK, 0), plain: true });
  parts.push({ ...block(hl + 0.03, hl + 0.07, hw * 0.44, c + 0.16, belt - 0.24, BLACK, 0), plain: true });
  plate(parts, hl + 0.035, hl + 0.08, hw * 0.18, c + 0.05, c + 0.15);
  rearDetails(parts, -hl - 0.06, c + 0.26);
  mirror(parts, cowlZ - 0.20, cowlZ - 0.07, width(belt + 0.02, cowlZ - 0.13), belt + 0.01, 0.09, 0.045);
  handle(parts, -L * 0.14, -L * 0.07, width(belt - 0.10, -L * 0.1), belt - 0.10);
  const head = lampAnchor(nose, stations[stations.length - 2], 1, 0.24, 0.07);
  const tail = lampAnchor(rear, stations[1], -1, 0.34, 0.07);
  const extras = [...lampBevel(head, 1, LAMP_LENS), ...lampBevel(tail, -1, TAIL_LENS)];
  extras.push(bumperStrip(fanDepth(-hl, rear.wLow, -hl - 0.045, 0.5, -hl - 0.06), rear.yLow + 0.04, rear.wLow * 0.9));
  return {
    stations,
    parts,
    extras,
    arches: archDefs,
    exhaust: { x: hw * 0.50, y: c + 0.01, zFace: -hl - 0.06 },
    head,
    tail,
    roof: { x: 0, y: H, z: 0, w: 0.3, h: 0.12, sweep: 0 },
    roofKind: 'none',
    wheelScale: 1.08,
    shadowW: hw * 1.55,
    shadowL: hl * 1.14,
    floor: c,
    belt,
  };
}

/** Tall one-box van: flat cargo body, steep windscreen over a short snout. */
function vanProfile(s: VehicleSpec): VehicleProfile {
  const L = s.length, hl = L / 2, hw = s.width / 2, H = s.height;
  const c = VEHICLE_RENDER.clearance;
  const belt = H * 0.5;
  const roof = H - 0.04;
  const wz = s.wheelbase / 2;
  const wx = hw - VEHICLE_RENDER.wheelWidth * 0.5 + WHEEL_INSET;
  const noseZ = L * 0.28;
  const hp = hw * PLAN;
  const IN = GLASS_INSET;
  const parts: PrismDef[] = [];
  const archDefs: ArchDef[] = [];
  const rear = station(-hl, c, roof - 0.02, hp * 0.86, belt + 0.02, hp * 0.92, { yFloor: c + 0.04, wFloor: hp * 0.86, yLow: belt - 0.32, wLow: hp * 0.91, edge: 0.05, crown: 0.02, seg: REAR_WRAP, lod: true });
  const nose = station(hl - 0.05, c, belt - 0.06, hp * 0.70, belt - 0.11, hp * 0.84, { yFloor: c + 0.04, wFloor: hp * 0.78, yLow: belt - 0.30, wLow: hp * 0.84, edge: 0.03, crown: 0.01, seg: FRONT_FACE, lod: true });
  const cowlZ = noseZ + 0.16, roofFrontZ = noseZ - 0.28, bPillarZ = noseZ - 1.02;
  const stations: Station[] = [
    shrunk(rear, -hl - 0.05, 0, belt - 0.15, FAN, true),
    shrunk(rear, -hl - 0.04, 0.72, belt - 0.15, REAR_FACE, true),
    rear,
    station(-hl + 0.22, c, roof, hp * 0.88, belt + 0.02, hp * 0.95, { wFloor: hp * 0.88, yLow: belt - 0.32, wLow: hp * 0.94, edge: 0.05, crown: 0.02, lod: true }),
    station(bPillarZ, c, roof, hp * 0.88, belt + 0.01, hp * 0.95, { wFloor: hp * 0.88, edge: 0.05, crown: 0.02, seg: B_PILLAR, inset: IN }),
    station(bPillarZ + 0.08, c, roof, hp * 0.88, belt + 0.01, hp * 0.95, { wFloor: hp * 0.88, edge: 0.05, crown: 0.02, seg: GLAZED, inset: IN, lod: true }),
    station(roofFrontZ - SEAL_W, c, roof - 0.005, hp * 0.87, belt, hp * 0.95, { wFloor: hp * 0.88, edge: 0.05, crown: 0.02, seg: GLAZED_SCREEN_EDGE, inset: IN }),
    station(roofFrontZ, c, roof - 0.01, hp * 0.87, belt, hp * 0.95, { wFloor: hp * 0.88, edge: 0.05, crown: 0.02, seg: GLAZED_SCREEN, inset: IN, topInset: IN, lod: true }),
    station(noseZ - 0.04, c, belt + 0.54, hp * 0.88, belt - 0.01, hp * 0.94, { edge: 0.04, crown: 0.01, seg: SCREEN, topInset: IN }),
    station(cowlZ - SEAL_W, c, belt + 0.166, hp * 0.86, belt - 0.02, hp * 0.93, { edge: 0.03, crown: 0.01, seg: SCREEN_EDGE, topInset: IN * 0.5 }),
    station(cowlZ, c, belt + 0.10, hp * 0.86, belt - 0.02, hp * 0.93, { edge: 0.03, crown: 0.01, lod: true }),
    station(hl - 0.32, c, belt - 0.02, hp * 0.78, belt - 0.08, hp * 0.88, { wFloor: hp * 0.82, yLow: belt - 0.28, wLow: hp * 0.87, edge: 0.04, crown: 0.02, seg: FRONT_WRAP, lod: true }),
    nose,
    shrunk(nose, hl + 0.05, 0.5, belt - 0.20, FAN, true),
    shrunk(nose, hl + 0.06, 0, belt - 0.20, FAN, true),
  ];
  const width = (y: number, z: number): number => shellWidth(stations, y, z);
  pillar(parts, cowlZ + 0.02, width(belt, cowlZ), belt - 0.01, roofFrontZ + 0.03, hp * 0.87, roof - 0.055);
  // Bonnet gap, sliding door shut lines, rear door seam + windows (glass in a dark frame), rocker.
  parts.push({ ...block(cowlZ + 0.02, cowlZ + 0.036, hw * 0.80, belt + 0.06, belt + 0.11, BLACK, 0), plain: true });
  shutLine(parts, bPillarZ + 0.02, width(c + 0.20, bPillarZ), c + 0.20, width(roof - 0.12, bPillarZ), roof - 0.12);
  shutLine(parts, -L * 0.22, width(c + 0.20, -L * 0.22), c + 0.20, width(roof - 0.12, -L * 0.22), roof - 0.12);
  parts.push({ ...block(-hl - 0.055, -hl + 0.03, hw * 0.02, c + 0.20, roof - 0.14, BLACK, 0), plain: true });
  pair(parts, { ...block(-hl - 0.05, -hl + 0.02, hw * 0.27, H * 0.605, H * 0.855, SEAL, 0, hw * 0.30), plain: true });
  pair(parts, { ...block(-hl - 0.055, -hl + 0.02, hw * 0.24, H * 0.62, H * 0.84, GLASS, 0, hw * 0.30), plain: true });
  flankStrip(parts, width, -L * 0.36, L * 0.20, c + 0.04, c + 0.17, 0.010, 0.04, DARK, 0.25);
  arches(archDefs, width, wx, wz, VEHICLE_RENDER.wheelRadius * 1.12, hw - ARCH_INSET - wx);
  parts.push({ ...block(hl + 0.03, hl + 0.075, hw * 0.42, c + 0.30, belt - 0.20, BLACK, 0), plain: true });
  plate(parts, hl + 0.04, hl + 0.085, hw * 0.18, c + 0.10, c + 0.21);
  rearDetails(parts, -hl - 0.05, c + 0.38);
  // Big mirrors on arms, cab and sliding-door handles.
  mirror(parts, cowlZ - 0.34, cowlZ - 0.14, width(belt + 0.20, cowlZ - 0.24), belt + 0.16, 0.20, 0.06);
  handle(parts, noseZ - 0.62, noseZ - 0.54, width(belt - 0.02, noseZ - 0.58), belt - 0.02);
  handle(parts, -L * 0.22 + 0.06, -L * 0.22 + 0.14, width(belt - 0.02, -L * 0.22 + 0.1), belt - 0.02);
  const head = lampAnchor(nose, stations[stations.length - 2], 1, 0.24, 0.10);
  const tail = lampAnchor(rear, stations[1], -1, 0.13, 0.22);
  const extras = [...lampBevel(head, 1, LAMP_LENS), ...lampBevel(tail, -1, TAIL_LENS)];
  extras.push(bumperStrip(fanDepth(-hl, rear.wLow, -hl - 0.04, 0.72, -hl - 0.05), rear.yLow + 0.05, rear.wLow * 0.92));
  return {
    stations,
    parts,
    extras,
    arches: archDefs,
    exhaust: { x: hw * 0.55, y: c + 0.01, zFace: -hl - 0.05 },
    head,
    tail,
    roof: { x: 0, y: H, z: 0, w: 0.3, h: 0.12, sweep: 0 },
    roofKind: 'none',
    wheelScale: 1.12,
    shadowW: hw * 1.55,
    shadowL: hl * 1.14,
    floor: c,
    belt,
  };
}

function profileFor(s: VehicleSpec): VehicleProfile {
  if (s.key === 'sport') return sportProfile(s);
  if (s.key === 'van') return vanProfile(s);
  return sedanProfile(s, s.key === 'police' ? 'police' : s.key === 'taxi' ? 'taxi' : 'sedan');
}

/**
 * Baked tonal structure: the colour attribute is darkened from the belt line down to the floor (sills and lower doors
 * sit in the car's own shadow) and on every downward-facing face. It multiplies the paint tint in the shader, so a
 * yellow taxi keeps a yellow roof and gets a deep-yellow lower body: the value split that makes a low-poly car read.
 */
function bakeShading(g: THREE.BufferGeometry, floor: number, belt: number): void {
  const pos = g.attributes.position, nrm = g.attributes.normal, col = g.attributes.color;
  const n = pos.count;
  const span = Math.max(0.05, belt - floor);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - floor) / span));
    const ramp = 0.70 + 0.30 * t * t * (3 - 2 * t);
    const under = nrm.getY(i) < -0.2 ? 0.55 : 1;
    const k = ramp * under;
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
}

/** Merges a profile's shell, small parts, arch fenders and exhaust into one buffer (position / normal / color / paintMix). */
export function bodyGeometry(s: VehicleSpec): THREE.BufferGeometry {
  const profile = profileFor(s);
  const parts = profile.parts;
  const geos: THREE.BufferGeometry[] = [loft(profile.stations, FULL_RING)];
  for (let i = 0; i < parts.length; i++) geos.push(prism(parts[i]));
  for (let i = 0; i < profile.extras.length; i++) geos.push(profile.extras[i]);
  for (let i = 0; i < profile.arches.length; i++) {
    const a = profile.arches[i];
    geos.push(...archGeometry(a, 1), ...archGeometry(a, -1));
  }
  geos.push(exhaustGeometry(profile.exhaust.x, profile.exhaust.y, profile.exhaust.zFace));
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error('vehicle body merge failed (attribute mismatch)');
  for (let i = 0; i < geos.length; i++) geos[i].dispose();
  bakeShading(merged, profile.floor, profile.belt);
  merged.computeBoundingSphere();
  return merged;
}

/** Hub tone of the parked-car shell's baked wheel discs (matches the lathed wheel's bright dish); the disc edge and tread fall to tyre black. */
const LOD_RIM = 0x9aa0a8;

/**
 * Cheap shell for the static parked cars of the lots: the same loft at the coarse ring through the `lod` stations only
 * (about 300 triangles), no pillars / arches / mirrors, and each wheel a dark 8-sided disc with a lighter rim face
 * instead of a lathed tyre. Same attribute set and paint material as the bodies, so `instanceColor` tints the paint
 * regions and leaves glass and lamps alone. Sits on the ground like a body (floor at `clearance`).
 */
export function parkedShellGeometry(s: VehicleSpec): THREE.BufferGeometry {
  const profile = profileFor(s);
  const stations: Station[] = [];
  for (let i = 0; i < profile.stations.length; i++) if (profile.stations[i].lod) stations.push(profile.stations[i]);
  const geos: THREE.BufferGeometry[] = [loft(stations, LOD_RING)];
  const R = VEHICLE_RENDER;
  const r = R.wheelRadius * profile.wheelScale, w = R.wheelWidth;
  const hw = s.width * 0.5 - w * 0.5 + WHEEL_INSET, hb = s.wheelbase * 0.5;
  for (let k = 0; k < 4; k++) {
    const x = (k % 2 === 0 ? -1 : 1) * hw, z = k < 2 ? hb : -hb;
    const disc = new THREE.CylinderGeometry(r, r, w, 8, 1, false);
    disc.rotateZ(Math.PI / 2); // axle y -> x
    disc.translate(x, r, z);
    // Rim faces: the cap centre vertex carries the bright hub, the cap edge and the tread ring stay tyre-black, so the
    // fan interpolates a bright rim inside a dark tyre like the lathed wheel does at chase distance.
    geos.push(shade(decorate(disc, LOD_RIM, 0), (px, py, pz) => (Math.abs(Math.abs(px - x) - w * 0.5) < 1e-4 && Math.hypot(py - r, pz - z) < r * 0.5 ? 1 : 0.22)));
  }
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error('parked shell merge failed (attribute mismatch)');
  for (let i = 0; i < geos.length; i++) geos[i].dispose();
  for (let i = 0; i < profile.extras.length; i++) profile.extras[i].dispose();
  bakeShading(merged, profile.floor, profile.belt);
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Wheel: a lathed tyre (flat tread, rounded shoulders, sidewall darker than the tread) with its bead standing 3 cm
 * proud of a recessed gunmetal rim: a dish inside the bead, seven thin tapered lathe blades and a small hub cap, merged;
 * one draw call for every wheel in the city. Authored with the axle along y (wheel plane = x/z) and rotated onto x at
 * the end; everything is symmetric about the mid-plane because the same instance geometry serves both sides of the car.
 */
function wheelGeometry(): THREE.BufferGeometry {
  const R = VEHICLE_RENDER;
  const parts: THREE.BufferGeometry[] = [];
  // Bright alloy: at chase distance the blades are sub-pixel and the dish face is what reads, so it is the light part.
  const TYRE = 0x1a1b1e, DISH = 0x9aa0a8, SPOKE = 0xd2d7dd;
  const add = (geo: THREE.BufferGeometry, hex: number, shade?: (x: number, y: number, z: number) => number): void => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    authorColor.setHex(hex);
    const pos = g.attributes.position;
    const n = pos.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const k = shade ? shade(pos.getX(i), pos.getY(i), pos.getZ(i)) : 1;
      colors[i * 3] = authorColor.r * k; colors[i * 3 + 1] = authorColor.g * k; colors[i * 3 + 2] = authorColor.b * k;
    }
    g.rotateZ(Math.PI / 2); // axle y -> x
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    stripUv(g);
    parts.push(g);
  };
  const r = R.wheelRadius, w = R.wheelWidth, hwid = w * 0.5;
  const SEG = 16;
  const rimR = r * 0.55;
  const dishFace = hwid - 0.06; // the dish sits 6 cm inside the tyre bead: a deep rim the blades stand out of
  // Tyre profile (radius, axial offset): bead seat cone -> bead lip -> bulged sidewall -> rounded shoulder -> flat tread,
  // mirrored about y = 0.
  const half = [
    [rimR, dishFace - 0.002], [r * 0.66, hwid - 0.004], [r * 0.82, hwid], [r * 0.95, hwid * 0.84], [r, hwid * 0.42], [r, 0],
  ];
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < half.length; i++) pts.push(new THREE.Vector2(half[i][0], -half[i][1]));
  for (let i = half.length - 2; i >= 0; i--) pts.push(new THREE.Vector2(half[i][0], half[i][1]));
  add(new THREE.LatheGeometry(pts, SEG), TYRE, (x, _y, z) => (Math.hypot(x, z) < r * 0.95 ? 0.72 : 1.1));
  // Rim: a dark dish deep in the bead; on each dish face seven thin tapered plates (2 cm deep, 1.5 cm proud) and a hub
  // cap. Both faces get them because the same instance geometry serves the left and right wheels.
  add(new THREE.CylinderGeometry(rimR, rimR, dishFace * 2, SEG, 1, false), DISH, (_x, y) => (Math.abs(y) < dishFace - 0.001 ? 0.5 : 0.95));
  // A 4-point lathe ring is a diamond; turned 45 degrees and scaled it becomes a flat plate (in-plane width x, depth z).
  const bladeW = r * 0.1, bladeD = 0.02;
  for (let face = -1; face <= 1; face += 2) {
    const zc = face * (dishFace + 0.005);
    const blade: Ring[] = [{ y: r * 0.12, rx: 1, rz: 1, z: zc }, { y: rimR + 0.004, rx: 0.5, rz: 0.8, z: zc }];
    for (let i = 0; i < 7; i++) {
      const g = tube(blade, 4, false, false);
      g.translate(0, 0, -zc);
      g.rotateY(Math.PI / 4);
      g.scale(bladeW / Math.SQRT1_2, 1, bladeD / Math.SQRT1_2);
      g.translate(0, 0, zc);
      g.rotateX(Math.PI / 2); // tube axis y -> radial z, depth z -> axial -y
      g.rotateY((i * Math.PI * 2) / 7);
      add(g, SPOKE, (_x, y) => (y > 0 ? 1 : 0.92));
    }
    const cap = new THREE.CylinderGeometry(r * 0.15, r * 0.15, 0.03, 8, 1, false);
    cap.translate(0, face * (dishFace + 0.012), 0);
    add(cap, SPOKE, () => 0.9);
  }
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('vehicle wheel merge failed (attribute mismatch)');
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  return merged;
}

// ---------------------------------------------------------------------------------------------- paint material

/** Paint look: a smooth metallic base under a hard clearcoat, plus the stylised view-angle rim toward the silhouette. */
const PAINT_LOOK = { metalness: 0.45, roughness: 0.35, envMapIntensity: 1.2, clearcoat: 1.0, clearcoatRoughness: 0.08, rim: 0.32, rimPower: 3.0 } as const;
/** Lit-lens emissive: bright enough by day to read as "on", over the night bloom threshold (1.4) after dark. */
const LENS_GLOW_DAY = 1.2;
const LENS_GLOW_NIGHT = 2.6;

/**
 * Physical + `paintMix`: the per-instance paint colour is blended in only where the geometry asks for it, so glass,
 * bumpers, lamps and liveries keep their authored colour on every car. Shared by the vehicle bodies and the parked
 * shells of the lots (CityRendererProps). The base is a smooth metallic (colour comes from the paint layer) under a
 * hard clearcoat lobe, so the sky probe's horizon crease and sun disc show on the roof and bonnet, and a Fresnel rim
 * brightens the paint toward the silhouette the way stylised low-poly cars are lit. With `lensGlow` the shader also
 * reads a per-instance `instanceGlow` attribute (1 = lights on) and makes the lens cells (paintMix < 0) emissive,
 * scaled by the material's `uLensGlow` uniform (VehicleRenderer.setNightFactor).
 */
export function makeVehiclePaintMaterial(lensGlow = false): THREE.MeshPhysicalMaterial {
  const L = PAINT_LOOK;
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true, metalness: L.metalness, roughness: L.roughness, envMapIntensity: L.envMapIntensity, clearcoat: L.clearcoat, clearcoatRoughness: L.clearcoatRoughness,
  });
  const uLensGlow = { value: 0 };
  m.userData.uLensGlow = uLensGlow;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLensGlow = uLensGlow;
    shader.uniforms.uRim = { value: L.rim };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', [
        '#include <common>',
        'attribute float paintMix;',
        lensGlow ? 'attribute float instanceGlow;' : '',
        'varying float vPaint;',
        'varying float vLens;',
      ].join('\n'))
      // three >= r155 declares vColor as vec4 (see color_pars_vertex), so write through .rgb.
      .replace('#include <color_vertex>', [
        'vColor = vec4( 1.0 );',
        '#ifdef USE_COLOR',
        '  vColor.rgb *= color;',
        '#endif',
        'vPaint = clamp( paintMix, 0.0, 1.0 );',
        lensGlow ? 'vLens = step( paintMix, -0.5 ) * instanceGlow;' : 'vLens = 0.0;',
        '#ifdef USE_INSTANCING_COLOR',
        '  vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, vPaint );',
        '#endif',
      ].join('\n'));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLensGlow;\nuniform float uRim;\nvarying float vPaint;\nvarying float vLens;')
      // Lit lens cells: emissive in their own (lens) colour.
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vLens * uLensGlow;')
      // Fresnel rim on the paint only: view-angle brightening toward the silhouette, tinted a little toward white.
      .replace('#include <opaque_fragment>', [
        '{',
        '  float rimNV = 1.0 - saturate( dot( normalize( normal ), normalize( vViewPosition ) ) );',
        `  float rim = pow( rimNV, ${L.rimPower.toFixed(1)} ) * uRim * vPaint;`,
        '  outgoingLight += mix( diffuseColor.rgb, vec3( 1.0 ), 0.55 ) * rim;',
        '}',
        '#include <opaque_fragment>',
      ].join('\n'));
  };
  m.customProgramCacheKey = () => (lensGlow ? 'vehiclePaintMixGlow' : 'vehiclePaintMix');
  return m;
}

// ---------------------------------------------------------------------------------------------- renderer

export class VehicleRenderer {
  private readonly scene: THREE.Scene;
  private readonly bodies: Record<VehicleKey, THREE.InstancedMesh>;
  /** Far LOD per spec: the parked shell (~450 tris, wheels baked in) instead of the ~2k-tri body; no shadow casting. */
  private readonly lodBodies: Record<VehicleKey, THREE.InstancedMesh>;
  private readonly lodCounts: Record<VehicleKey, number> = { sedan: 0, sport: 0, van: 0, police: 0, taxi: 0 };
  private readonly profiles: Record<VehicleKey, VehicleProfile>;
  private readonly wheels: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;
  private readonly shadows: ContactShadows;
  private readonly bodyMat: THREE.MeshPhysicalMaterial;
  /** Per-instance lights-on flag read by the paint shader (lens emissive), one buffer per body / LOD mesh. */
  private readonly glowAttrs: THREE.InstancedBufferAttribute[] = [];
  private readonly wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.75, envMapIntensity: 1.0 });
  /** Instance colour only: PlaneGeometry has no colour attribute, and `vertexColors` would multiply by a zeroed one. */
  private readonly lightMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: false, toneMapped: false });
  private readonly spotL: THREE.SpotLight;
  private readonly spotR: THREE.SpotLight;
  private readonly counts: Record<VehicleKey, number> = { sedan: 0, sport: 0, van: 0, police: 0, taxi: 0 };
  private readonly interp: Transform = createTransform();
  private readonly mat = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scl = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly color = new THREE.Color();
  private nightFactor = 1;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const cap = BUDGET.MAX_VEHICLES;
    this.bodyMat = makeVehiclePaintMaterial(true);
    this.bodies = {} as Record<VehicleKey, THREE.InstancedMesh>;
    this.lodBodies = {} as Record<VehicleKey, THREE.InstancedMesh>;
    this.profiles = {} as Record<VehicleKey, VehicleProfile>;
    for (let i = 0; i < KEYS.length; i++) {
      const key = KEYS[i];
      this.profiles[key] = profileFor(SPECS[key]);
      const mesh = new THREE.InstancedMesh(this.withGlow(bodyGeometry(SPECS[key]), cap), this.bodyMat, cap);
      mesh.name = `veh:body:${key}`;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.color.setRGB(1, 1, 1);
      for (let k = 0; k < cap; k++) mesh.setColorAt(k, this.color);
      this.bodies[key] = mesh;
      scene.add(mesh);
    }
    for (let i = 0; i < KEYS.length; i++) {
      const key = KEYS[i];
      const lod = new THREE.InstancedMesh(this.withGlow(parkedShellGeometry(SPECS[key]), cap), this.bodyMat, cap);
      lod.name = `veh:lod:${key}`;
      lod.count = 0;
      lod.frustumCulled = false;
      lod.castShadow = false;
      lod.receiveShadow = true;
      lod.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.color.setRGB(1, 1, 1);
      for (let k = 0; k < cap; k++) lod.setColorAt(k, this.color);
      this.lodBodies[key] = lod;
      scene.add(lod);
    }
    this.wheels = new THREE.InstancedMesh(wheelGeometry(), this.wheelMat, cap * VEHICLE_RENDER.wheelsPerVehicle);
    this.wheels.name = 'veh:wheels';
    this.wheels.count = 0;
    this.wheels.frustumCulled = false;
    // No shadow pass for the wheels: the body shadow + contact blob already cover them, and 4 x MAX_VEHICLES instances
    // of the rim would cost more shadow-map triangles than the whole static city.
    this.wheels.castShadow = false;
    this.wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.wheels);
    const lightGeo = new THREE.PlaneGeometry(1, 1);
    this.lights = new THREE.InstancedMesh(lightGeo, this.lightMat, cap * VEHICLE_RENDER.lightsPerVehicle);
    this.lights.name = 'veh:lights';
    this.lights.count = 0;
    this.lights.frustumCulled = false;
    this.lights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.color.setRGB(0.2, 0.2, 0.2);
    for (let k = 0; k < cap * VEHICLE_RENDER.lightsPerVehicle; k++) this.lights.setColorAt(k, this.color);
    scene.add(this.lights);
    this.shadows = new ContactShadows(scene, cap);
    this.spotL = this.makeSpot();
    this.spotR = this.makeSpot();
  }

  /** Adds the `instanceGlow` attribute (lights on/off per instance) the paint shader reads for the lens emissive. */
  private withGlow(g: THREE.BufferGeometry, cap: number): THREE.BufferGeometry {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('instanceGlow', a);
    this.glowAttrs.push(a);
    return g;
  }

  private makeSpot(): THREE.SpotLight {
    const R = VEHICLE_RENDER;
    const s = new THREE.SpotLight(0xfff1d0, 0, R.headlightDistance, R.headlightAngle, R.headlightPenumbra, R.headlightDecay);
    s.castShadow = false;
    this.scene.add(s);
    this.scene.add(s.target);
    return s;
  }

  /** 0 = full day (headlights dimmed), 1 = night. Integrator feeds DayNightSystem.nightFactor(). */
  setNightFactor(f: number): void {
    this.nightFactor = clamp(f, 0, 1);
    this.shadows.setNightFactor(this.nightFactor);
    (this.bodyMat.userData.uLensGlow as { value: number }).value = LENS_GLOW_DAY + (LENS_GLOW_NIGHT - LENS_GLOW_DAY) * this.nightFactor;
  }

  sync(world: World, alpha: number, time: number, camX: number, camZ: number): void {
    const R = VEHICLE_RENDER;
    const list = world.vehicleList;
    const counts = this.counts;
    counts.sedan = 0; counts.sport = 0; counts.van = 0; counts.police = 0; counts.taxi = 0;
    const lodCounts = this.lodCounts;
    lodCounts.sedan = 0; lodCounts.sport = 0; lodCounts.van = 0; lodCounts.police = 0; lodCounts.taxi = 0;
    const lodDist2 = R.bodyLodDist * R.bodyLodDist;
    let wheelIdx = 0;
    let lightIdx = 0;
    const sirenPhase = Math.floor(time * R.sirenHz * 2) % 2;
    let spotsSet = false;
    this.shadows.begin();
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const key = v.spec.key;
      const profile = this.profiles[key];
      lerpTransform(this.interp, v.prev, v.curr, alpha);
      const t = this.interp;
      const dx = t.x - camX, dz = t.z - camZ;
      const d2 = dx * dx + dz * dz;
      const visible = d2 < R.cullDist * R.cullDist;
      // Near cars get the full loft + lathed wheels and cast shadows; far ones the parked shell with baked wheel discs.
      const near = d2 < lodDist2;
      const mesh = near ? this.bodies[key] : this.lodBodies[key];
      const idx = near ? counts[key]++ : lodCounts[key]++;
      v.renderIndex = idx;
      const sc = visible ? Math.max(0.001, v.spawnFade) : 0;
      const yaw = t.yaw;
      // Weight transfer: dive on the brakes, squat on the throttle, lean out of the corner.
      let pitch = clamp(-v.longAccel * R.pitchGain, -R.pitchMax, R.pitchMax);
      let roll = clamp(v.yawRate * v.speed * R.rollGain, -R.rollMax, R.rollMax);
      if (v.destroyed) {
        const h = (v.id * 2654435761) >>> 0;
        pitch += ((h & 15) / 15 - 0.5) * 0.09;
        roll += (((h >> 4) & 15) / 15 - 0.5) * 0.16;
      }
      this.euler.set(pitch, yaw, roll);
      this.quat.setFromEuler(this.euler);
      this.pos.set(t.x, t.y, t.z);
      this.scl.set(sc, sc, sc);
      this.mat.compose(this.pos, this.quat, this.scl);
      mesh.setMatrixAt(idx, this.mat);
      this.paintColor(v);
      mesh.setColorAt(idx, this.color);
      (mesh.geometry.getAttribute('instanceGlow') as THREE.InstancedBufferAttribute).setX(idx, v.lightsOn && !v.destroyed ? 1 : 0);
      if (visible) {
        if (near && d2 < R.wheelDist * R.wheelDist) wheelIdx = this.syncWheels(v, t, sc, profile.wheelScale, wheelIdx);
        lightIdx = this.syncLights(v, t, sc, profile, sirenPhase, lightIdx);
        this.shadows.add(t.x, groundYAt(t.x, t.z) + R.shadowLift, t.z, profile.shadowW, profile.shadowL, yaw, v.spawnFade);
        if (v.occupiedByPlayer) { this.syncSpots(v, t, profile); spotsSet = true; }
      }
    }
    for (let i = 0; i < KEYS.length; i++) {
      const mesh = this.bodies[KEYS[i]];
      mesh.count = counts[KEYS[i]];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      const lod = this.lodBodies[KEYS[i]];
      lod.count = lodCounts[KEYS[i]];
      lod.instanceMatrix.needsUpdate = true;
      if (lod.instanceColor) lod.instanceColor.needsUpdate = true;
    }
    for (let i = 0; i < this.glowAttrs.length; i++) this.glowAttrs[i].needsUpdate = true;
    this.wheels.count = wheelIdx;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.lights.count = lightIdx;
    this.lights.instanceMatrix.needsUpdate = true;
    if (this.lights.instanceColor) this.lights.instanceColor.needsUpdate = true;
    this.shadows.end();
    if (!spotsSet) { this.spotL.intensity = 0; this.spotR.intensity = 0; }
  }

  /** Damage desaturates and sooties the paint (readable at a glance) without crushing it to black. */
  private paintColor(v: Vehicle): void {
    const c = this.color;
    c.setHex(v.color);
    if (v.destroyed) {
      c.setRGB(0.085, 0.075, 0.072);
    } else {
      const dmg = clamp(1 - v.health / 100, 0, 1);
      if (dmg > 0) {
        const lum = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
        const soot = lum * 0.42 + 0.02;
        const t = dmg * 0.85;
        c.r += (soot - c.r) * t;
        c.g += (soot - c.g) * t;
        c.b += (soot - c.b) * t;
        c.multiplyScalar(1 - 0.3 * dmg);
      }
    }
    if (v.damageFlash > 0) {
      const f = v.damageFlash * 0.6;
      c.r += (1 - c.r) * f; c.g += (1 - c.g) * f; c.b += (1 - c.b) * f;
    }
  }

  private syncWheels(v: Vehicle, t: Transform, sc: number, wheelScale: number, idx: number): number {
    const R = VEHICLE_RENDER;
    const yaw = t.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const hw = v.spec.width * 0.5 - R.wheelWidth * 0.5 + WHEEL_INSET;
    const hb = v.spec.wheelbase * 0.5;
    const ws = sc * wheelScale;
    for (let w = 0; w < 4; w++) {
      const side = w % 2 === 0 ? -1 : 1;
      const front = w < 2;
      const ox = side * hw, oz = front ? hb : -hb;
      this.pos.set(t.x + rx * ox + fx * oz, t.y + R.wheelRadius * ws, t.z + rz * ox + fz * oz);
      this.euler.set(v.wheelSpin, yaw + (front ? v.steerAngle : 0), 0);
      this.quat.setFromEuler(this.euler);
      this.scl.set(ws, ws, ws);
      this.mat.compose(this.pos, this.quat, this.scl);
      this.wheels.setMatrixAt(idx++, this.mat);
    }
    return idx;
  }

  private syncLights(v: Vehicle, t: Transform, sc: number, p: VehicleProfile, sirenPhase: number, idx: number): number {
    const yaw = t.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const wreck = v.destroyed;
    const braking = v.controls.brake > 0 || (v.controls.throttle < 0 && v.speed > 0.5);
    const c = this.color;
    for (let k = 0; k < 6; k++) {
      const rear = k >= 2 && k < 4;
      const roof = k >= 4;
      const a = roof ? p.roof : rear ? p.tail : p.head;
      const side = k % 2 === 0 ? -1 : 1;
      // Lamp quads follow the swept lamp faces of the shell (inner edge forward at the nose, backward at the tail).
      let ox = side * a.x, oz = a.z, rot = yaw + side * a.sweep, sx = a.w * LIGHT_QUAD_SCALE, sy = a.h * LIGHT_QUAD_SCALE;
      if (rear) rot = yaw + Math.PI - side * a.sweep;
      if (roof) {
        if (p.roofKind === 'none') { sx = 0; sy = 0; }
        else if (p.roofKind === 'sign') { ox = 0; rot = k === 4 ? yaw : yaw + Math.PI; oz = a.z * (k === 4 ? 1 : -1); }
      }
      this.pos.set(t.x + rx * ox + fx * oz, t.y + a.y * sc, t.z + rz * ox + fz * oz);
      this.euler.set(0, rot, 0);
      this.quat.setFromEuler(this.euler);
      this.scl.set(sx * sc, sy * sc, sc);
      this.mat.compose(this.pos, this.quat, this.scl);
      this.lights.setMatrixAt(idx, this.mat);
      // Unlit quads sit close to the lens colour of the shell behind them (a pale headlamp, a dim red tail cluster) so
      // they are not black boxes by day, and fade with the daylight so an unlit lens does not glow at night; the
      // emissive push only comes with the lights.
      const dim = 1 - 0.7 * this.nightFactor;
      if (wreck) c.setRGB(0.05, 0.05, 0.05);
      else if (k < 2) { if (v.lightsOn) c.setRGB(1, 0.97, 0.85); else c.setRGB(0.58 * dim, 0.62 * dim, 0.64 * dim); }
      else if (rear) {
        if (braking) c.setRGB(1, 0.16, 0.1);
        else if (v.lightsOn) c.setRGB(0.85, 0.08, 0.05);
        else c.setRGB(0.36 * dim, 0.05 * dim, 0.045 * dim);
      } else if (p.roofKind === 'sign') {
        const glow = 0.35 + 0.65 * this.nightFactor;
        c.setRGB(glow, glow * 0.82, glow * 0.28);
      } else if (v.sirenOn) {
        const red = (k === 4) === (sirenPhase === 0);
        if (red) c.setRGB(1, 0.1, 0.1); else c.setRGB(0.2, 0.4, 1);
      } else c.setRGB(0.12, 0.12, 0.14);
      this.lights.setColorAt(idx, c);
      idx++;
    }
    return idx;
  }

  private syncSpots(v: Vehicle, t: Transform, p: VehicleProfile): void {
    const R = VEHICLE_RENDER;
    const yaw = t.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const hw = p.head.x, hl = p.head.z;
    const y = p.head.y;
    const intensity = v.lightsOn && !v.destroyed ? R.headlightIntensity * Math.max(0.15, this.nightFactor) : 0;
    this.spotL.position.set(t.x - rx * hw + fx * hl, t.y + y, t.z - rz * hw + fz * hl);
    this.spotR.position.set(t.x + rx * hw + fx * hl, t.y + y, t.z + rz * hw + fz * hl);
    this.spotL.target.position.set(t.x - rx * hw + fx * (hl + 30), 0, t.z - rz * hw + fz * (hl + 30));
    this.spotR.target.position.set(t.x + rx * hw + fx * (hl + 30), 0, t.z + rz * hw + fz * (hl + 30));
    this.spotL.intensity = intensity;
    this.spotR.intensity = intensity;
  }

  dispose(): void {
    for (let i = 0; i < KEYS.length; i++) {
      const mesh = this.bodies[KEYS[i]];
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (let i = 0; i < KEYS.length; i++) {
      const lod = this.lodBodies[KEYS[i]];
      this.scene.remove(lod);
      lod.geometry.dispose();
      lod.dispose();
    }
    this.scene.remove(this.wheels);
    this.wheels.geometry.dispose();
    this.wheels.dispose();
    this.scene.remove(this.lights);
    this.lights.geometry.dispose();
    this.lights.dispose();
    this.shadows.dispose();
    this.scene.remove(this.spotL, this.spotL.target, this.spotR, this.spotR.target);
    this.spotL.dispose();
    this.spotR.dispose();
    this.bodyMat.dispose();
    this.wheelMat.dispose();
    this.lightMat.dispose();
  }
}
