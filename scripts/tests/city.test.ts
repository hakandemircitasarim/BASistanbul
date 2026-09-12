// City tests: graph counts/links, pathing, walk graph, validateCity, points/spots, reservations, lookups, determinism, minimap, lot dressing, street dressing (trees, hedges, kerbside cars). Track A.
import { test, expect, approx } from './harness';
import { generateCity, validateCity } from '../../src/game/city/CityGenerator';
import type { GeneratedCity } from '../../src/game/city/CityGenerator';
import { BUDGET } from '../../src/game/core/Budget';
import { Random } from '../../src/game/core/Random';
import { BLOCK, INTERSECTION_R, LANE_W, PITCH, ROAD_W, SIDEWALK_W } from '../../src/game/city/CityConfig';
import { ASPHALT_HALF, colliderDistance, districtOf, onRoad } from '../../src/game/city/CityBuild';
import { HEDGE, LOT_BAYS, lotLayout } from '../../src/game/city/CityLots';
import { CAFE, CLUTTER_SPOT_CLEAR, DUMPSTER, POLE, ROADSIGN, TREE_CLEAR } from '../../src/game/city/CityProps';
import type { Lot, ParkedCar } from '../../src/game/city/CityData';
import { SPECS } from '../../src/game/entities/VehicleSpecs';
import { parkedMidGeometry, parkedNearGeometry, parkedShellGeometry } from '../../src/game/render/VehicleRenderer';
import type { LanePos } from '../../src/game/city/RoadGraph';
import { MINIMAP_BLIP_CAPACITY, MinimapRenderer, createMinimapSnapshot } from '../../src/game/minimap/MinimapRenderer';

let gen: GeneratedCity | null = null;
let genMs = 0;
let warmMs = 0;
function city(): GeneratedCity {
  if (!gen) {
    const t0 = performance.now();
    gen = generateCity();
    genMs = performance.now() - t0;
    const t1 = performance.now();
    generateCity();
    warmMs = performance.now() - t1;
  }
  return gen;
}

test('city: counts and generation time', () => {
  const g = city();
  const c = g.city;
  let lamps = 0, palms = 0, benches = 0, hydrants = 0, trees = 0, hedges = 0, other = 0;
  for (const p of c.props) { if (p.kind === 'lamp') lamps++; else if (p.kind === 'palm') palms++; else if (p.kind === 'bench') benches++; else if (p.kind === 'hydrant') hydrants++; else if (p.kind === 'tree') trees++; else if (p.kind === 'hedge') hedges++; else other++; }
  let lotCars = 0, kerbCars = 0;
  for (const p of c.parked ?? []) { if (p.at === 'kerb') kerbCars++; else lotCars++; }
  console.log(`    summary: nodes ${g.roads.nodes.length}, segments ${g.roads.segments.length}, lanes ${g.roads.lanes.length}, walk nodes ${g.sidewalks.nodes.length}, loops ${g.sidewalks.loops.length}`);
  console.log(`    summary: buildings ${c.buildings.length}, neon ${c.neonSigns.length}, landmarks ${c.landmarks.length}, lamps ${lamps}, palms ${palms}, trees ${trees}, hedges ${hedges}, benches ${benches}, hydrants ${hydrants}, other props ${other}, spots ${c.parkedSpots.length}, lot cars ${lotCars}, kerb cars ${kerbCars}, colliders ${c.staticColliders.length}`);
  console.log(`    summary: generation ${genMs.toFixed(1)} ms (cold), ${warmMs.toFixed(1)} ms (warm)`);
  expect(g.roads.nodes.length === 121, 'nodes = 121');
  expect(g.roads.segments.length === 220, 'segments = 220');
  expect(g.roads.lanes.length === 880, 'lanes = 880');
  expect(c.buildings.length >= 300 && c.buildings.length <= 400, `buildings in 300-400 (got ${c.buildings.length})`);
  expect(lamps >= 1000 && lamps <= 1400, `~1200 lamps (got ${lamps})`);
  expect(palms >= 400 && palms <= 600, `~500 palms (got ${palms})`);
  expect(c.neonSigns.length > 20, 'neon signs exist');
  expect(c.landmarks.length === 7, '7 landmarks');
  expect(c.parkedSpots.length === BUDGET.PARKED, 'parked spots = BUDGET.PARKED');
  expect(c.blocks.length === 100, '100 blocks');
  expect(Math.min(genMs, warmMs) < 300, `generation < 300 ms (cold ${genMs.toFixed(0)}, warm ${warmMs.toFixed(0)})`);
});

test('roads: lane geometry, successors within 25 m, kinds, U-turns only at corners', () => {
  const g = city();
  const r = g.roads;
  let uturns = 0;
  for (const l of r.lanes) {
    approx(l.length, PITCH - 2 * INTERSECTION_R, 1e-6, `lane ${l.id} trimmed`);
    expect(l.next.length >= 1, `lane ${l.id} has a successor`);
    expect(l.next.length === l.nextKind.length, 'nextKind parallel');
    const off = l.index === 0 ? 0.5 * LANE_W : 1.5 * LANE_W;
    const a = r.nodes[l.from];
    // lane start = node + dir * R + right2D(dir) * off
    approx(l.start.x, a.x + l.dir.x * INTERSECTION_R + -l.dir.z * off, 1e-6, `lane ${l.id} start x`);
    approx(l.start.z, a.z + l.dir.z * INTERSECTION_R + l.dir.x * off, 1e-6, `lane ${l.id} start z`);
    for (let k = 0; k < l.next.length; k++) {
      const n = r.lanes[l.next[k]];
      expect(n.from === l.to, `successor starts at lane end node`);
      const d = Math.hypot(n.start.x - l.end.x, n.start.z - l.end.z);
      expect(d <= 25, `successor within 25 m (got ${d.toFixed(1)})`);
      const dot = l.dir.x * n.dir.x + l.dir.z * n.dir.z;
      const cross = l.dir.x * n.dir.z - l.dir.z * n.dir.x;
      const kind = l.nextKind[k];
      if (dot > 0.5) expect(kind === 'straight' && n.index === l.index, 'straight keeps the lane index');
      else if (dot < -0.5) { uturns++; expect(n.segment === l.segment, 'U-turn onto the same segment'); const to = r.nodes[l.to]; expect((to.col === 0 || to.col === r.cols) && (to.row === 0 || to.row === r.rows), 'U-turn only at corner nodes'); }
      else if (cross > 0) expect(kind === 'right' && n.index === 1, 'right turn lands on the outer lane');
      else expect(kind === 'left' && n.index === 0, 'left turn lands on the inner lane');
      expect(r.turnLength(l.id, n.id) > 0 && r.turnLength(l.id, n.id) < 60, 'turn length sane');
      const mid = r.turnPoint(l.id, n.id, 0.5, { x: 0, z: 0 });
      const to = r.nodes[l.to];
      expect(Math.abs(mid.x - to.x) < 14 && Math.abs(mid.z - to.z) < 14, 'turn midpoint inside the intersection');
    }
    expect(l.speedLimit > 0, 'speed limit set');
  }
  expect(uturns === 16, `16 U-turn links (4 arriving lanes at each of the 4 corners) (got ${uturns})`);
  // Interior lanes have exactly straight/right/left; border stop signs are false.
  const inner = r.lanes.find((l) => { const n = r.nodes[l.to]; return n.col > 0 && n.col < r.cols && n.row > 0 && n.row < r.rows; });
  expect(inner !== undefined && inner.next.length === 3, 'interior lane has 3 successors');
  for (const n of r.nodes) if (n.col === 0 || n.row === 0 || n.col === r.cols || n.row === r.rows) expect(!n.stopSign, 'border nodes have no stop sign');
  let stops = 0;
  for (const n of r.nodes) if (n.stopSign) stops++;
  expect(stops > 20 && stops < 61, `about half the interior nodes have stop signs (${stops})`);
});

