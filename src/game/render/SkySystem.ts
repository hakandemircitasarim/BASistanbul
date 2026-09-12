// Sky: HDR gradient dome shader, sun/moon sprites, stars, sun/moon directional light with a following shadow box, hemisphere
// fill/bounce light, exponential fog and a structured HDR reflection probe (sun blob, horizon line, skyline). Track B.
import * as THREE from 'three';
import type { Vec3 } from '../core/Types';
import { clamp, lerp } from '../core/math';
import type { TextureFactory } from './TextureFactory';

/**
 * One sky keyframe. `sun` is the key light colour, `fill` the hemisphere sky colour (authored as the complement of the
 * sun: warm key / cool fill at every hour), `ground` the bounce colour under the hemisphere, `fog` the haze dye that
 * gets blended toward the horizon in update(), `fogDensity` the FogExp2 density at high quality.
 */
export interface SkyKey { hour: number; top: number; horizon: number; sun: number; fill: number; ground: number; fog: number; sunI: number; ambI: number; fogDensity: number }

/** Keyframes by hour (wrap at 24). Sunset 18:30-19:15 reads as Vice City: horizon #ff7a3d, top #6a2c8f. */
export const SKY_KEYS: SkyKey[] = [
  { hour: 0, top: 0x05061c, horizon: 0x3a2a4e, sun: 0x000000, fill: 0x2c3a6e, ground: 0x3a2c22, fog: 0x1a1e44, sunI: 0, ambI: 0.5, fogDensity: 0.0036 },
  { hour: 4.5, top: 0x0a0c2a, horizon: 0x3a2a54, sun: 0x000000, fill: 0x2c3a6e, ground: 0x3a2c22, fog: 0x22204a, sunI: 0, ambI: 0.5, fogDensity: 0.0036 },
  { hour: 6, top: 0x3a3a7a, horizon: 0xff9a5a, sun: 0xffc890, fill: 0x6a70b8, ground: 0x4a3a30, fog: 0xd8b0a0, sunI: 0.45, ambI: 0.65, fogDensity: 0.0028 },
  { hour: 7.5, top: 0x3f7fd8, horizon: 0xc0d8f0, sun: 0xfff0d0, fill: 0x88a8e0, ground: 0x8a7a68, fog: 0xb4cbe6, sunI: 0.9, ambI: 0.85, fogDensity: 0.002 },
  { hour: 12, top: 0x2a63d4, horizon: 0xa9cdef, sun: 0xfff1dc, fill: 0x8fb4e8, ground: 0x9a8a78, fog: 0xb4cbe6, sunI: 1.15, ambI: 1.0, fogDensity: 0.0018 },
  { hour: 16.5, top: 0x3670c8, horizon: 0xe8c8a8, sun: 0xffe2b0, fill: 0x7f98d0, ground: 0x8a7a68, fog: 0xe6d2c2, sunI: 1.0, ambI: 0.9, fogDensity: 0.002 },
  { hour: 17.5, top: 0x3454a8, horizon: 0xf8b880, sun: 0xffd090, fill: 0x7480c0, ground: 0x7a6860, fog: 0xecc8b0, sunI: 1.05, ambI: 0.85, fogDensity: 0.0021 },
  { hour: 18, top: 0x4a4aa8, horizon: 0xff9a58, sun: 0xffb070, fill: 0x6470b4, ground: 0x625650, fog: 0xe6c6b4, sunI: 1.1, ambI: 0.9, fogDensity: 0.002 },
  { hour: 19, top: 0x363284, horizon: 0xff8a4a, sun: 0xff8a48, fill: 0x4a5aa0, ground: 0x46423f, fog: 0xc6b0b4, sunI: 1.0, ambI: 0.85, fogDensity: 0.0022 },
  { hour: 20.5, top: 0x141238, horizon: 0x4a2c66, sun: 0x000000, fill: 0x34407a, ground: 0x3a2c22, fog: 0x2a2448, sunI: 0.05, ambI: 0.6, fogDensity: 0.0032 },
  { hour: 22, top: 0x07081f, horizon: 0x3a2a4e, sun: 0x000000, fill: 0x2c3a6e, ground: 0x3a2c22, fog: 0x1a1e44, sunI: 0, ambI: 0.5, fogDensity: 0.0036 },
];

