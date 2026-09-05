// Player character (orange shirt, jeans, skin head, swinging limbs) synced from the Player entity; hidden while driving. Track C.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { World } from '../world/World';
import type { Transform } from '../core/Types';
import { createTransform, lerpTransform } from '../core/Transform';
import { damp } from '../core/math';
import { ContactShadows, groundYAt } from './ContactShadows';

const SHIRT = 0xff7a00;
const SLEEVE = 0xe86e00;
const JEANS = 0x2a4d9c;
const BELT = 0x1d3468;
const SKIN = 0xe3b48f;
const HAIR = 0x2a1d17;
const SHOE = 0x1b1b20;
const SHADOW_R = 0.56;
const SHADOW_LIFT = 0.03;

/**
 * Body proportions in metres, measured from the ground. The character is a stack of tapered, bevelled boxes: the
 * taper (narrow waist, narrow jaw, calf thinner than thigh) is what stops it reading as a pile of cubes, and each
 * limb is merged into one geometry so the whole figure is six draw calls.
 */
const BODY = {
  hipY: 0.85,
  torsoH: 0.61, shoulderW: 0.46, shoulderD: 0.29, waistK: 0.72,
  beltH: 0.1, beltW: 0.39, beltD: 0.27,
  neckY: 1.46, neckH: 0.08, neckW: 0.12,
  headY: 1.53, headH: 0.27, headW: 0.235, headD: 0.245, jawK: 0.82,
  hairH: 0.115, hairGrow: 1.06, backHairH: 0.2,
  shoulderY: 1.4, shoulderX: 0.278,
  upperArmH: 0.28, upperArmW: 0.115, foreArmH: 0.25, foreArmW: 0.098, handH: 0.13, handW: 0.105,
  hipX: 0.115, thighH: 0.45, thighW: 0.2, shinH: 0.4, shinW: 0.165,
  shoeH: 0.11, shoeW: 0.17, shoeD: 0.3, shoeFwd: 0.05,
} as const;

const scratchColor = new THREE.Color();

/** Bevelled box with an optional taper: x/z are scaled from `botK` at the bottom face to 1 at the top. */
function bevel(w: number, h: number, d: number, botK = 1): THREE.BufferGeometry {
  const r = Math.min(0.07, Math.min(w, Math.min(h, d)) * 0.3);
  const g = new RoundedBoxGeometry(w, h, d, 1, r);
  if (botK !== 1) {
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(1, Math.max(0, pos.getY(i) / h + 0.5));
      const k = botK + (1 - botK) * t;
      pos.setX(i, pos.getX(i) * k);
      pos.setZ(i, pos.getZ(i) * k);
    }
    g.computeVertexNormals();
  }
  return g;
}

/** Paints a whole part one colour, so limbs of different colours can share a single vertex-coloured material. */
function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  scratchColor.setHex(hex);
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = scratchColor.r; c[i * 3 + 1] = scratchColor.g; c[i * 3 + 2] = scratchColor.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Merges painted parts into one geometry (all inputs are non-indexed RoundedBoxGeometry, so the merge is valid). */
function fuse(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  return merged;
}

/** Torso from the hip up: tapered shirt, belt and neck. Local origin sits at the hip so the lean pivots there. */
function torsoGeometry(): THREE.BufferGeometry {
  const B = BODY;
  const shirt = bevel(B.shoulderW, B.torsoH, B.shoulderD, B.waistK);
  shirt.translate(0, B.torsoH / 2, 0);
  const belt = bevel(B.beltW, B.beltH, B.beltD);
  belt.translate(0, B.beltH / 2 - 0.01, 0);
  const neck = bevel(B.neckW, B.neckH + 0.03, B.neckW);
  neck.translate(0, B.neckY - B.hipY + B.neckH / 2 - 0.03, 0);
  return fuse([paint(shirt, SHIRT), paint(belt, BELT), paint(neck, SKIN)]);
}

