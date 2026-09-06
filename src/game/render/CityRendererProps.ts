// Instanced street props for CityRenderer: palms (two seeded variants: trunk + fronds), lamps (pole + head + light pool + facade spill), benches, hydrants. Track B.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Prop } from '../city/CityData';
import { CURB_H } from '../city/CityConfig';
import { Random } from '../core/Random';
import type { Materials } from './Materials';

export const PROP_DIMS = { palmTrunkH: 6.4, palmFrondLen: 4.4, palmFrondW: 3.0, lampH: 6.5, lampArm: 1.4, poolRadius: 9 } as const;

/** Street furniture colours; each part is baked into the vertex colours so one material covers all four kinds. */
const FURN = {
  binBody: 0x33513f, binLid: 0x1d3025, pole: 0x8b9298, blade: 0x1d6a49,
  post: 0x3a4046, roof: 0x2f353b, panel: 0x8fb4cc, seat: 0x8a6a44,
  bollard: 0x3c4147, bollardCap: 0xc3c8cd,
} as const;

const scratchColor = new THREE.Color();

/** Bakes one colour into a part's vertex colours, so merged multi-colour furniture needs a single material. */
function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  scratchColor.setHex(hex);
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = scratchColor.r; c[i * 3 + 1] = scratchColor.g; c[i * 3 + 2] = scratchColor.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function fuse(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  return merged;
}

/** Litter bin: a slightly conical body with a heavier lid. */
function binGeometry(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.27, 0.22, 0.72, 10, 1);
  body.translate(0, 0.36, 0);
  const lid = new THREE.CylinderGeometry(0.3, 0.3, 0.07, 10, 1);
  lid.translate(0, 0.755, 0);
  return fuse([paint(body, FURN.binBody), paint(lid, FURN.binLid)]);
}

/** Street-name sign: a pole with two blades crossing near the top so both streets are labelled. */
function signGeometry(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.045, 0.055, 2.5, 6, 1);
  pole.translate(0, 1.25, 0);
  const a = new THREE.BoxGeometry(0.95, 0.17, 0.035);
  a.translate(0.36, 2.3, 0);
  const b = new THREE.BoxGeometry(0.035, 0.17, 0.95);
  b.translate(0, 2.08, 0.36);
  return fuse([paint(pole, FURN.pole), paint(a, FURN.blade), paint(b, FURN.blade)]);
}

/** Bus shelter: four posts, a flat roof, a glazed back panel and a bench. Faces -Z (the road) at yaw 0. */
function shelterGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const px = i < 2 ? -1.72 : 1.72, pz = i % 2 === 0 ? -0.62 : 0.62;
    const post = new THREE.BoxGeometry(0.09, 2.4, 0.09);
    post.translate(px, 1.2, pz);
    parts.push(paint(post, FURN.post));
  }
  const roof = new THREE.BoxGeometry(3.75, 0.12, 1.55);
  roof.translate(0, 2.46, 0);
  parts.push(paint(roof, FURN.roof));
  const back = new THREE.BoxGeometry(3.5, 1.6, 0.06);
  back.translate(0, 1.24, 0.7);
  parts.push(paint(back, FURN.panel));
  const seat = new THREE.BoxGeometry(3.0, 0.08, 0.42);
  seat.translate(0, 0.46, 0.44);
  parts.push(paint(seat, FURN.seat));
  for (let i = 0; i < 2; i++) {
    const leg = new THREE.BoxGeometry(0.07, 0.46, 0.4);
    leg.translate(i === 0 ? -1.25 : 1.25, 0.23, 0.44);
    parts.push(paint(leg, FURN.post));
  }
  return fuse(parts);
}

/** Promenade bollard: a short post with a light cap. */
function bollardGeometry(): THREE.BufferGeometry {
  const post = new THREE.CylinderGeometry(0.09, 0.11, 0.82, 8, 1);
  post.translate(0, 0.41, 0);
  const cap = new THREE.SphereGeometry(0.095, 8, 5);
  cap.translate(0, 0.84, 0);
  return fuse([paint(post, FURN.bollard), paint(cap, FURN.bollardCap)]);
}

