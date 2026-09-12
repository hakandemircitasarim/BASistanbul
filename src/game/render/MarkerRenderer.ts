// Mission markers: pulsing additive cylinders for mission starts (orange) and the objective (blue) with a bobbing arrow cone. Track B.
import * as THREE from 'three';
import type { World } from '../world/World';
import type { Materials } from './Materials';
import { clamp } from '../core/math';

export interface MarkerPoint { x: number; z: number }
/** Fills `out` (preallocated MARKER_CAPACITY entries) with available mission-start markers and returns the count (MissionSystem.availableMarkers). */
export type GetMarkers = (out: MarkerPoint[]) => number;

export const MARKER_CAPACITY = 8;
/**
 * Marker beams. `radius` and `opacity*` are deliberately small: the beam is a light column, not an object. At the old
 * 3 m / 0.5 a mission start was a solid orange wall — additive, double sided and of uniform brightness over its whole
 * 40 m, so standing 3 m from it put two full-opacity walls across the frame and tinted the entire street orange.
 * `fadePower` shapes the vertical falloff baked into the beam's vertex colours (1 at the foot, 0 at the top): the
 * brightness is concentrated in the first few metres, where a marker has to be read on foot, while the top half is
 * faint enough to stay legible against a bright sky instead of painting over it.
 */
export const MARKER_TUNING = {
  radius: 1.6, height: 34, opacityMin: 0.16, opacityMax: 0.34, fadePower: 1.9, pulseHz: 0.8, arrowY: 6, bob: 0.6,
  arrowSpin: 1.5,
  /**
   * Proximity fade: a beam `nearFrom` metres away or closer is drawn at `nearFloor` of its brightness, ramping to full
   * by `nearTo`. A 34 m column seen from three metres covers a third of the frame however faint its texels are, and
   * additive blending over that area is a colour filter on the whole street; by the time you are that close the HUD
   * prompt is up and the beam has done its job. Nothing beyond `nearTo` is touched, so it stays findable from far off.
   */
  nearFrom: 3, nearTo: 11, nearFloor: 0.12,
} as const;

const dummy = new THREE.Object3D();
const scratchColor = new THREE.Color();

/** Proximity fade factor of a beam at (x, z) seen from (camX, camZ); see MARKER_TUNING.nearFrom. */
function nearFade(x: number, z: number, camX: number, camZ: number): number {
  const T = MARKER_TUNING;
  const d = Math.hypot(x - camX, z - camZ);
  const t = clamp((d - T.nearFrom) / (T.nearTo - T.nearFrom), 0, 1);
  return T.nearFloor + (1 - T.nearFloor) * t * t * (3 - 2 * t);
}

/**
 * Bakes the vertical falloff into the beam's vertex colours (the marker materials are additive and unlit, so a colour
 * multiplier IS an opacity ramp) and returns the geometry. Authored after the translate, so y runs 0..height.
 */
