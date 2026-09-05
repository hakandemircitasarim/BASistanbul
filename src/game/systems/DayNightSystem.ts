// Day/night clock: advances world.time.hour, exposes sun direction / night factor, toggles AI headlights. Track B (sim, Three-free).
import type { Vec3 } from '../core/Types';
import { smoothstep } from '../core/math';
import type { World } from '../world/World';
import type { EventBus } from '../core/EventBus';
import type { EngineContext, System } from './System';

export const DAY_TUNING = { dayLengthSec: 600, startHour: 18.0, lightsOnElevation: 0.05, lightsFadeHours: 0.5, lightsOnHour: 18.5, lightsOffHour: 6.5 };

/** Plain hour-window night test for anything that only needs "are the headlights on" (no sun vector to hand). */
export function isNightHour(hour: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  return h >= DAY_TUNING.lightsOnHour || h < DAY_TUNING.lightsOffHour;
}

/**
 * Sun path: rises east (+X) at 06:45, culminates at 12:45, sets west (-X) at 18:45; a small +Z tilt keeps shadows off-axis.
 * SOUTH_LEAN pushes the arc toward +Z as the sun climbs (noon elevation ~49 deg instead of ~55) so facades and lamp
 * posts throw long, readable shadows at midday, while the elevation at the horizon - and therefore the sunrise/sunset
 * azimuth and the nightFactor timing - is untouched.
 */
const SUNRISE_HOUR = 6.75;
const MAX_ELEVATION = 0.82;
const PATH_TILT = 0.22;
const SOUTH_LEAN = 0.55;
const TWO_PI = Math.PI * 2;

export class DayNightSystem implements System {
  readonly name = 'DayNight';
  world: World | null = null;
  events: EventBus | null = null;
  /** Hour used when no world is attached (RenderTest page). */
  private standaloneHour = DAY_TUNING.startHour;
  private lastHourInt = -1;
  private readonly dir: Vec3 = { x: 0, y: 1, z: 0 };

  init(ctx: EngineContext): void {
    this.world = ctx.world;
    this.events = ctx.events;
    this.lastHourInt = Math.floor(this.hour());
    this.refresh();
  }

  hour(): number {
    return this.world ? this.world.time.hour : this.standaloneHour;
  }

  setHour(h: number): void {
    const wrapped = ((h % 24) + 24) % 24;
    if (this.world) this.world.time.hour = wrapped;
    else this.standaloneHour = wrapped;
    this.refresh();
    const hi = Math.floor(wrapped);
    if (hi !== this.lastHourInt) {
      this.lastHourInt = hi;
      if (this.events) this.events.emit('time:hourChanged', { hour: hi });
    }
  }

  /** Sun elevation angle in radians (negative below the horizon). */
  sunElevation(): number {
    return Math.asin(this.dir.y);
  }

  /** Unit vector from the ground toward the sun. */
  sunDir(out: Vec3): Vec3 {
    out.x = this.dir.x;
    out.y = this.dir.y;
    out.z = this.dir.z;
    return out;
  }

  /** 0 = full day, 1 = full night; smoothstep(0.02, -0.16, sunDir.y): lights fade in after the 18:45 sunset and night is complete by ~19:45. */
  nightFactor(): number {
    return smoothstep(0.02, -0.16, this.dir.y);
  }

  fixedUpdate(dt: number): void {
    const w = this.world;
    const dayLen = w ? w.time.dayLengthSec : DAY_TUNING.dayLengthSec;
    let h = this.hour() + (dt * 24) / dayLen;
    if (h >= 24) h -= 24;
    if (w) w.time.hour = h;
    else this.standaloneHour = h;
    this.refresh();
    const hi = Math.floor(h);
    if (hi !== this.lastHourInt) {
      this.lastHourInt = hi;
      if (this.events) this.events.emit('time:hourChanged', { hour: hi });
    }
    if (w) {
      const lights = this.nightFactor() > 0.5;
      const list = w.vehicleList;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v.occupiedByPlayer || v.role === 'player') continue;
        const active = v.role === 'traffic' || v.role === 'police' || v.role === 'mission';
        v.lightsOn = lights && active && !v.destroyed;
      }
    }
  }

  private refresh(): void {
    const a = ((this.hour() - SUNRISE_HOUR) / 24) * TWO_PI;
    const x = Math.cos(a);
    const y = Math.sin(a) * MAX_ELEVATION;
    const z = PATH_TILT + SOUTH_LEAN * Math.max(0, y);
    const inv = 1 / Math.sqrt(x * x + y * y + z * z);
    this.dir.x = x * inv;
    this.dir.y = y * inv;
    this.dir.z = z * inv;
  }
}
