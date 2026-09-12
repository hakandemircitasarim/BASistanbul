// Street props for CityRenderer: palms (two seeded variants: trunk + alpha fronds near, one solid far LOD beyond
// PROP_RANGE.palmNear), sidewalk trees in two species (broad forked crowns and tall tiered cypresses), clipped hedge
// units, lamps (pole + head + pavement pool), benches, hydrants, bins, signs, shelters (frame + glazing), bollards,
// the batched street clutter (utility poles with catenary wires, traffic signs, alley dumpsters, café tables with
// parasols); plus the static parked cars of the lot bays and the kerbs (a coarse shell per spec, the full body loft
// for the handful nearest the camera, paint per instance), kerb islands and planters. Track B.
//
// Everything is sculpted from lathes, swept tubes and rounded slabs rather than raw boxes: a gooseneck lamp arm, a
// chamfered bollard, a slatted bench with cast-iron ends, a glazed shelter with a rounded roof, fronds that arch from
// their base with a V midrib and a fibrous crown. Every part that shares a material lives in ONE THREE.BatchedMesh per
// material (multi-draw): all the vertex-coloured furniture is a single draw call (+ one shadow draw), so is the
// foliage (tree species, hedge variants, far palms), and so is each rung of the parked-car fidelity ladder — coarse
// shells, mid shells and near lofts, paint per instance through the batch colour — plus the palm trunks and the alpha
// fronds. Only the lamp parts (three materials), the shelter glass, the additive pool quads and the wire LineSegments
// keep their own mesh, so the prop pass is 12 meshes.
//
// After dark the lamps closest to the camera also carry real THREE.PointLights (LAMP_LIGHTS): a small fixed pool
// created once and re-aimed at the nearest heads every frame, so the asphalt's normal map and its damp night
// roughness answer the street lighting instead of only an additive disc painting over them.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { LotProp, ParkedCar, ParkedSpec, Prop } from '../city/CityData';
import { CURB_H } from '../city/CityConfig';
import { HEDGE } from '../city/CityLots';
import { SPECS } from '../entities/VehicleSpecs';
import { Random } from '../core/Random';
import type { Materials } from './Materials';
import { LEAF_TILE_M } from './PropTextures';
import { ContactShadows } from './ContactShadows';
import { surface, tube, type Ring } from './PlayerRenderer';
import { makeVehiclePaintMaterial, parkedMidGeometry, parkedNearGeometry, parkedShellGeometry } from './VehicleRenderer';

export const PROP_DIMS = { palmTrunkH: 6.4, palmFrondLen: 4.4, palmFrondW: 2.3, lampH: 6.5, lampArm: 1.4, poolRadius: 5.5 } as const;

/** Street furniture colours; each part is baked into the vertex colours so one material covers every kind. */
const FURN = {
  binBody: 0x33513f, binLid: 0x1d3025, binBand: 0x9aa4a8, pole: 0x8b9298, blade: 0x1d6a49,
  post: 0x4a5058, roof: 0x2f353b, fascia: 0xb8702c, frame: 0x30353a, seat: 0x9a6a3c, iron: 0x2b2f33,
  bollard: 0x3c4147, bollardCap: 0xc3c8cd, hydrant: 0xd8302a, hydrantDark: 0x8e1f1a,
  kerb: 0x9c988f, kerbTop: 0xaaa69d, gravel: 0x5a5148, pot: 0x8f897d, potRim: 0x9d978b, soil: 0x3d3229, shrub: 0x44663f, shrubLit: 0x709056,
  // Trees (foliage material): bark, crown mass, its lit top and shaded underside; the far palm's trunk and fans.
  // Every green here is the old hue at 75 % of its saturation: the lime crowns read as poster paint next to the
  // desaturated stone and asphalt of the rest of the city, and a stylised city wants its foliage a shade dustier.
  bark: 0x5c4634, barkDark: 0x3d2e22, crown: 0x4b6d3e, crownLit: 0x7a9459, crownDark: 0x2c4128,
  // Sun-struck stop of the two-stop bark ramp: a trunk lit only by a vertical gradient reads as a plastic tube, so the
  // ramp runs barkDark (root) -> bark (shaft) -> barkLit (under the crown, where the sky reaches it).
  barkLit: 0x6d5335,
  // Hedges: a deeper, less lime green than the planter shrubs, lit along the clipped top and shaded at the foot.
  hedge: 0x3f633a, hedgeLit: 0x62874e, hedgeDark: 0x263e23,
  // Conifer: darker and bluer than the broad crowns, so a cypress reads as the shadow note in a row of them.
  conifer: 0x35512f, coniferLit: 0x5c7a48, coniferDark: 0x1e3220,
  palmBarkFar: 0x8b7252, frondFar: 0x5e8546, frondFarTip: 0x7fa25a,
  // Clutter: creosoted pole timber, its steel crossarm and porcelain insulators; sign post / plate / face; dumpster
  // steel, its heavier lid and rubber castors; café table top, its rim and the two tones of the parasol canopy.
  poleWood: 0x7a6247, poleWoodDark: 0x4e3e2c, poleArm: 0x6b6f74, insulator: 0xbfd4cf,
  signPost: 0x8d949b, signFace: 0xe9e5da, signRed: 0xb52f27, signBack: 0x6f757c,
  dumpster: 0x3c6a72, dumpsterLid: 0x2a4a50, castor: 0x1d2023,
  tableTop: 0xd8cdb8, tableRim: 0x8d8471, parasolA: 0xd8623c, parasolB: 0xe9e2d2, parasolPole: 0x8d8471,
} as const;

/** Lot floor height (CityRenderer's STREET.lotFloorY: the asphalt sits 2 cm above the block pavement). */
const LOT_FLOOR_Y = CURB_H + 0.02;

const scratchColor = new THREE.Color();

/** Bakes one colour into a part's vertex colours, so merged multi-colour furniture needs a single material. */
function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  scratchColor.setHex(hex);
  return tintRGB(g, scratchColor.r, scratchColor.g, scratchColor.b);
}

/** Bakes an RGB tint into a part's vertex colours. */
function tintRGB(g: THREE.BufferGeometry, r: number, gg: number, b: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Lerps every vertex colour toward `hex` by `k(x, y, z)` (a lit crown on a shrub, a paler kerb top). */
function blendTo(g: THREE.BufferGeometry, hex: number, k: (x: number, y: number, z: number) => number): THREE.BufferGeometry {
  scratchColor.setHex(hex);
  const pos = g.attributes.position, col = g.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const t = k(pos.getX(i), pos.getY(i), pos.getZ(i));
    col.setXYZ(i, col.getX(i) + (scratchColor.r - col.getX(i)) * t, col.getY(i) + (scratchColor.g - col.getY(i)) * t, col.getZ(i) + (scratchColor.b - col.getZ(i)) * t);
  }
  return g;
}

/**
 * Strips a three.js primitive down to the attribute set the sculpting helpers emit (non-indexed position + normal),
 * so boxes, rounded slabs and lathes can be merged into one geometry.
 */
function bare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  out.deleteAttribute('uv');
  return out;
}

function fuse(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  return merged;
}

/**
 * Marks how much of the leaf albedo a part of a foliage prop takes (the foliage material's shader multiplies its map
 * in by this attribute, see Materials.leafMapMixPatch): 1 for leaves, 0 for bark.
 *
 * The whole foliage batch shares one material and one attribute set, so a tree's bark trunk and limbs, a cypress'
 * bole and the far palm's trunk travel in the same geometry as the crowns — and a leaf map multiplied over them
 * printed leaf ellipses on the bark and pulled a warm brown column toward moss green. This is the cheapest way to
 * keep one draw call and still leave bark alone: one float a vertex, no second material, no second batch.
 */
function leafMixAttr(g: THREE.BufferGeometry, mix: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const a = new Float32Array(n);
  if (mix !== 0) a.fill(mix);
  g.setAttribute('leafMix', new THREE.BufferAttribute(a, 1));
  return g;
}

/**
 * How much of the leaf albedo each kind of foliage takes.
 *
 * The crowns are down to a whisper. At full strength the map's ellipses are 20-30 cm blobs on a 1.3 m lobe, and three
 * critics in a row read the result as mottled camouflage rather than leaves ("broccoli"): fine noise fights the
 * deliberate faceting a stylised low-poly crown is made of. The crowns now get their structure from `shadeCrown`
 * (flat tone bands per facet) instead, and keep just enough of the map (0.08) for its `leafMix > 0` side effects —
 * the daylight translucency emissive and the night leaf glow, which are gated by the same attribute.
 * Hedges keep a real but halved share: a clipped box has no facet structure of its own to read, and at the 1 m a
 * planter is walked past a little leaf grain is the difference between a hedge and a green kerb.
 */
const LEAF_MIX = { crown: 0.08, hedge: 0.32, frond: 1, bark: 0 } as const;

const R = (y: number, r: number, x = 0, z = 0): Ring => ({ y, rx: r, rz: r, x, z });

/** Painted lathe: rings bottom to top, `radial` sides. */
function lathe(rings: Ring[], radial: number, hex: number, capTop = false, capBot = false): THREE.BufferGeometry {
  return paint(tube(rings, radial, capTop, capBot), hex);
}

/** Painted box / rounded slab centred at (x, y, z). */
function slab(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, r = 0, segs = 1): THREE.BufferGeometry {
  const g = bare(r > 0 ? new RoundedBoxGeometry(w, h, d, segs, r) : new THREE.BoxGeometry(w, h, d));
  g.translate(x, y, z);
  return paint(g, hex);
}

const sT = new THREE.Vector3(), sN = new THREE.Vector3(), sB = new THREE.Vector3();

/**
 * Tube swept along a polyline of stations (a gooseneck arm, a cast-iron scroll): each station gets a circle of
 * `radial` points in the plane normal to the local tangent; `ref` is any vector not parallel to the path, used to
 * orient the circles consistently. `radius(i)` lets the tube taper.
 */
function sweep(pts: THREE.Vector3[], radius: (i: number) => number, radial: number, ref: THREE.Vector3): THREE.BufferGeometry {
  const n = pts.length;
  // Flipped winding: N x B here is the mirror of the lathe's sin/cos layout, so the faces would point inward.
  return surface(n, radial, true, true, (i, j, out) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    sT.subVectors(b, a).normalize();
    sN.crossVectors(sT, ref).normalize();
    sB.crossVectors(sT, sN);
    const ang = (j / radial) * Math.PI * 2, r = radius(i);
    out.copy(pts[i]).addScaledVector(sN, Math.sin(ang) * r).addScaledVector(sB, Math.cos(ang) * r);
  });
}

/** Litter bin: a chamfered, slightly conical body with a steel band and a heavier domed lid. */
function binGeometry(): THREE.BufferGeometry {
  const body = lathe([R(0, 0.205), R(0.05, 0.235), R(0.62, 0.27), R(0.66, 0.285)], 12, FURN.binBody, false, true);
  const band = lathe([R(0.66, 0.285), R(0.71, 0.295), R(0.73, 0.285)], 12, FURN.binBand);
  const lid = lathe([R(0.73, 0.285), R(0.77, 0.31), R(0.82, 0.29), R(0.85, 0.2)], 12, FURN.binLid, true);
  return fuse([body, band, lid]);
}

/** Street-name sign: a tapered pole on a small collar with two rounded blades crossing near the top. */
function signGeometry(): THREE.BufferGeometry {
  const pole = lathe([R(0, 0.07), R(0.08, 0.07), R(0.12, 0.05), R(2.5, 0.04)], 8, FURN.pole, true);
  const a = slab(0.95, 0.17, 0.035, 0.36, 2.3, 0, FURN.blade, 0.015);
  const b = slab(0.035, 0.17, 0.95, 0, 2.08, 0.36, FURN.blade, 0.015);
  return fuse([pole, a, b]);
}

/**
 * Bus shelter frame: four round posts, a rounded roof slab with a coloured fascia lip, thin rails framing the back
 * and left glazing, and a slatted seat on round legs. The panes themselves are `shelterGlassGeometry` (transparent
 * material, own instanced mesh). Faces -Z (the road) at yaw 0.
 */
function shelterGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const px = i < 2 ? -1.72 : 1.72, pz = i % 2 === 0 ? -0.62 : 0.62;
    parts.push(lathe([R(0, 0.05, px, pz), R(0.06, 0.05, px, pz), R(0.09, 0.042, px, pz), R(2.48, 0.042, px, pz)], 8, FURN.post));
  }
  parts.push(slab(3.75, 0.1, 1.55, 0, 2.5, 0, FURN.roof, 0.05, 2));
  // Fascia lip hanging 0.15 m below the roof edge, all four sides.
  parts.push(slab(3.75, 0.15, 0.035, 0, 2.42, -0.775, FURN.fascia));
  parts.push(slab(3.75, 0.15, 0.035, 0, 2.42, 0.775, FURN.fascia));
  parts.push(slab(0.035, 0.15, 1.55, -1.875, 2.42, 0, FURN.fascia));
  parts.push(slab(0.035, 0.15, 1.55, 1.875, 2.42, 0, FURN.fascia));
  // Back glazing rails (top, bottom, centre mullion) and the left end rails.
  parts.push(slab(3.5, 0.05, 0.05, 0, 0.42, 0.7, FURN.frame));
  parts.push(slab(3.5, 0.05, 0.05, 0, 2.06, 0.7, FURN.frame));
  parts.push(slab(0.04, 1.6, 0.04, 0, 1.24, 0.7, FURN.frame));
  parts.push(slab(0.05, 0.05, 1.25, -1.72, 0.42, 0.04, FURN.frame));
  parts.push(slab(0.05, 0.05, 1.25, -1.72, 2.2, 0.04, FURN.frame));
  // Slatted seat: four slats with 2 cm gaps on two brackets and round legs.
  for (let k = 0; k < 4; k++) parts.push(slab(3.0, 0.03, 0.09, 0, 0.47, 0.44 + (k - 1.5) * 0.11, FURN.seat));
  for (let i = 0; i < 2; i++) {
    const x = i === 0 ? -1.25 : 1.25;
    parts.push(slab(0.06, 0.04, 0.44, x, 0.435, 0.44, FURN.iron));
    parts.push(lathe([R(0, 0.03, x, 0.44), R(0.43, 0.03, x, 0.44)], 6, FURN.iron));
  }
  return fuse(parts);
}

