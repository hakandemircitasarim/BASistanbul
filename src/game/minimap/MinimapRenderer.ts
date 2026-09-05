// Minimap: pooled snapshot type, pre-rendered city base canvas (districts, roads, landmarks, Turkish labels) and per-frame blips. Track A.
import type { CityData, Landmark } from '../city/CityData';
import type { RoadGraph } from '../city/RoadGraph';
import { BEACH_X0, CITY_MAX_Z, CITY_MIN_Z, OCEAN_X0, ROAD_W } from '../city/CityConfig';
import { districtOf } from '../city/CityBuild';

export type BlipKind = 'player' | 'vehicle' | 'police' | 'mission' | 'objective' | 'hospital' | 'policeStation' | 'garage';
export interface Blip { kind: BlipKind; x: number; z: number; yaw: number }
export interface MinimapSnapshot { px: number; pz: number; pyaw: number; camYaw: number; blipCount: number; blips: Blip[] /* preallocated 160 */; wanted: number; hasObjective: boolean; objectiveX: number; objectiveZ: number; inVehicle: boolean }

export const MINIMAP_BLIP_CAPACITY = 160;

export function createMinimapSnapshot(): MinimapSnapshot {
  const blips: Blip[] = [];
  for (let i = 0; i < MINIMAP_BLIP_CAPACITY; i++) blips.push({ kind: 'vehicle', x: 0, z: 0, yaw: 0 });
  return { px: 0, pz: 0, pyaw: 0, camYaw: 0, blipCount: 0, blips, wanted: 0, hasObjective: false, objectiveX: 0, objectiveZ: 0, inVehicle: false };
}

