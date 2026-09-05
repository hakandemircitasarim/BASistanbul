// Mission markers: pulsing additive cylinders for mission starts (orange) and the objective (blue) with a bobbing arrow cone. Track B.
import * as THREE from 'three';
import type { World } from '../world/World';
import type { Materials } from './Materials';

export interface MarkerPoint { x: number; z: number }
/** Fills `out` (preallocated MARKER_CAPACITY entries) with available mission-start markers and returns the count (MissionSystem.availableMarkers). */
export type GetMarkers = (out: MarkerPoint[]) => number;

export const MARKER_CAPACITY = 8;
export const MARKER_TUNING = { radius: 3, height: 40, opacityMin: 0.25, opacityMax: 0.5, pulseHz: 0.8, arrowY: 6, bob: 0.6, arrowSpin: 1.5 } as const;

const dummy = new THREE.Object3D();

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
    this.cylGeo = new THREE.CylinderGeometry(T.radius, T.radius, T.height, 24, 1, true);
    this.cylGeo.translate(0, T.height / 2, 0);
    this.coneGeo = new THREE.ConeGeometry(1.1, 2.2, 4);
    this.coneGeo.rotateX(Math.PI);
    this.startMat = materials.marker(0xff7a00);
    this.objMat = materials.marker(0x2f8bff);
    this.arrowMat = materials.marker(0x2f8bff);
    this.arrowMat.opacity = 0.9;
    this.starts = new THREE.InstancedMesh(this.cylGeo, this.startMat, MARKER_CAPACITY);
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
    for (let i = 0; i < n; i++) {
      dummy.position.set(this.points[i].x, 0, this.points[i].z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      this.starts.setMatrixAt(i, dummy.matrix);
    }
    this.starts.count = n;
    if (n > 0) this.starts.instanceMatrix.needsUpdate = true;
    const m = world.mission;
    const show = m.markerVisible;
    this.objective.visible = show;
    this.arrow.visible = show;
    if (show) {
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