/** Bus shelter glazing: the back pane and the left end pane (drawn with the transparent glass material). */
function shelterGlassGeometry(): THREE.BufferGeometry {
  const back = new THREE.BoxGeometry(3.44, 1.6, 0.012);
  back.translate(0, 1.24, 0.7);
  const end = new THREE.BoxGeometry(0.012, 1.74, 1.22);
  end.translate(-1.72, 1.31, 0.04);
  return fuse([back, end]);
}

/** Height of the wire crossarm on a utility pole, and the insulator offsets across it (the renderer strings wires here). */
export const UTILITY = { height: 8.2, armY: 7.35, armHalf: 0.62, wireDrop: 0.16 } as const;

/**
 * Timber utility pole: an 8-sided creosoted trunk with a slight taper and a dark base band, a steel crossarm across
 * the street, three porcelain insulators (the wires hang from these) and a small service box strapped low down.
 * Authored with local +Z pointing at the road, so the crossarm runs along local X (the line of poles).
 */
function utilityPoleGeometry(): THREE.BufferGeometry {
  const H = UTILITY.height;
  const post = lathe([R(0, 0.16), R(0.35, 0.145), R(H * 0.55, 0.125), R(H, 0.105)], 8, FURN.poleWood, true);
  blendTo(post, FURN.poleWoodDark, (_x, y) => (y < 1.1 ? 1 - y / 1.1 : 0) * 0.85);
  const parts: THREE.BufferGeometry[] = [post];
  parts.push(slab(UTILITY.armHalf * 2 + 0.2, 0.09, 0.075, 0, UTILITY.armY, 0, FURN.poleArm));
  // Diagonal brace under the arm.
  const brace = slab(0.05, 0.05, 0.6, 0, 0, 0, FURN.poleArm);
  brace.rotateX(0.75);
  brace.translate(0, UTILITY.armY - 0.26, 0);
  parts.push(brace);
  for (let k = -1; k <= 1; k++) {
    const x = k * UTILITY.armHalf;
    parts.push(lathe([R(UTILITY.armY + 0.04, 0.045, x), R(UTILITY.armY + 0.1, 0.07, x), R(UTILITY.armY + 0.15, 0.05, x), R(UTILITY.armY + 0.2, 0.065, x)], 6, FURN.insulator, true));
  }
  parts.push(slab(0.3, 0.42, 0.2, 0, 2.5, 0.16, FURN.poleArm, 0.03));
  return fuse(parts);
}

/**
 * Traffic sign: a slim galvanised post with a round plate on it — a red ring around a pale face, a darker back — plus
 * a small rectangular plate below it. The faces look along local -Z (the yaw the generator gives it aims that at the
 * oncoming lane).
 */
function roadSignGeometry(): THREE.BufferGeometry {
  const post = lathe([R(0, 0.06), R(0.07, 0.06), R(0.1, 0.042), R(2.35, 0.036)], 6, FURN.signPost, true);
  const parts: THREE.BufferGeometry[] = [post];
  const y = 2.0;
  // Plate: a 10-sided disc standing across local z — a red rim around a pale face, dark on the back.
  const plate = new THREE.CylinderGeometry(0.3, 0.3, 0.026, 10, 1, false);
  plate.rotateX(Math.PI / 2);
  plate.translate(0, y, -0.045);
  const face = paint(bare(plate), FURN.signFace);
  blendTo(face, FURN.signRed, (x, py) => (Math.hypot(x, py - y) > 0.2 ? 1 : 0));
  blendTo(face, FURN.signBack, (_x, _py, z) => (z > -0.045 ? 1 : 0));
  parts.push(face);
  parts.push(slab(0.46, 0.2, 0.02, 0, 1.5, -0.045, FURN.signFace));
  return fuse(parts);
}

/**
 * Wheeled dumpster: a tapered steel tub (wider at the lip), a heavier hinged lid sloping to the front, a kick rail and
 * four small castors. Authored long along local X, backed against the alley wall at local +Z.
 */
function dumpsterGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Tub: a 4-sided lathe (a box that flares), so the walls lean out like a real skip.
  const tub = tube([{ y: 0.16, rx: 1.02, rz: 0.6 }, { y: 1.12, rx: 1.16, rz: 0.72 }, { y: 1.2, rx: 1.18, rz: 0.74 }], 4, false, true);
  tub.rotateY(Math.PI / 4); // 4-gon lathe -> a box with flat sides facing the axes
  parts.push(blendTo(paint(tub, FURN.dumpster), FURN.dumpsterLid, (_x, y) => Math.max(0, Math.min(1, 1 - y / 0.7)) * 0.55));
  const lid = slab(2.34, 0.09, 1.42, 0, 1.24, 0, FURN.dumpsterLid, 0.04);
  lid.rotateX(0.07);
  parts.push(lid);
  parts.push(slab(2.3, 0.07, 0.07, 0, 0.58, -0.62, FURN.dumpsterLid));
  for (let k = 0; k < 4; k++) {
    const x = (k < 2 ? -1 : 1) * 0.82, z = (k % 2 === 0 ? -1 : 1) * 0.42;
    parts.push(lathe([R(0.0, 0.12, x, z), R(0.14, 0.12, x, z)], 6, FURN.castor, true, true));
  }
  return fuse(parts);
}

/**
 * Café table: a round top on a cast column and a cross foot, with a parasol standing through it — an 8-panel canopy
 * in two alternating tones on a pole, the classic striped awning of a Turkish çay bahçesi.
 */
function cafeTableGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const top = lathe([R(0.70, 0.40), R(0.74, 0.42), R(0.76, 0.40)], 10, FURN.tableTop, true, true);
  blendTo(top, FURN.tableRim, (x, _y, z) => (Math.hypot(x, z) > 0.36 ? 1 : 0));
  parts.push(top);
  parts.push(lathe([R(0.02, 0.16), R(0.05, 0.1), R(0.70, 0.07)], 6, FURN.tableRim, false, true));
  parts.push(lathe([R(0.76, 0.035), R(2.05, 0.032)], 6, FURN.parasolPole));
  // Canopy: alternating panels, so the parasol reads as striped rather than as one orange cone.
  for (let k = 0; k < 8; k++) {
    const a0 = (k / 8) * Math.PI * 2, a1 = ((k + 1) / 8) * Math.PI * 2;
    const panel = surface(2, 2, false, false, (i, j, out) => {
      const a = j === 0 ? a0 : a1;
      if (i === 0) out.set(0, 2.16, 0);
      else out.set(Math.sin(a) * 1.05, 1.82, Math.cos(a) * 1.05);
    });
    const both = fuse([panel, flipFaces(panel)]);
    parts.push(paint(both, k % 2 === 0 ? FURN.parasolA : FURN.parasolB));
  }
  return fuse(parts);
}

/** Promenade bollard: a chamfered post with a domed light cap. */
function bollardGeometry(): THREE.BufferGeometry {
  const post = lathe([R(0, 0.115), R(0.07, 0.115), R(0.1, 0.095), R(0.74, 0.088), R(0.79, 0.078)], 12, FURN.bollard);
  const cap = lathe([R(0.79, 0.078), R(0.85, 0.088), R(0.93, 0.05)], 12, FURN.bollardCap, true);
  return fuse([post, cap]);
}

/** Fire hydrant: flanged base, tapered barrel, collar and dome, two capped side nozzles. */
function hydrantGeometry(): THREE.BufferGeometry {
  const body = lathe([R(0, 0.19), R(0.05, 0.19), R(0.08, 0.15), R(0.52, 0.14), R(0.55, 0.165), R(0.62, 0.165), R(0.64, 0.145), R(0.72, 0.11), R(0.79, 0.045)], 10, FURN.hydrant, true);
  const parts = [body];
  for (let s = -1; s <= 1; s += 2) {
    const nz = lathe([R(0, 0.06), R(0.15, 0.06), R(0.17, 0.075), R(0.22, 0.075)], 6, FURN.hydrantDark, true);
    nz.rotateZ(-s * Math.PI / 2);
    nz.translate(s * 0.12, 0.42, 0);
    parts.push(nz);
  }
  return fuse(parts);
}

/**
 * Park bench: five seat slats with 2 cm gaps, a back of three slats that recline progressively (a curved back in
 * profile), and cast-iron ends: a swept scroll bar from the front foot over the armrest to the back top, plus a back leg.
 */
function benchGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 5; k++) parts.push(slab(1.7, 0.035, 0.085, 0, 0.45, (k - 2) * 0.105, FURN.seat));
  for (let k = 0; k < 3; k++) {
    const y = 0.56 + k * 0.13, z = -0.24 - k * 0.035;
    const s = slab(1.7, 0.1, 0.03, 0, 0, 0, FURN.seat);
    s.rotateX(-(0.12 + k * 0.1));
    s.translate(0, y, z);
    parts.push(s);
  }
  for (let side = -1; side <= 1; side += 2) {
    const x = side * 0.8;
    const scroll = [
      new THREE.Vector3(x, 0, 0.25), new THREE.Vector3(x, 0.24, 0.27), new THREE.Vector3(x, 0.47, 0.25),
      new THREE.Vector3(x, 0.62, 0.12), new THREE.Vector3(x, 0.72, -0.1), new THREE.Vector3(x, 0.85, -0.26),
    ];
    parts.push(paint(sweep(scroll, (i) => (i === 5 ? 0.02 : 0.028), 6, new THREE.Vector3(1, 0, 0)), FURN.iron));
    parts.push(lathe([R(0, 0.028, x, -0.2), R(0.44, 0.028, x, -0.2)], 6, FURN.iron));
    parts.push(slab(0.05, 0.03, 0.5, x, 0.415, 0, FURN.iron));
  }
  return fuse(parts);
}

/**
 * Lamp post: a 10-sided pole with a base collar, and a gooseneck arm swept along an arc that rises from the pole top
 * and curves out over the road (+Z). The head sits at `PROP_DIMS.lampArm`.
 */
function poleGeometry(): THREE.BufferGeometry {
  const H = PROP_DIMS.lampH;
  const pole = tube([R(0, 0.16), R(0.32, 0.16), R(0.4, 0.105), R(H - 0.3, 0.07)], 10, false, false);
  const arc = 0.8, top = H - 0.3, pts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 3) * 1.85; // 0..106 deg: up, over and slightly down
    pts.push(new THREE.Vector3(0, top + arc * Math.sin(a), arc * (1 - Math.cos(a))));
  }
  const arm = sweep(pts, (i) => 0.07 - i * 0.01, 6, new THREE.Vector3(1, 0, 0));
  return fuse([pole, arm]);
}

/** Cobra-style luminaire: an elongated 6-sided ovoid hanging from the arm tip, closed to a point top and bottom. */
function headGeometry(): THREE.BufferGeometry {
  const y = PROP_DIMS.lampH + 0.35, z = PROP_DIMS.lampArm - 0.32;
  return tube([{ y: y - 0.14, rx: 0.02, rz: 0.03, z }, { y, rx: 0.24, rz: 0.42, z }, { y: y + 0.1, rx: 0.16, rz: 0.3, z }, { y: y + 0.14, rx: 0.02, rz: 0.03, z }], 6, false, false);
}

/**
 * Kerb island at the head of a bay strip: a rounded kerb slab (bay-long along x, a door wide) with a paler top face
 * and a sunken gravel fill; the planters that stand on it are their own prop.
 */
function islandGeometry(): THREE.BufferGeometry {
  const kerb = blendTo(slab(5.6, 0.16, 1.5, 0, 0.08, 0, FURN.kerb, 0.04), FURN.kerbTop, (_x, y) => (y > 0.14 ? 1 : 0));
  const fill = slab(5.2, 0.02, 1.1, 0, 0.15, 0, FURN.gravel);
  return fuse([kerb, fill]);
}

/**
 * Planter: an 8-sided tapered concrete pot with a rolled rim, a soil disc and a clipped shrub (a lathed ovoid whose
 * crown is blended toward a lit green so it reads as a lit volume, not a dark blob).
 */
function planterGeometry(): THREE.BufferGeometry {
  const pot = lathe([R(0, 0.30), R(0.04, 0.34), R(0.50, 0.41), R(0.56, 0.45), R(0.60, 0.42)], 8, FURN.pot, false, true);
  const rim = lathe([R(0.56, 0.45), R(0.60, 0.42)], 8, FURN.potRim);
  const soil = lathe([R(0.54, 0.40), R(0.55, 0.40)], 8, FURN.soil, true);
  const shrub = lathe([R(0.50, 0.08), R(0.72, 0.40), R(0.95, 0.50), R(1.18, 0.42), R(1.36, 0.22), R(1.45, 0.05)], 8, FURN.shrub, true);
  blendTo(shrub, FURN.shrubLit, (_x, y) => Math.max(0, Math.min(1, (y - 0.9) / 0.55)));
  return fuse([pot, rim, soil, shrub]);
}

const dummy = new THREE.Object3D();
const mat = new THREE.Matrix4();

/**
 * Trunk: a 7-sided column of ringed segments (every other row flares so the joints read as leaf-scar rings) bent
 * along an S-curve, topped by a fibrous crown: three flared collars of leaf bases stacked like scales and a cone of
 * unopened spears. The bark texture's v runs 0..1 over the trunk, so the material's repeat sets the ring density.
 * Seeded so the two palm variants differ in lean and height.
 */
