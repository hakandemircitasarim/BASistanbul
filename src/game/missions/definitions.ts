// Mission definitions (three Build-1 missions) and position resolution from city.points / parked spots — nothing hard-coded. Track F.
import type { CityData } from '../city/CityData';
import type { RoadGraph } from '../city/RoadGraph';
import type { LanePos } from '../city/RoadGraph';
import type { VehicleKey } from '../entities/VehicleSpecs';

export type MissionStepKind = 'goto' | 'enterVehicle' | 'deliverVehicle' | 'loseWanted' | 'wait';
/** Named points of CityData.points a step may be anchored to. */
export type PointKey = 'playerSpawn' | 'hospital' | 'policeStation' | 'pier' | 'garage' | 'beachDelivery';

export interface MissionStep {
  kind: MissionStepKind;
  objective: string;
  /** Anchor resolved into x/z by resolveMissionPositions (goto / deliverVehicle). */
  point?: PointKey;
  x: number;
  z: number;
  radius: number;
  /** goto: must the player be on foot (default: on foot or in a car). */
  onFoot?: boolean;
  /** deliverVehicle: minimum vehicle health, otherwise the mission fails with failText. */
  minHealth?: number;
  failText?: string;
  /** wait: seconds. */
  duration?: number;
}

export interface MissionVehicleSpawn { key: VehicleKey; color: number; /** search radius around the start for a curb spot */ nearStart: number; x: number; z: number; yaw: number }

export interface MissionDef {
  id: string;
  title: string;
  description: string;
  reward: number;
  timeLimit?: number;
  timeBonus?: { under: number; bonus: number };
  setWanted?: number;
  spawnVehicle?: MissionVehicleSpawn;
  steps: MissionStep[];
  cooldown: number;
  /** Start marker (missionStarts[i]); filled by resolveMissionPositions. */
  startX: number;
  startZ: number;
  startYaw: number;
}

export const MISSION_COOLDOWN = 30;
export const ORANGE = 0xff7a00;
export const LOSE_WANTED_OBJECTIVE = 'Polisten kaç! Yıldızlar sıfırlanana kadar hayatta kal';
export const FAIL_DAMAGED = 'Araç çok hasarlı';
export const FAIL_DESTROYED = 'Araç yok edildi';
export const FAIL_TIME = 'Süre doldu';
export const FAIL_WASTED = 'Harcandın';
export const FAIL_BUSTED = 'Yakalandın';

/** Fresh (unresolved) copies of the three missions; call resolveMissionPositions before use. */
export function createMissionDefs(): MissionDef[] {
  return [
    {
      id: 'sahil', title: 'Sahil Yürüyüşü', description: 'İskeleye git.', reward: 500, cooldown: MISSION_COOLDOWN,
      startX: 0, startZ: 0, startYaw: 0,
      steps: [{ kind: 'goto', objective: 'İskeleye git', point: 'pier', x: 0, z: 0, radius: 3 }],
    },
    {
      id: 'kurye', title: 'Turuncu Kurye', description: 'Turuncu spor arabayı garaja götür.', reward: 1500, cooldown: MISSION_COOLDOWN,
      timeBonus: { under: 90, bonus: 500 },
      spawnVehicle: { key: 'sport', color: ORANGE, nearStart: 40, x: 0, z: 0, yaw: 0 },
      startX: 0, startZ: 0, startYaw: 0,
      steps: [
        { kind: 'enterVehicle', objective: 'Turuncu spor arabaya bin', x: 0, z: 0, radius: 0 },
        { kind: 'deliverVehicle', objective: 'Arabayı garaja götür', point: 'garage', x: 0, z: 0, radius: 5, minHealth: 30, failText: FAIL_DAMAGED },
      ],
    },
    {
      id: 'takip', title: 'Sıcak Takip', description: 'Polisten kaç.', reward: 3000, cooldown: MISSION_COOLDOWN,
      setWanted: 3,
      startX: 0, startZ: 0, startYaw: 0,
      steps: [{ kind: 'loseWanted', objective: LOSE_WANTED_OBJECTIVE, x: 0, z: 0, radius: 0 }],
    },
  ];
}

const lanePos: LanePos = { lane: 0, t: 0 };

/**
 * Fills every coordinate from the generated city: start markers = points.missionStarts[i], step anchors = points[key],
 * mission vehicles = the nearest parked spot within nearStart of the start (fallback: the nearest lane point).
 */
export function resolveMissionPositions(defs: MissionDef[], city: CityData, roads: RoadGraph): MissionDef[] {
  const starts = city.points.missionStarts;
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const s = starts.length > 0 ? starts[i % starts.length] : city.points.playerSpawn;
    d.startX = s.x; d.startZ = s.z; d.startYaw = s.yaw;
    for (let k = 0; k < d.steps.length; k++) {
      const st = d.steps[k];
      if (st.point) { const p = city.points[st.point]; st.x = p.x; st.z = p.z; }
    }
    const sv = d.spawnVehicle;
    if (sv) {
      let best = -1, bestD2 = sv.nearStart * sv.nearStart;
      const spots = city.parkedSpots;
      for (let k = 0; k < spots.length; k++) {
        const dx = spots[k].x - s.x, dz = spots[k].z - s.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = k; }
      }
      if (best >= 0) { sv.x = spots[best].x; sv.z = spots[best].z; sv.yaw = spots[best].yaw; }
      else {
        roads.nearestLane(s.x, s.z, lanePos);
        const lane = roads.lanes[lanePos.lane];
        const t = Math.min(Math.max(lanePos.t, 8), Math.max(8, lane.length - 8));
        sv.x = lane.start.x + lane.dir.x * t; sv.z = lane.start.z + lane.dir.z * t;
        sv.yaw = Math.atan2(lane.dir.x, lane.dir.z);
      }
    }
  }
  return defs;
}

/** tr-TR grouping without decimals: 1500 -> "$1.500". */
export function formatMoney(n: number): string {
  const s = Math.round(Math.abs(n)).toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '.';
    out += s[i];
  }
  return (n < 0 ? '-$' : '$') + out;
}