test('roads: A* corner-to-corner = 21 nodes and lanePathFromNodePath is continuous', () => {
  const r = city().roads;
  const path: number[] = [];
  const n = r.findPath(r.nodeAt(0, 0).id, r.nodeAt(10, 10).id, path);
  expect(n === 21, `21 nodes (got ${n})`);
  expect(path[0] === r.nodeAt(0, 0).id && path[20] === r.nodeAt(10, 10).id, 'ends included');
  for (let i = 0; i + 1 < n; i++) {
    const a = r.nodes[path[i]], b = r.nodes[path[i + 1]];
    expect(Math.abs(a.col - b.col) + Math.abs(a.row - b.row) === 1, 'consecutive nodes are adjacent');
  }
  const trivial: number[] = [];
  expect(r.findPath(5, 5, trivial) === 1 && trivial[0] === 5, 'trivial path');
  // Lane path: start on a lane whose end node is path[0]'s neighbor... use the lane arriving at path[0] from the east? Corner (0,0):
  const cur = r.nodes[path[0]].inLanes[0];
  const lanes: number[] = [];
  const lc = r.lanePathFromNodePath(cur, path, n, lanes);
  expect(lc >= 1, 'lane path produced');
  let prev = cur;
  for (let i = 0; i < lc; i++) {
    expect(r.lanes[prev].next.indexOf(lanes[i]) >= 0, `lane path continuous at ${i}`);
    prev = lanes[i];
  }
  expect(lc === n - 1 || r.lanes[lanes[lc - 1]].to === path[n - 1], 'lane path reaches the target');
  // Random pairs: lane path exists and is continuous from a lane arriving at the start node.
  const rng = new Random(5);
  for (let k = 0; k < 40; k++) {
    const a = rng.int(0, r.nodes.length - 1), b = rng.int(0, r.nodes.length - 1);
    const cnt = r.findPath(a, b, path);
    expect(cnt >= 1, 'path found');
    const inl = r.nodes[a].inLanes[rng.int(0, r.nodes[a].inLanes.length - 1)];
    const lcnt = r.lanePathFromNodePath(inl, path, cnt, lanes);
    let p = inl;
    for (let i = 0; i < lcnt; i++) { expect(r.lanes[p].next.indexOf(lanes[i]) >= 0, 'continuous'); p = lanes[i]; }
  }
});

test('sidewalks: loops, crossings, promenade, lookups', () => {
  const g = city();
  const s = g.sidewalks;
  expect(s.loops.length === 101, '100 block loops + promenade');
  for (let i = 0; i < 100; i++) expect(s.loops[i].length === 12, '12 nodes per block loop');
  expect(s.promenadeLoop === 100 && s.loops[100].length > 60, 'promenade loop present');
  for (const n of s.nodes) {
    expect(s.nodes[n.loopNext].loopPrev === n.id && s.nodes[n.loopPrev].loopNext === n.id, 'loop links valid');
    if (n.corner) expect(n.crossings.length >= 1, `corner ${n.id} has a crossing`);
    for (const c of n.crossings) expect(s.nodes[c].crossings.indexOf(n.id) >= 0, 'crossing symmetric');
    const d = Math.hypot(s.nodes[n.loopNext].x - n.x, s.nodes[n.loopNext].z - n.z);
    expect(d < 40, `loop step < 40 m (got ${d.toFixed(1)})`);
  }
  // Crossings are straight across the road (axis aligned).
  for (const n of s.nodes) for (const c of n.crossings) { const o = s.nodes[c]; expect(Math.abs(o.x - n.x) < 1e-6 || Math.abs(o.z - n.z) < 1e-6, 'crossing axis aligned'); }
  // nearestNode / nodesInRing vs brute force.
  const rng = new Random(11);
  const out: number[] = [];
  for (let k = 0; k < 200; k++) {
    const x = rng.range(-20, 1300), z = rng.range(-20, 1200);
    const n = s.nearestNode(x, z);
    let bd = Infinity;
    for (const m of s.nodes) bd = Math.min(bd, (m.x - x) ** 2 + (m.z - z) ** 2);
    approx((n.x - x) ** 2 + (n.z - z) ** 2, bd, 1e-6, 'nearestNode matches brute force');
    const cnt = s.nodesInRing(x, z, 60, 130, out);
    let brute = 0;
    for (const m of s.nodes) { const d = (m.x - x) ** 2 + (m.z - z) ** 2; if (d >= 3600 && d <= 16900) brute++; }
    expect(cnt === brute, `nodesInRing count ${cnt} vs brute ${brute}`);
  }
  const r2 = new Random(3);
  let crossed = 0;
  for (let k = 0; k < 500; k++) { const n = s.randomNode(r2); const nx = s.nextNode(n.id, 1, r2, 0.5); if (n.crossings.indexOf(nx) >= 0) crossed++; expect(nx === n.loopNext || n.crossings.indexOf(nx) >= 0, 'nextNode valid'); }
  expect(crossed > 0, 'nextNode crosses sometimes');
});

test('city: parking lots sit inside their blocks, hold the spawn spots and never overlap a building', () => {
  const c = city().city;
  const lots = c.lots ?? [];
  expect(lots.length >= 60 && lots.length <= 160, `60-160 empty lots (got ${lots.length})`);
  let spawnLot = false;
  const sp = c.points.playerSpawn;
  for (const l of lots) {
    const blk = c.blocks[l.blockRow * 10 + l.blockCol];
    expect(blk.col === l.blockCol && blk.row === l.blockRow && blk.kind === 'buildings', 'lot block index resolves to a buildings block');
    expect(l.x - l.w / 2 >= blk.x0 + 2 - 1e-6 && l.x + l.w / 2 <= blk.x1 - 2 + 1e-6 && l.z - l.d / 2 >= blk.z0 + 2 - 1e-6 && l.z + l.d / 2 <= blk.z1 - 2 + 1e-6, 'lot inside the block inset');
    expect(l.w >= 20 && l.d >= 20, `lot at least 20 m (got ${l.w.toFixed(1)} x ${l.d.toFixed(1)})`);
    for (const id of blk.buildings) {
      const b = c.buildings[id];
      const sep = Math.max(Math.abs(b.x - l.x) - (b.w + l.w) / 2, Math.abs(b.z - l.z) - (b.d + l.d) / 2);
      expect(sep >= -1e-6, `building ${id} does not overlap the lot (sep ${sep.toFixed(2)})`);
    }
    if (Math.hypot(l.x - sp.x, l.z - sp.z) < 40) spawnLot = true;
  }
  expect(spawnLot, 'a lot lies within 40 m of the spawn');
  let inLot = 0;
  for (const s of c.parkedSpots) for (const l of lots) if (Math.abs(s.x - l.x) <= l.w / 2 && Math.abs(s.z - l.z) <= l.d / 2) { inLot++; break; }
  expect(inLot >= 10, `parked spots use the lots (got ${inLot})`);
});

