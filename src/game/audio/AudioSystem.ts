// Procedural WebAudio: engine synth with fake gears, horns, sirens (2 voices), surf/wind ambience, impacts, skid, UI jingles; lazy context, never throws. Track E.
import type { AudioLike, UiSound } from '../systems/System';
import type { EventBus } from '../core/EventBus';
import type { World } from '../world/World';
import type { Vec2 } from '../core/Types';
import { BEACH_X0 } from '../city/CityConfig';
import { clamp, damp } from '../core/math';

export const AUDIO_TUNING = {
  masterGain: 0.8, engineGainMin: 0.05, engineGainMax: 0.2, engineFreqMin: 42, engineFreqMax: 150, filterBase: 300, filterLoad: 1800,
  gearBands: [0.14, 0.32, 0.58, 1.0], idleRpm: 0.22, rpmLambda: 6, hornGain: 0.25, hornRange: 90, sirenGain: 0.16, sirenRange: 230,
  sirenLfoHz: 1.1, sirenLow: 650, sirenHigh: 1150, surfGain: 0.22, surfRange: 380, surfLfoHz: 0.1, windGain: 0.22, skidGain: 0.28,
  impactGain: 0.7, listenerLambda: 8,
};

const SIREN_VOICES = 2;
const noop = (): void => { /* swallow */ };

interface Voice { osc: OscillatorNode; lfo: OscillatorNode; gain: GainNode; pan: StereoPannerNode | null; active: boolean; x: number; z: number }

type Ctor = new () => AudioContext;

function contextCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class AudioSystem implements AudioLike {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engOscA: OscillatorNode | null = null;
  private engOscB: OscillatorNode | null = null;
  private engFilter: BiquadFilterNode | null = null;
  private engGain: GainNode | null = null;
  private surfGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private skidGain: GainNode | null = null;
  private readonly voices: Voice[] = [];
  private _muted = false;
  private volume = 1;
  private failed = false;
  private time = 0;
  // Targets written by the sim / frameUpdate, smoothed toward in frameUpdate.
  private engActive = false;
  private engRpm = 0;
  private engLoad = 0;
  private rpmSmooth = 0;
  private skidTarget = 0;
  private skidSmooth = 0;
  private windTarget = 0;
  private sirenCount = 0;
  private readonly sirenPos: Vec2[] = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
  private listenerX = 0;
  private listenerZ = 0;
  private listenerYaw = 0;
  private lastImpactAt = -1;
  private events: EventBus | null = null;

  constructor(events?: EventBus) {
    if (events) this.subscribe(events);
  }

  get muted(): boolean { return this._muted; }

  // ---- lifecycle ----

  /** Creates/resumes the context on a user gesture. Never throws. */
  unlock(): void {
    if (this.failed) return;
    try {
      if (!this.ctx) this.create();
      const c = this.ctx;
      if (c && c.state === 'suspended') c.resume().catch(noop);
    } catch {
      this.failed = true;
    }
  }

  private create(): void {
    const Ctor = contextCtor();
    if (!Ctor) { this.failed = true; return; }
    const c = new Ctor();
    this.ctx = c;
    const T = AUDIO_TUNING;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    comp.connect(c.destination);
    const master = c.createGain();
    master.gain.value = this._muted ? 0 : this.volume * T.masterGain;
    master.connect(comp);
    this.master = master;
    this.noise = this.makeNoise(c, 2, 0.02);
    // Engine: saw + square an octave down -> lowpass -> gain
    const a = c.createOscillator(); a.type = 'sawtooth';
    const b = c.createOscillator(); b.type = 'square'; b.detune.value = -1200;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = T.filterBase; f.Q.value = 1.2;
    const g = c.createGain(); g.gain.value = 0;
    a.connect(f); b.connect(f); f.connect(g); g.connect(master);
    a.start(); b.start();
    this.engOscA = a; this.engOscB = b; this.engFilter = f; this.engGain = g;
    // Surf: brown-ish noise through a lowpass
    this.surfGain = this.noiseLoop(c, 'lowpass', 420, 0.6, master);
    // Wind: bandpass noise
    this.windGain = this.noiseLoop(c, 'bandpass', 700, 0.7, master);
    // Skid: bandpass noise
    this.skidGain = this.noiseLoop(c, 'bandpass', 1500, 2.5, master);
    // Sirens
    for (let i = 0; i < SIREN_VOICES; i++) this.voices.push(this.makeVoice(c, master));
  }

  private makeNoise(c: AudioContext, seconds: number, brown: number): AudioBuffer {
    const len = Math.floor(c.sampleRate * seconds);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + brown * w) / (1 + brown);
      d[i] = brown > 0 ? last * 3.5 : w;
    }
    return buf;
  }

  private noiseLoop(c: AudioContext, type: BiquadFilterType, freq: number, q: number, dest: AudioNode): GainNode {
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(dest);
    src.start();
    return g;
  }

  private makeVoice(c: AudioContext, dest: AudioNode): Voice {
    const T = AUDIO_TUNING;
    const osc = c.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = (T.sirenLow + T.sirenHigh) * 0.5;
    const lfo = c.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = T.sirenLfoHz;
    const depth = c.createGain();
    depth.gain.value = (T.sirenHigh - T.sirenLow) * 0.5;
    lfo.connect(depth);
    depth.connect(osc.frequency);
    const gain = c.createGain();
    gain.gain.value = 0;
    let pan: StereoPannerNode | null = null;
    if (typeof c.createStereoPanner === 'function') {
      pan = c.createStereoPanner();
      osc.connect(gain); gain.connect(pan); pan.connect(dest);
    } else {
      osc.connect(gain); gain.connect(dest);
    }
    osc.start(); lfo.start();
    return { osc, lfo, gain, pan, active: false, x: 0, z: 0 };
  }

  dispose(): void {
    if (this.events) this.unsubscribe(this.events);
    const c = this.ctx;
    this.ctx = null;
    if (c) c.close().catch(noop);
  }

  // ---- AudioLike ----

  setMuted(m: boolean): void {
    this._muted = m;
    this.applyMaster();
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    this.applyMaster();
  }

  private applyMaster(): void {
    const c = this.ctx, m = this.master;
    if (!c || !m) return;
    try { m.gain.setTargetAtTime(this._muted ? 0 : this.volume * AUDIO_TUNING.masterGain, c.currentTime, 0.03); } catch { /* locked */ }
  }

  playImpact(strength01: number): void {
    const c = this.ctx, m = this.master, noise = this.noise;
    if (!c || !m || !noise || this._muted) return;
    const s = clamp(strength01, 0, 1);
    if (s < 0.05) return;
    if (this.time - this.lastImpactAt < 0.05) return;
    this.lastImpactAt = this.time;
    try {
      const t = c.currentTime;
      const src = c.createBufferSource();
      src.buffer = noise;
      const f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 900 + 2500 * s;
      const g = c.createGain();
      g.gain.setValueAtTime(AUDIO_TUNING.impactGain * s, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18 + 0.25 * s);
      src.connect(f); f.connect(g); g.connect(m);
      src.start(t); src.stop(t + 0.5);
      const thump = c.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(80, t);
      thump.frequency.exponentialRampToValueAtTime(35, t + 0.3);
      const tg = c.createGain();
      tg.gain.setValueAtTime(0.6 * s, t);
      tg.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      thump.connect(tg); tg.connect(m);
      thump.start(t); thump.stop(t + 0.4);
    } catch { /* locked */ }
  }

  /** Short tone helper for jingles. */
  private tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number, slideTo = 0): void {
    const c = this.ctx, m = this.master;
    if (!c || !m) return;
    const t = c.currentTime + start;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo > 0) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(m);
    o.start(t); o.stop(t + dur + 0.05);
  }

  playUi(kind: UiSound): void {
    if (!this.ctx || this._muted) return;
    try {
      switch (kind) {
        case 'money': this.tone(523, 0, 0.12, 'square', 0.12); this.tone(659, 0.1, 0.12, 'square', 0.12); this.tone(784, 0.2, 0.12, 'square', 0.12); this.tone(1047, 0.3, 0.3, 'square', 0.14); break;
        case 'wanted': this.tone(880, 0, 0.18, 'square', 0.16, 440); this.tone(660, 0.2, 0.25, 'square', 0.16, 330); break;
        case 'star': this.tone(1320, 0, 0.08, 'triangle', 0.14); this.tone(1760, 0.08, 0.16, 'triangle', 0.14); break;
        case 'busted': case 'wasted': this.tone(220, 0, 1.2, 'sawtooth', 0.22, 55); this.tone(110, 0.1, 1.2, 'sawtooth', 0.16, 40); break;
        case 'fail': this.tone(330, 0, 0.25, 'sawtooth', 0.14, 165); this.tone(247, 0.25, 0.4, 'sawtooth', 0.14, 120); break;
        case 'missionStart': this.tone(392, 0, 0.12, 'triangle', 0.14); this.tone(523, 0.12, 0.12, 'triangle', 0.14); this.tone(784, 0.24, 0.3, 'triangle', 0.16); break;
        case 'missionComplete': this.tone(523, 0, 0.15, 'triangle', 0.15); this.tone(659, 0.15, 0.15, 'triangle', 0.15); this.tone(784, 0.3, 0.15, 'triangle', 0.15); this.tone(1047, 0.45, 0.5, 'triangle', 0.18); this.tone(1319, 0.6, 0.6, 'triangle', 0.12); break;
        case 'confirm': this.tone(660, 0, 0.1, 'square', 0.1); this.tone(990, 0.08, 0.15, 'square', 0.1); break;
        default: this.tone(880, 0, 0.06, 'square', 0.08); break;
      }
    } catch { /* locked */ }
  }

  playHorn(durationSec: number, x: number, z: number): void {
    const c = this.ctx, m = this.master;
    if (!c || !m || this._muted) return;
    const T = AUDIO_TUNING;
    const d = Math.sqrt((x - this.listenerX) ** 2 + (z - this.listenerZ) ** 2);
    const att = clamp(1 - d / T.hornRange, 0, 1);
    if (att <= 0) return;
    try {
      const g = att * att * T.hornGain;
      this.tone(392, 0, durationSec, 'square', g);
      this.tone(494, 0, durationSec, 'square', g * 0.8);
    } catch { /* locked */ }
  }

  setEngine(active: boolean, rpm01: number, load01: number): void {
    this.engActive = active;
    this.engRpm = clamp(rpm01, 0, 1);
    this.engLoad = clamp(load01, 0, 1);
  }

  setSirens(list: Vec2[], count: number): void {
    const n = Math.min(count, SIREN_VOICES, list.length);
    for (let i = 0; i < n; i++) { this.sirenPos[i].x = list[i].x; this.sirenPos[i].z = list[i].z; }
    this.sirenCount = n;
  }

  setSkid(intensity01: number): void { this.skidTarget = clamp(intensity01, 0, 1); }
  setSpeedWind(speed01: number): void { this.windTarget = clamp(speed01, 0, 1); }

  // ---- per frame ----

  /** Smooths every continuous voice; when `world` is given the engine/skid/wind/listener are derived from the player. */
  frameUpdate(frameDt: number, world?: World): void {
    const dt = Math.min(frameDt, 0.1);
    this.time += dt;
    if (world) this.readWorld(world, dt);
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const T = AUDIO_TUNING;
    const now = c.currentTime;
    try {
      // Engine
      const rpmTarget = this.engActive ? Math.max(T.idleRpm, this.engRpm) : 0;
      this.rpmSmooth = damp(this.rpmSmooth, rpmTarget, T.rpmLambda, dt);
      if (this.engOscA && this.engOscB && this.engFilter && this.engGain) {
        const freq = T.engineFreqMin + (T.engineFreqMax - T.engineFreqMin) * this.rpmSmooth;
        this.engOscA.frequency.setTargetAtTime(freq, now, 0.05);
        this.engOscB.frequency.setTargetAtTime(freq, now, 0.05);
        this.engFilter.frequency.setTargetAtTime(T.filterBase + T.filterLoad * this.engLoad * this.rpmSmooth, now, 0.08);
        const g = this.engActive ? T.engineGainMin + (T.engineGainMax - T.engineGainMin) * (0.35 * this.rpmSmooth + 0.65 * this.engLoad) : 0;
        this.engGain.gain.setTargetAtTime(g, now, 0.1);
      }
      // Ambience
      if (this.surfGain) {
        const dBeach = Math.max(0, BEACH_X0 - this.listenerX);
        const base = T.surfGain * clamp(1 - dBeach / T.surfRange, 0, 1);
        this.surfGain.gain.setTargetAtTime(base * (0.65 + 0.35 * Math.sin(this.time * Math.PI * 2 * T.surfLfoHz)), now, 0.2);
      }
      if (this.windGain) this.windGain.gain.setTargetAtTime(T.windGain * this.windTarget * this.windTarget, now, 0.15);
      this.skidSmooth = damp(this.skidSmooth, this.skidTarget, 10, dt);
      if (this.skidGain) this.skidGain.gain.setTargetAtTime(T.skidGain * this.skidSmooth, now, 0.05);
      // Sirens
      const ryx = -Math.cos(this.listenerYaw), ryz = Math.sin(this.listenerYaw);
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        if (i < this.sirenCount) {
          const dx = this.sirenPos[i].x - this.listenerX, dz = this.sirenPos[i].z - this.listenerZ;
          const d = Math.sqrt(dx * dx + dz * dz);
          const att = clamp(1 - d / T.sirenRange, 0, 1);
          v.gain.gain.setTargetAtTime(T.sirenGain * att * att, now, 0.1);
          if (v.pan) v.pan.pan.setTargetAtTime(d > 1 ? clamp(((dx * ryx + dz * ryz) / d) * 0.8, -1, 1) : 0, now, 0.1);
        } else {
          v.gain.gain.setTargetAtTime(0, now, 0.1);
        }
      }
    } catch { /* param errors on a closing context */ }
  }

  private readWorld(world: World, dt: number): void {
    const p = world.player;
    this.listenerX = damp(this.listenerX, p.curr.x, AUDIO_TUNING.listenerLambda, dt);
    this.listenerZ = damp(this.listenerZ, p.curr.z, AUDIO_TUNING.listenerLambda, dt);
    this.listenerYaw = world.playerYaw();
    const v = world.playerVehicle();
    if (v && !v.destroyed) {
      const T = AUDIO_TUNING;
      const speed01 = clamp(Math.abs(v.speed) / v.spec.maxSpeed, 0, 1);
      let lo = 0, hi = T.gearBands[0];
      for (let g = 0; g < T.gearBands.length; g++) {
        if (speed01 <= T.gearBands[g]) { hi = T.gearBands[g]; break; }
        lo = T.gearBands[g];
        hi = g + 1 < T.gearBands.length ? T.gearBands[g + 1] : 1;
      }
      const inGear = clamp((speed01 - lo) / Math.max(1e-3, hi - lo), 0, 1);
      const throttle = Math.abs(v.controls.throttle);
      this.setEngine(true, 0.25 + 0.75 * inGear * (0.6 + 0.4 * throttle) + 0.1 * throttle, throttle);
      this.setSkid(v.drifting || (v.controls.handbrake && Math.abs(v.speed) > 4) ? clamp(Math.abs(v.lateral) / 8 + 0.3, 0, 1) : 0);
      this.setSpeedWind(speed01);
    } else {
      this.setEngine(false, 0, 0);
      this.setSkid(0);
      this.setSpeedWind(clamp(Math.sqrt(p.vx * p.vx + p.vz * p.vz) / 30, 0, 1));
    }
  }

  // ---- events ----

  private readonly onHorn = (p: { x: number; z: number }): void => { this.playHorn(0.4, p.x, p.z); };
  private readonly onCollision = (p: { impactSpeed: number; x: number; z: number; playerInvolved: boolean }): void => {
    const d = Math.sqrt((p.x - this.listenerX) ** 2 + (p.z - this.listenerZ) ** 2);
    const att = p.playerInvolved ? 1 : clamp(1 - d / 80, 0, 1);
    this.playImpact(clamp(p.impactSpeed / 18, 0, 1) * att);
  };
  private readonly onPedHit = (p: { speed: number; x: number; z: number }): void => {
    const d = Math.sqrt((p.x - this.listenerX) ** 2 + (p.z - this.listenerZ) ** 2);
    this.playImpact(clamp(p.speed / 20, 0.15, 0.6) * clamp(1 - d / 60, 0, 1));
  };
  private readonly onDestroyed = (p: { x: number; z: number }): void => {
    const d = Math.sqrt((p.x - this.listenerX) ** 2 + (p.z - this.listenerZ) ** 2);
    this.playImpact(clamp(1 - d / 160, 0, 1));
    this.playUi('fail');
  };
  private readonly onMissionStarted = (): void => { this.playUi('missionStart'); };
  private readonly onMissionCompleted = (): void => { this.playUi('missionComplete'); };
  private readonly onMissionFailed = (): void => { this.playUi('fail'); };
  private readonly onMoney = (p: { delta: number }): void => { if (p.delta > 0) this.playUi('money'); };
  private readonly onWanted = (p: { stars: number; prev: number }): void => {
    if (p.stars > p.prev) this.playUi(p.prev === 0 ? 'wanted' : 'star');
  };

  private subscribe(e: EventBus): void {
    this.events = e;
    e.on('horn', this.onHorn);
    e.on('vehicle:collision', this.onCollision);
    e.on('ped:hit', this.onPedHit);
    e.on('vehicle:destroyed', this.onDestroyed);
    e.on('mission:started', this.onMissionStarted);
    e.on('mission:completed', this.onMissionCompleted);
    e.on('mission:failed', this.onMissionFailed);
    e.on('money:changed', this.onMoney);
    e.on('wanted:changed', this.onWanted);
  }

  private unsubscribe(e: EventBus): void {
    e.off('horn', this.onHorn);
    e.off('vehicle:collision', this.onCollision);
    e.off('ped:hit', this.onPedHit);
    e.off('vehicle:destroyed', this.onDestroyed);
    e.off('mission:started', this.onMissionStarted);
    e.off('mission:completed', this.onMissionCompleted);
    e.off('mission:failed', this.onMissionFailed);
    e.off('money:changed', this.onMoney);
    e.off('wanted:changed', this.onWanted);
    this.events = null;
  }
}
