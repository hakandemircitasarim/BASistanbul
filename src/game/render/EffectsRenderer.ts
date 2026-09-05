// Effects: skid-mark ring buffer, tire smoke / damage smoke / dust and spark Points with life, explosion flash spheres. Track B.
import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import type { EntityId } from '../core/Types';
import type { World } from '../world/World';
import { clamp } from '../core/math';
import type { TextureFactory } from './TextureFactory';

export const FX_TUNING = { skidQuads: 3000, skidWidth: 0.3, skidY: 0.012, smokeMax: 400, sparkMax: 300, flashMax: 4, flashTime: 0.55, flashRadius: 13, smokeRise: 1.4, sparkGravity: 12, damageSmokeRate: 10 } as const;

const PVERT = `
attribute float aLife; attribute float aSize; attribute vec3 aColor;
varying float vLife; varying vec3 vColor;
void main() {
  vLife = aLife; vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (260.0 / max(1.0, -mv.z)) * step(0.001, aLife);
  gl_Position = projectionMatrix * mv;
}`;
const PFRAG = `
precision highp float;
uniform sampler2D uMap; uniform float uAlpha;
varying float vLife; varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor, t.a * vLife * uAlpha);
}`;

interface QueuedSkid { id: EntityId; intensity: number }

class ParticleSet {
  readonly points: THREE.Points;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly pos: Float32Array;
  readonly life: Float32Array;
  readonly size: Float32Array;
  readonly color: Float32Array;
  readonly vel: Float32Array;
  readonly decay: Float32Array;
  readonly grow: Float32Array;
  readonly max: number;
  private head = 0;

