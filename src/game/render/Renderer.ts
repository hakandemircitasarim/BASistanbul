// Three.js WebGL renderer wrapper: scene, camera, resize observer, quality settings, post chain, draw stats. Track P0.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import type { Settings } from '../state/GameStore';

/**
 * GTAOPass whose normal/depth prepass also skips alpha-cut and transparent meshes (palm fronds, glazing, road-mark
 * decals): the pass draws the scene with one override material that has no alpha test, so a cut-out frond would
 * otherwise occlude as a solid black quad. Hidden objects take the occlusion of whatever is behind them, which reads fine.
 */
class FoliageAwareGTAOPass extends GTAOPass {
  private hiddenObjects: THREE.Object3D[] = [];
  _overrideVisibility(): void {
    const cache = this.hiddenObjects;
    this.scene.traverse((o) => {
      if (!o.visible) return;
      const anyObj = o as THREE.Object3D & { isPoints?: boolean; isLine?: boolean; isLine2?: boolean; material?: THREE.Material | THREE.Material[] };
      let skip = !!(anyObj.isPoints || anyObj.isLine || anyObj.isLine2);
      const m = anyObj.material;
      if (!skip && m && !Array.isArray(m)) skip = m.transparent || m.alphaTest > 0 || m.alphaToCoverage;
      if (skip) { o.visible = false; cache.push(o); }
    });
  }
  _restoreVisibility(): void {
    const cache = this.hiddenObjects;
    for (let i = 0; i < cache.length; i++) cache[i].visible = true;
    cache.length = 0;
  }
}

export const SHADOW_MAP_SIZE = 2048;
/** Narrower than the old 65: a longer lens flattens the perspective and reads more cinematic than a wide-angle. */
export const CAMERA_FOV = 56;
export const CAMERA_NEAR = 0.3;
export const CAMERA_FAR = 900;

/**
 * Bloom over the HDR emissives (neon, lit windows, the sun disc) only, then a restrained grade + vignette; MSAA replaces
 * the old FXAA pass. Thresholds are in linear HDR (bloom samples the scene before tone mapping): sunlit white paint sits
 * around 1.5-2.5, so by day only the sun disc (>= 4) clears 3.0; at night the emissives (2.0-2.6) clear 1.4.
 */
export const POSTFX = { bloomStrength: 0.9, bloomRadius: 0.45, bloomThreshold: 1.4, bloomThresholdDay: 3.0, dayScale: 0.12, vignette: 0.9, saturation: 0.92, contrast: 1.0, msaaSamples: 4,
  // Ambient occlusion (metres): sized for street furniture, kerbs and building bases.
  aoIntensity: 1.0, aoRadius: 3.2, aoThickness: 1.0, aoSamples: 12,
  // Split tone: cool blue-violet shadows, warm highlights. Almost off by day (0.06); strongest around dusk (0.18 — higher values turned dusk into a monochrome salmon wash).
  shadowTint: [0.80, 0.86, 1.15] as const, highlightTint: [1.05, 1.0, 0.93] as const, tintDay: 0.06, tintDusk: 0.18,
  grain: 0.03 } as const;

