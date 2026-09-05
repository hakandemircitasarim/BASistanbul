// Transform helpers (create/copy/interpolate) for entity prev/curr state. Track P0.
import type { Transform } from './Types';
import { lerpAngle } from './math';

export const createTransform = (x = 0, y = 0, z = 0, yaw = 0): Transform => ({ x, y, z, yaw });

export const copyTransform = (dst: Transform, src: Transform): void => {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.yaw = src.yaw;
};

/** Linear position interpolation + shortest-arc yaw interpolation. */
export const lerpTransform = (out: Transform, prev: Transform, curr: Transform, alpha: number): Transform => {
  out.x = prev.x + (curr.x - prev.x) * alpha;
  out.y = prev.y + (curr.y - prev.y) * alpha;
  out.z = prev.z + (curr.z - prev.z) * alpha;
  out.yaw = lerpAngle(prev.yaw, curr.yaw, alpha);
  return out;
};
