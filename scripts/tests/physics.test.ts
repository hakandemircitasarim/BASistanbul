// Vehicle physics acceptance: top speeds per spec, 0-100, braking, handbrake turn, coasting, sleep, entry/exit through the systems. Track C.
import { test, expect, createHeadless } from './harness';
import { Vehicle } from '../../src/game/entities/Vehicle';
import { SPECS } from '../../src/game/entities/VehicleSpecs';
import type { VehicleKey } from '../../src/game/entities/VehicleSpecs';
import { VehiclePhysicsSystem } from '../../src/game/systems/VehiclePhysicsSystem';
import { PlayerMoveSystem } from '../../src/game/systems/PlayerMoveSystem';
import { VehicleEntrySystem, PROMPT_ENTER, PROMPT_EXIT } from '../../src/game/systems/VehicleEntrySystem';
import { CollisionSystem } from '../../src/game/systems/CollisionSystem';
import { FIXED_DT } from '../../src/game/core/Types';

const DT = FIXED_DT;
const car = (key: VehicleKey, x = 0, z = 0, yaw = 0): Vehicle => new Vehicle(SPECS[key], x, z, yaw, 'player', 0xffffff);
const run = (v: Vehicle, seconds: number, each?: (t: number) => void): void => {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { VehiclePhysicsSystem.integrate(v, DT); if (each) each((i + 1) * DT); }
};

test('physics: full-throttle top speeds after 25 s match the spec bands', () => {
  const bands: Record<VehicleKey, [number, number]> = { sedan: [31, 38], sport: [42, 50], police: [37, 45], van: [24, 30], taxi: [31, 38] };
  for (const key of Object.keys(bands) as VehicleKey[]) {
    const v = car(key);
    v.controls.throttle = 1;
    run(v, 25);
    const [lo, hi] = bands[key];
    expect(v.speed >= lo && v.speed <= hi, `${key} top speed ${v.speed.toFixed(2)} not in ${lo}..${hi}`);
    expect(Math.abs(v.curr.x) < 1e-6 && v.curr.z > 100, `${key} drives straight along +Z`);
    expect(Math.abs(v.lateral) < 0.01, `${key} no lateral drift on a straight`);
  }
});

test('physics: 0 -> 27.8 m/s within 7 s (sedan) and 4 s (sport)', () => {
  for (const [key, limit] of [['sedan', 7], ['sport', 4]] as [VehicleKey, number][]) {
    const v = car(key);
    v.controls.throttle = 1;
    let reached = -1;
    run(v, 10, (t) => { if (reached < 0 && v.speed >= 27.8) reached = t; });
    expect(reached > 0 && reached <= limit, `${key} reached 100 km/h in ${reached.toFixed(2)} s (limit ${limit})`);
  }
});

test('physics: braking from 30 m/s with throttle -1 stops within 40 m', () => {
  const v = car('sedan');
  v.vz = 30;
  v.controls.throttle = -1;
  let stopZ = -1;
  run(v, 8, () => { if (stopZ < 0 && v.speed <= 0.05) stopZ = v.curr.z; });
  expect(stopZ >= 0 && stopZ <= 40, `stopping distance ${stopZ.toFixed(2)} m`);
});

test('physics: handbrake at 20 m/s + full steer rotates >= 70 deg in 1 s while sliding >= 8 m', () => {
  const v = car('sedan');
  v.vz = 20;
  v.controls.handbrake = true;
  v.controls.steer = 1;
  let skidTicks = 0;
  run(v, 1, () => { if (Math.abs(v.lateral) > 1) skidTicks++; });
  const deg = Math.abs(v.curr.yaw) * 180 / Math.PI;
  const dist = Math.sqrt(v.curr.x * v.curr.x + v.curr.z * v.curr.z);
  expect(deg >= 70, `rotated ${deg.toFixed(1)} deg`);
  expect(dist >= 8, `slid ${dist.toFixed(2)} m`);
  expect(skidTicks > 10, 'lateral slip developed during the handbrake turn');
  expect(v.curr.yaw > 0, 'positive steer turns toward +X (yaw increases)');
});

test('physics: coasting from 30 m/s drops below 20 m/s within 8 s', () => {
  const v = car('sedan');
  v.vz = 30;
  let t20 = -1;
  run(v, 8, (t) => { if (t20 < 0 && v.speed < 20) t20 = t; });
  expect(t20 > 0 && t20 <= 8, `coasted to 20 m/s in ${t20.toFixed(2)} s`);
  expect(v.speed >= 0, 'coasting never reverses');
});

