// Collision acceptance: SAT manifolds, push-out separation, no tunnelling through lamp posts, momentum conservation, ped/player hits. Track C.
import { test, expect, approx, createHeadless } from './harness';
import { obbVsObb, obbVsAabb, obbVsCircle, staticVsObb } from '../../src/game/core/Collision';
import type { AABB, Circle, Manifold, OBB, StaticCollider } from '../../src/game/core/Collision';
import { Vehicle } from '../../src/game/entities/Vehicle';
import { Pedestrian } from '../../src/game/entities/Pedestrian';
import { SPECS } from '../../src/game/entities/VehicleSpecs';
import { VehiclePhysicsSystem } from '../../src/game/systems/VehiclePhysicsSystem';
import { CollisionSystem } from '../../src/game/systems/CollisionSystem';
import { PlayerMoveSystem } from '../../src/game/systems/PlayerMoveSystem';
import type { Headless } from './harness';

const m: Manifold = { nx: 0, nz: 0, depth: 0 };
const ROAD_X = 3 * 116 + 10; // N-S road center, far from the stub's test buildings

function sim(): Headless {
  return createHeadless({ systems: () => [new PlayerMoveSystem(), new VehiclePhysicsSystem(), new CollisionSystem()] });
}

function addProp(h: Headless, x: number, z: number, r: number): StaticCollider {
  const c: StaticCollider = { id: 9000 + h.world.city.staticColliders.length, shape: { kind: 'circle', cx: x, cz: z, r }, tag: 'prop', height: 6, minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r, hashStamp: 0 };
  h.world.city.staticColliders.push(c);
  h.world.staticHash.insert(c);
  return c;
}

test('SAT: rotated OBB pairs produce separating manifolds', () => {
  const a: OBB = { cx: 0, cz: 0, hw: 0.9, hl: 2.2, yaw: 0 };
  const b: OBB = { cx: 1.5, cz: 0.3, hw: 0.9, hl: 2.2, yaw: Math.PI / 2 };
  expect(obbVsObb(a, b, m), 'crossed cars overlap');
  expect(m.depth > 0 && m.depth < 2, `depth sane (${m.depth})`);
  expect(m.nx < 0, 'normal points from b toward a (a is to the -x side)');
  a.cx += m.nx * m.depth; a.cz += m.nz * m.depth;
  expect(!obbVsObb(a, b, m), 'moving a by n*depth separates');
  const far: OBB = { cx: 0, cz: 6, hw: 0.9, hl: 2.2, yaw: 0.7 };
  expect(!obbVsObb(a, far, m), 'no false positive at distance');
  const box: AABB = { minX: 2, minZ: -10, maxX: 20, maxZ: 10 };
  const car: OBB = { cx: 1.5, cz: 0, hw: 0.9, hl: 2.2, yaw: Math.PI / 4 };
  expect(obbVsAabb(car, box, m), 'diagonal car clips the wall');
  car.cx += m.nx * m.depth; car.cz += m.nz * m.depth;
  expect(!obbVsAabb(car, box, m), 'aabb push-out separates');
  const post: Circle = { cx: 0.8, cz: 2.0, r: 0.2 };
  const c2: OBB = { cx: 0, cz: 0, hw: 0.9, hl: 2.2, yaw: 0 };
  expect(obbVsCircle(c2, post, m), 'post inside the front corner');
  c2.cx += m.nx * m.depth; c2.cz += m.nz * m.depth;
  expect(!obbVsCircle(c2, post, m), 'circle push-out separates');
  const shape: StaticCollider['shape'] = { kind: 'aabb', minX: 2, minZ: -10, maxX: 20, maxZ: 10 };
  const c3: OBB = { cx: 1.5, cz: 0, hw: 0.9, hl: 2.2, yaw: 0 };
  expect(staticVsObb(shape, c3, m) && m.nx > 0, 'staticVsObb normal points from the car toward the wall');
});

test('system: a car overlapping a building is pushed out and damaged, a car in a wall never stays inside', () => {
  const h = sim();
  const w = h.world;
  let building: StaticCollider | null = null;
  for (const c of w.city.staticColliders) if (c.tag === 'building') { building = c; break; }
  expect(building !== null && building.shape.kind === 'aabb', 'stub city has a test building');
  const s = building.shape as AABB;
  const v = w.addVehicle(new Vehicle(SPECS.sedan, s.minX - 1.0, (s.minZ + s.maxZ) / 2, Math.PI / 2, 'traffic', 0));
  v.vx = 20;
  const hits: number[] = [];
  h.ctx.events.on('vehicle:collision', (e) => hits.push(e.impactSpeed));
  h.secs(1);
  const obb: OBB = { cx: 0, cz: 0, hw: 0, hl: 0, yaw: 0 };
  v.obb(obb);
  expect(!obbVsAabb(obb, s, m), 'car ends outside the building');
  expect(hits.length > 0 && hits[0] > 10, `impact reported (${hits[0]})`);
  expect(v.health < 100, 'car took damage');
  expect(v.vx < 5, 'car bounced/stopped rather than kept its speed');
});

