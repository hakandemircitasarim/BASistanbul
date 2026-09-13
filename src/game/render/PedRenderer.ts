// Instanced pedestrian rendering: six InstancedMeshes (body/head/arms/legs) sculpted with the PlayerRenderer helpers,
// per-ped colours, four prop variants (hat / ponytail / bald+bag / plain) chosen per instance by a vertex-shader mask,
// knees and elbows folded in the vertex shader from a per-instance bend value (the shin swings on the thigh, the
// forearm on the upper arm), walk swing with bob, sway and torso lean, per-ped height/width jitter, tumble/lying
// pose, fade, distance collapse. Track E.
import * as THREE from 'three';
import { ContactShadows, contactExtent, groundYAt } from './ContactShadows';
import type { World } from '../world/World';
import type { Transform } from '../core/Types';
import { createTransform, lerpTransform } from '../core/Transform';
import { BUDGET } from '../core/Budget';
import { clamp, damp, smoothstep } from '../core/math';
import {
  HAND_TONE, HAND_Y, PROFILE, RIM_FRAGMENT, SOLE_H, armRings, bakeAO, block, fillAttr, fuse, hairCap, hairFor,
  fillAttrY, hairShade, hand, headParts, legRings, makeGroundShadow, makeRimUniforms, neckRings, nightFromHour,
  paint, paintFn,
  paintShoe, ringAt, setRimNight, shoe, skull, surface, torsoRings, tube, updateGroundShadow,
  type Ring, type RimUniforms,
} from './PlayerRenderer';

/**
 * Half-span of a standing figure's footprint in metres: a shoe is ~0.12 either side of its own centre line and the
 * stance is ~0.2 wide, so ~0.22 for a ped. The contact blob is grown from THIS, not from the body's silhouette -
 * what has to be darkened is the ground the feet stand on.
 */
export const PED_FOOT_HALF = 0.22;

export const PED_RENDER = {
  /**
   * Crowd draw range. A ped is 1882 triangles and pays them TWICE (colour + shadow pass), so 40 of them are ~150 k -
   * the single largest line item in a dusk frame, and the walked dusk frames were sitting within 1 k of the 720 k
   * ceiling once the crowd reached its spawner target. The cut is at 96 m, where a 1.75 m figure is ~13 px tall at
   * 720 p, and past it the instance is dropped from the list ENTIRELY (see sync): a zero-scale instance, which is what
   * the old 120 m cull left behind, still submits all of its triangles in both passes.
   *
   * The last `cullFade` metres ease the ped down to `cullFloor` of its height first, so the figure settles rather than
   * blinking off. It deliberately does NOT fade to zero: a person shrinking to nothing reads as a dwarf walking away,
   * which is a worse artefact than the pop it replaces. At 0.55 of 13 px the remaining step is a few pixels.
   */
  cullDist: 96, cullFade: 6, cullFloor: 0.55, scale: 0.97, swingWalk: 0.55, swingFlee: 1.0, lyingLift: 0.22, armSwing: 0.75,
  /**
   * Blob half-width: the ped's own stance half-span (PED_FOOT_HALF) grown by the shared contact spill and penumbra,
   * so the undiluted part of the pool lands on the pavement AROUND the shoes rather than under them. Derived rather
   * than tuned, so the contact term of a ped, the player and a car all stay the same shape of thing.
   */
  shadowR: contactExtent(PED_FOOT_HALF), shadowLift: 0.03, bob: 0.028, sway: 0.045,
  /**
   * Contact blob geometry. It used to be a circle centred on the ped, the same size whatever the hour: it pointed
   * nowhere, so it read as a detached disc lying beside the feet rather than as a shadow. Now it is an ellipse aligned
   * with the direction the scene's own shadow light casts (see PlayerRenderer.GroundShadow, so it agrees with the
   * shadow map and follows the swap to moon shadows), `shadowNarrow` x shadowR across that direction and up to
   * `shadowStretchMax` x shadowR along it as the light drops, pushed `shadowAnchor` of the way out along it so the
   * dark part stays under the shoes and the tail runs away from the light. `shadowElevFloor` caps how long a very low
   * sun makes it.
   *
   * The stretch caps at 1.6 and the anchor at 0.25 (from 2.4 / 0.5): the blob is the floor's contact occlusion, not a
   * second cast shadow, and at dusk - where the light is clamped to 15.6 deg and the blob is the ONLY grounding cue
   * in the street - the old pair walked its opaque core the better part of half a metre off the shoes.
   */
  shadowNarrow: 1.0, shadowStretchMax: 1.6, shadowElevFloor: 0.26, shadowAnchor: 0.25,
  /** Height and width multipliers per ped span 1 +- spread/2 (fixed by the id). */
  heightSpread: 0.2, widthSpread: 0.2,
  /** Resting set of the arms across the body (radians): upper arm out from the ribs, forearm back in under it. */
  armOut: 0.11, elbowIn: 0.15,
  /** Joint folds (radians): the knee folds while the leg swings forward, the elbow rests soft and deepens on the reach. */
  kneeFold: 1.0, kneeSoft: 0.05, elbowRest: 0.25, elbowReach: 0.4, jointBlend: 0.05,
  /** Torso lean into the stride and the head's share of it. */
  lean: 0.05, leanStride: 0.03, headFollow: 0.5, glance: 0.22,
  /** Damping of the cosmetic kerb height under a ped (rad/s), the player's own rate (PlayerRenderer.groundY). */
  groundDamp: 14,
  // Head tessellation of the crowd. 10 x 6 (from 12 x 8): the extra rings of the collar, hem and belt profile have to
  // be paid for somewhere, and a 22 cm skull at the 10-40 m a ped is seen from does not resolve 96 quads. The player
  // keeps 14 x 10.
  radial: 10, headSegs: 10, headRings: 6, hairRows: 5,
  /**
   * Tier line, in metres from the camera: nearer than this a ped is the six-part articulated figure above, past it the
   * single merged `farGeometry` below. 40 m, where a 1.75 m figure is ~30 px tall at 720 p and the near tier's knee
   * fold, elbow fold, face furniture and props are all under a pixel. `lodHyst` is the extra distance a ped has to
   * walk back in before it returns to the near tier, so one hovering on the line does not flip tiers every frame.
   */
  lodDist: 40, lodHyst: 1.5,
  /**
   * Far-tier tessellation. `farRadial` DIVIDES the near tier's `radial`, which is the whole reason the swap does not
   * pop: the 5-gon's vertices are a subset of the 10-gon's, so the two tubes have exactly the same widest points and
   * the silhouette is inscribed rather than shrunk (at radial 6 the head-on half-width would drop from sin 72 deg to
   * sin 60 deg, i.e. 9 % narrower, which at 40 m is a 1.4 px step on the chest).
   */
  farRadial: 5, farHeadSegs: 6, farHeadRings: 4, farHairRows: 2,
};

