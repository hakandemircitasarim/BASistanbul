// Shared primitive types and constants for the simulation. Track P0.
export type EntityId = number;
export interface Vec2 { x: number; z: number }
export interface Vec3 { x: number; y: number; z: number }
export type GamePhase = 'menu' | 'playing' | 'paused' | 'wasted' | 'busted';
export type VehicleRole = 'parked' | 'traffic' | 'police' | 'player' | 'mission' | 'abandoned';
export type PedState = 'IDLE' | 'WALK' | 'FLEE' | 'HIT' | 'DEAD';
export interface Transform { x: number; y: number; z: number; yaw: number }
/** throttle -1..1 (negative = brake/reverse), steer -1..1 (+ = right), brake 0..1 */
export interface VehicleControls { throttle: number; steer: number; brake: number; handbrake: boolean; horn: boolean; headlights: boolean }
export const FIXED_DT = 1 / 60;

export function zeroControls(): VehicleControls {
  return { throttle: 0, steer: 0, brake: 0, handbrake: false, horn: false, headlights: false };
}

export function resetControls(c: VehicleControls): void {
  c.throttle = 0;
  c.steer = 0;
  c.brake = 0;
  c.handbrake = false;
  c.horn = false;
  c.headlights = false;
}
