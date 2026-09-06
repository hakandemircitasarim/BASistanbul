// Track B tests: DayNightSystem clock/sun/night factor/AI lights, building UVs in meters, landmark parts, sky keys. Track B.
import { test, expect, approx, createHeadless } from './harness';
import { DayNightSystem, DAY_TUNING } from '../../src/game/systems/DayNightSystem';
import { BAND, GeoBuilder, appendBuildingDetail, appendStreetLevel, buildingGeometry, landmarkGeometries, massingOf } from '../../src/game/render/BuildingGeometry';
import { Random } from '../../src/game/core/Random';
import { SKY_KEYS } from '../../src/game/render/SkySystem';
import { Vehicle } from '../../src/game/entities/Vehicle';
import { SPECS } from '../../src/game/entities/VehicleSpecs';
import type { Building, Landmark } from '../../src/game/city/CityData';
import type { Vec3 } from '../../src/game/core/Types';

test('DayNight: clock advances 24 h per dayLengthSec and emits time:hourChanged', () => {
  const h = createHeadless({ hour: 17.99, systems: () => [new DayNightSystem()] });
  const hours: number[] = [];
  h.ctx.events.on('time:hourChanged', (p) => hours.push(p.hour));
  h.secs(1);
  approx(h.world.time.hour, 17.99 + 24 / DAY_TUNING.dayLengthSec, 0.01, 'one real second = 24/600 h');
  expect(hours.length === 1 && hours[0] === 18, `hourChanged fired once with 18 (got ${JSON.stringify(hours)})`);
  h.secs(DAY_TUNING.dayLengthSec);
  expect(h.world.time.hour >= 17.9 && h.world.time.hour < 18.2, `wrapped around a full day (hour ${h.world.time.hour})`);
});

test('DayNight: sun direction is a unit vector, high at noon, below the horizon at 22:00; night factor 0 / 1', () => {
  const dn = new DayNightSystem();
  const d: Vec3 = { x: 0, y: 0, z: 0 };
  dn.setHour(12.75);
  dn.sunDir(d);
  approx(Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z), 1, 1e-6, 'unit length');
  expect(d.y > 0.7, `sun high at 12:45 (y ${d.y})`);
  expect(dn.nightFactor() === 0, 'no night at noon');
  // South lean: the noon sun sits at ~49 deg (not overhead) so facades and lamp posts throw readable shadows.
  dn.setHour(12);
  const noonDeg = (dn.sunElevation() * 180) / Math.PI;
  expect(noonDeg > 40 && noonDeg < 55, `noon elevation between 40 and 55 deg (got ${noonDeg.toFixed(1)})`);
  dn.sunDir(d);
  expect(d.z > 0.4, `noon sun leans south (+Z) (z ${d.z})`);
  dn.setHour(6.75);
  dn.sunDir(d);
  expect(d.x > 0.9 && Math.abs(d.y) < 0.05, 'sun rises in the east (+X)');
  dn.setHour(22);
  dn.sunDir(d);
  expect(d.y < -0.3, `sun below the horizon at 22:00 (y ${d.y})`);
  expect(dn.nightFactor() === 1, 'full night at 22:00');
  expect(dn.sunElevation() < 0, 'negative elevation at night');
  dn.setHour(18.0);
  expect(dn.nightFactor() < 0.15, `still day at 18:00 (nf ${dn.nightFactor()})`);
  dn.setHour(19.0);
  const dusk = dn.nightFactor();
  expect(dusk > 0.15 && dusk < 0.8, `dusk at 19:00 is in between (nf ${dusk})`);
  dn.setHour(19.75);
  expect(dn.nightFactor() > 0.95, `night by 19:45 (nf ${dn.nightFactor()})`);
  dn.setHour(25.5);
  approx(dn.hour(), 1.5, 1e-9, 'setHour wraps');
});

test('DayNight: AI vehicle headlights follow nightFactor > 0.5, player/parked untouched', () => {
  const h = createHeadless({ hour: 12, systems: () => [new DayNightSystem()] });
  const traffic = h.world.addVehicle(new Vehicle(SPECS.sedan, 100, 100, 0, 'traffic', 0xffffff));
  const parked = h.world.addVehicle(new Vehicle(SPECS.sedan, 110, 100, 0, 'parked', 0xffffff));
  const mine = h.world.addVehicle(new Vehicle(SPECS.sport, 120, 100, 0, 'player', 0xffffff));
  mine.occupiedByPlayer = true;
  mine.lightsOn = true;
  h.step(1);
  expect(!traffic.lightsOn && !parked.lightsOn && mine.lightsOn, 'day: AI lights off, player untouched');
  const dn = h.systems[0] as DayNightSystem;
  dn.setHour(22);
  h.step(1);
  expect(traffic.lightsOn, 'night: traffic lights on');
  expect(!parked.lightsOn, 'night: parked cars stay dark');
  expect(mine.lightsOn, 'night: player lights untouched');
});