test('validateCity(generateCity()) is empty', () => {
  const problems = validateCity(city());
  if (problems.length) console.log('    ' + problems.slice(0, 15).join('\n    '));
  expect(problems.length === 0, `${problems.length} invariant violation(s)`);
});

test('points and parked spots are clear of colliders and lanes', () => {
  const g = city();
  const c = g.city;
  const pts: [string, number, number][] = [];
  for (const k of ['playerSpawn', 'hospital', 'policeStation', 'pier', 'garage', 'beachDelivery'] as const) pts.push([k, c.points[k].x, c.points[k].z]);
  c.points.missionStarts.forEach((m, i) => pts.push([`missionStart${i}`, m.x, m.z]));
  c.parkedSpots.forEach((s, i) => pts.push([`spot${i}`, s.x, s.z]));
  const halfW = LANE_W / 2;
  for (const [name, x, z] of pts) {
    let best = Infinity;
    for (const col of c.staticColliders) best = Math.min(best, colliderDistance(col, x, z));
    expect(best >= 0.6, `${name} >= 0.6 m from colliders (got ${best.toFixed(2)})`);
    // brute-force lane rectangle test
    for (const l of g.roads.lanes) {
      const t = (x - l.start.x) * l.dir.x + (z - l.start.z) * l.dir.z;
      const px = l.start.x + l.dir.x * t, pz = l.start.z + l.dir.z * t;
      const perp = Math.hypot(px - x, pz - z);
      expect(!(t >= 0 && t <= l.length && perp <= halfW), `${name} not inside lane ${l.id}`);
    }
    expect(!onRoad(g.roads, x, z, halfW), `${name} not on road (onRoad)`);
  }
  const sp = c.points.playerSpawn;
  let near = 0, near30 = 0;
  for (const s of c.parkedSpots) { const d = Math.hypot(s.x - sp.x, s.z - sp.z); if (d <= 40) near++; if (d <= 30) near30++; }
  expect(near >= 3, `>= 3 spots within 40 m of spawn (got ${near})`);
  expect(near30 >= 1, `a spot within 30 m of spawn (got ${near30})`);
  for (const m of c.points.missionStarts) {
    let ok = false;
    for (const s of c.parkedSpots) if (Math.hypot(s.x - m.x, s.z - m.z) <= 40) ok = true;
    expect(ok, 'each mission start has a parked spot within 40 m');
  }
  for (let i = 0; i < c.parkedSpots.length; i++) for (let j = i + 1; j < c.parkedSpots.length; j++) {
    const a = c.parkedSpots[i], b = c.parkedSpots[j];
    expect(Math.hypot(a.x - b.x, a.z - b.z) >= 9, 'spots >= 9 m apart');
  }
  for (const s of c.parkedSpots) { const n = g.roads.nearestNode(s.x, s.z); expect(Math.hypot(n.x - s.x, n.z - s.z) >= 18, 'spot >= 18 m from nodes'); }
  // Spawn is the east mid node of block (8,5) facing +X.
  const blk = c.blocks[5 * 10 + 8];
  approx(sp.x, blk.x1 + 1.5, 1e-6, 'spawn on the east sidewalk of block (8,5)');
  approx(sp.yaw, Math.PI / 2, 1e-9, 'spawn faces the road');
  expect(c.points.pier.x < 1276 && Math.abs(c.points.pier.z - 590) < 1e-6, 'pier point at the deck start');
});

test('roads: reservation rule truth table, expiry and release', () => {
  const r = city().roads;
  const N = r.nodeAt(4, 4).id;
  expect(r.canEnter(N, 1, 0, true) && r.canEnter(N, 1, 1, false), 'empty node: anyone may enter');
  expect(r.reserve(N, 1, 0, true, 0), 'first straight reservation');
  expect(r.reserve(N, 1, 0, true, 0.5), 'reserve is idempotent per id');
  expect(r.nodes[N].occupantCount === 1, 'one occupant');
  expect(r.canEnter(N, 2, 0, true), 'same-axis straight may share');
  expect(!r.canEnter(N, 3, 1, true), 'cross-axis straight blocked');
  expect(!r.canEnter(N, 4, 0, false), 'turning blocked by an occupant');
  expect(!r.reserve(N, 4, 0, false, 1), 'reserve refuses a turn');
  expect(r.reserve(N, 2, 0, true, 1), 'second straight same axis accepted');
  r.release(N, 1);
  r.release(N, 2);
  expect(r.nodes[N].occupantCount === 0, 'released');
  expect(r.reserve(N, 5, 1, false, 2), 'turn reservation on an empty node');
  expect(!r.canEnter(N, 6, 1, true) && !r.canEnter(N, 7, 1, false), 'a turning occupant blocks everyone');
  expect(r.canEnter(N, 5, 1, true), 'the occupant itself may re-enter');
  r.expireReservations(5, 4);
  expect(r.nodes[N].occupantCount === 1, 'not expired at 3 s');
  r.expireReservations(6.5, 4);
  expect(r.nodes[N].occupantCount === 0, 'expired after 4 s');
  r.reserve(N, 9, 0, true, 0);
  r.reserve(r.nodeAt(5, 5).id, 9, 1, true, 0);
  r.releaseAll(9);
  expect(r.nodes[N].occupantCount === 0 && r.nodes[r.nodeAt(5, 5).id].occupantCount === 0, 'releaseAll');
});

test('roads: nearestLane / lanesInRing / nearestNode match brute force', () => {
  const r = city().roads;
  const rng = new Random(77);
  const lp: LanePos = { lane: 0, t: 0 };
  const out: number[] = [];
  for (let k = 0; k < 300; k++) {
    const x = rng.range(-30, 1250), z = rng.range(-30, 1250);
    r.nearestLane(x, z, lp);
    let best = Infinity;
    for (const l of r.lanes) {
      let t = (x - l.start.x) * l.dir.x + (z - l.start.z) * l.dir.z;
      t = Math.max(0, Math.min(l.length, t));
      best = Math.min(best, Math.hypot(l.start.x + l.dir.x * t - x, l.start.z + l.dir.z * t - z));
    }
    const l = r.lanes[lp.lane];
    const got = Math.hypot(l.start.x + l.dir.x * lp.t - x, l.start.z + l.dir.z * lp.t - z);
    approx(got, best, 1e-6, `nearestLane distance at (${x.toFixed(0)},${z.toFixed(0)})`);
    const rMin = rng.range(50, 150), rMax = rMin + rng.range(20, 150);
    const cnt = r.lanesInRing(x, z, rMin, rMax, out);
    let brute = 0;
    for (const m of r.lanes) { const d = Math.hypot((m.start.x + m.end.x) / 2 - x, (m.start.z + m.end.z) / 2 - z); if (d >= rMin && d <= rMax) brute++; }
    expect(cnt === brute, `lanesInRing ${cnt} vs brute ${brute}`);
    const n = r.nearestNode(x, z);
    let bn = Infinity;
    for (const m of r.nodes) bn = Math.min(bn, Math.hypot(m.x - x, m.z - z));
    approx(Math.hypot(n.x - x, n.z - z), bn, 1e-6, 'nearestNode');
  }
  const p = r.randomLanePos(rng, lp);
  expect(p.lane >= 0 && p.lane < 880 && p.t >= 0 && p.t <= r.lanes[p.lane].length, 'randomLanePos in range');
});

