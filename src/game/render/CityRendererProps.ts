// Instanced street props for CityRenderer: palms (two seeded variants: trunk + alpha fronds near, one solid flat-shaded
// far LOD beyond PROP_RANGE.palmNear), round-crown sidewalk trees, hedge units, lamps (pole + head + glow), benches,
// hydrants, bins, signs, shelters (frame + glazing), bollards; plus the static parked cars (one cheap shell per spec,
// paint per instance) of the lot bays and the kerbs, kerb islands and planters. Track B.
//
// Everything is sculpted from lathes, swept tubes and rounded slabs rather than raw boxes: a gooseneck lamp arm, a
// chamfered bollard, a slatted bench with cast-iron ends, a glazed shelter with a rounded roof, fronds that arch from
// their base with a V midrib and a fibrous crown. Each part is still one InstancedMesh, so the draw-call count is fixed.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { LotProp, ParkedCar, ParkedSpec, Prop } from '../city/CityData';
import { CURB_H } from '../city/CityConfig';
import { SPECS } from '../entities/VehicleSpecs';
import { Random } from '../core/Random';
import type { Materials } from './Materials';
import { surface, tube, type Ring } from './PlayerRenderer';
import { makeVehiclePaintMaterial, parkedShellGeometry } from './VehicleRenderer';

export const PROP_DIMS = { palmTrunkH: 6.4, palmFrondLen: 4.4, palmFrondW: 2.3, lampH: 6.5, lampArm: 1.4, poolRadius: 9 } as const;

