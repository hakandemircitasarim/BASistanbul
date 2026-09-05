// Road network graph: nodes/segments/lanes, successor links, precomputed bezier turns, A*, reservations, bucketed lookups. Track A.
import type { EntityId, Vec2 } from '../core/Types';
import type { Random } from '../core/Random';

export interface Occupant { id: EntityId; axis: 0 | 1; straight: boolean; since: number }
export interface RoadNode { id: number; x: number; z: number; col: number; row: number; segments: number[]; outLanes: number[]; inLanes: number[]; stopSign: boolean; occupants: Occupant[]; occupantCount: number }
export interface RoadSegment { id: number; a: number; b: number; axis: 0 | 1 /* 0 = along X, 1 = along Z */; length: number; lanes: number[] }
export interface Lane { id: number; segment: number; from: number; to: number; index: 0 | 1 /* 0 inner, 1 outer */; start: Vec2; end: Vec2; dir: Vec2; length: number; next: number[] /* successor lane ids */; nextKind: ('straight' | 'right' | 'left')[]; speedLimit: number; axis: 0 | 1 }
export interface LanePos { lane: number; t: number /* meters along lane from start */ }

export type TurnKind = 'straight' | 'right' | 'left';

const MAX_OCCUPANTS = 8;
const DEFAULT_SPEED_LIMIT = 12;
const MAX_NEXT = 4; // straight, right, left (+ U-turn at dead ends)
const TURN_SAMPLES = 8;
const scratchA: Vec2 = { x: 0, z: 0 };
const scratchB: Vec2 = { x: 0, z: 0 };

export class RoadGraph {
  readonly nodes: RoadNode[] = [];
  readonly segments: RoadSegment[] = [];
  readonly lanes: Lane[] = [];
  readonly cols: number;
  readonly rows: number;
  readonly pitch: number;
  readonly laneW: number;
  private readonly half: number; // node center offset from the grid origin (roadW / 2)
  private intersectionR = 0; // lane trim distance from node centers (U-turn loop depth)
  // Per successor slot (lane * MAX_NEXT + i): bezier control point and 8-sample polyline length.
  private turnCtrlX = new Float64Array(0);
  private turnCtrlZ = new Float64Array(0);
  private turnLen = new Float64Array(0);
  // A* scratch (allocated once per graph).
  private gScore = new Float64Array(0);
  private fScore = new Float64Array(0);
  private cameFrom = new Int32Array(0);
  private stampOpen = new Int32Array(0);
  private stampClosed = new Int32Array(0);
  private open = new Int32Array(0);
  private searchStamp = 0;

  private constructor(cols: number, rows: number, pitch: number, roadW: number, laneW: number) {
    this.cols = cols;
    this.rows = rows;
    this.pitch = pitch;
    this.laneW = laneW;
    this.half = roadW / 2;
  }

  static build(cols: number, rows: number, pitch: number, roadW: number, laneW: number, lanesPerDir: number, intersectionR: number, rng: Random): RoadGraph {
    const g = new RoadGraph(cols, rows, pitch, roadW, laneW);
    g.intersectionR = intersectionR;
    const half = roadW / 2;
    for (let row = 0; row <= rows; row++) {
      for (let col = 0; col <= cols; col++) {
        const interior = col > 0 && col < cols && row > 0 && row < rows;
        const occupants: Occupant[] = [];
        for (let i = 0; i < MAX_OCCUPANTS; i++) occupants.push({ id: -1, axis: 0, straight: true, since: 0 });
        g.nodes.push({ id: g.nodes.length, x: col * pitch + half, z: row * pitch + half, col, row, segments: [], outLanes: [], inLanes: [], stopSign: interior ? rng.chance(0.5) : false, occupants, occupantCount: 0 });
      }
    }
    // Segments: along X (axis 0, row-major) then along Z (axis 1, column-major). Ids are index-computable (see segX/segZ).
    for (let row = 0; row <= rows; row++) for (let col = 0; col < cols; col++) g.addSegment(g.nodeAt(col, row).id, g.nodeAt(col + 1, row).id, 0, pitch, laneW, lanesPerDir, intersectionR);
    for (let col = 0; col <= cols; col++) for (let row = 0; row < rows; row++) g.addSegment(g.nodeAt(col, row).id, g.nodeAt(col, row + 1).id, 1, pitch, laneW, lanesPerDir, intersectionR);
    g.linkSuccessors(lanesPerDir);
    g.precomputeTurns();
    const n = g.nodes.length;
    g.gScore = new Float64Array(n);
    g.fScore = new Float64Array(n);
    g.cameFrom = new Int32Array(n);
    g.stampOpen = new Int32Array(n);
    g.stampClosed = new Int32Array(n);
    g.open = new Int32Array(n);
    return g;
  }

