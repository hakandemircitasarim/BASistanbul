// Shared material set (lit PBR surfaces, emissive windows/shopfronts, water, neon + bloom, additive lamp/marker materials) driven by a night factor. Track B.
import * as THREE from 'three';
import type { BuildingStyle } from '../city/CityData';
import { clamp } from '../core/math';
import type { TextureFactory } from './TextureFactory';
import { ROAD_TILE_M } from './TextureFactory';
import { PROP_DIMS } from './CityRendererProps';

export const STYLES: readonly BuildingStyle[] = ['artdeco', 'glass', 'concrete', 'neon', 'residential'];
/** Sidewalk/sand/grass/plaza texture tile sizes in meters (UVs are world meters / tile). Sidewalk and pavement share the 8 m slab grid so kerb and lot never show a seam. */
export const TILE_M = { road: ROAD_TILE_M, sidewalk: 8, sand: 12, water: 40, grass: 8, plaza: 8, pavement: 8 } as const;

// Emissive levels are HDR: the bloom pass thresholds at 3.0 by day and 1.4 at night, so lit panes, glow parts and
// shop ceilings have to land above that to bloom while the mid-tones stay below it.
const WINDOW_EMISSIVE_MAX = 2.2;
const GLOW_EMISSIVE_MAX = 2.6;
const WINDOW_EMISSIVE_COLOR = 0xffe6b8;
const NEON_MIN_OPACITY = 0.15;
/** Shop interiors stay a little lit in daylight so the street level never reads as dead. */
const SHOP_EMISSIVE_DAY = 0.16;
/** 1.5: the warm interiors land just under the night bloom threshold (1.4) so a lit shop row stays legible; only the ceiling spots tip over it. */
const SHOP_EMISSIVE_NIGHT = 1.5;
/** 1.3: the baked lobby (pendants at ~1.0 in the map) glows without the whole band blooming into a white wall. */
const PLINTH_EMISSIVE_NIGHT = 1.3;
/** Unlit additive materials are not tone mapped, so a x2 colour stays in range on screen but crosses the bloom threshold. */
const HDR_BOOST = 2;
/**
 * Neon glyphs: x1.5 rather than the lamp boost. At x2 a 12 m sign crossed the bloom threshold over its whole face and
 * the letters smeared into one blob; at x1.5 the atlas' own baked halo carries the glow and the strokes stay readable.
 * CityRenderer dims wide signs further through the vertex tint.
 */
const NEON_BOOST = 1.5;
/** Palm frond tint (multiplies the leaflet map) and its daylight translucency emissive (faded out at night). */
const PALM_FROND_TINT = 0x7fa050;
const PALM_FROND_EMISSIVE_DAY = 0.06;
/** Leaf emissive kept at full night (the frond tint x this): a dark green, well under anything that blooms. */
const LEAF_EMISSIVE_NIGHT = 0.045;
/** How far the leaf albedo (fronds and solid foliage) drops at full night: moonlit leaves stay dark green, never pale. */
const FOLIAGE_NIGHT_DIM = 0.65;
/** Daylight roughness of the alpha fronds (0.97 at full night: no moon highlight on the leaves). */
const PALM_FROND_ROUGHNESS = 0.65;
/**
 * Half width of the frond alpha ramp around alphaTest (see the palmFrond shader patch). Alpha-to-coverage dithers
 * whatever lands inside this band into an MSAA sample mask, and on a 4-sample resolve that mask is a visible stipple:
 * at +-0.08 the leaflet serrations (which cross the band over a texel or two) grew a horizontal comb at 15-40 m on
 * the software GL of the screenshot harness. Halving the band leaves the dither only on the true silhouette edge,
 * which is what the coverage feathering is for.
 */
const PALM_ALPHA_RAMP = 0.04;
/** Distance-driven alpha boost of the fronds: x(1 + gain) reached `span` metres beyond `from` (see the palmFrond shader patch). */
const PALM_ALPHA_DIST = { from: 12, span: 33, gain: 1.6 } as const;