const dummy = new THREE.Object3D();
const mat = new THREE.Matrix4();

/** Bakes an RGB tint into a part's vertex colours. */
function tintRGB(g: THREE.BufferGeometry, r: number, gg: number, b: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/**
 * Trunk: six ringed segments (each flares at its base so the joints read as leaf-scar rings) following an S-curve,
 * with a crown bulb on top. The bark texture's v runs 0..1 over the whole trunk, so the material's repeat sets the
 * ring density. Seeded so the two palm variants lean differently.
 */
function trunkGeometry(seed: number): THREE.BufferGeometry {
  const rng = new Random(seed);
  const N = 6, H = PROP_DIMS.palmTrunkH;
  const lean = rng.range(0.05, 0.1), wob = rng.range(0.05, 0.08) * (rng.chance(0.5) ? 1 : -1);
  // One cylinder, two height segments per ring: every other ring row bulges (leaf scars) and the whole column is
  // bent along an S by displacing each ring in x. UV v already runs 0..1 over the height.
  const g = new THREE.CylinderGeometry(0.15, 0.27, H, 6, N * 2);
  g.translate(0, H / 2, 0);
  const pos = g.attributes.position;
  const bend = (t: number): number => lean * t * t * H * 0.9 + wob * Math.sin(t * Math.PI * 2) * 0.35;
  for (let k = 0; k < pos.count; k++) {
    const y = pos.getY(k), t = y / H;
    const ring = Math.round(t * N * 2);
    const bulge = ring % 2 === 1 && ring < N * 2 ? 1.12 : 1;
    pos.setX(k, pos.getX(k) * bulge + bend(t));
    pos.setZ(k, pos.getZ(k) * bulge);
  }
  g.computeVertexNormals();
  const bulb = new THREE.SphereGeometry(0.4, 6, 4);
  bulb.scale(1, 0.8, 1);
  bulb.translate(bend(1), H + 0.1, 0);
  const merged = fuse([g, bulb]);
  merged.userData.topX = bend(1);
  merged.userData.topY = H;
  return merged;
}

/**
 * Adds a back face to every triangle without flipping its normal: the copy has reversed winding but keeps the
 * sky-facing normal, so a frond seen from below is shaded like foliage instead of going black at midday (which is
 * what THREE.DoubleSide does, since it negates the normal on back faces). The copy is the leaf's underside, so its
 * vertex colour is pulled darker and a little cooler (`underside`): a frond then has two tones, top and shadow side,
 * instead of reading as one flat paper cut-out.
 */
function withBackFaces(g: THREE.BufferGeometry, underside = 1): THREE.BufferGeometry {
  const back = g.clone();
  const col = back.attributes.color as THREE.BufferAttribute | undefined;
  if (col && underside !== 1) {
    for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * underside, col.getY(i) * underside * 0.97, col.getZ(i) * underside * 0.92);
  }
  const idx = back.getIndex();
  if (idx) {
    const a = idx.array as ArrayLike<number>;
    const flipped = new Uint32Array(a.length);
    for (let i = 0; i < a.length; i += 3) { flipped[i] = a[i]; flipped[i + 1] = a[i + 2]; flipped[i + 2] = a[i + 1]; }
    back.setIndex(new THREE.BufferAttribute(flipped, 1));
  }
  const merged = mergeGeometries([g, back], false);
  back.dispose();
  return merged;
}

/**
 * One frond: a 2 x 3 segment plane whose centre column is lifted (the midrib crease, so the leaf is a V and shades
 * on both halves), drooping toward the tip. `pitch` is the angle from straight up: 0 = vertical, PI/2 = horizontal,
 * beyond that the frond hangs.
 */