  private addSegment(a: number, b: number, axis: 0 | 1, pitch: number, laneW: number, lanesPerDir: number, intersectionR: number): void {
    const seg: RoadSegment = { id: this.segments.length, a, b, axis, length: pitch, lanes: [] };
    this.segments.push(seg);
    this.nodes[a].segments.push(seg.id);
    this.nodes[b].segments.push(seg.id);
    for (let dirIdx = 0; dirIdx < 2; dirIdx++) {
      const from = dirIdx === 0 ? a : b;
      const to = dirIdx === 0 ? b : a;
      const na = this.nodes[from], nb = this.nodes[to];
      const dx = nb.x - na.x, dz = nb.z - na.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      const dirX = dx / len, dirZ = dz / len;
      const rightX = -dirZ, rightZ = dirX; // right2D
      for (let li = 0; li < lanesPerDir; li++) {
        const offset = (li + 0.5) * laneW;
        const lane: Lane = {
          id: this.lanes.length, segment: seg.id, from, to, index: li as 0 | 1,
          start: { x: na.x + dirX * intersectionR + rightX * offset, z: na.z + dirZ * intersectionR + rightZ * offset },
          end: { x: nb.x - dirX * intersectionR + rightX * offset, z: nb.z - dirZ * intersectionR + rightZ * offset },
          dir: { x: dirX, z: dirZ }, length: len - 2 * intersectionR, next: [], nextKind: [], speedLimit: DEFAULT_SPEED_LIMIT, axis,
        };
        this.lanes.push(lane);
        seg.lanes.push(lane.id);
        na.outLanes.push(lane.id);
        nb.inLanes.push(lane.id);
      }
    }
  }

  /** Lane of `segId` leaving `fromNode` with the given index, or -1. */
  private laneLeaving(segId: number, fromNode: number, index: number): number {
    const ls = this.segments[segId].lanes;
    for (let i = 0; i < ls.length; i++) {
      const l = this.lanes[ls[i]];
      if (l.from === fromNode && l.index === index) return l.id;
    }
    return -1;
  }

  /** Segment leaving `node` in grid direction (dc, dr), or -1. */
  private segmentToward(node: RoadNode, dc: number, dr: number): number {
    const c = node.col + dc, r = node.row + dr;
    if (c < 0 || c > this.cols || r < 0 || r > this.rows) return -1;
    const other = this.nodeAt(c, r).id;
    for (let i = 0; i < node.segments.length; i++) {
      const s = this.segments[node.segments[i]];
      if (s.a === other || s.b === other) return s.id;
    }
    return -1;
  }

