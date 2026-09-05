// Authoritative simulation state: city, entities, spatial hashes, time, wanted/mission state. Track P0.
import type { EntityId, GamePhase, Vec2, VehicleRole } from '../core/Types';
import type { Random } from '../core/Random';
import { SpatialHash } from '../core/SpatialHash';
import type { StaticCollider } from '../core/Collision';
import { segmentVsAabb, segmentVsCircle } from '../core/Collision';
import type { CityData } from '../city/CityData';
import type { GeneratedCity } from '../city/CityGenerator';
import type { RoadGraph } from '../city/RoadGraph';
import type { SidewalkGraph } from '../city/SidewalkGraph';
import type { Entity } from '../entities/Entity';
import { Player } from '../entities/Player';
import type { Vehicle } from '../entities/Vehicle';
import type { Pedestrian } from '../entities/Pedestrian';

export interface WantedState { stars: number; heat: number; lastSeenTimer: number; lastCrimeTimer: number; flash: number; sirenActive: number }
export interface MissionState { activeId: string | null; activeTitle: string | null; step: number; timer: number; timeLimit: number; elapsed: number; objective: string | null; markerX: number; markerZ: number; markerVisible: boolean; missionVehicleId: EntityId | null; cooldowns: Record<string, number>; completed: Record<string, number> }
export interface HudSignals { prompt: string | null; hitFlashAt: number }

export const START_HOUR = 18;
export const DAY_LENGTH_SEC = 600;
const STATIC_CELL = 32;
const DYNAMIC_CELL = 16;

const losOut: StaticCollider[] = [];

export class World {
  city: CityData;
  roads: RoadGraph;
  sidewalks: SidewalkGraph;
  rng: Random;
  player: Player;
  vehicles = new Map<EntityId, Vehicle>();
  peds = new Map<EntityId, Pedestrian>();
  vehicleList: Vehicle[] = [];
  pedList: Pedestrian[] = [];
  staticHash = new SpatialHash<StaticCollider>(STATIC_CELL);
  dynamicHash = new SpatialHash<Entity>(DYNAMIC_CELL);
  time = { hour: START_HOUR, tick: 0, elapsed: 0, dayLengthSec: DAY_LENGTH_SEC };
  wanted: WantedState = { stars: 0, heat: 0, lastSeenTimer: 0, lastCrimeTimer: 0, flash: 0, sirenActive: 0 };
  mission: MissionState = { activeId: null, activeTitle: null, step: 0, timer: 0, timeLimit: 0, elapsed: 0, objective: null, markerX: 0, markerZ: 0, markerVisible: false, missionVehicleId: null, cooldowns: {}, completed: {} };
  hud: HudSignals = { prompt: null, hitFlashAt: 0 };
  phase: GamePhase = 'menu';

  constructor(gen: GeneratedCity, rng: Random) {
    this.city = gen.city;
    this.roads = gen.roads;
    this.sidewalks = gen.sidewalks;
    this.rng = rng;
    this.player = new Player();
    const cols = this.city.staticColliders;
    for (let i = 0; i < cols.length; i++) this.staticHash.insert(cols[i]);
    const sp = this.city.points.playerSpawn;
    this.player.reset(sp.x, sp.z, sp.yaw);
  }

  /** Copies curr -> prev for every entity and advances the tick counter. */
  beginTick(): void {
    this.player.snap();
    const vl = this.vehicleList;
    for (let i = 0; i < vl.length; i++) vl[i].snap();
    const pl = this.pedList;
    for (let i = 0; i < pl.length; i++) pl[i].snap();
    this.time.tick++;
  }

  addVehicle(v: Vehicle): Vehicle {
    if (!this.vehicles.has(v.id)) {
      this.vehicles.set(v.id, v);
      this.vehicleList.push(v);
    }
    return v;
  }

  removeVehicle(id: EntityId): void {
    const v = this.vehicles.get(id);
    if (!v) return;
    this.vehicles.delete(id);
    v.alive = false;
    const idx = this.vehicleList.indexOf(v);
    if (idx >= 0) this.vehicleList.splice(idx, 1);
  }

