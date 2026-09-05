// Three-free, React-free HUD state store: shallow-merge setState, subscribe, notifications, persisted settings. Track P0.
import type { GamePhase } from '../core/Types';

export interface Settings { quality: 'low' | 'high'; shadows: boolean; mouseSensitivity: number /*0.5..3, default 1*/; invertY: boolean; muted: boolean; volume: number /*0..1*/; minimapRotate: boolean; showFps: boolean }
export interface Notification { id: number; text: string; kind: 'info' | 'success' | 'danger' | 'police'; at: number }
export interface DebugStats { fps: number; drawCalls: number; triangles: number; tickMs: number; vehicles: number; peds: number; police: number; traffic: number }
export interface HudState {
  phase: GamePhase; loading: boolean; loadingText: string; pointerLocked: boolean;
  health: number; armor: number; money: number; wanted: number; wantedFlash: boolean;
  inVehicle: boolean; speedKmh: number; vehicleHealth: number; vehicleName: string;
  prompt: string | null; missionTitle: string | null; missionObjective: string | null; missionTimer: number | null;
  clock: string; notifications: Notification[]; settings: Settings; fps: number;
  gameOverReason: 'wasted' | 'busted' | null; lastReward: number; hitFlashAt: number;
  debug: DebugStats | null; showDebug: boolean;
}

export const SETTINGS_STORAGE_KEY = 'gta6.settings';
export const MAX_NOTIFICATIONS = 4;

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high', shadows: true, mouseSensitivity: 1, invertY: false, muted: false, volume: 0.8, minimapRotate: true, showFps: false,
};

export const initialHudState: HudState = {
  phase: 'menu', loading: true, loadingText: 'Yükleniyor...', pointerLocked: false,
  health: 100, armor: 0, money: 1000, wanted: 0, wantedFlash: false,
  inVehicle: false, speedKmh: 0, vehicleHealth: 100, vehicleName: '',
  prompt: null, missionTitle: null, missionObjective: null, missionTimer: null,
  clock: '18:00', notifications: [], settings: DEFAULT_SETTINGS, fps: 0,
  gameOverReason: null, lastReward: 0, hitFlashAt: 0,
  debug: null, showDebug: false,
};

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function sanitizeSettings(raw: unknown): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.quality === 'low' || r.quality === 'high') out.quality = r.quality;
  if (typeof r.shadows === 'boolean') out.shadows = r.shadows;
  if (typeof r.mouseSensitivity === 'number' && isFinite(r.mouseSensitivity)) out.mouseSensitivity = Math.min(3, Math.max(0.5, r.mouseSensitivity));
  if (typeof r.invertY === 'boolean') out.invertY = r.invertY;
  if (typeof r.muted === 'boolean') out.muted = r.muted;
  if (typeof r.volume === 'number' && isFinite(r.volume)) out.volume = Math.min(1, Math.max(0, r.volume));
  if (typeof r.minimapRotate === 'boolean') out.minimapRotate = r.minimapRotate;
  if (typeof r.showFps === 'boolean') out.showFps = r.showFps;
  return out;
}

export class GameStore {
  private state: HudState = initialHudState;
  private listeners: ReadonlyArray<() => void> = [];
  private nextNotificationId = 1;

  getState = (): HudState => this.state;

  /** Shallow merge; creates a new state object; notifies only if some key changed (Object.is per key). */
  setState = (patch: Partial<HudState>): void => {
    const prev = this.state;
    let changed = false;
    for (const k in patch) {
      const key = k as keyof HudState;
      if (!Object.is(prev[key], patch[key])) { changed = true; break; }
    }
    if (!changed) return;
    this.state = { ...prev, ...patch };
    const ls = this.listeners;
    for (let i = 0; i < ls.length; i++) ls[i]();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners = this.listeners.concat(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx < 0) return;
      const next = this.listeners.slice();
      next.splice(idx, 1);
      this.listeners = next;
    };
  };

  /** Appends a notification; keeps at most MAX_NOTIFICATIONS (oldest dropped). */
  notify(text: string, kind: Notification['kind'] = 'info'): void {
    const n: Notification = { id: this.nextNotificationId++, text, kind, at: nowMs() };
    const list = this.state.notifications;
    const start = Math.max(0, list.length - (MAX_NOTIFICATIONS - 1));
    const next = list.slice(start);
    next.push(n);
    this.setState({ notifications: next });
  }

  /** Merges + persists to localStorage (guarded). */
  setSettings(patch: Partial<Settings>): void {
    const settings: Settings = { ...this.state.settings, ...patch };
    this.setState({ settings });
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable */
    }
  }

  /** Reads persisted settings (merged over defaults), applies them to the state and returns them. */
  loadSettings(): Settings {
    let loaded: Partial<Settings> = {};
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (raw) loaded = sanitizeSettings(JSON.parse(raw));
      }
    } catch {
      loaded = {};
    }
    const settings: Settings = { ...DEFAULT_SETTINGS, ...loaded };
    this.setState({ settings });
    return settings;
  }
}