  /** Straight = same index on the continuing segment, right = outer lane, left = inner lane; U-turn only at dead ends. */
  private linkSuccessors(lanesPerDir: number): void {
    const outer = lanesPerDir - 1;
    for (let i = 0; i < this.lanes.length; i++) {
      const l = this.lanes[i];
      const to = this.nodes[l.to];
      const dx = Math.round(l.dir.x), dz = Math.round(l.dir.z);
      const rx = -dz, rz = dx; // right2D(dir)
      const straight = this.segmentToward(to, dx, dz);
      const right = this.segmentToward(to, rx, rz);
      const left = this.segmentToward(to, -rx, -rz);
      if (straight >= 0) { l.next.push(this.laneLeaving(straight, to.id, l.index)); l.nextKind.push('straight'); }
      if (right >= 0) { l.next.push(this.laneLeaving(right, to.id, outer)); l.nextKind.push('right'); }
      if (left >= 0) { l.next.push(this.laneLeaving(left, to.id, 0)); l.nextKind.push('left'); }
      if (l.next.length <= 1) {
        // Dead end (corner / stub road): allow a U-turn onto the opposite lane of the same segment.
        const back = this.laneLeaving(l.segment, to.id, l.index);
        if (back >= 0) { l.next.push(back); l.nextKind.push('left'); }
      }
    }
  }

  /**
   * Control point = intersection of the two lane lines. Parallel lanes (straight continuation) use the midpoint;
   * antiparallel lanes (U-turn) push the control point forward into the intersection so the bezier is a loop
   * (apex 0.75 * intersectionR ahead of the lane end) instead of a line across the road. Returns via `out`.
   */
  private computeCtrl(a: Lane, b: Lane, out: Vec2): Vec2 {
    const p0x = a.end.x, p0z = a.end.z, p2x = b.start.x, p2z = b.start.z;
    const cross = a.dir.x * b.dir.z - a.dir.z * b.dir.x;
    if (Math.abs(cross) < 1e-6) {
      const dot = a.dir.x * b.dir.x + a.dir.z * b.dir.z;
      const push = dot < 0 ? 1.5 * this.intersectionR : 0;
      out.x = (p0x + p2x) * 0.5 + a.dir.x * push;
      out.z = (p0z + p2z) * 0.5 + a.dir.z * push;
    } else {
      const wx = p2x - p0x, wz = p2z - p0z;
      const u = (wx * b.dir.z - wz * b.dir.x) / cross;
      out.x = p0x + a.dir.x * u;
      out.z = p0z + a.dir.z * u;
    }
    return out;
  }

  private precomputeTurns(): void {
    const n = this.lanes.length * MAX_NEXT;
    this.turnCtrlX = new Float64Array(n);
    this.turnCtrlZ = new Float64Array(n);
    this.turnLen = new Float64Array(n);
    for (let i = 0; i < this.lanes.length; i++) {
      const a = this.lanes[i];
      for (let k = 0; k < a.next.length; k++) {
        const b = this.lanes[a.next[k]];
        this.computeCtrl(a, b, scratchA);
        const slot = i * MAX_NEXT + k;
        this.turnCtrlX[slot] = scratchA.x;
        this.turnCtrlZ[slot] = scratchA.z;
        this.turnLen[slot] = this.polylineLength(a, b, scratchA.x, scratchA.z);
      }
    }
  }

  private polylineLength(a: Lane, b: Lane, cx: number, cz: number): number {
    let len = 0;
    let px = a.end.x, pz = a.end.z;
    for (let i = 1; i <= TURN_SAMPLES; i++) {
      const s = i / TURN_SAMPLES, m = 1 - s;
      const x = m * m * a.end.x + 2 * m * s * cx + s * s * b.start.x;
      const z = m * m * a.end.z + 2 * m * s * cz + s * s * b.start.z;
      len += Math.sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
      px = x; pz = z;
    }
    return len;
  }

  private successorSlot(fromLane: number, toLane: number): number {
    const nx = this.lanes[fromLane].next;
    for (let k = 0; k < nx.length; k++) if (nx[k] === toLane) return fromLane * MAX_NEXT + k;
    return -1;
  }

  // ---- index helpers ----

  nodeAt(col: number, row: number): RoadNode {
    return this.nodes[row * (this.cols + 1) + col];
  }

