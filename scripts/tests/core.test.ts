// Smoke tests for the P0 core: Random, SpatialHash, Collision manifolds, GameStore, Input, EventBus, World LOS. Track P0.
import { test, expect, approx, createHeadless } from './harness';
import { Random } from '../../src/game/core/Random';
import { SpatialHash } from '../../src/game/core/SpatialHash';
import type { HashItem } from '../../src/game/core/SpatialHash';
import {
  obbVsAabb, obbVsObb, obbVsCircle, circleVsAabb, circleVsObb, circleVsCircle,
  segmentVsAabb, segmentVsCircle, pointInAabb, obbBounds, staticVsCircle, staticVsObb,
} from '../../src/game/core/Collision';
import type { AABB, OBB, Circle, Manifold, StaticShape } from '../../src/game/core/Collision';
import { GameStore } from '../../src/game/state/GameStore';
import { Input } from '../../src/game/core/Input';
import { EventBus } from '../../src/game/core/EventBus';
import { wrapAngle, angleDiff } from '../../src/game/core/math';

const m: Manifold = { nx: 0, nz: 0, depth: 0 };
const item = (minX: number, minZ: number, maxX: number, maxZ: number): HashItem => ({ minX, minZ, maxX, maxZ, hashStamp: 0 });

test('Random: deterministic per seed, in range', () => {
  const a = new Random(42), b = new Random(42), c = new Random(43);
  let same = true, diff = false;
  for (let i = 0; i < 200; i++) {
    const x = a.next(), y = b.next(), z = c.next();
    if (x !== y) same = false;
    if (x !== z) diff = true;
    expect(x >= 0 && x < 1, 'next() in [0,1)');
  }
  expect(same, 'same seed -> same stream');
  expect(diff, 'different seed -> different stream');
  for (let i = 0; i < 100; i++) { const v = a.int(3, 5); expect(v >= 3 && v <= 5, 'int in range'); }
  expect(new Random(7).fork().seed === new Random(7).fork().seed, 'fork deterministic');
  approx(wrapAngle(Math.PI * 2.5), Math.PI * 0.5, 1e-9, 'wrapAngle');
  approx(wrapAngle(-Math.PI * 3.5), Math.PI * 0.5, 1e-9, 'wrapAngle negative');
  approx(angleDiff(0.1, -0.1), -0.2, 1e-9, 'angleDiff');
});

test('SpatialHash: rect/circle/segment queries and dedup', () => {
  const h = new SpatialHash<HashItem>(10);
  const big = item(0, 0, 35, 5);        // spans 4 cells
  const far = item(100, 100, 102, 102);
  const mid = item(48, 48, 52, 52);
  h.insert(big); h.insert(far); h.insert(mid);
  expect(h.size === 3, 'size 3');
  const out: HashItem[] = [];
  let n = h.queryRect(-5, -5, 40, 10, out);
  expect(n === 1 && out[0] === big, 'rect finds big exactly once (dedup across cells)');
  n = h.queryRect(40, 40, 60, 60, out);
  expect(n === 1 && out[0] === mid, 'rect finds mid');
  n = h.queryRect(60, 60, 90, 90, out);
  expect(n === 0, 'empty rect');
  n = h.queryCircle(55, 50, 4, out);
  expect(n === 1 && out[0] === mid, 'circle touching mid');
  n = h.queryCircle(58, 50, 4, out);
  expect(n === 0, 'circle just missing mid (distance 6 > 4)');
  n = h.querySegment(-10, 50, 120, 50, 0, out);
  expect(n === 1 && out[0] === mid, 'horizontal segment hits mid only');
  n = h.querySegment(0, 0, 100, 100, 1, out);
  let hitBig = false, hitFar = false, hitMid = false;
  for (let i = 0; i < n; i++) { if (out[i] === big) hitBig = true; if (out[i] === far) hitFar = true; if (out[i] === mid) hitMid = true; }
  expect(hitBig && hitFar && hitMid && n === 3, 'diagonal segment hits all three once');
  n = h.querySegment(-10, 20, 120, 20, 0, out);
  expect(n === 0, 'segment along z=20 misses everything');
  n = h.querySegment(-10, 8, 120, 8, 3, out);
  expect(n === 1 && out[0] === big, 'pad 3 reaches big (maxZ 5) from z=8');
  h.remove(mid);
  n = h.queryRect(40, 40, 60, 60, out);
  expect(n === 0 && h.size === 2, 'remove');
  h.clear();
  expect(h.size === 0 && h.queryRect(-1000, -1000, 1000, 1000, out) === 0, 'clear');
});

