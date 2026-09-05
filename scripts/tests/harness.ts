// Test harness: test/expect/approx registry plus a headless World+systems factory for Node sims. Track P0.
import { FIXED_DT } from '../../src/game/core/Types';
import { Random } from '../../src/game/core/Random';
import { EventBus } from '../../src/game/core/EventBus';
import { Input } from '../../src/game/core/Input';
import { GameStore } from '../../src/game/state/GameStore';
import { generateCity } from '../../src/game/city/CityGenerator';
import { World } from '../../src/game/world/World';
import { resetEntityIds } from '../../src/game/entities/Entity';
import { stubAudio, stubCamera } from '../../src/game/systems/System';
import type { EngineContext, System } from '../../src/game/systems/System';

interface Registered { name: string; fn: () => void | Promise<void> }
let registry: Registered[] = [];

export function test(name: string, fn: () => void | Promise<void>): void {
  registry.push({ name, fn });
}

export function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function approx(a: number, b: number, tol: number, msg: string): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} (got ${a}, expected ${b} ± ${tol})`);
}

/** Runs and clears the registered tests; prints per-test timing. */
export async function runRegistered(): Promise<{ passed: number; failed: number }> {
  const list = registry;
  registry = [];
  let passed = 0;
  let failed = 0;
  for (const t of list) {
    const t0 = performance.now();
    try {
      await t.fn();
      passed++;
      console.log(`  ok   ${t.name} (${(performance.now() - t0).toFixed(1)} ms)`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      console.log(`  FAIL ${t.name} (${(performance.now() - t0).toFixed(1)} ms)\n    ${msg.split('\n').join('\n    ')}`);
    }
  }
  return { passed, failed };
}

export interface Headless { world: World; ctx: EngineContext; input: Input; systems: System[]; step(n?: number): void /* beginTick, systems, endTick, elapsed */; secs(s: number): void }

/** Stub camera/audio, real Input (unattached), real store, generateCity; systems run in the given order. */
export function createHeadless(opts: { seed?: number; systems?: (ctx: EngineContext) => System[]; hour?: number } = {}): Headless {
  resetEntityIds();
  const seed = opts.seed ?? 1907;
  const rng = new Random(seed);
  const gen = generateCity(seed);
  const world = new World(gen, rng.fork());
  world.time.hour = opts.hour ?? 18;
  world.phase = 'playing';
  const store = new GameStore();
  const input = new Input();
  input.enabled = true;
  const events = new EventBus();
  const ctx: EngineContext = { world, events, input, store, audio: stubAudio(), camera: stubCamera(), rng: rng.fork(), settings: () => store.getState().settings };
  const systems = opts.systems ? opts.systems(ctx) : [];
  for (const s of systems) s.init?.(ctx);
  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      world.beginTick();
      for (let k = 0; k < systems.length; k++) systems[k].fixedUpdate(FIXED_DT);
      input.endTick();
      world.time.elapsed += FIXED_DT;
    }
  };
  return { world, ctx, input, systems, step, secs: (s: number) => step(Math.round(s / FIXED_DT)) };
}
