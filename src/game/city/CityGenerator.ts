// Procedural city generation entry point: graphs, lots/buildings, landmarks, props, parked spots, points; plus validateCity. Track A.
import { Random } from '../core/Random';
import { BEACH_X0, CITY_MAX_Z, CITY_MIN_X, CITY_MIN_Z, CITY_SEED, GRID_COLS, GRID_ROWS, INTERSECTION_R, LANES_PER_DIR, LANE_W, OCEAN_X0, PITCH, ROAD_W, SIDEWALK_W } from './CityConfig';
import type { CityData } from './CityData';
import { RoadGraph } from './RoadGraph';
import { SidewalkGraph } from './SidewalkGraph';
import { blockIndex, createContext, makeBlocks } from './CityBuild';
import { buildLots } from './CityLots';
import { PROMENADE_X, SPAWN_BLOCK, addLandmarks, addPromenadePalms, addStreetProps, addWaterAndBounds, furnishPark, furnishPlazas, makePoints, placeParkedSpots } from './CityProps';
export { validateCity } from './CityValidate';
export { districtOf, blockKind } from './CityBuild';

export interface GeneratedCity { city: CityData; roads: RoadGraph; sidewalks: SidewalkGraph }

/** Extra world extent east of the ocean line covered by the pier + ferris wheel. */
const BOUNDS_EAST_PAD = 140;

export function generateCity(seed: number = CITY_SEED): GeneratedCity {
  const rng = new Random(seed);
  const blocks = makeBlocks(GRID_ROWS);
  const roads = RoadGraph.build(GRID_COLS, GRID_ROWS, PITCH, ROAD_W, LANE_W, LANES_PER_DIR, INTERSECTION_R, rng.fork());
  const sidewalks = SidewalkGraph.build(blocks, ROAD_W, SIDEWALK_W, { x: PROMENADE_X, z0: 20, z1: CITY_MAX_Z - 20 });
  const ctx = createContext(rng.fork(), roads, sidewalks, blocks);
  const spawnBlock = blockIndex(SPAWN_BLOCK[0], SPAWN_BLOCK[1]);
  const spawnNode = sidewalks.nodes[sidewalks.loops[spawnBlock][4]];
  buildLots(ctx, spawnNode.x, spawnNode.z, spawnBlock);
  addLandmarks(ctx);
  addWaterAndBounds(ctx);
  furnishPlazas(ctx);
  furnishPark(ctx);
  addStreetProps(ctx);
  addPromenadePalms(ctx);
  const points = makePoints(ctx);
  placeParkedSpots(ctx, points.playerSpawn);
  const city: CityData = {
    seed,
    buildings: ctx.buildings,
    blocks,
    props: ctx.props,
    landmarks: ctx.landmarks,
    parkedSpots: ctx.parkedSpots,
    staticColliders: ctx.colliders,
    neonSigns: ctx.neonSigns,
    bounds: { minX: CITY_MIN_X, minZ: CITY_MIN_Z, maxX: OCEAN_X0 + BOUNDS_EAST_PAD, maxZ: CITY_MAX_Z },
    points,
  };
  void BEACH_X0;
  return { city, roads, sidewalks };
}
