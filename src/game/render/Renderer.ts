// Three.js WebGL renderer wrapper: scene, camera, resize observer, quality settings, fog, draw stats. Track P0.
import * as THREE from 'three';
import type { Settings } from '../state/GameStore';

export const SHADOW_MAP_SIZE = 2048;
export const CAMERA_FOV = 65;
export const CAMERA_NEAR = 0.3;
export const CAMERA_FAR = 900;

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly gl: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly fog: THREE.Fog;
  private observer: ResizeObserver | null = null;
  private _drawCalls = 0;
  private _triangles = 0;
  private readonly onResize = (): void => this.resize();

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: settings.quality === 'high', powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
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
  }

  render(): void {
    this.gl.render(this.scene, this.camera);
    this._drawCalls = this.gl.info.render.calls;
    this._triangles = this.gl.info.render.triangles;
  }

  /** Pixel ratio and shadow toggling; antialias is fixed at construction. */
  applySettings(s: Settings): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.gl.setPixelRatio(Math.min(dpr, s.quality === 'high' ? 1.5 : 1));
    const shadows = s.quality === 'high' && s.shadows;
    if (this.gl.shadowMap.enabled !== shadows) {
      this.gl.shadowMap.enabled = shadows;
      this.gl.shadowMap.needsUpdate = true;
    }
  }

  setFog(color: number, near: number, far: number): void {
    this.fog.color.setHex(color);
    this.fog.near = near;
    this.fog.far = far;
  }

  get drawCalls(): number { return this._drawCalls; }
  get triangles(): number { return this._triangles; }

  dispose(): void {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onResize);
    this.gl.dispose();
  }
}