export const scratchLuma = new THREE.Color();

/**
 * Width of the shadow-edge fade, as a fraction of the shadow box on each side (0.1 of a 132 m box = 13.2 m).
 */
const SHADOW_FADE = 0.1;
/**
 * Shadow-edge fade, patched into three's shadow lookup once, at module load (before any material compiles).
 *
 * Outside the directional light's shadow box getShadow returns "lit", so on a big flat ground at noon the box's own
 * border draws a hard, stair-stepped line across the tarmac: the border of a square in LIGHT space, which the sun's
 * azimuth turns into a diagonal on the ground, stepped by the shadow map's texels. No box size hides that - it only
 * moves it. Fading the shadow term back to 1 over the outer SHADOW_FADE of the box turns the step into a gradient
 * that nothing in the frame reads as an edge, for two instructions in the fragment shader.
 *
 * Only the three 2D variants (PCF / VSM / basic, shared by the directional and spot lights) are patched; the two
 * getPointShadow tails work in cube space, where there is no border to fade.
 */
function patchShadowEdgeFade(): void {
  const tail = 'return mix( 1.0, shadow, shadowIntensity );';
  const faded = `{
			vec2 fadeXY = min( shadowCoord.xy, 1.0 - shadowCoord.xy );
			float edgeT = clamp( min( fadeXY.x, fadeXY.y ) / ${SHADOW_FADE.toFixed(3)}, 0.0, 1.0 );
			shadow = mix( 1.0, shadow, edgeT * edgeT * ( 3.0 - 2.0 * edgeT ) );
		}
		${tail}`;
  let out = '', rest = THREE.ShaderChunk.shadowmap_pars_fragment;
  for (let i = 0; i < 3; i++) {
    const k = rest.indexOf(tail);
    if (k < 0) break;
    out += rest.slice(0, k) + faded;
    rest = rest.slice(k + tail.length);
  }
  THREE.ShaderChunk.shadowmap_pars_fragment = out + rest;
}
patchShadowEdgeFade();
const SKY_TUNING = {
  // 132 m wide (0.065 m a texel at 2048). The border is hidden by SHADOW_FADE, not by the box size, so the box is
  // sized purely by what it can afford: it is the shadow pass' own caster set, and every metre of it is paid three
  // times over (colour, GTAO, shadow map). At 150 m the dusk frame measured 726k triangles against a 720k ceiling;
  // 132 gives ~6k of that back and still carries full shadow to 53 m, fading out to 66.
  domeRadius: 850, sunDist: 700, sunScale: 34, moonScale: 55, starCount: 1400, shadowBox: 132, shadowMap: 2048, lightUnits: 3.0,
  // Clouds: uv scale of the flat-plane projection, density cut/softness, day and night coverage, drift per game hour.
  cloudScale: 0.6, cloudCut: 0.28, cloudSoft: 0.3, cloudDay: 0.45, cloudNight: 0.22, cloudDrift: 0.018,
  // Dome radiance multiplier (linear HDR): a bright day sky that ACES rolls off, unity at night so the stars keep their size.
  exposureDay: 1.8, exposureNight: 1.0,
  // Reflection probe resolution (equirect) and refresh cadence in game hours. 256x128 is the smallest size at which the
  // horizon crease, the skyline row and the hard sun disc survive PMREM filtering on a clearcoat car roof.
  probeW: 256, probeH: 128, probeRefreshHours: 0.3,
  // Probe skyline: number of silhouette blocks around the horizon, their height range in sin(elevation) and gap chance.
  probeBlocks: 44, probeBlockMinH: 0.012, probeBlockMaxH: 0.075, probeGapChance: 0.3,
  // Probe sun: the hard disc radius (rad) and its linear radiance, plus the soft bloom sigma / amplitude around it.
  probeSunDisc: 0.014, probeSunDiscI: 14, probeSunSigma: 0.055, probeSunI: 3.5,
} as const;

const VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

/**
 * HDR dome. Output is linear radiance (the sun disc sits well above 4.0 so bloom catches it by day). On the direct-to-screen
 * path (low quality, no composer) three defines TONE_MAPPING, so the trailing includes tone-map and encode the dome
 * exactly like every lit material; in a render target they compile to no-ops and the composer receives linear HDR.
 */
