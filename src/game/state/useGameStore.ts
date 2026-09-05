// React bindings for GameStore/Engine: selector hook via useSyncExternalStore, contexts, shallowEqual. Track P0.
import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from 'react';
import type { GameStore, HudState } from './GameStore';
import type { Engine } from '../Engine';

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (!Object.prototype.hasOwnProperty.call(rb, k) || !Object.is(ra[k], rb[k])) return false;
  }
  return true;
}

export const GameStoreContext = createContext<GameStore | null>(null);
export const EngineReactContext = createContext<Engine | null>(null);

export function useStore(): GameStore {
  const s = useContext(GameStoreContext);
  if (!s) throw new Error('useStore: GameStoreContext is missing (render inside <GameCanvas>)');
  return s;
}

export function useEngine(): Engine {
  const e = useContext(EngineReactContext);
  if (!e) throw new Error('useEngine: EngineReactContext is missing (render inside <GameCanvas>)');
  return e;
}

/** Subscribes to a slice of HudState; re-renders only when the selected value changes (shallowEqual by default). */
export function useGameStore<T>(selector: (s: HudState) => T, eq: (a: T, b: T) => boolean = shallowEqual): T {
  const store = useStore();
  const cache = useRef<{ has: boolean; value: T }>({ has: false, value: undefined as T });
  const getSnapshot = useCallback((): T => {
    const next = selector(store.getState());
    const c = cache.current;
    if (c.has && eq(c.value, next)) return c.value;
    c.has = true;
    c.value = next;
    return next;
  }, [store, selector, eq]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
