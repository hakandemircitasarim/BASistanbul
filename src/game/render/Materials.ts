// Shared material set (lit PBR surfaces, emissive windows/shopfronts, water, neon + bloom, additive lamp/marker materials) driven by a night factor. Track B.
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
/** Shop interiors stay a little lit in daylight so the street level never reads as dead. */
const SHOP_EMISSIVE_DAY = 0.16;
const SHOP_EMISSIVE_NIGHT = 1.05;
const PLINTH_EMISSIVE_NIGHT = 0.85;

/**
 * Roughness / metalness / sky-probe strength per surface family. Everything lit is MeshStandardMaterial so the PMREM
 * sky probe actually shows up: without a specular term the whole city answers light identically and reads flat.
 */
const SURF = {
  building: { roughness: 1, metalness: 0.04, env: 0.75 },
  plain: { roughness: 0.88, metalness: 0.05, env: 0.5 },
  road: { roughnessDay: 1, roughnessNight: 0.6, metalness: 0.03, env: 0.45 },
  ground: { roughness: 0.94, metalness: 0, env: 0.35 },
  sand: { roughness: 0.97, metalness: 0, env: 0.25 },
  metal: { roughness: 0.42, metalness: 0.8, env: 1.0 },
  paint: { roughness: 0.55, metalness: 0.25, env: 0.8 },
  wood: { roughness: 0.78, metalness: 0, env: 0.4 },
  foliage: { roughness: 0.8, metalness: 0, env: 0.35 },
} as const;

export class Materials {
  private _night = 0;
  readonly building: Record<BuildingStyle, THREE.MeshStandardMaterial>;
  /** Vertex-colored, map-less surface (landmark plain parts, sidewalk curbs, props). */
  readonly plain: THREE.MeshStandardMaterial;
  /** Vertex-colored surface whose emissive map is the glow atlas: landmark neon rings/bars/gondolas and traffic lamps light up at night. */
  readonly glow: THREE.MeshStandardMaterial;
  /** Ground-floor shopfront band (beachfront/suburb): glazing + fascias, warm interiors at night. */
  readonly shopfront: THREE.MeshStandardMaterial;
  /** Ground-floor stone plinth band (downtown): pilasters + recessed lobby glazing. */
  readonly plinth: THREE.MeshStandardMaterial;
  readonly road: THREE.MeshStandardMaterial;
  readonly crosswalk: THREE.MeshStandardMaterial;
  /** Painted lane arrows / stop bars laid on the asphalt (alpha-tested decals). */
  readonly roadMark: THREE.MeshStandardMaterial;
  readonly sidewalk: THREE.MeshStandardMaterial;
  readonly sand: THREE.MeshStandardMaterial;
  readonly grass: THREE.MeshStandardMaterial;
  readonly plaza: THREE.MeshStandardMaterial;
  readonly pavement: THREE.MeshStandardMaterial;
  readonly dirt: THREE.MeshStandardMaterial;
  readonly water: THREE.MeshPhongMaterial;
  /** Surf line where the sea meets the sand (scrolls in update). */
  readonly foam: THREE.MeshStandardMaterial;
  /** Shared vertex-coloured material for the multi-part street furniture (bins, signs, shelters, bollards). */
  readonly furniture: THREE.MeshStandardMaterial;
  readonly palmTrunk: THREE.MeshStandardMaterial;
  readonly palmFrond: THREE.MeshStandardMaterial;
  readonly lampPole: THREE.MeshStandardMaterial;
  readonly bench: THREE.MeshStandardMaterial;
  readonly hydrant: THREE.MeshStandardMaterial;
  private readonly lampHeadMat: THREE.MeshBasicMaterial;
  private readonly lightPoolMat: THREE.MeshBasicMaterial;
  private neonMat: THREE.MeshBasicMaterial | null = null;
  private neonBloomMat: THREE.MeshBasicMaterial | null = null;
  private readonly bloomTex: THREE.Texture;
  private readonly markers: THREE.MeshBasicMaterial[] = [];
  private readonly lampDay = new THREE.Color(0x6a6a70);
  private readonly lampNight = new THREE.Color(0xfff2c8);
  private glassMat: THREE.MeshStandardMaterial | null = null;