  constructor(max: number, map: THREE.Texture, additive: boolean, alpha: number) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.size = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.decay = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.geometry = new THREE.BufferGeometry();
    const p = new THREE.BufferAttribute(this.pos, 3); p.setUsage(THREE.DynamicDrawUsage);
    const l = new THREE.BufferAttribute(this.life, 1); l.setUsage(THREE.DynamicDrawUsage);
    const s = new THREE.BufferAttribute(this.size, 1); s.setUsage(THREE.DynamicDrawUsage);
    const c = new THREE.BufferAttribute(this.color, 3); c.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', p);
    this.geometry.setAttribute('aLife', l);
    this.geometry.setAttribute('aSize', s);
    this.geometry.setAttribute('aColor', c);
    this.material = new THREE.ShaderMaterial({ uniforms: { uMap: { value: map }, uAlpha: { value: alpha } }, vertexShader: PVERT, fragmentShader: PFRAG, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, grow: number, lifeSec: number, r: number, g: number, b: number): void {
    const i = this.head;
    this.head = (i + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = 1;
    this.decay[i] = 1 / Math.max(0.05, lifeSec);
    this.size[i] = size;
    this.grow[i] = grow;
    this.color[i * 3] = r; this.color[i * 3 + 1] = g; this.color[i * 3 + 2] = b;
  }

  step(dt: number, gravity: number): void {
    const n = this.max;
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= this.decay[i] * dt;
      if (this.life[i] <= 0) { this.life[i] = 0; continue; }
      this.vel[i * 3 + 1] -= gravity * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.05 && gravity > 0) { this.pos[i * 3 + 1] = 0.05; this.vel[i * 3 + 1] = 0; }
      this.size[i] += this.grow[i] * dt;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aLife.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class EffectsRenderer {
  private readonly scene: THREE.Scene;
  private readonly skidGeo: THREE.BufferGeometry;
  private readonly skidPos: Float32Array;
  private readonly skidMat: THREE.MeshBasicMaterial;
  private readonly skidMesh: THREE.Mesh;
  private skidHead = 0;
  private skidCount = 0;
  private skidDirty = false;
  private readonly smoke: ParticleSet;
  private readonly sparks: ParticleSet;
  private readonly flashes: THREE.Mesh[] = [];
  private readonly flashMats: THREE.MeshBasicMaterial[] = [];
  private readonly flashTimers: Float32Array;
  private readonly flashGeo: THREE.SphereGeometry;
  private readonly skidQueue: QueuedSkid[] = [];
  private skidQueueCount = 0;
  private readonly unsubs: (() => void)[] = [];

  constructor(scene: THREE.Scene, events: EventBus, tex: TextureFactory) {
    this.scene = scene;
    const Q = FX_TUNING.skidQuads;
    this.skidPos = new Float32Array(Q * 4 * 3);
    const index = new Uint32Array(Q * 6);
    for (let i = 0; i < Q; i++) {
      const v = i * 4, k = i * 6;
      index[k] = v; index[k + 1] = v + 1; index[k + 2] = v + 2; index[k + 3] = v; index[k + 4] = v + 2; index[k + 5] = v + 3;
    }
    this.skidGeo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.skidPos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    this.skidGeo.setAttribute('position', pa);
    this.skidGeo.setIndex(new THREE.BufferAttribute(index, 1));
    this.skidGeo.setDrawRange(0, 0);
    this.skidMat = new THREE.MeshBasicMaterial({ color: 0x161616, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false });
    this.skidMesh = new THREE.Mesh(this.skidGeo, this.skidMat);
    this.skidMesh.frustumCulled = false;
    this.skidMesh.renderOrder = 1;
    scene.add(this.skidMesh);
    const glow = tex.radialGlow();
    this.smoke = new ParticleSet(FX_TUNING.smokeMax, glow, false, 0.45);
    this.sparks = new ParticleSet(FX_TUNING.sparkMax, glow, true, 1.0);
    this.sparks.material.toneMapped = false;
    scene.add(this.smoke.points, this.sparks.points);
    this.flashGeo = new THREE.SphereGeometry(1, 16, 12);
    this.flashTimers = new Float32Array(FX_TUNING.flashMax);
    for (let i = 0; i < FX_TUNING.flashMax; i++) {
      const m = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
      const mesh = new THREE.Mesh(this.flashGeo, m);
      mesh.visible = false;
      mesh.renderOrder = 6;
      this.flashMats.push(m);
      this.flashes.push(mesh);
      scene.add(mesh);
    }
    for (let i = 0; i < 64; i++) this.skidQueue.push({ id: 0, intensity: 0 });
    this.unsubs.push(events.on('fx:skid', (p) => this.queueSkid(p.vehicleId, p.intensity)));
    this.unsubs.push(events.on('vehicle:collision', (p) => this.burstSparks(p.x, 0.5, p.z, clamp(p.impactSpeed * 3, 4, 40) | 0, 6)));
    this.unsubs.push(events.on('vehicle:destroyed', (p) => this.explode(p.x, p.z)));
    this.unsubs.push(events.on('ped:hit', (p) => this.dust(p.x, p.z)));
  }

  private queueSkid(id: EntityId, intensity: number): void {
    if (this.skidQueueCount >= this.skidQueue.length) return;
    const q = this.skidQueue[this.skidQueueCount++];
    q.id = id;
    q.intensity = intensity;
  }

  private burstSparks(x: number, y: number, z: number, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random());
      this.sparks.emit(x, y, z, Math.cos(a) * s, 2 + Math.random() * speed, Math.sin(a) * s, 0.35 + Math.random() * 0.3, -0.3, 0.35 + Math.random() * 0.4, 1, 0.75 + Math.random() * 0.2, 0.25);
    }
  }

  private dust(x: number, z: number): void {
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 1.5;
      this.smoke.emit(x, 0.4, z, Math.cos(a) * s, 0.8, Math.sin(a) * s, 0.9, 1.6, 0.8, 0.75, 0.68, 0.55);
    }
  }

