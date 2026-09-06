// Instanced pedestrian rendering: six InstancedMeshes (body/head/arms/legs) sculpted with the PlayerRenderer helpers,
// per-ped colours, four prop variants (hat / ponytail / bald+bag / plain) chosen per instance by a vertex-shader mask,
// knees and elbows folded in the vertex shader from a per-instance bend value (the shin swings on the thigh, the
// forearm on the upper arm), walk swing with bob, sway and torso lean, per-ped height/width jitter, tumble/lying
// pose, fade, distance collapse. Track E.
import * as THREE from 'three';
import { ContactShadows, groundYAt } from './ContactShadows';
import type { World } from '../world/World';
import type { Transform } from '../core/Types';
import { createTransform, lerpTransform } from '../core/Transform';
import { BUDGET } from '../core/Budget';
import { clamp, smoothstep } from '../core/math';
import {
  PROFILE, RIM_FRAGMENT, armRings, bakeAO, block, fillAttr, fuse, hairCap, hand, headParts, legRings, makeRimUniforms,
  neckRings, nightFromHour, paintFn, ringAt, setRimNight, shoe, surface, torsoRings, tube, type Ring, type RimUniforms,
} from './PlayerRenderer';

export const PED_RENDER = {
  cullDist: 120, scale: 0.97, swingWalk: 0.55, swingFlee: 1.0, lyingLift: 0.22, armSwing: 0.75,
  shadowR: 0.46, shadowLift: 0.03, bob: 0.028, sway: 0.045,
  /** Height and width multipliers per ped span 1 +- spread/2 (fixed by the id). */
  heightSpread: 0.2, widthSpread: 0.2,
  /** Joint folds (radians): the knee folds while the leg swings forward, the elbow rests soft and deepens on the reach. */
  kneeFold: 1.0, kneeSoft: 0.05, elbowRest: 0.25, elbowReach: 0.4, jointBlend: 0.05,
  /** Torso lean into the stride and the head's share of it. */
  lean: 0.05, leanStride: 0.03, headFollow: 0.5, glance: 0.22,
  radial: 10, headSegs: 12, headRings: 8, hairRows: 5,
};

/** Variant bits: which of the four looks (ped.id % 4) show a part. */
const V_PLAIN = 1, V_HAT = 2, V_TAIL = 4, V_BALD = 8, V_ALL = 15;
/** Vertex-colour multipliers layered under the per-instance colour (absCol = 0); absolute colours use absCol = 1. */
const TINT_HAIR = 0.3, TINT_BROW = 0.26;
const HAT = 0x24304e, BAG = 0x5a3a24, SHOE = 0x1f1c1c, EYE = 0x1a1410;

function tint(g: THREE.BufferGeometry, k: number, mask: number): THREE.BufferGeometry {
  paintFn(g, (_x, _y, _z, out) => out.setRGB(k, k, k));
  fillAttr(g, 'absCol', 0);
  return fillAttr(g, 'partMask', mask);
}

function solid(g: THREE.BufferGeometry, hex: number, mask: number): THREE.BufferGeometry {
  paintFn(g, (_x, _y, _z, out) => out.setHex(hex));
  fillAttr(g, 'absCol', 1);
  return fillAttr(g, 'partMask', mask);
}

/**
 * Joint attribute (weight, pivotY) in the part's pivot space: weight 0 above the joint, 1 below, blended over
 * `blend` metres either side so the tube folds instead of shearing. The vertex shader rotates weighted vertices
 * about the x axis through (0, pivotY, 0) by the instance's bend value.
 */
function jointAttr(g: THREE.BufferGeometry, pivotY: number, blend: number): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    a[i * 2] = 1 - smoothstep(pivotY - blend, pivotY + blend, pos.getY(i));
    a[i * 2 + 1] = pivotY;
  }
  g.setAttribute('pedJoint', new THREE.BufferAttribute(a, 2));
  return g;
}

