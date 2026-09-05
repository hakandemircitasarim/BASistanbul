// Typed synchronous event bus; listener lists are copy-on-write so on()/off() during emit are safe. Track P0.
import type { EntityId, GamePhase } from './Types';

export type GameEvents = {
  'ped:hit': { pedId: EntityId; byVehicleId: EntityId | null; byPlayer: boolean; speed: number; killed: boolean; x: number; z: number };
  'vehicle:collision': { aId: EntityId; bId: EntityId | null; impactSpeed: number; damage: number; x: number; z: number; playerInvolved: boolean; bIsPolice: boolean };
  'vehicle:destroyed': { id: EntityId; byPlayer: boolean; x: number; z: number };
  'player:enterVehicle': { vehicleId: EntityId; stolen: boolean };
  'player:exitVehicle': { vehicleId: EntityId };
  'player:damaged': { amount: number; source: 'vehicle' | 'police' | 'fall' | 'explosion' };
  'player:wasted': { reason: string };
  'player:busted': { reason: string };
  'player:respawn': { x: number; z: number; reason: 'wasted' | 'busted' | 'new' };
  'wanted:changed': { stars: number; prev: number };
  'mission:started': { id: string; title: string };
  'mission:objective': { id: string; text: string };
  'mission:completed': { id: string; reward: number };
  'mission:failed': { id: string; reason: string };
  'money:changed': { money: number; delta: number };
  'notify': { text: string; kind: 'info' | 'success' | 'danger' | 'police' };
  'time:hourChanged': { hour: number };
  'phase:changed': { phase: GamePhase; prev: GamePhase };
  'horn': { vehicleId: EntityId; x: number; z: number };
  'siren:changed': { active: boolean };
  'camera:shake': { trauma: number };
  'fx:skid': { vehicleId: EntityId; intensity: number };
};

interface Entry<F> { fn: F; once: boolean }

type Listener<E, K extends keyof E> = (p: E[K]) => void;

export class EventBus<E extends Record<string, object> = GameEvents> {
  // Each key maps to an immutable array; mutations create a new array so emit() can keep iterating the old one.
  private lists = new Map<keyof E, ReadonlyArray<Entry<Listener<E, keyof E>>>>();

  on<K extends keyof E>(k: K, fn: (p: E[K]) => void): () => void {
    this.add(k, fn as Listener<E, keyof E>, false);
    return () => this.off(k, fn);
  }

  once<K extends keyof E>(k: K, fn: (p: E[K]) => void): () => void {
    this.add(k, fn as Listener<E, keyof E>, true);
    return () => this.off(k, fn);
  }

  off<K extends keyof E>(k: K, fn: (p: E[K]) => void): void {
    const list = this.lists.get(k);
    if (!list) return;
    let idx = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].fn === (fn as Listener<E, keyof E>)) { idx = i; break; }
    }
    if (idx < 0) return;
    const next = list.slice();
    next.splice(idx, 1);
    if (next.length === 0) this.lists.delete(k);
    else this.lists.set(k, next);
  }

  /** Synchronous dispatch. Listeners added during emit are not called for this emit; removed ones are skipped. */
  emit<K extends keyof E>(k: K, p: E[K]): void {
    const list = this.lists.get(k);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!this.stillRegistered(k, e)) continue;
      if (e.once) this.offEntry(k, e);
      e.fn(p);
    }
  }

  clear(): void {
    this.lists.clear();
  }

  private add(k: keyof E, fn: Listener<E, keyof E>, once: boolean): void {
    const list = this.lists.get(k);
    const next = list ? list.slice() : [];
    next.push({ fn, once });
    this.lists.set(k, next);
  }

  private offEntry(k: keyof E, e: Entry<Listener<E, keyof E>>): void {
    const list = this.lists.get(k);
    if (!list) return;
    const idx = list.indexOf(e);
    if (idx < 0) return;
    const next = list.slice();
    next.splice(idx, 1);
    if (next.length === 0) this.lists.delete(k);
    else this.lists.set(k, next);
  }

  private stillRegistered(k: keyof E, e: Entry<Listener<E, keyof E>>): boolean {
    const cur = this.lists.get(k);
    if (!cur) return false;
    for (let i = 0; i < cur.length; i++) if (cur[i] === e) return true;
    return false;
  }
}