/** Far-tier ring heights (figure units), sampled off the near tier's own profiles with `ringAt` so both tiers agree. */
const FAR_TORSO_Y = [0.66, 0.80, 0.856, 0.8625, 0.899, 0.910, 1.00, 1.20, 1.385, 1.447, 1.49];
const FAR_LEG_Y = [0.10, 0.28, 0.47, 0.66, 0.87];
const FAR_FORE_Y = [0.79, 1.00, 1.25];
const FAR_SLEEVE_Y = [1.255, 1.33, 1.40];
const FAR_NECK_Y = [1.425, 1.60];

/** Variant bits: which of the four looks (ped.id % 4) show a part. */
const V_PLAIN = 1, V_HAT = 2, V_TAIL = 4, V_BALD = 8, V_ALL = 15;
/** Vertex-colour multipliers layered under the per-instance colour (absCol = 0); absolute colours use absCol = 1. */
const TINT_HAIR = 0.3, TINT_BROW = 0.26;
const HAT = 0x24304e, BAG = 0x5a3a24, SHOE = 0x1f1c1c, SOLE = 0x4d4a4a, EYE = 0x1a1410;
/** Second garment tone break (see bodyGeometry / legGeometry): lit yoke, shaded back, lit thigh front. */
const GARMENT_YOKE = 1.13, GARMENT_BACK = 0.88, GARMENT_FRONT = 1.08;
/**
 * Height (figure units) below which the torso tube is TROUSERS, not shirt: the seat, the crotch and the belt that
 * closes over them. Everything below it reads the per-instance trouser colour (absCol 3), everything above it the
 * shirt (the mesh's own instance colour), so one tube carries two garments without a second draw call or a triangle.
 */
const PANTS_Y = PROFILE.beltHi + 0.003;

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

/**
 * Samples a near-tier profile at the given figure heights, so a far-tier tube lies exactly ON the near one's surface.
 *
 * A girth compensation was tried here and measured: widening the far radii by 1.05, which is what it takes for a
 * 5-gon to project to the same AVERAGE width as a 10-gon, moved the tier-line difference from 61 px to 63 px on a
 * 31.7 px figure - i.e. nothing. What is left at the line is one pixel of antialiased outline, and no radius scale
 * removes that, so the rings stay on the profile where they are easy to reason about.
 */
function farRings(rings: Ring[], ys: number[], s: number): Ring[] {
  return ys.map((y) => ({ ...ringAt(rings, y * s, scratchRing) }));
}

/** Paints a part one flat level (the instance colour, skin or pants, does the rest). */
function level(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  return paintFn(g, (_x, _y, _z, out) => out.setRGB(k, k, k));
}

/**
 * Garment tones of a ped torso: hip block under the belt, the dark belt band, then the shirt with its hem-to-chest
 * ramp, a lit yoke across the shoulders and a shaded back. Shared by both tiers - one flat garment colour with a
 * single vertical ramp is what makes a crowd read as shop mannequins, and a far tier painted any other way would
 * change tone as a ped crosses the tier line.
 */