test('city: deterministic for a seed, different for another', () => {
  const a = generateCity(1907), b = generateCity(1907), c = generateCity(42);
  const key = (g: GeneratedCity): string => JSON.stringify(g.city) + JSON.stringify(g.roads.lanes.map((l) => l.next)) + JSON.stringify(g.roads.nodes.map((n) => n.stopSign)) + JSON.stringify(g.sidewalks.nodes);
  expect(key(a) === key(b), 'same seed -> identical city');
  expect(JSON.stringify(a.city.buildings) !== JSON.stringify(c.city.buildings), 'different seed -> different buildings');
  expect(validateCity(c).length === 0, 'seed 42 also validates');
});

test('minimap: snapshot capacity and renderer draws with a fake canvas', () => {
  const snap = createMinimapSnapshot();
  expect(snap.blips.length === MINIMAP_BLIP_CAPACITY && MINIMAP_BLIP_CAPACITY === 160, '160 preallocated blips');
  const calls: Record<string, number> = {};
  const fakeCtx = new Proxy({}, {
    get: (_t, prop: string) => (...args: unknown[]) => { calls[prop] = (calls[prop] ?? 0) + 1; void args; return undefined; },
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx } as unknown as HTMLCanvasElement;
  const g = globalThis as unknown as { document?: unknown };
  const hadDoc = 'document' in g;
  g.document = { createElement: () => fakeCanvas };
  try {
    const gc = city();
    const mm = new MinimapRenderer(gc.city, gc.roads);
    expect(mm.base === fakeCanvas && fakeCanvas.width > 500 && fakeCanvas.height > 500, 'base canvas sized');
    expect((calls.fillRect ?? 0) > 300 && (calls.fillText ?? 0) === 0, 'base drew blocks/roads (labels are drawn per frame so they stay upright)');
    snap.px = gc.city.points.playerSpawn.x; snap.pz = gc.city.points.playerSpawn.z; snap.pyaw = 1; snap.camYaw = 2;
    snap.blipCount = 6;
    const kinds = ['vehicle', 'police', 'mission', 'hospital', 'policeStation', 'garage'] as const;
    for (let i = 0; i < 6; i++) { snap.blips[i].kind = kinds[i]; snap.blips[i].x = snap.px + i * 5; snap.blips[i].z = snap.pz - 10; }
    snap.hasObjective = true; snap.objectiveX = 100; snap.objectiveZ = 100; snap.wanted = 2;
    const before = calls.drawImage ?? 0;
    mm.draw(fakeCtx, snap, 200, 120, true);
    mm.draw(fakeCtx, snap, 200, 120, false);
    expect((calls.drawImage ?? 0) === before + 2, 'draw() blits the base once per call');
    expect((calls.clip ?? 0) >= 2 && (calls.fillText ?? 0) > 6, 'draw() clipped and drew badges + landmark labels');
    mm.dispose();
  } finally {
    if (!hadDoc) delete g.document;
  }
});

test('lots: static parked cars fill free bays only, keep the gameplay spots, their exit side and the gate lane clear, and carry colliders', () => {
  const g = city();
  const c = g.city;
  const lots = c.lots ?? [], parked = (c.parked ?? []).filter((p) => p.at === 'lot'), lotProps = c.lotProps ?? [];
  const B = LOT_BAYS;
  expect(parked.length >= 400 && parked.length <= 2000, `400-2000 static lot cars (got ${parked.length})`);
  let islands = 0, planters = 0;
  for (const p of lotProps) { if (p.kind === 'island') islands++; else if (p.kind === 'planter') planters++; }
  expect(islands >= lots.length && planters >= lots.length / 2, `islands (${islands}) and planters (${planters}) for ${lots.length} lots`);
  console.log(`    summary: parked ${parked.length}, islands ${islands}, planters ${planters} over ${lots.length} lots`);
  const lotOf = (x: number, z: number): Lot | null => {
    for (const l of lots) if (Math.abs(x - l.x) <= l.w / 2 && Math.abs(z - l.z) <= l.d / 2) return l;
    return null;
  };
  const rect = (x: number, z: number, yaw: number, hw: number, hl: number) => {
    const cs = Math.abs(Math.cos(yaw)), sn = Math.abs(Math.sin(yaw));
    const ex = hw * cs + hl * sn, ez = hw * sn + hl * cs;
    return { x0: x - ex, z0: z - ez, x1: x + ex, z1: z + ez };
  };
  const overlap = (a: { x0: number; z0: number; x1: number; z1: number }, b: { x0: number; z0: number; x1: number; z1: number }): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
  const aabbs = c.staticColliders.filter((k) => k.tag === 'prop' && k.shape.kind === 'aabb');
  const hasCollider = (x: number, z: number): boolean => aabbs.some((k) => k.shape.kind === 'aabb' && x > k.shape.minX && x < k.shape.maxX && z > k.shape.minZ && z < k.shape.maxZ);
  const rects: { x0: number; z0: number; x1: number; z1: number }[] = [];
  for (const p of parked) {
    const lot = lotOf(p.x, p.z);
    expect(lot !== null, `parked car at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) lies in a lot`);
    expect(p.spec === 'sedan' || p.spec === 'sport' || p.spec === 'van', 'parked spec valid');
    expect(SPECS[p.spec].colors.indexOf(p.colour) >= 0, 'parked colour from the spec palette');
    const q = Math.round(p.yaw / (Math.PI / 2));
    approx(p.yaw, q * Math.PI / 2, 1e-9, 'parked yaw is a quarter turn');
    const lay = lotLayout(g.roads, c.blocks, lot!);
    const along = lay.alongX ? p.x : p.z, across = lay.alongX ? p.z : p.x;
    expect(lay.strips.some((a) => Math.abs(a - along) < 1e-6) && lay.bays.some((b) => Math.abs(b - across) < 1e-6), 'parked car sits on a bay centre');
    expect(lay.alongX === (Math.abs(Math.sin(p.yaw)) > 0.5), 'parked car noses along the strip heading');
    const r = rect(p.x, p.z, p.yaw, SPECS[p.spec].width / 2, SPECS[p.spec].length / 2);
    expect(!overlap(r, lay.gateRect), 'parked car stays out of the gate lane');
    for (const o of rects) expect(!overlap(r, o), 'parked cars never overlap');
    rects.push(r);
    expect(hasCollider(p.x, p.z), 'parked car has an AABB prop collider');
  }
  // Gameplay spots: the spot bay and the bay to the driver's right (where ?nearcar=1 places the player) stay free.
  for (const s of c.parkedSpots) {
    const lot = lotOf(s.x, s.z);
    if (!lot) continue;
    const lay = lotLayout(g.roads, c.blocks, lot);
    const bay = (x: number, z: number) => (lay.alongX ? { x0: x - B.bayLen / 2, x1: x + B.bayLen / 2, z0: z - B.bayPitch / 2, z1: z + B.bayPitch / 2 } : { x0: x - B.bayPitch / 2, x1: x + B.bayPitch / 2, z0: z - B.bayLen / 2, z1: z + B.bayLen / 2 });
    const own = bay(s.x, s.z), right = bay(s.x - Math.cos(s.yaw) * B.bayPitch, s.z + Math.sin(s.yaw) * B.bayPitch);
    for (const r of rects) expect(!overlap(r, own) && !overlap(r, right), `spot (${s.x.toFixed(0)}, ${s.z.toFixed(0)}) and its exit bay are free of static cars`);
    expect(lay.strips.some((a) => Math.abs(a - (lay.alongX ? s.x : s.z)) < 1e-6) && lay.bays.some((b) => Math.abs(b - (lay.alongX ? s.z : s.x)) < 1e-6), 'gameplay spot lands on a bay centre of the shared grid');
  }
  for (const p of lotProps) {
    const lot = lotOf(p.x, p.z);
    expect(lot !== null, `${p.kind} lies in a lot`);
    if (p.kind === 'island') {
      expect(hasCollider(p.x, p.z), 'island has an AABB prop collider');
      const r = rect(p.x, p.z, p.yaw, 0.75, 2.8);
      for (const o of rects) expect(!overlap(r, o), 'island never overlaps a parked car');
    } else {
      expect(lotProps.some((q) => q.kind === 'island' && Math.abs(q.x - p.x) < 2.2 && Math.abs(q.z - p.z) < 2.2), 'planter stands on an island');
    }
  }
  // The spawn lot: static cars present, the nearest gameplay spot to the spawn untouched.
  const sp = c.points.playerSpawn;
  expect(parked.some((p) => Math.hypot(p.x - sp.x, p.z - sp.z) < 45), 'static cars in the spawn lot');
  // Determinism of the dressing alone.
  const b = generateCity(1907).city;
  expect(JSON.stringify((b.parked ?? []).filter((p) => p.at === 'lot')) === JSON.stringify(parked) && JSON.stringify(b.lotProps) === JSON.stringify(lotProps), 'lot dressing deterministic for the seed');
});

/** Road centre line nearest a point on a block face: the block edge it sits outside of and the offset from that edge. */
function faceOffset(c: { blocks: { x0: number; z0: number; x1: number; z1: number }[] }, x: number, z: number): { edge: number; off: number; along: number } | null {
  for (const b of c.blocks) {
    const half = ROAD_W / 2;
    if (x >= b.x0 && x <= b.x1) {
      if (z > b.z1 && z < b.z1 + half) return { edge: 0, off: z - b.z1, along: x - b.x0 };
      if (z < b.z0 && z > b.z0 - half) return { edge: 2, off: b.z0 - z, along: x - b.x0 };
    }
    if (z >= b.z0 && z <= b.z1) {
      if (x > b.x1 && x < b.x1 + half) return { edge: 1, off: x - b.x1, along: z - b.z0 };
      if (x < b.x0 && x > b.x0 - half) return { edge: 3, off: b.x0 - x, along: z - b.z0 };
    }
  }
  return null;
}

test('kerbside parking: on the pavement against the kerb, off every lane / intersection / crossing, clear of props, points and each other, with colliders, deterministic', () => {
  const g = city();
  const c = g.city;
  const kerb = (c.parked ?? []).filter((p) => p.at === 'kerb');
  expect(kerb.length >= 900 && kerb.length <= 2200, `900-2200 kerbside cars (got ${kerb.length})`);
  const aabbs = c.staticColliders.filter((k) => k.tag === 'prop' && k.shape.kind === 'aabb');
  const circles = c.staticColliders.filter((k) => k.shape.kind === 'circle' && k.tag !== 'water' && k.tag !== 'boundary');
  const hasCollider = (x: number, z: number): boolean => aabbs.some((k) => k.shape.kind === 'aabb' && x > k.shape.minX && x < k.shape.maxX && z > k.shape.minZ && z < k.shape.maxZ);
  const rectOf = (p: ParkedCar) => {
    const hw = SPECS[p.spec].width / 2, hl = SPECS[p.spec].length / 2;
    const cs = Math.abs(Math.cos(p.yaw)), sn = Math.abs(Math.sin(p.yaw));
    const ex = hw * cs + hl * sn, ez = hw * sn + hl * cs;
    return { x0: p.x - ex, z0: p.z - ez, x1: p.x + ex, z1: p.z + ez };
  };
  const overlap = (a: { x0: number; z0: number; x1: number; z1: number }, b: { x0: number; z0: number; x1: number; z1: number }): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
  const rects = (c.parked ?? []).filter((p) => p.at === 'lot').map(rectOf);
  const pts: [number, number][] = [];
  for (const k of ['playerSpawn', 'hospital', 'policeStation', 'garage', 'beachDelivery'] as const) pts.push([c.points[k].x, c.points[k].z]);
  for (const m of c.points.missionStarts) pts.push([m.x, m.z]);
  const hydrants = c.props.filter((p) => p.kind === 'hydrant'), shelters = c.props.filter((p) => p.kind === 'shelter');
  const dist = (r: { x0: number; z0: number; x1: number; z1: number }, x: number, z: number): number => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));
  const halfW = LANE_W / 2;
  let sedans = 0;
  for (const p of kerb) {
    expect(p.spec === 'sedan' || p.spec === 'sport' || p.spec === 'van', 'kerb spec valid');
    if (p.spec === 'sedan') sedans++;
    expect(SPECS[p.spec].colors.indexOf(p.colour) >= 0, 'kerb colour from the spec palette');
    approx(p.yaw, Math.round(p.yaw / (Math.PI / 2)) * Math.PI / 2, 1e-9, 'kerb yaw is a quarter turn');
    const r = rectOf(p);
    // On a block face's pavement strip: road-side flank just off the asphalt, far flank inside the block edge.
    const f = faceOffset(c, p.x, p.z);
    expect(f !== null, `kerb car at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) lies on a block face`);
    const hw = SPECS[p.spec].width / 2;
    const roadSide = f!.off + hw, blockSide = f!.off - hw;
    expect(roadSide <= SIDEWALK_W - 0.05 + 1e-6 && roadSide >= SIDEWALK_W - 0.2, `road-side flank ${(ROAD_W / 2 - roadSide).toFixed(2)} m from the road centre (kerb at ${ASPHALT_HALF})`);
    expect(blockSide >= 0.5, 'far flank leaves room on the pavement');
    // Nose along the edge, well clear of the block corners (intersection boxes + crossings).
    const alongX = f!.edge === 0 || f!.edge === 2;
    expect(alongX === (Math.abs(Math.sin(p.yaw)) > 0.5), 'kerb car noses along the street');
    const hl = SPECS[p.spec].length / 2;
    expect(f!.along - hl >= 5.9 && f!.along + hl <= BLOCK - 5.9, `kerb car stays ${6} m clear of the block corners (along ${f!.along.toFixed(1)})`);
    // Never on a lane or in an intersection (validator rule at every corner), and the yaw follows the adjacent lane.
    for (const [x, z] of [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1], [p.x, p.z]]) expect(!onRoad(g.roads, x, z, halfW), 'kerb car footprint off the road');
    const lp = { lane: 0, t: 0 };
    g.roads.nearestLane(p.x, p.z, lp);
    const d = g.roads.lanes[lp.lane].dir;
    approx(Math.atan2(d.x, d.z), p.yaw, 1e-6, 'nose along the adjacent lane direction');
    // Clear of every prop / building collider (circles), other parked cars, hydrants, shelters and the named points.
    for (const k of circles) { const s = k.shape as { cx: number; cz: number; r: number }; expect(dist(r, s.cx, s.cz) >= s.r + 0.29, `kerb car clears ${k.tag} collider at (${s.cx.toFixed(1)}, ${s.cz.toFixed(1)})`); }
    for (const o of rects) expect(!overlap(r, o), 'kerb cars never overlap another parked car');
    rects.push(r);
    for (const h of hydrants) expect(dist(r, h.x, h.z) >= 1.5 - 1e-6, 'kerb car keeps 1.5 m from a hydrant');
    for (const h of shelters) expect(dist(r, h.x, h.z) >= 3.2 - 1e-6, 'kerb car keeps 3.2 m from a bus shelter');
    for (const [x, z] of pts) expect(dist(r, x, z) >= 3.5 - 1e-6, 'kerb car keeps 3.5 m from the named points');
    expect(hasCollider(p.x, p.z), 'kerb car has an AABB prop collider');
  }
  expect(sedans > kerb.length * 0.45 && sedans < kerb.length * 0.8, `sedans dominate the mix (${sedans}/${kerb.length})`);
  // The spawn street has kerbside cars in view, and the spawn point itself stays free.
  const sp = c.points.playerSpawn;
  expect(kerb.some((p) => Math.hypot(p.x - sp.x, p.z - sp.z) < 60), 'kerbside cars within 60 m of the spawn');
  const b = generateCity(1907).city;
  expect(JSON.stringify((b.parked ?? []).filter((p) => p.at === 'kerb')) === JSON.stringify(kerb), 'kerbside parking deterministic for the seed');
});