const C_OCEAN = '#0d3b5c';
const C_SAND = '#d8c48a';
const C_GROUND = '#161b22';
const C_ROAD = '#5c6470';
const C_DOWNTOWN = '#1c2530';
const C_BEACHFRONT = '#2a2238';
const C_SUBURB = '#202a24';
const C_PARK = '#2f5d3a';
const C_PLAZA = '#3a3346';
const C_LABEL = '#f4f0ff';
const LANDMARK_TINT: Record<Landmark['kind'], string> = { tower: '#ff7a00', arena: '#b14bff', hospital: '#e04848', police: '#3b6bff', lighthouse: '#f5f5f5', ferris: '#ff2d95', pier: '#c9b98a' };
const LANDMARK_LABEL: Record<Landmark['kind'], string> = { tower: 'Kule', arena: 'Arena', hospital: 'Hastane', police: 'Polis', lighthouse: 'Fener', ferris: '', pier: 'İskele' };
const MARGIN = 60;
const RIM_INSET = 10;

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class MinimapRenderer {
  readonly base: HTMLCanvasElement; // pre-rendered city
  private readonly ppm: number;
  private readonly originX: number;
  private readonly originZ: number;

  constructor(city: CityData, roads: RoadGraph, pxPerMeter = 0.5) {
    this.ppm = pxPerMeter;
    this.originX = city.bounds.minX - MARGIN;
    this.originZ = city.bounds.minZ - MARGIN;
    const w = Math.ceil((city.bounds.maxX + MARGIN - this.originX) * pxPerMeter);
    const h = Math.ceil((city.bounds.maxZ + MARGIN - this.originZ) * pxPerMeter);
    this.base = document.createElement('canvas');
    this.base.width = w;
    this.base.height = h;
    const ctx = this.base.getContext('2d');
    if (!ctx) return;
    this.drawBase(ctx, city, roads, w, h);
  }

  private wx(x: number): number { return (x - this.originX) * this.ppm; }
  private wz(z: number): number { return (z - this.originZ) * this.ppm; }

  private drawBase(ctx: CanvasRenderingContext2D, city: CityData, roads: RoadGraph, w: number, h: number): void {
    const p = this.ppm;
    ctx.fillStyle = C_OCEAN;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = C_GROUND;
    ctx.fillRect(this.wx(city.bounds.minX), this.wz(CITY_MIN_Z), (BEACH_X0 - city.bounds.minX) * p, (CITY_MAX_Z - CITY_MIN_Z) * p);
    ctx.fillStyle = C_SAND;
    ctx.fillRect(this.wx(BEACH_X0), this.wz(CITY_MIN_Z), (OCEAN_X0 - BEACH_X0) * p, (CITY_MAX_Z - CITY_MIN_Z) * p);
    ctx.fillStyle = C_ROAD;
    const hw = ROAD_W / 2;
    for (let i = 0; i < roads.segments.length; i++) {
      const s = roads.segments[i];
      const a = roads.nodes[s.a], b = roads.nodes[s.b];
      const x0 = Math.min(a.x, b.x) - hw, x1 = Math.max(a.x, b.x) + hw;
      const z0 = Math.min(a.z, b.z) - hw, z1 = Math.max(a.z, b.z) + hw;
      ctx.fillRect(this.wx(x0), this.wz(z0), (x1 - x0) * p, (z1 - z0) * p);
    }
    for (let i = 0; i < city.blocks.length; i++) {
      const b = city.blocks[i];
      const d = districtOf(b.col, b.row);
      ctx.fillStyle = b.kind === 'park' ? C_PARK : b.kind === 'plaza' ? C_PLAZA : d === 'downtown' ? C_DOWNTOWN : d === 'beachfront' ? C_BEACHFRONT : C_SUBURB;
      ctx.fillRect(this.wx(b.x0), this.wz(b.z0), (b.x1 - b.x0) * p, (b.z1 - b.z0) * p);
    }
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < city.blocks.length; i++) {
      const b = city.blocks[i];
      if (b.kind === 'park') this.labels.push({ x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, text: 'Park' });
    }
    for (let i = 0; i < city.landmarks.length; i++) {
      const l = city.landmarks[i];
      ctx.fillStyle = LANDMARK_TINT[l.kind];
      if (l.kind === 'arena' || l.kind === 'lighthouse') {
        ctx.beginPath();
        ctx.ellipse(this.wx(l.x), this.wz(l.z), (l.w / 2) * p, (l.d / 2) * p, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (l.kind === 'ferris') {
        ctx.lineWidth = 2;
        ctx.strokeStyle = LANDMARK_TINT.ferris;
        ctx.beginPath();
        ctx.arc(this.wx(l.x), this.wz(l.z), (l.d / 2) * p, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillRect(this.wx(l.x - l.w / 2), this.wz(l.z - l.d / 2), l.w * p, l.d * p);
      }
      const text = LANDMARK_LABEL[l.kind];
      if (text) this.labels.push({ x: l.x, z: l.z + (l.kind === 'pier' ? -10 : l.kind === 'lighthouse' ? 14 : 0), text });
    }
  }

  /** Labels are drawn per frame (not baked into the base) so they stay upright when the map rotates with the camera. */
  private readonly labels: { x: number; z: number; text: string }[] = [];

  private drawLabels(ctx: CanvasRenderingContext2D, snap: MinimapSnapshot, scale: number, half: number, mapRot: number): void {
    const limit = (half + 20) * (half + 20);
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.labels.length; i++) {
      const l = this.labels[i];
      const lx = (l.x - snap.px) * scale, lz = (l.z - snap.pz) * scale;
      if (lx * lx + lz * lz > limit) continue;
      ctx.save();
      ctx.translate(lx, lz);
      ctx.rotate(-mapRot);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillText(l.text, 1, 1);
      ctx.fillStyle = C_LABEL;
      ctx.fillText(l.text, 0, 0);
      ctx.restore();
    }
  }

  /** Clips a circle, draws the rotated base window around the player, then the blips, north marker and player. */
  draw(ctx: CanvasRenderingContext2D, snap: MinimapSnapshot, sizePx: number, rangeM: number, rotate: boolean): void {
    const half = sizePx / 2;
    const scale = half / rangeM; // screen px per meter
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = C_OCEAN;
    ctx.fillRect(0, 0, sizePx, sizePx);
    ctx.translate(half, half);
    // Screen up = north (-z). With rotation, screen up = camera forward.
    const mapRot = rotate ? snap.camYaw - Math.PI : 0;
    ctx.rotate(mapRot);
    const dest = sizePx * 1.45; // cover the circle's corners when rotated
    const srcW = rangeM * 2 * 1.45 * this.ppm;
    const sx = (snap.px - this.originX) * this.ppm - srcW / 2;
    const sz = (snap.pz - this.originZ) * this.ppm - srcW / 2;
    ctx.drawImage(this.base, sx, sz, srcW, srcW, -dest / 2, -dest / 2, dest, dest);
    const policeRed = (((nowMs() / 250) | 0) & 1) === 0;
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const limit = (half + 8) * (half + 8);
    for (let i = 0; i < snap.blipCount; i++) {
      const b = snap.blips[i];
      const bx = (b.x - snap.px) * scale, bz = (b.z - snap.pz) * scale;
      if (bx * bx + bz * bz > limit) continue;
      switch (b.kind) {
        case 'vehicle':
          ctx.fillStyle = '#b8bcc4';
          ctx.fillRect(bx - 1.5, bz - 1.5, 3, 3);
          break;
        case 'police':
          ctx.fillStyle = policeRed ? '#ff3b3b' : '#3b6bff';
          ctx.beginPath();
          ctx.arc(bx, bz, 2, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'mission':
          ctx.strokeStyle = '#ff7a00';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(bx, bz, 2.5, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'hospital':
          this.badge(ctx, bx, bz, 'H', '#d83a3a', mapRot);
          break;
        case 'policeStation':
          this.badge(ctx, bx, bz, 'P', '#2f5fe0', mapRot);
          break;
        case 'garage':
          this.badge(ctx, bx, bz, 'G', '#7a7f88', mapRot);
          break;
        case 'objective':
          this.diamond(ctx, bx, bz);
          break;
        default:
          break;
      }
    }
    if (snap.hasObjective) {
      let ox = (snap.objectiveX - snap.px) * scale, oz = (snap.objectiveZ - snap.pz) * scale;
      const dist = Math.sqrt(ox * ox + oz * oz);
      const rim = half - RIM_INSET;
      if (dist > rim) {
        const k = rim / dist;
        ox *= k; oz *= k;
        // Arrow at the rim pointing toward the objective.
        const ux = ox / rim, uz = oz / rim;
        ctx.fillStyle = '#ffe14a';
        ctx.beginPath();
        ctx.moveTo(ox + ux * 7, oz + uz * 7);
        ctx.lineTo(ox - uz * 4, oz + ux * 4);
        ctx.lineTo(ox + uz * 4, oz - ux * 4);
        ctx.closePath();
        ctx.fill();
      }
      this.diamond(ctx, ox, oz);
    }
    this.drawLabels(ctx, snap, scale, half, mapRot);
    // North marker 'K' (Kuzey) at the rim, kept upright.
    ctx.save();
    ctx.translate(0, -(half - 9));
    ctx.rotate(-mapRot);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('K', 0, 0.5);
    ctx.restore();
    // Player: triangle at the center rotated by yaw relative to the map rotation.
    ctx.rotate(Math.PI - snap.pyaw);
    ctx.fillStyle = snap.inVehicle ? '#ff7a00' : '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (snap.wanted > 0) {
      ctx.strokeStyle = policeRed ? 'rgba(255,59,59,0.85)' : 'rgba(59,107,255,0.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(half, half, half - 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private badge(ctx: CanvasRenderingContext2D, x: number, z: number, text: string, color: string, mapRot: number): void {
    ctx.save();
    ctx.translate(x, z);
    ctx.rotate(-mapRot);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, 0, 0.5);
    ctx.restore();
  }

  private diamond(ctx: CanvasRenderingContext2D, x: number, z: number): void {
    ctx.fillStyle = '#ffe14a';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, z - 5);
    ctx.lineTo(x + 5, z);
    ctx.lineTo(x, z + 5);
    ctx.lineTo(x - 5, z);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  dispose(): void {
    this.base.width = 0;
    this.base.height = 0;
  }
}
