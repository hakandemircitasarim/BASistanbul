// Render test page (/rendertest?hour=19&view=plaza|beach|spawn|neon|fx&cam=x,y,z&look=x,y,z&quality=low|high&run=1&fx=1): city + sky at a fixed camera, no Engine. Track B.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Renderer } from '@/game/render/Renderer';
import { TextureFactory } from '@/game/render/TextureFactory';
import { Materials } from '@/game/render/Materials';
import { CityRenderer } from '@/game/render/CityRenderer';
import { SkySystem } from '@/game/render/SkySystem';
import { MarkerRenderer } from '@/game/render/MarkerRenderer';
import { EffectsRenderer } from '@/game/render/EffectsRenderer';
import { DayNightSystem } from '@/game/systems/DayNightSystem';
import { generateCity } from '@/game/city/CityGenerator';
import { World } from '@/game/world/World';
import { Random } from '@/game/core/Random';
import { EventBus } from '@/game/core/EventBus';
import { DEFAULT_SETTINGS } from '@/game/state/GameStore';
import type { Settings } from '@/game/state/GameStore';
import type { Vec3 } from '@/game/core/Types';
import { Vehicle } from '@/game/entities/Vehicle';
import { SPECS } from '@/game/entities/VehicleSpecs';

interface RenderDebug { drawCalls: number; triangles: number; hour: number; staticDraws: number; nightFactor: number; errors: string[] }
type DebugWindow = { __GAME_DEBUG__?: () => RenderDebug };

interface View { x: number; y: number; z: number; tx: number; ty: number; tz: number }
const VIEWS: Record<string, View> = {
  // Plaza (6,5) east edge looking west at the tower on block (5,5).
  plaza: { x: 808, y: 9, z: 690, tx: 648, ty: 48, tz: 640 },
  // Promenade near the spawn looking south-east over the beach to the pier and ferris wheel.
  beach: { x: 1188, y: 8, z: 520, tx: 1330, ty: 10, tz: 600 },
  // Player spawn on the beachfront block looking north along the road.
  spawn: { x: 1045, y: 4, z: 640, tx: 1080, ty: 12, tz: 420 },
  // Beachfront street with neon-sign facades (signs face south at z ~ 575).
  neon: { x: 1070, y: 5, z: 612, tx: 1088, ty: 14, tz: 575 },
  // Plaza (6,5) center from above for the effects demo (?fx=1).
  fx: { x: 764, y: 11, z: 670, tx: 764, ty: 1, tz: 646 },
};
const FX_CENTER = { x: 764, z: 648, r: 12 };