const scratchRing: Ring = { y: 0, rx: 0, rz: 0, x: 0, z: 0 };

/** Torso with hem gradient, belt and collar bands (shirt instance colour), plus the shoulder bag for two variants. Pivot at the hips. */
function bodyGeometry(): THREE.BufferGeometry {
  const R = PED_RENDER, s = R.scale, P = PROFILE;
  const rings = torsoRings(s);
  const beltLo = P.beltLo * s, beltHi = P.beltHi * s, collar = P.collarY * s;
  const torso = tube(rings, R.radial, true, true);
  paintFn(torso, (_x, y, _z, out) => {
    if (y < beltLo) out.setRGB(0.42, 0.4, 0.44);
    else if (y < beltHi + 0.002) out.setRGB(0.16, 0.15, 0.17);
    else if (y < collar) { const k = 0.64 + 0.36 * smoothstep(beltHi, 1.24 * s, y); out.setRGB(k, k, k); }
    else out.setRGB(0.78, 0.76, 0.8);
  });
  fillAttr(torso, 'absCol', 0);
  fillAttr(torso, 'partMask', V_ALL);
  // Shoulder bag: strap hugging the chest from the left shoulder to the right hip, pouch on the hip.
  const strap = surface(2, 8, false, false, (i, j, out) => {
    const t = j / 7;
    const x = -0.12 * s + (0.34 * s) * t, y = 1.43 * s - (0.52 * s) * t;
    const r = ringAt(rings, y, scratchRing);
    const nx = clamp(x / r.rx, -0.98, 0.98);
    const z = (r.z ?? 0) + r.rz * Math.sqrt(1 - nx * nx) + 0.008;
    // Second edge offset across the strap direction (perpendicular in the xy plane).
    const w = i === 0 ? 0 : 0.036 * s;
    out.set(x + w * 0.84, y + w * 0.55, z);
  });
  const pouch = block(0.17 * s, 0.13 * s, 0.07 * s); // a plain box: the bevel never read at crowd distance
  pouch.translate(0.21 * s, 0.9 * s, 0.02);
  const bag = fuse([solid(strap, BAG, V_TAIL | V_BALD), solid(pouch, BAG, V_TAIL | V_BALD)]);
  const g = bakeAO(fuse([torso, bag]), s);
  g.translate(0, -P.hipY * s, 0);
  return g;
}

/** Skull, face, neck and hair (skin instance colour); hat and ponytail props that show on one variant each. Pivot at the neck. */
function headGeometry(): THREE.BufferGeometry {
  const R = PED_RENDER, s = R.scale, P = PROFILE;
  const parts: THREE.BufferGeometry[] = [];
  headParts(s, R.headSegs, R.headRings, R.hairRows, (role, g) => {
    if (role === 'skin') parts.push(tint(g, 1, V_ALL));
    else if (role === 'eye') parts.push(solid(g, EYE, V_ALL));
    else if (role === 'brow') parts.push(tint(g, TINT_BROW, V_ALL));
    else parts.push(tint(g, TINT_HAIR, V_PLAIN | V_HAT | V_TAIL));
  });
  parts.push(tint(tube(neckRings(s), 8, false, false), 1, V_ALL));
  const cy = P.headCY * s, rx = P.headRX * s, ry = P.headRY * s, rz = P.headRZ * s;
  // Cap: a shallow dome over the hair with a visor out front.
  const dome = hairCap(cy + ry * 0.05, rx * 1.16, ry * 1.12, rz * 1.16, R.headSegs, 3, 1.32, 1.32, 1.32, 0.1);
  const brimY = cy + ry * 0.05 + ry * 1.12 * Math.cos(1.32);
  const visor = surface(2, 7, false, true, (i, j, out) => {
    const a = -0.85 + (1.7 * j) / 6;
    const k = i === 0 ? 1 : 1.55;
    out.set(rx * 1.16 * Math.sin(1.32) * Math.sin(a) * k, brimY - (i === 0 ? 0 : 0.012), rz * 1.16 * Math.sin(1.32) * Math.cos(a) * k);
  });
  parts.push(solid(fuse([dome, visor]), HAT, V_HAT));
  // Ponytail: a tapering tube hanging from the crown down the nape.
  const tail = tube([
    { y: cy - ry * 1.9, rx: 0.018, rz: 0.018, z: -rz * 0.75 },
    { y: cy - ry * 1.2, rx: 0.03, rz: 0.03, z: -rz * 0.95 },
    { y: cy - ry * 0.5, rx: 0.038, rz: 0.034, z: -rz * 1.05 },
    { y: cy + ry * 0.35, rx: 0.03, rz: 0.03, z: -rz * 0.98 },
  ], 6, true, true);
  parts.push(tint(tail, TINT_HAIR, V_TAIL));
  const g = bakeAO(fuse(parts), s);
  g.translate(0, -P.neckY * s, 0);
  return g;
}

