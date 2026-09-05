// Instanced pedestrian rendering: body/head/arms/legs InstancedMeshes with per-ped colors, walk swing, tumble/lying pose, fade, distance collapse. Track E.
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ContactShadows, groundYAt } from './ContactShadows';
import type { World } from '../world/World';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Transform } from '../core/Types';
import { createTransform, lerpTransform } from '../core/Transform';
import { BUDGET } from '../core/Budget';
import { clamp } from '../core/math';

export const PED_RENDER = {
  cullDist: 120, bodyW: 0.44, bodyH: 0.62, bodyD: 0.26, bodyY: 1.12, headSize: 0.24, headY: 1.56,
  legW: 0.18, legH: 0.78, legD: 0.2, legX: 0.11, legTopY: 0.78, swingWalk: 0.55, swingFlee: 1.0, lyingLift: 0.22,
  armW: 0.13, armH: 0.6, armD: 0.15, armX: 0.28, armTopY: 1.38, armSwing: 0.75,
  shoeH: 0.1, shoeGrow: 1.25, hairH: 0.07, shadowR: 0.46, shadowLift: 0.03,
};

/** Vertex-colour multipliers layered under the per-instance colour: 1 keeps it, <1 darkens (hair, shoes). */
const TINT_PLAIN = 1, TINT_HAIR = 0.32, TINT_SHOE = 0.28;

/** Soft-edged limb (see PlayerRenderer): non-indexed like RoundedBoxGeometry so merges stay compatible. */
function box(w: number, h: number, d: number, pivotTop: boolean): THREE.BufferGeometry {
  const r = Math.min(0.045, Math.min(w, Math.min(h, d)) * 0.28);
  const g = new RoundedBoxGeometry(w, h, d, 1, r);
  if (pivotTop) g.translate(0, -h / 2, 0);
  return g;
}

/** Paints one grey level into a geometry's colour attribute so merged sub-boxes can darken the instance colour. */
function tinted(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) c[i] = k;
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Head + a darker hair cap on top, merged into one instanced part. */
function headGeometry(): THREE.BufferGeometry {
  const R = PED_RENDER;
  const skull = tinted(box(R.headSize, R.headSize + 0.04, R.headSize, false), TINT_PLAIN);
  const hair = box(R.headSize + 0.02, R.hairH, R.headSize + 0.02, false);
  hair.translate(0, (R.headSize + 0.04) / 2, 0);
  return BufferGeometryUtils.mergeGeometries([skull, tinted(hair, TINT_HAIR)], false);
}

/** Leg + a darker shoe at the ankle, pivoted at the hip so a single rotation swings the whole limb. */
function legGeometry(): THREE.BufferGeometry {
  const R = PED_RENDER;
  const leg = tinted(box(R.legW, R.legH, R.legD, true), TINT_PLAIN);
  const shoe = box(R.legW * R.shoeGrow, R.shoeH, R.legD * R.shoeGrow + 0.06, false);
  shoe.translate(0, -R.legH + R.shoeH / 2, 0.02);
  return BufferGeometryUtils.mergeGeometries([leg, tinted(shoe, TINT_SHOE)], false);
}

