// Missions headless sim: marker prompt + E start, sahil (+500 at the pier), kurye (mission car delivered to the garage), takip (3 stars), cooldowns. Track F.
import { test, expect, createHeadless } from './harness';
import { DayNightSystem } from '../../src/game/systems/DayNightSystem';
import { PlayerMoveSystem } from '../../src/game/systems/PlayerMoveSystem';
import { VehicleEntrySystem } from '../../src/game/systems/VehicleEntrySystem';
import { VehiclePhysicsSystem } from '../../src/game/systems/VehiclePhysicsSystem';
import { CollisionSystem } from '../../src/game/systems/CollisionSystem';
import { TrafficSystem } from '../../src/game/systems/TrafficSystem';
import { PedestrianSystem } from '../../src/game/systems/PedestrianSystem';
import { PoliceSystem } from '../../src/game/systems/PoliceSystem';
import { WantedSystem, setStars } from '../../src/game/systems/WantedSystem';
import { MissionSystem } from '../../src/game/systems/MissionSystem';
import { createMissionDefs, resolveMissionPositions, formatMoney, LOSE_WANTED_OBJECTIVE } from '../../src/game/missions/definitions';
import type { LanePos } from '../../src/game/city/RoadGraph';

interface MutableCamera { x: number; z: number; forwardX: number; forwardZ: number }

function makeSim(seed = 1907) {
  const traffic = new TrafficSystem();
  const missions = new MissionSystem();
  const police = new PoliceSystem();
  const h = createHeadless({
    seed,
    hour: 12,
    systems: () => [new DayNightSystem(), new PlayerMoveSystem(), new VehicleEntrySystem(), traffic, police, new PedestrianSystem(),
      new VehiclePhysicsSystem(), new CollisionSystem(), new WantedSystem(), missions],
  });
  traffic.spawnParkedCars();
  // Stub camera at the player so the hidden-spawn rule has a meaningful cone (as in traffic.sim).
  const sp = h.world.city.points.playerSpawn;
  const cam = h.ctx.camera as unknown as MutableCamera;
  cam.x = sp.x; cam.z = sp.z; cam.forwardX = 1; cam.forwardZ = 0;
  return { h, missions, police };
}

function insideStatic(h: ReturnType<typeof createHeadless>, x: number, z: number): boolean {
  const out: { shape: { kind: string; minX?: number; maxX?: number; minZ?: number; maxZ?: number; cx?: number; cz?: number; r?: number } }[] = [];
  const n = h.world.staticHash.queryCircle(x, z, 0.1, out as never);
  for (let i = 0; i < n; i++) {
    const s = out[i].shape;
    if (s.kind === 'aabb' && x > s.minX! && x < s.maxX! && z > s.minZ! && z < s.maxZ!) return true;
    if (s.kind === 'circle' && (x - s.cx!) ** 2 + (z - s.cz!) ** 2 < s.r! * s.r!) return true;
  }
  return false;
}

test('definitions: positions resolve from city.points, never inside a static collider', () => {
  const { h } = makeSim();
  const city = h.world.city;
  const defs = resolveMissionPositions(createMissionDefs(), city, h.world.roads);
  expect(defs.length === 3 && defs[0].id === 'sahil' && defs[1].id === 'kurye' && defs[2].id === 'takip', 'three missions in order');
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const s = city.points.missionStarts[i];
    expect(d.startX === s.x && d.startZ === s.z, `${d.id} start = missionStarts[${i}]`);
    expect(!insideStatic(h, d.startX, d.startZ), `${d.id} start marker not inside a collider`);
  }
  expect(defs[0].steps[0].x === city.points.pier.x && defs[0].steps[0].z === city.points.pier.z, 'sahil goto = pier');
  expect(defs[1].steps[1].x === city.points.garage.x && defs[1].steps[1].z === city.points.garage.z, 'kurye deliver = garage');
  const sv = defs[1].spawnVehicle;
  expect(sv !== undefined && Math.hypot(sv.x - defs[1].startX, sv.z - defs[1].startZ) <= 40, 'kurye car spot within 40 m of the start');
  expect(sv !== undefined && !insideStatic(h, sv.x, sv.z), 'kurye car spot not inside a collider');
  expect(formatMoney(1500) === '$1.500' && formatMoney(500) === '$500' && formatMoney(1234567) === '$1.234.567', 'tr-TR money format');
});

