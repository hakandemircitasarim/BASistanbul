// Shared material set (lit Lambert surfaces, emissive windows, water, neon, additive lamp/marker materials) driven by a night factor. Track B.
import * as THREE from 'three';
import type { BuildingStyle } from '../city/CityData';
import { clamp } from '../core/math';
import type { TextureFactory } from './TextureFactory';
import { ROAD_TILE_M } from './TextureFactory';

export const STYLES: readonly BuildingStyle[] = ['artdeco', 'glass', 'concrete', 'neon', 'residential'];
/** Sidewalk/sand/grass/plaza texture tile sizes in meters (UVs are world meters / tile). */
export const TILE_M = { road: ROAD_TILE_M, sidewalk: 4, sand: 12, water: 40, grass: 8, plaza: 8, pavement: 6 } as const;

const WINDOW_EMISSIVE_MAX = 1.0;
const GLOW_EMISSIVE_MAX = 1.3;
const NEON_MIN_OPACITY = 0.15;

export class Materials {
  private _night = 0;
  readonly building: Record<BuildingStyle, THREE.MeshLambertMaterial>;
  /** Vertex-colored Lambert without maps (landmark plain parts, sidewalk curbs, props). */
  readonly plain: THREE.MeshLambertMaterial;
  /** Vertex-colored Lambert whose emissive map is the glow atlas: landmark neon rings/bars/gondolas light up at night. */
  readonly glow: THREE.MeshLambertMaterial;
  readonly road: THREE.MeshLambertMaterial;
  readonly crosswalk: THREE.MeshLambertMaterial;
  readonly sidewalk: THREE.MeshLambertMaterial;
  readonly sand: THREE.MeshLambertMaterial;
  readonly grass: THREE.MeshLambertMaterial;
  readonly plaza: THREE.MeshLambertMaterial;
  readonly pavement: THREE.MeshLambertMaterial;
  readonly dirt: THREE.MeshLambertMaterial;
  readonly water: THREE.MeshPhongMaterial;
  readonly palmTrunk: THREE.MeshLambertMaterial;
  readonly palmFrond: THREE.MeshLambertMaterial;
  readonly lampPole: THREE.MeshLambertMaterial;
  readonly bench: THREE.MeshLambertMaterial;
  readonly hydrant: THREE.MeshLambertMaterial;
  private readonly lampHeadMat: THREE.MeshBasicMaterial;
  private readonly lightPoolMat: THREE.MeshBasicMaterial;
  private neonMat: THREE.MeshBasicMaterial | null = null;
  private readonly markers: THREE.MeshBasicMaterial[] = [];
  private readonly lampDay = new THREE.Color(0x6a6a70);
  private readonly lampNight = new THREE.Color(0xfff2c8);
  private carPaintMat: THREE.MeshLambertMaterial | null = null;
  private glassMat: THREE.MeshLambertMaterial | null = null;

