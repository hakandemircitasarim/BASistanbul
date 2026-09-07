// Track B tests: DayNightSystem clock/sun/night factor/AI lights, building UVs in meters, landmark parts, sky keys. Track B.
import { test, expect, approx, createHeadless } from './harness';
import { DayNightSystem, DAY_TUNING } from '../../src/game/systems/DayNightSystem';
import { ARCADE, BAND, GeoBuilder, appendBuilding, appendBuildingDetail, appendStreetLevel, bandHeight, buildingGeometry, buildingTint, hasCrown, landmarkGeometries, massingOf } from '../../src/game/render/BuildingGeometry';
import { PLINTH_BAYS, PLINTH_TILE_W, SHOP_BAYS, SHOP_TILE_W } from '../../src/game/render/TextureFactory';
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

test('BuildingGeometry: street level = recessed band + arcade columns + cap, awnings in their own builder; trim stays separate and cheap', () => {
  const style = new GeoBuilder(), band = new GeoBuilder(), awning = new GeoBuilder(), rng = new Random(3);
  const shop = sampleBuilding({ district: 'suburb', style: 'residential', h: 14.2, w: 16, d: 12 });
  // Only the street-facing wall (+Z) sees a street: columns on that face and its two corners, nothing on the others.
  appendStreetLevel(style, band, shop, rng, false, awning, 1);
  expect(band.vertexCount === 16, `shop band = 4 faces (got ${band.vertexCount / 4} quads)`);
  // Band v spans exactly 0..1 over the band height, the band tops out at SHOP_BAND_H and stands ARCADE.recess behind the wall.
  const bg = band.build();
  let maxY = 0, maxV = 0, maxZ = -Infinity;
  for (let i = 0; i < bg.attributes.position.count; i++) { maxY = Math.max(maxY, bg.attributes.position.getY(i)); maxV = Math.max(maxV, bg.attributes.uv.getY(i)); maxZ = Math.max(maxZ, bg.attributes.position.getZ(i)); }
  approx(maxY, BAND.shopH, 1e-6, 'band height = SHOP_BAND_H');
  approx(maxV, 1, 1e-6, 'band v spans 0..1');
  approx(maxZ, 200 + 6 - ARCADE.recess, 1e-3, 'shop band recessed behind the wall line');
  // Cap with its soffit (6 quads) + 2 corner columns (4 quads each) + one bay column per shop bay on the 16 m street face (3 quads each).
  let bays = 0;
  for (let s = ARCADE.recess + ARCADE.bay; s < 16 - ARCADE.recess - 1.5; s += ARCADE.bay) bays++;
  expect(bays >= 2, `a 16 m face holds at least two bay columns (got ${bays})`);
  expect(style.vertexCount === (6 + 8 + 3 * bays) * 4, `cap + corner + bay columns = ${6 + 8 + 3 * bays} quads (got ${style.vertexCount / 4})`);
  // The band starts the shop sequence on a whole bay (so the painted piers stay under the columns), picked per face.
  const bayStarts = [0];
  for (let i = 0; i < SHOP_BAYS.length; i++) bayStarts.push(bayStarts[i] + SHOP_BAYS[i].w);
  approx(bayStarts[bayStarts.length - 1], SHOP_TILE_W, 1e-9, 'shop bays fill the tile exactly');
  for (let k = 1; k * ARCADE.bay < SHOP_TILE_W; k++) expect(bayStarts.some((v) => Math.abs(v - k * ARCADE.bay) < 1e-9), `a bay boundary (pier) falls on arcade column line ${k}`);
  const u0 = bg.attributes.uv.getX(0), u0side = bg.attributes.uv.getX(4);
  expect(bayStarts.some((v) => Math.abs(v / SHOP_TILE_W - u0) < 1e-6), `band u offset is a whole bay (u0 ${u0.toFixed(4)})`);
  expect(Math.abs(u0side - u0) > 1e-6, 'adjacent faces start at different bays');
  // Awnings per shop bay: several slope + valance pairs in more than one colour, plus the cafe's hanging sign board;
  // u runs along the span, v from 1 at the wall down to 0 at the hem, and nothing pokes above the arcade cap.
  expect(awning.vertexCount % 4 === 0 && awning.vertexCount / 4 >= 8, `awnings per bay: at least 4 awnings (got ${awning.vertexCount / 4} quads)`);
  const ag = awning.build();
  let vMin = 1, vMax = 0, uMax = 0, yMin = Infinity, yMax = 0;
  const tints = new Set<string>();
  for (let i = 0; i < ag.attributes.position.count; i++) {
    vMin = Math.min(vMin, ag.attributes.uv.getY(i)); vMax = Math.max(vMax, ag.attributes.uv.getY(i)); uMax = Math.max(uMax, ag.attributes.uv.getX(i));
    yMin = Math.min(yMin, ag.attributes.position.getY(i)); yMax = Math.max(yMax, ag.attributes.position.getY(i));
    tints.add(`${ag.attributes.color.getX(i).toFixed(2)},${ag.attributes.color.getY(i).toFixed(2)},${ag.attributes.color.getZ(i).toFixed(2)}`);
  }
  expect(vMin === 0 && vMax === 1 && uMax > 2, `awning v spans 0..1 and u repeats along the span (u max ${uMax.toFixed(2)})`);
  expect(yMax < BAND.shopH - 0.3 && yMin > 2.2 && yMax - yMin > 0.6, `awnings hang under the cap and drop (y ${yMin.toFixed(2)}..${yMax.toFixed(2)})`);
  expect(tints.size >= 3, `awnings come in several colours (got ${tints.size})`);
  // Neighbouring ids render with different tints even on the same palette colour.
  expect(buildingTint(shop) !== buildingTint({ ...shop, id: 8 }), 'render tint differs between neighbouring ids');
  // Downtown plinth: band stretched to whole bays per face, a cap, and an entrance canopy in front of the facing wall.
  const plinthStyle = new GeoBuilder(), plinth = new GeoBuilder();
  const tower = sampleBuilding({});
  appendStreetLevel(plinthStyle, plinth, tower, rng, true, awning, 15);
  expect(plinth.vertexCount === 16 && plinthStyle.vertexCount > 20 && awning.vertexCount === ag.attributes.position.count, 'downtown plinth: flush band + cap + entrance, no columns, no awning');
  const pg = plinth.build();
  const nBays = Math.round((tower.w + 2 * BAND.plinthOut) / (PLINTH_TILE_W / PLINTH_BAYS));
  approx(pg.attributes.uv.getX(1) - pg.attributes.uv.getX(0), nBays / PLINTH_BAYS, 1e-6, `plinth facing wall holds ${nBays} whole bays`);
  const sg = plinthStyle.build();
  let canopyZ = -Infinity, canopyTop = 0;
  for (let i = 0; i < sg.attributes.position.count; i++) { const z = sg.attributes.position.getZ(i); if (z > canopyZ) { canopyZ = z; canopyTop = sg.attributes.position.getY(i); } }
  expect(canopyZ > tower.z + tower.d / 2 + BAND.plinthOut + 2.2 && canopyTop < BAND.plinthH, `entrance canopy reaches 2.5 m over the pavement (z ${canopyZ.toFixed(2)})`);
  // Long street faces split into tint segments (one quad a face otherwise).
  const longG = buildingGeometry(sampleBuilding({ w: 60 }));
  expect(longG.attributes.position.count > 20, `a 60 m face is more than one quad (got ${longG.attributes.position.count / 4} quads)`);
  // Without a street mask a shop still gets its band and cap but no columns.
  const s2 = new GeoBuilder();
  appendStreetLevel(s2, new GeoBuilder(), shop, rng, false, null, 0);
  expect(s2.vertexCount === 6 * 4, `no street faces: cap only (got ${s2.vertexCount / 4} quads)`);
  // Arcade buildings raise their windowed walls to the arcade ceiling.
  const raised = new GeoBuilder();
  appendBuilding(raised, shop, bandHeight(shop, false) - 0.3);
  const rg = raised.build();
  let minY = Infinity;
  for (let i = 0; i < rg.attributes.position.count; i++) minY = Math.min(minY, rg.attributes.position.getY(i));
  approx(minY, BAND.shopH - 0.3, 1e-6, 'walls start at the arcade ceiling');
  // Detail pass: roof trim goes to the trim builder, the style builder only gets textured tiers / facade relief.
  const gb = new GeoBuilder(), trim = new GeoBuilder();
  const low = sampleBuilding({ id: 4, district: 'suburb', style: 'concrete', h: 10.7, w: 20, d: 16 });
  appendBuildingDetail(gb, trim, low, new Random(1), [], 0);
  expect(massingOf(low).kind === 'box', 'low flat suburb building is a box');
  expect(trim.vertexCount === 13 * 4, `roof under 12 m: two-step cornice only (13 quads), no walls or clutter (got ${trim.vertexCount / 4} quads)`);
  expect(gb.vertexCount === 0, 'no street faces: no relief on the style mesh');
  // With one street face the concrete building gets a ledge per window row and a pier per bay line on that face.
  const gbR = new GeoBuilder();
  appendBuildingDetail(gbR, new GeoBuilder(), low, new Random(1), [], 1, BAND.shopH);
  expect(gbR.vertexCount > 0 && gbR.vertexCount % 4 === 0, `ledges + piers on the street face (got ${gbR.vertexCount / 4} quads)`);
  const tall = sampleBuilding({ id: 8, district: 'suburb', style: 'concrete', h: 21.2, w: 24, d: 20 });
  const gb2 = new GeoBuilder(), trim2 = new GeoBuilder();
  appendBuildingDetail(gb2, trim2, tall, new Random(1), [], 0);
  expect(trim2.vertexCount / 4 >= 13 + 12 && trim2.vertexCount / 4 <= 80, `tall roof: cornice + parapet frame + at most one clutter piece (got ${trim2.vertexCount / 4} quads)`);
  // Stepped roofs are capped at two tiers whatever the height; a crown tower stops CHAMFER short and the detail pass chamfers it.
  const stepped = buildingGeometry(sampleBuilding({ id: 2, roofKind: 'stepped', h: 70.2, style: 'glass' }));
  expect(stepped.attributes.position.count === 2 * 20, `two tiers = 2 window boxes (got ${stepped.attributes.position.count / 20})`);
  const towerB = sampleBuilding({ id: 4, h: 60 });
  expect(hasCrown(towerB, massingOf(towerB).top), 'a 60 m flat downtown tower has a crown');
  const tg = buildingGeometry(towerB);
  let tMax = 0;
  for (let i = 0; i < tg.attributes.position.count; i++) tMax = Math.max(tMax, tg.attributes.position.getY(i));
  approx(tMax, 58, 1e-6, 'crown tower box stops 2 m short for the chamfer');
  const gb3 = new GeoBuilder(), trim3 = new GeoBuilder();
  appendBuildingDetail(gb3, trim3, towerB, new Random(1), [], 0);
  const cg = gb3.build();
  let cMax = 0;
  for (let i = 0; i < cg.attributes.position.count; i++) cMax = Math.max(cMax, cg.attributes.position.getY(i));
  approx(cMax, 60, 1e-6, 'chamfer reaches the tower top');
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
  expect(k !== undefined && k.horizon === 0xff8a4a && k.top === 0x363284, 'sunset horizon #ff8a4a / top #363284');
  expect(k !== undefined && k.fill === 0x4a5aa0 && k.sun === 0xff8a48, 'sunset: orange key against a cool blue fill');
  for (const s of SKY_KEYS) {
    expect(s.fogDensity >= 0.001 && s.fogDensity <= 0.006, `fog density sane at ${s.hour} (${s.fogDensity})`);
    expect(s.fill !== s.ground, `fill and ground differ at ${s.hour}`);
  }
  const noon = SKY_KEYS.find((s) => s.hour === 12);
  const night = SKY_KEYS.find((s) => s.hour === 22);
  expect(noon !== undefined && night !== undefined && noon.fogDensity < night.fogDensity, 'night fog denser than noon');
  expect(noon !== undefined && noon.sunI > 0 && noon.ambI > 0 && noon.sunI * 1.3 > noon.ambI * 0.5 * 2, 'key stronger than fill at noon');
});
