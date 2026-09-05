// Instanced vehicle rendering: per-spec merged low-poly bodies (paint + fixed-colour glass/chrome/lamps), rims,
// light quads, contact shadows, player headlight spotlights. Track C.
//
// Every body is merged ONCE at construction from tapered prisms ("slabs"): each prism carries a base vertex colour and a
// `paintMix` weight, and the patched Lambert shader blends the per-instance paint only into the parts with paintMix > 0.
// That keeps glass dark blue and bumpers grey on a bright yellow taxi while still costing one draw call per spec.
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

export const VEHICLE_RENDER = {
  cullDist: 260, clearance: 0.30, wheelRadius: 0.33, wheelWidth: 0.24, lightsPerVehicle: 6, wheelsPerVehicle: 4,
  headlightIntensity: 90, headlightDistance: 50, headlightAngle: 0.5, headlightPenumbra: 0.45, sirenHz: 4,
  /** Body pitch (dive/squat) and roll (lean) limits in radians, and how hard longAccel / yawRate push them. */
  pitchGain: 0.010, pitchMax: 0.036, rollGain: 0.0035, rollMax: 0.055,
  shadowLift: 0.045,
} as const;

const KEYS: VehicleKey[] = ['sedan', 'sport', 'van', 'police', 'taxi'];

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
const LAMP = 0xe6e8dc;
const TAIL = 0x9c2119;
const POLICE_BLUE = 0x1638b4;
const SIGN = 0xf6edd2;

/** A box deformed into a frustum: independent z / half-width / y for the (bottom, top) x (back, front) corners. */
interface PrismDef {
  /** bottom face: back z, front z, back half-width, front half-width, back y, front y (y defaults to flat). */
  bz0: number; bz1: number; bw0: number; bw1: number; by0: number; by1?: number;
  /** top face, same layout. */
  tz0: number; tz1: number; tw0: number; tw1: number; ty0: number; ty1?: number;
  /** centre offset on x (mirrored pairs push ±); `txc` lets the top face lean (raked pillars, shut lines on a tapered flank). */
  xc?: number; txc?: number;
  col: number;
  /** 0 = authored colour, 1 = fully tinted by the vehicle paint. */
  paint?: number;
  /** Corner radius in unit-cube space (default PRISM_BEVEL); >= PRISM_BEVEL_SOFT gets the finer 2-segment bevel. */
  bevel?: number;
  /** Longitudinal crown: the top face lifts by this much along the centre line, so a roof gets a crease that splits the light. */
  crown?: number;
}

const authorColor = new THREE.Color();

/** Bevel on every body panel: sharp cube corners are what read as "boxy"; a small radius catches the light instead. */
const PRISM_BEVEL = 0.085;
const PRISM_SEGMENTS = 1;
/** Hull / cabin / roof use a wider, smoother bevel: that soft nose-and-shoulder profile is the modern low-poly signature. */
const PRISM_BEVEL_SOFT = 0.16;
const PRISM_SEGMENTS_SOFT = 2;

/** Panels smaller than this stay plain boxes: a bevel would be invisible and 9x the triangles. */
const PRISM_BEVEL_MIN_SIZE = 0.55;