  constructor(tex: TextureFactory) {
    this.building = {} as Record<BuildingStyle, THREE.MeshStandardMaterial>;
    for (let i = 0; i < STYLES.length; i++) {
      const style = STYLES[i];
      const w = tex.windows(style, i + 1);
      this.building[style] = new THREE.MeshStandardMaterial({
        vertexColors: true, map: w.map, emissiveMap: w.emissive, emissive: 0xffffff, emissiveIntensity: 0,
        // Per-pixel relief so windows read as recessed instead of painted on a flat slab, plus a roughness map so
        // the glazing catches the sky and the render around it does not.
        normalMap: w.normal, normalScale: new THREE.Vector2(0.75, 0.75), roughnessMap: w.rough,
        roughness: SURF.building.roughness, metalness: SURF.building.metalness, envMapIntensity: SURF.building.env,
      });
    }
    this.plain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: SURF.plain.roughness, metalness: SURF.plain.metalness, envMapIntensity: SURF.plain.env });
    this.glow = new THREE.MeshStandardMaterial({ vertexColors: true, emissiveMap: tex.glowAtlas(), emissive: 0xffffff, emissiveIntensity: 0, roughness: SURF.plain.roughness, metalness: SURF.plain.metalness, envMapIntensity: SURF.plain.env });
    const shop = tex.shopfront();
    this.shopfront = new THREE.MeshStandardMaterial({
      vertexColors: true, map: shop.map, emissiveMap: shop.emissive, emissive: 0xffffff, emissiveIntensity: SHOP_EMISSIVE_DAY,
      normalMap: shop.normal, normalScale: new THREE.Vector2(0.9, 0.9), roughnessMap: shop.rough,
      roughness: SURF.building.roughness, metalness: SURF.building.metalness, envMapIntensity: SURF.building.env,
    });
    const pl = tex.plinth();
    this.plinth = new THREE.MeshStandardMaterial({
      vertexColors: true, map: pl.map, emissiveMap: pl.emissive, emissive: 0xffffff, emissiveIntensity: 0,
      normalMap: pl.normal, normalScale: new THREE.Vector2(0.9, 0.9), roughnessMap: pl.rough,
      roughness: SURF.building.roughness, metalness: SURF.building.metalness, envMapIntensity: SURF.building.env,
    });
    const roadMap = tex.road();
    this.road = new THREE.MeshStandardMaterial({
      map: roadMap, roughnessMap: tex.roadRough(), roughness: SURF.road.roughnessDay,
      metalness: SURF.road.metalness, envMapIntensity: SURF.road.env,
    });
    this.crosswalk = new THREE.MeshStandardMaterial({ map: tex.crosswalk(), roughness: 0.8, metalness: SURF.road.metalness, envMapIntensity: SURF.road.env });
    this.roadMark = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05, envMapIntensity: SURF.road.env, map: tex.roadMarks(), transparent: true, alphaTest: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -6 });
    this.sidewalk = new THREE.MeshStandardMaterial({ map: tex.sidewalk(), roughness: SURF.ground.roughness, metalness: SURF.ground.metalness, envMapIntensity: SURF.ground.env });
    this.sand = new THREE.MeshStandardMaterial({ map: tex.sand(), roughness: SURF.sand.roughness, metalness: 0, envMapIntensity: SURF.sand.env });
    this.grass = new THREE.MeshStandardMaterial({ map: tex.grass(), roughness: SURF.ground.roughness, metalness: 0, envMapIntensity: SURF.ground.env });
    this.plaza = new THREE.MeshStandardMaterial({ map: tex.plaza(), roughness: 0.86, metalness: 0.05, envMapIntensity: SURF.ground.env });
    this.pavement = new THREE.MeshStandardMaterial({ map: tex.sidewalk(), color: 0x8d8a86, roughness: SURF.ground.roughness, metalness: 0.05, envMapIntensity: SURF.ground.env });
    this.dirt = new THREE.MeshStandardMaterial({ color: 0x3d3f44, roughness: SURF.ground.roughness, metalness: 0, envMapIntensity: SURF.ground.env });
    const wt = tex.water();
    this.water = new THREE.MeshPhongMaterial({ map: wt, normalMap: tex.waterNormal(), color: 0x9fd8ff, specular: 0xffffff, shininess: 80, transparent: true, opacity: 0.92 });
    this.water.normalScale.set(0.45, 0.45);
    const wn = this.water.normalMap;
    if (wn) wn.repeat.set(3, 3);
    this.foam = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0, map: tex.foam(), color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide });
    this.furniture = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: SURF.paint.roughness, metalness: SURF.paint.metalness, envMapIntensity: SURF.paint.env });
    this.palmTrunk = new THREE.MeshStandardMaterial({ color: 0xa8814f, roughness: 0.9, metalness: 0, envMapIntensity: SURF.foliage.env });
        // Front side only: the frond geometry carries its own back faces, whose normals still point at the sky. With
    // DoubleSide three flips the normal on back faces, so at midday every frond seen from below turned black.
    this.palmFrond = new THREE.MeshStandardMaterial({ map: tex.palmFrond(), alphaTest: 0.34, side: THREE.FrontSide, color: 0xdcecc4, roughness: SURF.foliage.roughness, metalness: 0, envMapIntensity: SURF.foliage.env });
    // Alpha-to-coverage lets the MSAA resolve feather the leaf edges instead of the hard alpha-test stair-step.
    this.palmFrond.alphaToCoverage = true;
    this.lampPole = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: SURF.metal.roughness, metalness: SURF.metal.metalness, envMapIntensity: SURF.metal.env });
    this.bench = new THREE.MeshStandardMaterial({ color: 0x8a5a30, roughness: SURF.wood.roughness, metalness: 0, envMapIntensity: SURF.wood.env });
    this.hydrant = new THREE.MeshStandardMaterial({ color: 0xd8302a, roughness: SURF.paint.roughness, metalness: SURF.paint.metalness, envMapIntensity: SURF.paint.env });
    this.lampHeadMat = new THREE.MeshBasicMaterial({ color: 0x6a6a70, fog: false, toneMapped: false });
    this.lightPoolMat = new THREE.MeshBasicMaterial({ map: tex.radialGlow(), color: 0xffc070, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
    this.bloomTex = tex.radialGlow();
    // Macro scale is expressed against each surface's own tile size, so all of them break up at roughly 45 m.
    const macro = tex.clouds();
    const macroFor = (tile: number): number => tile / 45;
    this.macroVariation(this.road, macro, macroFor(TILE_M.road), 0.2);
    this.macroVariation(this.sidewalk, macro, macroFor(TILE_M.sidewalk), 0.16);
    this.macroVariation(this.plaza, macro, macroFor(TILE_M.plaza), 0.16);
    this.macroVariation(this.pavement, macro, macroFor(TILE_M.pavement), 0.16);
    this.macroVariation(this.sand, macro, macroFor(TILE_M.sand), 0.12);
    this.macroVariation(this.grass, macro, macroFor(TILE_M.grass), 0.22);
    this.setNight(0);
  }

  /**
   * Breaks up tiling on the big ground surfaces. Road, pavement and sand repeat every few metres, and a texture that
   * obviously repeats is one of the strongest "old game" cues there is. A second, very low-frequency noise multiplied
   * into the albedo hides the grid without a second UV set or extra geometry.
   */
  private macroVariation(m: THREE.MeshStandardMaterial, macro: THREE.Texture, scale: number, amount: number): void {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uMacro = { value: macro };
      shader.uniforms.uMacroScale = { value: scale };
      shader.uniforms.uMacroAmt = { value: amount };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uMacro;\nuniform float uMacroScale;\nuniform float uMacroAmt;')
        .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float macro = texture2D( uMacro, vMapUv * uMacroScale ).r;
          diffuseColor.rgb *= 1.0 + uMacroAmt * (macro * 2.0 - 1.0);
        }`);
    };
    m.customProgramCacheKey = () => 'macro' + scale.toFixed(4) + amount.toFixed(3);
  }

  get nightFactor(): number { return this._night; }

  glass(): THREE.MeshStandardMaterial {
    if (!this.glassMat) this.glassMat = new THREE.MeshStandardMaterial({ color: 0x14202e, metalness: 0.95, roughness: 0.08, envMapIntensity: 1.4, transparent: true, opacity: 0.86 });
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

  /** Cheap fake bloom: oversized additive halo quads behind the neon signs (no postprocessing). */
  neonBloom(): THREE.MeshBasicMaterial {
    if (!this.neonBloomMat) {
      this.neonBloomMat = new THREE.MeshBasicMaterial({ map: this.bloomTex, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
      this.applyNight();
    }
    return this.neonBloomMat;
  }

  lampHead(): THREE.MeshBasicMaterial { return this.lampHeadMat; }

  lightPool(): THREE.MeshBasicMaterial { return this.lightPoolMat; }

  /** Additive, unlit marker material for mission cylinders/arrows. */
  marker(color: number): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
    this.markers.push(m);
    return m;
  }

  /** 0 = day, 1 = night: window emissive, shopfront/plinth glow, neon opacity + bloom, lamp heads and light pools. */
  setNight(f: number): void {
    this._night = clamp(f, 0, 1);
    this.applyNight();
  }

  private applyNight(): void {
    const n = this._night;
    for (let i = 0; i < STYLES.length; i++) this.building[STYLES[i]].emissiveIntensity = n * WINDOW_EMISSIVE_MAX;
    this.glow.emissiveIntensity = n * GLOW_EMISSIVE_MAX;
    this.shopfront.emissiveIntensity = SHOP_EMISSIVE_DAY + n * (SHOP_EMISSIVE_NIGHT - SHOP_EMISSIVE_DAY);
    this.plinth.emissiveIntensity = n * PLINTH_EMISSIVE_NIGHT;
    if (this.neonMat) this.neonMat.opacity = Math.max(NEON_MIN_OPACITY, n);
    if (this.neonBloomMat) this.neonBloomMat.opacity = 0.05 + n * 0.5;
    this.lampHeadMat.color.lerpColors(this.lampDay, this.lampNight, n);
    this.lightPoolMat.opacity = n * 0.85;
    // Damp asphalt after dark: dropping the road's roughness lets the sky probe, the lamps and the neon smear along
    // the street the way a wet Vice City night does, without any reflection pass.
    this.road.roughness = SURF.road.roughnessDay + n * (SURF.road.roughnessNight - SURF.road.roughnessDay);
    this.crosswalk.roughness = 0.8 - n * 0.22;
  }

  /** Scrolls the water albedo/normal UVs (opposite drifts give a moving specular) and the surf line. */
  update(t: number): void {
    const map = this.water.map;
    if (map) {
      map.offset.x = (t * 0.008) % 1;
      map.offset.y = (t * 0.005) % 1;
    }
    const nrm = this.water.normalMap;
    if (nrm) {
      nrm.offset.x = (-t * 0.013) % 1;
      nrm.offset.y = (t * 0.021) % 1;
    }
    const fm = this.foam.map;
    if (fm) {
      fm.offset.x = (t * 0.02) % 1;
      fm.offset.y = Math.sin(t * 0.45) * 0.06;
    }
    this.foam.opacity = 0.55 + Math.sin(t * 0.7) * 0.14;
  }

  dispose(): void {
    for (let i = 0; i < STYLES.length; i++) this.building[STYLES[i]].dispose();
    this.plain.dispose(); this.glow.dispose(); this.shopfront.dispose(); this.plinth.dispose();
    this.road.dispose(); this.crosswalk.dispose(); this.roadMark.dispose(); this.sidewalk.dispose(); this.sand.dispose();
    this.grass.dispose(); this.plaza.dispose(); this.pavement.dispose(); this.dirt.dispose(); this.water.dispose(); this.foam.dispose();
    this.furniture.dispose(); this.palmTrunk.dispose(); this.palmFrond.dispose(); this.lampPole.dispose(); this.bench.dispose(); this.hydrant.dispose();
    this.lampHeadMat.dispose(); this.lightPoolMat.dispose();
    if (this.neonMat) this.neonMat.dispose();
    if (this.neonBloomMat) this.neonBloomMat.dispose();
    if (this.glassMat) this.glassMat.dispose();
    for (let i = 0; i < this.markers.length; i++) this.markers[i].dispose();
    this.markers.length = 0;
  }
}
