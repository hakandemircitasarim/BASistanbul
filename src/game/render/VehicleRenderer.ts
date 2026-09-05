// Instanced vehicle rendering: per-spec merged bodies (paint + tinted glass + bumpers), wheels, light quads, player headlight spotlights. Track C.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { World } from '../world/World';
import type { Vehicle } from '../entities/Vehicle';
import type { VehicleKey, VehicleSpec } from '../entities/VehicleSpecs';
import { SPECS } from '../entities/VehicleSpecs';
import { BUDGET } from '../core/Budget';
import type { Transform } from '../core/Types';
import { createTransform, lerpTransform } from '../core/Transform';
import { clamp } from '../core/math';

export const VEHICLE_RENDER = {
  cullDist: 260, clearance: 0.28, wheelRadius: 0.33, wheelWidth: 0.24, lightsPerVehicle: 6, wheelsPerVehicle: 4,
  headlightIntensity: 90, headlightDistance: 50, headlightAngle: 0.5, headlightPenumbra: 0.45, sirenHz: 4,
};

const KEYS: VehicleKey[] = ['sedan', 'sport', 'van', 'police', 'taxi'];
const GLASS = 0.32;
const BUMPER = 0.12;

/** Box with a constant vertex color (r,g,b in 0..1) positioned at (x, y, z); nose toward +Z. */
function coloredBox(w: number, h: number, d: number, x: number, y: number, z: number, c: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const count = g.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { colors[i * 3] = c; colors[i * 3 + 1] = c; colors[i * 3 + 2] = c; }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Lower body + cabin (darker vertex color for glass) + bumpers (+ roof bar for police), base at y = 0. */
function bodyGeometry(s: VehicleSpec): THREE.BufferGeometry {
  const R = VEHICLE_RENDER;
  const L = s.length, W = s.width, H = s.height;
  const lowerH = H * 0.55;
  const cabinH = H - lowerH;
  const cabinL = s.key === 'van' ? L * 0.62 : L * 0.5;
  const cabinZ = s.key === 'van' ? L * 0.12 : s.key === 'sport' ? -L * 0.12 : -L * 0.08;
  const parts: THREE.BufferGeometry[] = [
    coloredBox(W, lowerH, L, 0, R.clearance + lowerH / 2, 0, 1),
    coloredBox(W * 0.84, cabinH, cabinL, 0, R.clearance + lowerH + cabinH / 2, cabinZ, GLASS),
    coloredBox(W * 0.96, 0.18, 0.14, 0, R.clearance + 0.12, L / 2 - 0.02, BUMPER),
    coloredBox(W * 0.96, 0.18, 0.14, 0, R.clearance + 0.12, -L / 2 + 0.02, BUMPER),
  ];
  if (s.hasBar) parts.push(coloredBox(W * 0.5, 0.12, 0.3, 0, R.clearance + H + 0.06, cabinZ, 0.1));
  const merged = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  return merged;
}

export class VehicleRenderer {
  private readonly scene: THREE.Scene;
  private readonly bodies: Record<VehicleKey, THREE.InstancedMesh>;
  private readonly wheels: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;
  private readonly bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly wheelMat = new THREE.MeshLambertMaterial({ color: 0x141414 });
  private readonly lightMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: false, toneMapped: false });
  private readonly spotL: THREE.SpotLight;
  private readonly spotR: THREE.SpotLight;
  private readonly counts: Record<VehicleKey, number> = { sedan: 0, sport: 0, van: 0, police: 0, taxi: 0 };
  private readonly interp: Transform = createTransform();
  private readonly mat = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scl = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly color = new THREE.Color();
  private nightFactor = 1;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const cap = BUDGET.MAX_VEHICLES;
    this.bodies = {} as Record<VehicleKey, THREE.InstancedMesh>;
    for (let i = 0; i < KEYS.length; i++) {
      const key = KEYS[i];
      const mesh = new THREE.InstancedMesh(bodyGeometry(SPECS[key]), this.bodyMat, cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.color.setRGB(1, 1, 1);
      for (let k = 0; k < cap; k++) mesh.setColorAt(k, this.color);
      this.bodies[key] = mesh;
      scene.add(mesh);
    }
    const wheelGeo = new THREE.CylinderGeometry(VEHICLE_RENDER.wheelRadius, VEHICLE_RENDER.wheelRadius, VEHICLE_RENDER.wheelWidth, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    this.wheels = new THREE.InstancedMesh(wheelGeo, this.wheelMat, cap * VEHICLE_RENDER.wheelsPerVehicle);
    this.wheels.count = 0;
    this.wheels.frustumCulled = false;
    this.wheels.castShadow = true;
    this.wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.wheels);
    const lightGeo = new THREE.PlaneGeometry(0.36, 0.16);
    this.lights = new THREE.InstancedMesh(lightGeo, this.lightMat, cap * VEHICLE_RENDER.lightsPerVehicle);
    this.lights.count = 0;
    this.lights.frustumCulled = false;
    this.lights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.color.setRGB(0.2, 0.2, 0.2);
    for (let k = 0; k < cap * VEHICLE_RENDER.lightsPerVehicle; k++) this.lights.setColorAt(k, this.color);
    scene.add(this.lights);
    this.spotL = this.makeSpot();
    this.spotR = this.makeSpot();
  }

  private makeSpot(): THREE.SpotLight {
    const R = VEHICLE_RENDER;
    const s = new THREE.SpotLight(0xfff1d0, 0, R.headlightDistance, R.headlightAngle, R.headlightPenumbra, 1.2);
    s.castShadow = false;
    this.scene.add(s);
    this.scene.add(s.target);
    return s;
  }

  /** 0 = full day (headlights dimmed), 1 = night. Integrator feeds DayNightSystem.nightFactor(). */
  setNightFactor(f: number): void {
    this.nightFactor = clamp(f, 0, 1);
  }

  sync(world: World, alpha: number, time: number, camX: number, camZ: number): void {
    const R = VEHICLE_RENDER;
    const list = world.vehicleList;
    const counts = this.counts;
    counts.sedan = 0; counts.sport = 0; counts.van = 0; counts.police = 0; counts.taxi = 0;
    let wheelIdx = 0;
    let lightIdx = 0;
    const sirenPhase = Math.floor(time * R.sirenHz * 2) % 2;
    let spotsSet = false;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const key = v.spec.key;
      const mesh = this.bodies[key];
      const idx = counts[key]++;
      v.renderIndex = idx;
      lerpTransform(this.interp, v.prev, v.curr, alpha);
      const t = this.interp;
      const dx = t.x - camX, dz = t.z - camZ;
      const visible = dx * dx + dz * dz < R.cullDist * R.cullDist;
      const sc = visible ? Math.max(0.001, v.spawnFade) : 0;
      const yaw = t.yaw;
      this.euler.set(0, yaw, 0);
      this.quat.setFromEuler(this.euler);
      this.pos.set(t.x, t.y, t.z);
      this.scl.set(sc, sc, sc);
      this.mat.compose(this.pos, this.quat, this.scl);
      mesh.setMatrixAt(idx, this.mat);
      this.paintColor(v);
      mesh.setColorAt(idx, this.color);
      if (visible) {
        wheelIdx = this.syncWheels(v, t, sc, wheelIdx);
        lightIdx = this.syncLights(v, t, sc, sirenPhase, lightIdx);
        if (v.occupiedByPlayer) { this.syncSpots(v, t); spotsSet = true; }
      }
    }
    for (let i = 0; i < KEYS.length; i++) {
      const mesh = this.bodies[KEYS[i]];
      mesh.count = counts[KEYS[i]];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.wheels.count = wheelIdx;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.lights.count = lightIdx;
    this.lights.instanceMatrix.needsUpdate = true;
    if (this.lights.instanceColor) this.lights.instanceColor.needsUpdate = true;
    if (!spotsSet) { this.spotL.intensity = 0; this.spotR.intensity = 0; }
  }

  private paintColor(v: Vehicle): void {
    const c = this.color;
    if (v.destroyed) { c.setRGB(0.05, 0.05, 0.05); return; }
    c.setHex(v.color);
    const hp = v.health / 100;
    const k = 0.25 + 0.75 * hp * hp; // steep: a badly dented car reads dark from a distance
    c.multiplyScalar(k);
    if (v.damageFlash > 0) {
      const f = v.damageFlash * 0.6;
      c.r += (1 - c.r) * f; c.g += (1 - c.g) * f; c.b += (1 - c.b) * f;
    }
  }

  private syncWheels(v: Vehicle, t: Transform, sc: number, idx: number): number {
    const R = VEHICLE_RENDER;
    const yaw = t.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const hw = v.spec.width * 0.5 - R.wheelWidth * 0.5 + 0.04;
    const hb = v.spec.wheelbase * 0.5;
    for (let w = 0; w < 4; w++) {
      const side = w % 2 === 0 ? -1 : 1;
      const front = w < 2;
      const ox = side * hw, oz = front ? hb : -hb;
      this.pos.set(t.x + rx * ox + fx * oz, t.y + R.wheelRadius * sc, t.z + rz * ox + fz * oz);
      this.euler.set(v.wheelSpin, yaw + (front ? v.steerAngle : 0), 0);
      this.quat.setFromEuler(this.euler);
      this.scl.set(sc, sc, sc);
      this.mat.compose(this.pos, this.quat, this.scl);
      this.wheels.setMatrixAt(idx++, this.mat);
    }
    return idx;
  }

  private syncLights(v: Vehicle, t: Transform, sc: number, sirenPhase: number, idx: number): number {
    const R = VEHICLE_RENDER;
    const yaw = t.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const s = v.spec;
    const hw = s.width * 0.5, hl = s.length * 0.5;
    const lampY = R.clearance + s.height * 0.55 * 0.6;
    const wreck = v.destroyed;
    const braking = v.controls.brake > 0 || (v.controls.throttle < 0 && v.speed > 0.5);
    const c = this.color;
    for (let k = 0; k < 6; k++) {
      let ox = 0, oz = 0, oy = lampY, rot = yaw, scale = sc;
      if (k < 2) { ox = (k === 0 ? -1 : 1) * hw * 0.65; oz = hl + 0.02; }
      else if (k < 4) { ox = (k === 2 ? -1 : 1) * hw * 0.65; oz = -hl - 0.02; rot = yaw + Math.PI; }
      else {
        if (!s.hasBar) scale = 0;
        ox = (k === 4 ? -1 : 1) * 0.2; oz = -s.length * 0.08; oy = R.clearance + s.height + 0.13;
      }
      this.pos.set(t.x + rx * ox + fx * oz, t.y + oy * sc, t.z + rz * ox + fz * oz);
      this.euler.set(0, rot, 0);
      this.quat.setFromEuler(this.euler);
      this.scl.set(scale, scale, scale);
      this.mat.compose(this.pos, this.quat, this.scl);
      this.lights.setMatrixAt(idx, this.mat);
      if (wreck) c.setRGB(0.05, 0.05, 0.05);
      else if (k < 2) { if (v.lightsOn) c.setRGB(1, 0.97, 0.85); else c.setRGB(0.32, 0.32, 0.28); }
      else if (k < 4) {
        if (braking) c.setRGB(1, 0.16, 0.1);
        else if (v.lightsOn) c.setRGB(0.85, 0.08, 0.05);
        else c.setRGB(0.3, 0.05, 0.04);
      } else if (v.sirenOn) {
        const red = (k === 4) === (sirenPhase === 0);
        if (red) c.setRGB(1, 0.1, 0.1); else c.setRGB(0.2, 0.4, 1);
      } else c.setRGB(0.12, 0.12, 0.14);
      this.lights.setColorAt(idx, c);
      idx++;
    }
    return idx;
  }

  private syncSpots(v: Vehicle, t: Transform): void {
    const R = VEHICLE_RENDER;
    const yaw = t.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const hw = v.spec.width * 0.5 * 0.65, hl = v.spec.length * 0.5;
    const y = R.clearance + v.spec.height * 0.4;
    const intensity = v.lightsOn && !v.destroyed ? R.headlightIntensity * Math.max(0.15, this.nightFactor) : 0;
    this.spotL.position.set(t.x - rx * hw + fx * hl, t.y + y, t.z - rz * hw + fz * hl);
    this.spotR.position.set(t.x + rx * hw + fx * hl, t.y + y, t.z + rz * hw + fz * hl);
    this.spotL.target.position.set(t.x - rx * hw + fx * (hl + 30), 0, t.z - rz * hw + fz * (hl + 30));
    this.spotR.target.position.set(t.x + rx * hw + fx * (hl + 30), 0, t.z + rz * hw + fz * (hl + 30));
    this.spotL.intensity = intensity;
    this.spotR.intensity = intensity;
  }

  dispose(): void {
    for (let i = 0; i < KEYS.length; i++) {
      const mesh = this.bodies[KEYS[i]];
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.scene.remove(this.wheels);
    this.wheels.geometry.dispose();
    this.wheels.dispose();
    this.scene.remove(this.lights);
    this.lights.geometry.dispose();
    this.lights.dispose();
    this.scene.remove(this.spotL, this.spotL.target, this.spotR, this.spotR.target);
    this.spotL.dispose();
    this.spotR.dispose();
    this.bodyMat.dispose();
    this.wheelMat.dispose();
    this.lightMat.dispose();
  }
}
