// Instanced pedestrian rendering: body/head/legs InstancedMeshes with per-ped colors, walk swing, tumble/lying pose, fade, distance collapse. Track E.
import * as THREE from 'three';
import type { World } from '../world/World';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Transform } from '../core/Types';
import { createTransform, lerpTransform } from '../core/Transform';
import { BUDGET } from '../core/Budget';
import { clamp } from '../core/math';

export const PED_RENDER = {
  cullDist: 120, bodyW: 0.44, bodyH: 0.62, bodyD: 0.26, bodyY: 1.12, headSize: 0.24, headY: 1.56,
  legW: 0.18, legH: 0.78, legD: 0.2, legX: 0.11, legTopY: 0.78, swingWalk: 0.55, swingFlee: 1.0, lyingLift: 0.22,
};

function box(w: number, h: number, d: number, pivotTop: boolean): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (pivotTop) g.translate(0, -h / 2, 0);
  return g;
}

export class PedRenderer {
  private readonly scene: THREE.Scene;
  private readonly body: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly legL: THREE.InstancedMesh;
  private readonly legR: THREE.InstancedMesh;
  private readonly mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
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
    this.body = this.make(box(R.bodyW, R.bodyH, R.bodyD, false), cap);
    this.head = this.make(box(R.headSize, R.headSize + 0.04, R.headSize, false), cap);
    this.legL = this.make(box(R.legW, R.legH, R.legD, true), cap);
    this.legR = this.make(box(R.legW, R.legH, R.legD, true), cap);
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
      n++;
    }
    this.finish(this.body, n);
    this.finish(this.head, n);
    this.finish(this.legL, n);
    this.finish(this.legR, n);
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
    const meshes = [this.body, this.head, this.legL, this.legR];
    for (let i = 0; i < meshes.length; i++) {
      this.scene.remove(meshes[i]);
      meshes[i].geometry.dispose();
      meshes[i].dispose();
    }
    this.mat.dispose();
  }
}
