// Traffic/pedestrian headless sim: 180 s around a plaza; counts, gridlock, building penetration, NaN, collision rate, false flees + driver unit tests. Track E.
import { test, expect, createHeadless } from './harness';
import { DayNightSystem } from '../../src/game/systems/DayNightSystem';
import { PlayerMoveSystem } from '../../src/game/systems/PlayerMoveSystem';
import { VehicleEntrySystem } from '../../src/game/systems/VehicleEntrySystem';
import { VehiclePhysicsSystem } from '../../src/game/systems/VehiclePhysicsSystem';
import { CollisionSystem } from '../../src/game/systems/CollisionSystem';
import { TrafficSystem, TRAFFIC_TUNING, chooseNextWeighted } from '../../src/game/systems/TrafficSystem';
import { PedestrianSystem } from '../../src/game/systems/PedestrianSystem';
import { Vehicle, makeTrafficBrain } from '../../src/game/entities/Vehicle';
import { SPECS } from '../../src/game/entities/VehicleSpecs';
import { BUDGET } from '../../src/game/core/Budget';
import { FIXED_DT } from '../../src/game/core/Types';
import type { StaticCollider } from '../../src/game/core/Collision';
import type { Lane } from '../../src/game/city/RoadGraph';

interface MutableCamera { x: number; z: number; forwardX: number; forwardZ: number }

function makeSim(seed = 1907) {
  const traffic = new TrafficSystem();
  const peds = new PedestrianSystem();
  const h = createHeadless({
    seed,
    hour: 12,
    systems: () => [new DayNightSystem(), new PlayerMoveSystem(), new VehicleEntrySystem(), traffic, peds, new VehiclePhysicsSystem(), new CollisionSystem()],
  });
  return { h, traffic, peds };
}

const staticOut: StaticCollider[] = [];
function insideBuilding(h: ReturnType<typeof createHeadless>, x: number, z: number): boolean {
  const n = h.world.staticHash.queryCircle(x, z, 0.1, staticOut);
  for (let i = 0; i < n; i++) {
    const c = staticOut[i];
    if (c.tag !== 'building' && c.tag !== 'landmark') continue;
    const s = c.shape;
    if (s.kind === 'aabb') { if (x > s.minX && x < s.maxX && z > s.minZ && z < s.maxZ) return true; }
    else if ((x - s.cx) ** 2 + (z - s.cz) ** 2 < s.r * s.r) return true;
  }
  return false;
}

test('traffic sim: 180 s around a plaza sidewalk (counts, no gridlock, no penetration, no NaN, few crashes, no false flees)', () => {
  const { h, traffic, peds } = makeSim();
  const world = h.world;
  const start = world.city.points.missionStarts[0];
  world.player.reset(start.x, start.z, start.yaw);
  const cam = h.ctx.camera as unknown as MutableCamera;
  cam.x = start.x; cam.z = start.z; cam.forwardX = 1; cam.forwardZ = 0;
  expect(traffic.spawnParkedCars() === BUDGET.PARKED, `parked cars spawned: ${world.countByRole('parked')}`);

  let crashes = 0;
  h.ctx.events.on('vehicle:collision', (p) => { if (p.bId !== null && p.impactSpeed > 5) crashes++; });
  let reached20At = -1;
  let maxTraffic = 0, maxPeds = 0, maxBlocked = 0;
  let hornsWhileStill = 0;
  h.ctx.events.on('horn', () => { hornsWhileStill++; });
  let movingSamples = 0, sampleCount = 0;

  for (let sec = 1; sec <= 180; sec++) {
    h.secs(1);
    const t = world.countByRole('traffic');
    if (t > maxTraffic) maxTraffic = t;
    if (t >= 20 && reached20At < 0) reached20At = sec;
    if (world.pedList.length > maxPeds) maxPeds = world.pedList.length;
    const vl = world.vehicleList;
    for (let i = 0; i < vl.length; i++) {
      const v = vl[i];
      expect(isFinite(v.curr.x) && isFinite(v.curr.z) && isFinite(v.curr.yaw) && isFinite(v.vx) && isFinite(v.vz), `vehicle ${v.id} has NaN at ${sec}s`);
      if (v.role === 'traffic' && v.brain) {
        const bt = (v.brain as { blockedTimer: number }).blockedTimer;
        if (bt > maxBlocked) maxBlocked = bt;
        expect(bt <= 20, `traffic car ${v.id} blocked for ${bt.toFixed(1)} s at ${sec}s`);
        if (sec > 20) { sampleCount++; if (Math.abs(v.speed) > 1) movingSamples++; }
      }
      if (sec % 5 === 0) expect(!insideBuilding(h, v.curr.x, v.curr.z), `vehicle ${v.id} (${v.role}) inside a building at ${sec}s (${v.curr.x.toFixed(1)}, ${v.curr.z.toFixed(1)})`);
    }
    const pl = world.pedList;
    for (let i = 0; i < pl.length; i++) {
      const p = pl[i];
      expect(isFinite(p.curr.x) && isFinite(p.curr.z) && isFinite(p.curr.y), `ped ${p.id} has NaN at ${sec}s`);
    }
  }
  expect(reached20At > 0 && reached20At <= 30, `traffic reached 20 at ${reached20At}s (max ${maxTraffic})`);
  expect(maxPeds >= 30, `peds reached ${maxPeds} (< 30)`);
  expect(crashes < 9, `${crashes} vehicle-vehicle crashes > 5 m/s in 3 min (limit 3/min)`);
  expect(peds.stats.fleeTransitions < 5, `${peds.stats.fleeTransitions} FLEE transitions with the player standing still`);
  expect(peds.stats.hits === 0, `${peds.stats.hits} peds hit by traffic`);
  expect(movingSamples / Math.max(1, sampleCount) > 0.5, `traffic mostly stationary: ${(100 * movingSamples / Math.max(1, sampleCount)).toFixed(0)} % moving`);
  console.log(`    traffic max ${maxTraffic} (20 at ${reached20At}s), peds max ${maxPeds}, crashes ${crashes}, maxBlocked ${maxBlocked.toFixed(1)}s, ` +
    `flees ${peds.stats.fleeTransitions}, honks ${hornsWhileStill}, spawned ${traffic.stats.spawned}, despawned ${traffic.stats.despawned} (blocked ${traffic.stats.blockedDespawns}), ` +
    `moving ${(100 * movingSamples / Math.max(1, sampleCount)).toFixed(0)} %`);
});