test('Collision: obbVsAabb manifold separates A', () => {
  const o: OBB = { cx: 0, cz: 0, hw: 1, hl: 2, yaw: 0 };
  const a: AABB = { minX: 0.5, minZ: -1, maxX: 5, maxZ: 1 };
  expect(obbVsAabb(o, a, m), 'overlapping');
  approx(m.depth, 0.5, 1e-9, 'depth along x');
  approx(m.nx, -1, 1e-9, 'normal points from aabb toward obb');
  approx(m.nz, 0, 1e-9, 'nz 0');
  o.cx += m.nx * m.depth; o.cz += m.nz * m.depth;
  expect(!obbVsAabb(o, a, m), 'moving A by n*depth separates');
  // rotated diamond: AABB extents overlap but SAT on the diagonal separates
  const d: OBB = { cx: 0, cz: 0, hw: 1, hl: 1, yaw: Math.PI / 4 };
  expect(!obbVsAabb(d, { minX: 1.2, minZ: 1.2, maxX: 3, maxZ: 3 }, m), 'diamond corner case separated by diagonal axis');
  expect(obbVsAabb(d, { minX: 0.6, minZ: 0.6, maxX: 3, maxZ: 3 }, m), 'diamond corner case overlaps when closer');
});

test('Collision: obbVsObb manifold', () => {
  const a: OBB = { cx: 0, cz: 0, hw: 1, hl: 2, yaw: 0 };
  const b: OBB = { cx: 0, cz: 3.5, hw: 1, hl: 2, yaw: 0 };
  expect(obbVsObb(a, b, m), 'overlap along z');
  approx(m.depth, 0.5, 1e-9, 'depth 0.5');
  approx(m.nz, -1, 1e-9, 'normal from b toward a (-z)');
  a.cx += m.nx * m.depth; a.cz += m.nz * m.depth;
  expect(!obbVsObb(a, b, m), 'separated after push');
  const c: OBB = { cx: 2.6, cz: 0, hw: 1, hl: 2, yaw: Math.PI / 2 }; // rotated: extends 2 along x
  a.cx = 0; a.cz = 0;
  expect(obbVsObb(a, c, m), 'rotated overlap');
  approx(m.depth, 0.4, 1e-9, 'depth 1 + 2 - 2.6');
  approx(m.nx, -1, 1e-9, 'normal -x');
  expect(!obbVsObb(a, { cx: 0, cz: 4.1, hw: 1, hl: 2, yaw: 0 }, m), 'no overlap');
});

test('Collision: obb/circle/aabb pairs', () => {
  const o: OBB = { cx: 0, cz: 0, hw: 1, hl: 2, yaw: 0 };
  const c: Circle = { cx: 1.5, cz: 0, r: 1 };
  expect(obbVsCircle(o, c, m), 'obb vs circle overlap');
  approx(m.depth, 0.5, 1e-9, 'depth');
  approx(m.nx, -1, 1e-9, 'normal from circle toward obb');
  o.cx += m.nx * m.depth;
  expect(!obbVsCircle(o, c, m), 'separated');
  o.cx = 0;
  expect(circleVsObb(c, o, m), 'circle vs obb');
  approx(m.nx, 1, 1e-9, 'flipped normal (from obb toward circle)');
  c.cx += m.nx * m.depth;
  expect(!circleVsObb(c, o, m), 'circle pushed out');
  const rot: OBB = { cx: 0, cz: 0, hw: 1, hl: 2, yaw: Math.PI / 2 };
  const c2: Circle = { cx: 0, cz: 1.5, r: 1 };
  expect(obbVsCircle(rot, c2, m), 'rotated obb (width now along z) vs circle');
  approx(m.depth, 0.5, 1e-9, 'rotated depth');
  approx(m.nz, -1, 1e-9, 'rotated normal');

  const a: AABB = { minX: -1, minZ: -1, maxX: 1, maxZ: 1 };
  const cc: Circle = { cx: 0, cz: 1.5, r: 1 };
  expect(circleVsAabb(cc, a, m), 'circle vs aabb');
  approx(m.depth, 0.5, 1e-9, 'depth');
  approx(m.nz, 1, 1e-9, 'normal from aabb toward circle');
  cc.cz += m.nz * m.depth;
  expect(!circleVsAabb(cc, a, m), 'separated');
  const inside: Circle = { cx: 0.8, cz: 0.1, r: 0.3 };
  expect(circleVsAabb(inside, a, m), 'circle center inside aabb');
  approx(m.nx, 1, 1e-9, 'exit through nearest (+x) face');
  approx(m.depth, 0.2 + 0.3, 1e-9, 'depth = face distance + r');
  inside.cx += m.nx * m.depth;
  expect(!circleVsAabb(inside, a, m), 'inside case separated');
  const corner: Circle = { cx: 1.5, cz: 1.5, r: 1 };
  expect(circleVsAabb(corner, a, m), 'corner contact');
  approx(m.depth, 1 - Math.SQRT1_2, 1e-9, 'corner depth');
  approx(m.nx, Math.SQRT1_2, 1e-9, 'corner normal x');

  const c1: Circle = { cx: 0, cz: 0, r: 1 };
  const c3: Circle = { cx: 1.2, cz: 0, r: 0.5 };
  expect(circleVsCircle(c1, c3, m), 'circles overlap');
  approx(m.depth, 0.3, 1e-9, 'depth');
  approx(m.nx, -1, 1e-9, 'normal from c3 toward c1');
  c1.cx += m.nx * m.depth;
  expect(!circleVsCircle(c1, c3, m), 'separated');
});