const sampleBuilding = (over: Partial<Building>): Building => ({
  id: 7, x: 100, z: 200, w: 32, d: 16, h: 56, style: 'glass', color: 0x8090a0, accent: 0xff7a00, roofKind: 'flat', hasNeonSign: false, neonColor: 0, district: 'downtown', facing: 0, ...over,
});

test('BuildingGeometry: side UVs are in meters (u = width/16, v = height/28), roof uses the plain strip, vertex colors present', () => {
  const g = buildingGeometry(sampleBuilding({}));
  const pos = g.attributes.position, uv = g.attributes.uv, col = g.attributes.color;
  expect(pos.count === 20 && uv.count === 20 && col.count === 20, `flat box = 5 faces x 4 verts (got ${pos.count})`);
  // South face (first quad): u spans w/16 = 2, v spans (56 - (-0.2)) / 28 (+ per-building whole-window offset).
  const u0 = uv.getX(0), u1 = uv.getX(1), v0 = uv.getY(0), v1 = uv.getY(2);
  approx(u1 - u0, 32 / 16, 1e-6, 'u spans width / 16');
  approx(v1 - v0, 56.2 / 28, 1e-6, 'v spans height / 28');
  // Base sits at y = -0.2 (hidden under the block plane), so v0 = -0.2/28 + whole-cell offset.
  const cellsU = u0 * 4, cellsV = (v0 + 0.2 / 28) * 8;
  expect(Math.abs(cellsU - Math.round(cellsU)) < 1e-6 && Math.abs(cellsV - Math.round(cellsV)) < 1e-6, 'UV offsets are whole window cells');
  // Roof quad = last 4 vertices: v in the plain strip, darker color than the walls.
  expect(uv.getY(16) > 0.98, 'roof v in the plain strip');
  expect(col.getX(16) < col.getX(0), 'roof darker than wall');
  expect(g.boundingSphere !== null && g.boundingSphere.radius > 20, 'bounding sphere computed');
  const stepped = buildingGeometry(sampleBuilding({ roofKind: 'stepped', h: 60 }));
  expect(stepped.attributes.position.count > pos.count, 'stepped roof has more than one tier');
  const spire = buildingGeometry(sampleBuilding({ roofKind: 'spire' }));
  let maxY = 0;
  for (let i = 0; i < spire.attributes.position.count; i++) maxY = Math.max(maxY, spire.attributes.position.getY(i));
  expect(maxY > 56, 'spire rises above the box');
});

