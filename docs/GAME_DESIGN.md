# BAS İstanbul (Büyük Araba Soygunu) — Build 1 Implementation Spec

A browser, third-person, open-world "GTA-style" sandbox set in a procedurally generated
Vice-City-like coastal grid city. This document is the **contract** every engineer implements
against. Interfaces in section 2 are frozen: implement them exactly (names, signatures, units).
If you must deviate, keep the old name working and document the deviation in your report.

Working title: **BAS İstanbul** (Büyük Araba Soygunu). UI language: **Turkish**. Code and comments: English.

---

## 0. Ground rules (read fully before writing code)

### Stack
- Vite 5, React 18, TypeScript 5 (`strict` is OFF, `noImplicitAny` OFF — the contract below is
  the safety net, so keep exports exactly as specified), Tailwind 3, shadcn/ui in `src/components/ui`,
  lucide-react, react-router-dom 6. `three@0.185` + `@types/three` are installed. `tsx` is installed
  for Node tests. No other dependencies may be added.
- Path alias `@/` -> `src/`. **Simulation code must use relative imports** (it also runs in Node).

### Layers and import rules (hard rules)
1. **Simulation code is Three.js-free and React-free.** Nothing under `src/game/core`, `src/game/city`,
   `src/game/entities`, `src/game/world`, `src/game/systems`, `src/game/missions`, `src/game/state`
   (except `useGameStore.ts`), or `src/game/minimap` may import `three` or `react`. This lets the
   whole simulation run headless in Node with `tsx`.
2. Renderers (`src/game/render/*`), audio (`src/game/audio/*`) and React components may import `three`.
3. **Nothing imports `src/game/Engine.ts`** except `src/components/game/GameCanvas.tsx`,
   `src/game/index.ts` and `src/game/debug/DebugOverlay.ts`. Systems receive an `EngineContext`.
4. Use `import type` for every type-only import. Never create an import cycle through a value import.
5. Entities hold **no** Three objects. Renderers map entities to instances via `renderIndex`.
6. **One authoritative transform per entity**: `entity.curr` (and `entity.prev` for interpolation).
   No system may keep a second copy of position/yaw.
7. Collisions are resolved in `CollisionSystem` only. Movement systems integrate; they never push out.

### Coordinates and units (all modules)
- Meters, seconds, radians. Y up, ground at y = 0. XZ is the ground plane. +X = east (toward the
  beach), +Z = south. `Vec2 = {x, z}`.
- `yaw = 0` faces +Z. `forward(yaw) = (sin yaw, 0, cos yaw)`, `right(yaw) = (-cos yaw, 0, sin yaw)`.
  In 2D, `right2D(d) = (-d.z, d.x)`. Every model is built with its nose/face toward local +Z so
  `mesh.rotation.y = yaw`.
- Right-hand traffic: lanes are offset to `right2D(dir)` of the direction of travel.
- Speeds in m/s. HUD shows km/h = m/s × 3.6 with the label `km/sa`.

### Performance rules
- Fixed timestep 1/60 s, max 5 steps per frame, frame dt clamped to 0.1 s. Render interpolation
  by `alpha` for every moving entity. Teleports call `entity.snap()`.
- **No allocations in per-tick code**: preallocated scratch objects, `out` parameters, arrays with
  explicit counts. No `.map/.filter/.forEach` closures, no spread, no `new` inside `fixedUpdate`.
  Event payload literals are the only accepted exception (a few per second).
- Draw-call budget < 120 at any camera position. Instancing/merging as specified in Track B.
- React re-renders at most 10 Hz (HudPublisher) and only for components whose slice changed.
- Every additive/unlit/emissive-only material sets `material.fog = false` and `toneMapped = false`.

### Quality gates (every engineer runs these before reporting)
- `npx tsc -p tsconfig.app.json --noEmit` → zero errors.
- `npm run lint` → **no new errors**. Three pre-existing errors in `src/components/ui/*` and
  `tailwind.config.ts` are known and must not be "fixed" by you. Lint rules that bite:
  no `any` (use `unknown` or a real type), no empty interfaces / `{}` types, no `require()`,
  no unused expressions, no `@ts-ignore`. Hooks rules apply in React files.
- Your own tests under `scripts/tests/` pass: `npx tsx scripts/run-tests.ts <filter>`.
- Do **not** run `npm run build` while another engineer may be running it (it writes `dist/`);
  the integrator runs the build. Do not `git commit`. Do not touch files you do not own.

### Turkish UI strings (use exactly these)
- Prompts: `E - Araca bin`, `E - Araçtan in`, `E - Görevi başlat: {title}`.
- Notifications: `Aranıyorsun!`, `Polis peşinde!`, `Araç çalındı`, `Görev tamamlandı: +$1.500`,
  `Görev başarısız: {reason}`, `Yeni görev: {title}`, `Süre bonusu: +$500`, `Kaçtın! Aranma sona erdi`.
- Game over: `HARCANDIN` (wasted) with subtitle `Hastanede uyandın.`; `YAKALANDIN` (busted) with
  subtitle `Polis merkezinden serbest bırakıldın. -$500`.
- Menus: `BAS İSTANBUL`, `Başla`, `Kontroller`, `Ayarlar`, `Devam Et`, `Ana Menü`, `Geri`,
  `Yükleniyor...`, `Devam etmek için tıkla`, `Duraklatıldı`.
- Settings: `Grafik kalitesi` (`Düşük`/`Yüksek`), `Gölgeler`, `Fare hassasiyeti`, `Y eksenini ters çevir`,
  `Ses seviyesi`, `Sessiz`, `Mini harita dönsün`, `FPS göster`.
- Controls table: `W A S D — Hareket`, `Shift — Koş`, `Boşluk — Zıpla / El freni`, `E — Araca bin / in`,
  `H — Korna`, `Q / R — Kamera (fare kilidi yokken)`, `L — Farlar`, `M — Sessiz`, `V — Kamera mesafesi`,
  `Esc — Duraklat`, `F3 — Hata ayıklama`.
- Missions: `Sahil Yürüyüşü`, `Turuncu Kurye`, `Sıcak Takip` (details in Track F).
- Vehicle display names: `Sedan`, `Spor`, `Kamyonet`, `Polis`, `Taksi`.
- Money format: `$1.250` (tr-TR grouping, no decimals).

---

## 1. Tracks and file ownership

| Track | Owner scope (files) |
|---|---|
| **P0 Core** | `src/game/core/*`, `src/game/state/GameStore.ts`, `src/game/state/useGameStore.ts`, `src/game/entities/*`, `src/game/world/World.ts`, `src/game/systems/System.ts`, `src/game/city/CityConfig.ts`, `src/game/city/CityData.ts`, `src/game/city/Palette.ts`, STUBS of `src/game/city/{RoadGraph,SidewalkGraph,CityGenerator}.ts`, `src/game/render/Renderer.ts`, minimal `src/game/render/CameraController.ts`, minimal `src/game/Engine.ts`, `src/game/index.ts`, `src/components/game/GameCanvas.tsx`, `src/pages/Index.tsx`, `src/App.tsx` (routes), `index.html` (title), `scripts/run-tests.ts`, `scripts/tests/harness.ts`, `package.json` scripts |
| **A City** | `src/game/city/{RoadGraph,SidewalkGraph,CityGenerator}.ts` (replace stubs), `src/game/minimap/MinimapRenderer.ts`, `scripts/tests/city.test.ts` |
| **B Render** | `src/game/render/{TextureFactory,Materials,BuildingGeometry,CityRenderer,SkySystem,MarkerRenderer,EffectsRenderer}.ts`, `src/game/systems/DayNightSystem.ts`, `src/pages/RenderTest.tsx` (+ its route in `App.tsx`) |
| **C Player/Vehicles** | `src/game/systems/{PlayerMoveSystem,VehicleEntrySystem,VehiclePhysicsSystem,CollisionSystem}.ts`, `src/game/render/{CameraController,PlayerRenderer,VehicleRenderer}.ts`, `scripts/tests/{physics,collision}.test.ts` |
| **D UI** | `src/components/game/*` except `GameCanvas.tsx`, `src/game/state/HudPublisher.ts`, `src/game/debug/DebugOverlay.ts` |
| **E NPC** | `src/game/systems/{TrafficSystem,PedestrianSystem}.ts`, `src/game/render/PedRenderer.ts`, `src/game/audio/AudioSystem.ts`, `scripts/tests/traffic.sim.ts` |
| **F Law/Missions** | `src/game/systems/{WantedSystem,PoliceSystem,MissionSystem}.ts`, `src/game/missions/definitions.ts`, `scripts/tests/{police,missions}.sim.ts` |
| **I Integration** | `src/game/Engine.ts`, `scripts/screenshot.mjs`, `README.md`, any glue; may edit any file to fix integration bugs |

Order: P0 → (A ‖ C ‖ D) → B after A → E after A+C → F after E → I.

---

## 2. Frozen contracts (P0 creates these files exactly)

### 2.1 `src/game/core/Types.ts`
```ts
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
export function zeroControls(): VehicleControls;
export function resetControls(c: VehicleControls): void;
```

### 2.2 `src/game/core/math.ts` (allocation-free)
```ts
export const clamp = (v: number, a: number, b: number) => number;
export const lerp = (a: number, b: number, t: number) => number;
export const damp = (a: number, b: number, lambda: number, dt: number) => number; // a + (b-a)*(1-exp(-lambda*dt))
export const wrapAngle = (a: number) => number;            // -PI..PI
export const angleDiff = (from: number, to: number) => number; // wrapped (to - from)
export const lerpAngle = (a: number, b: number, t: number) => number;
export const dampAngle = (a: number, b: number, lambda: number, dt: number) => number;
export const forwardOf = (yaw: number, out: Vec2) => Vec2;   // (sin, cos)
export const rightOf = (yaw: number, out: Vec2) => Vec2;     // (-cos, sin)
export const right2D = (d: Vec2, out: Vec2) => Vec2;         // (-d.z, d.x)
export const len2 = (x: number, z: number) => number;
export const dist2D = (ax: number, az: number, bx: number, bz: number) => number;
export const yawFromDir = (dx: number, dz: number) => number; // Math.atan2(dx, dz)
export const smoothstep = (e0: number, e1: number, x: number) => number;
export const sign = (x: number) => number; // -1, 0, 1
```

### 2.3 `src/game/core/Random.ts`
```ts
export class Random { constructor(seed: number); next(): number; range(min: number, max: number): number; int(min: number, maxInclusive: number): number; pick<T>(arr: readonly T[]): T; chance(p: number): boolean; fork(): Random; readonly seed: number }
```
mulberry32. Deterministic for a given seed.

### 2.4 `src/game/core/Transform.ts`
```ts
export const createTransform = (x = 0, y = 0, z = 0, yaw = 0) => Transform;
export const copyTransform = (dst: Transform, src: Transform) => void;
export const lerpTransform = (out: Transform, prev: Transform, curr: Transform, alpha: number) => Transform; // lerpAngle for yaw
```

### 2.5 `src/game/core/EventBus.ts`
```ts
export interface GameEvents {
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
}
export class EventBus<E extends Record<string, object> = GameEvents> {
  on<K extends keyof E>(k: K, fn: (p: E[K]) => void): () => void;
  once<K extends keyof E>(k: K, fn: (p: E[K]) => void): () => void;
  off<K extends keyof E>(k: K, fn: (p: E[K]) => void): void;
  emit<K extends keyof E>(k: K, p: E[K]): void; // synchronous; safe to on()/off() during emit
  clear(): void;
}
```

### 2.6 `src/game/core/Input.ts`
```ts
export type Action = 'forward' | 'back' | 'left' | 'right' | 'sprint' | 'jump' | 'interact' | 'handbrake' | 'horn'
  | 'camLeft' | 'camRight' | 'pause' | 'mute' | 'headlights' | 'debug' | 'cameraToggle';
export const DEFAULT_BINDINGS: Record<Action, string[]>;
// forward KeyW ArrowUp | back KeyS ArrowDown | left KeyA ArrowLeft | right KeyD ArrowRight | sprint ShiftLeft ShiftRight
// jump Space | handbrake Space | interact KeyE KeyF | horn KeyH | camLeft KeyQ | camRight KeyR | pause Escape
// mute KeyM | headlights KeyL | debug F3 | cameraToggle KeyV     (E is ONLY interact; Q/R are ONLY camera)
export class Input {
  constructor();                                  // no DOM access in constructor (Node-safe)
  attach(target: HTMLElement): void; detach(): void; // keys on window; mouse/pointer lock on target
  setKey(code: string, down: boolean): void;      // used by DOM listeners AND headless tests
  addMouseDelta(dx: number, dy: number): void;
  beginFrame(): void;   // once per rAF: moves accumulated mouse delta into mouseDX/mouseDY and zeroes the accumulator
  endTick(): void;      // after each fixed tick: clears all "pressed" edges (so exactly one tick sees a keypress)
  down(a: Action): boolean;      // held
  pressed(a: Action): boolean;   // went down since last endTick
  consume(a: Action): boolean;   // pressed() and clears that edge
  axis(neg: Action, pos: Action): number; // -1..1
  mouseDX: number; mouseDY: number;
  pointerLocked: boolean;
  requestPointerLock(): void;  // catches the promise rejection; never throws
  exitPointerLock(): void;
  onPointerLockChange: ((locked: boolean) => void) | null;
  clearAll(): void; // on blur / visibilitychange hidden / pointer-lock loss: all keys up, edges cleared
  enabled: boolean; // when false down()/pressed() return false (menus)
}
```