  /** Id of the axis-0 segment between (col,row) and (col+1,row). */
  segX(col: number, row: number): number { return row * this.cols + col; }
  /** Id of the axis-1 segment between (col,row) and (col,row+1). */
  segZ(col: number, row: number): number { return (this.rows + 1) * this.cols + col * this.rows + row; }

  nearestNode(x: number, z: number): RoadNode {
    let col = Math.round((x - this.half) / this.pitch);
    let row = Math.round((z - this.half) / this.pitch);
    if (col < 0) col = 0; else if (col > this.cols) col = this.cols;
    if (row < 0) row = 0; else if (row > this.rows) row = this.rows;
    return this.nodeAt(col, row);
  }

  /** Bucketed: only the lanes of the (<= 4) segments touching the nearest node are scanned. */
  nearestLane(x: number, z: number, out: LanePos): LanePos {
    const node = this.nearestNode(x, z);
    let best = Infinity;
    out.lane = node.outLanes.length > 0 ? node.outLanes[0] : 0;
    out.t = 0;
    for (let s = 0; s < node.segments.length; s++) {
      const ls = this.segments[node.segments[s]].lanes;
      for (let i = 0; i < ls.length; i++) {
        const l = this.lanes[ls[i]];
        let t = (x - l.start.x) * l.dir.x + (z - l.start.z) * l.dir.z;
        if (t < 0) t = 0; else if (t > l.length) t = l.length;
        const px = l.start.x + l.dir.x * t, pz = l.start.z + l.dir.z * t;
        const d = (px - x) * (px - x) + (pz - z) * (pz - z);
        if (d < best) { best = d; out.lane = l.id; out.t = t; }
      }
    }
    return out;
  }

  pointOnLane(laneId: number, t: number, out: Vec2): Vec2 {
    const l = this.lanes[laneId];
    out.x = l.start.x + l.dir.x * t;
    out.z = l.start.z + l.dir.z * t;
    return out;
  }

  laneDir(laneId: number): Vec2 {
    return this.lanes[laneId].dir;
  }

  /** Quadratic bezier from.end -> ctrl -> to.start (ctrl precomputed for successors, derived otherwise). */
  turnPoint(fromLane: number, toLane: number, s: number, out: Vec2): Vec2 {
    const a = this.lanes[fromLane], b = this.lanes[toLane];
    const slot = this.successorSlot(fromLane, toLane);
    let cx: number, cz: number;
    if (slot >= 0) {
      cx = this.turnCtrlX[slot];
      cz = this.turnCtrlZ[slot];
    } else {
      this.computeCtrl(a, b, scratchB);
      cx = scratchB.x;
      cz = scratchB.z;
    }
    const m = 1 - s;
    out.x = m * m * a.end.x + 2 * m * s * cx + s * s * b.start.x;
    out.z = m * m * a.end.z + 2 * m * s * cz + s * s * b.start.z;
    return out;
  }

  /** Precomputed 8-sample polyline length of the turn bezier. */
  turnLength(fromLane: number, toLane: number): number {
    const slot = this.successorSlot(fromLane, toLane);
    if (slot >= 0) return this.turnLen[slot];
    const a = this.lanes[fromLane], b = this.lanes[toLane];
    this.computeCtrl(a, b, scratchB);
    return this.polylineLength(a, b, scratchB.x, scratchB.z);
  }

  /** Kind of the turn from one lane onto a successor ('straight' when not linked). */
  turnKind(fromLane: number, toLane: number): TurnKind {
    const l = this.lanes[fromLane];
    for (let k = 0; k < l.next.length; k++) if (l.next[k] === toLane) return l.nextKind[k];
    return 'straight';
  }

  // ---- pathing ----

