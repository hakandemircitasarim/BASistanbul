import * as THREE from 'three';
import { generateCity } from '../../src/game/city/CityGenerator';
import { GeoBuilder, appendBuilding, landmarkGeometries } from '../../src/game/render/BuildingGeometry';
import { STYLES } from '../../src/game/render/Materials';

const { city } = generateCity();
const tri = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;

const builders: Record<string, GeoBuilder> = {};
for (const s of STYLES) builders[s] = new GeoBuilder();
for (const b of city.buildings) appendBuilding(builders[b.style], b);
let bTri = 0;
for (const s of STYLES) { const gb = builders[s]; if (gb.vertexCount) bTri += tri(gb.build()); }

let lTri = 0;
for (const l of city.landmarks) for (const p of landmarkGeometries(l)) lTri += tri(p.geometry);

const counts: Record<string, number> = {};
for (const p of city.props) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
console.log('binalar      ', Math.round(bTri), 'üçgen /', city.buildings.length, 'bina');
console.log('simge yapılar', Math.round(lTri));
console.log('props        ', JSON.stringify(counts));
