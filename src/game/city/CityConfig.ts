// City layout constants (grid, road widths, districts, landmark blocks) shared by generator/renderers. Track P0.
export const CITY_SEED = 1907;
export const GRID_COLS = 10; export const GRID_ROWS = 10;
export const BLOCK = 96; export const ROAD_W = 20; export const PITCH = BLOCK + ROAD_W; // 116
export const LANE_W = 3.5; export const LANES_PER_DIR = 2; export const SIDEWALK_W = 3; export const CURB_H = 0.15;
export const CITY_MIN_X = 0; export const CITY_MAX_X = GRID_COLS * PITCH + ROAD_W; // 1180
export const CITY_MIN_Z = 0; export const CITY_MAX_Z = GRID_ROWS * PITCH + ROAD_W; // 1180
export const BEACH_X0 = CITY_MAX_X; export const BEACH_W = 90; export const OCEAN_X0 = BEACH_X0 + BEACH_W; export const OCEAN_SIZE = 3000;
export const INTERSECTION_R = ROAD_W / 2 + 1; // 11 — lanes are trimmed by this from node centers
export const SPEED_LIMIT = 12; // m/s
export const LAMP_SPACING = 32; export const PALMS_PER_BLOCK_EDGE = 3;
export const DISTRICTS = { downtown: { col: [3, 6], row: [3, 6] }, beachfrontCols: 2 } as const;
export const LANDMARK_BLOCKS = { tower: [5, 5], arena: [1, 7], hospital: [2, 2], police: [7, 3], park: [4, 8] } as const; // [col,row]
export const PLAZA_BLOCKS: [number, number][] = [[6, 5], [2, 3], [7, 4]]; // mission start markers live on these blocks' sidewalks