test('street trees and lot hedges: placement, clearances, colliders', () => {
  const g = city();
  const c = g.city;
  const trees = c.props.filter((p) => p.kind === 'tree'), hedges = c.props.filter((p) => p.kind === 'hedge');
  expect(trees.length >= 500 && trees.length <= 1600, `500-1600 sidewalk trees (got ${trees.length})`);
  expect(hedges.length >= 600 && hedges.length <= 3000, `600-3000 hedge units (got ${hedges.length})`);
  const circles = c.staticColliders.filter((k) => k.shape.kind === 'circle' && k.tag !== 'water' && k.tag !== 'boundary');
  const shelters = c.props.filter((p) => p.kind === 'shelter');
  let downtown = 0, fitted = 0;
  for (const t of trees) {
    const f = faceOffset(c, t.x, t.z);
    expect(f !== null, 'tree stands on a block face');
    approx(f!.off, 2.3, 1e-6, 'tree on the kerb line (2.3 m outside the block edge)');
    expect(f!.along >= 6 && f!.along <= BLOCK - 6, 'tree clear of the block corners');
    expect(!onRoad(g.roads, t.x, t.z, halfWOf()), 'tree off the road');
    const blk = c.blocks.find((b) => t.x >= b.x0 - 3 && t.x <= b.x1 + 3 && t.z >= b.z0 - 3 && t.z <= b.z1 + 3)!;
    const d = districtOf(blk.col, blk.row);
    expect(d !== 'beachfront' && blk.kind === 'buildings', 'trees only on downtown / suburb building blocks');
    if (d === 'downtown') downtown++;
    expect(t.scale >= 0.8 && t.scale <= 1.3, 'tree scale in range');
    let nearest = Infinity;
    for (const k of circles) {
      const s = k.shape as { cx: number; cz: number; r: number };
      const dd = Math.hypot(s.cx - t.x, s.cz - t.z) - s.r;
      if (dd > 1e-6 && dd < nearest) nearest = dd; // skip its own collider (distance -r)
    }
    expect(nearest >= 1.2 - 1e-6, `tree keeps 1.2 m from the nearest collider (got ${nearest.toFixed(2)})`);
    // Crown clearance: the whole point of scaling a tree down near a facade is that its crown (TREE.crownR at
    // scale 1) never reaches the building line. Crowns pushing through walls and clipping shopfront bands was the
    // fault this test exists to catch.
    let facade = Infinity;
    for (const bg of c.buildings) {
      const dx = Math.max(bg.x - bg.w / 2 - t.x, 0, t.x - (bg.x + bg.w / 2));
      const dz = Math.max(bg.z - bg.d / 2 - t.z, 0, t.z - (bg.z + bg.d / 2));
      facade = Math.min(facade, Math.hypot(dx, dz));
    }
    expect(facade >= TREE_CLEAR.crownR * t.scale + TREE_CLEAR.facadeGap - 1e-6,
      `tree crown clears the building line (gap ${facade.toFixed(2)} m, crown ${(TREE_CLEAR.crownR * t.scale).toFixed(2)} m)`);
    // ... and the rule has to actually BITE somewhere, or the assertion above certifies nothing: with crownR at 2.75
    // the largest crown (2.75 * 1.3 + 0.4 = 3.98 m) fitted every gap the generator can make (the tightest is 4.30 m),
    // so no tree was ever shrunk and the clearance was dead code that passed with 0.3 m of slack.
    if (Math.abs(t.scale - (facade - TREE_CLEAR.facadeGap) / TREE_CLEAR.crownR) < 1e-9 && t.scale < 1.3 - 1e-9) fitted++;
    for (const h of shelters) expect(Math.hypot(h.x - t.x, h.z - t.z) >= 4.5, 'tree keeps 4.5 m from a bus shelter');
    expect(circles.some((k) => { const s = k.shape as { cx: number; cz: number; r: number }; return Math.abs(s.cx - t.x) < 1e-6 && Math.abs(s.cz - t.z) < 1e-6; }), 'tree has a circle collider');
  }
  expect(fitted >= 20, `the crown-clearance rule shrinks the trees that stand close to a facade (got ${fitted} of ${trees.length})`);
  expect(downtown > 0 && downtown < trees.length, 'trees in both downtown and the suburbs');
  const lots = c.lots ?? [];
  const aabbs = c.staticColliders.filter((k) => k.tag === 'prop' && k.shape.kind === 'aabb');
  for (const h of hedges) {
    // In the inset band outside a lot's street-facing edge, never across its gate.
    const lot = lots.find((l) => Math.abs(h.x - l.x) <= l.w / 2 + HEDGE.off + 0.5 && Math.abs(h.z - l.z) <= l.d / 2 + HEDGE.off + 0.5 && (Math.abs(Math.abs(h.x - l.x) - (l.w / 2 + HEDGE.off)) < 1e-6 || Math.abs(Math.abs(h.z - l.z) - (l.d / 2 + HEDGE.off)) < 1e-6));
    expect(lot !== undefined, `hedge at (${h.x.toFixed(1)}, ${h.z.toFixed(1)}) sits ${HEDGE.off} m outside a lot edge`);
    const blk = c.blocks[lot!.blockRow * 10 + lot!.blockCol];
    expect(h.x > blk.x0 && h.x < blk.x1 && h.z > blk.z0 && h.z < blk.z1, 'hedge inside the block (inset band)');
    const lay = lotLayout(g.roads, c.blocks, lot!);
    const onX = Math.abs(Math.abs(h.z - lot!.z) - (lot!.d / 2 + HEDGE.off)) < 1e-6;
    const gateEdge = lay.gate === 0 || lay.gate === 2 ? onX && Math.sign(h.z - lot!.z) === (lay.gate === 0 ? 1 : -1) : !onX && Math.sign(h.x - lot!.x) === (lay.gate === 1 ? 1 : -1);
    if (gateEdge) expect(Math.abs((onX ? h.x : h.z) - (onX ? lot!.x : lot!.z)) >= LOT_BAYS.gateW / 2 + HEDGE.gateClear + HEDGE.len / 2 - 1e-6, 'hedge stays out of the gate');
    expect(aabbs.some((k) => k.shape.kind === 'aabb' && h.x > k.shape.minX && h.x < k.shape.maxX && h.z > k.shape.minZ && h.z < k.shape.maxZ), 'hedge has an AABB collider');
    for (const b of c.buildings) expect(Math.abs(b.x - h.x) > b.w / 2 + 0.3 || Math.abs(b.z - h.z) > b.d / 2 + 0.3, 'hedge never touches a building');
  }
  const b = generateCity(1907).city;
  expect(JSON.stringify(b.props.filter((p) => p.kind === 'tree' || p.kind === 'hedge')) === JSON.stringify([...c.props.filter((p) => p.kind === 'tree' || p.kind === 'hedge')]), 'trees and hedges deterministic for the seed');
});