### 2.7 `src/game/core/SpatialHash.ts`
```ts
export interface HashItem { minX: number; minZ: number; maxX: number; maxZ: number; hashStamp: number }
export class SpatialHash<T extends HashItem> {
  constructor(cellSize: number);
  insert(item: T): void; remove(item: T): void; clear(): void;
  queryRect(minX: number, minZ: number, maxX: number, maxZ: number, out: T[]): number;  // returns count; dedups via hashStamp; out is reused (length may exceed count)
  queryCircle(cx: number, cz: number, r: number, out: T[]): number;
  querySegment(ax: number, az: number, bx: number, bz: number, pad: number, out: T[]): number; // DDA over cells
  readonly size: number;
}
```
`out.length` is NOT truncated (to avoid churn); callers use the returned count.

### 2.8 `src/game/core/Collision.ts`
```ts
export interface AABB { minX: number; minZ: number; maxX: number; maxZ: number }
export interface OBB { cx: number; cz: number; hw: number; hl: number; yaw: number } // hw = half width (local x), hl = half length (local z)
export interface Circle { cx: number; cz: number; r: number }
export interface Manifold { nx: number; nz: number; depth: number } // normal points from B toward A; moving A by n*depth separates
export type StaticShape = ({ kind: 'aabb' } & AABB) | ({ kind: 'circle' } & Circle);
export interface StaticCollider extends HashItem { id: number; shape: StaticShape; tag: 'building' | 'prop' | 'water' | 'boundary' | 'landmark'; height: number }
export const obbVsAabb = (o: OBB, a: AABB, out: Manifold) => boolean;   // SAT: world X, world Z, obb forward, obb right
export const obbVsObb = (a: OBB, b: OBB, out: Manifold) => boolean;
export const obbVsCircle = (o: OBB, c: Circle, out: Manifold) => boolean;
export const circleVsAabb = (c: Circle, a: AABB, out: Manifold) => boolean;
export const circleVsObb = (c: Circle, o: OBB, out: Manifold) => boolean;
export const circleVsCircle = (a: Circle, b: Circle, out: Manifold) => boolean;
export const segmentVsAabb = (ax: number, az: number, bx: number, bz: number, a: AABB) => number;  // t in [0,1] or -1
export const segmentVsCircle = (ax: number, az: number, bx: number, bz: number, c: Circle) => number; // t or -1
export const pointInAabb = (x: number, z: number, a: AABB) => boolean;
export const obbBounds = (o: OBB, out: AABB) => AABB;
export const staticVsCircle = (s: StaticShape, c: Circle, out: Manifold) => boolean;
export const staticVsObb = (s: StaticShape, o: OBB, out: Manifold) => boolean;
```

### 2.9 `src/game/core/GameLoop.ts`
```ts
export interface LoopCallbacks { fixed: (dt: number) => void; render: (alpha: number, frameDt: number) => void }
export class GameLoop {
  constructor(cb: LoopCallbacks, fixedDt?: number /* 1/60 */);
  start(): void; stop(): void;
  paused: boolean;            // when true: no fixed steps, render still called with alpha 0
  timeScale: number;          // 1 normally, 0.3 during wasted slow-mo
  readonly fps: number;       // smoothed
  readonly tick: number;
  readonly lastFixedMs: number; // wall ms spent in fixed steps this frame
  readonly maxSubSteps: number; // 5
  readonly maxFrameDt: number;  // 0.1
}
```

### 2.10 `src/game/core/Budget.ts`
```ts
export const BUDGET = {
  MAX_VEHICLES: 128, MAX_PEDS: 96,
  PARKED: 40, TRAFFIC_TARGET: 28, POLICE_MAX: 10, MISSION: 2, ABANDONED: 8,
  PED_TARGET: 40,
} as const; // 40+28+10+2+8 = 88 < 128. Spawners assert world.vehicleList.length < MAX_VEHICLES before spawning.
```

### 2.11 `src/game/state/GameStore.ts` (Three-free, React-free)
```ts
export interface Settings { quality: 'low' | 'high'; shadows: boolean; ao: boolean /* screen-space AO, opt-in, high only */; mouseSensitivity: number /*0.5..3, default 1*/; invertY: boolean; muted: boolean; volume: number /*0..1*/; minimapRotate: boolean; showFps: boolean }
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
export const DEFAULT_SETTINGS: Settings;
export const initialHudState: HudState;
export class GameStore {
  getState(): HudState;
  setState(patch: Partial<HudState>): void;   // shallow merge; creates a new state object; notifies listeners only if something changed (Object.is per key)
  subscribe(listener: () => void): () => void;
  notify(text: string, kind?: Notification['kind']): void; // appends (max 4 kept, oldest dropped)
  setSettings(patch: Partial<Settings>): void;             // merges + persists to localStorage key 'gta6.settings' (guarded by try/catch)
  loadSettings(): Settings;
}
```

### 2.12 `src/game/state/useGameStore.ts` (React)
```ts
export function useGameStore<T>(selector: (s: HudState) => T, eq?: (a: T, b: T) => boolean): T; // useSyncExternalStore + shallowEqual default
export const GameStoreContext: React.Context<GameStore | null>; export function useStore(): GameStore;
export const EngineReactContext: React.Context<Engine | null>; export function useEngine(): Engine; // `import type { Engine }`
export function shallowEqual(a: unknown, b: unknown): boolean;
```

### 2.13 `src/game/entities/Entity.ts`
```ts
export type EntityKind = 'player' | 'vehicle' | 'ped';
export interface Entity extends HashItem {
  id: EntityId; kind: EntityKind; prev: Transform; curr: Transform; vx: number; vz: number; alive: boolean;
  renderIndex: number; spawnFade: number; /* 0..1, 1 = fully visible; renderers scale by it; spawners set 0 then it grows 2/s */
  snap(): void;          // prev = curr
  updateBounds(): void;  // recompute minX..maxZ from curr
}
export const nextEntityId: () => EntityId;
export const resetEntityIds: () => void;
```

### 2.14 `src/game/entities/VehicleSpecs.ts`
```ts
export type VehicleKey = 'sedan' | 'sport' | 'van' | 'police' | 'taxi';
export interface VehicleSpec {
  key: VehicleKey; name: string; length: number; width: number; height: number; wheelbase: number; mass: number;
  maxSpeed: number; reverseSpeed: number; accel: number; brakeDecel: number; coastDecel: number; rollDecel: number; dragQuad: number;
  steerMaxLow: number; steerMaxHigh: number; steerLambda: number; gripNormal: number; gripHandbrake: number; handbrakeDecel: number;
  colors: number[]; hasBar: boolean;
}
export const SPECS: Record<VehicleKey, VehicleSpec>;
export const TRAFFIC_MIX: { key: VehicleKey; weight: number }[]; // sedan 55, sport 15, van 15, taxi 15
```
Values (P0 writes them; C may retune within ±20% and must keep the physics test passing):

| key | name | L×W×H | wb | mass | maxSpeed | rev | accel | brake | coast | roll | dragQuad | steer lo/hi | steerλ | grip n/hb | hbDecel | hasBar |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sedan | Sedan | 4.4×1.8×1.4 | 2.7 | 1200 | 38 | 10 | 10 | 18 | 1.5 | 0.5 | 0.0006 | 0.60/0.14 | 10 | 8/1.8 | 10 | no |
| sport | Spor | 4.3×1.9×1.2 | 2.6 | 1150 | 50 | 12 | 14 | 20 | 1.5 | 0.5 | 0.0006 | 0.55/0.10 | 12 | 9/1.6 | 10 | no |
| van | Kamyonet | 5.2×2.0×2.0 | 3.2 | 1600 | 30 | 8 | 7 | 16 | 1.5 | 0.6 | 0.0009 | 0.55/0.14 | 8 | 7/2.0 | 9 | no |
| police | Polis | 4.8×1.9×1.5 | 2.8 | 1400 | 45 | 10 | 12.5 | 20 | 1.5 | 0.5 | 0.0006 | 0.60/0.13 | 11 | 9/1.8 | 10 | yes |
| taxi | Taksi | 4.5×1.8×1.4 | 2.7 | 1200 | 38 | 10 | 10 | 18 | 1.5 | 0.5 | 0.0006 | 0.60/0.14 | 10 | 8/1.8 | 10 | no |

Colors: sedan pastel/normal 8 colors; sport 6 vivid (must include orange 0xff7a00); van 4; police [0xf2f2f2]; taxi [0xffd400].

### 2.15 `src/game/entities/Vehicle.ts`
```ts
export interface TrafficBrain { lane: number; t: number; nextLane: number; inTurn: boolean; turnS: number; stopTimer: number; waitingAtNode: number; reservedNode: number; targetSpeed: number; blockedTimer: number; decideTick: number; honkTimer: number; yieldTimer: number; prevHeadingErr: number }
export interface PoliceBrain { mode: 'PATH' | 'PURSUE' | 'BUST' | 'RETURN'; traffic: TrafficBrain; path: number[]; pathLen: number; pathIdx: number; repathTimer: number; sightTimer: number; bustTimer: number; stuckTimer: number; reverseTimer: number; siren: boolean; returnTimer: number }
export class Vehicle implements Entity {
  constructor(spec: VehicleSpec, x: number, z: number, yaw: number, role: VehicleRole, color: number);
  id: EntityId; readonly kind: 'vehicle'; spec: VehicleSpec; role: VehicleRole; prevRole: VehicleRole; color: number;
  prev: Transform; curr: Transform; vx: number; vz: number;
  speed: number; /* signed forward m/s */ lateral: number; yawRate: number; steerAngle: number; wheelSpin: number; longAccel: number; drifting: boolean;
  controls: VehicleControls; health: number /*100*/; destroyed: boolean; damageFlash: number; smoke: number; wreckTimer: number;
  driverId: EntityId | null; occupiedByPlayer: boolean; brain: TrafficBrain | PoliceBrain | null; ramCount: number;
  lightsOn: boolean; sirenOn: boolean; hornTimer: number; alive: boolean; renderIndex: number; spawnFade: number; sleeping: boolean; idleTimer: number;
  minX: number; minZ: number; maxX: number; maxZ: number; hashStamp: number;
  obb(out: OBB): OBB; updateBounds(): void; snap(): void; forward(out: Vec2): Vec2; applyDamage(d: number): void /* clamps, sets destroyed at 0 */; isPolice(): boolean;
}
export function makeTrafficBrain(): TrafficBrain; export function makePoliceBrain(): PoliceBrain;
```
`sleeping` = parked/abandoned vehicle with |v| < 0.05 for > 1 s: skipped as a collision *initiator* and by physics integration, but still in the dynamic hash so others collide with it; any collision wakes it.

### 2.16 `src/game/entities/Pedestrian.ts`
```ts
export class Pedestrian implements Entity {
  constructor(x: number, z: number, yaw: number, walkNode: number, shirt: number, pants: number, skin: number);
  id: EntityId; readonly kind: 'ped'; prev: Transform; curr: Transform; vx: number; vz: number; vy: number;
  state: PedState; stateTimer: number; walkNode: number; targetNode: number; dir: 1 | -1; speed: number; health: number;
  threatX: number; threatZ: number; fleeTimer: number; tumble: number; fadeTimer: number; alive: boolean; renderIndex: number; spawnFade: number;
  colors: { shirt: number; pants: number; skin: number }; animPhase: number; decideTick: number;
  readonly radius: number /*0.35*/; readonly height: number /*1.75*/;
  circle(out: Circle): Circle; updateBounds(): void; snap(): void; minX: number; minZ: number; maxX: number; maxZ: number; hashStamp: number;
}
```

### 2.17 `src/game/entities/Player.ts`
```ts
export class Player implements Entity {
  id: EntityId; readonly kind: 'player'; prev: Transform; curr: Transform; vx: number; vy: number; vz: number; grounded: boolean; moving: boolean; sprinting: boolean; animPhase: number;
  health: number /*100*/; armor: number /*0*/; money: number /*1000*/; vehicleId: EntityId | null; enterCooldown: number; invulnTimer: number; stumbleTimer: number; alive: boolean; renderIndex: number; spawnFade: number;
  readonly radius: number /*0.4*/; readonly height: number /*1.8*/;
  circle(out: Circle): Circle; updateBounds(): void; snap(): void; minX: number; minZ: number; maxX: number; maxZ: number; hashStamp: number;
  reset(x: number, z: number, yaw: number): void; // full stats reset (new game)
}
```