test('physics: reverse is capped at reverseSpeed and steering turns the other way', () => {
  const v = car('van');
  v.controls.throttle = -1;
  v.controls.steer = 1;
  run(v, 6);
  expect(v.speed < 0 && v.speed >= -SPECS.van.reverseSpeed - 0.01, `reverse speed ${v.speed.toFixed(2)}`);
  expect(v.curr.yaw < 0, 'reversing with right steer swings the nose left');
});

test('physics: full steer at 30 m/s drifts, moderate speed grips', () => {
  const fast = car('sedan');
  fast.vz = 30;
  fast.controls.throttle = 1;
  fast.controls.steer = 1;
  let drifted = false;
  run(fast, 3, () => { if (fast.drifting) drifted = true; });
  expect(drifted, 'high-speed full steer produces a drift');
  const slow = car('sedan');
  slow.vz = 6;
  slow.controls.steer = 1;
  slow.controls.throttle = 0.4;
  let anyDrift = false;
  run(slow, 3, () => { if (slow.drifting) anyDrift = true; });
  expect(!anyDrift, 'low-speed cornering does not slide');
});

test('systems: parked vehicles sleep, controls wake them; skid events fire under handbrake', () => {
  let skids = 0;
  const h = createHeadless({ systems: () => [new VehiclePhysicsSystem()] });
  h.ctx.events.on('fx:skid', () => skids++);
  const sp = h.world.city.points.playerSpawn;
  const v = h.world.addVehicle(new Vehicle(SPECS.sedan, sp.x + 20, sp.z, 0, 'parked', 0));
  h.secs(1.5);
  expect(v.sleeping, 'parked car sleeps after 1 s idle');
  v.controls.throttle = 1;
  h.step(1);
  expect(!v.sleeping && v.speed > 0, 'throttle wakes the car');
  h.secs(3);
  v.controls.handbrake = true;
  v.controls.steer = 1;
  h.secs(0.5);
  expect(skids > 0, 'fx:skid emitted while sliding');
});

test('systems: E enters the nearest car, W drives it, E exits beside it (role abandoned)', () => {
  const h = createHeadless({ systems: (ctx) => {
    void ctx;
    return [new PlayerMoveSystem(), new VehicleEntrySystem(), new VehiclePhysicsSystem(), new CollisionSystem()];
  } });
  const w = h.world;
  const p = w.player;
  const events: string[] = [];
  h.ctx.events.on('player:enterVehicle', (e) => events.push('enter:' + e.stolen));
  h.ctx.events.on('player:exitVehicle', () => events.push('exit'));
  const px = p.curr.x, pz = p.curr.z;
  const v = w.addVehicle(new Vehicle(SPECS.sport, px + 2.5, pz, 0, 'parked', 0xff7a00));
  h.step(2);
  expect(w.hud.prompt === PROMPT_ENTER, `enter prompt shown near a car (got ${w.hud.prompt})`);
  h.input.setKey('KeyE', true);
  h.step(1);
  h.input.setKey('KeyE', false);
  expect(p.vehicleId === v.id && v.occupiedByPlayer && v.role === 'player' && v.prevRole === 'parked', 'player entered the car');
  expect(events[0] === 'enter:false', 'enter event, not stolen (parked)');
  expect(w.hud.prompt === PROMPT_EXIT, 'exit prompt while driving');
  h.input.setKey('KeyW', true);
  h.secs(3);
  expect(v.speed > 15, `car accelerates under W (speed ${v.speed.toFixed(1)})`);
  expect(Math.abs(p.curr.x - v.curr.x) < 2 && Math.abs(p.curr.z - v.curr.z) < 2, 'player mirrors the seat');
  h.input.setKey('KeyW', false);
  h.input.setKey('KeyS', true);
  h.secs(4);
  h.input.setKey('KeyS', false);
  h.secs(1);
  h.input.setKey('KeyE', true);
  h.step(1);
  h.input.setKey('KeyE', false);
  expect(p.vehicleId === null && !v.occupiedByPlayer && v.role === 'abandoned', 'player exited, car abandoned');
  expect(events[1] === 'exit', 'exit event');
  const dx = p.curr.x - v.curr.x, dz = p.curr.z - v.curr.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  expect(d > 1.5 && d < 5, `player placed beside the car (${d.toFixed(2)} m)`);
  h.secs(1);
  expect(p.vehicleId === null, 'cooldown prevents immediate re-entry without a new press');
});