  addPed(p: Pedestrian): Pedestrian {
    if (!this.peds.has(p.id)) {
      this.peds.set(p.id, p);
      this.pedList.push(p);
    }
    return p;
  }

  removePed(id: EntityId): void {
    const p = this.peds.get(id);
    if (!p) return;
    this.peds.delete(id);
    p.alive = false;
    const idx = this.pedList.indexOf(p);
    if (idx >= 0) this.pedList.splice(idx, 1);
  }

  playerVehicle(): Vehicle | null {
    const id = this.player.vehicleId;
    if (id === null) return null;
    const v = this.vehicles.get(id);
    return v ? v : null;
  }

  playerPos(out: Vec2): Vec2 {
    out.x = this.player.curr.x;
    out.z = this.player.curr.z;
    return out;
  }

  playerYaw(): number {
    const v = this.playerVehicle();
    return v ? v.curr.yaw : this.player.curr.yaw;
  }

  /** Signed forward speed in a vehicle, planar speed on foot. */
  playerSpeed(): number {
    const v = this.playerVehicle();
    if (v) return v.speed;
    const p = this.player;
    return Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  }

  rebuildDynamicHash(): void {
    const h = this.dynamicHash;
    h.clear();
    const p = this.player;
    p.updateBounds();
    h.insert(p);
    const vl = this.vehicleList;
    for (let i = 0; i < vl.length; i++) {
      const v = vl[i];
      v.updateBounds();
      h.insert(v);
    }
    const pl = this.pedList;
    for (let i = 0; i < pl.length; i++) {
      const pd = pl[i];
      pd.updateBounds();
      h.insert(pd);
    }
  }

  /** True when no 'building'/'landmark' collider blocks the segment a->b. */
  hasLineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    const n = this.staticHash.querySegment(ax, az, bx, bz, 0, losOut);
    for (let i = 0; i < n; i++) {
      const c = losOut[i];
      if (c.tag !== 'building' && c.tag !== 'landmark') continue;
      const s = c.shape;
      if (s.kind === 'aabb') {
        if (segmentVsAabb(ax, az, bx, bz, s) >= 0) return false;
      } else if (segmentVsCircle(ax, az, bx, bz, s) >= 0) {
        return false;
      }
    }
    return true;
  }

  countByRole(role: VehicleRole): number {
    let n = 0;
    const vl = this.vehicleList;
    for (let i = 0; i < vl.length; i++) if (vl[i].role === role) n++;
    return n;
  }

  /** Removes all dynamic entities and resets player/wanted/mission/hud/time; the city is kept. */
  reset(): void {
    const vl = this.vehicleList;
    for (let i = 0; i < vl.length; i++) vl[i].alive = false;
    const pl = this.pedList;
    for (let i = 0; i < pl.length; i++) pl[i].alive = false;
    this.vehicles.clear();
    this.peds.clear();
    this.vehicleList.length = 0;
    this.pedList.length = 0;
    this.dynamicHash.clear();
    for (let i = 0; i < this.roads.nodes.length; i++) this.roads.nodes[i].occupantCount = 0;
    const sp = this.city.points.playerSpawn;
    this.player.reset(sp.x, sp.z, sp.yaw);
    const w = this.wanted;
    w.stars = 0; w.heat = 0; w.lastSeenTimer = 0; w.lastCrimeTimer = 0; w.flash = 0; w.sirenActive = 0;
    const m = this.mission;
    m.activeId = null; m.activeTitle = null; m.step = 0; m.timer = 0; m.timeLimit = 0; m.elapsed = 0; m.objective = null;
    m.markerX = 0; m.markerZ = 0; m.markerVisible = false; m.missionVehicleId = null; m.cooldowns = {}; m.completed = {};
    this.hud.prompt = null;
    this.hud.hitFlashAt = 0;
    this.time.hour = START_HOUR;
    this.time.tick = 0;
    this.time.elapsed = 0;
  }
}