export class PedRenderer {
  private readonly scene: THREE.Scene;
  private readonly body: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly legL: THREE.InstancedMesh;
  private readonly legR: THREE.InstancedMesh;
  private readonly armL: THREE.InstancedMesh;
  private readonly armR: THREE.InstancedMesh;
  private readonly shadows: ContactShadows;
  private readonly mat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  private readonly interp: Transform = createTransform();
  private readonly base = new THREE.Matrix4();
  private readonly part = new THREE.Matrix4();
  private readonly out = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scl = new THREE.Vector3();
  private readonly unit = new THREE.Vector3(1, 1, 1);
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const R = PED_RENDER;
    const cap = BUDGET.MAX_PEDS;
    this.body = this.make(tinted(box(R.bodyW, R.bodyH, R.bodyD, false), TINT_PLAIN), cap);
    this.head = this.make(headGeometry(), cap);
    this.legL = this.make(legGeometry(), cap);
    this.legR = this.make(legGeometry(), cap);
    this.armL = this.make(tinted(box(R.armW, R.armH, R.armD, true), TINT_PLAIN), cap);
    this.armR = this.make(tinted(box(R.armW, R.armH, R.armD, true), TINT_PLAIN), cap);
    this.shadows = new ContactShadows(scene, cap);
  }

  private make(geo: THREE.BufferGeometry, cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, this.mat, cap);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.color.setRGB(1, 1, 1);
    for (let i = 0; i < cap; i++) m.setColorAt(i, this.color);
    this.scene.add(m);
    return m;
  }

  sync(world: World, alpha: number, camX: number, camZ: number): void {
    const R = PED_RENDER;
    const list = world.pedList;
    const cap = BUDGET.MAX_PEDS;
    let n = 0;
    this.shadows.begin();
    for (let i = 0; i < list.length && n < cap; i++) {
      const p = list[i];
      p.renderIndex = n;
      lerpTransform(this.interp, p.prev, p.curr, alpha);
      const t = this.interp;
      const dx = t.x - camX, dz = t.z - camZ;
      const visible = dx * dx + dz * dz < R.cullDist * R.cullDist;
      const sc = visible ? Math.max(0.001, clamp(p.spawnFade, 0, 1)) : 0;
      const lying = p.state === 'HIT' || p.state === 'DEAD';
      const pitch = lying ? -(Math.PI / 2) * clamp(p.tumble - 1, 0, 1) : 0;
      const lift = lying ? R.lyingLift * clamp(p.tumble - 1, 0, 1) : 0;
      this.euler.set(pitch, t.yaw, 0);
      this.quat.setFromEuler(this.euler);
      this.pos.set(t.x, t.y + lift, t.z);
      this.scl.set(sc, sc, sc);
      this.base.compose(this.pos, this.quat, this.scl);
      const amp = p.state === 'FLEE' ? R.swingFlee : p.state === 'WALK' && p.speed > 0.1 ? R.swingWalk : 0;
      const swing = lying ? 0 : Math.sin(p.animPhase) * amp;
      this.place(this.body, n, 0, R.bodyY, 0, 0, p.colors.shirt);
      this.place(this.head, n, 0, R.headY, 0, 0, p.colors.skin);
      this.place(this.legL, n, -R.legX, R.legTopY, 0, swing, p.colors.pants);
      this.place(this.legR, n, R.legX, R.legTopY, 0, -swing, p.colors.pants);
      // Arms counter-swing against the legs; sleeves take the shirt colour.
      this.place(this.armL, n, -R.armX, R.armTopY, 0, -swing * R.armSwing, p.colors.shirt);
      this.place(this.armR, n, R.armX, R.armTopY, 0, swing * R.armSwing, p.colors.shirt);
      if (sc > 0.01) {
        const r = lying ? R.shadowR * 1.7 : R.shadowR;
        const rz = lying ? R.shadowR * 0.75 : R.shadowR;
        this.shadows.add(t.x, groundYAt(t.x, t.z) + R.shadowLift, t.z, r, rz, t.yaw, sc);
      }
      n++;
    }
    this.finish(this.body, n);
    this.finish(this.head, n);
    this.finish(this.legL, n);
    this.finish(this.legR, n);
    this.finish(this.armL, n);
    this.finish(this.armR, n);
    this.shadows.end();
  }

  private place(mesh: THREE.InstancedMesh, idx: number, x: number, y: number, z: number, rotX: number, hex: number): void {
    this.pos.set(x, y, z);
    this.euler.set(rotX, 0, 0);
    this.quat.setFromEuler(this.euler);
    this.part.compose(this.pos, this.quat, this.unit);
    this.out.multiplyMatrices(this.base, this.part);
    mesh.setMatrixAt(idx, this.out);
    this.color.setHex(hex);
    mesh.setColorAt(idx, this.color);
  }

  private finish(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    const meshes = [this.body, this.head, this.legL, this.legR, this.armL, this.armR];
    for (let i = 0; i < meshes.length; i++) {
      this.scene.remove(meshes[i]);
      meshes[i].geometry.dispose();
      meshes[i].dispose();
    }
    this.shadows.dispose();
    this.mat.dispose();
  }
}
