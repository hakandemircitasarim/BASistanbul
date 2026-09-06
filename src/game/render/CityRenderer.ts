// Static city rendering: merged buildings per style, landmarks, roads, sidewalks, ground/park/plaza/beach/ocean, props, neon signs. Track B.
import * as THREE from 'three';
import type { Building, CityData, Landmark, Lot } from '../city/CityData';
import type { RoadGraph } from '../city/RoadGraph';
import type { LanePos } from '../city/RoadGraph';
import { CITY_MAX_X, CITY_MAX_Z, CURB_H, GRID_COLS, LANE_W, OCEAN_SIZE, OCEAN_X0, SIDEWALK_W } from '../city/CityConfig';
import { SIGN_WORDS } from '../city/Palette';
import type { Materials } from './Materials';
import { STYLES, TILE_M } from './Materials';
import type { TextureFactory } from './TextureFactory';
import { GLOW_U, MARK_UV } from './TextureFactory';
import { BAND, GeoBuilder, appendBuilding, appendBuildingDetail, appendStreetLevel, landmarkGeometries } from './BuildingGeometry';
import type { WallSign } from './BuildingGeometry';
import { Random } from '../core/Random';
import { PropRenderer } from './CityRendererProps';

/** Asphalt half width: ROAD_W/2 - SIDEWALK_W = 7 m (curbs cover the rest). */
export const ASPHALT_HALF = 7;
export const CITY_RENDER = { groundY: -0.05, roadY: 0, blockY: CURB_H, oceanY: -0.3, promenadeX0: CITY_MAX_X - SIDEWALK_W, promenadeX1: CITY_MAX_X + 14, ferrisRate: 0.15, beamRate: 0.6 } as const;

/**
 * Street-level layout: where the painted marks and the lot furniture sit. Distances along a lane are measured from
 * the node centre; the crosswalk tile ends at ASPHALT_HALF, so the stop bar lands just outside the zebra and the
 * arrows a car length behind it. Lot bays follow the 9 m parked-spot grid (CityProps): a 5.6 m bay every 3 m across
 * the heading, one strip per spot column, leaving 3.4 m aisles between strips.
 */
export const STREET = {
  stopBarDist: ASPHALT_HALF + 0.75, stopBarW: 2 * LANE_W - 0.55, stopBarL: 0.5, arrowDist: ASPHALT_HALF + 4.4, arrowW: 2.4, arrowL: 4.4, markY: 0.02,
  /**
   * Only buildings whose facing wall stands within this distance of the block edge get a shopfront / plinth band:
   * edge lots sit 2.3-7 m in (block inset + setback), the centre lot of a 3x3 grid more than 30 m.
   */
  bandMaxSetback: 8,
  cornerDip: 0.03, lotFloorY: CURB_H + 0.02, lotKerbH: 0.13, lotKerbW: 0.3, lotGateW: 7, bayPitch: 3, bayLen: 5.6, bayLineW: 0.12, stripPitch: 9, stripInset: 3.5, wheelStopH: 0.11, wheelStopW: 0.22,
} as const;

/** Flat quad on the XZ plane with UVs in meters / tile (u along X, v along Z) at height y. */
function flatQuad(gb: GeoBuilder, x0: number, z0: number, x1: number, z1: number, y: number, tile: number): void {
  gb.quad(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0, 0, 1, 0, x0 / tile, z1 / tile, x1 / tile, z1 / tile, x1 / tile, z0 / tile, x0 / tile, z0 / tile);
}

