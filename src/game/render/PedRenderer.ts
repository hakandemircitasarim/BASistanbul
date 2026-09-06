// Instanced pedestrian rendering: six InstancedMeshes (body/head/arms/legs) sculpted with the PlayerRenderer helpers,
// per-ped colours, four prop variants (hat / ponytail / bald+bag / plain) chosen per instance by a vertex-shader mask,
// pre-bent knees and elbows, walk swing with bob and sway, tumble/lying pose, fade, distance collapse. Track E.
import * as THREE from 'three';
import { ContactShadows, groundYAt } from './ContactShadows';
import type { World } from '../world/World';
import type { Transform } from '../core/Types';
import { createTransform, lerpTransform } from '../core/Transform';
import { BUDGET } from '../core/Budget';
import { clamp, smoothstep } from '../core/math';
import {
  PROFILE, RIM_FRAGMENT, armRings, bendBelow, fillAttr, fuse, hairCap, headParts, legRings, makeRimUniforms,
  neckRings, nightFromHour, paintFn, ringAt, rounded, setRimNight, shoe, surface, torsoRings, tube, type Ring, type RimUniforms,
} from './PlayerRenderer';

export const PED_RENDER = {
  cullDist: 120, scale: 0.97, swingWalk: 0.55, swingFlee: 1.0, lyingLift: 0.22, armSwing: 0.75,
  shadowR: 0.46, shadowLift: 0.03, kneeBend: 0.16, elbowBend: 0.42, bob: 0.028, sway: 0.045, sizeSpread: 0.07,
  radial: 7, headSegs: 9, headRings: 6, hairRows: 5,
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

const scratchRing: Ring = { y: 0, rx: 0, rz: 0, x: 0, z: 0 };

/** Torso with hem gradient, belt and collar bands (shirt instance colour), plus the shoulder bag for two variants. */
function bodyGeometry(): THREE.BufferGeometry {
  const R = PED_RENDER, s = R.scale, P = PROFILE;
  const rings = torsoRings(s);
  const beltLo = P.beltLo * s, beltHi = P.beltHi * s, collar = P.collarY * s;
  const torso = tube(rings, R.radial + 1, true, true);
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
  const pouch = rounded(0.17 * s, 0.13 * s, 0.07 * s, 0.02, 1);
  pouch.translate(0.21 * s, 0.9 * s, 0.02);
  const bag = fuse([solid(strap, BAG, V_TAIL | V_BALD), solid(pouch, BAG, V_TAIL | V_BALD)]);
  return fuse([torso, bag]);
}

/** Skull, face, neck and hair (skin instance colour); hat and ponytail props that show on one variant each. */
function headGeometry(): THREE.BufferGeometry {
  const R = PED_RENDER, s = R.scale, P = PROFILE;
  const parts: THREE.BufferGeometry[] = [];
  headParts(s, R.headSegs, R.headRings, R.hairRows, (role, g) => {
    if (role === 'skin') parts.push(tint(g, 1, V_ALL));
    else if (role === 'eye') parts.push(solid(g, EYE, V_ALL));
    else if (role === 'brow') parts.push(tint(g, TINT_BROW, V_ALL));
    else parts.push(tint(g, TINT_HAIR, V_PLAIN | V_HAT | V_TAIL));
  });
  parts.push(tint(tube(neckRings(s), 7, false, false), 1, V_ALL));
  const cy = P.headCY * s, rx = P.headRX * s, ry = P.headRY * s, rz = P.headRZ * s;
  // Cap: a shallow dome over the hair with a visor out front.
  const dome = hairCap(cy + ry * 0.05, rx * 1.16, ry * 1.12, rz * 1.16, R.headSegs, 4, 1.32, 1.32, 1.32, 0.1);
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
  return fuse(parts);
}

/** Leg pivoted at the hip with the knee pre-bent a little so the shin reads as a separate segment; darker shoe. */
function legGeometry(): THREE.BufferGeometry {
  const R = PED_RENDER, s = R.scale, P = PROFILE;
  const leg = tube(legRings(s), R.radial, false, true);
  paintFn(leg, (_x, y, _z, out) => { const k = 0.84 + 0.16 * smoothstep(0.07, 0.5, y / s); out.setRGB(k, k, k); });
  fillAttr(leg, 'absCol', 0);
  fillAttr(leg, 'partMask', V_ALL);
  const g = fuse([leg, solid(shoe(s, 8), SHOE, V_ALL)]);
  g.translate(0, -P.hipY * s, 0);
  bendBelow(g, (P.kneeY - P.hipY) * s, R.kneeBend, 0.05);
  // Lean the whole leg forward a touch so the pre-bent foot still lands under the hip.
  g.rotateX(-R.kneeBend * 0.45);
  return g;
}

/** Arm pivoted at the shoulder, elbow pre-bent forward; sleeve takes the shirt colour, forearm the skin colour. */
function armGeometry(): THREE.BufferGeometry {
  const R = PED_RENDER, s = R.scale, P = PROFILE;
  const sleeveY = P.sleeveY * s;
  const sleeve = tube(armRings(s).filter((r) => r.y >= sleeveY), R.radial, false, false);
  paintFn(sleeve, (_x, y, _z, out) => { const k = 0.86 + 0.14 * smoothstep(sleeveY, 1.36 * s, y); out.setRGB(k, k, k); });
  fillAttr(sleeve, 'absCol', 0);
  fillAttr(sleeve, 'partMask', V_ALL);
  // Forearm and hand: absCol = 2 selects the per-instance skin colour instead of the shirt instance colour.
  const fore = tube(armRings(s).filter((r) => r.y <= sleeveY), R.radial, true, true);
  paintFn(fore, (_x, _y, _z, out) => out.setRGB(1, 1, 1));
  fillAttr(fore, 'absCol', 2);
  fillAttr(fore, 'partMask', V_ALL);
  const g = fuse([sleeve, fore]);
  g.translate(0, -P.shoulderY * s, 0);
  bendBelow(g, (P.elbowY - P.shoulderY) * s, -R.elbowBend, 0.04);
  return g;
}

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
    this.bodyVariant = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.headVariant = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.bodyVariant.setUsage(THREE.DynamicDrawUsage);
    this.headVariant.setUsage(THREE.DynamicDrawUsage);
    bodyGeo.setAttribute('pedVariant', this.bodyVariant);
    headGeo.setAttribute('pedVariant', this.headVariant);
    this.body = this.make(bodyGeo, cap);
    this.head = this.make(headGeo, cap);
    this.legL = this.make(legGeometry(), cap);
    this.legR = this.make(legGeometry(), cap);
    const armGeoL = armGeometry(), armGeoR = armGeometry();
    this.skinL = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.skinR = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.skinL.setUsage(THREE.DynamicDrawUsage);
    this.skinR.setUsage(THREE.DynamicDrawUsage);
    armGeoL.setAttribute('pedSkin', this.skinL);
    armGeoR.setAttribute('pedSkin', this.skinR);
    this.armL = this.make(armGeoL, cap);
    this.armR = this.make(armGeoR, cap);
    this.shadows = new ContactShadows(scene, cap);
  }

  /**
   * Vertex colour = instance colour x tint, an absolute colour where absCol = 1 (hat, bag, shoes, eyes), or the
   * per-instance skin colour where absCol = 2 (forearms on the shirt-coloured arm instances). Parts whose
   * partMask bit for the instance's variant is clear collapse to the pivot, which is how one geometry serves four
   * looks. The depth material gets the same collapse so hidden props cast no shadow. Rim as on the player.
   */
  private setupMaterials(): void {
    const vertexHook = (shader: { vertexShader: string }): void => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float absCol;\nattribute float partMask;\nattribute float pedVariant;\nattribute vec3 pedSkin;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        if ( mod( floor( partMask / exp2( pedVariant ) ), 2.0 ) < 0.5 ) transformed = vec3( 0.0 );`);
    };
    this.mat.onBeforeCompile = (shader) => {
      vertexHook(shader);
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', [
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
    this.mat.customProgramCacheKey = () => 'pedVariantRim';
    this.depthMat.onBeforeCompile = vertexHook;
    this.depthMat.customProgramCacheKey = () => 'pedVariantDepth';
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
      // Per-ped build: a little taller or shorter, and one of four looks, both fixed by the id.
      const size = 1 + ((((p.id * 7919) % 13) / 12) - 0.5) * R.sizeSpread;
      const variant = p.id % 4;
      const sc = visible ? Math.max(0.001, clamp(p.spawnFade, 0, 1)) * size : 0;
      const lying = p.state === 'HIT' || p.state === 'DEAD';
      const fall = clamp(p.tumble - 1, 0, 1);
      const pitch = lying ? -(Math.PI / 2) * fall : 0;
      const lift = lying ? R.lyingLift * fall : 0;
      const amp = p.state === 'FLEE' ? R.swingFlee : p.state === 'WALK' && p.speed > 0.1 ? R.swingWalk : 0;
      const sn = lying ? 0 : Math.sin(p.animPhase);
      const swing = sn * amp;
      // Stride bounce at twice the step rate and a lateral sway, folded into the base matrix (free for six parts).
      const bob = lying ? 0 : R.bob * amp * (0.5 - 0.5 * Math.cos(p.animPhase * 2));
      this.euler.set(pitch, t.yaw, R.sway * swing);
      this.quat.setFromEuler(this.euler);
      this.pos.set(t.x, t.y + lift + bob * sc, t.z);
      this.scl.set(sc, sc, sc);
      this.base.compose(this.pos, this.quat, this.scl);
      this.bodyVariant.setX(n, variant);
      this.headVariant.setX(n, variant);
      this.place(this.body, n, 0, 0, 0, 0.05 * Math.abs(swing), p.colors.shirt);
      this.place(this.head, n, 0, 0, 0, 0, p.colors.skin);
      this.place(this.legL, n, -P.hipX * s, P.hipY * s, 0, swing, p.colors.pants);
      this.place(this.legR, n, P.hipX * s, P.hipY * s, 0, -swing, p.colors.pants);
      // Arms counter-swing against the legs; sleeves take the shirt colour, forearms read the skin attribute.
      this.color.setHex(p.colors.skin);
      this.skinL.setXYZ(n, this.color.r, this.color.g, this.color.b);
      this.skinR.setXYZ(n, this.color.r, this.color.g, this.color.b);
      this.place(this.armL, n, -P.shoulderX * s, P.shoulderY * s, 0, -swing * R.armSwing, p.colors.shirt);
      this.place(this.armR, n, P.shoulderX * s, P.shoulderY * s, 0, swing * R.armSwing, p.colors.shirt);
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
    this.bodyVariant.needsUpdate = true;
    this.headVariant.needsUpdate = true;
    this.skinL.needsUpdate = true;
    this.skinR.needsUpdate = true;
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
    this.depthMat.dispose();
  }
}