const FRAG = `
precision highp float;
#define CLOUD_SCALE ${SKY_TUNING.cloudScale.toFixed(4)}
#define CLOUD_CUT ${SKY_TUNING.cloudCut.toFixed(3)}
#define CLOUD_SOFT ${SKY_TUNING.cloudSoft.toFixed(3)}
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uStars; uniform sampler2D uStarTex;
uniform sampler2D uCloudTex; uniform vec3 uCloudLit; uniform vec3 uCloudDark; uniform float uCloudAmt; uniform vec2 uCloudDrift;
uniform float uExposure; uniform float uSunLow;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float y = clamp(d.y, -1.0, 1.0);
  float yy = max(y, 0.0);
  // The warm horizon key belongs to the sun's side of the sky; away from it the haze stays a cool, sky-tinted grey.
  vec2 hd = normalize(vec2(d.x, d.z) + vec2(1e-4, 0.0));
  vec2 sd = normalize(vec2(uSunDir.x, uSunDir.z) + vec2(1e-4, 0.0));
  float sunSide = 0.4 + 0.6 * pow(0.5 + 0.5 * dot(hd, sd), 2.0);
  vec3 hor = mix(mix(uHorizon, uTop, 0.4) * 1.1, uHorizon, sunSide);
  // An orange horizon key blended with a violet zenith key lands on magenta; at low sun pull the away-from-sun haze and
  // the mid band toward their luminance (a grey-blue dusk) so the sky does not wash the whole frame salmon.
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  float dusk = uSunLow;
  hor = mix(hor, vec3(dot(hor, LUMA)) * vec3(1.0, 0.97, 0.96), 0.4 * dusk * (1.0 - sunSide));
  // Three-stop gradient: bright horizon band, a mid tone at ~17 deg elevation, then a slow curve into the deep zenith.
  // With a low sun the band narrows (mid pulled toward the top) so the sunset glow stays a rim, not a whole-sky wash.
  vec3 mid = mix(mix(hor, uTop, 0.72), uTop, uSunLow * 0.3) * 0.8;
  mid = mix(mid, vec3(dot(mid, LUMA)) * vec3(0.9, 0.95, 1.06), 0.5 * dusk);
  vec3 col = yy < 0.3 ? mix(hor, mid, pow(yy / 0.3, 0.7)) : mix(mid, uTop, pow((yy - 0.3) / 0.7, 0.45));
  if (y < 0.0) col = mix(hor, hor * 0.35, clamp(-y * 3.0, 0.0, 1.0));
  float s = max(dot(d, uSunDir), 0.0);
  float sunUp = step(-0.08, uSunDir.y);
  // Sun-side brightening of the haze, a corona that widens when the sun is low, and a small hard disc (>= 4 linear).
  col += uHorizon * pow(s, 3.0) * 0.12 * sunUp;
  vec3 sunTerm = uSunColor * (pow(s, 12.0) * mix(0.15, 0.6, uSunLow) + pow(s, 200.0) * 0.5 + smoothstep(0.9990, 0.9996, s) * 3.0) * sunUp;
  vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(y) / 3.14159265 + 0.5);
  vec3 stars = texture2D(uStarTex, uv).rgb;
  col += stars * uStars * clamp(y * 2.5, 0.0, 1.0);
  // The exposure lift is a horizon effect (bright haze that the fog can match); the upper sky keeps its deep blue.
  float ex = uExposure * mix(1.0, 0.6, smoothstep(0.0, 0.5, yy));
  col = col * ex + sunTerm * uExposure;
  // Clouds: a tiling density field projected onto a flat plane above the camera, so the sheet stretches towards the
  // horizon like a real cloud deck instead of pinching at the zenith. Two octaves, the second drifting the other way.
  if (uCloudAmt > 0.001) {
    vec2 base = d.xz / max(y, 0.05) * CLOUD_SCALE;
    float a = texture2D(uCloudTex, base + uCloudDrift).r;
    float b = texture2D(uCloudTex, base * 3.7 + vec2(0.61, 0.29) - uCloudDrift * 1.6).r;
    float dens = smoothstep(CLOUD_CUT, CLOUD_CUT + CLOUD_SOFT, a * 0.85 + b * 0.55);
    // Fade into the horizon haze, and thin out overhead where the deck is seen edge-on the least.
    dens *= smoothstep(0.008, 0.13, y) * uCloudAmt;
    // Silver lining: the side facing the sun keeps the sun colour, the rest falls to the shaded underside tone.
    float lit = pow(max(dot(d, uSunDir), 0.0), 3.0);
    vec3 cloud = mix(uCloudDark, uCloudLit, clamp(lit * 0.85 + 0.25, 0.0, 1.0));
    col = mix(col, cloud * ex, dens);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Skyline silhouette block in the reflection probe: azimuth centre / half width (rad), top and bottom in sin(elevation),
 * and `lit` (0..1) for the block's tone, so the row reads as a jagged city edge rather than one flat wall.
 */
interface Silhouette { az: number; halfW: number; top: number; bottom: number; lit: number }

export class SkySystem {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly dome: THREE.Mesh;
  private readonly domeMat: THREE.ShaderMaterial;
  private readonly sunSprite: THREE.Sprite;
  private readonly moonSprite: THREE.Sprite;
  private readonly stars: THREE.Points;
  private readonly starMat: THREE.PointsMaterial;
  /** Owned by the sky: colour and density follow the keys, scene.fog is assigned unconditionally. */
  private readonly fog: THREE.FogExp2;
  private readonly cTop = new THREE.Color();
  private readonly cHor = new THREE.Color();
  private readonly cSun = new THREE.Color();
  private readonly cFill = new THREE.Color();
  private readonly cGround = new THREE.Color();
  private readonly cFog = new THREE.Color();
  private readonly cA = new THREE.Color();
  private readonly cB = new THREE.Color();
  private readonly cC = new THREE.Color();
  private readonly cD = new THREE.Color();
  private readonly cE = new THREE.Color();
  private readonly cF = new THREE.Color();
  private readonly white = new THREE.Color(0xffffff);
  // Reflection probe: a small equirect HDR image of the current sky (gradient + sun blob + horizon + skyline),
  // PMREM-filtered into scene.environment.
  private readonly targetScene: THREE.Scene;
  private gl: THREE.WebGLRenderer | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envData: Float32Array | null = null;
  private envTex: THREE.DataTexture | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnvHour = -99;
  private readonly silhouettes: Silhouette[] = [];
  private readonly moonColor = new THREE.Color(0xb8c4e8);
  private readonly nightAmbient = new THREE.Color(0x38405a);
  private readonly background = new THREE.Color();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  /** Renderer is optional: without it the sky still draws, it just cannot build the reflection probe. */
  constructor(scene: THREE.Scene, camera: THREE.Camera, tex: TextureFactory, gl?: THREE.WebGLRenderer) {
    this.scene = scene;
    this.targetScene = scene;
    this.camera = camera;
    if (gl) this.attachRenderer(gl);
    const domeGeo = new THREE.SphereGeometry(SKY_TUNING.domeRadius, 32, 16);
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(0x2a63d4) }, uHorizon: { value: new THREE.Color(0xa9cdef) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(0xffffff) },
        uStars: { value: 0 }, uStarTex: { value: tex.starField() },
        uCloudTex: { value: tex.clouds() }, uCloudLit: { value: new THREE.Color(0xffffff) },
        uCloudDark: { value: new THREE.Color(0x8fa4bc) }, uCloudAmt: { value: SKY_TUNING.cloudDay },
        uCloudDrift: { value: new THREE.Vector2() },
        uExposure: { value: SKY_TUNING.exposureDay }, uSunLow: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.dome = new THREE.Mesh(domeGeo, this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);
    const glow = tex.radialGlow();
    const sunMat = new THREE.SpriteMaterial({ map: glow, color: 0xffe0a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: true });
    this.sunSprite = new THREE.Sprite(sunMat);
    this.sunSprite.scale.set(SKY_TUNING.sunScale, SKY_TUNING.sunScale, 1);
    scene.add(this.sunSprite);
    const moonMat = new THREE.SpriteMaterial({ map: glow, color: 0xdde4ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
    this.moonSprite = new THREE.Sprite(moonMat);
    this.moonSprite.scale.set(SKY_TUNING.moonScale, SKY_TUNING.moonScale, 1);
    scene.add(this.moonSprite);
    const n = SKY_TUNING.starCount;
    const pos = new Float32Array(n * 3);
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, e = Math.asin(rnd() * 0.95 + 0.05);
      const r = SKY_TUNING.domeRadius * 0.92;
      pos[i * 3] = Math.cos(a) * Math.cos(e) * r;
      pos[i * 3 + 1] = Math.sin(e) * r;
      pos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
    }
    // Skyline silhouettes for the probe: a contiguous row of seeded blocks around the whole horizon (varying width and
    // height, a gap now and then, a taller tower every so often), so a car roof reflects a broken city edge under the sky.
    const nb = SKY_TUNING.probeBlocks;
    let az = 0;
    for (let i = 0; i < nb; i++) {
      const halfW = (Math.PI * 2 / nb) * (0.35 + rnd() * 0.3);
      az += halfW;
      const gap = rnd() < SKY_TUNING.probeGapChance;
      const tall = rnd() < 0.12;
      const h = SKY_TUNING.probeBlockMinH + rnd() * (SKY_TUNING.probeBlockMaxH - SKY_TUNING.probeBlockMinH);
      if (!gap) this.silhouettes.push({ az, halfW, top: tall ? h * 1.8 : h, bottom: -0.06, lit: rnd() });
      az += halfW + (gap ? halfW * 0.6 : 0);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false, blending: THREE.AdditiveBlending });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.frustumCulled = false;
    scene.add(this.stars);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.shadow.mapSize.set(SKY_TUNING.shadowMap, SKY_TUNING.shadowMap);
    const half = SKY_TUNING.shadowBox / 2;
    const sc = this.sun.shadow.camera;
    // The light sits 220 m from the box centre: a tight near/far keeps depth precision for contact-hugging shadows.
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 60; sc.far = 420;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.16;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0x8fb4e8, 0x9a8a78, 1);
    scene.add(this.hemi);
    this.fog = new THREE.FogExp2(0xb4cbe6, 0.0018);
    scene.fog = this.fog;
    scene.background = this.background;
    this.geometries.push(domeGeo, starGeo);
    this.materials.push(this.domeMat, sunMat, moonMat, this.starMat);
  }

  /** Interpolates SKY_KEYS at the given hour into the color scratch fields; returns interpolated scalars via the out object. */
  private sample(hour: number, out: { sunI: number; ambI: number; fogDensity: number }): void {
    const keys = SKY_KEYS;
    const h = ((hour % 24) + 24) % 24;
    let i = keys.length - 1;
    for (let k = 0; k < keys.length; k++) if (keys[k].hour <= h) i = k;
    const a = keys[i], b = keys[(i + 1) % keys.length];
    const span = (b.hour > a.hour ? b.hour : b.hour + 24) - a.hour;
    const t = clamp((h - a.hour) / span, 0, 1);
    this.cTop.lerpColors(this.cA.setHex(a.top), this.cB.setHex(b.top), t);
    this.cHor.lerpColors(this.cA.setHex(a.horizon), this.cB.setHex(b.horizon), t);
    this.cSun.lerpColors(this.cA.setHex(a.sun), this.cB.setHex(b.sun), t);
    this.cFill.lerpColors(this.cA.setHex(a.fill), this.cB.setHex(b.fill), t);
    this.cGround.lerpColors(this.cA.setHex(a.ground), this.cB.setHex(b.ground), t);
    this.cFog.lerpColors(this.cA.setHex(a.fog), this.cB.setHex(b.fog), t);
    out.sunI = lerp(a.sunI, b.sunI, t);
    out.ambI = lerp(a.ambI, b.ambI, t);
    out.fogDensity = lerp(a.fogDensity, b.fogDensity, t);
  }

  private readonly scalars = { sunI: 0, ambI: 0, fogDensity: 0.0018 };
  /** Divides into the fog density (Engine sets < 1 on low quality: denser fog hides the far city sooner). */
  fogScale = 1;

  /** Enables the reflection probe (needs a WebGL renderer for PMREM filtering). */
  attachRenderer(gl: THREE.WebGLRenderer): void {
    if (this.gl) return;
    this.gl = gl;
    this.pmrem = new THREE.PMREMGenerator(gl);
    this.pmrem.compileEquirectangularShader();
    const w = SKY_TUNING.probeW, h = SKY_TUNING.probeH;
    this.envData = new Float32Array(w * h * 4);
    const tex = new THREE.DataTexture(this.envData, w, h, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    this.envTex = tex;
    this.lastEnvHour = -99;
  }

  /**
   * Paints the probe (sky gradient x exposure, a hard sun disc inside a soft bloom, a bright horizon band over a hazy
   * ground half, and the skyline silhouette row) and refilters it. Cheap (256x128 source, ~1 ms) and only runs when the
   * sky has moved on, so car paint and glass show a horizon crease, a city edge and a sun glint that track the day.
   */
  private refreshEnvironment(sunDir: Vec3, exposure: number, sunLow: number): void {
    const data = this.envData, tex = this.envTex, pm = this.pmrem;
    if (!data || !tex || !pm) return;
    const W = SKY_TUNING.probeW, H = SKY_TUNING.probeH;
    const top = this.cTop, warmHor = this.cHor, sun = this.cSun;
    const coolHor = this.cA.copy(warmHor).lerp(top, 0.4).multiplyScalar(1.1);
    // Ground half: a hazy band right under the horizon that falls to a dark floor, so the crease between the bright
    // horizon and the ground is the strongest line in the probe (it is what a roof or bonnet reflects most).
    const groundNear = this.cB.copy(this.cFog).multiplyScalar(0.5);
    const groundFar = this.cD.copy(this.cFog).multiplyScalar(0.18);
    const px = this.cE, hor = this.cC, mid = this.cF;
    const sunUp = sunDir.y > -0.08;
    const sl = Math.hypot(sunDir.x, sunDir.z) || 1;
    const sdx = sunDir.x / sl, sdz = sunDir.z / sl;
    const sil0 = this.silhouettes;
    const TWO_PI = Math.PI * 2;
    const S = SKY_TUNING;
    for (let j = 0; j < H; j++) {
      const v = (j + 0.5) / H;
      const el = (v - 0.5) * Math.PI;
      const y = Math.sin(el), ce = Math.cos(el);
      for (let i = 0; i < W; i++) {
        const u = (i + 0.5) / W;
        const phi = (u - 0.5) * TWO_PI;
        const x = Math.cos(phi) * ce, z = Math.sin(phi) * ce;
        const ss = 0.5 + 0.5 * (Math.cos(phi) * sdx + Math.sin(phi) * sdz);
        hor.lerpColors(coolHor, warmHor, 0.4 + 0.6 * ss * ss);
        mid.lerpColors(hor, top, 0.72).lerp(top, sunLow * 0.3).multiplyScalar(0.8);
        // Mirror of the dome's low-sun desaturation (see FRAG) so the probe agrees with the visible sky.
        { const l = mid.r * 0.299 + mid.g * 0.587 + mid.b * 0.114; mid.lerp(scratchLuma.setRGB(l * 0.9, l * 0.95, l * 1.06), 0.5 * sunLow); }
        if (y >= 0) {
          // Horizon band: brightest haze right on the line, easing into the gradient over the first few degrees.
          if (y < 0.06) px.copy(hor).multiplyScalar(1.3 - 0.3 * (y / 0.06));
          else if (y < 0.3) px.lerpColors(hor, mid, Math.pow((y - 0.06) / 0.24, 0.7));
          else px.lerpColors(mid, top, Math.pow((y - 0.3) / 0.7, 0.45));
        } else {
          px.lerpColors(groundNear, groundFar, Math.min(1, -y / 0.2));
        }
        for (let k = 0; k < sil0.length; k++) {
          const s = sil0[k];
          if (y > s.top || y < s.bottom) continue;
          let da = phi - s.az;
          da -= Math.round(da / TWO_PI) * TWO_PI;
          if (Math.abs(da) < s.halfW) {
            // Block face: dark haze-tinted mass, a shade lighter on its sunward side and along its top edge.
            const face = 0.14 + 0.1 * s.lit + 0.08 * ss * ss + (s.top - y < 0.006 ? 0.12 : 0);
            px.copy(this.cFog).multiplyScalar(face);
            break;
          }
        }
        const yy = Math.max(y, 0);
        const sm = yy >= 0.5 ? 1 : (yy / 0.5) * (yy / 0.5) * (3 - 2 * (yy / 0.5));
        const ex = exposure * (1 - 0.4 * sm);
        px.multiplyScalar(ex);
        if (sunUp && y > -0.02) {
          const d = clamp(x * sunDir.x + y * sunDir.y + z * sunDir.z, -1, 1);
          const ang = Math.acos(d);
          // Hard disc + soft bloom + wide corona: the disc is what a clearcoat glint picks up, the bloom what the
          // rougher base paint smears into a highlight.
          const disc = ang < S.probeSunDisc ? S.probeSunDiscI : 0;
          const r = (disc + S.probeSunI * Math.exp(-(ang * ang) / (2 * S.probeSunSigma * S.probeSunSigma)) + 0.35 * Math.exp(-(ang * ang) / (2 * 0.35 * 0.35))) * exposure;
          px.r += sun.r * r; px.g += sun.g * r; px.b += sun.b * r;
        }
        const o = (j * W + i) * 4;
        data[o] = px.r; data[o + 1] = px.g; data[o + 2] = px.b; data[o + 3] = 1;
      }
    }
    tex.needsUpdate = true;
    const rt = pm.fromEquirectangular(tex);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    this.targetScene.environment = rt.texture;
  }

  update(hour: number, sunDir: Vec3, nightFactor: number, playerX: number, playerZ: number, shadows: boolean): void {
    const s = this.scalars;
    this.sample(hour, s);
    const exposure = lerp(SKY_TUNING.exposureDay, SKY_TUNING.exposureNight, nightFactor);
    const sunLow = clamp(1 - sunDir.y * 3, 0, 1);
    if (this.pmrem && Math.abs(hour - this.lastEnvHour) > SKY_TUNING.probeRefreshHours) {
      this.lastEnvHour = hour;
      this.refreshEnvironment(sunDir, exposure, sunLow);
    }
    const u = this.domeMat.uniforms;
    (u.uTop.value as THREE.Color).copy(this.cTop);
    (u.uHorizon.value as THREE.Color).copy(this.cHor);
    (u.uSunDir.value as THREE.Vector3).set(sunDir.x, sunDir.y, sunDir.z);
    (u.uSunColor.value as THREE.Color).copy(this.cSun);
    u.uExposure.value = exposure;
    u.uSunLow.value = sunLow;
    // Cloud tones ride the sky keys: pale near-white by day, orange-lined at sunset, near-black overcast at night.
    (u.uCloudLit.value as THREE.Color).copy(this.cHor).lerp(this.white, 0.5 - nightFactor * 0.42).multiplyScalar(1 - nightFactor * 0.55);
    (u.uCloudDark.value as THREE.Color).copy(this.cTop).lerp(this.cHor, 0.2).multiplyScalar(0.6 * (1 - nightFactor * 0.55));
    u.uCloudAmt.value = lerp(SKY_TUNING.cloudDay, SKY_TUNING.cloudNight, nightFactor);
    (u.uCloudDrift.value as THREE.Vector2).set(hour * SKY_TUNING.cloudDrift, hour * SKY_TUNING.cloudDrift * 0.4);
    const starK = nightFactor * nightFactor * nightFactor;
    u.uStars.value = starK * 0.7;
    this.starMat.opacity = starK * 0.9;
    const cam = this.camera.position;
    this.dome.position.copy(cam);
    this.stars.position.copy(cam);
    const D = SKY_TUNING.sunDist;
    this.sunSprite.position.set(cam.x + sunDir.x * D, cam.y + sunDir.y * D, cam.z + sunDir.z * D);
    this.sunSprite.visible = sunDir.y > -0.12;
    const sunMat = this.sunSprite.material as THREE.SpriteMaterial;
    sunMat.color.copy(this.cSun).lerp(this.cHor, 0.3);
    // The glow sprite is a low-sun effect: a high sun is carried by the dome's hard disc and bloom.
    sunMat.opacity = 0.35 + 0.65 * clamp(1 - sunDir.y * 2.5, 0, 1);
    this.moonSprite.position.set(cam.x - sunDir.x * D, cam.y - sunDir.y * D, cam.z - sunDir.z * D);
    this.moonSprite.visible = -sunDir.y > -0.05;
    (this.moonSprite.material as THREE.SpriteMaterial).opacity = nightFactor;
    // Fog is derived from the sky rather than a raw dye: pulled toward the horizon tone, lifted toward white by day so
    // the far city dissolves into haze instead of a coloured wall. Density follows the keys (denser on low quality).
    this.fog.color.copy(this.cFog).lerp(this.cHor, 0.2).lerp(this.white, 0.2 * (1 - nightFactor));
    this.fog.density = s.fogDensity / this.fogScale;
    this.background.copy(this.cHor).multiplyScalar(exposure);
    // Lights (physical units: scale by lightUnits). Key well above fill: ~4.5 vs ~1.5 at noon, so a sunlit white wall
    // sits around 1.4 linear against ~0.35 in shadow before ACES.
    const L = SKY_TUNING.lightUnits;
    const moon = nightFactor > 0.9;
    const lx = moon ? -sunDir.x : sunDir.x, ly = moon ? -sunDir.y : sunDir.y, lz = moon ? -sunDir.z : sunDir.z;
    // A low sun keeps at least ~16 deg of elevation so the ground still catches a warm key at dusk.
    const ey = Math.max(ly, 0.28);
    if (moon) {
      this.sun.color.copy(this.moonColor);
      this.sun.intensity = 0.5 * L;
    } else {
      this.sun.color.copy(this.cSun);
      this.sun.intensity = s.sunI * L * 1.3 * Math.max(0, 1 - nightFactor * 0.8);
    }
    // Hemisphere = authored sky fill / ground bounce complements of the key; at night the fill drifts toward a
    // desaturated navy so the neon still reads against it.
    this.hemi.color.copy(this.cFill).lerp(this.nightAmbient, nightFactor * 0.25);
    this.hemi.groundColor.copy(this.cGround);
    // ~1.5 at noon. The dusk/night fills are authored as dark violets and navies (hue, not brightness), so the gain rises
    // with sunLow and a large night term lifts the floor to a readable navy (~0.01 linear) instead of black.
    this.hemi.intensity = s.ambI * L * (0.35 + 0.15 * (1 - nightFactor)) * (1 + sunLow) + nightFactor * 3.2;
    // Shadow box follows the player, snapped to shadow-map texels to avoid swimming.
    const texel = SKY_TUNING.shadowBox / SKY_TUNING.shadowMap;
    const tx = Math.round(playerX / texel) * texel, tz = Math.round(playerZ / texel) * texel;
    const dist = 220;
    this.sun.position.set(tx + lx * dist, ey * dist, tz + lz * dist);
    this.sun.target.position.set(tx, 0, tz);
    this.sun.target.updateMatrixWorld();
    // Sun shadows while the disc is up (the light elevation is clamped, so the just-set sun still throws long shadows
    // that keep the sunlit floor orange and the shadowed floor violet), moon shadows at full night, a short gap between.
    const wantShadow = shadows && (moon || sunDir.y > -0.06);
    if (this.sun.castShadow !== wantShadow) this.sun.castShadow = wantShadow;
  }

  dispose(): void {
    if (this.envRT) { this.envRT.dispose(); this.envRT = null; }
    if (this.envTex) { this.envTex.dispose(); this.envTex = null; }
    this.envData = null;
    if (this.pmrem) { this.pmrem.dispose(); this.pmrem = null; }
    this.targetScene.environment = null;
    if (this.scene.fog === this.fog) this.scene.fog = null;
    this.scene.remove(this.dome, this.sunSprite, this.moonSprite, this.stars, this.sun, this.sun.target, this.hemi);
    for (let i = 0; i < this.geometries.length; i++) this.geometries[i].dispose();
    for (let i = 0; i < this.materials.length; i++) this.materials[i].dispose();
    this.sun.dispose();
    this.hemi.dispose();
  }
}
