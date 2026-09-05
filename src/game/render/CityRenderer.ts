// Static city rendering: merged buildings per style, landmarks, roads, sidewalks, ground/park/plaza/beach/ocean, props, neon signs. Track B.
import * as THREE from 'three';
import type { CityData, Landmark } from '../city/CityData';
import type { RoadGraph } from '../city/RoadGraph';
import { CITY_MAX_X, CITY_MAX_Z, CURB_H, OCEAN_SIZE, OCEAN_X0, SIDEWALK_W } from '../city/CityConfig';
import { SIGN_WORDS } from '../city/Palette';
import type { Materials } from './Materials';
import { STYLES, TILE_M } from './Materials';
import type { TextureFactory } from './TextureFactory';
import { GLOW_U } from './TextureFactory';
import { GeoBuilder, appendBuilding, landmarkGeometries } from './BuildingGeometry';
import { PropRenderer } from './CityRendererProps';

/** Asphalt half width: ROAD_W/2 - SIDEWALK_W = 7 m (curbs cover the rest). */
export const ASPHALT_HALF = 7;
export const CITY_RENDER = { groundY: -0.05, roadY: 0, blockY: CURB_H, oceanY: -0.3, promenadeX0: CITY_MAX_X - SIDEWALK_W, promenadeX1: CITY_MAX_X + 14, ferrisRate: 0.15, beamRate: 0.6 } as const;

/** Flat quad on the XZ plane with UVs in meters / tile (u along X, v along Z) at height y. */
function flatQuad(gb: GeoBuilder, x0: number, z0: number, x1: number, z1: number, y: number, tile: number): void {
  gb.quad(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0, 0, 1, 0, x0 / tile, z1 / tile, x1 / tile, z1 / tile, x1 / tile, z0 / tile, x0 / tile, z0 / tile);
}

/** Curb box: textured top (meters / tile) + plain sides, from y = 0 to CURB_H. */
function curbBox(gb: GeoBuilder, x0: number, z0: number, x1: number, z1: number): void {
  const h = CURB_H, t = TILE_M.sidewalk;
  gb.setColor(0xffffff);
  gb.quad(x0, h, z1, x1, h, z1, x1, h, z0, x0, h, z0, 0, 1, 0, x0 / t, z1 / t, x1 / t, z1 / t, x1 / t, z0 / t, x0 / t, z0 / t);
  gb.setColor(0xbdbdb8);
  gb.quad(x0, 0, z1, x1, 0, z1, x1, h, z1, x0, h, z1, 0, 0, 1, 0, 0, 0.02, 0, 0.02, 0.02, 0, 0.02);
  gb.quad(x1, 0, z0, x0, 0, z0, x0, h, z0, x1, h, z0, 0, 0, -1, 0, 0, 0.02, 0, 0.02, 0.02, 0, 0.02);
  gb.quad(x1, 0, z1, x1, 0, z0, x1, h, z0, x1, h, z1, 1, 0, 0, 0, 0, 0.02, 0, 0.02, 0.02, 0, 0.02);
  gb.quad(x0, 0, z0, x0, 0, z1, x0, h, z1, x0, h, z0, -1, 0, 0, 0, 0, 0.02, 0, 0.02, 0.02, 0, 0.02);
}

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
    this.buildRoads();
    this.buildSidewalks();
    this.buildGround();
    this.props = new PropRenderer(this.scene, this.city.props, this.materials);
    this._staticDraws += this.props.drawCount;
    this.buildNeon();
  }

  private buildBuildings(): void {
    const builders: Record<string, GeoBuilder> = {};
    for (let i = 0; i < STYLES.length; i++) builders[STYLES[i]] = new GeoBuilder();
    const list = this.city.buildings;
    for (let i = 0; i < list.length; i++) appendBuilding(builders[list[i].style], list[i]);
    for (let i = 0; i < STYLES.length; i++) {
      const gb = builders[STYLES[i]];
      if (gb.vertexCount === 0) continue;
      this.addGeo(gb.build(), this.materials.building[STYLES[i]], true, true);
    }
  }

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

  private buildRoads(): void {
    const seg = new GeoBuilder(), cross = new GeoBuilder();
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
    this.addGeo(seg.build(), this.materials.road, false, true);
    this.addGeo(cross.build(), this.materials.crosswalk, false, true);
  }

  private buildSidewalks(): void {
    const gb = new GeoBuilder();
    const blocks = this.city.blocks;
    const S = SIDEWALK_W;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      curbBox(gb, b.x0 - S, b.z0 - S, b.x1 + S, b.z0);
      curbBox(gb, b.x0 - S, b.z1, b.x1 + S, b.z1 + S);
      curbBox(gb, b.x0 - S, b.z0, b.x0, b.z1);
      curbBox(gb, b.x1, b.z0, b.x1 + S, b.z1);
    }
    curbBox(gb, CITY_RENDER.promenadeX0, 0, CITY_RENDER.promenadeX1, CITY_MAX_Z);
    this.addGeo(gb.build(), this.materials.sidewalk, false, true);
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
    if (signs.length === 0) return;
    const atlas = this.tex.neonAtlas(SIGN_WORDS);
    const gb = new GeoBuilder();
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