function halfWOf(): number { return LANE_W / 2; }

/** Distance from (x, z) to the nearest edge of the block that contains it, with that edge's index (null when outside every block). */
function insetOffset(c: { blocks: { x0: number; z0: number; x1: number; z1: number }[] }, x: number, z: number): { edge: number; off: number } | null {
  for (const b of c.blocks) {
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    const d = [b.z1 - z, b.x1 - x, z - b.z0, x - b.x0];
    let edge = 0;
    for (let i = 1; i < 4; i++) if (d[i] < d[edge]) edge = i;
    return { edge, off: d[edge] };
  }
  return null;
}

test('street clutter: poles with wire runs, signs, dumpsters and café tables — placement, clearances, colliders, determinism', () => {
  const g = city();
  const c = g.city;
  const poles = c.props.filter((p) => p.kind === 'pole');
  const signs = c.props.filter((p) => p.kind === 'roadsign');
  const dumpsters = c.props.filter((p) => p.kind === 'dumpster');
  const tables = c.props.filter((p) => p.kind === 'table');
  console.log(`    summary: clutter — poles ${poles.length}, road signs ${signs.length}, dumpsters ${dumpsters.length}, café tables ${tables.length}`);
  expect(poles.length >= 200 && poles.length <= 900, `200-900 utility poles (got ${poles.length})`);
  expect(signs.length >= 60 && signs.length <= 400, `60-400 road signs (got ${signs.length})`);
  expect(dumpsters.length >= 100 && dumpsters.length <= 900, `100-900 dumpsters (got ${dumpsters.length})`);
  expect(tables.length >= 20 && tables.length <= 400, `20-400 café tables (got ${tables.length})`);
  const circles = c.staticColliders.filter((k) => k.shape.kind === 'circle' && k.tag !== 'water' && k.tag !== 'boundary');
  const aabbs = c.staticColliders.filter((k) => k.tag === 'prop' && k.shape.kind === 'aabb');
  const hasCircle = (x: number, z: number): boolean => circles.some((k) => { const s = k.shape as { cx: number; cz: number; r: number }; return Math.abs(s.cx - x) < 1e-6 && Math.abs(s.cz - z) < 1e-6; });
  const hasAabb = (x: number, z: number): boolean => aabbs.some((k) => k.shape.kind === 'aabb' && x > k.shape.minX && x < k.shape.maxX && z > k.shape.minZ && z < k.shape.maxZ);
  /** Clearance to the nearest *other* collider surface (its own collider sits at distance -r). */
  const nearestOther = (x: number, z: number): number => {
    let best = Infinity;
    for (const k of circles) { const s = k.shape as { cx: number; cz: number; r: number }; const d = Math.hypot(s.cx - x, s.cz - z) - s.r; if (d > 1e-6 && d < best) best = d; }
    return best;
  };
  const halfW = LANE_W / 2;
  const kerbCars = (c.parked ?? []).filter((p) => p.at === 'kerb');
  const carClear = (x: number, z: number, r: number): boolean => kerbCars.every((p) => {
    const hw = SPECS[p.spec].width / 2, hl = SPECS[p.spec].length / 2;
    const cs = Math.abs(Math.cos(p.yaw)), sn = Math.abs(Math.sin(p.yaw));
    const ex = hw * cs + hl * sn, ez = hw * sn + hl * cs;
    return Math.hypot(Math.max(p.x - ex - x, 0, x - (p.x + ex)), Math.max(p.z - ez - z, 0, z - (p.z + ez))) >= r;
  });
  const spots = c.parkedSpots;
  const spotClear = (x: number, z: number, r: number): boolean => spots.every((s) => Math.hypot(s.x - x, s.z - z) >= r - 1e-6);

  // Poles: on the kerb line of a suburb building block, in runs that stop short of both corners.
  for (const p of poles) {
    const f = faceOffset(c, p.x, p.z);
    expect(f !== null, `pole at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) stands on a block face`);
    approx(f!.off, POLE.off, 1e-6, 'pole on the kerb line');
    expect(f!.along >= POLE.first - 1e-6 && f!.along <= BLOCK - POLE.endClear + 1e-6, `pole clear of the block corners (along ${f!.along.toFixed(1)})`);
    const blk = c.blocks.find((b) => p.x >= b.x0 - 3 && p.x <= b.x1 + 3 && p.z >= b.z0 - 3 && p.z <= b.z1 + 3)!;
    expect(districtOf(blk.col, blk.row) === 'suburb' && blk.kind === 'buildings', 'poles only on suburb building blocks');
    expect(!onRoad(g.roads, p.x, p.z, halfW), 'pole off the road');
    expect(nearestOther(p.x, p.z) >= POLE.clear - 1e-6, `pole keeps ${POLE.clear} m from the nearest collider`);
    expect(hasCircle(p.x, p.z), 'pole has a circle collider');
    expect(carClear(p.x, p.z, POLE.r), 'no kerbside car overlaps a pole');
    expect(spotClear(p.x, p.z, CLUTTER_SPOT_CLEAR), 'pole keeps clear of the gameplay parking spots');
  }
  // Wire runs: a pole always has a neighbour on its own edge line, and a run never jumps an intersection.
  let spans = 0;
  for (const a of poles) {
    for (const b of poles) {
      if (a === b || Math.abs(a.yaw - b.yaw) > 1e-3) continue;
      const alongX = Math.abs(Math.sin(a.yaw)) < 0.5;
      if (Math.abs(alongX ? a.z - b.z : a.x - b.x) > 0.05) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d >= 12 && d <= 42) spans++;
    }
  }
  expect(spans > poles.length, `poles form wire runs (${spans / 2} spans for ${poles.length} poles)`);

  // Road signs: on the pavement at an intersection approach, plate across the street.
  for (const p of signs) {
    const f = faceOffset(c, p.x, p.z);
    expect(f !== null, 'road sign stands on a block face');
    approx(f!.off, ROADSIGN.off, 1e-6, 'road sign on the kerb line');
    expect(!onRoad(g.roads, p.x, p.z, halfW), 'road sign off the road');
    expect(nearestOther(p.x, p.z) >= ROADSIGN.clear - 1e-6, 'road sign keeps its clearance');
    expect(hasCircle(p.x, p.z), 'road sign has a circle collider');
    expect(carClear(p.x, p.z, ROADSIGN.r), 'no kerbside car overlaps a road sign');
    expect(spotClear(p.x, p.z, CLUTTER_SPOT_CLEAR), 'road sign keeps clear of the gameplay parking spots');
  }

  // Dumpsters: inside a block, in the alley band, never inside a building, with a box collider.
  for (const p of dumpsters) {
    const f = insetOffset(c, p.x, p.z);
    expect(f !== null, `dumpster at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) is inside a block`);
    expect(f!.off <= DUMPSTER.depth + 1e-6, 'dumpster in the alley band, not deep inside the block');
    expect(!onRoad(g.roads, p.x, p.z, halfW), 'dumpster off the road');
    for (const b of c.buildings) expect(Math.abs(b.x - p.x) > b.w / 2 || Math.abs(b.z - p.z) > b.d / 2, 'dumpster never inside a building');
    expect(nearestOther(p.x, p.z) >= DUMPSTER.clear - 1e-6, 'dumpster keeps its clearance');
    expect(hasAabb(p.x, p.z), 'dumpster has an AABB collider');
    expect(spotClear(p.x, p.z, CLUTTER_SPOT_CLEAR), 'dumpster keeps clear of the gameplay parking spots');
  }

  // Café tables: in the arcade strip between the block edge and the shopfronts.
  for (const p of tables) {
    const f = insetOffset(c, p.x, p.z);
    expect(f !== null, 'café table is inside a block');
    approx(f!.off, CAFE.inset, 1e-6, 'café table in the arcade strip');
    expect(!onRoad(g.roads, p.x, p.z, halfW), 'café table off the road');
    for (const b of c.buildings) expect(Math.abs(b.x - p.x) > b.w / 2 || Math.abs(b.z - p.z) > b.d / 2, 'café table never inside a building');
    expect(nearestOther(p.x, p.z) >= CAFE.clear - 1e-6, 'café table keeps its clearance');
    expect(hasCircle(p.x, p.z), 'café table has a circle collider');
    expect(spotClear(p.x, p.z, CLUTTER_SPOT_CLEAR), 'café table keeps clear of the gameplay parking spots');
  }

  // Crossings: nothing stands on a sidewalk crossing line between two corner nodes.
  const clutter = [...poles, ...signs, ...dumpsters, ...tables];
  for (const n of g.sidewalks.nodes) {
    for (const ci of n.crossings) {
      if (ci < n.id) continue;
      const m = g.sidewalks.nodes[ci];
      for (const p of clutter) {
        const dx = m.x - n.x, dz = m.z - n.z, len2 = dx * dx + dz * dz;
        const t = Math.max(0, Math.min(1, ((p.x - n.x) * dx + (p.z - n.z) * dz) / len2));
        const d = Math.hypot(n.x + dx * t - p.x, n.z + dz * t - p.z);
        expect(d >= 1.2, `clutter (${p.kind}) keeps 1.2 m off the crossing ${n.id}-${ci}`);
      }
    }
  }

  const b2 = generateCity(1907).city;
  expect(JSON.stringify(b2.props.filter((p) => p.kind === 'pole' || p.kind === 'roadsign' || p.kind === 'dumpster' || p.kind === 'table')) === JSON.stringify(clutter), 'street clutter deterministic for the seed');
});