test('Collision: segments, bounds, static wrappers', () => {
  const a: AABB = { minX: -1, minZ: -1, maxX: 1, maxZ: 1 };
  approx(segmentVsAabb(-5, 0, 5, 0, a), 0.4, 1e-9, 'entry t');
  expect(segmentVsAabb(-5, 2, 5, 2, a) === -1, 'miss');
  expect(segmentVsAabb(0, 0, 5, 0, a) === 0, 'start inside');
  expect(segmentVsAabb(-5, -5, -2, -2, a) === -1, 'short segment stops before box');
  const c: Circle = { cx: 0, cz: 0, r: 1 };
  approx(segmentVsCircle(-5, 0, 5, 0, c), 0.4, 1e-9, 'circle entry t');
  expect(segmentVsCircle(-5, 2, 5, 2, c) === -1, 'circle miss');
  expect(segmentVsCircle(0.5, 0, 5, 0, c) === 0, 'start inside circle');
  expect(pointInAabb(0.5, 0.5, a) && !pointInAabb(2, 0, a), 'pointInAabb');
  const b: AABB = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  obbBounds({ cx: 10, cz: 5, hw: 1, hl: 2, yaw: Math.PI / 2 }, b);
  approx(b.minX, 8, 1e-9, 'bounds minX'); approx(b.maxX, 12, 1e-9, 'bounds maxX');
  approx(b.minZ, 4, 1e-9, 'bounds minZ'); approx(b.maxZ, 6, 1e-9, 'bounds maxZ');

  const wall: StaticShape = { kind: 'aabb', minX: 0, minZ: -5, maxX: 2, maxZ: 5 };
  const ped: Circle = { cx: -0.3, cz: 0, r: 0.5 };
  expect(staticVsCircle(wall, ped, m), 'static vs circle');
  approx(m.nx, 1, 1e-9, 'normal from circle toward static (+x)');
  ped.cx -= m.nx * m.depth;
  expect(!staticVsCircle(wall, ped, m), 'moving the circle by -n*depth separates');
  const car: OBB = { cx: -0.5, cz: 0, hw: 0.9, hl: 2.2, yaw: 0 }; // x extent -1.4..0.4 overlaps the wall by 0.4
  expect(staticVsObb(wall, car, m), 'static vs obb');
  approx(m.nx, 1, 1e-9, 'normal toward static');
  approx(m.depth, 0.4, 1e-9, 'depth');
  car.cx -= m.nx * m.depth;
  expect(!staticVsObb(wall, car, m), 'moving the obb by -n*depth separates');
  const post: StaticShape = { kind: 'circle', cx: 0, cz: 0, r: 0.2 };
  const car2: OBB = { cx: 0, cz: 2.3, hw: 0.9, hl: 2.2, yaw: 0 };
  expect(staticVsObb(post, car2, m), 'lamp post vs car');
  approx(m.nz, -1, 1e-9, 'normal from car toward post');
  approx(m.depth, 0.1, 1e-9, 'depth');
});

test('GameStore: setState/subscribe semantics, notify cap, settings', () => {
  const s = new GameStore();
  let calls = 0;
  const unsub = s.subscribe(() => { calls++; });
  const before = s.getState();
  s.setState({ money: before.money });
  expect(calls === 0 && s.getState() === before, 'no-op patch does not notify or replace state');
  s.setState({ money: 5 });
  expect(calls === 1 && s.getState() !== before && s.getState().money === 5, 'changed patch notifies with a new object');
  expect(before.money === 1000, 'old state object untouched');
  unsub();
  s.setState({ money: 6 });
  expect(calls === 1, 'unsubscribed listener not called');
  for (let i = 0; i < 6; i++) s.notify('n' + i, 'info');
  const n = s.getState().notifications;
  expect(n.length === 4 && n[0].text === 'n2' && n[3].text === 'n5', 'max 4 notifications, oldest dropped');
  expect(n[3].id > n[0].id, 'ids increase');
  s.setSettings({ quality: 'low' });
  expect(s.getState().settings.quality === 'low' && s.getState().settings.volume === 0.8, 'settings merge');
  const loaded = s.loadSettings();
  expect(loaded.quality === 'high', 'loadSettings falls back to defaults without localStorage');
});

