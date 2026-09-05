// City invariant checks (graph counts/links, buildings, walk graph, points, parked spots, props, colliders vs roads). Track A.
import { BUDGET } from '../core/Budget';
import { BLOCK, GRID_COLS, GRID_ROWS, INTERSECTION_R, LANE_W, PLAZA_BLOCKS } from './CityConfig';
import type { GeneratedCity } from './CityGenerator';
import { colliderDistance, distToNearestRoadNode, onRoad } from './CityBuild';
import type { CityData } from './CityData';

const POINT_CLEARANCE = 0.6;
const SUCCESSOR_MAX_DIST = 25;
const SPOT_NODE_DIST = 18;
const SPOT_SPACING = 9;

function minClearance(city: CityData, x: number, z: number): number {
  let best = Infinity;
  const cs = city.staticColliders;
  for (let i = 0; i < cs.length; i++) {
    const d = colliderDistance(cs[i], x, z);
    if (d < best) best = d;
  }
  return best;
}

/** Returns human-readable invariant violations (empty = OK). */
export function validateCity(g: GeneratedCity): string[] {
  const out: string[] = [];
  const { city, roads, sidewalks } = g;
  const expectNodes = (GRID_COLS + 1) * (GRID_ROWS + 1), expectSegs = 2 * GRID_COLS * GRID_ROWS + GRID_COLS + GRID_ROWS;
  if (roads.nodes.length !== expectNodes) out.push(`road nodes ${roads.nodes.length} != ${expectNodes}`);
  if (roads.segments.length !== expectSegs) out.push(`road segments ${roads.segments.length} != ${expectSegs}`);
  if (roads.lanes.length !== expectSegs * 4) out.push(`lanes ${roads.lanes.length} != ${expectSegs * 4}`);
  for (let i = 0; i < roads.lanes.length; i++) {
    const l = roads.lanes[i];
    if (l.next.length < 1) { out.push(`lane ${i} has no successor`); continue; }
    if (l.next.length !== l.nextKind.length) out.push(`lane ${i} next/nextKind length mismatch`);
    for (let k = 0; k < l.next.length; k++) {
      const n = roads.lanes[l.next[k]];
      if (!n) { out.push(`lane ${i} successor ${l.next[k]} missing`); continue; }
      if (n.from !== l.to) out.push(`lane ${i} successor ${n.id} does not start at node ${l.to}`);
      const d = Math.sqrt((n.start.x - l.end.x) ** 2 + (n.start.z - l.end.z) ** 2);
      if (d > SUCCESSOR_MAX_DIST) out.push(`lane ${i} successor ${n.id} starts ${d.toFixed(1)} m away`);
    }
    if (Math.abs(l.length - (roads.pitch - 2 * INTERSECTION_R)) > 1e-6) out.push(`lane ${i} not trimmed by INTERSECTION_R`);
  }
  // Buildings: count, inside their block with the 2 m inset, disjoint, collider present.
  const bl = city.buildings;
  if (bl.length < 300 || bl.length > 400) out.push(`building count ${bl.length} outside 300-400`);
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i];
    const blk = city.blocks[blockOf(city, b.id)];
    if (!blk) { out.push(`building ${b.id} not listed in any block`); continue; }
    if (b.x - b.w / 2 < blk.x0 + 2 - 1e-6 || b.x + b.w / 2 > blk.x1 - 2 + 1e-6 || b.z - b.d / 2 < blk.z0 + 2 - 1e-6 || b.z + b.d / 2 > blk.z1 - 2 + 1e-6) out.push(`building ${b.id} violates the block inset`);
    if (!(b.h > 0) || !(b.w > 0) || !(b.d > 0)) out.push(`building ${b.id} has a non-positive size`);
    for (let j = i + 1; j < bl.length; j++) {
      const c = bl[j];
      if (Math.abs(b.x - c.x) < (b.w + c.w) / 2 && Math.abs(b.z - c.z) < (b.d + c.d) / 2) out.push(`buildings ${b.id} and ${c.id} overlap`);
    }
  }
  let buildingColliders = 0;
  for (let i = 0; i < city.staticColliders.length; i++) if (city.staticColliders[i].tag === 'building') buildingColliders++;
  if (buildingColliders !== bl.length) out.push(`building colliders ${buildingColliders} != buildings ${bl.length}`);
  // Walk graph.
  const wn = sidewalks.nodes;
  for (let i = 0; i < wn.length; i++) {
    const n = wn[i];
    if (n.id !== i) out.push(`walk node ${i} has id ${n.id}`);
    const nx = wn[n.loopNext], pv = wn[n.loopPrev];
    if (!nx || nx.loopPrev !== i) out.push(`walk node ${i} loopNext link broken`);
    if (!pv || pv.loopNext !== i) out.push(`walk node ${i} loopPrev link broken`);
    if (n.corner && n.crossings.length < 1) out.push(`corner walk node ${i} has no crossing`);
    for (let k = 0; k < n.crossings.length; k++) {
      const c = wn[n.crossings[k]];
      if (!c || c.crossings.indexOf(i) < 0) out.push(`walk node ${i} crossing ${n.crossings[k]} not symmetric`);
    }
  }
  if (sidewalks.loops.length !== city.blocks.length + 1) out.push(`walk loops ${sidewalks.loops.length} != blocks + promenade`);
  for (let i = 0; i < city.blocks.length; i++) if (sidewalks.loops[i].length !== 12) out.push(`block ${i} loop has ${sidewalks.loops[i].length} nodes`);
  // Points.
  const p = city.points;
  checkPoint(out, city, roads, 'playerSpawn', p.playerSpawn.x, p.playerSpawn.z);
  checkPoint(out, city, roads, 'hospital', p.hospital.x, p.hospital.z);
  checkPoint(out, city, roads, 'policeStation', p.policeStation.x, p.policeStation.z);
  checkPoint(out, city, roads, 'pier', p.pier.x, p.pier.z);
  checkPoint(out, city, roads, 'garage', p.garage.x, p.garage.z);
  checkPoint(out, city, roads, 'beachDelivery', p.beachDelivery.x, p.beachDelivery.z);
  if (p.missionStarts.length !== PLAZA_BLOCKS.length) out.push(`missionStarts ${p.missionStarts.length} != plazas ${PLAZA_BLOCKS.length}`);
  for (let i = 0; i < p.missionStarts.length; i++) checkPoint(out, city, roads, `missionStarts[${i}]`, p.missionStarts[i].x, p.missionStarts[i].z);
  // Parked spots.
  const ps = city.parkedSpots;
  if (ps.length !== BUDGET.PARKED) out.push(`parked spots ${ps.length} != BUDGET.PARKED ${BUDGET.PARKED}`);
  let nearSpawn = 0;
  for (let i = 0; i < ps.length; i++) {
    const s = ps[i];
    checkPoint(out, city, roads, `parkedSpot[${i}]`, s.x, s.z);
    if (distToNearestRoadNode(roads, s.x, s.z) < SPOT_NODE_DIST) out.push(`parkedSpot[${i}] within ${SPOT_NODE_DIST} m of a road node`);
    for (let j = i + 1; j < ps.length; j++) {
      const t = ps[j];
      if ((s.x - t.x) ** 2 + (s.z - t.z) ** 2 < SPOT_SPACING * SPOT_SPACING) out.push(`parkedSpots ${i} and ${j} closer than ${SPOT_SPACING} m`);
    }
    if ((s.x - p.playerSpawn.x) ** 2 + (s.z - p.playerSpawn.z) ** 2 <= 40 * 40) nearSpawn++;
    if (!isFinite(s.yaw)) out.push(`parkedSpot[${i}] has a non-finite yaw`);
  }
  if (nearSpawn < 3) out.push(`only ${nearSpawn} parked spots within 40 m of playerSpawn`);
  // Props: never on a lane / intersection, never inside a building.
  for (let i = 0; i < city.props.length; i++) {
    const pr = city.props[i];
    if (onRoad(roads, pr.x, pr.z, LANE_W / 2)) out.push(`prop ${i} (${pr.kind}) is on a lane`);
  }
  // Colliders (except water/boundary) never intrude on lanes or intersections.
  for (let i = 0; i < city.staticColliders.length; i++) {
    const c = city.staticColliders[i];
    if (c.tag === 'water' || c.tag === 'boundary') continue;
    const s = c.shape;
    if (s.kind === 'circle') {
      if (onRoad(roads, s.cx, s.cz, LANE_W / 2 + s.r)) out.push(`collider ${i} (${c.tag}) overlaps a lane`);
    } else {
      const bad = onRoad(roads, s.minX, s.minZ, LANE_W / 2) || onRoad(roads, s.maxX, s.minZ, LANE_W / 2) || onRoad(roads, s.minX, s.maxZ, LANE_W / 2) || onRoad(roads, s.maxX, s.maxZ, LANE_W / 2) || onRoad(roads, (s.minX + s.maxX) / 2, (s.minZ + s.maxZ) / 2, LANE_W / 2);
      if (bad) out.push(`collider ${i} (${c.tag}) overlaps a lane`);
    }
  }
  // Landmarks.
  const kinds = ['tower', 'arena', 'hospital', 'police', 'lighthouse', 'pier', 'ferris'];
  for (let i = 0; i < kinds.length; i++) {
    let found = false;
    for (let k = 0; k < city.landmarks.length; k++) if (city.landmarks[k].kind === kinds[i]) found = true;
    if (!found) out.push(`landmark ${kinds[i]} missing`);
  }
  for (let i = 0; i < city.blocks.length; i++) {
    const b = city.blocks[i];
    if (b.x1 - b.x0 !== BLOCK || b.z1 - b.z0 !== BLOCK) out.push(`block ${i} size mismatch`);
    if (b.kind === 'buildings' && b.buildings.length === 0) out.push(`block ${i} has no buildings`);
  }
  return out;
}

function blockOf(city: CityData, buildingId: number): number {
  for (let i = 0; i < city.blocks.length; i++) if (city.blocks[i].buildings.indexOf(buildingId) >= 0) return i;
  return -1;
}

function checkPoint(out: string[], city: CityData, roads: GeneratedCity['roads'], name: string, x: number, z: number): void {
  const c = minClearance(city, x, z);
  if (c < POINT_CLEARANCE) out.push(`${name} is ${c.toFixed(2)} m from a collider (< ${POINT_CLEARANCE})`);
  if (onRoad(roads, x, z, LANE_W / 2)) out.push(`${name} lies on a lane`);
  if (!isFinite(x) || !isFinite(z)) out.push(`${name} is not finite`);
}
