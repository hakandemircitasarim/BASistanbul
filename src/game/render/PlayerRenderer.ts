// Blocky player character (orange shirt, jeans, skin head, swinging limbs) synced from the Player entity; hidden while driving. Track C.
import * as THREE from 'three';
import type { World } from '../world/World';
import type { Transform } from '../core/Types';
import { createTransform, lerpTransform } from '../core/Transform';
import { damp } from '../core/math';

const SHIRT = 0xff7a00;
const JEANS = 0x2a4d9c;
const SKIN = 0xe3b48f;

function box(w: number, h: number, d: number, mat: THREE.Material, pivotTop: boolean): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  if (pivotTop) g.translate(0, -h / 2, 0);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}

export class PlayerRenderer {
  readonly group = new THREE.Group();
  private readonly torso: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly armL: THREE.Mesh;
  private readonly armR: THREE.Mesh;
  private readonly legL: THREE.Mesh;
  private readonly legR: THREE.Mesh;
  private readonly matShirt = new THREE.MeshLambertMaterial({ color: SHIRT });
  private readonly matJeans = new THREE.MeshLambertMaterial({ color: JEANS });
  private readonly matSkin = new THREE.MeshLambertMaterial({ color: SKIN });
  private readonly interp: Transform = createTransform();
  private readonly scene: THREE.Scene;
  private swing = 0;
  private airPose = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.torso = box(0.5, 0.6, 0.28, this.matShirt, false);
    this.torso.position.y = 1.15;
    this.head = box(0.26, 0.28, 0.26, this.matSkin, false);
    this.head.position.y = 1.6;
    this.armL = box(0.14, 0.62, 0.14, this.matSkin, true);
    this.armL.position.set(-0.33, 1.42, 0);
    this.armR = box(0.14, 0.62, 0.14, this.matSkin, true);
    this.armR.position.set(0.33, 1.42, 0);
    this.legL = box(0.22, 0.85, 0.24, this.matJeans, true);
    this.legL.position.set(-0.13, 0.85, 0);
    this.legR = box(0.22, 0.85, 0.24, this.matJeans, true);
    this.legR.position.set(0.13, 0.85, 0);
    this.group.add(this.torso, this.head, this.armL, this.armR, this.legL, this.legR);
    this.group.rotation.order = 'YXZ';
    scene.add(this.group);
  }

  sync(world: World, alpha: number, frameDt: number): void {
    const p = world.player;
    const g = this.group;
    g.visible = p.vehicleId === null;
    if (!g.visible) return;
    lerpTransform(this.interp, p.prev, p.curr, alpha);
    const dt = Math.min(frameDt, 0.1);
    const sc = Math.max(0.01, p.spawnFade);
    g.position.set(this.interp.x, this.interp.y, this.interp.z);
    g.rotation.y = this.interp.yaw;
    g.scale.set(sc, sc, sc);

    if (!p.alive) {
      g.rotation.x = -Math.PI / 2;
      g.position.y += 0.25;
      this.setSwing(0, 0);
      return;
    }
    g.rotation.x = 0;
    const targetAmp = p.moving ? (p.sprinting ? 0.95 : 0.6) : 0;
    this.swing = damp(this.swing, targetAmp, 10, dt);
    this.airPose = damp(this.airPose, p.grounded ? 0 : 1, 12, dt);
    this.setSwing(Math.sin(p.animPhase) * this.swing, this.airPose);
  }

  private setSwing(s: number, air: number): void {
    const lean = air;
    this.legL.rotation.x = s * (1 - air) + 0.55 * air;
    this.legR.rotation.x = -s * (1 - air) - 0.15 * air;
    this.armL.rotation.x = -s * 0.8 * (1 - air) - 2.4 * air;
    this.armR.rotation.x = s * 0.8 * (1 - air) - 2.4 * air;
    this.torso.rotation.x = 0.08 * Math.abs(s) + 0.12 * lean;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.torso.geometry.dispose();
    this.head.geometry.dispose();
    this.armL.geometry.dispose();
    this.armR.geometry.dispose();
    this.legL.geometry.dispose();
    this.legR.geometry.dispose();
    this.matShirt.dispose();
    this.matJeans.dispose();
    this.matSkin.dispose();
  }
}