function fadeBeam(g: THREE.CylinderGeometry, height: number, power: number): THREE.CylinderGeometry {
  const pos = g.attributes.position;
  const c = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = Math.pow(Math.max(0, 1 - pos.getY(i) / height), power);
    c[i * 3] = k; c[i * 3 + 1] = k; c[i * 3 + 2] = k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

export class MarkerRenderer {
  private readonly scene: THREE.Scene;
  private readonly starts: THREE.InstancedMesh;
  private readonly objective: THREE.Mesh;
  private readonly arrow: THREE.Mesh;
  private readonly startMat: THREE.MeshBasicMaterial;
  private readonly objMat: THREE.MeshBasicMaterial;
  private readonly arrowMat: THREE.MeshBasicMaterial;
  private readonly cylGeo: THREE.CylinderGeometry;
  private readonly coneGeo: THREE.ConeGeometry;
  private readonly points: MarkerPoint[] = [];
  private getMarkers: GetMarkers | null;

  constructor(scene: THREE.Scene, materials: Materials, getMarkers: GetMarkers | null = null) {
    this.scene = scene;
    this.getMarkers = getMarkers;
    for (let i = 0; i < MARKER_CAPACITY; i++) this.points.push({ x: 0, z: 0 });
    const T = MARKER_TUNING;
    // Two rows of cells: the fade is a vertex-colour ramp, so the column needs a mid station or the whole beam is one
    // linear gradient from foot to tip and the near-ground brightness is lost.
    this.cylGeo = new THREE.CylinderGeometry(T.radius, T.radius * 1.12, T.height, 20, 4, true);
    this.cylGeo.translate(0, T.height / 2, 0);
    fadeBeam(this.cylGeo, T.height, T.fadePower);
    this.coneGeo = new THREE.ConeGeometry(1.1, 2.2, 4);
    this.coneGeo.rotateX(Math.PI);
    this.startMat = materials.marker(0xff7a00);
    this.objMat = materials.marker(0x2f8bff);
    // Only the beams carry the fade ramp; the arrow cone has no colour attribute and keeps its flat tint.
    // Back faces only: a double-sided additive cylinder adds BOTH of its walls to every pixel inside its outline, and
    // when the camera walks into the beam the near wall is a full-screen orange filter. Drawing only the far wall
    // halves the tint, leaves the marker looking the same from outside (it is a hollow glow either way), and makes
    // standing on it a non-event.
    for (const m of [this.startMat, this.objMat]) { m.vertexColors = true; m.side = THREE.BackSide; }
    this.arrowMat = materials.marker(0x2f8bff);
    this.arrowMat.opacity = 0.9;
    this.starts = new THREE.InstancedMesh(this.cylGeo, this.startMat, MARKER_CAPACITY);
    // Per-instance colour carries the proximity fade (the vertical ramp is in the geometry's own vertex colours and
    // both multiply into the additive tint), so each start beam fades on its own distance.
    this.starts.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MARKER_CAPACITY * 3).fill(1), 3);
    this.starts.count = 0;
    this.starts.frustumCulled = false;
    this.starts.renderOrder = 4;
    this.objective = new THREE.Mesh(this.cylGeo, this.objMat);
    this.objective.visible = false;
    this.objective.renderOrder = 4;
    this.arrow = new THREE.Mesh(this.coneGeo, this.arrowMat);
    this.arrow.visible = false;
    this.arrow.renderOrder = 4;
    scene.add(this.starts, this.objective, this.arrow);
  }

  setMarkerSource(fn: GetMarkers | null): void {
    this.getMarkers = fn;
  }

  /** Reads world.mission for the objective and the marker callback for starts; time in seconds. */
  update(world: World, time: number): void {
    const T = MARKER_TUNING;
    const pulse = 0.5 + 0.5 * Math.sin(time * Math.PI * 2 * T.pulseHz);
    const opacity = T.opacityMin + (T.opacityMax - T.opacityMin) * pulse;
    this.startMat.opacity = opacity;
    this.objMat.opacity = opacity;
    let n = 0;
    if (this.getMarkers && world.mission.activeId === null) {
      n = this.getMarkers(this.points);
      if (n > MARKER_CAPACITY) n = MARKER_CAPACITY;
    }
    const camX = world.player.curr.x, camZ = world.player.curr.z;
    for (let i = 0; i < n; i++) {
      dummy.position.set(this.points[i].x, 0, this.points[i].z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      this.starts.setMatrixAt(i, dummy.matrix);
      this.starts.setColorAt(i, scratchColor.setScalar(nearFade(this.points[i].x, this.points[i].z, camX, camZ)));
    }
    this.starts.count = n;
    if (n > 0) {
      this.starts.instanceMatrix.needsUpdate = true;
      if (this.starts.instanceColor) this.starts.instanceColor.needsUpdate = true;
    }
    const m = world.mission;
    const show = m.markerVisible;
    this.objective.visible = show;
    this.arrow.visible = show;
    if (show) {
      // One objective beam, so its fade rides the material opacity instead of an instance colour.
      this.objMat.opacity = opacity * nearFade(m.markerX, m.markerZ, camX, camZ);
      this.objective.position.set(m.markerX, 0, m.markerZ);
      this.arrow.position.set(m.markerX, T.arrowY + Math.sin(time * 3) * T.bob, m.markerZ);
      this.arrow.rotation.y = time * T.arrowSpin;
    }
  }

  dispose(): void {
    this.scene.remove(this.starts, this.objective, this.arrow);
    this.starts.dispose();
    this.cylGeo.dispose();
    this.coneGeo.dispose();
  }
}
