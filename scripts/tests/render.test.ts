// Track B tests: DayNightSystem clock/sun/night factor/AI lights, building UVs in meters, street level, facade relief and massing, landmark parts, sky keys. Track B.
import { test, expect, approx, createHeadless } from './harness';
import { DayNightSystem, DAY_TUNING } from '../../src/game/systems/DayNightSystem';
import { ARCADE, BAND, GeoBuilder, Outline, appendBuilding, appendBuildingDetail, appendStreetLevel, bandHeight, buildingGeometry, buildingTint, footprint, hasCrown, landmarkGeometries, massingOf } from '../../src/game/render/BuildingGeometry';
import { PLINTH_BAYS, PLINTH_TILE_W, SHOP_BAYS, SHOP_BAY_W, SHOP_DOOR_W, SHOP_FASCIA_Y, SHOP_ROWS, SHOP_TILE_W } from '../../src/game/render/TextureFactory';
import type { BufferGeometry } from 'three';
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

/** Min / max of one attribute component over a geometry. */
const range = (g: BufferGeometry, attr: string, comp: number): [number, number] => {
  const a = g.getAttribute(attr);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < a.count; i++) { const v = comp === 0 ? a.getX(i) : comp === 1 ? a.getY(i) : a.getZ(i); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return [lo, hi];
};
const countWhere = (g: BufferGeometry, pred: (x: number, y: number, z: number) => boolean): number => {
  const p = g.attributes.position;
  let n = 0;
  for (let i = 0; i < p.count; i++) if (pred(p.getX(i), p.getY(i), p.getZ(i))) n++;
  return n;
};

test('BuildingGeometry: side UVs are in meters (u = width/tw, v = height/th), whole-cell offsets, roof uses the plain strip, vertex colors present', () => {
  // A plain suburb box: one segment a face, one vertical band, so the box is still 5 quads.
  const plain = sampleBuilding({ id: 3, district: 'suburb', style: 'concrete', w: 16, d: 12, h: 14 });
  const g = buildingGeometry(plain);
  const pos = g.attributes.position, uv = g.attributes.uv, col = g.attributes.color;
  expect(pos.count === 20 && uv.count === 20 && col.count === 20, `flat box = 5 faces x 4 verts (got ${pos.count})`);
  // South face (first quad): u spans w/16 = 1, v spans (14 - (-0.2)) / 28; offsets are whole cells / whole rows.
  const u0 = uv.getX(0), u1 = uv.getX(1), v0 = uv.getY(0), v1 = uv.getY(2);
  approx(u1 - u0, 16 / 16, 1e-6, 'u spans width / 16');
  approx(v1 - v0, 14.2 / 28, 1e-6, 'v spans height / 28');
  const cellsU = u0 * 4, rowH = ((1 - 20 / 1024) / 8) * 28, rowsV = (v0 * 28 + 0.2) / rowH;
  expect(Math.abs(cellsU - Math.round(cellsU)) < 1e-6 && Math.abs(rowsV - Math.round(rowsV)) < 1e-6, `UV offsets are whole window cells / rows (u ${cellsU.toFixed(3)} rows ${rowsV.toFixed(3)})`);
  expect(v0 >= -0.021 && v1 <= 0.981, `the wall stays inside the tile's window rows, never crossing the roof strip (v ${v0.toFixed(3)}..${v1.toFixed(3)})`);
  // Roof quad = last 4 vertices: v in the plain strip, darker color than the walls.
  expect(uv.getY(16) > 0.98, 'roof v in the plain strip');
  expect(col.getX(16) < col.getX(0), 'roof darker than wall');
  expect(g.boundingSphere !== null && g.boundingSphere.radius > 8, 'bounding sphere computed');
  // Downtown towers cycle their window rhythm: id 7 stretches the glass tile to two storeys a row (th = 56).
  const tower = sampleBuilding({});
  const tg = buildingGeometry(tower);
  const m7 = massingOf(tower);
  expect(m7.th === 56 && m7.tw === 16, `tower id 7 uses the two-storey tile (tw ${m7.tw} th ${m7.th})`);
  const m8 = massingOf(sampleBuilding({ id: 8 }));
  expect(m8.tw === 12, `tower id 8 uses the slender 12 m tile (tw ${m8.tw})`);
  expect(massingOf(plain).tw === 16 && massingOf(plain).th === 28, 'low buildings keep the 16 x 28 tile');
  // Tall walls split into bands of four rows, each with its own cell offset, at the same row lines.
  expect(tg.attributes.position.count > 20, `a 56 m tower face is more than one quad (got ${tg.attributes.position.count / 4})`);
  const stepped = buildingGeometry(sampleBuilding({ roofKind: 'stepped', h: 60 }));
  expect(stepped.attributes.position.count > tg.attributes.position.count, 'stepped roof has more than one tier');
  const spire = buildingGeometry(sampleBuilding({ roofKind: 'spire' }));
  expect(range(spire, 'position', 1)[1] > 56, 'spire rises above the box');
});