function prism(p: PrismDef): THREE.BufferGeometry {
  const by1p = p.by1 ?? p.by0;
  const ty1p = p.ty1 ?? p.ty0;
  const spanZ = Math.max(p.bz1 - p.bz0, p.tz1 - p.tz0);
  const spanY = Math.max(p.ty0 - p.by0, ty1p - by1p);
  const spanX = 2 * Math.max(p.bw0, p.bw1, p.tw0, p.tw1);
  const big = Math.max(spanX, spanY, spanZ) >= PRISM_BEVEL_MIN_SIZE;
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
  const crown = p.crown ?? 0;
  authorColor.setHex(p.col);
  const paint = p.paint ?? 1;
  for (let i = 0; i < n; i++) {
    // Unit cube coords -> 0..1 weights. Rounded corners sit slightly inside, so the bevel survives the taper.
    const u = pos.getX(i) * 2;                       // -1..1 across the width
    const v = Math.min(1, Math.max(0, pos.getY(i) + 0.5)); // 0 bottom, 1 top
    const w = Math.min(1, Math.max(0, pos.getZ(i) + 0.5)); // 0 back, 1 front
    const hw = (p.bw0 * (1 - w) + p.bw1 * w) * (1 - v) + (p.tw0 * (1 - w) + p.tw1 * w) * v;
    const z = (p.bz0 * (1 - w) + p.bz1 * w) * (1 - v) + (p.tz0 * (1 - w) + p.tz1 * w) * v;
    const y = (p.by0 * (1 - w) + by1 * w) * (1 - v) + (p.ty0 * (1 - w) + ty1 * w) * v + crown * (1 - Math.abs(u)) * v;
    pos.setXYZ(i, xc * (1 - v) + txc * v + u * hw, y, z);
    colors[i * 3] = authorColor.r; colors[i * 3 + 1] = authorColor.g; colors[i * 3 + 2] = authorColor.b;
    paints[i] = paint;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('paintMix', new THREE.BufferAttribute(paints, 1));
  g.computeVertexNormals();
  return g;
}

/** Gives a stock three geometry the vehicle attributes (colour + paintMix) and makes it mergeable with the prisms. */
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

/** Thin black panel-gap line on a tapered flank: follows the hull's lean from floor half-width `bx` to belt half-width `tx`. */
function shutLine(out: PrismDef[], z: number, bx: number, y0: number, tx: number, y1: number): void {
  pair(out, {
    bz0: z - 0.008, bz1: z + 0.008, bw0: 0.012, bw1: 0.012, by0: y0, tz0: z - 0.008, tz1: z + 0.008, tw0: 0.012, tw1: 0.012, ty0: y1,
    xc: bx + 0.004, txc: tx + 0.004, col: BLACK, paint: 0,
  });
}

/** Tail-lamp cluster: a rear face block plus a wrap-around lens on the flank, so the lamp reads from three-quarter views. */
function tailCluster(out: PrismDef[], hl: number, xc: number, hw: number, y0: number, y1: number, flankX: number): void {
  pair(out, { ...block(-hl - 0.07, -hl + 0.05, hw, y0, y1, TAIL, 0, xc) });
  pair(out, { ...block(-hl - 0.02, -hl + 0.22, 0.016, y0 + 0.01, y1 - 0.01, TAIL, 0, flankX) });
}

/** Rear plate recess and a chrome exhaust stub under the bumper. */
function rearDetails(out: PrismDef[], hl: number, c: number, plateY: number, exhaustX: number): void {
  out.push(block(-hl - 0.10, -hl + 0.02, 0.19, plateY, plateY + 0.11, SIGN, 0));
  out.push(block(-hl - 0.12, -hl + 0.10, 0.028, c - 0.02, c + 0.04, CHROME, 0, exhaustX));
}

const PILLAR_W = 0.09;
const PILLAR_PROUD = 0.012;

// ---------------------------------------------------------------------------------------------- per-spec profiles

interface Anchor { x: number; y: number; z: number; w: number; h: number }
/** Half-cylinder wheel arch over one axle (mirrored across x): tube radius, axle x/z and outboard half-width. */
interface ArchDef { x: number; z: number; r: number; w: number }
interface VehicleProfile {
  parts: PrismDef[];
  arches: ArchDef[];
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

/** Wheel arches: a half-cylinder fender over each wheel plus a dark inner recess so the tyre reads as sitting in an arch. */
function arches(out: PrismDef[], archOut: ArchDef[], hw: number, wheelX: number, wheelZ: number, r: number, wide: number): void {
  for (let i = 0; i < 2; i++) {
    const z = i === 0 ? wheelZ : -wheelZ;
    archOut.push({ x: wheelX, z, r: r * 1.45, w: wide });
    pair(out, { ...block(z - r * 1.5, z + r * 1.5, hw * 0.06, r * 0.35, r * 1.6, BLACK, 0, wheelX * 0.86) });
  }
}

/** Builds the arch fenders as open half-tubes with an annular lip on the outboard end (the tyre stays visible through it). */
function archGeometry(a: ArchDef, side: number): THREE.BufferGeometry[] {
  const tube = new THREE.CylinderGeometry(a.r, a.r, a.w * 2, 10, 1, true, 0, Math.PI);
  tube.rotateZ(Math.PI / 2); // axis along x, open half facing +y
  tube.translate(side * a.x, VEHICLE_RENDER.wheelRadius, a.z);
  const lip = new THREE.RingGeometry(a.r * 0.72, a.r, 10, 1, 0, Math.PI);
  lip.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2); // face outboard
  lip.translate(side * (a.x + a.w), VEHICLE_RENDER.wheelRadius, a.z);
  return [decorate(tube, PAINT_DARK, 1), decorate(lip, PAINT_DARK, 1)];
}

/** Three-box saloon: sloped bonnet, raked glasshouse, boot lip. Shared by sedan / police / taxi. */
function sedanProfile(s: VehicleSpec, kind: 'sedan' | 'police' | 'taxi'): VehicleProfile {
  const L = s.length, hl = L / 2, hw = s.width / 2, H = s.height;
  const c = VEHICLE_RENDER.clearance;
  const belt = H * 0.62;
  const glassTop = H - H * 0.07;
  const wz = s.wheelbase / 2;
  const wx = hw - VEHICLE_RENDER.wheelWidth * 0.5 + 0.04;
  const parts: PrismDef[] = [];
  const archDefs: ArchDef[] = [];
  const SOFT = PRISM_BEVEL_SOFT;
  // Hull: wedge-sided, slightly narrower at the floor, nose lower than the boot.
  parts.push({
    bz0: -hl + 0.06, bz1: hl - 0.10, bw0: hw * 0.80, bw1: hw * 0.74, by0: c, by1: c + 0.05,
    tz0: -hl, tz1: hl, tw0: hw * 0.93, tw1: hw * 0.86, ty0: belt, ty1: belt - 0.05, col: PAINT, paint: 1, bevel: SOFT,
  });
  // Boot lid (separate panel) with a raised lip along its trailing edge.
  parts.push({
    bz0: -hl + 0.01, bz1: -L * 0.20, bw0: hw * 0.90, bw1: hw * 0.90, by0: belt - 0.04,
    tz0: -hl + 0.05, tz1: -L * 0.20, tw0: hw * 0.84, tw1: hw * 0.86, ty0: belt + 0.05, ty1: belt + 0.07, col: PAINT, paint: 1,
  });
  parts.push(block(-hl + 0.02, -hl + 0.10, hw * 0.80, belt + 0.04, belt + 0.08, PAINT, 1));
  // Bonnet: falls away toward the nose.
  parts.push({
    bz0: L * 0.12, bz1: hl - 0.03, bw0: hw * 0.88, bw1: hw * 0.78, by0: belt - 0.10,
    tz0: L * 0.12, tz1: hl - 0.02, tw0: hw * 0.86, tw1: hw * 0.74, ty0: belt + 0.06, ty1: belt - 0.09, col: PAINT, paint: 1,
  });
  // Glasshouse: inset glass band, faintly tinted by the paint, framed by raked A / C pillars and a creased roof.
  const gz0 = -L * 0.32, gz1 = L * 0.145, gtz0 = -L * 0.255, gtz1 = -L * 0.015;
  const gbw = hw * 0.84, gtw = hw * 0.72;
  parts.push({
    bz0: gz0, bz1: gz1, bw0: gbw - 0.02, bw1: gbw - 0.02, by0: belt - 0.02,
    tz0: gtz0, tz1: gtz1, tw0: hw * 0.70, tw1: hw * 0.70, ty0: glassTop, col: GLASS, paint: 0.15, bevel: SOFT,
  });
  pillar(parts, gz1, gbw, belt - 0.01, gtz1, gtw, glassTop + 0.005);
  pillar(parts, gz0 + PILLAR_W, gbw, belt - 0.01, gtz0 + PILLAR_W, gtw, glassTop + 0.005);
  // Windscreen / rear window: darker slabs sitting a touch proud of the tinted band.
  parts.push({
    bz0: gz1 - 0.06, bz1: gz1 + 0.01, bw0: hw * 0.66, bw1: hw * 0.66, by0: belt + 0.02,
    tz0: gtz1 - 0.06, tz1: gtz1 + 0.01, tw0: hw * 0.58, tw1: hw * 0.58, ty0: glassTop - 0.03, col: GLASS_DEEP, paint: 0,
  });
  parts.push({
    bz0: gz0 - 0.01, bz1: gz0 + 0.06, bw0: hw * 0.66, bw1: hw * 0.66, by0: belt + 0.02,
    tz0: gtz0 - 0.01, tz1: gtz0 + 0.06, tw0: hw * 0.60, tw1: hw * 0.60, ty0: glassTop - 0.03, col: GLASS_DEEP, paint: 0,
  });
  // Roof panel over the glass band, crowned along the centre line.
  parts.push({
    bz0: -L * 0.27, bz1: L * 0.005, bw0: hw * 0.78, bw1: hw * 0.75, by0: glassTop - 0.01,
    tz0: -L * 0.25, tz1: -L * 0.01, tw0: hw * 0.74, tw1: hw * 0.71, ty0: H - 0.015, col: PAINT, paint: 1, bevel: SOFT, crown: 0.03,
  });
  // Rocker panel / sills.
  parts.push(block(-L * 0.33, L * 0.33, hw * 0.90, c + 0.02, c + 0.16, DARK, 0.25));
  arches(parts, archDefs, hw, wx, wz, VEHICLE_RENDER.wheelRadius, hw * 0.17);
  // Door shut lines on the flank (front and rear door edges) and a bonnet gap across the cowl.
  shutLine(parts, L * 0.13, hw * 0.795, c + 0.17, hw * 0.925, belt - 0.03);
  shutLine(parts, -L * 0.19, hw * 0.805, c + 0.17, hw * 0.93, belt - 0.03);
  parts.push(block(L * 0.115, L * 0.115 + 0.016, hw * 0.78, belt + 0.03, belt + 0.075, BLACK, 0));
  // Bumpers, grille, plate.
  parts.push({ bz0: hl - 0.04, bz1: hl + 0.11, bw0: hw * 0.88, bw1: hw * 0.80, by0: c + 0.02, tz0: hl - 0.04, tz1: hl + 0.10, tw0: hw * 0.86, tw1: hw * 0.78, ty0: c + 0.30, col: DARK, paint: 0 });
  parts.push({ bz0: -hl - 0.11, bz1: -hl + 0.04, bw0: hw * 0.80, bw1: hw * 0.88, by0: c + 0.02, tz0: -hl - 0.10, tz1: -hl + 0.04, tw0: hw * 0.78, tw1: hw * 0.86, ty0: c + 0.30, col: DARK, paint: 0 });
  parts.push(block(hl - 0.02, hl + 0.09, hw * 0.46, c + 0.32, belt - 0.16, BLACK, 0));
  parts.push(block(hl + 0.02, hl + 0.10, hw * 0.20, c + 0.06, c + 0.22, CHROME, 0));
  // Lamps baked into the shell so they read in daylight; tail clusters wrap onto the rear wings.
  pair(parts, { ...block(hl - 0.06, hl + 0.07, hw * 0.19, belt - 0.24, belt - 0.06, LAMP, 0, hw * 0.60) });
  tailCluster(parts, hl, hw * 0.58, hw * 0.21, belt - 0.24, belt - 0.04, hw * 0.925);
  rearDetails(parts, hl, c, c + 0.34, hw * 0.55);
  // Door mirrors on stalks.
  pair(parts, { ...block(L * 0.10, L * 0.165, hw * 0.16, belt + 0.06, belt + 0.17, PAINT_SHADE, 1, hw * 0.90) });
  // Door handles.
  pair(parts, { ...block(-L * 0.10, -L * 0.04, hw * 0.03, belt - 0.14, belt - 0.08, CHROME, 0, hw * 0.94) });

  const profile: VehicleProfile = {
    parts,
    arches: archDefs,
    head: { x: hw * 0.60, y: belt - 0.15, z: hl + 0.08, w: 0.34, h: 0.15 },
    tail: { x: hw * 0.58, y: belt - 0.14, z: -hl - 0.09, w: 0.40, h: 0.16 },
    roof: { x: 0, y: H, z: 0, w: 0.3, h: 0.12 },
    roofKind: 'none',
    wheelScale: 1,
    shadowW: hw * 1.55,
    shadowL: hl * 1.14,
    floor: c,
    belt,
  };

  if (kind === 'police') {
    // Bull bar, roof lightbar housing and a blue side flash.
    pair(parts, { ...block(hl + 0.04, hl + 0.16, hw * 0.08, c + 0.10, belt - 0.02, DARK, 0, hw * 0.42) });
    parts.push(block(hl + 0.06, hl + 0.15, hw * 0.55, belt - 0.22, belt - 0.10, DARK, 0));
    parts.push(block(-L * 0.05, L * 0.05, hw * 0.46, H, H + 0.11, BLACK, 0));
    pair(parts, { ...block(-L * 0.30, L * 0.24, hw * 0.03, belt - 0.30, belt - 0.10, POLICE_BLUE, 0, hw * 0.95) });
    pair(parts, { ...block(-L * 0.30, -L * 0.05, hw * 0.03, belt - 0.02, glassTop - 0.06, POLICE_BLUE, 0, hw * 0.80) });
    profile.roof = { x: 0.24, y: H + 0.055, z: 0.03, w: 0.3, h: 0.12 };
    profile.roofKind = 'siren';
  } else if (kind === 'taxi') {
    // Roof sign box + a dark chequer band along the doors.
    parts.push({
      bz0: -L * 0.03, bz1: L * 0.05, bw0: hw * 0.34, bw1: hw * 0.34, by0: H - 0.01,
      tz0: -L * 0.02, tz1: L * 0.04, tw0: hw * 0.30, tw1: hw * 0.30, ty0: H + 0.19, col: SIGN, paint: 0,
    });
    pair(parts, { ...block(-L * 0.32, L * 0.30, hw * 0.03, belt - 0.30, belt - 0.16, BLACK, 0, hw * 0.94) });
    profile.roof = { x: 0, y: H + 0.10, z: L * 0.045, w: 0.46, h: 0.15 };
    profile.roofKind = 'sign';
  }
  return profile;
}

/** Low, wide, cab-back coupe with a spoiler. */
function sportProfile(s: VehicleSpec): VehicleProfile {
  const L = s.length, hl = L / 2, hw = s.width / 2, H = s.height;
  const c = VEHICLE_RENDER.clearance - 0.05;
  const belt = H * 0.58;
  const glassTop = H - 0.09;
  const wz = s.wheelbase / 2;
  const wx = hw - VEHICLE_RENDER.wheelWidth * 0.5 + 0.05;
  const parts: PrismDef[] = [];
  const archDefs: ArchDef[] = [];
  const SOFT = PRISM_BEVEL_SOFT;
  parts.push({
    bz0: -hl + 0.08, bz1: hl - 0.08, bw0: hw * 0.82, bw1: hw * 0.76, by0: c, by1: c + 0.04,
    tz0: -hl, tz1: hl, tw0: hw * 0.94, tw1: hw * 0.88, ty0: belt + 0.02, ty1: belt - 0.10, col: PAINT, paint: 1, bevel: SOFT,
  });
  // Long, low bonnet.
  parts.push({
    bz0: -L * 0.02, bz1: hl - 0.02, bw0: hw * 0.90, bw1: hw * 0.80, by0: belt - 0.12,
    tz0: -L * 0.02, tz1: hl - 0.01, tw0: hw * 0.88, tw1: hw * 0.74, ty0: belt + 0.06, ty1: belt - 0.13, col: PAINT, paint: 1,
  });
  // Cab-back glasshouse: inset tinted band, raked pillars, crowned roof.
  const gz0 = -L * 0.38, gz1 = L * 0.03, gtz0 = -L * 0.31, gtz1 = -L * 0.08;
  const gbw = hw * 0.83, gtw = hw * 0.69;
  parts.push({
    bz0: gz0, bz1: gz1, bw0: gbw - 0.02, bw1: gbw - 0.02, by0: belt - 0.01,
    tz0: gtz0, tz1: gtz1, tw0: hw * 0.67, tw1: hw * 0.64, ty0: glassTop, col: GLASS, paint: 0.15, bevel: SOFT,
  });
  pillar(parts, gz1, gbw, belt, gtz1, gtw - 0.02, glassTop + 0.005);
  pillar(parts, gz0 + PILLAR_W, gbw, belt, gtz0 + PILLAR_W, gtw, glassTop + 0.005);
  parts.push({
    bz0: gz1 - 0.06, bz1: gz1 + 0.01, bw0: hw * 0.64, bw1: hw * 0.64, by0: belt + 0.03,
    tz0: gtz1 - 0.06, tz1: gtz1 + 0.01, tw0: hw * 0.52, tw1: hw * 0.52, ty0: glassTop - 0.03, col: GLASS_DEEP, paint: 0,
  });
  parts.push({
    bz0: gz0 - 0.01, bz1: gz0 + 0.06, bw0: hw * 0.62, bw1: hw * 0.62, by0: belt + 0.03,
    tz0: gtz0 - 0.01, tz1: gtz0 + 0.06, tw0: hw * 0.56, tw1: hw * 0.56, ty0: glassTop - 0.03, col: GLASS_DEEP, paint: 0,
  });
  parts.push({
    bz0: -L * 0.32, bz1: -L * 0.07, bw0: hw * 0.74, bw1: hw * 0.70, by0: glassTop - 0.01,
    tz0: -L * 0.30, tz1: -L * 0.10, tw0: hw * 0.70, tw1: hw * 0.66, ty0: H - 0.015, col: PAINT, paint: 1, bevel: SOFT, crown: 0.03,
  });
  // Rear deck (boot) with a lip + wing.
  parts.push(block(-hl + 0.02, -L * 0.30, hw * 0.90, belt - 0.04, belt + 0.03, PAINT, 1));
  parts.push(block(-hl + 0.02, -hl + 0.09, hw * 0.78, belt + 0.02, belt + 0.06, PAINT, 1));
  pair(parts, { ...block(-hl - 0.02, -hl + 0.16, hw * 0.06, belt + 0.01, belt + 0.24, DARK, 0, hw * 0.58) });
  parts.push(block(-hl - 0.06, -hl + 0.18, hw * 0.92, belt + 0.24, belt + 0.31, PAINT_SHADE, 1));
  // Splitter, sills, side scoops.
  parts.push({ bz0: hl - 0.04, bz1: hl + 0.14, bw0: hw * 0.92, bw1: hw * 0.86, by0: c - 0.02, tz0: hl - 0.04, tz1: hl + 0.12, tw0: hw * 0.90, tw1: hw * 0.82, ty0: c + 0.22, col: DARK, paint: 0 });
  parts.push(block(-hl - 0.12, -hl + 0.04, hw * 0.88, c - 0.02, c + 0.22, DARK, 0));
  parts.push(block(-L * 0.35, L * 0.35, hw * 0.94, c + 0.02, c + 0.14, BLACK, 0.2));
  pair(parts, { ...block(-L * 0.22, -L * 0.02, hw * 0.04, c + 0.16, belt - 0.10, BLACK, 0, hw * 0.92) });
  arches(parts, archDefs, hw, wx, wz, VEHICLE_RENDER.wheelRadius * 1.08, hw * 0.16);
  // Door shut line (single long door) + bonnet gap.
  shutLine(parts, L * 0.02, hw * 0.815, c + 0.15, hw * 0.935, belt - 0.02);
  parts.push(block(-L * 0.025, -L * 0.025 + 0.016, hw * 0.80, belt + 0.02, belt + 0.075, BLACK, 0));
  parts.push(block(hl - 0.01, hl + 0.08, hw * 0.52, c + 0.20, belt - 0.20, BLACK, 0));
  pair(parts, { ...block(hl - 0.10, hl + 0.05, hw * 0.22, belt - 0.20, belt - 0.09, LAMP, 0, hw * 0.56) });
  parts.push(block(-hl - 0.05, -hl + 0.02, hw * 0.78, belt - 0.14, belt - 0.02, TAIL, 0));
  pair(parts, { ...block(-hl - 0.02, -hl + 0.20, 0.016, belt - 0.13, belt - 0.03, TAIL, 0, hw * 0.93) });
  rearDetails(parts, hl, c, c + 0.28, hw * 0.50);
  pair(parts, { ...block(L * 0.06, L * 0.12, hw * 0.14, belt + 0.02, belt + 0.11, PAINT_SHADE, 1, hw * 0.92) });
  return {
    parts,
    arches: archDefs,
    head: { x: hw * 0.56, y: belt - 0.14, z: hl + 0.04, w: 0.34, h: 0.11 },
    tail: { x: hw * 0.42, y: belt - 0.08, z: -hl - 0.05, w: 0.5, h: 0.12 },
    roof: { x: 0, y: H, z: 0, w: 0.3, h: 0.12 },
    roofKind: 'none',
    wheelScale: 1.08,
    shadowW: hw * 1.55,
    shadowL: hl * 1.14,
    floor: c,
    belt,
  };
}

/** Tall box van: short sloped snout, deep windscreen, cargo body. */
function vanProfile(s: VehicleSpec): VehicleProfile {
  const L = s.length, hl = L / 2, hw = s.width / 2, H = s.height;
  const c = VEHICLE_RENDER.clearance;
  const wz = s.wheelbase / 2;
  const wx = hw - VEHICLE_RENDER.wheelWidth * 0.5 + 0.04;
  const noseZ = L * 0.28;
  const parts: PrismDef[] = [];
  const archDefs: ArchDef[] = [];
  const SOFT = PRISM_BEVEL_SOFT;
  // Cargo body.
  parts.push({
    bz0: -hl + 0.04, bz1: noseZ, bw0: hw * 0.86, bw1: hw * 0.88, by0: c + 0.04,
    tz0: -hl, tz1: noseZ, tw0: hw * 0.95, tw1: hw * 0.95, ty0: H - 0.06, col: PAINT, paint: 1, bevel: SOFT,
  });
  // Roof cap, crowned.
  parts.push({
    bz0: -hl + 0.02, bz1: noseZ - 0.05, bw0: hw * 0.93, bw1: hw * 0.93, by0: H - 0.07,
    tz0: -hl + 0.10, tz1: noseZ - 0.14, tw0: hw * 0.86, tw1: hw * 0.86, ty0: H - 0.02, col: PAINT_DARK, paint: 1, bevel: SOFT, crown: 0.03,
  });
  // Snout.
  parts.push({
    bz0: noseZ - 0.02, bz1: hl - 0.02, bw0: hw * 0.88, bw1: hw * 0.80, by0: c + 0.04,
    tz0: noseZ - 0.02, tz1: hl - 0.02, tw0: hw * 0.92, tw1: hw * 0.80, ty0: H * 0.53, ty1: H * 0.47, col: PAINT, paint: 1, bevel: SOFT,
  });
  // Windscreen, raked back over the snout: inset tinted pane between painted A pillars.
  parts.push({
    bz0: noseZ - 0.10, bz1: noseZ + 0.15, bw0: hw * 0.86, bw1: hw * 0.86, by0: H * 0.52,
    tz0: noseZ - 0.24, tz1: noseZ - 0.03, tw0: hw * 0.84, tw1: hw * 0.84, ty0: H * 0.90, col: GLASS, paint: 0.15,
  });
  parts.push({
    bz0: noseZ + 0.10, bz1: noseZ + 0.16, bw0: hw * 0.70, bw1: hw * 0.70, by0: H * 0.55,
    tz0: noseZ - 0.08, tz1: noseZ - 0.02, tw0: hw * 0.70, tw1: hw * 0.70, ty0: H * 0.87, col: GLASS_DEEP, paint: 0,
  });
  pillar(parts, noseZ + 0.16, hw * 0.90, H * 0.52, noseZ - 0.02, hw * 0.88, H * 0.90);
  // Cab side windows.
  pair(parts, { ...block(noseZ - 0.95, noseZ - 0.16, hw * 0.04, H * 0.60, H * 0.86, GLASS, 0.15, hw * 0.94) });
  // Sliding door shut lines on the flank.
  shutLine(parts, noseZ - 1.0, hw * 0.87, c + 0.20, hw * 0.94, H - 0.12);
  shutLine(parts, -L * 0.22, hw * 0.865, c + 0.20, hw * 0.945, H - 0.12);
  // Rear doors: seam + handles.
  parts.push(block(-hl - 0.03, -hl + 0.03, hw * 0.02, c + 0.20, H - 0.16, BLACK, 0));
  parts.push(block(-hl - 0.04, -hl + 0.02, hw * 0.60, H * 0.62, H * 0.84, GLASS, 0));
  parts.push(block(-L * 0.36, L * 0.20, hw * 0.90, c + 0.04, c + 0.18, DARK, 0.25));
  arches(parts, archDefs, hw, wx, wz, VEHICLE_RENDER.wheelRadius * 1.12, hw * 0.15);
  parts.push({ bz0: hl - 0.04, bz1: hl + 0.10, bw0: hw * 0.86, bw1: hw * 0.80, by0: c + 0.02, tz0: hl - 0.04, tz1: hl + 0.09, tw0: hw * 0.84, tw1: hw * 0.78, ty0: c + 0.34, col: DARK, paint: 0 });
  parts.push(block(-hl - 0.10, -hl + 0.04, hw * 0.84, c + 0.02, c + 0.34, DARK, 0));
  parts.push(block(hl - 0.02, hl + 0.08, hw * 0.50, c + 0.36, H * 0.42, BLACK, 0));
  pair(parts, { ...block(hl - 0.08, hl + 0.06, hw * 0.20, H * 0.30, H * 0.45, LAMP, 0, hw * 0.60) });
  pair(parts, { ...block(-hl - 0.06, -hl + 0.02, hw * 0.12, H * 0.32, H * 0.62, TAIL, 0, hw * 0.76) });
  pair(parts, { ...block(-hl - 0.02, -hl + 0.16, 0.016, H * 0.34, H * 0.60, TAIL, 0, hw * 0.94) });
  rearDetails(parts, hl, c, c + 0.40, hw * 0.55);
  // Big mirrors on arms.
  pair(parts, { ...block(noseZ - 0.20, noseZ + 0.02, hw * 0.18, H * 0.62, H * 0.80, DARK, 0, hw * 1.02) });
  return {
    parts,
    arches: archDefs,
    head: { x: hw * 0.60, y: H * 0.38, z: hl + 0.07, w: 0.36, h: 0.16 },
    tail: { x: hw * 0.76, y: H * 0.47, z: -hl - 0.07, w: 0.22, h: 0.3 },
    roof: { x: 0, y: H, z: 0, w: 0.3, h: 0.12 },
    roofKind: 'none',
    wheelScale: 1.12,
    shadowW: hw * 1.55,
    shadowL: hl * 1.14,
    floor: c,
    belt: H * 0.5,
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

/** Merges a profile's prisms and arch fenders into one buffer (position / normal / uv / color / paintMix). */
export function bodyGeometry(s: VehicleSpec): THREE.BufferGeometry {
  const profile = profileFor(s);
  const parts = profile.parts;
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < parts.length; i++) geos.push(prism(parts[i]));
  for (let i = 0; i < profile.arches.length; i++) {
    const a = profile.arches[i];
    geos.push(...archGeometry(a, 1), ...archGeometry(a, -1));
  }
  const merged = mergeGeometries(geos, false);
  for (let i = 0; i < geos.length; i++) geos[i].dispose();
  bakeShading(merged, profile.floor, profile.belt);
  merged.computeBoundingSphere();
  return merged;
}

/** Tyre + sidewall ring + five-spoke rim + bright hub, merged; one draw call for every wheel in the city. */
function wheelGeometry(): THREE.BufferGeometry {
  const R = VEHICLE_RENDER;
  const parts: THREE.BufferGeometry[] = [];
  const add = (geo: THREE.BufferGeometry, hex: number, spin = 0): void => {
    if (spin !== 0) geo.rotateX(spin);
    geo.rotateZ(Math.PI / 2);
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    authorColor.setHex(hex);
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { colors[i * 3] = authorColor.r; colors[i * 3 + 1] = authorColor.g; colors[i * 3 + 2] = authorColor.b; }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(g);
  };
  const r = R.wheelRadius, w = R.wheelWidth;
  add(new THREE.CylinderGeometry(r, r, w, 16), 0x0e0e10);
  // Bevelled sidewall: a shallower, slightly lighter ring stepping in from the tread so the tyre face is not one flat disc.
  add(new THREE.CylinderGeometry(r * 0.86, r * 0.86, w + 0.012, 16), 0x2a2a2e);
  // Rim dish (dark well behind the spokes) and five spokes.
  add(new THREE.CylinderGeometry(r * 0.66, r * 0.66, w * 0.55, 10), 0x3a3d44);
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.BoxGeometry(w + 0.03, r * 0.62, r * 0.14);
    spoke.translate(0, r * 0.34, 0);
    // Spokes are authored along +y of the wheel then rotated around its axle (x after rotateZ), i.e. around y here.
    spoke.rotateY(0);
    add(spoke, 0xc4c8cf, (i * Math.PI * 2) / 5);
  }
  add(new THREE.CylinderGeometry(r * 0.22, r * 0.22, w + 0.05, 8), 0xe2e5ea);
  const merged = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  return merged;
}

// ---------------------------------------------------------------------------------------------- renderer

export class VehicleRenderer {
  private readonly scene: THREE.Scene;
  private readonly bodies: Record<VehicleKey, THREE.InstancedMesh>;
  private readonly profiles: Record<VehicleKey, VehicleProfile>;
  private readonly wheels: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;
  private readonly shadows: ContactShadows;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.35, envMapIntensity: 0.9 });
  private readonly lightMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide, fog: false, toneMapped: false });
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
    this.bodyMat = this.makeBodyMaterial();
    this.bodies = {} as Record<VehicleKey, THREE.InstancedMesh>;
    this.profiles = {} as Record<VehicleKey, VehicleProfile>;
    for (let i = 0; i < KEYS.length; i++) {
      const key = KEYS[i];
      this.profiles[key] = profileFor(SPECS[key]);
      const mesh = new THREE.InstancedMesh(bodyGeometry(SPECS[key]), this.bodyMat, cap);
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
    this.wheels = new THREE.InstancedMesh(wheelGeometry(), this.wheelMat, cap * VEHICLE_RENDER.wheelsPerVehicle);
    this.wheels.count = 0;
    this.wheels.frustumCulled = false;
    this.wheels.castShadow = true;
    this.wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.wheels);
    const lightGeo = new THREE.PlaneGeometry(1, 1);
    this.lights = new THREE.InstancedMesh(lightGeo, this.lightMat, cap * VEHICLE_RENDER.lightsPerVehicle);
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

  /**
   * Lambert + `paintMix`: the per-instance paint colour is blended in only where the geometry asks for it, so glass,
   * bumpers, lamps and liveries keep their authored colour on every car.
   */
  private makeBodyMaterial(): THREE.MeshStandardMaterial {
    // Standard (not Lambert) so the sky probe reflects off the paint: that is what stops the cars reading as flat boxes.
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.34, envMapIntensity: 1.15 });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float paintMix;')
        // three >= r155 declares vColor as vec4 (see color_pars_vertex), so write through .rgb.
        .replace('#include <color_vertex>', [
          'vColor = vec4( 1.0 );',
          '#ifdef USE_COLOR',
          '  vColor.rgb *= color;',
          '#endif',
          '#ifdef USE_INSTANCING_COLOR',
          '  vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, clamp( paintMix, 0.0, 1.0 ) );',
          '#endif',
        ].join('\n'));
    };
    m.customProgramCacheKey = () => 'vehiclePaintMix';
    return m;
  }

  private makeSpot(): THREE.SpotLight {
    const R = VEHICLE_RENDER;
    const s = new THREE.SpotLight(0xfff1d0, 0, R.headlightDistance, R.headlightAngle, R.headlightPenumbra, 1.2);
    s.castShadow = false;
    this.scene.add(s);
    this.scene.add(s.target);
    return s;
  }

  /** 0 = full day (headlights dimmed), 1 = night. Integrator feeds DayNightSystem.nightFactor(). */
  setNightFactor(f: number): void {
    this.nightFactor = clamp(f, 0, 1);
    this.shadows.setNightFactor(this.nightFactor);
  }

  sync(world: World, alpha: number, time: number, camX: number, camZ: number): void {
    const R = VEHICLE_RENDER;
    const list = world.vehicleList;
    const counts = this.counts;
    counts.sedan = 0; counts.sport = 0; counts.van = 0; counts.police = 0; counts.taxi = 0;
    let wheelIdx = 0;
    let lightIdx = 0;
    const sirenPhase = Math.floor(time * R.sirenHz * 2) % 2;
    let spotsSet = false;
    this.shadows.begin();
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const key = v.spec.key;
      const mesh = this.bodies[key];
      const profile = this.profiles[key];
      const idx = counts[key]++;
      v.renderIndex = idx;
      lerpTransform(this.interp, v.prev, v.curr, alpha);
      const t = this.interp;
      const dx = t.x - camX, dz = t.z - camZ;
      const visible = dx * dx + dz * dz < R.cullDist * R.cullDist;
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
      if (visible) {
        wheelIdx = this.syncWheels(v, t, sc, profile.wheelScale, wheelIdx);
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
    }
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
    const hw = v.spec.width * 0.5 - R.wheelWidth * 0.5 + 0.04;
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
      let ox = side * a.x, oz = a.z, rot = yaw, sx = a.w, sy = a.h;
      if (rear) rot = yaw + Math.PI;
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
      if (wreck) c.setRGB(0.05, 0.05, 0.05);
      else if (k < 2) { if (v.lightsOn) c.setRGB(1, 0.97, 0.85); else c.setRGB(0.34, 0.34, 0.3); }
      else if (rear) {
        if (braking) c.setRGB(1, 0.16, 0.1);
        else if (v.lightsOn) c.setRGB(0.85, 0.08, 0.05);
        else c.setRGB(0.3, 0.05, 0.04);
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