test('sahil: walking into the marker shows the prompt, E starts, reaching the pier pays +500', () => {
  const { h, missions } = makeSim();
  const world = h.world;
  const def = missions.defs[0];
  const markers = [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }];
  expect(missions.availableMarkers(markers) === 3, 'three markers available');
  world.player.reset(def.startX, def.startZ, 0);
  h.step(2);
  expect(world.hud.prompt === 'E - Görevi başlat: Sahil Yürüyüşü', `prompt: ${world.hud.prompt}`);
  const money0 = world.player.money;
  let started = '', completedReward = 0, objective = '', notified = '';
  h.ctx.events.on('mission:started', (p) => { started = p.id; });
  h.ctx.events.on('mission:objective', (p) => { objective = p.text; });
  h.ctx.events.on('mission:completed', (p) => { completedReward = p.reward; });
  h.ctx.events.on('notify', (p) => { if (p.text.startsWith('Görev tamamlandı')) notified = p.text; });
  h.input.setKey('KeyE', true);
  h.step(1);
  h.input.setKey('KeyE', false);
  expect(started === 'sahil' && world.mission.activeId === 'sahil' && world.mission.activeTitle === 'Sahil Yürüyüşü', 'mission started on E');
  expect(objective.length > 0 && world.mission.objective === objective, 'objective published');
  expect(missions.availableMarkers(markers) === 0, 'markers hidden during a mission');
  expect(world.mission.markerVisible && world.mission.markerX === world.city.points.pier.x, 'objective marker at the pier');
  const pier = world.city.points.pier;
  world.player.reset(pier.x, pier.z, 0);
  h.step(3);
  expect(completedReward === 500, `completed with +500 (got ${completedReward})`);
  expect(world.player.money === money0 + 500, 'money credited');
  expect(notified === 'Görev tamamlandı: +$500', `toast: ${notified}`);
  expect(world.mission.activeId === null && !world.mission.markerVisible, 'mission state cleared');
  expect(missions.availableMarkers(markers) === 2, 'sahil on cooldown (2 markers left)');
  h.secs(31);
  expect(missions.availableMarkers(markers) === 3, 'cooldown expired after 30 s');
});

