// 2D (XZ) collision primitives: SAT for OBB/AABB, circle tests, segment raycasts. Allocation-free. Track P0.
// Manifold convention (all functions): the normal points from the SECOND shape (B) toward the FIRST (A);
// moving A by (nx, nz) * depth separates the pair.
import type { HashItem } from './SpatialHash';

export interface AABB { minX: number; minZ: number; maxX: number; maxZ: number }
export interface OBB { cx: number; cz: number; hw: number; hl: number; yaw: number } // hw = half width (local x), hl = half length (local z)
export interface Circle { cx: number; cz: number; r: number }
export interface Manifold { nx: number; nz: number; depth: number } // normal points from B toward A; moving A by n*depth separates
export type StaticShape = ({ kind: 'aabb' } & AABB) | ({ kind: 'circle' } & Circle);
export interface StaticCollider extends HashItem { id: number; shape: StaticShape; tag: 'building' | 'prop' | 'water' | 'boundary' | 'landmark'; height: number }

// ---- SAT core (module-level scratch state; single-threaded) ----
let bestDepth = 0;
let bestNx = 0;
let bestNz = 0;

/** Projected half-extent of a box (forward f, right r, half sizes hw along right, hl along forward) on a unit axis. */
const projRadius = (ax: number, az: number, fx: number, fz: number, rx: number, rz: number, hw: number, hl: number): number =>
  hw * Math.abs(ax * rx + az * rz) + hl * Math.abs(ax * fx + az * fz);

/**
 * Tests one axis. Returns false when separated. Otherwise updates the best (smallest) overlap.
 * d = (centerA - centerB) · axis, so the normal is oriented from B toward A.
 */
function testAxis(ax: number, az: number, acx: number, acz: number, afx: number, afz: number, arx: number, arz: number, ahw: number, ahl: number,
  bcx: number, bcz: number, bfx: number, bfz: number, brx: number, brz: number, bhw: number, bhl: number): boolean {
  const d = (acx - bcx) * ax + (acz - bcz) * az;
  const ra = projRadius(ax, az, afx, afz, arx, arz, ahw, ahl);
  const rb = projRadius(ax, az, bfx, bfz, brx, brz, bhw, bhl);
  const overlap = ra + rb - Math.abs(d);
  if (overlap <= 0) return false;
  if (overlap < bestDepth) {
    bestDepth = overlap;
    if (d >= 0) { bestNx = ax; bestNz = az; } else { bestNx = -ax; bestNz = -az; }
  }
  return true;
}

/** Box vs box SAT with the 4 axes given in test order (b's axes first when b is the AABB). */
function satBoxes(
  acx: number, acz: number, afx: number, afz: number, arx: number, arz: number, ahw: number, ahl: number,
  bcx: number, bcz: number, bfx: number, bfz: number, brx: number, brz: number, bhw: number, bhl: number,
  a1x: number, a1z: number, a2x: number, a2z: number, a3x: number, a3z: number, a4x: number, a4z: number, out: Manifold): boolean {
  bestDepth = Infinity;
  if (!testAxis(a1x, a1z, acx, acz, afx, afz, arx, arz, ahw, ahl, bcx, bcz, bfx, bfz, brx, brz, bhw, bhl)) return false;
  if (!testAxis(a2x, a2z, acx, acz, afx, afz, arx, arz, ahw, ahl, bcx, bcz, bfx, bfz, brx, brz, bhw, bhl)) return false;
  if (!testAxis(a3x, a3z, acx, acz, afx, afz, arx, arz, ahw, ahl, bcx, bcz, bfx, bfz, brx, brz, bhw, bhl)) return false;
  if (!testAxis(a4x, a4z, acx, acz, afx, afz, arx, arz, ahw, ahl, bcx, bcz, bfx, bfz, brx, brz, bhw, bhl)) return false;
  out.nx = bestNx;
  out.nz = bestNz;
  out.depth = bestDepth;
  return true;
}