/** Street furniture colours; each part is baked into the vertex colours so one material covers every kind. */
const FURN = {
  binBody: 0x33513f, binLid: 0x1d3025, binBand: 0x9aa4a8, pole: 0x8b9298, blade: 0x1d6a49,
  post: 0x4a5058, roof: 0x2f353b, fascia: 0xb8702c, frame: 0x30353a, seat: 0x9a6a3c, iron: 0x2b2f33,
  bollard: 0x3c4147, bollardCap: 0xc3c8cd, hydrant: 0xd8302a, hydrantDark: 0x8e1f1a,
  kerb: 0x9c988f, kerbTop: 0xaaa69d, gravel: 0x5a5148, pot: 0x8f897d, potRim: 0x9d978b, soil: 0x3d3229, shrub: 0x3f6d38, shrubLit: 0x6f9a4c,
  // Trees (flat-shaded foliage material): bark, crown mass, its lit top and shaded underside; the far palm's trunk and fans.
  bark: 0x5c4634, barkDark: 0x3d2e22, crown: 0x477536, crownLit: 0x84b258, crownDark: 0x2f5228, hedgeDark: 0x2c4d28,
  palmBarkFar: 0x8b7252, frondFar: 0x5b8f3c, frondFarTip: 0x7fae4e,
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
 * Sidewalk tree: an 8-sided tapered trunk with a darker foot and a crown of three overlapping icosahedral lobes, lit
 * from the top through the vertex colours (crownLit at the top of the mass, crownDark on the underside) so the flat
 * shading reads as one round volume of leaves. About 300 triangles; scale and yaw vary per instance.
 */
function treeGeometry(seed: number): THREE.BufferGeometry {
  const rng = new Random(seed);
  const trunk = lathe([R(0, 0.26), R(0.12, 0.2), R(1.5, 0.15), R(3.0, 0.12), R(3.6, 0.09)], 8, FURN.bark);
  blendTo(trunk, FURN.barkDark, (_x, y) => (y < 0.4 ? 1 - y / 0.4 : 0) * 0.8);
  const parts: THREE.BufferGeometry[] = [trunk];
  const lobes = [[0, 4.55, 0, 1.8], [0.85, 5.0, 0.5, 1.35], [-0.8, 4.9, -0.55, 1.3]];
  let yLo = Infinity, yHi = -Infinity;
  for (let i = 0; i < lobes.length; i++) { yLo = Math.min(yLo, lobes[i][1] - lobes[i][3] * 0.85); yHi = Math.max(yHi, lobes[i][1] + lobes[i][3] * 0.85); }
  for (let i = 0; i < lobes.length; i++) {
    const [ox, oy, oz, r] = lobes[i];
    const g = bare(new THREE.IcosahedronGeometry(r, 1));
    g.scale(1, 0.85, 1);
    g.rotateY(rng.range(0, Math.PI));
    g.translate(ox + rng.range(-0.1, 0.1), oy, oz + rng.range(-0.1, 0.1));
    paint(g, FURN.crown);
    const jitter = rng.range(-0.06, 0.06);
    blendTo(g, FURN.crownLit, (_x, y) => Math.max(0, Math.min(1, (y - yLo) / (yHi - yLo) - 0.25)) * (0.9 + jitter));
    blendTo(g, FURN.crownDark, (_x, y) => Math.max(0, Math.min(1, 1 - (y - yLo) / 1.4)) * 0.8);
    parts.push(g);
  }
  return fuse(parts);
}

/**
 * Hedge unit: a clipped 2 m x 0.6 m rounded block on the lot's street edge, its nose along z (CityLots.HEDGE); the
 * top is lit, the base shaded, so a row reads as trimmed shrubs rather than green boxes.
 */
function hedgeGeometry(): THREE.BufferGeometry {
  const g = slab(0.6, 0.8, 2.0, 0, 0.4, 0, FURN.shrub, 0.2, 1);
  blendTo(g, FURN.shrubLit, (_x, y) => Math.max(0, Math.min(1, (y - 0.35) / 0.45)) * 0.85);
  blendTo(g, FURN.hedgeDark, (_x, y) => Math.max(0, Math.min(1, 1 - y / 0.3)) * 0.8);
  return g;
}

/**
 * Far palm (beyond PROP_RANGE.palmNear): a six-sided trunk leaning to the seeded trunk's top, bark baked as a vertex
 * colour, and a crown of ten opaque two-tone fans (three rows, V section, back faces darker), all on the flat-shaded
 * foliage material. No alpha, so nothing lets the sky through at distance; about a third of the near palm's triangles.
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
    g.translate(topX, topY + (inner ? 0.1 : -0.05), 0);
    paint(g, FURN.frondFar);
    blendTo(g, FURN.frondFarTip, () => rng.range(0.15, 0.55));
    const both = withBackFaces(g, 0.62);
    g.dispose();
    parts.push(bare(both));
  }
  return fuse(parts);
}

/** Lamp glow: the pavement pool and the facade spill merged into one quad pair; the spill is 40% as bright. */
function glowGeometry(): THREE.BufferGeometry {
  const pool = new THREE.PlaneGeometry(PROP_DIMS.poolRadius * 2, PROP_DIMS.poolRadius * 2);
  pool.rotateX(-Math.PI / 2);
  pool.translate(0, 0.06, PROP_DIMS.lampArm - 0.3);
  tintRGB(pool, 1, 1, 1);
  // Facade spill: a vertical glow behind the pole (the kerb side is -Z; the arm points +Z over the road).
  const spill = new THREE.PlaneGeometry(2.5, 4.5);
  spill.translate(0, 2.25, -0.9);
  tintRGB(spill, 0.4, 0.4, 0.4);
  return fuse([pool, spill]);
}

/**
 * Draw radius per prop kind: past this the prop is a couple of pixels, so it is left out of the instance buffer.
 * Parked shells and lot furniture stop at 120 m: beyond that a lot interior is hidden behind its own street wall;
 * kerbside cars sit in plain view down a street and go further. Palms switch from the alpha fronds to the solid far
 * LOD at `palmNear`.
 */
export const PROP_RANGE = { palm: 165, palmNear: 60, tree: 120, hedge: 100, lamp: 240, bench: 170, hydrant: 140, bin: 130, sign: 175, shelter: 210, bollard: 120, parked: 120, kerb: 135, island: 120, planter: 110, repackMove: 15 } as const;

/** Seeds of the two palm variants; palms alternate between them by index. */
const PALM_SEEDS = [1201, 2417] as const;

/** Night opacity of the lamp glow quads (the pavement pool; the spill quad is vertex-tinted to 40% of it). */
const GLOW_OPACITY = 0.45;

const PARKED_SPECS: ParkedSpec[] = ['sedan', 'sport', 'van'];

/** Floats per placement in PropGroup.data: x, z, yaw, scale, y (the ground height the instance stands on). */
const STRIDE = 5;

interface PropGroup {
  /** Source placements, STRIDE floats each (never mutated). */
  data: Float32Array;
  /** Per-instance paint (r, g, b) for the parked shells; null for props drawn in their baked colours. */
  colors: Float32Array | null;
  count: number;
  range2: number;
  /** Meshes every in-range instance is written to. */
  meshes: THREE.InstancedMesh[];
  /** LOD split: instances closer than `nearRange2` also go to `near`, the rest to `far` (both optional). */
  nearRange2: number;
  near: THREE.InstancedMesh[];
  far: THREE.InstancedMesh[];
}

function makeGroup(n: number, range: number, meshes: THREE.InstancedMesh[], near: THREE.InstancedMesh[] = [], far: THREE.InstancedMesh[] = [], nearRange = 0, colors = false): PropGroup {
  return { data: new Float32Array(Math.max(1, n) * STRIDE), colors: colors ? new Float32Array(Math.max(1, n) * 3) : null, count: 0, range2: range * range, meshes, nearRange2: nearRange * nearRange, near, far };
}

function pushPlacement(g: PropGroup, x: number, z: number, yaw: number, scale: number, y: number): void {
  const o = g.count * STRIDE;
  g.data[o] = x; g.data[o + 1] = z; g.data[o + 2] = yaw; g.data[o + 3] = scale; g.data[o + 4] = y;
  g.count++;
}

/**
 * Builds and adds the instanced prop meshes; 22 draw calls total (two palm variants x 2 parts + the shared far palm,
 * tree, hedge, three lamp parts, bench, hydrant, bin, sign, shelter frame, shelter glass, bollard, three parked
 * shells, island, planter).
 *
 * The city holds ~1300 lamps, ~500 palms and a few thousand cars, trees and hedges — drawing them all costs hundreds
 * of thousands of triangles per frame even when they are half a kilometre behind the camera. Instead the source
 * placements are kept on the CPU and only the ones inside PROP_RANGE are written into the instance buffers, repacked
 * whenever the camera has moved `repackMove` metres. Groups may share a mesh (the lot and kerb cars of one spec both
 * fill the spec's shell; both palm variants fill the far palm), so a repack appends to each mesh's `count` in group
 * order. Draw calls stay fixed; the triangle count drops by roughly 6x.
 */
export class PropRenderer {
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly groups: PropGroup[] = [];
  private readonly materials: Materials;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly paintMat: THREE.MeshPhysicalMaterial;
  /** Flat-shaded vertex-colour foliage: tree crowns and trunks, hedges, the far palm LOD. */
  private readonly foliageMat: THREE.MeshStandardMaterial;
  private lastX = Infinity;
  private lastZ = Infinity;

  constructor(scene: THREE.Scene, props: Prop[], materials: Materials, parked: ParkedCar[] = [], lotProps: LotProp[] = []) {
    this.materials = materials;
    const counts: Record<Prop['kind'], number> = { palm: 0, lamp: 0, bench: 0, hydrant: 0, bin: 0, sign: 0, shelter: 0, bollard: 0, tree: 0, hedge: 0 };
    for (let i = 0; i < props.length; i++) counts[props[i].kind]++;
    const parkedCounts: Record<ParkedSpec, number> = { sedan: 0, sport: 0, van: 0 };
    const kerbCounts: Record<ParkedSpec, number> = { sedan: 0, sport: 0, van: 0 };
    for (let i = 0; i < parked.length; i++) (parked[i].at === 'kerb' ? kerbCounts : parkedCounts)[parked[i].spec]++;
    const lotCounts: Record<LotProp['kind'], number> = { island: 0, planter: 0, booth: 0 };
    for (let i = 0; i < lotProps.length; i++) lotCounts[lotProps[i].kind]++;
    const pole = poleGeometry();
    const head = headGeometry();
    const glow = glowGeometry();
    const bench = benchGeometry();
    const hydrant = hydrantGeometry();
    const bin = binGeometry();
    const sign = signGeometry();
    const shelter = shelterGeometry();
    const shelterGlass = shelterGlassGeometry();
    const bollard = bollardGeometry();
    const island = islandGeometry();
    const planter = planterGeometry();
    const tree = treeGeometry(4111);
    const hedge = hedgeGeometry();
    const farPalm = farPalmGeometry(PALM_SEEDS[0]);
    this.geometries.push(pole, head, glow, bench, hydrant, bin, sign, shelter, shelterGlass, bollard, island, planter, tree, hedge, farPalm);
    // Pool and spill share one additive material (same glow sprite and tint as Materials' lightPool); the spill's
    // lower intensity is baked into its vertex colour and the night opacity is synced in update().
    const poolSrc = materials.lightPool();
    this.glowMat = new THREE.MeshBasicMaterial({ map: poolSrc.map, color: poolSrc.color, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
    this.paintMat = makeVehiclePaintMaterial();
    this.foliageMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.35 });
    this.foliageMat.name = 'foliage';
    const mk = (name: string, g: THREE.BufferGeometry, m: THREE.Material, n: number, shadow: boolean): THREE.InstancedMesh => {
      const im = new THREE.InstancedMesh(g, m, Math.max(1, n));
      im.name = 'prop:' + name;
      im.count = 0;
      im.castShadow = shadow;
      im.receiveShadow = false;
      im.frustumCulled = false;
      this.meshes.push(im);
      scene.add(im);
      return im;
    };
    const palmMeshes: THREE.InstancedMesh[][] = [];
    for (let v = 0; v < PALM_SEEDS.length; v++) {
      const trunk = trunkGeometry(PALM_SEEDS[v]);
      const fronds = frondsGeometry(trunk.userData.topX as number, trunk.userData.topY as number, PALM_SEEDS[v] + 7);
      this.geometries.push(trunk, fronds);
      const n = Math.ceil(counts.palm / PALM_SEEDS.length);
      palmMeshes.push([mk('palmTrunk' + v, trunk, materials.palmTrunk, n, true), mk('palmFronds' + v, fronds, materials.palmFrond, n, true)]);
    }
    // The far palm is one mesh for both variants: past 60 m the variants' lean is a few pixels, and it never enters
    // the shadow box, so it casts nothing.
    const farPalmM = mk('palmFar', farPalm, this.foliageMat, counts.palm, false);
    const treeM = mk('tree', tree, this.foliageMat, counts.tree, true);
    const hedgeM = mk('hedge', hedge, this.foliageMat, counts.hedge, true);
    const poleM = mk('lampPole', pole, materials.lampPole, counts.lamp, true);
    const headM = mk('lampHead', head, materials.lampHead(), counts.lamp, false);
    const glowM = mk('lampGlow', glow, this.glowMat, counts.lamp, false);
    glowM.renderOrder = 2;
    const benchM = mk('bench', bench, materials.furniture, counts.bench, true);
    const hydrantM = mk('hydrant', hydrant, materials.furniture, counts.hydrant, false);
    const binM = mk('bin', bin, materials.furniture, counts.bin, true);
    const signM = mk('sign', sign, materials.furniture, counts.sign, true);
    const shelterM = mk('shelter', shelter, materials.furniture, counts.shelter, true);
    const shelterGlassM = mk('shelterGlass', shelterGlass, materials.glass(), counts.shelter, false);
    const bollardM = mk('bollard', bollard, materials.furniture, counts.bollard, false);
    const islandM = mk('island', island, materials.furniture, lotCounts.island, false);
    const planterM = mk('planter', planter, materials.furniture, lotCounts.planter, true);
    // Parked shells: one mesh per spec (lot and kerb cars together) on the vehicle paint material; the instance
    // colour tints the paint regions.
    const parkedMeshes: THREE.InstancedMesh[] = [];
    scratchColor.setRGB(1, 1, 1);
    for (let i = 0; i < PARKED_SPECS.length; i++) {
      const spec = PARKED_SPECS[i];
      const shell = parkedShellGeometry(SPECS[spec]);
      this.geometries.push(shell);
      const m = mk('parked:' + spec, shell, this.paintMat, parkedCounts[spec] + kerbCounts[spec], true);
      m.receiveShadow = true;
      m.setColorAt(0, scratchColor); // allocates instanceColor before the first compile, so the shader is built with it
      parkedMeshes.push(m);
    }
    // `parity`/`mod` split one kind over several groups (palm variants) by its index within the kind.
    const group = (kind: Prop['kind'], n: number, range: number, meshes: THREE.InstancedMesh[], parity = 0, mod = 1, near: THREE.InstancedMesh[] = [], far: THREE.InstancedMesh[] = [], nearRange = 0): PropGroup => {
      const g = makeGroup(n, range, meshes, near, far, nearRange);
      this.groups.push(g);
      let idx = 0;
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        if (p.kind !== kind) continue;
        if (idx++ % mod !== parity) continue;
        pushPlacement(g, p.x, p.z, p.yaw, p.scale, CURB_H);
      }
      return g;
    };
    for (let v = 0; v < PALM_SEEDS.length; v++) group('palm', Math.ceil(counts.palm / PALM_SEEDS.length), PROP_RANGE.palm, [], v, PALM_SEEDS.length, palmMeshes[v], [farPalmM], PROP_RANGE.palmNear);
    group('tree', counts.tree, PROP_RANGE.tree, [treeM]);
    group('hedge', counts.hedge, PROP_RANGE.hedge, [hedgeM]);
    group('lamp', counts.lamp, PROP_RANGE.lamp, [poleM, headM, glowM]);
    group('bench', counts.bench, PROP_RANGE.bench, [benchM]);
    group('hydrant', counts.hydrant, PROP_RANGE.hydrant, [hydrantM]);
    group('bin', counts.bin, PROP_RANGE.bin, [binM]);
    group('sign', counts.sign, PROP_RANGE.sign, [signM]);
    group('shelter', counts.shelter, PROP_RANGE.shelter, [shelterM, shelterGlassM]);
    group('bollard', counts.bollard, PROP_RANGE.bollard, [bollardM]);
    // Lot dressing stands on the lot floor.
    const lotGroup = (kind: LotProp['kind'], range: number, mesh: THREE.InstancedMesh): void => {
      const g = makeGroup(lotCounts[kind], range, [mesh]);
      this.groups.push(g);
      for (let i = 0; i < lotProps.length; i++) {
        const p = lotProps[i];
        if (p.kind === kind) pushPlacement(g, p.x, p.z, p.yaw, 1, LOT_FLOOR_Y);
      }
    };
    lotGroup('island', PROP_RANGE.island, islandM);
    lotGroup('planter', PROP_RANGE.planter, planterM);
    // Parked cars: per spec one group for the lot bays (lot floor, short range) and one for the kerbs (pavement,
    // longer range), both filling the spec's shell mesh.
    for (let s = 0; s < PARKED_SPECS.length; s++) {
      const spec = PARKED_SPECS[s];
      for (const at of ['lot', 'kerb'] as const) {
        const n = at === 'lot' ? parkedCounts[spec] : kerbCounts[spec];
        const g = makeGroup(n, at === 'lot' ? PROP_RANGE.parked : PROP_RANGE.kerb, [parkedMeshes[s]], [], [], 0, true);
        this.groups.push(g);
        for (let i = 0; i < parked.length; i++) {
          const p = parked[i];
          if (p.spec !== spec || p.at !== at) continue;
          const c = g.count * 3;
          scratchColor.setHex(p.colour);
          g.colors![c] = scratchColor.r; g.colors![c + 1] = scratchColor.g; g.colors![c + 2] = scratchColor.b;
          pushPlacement(g, p.x, p.z, p.yaw, 1, at === 'lot' ? LOT_FLOOR_Y : CURB_H);
        }
      }
    }
    // Instanced meshes cannot be culled per instance, and their bounds span the whole city: pack by distance instead.
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i].frustumCulled = false;
    this.repack(0, 0);
  }

  /** Syncs the glow opacity with the night factor, then refills the instance buffers if the camera moved enough. */
  update(camX: number, camZ: number): void {
    this.glowMat.opacity = this.materials.nightFactor * GLOW_OPACITY;
    const dx = camX - this.lastX, dz = camZ - this.lastZ;
    if (dx * dx + dz * dz < PROP_RANGE.repackMove * PROP_RANGE.repackMove) return;
    this.repack(camX, camZ);
  }

  /** Writes one placement into every mesh of `list` at that mesh's cursor (`count`). */
  private static write(list: THREE.InstancedMesh[], colored: boolean): void {
    for (let m = 0; m < list.length; m++) {
      const mesh = list[m];
      mesh.setMatrixAt(mesh.count, mat);
      if (colored) mesh.setColorAt(mesh.count, scratchColor);
      mesh.count++;
    }
  }

  private repack(camX: number, camZ: number): void {
    this.lastX = camX;
    this.lastZ = camZ;
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i].count = 0;
    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi];
      const colored = g.colors !== null;
      for (let i = 0; i < g.count; i++) {
        const o = i * STRIDE;
        const x = g.data[o], z = g.data[o + 1];
        const ddx = x - camX, ddz = z - camZ;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 > g.range2) continue;
        dummy.position.set(x, g.data[o + 4], z);
        dummy.rotation.set(0, g.data[o + 2], 0);
        const sc = g.data[o + 3];
        dummy.scale.set(sc, sc, sc);
        dummy.updateMatrix();
        mat.copy(dummy.matrix);
        if (colored) scratchColor.setRGB(g.colors![i * 3], g.colors![i * 3 + 1], g.colors![i * 3 + 2]);
        PropRenderer.write(g.meshes, colored);
        if (g.near.length || g.far.length) PropRenderer.write(d2 < g.nearRange2 ? g.near : g.far, colored);
      }
    }
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
    this.glowMat.dispose();
    this.paintMat.dispose();
    this.foliageMat.dispose();
    this.meshes.length = 0;
    this.geometries.length = 0;
  }
}
