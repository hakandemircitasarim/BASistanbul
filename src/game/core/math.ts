// Allocation-free scalar/angle/vector helpers shared by all simulation code. Track P0.
import type { Vec2 } from './Types';

const TWO_PI = Math.PI * 2;

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Frame-rate independent exponential approach: a + (b - a) * (1 - exp(-lambda * dt)). */
export const damp = (a: number, b: number, lambda: number, dt: number): number => a + (b - a) * (1 - Math.exp(-lambda * dt));
/** Wraps an angle into -PI..PI. */
export const wrapAngle = (a: number): number => a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
/** Wrapped (to - from). */
export const angleDiff = (from: number, to: number): number => wrapAngle(to - from);
export const lerpAngle = (a: number, b: number, t: number): number => a + angleDiff(a, b) * t;
export const dampAngle = (a: number, b: number, lambda: number, dt: number): number => a + angleDiff(a, b) * (1 - Math.exp(-lambda * dt));
/** forward(yaw) = (sin yaw, cos yaw); yaw 0 faces +Z. */
export const forwardOf = (yaw: number, out: Vec2): Vec2 => {
  out.x = Math.sin(yaw);
  out.z = Math.cos(yaw);
  return out;
};
/** right(yaw) = (-cos yaw, sin yaw). */
export const rightOf = (yaw: number, out: Vec2): Vec2 => {
  out.x = -Math.cos(yaw);
  out.z = Math.sin(yaw);
  return out;
};
/** right2D(d) = (-d.z, d.x). Safe when out === d. */
export const right2D = (d: Vec2, out: Vec2): Vec2 => {
  const dx = d.x;
  out.x = -d.z;
  out.z = dx;
  return out;
};
export const len2 = (x: number, z: number): number => Math.sqrt(x * x + z * z);
export const dist2D = (ax: number, az: number, bx: number, bz: number): number => {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
};
/** Yaw of a direction vector: atan2(dx, dz). */
export const yawFromDir = (dx: number, dz: number): number => Math.atan2(dx, dz);
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