function paintTorso(g: THREE.BufferGeometry, s: number): THREE.BufferGeometry {
  const P = PROFILE;
  const beltLo = P.beltLo * s, beltHi = P.beltHi * s, collar = P.collarY * s;
  return paintFn(g, (_x, y, z, out) => {
    // `face` eases across z so the tone break is a plane change and not a seam drawn down the flank.
    const face = GARMENT_BACK + (1 - GARMENT_BACK) * smoothstep(-0.05 * s, 0.05 * s, z);
    // Seat and crotch: the SAME ramp `paintLeg` puts on the top of the thigh, because this is the same garment. It
    // used to be a flat grey carried on the SHIRT instance colour (see PANTS_Y), which hung a shirt-coloured wedge
    // between the trouser legs of every ped in the city - the missing pelvis of the round-12 critic's first item.
    if (y < beltLo) {
      const faceL = smoothstep(-0.045 * s, 0.045 * s, z);
      const k = (0.84 + 0.16 * smoothstep(0.1, 0.5, y / s)) * (0.93 + (GARMENT_FRONT - 0.93) * faceL);
      out.setRGB(k, k, k);
    } else if (y < beltHi + 0.002) out.setRGB(0.16, 0.15, 0.17);
    else if (y < collar) {
      const k = (0.64 + 0.36 * smoothstep(beltHi, 1.24 * s, y)) * (1 + (GARMENT_YOKE - 1) * smoothstep(1.26 * s, 1.38 * s, y)) * face;
      out.setRGB(k, k, k);
    } else out.setRGB(0.78, 0.76, 0.8);
  });
}

/** Trouser tones: a ramp up the shin, a lit plane down the front of the thigh and a crease behind the knee. */
function paintLeg(g: THREE.BufferGeometry, s: number): THREE.BufferGeometry {
  const P = PROFILE;
  return paintFn(g, (_x, y, z, out) => {
    const face = smoothstep(-0.045 * s, 0.045 * s, z);
    const crease = 1 - 0.12 * (1 - smoothstep(0, 0.09 * s, Math.abs(y - P.kneeY * s))) * (1 - 0.75 * face);
    const k = (0.84 + 0.16 * smoothstep(0.1, 0.5, y / s)) * (0.93 + (GARMENT_FRONT - 0.93) * face) * crease;
    out.setRGB(k, k, k);
  });
}

/** Sleeve tone: the cuff sits in shade, the shoulder catches the sky. */
function paintSleeve(g: THREE.BufferGeometry, s: number): THREE.BufferGeometry {
  const sleeveY = PROFILE.sleeveY * s;
  return paintFn(g, (_x, y, _z, out) => { const k = 0.86 + 0.14 * smoothstep(sleeveY, 1.36 * s, y); out.setRGB(k, k, k); });
}

/** Forearm and hand: the hand is a shade deeper (HAND_TONE) or the two masses read as one tube. */
function paintForearm(g: THREE.BufferGeometry, s: number): THREE.BufferGeometry {
  return paintFn(g, (_x, y, _z, out) => { const k = y < HAND_Y * s ? HAND_TONE : 1; out.setRGB(k, k, k); });
}

/**
 * Rotates everything below `pivotY` about the Z axis through (0, pivotY, 0), easing in over `blend` metres. The Z-axis
 * twin of PlayerRenderer's `bendBelow` (which turns about X): this is the one that shows in a silhouette seen from the
 * front or the back, which is every angle a pedestrian is ever seen from.
 */
function leanAcross(g: THREE.BufferGeometry, pivotY: number, angle: number, blend: number): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y >= pivotY + blend) continue;
    const t = clamp((pivotY + blend - y) / (blend * 2), 0, 1);
    const th = angle * t, c = Math.cos(th), sn = Math.sin(th);
    const dy = y - pivotY, dx = pos.getX(i);
    pos.setX(i, dx * c - dy * sn);
    pos.setY(i, pivotY + dx * sn + dy * c);
    const nx = nor.getX(i), ny = nor.getY(i);
    nor.setX(i, nx * c - ny * sn);
    nor.setY(i, nx * sn + ny * c);
  }
  return g;
}

