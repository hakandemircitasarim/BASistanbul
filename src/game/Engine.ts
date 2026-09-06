// Game engine (composition root): owns world/loop/input/renderers, runs the phase machine and the fixed-step system pipeline. Track I.
import { World, START_HOUR } from './world/World';
import { EventBus } from './core/EventBus';
import { GameStore } from './state/GameStore';
import type { DebugStats, Settings } from './state/GameStore';
import { GameLoop } from './core/GameLoop';
import { Input } from './core/Input';
import { Random } from './core/Random';
import type { GamePhase, Vec3 } from './core/Types';
import { generateCity, validateCity } from './city/CityGenerator';
import { CITY_SEED } from './city/CityConfig';
import { MinimapRenderer, createMinimapSnapshot } from './minimap/MinimapRenderer';
import type { MinimapSnapshot } from './minimap/MinimapRenderer';
import { resetEntityIds } from './entities/Entity';
import type { AudioLike, EngineContext, System } from './systems/System';
// Systems (spec 2.26 order).
import { DayNightSystem } from './systems/DayNightSystem';
import { PlayerMoveSystem } from './systems/PlayerMoveSystem';
import { VehicleEntrySystem } from './systems/VehicleEntrySystem';
import { TrafficSystem } from './systems/TrafficSystem';
import { PoliceSystem } from './systems/PoliceSystem';
import { PedestrianSystem } from './systems/PedestrianSystem';
import { VehiclePhysicsSystem } from './systems/VehiclePhysicsSystem';
import { CollisionSystem } from './systems/CollisionSystem';
import { WantedSystem, setStars } from './systems/WantedSystem';
import { MissionSystem } from './systems/MissionSystem';
import { HudPublisher } from './state/HudPublisher';
import { DebugOverlay } from './debug/DebugOverlay';
// Renderers + audio.
import { Renderer } from './render/Renderer';
import { CameraController } from './render/CameraController';
import { TextureFactory } from './render/TextureFactory';
import { Materials } from './render/Materials';
import { CityRenderer } from './render/CityRenderer';
import { SkySystem } from './render/SkySystem';
import { MarkerRenderer } from './render/MarkerRenderer';
import { EffectsRenderer } from './render/EffectsRenderer';
import { PlayerRenderer } from './render/PlayerRenderer';
import { VehicleRenderer } from './render/VehicleRenderer';
import { PedRenderer } from './render/PedRenderer';
import { AudioSystem } from './audio/AudioSystem';

/** Debug stats extended for the screenshot harness (player speed / vehicle / wanted / clock / camera yaw). */
export interface EngineDebugStats extends DebugStats { speed: number; inVehicle: boolean; wanted: number; hour: number; camYaw: number; resScale: number }

export interface EngineOptions { autostart?: boolean; hour?: number; quality?: 'low' | 'high'; seed?: number; debug?: boolean; stars?: number /* ?stars=2: debug wanted level at newGame */; nearCar?: boolean /* ?nearcar=1: spawn beside the nearest parked car (harness/debug) */; noAdapt?: boolean /* ?noadapt=1: fixed drawing-buffer scale */; ao?: 0 | 1 | 2 /* ?ao=0 off, 1 on, 2 show the occlusion buffer (debug) */ }

export function parseEngineOptions(search: string): EngineOptions {
  const p = new URLSearchParams(search);
  const o: EngineOptions = {};
  const flag = (k: string): boolean => { const v = p.get(k); return v !== null && v !== '0' && v !== 'false'; };
  if (p.has('autostart')) o.autostart = flag('autostart');
  if (p.has('debug')) o.debug = flag('debug');
  const hour = Number(p.get('hour'));
  if (p.has('hour') && isFinite(hour)) o.hour = ((hour % 24) + 24) % 24;
  const q = p.get('quality');
  if (q === 'low' || q === 'high') o.quality = q;
  const seed = Number(p.get('seed'));
  if (p.has('seed') && isFinite(seed)) o.seed = Math.floor(seed);
  const stars = Number(p.get('stars'));
  if (p.has('stars') && isFinite(stars)) o.stars = Math.max(0, Math.min(5, Math.floor(stars)));
  if (p.has('nearcar')) o.nearCar = flag('nearcar');
  if (p.has('noadapt')) o.noAdapt = flag('noadapt');
  const ao = Number(p.get('ao'));
  if (p.has('ao') && (ao === 0 || ao === 1 || ao === 2)) o.ao = ao;
  return o;
}