function frond(len: number, width: number, pitch: number, yaw: number, droop: number, crease: number, cols = 2, rows = 3): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, len, cols, rows);
  g.translate(0, len / 2, 0);
  const pos = g.attributes.position;
  for (let k = 0; k < pos.count; k++) {
    const y = pos.getY(k), t = y / len;
    pos.setY(k, y - t * t * droop);
    if (Math.abs(pos.getX(k)) < 1e-4) pos.setZ(k, crease * (0.4 + 0.6 * (1 - t)));
  }
  g.computeVertexNormals();
  g.rotateX(-pitch);
  g.rotateY(yaw);
  return g;
}

/** Crown: 11 live fronds with seeded jitter plus a skirt of 4 short dead fronds hanging below them. */
function frondsGeometry(topX: number, topY: number, seed: number): THREE.BufferGeometry {
  const rng = new Random(seed);
  const parts: THREE.BufferGeometry[] = [];
  const L = PROP_DIMS.palmFrondLen, W = PROP_DIMS.palmFrondW;
  const n = 11;
  for (let i = 0; i < n; i++) {
    const len = L * rng.range(0.8, 1.1);
    const g = frond(len, W, rng.range(0.35, 0.95), (i / n) * Math.PI * 2 + rng.range(-0.25, 0.25), 1.6 * (len / L), 0.18);
    g.translate(topX, topY, 0);
    const v = rng.range(0.82, 1);
    tintRGB(g, v, v, v * 0.96);
    const both = withBackFaces(g, 0.66);
    g.dispose();
    parts.push(both);
  }
  for (let i = 0; i < 4; i++) {
    const len = L * rng.range(0.5, 0.7);
    const g = frond(len, W * 0.7, rng.range(1.6, 1.9), (i / 4) * Math.PI * 2 + rng.range(-0.4, 0.4), 0.5, 0, 1, 2);
    g.translate(topX, topY - 0.15, 0);
    tintRGB(g, 0.5, 0.4, 0.26);
    const both = withBackFaces(g, 0.78);
    g.dispose();
    parts.push(both);
  }
  return fuse(parts);
}

function poleGeometry(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.09, 0.13, PROP_DIMS.lampH, 6, 1);
  pole.translate(0, PROP_DIMS.lampH / 2, 0);
  const arm = new THREE.BoxGeometry(0.12, 0.12, PROP_DIMS.lampArm);
  arm.translate(0, PROP_DIMS.lampH - 0.1, PROP_DIMS.lampArm / 2);
  const merged = mergeGeometries([pole, arm], false);
  pole.dispose(); arm.dispose();
  return merged;
}

function benchGeometry(): THREE.BufferGeometry {
  const seat = new THREE.BoxGeometry(1.7, 0.08, 0.5);
  seat.translate(0, 0.45, 0);
  const back = new THREE.BoxGeometry(1.7, 0.45, 0.06);
  back.translate(0, 0.72, -0.24);
  const legL = new THREE.BoxGeometry(0.08, 0.45, 0.45);
  legL.translate(-0.75, 0.22, 0);
  const legR = new THREE.BoxGeometry(0.08, 0.45, 0.45);
  legR.translate(0.75, 0.22, 0);
  const merged = mergeGeometries([seat, back, legL, legR], false);
  seat.dispose(); back.dispose(); legL.dispose(); legR.dispose();
  return merged;
}

function hydrantGeometry(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.16, 0.2, 0.7, 8, 1);
  body.translate(0, 0.35, 0);
  const cap = new THREE.SphereGeometry(0.17, 8, 6);
  cap.translate(0, 0.72, 0);
  const side = new THREE.BoxGeometry(0.5, 0.12, 0.14);
  side.translate(0, 0.45, 0);
  const merged = mergeGeometries([body, cap, side], false);
  body.dispose(); cap.dispose(); side.dispose();
  return merged;
}