### 2.18 `src/game/city/CityConfig.ts`
```ts
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
```
Road center lines: `x = c * PITCH + ROAD_W / 2` for c in 0..10 (11 N-S roads); same for z. Block (col,row) occupies
`x0 = ROAD_W + col * PITCH .. x0 + BLOCK`, same for z. Node (col,row) center = `(col*PITCH + ROAD_W/2, row*PITCH + ROAD_W/2)`.

### 2.19 `src/game/city/CityData.ts` (types only)
```ts
export type BuildingStyle = 'artdeco' | 'glass' | 'concrete' | 'neon' | 'residential';
export type District = 'downtown' | 'beachfront' | 'suburb';
export interface Building { id: number; x: number; z: number; w: number; d: number; h: number; style: BuildingStyle; color: number; accent: number; roofKind: 'flat' | 'stepped' | 'spire'; hasNeonSign: boolean; neonColor: number; district: District; facing: 0 | 1 | 2 | 3 /* +Z, +X, -Z, -X */ }
export interface Lot { blockCol: number; blockRow: number; x: number; z: number; w: number; d: number }
export interface Block { id: number; col: number; row: number; x0: number; z0: number; x1: number; z1: number; kind: 'buildings' | 'park' | 'landmark' | 'plaza'; buildings: number[] }
export interface Prop { kind: 'palm' | 'lamp' | 'bench' | 'hydrant' | 'bin' | 'sign' | 'shelter' | 'bollard' | 'tree' | 'hedge' | 'pole' | 'roadsign' | 'dumpster' | 'table'; x: number; z: number; yaw: number; scale: number } // 'tree'/'hedge' round 6, 'pole'/'roadsign'/'dumpster'/'table' round 7
export interface Landmark { kind: 'tower' | 'arena' | 'lighthouse' | 'ferris' | 'hospital' | 'police' | 'pier'; x: number; z: number; yaw: number; w: number; d: number; h: number; name: string }
export interface ParkedSpot { x: number; z: number; yaw: number }
export interface NeonSign { x: number; y: number; z: number; yaw: number; text: string; color: number; w: number; h: number }
export interface NamedPoint { x: number; z: number; yaw: number }
export interface CityData {
  seed: number; buildings: Building[]; blocks: Block[]; props: Prop[]; landmarks: Landmark[]; parkedSpots: ParkedSpot[];
  staticColliders: StaticCollider[]; neonSigns: NeonSign[]; bounds: AABB;
  points: { playerSpawn: NamedPoint; hospital: NamedPoint; policeStation: NamedPoint; pier: NamedPoint; missionStarts: NamedPoint[]; garage: NamedPoint; beachDelivery: NamedPoint };
}
```
Every `points.*` entry MUST be on a sidewalk or plaza (never inside a static collider, never on a lane) — derived from the generated graph, never hard-coded.

Round 4 additions: `ParkedCar { x, z, yaw, spec: 'sedan'|'sport'|'van', colour }` and `LotProp { kind: 'planter'|'island'|'booth', x, z, yaw }`, exported on `CityData` as `parked?` and `lotProps?` (set dressing with colliders, never `Vehicle`s). `CityLots.furnishLots(ctx)` fills the lots after the gameplay spots: kerb islands with planters at both heads of every bay strip, a static car in ~40 % of the free bays (deterministic from the city seed); the gameplay spot, two bays on the driver's exit side and one on the far side, the gate's drive lane and the islands stay free; `CityBuild.addParkedCar/addLotProp` add the AABB colliders. Round 5: `Prop.kind` gains `'tree' | 'hedge'`, `ParkedCar.at: 'lot' | 'kerb'`; `CityProps.furnishStreets` (called from `CityLots.furnishLots`) adds deterministic kerbside parking on the pavement strip (8 cm off the asphalt, outside intersections, crossings, lanes and every furniture/point rect, AABB colliders via `CityBuild.addPropBox`) and round-crown sidewalk trees on downtown/suburb blocks; `CityLots.addLotHedges` screens lot edges from the street.

### 2.20 `src/game/city/RoadGraph.ts` (Track A implements; P0 stubs)
```ts
export interface Occupant { id: EntityId; axis: 0 | 1; straight: boolean; since: number }
export interface RoadNode { id: number; x: number; z: number; col: number; row: number; segments: number[]; outLanes: number[]; inLanes: number[]; stopSign: boolean; occupants: Occupant[]; occupantCount: number }
export interface RoadSegment { id: number; a: number; b: number; axis: 0 | 1 /* 0 = along X, 1 = along Z */; length: number; lanes: number[] }
export interface Lane { id: number; segment: number; from: number; to: number; index: 0 | 1 /* 0 inner, 1 outer */; start: Vec2; end: Vec2; dir: Vec2; length: number; next: number[] /* successor lane ids */; nextKind: ('straight' | 'right' | 'left')[]; speedLimit: number; axis: 0 | 1 }
export interface LanePos { lane: number; t: number /* meters along lane from start */ }
export class RoadGraph {
  readonly nodes: RoadNode[]; readonly segments: RoadSegment[]; readonly lanes: Lane[]; readonly cols: number; readonly rows: number;
  static build(cols: number, rows: number, pitch: number, roadW: number, laneW: number, lanesPerDir: number, intersectionR: number, rng: Random): RoadGraph;
  nodeAt(col: number, row: number): RoadNode; nearestNode(x: number, z: number): RoadNode;
  nearestLane(x: number, z: number, out: LanePos): LanePos;                 // per-segment bucketing, no scan of all lanes
  pointOnLane(laneId: number, t: number, out: Vec2): Vec2; laneDir(laneId: number): Vec2;
  turnPoint(fromLane: number, toLane: number, s: number, out: Vec2): Vec2;  // quadratic bezier from.end -> ctrl -> to.start; ctrl = intersection of the two lane lines
  turnLength(fromLane: number, toLane: number): number;                     // precomputed 8-sample polyline length
  findPath(fromNode: number, toNode: number, out: number[]): number;        // A*, returns count; out[0..count) node ids incl. both ends
  lanePathFromNodePath(currentLane: number, nodePath: number[], nodeCount: number, out: number[]): number; // successor lanes leading node to node
  canEnter(nodeId: number, id: EntityId, axis: 0 | 1, straight: boolean): boolean; // rule below
  reserve(nodeId: number, id: EntityId, axis: 0 | 1, straight: boolean, now: number): boolean; // canEnter && add occupant (idempotent per id)
  release(nodeId: number, id: EntityId): void; releaseAll(id: EntityId): void;
  expireReservations(now: number, timeout: number): void; // 4 s
  randomLanePos(rng: Random, out: LanePos): LanePos;
  lanesInRing(cx: number, cz: number, rMin: number, rMax: number, out: number[]): number; // lanes whose midpoint is in the ring; returns count
}
```
Reservation rule: a vehicle may enter node N if N has no occupants, or if the vehicle goes straight and every
occupant goes straight on the same axis (same-axis straight traffic never conflicts). Turns require an empty node.
Reservations expire after 4 s (`expireReservations` is called once per tick by TrafficSystem). Police may evict an
occupant that has held the node for > 1.5 s (`reserve` with police id after `release` of the stale one — Track F).

### 2.21 `src/game/city/SidewalkGraph.ts` (Track A; P0 stubs)
```ts
export interface WalkNode { id: number; x: number; z: number; block: number; corner: boolean; loopNext: number; loopPrev: number; crossings: number[] }
export class SidewalkGraph {
  readonly nodes: WalkNode[]; readonly loops: number[][]; // one loop per block: 4 corners + 2 per edge = 12 nodes; plus one beach promenade loop
  static build(blocks: Block[], roadW: number, sidewalkW: number, beach: { x: number; z0: number; z1: number } | null): SidewalkGraph;
  randomNode(rng: Random): WalkNode; nearestNode(x: number, z: number): WalkNode;
  nodesInRing(cx: number, cz: number, rMin: number, rMax: number, out: number[]): number;
  nextNode(current: number, direction: 1 | -1, rng: Random, crossChance: number): number; // returns node id; may cross at corners
}
```
Walk nodes sit on the sidewalk center line: `SIDEWALK_W/2` outside the block edge. Corner nodes of adjacent blocks
are linked as crossings straight across the road.

### 2.22 `src/game/city/CityGenerator.ts` (Track A; P0 stubs)
```ts
export interface GeneratedCity { city: CityData; roads: RoadGraph; sidewalks: SidewalkGraph }
export function generateCity(seed?: number): GeneratedCity;
export function validateCity(g: GeneratedCity): string[]; // returns human-readable invariant violations (empty = OK); used by tests and by Engine in ?debug
```

### 2.23 `src/game/city/Palette.ts` (P0)
```ts
export const PASTELS: number[]; export const NEONS: number[]; export const DOWNTOWN_COLORS: number[]; export const SUBURB_COLORS: number[];
export const SHIRTS: number[]; export const PANTS: number[]; export const SKINS: number[];
export const VENUE_WORDS: readonly string[]; // what a whole building puts on its roof: 'OTEL','TURUNCU','MAVİ','CLUB','MALİBU','PLAJ','CASINO','DİSKO','GAZİNO','TAVERNA','PLAZA','MARİNA' (12)
export const SHOP_WORDS: readonly string[];  // what one unit at street level sells: 'KAHVE','KEBAP','BAR','LOKANTA','PASTANE','BAKKAL','MEYHANE','ÇAY EVİ','BERBER','ECZANE','MARKET','PİDECİ','DÖNER','BALIKÇI','HAMAM','MANAV','SİMİT','BÜFE','KUAFÖR','ŞARKÜTERİ' (20)
export const SIGN_WORDS: readonly string[];  // = [...VENUE_WORDS, ...SHOP_WORDS]; the neon atlas' word list. HARD CEILING 32 WORDS:
// TextureFactory.neonAtlas lays it out in columns of at most ATLAS_ROWS = 16, and a third column shrinks every glyph.
// Rooftop / facade neon (CityLots.makeSign) draws from VENUE_WORDS only, the painted blank-wall signs from SHOP_WORDS
// (BuildingGeometry emits the index, CityRenderer looks it up), so a seafront hotel never gets a barber's name.
export function pickStyle(district: District, rng: Random): { style: BuildingStyle; color: number; accent: number; roofKind: Building['roofKind'] };
```

### 2.24 `src/game/world/World.ts` (P0, complete)
```ts
export interface WantedState { stars: number; heat: number; lastSeenTimer: number; lastCrimeTimer: number; flash: number; sirenActive: number }
export interface MissionState { activeId: string | null; activeTitle: string | null; step: number; timer: number; timeLimit: number; elapsed: number; objective: string | null; markerX: number; markerZ: number; markerVisible: boolean; missionVehicleId: EntityId | null; cooldowns: Record<string, number>; completed: Record<string, number> }
export interface HudSignals { prompt: string | null; hitFlashAt: number }
export class World {
  constructor(gen: GeneratedCity, rng: Random);
  city: CityData; roads: RoadGraph; sidewalks: SidewalkGraph; rng: Random;
  player: Player; vehicles: Map<EntityId, Vehicle>; peds: Map<EntityId, Pedestrian>; vehicleList: Vehicle[]; pedList: Pedestrian[];
  staticHash: SpatialHash<StaticCollider>; dynamicHash: SpatialHash<Entity>;
  time: { hour: number; tick: number; elapsed: number; dayLengthSec: number }; wanted: WantedState; mission: MissionState; hud: HudSignals; phase: GamePhase;
  beginTick(): void;                               // copy curr -> prev for all entities; time.tick++
  addVehicle(v: Vehicle): Vehicle; removeVehicle(id: EntityId): void; addPed(p: Pedestrian): Pedestrian; removePed(id: EntityId): void;
  playerVehicle(): Vehicle | null; playerPos(out: Vec2): Vec2; playerYaw(): number; playerSpeed(): number;
  rebuildDynamicHash(): void;
  hasLineOfSight(ax: number, az: number, bx: number, bz: number): boolean; // segment vs 'building'/'landmark' colliders only
  countByRole(role: VehicleRole): number;
  reset(): void;                                   // removes all dynamic entities, resets player/wanted/mission/hud/time, keeps city
}
```

### 2.25 `src/game/systems/System.ts` (P0)
```ts
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
export function stubCamera(): CameraLike; export function stubAudio(): AudioLike; // for headless tests
```

### 2.26 System order (Engine ticks exactly this)
`DayNightSystem → PlayerMoveSystem → VehicleEntrySystem → TrafficSystem → PoliceSystem → PedestrianSystem → VehiclePhysicsSystem → CollisionSystem → WantedSystem → MissionSystem → HudPublisher`.
`World.beginTick()` runs before the first system; `input.endTick()` after the last.
Render frame: `CameraController.update(alpha, frameDt)` → `SkySystem.update(...)` → renderers `sync(world, alpha, ...)` → `EffectsRenderer.update` → `renderer.render()`. Audio is updated in the render frame (`AudioSystem.frameUpdate(frameDt)`).

