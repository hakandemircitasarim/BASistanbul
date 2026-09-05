// System interface, EngineContext and the CameraLike/AudioLike ports (with headless stubs). Track P0.
import type { Vec2 } from '../core/Types';
import type { World } from '../world/World';
import type { EventBus } from '../core/EventBus';
import type { Input } from '../core/Input';
import type { GameStore, Settings } from '../state/GameStore';
import type { Random } from '../core/Random';

export type UiSound = 'select' | 'confirm' | 'money' | 'star' | 'fail' | 'wanted' | 'busted' | 'wasted' | 'missionStart' | 'missionComplete';
export interface CameraLike {
  readonly yawForMovement: number; readonly x: number; readonly z: number; readonly forwardX: number; readonly forwardZ: number;
  snapBehind(): void; addTrauma(t: number): void;
  isInView(x: number, z: number): boolean; // true if the point is inside the camera's forward cone (dot > 0.25)
}
export interface AudioLike {
  unlock(): void; setMuted(m: boolean): void; setVolume(v: number): void; readonly muted: boolean;
  playImpact(strength01: number): void; playUi(kind: UiSound): void; playHorn(durationSec: number, x: number, z: number): void;
  setEngine(active: boolean, rpm01: number, load01: number): void; setSirens(list: Vec2[], count: number): void; setSkid(intensity01: number): void; setSpeedWind(speed01: number): void;
}
export interface EngineContext { world: World; events: EventBus; input: Input; store: GameStore; audio: AudioLike; camera: CameraLike; rng: Random; settings(): Settings }
export interface System { readonly name: string; init?(ctx: EngineContext): void; fixedUpdate(dt: number): void; dispose?(): void }

class StubCamera implements CameraLike {
  yawForMovement = 0;
  x = 0;
  z = 0;
  forwardX = 0;
  forwardZ = 1;
  snapBehind(): void { /* no-op */ }
  addTrauma(): void { /* no-op */ }
  isInView(x: number, z: number): boolean {
    const dx = x - this.x, dz = z - this.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-6) return true;
    return (dx * this.forwardX + dz * this.forwardZ) / d > 0.25;
  }
}

class StubAudio implements AudioLike {
  muted = false;
  unlock(): void { /* no-op */ }
  setMuted(m: boolean): void { this.muted = m; }
  setVolume(): void { /* no-op */ }
  playImpact(): void { /* no-op */ }
  playUi(): void { /* no-op */ }
  playHorn(): void { /* no-op */ }
  setEngine(): void { /* no-op */ }
  setSirens(): void { /* no-op */ }
  setSkid(): void { /* no-op */ }
  setSpeedWind(): void { /* no-op */ }
}

export function stubCamera(): CameraLike { return new StubCamera(); }
export function stubAudio(): AudioLike { return new StubAudio(); }