/** Torso with hem gradient, belt and collar bands (shirt instance colour), plus the shoulder bag for two variants. Pivot at the hips. */
function bodyGeometry(): THREE.BufferGeometry {
  const R = PED_RENDER, s = R.scale, P = PROFILE;
  const rings = torsoRings(s);
  // Second tone break, matching the player's: a lit yoke across the chest and shoulders over a shaded back.
  const torso = paintTorso(tube(rings, R.radial, true, true), s);
  fillAttrY(torso, 'absCol', (y) => (y < PANTS_Y * s ? 3 : 0));
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
    else parts.push(hairShade(tint(g, TINT_HAIR, V_PLAIN | V_HAT | V_TAIL), (P.headCY + P.headRY * 0.02) * s, P.headRY * s));
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
  const leg = paintLeg(tube(legRings(s, side), R.radial, false, false), s); // the shoe hides the ankle end
  fillAttr(leg, 'absCol', 0);
  fillAttr(leg, 'partMask', V_ALL);
  // Six-sided shoe: the crowd is the one part of the scene that pays its triangles 26 times over (and twice again in
  // the shadow pass), and at the distance a ped is ever seen the facet count of a 25 cm shoe is not resolvable — the
  // heel height is what reads. The player keeps ten sides.
  // The sole plate is painted lighter than the upper (paintShoe), so a crowd's feet read as shoes from 20 m; the
  // `solid` path would flood the whole shoe one colour, so the shoe brings its own colours and only the flags are set.
  const foot = paintShoe(shoe(s, 6, -side * 0.020), s, SHOE, SOLE);
  fillAttr(foot, 'absCol', 1);
  fillAttr(foot, 'partMask', V_ALL);
  const g = fuse([leg, foot]);
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
  const sleeve = paintSleeve(tube(rings.filter((r) => r.y >= sleeveY), R.radial, false, false), s);
  fillAttr(sleeve, 'absCol', 0);
  fillAttr(sleeve, 'partMask', V_ALL);
  // Forearm and hand: absCol = 2 selects the per-instance skin colour instead of the shirt instance colour.
  const fore = paintForearm(fuse([tube(rings.filter((r) => r.y <= sleeveY), R.radial, true, false), hand(s, side, 6, 4)]), s);
  fillAttr(fore, 'absCol', 2);
  fillAttr(fore, 'partMask', V_ALL);
  const g = fuse([sleeve, fore]);
  g.translate(side * P.shoulderX * s, 0, 0);
  bakeAO(g, s);
  g.translate(-side * P.shoulderX * s, -P.shoulderY * s, 0);
  // The shader's elbow fold turns the forearm about X, which does nothing to the silhouette seen head-on: a crowd of
  // straight vertical arms is what makes the peds read as mannequins. Leaning the whole arm out from the shoulder and
  // the forearm back in ACROSS the body puts a real bend in the outline, in geometry, for no per-frame cost.
  leanAcross(g, 0, side * R.armOut, 0.28 * s);
  leanAcross(g, (P.elbowY - P.shoulderY) * s, -side * (R.armOut + R.elbowIn), R.jointBlend * 3);
  return jointAttr(g, (P.elbowY - P.shoulderY) * s, R.jointBlend);
}

/** Tags a far-tier part with its colour source, its variant mask and the limb it swings with. */
function farPart(g: THREE.BufferGeometry, absCol: number, mask: number, dir: number, pivotY: number): THREE.BufferGeometry {
  fillAttr(g, 'absCol', absCol);
  fillAttr(g, 'partMask', mask);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = dir; a[i * 2 + 1] = pivotY; }
  g.setAttribute('farJoint', new THREE.BufferAttribute(a, 2));
  return g;
}

/**
 * Far crowd tier: ONE merged figure of ~400 triangles against the near tier's ~1,900, in ONE InstancedMesh, and it
 * does NOT cast the sun shadow.
 *
 * The crowd was the largest line item in the budget frame and it had no LOD at all: the same 1,926 triangles were
 * paid TWICE (colour + shadow) at every distance from 10 m to the 96 m cull, and eleven of the peds in the worst
 * frame stand outside the 132 m shadow box entirely, so their shadow-pass triangles bought nothing at all.
 *
 * Every dimension here is sampled off the SAME profiles the near tier laths (`farRings` + `ringAt`), every tone comes
 * from the SAME paint functions, and `farRadial` divides `radial`, so the far tube's vertices are a subset of the
 * near one's and the two silhouettes share their widest points. What the far tier drops is what is under a pixel at
 * 40 m: the knee and elbow folds, the face furniture (eyes, brows, mouth, nose, ears), the shoulder bag, the
 * ponytail, the sculpted shoe and the mitten hand's thumb. The walk survives - the legs and arms swing about the hip
 * and shoulder in the vertex shader from one per-instance value, which is what keeps a distant crowd from reading as
 * a field of sliding statues.
 */