/**
 * Restrained grade: slightly desaturated primaries, desaturated highlights, a lifted toe (no crushed blacks), a split
 * tone whose amount is driven per frame (dusk/night), an optional fine grain and a vignette.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: POSTFX.vignette },
    uSaturation: { value: POSTFX.saturation },
    uContrast: { value: POSTFX.contrast },
    uShadowTint: { value: new THREE.Vector3(...POSTFX.shadowTint) },
    uHighlightTint: { value: new THREE.Vector3(...POSTFX.highlightTint) },
    uTint: { value: POSTFX.tintDay },
    uNight: { value: 0 },
    uGrain: { value: POSTFX.grain },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uSaturation;
    uniform float uContrast;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    uniform float uTint;
    uniform float uNight;
    uniform float uGrain;
    uniform float uTime;
    uniform vec2 uResolution;
    varying vec2 vUv;
    float hash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
    void main() {
      vec4 c = texture2D( tDiffuse, vUv );
      vec3 col = c.rgb;
      float l = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
      col = mix( vec3( l ), col, uSaturation );
      // Highlights drift toward white instead of staying saturated (film-like roll-off).
      col = mix( col, vec3( l ), smoothstep( 0.75, 1.0, l ) * 0.3 );
      // Lifted toe: blacks never hit zero, which reads softer and less "video".
      col = col * 0.97 + 0.025;
      col = ( col - 0.5 ) * uContrast + 0.5;
      float lum = clamp( dot( col, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0, 1.0 );
      vec3 tint = mix( uShadowTint, uHighlightTint, smoothstep( 0.15, 0.85, lum ) );
      col = mix( col, col * tint, uTint );
      // Night pedestal: a faint milky lift so the dark frame keeps some air.
      col = mix( col, col * 0.96 + 0.015, uNight );
      // Fine grain, stronger in the darks, invisible in the lights.
      float g = hash( vUv * uResolution + fract( uTime ) * 61.0 ) - 0.5;
      col += g * uGrain * ( 1.0 - lum );
      vec2 d = vUv - 0.5;
      float v = smoothstep( 0.85, 0.28, dot( d, d ) * uVignette * 2.4 );
      col *= mix( 0.78, 1.0, v );
      gl_FragColor = vec4( clamp( col, 0.0, 1.0 ), c.a );
    }
  `,
};

/** Dynamic resolution: keeps the frame budget by scaling the drawing buffer, never the user's quality preset. */
export const ADAPTIVE = {
  lowFps: 45, highFps: 57, minScale: 0.65, maxScale: 1,
  down: 0.05, up: 0.02, warmupSec: 2, sampleSec: 0.5,
} as const;

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly gl: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private observer: ResizeObserver | null = null;
  private _drawCalls = 0;
  private _triangles = 0;
  private baseRatio = 1;
  private scale = 1;
  private appliedRatio = 0;
  private adaptClock = 0;
  private warmup = 0;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private gtao: GTAOPass | null = null;
  /** ?ao=2: show the raw occlusion buffer instead of the shaded frame. */
  aoDebug = false;
  private grade: ShaderPass | null = null;
  private fxaa: ShaderPass | null = null;
  private aoWanted = false;
  private postEnabled = false;
  /** Off for screenshots/benchmarks (?noadapt=1) so the buffer size stays predictable. */
  adaptive = true;
  private readonly onResize = (): void => this.resize();

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: settings.quality === 'high', powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    // Exposure stays at 1: overall brightness is owned by the sky/light intensities, not by the tone mapper.
    this.gl.toneMappingExposure = 1.0;
    // Soft-filtered shadow map. In three r185 PCFShadowMap *is* the soft filter (hardware PCF x 5 rotated Vogel-disk
    // taps; PCFSoftShadowMap is deprecated and falls back to it with a warning); the penumbra width is the light's
    // shadow.radius in texels, set by SkySystem.
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    // The composer issues several render() calls per frame; count them all instead of just the last pass.
    this.gl.info.autoReset = false;
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR);
    // Fog belongs to SkySystem (its colour and range follow the sky keys); the renderer installs none.
    this.applySettings(settings);
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(canvas.parentElement ?? canvas);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onResize);
    }
  }

  /** Fits the drawing buffer to the canvas parent (falls back to the window). */
  resize(): void {
    const parent = this.canvas.parentElement;
    let w = parent ? parent.clientWidth : 0;
    let h = parent ? parent.clientHeight : 0;
    if (w <= 0 || h <= 0) {
      w = typeof window !== 'undefined' ? window.innerWidth : 1280;
      h = typeof window !== 'undefined' ? window.innerHeight : 720;
    }
    this.gl.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      const r = this.gl.getPixelRatio();
      this.composer.setPixelRatio(r);
      this.composer.setSize(w, h);
      if (this.gtao) this.gtao.setSize(Math.max(1, Math.floor(w * r)), Math.max(1, Math.floor(h * r)));
      const pw = Math.max(1, Math.floor(w * r)), ph = Math.max(1, Math.floor(h * r));
      if (this.fxaa) (this.fxaa.material.uniforms.resolution.value as THREE.Vector2).set(1 / pw, 1 / ph);
      if (this.grade) (this.grade.material.uniforms.uResolution.value as THREE.Vector2).set(pw, ph);
    }
  }

  render(): void {
    this.gl.info.reset();
    if (this.postEnabled && this.composer) this.composer.render();
    else this.gl.render(this.scene, this.camera);
    this._drawCalls = this.gl.info.render.calls;
    this._triangles = this.gl.info.render.triangles;
  }

  /** Builds the post chain on first use: scene -> bloom -> tone map/sRGB -> grade+vignette -> FXAA. */
  private ensureComposer(): void {
    if (this.composer) return;
    const size = new THREE.Vector2(1, 1);
    this.gl.getSize(size);
    const r = this.gl.getPixelRatio();
    const pw = Math.max(1, Math.floor(size.x * r)), ph = Math.max(1, Math.floor(size.y * r));
    // The composer's own target has no multisampling by default, which is what made thin geometry - cornices, window
    // mullions, lamp posts, roof masts - crawl and break into dashes at distance. Ask for MSAA on it; FXAA then only
    // has to clean up what the resolve misses, so it can stay off while the hardware does the work.
    const rt = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, samples: POSTFX.msaaSamples });
    rt.texture.name = 'EffectComposer.rt1';
    const composer = new EffectComposer(this.gl, rt);
    composer.addPass(new RenderPass(this.scene, this.camera));
    // Ground-truth ambient occlusion straight after the colour pass: contact darkening where walls meet pavement,
    // under cars, inside window reveals. It renders its own normal/depth pass over the scene, so it is the one post
    // effect with a real geometry cost (+~35 draw calls, 2x triangles), so it is opt-in (Settings.ao). The pass must
    // be built at the drawing-buffer size and resized with the composer or its depth reads are meaningless.
    const gtao = new FoliageAwareGTAOPass(this.scene, this.camera, pw, ph);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = POSTFX.aoIntensity;
    gtao.updateGtaoMaterial({ radius: POSTFX.aoRadius, distanceExponent: 1, thickness: POSTFX.aoThickness, scale: 1, samples: POSTFX.aoSamples, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 8 });
    gtao.enabled = this.aoWanted;
    composer.addPass(gtao);
    this.gtao = gtao;
    this.bloom = new UnrealBloomPass(size, POSTFX.bloomStrength, POSTFX.bloomRadius, POSTFX.bloomThreshold);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    composer.addPass(this.grade);
    if (POSTFX.msaaSamples <= 0) {
      this.fxaa = new ShaderPass(FXAAShader);
      composer.addPass(this.fxaa);
    }
    this.composer = composer;
    this.resize();
  }

  /**
   * Daylight barely blooms (white facades would blow out); at night the neon, lit windows and headlights carry it.
   * Bloom samples the linear HDR frame before the OutputPass tone-maps it, so the thresholds are HDR values: by day it
   * must clear sunlit white paint (~1.5-2.5 linear) and catch only the sun disc; at night it drops to the emissives.
   */
  setBloomForNight(nightFactor: number): void {
    if (!this.bloom) return;
    const k = POSTFX.dayScale + (1 - POSTFX.dayScale) * nightFactor;
    this.bloom.strength = POSTFX.bloomStrength * k;
    this.bloom.threshold = POSTFX.bloomThresholdDay + (POSTFX.bloomThreshold - POSTFX.bloomThresholdDay) * nightFactor;
  }

  /**
   * Time-of-day grade: the split tone is almost off by day and peaks at dusk (the sun just above/below the horizon);
   * at night a small pedestal lifts the blacks. `time` feeds the grain so it does not freeze into a fixed pattern.
   */
  setGrade(nightFactor: number, duskFactor: number, time: number): void {
    if (!this.grade) return;
    const u = this.grade.material.uniforms;
    u.uTint.value = POSTFX.tintDay + (POSTFX.tintDusk - POSTFX.tintDay) * duskFactor;
    u.uNight.value = nightFactor;
    u.uTime.value = time;
  }

  /** Pixel ratio and shadow toggling; antialias is fixed at construction. */
  applySettings(s: Settings): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.baseRatio = Math.min(dpr, s.quality === 'high' ? 1.5 : 1);
    this.applyPixelRatio();
    this.postEnabled = s.quality === 'high';
    this.aoWanted = s.quality === 'high' && s.ao;
    if (this.gtao) {
      this.gtao.enabled = this.aoWanted;
      this.gtao.output = this.aoDebug ? GTAOPass.OUTPUT.AO : GTAOPass.OUTPUT.Default;
    }
    if (this.postEnabled) this.ensureComposer();
    const shadows = s.quality === 'high' && s.shadows;
    if (this.gl.shadowMap.enabled !== shadows) {
      this.gl.shadowMap.enabled = shadows;
      this.gl.shadowMap.needsUpdate = true;
    }
  }

  private applyPixelRatio(): void {
    const r = this.baseRatio * this.scale;
    if (Math.abs(r - this.appliedRatio) < 0.02) return;
    this.appliedRatio = r;
    this.gl.setPixelRatio(r);
    this.resize();
  }

  /** Current drawing-buffer scale (1 = native for the chosen quality). */
  get resolutionScale(): number { return this.scale; }

  /**
   * Nudges the drawing-buffer scale toward the frame-rate target. Called once per rendered frame with the
   * smoothed fps; a slow GPU loses pixels instead of frames, and the scale climbs back when there is headroom.
   */
  adapt(fps: number, frameDt: number): void {
    if (!this.adaptive) return;
    if (this.warmup < ADAPTIVE.warmupSec) { this.warmup += frameDt; return; }
    this.adaptClock += frameDt;
    if (this.adaptClock < ADAPTIVE.sampleSec) return;
    this.adaptClock = 0;
    if (fps <= 0) return;
    const before = this.scale;
    if (fps < ADAPTIVE.lowFps) this.scale = Math.max(ADAPTIVE.minScale, this.scale - ADAPTIVE.down);
    else if (fps > ADAPTIVE.highFps) this.scale = Math.min(ADAPTIVE.maxScale, this.scale + ADAPTIVE.up);
    if (this.scale !== before) this.applyPixelRatio();
  }

  get drawCalls(): number { return this._drawCalls; }
  get triangles(): number { return this._triangles; }

  /**
   * Debug aid (window.__GAME_SCENE__): per-object triangle estimate for the colour pass (camera frustum) and the sun
   * shadow pass (shadow camera frustum), heaviest first. Allocates; never called from the frame loop.
   */
  sceneBreakdown(): { name: string; tris: number; shadowTris: number; instances: number }[] {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const camFrustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    let shadowFrustum: THREE.Frustum | null = null;
    this.scene.traverse((o) => {
      if (shadowFrustum || !(o instanceof THREE.DirectionalLight) || !o.castShadow) return;
      const sc = o.shadow.camera;
      sc.updateMatrixWorld();
      shadowFrustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(sc.projectionMatrix, sc.matrixWorldInverse));
    });
    const rows: { name: string; tris: number; shadowTris: number; instances: number }[] = [];
    this.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.visible) return;
      const g = o.geometry as THREE.BufferGeometry;
      const per = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      const inst = o instanceof THREE.InstancedMesh ? o.count : 1;
      const tris = Math.round(per * inst);
      const inCam = o.frustumCulled ? camFrustum.intersectsObject(o) : true;
      const inShadow = o.castShadow && (!o.frustumCulled || !shadowFrustum || shadowFrustum.intersectsObject(o));
      if (!inCam && !inShadow) return;
      const name = o.name || (o.material as THREE.Material)?.name || o.type;
      rows.push({ name, tris: inCam ? tris : 0, shadowTris: inShadow ? tris : 0, instances: inst });
    });
    rows.sort((a, b) => (b.tris + b.shadowTris) - (a.tris + a.shadowTris));
    return rows;
  }

  disposeComposer(): void {
    if (!this.composer) return;
    if (this.gtao) { this.gtao.dispose(); this.gtao = null; }
    this.composer.dispose();
    this.composer = null;
    this.bloom = null;
    this.grade = null;
    this.fxaa = null;
  }

  dispose(): void {
    this.disposeComposer();
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onResize);
    this.gl.dispose();
  }
}
