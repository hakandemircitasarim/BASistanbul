// Backdrop: a ring of low, hazy hills around the landward sides of the city plus a ground skirt under them, so the
// horizon is a silhouette fading into the fog instead of the bare edge of the dirt plane. One merged mesh on the
// shared vertex-colour material (lit, fogged like everything else), so it needs no per-frame update. Track B.
import * as THREE from 'three';
import { CITY_MAX_X, CITY_MAX_Z, CITY_MIN_X, CITY_MIN_Z, OCEAN_X0 } from '../city/CityConfig';
import type { Materials } from './Materials';

/**
 * Ring layout. The hills follow a rounded rectangle `foot` metres outside the city's landward sides (west, north,
 * south; the east is the sea), rising over `rise` to a ridge of `hMin..hMax`, and falling back over `fall`; the
 * skirt is a flat plate from well inside the dirt plane out past the hills. The ridge sits ~1.5 city radii from the
 * centre, inside the camera's far plane from anywhere in the city, and the fog does the rest.
 */
const BACKDROP = {
  foot: 120, rise: 90, fall: 150, skirtOut: 320, skirtIn: 60, cornerR: 160, step: 22,
  hMin: 28, hMax: 125, groundY: -0.06, ground: 0x5a4e3c, hillFoot: 0x5e6650, hillRidge: 0x6f7a62,
} as const;

/** Seeded ridge profile: two octaves of sines, so the skyline rolls instead of repeating. */
function ridgeHeight(s: number): number {
  const a = Math.sin(s * 0.0071 + 1.3) * 0.5 + Math.sin(s * 0.0193 + 0.4) * 0.3 + Math.sin(s * 0.041 + 2.1) * 0.2;
  const t = 0.5 + 0.5 * a;
  return BACKDROP.hMin + (BACKDROP.hMax - BACKDROP.hMin) * t * t;
}

interface PathPoint { x: number; z: number; nx: number; nz: number; s: number }

/**
 * The hill path: a rounded rectangle around the dirt plane's landward sides, walked from the north-east down the
 * north side, the west side and back along the south side to the south-east, with outward normals.
 */
function hillPath(): PathPoint[] {
  const B = BACKDROP;
  const x0 = CITY_MIN_X - 80 - B.foot, x1 = OCEAN_X0 - 40, z0 = CITY_MIN_Z - 80 - B.foot, z1 = CITY_MAX_Z + 80 + B.foot;
  const r = B.cornerR;
  const pts: PathPoint[] = [];
  let s = 0;
  const push = (x: number, z: number, nx: number, nz: number): void => {
    if (pts.length) { const p = pts[pts.length - 1]; s += Math.hypot(x - p.x, z - p.z); }
    pts.push({ x, z, nx, nz, s });
  };
  // North side, east to west (normal -z), then the north-west corner arc, the west side (normal -x), the south-west arc,
  // and the south side west to east (normal +z).
  for (let x = x1; x > x0 + r; x -= B.step) push(x, z0, 0, -1);
  for (let a = 0; a <= Math.PI / 2 + 1e-6; a += B.step / r) push(x0 + r - Math.sin(a) * r, z0 + r - Math.cos(a) * r, -Math.sin(a), -Math.cos(a));
  for (let z = z0 + r + B.step; z < z1 - r; z += B.step) push(x0, z, -1, 0);
  for (let a = 0; a <= Math.PI / 2 + 1e-6; a += B.step / r) push(x0 + r - Math.cos(a) * r, z1 - r + Math.sin(a) * r, -Math.cos(a), Math.sin(a));
  for (let x = x0 + r + B.step; x <= x1; x += B.step) push(x, z1, 0, 1);
  return pts;
}

/** Builds the skirt plate and the hill strip into one vertex-coloured geometry (position, normal, color). */
function backdropGeometry(): THREE.BufferGeometry {
  const B = BACKDROP;
  const path = hillPath();
  const n = path.length;
  // Cross-section stations along the outward normal: offset, height factor (x ridge height), colour blend (0 foot, 1 ridge).
  const section = [
    { d: -B.skirtIn, h: 0, c: 0, ground: true },
    { d: 0, h: 0, c: 0, ground: false },
    { d: B.rise * 0.45, h: 0.55, c: 0.5, ground: false },
    { d: B.rise, h: 1, c: 1, ground: false },
    { d: B.rise + B.fall * 0.5, h: 0.4, c: 0.6, ground: false },
    { d: B.rise + B.fall, h: 0, c: 0.2, ground: false },
    { d: B.skirtOut, h: 0, c: 0, ground: true },
  ];
  const m = section.length;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const ground = new THREE.Color(B.ground), foot = new THREE.Color(B.hillFoot), ridge = new THREE.Color(B.hillRidge), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const p = path[i];
    const h = ridgeHeight(p.s);
    for (let k = 0; k < m; k++) {
      const st = section[k];
      pos.push(p.x + p.nx * st.d, B.groundY + h * st.h, p.z + p.nz * st.d);
      if (st.ground) c.copy(ground); else c.lerpColors(foot, ridge, st.c);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i + 1 < n; i++) {
    for (let k = 0; k + 1 < m; k++) {
      const a = i * m + k, b = a + m;
      // Winding chosen so the faces point up / toward the city (the path runs clockwise seen from above).
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  // Skirt plate under the dirt plane's landward margin: from inside the dirt out to the hill foot, three rectangles
  // (west, north, south) that stop at the ocean line.
  const gy = B.groundY;
  const dx0 = CITY_MIN_X - 80, dz0 = CITY_MIN_Z - 80, dz1 = CITY_MAX_Z + 80, ox = OCEAN_X0 - 40;
  const fx0 = dx0 - B.foot - B.skirtOut, fz0 = dz0 - B.foot - B.skirtOut, fz1 = dz1 + B.foot + B.skirtOut;
  const rect = (ax: number, az: number, bx: number, bz: number): void => {
    const base = pos.length / 3;
    pos.push(ax, gy, az, bx, gy, az, bx, gy, bz, ax, gy, bz);
    for (let k = 0; k < 4; k++) col.push(ground.r, ground.g, ground.b);
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  rect(fx0, fz0, dx0 + 40, fz1);
  rect(dx0 + 40, fz0, ox, dz0 + 40);
  rect(dx0 + 40, dz1 - 40, ox, fz1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Distant hill ring + ground skirt. Construct once after the city; nothing to update per frame. */
export class BackdropRenderer {
  readonly mesh: THREE.Mesh;
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene, materials: Materials) {
    this.scene = scene;
    this.mesh = new THREE.Mesh(backdropGeometry(), materials.plain);
    this.mesh.name = 'backdrop';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Extra draw calls this adds to the frame. */
  get drawCount(): number { return 1; }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
  }
}