export function trunkGeometry(seed: number): THREE.BufferGeometry {
  const rng = new Random(seed);
  const rows = 7, H = PROP_DIMS.palmTrunkH * rng.range(0.86, 1.06);
  const lean = rng.range(0.04, 0.13), wob = rng.range(0.05, 0.08) * (rng.chance(0.5) ? 1 : -1);
  const g = new THREE.CylinderGeometry(0.15, 0.27, H, 7, rows, true);
  g.translate(0, H / 2, 0);
  const pos = g.attributes.position;
  const bend = (t: number): number => lean * t * t * H * 0.9 + wob * Math.sin(t * Math.PI * 2) * 0.35;
  for (let k = 0; k < pos.count; k++) {
    const y = pos.getY(k), t = y / H;
    const ring = Math.round(t * rows);
    const bulge = ring % 2 === 1 && ring < rows ? 1.12 : 1;
    pos.setX(k, pos.getX(k) * bulge + bend(t));
    pos.setZ(k, pos.getZ(k) * bulge);
  }
  g.computeVertexNormals();
  const parts = [g];
  const tx = bend(1);
  for (let k = 0; k < 3; k++) {
    const collar = new THREE.CylinderGeometry(0.44 - k * 0.07, 0.19, 0.32, 7, 1, true);
    collar.rotateY(k * 0.3);
    collar.translate(tx + (k === 1 ? 0.03 : -0.02), H - 0.14 + k * 0.2, k === 2 ? 0.03 : -0.02);
    parts.push(collar);
  }
  const spear = new THREE.CylinderGeometry(0, 0.25, 0.5, 7, 1, true);
  spear.translate(tx, H + 0.62, 0);
  parts.push(spear);
  const merged = fuse(parts);
  merged.userData.topX = tx;
  merged.userData.topY = H + 0.25;
  return merged;
}

/**
 * Adds a back face to every triangle without flipping its normal: the copy has reversed winding but keeps the
 * sky-facing normal, so a frond seen from below is shaded like foliage instead of going black at midday (which is
 * what THREE.DoubleSide does, since it negates the normal on back faces). The copy is the leaf's underside, so its
 * vertex colour is pulled darker and a little cooler (`underside`): a frond then has two tones, top and shadow side,
 * instead of reading as one flat paper cut-out.
 */
function withBackFaces(g: THREE.BufferGeometry, underside = 1): THREE.BufferGeometry {
  const back = g.clone();
  const col = back.attributes.color as THREE.BufferAttribute | undefined;
  if (col && underside !== 1) {
    for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * underside, col.getY(i) * underside * 0.97, col.getZ(i) * underside * 0.92);
  }
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

/**
 * One frond: a strip of `rows` segments whose midrib is an arc of constant curvature - it leaves the crown at `pitch`
 * (angle from straight up) and bends down by `bend` radians over its length, so the droop starts at the base instead
 * of only at the tip. Two columns give the leaf a V cross-section (the edges hang `crease` metres below the midrib,
 * plus `sag` more toward the tip); a single column is a flat strip for the dead skirt. The outline widens to `width`
 * a third of the way out and closes to a point, so the last row is two triangles meeting at the tip. UV v runs along
 * the length so the leaflet texture keeps its base-to-tip order.
 */
export function frondGeometry(len: number, width: number, pitch: number, yaw: number, bend: number, crease: number, sag: number, rows: number, cols: 1 | 2): THREE.BufferGeometry {
  const nx = cols + 1, nv = rows * nx + 1;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const ds = len / rows;
  let out = 0, up = 0, k = 0;
  const put = (x: number, y: number, o: number, u: number, v: number): void => {
    pos[k * 3] = x * cy + o * sy; pos[k * 3 + 1] = y; pos[k * 3 + 2] = -x * sy + o * cy;
    uv[k * 2] = u; uv[k * 2 + 1] = v;
    k++;
  };
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    if (i > 0) { const pm = pitch + bend * (t - 0.5 / rows); out += ds * Math.sin(pm); up += ds * Math.cos(pm); }
    if (i === rows) { put(0, up, out, 0.5, 1); break; }
    const phi = pitch + bend * t;
    const w = width * Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * t)), 0.7);
    for (let c = 0; c < nx; c++) {
      const xs = cols === 2 ? c - 1 : c * 2 - 1;
      const drop = cols === 2 ? Math.abs(xs) * (crease + sag * t) : 0;
      // The frond's "up" normal in the (out, up) plane is (-cos phi, sin phi); edges are pushed the other way.
      put(xs * w * 0.5, up - drop * Math.sin(phi), out + drop * Math.cos(phi), (xs + 1) * 0.5, t);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let c = 0; c < nx - 1; c++) {
      const a = i * nx + c, b = a + 1, d = a + nx, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const last = (rows - 1) * nx, tip = nv - 1;
  for (let c = 0; c < nx - 1; c++) idx.push(last + c, tip, last + c + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const sP = new THREE.Vector3(), sC = new THREE.Vector3();

/**
 * Foliage normal trick: blends each vertex normal `k` of the way toward the direction from a point below the crown
 * centre, so the canopy shades like one soft volume (lit on top, darker underneath) instead of each frond going
 * black wherever its own face happens to turn away from the sun.
 */
function canopyNormals(g: THREE.BufferGeometry, cy: number, k: number): void {
  const pos = g.attributes.position, nrm = g.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    sP.set(pos.getX(i), pos.getY(i) - cy, pos.getZ(i)).normalize();
    sC.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).lerp(sP, k).normalize();
    nrm.setXYZ(i, sC.x, sC.y, sC.z);
  }
}

/** Crown: 14 arching live fronds with seeded jitter in yaw, pitch and bend, plus a skirt of 3 short dead fronds. */
export function frondsGeometry(topX: number, topY: number, seed: number): THREE.BufferGeometry {
  const rng = new Random(seed);
  const parts: THREE.BufferGeometry[] = [];
  const L = PROP_DIMS.palmFrondLen, W = PROP_DIMS.palmFrondW;
  const n = 14;
  for (let i = 0; i < n; i++) {
    const len = L * rng.range(0.8, 1.1);
    // Alternate inner (steeper, shorter bend) and outer (flatter, arching harder) fronds around the crown.
    const inner = i % 2 === 0;
    const pitch = inner ? rng.range(0.25, 0.6) : rng.range(0.75, 1.15);
    const bend = inner ? rng.range(0.9, 1.2) : rng.range(1.1, 1.5);
    const g = frondGeometry(len, W * rng.range(0.9, 1.05), pitch, (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2), bend, 0.25, 0.18, 4, 2);
    canopyNormals(g, -30, 1);
    g.translate(topX, topY + (inner ? 0.1 : -0.05), 0);
    const v = rng.range(0.82, 1);
    tintRGB(g, v, v, v * 0.96);
    const both = withBackFaces(g, 0.66);
    g.dispose();
    parts.push(both);
  }
  for (let i = 0; i < 3; i++) {
    const len = L * rng.range(0.4, 0.55);
    const g = frondGeometry(len, W * 0.55, rng.range(2.5, 2.9), (i / 3) * Math.PI * 2 + rng.range(-0.5, 0.5), 0.15, 0, 0, 2, 1);
    canopyNormals(g, -30, 1);
    g.translate(topX, topY - 0.3, 0);
    tintRGB(g, 0.5, 0.4, 0.26);
    const both = withBackFaces(g, 0.78);
    g.dispose();
    parts.push(both);
  }
  return fuse(parts);
}

/**
 * Direction-driven wobble in [-1, 1]: three sine products of the *normalised* vertex direction, so a non-indexed
 * primitive (three's polyhedra duplicate their corners per face) displaces every copy of a corner identically and the
 * shell never tears. `p` shifts the pattern per lobe.
 */
function lobeWobble(x: number, y: number, z: number, p: number): number {
  const l = Math.max(1e-4, Math.sqrt(x * x + y * y + z * z));
  const nx = x / l, ny = y / l, nz = z / l;
  return Math.sin(nx * 5.3 + p) * Math.sin(ny * 4.1 + p * 1.7 + 1.1) * Math.sin(nz * 6.2 + p * 0.6 + 2.3);
}

/**
 * One crown lobe: an icosahedron (detail 1 for the big masses, 0 for the small outer ones) pushed in and out by
 * `lobeWobble` so no two lobes share a silhouette, then re-normalled flat and blended `soft` of the way back toward
 * the direction out of the crown centre — the facets stay visible (low poly, not a smooth ball) but the lobe still
 * shades as one volume, lit on top and dark underneath.
 */
function crownLobe(r: number, detail: 0 | 1, phase: number, amp: number, squash: number, soft: number): THREE.BufferGeometry {
  const g = bare(new THREE.IcosahedronGeometry(r, detail));
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 1 + amp * lobeWobble(x, y, z, phase);
    pos.setXYZ(i, x * k, y * k * squash, z * k);
  }
  g.computeVertexNormals();
  canopyNormals(g, 0, soft);
  return g;
}

/** Copy of a non-indexed geometry with every triangle's winding reversed (its normals are left pointing where they were). */
function flipFaces(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.clone();
  for (const name of ['position', 'normal'] as const) {
    const a = g.attributes[name] as THREE.BufferAttribute | undefined;
    if (!a) continue;
    const arr = a.array as Float32Array, s = a.itemSize;
    for (let i = 0; i + 3 * s <= arr.length; i += 3 * s) {
      for (let k = 0; k < s; k++) { const t = arr[i + s + k]; arr[i + s + k] = arr[i + 2 * s + k]; arr[i + 2 * s + k] = t; }
    }
    a.needsUpdate = true;
  }
  return g;
}

const sU = new THREE.Vector3(), sV = new THREE.Vector3();

/**
 * Gives a solid-foliage part the leaf albedo's UVs and a per-facet value jitter, and is the last thing done to every
 * geometry that goes into the foliage batch.
 *
 * UVs: a triplanar projection resolved PER FACE — the dominant axis of the face's own normal picks which two world
 * axes become u and v, in metres over LEAF_TILE_M. That is enough for a texture with no direction to it (leaves), it
 * needs no seams or unwrap on a wobbled icosahedron / lathed cone / lofted box, and because every vertex of a triangle
 * gets the same axis pair the interpolation inside it is exact. World-space, so two neighbouring lobes of one crown
 * never repeat the same patch of leaf.
 *
 * Jitter: +-`jit` on the whole facet's colour. The crowns are deliberately faceted (flat face normals), and a facet
 * that differs from its neighbour in value as well as in shading is what turns a faceted ball into foliage.
 *
 * Converts to non-indexed first: per-face data needs per-face vertices, and everything else in the batch already is.
 */
function leafSurface(g: THREE.BufferGeometry, seed: number, jit = 0.06): THREE.BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g;
  if (src !== g) g.dispose();
  const pos = src.attributes.position;
  const col = src.attributes.color as THREE.BufferAttribute | undefined;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  const rng = new Random(seed);
  const inv = 1 / LEAF_TILE_M;
  for (let t = 0; t + 2 < n; t += 3) {
    sU.set(pos.getX(t + 1) - pos.getX(t), pos.getY(t + 1) - pos.getY(t), pos.getZ(t + 1) - pos.getZ(t));
    sV.set(pos.getX(t + 2) - pos.getX(t), pos.getY(t + 2) - pos.getY(t), pos.getZ(t + 2) - pos.getZ(t));
    sU.cross(sV);
    const ax = Math.abs(sU.x), ay = Math.abs(sU.y), az = Math.abs(sU.z);
    const axis = ay >= ax && ay >= az ? 1 : ax >= az ? 0 : 2;
    const k = jit > 0 ? 1 + rng.range(-jit, jit) : 1;
    for (let c = 0; c < 3; c++) {
      const i = t + c, x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      uv[i * 2] = (axis === 0 ? z : x) * inv;
      uv[i * 2 + 1] = (axis === 1 ? z : y) * inv;
      if (col && k !== 1) col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
    }
  }
  src.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  // Anything that did not split itself into leaf and bark parts is all leaf.
  if (!src.attributes.leafMix) leafMixAttr(src, 1);
  return src;
}

/**
 * Two-stop bark ramp on a lathed trunk: barkDark at the root (soil contact), FURN.bark up the shaft, barkLit toward
 * the top where the sky reaches it, plus a per-facet value jitter. A trunk shaded by nothing but its own facet normals
 * reads as a smooth plastic tube — which is what the last critic saw — and the leaf map cannot help, because bark
 * carries leafMix 0 on purpose. `rootH` is how far up the root darkening reaches, `topY` the top of the shaft.
 */
function barkRamp(g: THREE.BufferGeometry, rootH: number, topY: number): void {
  // Flat facet normals. `tube` smooth-shades its rings, and a smooth cylindrical gradient is precisely what reads as a
  // plastic tube: it hides the eight lathe columns the trunk is actually made of. Non-indexed geometry means
  // computeVertexNormals gives one normal per face, so each column becomes its own flat strip of tone - the same
  // deliberate faceting the crowns get from shadeCrown, and the shape the silhouette already has.
  g.computeVertexNormals();
  blendTo(g, FURN.barkLit, (_x, y) => Math.max(0, Math.min(1, (y - topY * 0.5) / Math.max(0.4, topY * 0.5))) * 0.48);
  blendTo(g, FURN.barkDark, (_x, y) => { const t = Math.max(0, Math.min(1, 1 - y / rootH)); return t * t * 0.95; });
  // Per-facet jitter: eight lathe columns of one flat brown is a tube; a few percent of value between them is bark.
  const pos = g.attributes.position, col = g.attributes.color;
  for (let t = 0; t + 2 < pos.count; t += 3) {
    const k = 0.90 + 0.18 * (((t * 2654435761) >>> 8) % 97) / 96;
    for (let c = 0; c < 3; c++) { const i = t + c; col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k); }
  }
}

