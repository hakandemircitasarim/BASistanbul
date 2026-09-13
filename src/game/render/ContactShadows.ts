// Shared blob contact shadows: ONE instanced ground quad, sliced between the vehicle / ped / player renderers. Track C.
//
// Every grounded entity gets a soft dark ellipse on the floor. The whole city costs a single draw call because
// all three renderers write into fixed slices of the same InstancedMesh (each slice zeroes its unused tail).
import * as THREE from 'three';
import { BUDGET } from '../core/Budget';
import { clamp } from '../core/math';
import { BLOCK, CURB_H, GRID_COLS, GRID_ROWS, PITCH, ROAD_W, SIDEWALK_W } from '../city/CityConfig';

export const SHADOW_TUNING = {
  /**
   * Slots: every vehicle + every ped + the parked-car slice (CAR_SHADOWS.cap, 44) + the player + spare. The slices are
   * reserved once at construction and clamped to what is left, so this must cover all of them or the last renderer to
   * build silently gets fewer blobs than it asks for.
   */
  capacity: BUDGET.MAX_VEHICLES + BUDGET.MAX_PEDS + 48,
  texSize: 64,
  /**
   * Radius (0..1) of the fully opaque core; the rest fades to nothing at the rim.
   *
   * 0.72, not 0.5: with the multiply operator below the blob's alpha IS its occlusion, so the core is the only part
   * of the mask that reads at all, and at 0.5 the whole of it sat inside the caster's own footprint. The old vehicle
   * blob was 0.98 m across for a 1.8 m-wide sedan, so half of that put the dark part 20 cm INSIDE the sills - hiding
   * every live blob in the city at noon moved the lot asphalt beside a parked car by 0.5/255, i.e. nothing.
   * It is also the divisor VehicleRenderer.shadowExtent sizes the vehicle blobs by, so raising it widens them to
   * match rather than shrinking the visible pool. A ped's 0.6 m ellipse keeps a 43 cm opaque puddle around the
   * shoes. The remaining 28 % is still a smoothstep, so the rim does not read as a cut ellipse.
   */
  core: 0.72,
  /**
   * Occlusion of the core, i.e. how much light the multiply operator takes off the floor under a caster (see the
   * material below). Real cast shadows overlap the blobs by day so the day term stays the smaller of the two; at
   * night the moon shadow is almost nothing and the blob is the ONLY thing holding a car or a figure on the road.
   *
   * These are not the old alpha-over numbers and cannot be compared with them: 0.3 of an alpha-over toward a
   * near-black was worth 5.5/255 on lit pavement and 0.5/255 on lot asphalt. 0.5 of a multiply takes half the light.
   */
  dayOpacity: 0.5,
  nightOpacity: 0.62,
} as const;

/**
 * Height of the walkable surface under a world point: block interiors and their sidewalks are raised to CURB_H,
 * the carriageway is at 0. O(1) grid math — a blob placed at road height would sink under the kerb otherwise.
 *
 * The cell index is taken with the sidewalk apron folded IN (`+ SIDEWALK_W`), not from the block origin: a block's
 * raised surface runs [bx - SIDEWALK_W, bx + BLOCK + SIDEWALK_W], so a point on the apron on the LOW-x / LOW-z side
 * used to floor into the PREVIOUS cell, whose rect test then failed and answered 0 — the pavement on two of every
 * block's four faces read as carriageway. Shifting the index by the apron width maps every face of block c to cell c
 * and still leaves the carriageway (which is ROAD_W - 2 * SIDEWALK_W = 14 m wide between two aprons) outside the rect.
 */
export function groundYAt(x: number, z: number): number {
  const col = Math.floor((x - ROAD_W + SIDEWALK_W) / PITCH);
  const row = Math.floor((z - ROAD_W + SIDEWALK_W) / PITCH);
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
    // MULTIPLY, not alpha-over. The blob used to be a near-black quad lerped over the floor at 30 %, which is a
    // no-op on anything already dark: on lit lot asphalt it moved the mean by 0.5/255 (peak 22), inside the +-15/255
    // swing of the asphalt's own macro texture, and on the 19:00 pavement by 0.23/255 - the shoes met the paving with
    // literally no darkening. dst *= (1 - srcAlpha) instead makes the mask's alpha the OCCLUSION: it takes a fixed
    // FRACTION of whatever light the floor had, so it reads the same on white paving, grey road and black asphalt,
    // and it can never lighten anything (the old operator did, wherever the ground was darker than 0x0f0f12).
    // The RGB of the source is multiplied by zero and never reaches the framebuffer, so this material has no colour.
    // The alpha channel is kept on the destination (blendSrcAlpha/DstAlpha) so the blob does not punch holes in the
    // composer's alpha on the HDR path.
    this.material = new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, opacity: SHADOW_TUNING.dayOpacity,
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, blendEquationAlpha: THREE.AddEquation,
      depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    this.material.name = 'contactBlob'; // Renderer.sceneBreakdown() and the render probes attribute the mesh by this.
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, this.material, SHADOW_TUNING.capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Ground-transparent ladder: road paint and skid marks are renderOrder 1, the additive lamp pools 2, neon 3,
    // markers 4, particles 5-6. The blob has to land BETWEEN the paint and the additives. At -1 it drew FIRST among
    // the transparents, and since the paint writes no depth either, three then painted every lane line and lot bay
    // line back over the multiply at full brightness - the one thing in the frame the darkest pool could not darken.
    // It matters because `LOT_BAYS.bayPitch` is 3 m: a bay line sits 1.5 m from a parked car's centre, inside the
    // opaque core of its blob, and every one of the up to 44 parked-car blobs has one running through it.
    // Measured by toggling this line alone at hour 19 in the lot (a pure sort change - no shader, no material state,
    // so a runtime A/B is valid here): 0.52 % of the frame moves by more than 8/255, and the bay line crossing a
    // car's blob loses ~2 % of its brightness (mean of its brightest 200 px 158.0 -> 154.9).
    // 1.5 keeps it under every additive (a light pool must add on top of the shaded floor, not under it).
    this.mesh.renderOrder = 1.5;
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