/** Head: a jaw-tapered skull with a hair cap over the crown and a shorter panel down the back. */
function headGeometry(): THREE.BufferGeometry {
  const B = BODY;
  const skull = bevel(B.headW, B.headH, B.headD, B.jawK);
  const cap = bevel(B.headW * B.hairGrow, B.hairH, B.headD * B.hairGrow, 0.99);
  cap.translate(0, B.headH / 2 - B.hairH * 0.35, 0);
  // Hair wraps the back of the skull down to the nape; without it the head reads as a bald skin block from behind,
  // which is the angle the third-person camera spends all its time at.
  const back = bevel(B.headW * 0.98, B.backHairH, B.headD * 0.4);
  back.translate(0, B.headH * 0.06, -B.headD * 0.35);
  return fuse([paint(skull, SKIN), paint(cap, HAIR), paint(back, HAIR)]);
}

/** Arm hanging from the shoulder: sleeve, bare forearm, hand. Local origin at the shoulder joint. */
function armGeometry(): THREE.BufferGeometry {
  const B = BODY;
  const sleeve = bevel(B.upperArmW, B.upperArmH, B.upperArmW, 0.9);
  sleeve.translate(0, -B.upperArmH / 2, 0);
  const fore = bevel(B.foreArmW, B.foreArmH, B.foreArmW, 0.92);
  fore.translate(0, -B.upperArmH - B.foreArmH / 2 + 0.02, 0);
  const hand = bevel(B.handW, B.handH, B.handW * 0.85);
  hand.translate(0, -B.upperArmH - B.foreArmH - B.handH / 2 + 0.04, 0);
  return fuse([paint(sleeve, SLEEVE), paint(fore, SKIN), paint(hand, SKIN)]);
}

/** Leg hanging from the hip: thigh, calf, shoe. Local origin at the hip joint. */
function legGeometry(): THREE.BufferGeometry {
  const B = BODY;
  const thigh = bevel(B.thighW, B.thighH, B.thighW * 1.12, 0.86);
  thigh.translate(0, -B.thighH / 2, 0);
  const shin = bevel(B.shinW, B.shinH, B.shinW * 1.1, 0.88);
  shin.translate(0, -B.thighH - B.shinH / 2 + 0.02, 0);
  const shoe = bevel(B.shoeW, B.shoeH, B.shoeD);
  shoe.translate(0, -B.thighH - B.shinH - B.shoeH / 2 + 0.06, B.shoeFwd);
  return fuse([paint(thigh, JEANS), paint(shin, JEANS), paint(shoe, SHOE)]);
}

export class PlayerRenderer {
  readonly group = new THREE.Group();
  private readonly torso: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly armL: THREE.Mesh;
  private readonly armR: THREE.Mesh;
  private readonly legL: THREE.Mesh;
  private readonly legR: THREE.Mesh;
  private readonly shadows: ContactShadows;
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.04, envMapIntensity: 0.55 });
  private readonly interp: Transform = createTransform();
  private readonly scene: THREE.Scene;
  private swing = 0;
  private airPose = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const B = BODY;
    const mk = (g: THREE.BufferGeometry): THREE.Mesh => {
      const m = new THREE.Mesh(g, this.mat);
      m.castShadow = true;
      return m;
    };
    this.torso = mk(torsoGeometry());
    this.torso.position.y = B.hipY;
    this.head = mk(headGeometry());
    this.head.position.y = B.headY - B.hipY + B.headH / 2;
    this.armL = mk(armGeometry());
    this.armL.position.set(-B.shoulderX, B.shoulderY - B.hipY, 0);
    this.armR = mk(armGeometry());
    this.armR.position.set(B.shoulderX, B.shoulderY - B.hipY, 0);
    // Head and arms ride the torso, so a lean carries the whole upper body.
    this.torso.add(this.head, this.armL, this.armR);
    this.legL = mk(legGeometry());
    this.legL.position.set(-B.hipX, B.hipY, 0);
    this.legR = mk(legGeometry());
    this.legR.position.set(B.hipX, B.hipY, 0);
    this.group.add(this.torso, this.legL, this.legR);
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
  }

  dispose(): void {
    this.scene.remove(this.group);
    const parts = [this.torso, this.head, this.armL, this.armR, this.legL, this.legR];
    for (let i = 0; i < parts.length; i++) parts[i].geometry.dispose();
    this.shadows.dispose();
    this.mat.dispose();
  }
}