/** Crown tone bands, darkest first: underside, mass, top-lit. Flat colours, deliberately not a gradient. */
const CROWN_BANDS = [FURN.crownDark, FURN.crown, FURN.crownLit] as const;
const crownBase = new THREE.Color();
const crownMass = new THREE.Color(FURN.crown);

/**
 * Crown shading: every FACET is flooded with one of three flat tones, picked from its own face normal and its height
 * in the mass. Nothing is interpolated across a facet and nothing ramps smoothly over the lobe.
 *
 * This replaces the smooth top-lit / dark-bellied gradients of round 8. A low-poly crown's whole read comes from its
 * facets, and a gradient wrapped over them hides exactly the edges that are supposed to be the shape — with a leaf
 * noise map on top the result was the "broccoli" three critics reported. Three flat bands (up-facing = top-lit,
 * sideways = the mass, down-facing = underside) plus leafSurface's per-facet value jitter make the same faceting read
 * as a deliberate choice: the tone steps land ON the facet edges, which is how Art of Rally / Sable foliage works.
 *
 * `lit` scales how far the top band goes toward crownLit (per-lobe variation), `darkSpan` how much of the mass at the
 * foot is pulled down a band.
 */
function shadeCrown(g: THREE.BufferGeometry, yLo: number, yHi: number, lit: number, darkSpan: number): void {
  const pos = g.attributes.position;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const span = Math.max(0.3, yHi - yLo);
  const base = crownBase;
  for (let t = 0; t + 2 < n; t += 3) {
    // True facet normal (the stored normals are canopy-blended, so they cannot give a crisp band edge).
    const ax = pos.getX(t), ay = pos.getY(t), az = pos.getZ(t);
    sU.set(pos.getX(t + 1) - ax, pos.getY(t + 1) - ay, pos.getZ(t + 1) - az);
    sV.set(pos.getX(t + 2) - ax, pos.getY(t + 2) - ay, pos.getZ(t + 2) - az);
    sU.cross(sV);
    const len = Math.max(1e-6, sU.length());
    const ny = sU.y / len;
    const cy = (ay + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    // Height of the facet in the mass, 0 at the foot: the bottom of a crown sits in its own shade whichever way it faces.
    const hRel = (cy - yLo) / span;
    let band = ny >= 0.34 ? 2 : ny <= -0.14 ? 0 : 1;
    if (band > 0 && hRel < 0.3 * Math.max(0.4, darkSpan / 1.7)) band--;
    base.setHex(CROWN_BANDS[band]);
    // The top band is only `lit` of the way to crownLit, so neighbouring lobes of one tree do not flood-fill identically.
    if (band === 2) base.lerpColors(crownMass, base, Math.max(0.35, Math.min(1, lit * 1.55)));
    for (let c = 0; c < 3; c++) { col[(t + c) * 3] = base.r; col[(t + c) * 3 + 1] = base.g; col[(t + c) * 3 + 2] = base.b; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/**
 * Broad sidewalk tree `seed`: a short tapered trunk that forks into two or three limbs, and a crown of 8-10 noisy
 * lobes (2-3 big masses at icosahedron detail 1, the rest small detail-0 balls scattered around and below them), plus
 * a fringe of crossed leaf cards hanging off the silhouette. 500-650 triangles; the seeds, the per-instance scale
 * (0.8-1.3) and the batch colour tint keep a street from repeating.
 */
function treeGeometry(seed: number): THREE.BufferGeometry {
  const rng = new Random(seed);
  const forkH = rng.range(1.9, 2.4), trunkH = forkH + rng.range(1.2, 1.7);
  const trunk = lathe([R(0, 0.3), R(0.14, 0.22), R(1.2, 0.17), R(forkH, 0.15)], 8, FURN.bark, false, false);
  barkRamp(trunk, 0.95, forkH);
  const parts: THREE.BufferGeometry[] = [trunk];
  // Fork: two or three limbs leaning out of the trunk top toward the big crown masses.
  const limbs = rng.int(2, 3), a0 = rng.range(0, Math.PI * 2);
  const limbTop: [number, number, number][] = [];
  for (let k = 0; k < limbs; k++) {
    const a = a0 + (k / limbs) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const lean = rng.range(0.45, 0.85), top = trunkH + rng.range(-0.15, 0.35);
    const tx = Math.cos(a) * lean, tz = Math.sin(a) * lean;
    const limb = lathe([R(forkH - 0.25, 0.13, tx * 0.1, tz * 0.1), R((forkH + top) / 2, 0.105, tx * 0.45, tz * 0.45), R(top, 0.075, tx, tz)], 6, FURN.bark);
    // The limbs are the part of the bark the sky actually reaches, so they carry the ramp's lit stop.
    blendTo(limb, FURN.barkLit, (_x, y) => Math.max(0, Math.min(1, (y - forkH) / Math.max(0.4, top - forkH))) * 0.7);
    parts.push(limb);
    limbTop.push([tx, tz, top]);
  }
  // Crown: one big mass over each limb, then small lobes filling and overhanging the gaps between them.
  const lobes: [number, number, number, number, 0 | 1][] = [];
  for (let k = 0; k < limbs; k++) {
    const [tx, tz, top] = limbTop[k];
    lobes.push([tx * 1.25, top + rng.range(0.5, 0.9), tz * 1.25, rng.range(1.15, 1.45), 1]);
  }
  // Two more small lobes than round 8, and a pair of them hung low and wide: they take over the job the crossed leaf
  // cards used to do (breaking the ball outline) without the cards' pathology — see the fringe note below.
  const small = rng.int(7, 9), b0 = rng.range(0, Math.PI * 2);
  for (let k = 0; k < small; k++) {
    const a = b0 + (k / small) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const low = k % 3 === 2;
    const d = low ? rng.range(1.5, 2.0) : rng.range(0.9, 1.75);
    const y = low ? trunkH + rng.range(-0.35, 0.35) : trunkH + rng.range(0.1, 1.35);
    lobes.push([Math.cos(a) * d, y, Math.sin(a) * d, low ? rng.range(0.5, 0.78) : rng.range(0.62, 0.98), 0]);
  }
  let yLo = Infinity, yHi = -Infinity;
  for (let i = 0; i < lobes.length; i++) { yLo = Math.min(yLo, lobes[i][1] - lobes[i][3]); yHi = Math.max(yHi, lobes[i][1] + lobes[i][3]); }
  for (let i = 0; i < lobes.length; i++) {
    const [ox, oy, oz, r, detail] = lobes[i];
    const g = crownLobe(r, detail, rng.range(0, 6.3), detail === 1 ? rng.range(0.13, 0.21) : rng.range(0.08, 0.14), rng.range(0.78, 0.92), 0.5);
    g.rotateY(rng.range(0, Math.PI));
    g.translate(ox, oy, oz);
    shadeCrown(g, yLo, yHi, 0.62 + rng.range(-0.06, 0.06), 1.7);
    parts.push(g);
  }
  // No leaf-card fringe. Round 8 hung 6-8 crossed rhombus cards on the silhouette; the occlusion pass forces their
  // normal to point straight up and out (anything else collapses the coincident pair to a black hole), so under this
  // rig a card takes far more sky than the lobe behind it and renders as a lighter, translucent-looking shard lying
  // OVER the crown — read by the last critic as damage, and by the one before as pale mint shards. A normal that
  // cannot be shaded like the mass cannot be part of the mass, so the cards are gone and two extra low lobes (which
  // shade with everything else) do the outline-breaking instead. Also 130 triangles a tree cheaper.
  // parts[0] is the trunk and parts[1..limbs] the fork limbs: bark, which the leaf map must not touch.
  for (let i = 0; i < parts.length; i++) leafMixAttr(parts[i], i <= limbs ? LEAF_MIX.bark : LEAF_MIX.crown);
  return fuse(parts);
}

/**
 * The second species: a tall narrow cypress, the vertical note a street of round crowns needs. A lathed spire whose
 * radius steps in and out from station to station, so the silhouette is tiered like a conifer's branch whorls instead
 * of a smooth cone, with per-angle wobble on top of that and a short bole under it. Face normals (a conifer is a mass
 * of needle shadow, not a balloon), a much darker green than the broad crowns, and a lit band only at the very top.
 * Twelve columns, not seven, and half the per-angle wobble: this species is a third of every sidewalk tree, and at
 * the 3 m a pavement is walked past at, seven facets around a deeply notched silhouette read as a folded green shard
 * rather than a tree. The spire is built as three overlapping tiers (see below). About 310 triangles, still the
 * cheapest prop in the foliage batch.
 */
function cypressGeometry(seed: number): THREE.BufferGeometry {
  const rng = new Random(seed);
  const H = rng.range(6.8, 8.6), maxR = rng.range(0.52, 0.66);
  const rows = 13, cols = 12;
  const bole = rng.range(0.6, 0.95);
  const lean = rng.range(-0.14, 0.14), leanZ = rng.range(-0.12, 0.12);
  const ripple = rng.range(0, Math.PI * 2);
  const rs = new Float32Array(rows), xs = new Float32Array(rows), zs = new Float32Array(rows);
  // Three tiers of branch whorls stacked up the spire, each with its own girth. A cypress is not one smooth cone: it
  // is a stack of overlapping skirts, widest where a tier starts and drawn in under the one above. The step at a tier
  // boundary (widest foot right above the narrowest top) is the overlap, and it is what gives the silhouette its
  // shoulders — the old single envelope with a sine ripple read as a folded green shard at 3 m.
  const TIERS = 3;
  const tierK = new Float32Array(TIERS);
  for (let k = 0; k < TIERS; k++) tierK[k] = rng.range(0.93, 1.07);
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    // Envelope: columnar, full width from a fifth of the way up to three quarters, then drawn in to the tip — an
    // Italian cypress is a spire, not a cone.
    const env = maxR * Math.pow(Math.min(1, Math.sin(Math.PI * (0.30 + 0.70 * t))), 0.4);
    const tf = Math.min(TIERS - 1e-4, t * TIERS);
    const tier = Math.floor(tf), within = tf - tier;
    // Full at the tier's foot, pinched to 0.82 under the next one, plus the old fine ripple on top of that.
    const skirt = (1 - 0.18 * within) * tierK[tier];
    rs[i] = env * skirt * (1 - 0.08 * (0.5 + 0.5 * Math.sin(i * 2.4 + ripple))) * rng.range(0.94, 1.06);
    xs[i] = lean * t * t * H * 0.3;
    zs[i] = leanZ * t * t * H * 0.3;
  }
  rs[rows - 1] = 0.03;
  const body = surface(rows, cols, true, false, (i, j, out) => {
    const a = (j / cols) * Math.PI * 2;
    const w = 1 + 0.10 * Math.sin(a * 3 + i * 2.1) + 0.05 * Math.sin(a * 5 - i * 1.3);
    out.set(xs[i] + Math.sin(a) * rs[i] * w, bole + (H - bole) * (i / (rows - 1)), zs[i] + Math.cos(a) * rs[i] * w);
  });
  body.computeVertexNormals(); // non-indexed: one normal per face, so every whorl facet catches its own light
  paint(body, FURN.conifer);
  blendTo(body, FURN.coniferLit, (_x, y) => Math.max(0, Math.min(1, (y - bole - (H - bole) * 0.55) / ((H - bole) * 0.45))) * 0.55);
  blendTo(body, FURN.coniferDark, (_x, y) => Math.max(0, Math.min(1, 1 - (y - bole) / ((H - bole) * 0.45))) * 0.8);
  const nrm = body.attributes.normal, col = body.attributes.color;
  scratchColor.setHex(FURN.coniferDark);
  for (let i = 0; i < nrm.count; i++) {
    const t = Math.max(0, Math.min(1, (-nrm.getY(i) - 0.02) / 0.5)) * 0.6;
    if (t <= 0) continue;
    col.setXYZ(i, col.getX(i) + (scratchColor.r - col.getX(i)) * t, col.getY(i) + (scratchColor.g - col.getY(i)) * t, col.getZ(i) + (scratchColor.b - col.getZ(i)) * t);
  }
  const trunk = lathe([R(0, 0.2), R(0.1, 0.16), R(bole + 0.3, 0.12)], 6, FURN.bark);
  barkRamp(trunk, 0.7, bole + 0.3);
  return fuse([leafMixAttr(body, LEAF_MIX.crown), leafMixAttr(trunk, LEAF_MIX.bark)]);
}

/** Hedge profile, ground to ground over the clipped top: (u across in half-depths, v up in heights). */
const HEDGE_PROFILE: readonly (readonly [number, number])[] = [[-1, 0], [-1.03, 0.5], [-0.94, 0.82], [-0.58, 0.97], [0, 1.03], [0.58, 0.97], [0.94, 0.82], [1.03, 0.5], [1, 0]];
/** Stations along a hedge unit; the unit runs a little over CityLots' pitch so consecutive units overlap into one run. */
const HEDGE_STATIONS = 9;
const HEDGE_OVERLAP = 1.08;

/** Flat cap closing a hedge end: a fan from the ground centre over the profile points, normal along `dir` z. */
function capFan(xy: Float32Array, n: number, z: number, dir: 1 | -1): THREE.BufferGeometry {
  const tris = n - 1;
  const pos = new Float32Array(tris * 9), nrm = new Float32Array(tris * 9);
  for (let j = 0; j < tris; j++) {
    const a = dir > 0 ? j + 1 : j, b = dir > 0 ? j : j + 1;
    const o = j * 9;
    pos[o] = 0; pos[o + 1] = 0; pos[o + 2] = z;
    pos[o + 3] = xy[a * 2]; pos[o + 4] = xy[a * 2 + 1]; pos[o + 5] = z;
    pos[o + 6] = xy[b * 2]; pos[o + 7] = xy[b * 2 + 1]; pos[o + 8] = z;
    for (let k = 0; k < 3; k++) { nrm[o + k * 3] = 0; nrm[o + k * 3 + 1] = 0; nrm[o + k * 3 + 2] = dir; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

/**
 * Hedge unit `seed`: a clipped block lofted along z through HEDGE_STATIONS cross-sections (a rounded-top profile whose
 * height, depth and lean wobble per station, with extra noise on the top points), closed by flat end caps. Face
 * normals are baked, so the top reads as lumpy clipped facets; the foot is shaded, the top lit. The unit is a little
 * longer than the placement pitch and its sides never sit on the same plane twice, so a row of overlapping units
 * reads as one continuous hedge instead of a row of sausages. Colour and scale vary per instance (batch colour).
 */
function hedgeGeometry(seed: number): THREE.BufferGeometry {
  const rng = new Random(seed);
  const n = HEDGE_STATIONS, m = HEDGE_PROFILE.length;
  const len = HEDGE.pitch * HEDGE_OVERLAP, hd = HEDGE.depth / 2, h = HEDGE.h;
  const hs = new Float32Array(n), ws = new Float32Array(n), ls = new Float32Array(n), noise = new Float32Array(n * m);
  // One or two stations are clipped noticeably shorter than the rest, so the top line dips instead of running level:
  // a clipped hedge that has been cut by hand, not a sausage extruded along the kerb.
  const dipA = rng.int(0, n - 2), dipB = rng.chance(0.55) ? rng.int(0, n - 2) : -2;
  for (let i = 0; i < n; i++) {
    // The dip spans two neighbouring stations, so the top line sags into it instead of cutting a single sharp notch.
    const dip = i === dipA || i === dipB || i === dipA + 1 || i === dipB + 1 ? rng.range(0.84, 0.93) : 1;
    // Shear notch: every third station is clipped 4-8 cm lower than its neighbours. The wobble above is smooth enough
    // that the top still read as one extruded tube from the pavement; a regular short-long-long rhythm gives the run
    // the saw-tooth a hedge trimmer actually leaves.
    const notch = i % 3 === 2 ? rng.range(0.04, 0.08) : 0;
    hs[i] = h * rng.range(0.88, 1.1) * dip - notch; ws[i] = hd * rng.range(0.88, 1.12); ls[i] = rng.range(-0.06, 0.06);
    for (let j = 0; j < m; j++) noise[i * m + j] = HEDGE_PROFILE[j][1] > 0.6 ? rng.range(-0.07, 0.07) : 0;
  }
  const xy = new Float32Array(m * 2);
  const at = (i: number, j: number): void => {
    const u = HEDGE_PROFILE[j][0], v = HEDGE_PROFILE[j][1];
    xy[0] = u * ws[i] + ls[i] * v;
    xy[1] = v * hs[i] + noise[i * m + j];
  };
  const side = surface(n, m, false, true, (i, j, out) => {
    at(i, j);
    out.set(xy[0], xy[1], -len / 2 + (len * i) / (n - 1));
  });
  side.computeVertexNormals(); // non-indexed: one normal per face
  const endXY = new Float32Array(m * 2);
  const cap = (i: number, dir: 1 | -1): THREE.BufferGeometry => {
    for (let j = 0; j < m; j++) { at(i, j); endXY[j * 2] = xy[0]; endXY[j * 2 + 1] = xy[1]; }
    return capFan(endXY, m, dir * len / 2, dir);
  };
  const g = fuse([side, cap(0, -1), cap(n - 1, 1)]);
  paint(g, FURN.hedge);
  blendTo(g, FURN.hedgeLit, (_x, y) => Math.max(0, Math.min(1, (y - h * 0.4) / (h * 0.55))) * 0.85);
  // Bottom third: the deep shade inside a hedge. Squared, so the fall-off is concentrated in the last 30 % instead of
  // washing halfway up the face — an evenly shaded green box is exactly what reads as untextured plastic.
  blendTo(g, FURN.hedgeDark, (_x, y) => { const t = Math.max(0, Math.min(1, 1 - y / (h * 0.3))); return t * t * 0.95; });
  // Foot: the last 15 cm goes to bare shaded earth, so the run sits in the ground instead of floating on the pavement.
  blendTo(g, FURN.soil, (_x, y) => Math.max(0, Math.min(1, 1 - y / 0.15)) * 0.7);
  // A little per-vertex dapple so a long run does not read as one flat green.
  const col = g.attributes.color;
  for (let i = 0; i < col.count; i++) { const d = rng.range(0.95, 1.05); col.setXYZ(i, col.getX(i) * d, col.getY(i) * d, col.getZ(i) * d); }
  return leafMixAttr(g, LEAF_MIX.hedge);
}

/**
 * Far palm (beyond PROP_RANGE.palmNear): a six-sided trunk leaning to the seeded trunk's top, bark baked as a vertex
 * colour, and a crown of ten opaque two-tone fans (three rows, V section, back faces darker) with the same canopy
 * normals as the near fronds, on the foliage material. No alpha, so nothing lets the sky through at distance; about a
 * third of the near palm's triangles, and it shades (and darkens after dark) like the near LOD.
 */
function farPalmGeometry(seed: number): THREE.BufferGeometry {
  const rng = new Random(seed + 13);
  const full = trunkGeometry(seed);
  const topX = full.userData.topX as number, topY = full.userData.topY as number;
  full.dispose();
  // Six-sided trunk on three rings (base, mid, crown) leaning to the same top as the near trunk: ~40 triangles.
  const trunk = lathe([R(0, 0.27), R(topY * 0.5, 0.2, topX * 0.3), R(topY - 0.3, 0.16, topX), R(topY + 0.25, 0.3, topX)], 6, FURN.palmBarkFar, true);
  const parts: THREE.BufferGeometry[] = [trunk];
  const L = PROP_DIMS.palmFrondLen, W = PROP_DIMS.palmFrondW;
  const n = 10;
  for (let i = 0; i < n; i++) {
    const inner = i % 2 === 0;
    const pitch = inner ? rng.range(0.3, 0.6) : rng.range(0.8, 1.15);
    const bend = inner ? rng.range(0.9, 1.2) : rng.range(1.1, 1.45);
    const g = frondGeometry(L * rng.range(0.85, 1.05), W * 0.8, pitch, (i / n) * Math.PI * 2 + rng.range(-0.15, 0.15), bend, 0.22, 0.12, 3, 2);
    canopyNormals(g, -30, 1);
    g.translate(topX, topY + (inner ? 0.1 : -0.05), 0);
    paint(g, FURN.frondFar);
    blendTo(g, FURN.frondFarTip, () => rng.range(0.15, 0.55));
    const both = withBackFaces(g, 0.62);
    g.dispose();
    parts.push(bare(both));
  }
  // parts[0] is the bark trunk; everything after it is a frond.
  for (let i = 0; i < parts.length; i++) leafMixAttr(parts[i], i === 0 ? LEAF_MIX.bark : LEAF_MIX.frond);
  return fuse(parts);
}

/**
 * Lamp glow: one small additive disc on the pavement under the head, and nothing else. The lamps close to the camera
 * carry real point lights (LAMP_LIGHTS) that the asphalt's normal and roughness answer, so this quad is only the
 * stand-in for every lamp beyond them: at 5.5 m radius it reads as the hot core right under the luminaire instead of
 * the 18 m sepia ellipse that used to flatten the lane paint out of the road. The vertical facade-spill quad is gone
 * — from any angle but head-on it was a translucent slab standing in mid-air beside the pole.
 */
function glowGeometry(): THREE.BufferGeometry {
  const pool = new THREE.PlaneGeometry(PROP_DIMS.poolRadius * 2, PROP_DIMS.poolRadius * 2);
  pool.rotateX(-Math.PI / 2);
  pool.translate(0, 0.06, PROP_DIMS.lampArm - 0.3);
  return tintRGB(pool, 1, 1, 1);
}

/**
 * Draw radius per prop kind: past this the prop is a couple of pixels, so it is left out of the draw list.
 * Parked shells and lot furniture stop at 120 m: beyond that a lot interior is hidden behind its own street wall;
 * kerbside cars sit in plain view down a street and go further. Palms switch from the alpha fronds to the solid far
 * LOD at `palmNear`.
 */
export const PROP_RANGE = {
  palm: 165, palmNear: 60, tree: 110, hedge: 95, lamp: 240, bench: 170, hydrant: 140, bin: 130, sign: 175,
  shelter: 210, bollard: 120, parked: 120, kerb: 135, island: 120, planter: 110,
  pole: 125, roadsign: 105, dumpster: 78, table: 78, repackMove: 15,
} as const;

/**
 * Fidelity ladder of the static parked cars. Three tiers, because one hand-over could not pay for itself: the full
 * body loft is ~3.5k triangles and casts shadows, so widening ITS band to the 30 m a parked car is still readable at
 * would cost the whole dusk triangle budget, while the coarse shell (~530 triangles, no arch cut, no pillars, no
 * lamps) is what the eye catches out at anything closer.
 *
 * - `near` (<= 8 m, 3 of them): the player's own body loft, `parkedNearGeometry`. Three, not more: at ~3.5k
 * triangles each (and again in the shadow pass) a fourth costs more than the whole mid band, and the fourth-nearest
 * car inside 8 m falls back to the mid shell, which is exactly what the mid tier exists to make unremarkable.
 * - `mid` (<= 32 m, 16 of them): `parkedMidGeometry`, ~900-1000 triangles — the coarse silhouette plus arch fenders,
 *   greenhouse pillars, lamp cells and 12-sided shouldered tyres with an alloy face. This is the tier the street
 *   actually renders at: at 8-32 m a kerbside car fills a good part of the frame.
 * - far: the coarse shell for everything else out to PROP_RANGE.parked / .kerb.
 *
 * Both capped bands are BatchedMesh instances whose geometry, matrix and paint are reassigned on the repack, so the
 * whole ladder is two draw calls (+ their shadow pass) no matter how many cars are in range.
 */
const NEAR_CARS = { range: 8, cap: 3 } as const;
const MID_CARS = { range: 32, cap: 16 } as const;
/**
 * How far the camera may travel before the two capped car bands are re-picked. Their own cadence, NOT the generic
 * `PROP_RANGE.repackMove` of 15 m: the near band is 8 m wide, so on the generic cadence a car written into the mid
 * batch while it was 12 m away stayed the mid shell all the way to touching distance, and `parkedNearGeometry` could
 * never be seen doing its job. At 1.5 m every car closer than range - 1.5 m is guaranteed to be in its band, and the
 * pick is allocation-free over at most `cap` instances (like `aimLampLights`, which runs per frame for this reason).
 */
const CAR_TIER_MOVE = 1.5;

/**
 * Contact shadows for the static parked cars: the `cap` nearest of them get a blob in the shared ContactShadows field
 * (the same instanced quad the vehicles, the crowd and the player write into, so this costs no extra draw call).
 *
 * They had none. A moving Vehicle gets one every frame; a parked prop is not a Vehicle, so past the distance where its
 * own sun shadow is a couple of shadow-map texels — and at night, where the moon shadow is almost nothing — a kerbside
 * car sat on the pavement with no darkening under it at all and floated. They are re-picked on the car tier's own
 * 1.5 m cadence.
 *
 * `cap` is sized so it CANNOT bind: the densest 46 m neighbourhood in the generated city (a lot at 405, 542) holds 40
 * parked cars, and 241 of the 2115 cars stand in a neighbourhood of more than 24. With the old cap of 24 the pick was
 * a rank cut, so which cars were grounded changed every 1.5 m of camera motion — in a lot, where a whole row stands
 * at the same distance, neighbouring bays at 15 m had some cars grounded and some floating, which is the exact
 * artefact the blobs exist to remove. At 44 the cut is the range alone, so the set only changes at 46 m, where a blob
 * is a few pixels. The cost is instance slots in one shared mesh (SHADOW_TUNING.capacity), not a draw call.
 *
 * Half-extents follow the vehicle profiles' own (hw * 1.55, hl * 1.14): a blob a little wider than the track and a
 * little shorter than the body.
 */
const CAR_SHADOWS = { cap: 44, range: 46, w: 1.55, l: 1.14, lift: 0.045 } as const;

/**
 * Real lamp light: a fixed pool of point lights created once and re-aimed at the nearest lamp heads every frame, so
 * the asphalt's normal map and its damp night roughness actually answer the street lighting (and the lane paint stays
 * legible inside the pool). Physical units like the player's headlights: decay 2, ~60 cd, which lands at roughly the
 * same illuminance 6.5 m under the luminaire as a headlight pool 8 m ahead of the car.
 *
 * The pool is DELIBERATELY small. The lights never leave the scene (see update()), so every lit material in the city
 * carries NUM_POINT_LIGHTS of them in its shader at every hour — a noon frame pays for them too, at zero intensity.
 * Three cover the one or two lamps that are ever close enough to matter; a bigger pool is per-pixel ALU all day for
 * lamps whose contribution is already under the `distance` cutoff. `fade` is the fraction of `distance` over which a
 * light ramps out, so a lamp handed over to the next one never changes a pixel in a single frame.
 */
const LAMP_LIGHTS = { count: 3, intensity: 140, distance: 30, colour: 0xffc48a, y: 6.4, fade: 0.35 } as const;

/** Seeds of the two palm variants; palms alternate between them by index. */
const PALM_SEEDS = [1201, 2417] as const;
/** Seeds of the broad tree variants, the tall cypress variants and the hedge units; instances pick one (seeded). */
const TREE_SEEDS = [4111, 5237, 6301] as const;
const CYPRESS_SEEDS = [8117, 8231] as const;
/** Share of the sidewalk trees drawn as the tall narrow species. */
const CYPRESS_SHARE = 0.3;
const HEDGE_SEEDS = [7013, 7121, 7307, 7411] as const;

/** Night opacity of the small additive pavement pool under a lamp head. */
const GLOW_OPACITY = 0.3;

const PARKED_SPECS: ParkedSpec[] = ['sedan', 'sport', 'van'];

/** Floats per placement in PropGroup.data: x, z, yaw, scale, y (the ground height the instance stands on). */
const STRIDE = 5;

/** One BatchedMesh and the geometry ids of the parts it was built from (in the order they were given). */
interface Batch { mesh: THREE.BatchedMesh; geo: number[] }

/** Instances of one group inside one batch: the batch instance id of every placement. */
interface BatchTarget { mesh: THREE.BatchedMesh; ids: Int32Array }

interface PropGroup {
  /** Source placements, STRIDE floats each (never mutated). */
  data: Float32Array;
  count: number;
  range2: number;
  /** Batched instances toggled visible while in range. */
  batched: BatchTarget[];
  /** LOD split: placements closer than `nearRange2` show `near`, the rest of the in-range ones `far`. */
  nearRange2: number;
  near: BatchTarget[];
  far: BatchTarget[];
  /** Instanced meshes every in-range placement is written to at the mesh's cursor (`count`). */
  inst: THREE.InstancedMesh[];
}

/** Composes the placement matrix into `mat`. */
function placementMatrix(x: number, z: number, yaw: number, scale: number, y: number): THREE.Matrix4 {
  dummy.position.set(x, y, z);
  dummy.rotation.set(0, yaw, 0);
  dummy.scale.set(scale, scale, scale);
  dummy.updateMatrix();
  return mat.copy(dummy.matrix);
}

/**
 * Catenary spans between neighbouring utility poles. Poles are placed in runs along one block edge, so two of them are
 * neighbours when they share a yaw and the coordinate perpendicular to the run and stand `WIRE.minSpan`..`maxSpan`
 * apart with nothing between them; the runs stop short of the corners, so no span ever crosses an intersection. Each
 * span carries `WIRE.lines` wires hanging from the crossarm insulators, sagging `sag` at mid-span, drawn as
 * `WIRE.segments` line segments. Returns the packed segment endpoints (6 floats a segment) plus the span midpoints,
 * which the range packer uses to draw only the spans near the camera.
 */
const WIRE = { minSpan: 12, maxSpan: 42, lines: 3, segments: 6, sag: 0.55, inRange: 118 } as const;
const WIRE_FLOATS_PER_SPAN = WIRE.lines * WIRE.segments * 6;

interface WireSpans { data: Float32Array; midX: Float32Array; midZ: Float32Array; count: number }

function buildWireSpans(props: Prop[]): WireSpans {
  const poles: Prop[] = [];
  for (let i = 0; i < props.length; i++) if (props[i].kind === 'pole') poles.push(props[i]);
  // Sort into runs: yaw, then the coordinate across the run, then along it.
  const alongX = (yaw: number): boolean => Math.abs(Math.sin(yaw)) < 0.5; // local +Z along z => the run walks x
  poles.sort((a, b) => (a.yaw - b.yaw) || ((alongX(a.yaw) ? a.z - b.z : a.x - b.x) || (alongX(a.yaw) ? a.x - b.x : a.z - b.z)));
  const maxSpans = Math.max(1, poles.length);
  const data = new Float32Array(maxSpans * WIRE_FLOATS_PER_SPAN);
  const midX = new Float32Array(maxSpans), midZ = new Float32Array(maxSpans);
  let n = 0;
  for (let i = 0; i + 1 < poles.length; i++) {
    const a = poles[i], b = poles[i + 1];
    if (Math.abs(a.yaw - b.yaw) > 1e-3) continue;
    const ax = alongX(a.yaw);
    if (Math.abs((ax ? a.z - b.z : a.x - b.x)) > 0.05) continue;
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    if (d < WIRE.minSpan || d > WIRE.maxSpan) continue;
    // Insulator offsets run across the street: the crossarm is authored along local x.
    const cx = Math.cos(a.yaw), sx = Math.sin(a.yaw);
    let o = n * WIRE_FLOATS_PER_SPAN;
    for (let w = 0; w < WIRE.lines; w++) {
      const k = (w - (WIRE.lines - 1) / 2) * UTILITY.armHalf;
      const ox = cx * k, oz = -sx * k; // local +x of a yaw rotation about y
      const ya = CURB_H + UTILITY.armY * a.scale - UTILITY.wireDrop, yb = CURB_H + UTILITY.armY * b.scale - UTILITY.wireDrop;
      for (let sgm = 0; sgm < WIRE.segments; sgm++) {
        for (let e = 0; e < 2; e++) {
          const t = (sgm + e) / WIRE.segments;
          const sag = WIRE.sag * 4 * t * (1 - t);
          data[o++] = a.x + (b.x - a.x) * t + ox;
          data[o++] = ya + (yb - ya) * t - sag;
          data[o++] = a.z + (b.z - a.z) * t + oz;
        }
      }
    }
    midX[n] = (a.x + b.x) / 2;
    midZ[n] = (a.z + b.z) / 2;
    n++;
  }
  return { data, midX, midZ, count: n };
}

/**
 * Foliage tint per instance: value +-8 % and a hue lean of up to `hue` between yellow-green (warm) and blue-green,
 * multiplied into the baked vertex colours through the batch colour.
 */
function foliageTint(rng: Random, hue: number, out: THREE.Color): THREE.Color {
  const v = rng.range(0.92, 1.08), h = rng.range(-1, 1) * hue;
  return out.setRGB(v * (1 + 0.16 * h), v * (1 - 0.02 * Math.abs(h)), v * (1 - 0.18 * h));
}

/**
 * Builds and adds the prop meshes: six BatchedMeshes (furniture, foliage, the three parked-car tiers, palm trunks and
 * palm fronds) and four InstancedMeshes (lamp pole / head / glow, shelter glass), 10 draws in all.
 *
 * The city holds ~1300 lamps, ~500 palms and a few thousand cars, trees and hedges — drawing them all costs hundreds
 * of thousands of triangles per frame even when they are half a kilometre behind the camera. Instead the source
 * placements are kept on the CPU and only the ones inside PROP_RANGE are drawn, re-evaluated whenever the camera has
 * moved `repackMove` metres: batched instances are added once (matrix, geometry, colour) and toggled with
 * setVisibleAt, instanced meshes are refilled from the in-range placements. Draw calls stay fixed; the triangle
 * count drops by roughly 6x, and the batches' own per-instance frustum test trims the colour and shadow passes further.
 */
export class PropRenderer {
  private readonly meshes: THREE.Object3D[] = [];
  private readonly instanced: THREE.InstancedMesh[] = [];
  private readonly batches: THREE.BatchedMesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly groups: PropGroup[] = [];
  private readonly materials: Materials;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly paintMat: THREE.MeshPhysicalMaterial;
  /** Lamp placements (x, z, yaw) and the point lights parked on the nearest few of them. */
  private lampX = new Float32Array(0);
  private lampZ = new Float32Array(0);
  private lampYaw = new Float32Array(0);
  private lampCount = 0;
  private readonly lampLights: THREE.PointLight[] = [];
  private lampGlowMesh: THREE.InstancedMesh | null = null;
  private wireMat: THREE.LineBasicMaterial | null = null;
  /** Near parked cars: source placements, their coarse-shell instance ids, and the capped near batch. */
  private carX = new Float32Array(0);
  private carZ = new Float32Array(0);
  private carYaw = new Float32Array(0);
  private carY = new Float32Array(0);
  private carColour = new Int32Array(0);
  private carGeo = new Int32Array(0);
  private carCoarse = new Int32Array(0);
  private carCount = 0;
  private readonly carShadows: ContactShadows;
  private nearMesh: THREE.BatchedMesh | null = null;
  private midMesh: THREE.BatchedMesh | null = null;
  private coarseMesh: THREE.BatchedMesh | null = null;
  private readonly nearGeo: number[] = [];
  private readonly midGeo: number[] = [];
  /** Car indices handed to the near tier this repack, so the mid tier skips them. */
  private readonly nearPicked = new Int32Array(NEAR_CARS.cap);
  private nearPickedN = 0;
  /** Mid-band picks, kept so their coarse shells can be handed back when the band is re-picked. */
  private readonly midPicked = new Int32Array(MID_CARS.cap);
  private midPickedN = 0;
  private tierX = Infinity;
  private tierZ = Infinity;
  private static readonly PICK_CAP = Math.max(NEAR_CARS.cap, MID_CARS.cap, LAMP_LIGHTS.count, CAR_SHADOWS.cap);
  private readonly pickIdx = new Int32Array(PropRenderer.PICK_CAP);
  private readonly pickD2 = new Float32Array(PropRenderer.PICK_CAP);
  /** Catenary wire spans and the line mesh they are packed into by range. */
  private spans: WireSpans | null = null;
  private wireMesh: THREE.LineSegments | null = null;
  private wirePos: THREE.BufferAttribute | null = null;
  private lastX = Infinity;
  private lastZ = Infinity;

  constructor(scene: THREE.Scene, props: Prop[], materials: Materials, parked: ParkedCar[] = [], lotProps: LotProp[] = []) {
    this.materials = materials;
    this.carShadows = new ContactShadows(scene, CAR_SHADOWS.cap);
    const counts: Record<Prop['kind'], number> = { palm: 0, lamp: 0, bench: 0, hydrant: 0, bin: 0, sign: 0, shelter: 0, bollard: 0, tree: 0, hedge: 0, pole: 0, roadsign: 0, dumpster: 0, table: 0 };
    for (let i = 0; i < props.length; i++) counts[props[i].kind]++;
    const lotCounts: Record<LotProp['kind'], number> = { island: 0, planter: 0, booth: 0 };
    for (let i = 0; i < lotProps.length; i++) lotCounts[lotProps[i].kind]++;
    // The pavement pool shares the glow sprite and tint of Materials' lightPool; its night opacity is synced in update().
    const poolSrc = materials.lightPool();
    this.glowMat = new THREE.MeshBasicMaterial({ map: poolSrc.map, color: poolSrc.color, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
    this.paintMat = makeVehiclePaintMaterial();
    for (let i = 0; i < LAMP_LIGHTS.count; i++) {
      const l = new THREE.PointLight(LAMP_LIGHTS.colour, 0, LAMP_LIGHTS.distance, 2);
      l.castShadow = false;
      scene.add(l);
      this.lampLights.push(l);
    }
    // Seeded per-instance variety (variant pick, tint) in placement order, so a given city always looks the same.
    const rng = new Random(0x9e37);

    // --- batches: one per material -------------------------------------------------------------------------------
    const furnitureCount = counts.bench + counts.hydrant + counts.bin + counts.sign + counts.shelter + counts.bollard
      + counts.pole + counts.roadsign + counts.dumpster + counts.table + lotCounts.island + lotCounts.planter;
    const furniture = this.batch(scene, 'furniture', [
      benchGeometry(), hydrantGeometry(), binGeometry(), signGeometry(), shelterGeometry(), bollardGeometry(), islandGeometry(), planterGeometry(),
      utilityPoleGeometry(), roadSignGeometry(), dumpsterGeometry(), cafeTableGeometry(),
    ], materials.furniture, furnitureCount, true);
    const FG = { bench: 0, hydrant: 1, bin: 2, sign: 3, shelter: 4, bollard: 5, island: 6, planter: 7, pole: 8, roadsign: 9, dumpster: 10, table: 11 } as const;
    // Every part of the foliage batch goes through leafSurface: the leaf albedo's UVs (the material carries the map),
    // the per-facet value jitter and the `leafMix` mask that keeps the map and the translucency emissive off the bark
    // these geometries also carry (trunks, limbs, boles - see leafMixAttr). The batch's attribute set comes from the
    // first geometry, so this has to be all of them or none.
    const foliageGeos = [leafSurface(farPalmGeometry(PALM_SEEDS[0]), PALM_SEEDS[0], 0.04)];
    for (let i = 0; i < TREE_SEEDS.length; i++) foliageGeos.push(leafSurface(treeGeometry(TREE_SEEDS[i]), TREE_SEEDS[i]));
    for (let i = 0; i < CYPRESS_SEEDS.length; i++) foliageGeos.push(leafSurface(cypressGeometry(CYPRESS_SEEDS[i]), CYPRESS_SEEDS[i]));
    for (let i = 0; i < HEDGE_SEEDS.length; i++) foliageGeos.push(leafSurface(hedgeGeometry(HEDGE_SEEDS[i]), HEDGE_SEEDS[i]));
    // Far palms cast nothing on their own (past 60 m they never enter the shadow box); sharing the batch with the
    // trees and hedges means the odd one at the box corner does, which is harmless.
    const foliage = this.batch(scene, 'foliage', foliageGeos, materials.foliage, counts.palm + counts.tree + counts.hedge, true);
    const FOL_FAR_PALM = 0, FOL_TREE = 1, FOL_CYPRESS = 1 + TREE_SEEDS.length, FOL_HEDGE = FOL_CYPRESS + CYPRESS_SEEDS.length;
    const trunkGeos: THREE.BufferGeometry[] = [], frondGeos: THREE.BufferGeometry[] = [];
    for (let v = 0; v < PALM_SEEDS.length; v++) {
      const trunk = trunkGeometry(PALM_SEEDS[v]);
      frondGeos.push(frondsGeometry(trunk.userData.topX as number, trunk.userData.topY as number, PALM_SEEDS[v] + 7));
      trunkGeos.push(trunk);
    }
    const trunks = this.batch(scene, 'palmTrunk', trunkGeos, materials.palmTrunk, counts.palm, true);
    const fronds = this.batch(scene, 'palmFronds', frondGeos, materials.palmFrond, counts.palm, true);
    // Parked shells: one batch for the three specs on the vehicle paint material; the batch colour tints the paint regions.
    const shells: THREE.BufferGeometry[] = [];
    for (let i = 0; i < PARKED_SPECS.length; i++) shells.push(parkedShellGeometry(SPECS[PARKED_SPECS[i]]));
    const parkedB = this.batch(scene, 'parked', shells, this.paintMat, parked.length, true);
    parkedB.mesh.receiveShadow = true;
    // Mid and near shells: the same three specs at the mid and full body lofts, in batches that only ever hold
    // MID_CARS.cap / NEAR_CARS.cap instances — repack reassigns their geometry, matrix and paint to whichever cars
    // are closest, so the two extra fidelities cost two draw calls rather than one per car.
    const midShells: THREE.BufferGeometry[] = [];
    for (let i = 0; i < PARKED_SPECS.length; i++) midShells.push(parkedMidGeometry(SPECS[PARKED_SPECS[i]]));
    const midB = this.batch(scene, 'parkedMid', midShells, this.paintMat, MID_CARS.cap, true);
    midB.mesh.receiveShadow = true;
    this.midMesh = midB.mesh;
    for (let i = 0; i < midB.geo.length; i++) this.midGeo.push(midB.geo[i]);
    for (let i = 0; i < MID_CARS.cap; i++) midB.mesh.setVisibleAt(midB.mesh.addInstance(midB.geo[0]), false);
    const nearShells: THREE.BufferGeometry[] = [];
    for (let i = 0; i < PARKED_SPECS.length; i++) nearShells.push(parkedNearGeometry(SPECS[PARKED_SPECS[i]]));
    const nearB = this.batch(scene, 'parkedNear', nearShells, this.paintMat, NEAR_CARS.cap, true);
    nearB.mesh.receiveShadow = true;
    this.nearMesh = nearB.mesh;
    this.coarseMesh = parkedB.mesh;
    for (let i = 0; i < nearB.geo.length; i++) this.nearGeo.push(nearB.geo[i]);
    for (let i = 0; i < NEAR_CARS.cap; i++) {
      const id = nearB.mesh.addInstance(nearB.geo[0]);
      nearB.mesh.setVisibleAt(id, false);
    }
    // Overhead wires: one LineSegments refilled by range, so a suburb street gets its catenaries without a draw call
    // per span and without a web of them stretching to the far side of the city.
    this.spans = buildWireSpans(props);
    if (this.spans.count > 0) {
      const cap = Math.min(this.spans.count, 140) * WIRE_FLOATS_PER_SPAN / 3;
      const wireGeo = new THREE.BufferGeometry();
      this.wirePos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
      this.wirePos.setUsage(THREE.DynamicDrawUsage);
      wireGeo.setAttribute('position', this.wirePos);
      wireGeo.setDrawRange(0, 0);
      const wireMat = new THREE.LineBasicMaterial({ color: 0x23262b, fog: true, transparent: true, opacity: 0.85, depthWrite: false });
      this.wireMesh = new THREE.LineSegments(wireGeo, wireMat);
      this.wireMesh.name = 'prop:wires';
      this.wireMesh.frustumCulled = false;
      this.geometries.push(wireGeo);
      this.wireMat = wireMat;
      this.meshes.push(this.wireMesh);
      scene.add(this.wireMesh);
    }

    // --- instanced meshes: the lamp parts (three materials) and the shelter glass -------------------------------
    const mk = (name: string, g: THREE.BufferGeometry, m: THREE.Material, n: number, shadow: boolean): THREE.InstancedMesh => {
      const im = new THREE.InstancedMesh(g, m, Math.max(1, n));
      im.name = 'prop:' + name;
      im.count = 0;
      im.castShadow = shadow;
      im.receiveShadow = false;
      // Instanced meshes cannot be culled per instance, and their bounds span the whole city: pack by distance instead.
      im.frustumCulled = false;
      this.geometries.push(g);
      this.instanced.push(im);
      this.meshes.push(im);
      scene.add(im);
      return im;
    };
    const poleM = mk('lampPole', poleGeometry(), materials.lampPole, counts.lamp, true);
    const headM = mk('lampHead', headGeometry(), materials.lampHead(), counts.lamp, false);
    const glowM = mk('lampGlow', glowGeometry(), this.glowMat, counts.lamp, false);
    glowM.renderOrder = 2;
    const shelterGlassM = mk('shelterGlass', shelterGlassGeometry(), materials.glass(), counts.shelter, false);

    // --- groups ------------------------------------------------------------------------------------------------
    const target = (b: Batch, n: number): BatchTarget => ({ mesh: b.mesh, ids: new Int32Array(Math.max(1, n)).fill(-1) });
    const add = (b: Batch, geo: number, x: number, z: number, yaw: number, scale: number, y: number, tint: THREE.Color | null): number => {
      const id = b.mesh.addInstance(geo);
      b.mesh.setMatrixAt(id, placementMatrix(x, z, yaw, scale, y));
      if (tint) b.mesh.setColorAt(id, tint);
      return id;
    };
    const newGroup = (n: number, range: number, nearRange = 0): PropGroup => {
      const g: PropGroup = { data: new Float32Array(Math.max(1, n) * STRIDE), count: 0, range2: range * range, batched: [], nearRange2: nearRange * nearRange, near: [], far: [], inst: [] };
      this.groups.push(g);
      return g;
    };
    const push = (g: PropGroup, x: number, z: number, yaw: number, scale: number, y: number): number => {
      const o = g.count * STRIDE;
      g.data[o] = x; g.data[o + 1] = z; g.data[o + 2] = yaw; g.data[o + 3] = scale; g.data[o + 4] = y;
      return g.count++;
    };
    // Palms: near = seeded trunk + alpha fronds (variant by index), far = the solid foliage LOD.
    const palmG = newGroup(counts.palm, PROP_RANGE.palm, PROP_RANGE.palmNear);
    palmG.near.push(target(trunks, counts.palm), target(fronds, counts.palm));
    palmG.far.push(target(foliage, counts.palm));
    // Trees and hedges: a seeded variant and tint per instance.
    const treeG = newGroup(counts.tree, PROP_RANGE.tree);
    treeG.batched.push(target(foliage, counts.tree));
    const hedgeG = newGroup(counts.hedge, PROP_RANGE.hedge);
    hedgeG.batched.push(target(foliage, counts.hedge));
    // Furniture kinds: one batched target each (the shelter also fills the glass instances), lamps instanced only.
    const furnG: Partial<Record<Prop['kind'], PropGroup>> = {};
    for (const kind of ['bench', 'hydrant', 'bin', 'sign', 'shelter', 'bollard', 'pole', 'roadsign', 'dumpster', 'table'] as const) {
      const g = newGroup(counts[kind], PROP_RANGE[kind]);
      g.batched.push(target(furniture, counts[kind]));
      furnG[kind] = g;
    }
    furnG.shelter!.inst.push(shelterGlassM);
    const lampG = newGroup(counts.lamp, PROP_RANGE.lamp);
    lampG.inst.push(poleM, headM);
    // The glow quad is filled by repackLampGlow instead (one disc per in-range lamp).
    this.lampGlowMesh = glowM;
    let palmIdx = 0;
    const lampXs: number[] = [], lampZs: number[] = [], lampYaws: number[] = [];
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (p.kind === 'palm') {
        const v = palmIdx++ % PALM_SEEDS.length;
        const k = push(palmG, p.x, p.z, p.yaw, p.scale, CURB_H);
        palmG.near[0].ids[k] = add(trunks, trunks.geo[v], p.x, p.z, p.yaw, p.scale, CURB_H, null);
        palmG.near[1].ids[k] = add(fronds, fronds.geo[v], p.x, p.z, p.yaw, p.scale, CURB_H, null);
        palmG.far[0].ids[k] = add(foliage, foliage.geo[FOL_FAR_PALM], p.x, p.z, p.yaw, p.scale, CURB_H, scratchColor.setRGB(1, 1, 1));
      } else if (p.kind === 'tree') {
        // Roughly a third of the street trees are the tall narrow species; the rest are broad crowns. Cypresses are
        // drawn a little smaller than their placement scale asks, so a 1.3 one is not a 12 m spike over a shopfront.
        const cypress = rng.chance(CYPRESS_SHARE);
        const gi = cypress ? FOL_CYPRESS + rng.int(0, CYPRESS_SEEDS.length - 1) : FOL_TREE + rng.int(0, TREE_SEEDS.length - 1);
        const sc = cypress ? p.scale * 0.86 : p.scale;
        const k = push(treeG, p.x, p.z, p.yaw, sc, CURB_H);
        treeG.batched[0].ids[k] = add(foliage, foliage.geo[gi], p.x, p.z, p.yaw, sc, CURB_H, foliageTint(rng, 0.5, scratchColor));
      } else if (p.kind === 'hedge') {
        const k = push(hedgeG, p.x, p.z, p.yaw, p.scale, CURB_H);
        hedgeG.batched[0].ids[k] = add(foliage, foliage.geo[FOL_HEDGE + rng.int(0, HEDGE_SEEDS.length - 1)], p.x, p.z, p.yaw, p.scale, CURB_H, foliageTint(rng, 0.35, scratchColor));
      } else if (p.kind === 'lamp') {
        push(lampG, p.x, p.z, p.yaw, p.scale, CURB_H);
        lampXs.push(p.x); lampZs.push(p.z); lampYaws.push(p.yaw);
      } else {
        const g = furnG[p.kind]!;
        const k = push(g, p.x, p.z, p.yaw, p.scale, CURB_H);
        g.batched[0].ids[k] = add(furniture, furniture.geo[FG[p.kind]], p.x, p.z, p.yaw, p.scale, CURB_H, null);
      }
    }
    // Lot dressing stands on the lot floor.
    const islandG = newGroup(lotCounts.island, PROP_RANGE.island), planterG = newGroup(lotCounts.planter, PROP_RANGE.planter);
    islandG.batched.push(target(furniture, lotCounts.island));
    planterG.batched.push(target(furniture, lotCounts.planter));
    for (let i = 0; i < lotProps.length; i++) {
      const p = lotProps[i];
      if (p.kind === 'booth') continue;
      const g = p.kind === 'island' ? islandG : planterG;
      const k = push(g, p.x, p.z, p.yaw, 1, LOT_FLOOR_Y);
      g.batched[0].ids[k] = add(furniture, furniture.geo[FG[p.kind]], p.x, p.z, p.yaw, 1, LOT_FLOOR_Y, null);
    }
    // Parked cars: the lot bays (lot floor, short range) and the kerbs (pavement, longer range) as two groups of the
    // parked batch, each instance on its spec's shell in its own paint.
    let lotN = 0, kerbN = 0;
    for (let i = 0; i < parked.length; i++) if (parked[i].at === 'lot') lotN++; else kerbN++;
    const lotCarG = newGroup(lotN, PROP_RANGE.parked), kerbCarG = newGroup(kerbN, PROP_RANGE.kerb);
    lotCarG.batched.push(target(parkedB, lotN));
    kerbCarG.batched.push(target(parkedB, kerbN));
    this.carX = new Float32Array(Math.max(1, parked.length));
    this.carZ = new Float32Array(Math.max(1, parked.length));
    this.carYaw = new Float32Array(Math.max(1, parked.length));
    this.carY = new Float32Array(Math.max(1, parked.length));
    this.carColour = new Int32Array(Math.max(1, parked.length));
    this.carGeo = new Int32Array(Math.max(1, parked.length));
    this.carCoarse = new Int32Array(Math.max(1, parked.length));
    for (let i = 0; i < parked.length; i++) {
      const p = parked[i];
      const lot = p.at === 'lot';
      const g = lot ? lotCarG : kerbCarG, y = lot ? LOT_FLOOR_Y : CURB_H;
      const k = push(g, p.x, p.z, p.yaw, 1, y);
      const spec = PARKED_SPECS.indexOf(p.spec);
      const id = add(parkedB, parkedB.geo[spec], p.x, p.z, p.yaw, 1, y, scratchColor.setHex(p.colour));
      g.batched[0].ids[k] = id;
      const c = this.carCount++;
      this.carX[c] = p.x; this.carZ[c] = p.z; this.carYaw[c] = p.yaw; this.carY[c] = y;
      this.carColour[c] = p.colour; this.carGeo[c] = spec; this.carCoarse[c] = id;
    }
    this.lampX = new Float32Array(Math.max(1, lampXs.length));
    this.lampZ = new Float32Array(Math.max(1, lampXs.length));
    this.lampYaw = new Float32Array(Math.max(1, lampXs.length));
    for (let i = 0; i < lampXs.length; i++) { this.lampX[i] = lampXs[i]; this.lampZ[i] = lampZs[i]; this.lampYaw[i] = lampYaws[i]; }
    this.lampCount = lampXs.length;
    this.repack(0, 0);
  }

  /**
   * One BatchedMesh holding every part of one material: the parts are copied in (and disposed), instances are added
   * by the groups. The range packing decides which instances are visible at all; on top of that three's per-instance
   * frustum test (a sphere test per visible instance, per pass, no allocation) keeps props behind the camera out of
   * the colour pass and props outside the 120 m shadow box out of the shadow pass. Depth sorting is off.
   */
  private batch(scene: THREE.Scene, name: string, parts: THREE.BufferGeometry[], material: THREE.Material, instances: number, shadow: boolean): Batch {
    let verts = 0, index = 0;
    for (let i = 0; i < parts.length; i++) { verts += parts[i].attributes.position.count; index += parts[i].index ? parts[i].index!.count : 0; }
    const mesh = new THREE.BatchedMesh(Math.max(1, instances), Math.max(3, verts), Math.max(3, index), material);
    mesh.name = 'prop:' + name;
    mesh.perObjectFrustumCulled = true;
    mesh.sortObjects = false;
    mesh.frustumCulled = false;
    mesh.castShadow = shadow;
    mesh.receiveShadow = false;
    const geo: number[] = [];
    for (let i = 0; i < parts.length; i++) { geo.push(mesh.addGeometry(parts[i])); parts[i].dispose(); }
    this.batches.push(mesh);
    this.meshes.push(mesh);
    scene.add(mesh);
    return { mesh, geo };
  }

  /**
   * Syncs the glow opacity with the night factor, re-aims the lamp point lights (every frame, not on the 15 m repack
   * cadence: a light that jumped lamps only when the packer ran popped a whole pavement pool in one frame), then
   * re-evaluates the draw ranges if the camera moved enough.
   */
  update(camX: number, camZ: number): void {
    const n = this.materials.nightFactor;
    this.glowMat.opacity = n * GLOW_OPACITY;
    if (this.wireMat) this.wireMat.opacity = 0.85 - 0.35 * n;
    this.aimLampLights(camX, camZ, n);
    const tdx = camX - this.tierX, tdz = camZ - this.tierZ;
    if (tdx * tdx + tdz * tdz >= CAR_TIER_MOVE * CAR_TIER_MOVE) this.repackNearCars(camX, camZ);
    const dx = camX - this.lastX, dz = camZ - this.lastZ;
    if (dx * dx + dz * dz < PROP_RANGE.repackMove * PROP_RANGE.repackMove) return;
    this.repack(camX, camZ);
  }

  /**
   * Keeps the `n` smallest entries of a stream in `pickIdx` / `pickD2` (insertion into a cap-sized buffer: the
   * candidates that get this far are the handful already inside the near radius, so the shifting costs nothing).
   * Returns the new count.
   */
  private static insertNearest(idx: Int32Array, d2s: Float32Array, count: number, cap: number, i: number, d2: number): number {
    if (count === cap && d2 >= d2s[count - 1]) return count;
    let at = count < cap ? count : cap - 1;
    while (at > 0 && d2s[at - 1] > d2) { d2s[at] = d2s[at - 1]; idx[at] = idx[at - 1]; at--; }
    d2s[at] = d2;
    idx[at] = i;
    return Math.min(cap, count + 1);
  }

  /**
   * Re-aims the point-light pool at the nearest lamp heads. Called every frame: the pool used to follow the 15 m
   * range packer, which meant a boundary lamp swapped between a real 140 cd pool and a flat additive disc in one
   * frame, every 0.75 s of straight-line driving. Re-aiming per frame makes the hand-over happen where two lamps are
   * equidistant, and `fade` ramps a light out over the last third of its range so nothing changes discontinuously.
   * No allocation, and by day (n === 0) it is a three-iteration loop and an early out.
   */
  private aimLampLights(camX: number, camZ: number, n: number): void {
    const lights = this.lampLights;
    if (n <= 0 || this.lampCount === 0) {
      // Intensity, never visibility: a light that leaves the scene changes NUM_POINT_LIGHTS and recompiles every lit
      // material in the city, which would hitch at every dusk. At intensity 0 they still cost a per-fragment
      // evaluation in every lit material, which is why the pool is three lights and not a dozen.
      for (let k = 0; k < lights.length; k++) lights[k].intensity = 0;
      return;
    }
    let picked = 0;
    for (let i = 0; i < this.lampCount; i++) {
      const dx = this.lampX[i] - camX, dz = this.lampZ[i] - camZ;
      picked = PropRenderer.insertNearest(this.pickIdx, this.pickD2, picked, LAMP_LIGHTS.count, i, dx * dx + dz * dz);
    }
    const fadeFrom = LAMP_LIGHTS.distance * (1 - LAMP_LIGHTS.fade);
    for (let k = 0; k < lights.length; k++) {
      const l = lights[k];
      // A city with fewer lamps than lights would leave the tail parked on the last one; harmless, and it keeps the
      // light count (and therefore the compiled programs) fixed for the whole session.
      const slot = Math.min(k, Math.max(0, picked - 1));
      const i = this.pickIdx[slot], yaw = this.lampYaw[i];
      // The luminaire hangs at the arm tip: local (0, lampH + 0.35, lampArm - 0.32), turned by the lamp's yaw.
      const arm = PROP_DIMS.lampArm - 0.32;
      l.position.set(this.lampX[i] + Math.sin(yaw) * arm, LAMP_LIGHTS.y, this.lampZ[i] + Math.cos(yaw) * arm);
      const d = Math.sqrt(this.pickD2[slot]);
      const fade = d <= fadeFrom ? 1 : Math.max(0, (LAMP_LIGHTS.distance - d) / (LAMP_LIGHTS.distance - fadeFrom));
      l.intensity = n * LAMP_LIGHTS.intensity * fade;
    }
  }

  /**
   * Fills the additive pavement pools. Every lamp in range gets one, including the two or three carrying a real
   * point light: the disc is small enough to read as the hot core of the luminaire rather than a sepia ellipse over
   * the lane paint, and making it depend on which lamp holds a light is what put a pop on the pool boundary.
   */
  private repackLampGlow(camX: number, camZ: number): void {
    const glow = this.lampGlowMesh;
    if (!glow) return;
    glow.count = 0;
    const range2 = PROP_RANGE.lamp * PROP_RANGE.lamp;
    for (let i = 0; i < this.lampCount; i++) {
      const dx = this.lampX[i] - camX, dz = this.lampZ[i] - camZ;
      if (dx * dx + dz * dz > range2) continue;
      placementMatrix(this.lampX[i], this.lampZ[i], this.lampYaw[i], 1, CURB_H);
      glow.setMatrixAt(glow.count, mat);
      glow.count++;
    }
  }

  /**
   * Writes one capped fidelity band: the `cap` nearest cars inside `range` are given their geometry, matrix and paint
   * in `mesh` and their coarse shell is hidden. `skip`/`skipN` is the list of cars a closer band already took (the
   * near band's picks, so the mid band does not draw the same car twice). Returns the number of cars written, which
   * the caller keeps to pass down as the next band's skip list. No allocation.
   */
  private fillCarTier(mesh: THREE.BatchedMesh, geo: number[], cap: number, range: number, camX: number, camZ: number,
    skip: Int32Array, skipN: number, out: Int32Array | null): number {
    const coarse = this.coarseMesh;
    if (!coarse) return 0;
    for (let k = 0; k < cap; k++) mesh.setVisibleAt(k, false);
    const r2 = range * range;
    let picked = 0;
    for (let i = 0; i < this.carCount; i++) {
      const dx = this.carX[i] - camX, dz = this.carZ[i] - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      let taken = false;
      for (let k = 0; k < skipN && !taken; k++) taken = skip[k] === i;
      if (taken) continue;
      picked = PropRenderer.insertNearest(this.pickIdx, this.pickD2, picked, cap, i, d2);
    }
    for (let k = 0; k < picked; k++) {
      const i = this.pickIdx[k];
      mesh.setGeometryIdAt(k, geo[this.carGeo[i]]);
      mesh.setMatrixAt(k, placementMatrix(this.carX[i], this.carZ[i], this.carYaw[i], 1, this.carY[i]));
      mesh.setColorAt(k, scratchColor.setHex(this.carColour[i]));
      mesh.setVisibleAt(k, true);
      coarse.setVisibleAt(this.carCoarse[i], false);
      if (out) out[k] = i;
    }
    return picked;
  }

  /**
   * Hands the nearest static parked cars to the near loft and the next ring of them to the mid shell, hiding the
   * coarse shell of every car either band took. Runs after the generic pass, which has already set every coarse
   * shell's visibility from its own range. Near first, so its picks are the mid band's skip list.
   */
  private repackNearCars(camX: number, camZ: number): void {
    const near = this.nearMesh, mid = this.midMesh, coarse = this.coarseMesh;
    if (!near || !mid || !coarse) return;
    this.tierX = camX;
    this.tierZ = camZ;
    // Hand every previous pick's coarse shell back first: this runs on its own 1.5 m cadence, so the generic pass
    // (which sets coarse visibility from range) has usually NOT run since, and a car that has left a capped band
    // would otherwise keep the hidden coarse shell it was given and vanish from the street. Every previous pick was
    // within MID_CARS.range, i.e. well inside PROP_RANGE.parked / .kerb, so handing it back is always right.
    for (let k = 0; k < this.nearPickedN; k++) coarse.setVisibleAt(this.carCoarse[this.nearPicked[k]], true);
    for (let k = 0; k < this.midPickedN; k++) coarse.setVisibleAt(this.carCoarse[this.midPicked[k]], true);
    this.nearPickedN = this.fillCarTier(near, this.nearGeo, NEAR_CARS.cap, NEAR_CARS.range, camX, camZ, this.nearPicked, 0, this.nearPicked);
    this.midPickedN = this.fillCarTier(mid, this.midGeo, MID_CARS.cap, MID_CARS.range, camX, camZ, this.nearPicked, this.nearPickedN, this.midPicked);
    this.repackCarShadows(camX, camZ);
  }

  /** Blobs under the `CAR_SHADOWS.cap` nearest static parked cars, re-picked with the fidelity bands. No allocation. */
  private repackCarShadows(camX: number, camZ: number): void {
    const r2 = CAR_SHADOWS.range * CAR_SHADOWS.range;
    let picked = 0;
    for (let i = 0; i < this.carCount; i++) {
      const dx = this.carX[i] - camX, dz = this.carZ[i] - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      picked = PropRenderer.insertNearest(this.pickIdx, this.pickD2, picked, CAR_SHADOWS.cap, i, d2);
    }
    this.carShadows.begin();
    for (let k = 0; k < picked; k++) {
      const i = this.pickIdx[k];
      const spec = SPECS[PARKED_SPECS[this.carGeo[i]]];
      this.carShadows.add(this.carX[i], this.carY[i] + CAR_SHADOWS.lift, this.carZ[i],
        spec.width * 0.5 * CAR_SHADOWS.w, spec.length * 0.5 * CAR_SHADOWS.l, this.carYaw[i], 1);
    }
    this.carShadows.end();
  }

  /** Copies the wire spans within range into the line mesh's buffer and sets its draw range. */
  private repackWires(camX: number, camZ: number): void {
    const spans = this.spans, attr = this.wirePos;
    if (!spans || !attr || !this.wireMesh) return;
    const dst = attr.array as Float32Array;
    const capSpans = Math.floor(dst.length / WIRE_FLOATS_PER_SPAN);
    const r2 = WIRE.inRange * WIRE.inRange;
    let n = 0;
    for (let i = 0; i < spans.count && n < capSpans; i++) {
      const dx = spans.midX[i] - camX, dz = spans.midZ[i] - camZ;
      if (dx * dx + dz * dz > r2) continue;
      dst.set(spans.data.subarray(i * WIRE_FLOATS_PER_SPAN, (i + 1) * WIRE_FLOATS_PER_SPAN), n * WIRE_FLOATS_PER_SPAN);
      n++;
    }
    attr.needsUpdate = true;
    this.wireMesh.geometry.setDrawRange(0, (n * WIRE_FLOATS_PER_SPAN) / 3);
    this.wireMesh.visible = n > 0;
  }

  private static show(list: BatchTarget[], i: number, visible: boolean): void {
    for (let t = 0; t < list.length; t++) list[t].mesh.setVisibleAt(list[t].ids[i], visible);
  }

  private repack(camX: number, camZ: number): void {
    this.lastX = camX;
    this.lastZ = camZ;
    for (let i = 0; i < this.instanced.length; i++) this.instanced[i].count = 0;
    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi];
      const lod = g.near.length > 0 || g.far.length > 0;
      for (let i = 0; i < g.count; i++) {
        const o = i * STRIDE;
        const x = g.data[o], z = g.data[o + 1];
        const ddx = x - camX, ddz = z - camZ;
        const d2 = ddx * ddx + ddz * ddz;
        const inRange = d2 <= g.range2;
        if (g.batched.length) PropRenderer.show(g.batched, i, inRange);
        if (lod) {
          const near = inRange && d2 < g.nearRange2;
          PropRenderer.show(g.near, i, near);
          PropRenderer.show(g.far, i, inRange && !near);
        }
        if (inRange && g.inst.length) {
          placementMatrix(x, z, g.data[o + 2], g.data[o + 3], g.data[o + 4]);
          for (let m = 0; m < g.inst.length; m++) {
            const mesh = g.inst[m];
            mesh.setMatrixAt(mesh.count, mat);
            mesh.count++;
          }
        }
      }
    }
    this.repackLampGlow(camX, camZ);
    this.repackNearCars(camX, camZ);
    this.repackWires(camX, camZ);
    for (let i = 0; i < this.instanced.length; i++) this.instanced[i].instanceMatrix.needsUpdate = true;
  }

  /** Meshes this renderer contributes (one draw call each when visible). */
  get drawCount(): number { return this.meshes.length; }

  dispose(): void {
    this.carShadows.dispose();
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      if (m.parent) m.parent.remove(m);
    }
    for (let i = 0; i < this.instanced.length; i++) this.instanced[i].dispose();
    for (let i = 0; i < this.batches.length; i++) this.batches[i].dispose();
    for (let i = 0; i < this.geometries.length; i++) this.geometries[i].dispose();
    for (let i = 0; i < this.lampLights.length; i++) {
      const l = this.lampLights[i];
      if (l.parent) l.parent.remove(l);
      l.dispose();
    }
    this.lampLights.length = 0;
    if (this.wireMat) this.wireMat.dispose();
    this.glowMat.dispose();
    this.paintMat.dispose();
    this.meshes.length = 0;
    this.instanced.length = 0;
    this.batches.length = 0;
    this.geometries.length = 0;
  }
}