export default function RenderTest() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const p = new URLSearchParams(window.location.search);
    const hourParam = Number(p.get('hour'));
    const hour = p.has('hour') && isFinite(hourParam) ? hourParam : 18.7;
    const quality: Settings['quality'] = p.get('quality') === 'high' ? 'high' : 'low';
    // ?cam=x,y,z&look=x,y,z overrides the named view (close-up inspection of a facade, a car, a landmark).
    const nums = (v: string | null, n: number): number[] | null => {
      const a = (v ?? '').split(',').map(Number);
      return a.length === n && a.every((q) => isFinite(q)) ? a : null;
    };
    const camAt = nums(p.get('cam'), 3), look = nums(p.get('look'), 3);
    const named = VIEWS[p.get('view') ?? 'plaza'] ?? VIEWS.plaza;
    const view: View = camAt && look
      ? { x: camAt[0], y: camAt[1], z: camAt[2], tx: look[0], ty: look[1], tz: look[2] }
      : named;
    const run = p.get('run') === '1';
    const fx = p.get('fx') === '1';
    const settings: Settings = { ...DEFAULT_SETTINGS, quality, shadows: quality === 'high' };
    const errors: string[] = [];
    const onError = (e: ErrorEvent): void => { errors.push(e.message); };
    window.addEventListener('error', onError);

    const renderer = new Renderer(canvas, settings);
    const gen = generateCity();
    const world = new World(gen, new Random(1));
    const events = new EventBus();
    const tex = new TextureFactory();
    const materials = new Materials(tex);
    const city = new CityRenderer(renderer.scene, gen.city, gen.roads, materials, tex);
    city.build();
    const sky = new SkySystem(renderer.scene, renderer.camera, tex);
    const dayNight = new DayNightSystem();
    dayNight.setHour(hour);
    const markers = new MarkerRenderer(renderer.scene, materials, (out) => {
      const ms = gen.city.points.missionStarts;
      const n = Math.min(ms.length, out.length);
      for (let i = 0; i < n; i++) { out[i].x = ms[i].x; out[i].z = ms[i].z; }
      return n;
    });
    const effects = new EffectsRenderer(renderer.scene, events, tex);
    // Effects demo: a car circling the plaza fountain while drifting, a collision burst every 2 s, one explosion at t = 1 s.
    let fxCar: Vehicle | null = null;
    let fxNextBurst = 2, fxNextBoom = 1;
    if (fx) {
      fxCar = new Vehicle(SPECS.sport, FX_CENTER.x + FX_CENTER.r, FX_CENTER.z, 0, 'abandoned', 0xff7a00);
      fxCar.smoke = 1;
      world.addVehicle(fxCar);
    }
    const cam = renderer.camera;
    cam.position.set(view.x, view.y, view.z);
    cam.lookAt(new THREE.Vector3(view.tx, view.ty, view.tz));
    const sunDir: Vec3 = { x: 0, y: 1, z: 0 };
    let nightFactor = 0;
    let raf = 0;
    let last = performance.now();
    const t0 = last;
    const frame = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      if (run) dayNight.fixedUpdate(dt);
      if (fxCar) {
        const a = t * 1.2, c = FX_CENTER;
        fxCar.prev.x = fxCar.curr.x; fxCar.prev.z = fxCar.curr.z;
        fxCar.curr.x = c.x + Math.cos(a) * c.r; fxCar.curr.z = c.z + Math.sin(a) * c.r;
        fxCar.vx = -Math.sin(a) * c.r * 1.2; fxCar.vz = Math.cos(a) * c.r * 1.2;
        fxCar.curr.yaw = Math.atan2(fxCar.vx, fxCar.vz) + 0.5;
        events.emit('fx:skid', { vehicleId: fxCar.id, intensity: 0.8 });
        if (t > fxNextBurst) { fxNextBurst += 2; events.emit('vehicle:collision', { aId: fxCar.id, bId: null, impactSpeed: 12, damage: 10, x: fxCar.curr.x, z: fxCar.curr.z, playerInvolved: false, bIsPolice: false }); }
        if (t > fxNextBoom) { fxNextBoom += 2.5; events.emit('vehicle:destroyed', { id: fxCar.id, byPlayer: false, x: c.x, z: c.z }); }
      }
      dayNight.sunDir(sunDir);
      nightFactor = dayNight.nightFactor();
      renderer.setBloomForNight(nightFactor);
      renderer.setGrade(nightFactor, sunDir.y > -0.05 && sunDir.y < 0.15 ? 1 : 0, t);
      sky.update(dayNight.hour(), sunDir, nightFactor, cam.position.x, cam.position.z, settings.shadows);
      city.update(t, nightFactor, cam.position.x, cam.position.z);
      markers.update(world, t);
      effects.update(world, 0, dt);
      renderer.render();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    (window as unknown as DebugWindow).__GAME_DEBUG__ = () => ({
      drawCalls: renderer.drawCalls, triangles: renderer.triangles, hour: Math.round(dayNight.hour() * 100) / 100,
      staticDraws: city.staticDraws, nightFactor: Math.round(nightFactor * 100) / 100, errors: errors.slice(),
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('error', onError);
      delete (window as unknown as DebugWindow).__GAME_DEBUG__;
      effects.dispose();
      markers.dispose();
      sky.dispose();
      city.dispose();
      materials.dispose();
      tex.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#050308' }}>
      <canvas ref={ref} style={{ display: 'block' }} />
    </div>
  );
}