/**
 * Facade surface split (see TextureFactory.windows and facadeSurfacePatch). The roughness map's .g is the roughness
 * three samples (pane 0.15, render 0.92) and its .r marks the glazing, which buys two things a uniform cannot:
 * the sky probe is lifted on the panes only, so a window answers the sky while the wall beside it stays matte, and
 * the tiling plaster grain is kept off the glass. `tile` is the grain's repeat in tile UVs - 2.6 across a 16 m tile
 * and 4.6 up a 28 m one is ~6 m either way, so the grain reads at the same size however the massing scales the window
 * grid. Amount and repeat are deliberately gentle: at half this repeat and twice this amount the render came out as
 * coarse sandpaper, which is the fine noise a stylised facade must never have.
 */
const FACADE_GRAIN = { tile: [2.6, 4.6] as const, amount: 0.3, amountCurtain: 0.12, paneEnv: 0.6, paneEnvCurtain: 0.2 } as const;
/**
 * Roughness / metalness / sky-probe strength per surface family. Everything lit is MeshStandardMaterial so the PMREM
 * sky probe actually shows up: without a specular term the whole city answers light identically and reads flat.
 * Rule of thumb: bare metal is the only family with metalness above 0.1 - painted steel is paint, glass is glass -
 * and the families are spread across the roughness range (glass 0.26, metal 0.35, paint 0.5, asphalt 0.85 with its
 * lane paint at 0.55 via the map, stone and concrete 0.85-0.95, canvas 0.9) so light behaves differently on each.
 */