function farGeometry(): THREE.BufferGeometry {
  const R = PED_RENDER, s = R.scale, P = PROFILE;
  const rad = R.farRadial;
  const hipY = P.hipY * s, shY = P.shoulderY * s;
  const parts: THREE.BufferGeometry[] = [];
  // Torso: lidded at the collar only. The hip end closes between the thighs where nothing can see it, but the collar
  // opening is 1.45 m up and the chase camera rides at 2.2 m, so it is looked into from above at every distance.
  const farTorso = farPart(paintTorso(tube(farRings(torsoRings(s), FAR_TORSO_Y, s), rad, true, false), s), 0, V_ALL, 0, 0);
  parts.push(fillAttrY(farTorso, 'absCol', (y) => (y < PANTS_Y * s ? 3 : 0)));
  parts.push(farPart(level(tube(farRings(neckRings(s), FAR_NECK_Y, s), rad, false, false), 1), 2, V_ALL, 0, 0));
  // Head: skull plus the SAME cap the near tier wraps (`hairFor`), and the hat dome for the one variant in four that
  // wears one. A cap is only ~1.5 px at the tier line, but it is a navy 1.5 px over a skin-toned one, and a colour
  // step is exactly what a diff of two consecutive frames across the line sees.
  const cy = P.headCY * s, rx = P.headRX * s, ry = P.headRY * s, rz = P.headRZ * s;
  parts.push(farPart(level(skull(cy, rx, ry, rz, R.farHeadSegs, R.farHeadRings, P.jawK), 1), 2, V_ALL, 0, 0));
  const hair = hairShade(level(hairFor(s, R.farHeadSegs, R.farHairRows), TINT_HAIR), (P.headCY + P.headRY * 0.02) * s, ry);
  parts.push(farPart(hair, 2, V_PLAIN | V_HAT | V_TAIL, 0, 0));
  // Same dome the near tier wraps, lip included: without the lip the cap edge closes on the skull instead of tucking
  // under it, and the crown is the one part of the figure a tier-line diff lights up.
  const dome = paint(hairCap(cy + ry * 0.05, rx * 1.16, ry * 1.12, rz * 1.16, R.farHeadSegs, 2, 1.32, 1.32, 1.32, 0.1), HAT);
  parts.push(farPart(dome, 1, V_HAT, 0, 0));
  for (const side of [-1, 1]) {
    // Legs swing about the hip, arms about the shoulder, both in the vertex shader: `dir` is the signed multiplier
    // on the instance's swing value, matching the rotations `sync` hands the near tier's six part matrices.
    const leg = paintLeg(tube(farRings(legRings(s, side), FAR_LEG_Y, s), rad, false, false), s);
    leg.translate(side * P.hipX * s, 0, 0);
    parts.push(farPart(leg, 3, V_ALL, -side, hipY));
    // The shoe is a plain box here: at the tier line it is 2 px long, and what reads is the dark mass with the
    // lighter sole plate under it, which a box carries as well as five lathed sections do.
    const foot = block(0.15 * s, 0.075 * s, 0.30 * s);
    foot.translate(side * (P.hipX - 0.020) * s, 0.0375 * s, 0.03 * s);
    paintFn(foot, (_x, y, _z, out) => out.setHex(y <= SOLE_H * s ? SOLE : SHOE));
    parts.push(farPart(foot, 1, V_ALL, -side, hipY));
    const ar = armRings(s, side);
    const palm = block(0.07 * s, 0.11 * s, 0.075 * s);
    palm.translate(-side * 0.005 * s, 0.735 * s, 0.014 * s);
    const limbs: [THREE.BufferGeometry, number][] = [
      [paintSleeve(tube(farRings(ar, FAR_SLEEVE_Y, s), rad, false, false), s), 0],
      [paintForearm(tube(farRings(ar, FAR_FORE_Y, s), rad, true, false), s), 2],
      [paintForearm(palm, s), 2],
    ];
    for (const [g, absCol] of limbs) {
      // Same pre-bend as the near arm, applied in shoulder-local space: out from the ribs at the shoulder, back in
      // under it at the elbow, then the resting -0.05 set forward that `sync` adds to the near tier's arm matrices.
      g.translate(0, -shY, 0);
      leanAcross(g, 0, side * R.armOut, 0.28 * s);
      leanAcross(g, (P.elbowY - P.shoulderY) * s, -side * (R.armOut + R.elbowIn), R.jointBlend * 3);
      g.rotateX(-0.05);
      g.translate(side * P.shoulderX * s, shY, 0);
      parts.push(farPart(g, absCol, V_ALL, side * R.armSwing, shY));
    }
  }
  // The whole figure is in figure space (feet at y = 0), so the crevice bake runs once over the lot.
  return bakeAO(fuse(parts), s);
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

/**
 * Far tier GLSL. One merged figure, so the limb swing the near tier gets from six part matrices is done here: every
 * vertex carries (signed swing multiplier, pivot height) and the instance carries one swing value. `partMask` drops
 * the hair or the hat the way the near tier's does.
 */
const FAR_ATTRS = `#include <common>
attribute float absCol;
attribute float partMask;
attribute vec2 farJoint;
attribute float farVariant;
attribute float farSwing;
attribute vec3 farSkin;
attribute vec3 farPants;`;
const FAR_POSITION = `#include <begin_vertex>
{
  float fTh = farSwing * farJoint.x;
  float fC = cos( fTh ), fS = sin( fTh );
  float fDy = transformed.y - farJoint.y, fDz = transformed.z;
  transformed.y = farJoint.y + fDy * fC - fDz * fS;
  transformed.z = fDy * fS + fDz * fC;
}
if ( mod( floor( partMask / exp2( farVariant ) ), 2.0 ) < 0.5 ) transformed = vec3( 0.0 );`;
const FAR_NORMAL = `#include <beginnormal_vertex>
{
  float fTh = farSwing * farJoint.x;
  float fC = cos( fTh ), fS = sin( fTh );
  objectNormal.yz = vec2( objectNormal.y * fC - objectNormal.z * fS, objectNormal.y * fS + objectNormal.z * fC );
}`;
/** absCol picks the colour source: 0 shirt (the instance colour), 1 absolute, 2 skin, 3 trousers. */
const FAR_COLOR = `vColor = vec4( 1.0 );
#ifdef USE_INSTANCING_COLOR
  vec3 farTone = absCol < 0.5 ? instanceColor.rgb : ( absCol < 1.5 ? vec3( 1.0 ) : ( absCol < 2.5 ? farSkin : farPants ) );
  vColor.rgb = color.rgb * farTone;
#else
  vColor.rgb = color.rgb;
#endif`;

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
  /** Trouser colour, shared by every near-tier geometry so the attribute is always bound (only the torso reads it). */
  private readonly pants: THREE.InstancedBufferAttribute;
  private readonly bendLegL: THREE.InstancedBufferAttribute;
  private readonly bendLegR: THREE.InstancedBufferAttribute;
  private readonly bendArmL: THREE.InstancedBufferAttribute;
  private readonly bendArmR: THREE.InstancedBufferAttribute;
  private readonly far: THREE.InstancedMesh;
  private readonly farVariantAttr: THREE.InstancedBufferAttribute;
  private readonly farSwingAttr: THREE.InstancedBufferAttribute;
  private readonly farSkinAttr: THREE.InstancedBufferAttribute;
  private readonly farPantsAttr: THREE.InstancedBufferAttribute;
  /** Triangles drawn per visible pedestrian (all six parts, every variant's props included). */
  readonly trianglesPerPed: number;
  /** Triangles drawn per pedestrian past `PED_RENDER.lodDist`, in one pass instead of two. */
  readonly trianglesPerFarPed: number;
  private readonly shadows: ContactShadows;
  private readonly rim: RimUniforms = makeRimUniforms();
  private readonly mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0.03, envMapIntensity: 0.22 });
  private readonly farMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0.03, envMapIntensity: 0.22 });
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
  /**
   * Smoothed cosmetic ground height per ped, slotted by `id % MAX_PEDS` with the owning id beside it.
   *
   * `groundYAt` is a step function - 0 on the carriageway, CURB_H on a block-plus-sidewalk rectangle - so a ped that
   * steps off a kerb onto a crossing would otherwise jump 15 cm (8 % of its height) in a single frame, and one whose
   * walk line runs along the rectangle's edge would oscillate. The player damps exactly this value for exactly this
   * reason (PlayerRenderer.groundY); the crowd needs one damper each. The slot arrays are allocated once, so `sync`
   * still allocates nothing; a ped taking over a slot from a despawned one snaps rather than damping in from it.
   */
  private readonly groundY = new Float32Array(BUDGET.MAX_PEDS);
  private readonly groundOwner = new Int32Array(BUDGET.MAX_PEDS).fill(-1);
  /** 1 while the ped in that slot is on the far tier, so the tier line can carry hysteresis (see PED_RENDER.lodHyst). */
  private readonly farTier = new Uint8Array(BUDGET.MAX_PEDS);
  /** Ground direction and length of the contact blobs, from the scene's own shadow light (see GroundShadow). */
  private readonly groundShadow = makeGroundShadow();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const cap = BUDGET.MAX_PEDS;
    this.setupMaterials();
    const bodyGeo = bodyGeometry();
    const headGeo = headGeometry();
    this.bodyVariant = this.instanced(cap, 1);
    this.headVariant = this.instanced(cap, 1);
    this.pants = this.instanced(cap, 3);
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
    // The whole near tier shares one material, so every geometry has to carry every attribute its program declares.
    for (const g of [bodyGeo, headGeo, legGeoL, legGeoR, armGeoL, armGeoR]) g.setAttribute('pedPants', this.pants);
    this.trianglesPerPed = [bodyGeo, headGeo, legGeoL, legGeoR, armGeoL, armGeoR]
      .reduce((n, g) => n + g.attributes.position.count / 3, 0);
    const farGeo = farGeometry();
    this.farVariantAttr = this.instanced(cap, 1);
    this.farSwingAttr = this.instanced(cap, 1);
    this.farSkinAttr = this.instanced(cap, 3);
    this.farPantsAttr = this.instanced(cap, 3);
    farGeo.setAttribute('farVariant', this.farVariantAttr);
    farGeo.setAttribute('farSwing', this.farSwingAttr);
    farGeo.setAttribute('farSkin', this.farSkinAttr);
    farGeo.setAttribute('farPants', this.farPantsAttr);
    this.far = new THREE.InstancedMesh(farGeo, this.farMat, cap);
    this.far.name = 'ped:far';
    this.far.count = 0;
    this.far.frustumCulled = false;
    // The far tier is NOT a shadow caster. Past the tier line a ped's cast shadow is a handful of pixels at a
    // contrast the round-13 shadow survey measured at 5-6/255 against an 8/255 visibility bar, and beyond the sun's
    // 132 m shadow box (SKY_TUNING.shadowBox, half-extent 66 m about the player) it is not in the shadow map at all.
    // Those triangles were the cheapest in the frame to give back: the whole crowd's shadow pass was 6 draw calls.
    this.far.castShadow = false;
    this.far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.color.setRGB(1, 1, 1);
    for (let i = 0; i < cap; i++) this.far.setColorAt(i, this.color);
    scene.add(this.far);
    this.trianglesPerFarPed = farGeo.attributes.position.count / 3;
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
        .replace('#include <common>', '#include <common>\nattribute float absCol;\nattribute float partMask;\nattribute float pedVariant;\nattribute vec3 pedSkin;\nattribute vec3 pedPants;\nattribute vec2 pedJoint;\nattribute float pedBend;')
        .replace('#include <begin_vertex>', JOINT_POSITION);
    };
    this.mat.onBeforeCompile = (shader) => {
      vertexHook(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <beginnormal_vertex>', JOINT_NORMAL)
        .replace('#include <color_vertex>', [
          'vColor = vec4( 1.0 );',
          '#ifdef USE_INSTANCING_COLOR',
          '  vec3 pedTone = absCol < 0.5 ? instanceColor.rgb : ( absCol < 1.5 ? vec3( 1.0 ) : ( absCol < 2.5 ? pedSkin : pedPants ) );',
          '  vColor.rgb = color.rgb * pedTone;',
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
    // Far tier: its own program rather than a fourth colour mode bolted onto the near one, because the merged figure
    // needs a trouser colour the six-part tier gets from a whole mesh's instance colour. No depth variant - it does
    // not cast.
    this.farMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', FAR_ATTRS)
        .replace('#include <begin_vertex>', FAR_POSITION)
        .replace('#include <beginnormal_vertex>', FAR_NORMAL)
        .replace('#include <color_vertex>', FAR_COLOR);
      shader.uniforms.uRim = this.rim.uRim;
      shader.uniforms.uRimColor = this.rim.uRimColor;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uRim;\nuniform vec3 uRimColor;')
        .replace('#include <lights_fragment_end>', RIM_FRAGMENT);
    };
    this.farMat.customProgramCacheKey = () => 'pedFarVariantRim';
  }

  private make(geo: THREE.BufferGeometry, cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, this.mat, cap);
    m.name = 'ped:part';
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

  sync(world: World, alpha: number, camX: number, camZ: number, frameDt: number): void {
    const R = PED_RENDER, P = PROFILE, s = R.scale;
    const dt = Math.min(frameDt, 0.1);
    const list = world.pedList;
    const cap = BUDGET.MAX_PEDS;
    const clock = world.time.elapsed;
    const neckL = (P.neckY - P.hipY) * s;
    let n = 0, f = 0;
    setRimNight(this.rim, nightFromHour(world.time.hour));
    updateGroundShadow(this.groundShadow, this.scene, R.shadowNarrow, R.shadowStretchMax, R.shadowElevFloor);
    this.shadows.begin();
    for (let i = 0; i < list.length && n + f < cap; i++) {
      const p = list[i];
      lerpTransform(this.interp, p.prev, p.curr, alpha);
      const t = this.interp;
      const dx = t.x - camX, dz = t.z - camZ;
      const d2 = dx * dx + dz * dz;
      const visible = d2 < R.cullDist * R.cullDist;
      // Past cullDist the ped is DROPPED from the instance list rather than scaled to 0.001. An InstancedMesh is
      // frustum-culled as one object, so a zero-scale instance still submits its 1882 triangles in both the colour and
      // the shadow pass - the crowd is the largest single line item in the frame, so those degenerate draws were real
      // budget. Its damper slot is released too, so the ped snaps to the true ground when it comes back in range
      // instead of damping up from a stale height.
      const slot = p.id % cap;
      if (!visible) { p.renderIndex = -1; this.groundOwner[slot] = -1; this.farTier[slot] = 0; continue; }
      // Tier line, with hysteresis: a ped drops to the merged far figure past `lodDist` and only climbs back to the
      // six-part one `lodHyst` metres inside it, so one walking along the line cannot flip geometry every frame.
      const line = this.farTier[slot] === 1 ? R.lodDist - R.lodHyst : R.lodDist;
      const isFar = d2 > line * line;
      this.farTier[slot] = isFar ? 1 : 0;
      p.renderIndex = isFar ? f : n;
      // Per-ped build: taller or shorter, broader or slighter, and one of four looks, all fixed by the id.
      const tall = 1 + ((((p.id * 7919) % 13) / 12) - 0.5) * R.heightSpread;
      const wide = 1 + ((((p.id * 104729) % 17) / 16) - 0.5) * R.widthSpread;
      const variant = p.id % 4;
      // Distance ease over the last cullFade metres, folded into the same scale the spawn fade uses (so the contact
      // blob below shrinks with it).
      const far = smoothstep(R.cullDist - R.cullFade, R.cullDist, Math.sqrt(d2));
      const sc = Math.max(0.001, clamp(p.spawnFade, 0, 1) * (1 - (1 - R.cullFloor) * far));
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
      // Lifted onto the cosmetic ground like the contact shadow below: the simulation is one flat plane, the city's
      // pavements stand CURB_H above it, so a ped placed at the raw simulation y is buried to the ankles in every
      // sidewalk it walks along. Damped per ped (see `groundY`), like the player's own lift: the raw value is a
      // 15 cm step at every kerb line and the crowd crosses one all the time.
      const gRaw = groundYAt(t.x, t.z);
      if (this.groundOwner[slot] !== p.id) { this.groundOwner[slot] = p.id; this.groundY[slot] = gRaw; }
      else this.groundY[slot] = damp(this.groundY[slot], gRaw, R.groundDamp, dt);
      const gy = this.groundY[slot];
      this.pos.set(t.x, t.y + gy + lift + bob * sc * tall, t.z);
      this.scl.set(sc * wide, sc * tall, sc * wide);
      this.base.compose(this.pos, this.quat, this.scl);
      if (isFar) {
        // One matrix, one swing value, three colours: the merged figure does its own limb swing in the shader.
        this.far.setMatrixAt(f, this.base);
        this.farVariantAttr.setX(f, variant);
        this.farSwingAttr.setX(f, swing);
        this.color.setHex(p.colors.skin);
        this.farSkinAttr.setXYZ(f, this.color.r, this.color.g, this.color.b);
        this.color.setHex(p.colors.pants);
        this.farPantsAttr.setXYZ(f, this.color.r, this.color.g, this.color.b);
        this.color.setHex(p.colors.shirt);
        this.far.setColorAt(f, this.color);
        f++;
      } else {
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
        this.color.setHex(p.colors.pants);
        this.pants.setXYZ(n, this.color.r, this.color.g, this.color.b);
        this.place(this.armL, n, -P.shoulderX * s, P.shoulderY * s, 0, -0.05 - swing * R.armSwing, 0, p.colors.shirt);
        this.place(this.armR, n, P.shoulderX * s, P.shoulderY * s, 0, -0.05 + swing * R.armSwing, 0, p.colors.shirt);
        this.bendArmL.setX(n, -(R.elbowRest + R.elbowReach * Math.max(0, swing)));
        this.bendArmR.setX(n, -(R.elbowRest + R.elbowReach * Math.max(0, -swing)));
        n++;
      }
      if (sc > 0.01) {
        if (lying) {
          // A body on the ground is its own silhouette: keep the blob under it, aligned with the ped, not with the sun.
          // rz is the extent ALONG `yaw` (ContactShadows.add composes the quad on a plane rotated by yaw, so local +Z
          // is the yaw direction) and the body lies ALONG its yaw: the 'YXZ' pose above tips local +Y onto -Z BEFORE
          // the yaw turn, so the figure points where it was walking. The two used to be the wrong way round, which
          // put a 3 m wide pool across a 0.45 m corpse and left its head and feet on undarkened ground.
          this.shadows.add(t.x, gy + R.shadowLift, t.z, R.shadowR * 0.75 * wide, R.shadowR * 1.7 * wide, t.yaw, sc, 1);
        } else {
          const gs = this.groundShadow;
          const rx = R.shadowR * R.shadowNarrow * wide;
          const rz = R.shadowR * gs.stretch * wide;
          // Only `shadowAnchor` of the way out, not the full (rz - rx). Pushing the ellipse until its near RIM sat
          // under the shoes left its undiluted core — the mask is solid only inside SHADOW_TUNING.penumbra of the
          // rim — the best part of a metre downlight of the figure, which is exactly the "detached blob" read
          // the stretch was added to cure. Half the offset keeps the dark part under the ped and still runs the tail
          // away from the light.
          const push = (rz - rx) * R.shadowAnchor;
          this.shadows.add(t.x + gs.dirX * push, gy + R.shadowLift, t.z + gs.dirZ * push, rx, rz,
            Math.atan2(gs.dirX, gs.dirZ), sc, 1);
        }
      }
    }
    this.finish(this.body, n);
    this.finish(this.head, n);
    this.finish(this.legL, n);
    this.finish(this.legR, n);
    this.finish(this.armL, n);
    this.finish(this.armR, n);
    this.finish(this.far, f);
    this.bodyVariant.needsUpdate = true;
    this.headVariant.needsUpdate = true;
    this.skinL.needsUpdate = true;
    this.skinR.needsUpdate = true;
    this.pants.needsUpdate = true;
    this.bendLegL.needsUpdate = true;
    this.bendLegR.needsUpdate = true;
    this.bendArmL.needsUpdate = true;
    this.bendArmR.needsUpdate = true;
    this.farVariantAttr.needsUpdate = true;
    this.farSwingAttr.needsUpdate = true;
    this.farSkinAttr.needsUpdate = true;
    this.farPantsAttr.needsUpdate = true;
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
    const meshes = [this.body, this.head, this.legL, this.legR, this.armL, this.armR, this.far];
    for (let i = 0; i < meshes.length; i++) {
      this.scene.remove(meshes[i]);
      meshes[i].geometry.dispose();
      meshes[i].dispose();
    }
    this.shadows.dispose();
    this.mat.dispose();
    this.farMat.dispose();
    this.depthMat.dispose();
  }
}
