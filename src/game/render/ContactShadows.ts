// Shared blob contact shadows: ONE instanced ground quad, sliced between the vehicle / ped / player renderers. Track C.
//
// Every grounded entity gets a soft dark ellipse on the floor. The whole city costs a single draw call because
// all three renderers write into fixed slices of the same InstancedMesh (each slice zeroes its unused tail).
import * as THREE from 'three';
import { BUDGET } from '../core/Budget';
import { clamp } from '../core/math';
import { BLOCK, CURB_H, GRID_COLS, GRID_ROWS, PITCH, ROAD_W, SIDEWALK_W } from '../city/CityConfig';

export const SHADOW_TUNING = {
  /** Slots: every vehicle + every ped + the player (+ spare). */
  capacity: BUDGET.MAX_VEHICLES + BUDGET.MAX_PEDS + 8,
  texSize: 64,
  /** Radius (0..1) of the fully opaque core; the rest fades to nothing at the rim. */
  core: 0.34,
  dayOpacity: 0.55,
  nightOpacity: 0.17,
  color: 0x120b1c,
} as const;

/**
 * Height of the walkable surface under a world point: block interiors and their sidewalks are raised to CURB_H,
 * the carriageway is at 0. O(1) grid math — a blob placed at road height would sink under the kerb otherwise.
 */
export function groundYAt(x: number, z: number): number {
  const col = Math.floor((x - ROAD_W) / PITCH);
  const row = Math.floor((z - ROAD_W) / PITCH);
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return 0;
  const bx = ROAD_W + col * PITCH, bz = ROAD_W + row * PITCH;
  const inX = x >= bx - SIDEWALK_W && x <= bx + BLOCK + SIDEWALK_W;
  const inZ = z >= bz - SIDEWALK_W && z <= bz + BLOCK + SIDEWALK_W;
  return inX && inZ ? CURB_H : 0;
}

const mat4 = new THREE.Matrix4();
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scl = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const zero = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

/** Soft radial alpha mask (white RGB, falloff in alpha) built without a canvas so Node tests can construct it. */
function blobTexture(): THREE.DataTexture {
  const n = SHADOW_TUNING.texSize;
  const data = new Uint8Array(n * n * 4);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const t = clamp((1 - d) / (1 - SHADOW_TUNING.core), 0, 1);
      const a = t * t * (3 - 2 * t); // smoothstep
      const i = (y * n + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** The single shared mesh; owns the slice allocator and the day/night opacity. */
class ShadowField {
  readonly mesh: THREE.InstancedMesh;
  private readonly tex: THREE.DataTexture;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly scene: THREE.Scene;
  private cursor = 0;
  private refs = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.tex = blobTexture();
    this.material = new THREE.MeshBasicMaterial({
      color: SHADOW_TUNING.color, map: this.tex, transparent: true, opacity: SHADOW_TUNING.dayOpacity,
      depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, this.material, SHADOW_TUNING.capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1; // under every other transparent (light pools, neon, markers)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < SHADOW_TUNING.capacity; i++) this.mesh.setMatrixAt(i, zero);
    scene.add(this.mesh);
  }

  retain(): void { this.refs++; }

  /** Hands out a contiguous block of instance slots; the mesh always draws every reserved slot. */
  reserve(n: number): number {
    const start = this.cursor;
    const room = Math.min(n, SHADOW_TUNING.capacity - start);
    this.cursor += Math.max(0, room);
    if (this.cursor > this.mesh.count) this.mesh.count = this.cursor;
    return start;
  }

  reservedRoom(start: number, want: number): number {
    return Math.max(0, Math.min(want, SHADOW_TUNING.capacity - start));
  }

  setNight(f: number): void {
    const t = clamp(f, 0, 1);
    this.material.opacity = SHADOW_TUNING.dayOpacity + (SHADOW_TUNING.nightOpacity - SHADOW_TUNING.dayOpacity) * t;
  }

  flush(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  release(): void {
    this.refs--;
    if (this.refs > 0) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
    this.tex.dispose();
    fields.delete(this.scene);
  }
}

const fields = new WeakMap<THREE.Scene, ShadowField>();

function fieldFor(scene: THREE.Scene): ShadowField {
  let f = fields.get(scene);
  if (!f) {
    f = new ShadowField(scene);
    fields.set(scene, f);
  }
  return f;
}

/**
 * A renderer's private window into the shared blob mesh.
 * Per frame: `begin()`, one `add()` per visible entity, `end()` (zeroes the leftovers).
 */
export class ContactShadows {
  private readonly field: ShadowField;
  private readonly start: number;
  private readonly cap: number;
  private used = 0;

  constructor(scene: THREE.Scene, capacity: number) {
    this.field = fieldFor(scene);
    this.field.retain();
    this.start = this.field.reserve(capacity);
    this.cap = this.field.reservedRoom(this.start, capacity);
  }

  /** Instances actually written on the last frame (tests / debug). */
  get count(): number { return this.used; }
  get capacity(): number { return this.cap; }

  begin(): void {
    this.used = 0;
  }

  /** Ellipse of half-extents (rx, rz) centred at (x, y, z), aligned to yaw; fade 0..1 shrinks it away. */
  add(x: number, y: number, z: number, rx: number, rz: number, yaw: number, fade: number): void {
    if (this.used >= this.cap) return;
    const f = fade <= 0 ? 0 : fade > 1 ? 1 : fade;
    pos.set(x, y, z);
    euler.set(0, yaw, 0);
    quat.setFromEuler(euler);
    scl.set(rx * 2 * f, 1, rz * 2 * f);
    mat4.compose(pos, quat, scl);
    this.field.mesh.setMatrixAt(this.start + this.used, mat4);
    this.used++;
  }

  end(): void {
    for (let i = this.used; i < this.cap; i++) this.field.mesh.setMatrixAt(this.start + i, zero);
    this.field.flush();
  }

  /** 0 = day (crisp blobs), 1 = night (soft, mostly lit by street lamps). Shared by every slice. */
  setNightFactor(f: number): void {
    this.field.setNight(f);
  }

  dispose(): void {
    this.begin();
    this.end();
    this.field.release();
  }
}
