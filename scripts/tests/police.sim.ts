// Police/wanted headless sim: units reach and bust a 2-star player on foot; stars decay once the player is far away and unseen; heat rules. Track F.
import { test, expect, createHeadless } from './harness';
import { DayNightSystem } from '../../src/game/systems/DayNightSystem';
import { PlayerMoveSystem } from '../../src/game/systems/PlayerMoveSystem';
import { VehicleEntrySystem } from '../../src/game/systems/VehicleEntrySystem';
import { VehiclePhysicsSystem } from '../../src/game/systems/VehiclePhysicsSystem';
import { CollisionSystem } from '../../src/game/systems/CollisionSystem';
import { TrafficSystem } from '../../src/game/systems/TrafficSystem';
import { PedestrianSystem } from '../../src/game/systems/PedestrianSystem';
import { PoliceSystem, POLICE_TUNING } from '../../src/game/systems/PoliceSystem';
import { WantedSystem, WANTED_TUNING, setStars } from '../../src/game/systems/WantedSystem';
import { MissionSystem } from '../../src/game/systems/MissionSystem';
import { BUDGET } from '../../src/game/core/Budget';
import type { PoliceBrain } from '../../src/game/entities/Vehicle';

interface MutableCamera { x: number; z: number; forwardX: number; forwardZ: number }

function makeSim(seed = 1907) {
  const traffic = new TrafficSystem();
  const police = new PoliceSystem();
  const wanted = new WantedSystem();
  const h = createHeadless({
    seed,
    hour: 12,
    systems: () => [new DayNightSystem(), new PlayerMoveSystem(), new VehicleEntrySystem(), traffic, police, new PedestrianSystem(),
      new VehiclePhysicsSystem(), new CollisionSystem(), wanted, new MissionSystem()],
  });
  const start = h.world.city.points.missionStarts[0];
  h.world.player.reset(start.x, start.z, start.yaw);
  const cam = h.ctx.camera as unknown as MutableCamera;
  cam.x = start.x; cam.z = start.z; cam.forwardX = 1; cam.forwardZ = 0;
  traffic.spawnParkedCars();
  return { h, traffic, police, wanted, start };
}

function nearestPolice(h: ReturnType<typeof createHeadless>): number {
  const world = h.world;
  let best = Infinity;
  const p = world.player;
  for (let i = 0; i < world.vehicleList.length; i++) {
    const v = world.vehicleList[i];
    if (v.role !== 'police' || v.destroyed) continue;
    const d = Math.hypot(v.curr.x - p.curr.x, v.curr.z - p.curr.z);
    if (d < best) best = d;
  }
  return best;
}

test('police sim: 2 stars on foot -> a unit within 15 m within 40 s, busted within 60 s, unit count bounded', () => {
  const { h, police } = makeSim();
  const world = h.world;
  let busted = -1, within15 = -1, wantedNotified = false, changed = 0;
  h.ctx.events.on('player:busted', () => { if (busted < 0) busted = world.time.elapsed; });
  h.ctx.events.on('notify', (p) => { if (p.text === 'Aranıyorsun!') wantedNotified = true; });
  h.ctx.events.on('wanted:changed', () => changed++);
  setStars(world, 2);
  h.step(1);
  expect(world.wanted.stars === 2, `stars after setStars: ${world.wanted.stars}`);
  expect(changed === 1 && wantedNotified, 'wanted:changed + Aranıyorsun! on the first star');
  let maxPolice = 0, sawPursue = false, sirenSeen = false;
  for (let sec = 1; sec <= 60; sec++) {
    h.secs(1);
    const n = world.countByRole('police');
    if (n > maxPolice) maxPolice = n;
    expect(n <= WANTED_TUNING.policePerStar[2] + 1 && n <= BUDGET.POLICE_MAX, `police count ${n} at ${sec}s`);
    for (let i = 0; i < world.vehicleList.length; i++) {
      const v = world.vehicleList[i];
      expect(isFinite(v.curr.x) && isFinite(v.curr.z) && isFinite(v.curr.yaw), `vehicle ${v.id} NaN at ${sec}s`);
      if (v.role === 'police' && v.brain) {
        const b = v.brain as PoliceBrain;
        if (b.mode === 'PURSUE' || b.mode === 'BUST') sawPursue = true;
        if (v.sirenOn) sirenSeen = true;
      }
    }
    const d = nearestPolice(h);
    if (d < 15 && within15 < 0) within15 = sec;
    if (busted >= 0) break;
  }
  console.log(`    police max ${maxPolice}, within 15 m at ${within15}s, busted at ${busted >= 0 ? busted.toFixed(1) : 'never'}s, spawned ${police.stats.spawned}, pursuits ${police.stats.pursuits}`);
  expect(maxPolice >= 1, 'police spawned');
  expect(sirenSeen && world.wanted.sirenActive === 1 || busted >= 0, 'sirens were on while hunting');
  expect(sawPursue, 'a unit entered PURSUE');
  expect(within15 > 0 && within15 <= 40, `a police unit got within 15 m at ${within15}s (limit 40)`);
  expect(busted >= 0 && busted <= 60, `player:busted fired at ${busted >= 0 ? busted.toFixed(1) : 'never'}s (limit 60)`);
});