/** SAT axes: world X, world Z, obb forward, obb right. Normal from the AABB toward the OBB. */
export const obbVsAabb = (o: OBB, a: AABB, out: Manifold): boolean => {
  const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
  const rx = -fz, rz = fx;
  const bcx = (a.minX + a.maxX) * 0.5, bcz = (a.minZ + a.maxZ) * 0.5;
  const bhw = (a.maxX - a.minX) * 0.5, bhl = (a.maxZ - a.minZ) * 0.5;
  // AABB as a yaw-0 box: forward (0,1), right (-1,0); hw along x, hl along z.
  return satBoxes(o.cx, o.cz, fx, fz, rx, rz, o.hw, o.hl, bcx, bcz, 0, 1, -1, 0, bhw, bhl,
    1, 0, 0, 1, fx, fz, rx, rz, out);
};

/** Normal from b toward a. */
export const obbVsObb = (a: OBB, b: OBB, out: Manifold): boolean => {
  const afx = Math.sin(a.yaw), afz = Math.cos(a.yaw);
  const arx = -afz, arz = afx;
  const bfx = Math.sin(b.yaw), bfz = Math.cos(b.yaw);
  const brx = -bfz, brz = bfx;
  return satBoxes(a.cx, a.cz, afx, afz, arx, arz, a.hw, a.hl, b.cx, b.cz, bfx, bfz, brx, brz, b.hw, b.hl,
    afx, afz, arx, arz, bfx, bfz, brx, brz, out);
};

/**
 * Box (local frame: right = local x, forward = local z) vs circle. Normal from the circle toward the box.
 * Core routine shared by obbVsCircle / circleVsAabb.
 */
function boxVsCircleLocal(lx: number, lz: number, hw: number, hl: number, r: number, out: Manifold): boolean {
  // lx, lz: circle center in the box frame; out normal is in the box frame.
  const px = lx < -hw ? -hw : lx > hw ? hw : lx;
  const pz = lz < -hl ? -hl : lz > hl ? hl : lz;
  const dx = px - lx, dz = pz - lz;
  const d2 = dx * dx + dz * dz;
  if (d2 > 1e-12) {
    if (d2 >= r * r) return false;
    const d = Math.sqrt(d2);
    out.nx = dx / d; // from circle toward the box
    out.nz = dz / d;
    out.depth = r - d;
    return true;
  }
  // Circle center is inside the box: exit through the nearest face; move the box AWAY from that face.
  const penX = hw - Math.abs(lx);
  const penZ = hl - Math.abs(lz);
  if (penX < penZ) {
    out.nx = lx >= 0 ? -1 : 1;
    out.nz = 0;
    out.depth = penX + r;
  } else {
    out.nx = 0;
    out.nz = lz >= 0 ? -1 : 1;
    out.depth = penZ + r;
  }
  return true;
}

/** Normal from the circle toward the OBB. */
export const obbVsCircle = (o: OBB, c: Circle, out: Manifold): boolean => {
  const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
  const rx = -fz, rz = fx;
  const wx = c.cx - o.cx, wz = c.cz - o.cz;
  const lx = wx * rx + wz * rz;
  const lz = wx * fx + wz * fz;
  if (!boxVsCircleLocal(lx, lz, o.hw, o.hl, c.r, out)) return false;
  const nx = out.nx, nz = out.nz;
  out.nx = nx * rx + nz * fx;
  out.nz = nx * rz + nz * fz;
  return true;
};

/** Normal from the AABB toward the circle. */
export const circleVsAabb = (c: Circle, a: AABB, out: Manifold): boolean => {
  const bcx = (a.minX + a.maxX) * 0.5, bcz = (a.minZ + a.maxZ) * 0.5;
  const hw = (a.maxX - a.minX) * 0.5, hl = (a.maxZ - a.minZ) * 0.5;
  if (!boxVsCircleLocal(c.cx - bcx, c.cz - bcz, hw, hl, c.r, out)) return false;
  out.nx = -out.nx;
  out.nz = -out.nz;
  return true;
};

/** Normal from the OBB toward the circle. */
export const circleVsObb = (c: Circle, o: OBB, out: Manifold): boolean => {
  if (!obbVsCircle(o, c, out)) return false;
  out.nx = -out.nx;
  out.nz = -out.nz;
  return true;
};

