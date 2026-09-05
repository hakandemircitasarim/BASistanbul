// Entity count budgets shared by spawners and renderers (instance capacities). Track P0.
export const BUDGET = {
  MAX_VEHICLES: 128, MAX_PEDS: 96,
  PARKED: 40, TRAFFIC_TARGET: 28, POLICE_MAX: 10, MISSION: 2, ABANDONED: 8,
  PED_TARGET: 40,
} as const; // 40+28+10+2+8 = 88 < 128. Spawners assert world.vehicleList.length < MAX_VEHICLES before spawning.