  private explode(x: number, z: number): void {
    let slot = -1;
    for (let i = 0; i < this.flashTimers.length; i++) if (this.flashTimers[i] <= 0) { slot = i; break; }
    if (slot < 0) slot = 0;
    this.flashTimers[slot] = FX_TUNING.flashTime;
    const m = this.flashes[slot];
    m.position.set(x, 1.2, z);
    m.visible = true;
    this.burstSparks(x, 1, z, 60, 12);
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 4;
      this.smoke.emit(x, 1, z, Math.cos(a) * s, 3 + Math.random() * 4, Math.sin(a) * s, 2.5, 3, 1.5 + Math.random(), 0.12, 0.1, 0.1);
    }
  }

  private addSkid(x: number, z: number, dx: number, dz: number, len: number, width: number): void {
    const i = this.skidHead;
    this.skidHead = (i + 1) % FX_TUNING.skidQuads;
    if (this.skidCount < FX_TUNING.skidQuads) this.skidCount++;
    const rx = -dz * width * 0.5, rz = dx * width * 0.5;
    const fx = dx * len * 0.5, fz = dz * len * 0.5;
    const y = FX_TUNING.skidY;
    const p = this.skidPos, o = i * 12;
    p[o] = x - rx - fx; p[o + 1] = y; p[o + 2] = z - rz - fz;
    p[o + 3] = x + rx - fx; p[o + 4] = y; p[o + 5] = z + rz - fz;
    p[o + 6] = x + rx + fx; p[o + 7] = y; p[o + 8] = z + rz + fz;
    p[o + 9] = x - rx + fx; p[o + 10] = y; p[o + 11] = z - rz + fz;
    this.skidDirty = true;
  }

  private processSkids(world: World, frameDt: number): void {
    const n = this.skidQueueCount;
    this.skidQueueCount = 0;
    for (let k = 0; k < n; k++) {
      const q = this.skidQueue[k];
      const v = world.vehicles.get(q.id);
      if (!v) continue;
      const t = v.curr;
      const sy = Math.sin(t.yaw), cy = Math.cos(t.yaw);
      const hb = v.spec.wheelbase * 0.5, hw = v.spec.width * 0.5 - 0.15;
      const sp = Math.sqrt(v.vx * v.vx + v.vz * v.vz);
      let dx = sy, dz = cy;
      if (sp > 0.5) { dx = v.vx / sp; dz = v.vz / sp; }
      const len = clamp(sp * Math.max(frameDt, 1 / 60) * 1.4, 0.35, 1.4);
      const width = FX_TUNING.skidWidth * (0.7 + 0.6 * q.intensity);
      // Rear axle center = pos - forward * hb; wheels at +- right * hw.
      const ax = t.x - sy * hb, az = t.z - cy * hb;
      const rx = -cy * hw, rz = sy * hw;
      this.addSkid(ax + rx, az + rz, dx, dz, len, width);
      this.addSkid(ax - rx, az - rz, dx, dz, len, width);
      if (q.intensity > 0.15 && Math.random() < 0.6) {
        const side = Math.random() < 0.5 ? 1 : -1;
        this.smoke.emit(ax + rx * side, 0.3, az + rz * side, -dx * 0.5 + (Math.random() - 0.5), 0.8, -dz * 0.5 + (Math.random() - 0.5), 0.8, 2.2, 0.9, 0.82, 0.82, 0.84);
      }
    }
    if (this.skidDirty) {
      this.skidGeo.attributes.position.needsUpdate = true;
      this.skidGeo.setDrawRange(0, this.skidCount * 6);
      this.skidDirty = false;
    }
  }

  private damageSmoke(world: World, frameDt: number): void {
    const list = world.vehicleList;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.smoke <= 0) continue;
      if (Math.random() > v.smoke * frameDt * FX_TUNING.damageSmokeRate) continue;
      const t = v.curr;
      const sy = Math.sin(t.yaw), cy = Math.cos(t.yaw);
      const hx = t.x + sy * v.spec.length * 0.3, hz = t.z + cy * v.spec.length * 0.3;
      const dark = v.destroyed ? 0.12 : 0.5;
      this.smoke.emit(hx, v.spec.height + 0.2, hz, (Math.random() - 0.5) * 0.6, FX_TUNING.smokeRise, (Math.random() - 0.5) * 0.6, 0.9, 1.8, 1.4 + Math.random() * 0.6, dark, dark, dark);
    }
  }

  update(world: World, _alpha: number, frameDt: number): void {
    const dt = clamp(frameDt, 0, 0.1);
    this.processSkids(world, dt);
    this.damageSmoke(world, dt);
    this.smoke.step(dt, -0.4);
    this.sparks.step(dt, FX_TUNING.sparkGravity);
    for (let i = 0; i < this.flashTimers.length; i++) {
      if (this.flashTimers[i] <= 0) continue;
      this.flashTimers[i] -= dt;
      const k = 1 - Math.max(0, this.flashTimers[i]) / FX_TUNING.flashTime;
      const m = this.flashes[i];
      const s = 2 + k * FX_TUNING.flashRadius;
      m.scale.set(s, s, s);
      this.flashMats[i].opacity = (1 - k) * 0.9;
      if (this.flashTimers[i] <= 0) m.visible = false;
    }
  }

  dispose(): void {
    for (let i = 0; i < this.unsubs.length; i++) this.unsubs[i]();
    this.unsubs.length = 0;
    this.scene.remove(this.skidMesh, this.smoke.points, this.sparks.points);
    for (let i = 0; i < this.flashes.length; i++) { this.scene.remove(this.flashes[i]); this.flashMats[i].dispose(); }
    this.skidGeo.dispose();
    this.skidMat.dispose();
    this.smoke.dispose();
    this.sparks.dispose();
    this.flashGeo.dispose();
  }
}