test('parked car shells: the LOD ladder is cheaper at every rung and keeps one silhouette', () => {
  // The static parked cars of the lots and kerbs are drawn at three fidelities (CityRendererProps' near / mid / coarse
  // bands, and the same three shells serve the moving vehicles past VEHICLE_RENDER.bodyFullDist). The band boundaries
  // are 8, 32 and 70 m of open street, so what must NOT change across them is the SILHOUETTE: roofline height, overall
  // width and length, and the fact that the wheels reach the ground. Only the detail inside it may drop out.
  //
  // The triangle ceilings are the budget guard. A walked dusk frame holds ~20 cars; the ladder is what keeps that
  // inside the 720 k hard cap (round 8 measured 766 k in one, with the full body drawn out to 75 m).
  const box = (g: { attributes: { position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } }; index: { count: number } | null }): { tris: number; w: number; h: number; l: number; floor: number } => {
    const p = g.attributes.position;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.count; i++) {
      x0 = Math.min(x0, p.getX(i)); x1 = Math.max(x1, p.getX(i));
      y0 = Math.min(y0, p.getY(i)); y1 = Math.max(y1, p.getY(i));
      z0 = Math.min(z0, p.getZ(i)); z1 = Math.max(z1, p.getZ(i));
    }
    return { tris: (g.index ? g.index.count : p.count) / 3, w: x1 - x0, h: y1, l: z1 - z0, floor: y0 };
  };
  for (const key of ['sedan', 'sport', 'van'] as const) {
    const near = box(parkedNearGeometry(SPECS[key]));
    const mid = box(parkedMidGeometry(SPECS[key]));
    const coarse = box(parkedShellGeometry(SPECS[key]));
    expect(near.tris > mid.tris && mid.tris > coarse.tris, `${key}: each rung is cheaper (${near.tris} > ${mid.tris} > ${coarse.tris})`);
    expect(mid.tris <= 1100, `${key}: mid shell within budget (${mid.tris})`);
    expect(coarse.tris <= 700, `${key}: coarse shell within budget (${coarse.tris})`);
    for (const [name, b] of [['mid', mid], ['coarse', coarse]] as const) {
      approx(b.h, near.h, 0.02, `${key}/${name}: same roofline height`);
      // 9 cm on width: the near shell alone carries the door mirrors, which stand ~4 cm proud of the flank each side.
      approx(b.w, near.w, 0.09, `${key}/${name}: same width`);
      // 12 cm on length, not 3: the near shell alone carries the exhaust tube and the rear bumper's rubbing strip,
      // which poke a few centimetres past the loft the three shells share. Everything else is the same loft.
      approx(b.l, near.l, 0.12, `${key}/${name}: same length`);
      // Every rung's wheels reach the floor within a facet: which angle a 10- or 12-sided lathe happens to sample at
      // the bottom of the tyre is worth up to r * (1 - cos(pi / seg)), i.e. ~1.8 cm, and nothing else may hang lower.
      expect(b.floor >= -1e-4 && b.floor < 0.03, `${key}/${name}: wheels reach the ground (floor ${b.floor.toFixed(3)})`);
    }
  }
});
