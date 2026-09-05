// Three.js WebGL renderer wrapper: scene, camera, resize observer, quality settings, fog, draw stats. Track P0.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import type { Settings } from '../state/GameStore';

export const SHADOW_MAP_SIZE = 2048;
export const CAMERA_FOV = 65;
export const CAMERA_NEAR = 0.3;
export const CAMERA_FAR = 900;

/** Bloom over the neon/emissive parts, then a filmic grade + vignette, then FXAA. */
export const POSTFX = { bloomStrength: 0.9, bloomRadius: 0.6, bloomThreshold: 0.95, dayScale: 0.35, vignette: 0.9, saturation: 1.1, contrast: 1.04, msaaSamples: 4 } as const;

/** Cheap grade: lifts saturation/contrast a touch and darkens the corners so the frame reads less flat. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: POSTFX.vignette },
    uSaturation: { value: POSTFX.saturation },
    uContrast: { value: POSTFX.contrast },
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
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D( tDiffuse, vUv );
      vec3 col = c.rgb;
      float l = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
      col = mix( vec3( l ), col, uSaturation );
      col = ( col - 0.5 ) * uContrast + 0.5;
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
  private readonly fog: THREE.Fog;
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
  private fxaa: ShaderPass | null = null;
  private postEnabled = false;
  /** Off for screenshots/benchmarks (?noadapt=1) so the buffer size stays predictable. */
  adaptive = true;
  private readonly onResize = (): void => this.resize();

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: settings.quality === 'high', powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    // The composer issues several render() calls per frame; count them all instead of just the last pass.
    this.gl.info.autoReset = false;
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR);
    this.fog = new THREE.Fog(0x000000, 160, 620);
    this.scene.fog = this.fog;
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
      if (this.fxaa) (this.fxaa.material.uniforms.resolution.value as THREE.Vector2).set(1 / (w * r), 1 / (h * r));
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
    // The composer's own target has no multisampling by default, which is what made thin geometry - cornices, window
    // mullions, lamp posts, roof masts - crawl and break into dashes at distance. Ask for MSAA on it; FXAA then only
    // has to clean up what the resolve misses, so it can stay off while the hardware does the work.
    const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(size.x * r)), Math.max(1, Math.floor(size.y * r)), {
      type: THREE.HalfFloatType, samples: POSTFX.msaaSamples,
    });
    rt.texture.name = 'EffectComposer.rt1';
    const composer = new EffectComposer(this.gl, rt);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(size, POSTFX.bloomStrength, POSTFX.bloomRadius, POSTFX.bloomThreshold);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    composer.addPass(new ShaderPass(GradeShader));
    if (POSTFX.msaaSamples <= 0) {
      this.fxaa = new ShaderPass(FXAAShader);
      composer.addPass(this.fxaa);
    }
    this.composer = composer;
    this.resize();
  }

  /**
   * Daylight barely blooms (white facades would blow out); at night the neon, lit windows and headlights carry it.
   * The threshold stays high so only genuinely bright pixels glow.
   */
  setBloomForNight(nightFactor: number): void {
    if (!this.bloom) return;
    const k = POSTFX.dayScale + (1 - POSTFX.dayScale) * nightFactor;
    this.bloom.strength = POSTFX.bloomStrength * k;
  }

  /** Pixel ratio and shadow toggling; antialias is fixed at construction. */
  applySettings(s: Settings): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.baseRatio = Math.min(dpr, s.quality === 'high' ? 1.5 : 1);
    this.applyPixelRatio();
    this.postEnabled = s.quality === 'high';
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

  setFog(color: number, near: number, far: number): void {
    this.fog.color.setHex(color);
    this.fog.near = near;
    this.fog.far = far;
  }

  get drawCalls(): number { return this._drawCalls; }
  get triangles(): number { return this._triangles; }

  disposeComposer(): void {
    if (!this.composer) return;
    this.composer.dispose();
    this.composer = null;
    this.bloom = null;
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