/** Leg pivoted at the hip, straight; the knee fold is the shader's (pedJoint below the knee); darker shoe. */
function legGeometry(side: number): THREE.BufferGeometry {
  const R = PED_RENDER, s = R.scale, P = PROFILE;
  const leg = tube(legRings(s), R.radial, false, false); // the shoe hides the ankle end
  paintFn(leg, (_x, y, _z, out) => { const k = 0.84 + 0.16 * smoothstep(0.07, 0.5, y / s); out.setRGB(k, k, k); });
  fillAttr(leg, 'absCol', 0);
  fillAttr(leg, 'partMask', V_ALL);
  const g = fuse([leg, solid(shoe(s, 8), SHOE, V_ALL)]);
  g.translate(side * P.hipX * s, 0, 0);
  bakeAO(g, s);
  g.translate(-side * P.hipX * s, -P.hipY * s, 0);
  return jointAttr(g, (P.kneeY - P.hipY) * s, R.jointBlend);
}

/** Arm pivoted at the shoulder, straight, with a mitten hand; the elbow fold is the shader's. Sleeve = shirt colour, forearm = skin. */
function armGeometry(side: number): THREE.BufferGeometry {
  const R = PED_RENDER, s = R.scale, P = PROFILE;
  const sleeveY = P.sleeveY * s;
  const rings = armRings(s, side);
  const sleeve = tube(rings.filter((r) => r.y >= sleeveY), R.radial, false, false);
  paintFn(sleeve, (_x, y, _z, out) => { const k = 0.86 + 0.14 * smoothstep(sleeveY, 1.36 * s, y); out.setRGB(k, k, k); });
  fillAttr(sleeve, 'absCol', 0);
  fillAttr(sleeve, 'partMask', V_ALL);
  // Forearm and hand: absCol = 2 selects the per-instance skin colour instead of the shirt instance colour.
  const fore = fuse([tube(rings.filter((r) => r.y <= sleeveY), R.radial, true, false), hand(s, side, 6, 4)]);
  paintFn(fore, (_x, _y, _z, out) => out.setRGB(1, 1, 1));
  fillAttr(fore, 'absCol', 2);
  fillAttr(fore, 'partMask', V_ALL);
  const g = fuse([sleeve, fore]);
  g.translate(side * P.shoulderX * s, 0, 0);
  bakeAO(g, s);
  g.translate(-side * P.shoulderX * s, -P.shoulderY * s, 0);
  return jointAttr(g, (P.elbowY - P.shoulderY) * s, R.jointBlend);
}

/** GLSL for the shader joint: rotates the weighted part of a limb about the x axis through its pivot. */
const JOINT_POSITION = `#include <begin_vertex>
{
  float jTh = pedBend * pedJoint.x;
  float jC = cos( jTh ), jS = sin( jTh );
  float jDy = transformed.y - pedJoint.y, jDz = transformed.z;
  transformed.y = pedJoint.y + jDy * jC - jDz * jS;
  transformed.z = jDy * jS + jDz * jC;
}
if ( mod( floor( partMask / exp2( pedVariant ) ), 2.0 ) < 0.5 ) transformed = vec3( 0.0 );`;
const JOINT_NORMAL = `#include <beginnormal_vertex>
{
  float jTh = pedBend * pedJoint.x;
  float jC = cos( jTh ), jS = sin( jTh );
  objectNormal.yz = vec2( objectNormal.y * jC - objectNormal.z * jS, objectNormal.y * jS + objectNormal.z * jC );
}`;

