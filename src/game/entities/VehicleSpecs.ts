// Static per-model vehicle tuning table (dimensions, engine, steering, grip, colors). Track P0.
export type VehicleKey = 'sedan' | 'sport' | 'van' | 'police' | 'taxi';
export interface VehicleSpec {
  key: VehicleKey; name: string; length: number; width: number; height: number; wheelbase: number; mass: number;
  maxSpeed: number; reverseSpeed: number; accel: number; brakeDecel: number; coastDecel: number; rollDecel: number; dragQuad: number;
  steerMaxLow: number; steerMaxHigh: number; steerLambda: number; gripNormal: number; gripHandbrake: number; handbrakeDecel: number;
  colors: number[]; hasBar: boolean;
}

export const SPECS: Record<VehicleKey, VehicleSpec> = {
  sedan: {
    key: 'sedan', name: 'Sedan', length: 4.4, width: 1.8, height: 1.4, wheelbase: 2.7, mass: 1200,
    maxSpeed: 38, reverseSpeed: 10, accel: 10, brakeDecel: 18, coastDecel: 1.5, rollDecel: 0.5, dragQuad: 0.0006,
    steerMaxLow: 0.60, steerMaxHigh: 0.14, steerLambda: 10, gripNormal: 8, gripHandbrake: 1.8, handbrakeDecel: 10,
    colors: [0xf2e6d0, 0xb8d8e8, 0xd9b3c7, 0xc9d6a4, 0xe8e8e8, 0x8fa8c8, 0xd8c8a8, 0x9fb8a0], hasBar: false,
  },
  sport: {
    key: 'sport', name: 'Spor', length: 4.3, width: 1.9, height: 1.2, wheelbase: 2.6, mass: 1150,
    maxSpeed: 50, reverseSpeed: 12, accel: 14, brakeDecel: 20, coastDecel: 1.5, rollDecel: 0.5, dragQuad: 0.0006,
    steerMaxLow: 0.55, steerMaxHigh: 0.10, steerLambda: 12, gripNormal: 9, gripHandbrake: 1.6, handbrakeDecel: 10,
    colors: [0xff7a00, 0xff2d95, 0x00e5ff, 0xffe600, 0xd80000, 0x7b2cff], hasBar: false,
  },
  van: {
    key: 'van', name: 'Kamyonet', length: 5.2, width: 2.0, height: 2.0, wheelbase: 3.2, mass: 1600,
    maxSpeed: 30, reverseSpeed: 8, accel: 7, brakeDecel: 16, coastDecel: 1.5, rollDecel: 0.6, dragQuad: 0.0009,
    steerMaxLow: 0.55, steerMaxHigh: 0.14, steerLambda: 8, gripNormal: 7, gripHandbrake: 2.0, handbrakeDecel: 9,
    colors: [0xf0f0f0, 0x6b7280, 0x2f4f7f, 0x8b5a2b], hasBar: false,
  },
  police: {
    key: 'police', name: 'Polis', length: 4.8, width: 1.9, height: 1.5, wheelbase: 2.8, mass: 1400,
    maxSpeed: 45, reverseSpeed: 10, accel: 12.5, brakeDecel: 20, coastDecel: 1.5, rollDecel: 0.5, dragQuad: 0.0006,
    steerMaxLow: 0.60, steerMaxHigh: 0.13, steerLambda: 11, gripNormal: 9, gripHandbrake: 1.8, handbrakeDecel: 10,
    colors: [0xf2f2f2], hasBar: true,
  },
  taxi: {
    key: 'taxi', name: 'Taksi', length: 4.5, width: 1.8, height: 1.4, wheelbase: 2.7, mass: 1200,
    maxSpeed: 38, reverseSpeed: 10, accel: 10, brakeDecel: 18, coastDecel: 1.5, rollDecel: 0.5, dragQuad: 0.0006,
    steerMaxLow: 0.60, steerMaxHigh: 0.14, steerLambda: 10, gripNormal: 8, gripHandbrake: 1.8, handbrakeDecel: 10,
    colors: [0xffd400], hasBar: false,
  },
};

export const TRAFFIC_MIX: { key: VehicleKey; weight: number }[] = [
  { key: 'sedan', weight: 55 }, { key: 'sport', weight: 15 }, { key: 'van', weight: 15 }, { key: 'taxi', weight: 15 },
];
