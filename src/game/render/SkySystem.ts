// Sky: gradient dome shader, sun/moon sprites, stars, sun/moon directional light with a following shadow box, hemisphere light, fog keys. Track B.
import * as THREE from 'three';
import type { Vec3 } from '../core/Types';
import { clamp, lerp } from '../core/math';
import type { TextureFactory } from './TextureFactory';

export interface SkyKey { hour: number; top: number; horizon: number; sun: number; fog: number; sunI: number; ambI: number; fogNear: number; fogFar: number }

/** Keyframes by hour (wrap at 24). Sunset 18:30-19:15 reads as Vice City: horizon #ff7a3d, top #6a2c8f. */
export const SKY_KEYS: SkyKey[] = [
  { hour: 0, top: 0x05061c, horizon: 0x141a3a, sun: 0x000000, fog: 0x0c1028, sunI: 0, ambI: 0.28, fogNear: 60, fogFar: 380 },
  { hour: 4.5, top: 0x0a0c2a, horizon: 0x2a2148, sun: 0x000000, fog: 0x1a1634, sunI: 0, ambI: 0.3, fogNear: 60, fogFar: 380 },
  { hour: 6, top: 0x3a3a7a, horizon: 0xff9a5a, sun: 0xffb070, fog: 0xd08a70, sunI: 0.45, ambI: 0.55, fogNear: 140, fogFar: 520 },
  { hour: 7.5, top: 0x4f8ad8, horizon: 0xffd0a0, sun: 0xfff0d0, fog: 0xc8d0e0, sunI: 0.9, ambI: 0.85, fogNear: 160, fogFar: 620 },
  { hour: 12, top: 0x3a86e6, horizon: 0xb8dcf8, sun: 0xffffff, fog: 0xbcd6f0, sunI: 1.15, ambI: 1.0, fogNear: 160, fogFar: 620 },
  { hour: 16.5, top: 0x3f7fd0, horizon: 0xf0c8a0, sun: 0xfff0c8, fog: 0xd8c0b0, sunI: 1.0, ambI: 0.9, fogNear: 160, fogFar: 620 },
  { hour: 18, top: 0x6a3f9a, horizon: 0xff8a48, sun: 0xffc060, fog: 0xe07a58, sunI: 0.8, ambI: 0.7, fogNear: 140, fogFar: 520 },
  { hour: 19, top: 0x6a2c8f, horizon: 0xff7a3d, sun: 0xff8040, fog: 0xc85a58, sunI: 0.5, ambI: 0.5, fogNear: 140, fogFar: 520 },
  { hour: 20.5, top: 0x1c1440, horizon: 0x5a2a6a, sun: 0x000000, fog: 0x2a1c44, sunI: 0.05, ambI: 0.34, fogNear: 60, fogFar: 380 },
  { hour: 22, top: 0x07081f, horizon: 0x1e1c44, sun: 0x000000, fog: 0x0e1030, sunI: 0, ambI: 0.28, fogNear: 60, fogFar: 380 },
];

export const SKY_TUNING = { domeRadius: 850, sunDist: 700, sunScale: 130, moonScale: 55, starCount: 1400, shadowBox: 120, shadowMap: 2048, lightUnits: 3.0 } as const;

const VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
precision highp float;
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uStars; uniform sampler2D uStarTex;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float y = clamp(d.y, -1.0, 1.0);
  float t = pow(max(y, 0.0), 0.55);
  vec3 col = mix(uHorizon, uTop, t);
  if (y < 0.0) col = mix(uHorizon, uHorizon * 0.35, clamp(-y * 3.0, 0.0, 1.0));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 12.0) * 0.35 + pow(s, 200.0) * 0.8) * step(-0.08, uSunDir.y);
  vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(y) / 3.14159265 + 0.5);
  vec3 stars = texture2D(uStarTex, uv).rgb;
  col += stars * uStars * clamp(y * 2.5, 0.0, 1.0);
  gl_FragColor = vec4(col, 1.0);
}`;

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
  private readonly fog: THREE.Fog;
  private readonly cTop = new THREE.Color();
  private readonly cHor = new THREE.Color();
  private readonly cSun = new THREE.Color();
  private readonly cFog = new THREE.Color();
  private readonly cA = new THREE.Color();
  private readonly cB = new THREE.Color();
  private readonly moonColor = new THREE.Color(0x8fa0ff);
  private readonly nightAmbient = new THREE.Color(0x4a5a8a);
  private readonly sunLightColor = new THREE.Color();
  private readonly background = new THREE.Color();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(scene: THREE.Scene, camera: THREE.Camera, tex: TextureFactory) {
    this.scene = scene;
    this.camera = camera;
    const domeGeo = new THREE.SphereGeometry(SKY_TUNING.domeRadius, 32, 16);
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: { uTop: { value: new THREE.Color(0x2f7fe0) }, uHorizon: { value: new THREE.Color(0xb8dcf8) }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(0xffffff) }, uStars: { value: 0 }, uStarTex: { value: tex.starField() } },
      vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.dome = new THREE.Mesh(domeGeo, this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);
    const glow = tex.radialGlow();
    const sunMat = new THREE.SpriteMaterial({ map: glow, color: 0xffe0a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
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
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 10; sc.far = 500;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a2a30, 1);
    scene.add(this.hemi);
    if (scene.fog instanceof THREE.Fog) this.fog = scene.fog;
    else { this.fog = new THREE.Fog(0xbcd6f0, 160, 620); scene.fog = this.fog; }
    scene.background = this.background;
    this.geometries.push(domeGeo, starGeo);
    this.materials.push(this.domeMat, sunMat, moonMat, this.starMat);
  }

  /** Interpolates SKY_KEYS at the given hour into the color scratch fields; returns interpolated scalars via the out object. */
  private sample(hour: number, out: { sunI: number; ambI: number; fogNear: number; fogFar: number }): void {
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
    this.cFog.lerpColors(this.cA.setHex(a.fog), this.cB.setHex(b.fog), t);
    out.sunI = lerp(a.sunI, b.sunI, t);
    out.ambI = lerp(a.ambI, b.ambI, t);
    out.fogNear = lerp(a.fogNear, b.fogNear, t);
    out.fogFar = lerp(a.fogFar, b.fogFar, t);
  }

  private readonly scalars = { sunI: 0, ambI: 0, fogNear: 160, fogFar: 620 };
  /** Multiplies the fog distances (Engine sets < 1 on low quality to hide the far city sooner). */
  fogScale = 1;

  update(hour: number, sunDir: Vec3, nightFactor: number, playerX: number, playerZ: number, shadows: boolean): void {
    const s = this.scalars;
    this.sample(hour, s);
    const u = this.domeMat.uniforms;
    (u.uTop.value as THREE.Color).copy(this.cTop);
    (u.uHorizon.value as THREE.Color).copy(this.cHor);
    (u.uSunDir.value as THREE.Vector3).set(sunDir.x, sunDir.y, sunDir.z);
    (u.uSunColor.value as THREE.Color).copy(this.cSun);
    const starK = nightFactor * nightFactor * nightFactor;
    u.uStars.value = starK * 0.7;
    this.starMat.opacity = starK * 0.9;
    const cam = this.camera.position;
    this.dome.position.copy(cam);
    this.stars.position.copy(cam);
    const D = SKY_TUNING.sunDist;
    this.sunSprite.position.set(cam.x + sunDir.x * D, cam.y + sunDir.y * D, cam.z + sunDir.z * D);
    this.sunSprite.visible = sunDir.y > -0.12;
    (this.sunSprite.material as THREE.SpriteMaterial).color.copy(this.cSun).lerp(this.cHor, 0.3);
    this.moonSprite.position.set(cam.x - sunDir.x * D, cam.y - sunDir.y * D, cam.z - sunDir.z * D);
    this.moonSprite.visible = -sunDir.y > -0.05;
    (this.moonSprite.material as THREE.SpriteMaterial).opacity = nightFactor;
    // Fog + background follow the horizon/fog keys.
    this.fog.color.copy(this.cFog);
    this.fog.near = s.fogNear * this.fogScale;
    this.fog.far = s.fogFar * this.fogScale;
    this.background.copy(this.cHor);
    // Lights (physical units: scale by lightUnits).
    const L = SKY_TUNING.lightUnits;
    const moon = nightFactor > 0.9;
    const lx = moon ? -sunDir.x : sunDir.x, ly = moon ? -sunDir.y : sunDir.y, lz = moon ? -sunDir.z : sunDir.z;
    const ey = Math.max(ly, 0.15);
    if (moon) {
      this.sun.color.copy(this.moonColor);
      this.sun.intensity = 0.15 * L;
    } else {
      this.sunLightColor.copy(this.cSun);
      this.sun.color.copy(this.sunLightColor);
      this.sun.intensity = s.sunI * L * Math.max(0, 1 - nightFactor * 0.8);
    }
    this.hemi.color.copy(this.cTop).lerp(this.cHor, 0.4).lerp(this.nightAmbient, nightFactor * 0.85);
    this.hemi.groundColor.setHex(moon ? 0x181a26 : 0x4a3a34);
    this.hemi.intensity = s.ambI * L * 0.9 + nightFactor * 0.35;
    // Shadow box follows the player, snapped to shadow-map texels to avoid swimming.
    const texel = SKY_TUNING.shadowBox / SKY_TUNING.shadowMap;
    const tx = Math.round(playerX / texel) * texel, tz = Math.round(playerZ / texel) * texel;
    const dist = 220;
    this.sun.position.set(tx + lx * dist, ey * dist, tz + lz * dist);
    this.sun.target.position.set(tx, 0, tz);
    this.sun.target.updateMatrixWorld();
    const wantShadow = shadows && !moon && sunDir.y > 0.05;
    if (this.sun.castShadow !== wantShadow) this.sun.castShadow = wantShadow;
  }

  dispose(): void {
    this.scene.remove(this.dome, this.sunSprite, this.moonSprite, this.stars, this.sun, this.sun.target, this.hemi);
    for (let i = 0; i < this.geometries.length; i++) this.geometries[i].dispose();
    for (let i = 0; i < this.materials.length; i++) this.materials[i].dispose();
    this.sun.dispose();
    this.hemi.dispose();
  }
}