test('BuildingGeometry: street level = band box in the band builder + cornice/awnings in the style builder; trim stays separate and cheap', () => {
  const style = new GeoBuilder(), band = new GeoBuilder(), rng = new Random(3);
  const shop = sampleBuilding({ district: 'suburb', style: 'residential', h: 14.2, w: 16, d: 12 });
  appendStreetLevel(style, band, shop, rng, false);
  expect(band.vertexCount === 16, `shop band = 4 faces (got ${band.vertexCount / 4} quads)`);
  // Band v spans exactly 0..1 over the band height, and the band tops out at SHOP_BAND_H.
  const bg = band.build();
  let maxY = 0, maxV = 0;
  for (let i = 0; i < bg.attributes.position.count; i++) { maxY = Math.max(maxY, bg.attributes.position.getY(i)); maxV = Math.max(maxV, bg.attributes.uv.getY(i)); }
  approx(maxY, BAND.shopH, 1e-6, 'band height = SHOP_BAND_H');
  approx(maxV, 1, 1e-6, 'band v spans 0..1');
  // Cornice (5 quads) + 4 two-sided awning segments x 2 quads x 2 sides = 16 quads.
  expect(style.vertexCount === (5 + 16) * 4, `cornice + awnings = 21 quads (got ${style.vertexCount / 4})`);
  const plinthStyle = new GeoBuilder(), plinth = new GeoBuilder();
  appendStreetLevel(plinthStyle, plinth, sampleBuilding({}), rng, true);
  expect(plinth.vertexCount === 16 && plinthStyle.vertexCount === 20, 'downtown plinth: band + cornice, no awnings');
  // Detail pass: roof trim goes to the trim builder, the style builder only gets textured tiers / facade dressing.
  const gb = new GeoBuilder(), trim = new GeoBuilder();
  const low = sampleBuilding({ id: 4, district: 'suburb', style: 'concrete', h: 10.7, w: 20, d: 16 });
  appendBuildingDetail(gb, trim, low, new Random(1), []);
  expect(massingOf(low).kind === 'box', 'low flat suburb building is a box');
  expect(trim.vertexCount > 0 && trim.vertexCount <= 20 * 4, `roof under 12 m: coping band only, no walls or clutter (got ${trim.vertexCount / 4} quads)`);
  const tall = sampleBuilding({ id: 8, district: 'suburb', style: 'concrete', h: 21.2, w: 24, d: 20 });
  const gb2 = new GeoBuilder(), trim2 = new GeoBuilder();
  appendBuildingDetail(gb2, trim2, tall, new Random(1), []);
  expect(trim2.vertexCount / 4 >= 5 + 12 && trim2.vertexCount / 4 <= 80, `tall roof: coping + parapet frame + at most two clutter pieces (got ${trim2.vertexCount / 4} quads)`);
  // Stepped roofs are capped at two tiers whatever the height.
  const stepped = buildingGeometry(sampleBuilding({ id: 2, roofKind: 'stepped', h: 70.2, style: 'glass' }));
  expect(stepped.attributes.position.count === 2 * 20, `two tiers = 2 window boxes (got ${stepped.attributes.position.count / 20})`);
});

test('BuildingGeometry: every landmark kind yields parts; the ferris wheel has a rotating hub part', () => {
  const kinds: Landmark['kind'][] = ['tower', 'arena', 'hospital', 'police', 'lighthouse', 'pier', 'ferris'];
  let total = 0;
  let glowParts = 0;
  for (const kind of kinds) {
    const l: Landmark = { kind, x: 500, z: 500, yaw: 0, w: 40, d: 36, h: kind === 'pier' ? 1.2 : 40, name: kind };
    const parts = landmarkGeometries(l);
    expect(parts.length >= 1, `${kind} has geometry`);
    total += parts.length;
    glowParts += parts.filter((p) => p.style === 'glow').length;
    for (const p of parts) expect(p.geometry.attributes.position.count > 0 && p.geometry.attributes.uv.count > 0, `${kind} part has positions and uvs`);
    if (kind === 'ferris') {
      const rot = parts.filter((p) => p.rotating);
      expect(rot.length >= 1 && rot.every((p) => p.hubY > 10 && p.hubY === rot[0].hubY), 'ferris rotating parts share a raised hub');
      expect(parts.some((p) => p.style === 'glow'), 'ferris neon rings/gondolas are glow parts');
    }
  }
  expect(total - glowParts <= 12 && glowParts <= 7, `landmark meshes ${total - glowParts} <= 12 plus ${glowParts} glow parts (<= 7)`);
});

test('SkySystem: SKY_KEYS ascend in hour, carry fill/ground/fogDensity and hit the sunset palette at 19:00', () => {
  for (let i = 1; i < SKY_KEYS.length; i++) expect(SKY_KEYS[i].hour > SKY_KEYS[i - 1].hour, 'keys ascend');
  const k = SKY_KEYS.find((s) => s.hour === 19);
  expect(k !== undefined && k.horizon === 0xff7a3d && k.top === 0x6a2c8f, 'sunset horizon #ff7a3d / top #6a2c8f');
  expect(k !== undefined && k.fill === 0x554a8c && k.sun === 0xff8a48, 'sunset: orange key against a violet fill');
  for (const s of SKY_KEYS) {
    expect(s.fogDensity >= 0.001 && s.fogDensity <= 0.006, `fog density sane at ${s.hour} (${s.fogDensity})`);
    expect(s.fill !== s.ground, `fill and ground differ at ${s.hour}`);
  }
  const noon = SKY_KEYS.find((s) => s.hour === 12);
  const night = SKY_KEYS.find((s) => s.hour === 22);
  expect(noon !== undefined && night !== undefined && noon.fogDensity < night.fogDensity, 'night fog denser than noon');
  expect(noon !== undefined && noon.sunI > 0 && noon.ambI > 0 && noon.sunI * 1.3 > noon.ambI * 0.5 * 2, 'key stronger than fill at noon');
});