/** Curb box: textured top (meters / tile) + kerb-stone sides, from y0 to y1 (a block kerb by default). */
function curbBox(gb: GeoBuilder, x0: number, z0: number, x1: number, z1: number, y0 = 0, y1 = CURB_H): void {
  const h = y1, t = TILE_M.sidewalk;
  gb.setColor(0xffffff);
  gb.quad(x0, h, z1, x1, h, z1, x1, h, z0, x0, h, z0, 0, 1, 0, x0 / t, z1 / t, x1 / t, z1 / t, x1 / t, z0 / t, x0 / t, z0 / t);
  gb.setColor(0xbdbdb8);
  gb.quad(x0, y0, z1, x1, y0, z1, x1, h, z1, x0, h, z1, 0, 0, 1, 0, 0, 0.02, 0, 0.02, 0.02, 0, 0.02);
  gb.quad(x1, y0, z0, x0, y0, z0, x0, h, z0, x1, h, z0, 0, 0, -1, 0, 0, 0.02, 0, 0.02, 0.02, 0, 0.02);
  gb.quad(x1, y0, z1, x1, y0, z0, x1, h, z0, x1, h, z1, 1, 0, 0, 0, 0, 0.02, 0, 0.02, 0.02, 0, 0.02);
  gb.quad(x0, y0, z0, x0, y0, z1, x0, h, z1, x0, h, z0, -1, 0, 0, 0, 0, 0.02, 0, 0.02, 0.02, 0, 0.02);
}

/**
 * Block-corner kerb square whose outer corner (sx, sz = -1 | +1) is dropped to road level: the top splits along the
 * diagonal through that corner, so both halves slope toward the crossing and the kerb face falls with them — a
 * diagonal curb cut at every zebra, for no extra triangles over a plain box.
 */
function cornerBox(gb: GeoBuilder, x0: number, z0: number, x1: number, z1: number, sx: number, sz: number): void {
  const H = CURB_H, D = STREET.cornerDip, t = TILE_M.sidewalk;
  // Top corners in the flat-quad winding, rotated so the dipped one comes first (it then sits on the split diagonal).
  const cx = [x0, x1, x1, x0], cz = [z1, z1, z0, z0];
  let k = 0;
  for (let i = 0; i < 4; i++) if ((cx[i] === x1) === (sx > 0) && (cz[i] === z1) === (sz > 0)) k = i;
  const px = [cx[k], cx[(k + 1) % 4], cx[(k + 2) % 4], cx[(k + 3) % 4]];
  const pz = [cz[k], cz[(k + 1) % 4], cz[(k + 2) % 4], cz[(k + 3) % 4]];
  const py = [D, H, H, H];
  gb.setColor(0xffffff);
  gb.quad(px[0], py[0], pz[0], px[1], py[1], pz[1], px[2], py[2], pz[2], px[3], py[3], pz[3], 0, 1, 0, px[0] / t, pz[0] / t, px[1] / t, pz[1] / t, px[2] / t, pz[2] / t, px[3] / t, pz[3] / t);
  // Side faces: each edge runs from corner i to corner i+1 with the top edge following the corner heights.
  gb.setColor(0xbdbdb8);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const ax = px[i], az = pz[i], bx = px[j], bz = pz[j];
    // Outward normal of the edge a->b (the polygon is CCW seen from above, so the outside is on its right).
    const ex = bx - ax, ez = bz - az, l = Math.hypot(ex, ez) || 1;
    const nx = -ez / l, nz = ex / l;
    gb.quad(ax, 0, az, bx, 0, bz, bx, py[j], bz, ax, py[i], az, nx, 0, nz, 0, 0, 0.02, 0, 0.02, 0.02, 0, 0.02);
  }
}

/** Painted decal quad centred at (cx, cz), `l` long along the heading (hx, hz) and `w` wide, mapped to an atlas cell (+v = heading). */
function decal(gb: GeoBuilder, cx: number, cz: number, hx: number, hz: number, w: number, l: number, y: number, uv: { u0: number; v0: number; u1: number; v1: number }): void {
  const rx = -hz * w / 2, rz = hx * w / 2, fx = hx * l / 2, fz = hz * l / 2;
  gb.quad(cx - fx + rx, y, cz - fz + rz, cx + fx + rx, y, cz + fz + rz, cx + fx - rx, y, cz + fz - rz, cx - fx - rx, y, cz - fz - rz,
    0, 1, 0, uv.u1, uv.v0, uv.u1, uv.v1, uv.u0, uv.v1, uv.u0, uv.v0);
}