test('driveAlongLane: a car follows its lane end to end, reserves the node, turns and continues on a successor', () => {
  const { h } = makeSim();
  const world = h.world;
  const roads = world.roads;
  // An interior lane (node (4,4) -> (5,4)) with a stop sign forced on so the stop logic runs.
  const from = roads.nodeAt(4, 4), to = roads.nodeAt(5, 4);
  let laneId = -1;
  for (let i = 0; i < from.outLanes.length; i++) if (roads.lanes[from.outLanes[i]].to === to.id && roads.lanes[from.outLanes[i]].index === 1) laneId = from.outLanes[i];
  expect(laneId >= 0, 'lane found');
  const lane: Lane = roads.lanes[laneId];
  to.stopSign = true;
  const v = new Vehicle(SPECS.sedan, lane.start.x, lane.start.z, Math.atan2(lane.dir.x, lane.dir.z), 'traffic', 0xffffff);
  const b = makeTrafficBrain();
  b.lane = laneId; b.t = 0; b.targetSpeed = 12;
  v.brain = b;
  world.addVehicle(v);
  let stoppedNearEnd = false, reserved = false, turned = false, maxLat = 0;
  for (let tick = 0; tick < 60 * 40; tick++) {
    const now = tick * FIXED_DT;
    TrafficSystem.driveAlongLane(v, b, roads, world, FIXED_DT, now, chooseNextWeighted);
    VehiclePhysicsSystem.integrate(v, FIXED_DT);
    if (b.lane === laneId && !b.inTurn) {
      const ox = v.curr.x - lane.start.x, oz = v.curr.z - lane.start.z;
      const lat = Math.abs(-ox * lane.dir.z + oz * lane.dir.x);
      if (lat > maxLat) maxLat = lat;
      if (Math.abs(v.speed) < 0.3 && lane.length - b.t < 4) stoppedNearEnd = true;
      if (b.reservedNode === to.id) reserved = true;
    }
    if (b.lane !== laneId) { turned = true; }
    if (turned && b.t > 30) break;
  }
  expect(stoppedNearEnd, 'car made a full stop at the stop sign');
  expect(reserved, 'car reserved the node');
  expect(turned, 'car moved onto a successor lane');
  expect(maxLat < 1.2, `car stayed on the lane line (max lateral ${maxLat.toFixed(2)} m)`);
  expect(to.occupantCount === 0, 'reservation released after the turn');
  expect(Math.abs(v.speed) <= TRAFFIC_TUNING.cruiseMax + 1, `speed ${v.speed.toFixed(1)} within cruise range`);
});

test('reservation rule: a turning car waits for a car already inside the node', () => {
  const { h } = makeSim();
  const roads = h.world.roads;
  const node = roads.nodeAt(3, 3);
  node.stopSign = false;
  expect(roads.reserve(node.id, 900, 0, true, 0), 'first straight car enters');
  expect(!roads.canEnter(node.id, 901, 1, false), 'turning car on the other axis must wait');
  expect(roads.canEnter(node.id, 902, 0, true), 'same-axis straight car may enter');
  roads.release(node.id, 900);
  expect(roads.canEnter(node.id, 901, 1, false), 'turn allowed once the node is empty');
});