export class PedRenderer {
  private readonly scene: THREE.Scene;
  private readonly body: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly legL: THREE.InstancedMesh;
  private readonly legR: THREE.InstancedMesh;
  private readonly armL: THREE.InstancedMesh;
  private readonly armR: THREE.InstancedMesh;
  private readonly bodyVariant: THREE.InstancedBufferAttribute;
  private readonly headVariant: THREE.InstancedBufferAttribute;
  private readonly skinL: THREE.InstancedBufferAttribute;
  private readonly skinR: THREE.InstancedBufferAttribute;
  private readonly bendLegL: THREE.InstancedBufferAttribute;
  private readonly bendLegR: THREE.InstancedBufferAttribute;
  private readonly bendArmL: THREE.InstancedBufferAttribute;
  private readonly bendArmR: THREE.InstancedBufferAttribute;
  /** Triangles drawn per visible pedestrian (all six parts, every variant's props included). */
  readonly trianglesPerPed: number;
  private readonly shadows: ContactShadows;
  private readonly rim: RimUniforms = makeRimUniforms();
  private readonly mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0.03, envMapIntensity: 0.22 });
  private readonly depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
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
    const cap = BUDGET.MAX_PEDS;
    this.setupMaterials();
    const bodyGeo = bodyGeometry();
    const headGeo = headGeometry();
    this.bodyVariant = this.instanced(cap, 1);
    this.headVariant = this.instanced(cap, 1);
    bodyGeo.setAttribute('pedVariant', this.bodyVariant);
    headGeo.setAttribute('pedVariant', this.headVariant);
    this.body = this.make(bodyGeo, cap);
    this.head = this.make(headGeo, cap);
    const legGeoL = legGeometry(-1), legGeoR = legGeometry(1);
    this.bendLegL = this.instanced(cap, 1);
    this.bendLegR = this.instanced(cap, 1);
    legGeoL.setAttribute('pedBend', this.bendLegL);
    legGeoR.setAttribute('pedBend', this.bendLegR);
    this.legL = this.make(legGeoL, cap);
    this.legR = this.make(legGeoR, cap);
    const armGeoL = armGeometry(-1), armGeoR = armGeometry(1);
    this.skinL = this.instanced(cap, 3);
    this.skinR = this.instanced(cap, 3);
    this.bendArmL = this.instanced(cap, 1);
    this.bendArmR = this.instanced(cap, 1);
    armGeoL.setAttribute('pedSkin', this.skinL);
    armGeoR.setAttribute('pedSkin', this.skinR);
    armGeoL.setAttribute('pedBend', this.bendArmL);
    armGeoR.setAttribute('pedBend', this.bendArmR);
    this.armL = this.make(armGeoL, cap);
    this.armR = this.make(armGeoR, cap);
    this.trianglesPerPed = [bodyGeo, headGeo, legGeoL, legGeoR, armGeoL, armGeoR]
      .reduce((n, g) => n + g.attributes.position.count / 3, 0);
    this.shadows = new ContactShadows(scene, cap);
  }

  private instanced(cap: number, size: number): THREE.InstancedBufferAttribute {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  }

  /**
   * Vertex colour = instance colour x tint, an absolute colour where absCol = 1 (hat, bag, shoes, eyes), or the
   * per-instance skin colour where absCol = 2 (forearms on the shirt-coloured arm instances). Parts whose
   * partMask bit for the instance's variant is clear collapse to the pivot, which is how one geometry serves four
   * looks. Limb meshes carry a (weight, pivot) joint attribute and a per-instance bend that fold the shin and
   * forearm (position and normal). The depth material gets the same fold and collapse so shadows match. Rim as on
   * the player.
   */
  private setupMaterials(): void {
    const vertexHook = (shader: { vertexShader: string }): void => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float absCol;\nattribute float partMask;\nattribute float pedVariant;\nattribute vec3 pedSkin;\nattribute vec2 pedJoint;\nattribute float pedBend;')
        .replace('#include <begin_vertex>', JOINT_POSITION);
    };
    this.mat.onBeforeCompile = (shader) => {
      vertexHook(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <beginnormal_vertex>', JOINT_NORMAL)
        .replace('#include <color_vertex>', [
          'vColor = vec4( 1.0 );',
          '#ifdef USE_INSTANCING_COLOR',
          '  vColor.rgb = absCol > 1.5 ? color.rgb * pedSkin : mix( color.rgb * instanceColor.rgb, color.rgb, clamp( absCol, 0.0, 1.0 ) );',
          '#else',
          '  vColor.rgb = color.rgb;',
          '#endif',
        ].join('\n'));
      shader.uniforms.uRim = this.rim.uRim;
      shader.uniforms.uRimColor = this.rim.uRimColor;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uRim;\nuniform vec3 uRimColor;')
        .replace('#include <lights_fragment_end>', RIM_FRAGMENT);
    };
    this.mat.customProgramCacheKey = () => 'pedVariantJointRim';
    this.depthMat.onBeforeCompile = vertexHook;
    this.depthMat.customProgramCacheKey = () => 'pedVariantJointDepth';
  }

  private make(geo: THREE.BufferGeometry, cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, this.mat, cap);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = true;
    m.customDepthMaterial = this.depthMat;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.color.setRGB(1, 1, 1);
    for (let i = 0; i < cap; i++) m.setColorAt(i, this.color);
    this.scene.add(m);
    return m;
  }

  sync(world: World, alpha: number, camX: number, camZ: number): void {
    const R = PED_RENDER, P = PROFILE, s = R.scale;
    const list = world.pedList;
    const cap = BUDGET.MAX_PEDS;
    const clock = world.time.elapsed;
    const neckL = (P.neckY - P.hipY) * s;
    let n = 0;
    setRimNight(this.rim, nightFromHour(world.time.hour));
    this.shadows.begin();
    for (let i = 0; i < list.length && n < cap; i++) {
      const p = list[i];
      p.renderIndex = n;
      lerpTransform(this.interp, p.prev, p.curr, alpha);
      const t = this.interp;
      const dx = t.x - camX, dz = t.z - camZ;
      const visible = dx * dx + dz * dz < R.cullDist * R.cullDist;
      // Per-ped build: taller or shorter, broader or slighter, and one of four looks, all fixed by the id.
      const tall = 1 + ((((p.id * 7919) % 13) / 12) - 0.5) * R.heightSpread;
      const wide = 1 + ((((p.id * 104729) % 17) / 16) - 0.5) * R.widthSpread;
      const variant = p.id % 4;
      const sc = visible ? Math.max(0.001, clamp(p.spawnFade, 0, 1)) : 0;
      const lying = p.state === 'HIT' || p.state === 'DEAD';
      const fall = clamp(p.tumble - 1, 0, 1);
      const pitch = lying ? -(Math.PI / 2) * fall : 0;
      const lift = lying ? R.lyingLift * fall : 0;
      const amp = p.state === 'FLEE' ? R.swingFlee : p.state === 'WALK' && p.speed > 0.1 ? R.swingWalk : 0;
      const sn = lying ? 0 : Math.sin(p.animPhase);
      const cs = lying ? 0 : Math.cos(p.animPhase);
      const swing = sn * amp;
      // Stride bounce at twice the step rate and a lateral sway, folded into the base matrix (free for six parts).
      const bob = lying ? 0 : R.bob * amp * (0.5 - 0.5 * Math.cos(p.animPhase * 2));
      this.euler.set(pitch, t.yaw, R.sway * swing);
      this.quat.setFromEuler(this.euler);
      this.pos.set(t.x, t.y + lift + bob * sc * tall, t.z);
      this.scl.set(sc * wide, sc * tall, sc * wide);
      this.base.compose(this.pos, this.quat, this.scl);
      this.bodyVariant.setX(n, variant);
      this.headVariant.setX(n, variant);
      // Torso leans into the stride from the hips; the head rides the leaned neck, follows half the lean and, when
      // idle, glances about slowly at its own pace.
      const lean = R.lean * amp + R.leanStride * Math.abs(swing);
      const glance = lying ? 0 : R.glance * Math.sin(clock * 0.45 + p.id * 1.7) * (1 - Math.min(1, amp * 2));
      this.place(this.body, n, 0, P.hipY * s, 0, lean, 0, p.colors.shirt);
      this.place(this.head, n, 0, P.hipY * s + neckL * Math.cos(lean), neckL * Math.sin(lean), lean * R.headFollow, glance, p.colors.skin);
      // Legs swing from the hip; the knee folds while the leg swings forward (foot off the ground).
      const fold = lying ? 0 : amp;
      this.place(this.legL, n, -P.hipX * s, P.hipY * s, 0, swing, 0, p.colors.pants);
      this.place(this.legR, n, P.hipX * s, P.hipY * s, 0, -swing, 0, p.colors.pants);
      this.bendLegL.setX(n, (R.kneeSoft + R.kneeFold * Math.max(0, -cs)) * fold);
      this.bendLegR.setX(n, (R.kneeSoft + R.kneeFold * Math.max(0, cs)) * fold);
      // Arms counter-swing against the legs, elbows soft at rest and deeper on the forward reach; sleeves take the
      // shirt colour, forearms read the skin attribute.
      this.color.setHex(p.colors.skin);
      this.skinL.setXYZ(n, this.color.r, this.color.g, this.color.b);
      this.skinR.setXYZ(n, this.color.r, this.color.g, this.color.b);
      this.place(this.armL, n, -P.shoulderX * s, P.shoulderY * s, 0, -0.05 - swing * R.armSwing, 0, p.colors.shirt);
      this.place(this.armR, n, P.shoulderX * s, P.shoulderY * s, 0, -0.05 + swing * R.armSwing, 0, p.colors.shirt);
      this.bendArmL.setX(n, -(R.elbowRest + R.elbowReach * Math.max(0, swing)));
      this.bendArmR.setX(n, -(R.elbowRest + R.elbowReach * Math.max(0, -swing)));
      if (sc > 0.01) {
        const r = lying ? R.shadowR * 1.7 : R.shadowR;
        const rz = lying ? R.shadowR * 0.75 : R.shadowR;
        this.shadows.add(t.x, groundYAt(t.x, t.z) + R.shadowLift, t.z, r * wide, rz * wide, t.yaw, sc);
      }
      n++;
    }
    this.finish(this.body, n);
    this.finish(this.head, n);
    this.finish(this.legL, n);
    this.finish(this.legR, n);
    this.finish(this.armL, n);
    this.finish(this.armR, n);
    this.bodyVariant.needsUpdate = true;
    this.headVariant.needsUpdate = true;
    this.skinL.needsUpdate = true;
    this.skinR.needsUpdate = true;
    this.bendLegL.needsUpdate = true;
    this.bendLegR.needsUpdate = true;
    this.bendArmL.needsUpdate = true;
    this.bendArmR.needsUpdate = true;
    this.shadows.end();
  }

  private place(mesh: THREE.InstancedMesh, idx: number, x: number, y: number, z: number, rotX: number, rotY: number, hex: number): void {
    this.pos.set(x, y, z);
    this.euler.set(rotX, rotY, 0);
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
    this.depthMat.dispose();
  }
}