test('police sim: teleported 400 m away with police despawned and the spawner off, stars decay to 0 within 90 s', () => {
  const { h, police, start } = makeSim();
  const world = h.world;
  setStars(world, 2);
  h.secs(15);
  expect(world.countByRole('police') >= 1, 'police present before the teleport');
  // Far sidewalk node (>= 400 m) -> teleport, despawn all units, keep the spawner running.
  const ids: number[] = [];
  let n = world.sidewalks.nodesInRing(start.x, start.z, 400, 470, ids);
  expect(n > 0, 'a sidewalk node 400 m away exists');
  const node = world.sidewalks.nodes[ids[0]];
  world.player.reset(node.x, node.z, 0);
  const cam = h.ctx.camera as unknown as MutableCamera;
  cam.x = node.x; cam.z = node.z;
  police.despawnAll();
  police.spawnEnabled = false; // no units left anywhere: the wanted level must cool off on its own
  expect(world.countByRole('police') === 0, 'police despawned');
  let zeroAt = -1, escaped = false;
  h.ctx.events.on('notify', (p) => { if (p.text === 'Kaçtın! Aranma sona erdi') escaped = true; });
  for (let sec = 1; sec <= 90; sec++) {
    h.secs(1);
    if (world.wanted.stars === 0) { zeroAt = sec; break; }
  }
  n = world.countByRole('police');
  console.log(`    stars 0 at ${zeroAt}s, heat ${world.wanted.heat.toFixed(1)}, police now ${n}, spawned total ${police.stats.spawned}`);
  expect(zeroAt > 0, `stars did not decay within 90 s (heat ${world.wanted.heat.toFixed(1)}, lastSeen ${world.wanted.lastSeenTimer.toFixed(1)} s)`);
  expect(escaped, 'Kaçtın! notification');
  h.secs(POLICE_TUNING.returnTime + 2);
  for (let i = 0; i < world.vehicleList.length; i++) {
    const v = world.vehicleList[i];
    if (v.role === 'police') expect((v.brain as PoliceBrain).mode === 'RETURN' && !v.sirenOn, 'remaining units are returning with sirens off');
  }
});

test('wanted: a ped hit by the player is 1 star immediately; AI-caused events add nothing; police hit adds more', () => {
  const { h } = makeSim();
  const world = h.world;
  h.ctx.events.emit('ped:hit', { pedId: 1, byVehicleId: null, byPlayer: false, speed: 10, killed: false, x: 0, z: 0 });
  h.step(1);
  expect(world.wanted.stars === 0, 'AI ped hit adds no heat');
  h.ctx.events.emit('ped:hit', { pedId: 1, byVehicleId: null, byPlayer: true, speed: 10, killed: false, x: 0, z: 0 });
  expect(world.wanted.stars === 1, `player ped hit = 1 star immediately (got ${world.wanted.stars})`);
  h.step(1);
  expect(world.wanted.flash > 0, 'stars flash after a change');
  h.ctx.events.emit('ped:hit', { pedId: 2, byVehicleId: null, byPlayer: true, speed: 20, killed: true, x: 0, z: 0 });
  expect(world.wanted.stars === 3, `kill adds 60 heat -> 3 stars (got ${world.wanted.stars}, heat ${world.wanted.heat})`);
  expect(world.wanted.heat <= WANTED_TUNING.heatCap, 'heat capped');
});
