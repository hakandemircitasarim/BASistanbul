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
    parts.push(g);
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

/** Builds and adds the instanced prop meshes; 7 draw calls total. */
export class PropRenderer {
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

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
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      dummy.position.set(p.x, CURB_H, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      dummy.scale.set(p.scale, p.scale, p.scale);
      dummy.updateMatrix();
      mat.copy(dummy.matrix);
      if (p.kind === 'palm') {
        trunkM.setMatrixAt(trunkM.count, mat);
        frondM.setMatrixAt(frondM.count, mat);
        trunkM.count++; frondM.count++;
      } else if (p.kind === 'lamp') {
        poleM.setMatrixAt(poleM.count, mat);
        headM.setMatrixAt(headM.count, mat);
        poolM.setMatrixAt(poolM.count, mat);
        poleM.count++; headM.count++; poolM.count++;
      } else if (p.kind === 'bench') {
        benchM.setMatrixAt(benchM.count, mat);
        benchM.count++;
      } else {
        hydrantM.setMatrixAt(hydrantM.count, mat);
        hydrantM.count++;
      }
    }
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
      m.frustumCulled = true;
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