const ESC_DEBOUNCE_MS = 300;
const SLOWMO_SECONDS = 2;
const RESPAWN_SECONDS = 3;
/** Clicking through the game-over screen respawns only after this much of the countdown has passed. */
const CLICK_RESPAWN_AFTER = 0.5;
const HOSPITAL_FEE_FRACTION = 0.1;
const POLICE_FINE = 500;
const RESPAWN_INVULN_SECONDS = 3;
/** Low quality pulls the fog in (fewer far fragments) on top of the lower pixel ratio and disabled shadows. */
const LOW_QUALITY_FOG_SCALE = 0.85;

/** 1 while the sun sits just above/below the horizon (sunDir.y in [-0.05, 0.15]), fading out over 0.1 either side. */
function duskFactor(sunY: number): number {
  const lo = sunY < -0.05 ? Math.max(0, 1 - (-0.05 - sunY) / 0.1) : 1;
  const hi = sunY > 0.15 ? Math.max(0, 1 - (sunY - 0.15) / 0.1) : 1;
  return Math.min(lo, hi);
}

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const nextTask = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class Engine {
  readonly world: World;
  readonly events: EventBus;
  readonly store: GameStore;
  readonly loop: GameLoop;
  readonly input: Input;
  minimap: MinimapRenderer | null = null;
  readonly rng: Random;
  readonly options: EngineOptions;
  readonly audio: AudioLike;
  systems: System[] = [];
  camera: CameraController | null = null;
  renderer: Renderer | null = null;
  disposed = false;

  // System handles (all constructed in the constructor; init(ctx) runs in init()).
  readonly dayNight = new DayNightSystem();
  readonly traffic = new TrafficSystem();
  readonly police = new PoliceSystem();
  readonly peds = new PedestrianSystem();
  readonly wantedSys = new WantedSystem();
  readonly missions = new MissionSystem();
  private readonly hudPublisher: HudPublisher;
  private readonly audioSys: AudioSystem;
  private debugOverlay: DebugOverlay | null = null;

  // Renderers (browser only; created in init()).
  private tex: TextureFactory | null = null;
  private materials: Materials | null = null;
  private cityRenderer: CityRenderer | null = null;
  private sky: SkySystem | null = null;
  private markers: MarkerRenderer | null = null;
  private effects: EffectsRenderer | null = null;
  private playerRenderer: PlayerRenderer | null = null;
  private vehicleRenderer: VehicleRenderer | null = null;
  private pedRenderer: PedRenderer | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: EngineContext;
  private readonly sunDir: Vec3 = { x: 0, y: 1, z: 0 };
  /** Continuous render-side clock (seconds) for water/ferris/marker/siren animation; unaffected by pause. */
  private renderClock = 0;
  private lastLockChangeMs = -1e9;
  private slowMoTimer = 0;
  private respawnTimer = 0;
  private firstFrameResolve: (() => void) | null = null;
  private readonly debugStats: EngineDebugStats = { fps: 0, drawCalls: 0, triangles: 0, tickMs: 0, vehicles: 0, peds: 0, police: 0, traffic: 0, speed: 0, inVehicle: false, wanted: 0, hour: 0, camYaw: 0, resScale: 1 };
  private readonly snapshot: MinimapSnapshot = createMinimapSnapshot();
  private readonly markerOut = [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }];

  constructor(canvas: HTMLCanvasElement, store: GameStore, options: EngineOptions = {}) {
    this.canvas = canvas;
    this.store = store;
    this.options = options;
    resetEntityIds();
    const seed = options.seed ?? CITY_SEED;
    this.rng = new Random(seed);
    this.events = new EventBus();
    const gen = generateCity(seed);
    if (options.debug) {
      const problems = validateCity(gen);
      if (problems.length) console.warn('validateCity:', problems);
    }
    this.world = new World(gen, this.rng.fork());
    this.world.time.hour = options.hour ?? START_HOUR;
    this.input = new Input();
    this.input.enabled = false;
    this.audioSys = new AudioSystem(this.events); // lazy AudioContext, unlocked on Başla / click / first keydown
    this.audio = this.audioSys;
    this.loop = new GameLoop({ fixed: this.fixedStep, render: this.renderFrame });
    this.ctx = { world: this.world, events: this.events, input: this.input, store, audio: this.audio, camera: null as unknown as CameraController, rng: this.rng.fork(), settings: () => store.getState().settings };
    this.hudPublisher = new HudPublisher({ fps: () => this.loop.fps, debugStats: () => this.getDebugStats() });
    // Spec 2.26 order; HudPublisher stays last.
    this.systems = [this.dayNight, new PlayerMoveSystem(), new VehicleEntrySystem(), this.traffic, this.police, this.peds,
      new VehiclePhysicsSystem(), new CollisionSystem(), this.wantedSys, this.missions, this.hudPublisher];
    this.events.on('player:wasted', () => this.onGameOver('wasted'));
    this.events.on('player:busted', () => this.onGameOver('busted'));
  }

  /** Builds renderers, attaches input, starts the loop; resolves after the first rendered frame. */
  async init(): Promise<void> {
    this.store.setState({ loading: true, loadingText: 'Yükleniyor...' });
    let settings = this.store.loadSettings();
    if (this.options.quality) {
      this.store.setSettings({ quality: this.options.quality });
      settings = this.store.getState().settings;
    }
    const renderer = new Renderer(this.canvas, settings);
    if (this.options.noAdapt) renderer.adaptive = false;
    if (this.options.ao !== undefined) {
      renderer.aoDebug = this.options.ao === 2;
      this.applySettings({ ao: this.options.ao !== 0 });
    }
    this.renderer = renderer;
    this.camera = new CameraController(renderer.camera, this.world, this.input, this.ctx.settings, this.events);
    this.ctx.camera = this.camera;
    // Let the loading screen paint before the synchronous city build (~100s of ms).
    this.store.setState({ loadingText: 'Şehir inşa ediliyor...' });
    await nextTask();
    if (this.disposed) return;
    const tex = new TextureFactory();
    const materials = new Materials(tex);
    this.tex = tex;
    this.materials = materials;
    this.cityRenderer = new CityRenderer(renderer.scene, this.world.city, this.world.roads, materials, tex);
    this.cityRenderer.build();
    this.sky = new SkySystem(renderer.scene, renderer.camera, tex, renderer.gl);
    this.markers = new MarkerRenderer(renderer.scene, materials, (out) => this.missions.availableMarkers(out));
    this.effects = new EffectsRenderer(renderer.scene, this.events, tex);
    this.playerRenderer = new PlayerRenderer(renderer.scene);
    this.vehicleRenderer = new VehicleRenderer(renderer.scene);
    this.pedRenderer = new PedRenderer(renderer.scene);
    this.minimap = new MinimapRenderer(this.world.city, this.world.roads);
    this.debugOverlay = new DebugOverlay(this);
    this.debugOverlay.attach();
    this.input.attach(this.canvas);
    this.input.onPointerLockChange = this.onLockChange;
    window.addEventListener('keydown', this.onRawKey);
    this.canvas.addEventListener('click', this.onClick);
    for (let i = 0; i < this.systems.length; i++) this.systems[i].init?.(this.ctx);
    this.dayNight.setHour(this.options.hour ?? START_HOUR);
    this.applyRenderSettings(settings);
    this.setPhase('menu');
    await new Promise<void>((resolve) => {
      this.firstFrameResolve = resolve;
      this.loop.start();
    });
    this.store.setState({ loading: false });
  }

  /** Resets the world, spawns parked cars, places the player at the spawn point and enters 'playing'. */
  newGame(): void {
    this.world.reset();
    this.dayNight.setHour(this.options.hour ?? START_HOUR);
    const sp = this.world.city.points.playerSpawn;
    this.world.player.reset(sp.x, sp.z, sp.yaw);
    this.traffic.spawnParkedCars();
    if (this.options.nearCar) this.placePlayerBesideNearestCar();
    this.traffic.prefill();
    this.peds.prefill();
    if (this.options.stars) setStars(this.world, this.options.stars);
    this.store.setState({ gameOverReason: null, lastReward: 0, notifications: [] });
    this.setPhase('playing');
    if (this.camera) { this.camera.mode = 'orbit'; this.camera.snapBehind(); }
    this.audio.unlock();
    this.input.requestPointerLock();
    this.events.emit('player:respawn', { x: sp.x, z: sp.z, reason: 'new' });
    this.hudPublisher.publishNow();
  }

  pause(): void {
    if (this.world.phase !== 'playing') return;
    this.setPhase('paused');
    this.input.exitPointerLock();
  }

  /** Sets 'playing' unconditionally, then re-requests pointer lock (may fail without a gesture). */
  resume(): void {
    this.setPhase('playing');
    this.audio.unlock();
    this.input.requestPointerLock();
  }

  toMainMenu(): void {
    this.setPhase('menu');
    this.input.exitPointerLock();
  }

  /** Wasted -> hospital (money -10 %); busted -> police station (-$500, wanted cleared); 3 s invulnerability. */
  respawn(): void {
    const phase = this.world.phase;
    if (phase !== 'wasted' && phase !== 'busted') return;
    const busted = phase === 'busted';
    const pts = this.world.city.points;
    const at = busted ? pts.policeStation : pts.hospital;
    const p = this.world.player;
    const money = p.money;
    p.reset(at.x, at.z, at.yaw);
    p.money = busted ? Math.max(0, money - POLICE_FINE) : Math.max(0, Math.round(money * (1 - HOSPITAL_FEE_FRACTION)));
    p.invulnTimer = RESPAWN_INVULN_SECONDS;
    this.traffic.prefill();
    this.peds.prefill();
    const w = this.world.wanted;
    w.stars = 0; w.heat = 0; w.flash = 0;
    this.store.setState({ gameOverReason: null });
    this.setPhase('playing');
    if (this.camera) this.camera.snapBehind();
    this.input.requestPointerLock();
    this.events.emit('player:respawn', { x: at.x, z: at.z, reason: busted ? 'busted' : 'wasted' });
    this.hudPublisher.publishNow();
  }

  setPhase(p: GamePhase): void {
    const prev = this.world.phase;
    this.world.phase = p;
    this.input.enabled = p === 'playing';
    // Keys pressed while a menu was open must not fire as latched edges on the first tick after resuming
    // (e.g. E pressed in the pause menu would exit the vehicle the moment the game resumes).
    if (prev !== p) this.input.clearAll();
    if (p === 'wasted' || p === 'busted') {
      this.loop.timeScale = 0.3;
      this.loop.paused = false;
      this.slowMoTimer = SLOWMO_SECONDS;
      this.respawnTimer = RESPAWN_SECONDS;
    } else {
      this.loop.timeScale = 1;
      this.loop.paused = p !== 'playing';
      this.slowMoTimer = 0;
      this.respawnTimer = 0;
    }
    if (this.camera) {
      if (p === 'menu') this.camera.mode = 'cinematic';
      else if (this.camera.mode === 'cinematic') this.camera.mode = 'orbit';
    }
    this.store.setState({ phase: p });
    if (prev !== p) this.events.emit('phase:changed', { phase: p, prev });
  }

  applySettings(s: Partial<Settings>): void {
    this.store.setSettings(s);
    this.applyRenderSettings(this.store.getState().settings);
  }

  toggleMute(): void {
    this.applySettings({ muted: !this.store.getState().settings.muted });
  }

  /** Pooled snapshot: player, vehicles (traffic/parked/abandoned/mission), police, mission starts, landmarks, objective. */
  getMinimapSnapshot(): MinimapSnapshot {
    const s = this.snapshot;
    const w = this.world;
    const blips = s.blips;
    s.px = w.player.curr.x;
    s.pz = w.player.curr.z;
    s.pyaw = w.playerYaw();
    s.camYaw = this.camera ? this.camera.yaw : 0;
    let n = 0;
    const pts = w.city.points;
    const cap = blips.length - 3; // keep room for the three landmark badges
    const vl = w.vehicleList;
    for (let i = 0; i < vl.length && n < cap; i++) {
      const v = vl[i];
      if (v.role === 'player' || v.destroyed) continue;
      const b = blips[n++];
      b.kind = v.role === 'police' ? 'police' : 'vehicle';
      b.x = v.curr.x; b.z = v.curr.z; b.yaw = v.curr.yaw;
    }
    const mc = this.missions.availableMarkers(this.markerOut);
    for (let i = 0; i < mc && n < cap; i++) {
      const b = blips[n++];
      b.kind = 'mission'; b.x = this.markerOut[i].x; b.z = this.markerOut[i].z; b.yaw = 0;
    }
    let b = blips[n++];
    b.kind = 'hospital'; b.x = pts.hospital.x; b.z = pts.hospital.z; b.yaw = 0;
    b = blips[n++];
    b.kind = 'policeStation'; b.x = pts.policeStation.x; b.z = pts.policeStation.z; b.yaw = 0;
    b = blips[n++];
    b.kind = 'garage'; b.x = pts.garage.x; b.z = pts.garage.z; b.yaw = 0;
    s.blipCount = n;
    s.wanted = w.wanted.stars;
    s.hasObjective = w.mission.markerVisible;
    s.objectiveX = w.mission.markerX;
    s.objectiveZ = w.mission.markerZ;
    s.inVehicle = w.player.vehicleId !== null;
    return s;
  }

  getDebugStats(): EngineDebugStats {
    const d = this.debugStats;
    const w = this.world;
    d.fps = Math.round(this.loop.fps);
    d.drawCalls = this.renderer ? this.renderer.drawCalls : 0;
    d.triangles = this.renderer ? this.renderer.triangles : 0;
    d.tickMs = Math.round(this.loop.lastFixedMs * 100) / 100;
    d.vehicles = w.vehicleList.length;
    d.peds = w.pedList.length;
    d.police = w.countByRole('police');
    d.traffic = w.countByRole('traffic');
    d.speed = Math.round(w.playerSpeed() * 100) / 100;
    d.inVehicle = w.player.vehicleId !== null;
    d.wanted = w.wanted.stars;
    d.hour = Math.round(w.time.hour * 100) / 100;
    d.camYaw = this.camera ? Math.round(this.camera.yaw * 100) / 100 : 0;
    d.resScale = this.renderer ? Math.round(this.renderer.resolutionScale * 100) / 100 : 1;
    return d;
  }

  /** StrictMode-safe: idempotent; stops the loop, unhooks every listener, frees GPU resources and the AudioContext. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.stop();
    this.firstFrameResolve = null;
    for (let i = 0; i < this.systems.length; i++) this.systems[i].dispose?.();
    this.input.onPointerLockChange = null;
    this.input.detach();
    window.removeEventListener('keydown', this.onRawKey);
    this.canvas.removeEventListener('click', this.onClick);
    if (this.debugOverlay) this.debugOverlay.dispose();
    if (this.minimap) this.minimap.dispose();
    if (this.playerRenderer) this.playerRenderer.dispose();
    if (this.vehicleRenderer) this.vehicleRenderer.dispose();
    if (this.pedRenderer) this.pedRenderer.dispose();
    if (this.effects) this.effects.dispose();
    if (this.markers) this.markers.dispose();
    if (this.sky) this.sky.dispose();
    if (this.cityRenderer) this.cityRenderer.dispose();
    if (this.materials) this.materials.dispose();
    if (this.tex) this.tex.dispose();
    this.audioSys.dispose();
    if (this.camera) this.camera.dispose();
    if (this.renderer) this.renderer.dispose();
    this.events.clear();
  }

  // ---- internals ----

  /** Debug/harness helper (?nearcar=1): moves the player 2.4 m to the right of the nearest parked car, facing the same way. */
  private placePlayerBesideNearestCar(): void {
    const p = this.world.player;
    const list = this.world.vehicleList;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.role !== 'parked') continue;
      const dx = v.curr.x - p.curr.x, dz = v.curr.z - p.curr.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return;
    const v = list[best];
    const off = v.spec.width / 2 + p.radius + 1.0;
    // right(yaw) = (-cos yaw, sin yaw)
    p.reset(v.curr.x - Math.cos(v.curr.yaw) * off, v.curr.z + Math.sin(v.curr.yaw) * off, v.curr.yaw);
  }

  /** Quality -> pixel ratio / shadow map (Renderer), fog distance (SkySystem); audio mute/volume. */
  private applyRenderSettings(all: Settings): void {
    if (this.renderer) this.renderer.applySettings(all);
    if (this.sky) this.sky.fogScale = all.quality === 'high' ? 1 : LOW_QUALITY_FOG_SCALE;
    this.audio.setMuted(all.muted);
    this.audio.setVolume(all.volume);
  }

  private readonly fixedStep = (dt: number): void => {
    const w = this.world;
    w.beginTick();
    for (let i = 0; i < this.systems.length; i++) this.systems[i].fixedUpdate(dt);
    this.input.endTick();
    w.time.elapsed += dt;
  };

  private readonly renderFrame = (alpha: number, frameDt: number): void => {
    if (this.disposed) return;
    this.input.beginFrame();
    this.renderClock += frameDt;
    const world = this.world;
    const phase = world.phase;
    if (phase === 'wasted' || phase === 'busted') {
      if (this.slowMoTimer > 0) {
        this.slowMoTimer -= frameDt;
        if (this.slowMoTimer <= 0) { this.loop.paused = true; this.loop.timeScale = 1; }
      }
      if (this.respawnTimer > 0) {
        this.respawnTimer -= frameDt;
        if (this.respawnTimer <= 0) this.respawn();
      }
    }
    const cam = this.camera;
    if (cam) cam.update(alpha, frameDt);
    const camX = cam ? cam.x : 0, camZ = cam ? cam.z : 0;
    const t = this.renderClock;
    // Sky/lights first (materials read the night factor), then entity renderers, then effects.
    this.dayNight.sunDir(this.sunDir);
    const nf = this.dayNight.nightFactor();
    const settings = this.ctx.settings();
    const px = world.player.curr.x, pz = world.player.curr.z;
    if (this.sky) this.sky.update(world.time.hour, this.sunDir, nf, px, pz, settings.quality === 'high' && settings.shadows);
    if (this.renderer) { this.renderer.setBloomForNight(nf); this.renderer.setGrade(nf, duskFactor(this.sunDir.y), t); }
    if (this.cityRenderer) this.cityRenderer.update(t, nf, px, pz);
    if (this.vehicleRenderer) { this.vehicleRenderer.setNightFactor(nf); this.vehicleRenderer.sync(world, alpha, t, camX, camZ); }
    if (this.playerRenderer) this.playerRenderer.sync(world, alpha, frameDt);
    if (this.pedRenderer) this.pedRenderer.sync(world, alpha, camX, camZ);
    if (this.markers) this.markers.update(world, t);
    if (this.effects) this.effects.update(world, alpha, frameDt);
    // Audio follows the player; engine/skid/wind fall silent outside 'playing'.
    if (phase === 'playing') this.audioSys.frameUpdate(frameDt, world);
    else { this.audioSys.setEngine(false, 0, 0); this.audioSys.setSkid(0); this.audioSys.setSpeedWind(0); this.audioSys.frameUpdate(frameDt); }
    if (this.renderer) {
      // Dynamic resolution: a struggling GPU loses pixels rather than frames (never touches the quality preset).
      if (phase === 'playing') this.renderer.adapt(this.loop.fps, frameDt);
      this.renderer.render();
    }
    if (this.firstFrameResolve) {
      const r = this.firstFrameResolve;
      this.firstFrameResolve = null;
      r();
    }
  };

  private readonly onLockChange = (locked: boolean): void => {
    this.lastLockChangeMs = nowMs();
    this.store.setState({ pointerLocked: locked });
    if (!locked && this.world.phase === 'playing') this.pause();
  };

  /** Esc pause/resume (debounced against pointer-lock changes), M mute; F3 is DebugOverlay's, L/V are read by systems/camera. */
  private readonly onRawKey = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.audio.unlock(); // a keydown is a user gesture: creates/resumes the AudioContext
    const phase = this.world.phase;
    if (e.code === 'Escape') {
      if (e.defaultPrevented) return; // a menu widget (e.g. a Select dropdown) already consumed this Esc
      if (nowMs() - this.lastLockChangeMs < ESC_DEBOUNCE_MS) return;
      if (phase === 'playing') this.pause();
      else if (phase === 'paused') this.resume();
    } else if (e.code === 'KeyM' && (phase === 'playing' || phase === 'paused')) {
      this.toggleMute();
    }
  };

  private readonly onClick = (): void => {
    const phase = this.world.phase;
    if (phase === 'playing') {
      this.audio.unlock();
      if (!this.input.pointerLocked) this.input.requestPointerLock();
    } else if ((phase === 'wasted' || phase === 'busted') && this.respawnTimer < RESPAWN_SECONDS - CLICK_RESPAWN_AFTER) {
      this.respawn();
    }
  };

  private onGameOver(reason: 'wasted' | 'busted'): void {
    if (this.world.phase !== 'playing') return;
    this.store.setState({ gameOverReason: reason });
    this.setPhase(reason);
    this.input.exitPointerLock();
    this.audio.playUi(reason);
  }
}