### 2.27 Engine public API (P0 minimal, I completes) `src/game/Engine.ts`
```ts
export interface EngineOptions { autostart?: boolean; hour?: number; quality?: 'low' | 'high'; seed?: number; debug?: boolean }
export class Engine {
  constructor(canvas: HTMLCanvasElement, store: GameStore, options?: EngineOptions);
  readonly world: World; readonly events: EventBus; readonly store: GameStore; readonly loop: GameLoop; readonly input: Input; readonly minimap: MinimapRenderer | null;
  init(): Promise<void>;    // generate city, build renderers; resolves after the first rendered frame; store.loading true→false
  newGame(): void;          // world.reset(), spawn parked cars/player, phase 'playing', request pointer lock, audio unlock
  pause(): void; resume(): void; toMainMenu(): void; respawn(): void; setPhase(p: GamePhase): void;
  applySettings(s: Partial<Settings>): void; toggleMute(): void;
  getMinimapSnapshot(): MinimapSnapshot;  // pooled
  getDebugStats(): DebugStats;
  dispose(): void; readonly disposed: boolean;
}
export function parseEngineOptions(search: string): EngineOptions; // ?autostart=1&hour=19&quality=low&seed=7&debug=1
```
`window.__GAME_DEBUG__ = () => ({ ...getDebugStats(), phase, playerX, playerZ, errors: string[] })` is installed by GameCanvas
(errors = captured `window.onerror` messages). The screenshot harness reads it.

Phase machine: `menu` (loop running, sim paused, cinematic camera) → `newGame()` → `playing` → Esc or pointer-lock loss → `paused`
(sim paused, render continues) → `resume()` → `playing` (sets phase unconditionally, then re-requests pointer lock; if it fails,
HUD shows `Devam etmek için tıkla` and Q/R camera stays active). `wasted`/`busted`: loop.timeScale 0.3 for 2 s then sim paused;
`respawn()` after 3 s or on click. Esc events within 300 ms of a pointer-lock change are ignored (debounce).

### 2.28 Minimap snapshot `src/game/minimap/MinimapRenderer.ts` (Track A)
```ts
export type BlipKind = 'player' | 'vehicle' | 'police' | 'mission' | 'objective' | 'hospital' | 'policeStation' | 'garage';
export interface Blip { kind: BlipKind; x: number; z: number; yaw: number }
export interface MinimapSnapshot { px: number; pz: number; pyaw: number; camYaw: number; blipCount: number; blips: Blip[] /* preallocated 160 */; wanted: number; hasObjective: boolean; objectiveX: number; objectiveZ: number; inVehicle: boolean }
export function createMinimapSnapshot(): MinimapSnapshot;
export class MinimapRenderer {
  constructor(city: CityData, roads: RoadGraph, pxPerMeter?: number /* 0.5 */);
  readonly base: HTMLCanvasElement; // pre-rendered city
  draw(ctx: CanvasRenderingContext2D, snap: MinimapSnapshot, sizePx: number, rangeM: number, rotate: boolean): void;
  dispose(): void;
}
```

---

## 3. Track P0 — Core skeleton (one engineer; blocks everything)

Create every file in section 2 exactly. Additionally:
- `src/game/render/Renderer.ts`: `class Renderer { constructor(canvas, settings); scene; camera /* fov 56, near 0.3, far 900 */; gl; resize(); render(); applySettings(s); adapt(fps, frameDt); setBloomForNight(nightFactor); setGrade(nightFactor, duskFactor, time); sceneBreakdown(); readonly drawCalls; readonly triangles; dispose() }`. On `high` the frame goes through an EffectComposer on a 4x MSAA HalfFloat target: RenderPass → UnrealBloom (HDR-only: threshold 3.0 by day, 1.4 at night) → OutputPass (ACES) → grade (saturation 0.92, lifted toe, split tone that peaks at dusk, fine grain). Fog is owned by `SkySystem`.
  `powerPreference 'high-performance'`, antialias on 'high', pixelRatio min(devicePixelRatio, high 1.5 / low 1), `outputColorSpace = SRGBColorSpace`, ACESFilmic tone mapping exposure 1.0, shadows only on high (PCFSoft 2048). Resize observes the canvas parent.
- `src/game/render/CameraController.ts` (minimal orbit; Track C replaces): implements `CameraLike`, `update(alpha, frameDt)`, mode `'orbit' | 'chase' | 'cinematic'`.
- `src/game/Engine.ts` (minimal): full phase machine, loop, input wiring, pointer lock handling, `?autostart` option, systems array (initially `[]` plus HudPublisher-less direct store patches every 6 ticks for phase/health/money/clock), render pipeline (ground plane 1300×1300 grey, a 2 m orange box for the player, a hemisphere light, sky color), `getDebugStats`, `getMinimapSnapshot` returning a pooled snapshot with the player only. `newGame()` resets the world and places the player at `city.points.playerSpawn`.
- City stubs: `RoadGraph.build` returns a graph with correct node/segment/lane **counts and coordinates** for the grid (so downstream work has real coordinates) but may leave `next` empty and path/reservation methods trivial. `SidewalkGraph.build` returns one loop per block with 12 nodes at correct coordinates. `generateCity` returns blocks + 12 test building AABB colliders around the spawn + `points` on sidewalks, empty props/landmarks/parked spots. `validateCity` returns `[]`. Mark every stub body with `// STUB(Track A)`.
- `src/game/index.ts` barrel; `src/components/game/GameCanvas.tsx`: creates GameStore + Engine once (ref guard, StrictMode-safe), full-screen canvas, provides `GameStoreContext` and `EngineReactContext`, calls `engine.init()`, installs `window.__GAME_DEBUG__`, renders `children` over the canvas. Shows a plain `Yükleniyor...` overlay until `loading` is false. If `?autostart=1`, calls `newGame()` after init.
- `src/pages/Index.tsx` → `<GameCanvas><GameOverlay/></GameCanvas>`; until Track D lands, P0 ships a placeholder `src/components/game/GameOverlay.tsx` with a `Başla` button that calls `engine.newGame()` (Track D replaces it).
- `src/App.tsx`: route `/` → Index, `/rendertest` → the render sandbox, `*` → NotFound. `index.html` title `BAS İstanbul`, description in Turkish.
- `src/index.css`: add `html, body, #root { height: 100%; margin: 0; overflow: hidden; background: #050308 }` and a `.game-font` utility using `'Trebuchet MS', 'Segoe UI', system-ui, sans-serif` with `font-weight: 800; letter-spacing: 0.04em`.
- Test runner: `scripts/run-tests.ts` (runs every `scripts/tests/*.test.ts` and `*.sim.ts`, optional substring filter arg, exits 1 on failure, prints per-test timing) and `scripts/tests/harness.ts`:
  ```ts
  export function test(name: string, fn: () => void | Promise<void>): void; export function expect(cond: unknown, msg: string): asserts cond;
  export function approx(a: number, b: number, tol: number, msg: string): void;
  export interface Headless { world: World; ctx: EngineContext; input: Input; systems: System[]; step(n?: number): void /* beginTick, systems, endTick, elapsed */; secs(s: number): void }
  export function createHeadless(opts?: { seed?: number; systems?: (ctx: EngineContext) => System[]; hour?: number }): Headless; // stub camera/audio, real Input (unattached), real store, generateCity
  ```
  `package.json` scripts: `"test": "tsx scripts/run-tests.ts"`, `"test:unit": "tsx scripts/run-tests.ts .test"`, `"test:sim": "tsx scripts/run-tests.ts .sim"`, `"typecheck": "tsc -p tsconfig.app.json --noEmit"`, `"shot": "node scripts/screenshot.mjs"`.
- Acceptance: typecheck + lint clean; `npm test` runs (0 tests is fine); `?autostart=1` renders ground + orange box; a Playwright screenshot shows it; no console errors. The AO pass is `FoliageAwareGTAOPass` (Renderer.ts): its normal/depth prepass hides alpha-tested, alphaToCoverage and transparent meshes (palm fronds, shelter glazing, road-mark decals), because the override material has no alpha test and a cut-out frond would otherwise occlude as a solid dark quad.

---

## 4. Track A — City data, graphs, minimap

Implements `RoadGraph`, `SidewalkGraph`, `CityGenerator`, `MinimapRenderer` per 2.18–2.22 and 2.28.