  constructor(tex: TextureFactory) {
    this.building = {} as Record<BuildingStyle, THREE.MeshLambertMaterial>;
    for (let i = 0; i < STYLES.length; i++) {
      const style = STYLES[i];
      const w = tex.windows(style, i + 1);
      this.building[style] = new THREE.MeshLambertMaterial({ vertexColors: true, map: w.map, emissiveMap: w.emissive, emissive: 0xffffff, emissiveIntensity: 0 });
    }
    this.plain = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.glow = new THREE.MeshLambertMaterial({ vertexColors: true, emissiveMap: tex.glowAtlas(), emissive: 0xffffff, emissiveIntensity: 0 });
    this.road = new THREE.MeshLambertMaterial({ map: tex.road() });
    this.crosswalk = new THREE.MeshLambertMaterial({ map: tex.crosswalk() });
    this.sidewalk = new THREE.MeshLambertMaterial({ map: tex.sidewalk() });
    this.sand = new THREE.MeshLambertMaterial({ map: tex.sand() });
    this.grass = new THREE.MeshLambertMaterial({ map: tex.grass() });
    this.plaza = new THREE.MeshLambertMaterial({ map: tex.plaza() });
    this.pavement = new THREE.MeshLambertMaterial({ map: tex.sidewalk(), color: 0x8d8a86 });
    this.dirt = new THREE.MeshLambertMaterial({ color: 0x3d3f44 });
    const wt = tex.water();
    this.water = new THREE.MeshPhongMaterial({ map: wt, color: 0x9fd8ff, specular: 0xffffff, shininess: 80, transparent: true, opacity: 0.92 });
    this.palmTrunk = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });
    this.palmFrond = new THREE.MeshLambertMaterial({ map: tex.palmFrond(), alphaTest: 0.5, side: THREE.DoubleSide, color: 0xc8e8a0 });
    this.lampPole = new THREE.MeshLambertMaterial({ color: 0x3a3d44 });
    this.bench = new THREE.MeshLambertMaterial({ color: 0x8a5a30 });
    this.hydrant = new THREE.MeshLambertMaterial({ color: 0xd8302a });
    this.lampHeadMat = new THREE.MeshBasicMaterial({ color: 0x6a6a70, fog: false, toneMapped: false });
    this.lightPoolMat = new THREE.MeshBasicMaterial({ map: tex.radialGlow(), color: 0xffc070, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
    this.setNight(0);
  }

  get nightFactor(): number { return this._night; }

  /** White Lambert; InstancedMesh instanceColor tints the paint. */
  carPaint(): THREE.MeshLambertMaterial {
    if (!this.carPaintMat) this.carPaintMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    return this.carPaintMat;
  }

  glass(): THREE.MeshLambertMaterial {
    if (!this.glassMat) this.glassMat = new THREE.MeshLambertMaterial({ color: 0x1c2a3a, transparent: true, opacity: 0.85 });
    return this.glassMat;
  }

  /** Neon sign atlas material: additive, vertex-tinted, opacity follows the night factor (min 0.15 by day). */
  neon(atlasTex: THREE.Texture): THREE.MeshBasicMaterial {
    if (!this.neonMat) {
      this.neonMat = new THREE.MeshBasicMaterial({ map: atlasTex, vertexColors: true, transparent: true, opacity: NEON_MIN_OPACITY, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
      this.applyNight();
    }
    return this.neonMat;
  }

  lampHead(): THREE.MeshBasicMaterial { return this.lampHeadMat; }

  lightPool(): THREE.MeshBasicMaterial { return this.lightPoolMat; }

  /** Additive, unlit marker material for mission cylinders/arrows. */
  marker(color: number): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
    this.markers.push(m);
    return m;
  }

  /** 0 = day, 1 = night: window emissive, neon opacity, lamp heads and light pools. */
  setNight(f: number): void {
    this._night = clamp(f, 0, 1);
    this.applyNight();
  }

  private applyNight(): void {
    const n = this._night;
    for (let i = 0; i < STYLES.length; i++) this.building[STYLES[i]].emissiveIntensity = n * WINDOW_EMISSIVE_MAX;
    this.glow.emissiveIntensity = n * GLOW_EMISSIVE_MAX;
    if (this.neonMat) this.neonMat.opacity = Math.max(NEON_MIN_OPACITY, n);
    this.lampHeadMat.color.lerpColors(this.lampDay, this.lampNight, n);
    this.lightPoolMat.opacity = n * 0.85;
  }

  /** Scrolls the water UVs. */
  update(t: number): void {
    const map = this.water.map;
    if (map) {
      map.offset.x = (t * 0.008) % 1;
      map.offset.y = (t * 0.005) % 1;
    }
  }

  dispose(): void {
    for (let i = 0; i < STYLES.length; i++) this.building[STYLES[i]].dispose();
    this.plain.dispose(); this.glow.dispose(); this.road.dispose(); this.crosswalk.dispose(); this.sidewalk.dispose(); this.sand.dispose();
    this.grass.dispose(); this.plaza.dispose(); this.pavement.dispose(); this.dirt.dispose(); this.water.dispose();
    this.palmTrunk.dispose(); this.palmFrond.dispose(); this.lampPole.dispose(); this.bench.dispose(); this.hydrant.dispose();
    this.lampHeadMat.dispose(); this.lightPoolMat.dispose();
    if (this.neonMat) this.neonMat.dispose();
    if (this.carPaintMat) this.carPaintMat.dispose();
    if (this.glassMat) this.glassMat.dispose();
    for (let i = 0; i < this.markers.length; i++) this.markers[i].dispose();
    this.markers.length = 0;
  }
}