test('BuildingGeometry: street level = 6 m bays with recessed doors and palette fascias behind arcade columns, awnings per bay; trim stays separate and cheap', () => {
  const style = new GeoBuilder(), band = new GeoBuilder(), awning = new GeoBuilder(), rng = new Random(3);
  const shop = sampleBuilding({ district: 'suburb', style: 'residential', h: 14.2, w: 16, d: 12 });
  // Only the street-facing wall (+Z) sees a street: whole bays with doors, columns on that face and its two corners.
  appendStreetLevel(style, band, shop, rng, false, awning, 1);
  const bandLen = 16 - 2 * ARCADE.recess, nBays = Math.max(1, Math.round(bandLen / ARCADE.bay));
  expect(nBays === 3, `a 16 m face holds three ~5 m bays (got ${nBays})`);
  // Street face: per bay glazing (split around the recessed door) + two reveals + a fascia; the three hidden faces two quads each.
  expect(band.vertexCount % 4 === 0 && band.vertexCount / 4 >= 3 * 2 + nBays * 2 && band.vertexCount / 4 <= 3 * 2 + nBays * 6, `shop band quads (got ${band.vertexCount / 4})`);
  const bg = band.build();
  const [, maxY] = range(bg, 'position', 1);
  const [vMin, vMax] = range(bg, 'uv', 1);
  const [, maxZ] = range(bg, 'position', 2);
  approx(maxY, BAND.shopH, 1e-6, 'band height = SHOP_BAND_H');
  expect(vMin >= 0 && vMax <= 1, `band v inside the atlas (${vMin.toFixed(3)}..${vMax.toFixed(3)})`);
  approx(maxZ, 200 + 6 - ARCADE.recess, 1e-3, 'shop band recessed behind the wall line');
  // Door cells step BAND.doorRecess further back on the street face, with reveal faces between.
  const doorZ = 200 + 6 - ARCADE.recess - BAND.doorRecess;
  expect(countWhere(bg, (_x, _y, z) => Math.abs(z - doorZ) < 1e-3) >= 8, 'at least one doorway recessed 0.6 m into the wall');
  // Fascia strips (above SHOP_FASCIA_Y) come in at most three palette hues plus the vacant neutral.
  const fasciaY = BAND.shopH * (SHOP_FASCIA_Y / BAND.shopH);
  const tints = new Set<string>();
  for (let i = 0; i < bg.attributes.position.count; i++) {
    if (bg.attributes.position.getY(i) < fasciaY + 0.01) continue;
    tints.add(`${bg.attributes.color.getX(i).toFixed(2)},${bg.attributes.color.getY(i).toFixed(2)},${bg.attributes.color.getZ(i).toFixed(2)}`);
  }
  expect(tints.size >= 2 && tints.size <= 4, `fascias limited to the building's palette (got ${tints.size} tints)`);
  // Cap with its soffit (6 quads) + 2 corner columns (4 quads each) + one bay column per bay line (3 quads each).
  expect(style.vertexCount === (6 + 8 + 3 * (nBays - 1)) * 4, `cap + corner + bay columns = ${6 + 8 + 3 * (nBays - 1)} quads (got ${style.vertexCount / 4})`);
  // Every atlas bay is SHOP_BAY_W wide, so the piers fall on every column line whatever bay a face starts at.
  expect(SHOP_BAYS.length === SHOP_ROWS * 4 && ARCADE.bay === SHOP_BAY_W && SHOP_TILE_W === 4 * SHOP_BAY_W, 'atlas = SHOP_ROWS rows of four SHOP_BAY_W bays');
  expect(SHOP_BAYS.filter((b) => b.door >= 0).every((b) => b.door >= 0.15 && b.door + SHOP_DOOR_W <= SHOP_BAY_W - 0.15), 'door cells sit inside their bay');
  // Awnings on about half the bays of a wide street face: slope + valance pairs, u along the span, v from 1 at the
  // wall down to 0 at the hem, a 1.2 m drop, nothing above the arcade cap.
  // Which bays get one is hashed per building, so gather a few ids' worth of 40 m fronts.
  const aw = new GeoBuilder();
  for (let id = 1; id <= 4; id++) {
    const wide = sampleBuilding({ id, district: 'suburb', style: 'residential', h: 14.2, w: 40, d: 12 });
    const one = new GeoBuilder();
    appendStreetLevel(new GeoBuilder(), new GeoBuilder(), wide, rng, false, one, 1);
    expect(one.vertexCount % 4 === 0 && one.vertexCount / 4 >= 2, `awnings on a 40 m front (id ${id}: got ${one.vertexCount / 4} quads)`);
    appendStreetLevel(new GeoBuilder(), new GeoBuilder(), wide, rng, false, aw, 1);
  }
  const ag = aw.build();
  const [avMin, avMax] = range(ag, 'uv', 1), [, auMax] = range(ag, 'uv', 0), [yMin, yMax] = range(ag, 'position', 1);
  expect(avMin === 0 && avMax === 1 && auMax > 2, `awning v spans 0..1 and u repeats along the span (u max ${auMax.toFixed(2)})`);
  expect(yMax < BAND.shopH - 0.3 && yMin > 1.7 && yMax - yMin >= 1.1, `awnings hang under the fascia with a 1.2 m drop (y ${yMin.toFixed(2)}..${yMax.toFixed(2)})`);
  // Neighbouring ids render with different tints even on the same palette colour.
  expect(buildingTint(shop) !== buildingTint({ ...shop, id: 8 }), 'render tint differs between neighbouring ids');
  // Downtown plinth: band stretched to whole bays per face, a cap, and an entrance canopy in front of the facing wall.
  const plinthStyle = new GeoBuilder(), plinth = new GeoBuilder();
  const tower = sampleBuilding({});
  const awBefore = awning.vertexCount;
  appendStreetLevel(plinthStyle, plinth, tower, rng, true, awning, 15);
  expect(plinth.vertexCount === 16 && plinthStyle.vertexCount > 20 && awning.vertexCount === awBefore, 'downtown plinth: flush band + cap + entrance, no columns, no awning');
  const pg = plinth.build();
  const nPl = Math.round((tower.w + 2 * BAND.plinthOut) / (PLINTH_TILE_W / PLINTH_BAYS));
  approx(pg.attributes.uv.getX(1) - pg.attributes.uv.getX(0), nPl / PLINTH_BAYS, 1e-6, `plinth facing wall holds ${nPl} whole bays`);
  const sg = plinthStyle.build();
  let canopyZ = -Infinity, canopyTop = 0;
  for (let i = 0; i < sg.attributes.position.count; i++) { const z = sg.attributes.position.getZ(i); if (z > canopyZ) { canopyZ = z; canopyTop = sg.attributes.position.getY(i); } }
  expect(canopyZ > tower.z + tower.d / 2 + BAND.plinthOut + 2.2 && canopyTop < BAND.plinthH, `entrance canopy reaches 2.5 m over the pavement (z ${canopyZ.toFixed(2)})`);
  // Without a street mask a shop still gets its band and cap but no columns.
  const s2 = new GeoBuilder();
  appendStreetLevel(s2, new GeoBuilder(), shop, rng, false, null, 0);
  expect(s2.vertexCount === 6 * 4, `no street faces: cap only (got ${s2.vertexCount / 4} quads)`);
  // Arcade buildings raise their windowed walls to the arcade ceiling.
  const raised = new GeoBuilder();
  appendBuilding(raised, shop, bandHeight(shop, false) - 0.3);
  approx(range(raised.build(), 'position', 1)[0], BAND.shopH - 0.3, 1e-6, 'walls start at the arcade ceiling');
  // Detail pass: roof trim goes to the trim builder, the style builder only gets textured tiers / facade relief.
  const gb = new GeoBuilder(), trim = new GeoBuilder();
  const low = sampleBuilding({ id: 4, district: 'suburb', style: 'concrete', h: 10.7, w: 20, d: 16 });
  appendBuildingDetail(gb, trim, low, new Random(1), [], 0);
  expect(massingOf(low).kind === 'box', 'low flat suburb building is a box');
  expect(trim.vertexCount === 13 * 4, `roof under 12 m: two-step cornice only (13 quads), no walls or clutter (got ${trim.vertexCount / 4} quads)`);
  expect(gb.vertexCount === 0, 'no street faces: no relief on the style mesh');
  // With one street face the suburb concrete building gets a floor slab (0.25 m proud) at every floor line of that face.
  const gbR = new GeoBuilder();
  appendBuildingDetail(gbR, new GeoBuilder(), low, new Random(1), [], 1, BAND.shopH);
  expect(gbR.vertexCount > 0 && gbR.vertexCount % 4 === 0, `slabs on the street face (got ${gbR.vertexCount / 4} quads)`);
  expect(countWhere(gbR.build(), (_x, _y, z) => Math.abs(z - (200 + 8 + 0.25)) < 1e-6) >= 4, 'slab front 0.25 m proud of the wall');
  // Tall roof: cornice + 1.0-1.2 m parapet walls with a coping + at most one clutter piece.
  const tall = sampleBuilding({ id: 8, district: 'suburb', style: 'concrete', h: 21.2, w: 24, d: 20 });
  const gb2 = new GeoBuilder(), trim2 = new GeoBuilder();
  appendBuildingDetail(gb2, trim2, tall, new Random(1), [], 0);
  expect(trim2.vertexCount / 4 >= 13 + 12 + 8 && trim2.vertexCount / 4 <= 90, `tall roof: cornice + parapet + coping + at most one clutter piece (got ${trim2.vertexCount / 4} quads)`);
  const tg = trim2.build();
  const copingTop = countWhere(tg, (x, y, z) => y > 21.2 + 1.0 && y <= 21.2 + 1.2 + 0.125 && Math.abs(x - 100) < 12.5 && Math.abs(z - 200) < 10.5);
  expect(copingTop >= 8, `parapet coping tops out 1.1-1.3 m over the roof (got ${copingTop} vertices)`);
  // Stepped roofs are capped at two tiers whatever the height; a crown tower stops CHAMFER short and the detail pass chamfers it.
  const stepped = buildingGeometry(sampleBuilding({ id: 2, roofKind: 'stepped', h: 70.2, style: 'glass' }));
  const inset = 16 * 0.14;
  expect(countWhere(stepped, (x) => Math.abs(x - (84 + inset)) < 1e-3) > 0 && countWhere(stepped, (x) => Math.abs(x - (84 + 2 * inset)) < 1e-3) === 0, 'two tiers: one inset box over the base, no third');
  approx(range(stepped, 'position', 1)[1], 70.2 - 2, 1e-3, 'top tier stops 2 m short for the crown chamfer');
  const towerB = sampleBuilding({ id: 4, h: 60 });
  expect(hasCrown(towerB, massingOf(towerB).top), 'a 60 m flat downtown tower has a crown');
  approx(range(buildingGeometry(towerB), 'position', 1)[1], 58, 1e-6, 'crown tower box stops 2 m short for the chamfer');
  const gb3 = new GeoBuilder(), trim3 = new GeoBuilder();
  appendBuildingDetail(gb3, trim3, towerB, new Random(1), [], 0);
  approx(range(gb3.build(), 'position', 1)[1], 60, 1e-6, 'chamfer reaches the tower top');
});