  /** A* over nodes (Manhattan heuristic). Returns the count; out[0..count) holds node ids including both ends. */
  findPath(fromNode: number, toNode: number, out: number[]): number {
    const nodes = this.nodes;
    if (fromNode === toNode) { out[0] = fromNode; return 1; }
    const stamp = ++this.searchStamp;
    const g = this.gScore, f = this.fScore, came = this.cameFrom, so = this.stampOpen, sc = this.stampClosed, open = this.open;
    const target = nodes[toNode];
    let openCount = 0;
    g[fromNode] = 0;
    f[fromNode] = Math.abs(nodes[fromNode].x - target.x) + Math.abs(nodes[fromNode].z - target.z);
    came[fromNode] = -1;
    so[fromNode] = stamp;
    open[openCount++] = fromNode;
    let found = false;
    while (openCount > 0) {
      // Pop the lowest f (linear scan; the grid is tiny).
      let bi = 0;
      for (let i = 1; i < openCount; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const cur = open[bi];
      open[bi] = open[--openCount];
      if (cur === toNode) { found = true; break; }
      sc[cur] = stamp;
      const n = nodes[cur];
      for (let s = 0; s < n.segments.length; s++) {
        const seg = this.segments[n.segments[s]];
        const other = seg.a === cur ? seg.b : seg.a;
        if (sc[other] === stamp) continue;
        const tentative = g[cur] + seg.length;
        if (so[other] === stamp && tentative >= g[other]) continue;
        came[other] = cur;
        g[other] = tentative;
        const on = nodes[other];
        f[other] = tentative + Math.abs(on.x - target.x) + Math.abs(on.z - target.z);
        if (so[other] !== stamp) { so[other] = stamp; open[openCount++] = other; }
      }
    }
    if (!found) return 0;
    let count = 0;
    for (let n = toNode; n !== -1; n = came[n]) out[count++] = n;
    for (let i = 0, j = count - 1; i < j; i++, j--) { const t = out[i]; out[i] = out[j]; out[j] = t; }
    return count;
  }

  /**
   * Successor lanes (excluding currentLane) leading along nodePath from currentLane.to; returns the count written to out.
   * When the path does not pass through currentLane.to (typically: it starts at the node behind the vehicle), the chain
   * rejoins the path through one or two successor lanes when possible; 0 means no lane chain reaches the path.
   */
  lanePathFromNodePath(currentLane: number, nodePath: number[], nodeCount: number, out: number[]): number {
    let lane = this.lanes[currentLane];
    let k = this.pathIndexOf(nodePath, nodeCount, lane.to);
    let count = 0;
    if (k < 0) {
      // One successor level: a successor whose end node is on the path.
      for (let s = 0; s < lane.next.length && k < 0; s++) {
        const cand = this.lanes[lane.next[s]];
        const idx = this.pathIndexOf(nodePath, nodeCount, cand.to);
        if (idx >= 0) { k = idx; out[count++] = cand.id; lane = cand; }
      }
    }
    if (k < 0) {
      // Two levels: successor of a successor (the path started behind us and turned away).
      for (let s = 0; s < lane.next.length && k < 0; s++) {
        const mid = this.lanes[lane.next[s]];
        for (let q = 0; q < mid.next.length && k < 0; q++) {
          const cand = this.lanes[mid.next[q]];
          if (cand.id === currentLane) continue;
          const idx = this.pathIndexOf(nodePath, nodeCount, cand.to);
          if (idx >= 0) { k = idx; out[count++] = mid.id; out[count++] = cand.id; lane = cand; }
        }
      }
      if (k < 0) return 0;
    }
    for (let i = k; i < nodeCount - 1; i++) {
      const wanted = nodePath[i + 1];
      let pick = -1;
      for (let s = 0; s < lane.next.length; s++) {
        const cand = this.lanes[lane.next[s]];
        if (cand.to === wanted) { pick = cand.id; if (lane.nextKind[s] === 'straight') break; }
      }
      if (pick < 0) break;
      out[count++] = pick;
      lane = this.lanes[pick];
    }
    return count;
  }

  private pathIndexOf(nodePath: number[], nodeCount: number, nodeId: number): number {
    for (let i = 0; i < nodeCount; i++) if (nodePath[i] === nodeId) return i;
    return -1;
  }

  // ---- intersection reservations ----

  /** Already an occupant, or an empty node, or straight traffic on the same axis as every occupant. */
  canEnter(nodeId: number, id: EntityId, axis: 0 | 1, straight: boolean): boolean {
    const n = this.nodes[nodeId];
    for (let i = 0; i < n.occupantCount; i++) if (n.occupants[i].id === id) return true;
    for (let i = 0; i < n.occupantCount; i++) {
      const o = n.occupants[i];
      if (!straight || !o.straight || o.axis !== axis) return false;
    }
    return true;
  }

  reserve(nodeId: number, id: EntityId, axis: 0 | 1, straight: boolean, now: number): boolean {
    if (!this.canEnter(nodeId, id, axis, straight)) return false;
    const n = this.nodes[nodeId];
    for (let i = 0; i < n.occupantCount; i++) if (n.occupants[i].id === id) return true;
    if (n.occupantCount >= MAX_OCCUPANTS) return false;
    const o = n.occupants[n.occupantCount++];
    o.id = id; o.axis = axis; o.straight = straight; o.since = now;
    return true;
  }

  release(nodeId: number, id: EntityId): void {
    const n = this.nodes[nodeId];
    for (let i = 0; i < n.occupantCount; i++) {
      if (n.occupants[i].id !== id) continue;
      const last = n.occupants[n.occupantCount - 1];
      n.occupants[n.occupantCount - 1] = n.occupants[i];
      n.occupants[i] = last;
      n.occupantCount--;
      return;
    }
  }

  releaseAll(id: EntityId): void {
    for (let i = 0; i < this.nodes.length; i++) if (this.nodes[i].occupantCount > 0) this.release(i, id);
  }

  expireReservations(now: number, timeout: number): void {
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      for (let j = n.occupantCount - 1; j >= 0; j--) if (now - n.occupants[j].since > timeout) this.release(i, n.occupants[j].id);
    }
  }