const laneScratch: LanePos = { lane: 0, t: 0 };

export class CityRenderer {
  private readonly scene: THREE.Scene;
  private readonly city: CityData;
  private readonly roads: RoadGraph;
  private readonly materials: Materials;
  private readonly tex: TextureFactory;
  private readonly meshes: THREE.Object3D[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private props: PropRenderer | null = null;
  private ferris: THREE.Group | null = null;
  private beam: THREE.Mesh | null = null;
  private beamMat: THREE.MeshBasicMaterial | null = null;
  private lighthouse: Landmark | null = null;
  private _staticDraws = 0;

  constructor(scene: THREE.Scene, city: CityData, roads: RoadGraph, materials: Materials, tex: TextureFactory) {
    this.scene = scene;
    this.city = city;
    this.roads = roads;
    this.materials = materials;
    this.tex = tex;
  }

  /** Number of meshes this renderer contributes (one draw call each when visible). */
  get staticDraws(): number { return this._staticDraws; }

  private add(mesh: THREE.Mesh | THREE.Group, shadowCast: boolean, shadowReceive: boolean): void {
    mesh.castShadow = shadowCast;
    mesh.receiveShadow = shadowReceive;
    this.scene.add(mesh);
    this.meshes.push(mesh);
    this._staticDraws++;
  }

  private addGeo(g: THREE.BufferGeometry, m: THREE.Material, cast: boolean, receive: boolean): THREE.Mesh {
    this.geometries.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.add(mesh, cast, receive);
    return mesh;
  }

  build(): void {
    this.buildBuildings();
    this.buildLandmarks();
    // Roads, marks and sidewalks share builders with the parking lots (lot floors are asphalt, kerbs are kerb stone,
    // bay lines are paint) so the lots cost no draw calls of their own.
    const road = new GeoBuilder(), marks = new GeoBuilder(), walk = new GeoBuilder();
    this.buildRoads(road, marks);
    this.buildSidewalks(walk);
    this.buildLots(road, walk, marks);
    this.addGeo(road.build(), this.materials.road, false, true);
    this.addGeo(walk.build(), this.materials.sidewalk, false, true);
    const markMesh = this.addGeo(marks.build(), this.materials.roadMark, false, true);
    markMesh.renderOrder = 1;
    this.buildGround();
    this.props = new PropRenderer(this.scene, this.city.props, this.materials);
    this._staticDraws += this.props.drawCount;
    this.buildNeon();
  }

  /**
   * Whether a building gets a ground-floor band: its facing wall must hold the street (within STREET.bandMaxSetback
   * of the block edge — inner lots of a 3x3 grid face nothing) and its neon sign must not hang into the band.
   */
  private wantsStreetLevel(b: Building, blockIdx: number): boolean {
    if (blockIdx < 0) return false;
    const blk = this.city.blocks[blockIdx];
    const edge = b.facing === 0 ? blk.z1 - (b.z + b.d / 2) : b.facing === 2 ? (b.z - b.d / 2) - blk.z0 : b.facing === 1 ? blk.x1 - (b.x + b.w / 2) : (b.x - b.w / 2) - blk.x0;
    if (edge > STREET.bandMaxSetback) return false;
    if (b.hasNeonSign) {
      const signs = this.city.neonSigns;
      for (let i = 0; i < signs.length; i++) {
        const s = signs[i];
        if (Math.abs(s.x - b.x) > b.w / 2 + 1 || Math.abs(s.z - b.z) > b.d / 2 + 1) continue;
        if (s.y - s.h / 2 < BAND.shopH + 1) return false;
      }
    }
    return true;
  }

  private buildBuildings(): void {
    const builders: Record<string, GeoBuilder> = {};
    // Roof trim (parapets, clutter, crowns) is one plain mesh kept out of the shadow pass; every glow part of every
    // builder lands in one glow mesh; the ground-floor bands are two textured meshes (shopfront / downtown plinth).
    const trim = new GeoBuilder(), glow = new GeoBuilder(), shopBand = new GeoBuilder(), plinthBand = new GeoBuilder();
    trim.setGlowSink(glow);
    for (let i = 0; i < STYLES.length; i++) { builders[STYLES[i]] = new GeoBuilder(); builders[STYLES[i]].setGlowSink(glow); }
    const list = this.city.buildings;
    const blocks = this.city.blocks;
    const blockOf = new Int32Array(list.length).fill(-1);
    for (let i = 0; i < blocks.length; i++) for (let k = 0; k < blocks[i].buildings.length; k++) { const id = blocks[i].buildings[k]; if (id >= 0 && id < list.length) blockOf[id] = i; }
    // Seeded from the city so parapets, roof clutter, awnings and painted signs are identical for a given seed.
    const rng = new Random(this.city.seed ^ 0x5eed);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      appendBuilding(builders[b.style], b);
      appendBuildingDetail(builders[b.style], trim, b, rng, this.wallSigns);
      if (this.wantsStreetLevel(b, blockOf[b.id])) {
        const plinth = b.district === 'downtown';
        appendStreetLevel(builders[b.style], plinth ? plinthBand : shopBand, b, rng, plinth);
      }
    }
    for (let i = 0; i < STYLES.length; i++) {
      const gb = builders[STYLES[i]];
      if (gb.vertexCount === 0) continue;
      this.addGeo(gb.build(), this.materials.building[STYLES[i]], true, true);
    }
    if (trim.vertexCount > 0) this.addGeo(trim.build(), this.materials.plain, false, true);
    if (glow.vertexCount > 0) this.addGeo(glow.build(), this.materials.glow, false, true);
    if (shopBand.vertexCount > 0) this.addGeo(shopBand.build(), this.materials.shopfront, false, true);
    if (plinthBand.vertexCount > 0) this.addGeo(plinthBand.build(), this.materials.plinth, false, true);
  }