test('BuildingGeometry: long street faces jog, residential street faces recess one bay in three and grow balconies, street corners chamfer', () => {
  // A 60 m residential front on the +Z street: inner segments step back 0.7-1.0 m, with reveal faces and a soffit.
  const long = sampleBuilding({ id: 11, district: 'suburb', style: 'residential', h: 17.7, w: 60, d: 16 });
  const gb = new GeoBuilder();
  appendBuilding(gb, long, -0.2, 1);
  const g = gb.build();
  const z1 = 208;
  const jogged = countWhere(g, (_x, _y, z) => z < z1 - 0.69 && z > z1 - 1.01);
  const flush = countWhere(g, (_x, _y, z) => Math.abs(z - z1) < 1e-6);
  expect(jogged >= 8 && flush >= 8, `long face: jogged and flush segments (jogged ${jogged}, flush ${flush} vertices)`);
  // Recessed bays: one in three, 0.3 m back; the end bays stay flush.
  const recessed = countWhere(g, (_x, _y, z) => Math.abs(z - (z1 - 0.3)) < 1e-3);
  expect(recessed >= 8, `recessed bays on the street face (got ${recessed} vertices)`);
  const wallX: number[] = [];
  for (let i = 0; i < g.attributes.position.count; i++) if (Math.abs(g.attributes.position.getZ(i) - (z1 - 0.3)) < 1e-3) wallX.push(g.attributes.position.getX(i));
  expect(Math.min(...wallX) >= 70 + 4 - 1e-6 && Math.max(...wallX) <= 130 - 4 + 1e-6, 'the corner bays are never recessed');
  // The hidden faces stay one flat plane.
  expect(countWhere(g, (x) => x > 130 + 1e-6 || x < 70 - 1e-6) === 0, 'nothing pokes outside the footprint');
  // Balconies on the street face: slab + rail bar + three posts, only on flush bays, under the painted rail rows.
  const det = new GeoBuilder(), trim = new GeoBuilder();
  appendBuildingDetail(det, trim, long, new Random(1), [], 1, 0);
  const dg = det.build();
  const posts = countWhere(dg, (_x, _y, z) => Math.abs(z - (z1 + 0.45)) < 1e-3);
  expect(posts >= 3 * 4, `balcony rails with posts in front of the wall (got ${posts} vertices at 0.45 m)`);
  // Chamfered corner: a residential block-corner building (faces +Z and +X on streets) loses its corner at 45 degrees
  // on some ids; the chamfer is 2.2-3 m and the arcade band / cap follow it.
  let chamfered = 0, square = 0;
  for (let id = 1; id <= 12; id++) {
    const b = sampleBuilding({ id, district: 'suburb', style: 'residential', h: 14.2, w: 20, d: 20 });
    const m = massingOf(b);
    if (m.kind !== 'box' || m.roofVariant !== 0) continue;
    const ol = footprint(b, 3, m, new Outline());
    if (ol.n === 4) { square++; continue; }
    chamfered++;
    expect(ol.n === 5 && ol.face[1] === -1 && ol.face[2] === 1, `chamfer edge inserted at the street corner (id ${id})`);
    const c = Math.hypot(ol.x[2] - ol.x[1], ol.z[2] - ol.z[1]) / Math.SQRT2;
    expect(c >= 2.2 - 1e-6 && c <= 3.0 + 1e-6, `chamfer 2.2-3 m (got ${c.toFixed(2)})`);
    const st = new GeoBuilder(), bd = new GeoBuilder();
    appendStreetLevel(st, bd, b, new Random(1), false, null, 3);
    expect(countWhere(bd.build(), (x, _y, z) => x > 110 - 1e-6 && z > 210 - 1e-6) === 0, 'the band follows the chamfer (no vertex on the cut corner)');
    expect(footprint(b, 0, massingOf(b), new Outline()).n === 4, 'no street mask, no chamfer');
  }
  expect(chamfered >= 1 && square >= 1, `chamfers on some corner buildings, not all (chamfered ${chamfered}, square ${square})`);
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