const SURF = {
  building: { roughness: 1, metalness: 0.04, env: 0.75, envGlass: 1.2 },
  plain: { roughness: 0.88, metalness: 0.05, env: 0.5 },
  road: { roughnessDay: 0.85, roughnessNight: 0.6, metalness: 0.03, env: 0.45 },
  ground: { roughness: 0.94, metalness: 0, env: 0.35 },
  sand: { roughness: 0.97, metalness: 0, env: 0.25 },
  metal: { roughness: 0.35, metalness: 0.8, env: 1.0 },
  paint: { roughness: 0.5, metalness: 0.08, env: 0.8 },
  wood: { roughness: 0.78, metalness: 0, env: 0.4 },
  foliage: { roughness: 0.8, metalness: 0, env: 0.35 },
  canvas: { roughness: 0.9, metalness: 0, env: 0.3 },
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
  /** Ground-floor lobby plinth band (downtown): pale stone piers, tall lobby glazing with a baked interior, an entrance bay. */
  readonly plinth: THREE.MeshStandardMaterial;
  /** Striped canvas for shop awnings (vertex colour sets the hue, u runs along the stripes' width, v up the drop). */
  readonly awning: THREE.MeshStandardMaterial;
  /** Built facade detail (window frames, sills, balconies, AC units, downpipes): vertex colour x batch instance colour, painted-metal sheen. */
  readonly facade: THREE.MeshStandardMaterial;
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
  /** Vertex-coloured foliage with baked face normals (tree crowns and trunks, hedges, the far palm LOD); darkens after dark like palmFrond. */
  readonly foliage: THREE.MeshStandardMaterial;
  readonly lampPole: THREE.MeshStandardMaterial;
  readonly bench: THREE.MeshStandardMaterial;
  readonly hydrant: THREE.MeshStandardMaterial;
  private readonly lampHeadMat: THREE.MeshBasicMaterial;
  private readonly lightPoolMat: THREE.MeshBasicMaterial;
  private readonly lampSpillMat: THREE.MeshBasicMaterial;
  private neonMat: THREE.MeshBasicMaterial | null = null;
  private neonBloomMat: THREE.MeshBasicMaterial | null = null;
  private readonly bloomTex: THREE.Texture;
  private readonly markers: THREE.MeshBasicMaterial[] = [];
  private readonly lampDay = new THREE.Color(0x6a6a70);
  private readonly lampNight = new THREE.Color(0xfff2c8).multiplyScalar(HDR_BOOST);
  private glassMat: THREE.MeshStandardMaterial | null = null;

  constructor(tex: TextureFactory) {
    this.building = {} as Record<BuildingStyle, THREE.MeshStandardMaterial>;
    for (let i = 0; i < STYLES.length; i++) {
      const style = STYLES[i];
      const w = tex.windows(style, i + 1);
      this.building[style] = new THREE.MeshStandardMaterial({
        vertexColors: true, map: w.map, emissiveMap: w.emissive, emissive: WINDOW_EMISSIVE_COLOR, emissiveIntensity: 0,
        // Per-pixel relief so windows read as recessed instead of painted on a flat slab, plus a roughness map so
        // the glazing catches the sky and the render around it does not.
        // 0.45: the relief is a high-passed albedo, and at 0.75 the plaster mottle rippled like wet watercolour.
        normalMap: w.normal, normalScale: new THREE.Vector2(0.45, 0.45), roughnessMap: w.rough,
        // The curtain wall bakes a sky-to-slate reflection into its albedo and leans harder on the sky probe over it.
        roughness: SURF.building.roughness, metalness: SURF.building.metalness, envMapIntensity: style === 'glass' ? SURF.building.envGlass : SURF.building.env,
      });
      this.facadeSurfacePatch(this.building[style], tex.detailNormal(), style === 'glass' || style === 'neon');
    }
    this.plain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: SURF.plain.roughness, metalness: SURF.plain.metalness, envMapIntensity: SURF.plain.env });
    this.glow = new THREE.MeshStandardMaterial({ vertexColors: true, emissiveMap: tex.glowAtlas(), emissive: 0xffffff, emissiveIntensity: 0, roughness: SURF.plain.roughness, metalness: SURF.plain.metalness, envMapIntensity: SURF.plain.env });
    const shop = tex.shopfront();
    this.shopfront = new THREE.MeshStandardMaterial({
      vertexColors: true, map: shop.map, emissiveMap: shop.emissive, emissive: 0xffffff, emissiveIntensity: SHOP_EMISSIVE_DAY,
      normalMap: shop.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: shop.rough,
      roughness: SURF.building.roughness, metalness: SURF.building.metalness, envMapIntensity: SURF.building.env,
    });
    const pl = tex.plinth();
    this.plinth = new THREE.MeshStandardMaterial({
      vertexColors: true, map: pl.map, emissiveMap: pl.emissive, emissive: 0xffffff, emissiveIntensity: 0,
      normalMap: pl.normal, normalScale: new THREE.Vector2(0.7, 0.7), roughnessMap: pl.rough,
      roughness: SURF.building.roughness, metalness: SURF.building.metalness, envMapIntensity: SURF.building.env,
    });
    this.awning = new THREE.MeshStandardMaterial({ map: tex.awningTex(), vertexColors: true, side: THREE.DoubleSide, roughness: SURF.canvas.roughness, metalness: SURF.canvas.metalness, envMapIntensity: SURF.canvas.env });
    this.facade = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: SURF.paint.metalness, envMapIntensity: 0.6 });
    // The 1024 px ground tiles carry aggregate, cracks and joints; the relief is derived from them at full res (so a
    // 3 px joint still reads as a groove) and the roughness is painted while drawing (paint and iron smoother than
    // stone), at half res. Normal strengths are tuned so joints catch a 15:00 sun without the aggregate sparkling.
    const roadMap = tex.road();
    this.road = new THREE.MeshStandardMaterial({
      map: roadMap, roughnessMap: tex.roadRough(), roughness: SURF.road.roughnessDay,
      normalMap: tex.groundNormal('road', 3.0), normalScale: new THREE.Vector2(0.45, 0.45),
      metalness: SURF.road.metalness, envMapIntensity: SURF.road.env,
    });
    this.crosswalk = new THREE.MeshStandardMaterial({ map: tex.crosswalk(), roughness: 0.85, metalness: SURF.road.metalness, envMapIntensity: SURF.road.env });
    this.roadMark = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, envMapIntensity: SURF.road.env, map: tex.roadMarks(), transparent: true, alphaTest: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -6 });
    // Ground families get relief + roughness maps so slab joints and the kerb chamfer catch low sun instead of
    // reading as a flat print. Values are deliberately grouped: dark warm asphalt, mid warm pavement, light facades.
    const walkN = tex.groundNormal('sidewalk', 3.6), walkR = tex.groundRough('sidewalk', 0.8, 1);
    this.sidewalk = new THREE.MeshStandardMaterial({ map: tex.sidewalk(), color: 0xaea89c, normalMap: walkN, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: walkR, roughness: SURF.ground.roughness, metalness: SURF.ground.metalness, envMapIntensity: SURF.ground.env });
    this.sand = new THREE.MeshStandardMaterial({ map: tex.sand(), roughness: SURF.sand.roughness, metalness: 0, envMapIntensity: SURF.sand.env });
    this.grass = new THREE.MeshStandardMaterial({ map: tex.grass(), roughness: SURF.ground.roughness, metalness: 0, envMapIntensity: SURF.ground.env });
    this.plaza = new THREE.MeshStandardMaterial({ map: tex.plaza(), normalMap: tex.groundNormal('plaza', 2.5), normalScale: new THREE.Vector2(0.5, 0.5), roughnessMap: tex.groundRough('plaza', 0.75, 0.98), roughness: 0.86, metalness: 0.05, envMapIntensity: SURF.ground.env });
    this.pavement = new THREE.MeshStandardMaterial({ map: tex.sidewalk(), normalMap: walkN, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: walkR, color: 0xa39c90, roughness: SURF.ground.roughness, metalness: 0.05, envMapIntensity: SURF.ground.env });
    this.dirt = new THREE.MeshStandardMaterial({ color: 0x5a4e3c, roughness: SURF.ground.roughness, metalness: 0, envMapIntensity: SURF.ground.env });
    const wt = tex.water();
    this.water = new THREE.MeshPhongMaterial({ map: wt, normalMap: tex.waterNormal(), color: 0x9fd8ff, specular: 0xffffff, shininess: 80, transparent: true, opacity: 0.92 });
    this.water.normalScale.set(0.45, 0.45);
    const wn = this.water.normalMap;
    if (wn) wn.repeat.set(3, 3);
    this.foam = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0, map: tex.foam(), color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide });
    this.furniture = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: SURF.paint.roughness, metalness: SURF.paint.metalness, envMapIntensity: SURF.paint.env });
    const bark = tex.palmBark();
    bark.repeat.set(1, PROP_DIMS.palmTrunkH / 2);
    this.palmTrunk = new THREE.MeshStandardMaterial({ map: bark, color: 0xc9a878, roughness: 0.9, metalness: 0, envMapIntensity: SURF.foliage.env });
    // Front side only: the frond geometry carries its own back faces, whose normals still point at the sky. With
    // DoubleSide three flips the normal on back faces, so at midday every frond seen from below turned black.
    // Vertex colours tint the dead skirt fronds brown and the underside copies darker; live fronds carry white.
    // A whisper of leaf-coloured emissive stands in for translucency by day (applyNight fades it out, so the crowns
    // go dark with everything else instead of glowing grey after sunset). The tint is a deep saturated green: the
    // old pale sage read as mint once the sky fill and the coverage bleed (below) got at it.
    this.palmFrond = new THREE.MeshStandardMaterial({ map: tex.palmFrond(), alphaTest: 0.34, side: THREE.FrontSide, color: PALM_FROND_TINT, vertexColors: true, emissive: PALM_FROND_TINT, emissiveIntensity: PALM_FROND_EMISSIVE_DAY, roughness: PALM_FROND_ROUGHNESS, metalness: 0, envMapIntensity: SURF.foliage.env });
    // Alpha-to-coverage lets the MSAA resolve feather the leaf edges instead of the hard alpha-test stair-step. Past
    // ~25 m the mip chain averages the leaflet gaps into a coverage of ~0.4-0.6, and three's own smoothstep over
    // [alphaTest, alphaTest + fwidth] then lets that much sky through every frond (the mint / cut-out look). The
    // ramp below is re-centred on the test and fixed at +-PALM_ALPHA_RAMP (no screen derivatives: a fwidth-based
    // ramp blacked out the whole MSAA frame on the software GL used by the screenshot harness), so a distant frond is
    // solid wherever its alpha clears the test and only the real leaf edges, which cross the ramp in a texel or two,
    // stay feathered. The mip chain still erodes the alpha of the thin leaflets with distance (a 40 m crown kept only
    // a few covered samples and read as the sky behind it: a pale ghost after dark), so the alpha is boosted with the
    // view distance (PALM_ALPHA_DIST: from 12 m, x2.6 by 45 m; distance, not derivatives, for the reason above), which
    // closes a distant crown into the solid fans the far LOD takes over at 60 m.
    this.palmFrond.alphaToCoverage = true;
    this.palmFrond.onBeforeCompile = (shader) => {
      this.leafSpecularPatch(shader);
      // The leaflet map's transparent texels are black, so the mip chain darkens a distant frond toward black (its
      // colour, unlike its alpha, averages with the gaps): a 40 m crown had no albedo left at all. Dividing the
      // sampled colour by its alpha undoes that premultiplication-like fade and keeps the leaf green at every mip.
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb /= max( diffuseColor.a, 0.05 );');
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', [
        '{',
        `  float leafBoost = 1.0 + ${PALM_ALPHA_DIST.gain.toFixed(2)} * clamp( ( length( vViewPosition ) - ${PALM_ALPHA_DIST.from.toFixed(1)} ) / ${PALM_ALPHA_DIST.span.toFixed(1)}, 0.0, 1.0 );`,
        `  diffuseColor.a = smoothstep( alphaTest - ${PALM_ALPHA_RAMP.toFixed(3)}, alphaTest + ${PALM_ALPHA_RAMP.toFixed(3)}, diffuseColor.a * leafBoost );`,
        '  if ( diffuseColor.a <= 0.0 ) discard;',
        '}',
      ].join('\n'));
    };
    this.palmFrond.customProgramCacheKey = () => 'palmFrondSharpen6';
    // Solid foliage (PropRenderer bakes the normals: canopy normals on the far fronds, face normals on the crowns and
    // hedges) with the same daylight-only translucency emissive as the fronds, so the far palm LOD and the tree crowns
    // fall dark with the near fronds after sunset instead of standing in the street as pale cut-outs.
    this.foliage = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: SURF.foliage.roughness, metalness: SURF.foliage.metalness, envMapIntensity: SURF.foliage.env, emissive: PALM_FROND_TINT, emissiveIntensity: PALM_FROND_EMISSIVE_DAY });
    this.foliage.onBeforeCompile = (shader) => { this.leafSpecularPatch(shader); };
    this.foliage.customProgramCacheKey = () => 'foliageLeaf2';
    this.lampPole = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: SURF.metal.roughness, metalness: SURF.metal.metalness, envMapIntensity: SURF.metal.env });
    this.bench = new THREE.MeshStandardMaterial({ color: 0x8a5a30, roughness: SURF.wood.roughness, metalness: 0, envMapIntensity: SURF.wood.env });
    this.hydrant = new THREE.MeshStandardMaterial({ color: 0xd8302a, roughness: SURF.paint.roughness, metalness: SURF.paint.metalness, envMapIntensity: SURF.paint.env });
    this.lampHeadMat = new THREE.MeshBasicMaterial({ color: 0x6a6a70, fog: false, toneMapped: false });
    this.lightPoolMat = new THREE.MeshBasicMaterial({ map: tex.radialGlow(), color: new THREE.Color(0xffd39a).multiplyScalar(HDR_BOOST), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
    // Vertical spill quad behind each lamp so the facade behind it catches light too, not just the pavement.
    this.lampSpillMat = new THREE.MeshBasicMaterial({ map: tex.radialGlow(), color: new THREE.Color(0xffd39a).multiplyScalar(HDR_BOOST), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
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
    // Name every material after its field so Renderer.sceneBreakdown() can attribute merged meshes (debug only).
    for (const [k, v] of Object.entries(this)) if (v instanceof THREE.Material && !v.name) v.name = k;
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

  /**
   * Facade surface: a tiling plaster grain blended into the normal, and the sky probe lifted on the glazing only.
   * Both are driven by the roughness map's pane channel (.r, free because three reads roughness from .g), so the two
   * materials a facade actually has - render and glass - stop answering the light identically. The normal chunk is
   * rewritten rather than appended to: the grain has to join the painted relief in TANGENT space, before the tbn
   * transform, or a wall at a grazing angle picks up a normal that is no longer a unit vector in the surface frame.
   */
  private facadeSurfacePatch(m: THREE.MeshStandardMaterial, detail: THREE.Texture, curtainWall: boolean): void {
    const amount = curtainWall ? FACADE_GRAIN.amountCurtain : FACADE_GRAIN.amount;
    const paneEnv = curtainWall ? FACADE_GRAIN.paneEnvCurtain : FACADE_GRAIN.paneEnv;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uGrain = { value: detail };
      shader.uniforms.uGrainTile = { value: new THREE.Vector2(FACADE_GRAIN.tile[0], FACADE_GRAIN.tile[1]) };
      shader.uniforms.uGrainAmt = { value: amount };
      shader.uniforms.uPaneEnv = { value: paneEnv };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uGrain;\nuniform vec2 uGrainTile;\nuniform float uGrainAmt;\nuniform float uPaneEnv;\nfloat vPaneMask;')
        .replace('#include <normal_fragment_maps>', [
          'vPaneMask = texture2D( roughnessMap, vRoughnessMapUv ).r;',
          'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
          'mapN.xy *= normalScale;',
          'vec3 grainN = texture2D( uGrain, vNormalMapUv * uGrainTile ).xyz * 2.0 - 1.0;',
          'mapN.xy += grainN.xy * uGrainAmt * ( 1.0 - vPaneMask );',
          'normal = normalize( tbn * mapN );',
        ].join('\n'))
        .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\nradiance *= 1.0 + uPaneEnv * vPaneMask;');
    };
    m.customProgramCacheKey = () => `facadeSurface1:${amount.toFixed(2)}:${paneEnv.toFixed(2)}`;
  }

  /** Dielectric F0 scale of the leaf materials (palmFrond, foliage): 1 by day, 0 at full night (see leafSpecularPatch). */
  private readonly leafSpec = { value: 1 };

  /**
   * Leaves have no moon highlight: the moon's broad specular lobe on up-facing leaves lit a whole crown to a flat
   * blue-white (F0 0.04 x a 1.5-unit light, independent of the albedo), which is what stood in the street as a pale
   * cut-out. The dielectric F0 of both leaf materials is scaled by uLeafSpec, driven to 0 by the night factor.
   */
  private leafSpecularPatch(shader: THREE.WebGLProgramParametersWithUniforms): void {
    shader.uniforms.uLeafSpec = this.leafSpec;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLeafSpec;')
      .replace('#include <lights_physical_fragment>', THREE.ShaderChunk.lights_physical_fragment
        .replace('material.specularColor = vec3( 0.04 );', 'material.specularColor = vec3( 0.04 * uLeafSpec );')
        // F90 too: the probe's grazing-angle reflection (the multi-scatter term) is what a scaled F0 alone leaves behind.
        .replace('material.specularF90 = 1.0;\n', 'material.specularF90 = uLeafSpec;\n'));
  }

  get nightFactor(): number { return this._night; }

  glass(): THREE.MeshStandardMaterial {
    if (!this.glassMat) this.glassMat = new THREE.MeshStandardMaterial({ color: 0x14202e, metalness: 0, roughness: 0.08, envMapIntensity: 1.6, transparent: true, opacity: 0.86 });
    return this.glassMat;
  }

  /** Neon sign atlas material: additive, vertex-tinted, opacity follows the night factor (min 0.15 by day). */
  neon(atlasTex: THREE.Texture): THREE.MeshBasicMaterial {
    if (!this.neonMat) {
      this.neonMat = new THREE.MeshBasicMaterial({ map: atlasTex, color: new THREE.Color(NEON_BOOST, NEON_BOOST, NEON_BOOST), vertexColors: true, transparent: true, opacity: NEON_MIN_OPACITY, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
      this.applyNight();
    }
    return this.neonMat;
  }

  /** Cheap fake bloom: oversized additive halo quads behind the neon signs (no postprocessing). */
  neonBloom(): THREE.MeshBasicMaterial {
    if (!this.neonBloomMat) {
      this.neonBloomMat = new THREE.MeshBasicMaterial({ map: this.bloomTex, color: new THREE.Color(HDR_BOOST, HDR_BOOST, HDR_BOOST), vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
      this.applyNight();
    }
    return this.neonBloomMat;
  }

  lampHead(): THREE.MeshBasicMaterial { return this.lampHeadMat; }

  lightPool(): THREE.MeshBasicMaterial { return this.lightPoolMat; }

  /** Additive vertical glow quad behind a lamp head (facade spill); opacity follows the night factor. */
  lampSpill(): THREE.MeshBasicMaterial { return this.lampSpillMat; }

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
    this.lightPoolMat.opacity = n * 0.45;
    this.lampSpillMat.opacity = n * 0.18;
    // Palm crowns: the translucency stand-in is a daylight effect only.
    // A whisper of leaf green stays on after dark (LEAF_EMISSIVE_NIGHT): with the moon highlight gone a crown is
    // otherwise pure black lifted by the grade's toe, i.e. the same grey as the facade behind it, and reads as a
    // cut-out again — this keeps it a dark green.
    this.palmFrond.emissiveIntensity = PALM_FROND_EMISSIVE_DAY * (1 - n) + LEAF_EMISSIVE_NIGHT * n;
    this.foliage.emissiveIntensity = PALM_FROND_EMISSIVE_DAY * (1 - n) + LEAF_EMISSIVE_NIGHT * n;
    // Leaves go dark after sunset: the moon and the sky probe's horizon band lit a moonlit crown to the same pale
    // grey as the facades, and a palm then stood in the street as a flat cut-out. The albedo of both leaf materials
    // (the alpha fronds' tint, the solid foliage's vertex-colour multiplier) is pulled down together with the probe's
    // share, so near fronds, far fronds and tree crowns all read as dark green under the lamps.
    const leafDim = 1 - FOLIAGE_NIGHT_DIM * n;
    this.palmFrond.color.setHex(PALM_FROND_TINT).multiplyScalar(leafDim);
    this.foliage.color.setScalar(leafDim);
    this.palmFrond.envMapIntensity = SURF.foliage.env * (1 - 0.7 * n);
    this.foliage.envMapIntensity = SURF.foliage.env * (1 - 0.7 * n);
    // The moon's broad specular lobe on 0.65-rough leaves was the actual pale grey: a crown whose canopy normals sat
    // near the half vector lit up in the moon's blue-white regardless of its albedo. Leaves go matte after dark.
    this.palmFrond.roughness = PALM_FROND_ROUGHNESS + (0.97 - PALM_FROND_ROUGHNESS) * n;
    this.foliage.roughness = SURF.foliage.roughness + (0.97 - SURF.foliage.roughness) * n;
    this.leafSpec.value = 1 - n;
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
    this.plain.dispose(); this.glow.dispose(); this.shopfront.dispose(); this.plinth.dispose(); this.awning.dispose(); this.facade.dispose();
    this.road.dispose(); this.crosswalk.dispose(); this.roadMark.dispose(); this.sidewalk.dispose(); this.sand.dispose();
    this.grass.dispose(); this.plaza.dispose(); this.pavement.dispose(); this.dirt.dispose(); this.water.dispose(); this.foam.dispose();
    this.furniture.dispose(); this.palmTrunk.dispose(); this.palmFrond.dispose(); this.foliage.dispose(); this.lampPole.dispose(); this.bench.dispose(); this.hydrant.dispose();
    this.lampHeadMat.dispose(); this.lightPoolMat.dispose(); this.lampSpillMat.dispose();
    if (this.neonMat) this.neonMat.dispose();
    if (this.neonBloomMat) this.neonBloomMat.dispose();
    if (this.glassMat) this.glassMat.dispose();
    for (let i = 0; i < this.markers.length; i++) this.markers[i].dispose();
    this.markers.length = 0;
  }
}
