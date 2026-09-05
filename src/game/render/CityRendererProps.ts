// Instanced street props for CityRenderer: palms (trunk + fronds), lamps (pole + head + light pool), benches, hydrants. Track B.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Prop } from '../city/CityData';
import { CURB_H } from '../city/CityConfig';
import type { Materials } from './Materials';

export const PROP_DIMS = { palmTrunkH: 6.4, palmFrondLen: 4.4, palmFrondW: 3.0, lampH: 6.5, lampArm: 1.4, poolRadius: 6 } as const;

const dummy = new THREE.Object3D();
const mat = new THREE.Matrix4();

function trunkGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const segH = PROP_DIMS.palmTrunkH / 3;
  let x = 0, y = 0;
  for (let i = 0; i < 3; i++) {
    const r0 = 0.24 - i * 0.04, r1 = 0.2 - i * 0.04;
    const g = new THREE.CylinderGeometry(r1, r0, segH, 7, 1);
    const tilt = 0.06 + i * 0.05;
    g.translate(0, segH / 2, 0);
    g.rotateZ(-tilt);
    g.translate(x, y, 0);
    x += Math.sin(tilt) * segH;
    y += Math.cos(tilt) * segH;
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  merged.userData.topX = x;
  merged.userData.topY = y;
  return merged;
}

/**
 * Adds a back face to every triangle without flipping its normal: the copy has reversed winding but keeps the
 * sky-facing normal, so a frond seen from below is shaded like foliage instead of going black at midday (which is
 * what THREE.DoubleSide does, since it negates the normal on back faces).
 */
function withBackFaces(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const back = g.clone();
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

function frondsGeometry(topX: number, topY: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const L = PROP_DIMS.palmFrondLen, W = PROP_DIMS.palmFrondW;
  for (let i = 0; i < 7; i++) {
    const g = new THREE.PlaneGeometry(W, L, 1, 2);
    // Plane spans y -L/2..L/2 with the tip at +v (top): move the base to the origin, droop, and spin around Y.
    g.translate(0, L / 2, 0);
    const pos = g.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      const y = pos.getY(k);
      const t = y / L;
      pos.setY(k, y - t * t * 1.6);
    }
    g.rotateX(-Math.PI / 2 + 0.55 + (i % 2) * 0.25);
    g.rotateY((i / 7) * Math.PI * 2);
    g.translate(topX, topY, 0);
    const both = withBackFaces(g);
    g.dispose();
    parts.push(both);
  }
  const merged = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  return merged;
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
export const PROP_RANGE = { palm: 300, lamp: 240, bench: 170, hydrant: 140, repackMove: 15 } as const;

interface PropGroup {
  /** Source placements: x, z, yaw, scale per prop (never mutated). */
  data: Float32Array;
  count: number;
  range2: number;
  meshes: THREE.InstancedMesh[];
}

/**
 * Builds and adds the instanced prop meshes; 7 draw calls total.
 *
 * The city holds ~1300 lamps and ~500 palms — drawing them all costs ~125k triangles per frame even when
 * they are half a kilometre behind the camera. Instead the source placements are kept on the CPU and only the
 * ones inside PROP_RANGE are written into the instance buffers, repacked whenever the camera has moved
 * `repackMove` metres. Draw calls stay at 7; the triangle count drops by roughly 6x.
 */
export class PropRenderer {
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly groups: PropGroup[] = [];
  private lastX = Infinity;
  private lastZ = Infinity;

  constructor(scene: THREE.Scene, props: Prop[], materials: Materials) {
    let palms = 0, lamps = 0, benches = 0, hydrants = 0;
    for (let i = 0; i < props.length; i++) {
      const k = props[i].kind;
      if (k === 'palm') palms++; else if (k === 'lamp') lamps++; else if (k === 'bench') benches++; else hydrants++;
    }
    const trunk = trunkGeometry();
    const fronds = frondsGeometry(trunk.userData.topX as number, trunk.userData.topY as number);
    const pole = poleGeometry();
    const head = new THREE.BoxGeometry(0.5, 0.22, 0.9);
    head.translate(0, PROP_DIMS.lampH - 0.2, PROP_DIMS.lampArm - 0.3);
    const pool = new THREE.PlaneGeometry(PROP_DIMS.poolRadius * 2, PROP_DIMS.poolRadius * 2);
    pool.rotateX(-Math.PI / 2);
    pool.translate(0, 0.06, PROP_DIMS.lampArm - 0.3);
    const bench = benchGeometry();
    const hydrant = hydrantGeometry();
    this.geometries.push(trunk, fronds, pole, head, pool, bench, hydrant);
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
    const trunkM = mk(trunk, materials.palmTrunk, palms, true);
    const frondM = mk(fronds, materials.palmFrond, palms, true);
    const poleM = mk(pole, materials.lampPole, lamps, true);
    const headM = mk(head, materials.lampHead(), lamps, false);
    const poolM = mk(pool, materials.lightPool(), lamps, false);
    poolM.renderOrder = 2;
    const benchM = mk(bench, materials.bench, benches, true);
    const hydrantM = mk(hydrant, materials.hydrant, hydrants, false);
    const group = (kind: Prop['kind'], n: number, range: number, meshes: THREE.InstancedMesh[]): PropGroup => {
      const g: PropGroup = { data: new Float32Array(Math.max(1, n) * 4), count: 0, range2: range * range, meshes };
      this.groups.push(g);
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        if (p.kind !== kind) continue;
        const o = g.count * 4;
        g.data[o] = p.x; g.data[o + 1] = p.z; g.data[o + 2] = p.yaw; g.data[o + 3] = p.scale;
        g.count++;
      }
      return g;
    };
    group('palm', palms, PROP_RANGE.palm, [trunkM, frondM]);
    group('lamp', lamps, PROP_RANGE.lamp, [poleM, headM, poolM]);
    group('bench', benches, PROP_RANGE.bench, [benchM]);
    group('hydrant', hydrants, PROP_RANGE.hydrant, [hydrantM]);
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