**Blocks**: 10×10. `LANDMARK_BLOCKS` → kind `landmark`; park → `park`; `PLAZA_BLOCKS` → `plaza` (open paved block with a fountain circle collider r 5 in the center, 8 benches, 12 palms; mission start markers go on `points.missionStarts` = the plaza's sidewalk mid-edge nodes, one per plaza block); everything else `buildings`.

**Lots and buildings**: per `buildings` block choose 2×2 (p .45) or 3×3 grid, merge adjacent lot pairs with p .35 (max 2 merges), inset 2 m from the block edge, 1.5 m gaps (use 2.5 m gaps in downtown so cars cannot wedge). Footprint = lot shrunk 0–15 %. Heights: downtown `30 + rng²·90` (5 % → 120–150), beachfront (last 2 columns) 10–28 with `stepped` roofs 60 %, suburb 8–22. Styles via `pickStyle`. `facing` = the block edge nearest the lot. Buildings with `h > 14` in beachfront/neon style get a `NeonSign` on the road-facing facade (`y` = 6..h−2, `w` 8–14, `h` 2.2). Target 300–400 buildings.

**Landmarks** (`w,d,h` are the collider footprint; renderer builds shapes): `tower` (Turuncu Kule, 40×40, h 160), `arena` (150×90 ellipse footprint expressed as an AABB collider 150×90, h 28), `hospital` (60×60×24, name `Hastane`), `police` (60×50×18, name `Polis Merkezi`), `lighthouse` (r 5, h 35, on the beach at the north end: x = BEACH_X0+45, z = 40), `pier` (12×120, from x = OCEAN_X0−10 eastward at z = 590, walkable: no collider on the deck, two rail AABBs), `ferris` (r 18 at the pier end).
`points`: `playerSpawn` = sidewalk mid-node of the beachfront block (8, 5) facing the road; `hospital` = sidewalk mid-node in front of the hospital block; `policeStation` likewise; `pier` = deck start; `garage` = sidewalk mid-node of block (7, 2); `beachDelivery` = a promenade node near the pier. All must pass `validateCity`.

**Props**: lamps every `LAMP_SPACING` along every segment on both sidewalks (staggered 16 m), 1 m from the curb, never within 14 m of a node; palms: promenade every 12 m (two rows at BEACH_X0+4 and +14), 3 per block edge in the beachfront district, 40 in the park, 12 per plaza; benches in park/plazas. Collider circles: palm r 0.35, lamp r 0.2 (tag `prop`). Expect ~1200 lamps, ~500 palms.

**Parked spots**: `BUDGET.PARKED` spots on outer-lane curbs (center 1.2 m inside the curb line), yaw = lane dir, ≥ 18 m from any node, ≥ 9 m apart, none inside a collider, preferring beachfront/plaza segments (so the player sees cars within 30 m of spawn: guarantee ≥ 3 spots within 40 m of `playerSpawn`).

**Static colliders**: buildings (AABB, tag `building`, height h), landmarks (tag `landmark`), props (circle, `prop`), fountain (circle r 5, `landmark`), ocean (`water` AABB x ≥ OCEAN_X0+6), boundary walls 10 m thick just outside the city on N/S/W and beyond the beach at x = OCEAN_X0+6.

**RoadGraph**: 121 nodes, 220 segments, 880 lanes. Lane offsets from the road center: inner `0.5·LANE_W`, outer `1.5·LANE_W` to `right2D(dir)`. Lanes trimmed by `INTERSECTION_R` at both ends. Successors at node `to`: straight (same index on the continuing segment), right (outer lane of the right segment), left (inner lane of the left segment); U-turn only at dead ends (edge/corner nodes with a single continuation). `stopSign = rng.chance(0.5)` for interior nodes, false on the border. `nearestLane` buckets lanes by segment: segment lookup from `floor(x/PITCH)`, `floor(z/PITCH)` and which side of the block the point is on.
**SidewalkGraph**: loops per block as in 2.21 + a beach promenade loop (x = BEACH_X0+2, from z = 20 to 1160, nodes every 24 m, both directions), linked to beachfront block corners by crossings.

**MinimapRenderer**: base canvas 0.5 px/m: ocean `#0d3b5c`, sand `#d8c48a`, blocks by district (`#1c2530` downtown, `#2a2238` beachfront, `#202a24` suburb), park `#2f5d3a`, plazas `#3a3346`, roads `#5c6470` (ROAD_W wide), landmarks tinted + short Turkish labels (`Kule`, `Arena`, `Hastane`, `Polis`, `Park`, `İskele`). `draw()`: clip circle, rotate by −camYaw when `rotate`, draw a window of `rangeM` radius around `(px,pz)`, then blips: traffic vehicles 3 px grey dots, police alternating red/blue 4 px, mission markers orange 5 px rings, objective yellow diamond clamped to the rim with an arrow, hospital `H` white on red, police station `P` white on blue, garage `G`; player = white triangle at center rotated by `pyaw` (relative to map rotation); north arrow `K` at the rim.

**Tests** (`scripts/tests/city.test.ts`): counts; every lane has ≥ 1 successor and every successor starts within 25 m of the lane end; `findPath` corner-to-corner returns 21 nodes; `lanePathFromNodePath` is continuous; every walk node has valid loopNext/loopPrev and every corner ≥ 1 crossing; `validateCity(generateCity())` is empty; every `points.*` and every parked spot is ≥ 0.6 m from all colliders and not within a lane's rectangle; reservation rule truth table; determinism (two generations with the same seed produce identical JSON).

---

## 5. Track B — Rendering foundation, sky, day/night, effects

**`TextureFactory`** (class, cached by key, all CanvasTexture, correct `colorSpace`/wrap/mipmaps, canvases opened with `willReadFrequently`): `windows(style, seed)` → `{ map, emissive, normal, rough }` drawn in a 1024×2048 design space (64 px/m; residential/concrete/artdeco at full size, curtain-wall glass/neon at 1024×1024 through a scaled context), 4 columns × 8 rows per tile so one tile = 16 m × 28 m (UVs in meters: u = x/16, v = y/28; roofs get flat colour via a plain strip at v > 0.99); per-cell variety (blinds at random heights, one/two-sided curtains, dark and cool rooms, sill plants, AC units under ~20 % of sills, balcony parapets on residential, alternating spandrel tones on glass) and a baked sky-to-slate reflection with a rooftop horizon band on the glass style; the normal map comes from a structure-only canvas (frames, sills, mullions, piers, spandrels) via `normalFromLuminance` (high-pass R=8, Sobel), the roughness map from `roughFromLuminance` (glazing floor 0.26); 1 px highlights are 3 px feathered strokes plus a 1 px soften before upload. `shopfront()` a 3-row 2048×1152 atlas of whole 6 m bays (`SHOP_BAY_W`), 12 kinds (MANAV, BERBER, KAHVE, KEBAP, BAKKAL, SİMİT, LOKANTA, KUAFÖR, ECZANE, BUTİK, MARKET, shuttered/KİRALIK), 0.78 m fascia with 0.45 m letters, value-only fascia families tinted per bay by `BuildingGeometry.fasciaPalette` (wall hue + accent + cream/charcoal), `ShopBay` carries the door offset for the geometric 0.6 m recess; `windows()` is a CLEAN tile of flat colour fields (frame colour, glass tone, blinds/curtain variation, lit/dark interiors; no painted bevels, fake reveals, grime or 1-px noise — depth comes from `FacadeDetailRenderer`) with a shuffled per-tile variant deck so no two cells match; exports `WINDOW_CELL` / `WINDOW_CELL_FRAME_PX`. `asphalt()/road()/crosswalk()/lotAsphalt()` are a bitumen bed carrying two SIGNED aggregate fields (`aggregate`: 4.7 m down to 0.16 m, deliberate tone, never speckle), reinstatement patches and paving seams (`asphaltPatches`), gutter lines and polished wheel bands, plus crisp paint and edge-only wear (`wearPaint`); `roadMarks()` adds the `MARK_UV.line/stop` strips; shop interiors are 3 shelf bands with 6-8 large blocks, a counter and a back wall, no grime with painted interiors dimmed through the glass in the albedo and warm-lit in the emissive, a pier every 4 m so the arcade columns line up; `plinth()` downtown lobbies (4-5 m bays, pale stone piers, tall glazing with a baked warm interior, one double-door entrance bay with a lit number per tile, stone base course); `awningTex()` striped canvas; `road()` / `sidewalk()` 1024 px tiles with `roadRough()`; `lotAsphalt()` / `lotRough()` (off-street parking: the road's bitumen and reinstatements without the lane paint, half-resolution relief); `groundPatch()` (256 px, six quantised tone plates, built from a value-noise field CENTRED on mid grey — `Materials.macroVariation` applies it SIGNED, so the default centre of 1 clips 43 % of the field flat at white and lifts every paved surface ~12 %); `mipChain()` / `cellMipChain()` detail-preserving mip chains and `GROUND_ANISO` on the ground families; `roadMarks()` decal atlas; `crosswalk()`; `sand()`; `water()`; `grass()`; `plaza()`; `neonAtlas(words)` one 512×1024 atlas laid out in columns of at most 16 words (so a longer word list costs atlas width, not glyph height: ~40-50 px rows either way; returns per-word UV rects); `palmFrond()` 256×512 alpha (34 leaflet pairs, lit/shaded halves, vein) with `bleedAlpha` mip fringe fix; `palmBark()` 128×512; `clouds()`; `radialGlow()`; `starField()` 1024×512; `policeLivery()`; `grime()` / `bleedAlpha()` helpers; `dispose()`. Texture memory after round 9 ≈ **113 MB** of GPU RGBA including mip chains (53 textures, five window styles at one seed — measured in-page by walking the factory cache, `scratchpad/pw/texmem.mjs`; the old "≈ 84 MB" predates the ground mip chains and the `lotAsphalt` family) plus ≈ 23 MB of CPU mip canvases that three keeps alive for the ground families. Build cost is main-thread and blocking: the zero-arg builders sum to ≈ 1.03 s in the headless harness (road 242 ms, lotAsphalt 172, crosswalk 151, sidewalk 99), boot to first frame ≈ 7.0 s there; the `noiseWash` destination canvas is pooled (`washField`) and the paired washes share one `getImageData`/`putImageData`, which is worth ~85 ms of that. A half-resolution fallback for `low` is still open.

**`Materials`**: MeshStandardMaterial for everything lit, roughness/metalness/envMapIntensity per surface from the `SURF` table (buildings with `vertexColors`, `map` + `emissiveMap` + `normalMap` (normalScale 0.45; shopfront 0.6, plinth 0.7) + `roughnessMap` windows, glass style envMapIntensity 1.2; `macroVariation()` onBeforeCompile tiling break); roads/sidewalk/sand/grass/plaza Standard with roughness maps, `applyNight()` lowers road roughness (day 0.85 → night 0.6) for wet-look reflections, and `crosswalk` (junction tiles) and `lotAsphalt` take the road's roughness VALUE as well as its `roughnessMap`/`groundNormal('road')` — they meet the carriageway along a straight kerb line the width of the frame, so any difference there is a tone step, not a variation; `roadMark` alpha-tested decal; water MeshPhongMaterial (shininess 80, opacity .92, uv scroll in `update(t)`); `furniture` vertex-coloured Standard for all props; `awning` striped canvas; `palmTrunk` / `palmFrond` (FrontSide, alphaTest 0.34, alphaToCoverage); `glass()` transparent Standard (shelter panes); `neon(atlasTex)` MeshBasicMaterial `fog=false toneMapped=false transparent` with opacity = night factor (min 0.15 by day); `lampHead()`, `lightPool()` additive MeshBasic `fog=false depthWrite=false`; `marker(color)` additive; `setNight(f)` drives all of the above. Expose `readonly nightFactor`. Vehicle paint lives in `VehicleRenderer` (MeshPhysicalMaterial clearcoat with a `paintMix` vertex patch). Palms: tint 0x7fa050, `PALM_ALPHA_RAMP` onBeforeCompile patch (alpha ramped ±0.08 around alphaTest so distant fronds stay solid), emissive faded to zero at night in `applyNight`. Round 6: `FOLIAGE_NIGHT_DIM` 0.55 darkens the `foliage` material (tree crowns/trunks, hedges, far palm LOD) after dark like `palmFrond`; `PALM_ALPHA_DIST` boosts frond alpha with view distance (from 12 m, ×2.6 by 45 m) so a distant crown never reads as the sky behind it; leaf specular patch and night roughness 0.97. Round 8-9: the `foliage` material carries the leaf albedo (`PropTextures.leafTexture`, a leaf-coloured multiplier — mean luma 0.45, NOT a near-white wash) triplanar-mapped in world metres / `LEAF_TILE_M`, and a **`leafMix` float vertex attribute is part of the contract**: the foliage batch carries whole trees, so every geometry in it must set 1 on leaves and 0 on bark (`leafMixAttr` in `CityRendererProps`) or the leaf map and the translucency emissive print themselves on trunks, boles and limbs.

**`BuildingGeometry`**: `GeoBuilder` (vertex colour + baked vertex AO in `vertex()`: AO_HEIGHT 6, AO_FLOOR 0.5; `boxFaces` masked box, `cornice` two-step (0.15 m fillet + 0.35 m slab with soffit ring, 13 quads), `chamferTop`, `frustum`, `texQuad`). `appendBuilding(gb, b, rng, y0?)` — massing from `massingOf()` (`'box' | 'tiers' | 'setback' | 'octagon' | 'podium' | 'twin'`) positioned at world coordinates, **UVs in meters** per face (u along the face width / 16, v = height / 28), vertex colour = `b.color` (roof slightly darker); towers > 42 m get their top 2 m chamfered at 45° (frustum for the octagon shaft) with the cornice and a darker string band at the chamfer foot; only the neon style keeps a glow strip at the crown. `appendBuildingDetail(…, streetFaces, bandTop)` adds street-face relief: a spandrel ledge under every window row (0.12 m proud, 0.25 m tall) and a pier on every 4 m bay line (0.18 m proud) for downtown / glass / concrete, aligned to the window texture grid; piers on podium/setback tower shafts; residential balconies (1.6 × 0.42 × 0.12 m slab + rail panel) on alternate bays of the rows with painted rails. `appendStreetLevel(styleGb, bandGb, b, rng, plinthStyle, streetFaces)` — shopfront band recessed 0.35 m behind corner and 6 m bay columns (`ARCADE`), cap underside as the arcade soffit, windowed walls start at the arcade ceiling; plinth (downtown) band stays flush; awnings one slope + valance quad pair per shop in a dedicated awning builder (u along the span, 4 m repeat, one tint per awning). `landmarkGeometries(l: Landmark)` returns `{ geometry, style }[]` (tower: 3 setbacks + spire; arena: 32-segment elliptical cylinder with ribbed boxes; hospital: white box + red cross; police: box + blue band; lighthouse: striped cylinder; pier: planks + posts; ferris: torus + 12 spokes + 12 gondola boxes in a `Group` exposed separately for rotation). Exports `FACE` bits, `ARCADE`, `bandHeight()`, `hasCrown()`. Street-level variety: every building/face starts the shop band at a different bay (bay-snapped `uOff` from `b.id`), awnings are per bay (8-colour palette indexed by building + bay, about one in three bays skipped, occasional flat box canopy, jittered drop), long street faces shift the wall tint every 2-3 bays and neighbours get a stable hue/value perturbation from `b.id`; the plinth entrance bay gets a 2.5 m canopy slab on two posts with planters/bollards. Round 5: `Outline` polygons (chamfer/offset/edges) and `footprint()` drive `prism`/`corniceOutline`/`frameOutline`/`polyCap`, so 2.2-3 m 45° chamfers on residential/artdeco street corners carry through band, cap, columns, cornice and parapet; `layoutFace()`/`bandRows()`/`facade()` lay every wall out as bay-snapped segments × 4-row vertical bands with hashed whole-cell u/v offsets, inner segments of street faces > 40 m jogged −0.7…−1.0 m with reveals and soffits, one bay in three recessed 0.3 m, 0.25 m floor slabs on every row line (residential/artdeco/suburb concrete), balconies (slab + bar + 3 posts) on all street faces; parapets 1.0-1.2 m with a 0.12 m coping; `Massing` carries a per-tower window grid (16 / 12 slender / 20 m or 2-storey rows). `appendBuilding` takes the street mask. Shop band: whole 6 m bays stretched per face, per-face bay permutation, 0.6 m recessed door cells, full-bay awnings on ~half the bays (0.8 m slope + 0.4 m valance, 1 in 4 a box canopy). Round 6 — the facade is built, not painted: `facadeUnits()` lists every painted window cell on a street face plus balconies (4 of 5 flush bays, every floor above the band), AC condensers (1 in 6 sills) and downpipes (per segment line and face end) as a compact `FacadeCellList` (`CELL_KIND`, `CELL_STYLES`, `cellCode`), with `FacadeKeepOut` rects from the neon signs; static balconies are gone (the flat tile is the far LOD). `bandRows` no longer maps the tile's ground row onto upper bands. `DOOR_RECESS` is 1.2 m with a `doorLeaf()` and threshold.

**`CityRenderer`**: `constructor(scene, city, roads, materials, tex)`, `build()`, `update(time, nightFactor, playerX, playerZ)`, `dispose()`. Draw-call plan: buildings merged **per style** with `BufferGeometryUtils.mergeGeometries` (style meshes + trim (receiveShadow off) + glow + shop band + plinth band + awning mesh; `frustumCulled` on, bounding spheres computed); `streetFaces()` bitmask per building (faces within `STREET.bandMaxSetback` of the block edge) decides where relief, columns and balconies go; landmarks ≤ 12 meshes; roads: one merged mesh of segment planes + one merged mesh of intersection squares (crosswalk texture) + road-mark decals; sidewalks one merged mesh of curb boxes (`CURB_H`), lots with kerbs; ground plane (dirt), park/plaza planes, beach sand plane, ocean plane 3000×3000 at y −0.3; props via `CityRendererProps` (one InstancedMesh per part, 14 draws): palms 2 seeded variants (lean/height) with fronds of 6 rows drooping parabolically from the base on a 0.25 m V midrib, 14-16 live fronds with jittered yaw/pitch, a fibrous bulb crown and a small dead skirt; lamps (10-sided pole with base collar, 4-station swept gooseneck arm, rounded head, additive light pool + facade spill quads); slatted benches with cast-iron ends; chamfered 12-16-segment bins / bollards / hydrants; rounded-blade street signs; bus shelters (round posts, rounded roof slab with fascia lip, thin-framed `glass()` panes as their own instanced mesh, slatted seat). `PROP_RANGE` packs only nearby instances and repacks after 15 m of camera movement. Neon signs: one merged mesh with the atlas material; ferris wheel group rotating 0.15 rad/s; lighthouse beam sprite rotating at night. Static draws ≈ 52 at noon; whole frame < 120. Neon/wall signs (`buildNeon`) sit on a dark backing box 0.25 m proud of the wall with two brackets and the glyph quad 5 cm in front; the emissive multiplier is ~1.5 (large signs dimmer) so letters stay legible instead of blooming. Round 5 props (`CityRendererProps`): per-instance y, near/far LOD split with shared-mesh cursors, tree (trunk lathe + faceted crown, `foliage` material), hedge units, kerb parked shells (`PROP_RANGE.kerb` 135, `tree` 120, `hedge` 100) and a flat-shaded solid palm-frond LOD beyond 60 m. **`BackdropRenderer`** (new): a lit, fogged ring of low hills plus a ground skirt at ~1.5× the city radius in `materials.plain`, one merged mesh, constructed by Engine and RenderTest, `dispose()` only. **`FacadeDetailRenderer`** (round 6, wired from CityRenderer, +1 draw): window frames (head + jambs 0.15 m proud, dark reveals) and 0.22 m sills, railed/solid balconies, AC units and downpipes as unit geometries in ONE `THREE.BatchedMesh` (`materials.facade`, `perObjectFrustumCulled`, `sortObjects = false`), packed for buildings within `FACADE_RANGE` of the player and repacked after 15 m of movement without allocating (per-cell geometry ids are precomputed); back-facing walls and cells above the 6th floor beyond 30 m are skipped. Requires `WEBGL_multi_draw` (three 0.185 has no fallback). Bay lines and stop bars use the dedicated `MARK_UV.line/stop` atlas strips (no mip bleed from the arrow cells); `NEON.backing` is 0.42 m so the floor slabs never z-fight the sign box. Round 6: every prop part that shares a material lives in ONE `THREE.BatchedMesh` per material (furniture, foliage, parked shells, palm trunks, palm fronds — five batches; `setVisibleAt` does the PROP_RANGE culling, per-instance colour keeps the parked paint), hedges are 3-4 variants with noisy tops joined into low continuous runs with colour/scale jitter, tree crowns come from 3 seeds with 4-6 lobes, scale 0.8-1.3 and hue jitter at irregular spacing (`CityProps`). Round 7-9 — the prop pass is no longer the five batches above: the static parked cars are a three-tier ladder over **seven** batches, `prop:parkedNear` holding `NEAR_CARS.cap` = **3** cars within `NEAR_CARS.range` = **8 m** at the full `parkedNearGeometry` body loft and `prop:parkedMid` holding `MID_CARS.cap` = **16** within `MID_CARS.range` = **32 m** at `parkedMidGeometry` (~980 tris: real arch fenders, greenhouse pillars, lamp cells, 12-sided shouldered tyres), with the coarse shell of every car either band took hidden while it is up. The coarse shell itself carries no fake arch band any more (removed round 9: 64 tris a car paid three times a frame for a crescent that is sub-pixel past 60 m). Both capped bands are re-picked on their OWN cadence, `CAR_TIER_MOVE` = 1.5 m of camera travel, not on the 15 m `PROP_RANGE.repackMove` — a band 8 m wide cannot be assigned on a 15 m cadence — and a re-pick hands the previous picks' coarse shells back first, so nothing is ever drawn twice or lost; the utility-pole catenaries are one `THREE.LineSegments` repacked by range, the lamp's facade spill quad is GONE, and `PropRenderer` adds `LAMP_LIGHTS.count` = **3 permanent `THREE.PointLight`s** to the scene (140 cd, distance 30, decay 2, colour 0xffc48a, at y 6.4). They are never removed — only their intensity is ramped with the night factor (a light leaving the scene recompiles every lit material), so they sit in `NUM_POINT_LIGHTS` at every hour, noon included: budget any further light against **3 point lights + the 2 headlight SpotLights**. They are re-aimed at the nearest lamp heads every frame (not on the 15 m repack) and fade out over the last third of their range, and every in-range lamp keeps its additive pavement disc, so a lamp handed from one light to another never changes a pixel in one frame. Round 9-10: the static parked cars also get blob contact shadows from the shared `ContactShadows` field (`CAR_SHADOWS`, range 46 m) — a parked car is not a `Vehicle`, so it had none and floated once its own sun shadow was a few texels. The cap is **44**, sized so it CANNOT bind (the densest 46 m neighbourhood in the generated city holds 40 parked cars; with the old cap of 24 the pick was a rank cut and neighbouring bays in a lot at 15 m blinked between grounded and floating every 1.5 m of camera travel). `SHADOW_TUNING.capacity` must cover every slice reserved from that one mesh — vehicles 96 + peds `MAX_PEDS` + player 1 + parked 44 — or the last renderer built silently gets fewer blobs (guarded by a test in `render.test.ts`).

**`SkySystem`**: HDR dome `SphereGeometry(850)` BackSide ShaderMaterial (three-stop gradient, `uExposure` 1.8 by day → 1.0 at night, sun disc bright enough to bloom, two-octave cloud layer projected on a flat plane, stars) following the camera; sun + moon sprites; `DirectionalLight` (warm sun ≈ 4.5 at noon, moon 0.5·L `#b8c4e8` with moon shadows at night) with a **132 m** shadow box following the player (texel snapped 0.065 m, normalBias **0.09**, `SHADOW_TAPS` = 7 Vogel-disk taps over a `SHADOW_RADIUS` = 7 texel disk with a two-tap contact-hardening estimate (`patchShadowPenumbra`, `SHADOW_CONTACT`) so a shadow softens with the blocker's distance, only on `high`). The box's hard stair-stepped border is hidden by `patchShadowEdgeFade()`, a one-time patch of three's `shadowmap_pars_fragment` that fades the shadow term back to lit over the outer `SHADOW_FADE` = 10 % of the box, NOT by making the box bigger: the box is the shadow pass' caster set and every metre of it is paid in the colour, GTAO and shadow passes (measured: 150 m cost ~9.5k triangles more than 120 m in the dusk frame); `HemisphereLight` driven by the key's `fill`/`ground` complements (≈ 1.5 at noon, key > fill); `scene.fog = THREE.FogExp2` owned here (`density = key.fogDensity / fogScale`, colour derived from the sky); a 128×64 float equirect reflection probe (graded sky + sun blob + horizon line) PMREM-filtered into `scene.environment` when the hour moves > 0.3 h; `update(hour, sunDir, nightFactor, playerX, playerZ, shadows)`. `SkyKey = { hour, top, horizon, sun, fill, ground, fog, sunI, ambI, fogDensity }`; `SKY_KEYS` at hours 0, 4.5, 6, 7.5, 12, 16.5, 17.5, 18, 19, 20.5, 22. Sunset must read as Vice City: horizon `#ff7a3d`, top `#6a2c8f` around 18:30–19:15. The sun path (`DayNightSystem`) leans south as it climbs so noon elevation is ≈ 49° while sunrise/sunset azimuth and the dusk timing are unchanged.

**`DayNightSystem`** (sim, Three-free): `DAY_TUNING = { dayLengthSec: 600, startHour: 18.0, lightsOnElevation: 0.05, lightsFadeHours: 0.5 }`; `hour()`, `sunElevation()`, `sunDir(out: Vec3)`, `nightFactor()` = smoothstep(0.08, −0.06, sunDir.y), `setHour(h)`, emits `time:hourChanged`. Also sets `vehicle.lightsOn` for AI vehicles when nightFactor > 0.5 (P0 `World` exposes vehicleList).

**`MarkerRenderer`**: pulsing additive cylinders for mission starts (orange) and the objective (blue) + a bobbing arrow cone above the objective. Round 8 tuning (`MARKER_TUNING`): r **1.6**, h **34**, opacity **.16–.34**, `BackSide`, a vertical falloff baked into the beam's vertex colours (`fadePower` 1.9, bright at the foot) and a per-instance proximity fade (`nearFrom` 3 m → `nearTo` 11 m, floor 0.12) so standing at a marker no longer tints the street. The beam is a light column, NOT the trigger: mission-start radii are gameplay values in Track F and are unrelated to r; reads `world.mission` and the marker list via a `getMarkers(out)` callback provided by Engine (Track F's `MissionSystem.availableMarkers`).

**`EffectsRenderer`**: skid marks ring buffer (3000 quads, `DynamicDrawUsage`, `drawRange`) fed by `fx:skid` events + per-vehicle rear-wheel positions; tire smoke and sparks as `Points` with life attribute (400 + 300); damage smoke for vehicles with `smoke > 0`; explosion flash sphere on `vehicle:destroyed`; listens to `vehicle:collision` (sparks ∝ impactSpeed, emits nothing) and `ped:hit` (dust). `update(world, alpha, frameDt)`.

**`RenderTest` page** (`/rendertest?hour=19`): builds `generateCity()`, CityRenderer, SkySystem, DayNightSystem, and a fixed camera at the plaza looking at the tower; no Engine. Use it with the screenshot harness to verify the look (day, sunset, night) and `renderer.info.render.calls` (print into `window.__GAME_DEBUG__`).

Acceptance: screenshots at hours 12, 18.7, 22 look right (windows lit at night, neon on, lamps with light pools, sunset gradient); static draws ≈ 52 and the whole frame < 120 draw calls; triangles ≤ 720k measured at the **worst of {spawn, 20 m north, 40 m north} × {12:00, 19:00, 21:00}** — NOT at the spawn frame, which is not the worst case: round 8 passed a spawn-frame check and still breached at 742-747k twenty and forty metres up the street. 19:00 at 40 m north is normally the binding frame. Round 10 measured (`scratchpad/pw/gate-worst.mjs`, 1280×720, `quality=high&noadapt=1`): **669,846 triangles / 111 draw calls** at 19:00 / 40 m north; 12:00 spans 621-634k, 19:00 645-670k, 21:00 648-667k, draw calls 103-111; typecheck/lint clean; every visual change is judged from a screenshot.

---

## 6. Track C — Player, camera, vehicle physics, collisions

**`PlayerMoveSystem`** (on-foot only; skipped while `player.vehicleId !== null`): `PLAYER_TUNING = { walkSpeed: 4.2, sprintSpeed: 7.5, accel: 30, decel: 40, jumpVel: 6.5, gravity: 20, turnLambda: 14, fallDamageSpeed: 12, stumbleTime: 0.4 }`. Camera-relative movement using `ctx.camera.yawForMovement`; yaw damps toward the move direction; jump on `consume('jump')` when grounded; `moving`, `sprinting`, `animPhase` for the renderer; `stumbleTimer` blocks input. Wasted when `health <= 0` → emit `player:wasted` once and set `alive = false`.

**`VehicleEntrySystem`**: prompt + enter/exit + driving controls. `ENTRY_TUNING = { enterRadius: 3.0, exitPad: 1.0, enterCooldown: 0.6 }`. Nearest enterable vehicle = OBB expanded by `enterRadius` containing the player, not destroyed, not `police` with a live brain unless `speed < 1`. `interact` on foot → enter: `player.vehicleId = v.id`, `v.occupiedByPlayer = true`, `v.driverId = player.id`, `v.prevRole = v.role`, `v.role = 'player'`, `v.brain = null`, `stolen = prevRole !== 'parked'`... (stealing traffic ejects the driver: Track E's `PedestrianSystem.spawnFleeingDriver(v)` is called through the event `player:enterVehicle` — E subscribes), `ctx.camera.snapBehind()`. `interact` in a vehicle → exit at `right * (hw + 0.4 + exitPad)`; if that circle overlaps a static/vehicle try left, then behind; vehicle `role = 'abandoned'`, `occupiedByPlayer = false`; `player.curr` set + `snap()`. While driving: write `v.controls` from input (throttle = axis(back, forward), steer = axis(left, right), handbrake = down('handbrake'), horn = pressed('horn') → emit `horn`, headlights toggle on `consume('headlights')`), mirror `player.curr` to the seat position each tick, set `world.hud.prompt`. Player damage from vehicle collisions comes through `CollisionSystem` (`player:damaged`), destroyed vehicle → forced exit + 30 damage. `respawn(at, reason)`: heal, clear vehicle, `snap()`, `invulnTimer = 3`.

**`VehiclePhysicsSystem`** — integrates ALL vehicles (skips `sleeping`, wakes when controls non-zero). `static integrate(v: Vehicle, dt: number)` exported for tests. Model (per tick, all in the car's frame):
```
vf = v.speed, vl = v.lateral (recomposed from vx,vz each tick using yaw)
steerMax = lerp(steerMaxLow, steerMaxHigh, clamp(|vf| / maxSpeed, 0, 1)); steerAngle = damp(steerAngle, controls.steer * steerMax, steerLambda, dt)
if throttle > 0:            a = accel * throttle * max(0, 1 - vf / maxSpeed)           // single engine curve (no other cap)
else if throttle < 0:       a = vf > 0.5 ? -brakeDecel : (vf > -reverseSpeed ? -accel * 0.6 : 0)
else:                       a = -sign(vf) * min(|vf| / dt, coastDecel)
a -= sign(vf) * min(|vf| / dt, rollDecel + dragQuad * vf * vf)        // rolling + light aero, never reverses sign
a -= sign(vf) * brakeDecel * controls.brake
if handbrake: a -= sign(vf) * min(|vf| / dt, handbrakeDecel)
vf += a * dt
grip = handbrake ? gripHandbrake : gripNormal;  if |vf| < 4: grip *= 1.6            // no low-speed sliding
vl *= exp(-grip * dt)
yawAuthority = clamp(1 - |vl| / 12, 0.35, 1)
yawRate = (vf / wheelbase) * tan(steerAngle) * yawAuthority;  if handbrake: yawRate *= 1.25
yaw += yawRate * dt; recompose vx,vz = forward*vf + right*vl; pos += v*dt; wheelSpin += vf / 0.33 * dt
drifting = |vl| > 3.5 && |vf| > 6;  longAccel = (vf - prevVf) / dt
```
Destroyed vehicles: throttle forced 0, brake 1. Emit `fx:skid` for drifting/handbrake vehicles when |vf| > 4 (intensity = clamp(|vl|/8)). `damageFlash`/`smoke` decay here (smoke = 1 when health < 30).
**Physics test** (`physics.test.ts`): integrate each spec with full throttle for 25 s on a straight: sedan top speed 31–38, sport 42–50, police 37–45, van 24–30; 0→27.8 m/s ≤ 7 s (sedan), ≤ 4 s (sport); braking from 30 m/s with throttle −1 stops within 40 m; handbrake at 20 m/s + full steer rotates ≥ 70° within 1 s while sliding ≥ 8 m; coasting from 30 m/s drops below 20 m/s within 8 s.

**`CollisionSystem`** — `COLLISION_TUNING = { restitutionStatic: 0.2, restitutionVehicle: 0.3, damageMinSpeed: 3, damagePerMs: 2.5, pedHitSpeed: 3.5, pedDamagePerMs: 8, pedKillSpeed: 9, playerHitSpeed: 4, playerDamagePerMs: 6, sweepSpeed: 15, iterations: 2, angularKick: 0.35, maxYawRate: 2.5 }`. Order each tick: `world.rebuildDynamicHash()` → **vehicle vs vehicle** (pairs once via id order, OBB SAT, positional split by inverse mass, impulse exchange with restitution, damage from relative normal speed, `angularKick` from the contact offset; parked/sleeping vehicles are woken and pushed) → **vehicle vs ped/player** (`circleVsObb`; if vehicle speed > pedHitSpeed: ped → `HIT` with velocity = vehicle vel × 0.8 + vy 3, health −= speed × pedDamagePerMs, `killed = speed > pedKillSpeed`; emit `ped:hit` with `byPlayer = v.occupiedByPlayer`; player on foot: damage `(speed − playerHitSpeed) × playerDamagePerMs`, knockback, `stumbleTimer`, invuln 0.5 s; else push out) → **vehicle vs static** (queried by AABB; `staticVsObb`; push out, reflect normal velocity, tangential ×0.92, damage when impact > damageMinSpeed; for props with r < 0.5 and speed > sweepSpeed use `segmentVsCircle` from `prev` to `curr` first) → **final vehicle vs static pass** (guarantees no vehicle ends inside a wall after being pushed by another) → **ped/player vs static** (circle push-out, 2 iterations) → **player vs vehicle** (when not driving). Emit `vehicle:collision` (with `playerInvolved`, `bIsPolice`), `vehicle:destroyed` when health hits 0 (once), `camera:shake` for player-involved impacts (trauma = clamp(impact / 20)). Water collider: vehicles stop (velocity zeroed), peds/player pushed out. `collision.test.ts`: SAT manifolds, push-out separates, a car at 30 m/s cannot tunnel through a lamp post, vehicle-vehicle momentum conservation within 10 %.

**`CameraController`** (implements `CameraLike`; frame-rate update on interpolated transforms): `CAMERA_TUNING = { orbitDist: 6.2, orbitHeight: 1.45, pitchMin: -0.35, pitchMax: 1.1, pitchDefault: 0.13, mouseSens: 0.0022, keyYawSpeed: 2.4, chaseDists: [9, 12.5, 4], chaseHeight: 2.15, chaseLookAhead: 3, posLambda: 6, yawLambda: 4, autoAlignDelay: 1.0, autoAlignRate: 2.5, reverseDelay: 0.5, fovBase: 56, fovMax: 68, fovSpeedRef: 24, fovLambda: 4, shakeDecay: 1.6, shakeMaxPos: 0.45, shakeMaxRot: 0.03, occlusionPad: 0.4, occlusionMin: 0.12, cinematicRadius: 140, cinematicHeight: 55, cinematicRate: 0.06 }` (chase adds a speed-scaled look-ahead, a lateral slide into the turn and a small steering roll). Orbit on foot (mouse when locked, Q/R otherwise, `invertY`, `mouseSensitivity`); chase in vehicle (behind, auto-align after idle, reverse cam when reversing > 0.5 s, `V` cycles `chaseDists`, speed FOV); building occlusion pull-in via `staticHash.querySegment` + `segmentVsAabb`; trauma shake (`camera:shake` events + `addTrauma`); cinematic orbit around the tower in `menu`. `isInView` uses the current forward. `yawForMovement` = camera yaw.

**`PlayerRenderer`**: orange shirt, blue jeans, skin head, arms/legs boxes with walk/run swing driven by `animPhase`, jump pose, hidden while driving, `spawnFade` scale. ≤ 7 draws.

**`VehicleRenderer`**: per-spec body InstancedMesh (5) with merged bevelled prism geometry (hull, pillars, tinted glass band, bumpers, arches, lamps; nose toward +Z; a belt-line shading ramp darkens sills) on a clearcoat `MeshPhysicalMaterial` whose vertex patch mixes `instanceColor` into the paint regions; `instanceColor` = paint darkened by damage `(0.35 + 0.65·health/100)`, wrecks black; one wheels InstancedMesh (lathed tyre + spoked rim, 4 per vehicle, steer on front, spin; not written beyond `wheelDist` 110 m); one lights InstancedMesh (headlight + taillight quads, instanceColor: white/red when `lightsOn`, dark otherwise; police bar quads alternate red/blue at 4 Hz while `sirenOn`); two SpotLights permanently in the scene for the player's headlights (intensity 0 by day); capacity `BUDGET.MAX_VEHICLES`; `spawnFade` scales instances; instances beyond 260 m collapsed (scale 0). ≤ 8 draws. Round 4: glass stations inset 2 cm with a 3 cm near-black gasket band at belt and roof, a vertical glass darkening ramp, two-stage rear screen, dark-bezel lamp clusters with inset lenses, 2 cm exhaust tube, muted framed plate; headlights 45 cd / 35 m / decay 2. LOD ladder (round 9, three tiers, ten extra InstancedMeshes — five per tier): the full loft + lathed steering wheels + a shadow pass only within `VEHICLE_RENDER.bodyFullDist` = **30 m** (and `wheelDist` = 30 m, kept a separate constant); `parkedMidGeometry()` (~950 tris, baked shouldered tyres) out to `bodyMidDist` = **70 m**, which DOES cast — cutting the shadow at 30 m switched a car's whole 6-10 m low-sun shadow on and off as it crossed the band; beyond that `parkedShellGeometry()` (~460 tris, baked wheel discs, no shadow pass). The mid tier's shadow pass measures +11.5k triangles and +4 draw calls for a dozen cars, an eighth of what the same cars cost the shadow pass at the old 75 m full-loft band. The same shells dress the lots via `CityRendererProps` (`PROP_RANGE.parked` 120 m). Round 5: `makeVehiclePaintMaterial(lensGlow)` — clearcoat 1.0 / clearcoatRoughness 0.08 over a 0.35-rough metallic base with a Fresnel rim, per-instance `instanceGlow` attribute lighting the lens cells above the night bloom threshold when `lightsOn`; rear PAINT_SHADE bumper band + black rubbing strip; bezel + lens plate on every lamp; bright alloy wheel dish. **`SkySystem`** probe is 256×128 (hard sun disc, bright horizon band, 44-block skyline row). Round 6: the rear is a proud bumper part with a rubbing strip and black valance (the fan-shaded valance X is gone), lamps are 3D blocks with bezels, mirrors are tapered housings on stalks, the exhaust is a 5.4 cm tailpipe tucked under the valance.

Acceptance: physics + collision tests pass; with the P0 engine + stub city you can walk, jump, orbit, enter a spawned car, drive with drift, hit a test building and see damage (verify via a temporary route or `?autostart=1` + keyboard in the screenshot harness); typecheck/lint clean.

---

## 7. Track D — React HUD and menus, HudPublisher, debug overlay

All under `src/components/game/` (Tailwind + shadcn; `pointer-events-none` on the HUD, `pointer-events-auto` on menus). Components: `GameOverlay` (switches by `phase` + local sub-screen), `Hud`, `Minimap`, `StatusBars`, `WantedStars`, `Speedometer`, `Prompt`, `MissionText`, `Notifications`, `MainMenu`, `PauseMenu`, `ControlsHelp`, `SettingsMenu`, `GameOverScreen`, `ClickToResume`, `LoadingScreen`, `DebugPanel`.
- Style: Vice-City neon. Palette tokens: orange `#ff7a00`, magenta `#ff2d95`, cyan `#00e5ff`, panel `rgba(5,3,8,.55)` with `backdrop-blur`, text white with subtle glow; title in `.game-font` with an orange→magenta gradient. Main menu over the live cinematic city; a thin 'V I' badge; buttons big with hover glow.
- `Minimap`: 200 px circle bottom-left, own rAF at 30 Hz calling `engine.getMinimapSnapshot()` and `engine.minimap.draw(...)`; no React state per frame. Clock next to it.
- `WantedStars`: 5 lucide `Star`s top-right, filled = `wanted`, `animate-pulse` while `wantedFlash`. `StatusBars`: health (red) + armor (grey) 160 px; money `$1.250` in mono/game font with a green delta pop on change. `Speedometer`: big km/h + `km/sa` + vehicle name + vehicle health bar, only when `inVehicle`. `Prompt`: bottom-center pill with a key chip. `MissionText`: top-center title + objective + timer. `Notifications`: stacked under money, auto-remove after 4 s (from `at`), colored by kind. Hit flash: red vignette for 150 ms after `hitFlashAt` changes. `GameOverScreen`: `HARCANDIN`/`YAKALANDIN` + subtitle, 3 s countdown, `Devam` → `engine.respawn()`. `ClickToResume`: shown when `phase === 'playing' && !pointerLocked` (text `Devam etmek için tıkla`; click → `engine.resume()`). `LoadingScreen` while `loading`. Settings write through `engine.applySettings`.
- `HudPublisher` (sim system, runs every 6 ticks + `publishNow()` on events `phase:changed`, `notify`, `wanted:changed`, `mission:*`, `money:changed`, `player:damaged`): builds a patch from World and only includes changed fields; formats clock `HH:MM` and money; `speedKmh` = |vehicle.speed| × 3.6; `debug` stats only when `showDebug`.
- `DebugOverlay` (`src/game/debug/DebugOverlay.ts`): F3 toggles `store.showDebug`; the `DebugPanel` component renders fps/draw calls/tick ms/entity counts.

Acceptance: works against the P0 engine (menu → Başla → HUD → Esc → pause → Devam Et; settings persist); no React re-render faster than 10 Hz; typecheck/lint clean; screenshot of the main menu and the HUD.

---

## 8. Track E — Traffic, pedestrians, audio

**`TrafficSystem`** — `TRAFFIC_TUNING = { targetCount: BUDGET.TRAFFIC_TARGET, spawnMin: 130, spawnMax: 230, spawnAheadMin: 220, despawnDist: 280, lookahead: 6, followGapBase: 6, followGapPerMs: 1.0, stopTime: 0.8, nodeApproach: 8, scanLen: 16, scanHalfW: 2.4, pedConeLen: 6, pedConeDot: 0.75, steerP: 2.2, steerD: 0.3, spawnInterval: 0.5, blockedTimeout: 6, honkAfter: 2, sirenYieldDist: 18, turnSpeed: 6 }`.
`static driveAlongLane(v, b, roads, world, dt, now, chooseNext)` shared with police: pure-pursuit toward `pointOnLane(lane, t + lookahead)` (or the bezier during a turn), PD steering, speed control to `min(lane.speedLimit, b.targetSpeed)` and `turnSpeed` within 12 m of a turn; `t` = projection of the position onto the lane. At `t >= length − nodeApproach`: if `node.stopSign` wait `stopTime` stationary once; then `roads.reserve(node, id, axis, straight, now)`; while not allowed: hold at the stop line; once reserved: traverse the bezier (`turnS += speed·dt / turnLength`), then `lane = next, t = 0`, `release`. `chooseNext(b, lane, rng)` weights straight .6 / right .25 / left .15. Car-following: `dynamicHash.querySegment` ahead `scanLen` with `scanHalfW`; vehicles roughly same heading (|angleDiff| < .8) or peds/player in the cone → desired = max(0, (gap − followGapBase) × 1.5); gap < 2 → brake 1. Peds inside `pedConeLen` cone → brake. Police with siren within `sirenYieldDist` behind → pull right 1 m and slow to 4 m/s. Blocked (speed < .3 with desired > 2): honk after 2 s if the blocker is the player (emit `horn`), despawn after 6 s if not in view. Spawner every `spawnInterval`: pick `lanesInRing(player, spawnMin, spawnMax)`; accept if not in view **or** dist ≥ spawnAheadMin, and no entity within 12 m; `spawnFade = 0`. Despawn traffic beyond `despawnDist` unless in view and < 320 m. `spawnParkedCars()` at init/newGame from `city.parkedSpots` (role `parked`, brain null, sleeping). Abandoned vehicles despawn beyond 300 m (never the mission vehicle). Assert budget before each spawn.
Also owns `spawnFleeingDriver(v)` (called from `player:enterVehicle` when `stolen`): a ped appears at the driver door and flees.

**`PedestrianSystem`** — `PED_TUNING = { targetCount: BUDGET.PED_TARGET, spawnMin: 60, spawnMax: 130, despawnDist: 170, walkSpeed: 1.4, fleeSpeed: 5.5, fleeTime: 6, idleMin: 1, idleMax: 4, threatSpeed: 10, threatApproach: 2.0, hornRadius: 12, panicRadius: 15, lyingTime: 8, fadeTime: 1.5, crossChance: 0.25, aiEveryTicks: 3, sprintScare: 2 }`. FSM `IDLE → WALK (along SidewalkGraph, nextNode with crossChance at corners) → FLEE → IDLE`, `HIT` (tumble: vy gravity, spin) → lying `lyingTime` → fade → remove; `DEAD` when `health <= 0`. Threats (evaluated every 3 ticks, staggered): **closest-approach test** against the player's vehicle only (and any vehicle that is off-lane, i.e. `brain === null && speed > threatSpeed`): time to closest approach clamped to 0..1 s, distance at that time < `threatApproach` and vehicle speed > `threatSpeed` → FLEE; `horn` within `hornRadius`; sprinting player within `sprintScare` m; `ped:hit` within `panicRadius` → panic. Lane traffic never scares peds. Spawner as traffic (ring, not in view, `spawnFade`). Ped vs ped: soft separation only.

**`AudioSystem`** (`src/game/audio/AudioSystem.ts`, implements `AudioLike` + `frameUpdate(frameDt, world)`): lazy `AudioContext` on `unlock()`; master gain → compressor; engine: sawtooth + square (−12 st) → lowpass (300 + 1800·load) → gain (.05..0.2), rpm with 4 fake gears; horn 2 square oscs 392/494 Hz 0.4 s with distance attenuation; siren triangle 650→1150 Hz LFO 1.1 Hz, ≤ 2 voices panned by relative position; ambient surf: filtered brown noise with 0.1 Hz LFO, gain by distance to `BEACH_X0`; wind ∝ speed; impacts noise burst + 80 Hz thump; skid bandpass noise while drifting; UI jingles (`money`: C5 E5 G5 C6; `wanted`: two descending squares; `busted`/`wasted`: low saw slide; `missionStart/Complete`; `star`). `M` toggles mute (Engine wires it). Subscribes to `horn`, `vehicle:collision`, `ped:hit`, `vehicle:destroyed`, `mission:*`, `money:changed`, `wanted:changed`.

**`PedRenderer`**: 4 InstancedMeshes (body, head, legL, legR) capacity `BUDGET.MAX_PEDS`, instanceColor shirt/skin/pants, leg swing from `animPhase`, tumble/lying pose for HIT/DEAD, fade via `spawnFade`/`fadeTimer`, DROPPED from the instance list (not scaled to zero) beyond `PED_RENDER.cullDist` = **96 m**, with a `cullFade` 6 m ramp.

**`traffic.sim.ts`** (headless, via `createHeadless` with DayNight + Traffic + Pedestrian + VehiclePhysics + Collision systems): simulate 180 s with the player standing on a plaza sidewalk: traffic count reaches ≥ 20 within 30 s; no traffic car has `blockedTimer > 20`; no vehicle ends inside a building AABB; no NaN positions; peds reach ≥ 30; fewer than 3 vehicle-vehicle collisions with impact > 5 m/s per simulated minute; no ped flees while the player stands still (count of FLEE transitions with no player vehicle < 5).

---

## 9. Track F — Wanted, police, missions

**`WantedSystem`** — `WANTED_TUNING = { heatPerStar: 30, maxStars: 5, heatCap: 165, heatPedHit: 35, heatPedKill: 60, heatVehicleHit: 12, heatVehicleHitMinSpeed: 5, heatPoliceHit: 45, heatStealCar: 15, stealWitnessRadius: 20, decayPerSec: 4, decayDelay: 8, sightRange: 70, policePerStar: [0, 2, 3, 4, 6, 8] }`. Heat from events (only `byPlayer`/`playerInvolved`); `stars = min(5, floor(heat / 30))`; first star → notify `Aranıyorsun!` + `playUi('wanted')`; seen = any police within `sightRange` with LOS; decay after `decayDelay` s unseen AND after the last crime; on stars → 0: notify `Kaçtın! Aranma sona erdi`; `flash` 1.5 s on change; `sirenActive` mirrors any police with `sirenOn` (emit `siren:changed`). `addHeat`, `setStars`, `clear` exported.

**`PoliceSystem`** — `POLICE_TUNING = { spawnMin: 120, spawnMax: 200, spawnAheadMin: 220, despawnDist: 320, repathInterval: 1.5, pursueRange: 50, losePursuitRange: 90, predictTime: 0.5, ramSpeed: 20, bustRadiusFoot: 3.5, bustRadiusCar: 4.5, bustPlayerMaxSpeed: 1.5, bustTime: 2.0, bustTimeCar: 3.0, stuckTime: 3, reverseTime: 1.2, laneSpeed: 24, whiskerLen: 12, whiskerAngle: 0.44, returnTime: 10, evictAfter: 1.5 }`. Maintains `policePerStar[stars]` units (never above `BUDGET.POLICE_MAX`); spawn on lanes via the same hidden rule as traffic. `PATH`: A* over `roads` to the node nearest the player (repath every 1.5 s), `driveAlongLane` with `chooseNext` following the lane path, `laneSpeed`, no stop-sign wait, evicts stale reservations; → `PURSUE` when dist < `pursueRange` and LOS. `PURSUE`: steer to `playerPos + playerVel·predictTime` with 3 whiskers (`staticHash.querySegment` + `dynamicHash`), brake .5 if the center whisker hits < 8 m, ram (throttle 1) when closing; if the player is on foot and dist < 6 → stop; → `PATH` when dist > `losePursuitRange` or no LOS for 4 s. `BUST` timers: on-foot player within `bustRadiusFoot` of a police car with police speed < 1.5 → `bustTimer += dt` (2 s); player in a vehicle with |speed| < `bustPlayerMaxSpeed` and police within `bustRadiusCar` → 3 s; timers reset when the condition breaks; expiry → emit `player:busted` (Engine handles phase + respawn at the police station, money −500). Stuck (speed < .5 under throttle for 3 s) → reverse 1.2 s with opposite steer. Destroyed police are replaced after 20 s. Stars → 0: all units `RETURN` (drive as traffic for `returnTime`, then despawn when not in view). Sirens on while PATH/PURSUE; `audio.setSirens` fed by the two nearest units each tick.

**Missions** (`missions/definitions.ts` + `MissionSystem`): `MissionStep = goto | enterVehicle | deliverVehicle | loseWanted | wait`; `MissionDef { id, title, description, reward, timeLimit?, timeBonus?, setWanted?, spawnVehicle?, steps, cooldown }`; `resolveMissionPositions(defs, city, roads)` fills every coordinate from `city.points` (start markers = `missionStarts[i]`).
1. `sahil` **Sahil Yürüyüşü** — goto `points.pier` (r 3, on foot or car), reward 500.
2. `kurye` **Turuncu Kurye** — spawns an orange `sport` on the nearest parked-style curb spot within 40 m of the start; `enterVehicle` → `deliverVehicle` to `points.garage` (r 5, stopped, health ≥ 30 else fail `Araç çok hasarlı`), reward 1500, `timeBonus { under: 90, bonus: 500 }`. The mission vehicle is immune to despawn while active; on end it becomes `abandoned`.
3. `takip` **Sıcak Takip** — `setWanted 3`, `loseWanted` (objective `Polisten kaç! Yıldızlar sıfırlanana kadar hayatta kal`), reward 3000; fails on busted/wasted.
Markers hidden during a mission; walking into a start marker (r 2.5, on foot) sets the prompt `E - Görevi başlat: {title}`; `interact` starts. Objective marker/blip via `world.mission.marker*`. Cooldown 30 s. `availableMarkers(out)` for MarkerRenderer/minimap. Rewards → `player.money`, `money:changed`, notify `Görev tamamlandı: +$1.500`, `playUi('missionComplete')`. Wasted/busted aborts with `mission:failed`.

**Sims**: `police.sim.ts`: player on foot on a sidewalk, `setStars(2)`: a police unit gets within 15 m within 40 s and `player:busted` fires within 60 s; with the player teleported 400 m away and police despawned, stars decay to 0 within 90 s. `missions.sim.ts`: start `sahil`, teleport the player to the pier → completed with +500; start `kurye`, teleport a vehicle + player to the garage stopped → completed; `takip` sets 3 stars.

---

## 10. Track I — Integration

Wire `Engine.ts` fully: system order (2.26), renderers, `AudioSystem` (with `unlock()` on Başla/first keydown), pointer lock + pause, `player:wasted`/`player:busted` → phase + slow-mo + respawn (hospital: money −10 % ; police station: −500, wanted cleared, 3 s invulnerability), `M` mute, `F3` debug, `?hour`, settings application (quality → renderer + shadows + fog), StrictMode-safe dispose. `scripts/screenshot.mjs` = the Playwright harness (Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, SwiftShader flags) that captures `/?autostart=1&hour=19&quality=low`, `?hour=12`, `?hour=23`, the main menu, and a driving shot after scripted keys, printing `__GAME_DEBUG__` and console errors. Acceptance: `npm run typecheck`, `npm run lint` (no new errors), `npm test`, `npm run build`, screenshots with 0 console errors and draw calls < 120, the first-60-seconds script works in the harness (spawn → E enters a car within 30 m → drive → hit a ped → star → police arrive).

---

## 11. First-60-seconds acceptance script (integration playtest)
1. Menu shows the live sunset city with the tower; `Başla` starts at the beachfront sidewalk at 18:00 with a car within 30 m.
2. `E - Araca bin` appears next to a parked car; E enters; W accelerates with engine sound; camera pulls back; Space + steer drifts leaving skid marks.
3. Hitting a pedestrian ragdolls them, a star appears, `Aranıyorsun!` shows, sirens start, a police car arrives within 30 s.
4. Traffic stops at stop signs and yields; no gridlock after 3 minutes.
5. Night falls (~19:30 game time = 37 s real): windows, neon and lamps switch on, headlights show.
6. Walking into an orange marker starts a mission; completing it pays out and toasts.
7. Esc pauses; Devam Et resumes; settings persist across reload.