test('kurye: orange sport car spawns near the start, enter it, deliver stopped at the garage -> +1500 (+500 time bonus)', () => {
  const { h, missions } = makeSim();
  const world = h.world;
  const def = missions.defs[1];
  world.player.reset(def.startX, def.startZ, 0);
  h.step(1);
  expect(missions.startMission('kurye'), 'kurye starts');
  const mv = world.vehicles.get(world.mission.missionVehicleId ?? -1);
  expect(mv !== undefined && mv.role === 'mission' && mv.spec.key === 'sport' && mv.color === 0xff7a00, 'orange sport mission car spawned');
  if (!mv) return;
  expect(Math.hypot(mv.curr.x - def.startX, mv.curr.z - def.startZ) <= 40, 'car within 40 m of the start');
  expect(world.mission.markerVisible && Math.hypot(world.mission.markerX - mv.curr.x, world.mission.markerZ - mv.curr.z) < 1, 'marker on the car');
  // Walk next to the car and press E (VehicleEntrySystem handles the entry).
  const yaw = mv.curr.yaw;
  world.player.reset(mv.curr.x - Math.cos(yaw) * 1.8, mv.curr.z + Math.sin(yaw) * 1.8, yaw);
  h.step(1);
  h.input.setKey('KeyE', true);
  h.step(1);
  h.input.setKey('KeyE', false);
  expect(world.player.vehicleId === mv.id, 'player entered the mission car');
  h.step(2);
  expect(world.mission.step === 1 && world.mission.objective === 'Arabayı garaja götür', `deliver step active (step ${world.mission.step})`);
  // Teleport the car (with the player inside) to the curb next to the garage point, stopped.
  const g = world.city.points.garage;
  const lp: LanePos = { lane: 0, t: 0 };
  world.roads.nearestLane(g.x, g.z, lp);
  const lane = world.roads.lanes[lp.lane];
  const lx = lane.start.x + lane.dir.x * lp.t, lz = lane.start.z + lane.dir.z * lp.t;
  const dl = Math.hypot(lx - g.x, lz - g.z);
  const cx = g.x + (lx - g.x) / dl * 3.5, cz = g.z + (lz - g.z) / dl * 3.5;
  mv.curr.x = cx; mv.curr.z = cz; mv.curr.yaw = Math.atan2(lane.dir.x, lane.dir.z);
  mv.vx = 0; mv.vz = 0; mv.speed = 0; mv.lateral = 0; mv.snap();
  let reward = 0;
  h.ctx.events.on('mission:completed', (p) => { reward = p.reward; });
  const money0 = world.player.money;
  h.secs(2);
  expect(reward === 2000, `delivered: +1500 + 500 bonus (got ${reward})`);
  expect(world.player.money === money0 + 2000, 'money credited');
  expect(world.mission.missionVehicleId === null && mv.prevRole === 'abandoned', 'mission car released');
});

test('kurye fails when the car is too damaged at delivery', () => {
  const { h, missions } = makeSim();
  const world = h.world;
  expect(missions.startMission('kurye'), 'kurye starts');
  const mv = world.vehicles.get(world.mission.missionVehicleId ?? -1);
  expect(mv !== undefined, 'mission car');
  if (!mv) return;
  const yaw = mv.curr.yaw;
  world.player.reset(mv.curr.x - Math.cos(yaw) * 1.8, mv.curr.z + Math.sin(yaw) * 1.8, yaw);
  h.step(1);
  h.input.setKey('KeyE', true);
  h.step(1);
  h.input.setKey('KeyE', false);
  expect(world.player.vehicleId === mv.id, 'entered');
  mv.health = 20;
  const g = world.city.points.garage;
  mv.curr.x = g.x; mv.curr.z = g.z; mv.vx = 0; mv.vz = 0; mv.speed = 0; mv.snap();
  let reason = '';
  h.ctx.events.on('mission:failed', (p) => { reason = p.reason; });
  h.step(2);
  expect(reason === 'Araç çok hasarlı', `failed with 'Araç çok hasarlı' (got '${reason}')`);
});

test('takip: sets 3 stars, police come, losing the stars completes with +3000; busted fails a mission', () => {
  const { h, missions } = makeSim();
  const world = h.world;
  expect(missions.startMission('takip'), 'takip starts');
  h.step(1);
  expect(world.wanted.stars === 3, `stars ${world.wanted.stars}`);
  expect(world.mission.objective === LOSE_WANTED_OBJECTIVE, 'lose-wanted objective');
  h.secs(5);
  expect(world.countByRole('police') >= 1, 'police units spawned for 3 stars');
  let reward = 0;
  h.ctx.events.on('mission:completed', (p) => { reward = p.reward; });
  setStars(world, 0);
  h.step(3);
  expect(reward === 3000, `completed with +3000 (got ${reward})`);
  h.secs(31);
  expect(missions.startMission('takip'), 'restart after cooldown');
  let failReason = '';
  h.ctx.events.on('mission:failed', (p) => { failReason = p.reason; });
  h.ctx.events.emit('player:busted', { reason: 'busted' });
  expect(failReason === 'Yakalandın' && world.mission.activeId === null, `busted aborts the mission (${failReason})`);
});