test('Input: edge latching, consume, endTick, enabled, axis', () => {
  const inp = new Input();
  inp.setKey('KeyW', true);
  expect(inp.down('forward') && inp.pressed('forward'), 'down + pressed after keydown');
  expect(inp.axis('back', 'forward') === 1, 'axis +1');
  inp.endTick();
  expect(inp.down('forward') && !inp.pressed('forward'), 'edge cleared by endTick, still held');
  inp.setKey('KeyW', true);
  expect(!inp.pressed('forward'), 'repeat down without release does not re-latch');
  inp.setKey('KeyW', false);
  inp.setKey('KeyW', true);
  expect(inp.pressed('forward'), 're-latched after release');
  expect(inp.consume('forward') && !inp.pressed('forward') && !inp.consume('forward'), 'consume clears once');
  inp.setKey('KeyE', true); inp.setKey('KeyE', false);
  expect(inp.pressed('interact') && !inp.down('interact'), 'tap within a tick keeps the edge until endTick');
  inp.endTick();
  expect(!inp.pressed('interact'), 'tap edge cleared');
  inp.setKey('Space', true);
  expect(inp.down('jump') && inp.down('handbrake'), 'space bound to both jump and handbrake');
  inp.enabled = false;
  expect(!inp.down('forward') && !inp.pressed('jump'), 'disabled input reports nothing');
  inp.enabled = true;
  inp.addMouseDelta(3, 4); inp.addMouseDelta(1, 1);
  inp.beginFrame();
  expect(inp.mouseDX === 4 && inp.mouseDY === 5, 'mouse delta accumulated per frame');
  inp.beginFrame();
  expect(inp.mouseDX === 0, 'accumulator zeroed');
  inp.clearAll();
  expect(!inp.down('forward') && !inp.down('jump') && !inp.pressed('jump'), 'clearAll');
});

test('EventBus: on/off/once during emit', () => {
  const bus = new EventBus();
  const order: string[] = [];
  const offB = bus.on('notify', () => { order.push('B'); });
  bus.on('notify', () => { order.push('A'); offB(); });
  bus.emit('notify', { text: '', kind: 'info' });
  // A registered second: B fires first (already iterating) then A removes B; next emit only A.
  expect(order.join('') === 'BA', 'first emit: ' + order.join(''));
  order.length = 0;
  bus.emit('notify', { text: '', kind: 'info' });
  expect(order.join('') === 'A', 'B removed during emit stays removed');
  order.length = 0;
  let added = false;
  const unsub = bus.on('notify', () => { if (!added) { added = true; bus.on('notify', () => { order.push('C'); }); } order.push('X'); });
  bus.emit('notify', { text: '', kind: 'info' });
  expect(order.join('') === 'AX', 'listener added during emit is not called in that emit: ' + order.join(''));
  order.length = 0;
  bus.emit('notify', { text: '', kind: 'info' });
  expect(order.join('') === 'AXC', 'added listener called next emit: ' + order.join(''));
  unsub();
  let onceCount = 0;
  bus.once('horn', () => { onceCount++; });
  bus.emit('horn', { vehicleId: 1, x: 0, z: 0 });
  bus.emit('horn', { vehicleId: 1, x: 0, z: 0 });
  expect(onceCount === 1, 'once fires once');
  bus.clear();
  order.length = 0;
  bus.emit('notify', { text: '', kind: 'info' });
  expect(order.length === 0, 'clear removes everything');
});

test('World: line of sight against a known building', () => {
  const h = createHeadless({ seed: 1907 });
  const w = h.world;
  const b = w.city.buildings[0];
  const c = w.city.staticColliders[0];
  expect(c.tag === 'building' && c.shape.kind === 'aabb', 'first collider is a building AABB');
  const west = b.x - b.w / 2 - 3, east = b.x + b.w / 2 + 3;
  expect(!w.hasLineOfSight(west, b.z, east, b.z), 'segment through the building is blocked');
  expect(!w.hasLineOfSight(east, b.z, west, b.z), 'reverse direction blocked too');
  const clearZ = b.z - b.d / 2 - 2; // just outside, along the gap
  expect(w.hasLineOfSight(west, clearZ, east, clearZ), 'segment skirting the building is clear');
  const sp = w.city.points.playerSpawn;
  expect(w.hasLineOfSight(sp.x, sp.z, sp.x, sp.z + 30), 'along the sidewalk is clear');
  expect(w.roads.nodes.length === 121 && w.roads.segments.length === 220 && w.roads.lanes.length === 880, 'road graph counts');
  expect(w.sidewalks.loops.length === 101 && w.sidewalks.nodes.length >= 1200, 'sidewalk loops: 100 blocks + promenade');
  h.step(10);
  expect(w.time.tick === 10, 'headless step advances ticks');
  approx(w.time.elapsed, 10 / 60, 1e-9, 'elapsed');
});