test('system: a car at 30 m/s cannot tunnel through a lamp post', () => {
  const h = sim();
  const w = h.world;
  const z0 = 120;
  const post = addProp(h, ROAD_X, z0 + 12, 0.2);
  const v = w.addVehicle(new Vehicle(SPECS.sport, ROAD_X, z0, 0, 'traffic', 0));
  v.vz = 30;
  v.controls.throttle = 1;
  const postZ = post.shape.kind === 'circle' ? post.shape.cz : 0;
  let maxZ = -Infinity;
  for (let i = 0; i < 120; i++) { h.step(1); if (v.curr.z > maxZ) maxZ = v.curr.z; }
  expect(maxZ < postZ, `never passed the post (max z ${maxZ.toFixed(2)} vs ${postZ})`);
  expect(v.curr.z < z0 + 12, `stopped before the post (z ${v.curr.z.toFixed(2)})`);
  expect(v.health < 100, 'the hit damaged the car');
  expect(Math.abs(v.vz) < 10, 'speed absorbed');
});

test('system: vehicle-vehicle impact conserves momentum within 10 %, wakes and pushes the parked car', () => {
  const h = sim();
  const w = h.world;
  const a = w.addVehicle(new Vehicle(SPECS.sedan, ROAD_X, 200, 0, 'traffic', 0));
  const b = w.addVehicle(new Vehicle(SPECS.sedan, ROAD_X, 212, 0, 'parked', 0));
  h.secs(1.5);
  expect(b.sleeping, 'b sleeps before the hit');
  a.vz = 15;
  a.vx = 0;
  const before = a.spec.mass * a.vz + b.spec.mass * b.vz;
  let impact = -1;
  h.ctx.events.on('vehicle:collision', (e) => { if (impact < 0) impact = e.impactSpeed; });
  let after = 0;
  for (let i = 0; i < 90; i++) {
    h.step(1);
    if (impact >= 0) { after = a.spec.mass * a.vz + b.spec.mass * b.vz; break; }
  }
  expect(impact > 10, `collision happened (impact ${impact})`);
  approx(after, before, before * 0.1, 'momentum conserved on the collision tick');
  expect(!b.sleeping && b.vz > 3, 'parked car woke and got pushed');
  expect(a.vz < b.vz, 'the hitter is slower than the hit car after impact');
  h.secs(1);
  const oa: OBB = { cx: 0, cz: 0, hw: 0, hl: 0, yaw: 0 }, ob: OBB = { cx: 0, cz: 0, hw: 0, hl: 0, yaw: 0 };
  expect(!obbVsObb(a.obb(oa), b.obb(ob), m), 'cars are separated afterwards');
});

test('system: running into a ped ragdolls it, running into the player damages and knocks back', () => {
  const h = sim();
  const w = h.world;
  const ped = w.addPed(new Pedestrian(ROAD_X + 0.3, 310, 0, 0, 0, 0, 0));
  const v = w.addVehicle(new Vehicle(SPECS.van, ROAD_X, 300, 0, 'traffic', 0));
  v.vz = 12;
  v.controls.throttle = 1;
  const hits: { killed: boolean; speed: number; byPlayer: boolean }[] = [];
  h.ctx.events.on('ped:hit', (e) => hits.push({ killed: e.killed, speed: e.speed, byPlayer: e.byPlayer }));
  h.secs(1.5);
  expect(hits.length === 1, `exactly one ped:hit (${hits.length})`);
  expect(hits[0].killed && hits[0].speed > 9 && !hits[0].byPlayer, 'fast hit kills, not by player');
  expect(ped.state === 'HIT' && ped.health === 0 && ped.vz > 3, 'ped tumbles with the car velocity');

  const p = w.player;
  p.curr.x = ROAD_X; p.curr.z = 420; p.snap();
  const car = w.addVehicle(new Vehicle(SPECS.sedan, ROAD_X, 410, 0, 'traffic', 0));
  car.vz = 12;
  car.controls.throttle = 1;
  let damaged = 0;
  let shake = 0;
  h.ctx.events.on('player:damaged', (e) => { damaged += e.amount; });
  h.ctx.events.on('camera:shake', () => shake++);
  h.secs(1.5);
  expect(damaged > 0 && p.health < 100, `player damaged (${damaged.toFixed(1)})`);
  expect(shake > 0, 'camera shake on player hit');
  expect(p.curr.z > 421, 'player knocked forward');
});

test('system: player on foot is pushed out of buildings and parked cars', () => {
  const h = sim();
  const w = h.world;
  let building: StaticCollider | null = null;
  for (const c of w.city.staticColliders) if (c.tag === 'building') { building = c; break; }
  expect(building !== null, 'stub city has a test building');
  const s = building.shape as AABB;
  const p = w.player;
  p.curr.x = s.minX + 0.2; p.curr.z = (s.minZ + s.maxZ) / 2; p.snap();
  h.step(2);
  expect(p.curr.x <= s.minX - p.radius + 1e-6, `player outside the wall (x ${p.curr.x.toFixed(2)} vs ${s.minX})`);
  const v = w.addVehicle(new Vehicle(SPECS.sedan, ROAD_X, 500, 0, 'parked', 0));
  p.curr.x = ROAD_X + 0.3; p.curr.z = 500; p.snap();
  h.step(2);
  const obb: OBB = { cx: 0, cz: 0, hw: 0, hl: 0, yaw: 0 };
  v.obb(obb);
  const c: Circle = { cx: p.curr.x, cz: p.curr.z, r: p.radius };
  expect(!obbVsCircle(obb, c, m), 'player pushed out of the parked car');
  expect(p.health === 100, 'a parked car does not hurt');
});