  // ---- random / ring queries ----

  randomLanePos(rng: Random, out: LanePos): LanePos {
    out.lane = rng.int(0, this.lanes.length - 1);
    out.t = rng.range(0, this.lanes[out.lane].length);
    return out;
  }

  /** Lanes whose midpoint lies in the ring; only segments in the ring's grid range are visited. */
  lanesInRing(cx: number, cz: number, rMin: number, rMax: number, out: number[]): number {
    let n = 0;
    const r0 = rMin * rMin, r1 = rMax * rMax;
    let c0 = Math.floor((cx - rMax - this.half) / this.pitch) - 1, c1 = Math.ceil((cx + rMax - this.half) / this.pitch) + 1;
    let q0 = Math.floor((cz - rMax - this.half) / this.pitch) - 1, q1 = Math.ceil((cz + rMax - this.half) / this.pitch) + 1;
    if (c0 < 0) c0 = 0; if (c1 > this.cols) c1 = this.cols;
    if (q0 < 0) q0 = 0; if (q1 > this.rows) q1 = this.rows;
    for (let c = c0; c <= c1; c++) {
      for (let r = q0; r <= q1; r++) {
        if (c < this.cols) n = this.ringSegment(this.segX(c, r), cx, cz, r0, r1, out, n);
        if (r < this.rows) n = this.ringSegment(this.segZ(c, r), cx, cz, r0, r1, out, n);
      }
    }
    return n;
  }

  private ringSegment(segId: number, cx: number, cz: number, r0: number, r1: number, out: number[], n: number): number {
    const ls = this.segments[segId].lanes;
    for (let i = 0; i < ls.length; i++) {
      const l = this.lanes[ls[i]];
      const mx = (l.start.x + l.end.x) * 0.5 - cx, mz = (l.start.z + l.end.z) * 0.5 - cz;
      const d = mx * mx + mz * mz;
      if (d >= r0 && d <= r1) out[n++] = l.id;
    }
    return n;
  }
}