/** Normal from b toward a. */
export const circleVsCircle = (a: Circle, b: Circle, out: Manifold): boolean => {
  const dx = a.cx - b.cx, dz = a.cz - b.cz;
  const rs = a.r + b.r;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rs * rs) return false;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    out.nx = dx / d;
    out.nz = dz / d;
    out.depth = rs - d;
  } else {
    out.nx = 1;
    out.nz = 0;
    out.depth = rs;
  }
  return true;
};

/** Entry parameter t in [0,1] of segment a->b against the box (0 when a is inside), or -1. */
export const segmentVsAabb = (ax: number, az: number, bx: number, bz: number, a: AABB): number => {
  const dx = bx - ax, dz = bz - az;
  let t0 = 0, t1 = 1;
  if (dx === 0) {
    if (ax < a.minX || ax > a.maxX) return -1;
  } else {
    const inv = 1 / dx;
    let ta = (a.minX - ax) * inv, tb = (a.maxX - ax) * inv;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  if (dz === 0) {
    if (az < a.minZ || az > a.maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let ta = (a.minZ - az) * inv, tb = (a.maxZ - az) * inv;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return t0;
};

/** Entry parameter t in [0,1] of segment a->b against the circle (0 when a is inside), or -1. */
export const segmentVsCircle = (ax: number, az: number, bx: number, bz: number, c: Circle): number => {
  const fx = ax - c.cx, fz = az - c.cz;
  const r2 = c.r * c.r;
  if (fx * fx + fz * fz <= r2) return 0;
  const dx = bx - ax, dz = bz - az;
  const A = dx * dx + dz * dz;
  if (A === 0) return -1;
  const B = 2 * (fx * dx + fz * dz);
  const C = fx * fx + fz * fz - r2;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t = (-B - sq) / (2 * A);
  if (t >= 0 && t <= 1) return t;
  return -1;
};

export const pointInAabb = (x: number, z: number, a: AABB): boolean => x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ;

export const obbBounds = (o: OBB, out: AABB): AABB => {
  const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
  const ex = o.hw * Math.abs(fz) + o.hl * Math.abs(fx); // |right.x| = |fz|, |forward.x| = |fx|
  const ez = o.hw * Math.abs(fx) + o.hl * Math.abs(fz);
  out.minX = o.cx - ex;
  out.maxX = o.cx + ex;
  out.minZ = o.cz - ez;
  out.maxZ = o.cz + ez;
  return out;
};

const scratchCircle: Circle = { cx: 0, cz: 0, r: 0 };
const scratchAabb: AABB = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };

/** Static shape (A) vs circle (B): normal from the circle toward the static shape. Move the circle by -n*depth. */
export const staticVsCircle = (s: StaticShape, c: Circle, out: Manifold): boolean => {
  if (s.kind === 'aabb') {
    scratchAabb.minX = s.minX; scratchAabb.minZ = s.minZ; scratchAabb.maxX = s.maxX; scratchAabb.maxZ = s.maxZ;
    if (!circleVsAabb(c, scratchAabb, out)) return false;
  } else {
    scratchCircle.cx = s.cx; scratchCircle.cz = s.cz; scratchCircle.r = s.r;
    if (!circleVsCircle(c, scratchCircle, out)) return false;
  }
  out.nx = -out.nx;
  out.nz = -out.nz;
  return true;
};

/** Static shape (A) vs OBB (B): normal from the OBB toward the static shape. Move the OBB by -n*depth. */
export const staticVsObb = (s: StaticShape, o: OBB, out: Manifold): boolean => {
  if (s.kind === 'aabb') {
    scratchAabb.minX = s.minX; scratchAabb.minZ = s.minZ; scratchAabb.maxX = s.maxX; scratchAabb.maxZ = s.maxZ;
    if (!obbVsAabb(o, scratchAabb, out)) return false;
  } else {
    scratchCircle.cx = s.cx; scratchCircle.cz = s.cz; scratchCircle.r = s.r;
    if (!obbVsCircle(o, scratchCircle, out)) return false;
  }
  out.nx = -out.nx;
  out.nz = -out.nz;
  return true;
};