/** Draw radius per prop kind: past this the prop is a couple of pixels, so it is left out of the instance buffer. */
export const PROP_RANGE = { palm: 165, lamp: 240, bench: 170, hydrant: 140, bin: 130, sign: 175, shelter: 210, bollard: 120, repackMove: 15 } as const;

/** Seeds of the two palm variants; palms alternate between them by index. */
const PALM_SEEDS = [1201, 2417] as const;

interface PropGroup {
  /** Source placements: x, z, yaw, scale per prop (never mutated). */
  data: Float32Array;
  count: number;
  range2: number;
  meshes: THREE.InstancedMesh[];
}

/**
 * Builds and adds the instanced prop meshes; 14 draw calls total (two palm variants, four lamp parts).
 *
 * The city holds ~1300 lamps and ~500 palms — drawing them all costs ~125k triangles per frame even when
 * they are half a kilometre behind the camera. Instead the source placements are kept on the CPU and only the
 * ones inside PROP_RANGE are written into the instance buffers, repacked whenever the camera has moved
 * `repackMove` metres. Draw calls stay fixed; the triangle count drops by roughly 6x.
 */
export class PropRenderer {
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly groups: PropGroup[] = [];
  private lastX = Infinity;
  private lastZ = Infinity;

  constructor(scene: THREE.Scene, props: Prop[], materials: Materials) {
    const counts: Record<Prop['kind'], number> = { palm: 0, lamp: 0, bench: 0, hydrant: 0, bin: 0, sign: 0, shelter: 0, bollard: 0 };
    for (let i = 0; i < props.length; i++) counts[props[i].kind]++;
    const pole = poleGeometry();
    const head = new THREE.BoxGeometry(0.5, 0.22, 0.9);
    head.translate(0, PROP_DIMS.lampH - 0.2, PROP_DIMS.lampArm - 0.3);
    const pool = new THREE.PlaneGeometry(PROP_DIMS.poolRadius * 2, PROP_DIMS.poolRadius * 2);
    pool.rotateX(-Math.PI / 2);
    pool.translate(0, 0.06, PROP_DIMS.lampArm - 0.3);
    // Facade spill: a vertical glow behind the pole (the kerb side is -Z; the arm points +Z over the road).
    const spill = new THREE.PlaneGeometry(2.5, 4.5);
    spill.translate(0, 2.25, -0.9);
    const bench = benchGeometry();
    const hydrant = hydrantGeometry();
    const bin = binGeometry();
    const sign = signGeometry();
    const shelter = shelterGeometry();
    const bollard = bollardGeometry();
    this.geometries.push(pole, head, pool, spill, bench, hydrant, bin, sign, shelter, bollard);
    const mk = (g: THREE.BufferGeometry, m: THREE.Material, n: number, shadow: boolean): THREE.InstancedMesh => {
      const im = new THREE.InstancedMesh(g, m, Math.max(1, n));
      im.count = 0;
      im.castShadow = shadow;
      im.receiveShadow = false;
      im.frustumCulled = false;
      this.meshes.push(im);
      scene.add(im);
      return im;
    };
    const palmMeshes: THREE.InstancedMesh[][] = [];
    for (let v = 0; v < PALM_SEEDS.length; v++) {
      const trunk = trunkGeometry(PALM_SEEDS[v]);
      const fronds = frondsGeometry(trunk.userData.topX as number, trunk.userData.topY as number, PALM_SEEDS[v] + 7);
      this.geometries.push(trunk, fronds);
      const n = Math.ceil(counts.palm / PALM_SEEDS.length);
      palmMeshes.push([mk(trunk, materials.palmTrunk, n, true), mk(fronds, materials.palmFrond, n, true)]);
    }
    const poleM = mk(pole, materials.lampPole, counts.lamp, true);
    const headM = mk(head, materials.lampHead(), counts.lamp, false);
    const poolM = mk(pool, materials.lightPool(), counts.lamp, false);
    poolM.renderOrder = 2;
    const spillM = mk(spill, materials.lampSpill(), counts.lamp, false);
    spillM.renderOrder = 2;
    const benchM = mk(bench, materials.bench, counts.bench, true);
    const hydrantM = mk(hydrant, materials.hydrant, counts.hydrant, false);
    const binM = mk(bin, materials.furniture, counts.bin, true);
    const signM = mk(sign, materials.furniture, counts.sign, true);
    const shelterM = mk(shelter, materials.furniture, counts.shelter, true);
    const bollardM = mk(bollard, materials.furniture, counts.bollard, false);
    // `parity`/`mod` split one kind over several groups (palm variants) by its index within the kind.
    const group = (kind: Prop['kind'], n: number, range: number, meshes: THREE.InstancedMesh[], parity = 0, mod = 1): PropGroup => {
      const g: PropGroup = { data: new Float32Array(Math.max(1, n) * 4), count: 0, range2: range * range, meshes };
      this.groups.push(g);
      let idx = 0;
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        if (p.kind !== kind) continue;
        if (idx++ % mod !== parity) continue;
        const o = g.count * 4;
        g.data[o] = p.x; g.data[o + 1] = p.z; g.data[o + 2] = p.yaw; g.data[o + 3] = p.scale;
        g.count++;
      }
      return g;
    };
    for (let v = 0; v < PALM_SEEDS.length; v++) group('palm', Math.ceil(counts.palm / PALM_SEEDS.length), PROP_RANGE.palm, palmMeshes[v], v, PALM_SEEDS.length);
    group('lamp', counts.lamp, PROP_RANGE.lamp, [poleM, headM, poolM, spillM]);
    group('bench', counts.bench, PROP_RANGE.bench, [benchM]);
    group('hydrant', counts.hydrant, PROP_RANGE.hydrant, [hydrantM]);
    group('bin', counts.bin, PROP_RANGE.bin, [binM]);
    group('sign', counts.sign, PROP_RANGE.sign, [signM]);
    group('shelter', counts.shelter, PROP_RANGE.shelter, [shelterM]);
    group('bollard', counts.bollard, PROP_RANGE.bollard, [bollardM]);
    // Instanced meshes cannot be culled per instance, and their bounds span the whole city: pack by distance instead.
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i].frustumCulled = false;
    this.repack(0, 0);
  }

  /** Refills the instance buffers with the props near (camX, camZ); cheap and only runs after real movement. */
  update(camX: number, camZ: number): void {
    const dx = camX - this.lastX, dz = camZ - this.lastZ;
    if (dx * dx + dz * dz < PROP_RANGE.repackMove * PROP_RANGE.repackMove) return;
    this.repack(camX, camZ);
  }

  private repack(camX: number, camZ: number): void {
    this.lastX = camX;
    this.lastZ = camZ;
    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi];
      let written = 0;
      for (let i = 0; i < g.count; i++) {
        const o = i * 4;
        const x = g.data[o], z = g.data[o + 1];
        const ddx = x - camX, ddz = z - camZ;
        if (ddx * ddx + ddz * ddz > g.range2) continue;
        dummy.position.set(x, CURB_H, z);
        dummy.rotation.set(0, g.data[o + 2], 0);
        const sc = g.data[o + 3];
        dummy.scale.set(sc, sc, sc);
        dummy.updateMatrix();
        mat.copy(dummy.matrix);
        for (let m = 0; m < g.meshes.length; m++) g.meshes[m].setMatrixAt(written, mat);
        written++;
      }
      for (let m = 0; m < g.meshes.length; m++) {
        const mesh = g.meshes[m];
        mesh.count = written;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  get drawCount(): number { return this.meshes.length; }

  dispose(): void {
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      if (m.parent) m.parent.remove(m);
      m.dispose();
    }
    for (let i = 0; i < this.geometries.length; i++) this.geometries[i].dispose();
    this.meshes.length = 0;
    this.geometries.length = 0;
  }
}