  /** Painted wall signs collected by the building detail pass, drawn with the neon atlas. */
  private readonly wallSigns: WallSign[] = [];

  private buildLandmarks(): void {
    const list = this.city.landmarks;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      const parts = landmarkGeometries(l);
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        const mat = p.style === 'glow' ? this.materials.glow : this.materials.building[p.style];
        if (p.rotating) {
          // All rotating parts of a landmark (wheel + its glow parts) share one group around the hub.
          let group = this.ferris;
          if (!group) {
            group = new THREE.Group();
            group.position.set(p.hubX, p.hubY, p.hubZ);
            this.add(group, true, false);
            this.ferris = group;
          }
          const mesh = new THREE.Mesh(p.geometry, mat);
          mesh.castShadow = true;
          group.add(mesh);
          this.geometries.push(p.geometry);
        } else {
          this.addGeo(p.geometry, mat, true, true);
        }
      }
      if (l.kind === 'lighthouse') this.lighthouse = l;
    }
    // Plaza fountains (Track A places a circle collider r 5 at each plaza center): one merged mesh.
    const fountains = new GeoBuilder();
    const blocks = this.city.blocks;
    let fountainCount = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.kind !== 'plaza') continue;
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, y = CITY_RENDER.blockY;
      fountains.cylinder(cx, cz, 5, 5, y, y + 0.9, 20, 0xd0c8d8, false, 0x48a8d8, GLOW_U.cyan);
      fountains.cylinder(cx, cz, 0.9, 0.9, y + 0.9, y + 3.2, 10, 0xb8b0c0, false, null);
      fountains.cylinder(cx, cz, 2.2, 2.2, y + 3.2, y + 3.6, 12, 0xd0c8d8, false, 0x48a8d8, GLOW_U.cyan);
      fountains.cylinder(cx, cz, 0.5, 0.5, y + 3.6, y + 5.0, 8, 0xb8b0c0, false, 0xff7a00, GLOW_U.orange);
      fountainCount++;
    }
    if (fountainCount > 0) {
      this.addGeo(fountains.build(), this.materials.building.concrete, true, true);
      if (fountains.glow) this.addGeo(fountains.glow.build(), this.materials.glow, true, true);
    }
    if (this.lighthouse) {
      const l = this.lighthouse;
      const g = new THREE.PlaneGeometry(90, 5, 1, 1);
      g.translate(45, 0, 0);
      this.beamMat = new THREE.MeshBasicMaterial({ map: this.tex.radialGlow(), color: 0xfff0b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
      const beam = new THREE.Mesh(g, this.beamMat);
      beam.position.set(l.x, l.h * 0.93, l.z);
      this.geometries.push(g);
      this.add(beam, false, false);
      this.beam = beam;
    }
  }

  /** Asphalt segments into `seg`, the crosswalk tiles as their own mesh, lane arrows + stop bars into `marks`. */
  private buildRoads(seg: GeoBuilder, marks: GeoBuilder): void {
    const cross = new GeoBuilder();
    const y = CITY_RENDER.roadY, H = ASPHALT_HALF, T = TILE_M.road;
    const nodes = this.roads.nodes, segments = this.roads.segments;
    seg.setColor(0xffffff);
    cross.setColor(0xffffff);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const a = nodes[s.a], b = nodes[s.b];
      if (s.axis === 0) {
        const xa = Math.min(a.x, b.x) + H, xb = Math.max(a.x, b.x) - H, z0 = a.z - H, z1 = a.z + H;
        // u across (z), v along (x)
        seg.quad(xa, y, z1, xb, y, z1, xb, y, z0, xa, y, z0, 0, 1, 0, 1, 0, 1, (xb - xa) / T, 0, (xb - xa) / T, 0, 0);
      } else {
        const za = Math.min(a.z, b.z) + H, zb = Math.max(a.z, b.z) - H, x0 = a.x - H, x1 = a.x + H;
        seg.quad(x0, y, zb, x1, y, zb, x1, y, za, x0, y, za, 0, 1, 0, 0, (zb - za) / T, 1, (zb - za) / T, 1, 0, 0, 0);
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      cross.quad(n.x - H, y, n.z + H, n.x + H, y, n.z + H, n.x + H, y, n.z - H, n.x - H, y, n.z - H, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 1);
    }
    this.addGeo(cross.build(), this.materials.crosswalk, false, true);
    // Painted approach marks: per lane an arrow cell before the crossing (inner lane straight, outer lane straight +
    // right; a lane running head-on into the city border gets none), per direction one stop bar across both lanes.
    const lanes = this.roads.lanes, cols = this.roads.cols, rows = this.roads.rows;
    marks.setColor(0xffffff);
    const my = CITY_RENDER.roadY + STREET.markY;
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      const to = nodes[l.to];
      const hx = l.dir.x, hz = l.dir.z, rx = -hz, rz = hx;
      const border = (to.col === 0 && hx < 0) || (to.col === cols && hx > 0) || (to.row === 0 && hz < 0) || (to.row === rows && hz > 0);
      if (!border) {
        const off = (l.index === 0 ? 0.5 : 1.5) * LANE_W;
        const ax = to.x - hx * STREET.arrowDist + rx * off, az = to.z - hz * STREET.arrowDist + rz * off;
        decal(marks, ax, az, hx, hz, STREET.arrowW, STREET.arrowL, my, l.index === 0 ? MARK_UV.ahead : MARK_UV.right);
      }
      if (l.index === 0) {
        const off = LANE_W + 0.25;
        decal(marks, to.x - hx * STREET.stopBarDist + rx * off, to.z - hz * STREET.stopBarDist + rz * off, hx, hz, STREET.stopBarW, STREET.stopBarL, my, MARK_UV.bar);
      }
    }
  }

  /** Block kerbs: four straight strips plus four corner squares whose outer corners dip to the zebra crossings. */
  private buildSidewalks(gb: GeoBuilder): void {
    const blocks = this.city.blocks;
    const S = SIDEWALK_W;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      curbBox(gb, b.x0, b.z0 - S, b.x1, b.z0);
      curbBox(gb, b.x0, b.z1, b.x1, b.z1 + S);
      curbBox(gb, b.x0 - S, b.z0, b.x0, b.z1);
      curbBox(gb, b.x1, b.z0, b.x1 + S, b.z1);
      cornerBox(gb, b.x0 - S, b.z0 - S, b.x0, b.z0, -1, -1);
      cornerBox(gb, b.x1, b.z0 - S, b.x1 + S, b.z0, 1, -1);
      cornerBox(gb, b.x0 - S, b.z1, b.x0, b.z1 + S, -1, 1);
      cornerBox(gb, b.x1, b.z1, b.x1 + S, b.z1 + S, 1, 1);
    }
    curbBox(gb, CITY_RENDER.promenadeX0, 0, CITY_RENDER.promenadeX1, CITY_MAX_Z);
  }

  /**
   * Off-street parking lots: an asphalt floor a hair above the block pavement (groundYAt keeps returning CURB_H),
   * a low kerb ring with a gate on the street side, one painted bay strip per parked-spot column and a continuous
   * wheel-stop kerb at the head of every strip.
   */
  private buildLots(road: GeoBuilder, walk: GeoBuilder, marks: GeoBuilder): void {
    const lots = this.city.lots;
    if (!lots) return;
    const blocks = this.city.blocks;
    const S = STREET;
    const fy = S.lotFloorY, ky = fy + S.lotKerbH, kw = S.lotKerbW;
    for (let i = 0; i < lots.length; i++) {
      const lot = lots[i];
      const x0 = lot.x - lot.w / 2, x1 = lot.x + lot.w / 2, z0 = lot.z - lot.d / 2, z1 = lot.z + lot.d / 2;
      road.setColor(0xffffff);
      flatQuad(road, x0, z0, x1, z1, fy, TILE_M.road);
      // Gate on the nearest block edge (the street the lot opens onto).
      const blk = blocks[lot.blockRow * GRID_COLS + lot.blockCol];
      const dS = blk.z1 - z1, dN = z0 - blk.z0, dE = blk.x1 - x1, dW = x0 - blk.x0;
      let gate = dN < dS ? 2 : 0, best = Math.min(dS, dN);
      if (dE < best) { best = dE; gate = 1; }
      if (dW < best) gate = 3;
      const g = S.lotGateW / 2;
      const gx0 = lot.x - g, gx1 = lot.x + g, gz0 = lot.z - g, gz1 = lot.z + g;
      // North / south rails (full width unless gated), then the east / west rails between them.
      if (gate === 2) { curbBox(walk, x0, z0, gx0, z0 + kw, fy, ky); curbBox(walk, gx1, z0, x1, z0 + kw, fy, ky); } else curbBox(walk, x0, z0, x1, z0 + kw, fy, ky);
      if (gate === 0) { curbBox(walk, x0, z1 - kw, gx0, z1, fy, ky); curbBox(walk, gx1, z1 - kw, x1, z1, fy, ky); } else curbBox(walk, x0, z1 - kw, x1, z1, fy, ky);
      if (gate === 3) { curbBox(walk, x0, z0 + kw, x0 + kw, gz0, fy, ky); curbBox(walk, x0, gz1, x0 + kw, z1 - kw, fy, ky); } else curbBox(walk, x0, z0 + kw, x0 + kw, z1 - kw, fy, ky);
      if (gate === 1) { curbBox(walk, x1 - kw, z0 + kw, x1, gz0, fy, ky); curbBox(walk, x1 - kw, gz1, x1, z1 - kw, fy, ky); } else curbBox(walk, x1 - kw, z0 + kw, x1, z1 - kw, fy, ky);
      this.paintBays(lot, walk, marks);
    }
  }

  /** Bay lines + wheel stops for one lot, following the heading of the nearest lane like the parked spots do. */
  private paintBays(lot: Lot, walk: GeoBuilder, marks: GeoBuilder): void {
    const S = STREET;
    this.roads.nearestLane(lot.x, lot.z, laneScratch);
    const dir = this.roads.lanes[laneScratch.lane].dir;
    const alongX = Math.abs(dir.x) >= Math.abs(dir.z);
    const hx = alongX ? Math.sign(dir.x) || 1 : 0, hz = alongX ? 0 : Math.sign(dir.z) || 1;
    // Strip columns run along the heading axis at the parked-spot pitch; bays step across it.
    const along0 = (alongX ? lot.x - lot.w / 2 : lot.z - lot.d / 2) + S.stripInset, along1 = (alongX ? lot.x + lot.w / 2 : lot.z + lot.d / 2) - S.stripInset;
    const across0 = (alongX ? lot.z - lot.d / 2 : lot.x - lot.w / 2) + S.stripInset, across1 = (alongX ? lot.z + lot.d / 2 : lot.x + lot.w / 2) - S.stripInset;
    const y = S.lotFloorY + 0.01, half = S.bayLen / 2;
    marks.setColor(0xffffff);
    for (let a = along0; a <= along1 + 1e-6; a += S.stripPitch) {
      const c0 = across0 - S.bayPitch / 2;
      let c = c0;
      for (; c <= across1 + S.bayPitch / 2 + 1e-6; c += S.bayPitch) {
        const px = alongX ? a : c, pz = alongX ? c : a;
        decal(marks, px, pz, hx, hz, S.bayLineW, S.bayLen, y, MARK_UV.bar);
      }
      const cEnd = c - S.bayPitch;
      // Wheel-stop kerb at the head of the strip, spanning every bay in it.
      const headA = a + (alongX ? hx : hz) * (half - 0.35);
      const lo = Math.min(c0, cEnd), hi = Math.max(c0, cEnd);
      if (alongX) curbBox(walk, headA - S.wheelStopW / 2, lo, headA + S.wheelStopW / 2, hi, S.lotFloorY, S.lotFloorY + S.wheelStopH);
      else curbBox(walk, lo, headA - S.wheelStopW / 2, hi, headA + S.wheelStopW / 2, S.lotFloorY, S.lotFloorY + S.wheelStopH);
    }
  }

  private buildGround(): void {
    const m = this.materials;
    const pavement = new GeoBuilder(), grass = new GeoBuilder(), plaza = new GeoBuilder();
    const blocks = this.city.blocks;
    const y = CITY_RENDER.blockY;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const gb = b.kind === 'park' ? grass : b.kind === 'plaza' ? plaza : pavement;
      const tile = b.kind === 'park' ? TILE_M.grass : b.kind === 'plaza' ? TILE_M.plaza : TILE_M.pavement;
      gb.setColor(0xffffff);
      flatQuad(gb, b.x0, b.z0, b.x1, b.z1, y, tile);
    }
    this.addGeo(pavement.build(), m.pavement, false, true);
    this.addGeo(grass.build(), m.grass, false, true);
    this.addGeo(plaza.build(), m.plaza, false, true);
    // Dirt ground under everything.
    const dirt = new GeoBuilder();
    flatQuad(dirt, -80, -80, CITY_MAX_X + 20, CITY_MAX_Z + 80, CITY_RENDER.groundY, 50);
    this.addGeo(dirt.build(), m.dirt, false, true);
    // Beach: flat sand then a shoreline slope down under the water line.
    const sand = new GeoBuilder();
    sand.setColor(0xffffff);
    const ts = TILE_M.sand, sx0 = CITY_RENDER.promenadeX0, sx1 = OCEAN_X0 - 12, sx2 = OCEAN_X0 + 16, sz0 = -80, sz1 = CITY_MAX_Z + 80;
    flatQuad(sand, sx0, sz0, sx1, sz1, 0, ts);
    sand.quad(sx1, 0, sz1, sx2, -0.6, sz1, sx2, -0.6, sz0, sx1, 0, sz0, -0.02, 1, 0, sx1 / ts, sz1 / ts, sx2 / ts, sz1 / ts, sx2 / ts, sz0 / ts, sx1 / ts, sz0 / ts);
    this.addGeo(sand.build(), m.sand, false, true);
    const ocean = new GeoBuilder();
    ocean.setColor(0xffffff);
    const ox0 = OCEAN_X0 - 40, oz0 = CITY_MAX_Z / 2 - OCEAN_SIZE / 2;
    flatQuad(ocean, ox0, oz0, ox0 + OCEAN_SIZE, oz0 + OCEAN_SIZE, CITY_RENDER.oceanY, TILE_M.water);
    this.addGeo(ocean.build(), m.water, false, false);
  }

  private buildNeon(): void {
    const signs = this.city.neonSigns;
    if (signs.length === 0 && this.wallSigns.length === 0) return;
    const atlas = this.tex.neonAtlas(SIGN_WORDS);
    const gb = new GeoBuilder();
    // Big painted words on blank side walls: same atlas, picked by the detail pass's word index.
    for (let i = 0; i < this.wallSigns.length; i++) {
      const s = this.wallSigns[i];
      const rect = atlas.rects.get(SIGN_WORDS[s.word % SIGN_WORDS.length]);
      if (!rect) continue;
      const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
      const nx = Math.sin(s.yaw), nz = Math.cos(s.yaw);
      const hw = s.w / 2, hh = s.h / 2;
      gb.setColor(s.color);
      gb.quad(s.x - rx * hw, s.y - hh, s.z - rz * hw, s.x + rx * hw, s.y - hh, s.z + rz * hw, s.x + rx * hw, s.y + hh, s.z + rz * hw, s.x - rx * hw, s.y + hh, s.z - rz * hw,
        nx, 0, nz, rect.u0, rect.v0, rect.u1, rect.v0, rect.u1, rect.v1, rect.u0, rect.v1);
    }
    for (let i = 0; i < signs.length; i++) {
      const s = signs[i];
      const rect = atlas.rects.get(s.text);
      if (!rect) continue;
      const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw); // local +X in world
      const nx = Math.sin(s.yaw), nz = Math.cos(s.yaw);
      const hw = s.w / 2, hh = s.h / 2;
      gb.setColor(s.color);
      gb.quad(s.x - rx * hw, s.y - hh, s.z - rz * hw, s.x + rx * hw, s.y - hh, s.z + rz * hw, s.x + rx * hw, s.y + hh, s.z + rz * hw, s.x - rx * hw, s.y + hh, s.z - rz * hw,
        nx, 0, nz, rect.u0, rect.v0, rect.u1, rect.v0, rect.u1, rect.v1, rect.u0, rect.v1);
    }
    const mesh = this.addGeo(gb.build(), this.materials.neon(atlas.texture), false, false);
    mesh.renderOrder = 3;
  }

  /** Per-frame: ferris rotation, lighthouse beam, water scroll and night-driven materials. */
  update(time: number, nightFactor: number, playerX: number, playerZ: number): void {
    this.materials.setNight(nightFactor);
    this.materials.update(time);
    if (this.props) this.props.update(playerX, playerZ);
    if (this.ferris) this.ferris.rotation.x = time * CITY_RENDER.ferrisRate;
    if (this.beam && this.beamMat) {
      this.beam.rotation.y = time * CITY_RENDER.beamRate;
      this.beamMat.opacity = nightFactor * 0.45;
      this.beam.visible = nightFactor > 0.02;
    }
  }

  dispose(): void {
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      if (m.parent) m.parent.remove(m);
    }
    for (let i = 0; i < this.geometries.length; i++) this.geometries[i].dispose();
    if (this.props) this.props.dispose();
    if (this.beamMat) this.beamMat.dispose();
    this.meshes.length = 0;
    this.geometries.length = 0;
    this._staticDraws = 0;
  }
}
