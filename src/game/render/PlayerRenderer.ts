// Blocky player character (orange shirt, jeans, skin head, swinging limbs) synced from the Player entity; hidden while driving. Track C.
import * as THREE from 'three';
import type { World } from '../world/World';
import type { Transform } from '../core/Types';
import { createTransform, lerpTransform } from '../core/Transform';
import { damp } from '../core/math';
import { ContactShadows, groundYAt } from './ContactShadows';

const SHIRT = 0xff7a00;
const JEANS = 0x2a4d9c;
const SKIN = 0xe3b48f;
const HAIR = 0x2a1d17;
const SHOE = 0x1b1b20;
const SHADOW_R = 0.56;
const SHADOW_LIFT = 0.03;

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
  private readonly hair: THREE.Mesh;
  private readonly handL: THREE.Mesh;
  private readonly handR: THREE.Mesh;
  private readonly shoeL: THREE.Mesh;
  private readonly shoeR: THREE.Mesh;
  private readonly shadows: ContactShadows;
  private readonly matShirt = new THREE.MeshLambertMaterial({ color: SHIRT });
  private readonly matJeans = new THREE.MeshLambertMaterial({ color: JEANS });
  private readonly matSkin = new THREE.MeshLambertMaterial({ color: SKIN });
  private readonly matHair = new THREE.MeshLambertMaterial({ color: HAIR });
  private readonly matShoe = new THREE.MeshLambertMaterial({ color: SHOE });
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
    this.hair = box(0.28, 0.08, 0.28, this.matHair, false);
    this.hair.position.y = 1.76;
    this.armL = box(0.14, 0.44, 0.14, this.matShirt, true);
    this.armL.position.set(-0.33, 1.42, 0);
    this.armR = box(0.14, 0.44, 0.14, this.matShirt, true);
    this.armR.position.set(0.33, 1.42, 0);
    // Hands and shoes are children of the limbs, so one limb rotation moves the whole chain.
    this.handL = box(0.15, 0.18, 0.15, this.matSkin, true);
    this.handL.position.y = -0.44;
    this.armL.add(this.handL);
    this.handR = box(0.15, 0.18, 0.15, this.matSkin, true);
    this.handR.position.y = -0.44;
    this.armR.add(this.handR);
    this.legL = box(0.22, 0.85, 0.24, this.matJeans, true);
    this.legL.position.set(-0.13, 0.85, 0);
    this.legR = box(0.22, 0.85, 0.24, this.matJeans, true);
    this.legR.position.set(0.13, 0.85, 0);
    this.shoeL = box(0.25, 0.12, 0.32, this.matShoe, false);
    this.shoeL.position.set(0, -0.79, 0.03);
    this.legL.add(this.shoeL);
    this.shoeR = box(0.25, 0.12, 0.32, this.matShoe, false);
    this.shoeR.position.set(0, -0.79, 0.03);
    this.legR.add(this.shoeR);
    this.group.add(this.torso, this.head, this.hair, this.armL, this.armR, this.legL, this.legR);
    this.group.rotation.order = 'YXZ';
    scene.add(this.group);
    this.shadows = new ContactShadows(scene, 1);
  }

  sync(world: World, alpha: number, frameDt: number): void {
    const p = world.player;
    const g = this.group;
    g.visible = p.vehicleId === null;
    this.shadows.begin();
    if (!g.visible) { this.shadows.end(); return; }
    lerpTransform(this.interp, p.prev, p.curr, alpha);
    const dt = Math.min(frameDt, 0.1);
    const sc = Math.max(0.01, p.spawnFade);
    g.position.set(this.interp.x, this.interp.y, this.interp.z);
    g.rotation.y = this.interp.yaw;
    g.scale.set(sc, sc, sc);

    this.shadows.add(this.interp.x, groundYAt(this.interp.x, this.interp.z) + SHADOW_LIFT, this.interp.z,
      SHADOW_R, p.alive ? SHADOW_R : SHADOW_R * 1.8, this.interp.yaw, sc);
    this.shadows.end();

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
    // Arms rest slightly away from the body when still, swing opposite the legs when moving, reach up in the air.
    const idle = 0.12 * (1 - Math.min(1, Math.abs(s) * 4));
    this.armL.rotation.x = -s * 0.8 * (1 - air) - 2.4 * air;
    this.armR.rotation.x = s * 0.8 * (1 - air) - 2.4 * air;
    this.armL.rotation.z = idle;
    this.armR.rotation.z = -idle;
    this.torso.rotation.x = 0.08 * Math.abs(s) + 0.12 * lean;
    this.head.rotation.x = -0.05 * Math.abs(s);
    this.hair.rotation.x = this.head.rotation.x;
  }

  dispose(): void {
    this.scene.remove(this.group);
    const parts = [this.torso, this.head, this.hair, this.armL, this.armR, this.legL, this.legR, this.handL, this.handR, this.shoeL, this.shoeR];
    for (let i = 0; i < parts.length; i++) parts[i].geometry.dispose();
    this.shadows.dispose();
    this.matShirt.dispose();
    this.matJeans.dispose();
    this.matSkin.dispose();
    this.matHair.dispose();
    this.matShoe.dispose();
  }
}
