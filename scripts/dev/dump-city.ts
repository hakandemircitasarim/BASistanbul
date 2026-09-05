// Dev tool: writes an SVG overview of the generated city (blocks, lanes, buildings, props, spots, points). Track A.
// Usage: npx tsx scripts/dev/dump-city.ts [out.svg] [seed]
import fs from 'node:fs';
import { generateCity, validateCity } from '../../src/game/city/CityGenerator';
import { districtOf } from '../../src/game/city/CityBuild';

const out = process.argv[2] ?? 'city.svg';
const seed = Number(process.argv[3] ?? 1907);
const t0 = performance.now();
const g = generateCity(seed);
const ms = performance.now() - t0;
const c = g.city;
const S = 1; // px per meter
const W = 1450, H = 1200;
const parts: string[] = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W * S}" height="${H * S}" viewBox="-30 -10 ${W} ${H}" style="background:#0d3b5c">`);
parts.push(`<rect x="0" y="0" width="1180" height="1180" fill="#3a3f47"/>`);
parts.push(`<rect x="1180" y="0" width="90" height="1180" fill="#d8c48a"/>`);
for (const b of c.blocks) {
  const d = districtOf(b.col, b.row);
  const fill = b.kind === 'park' ? '#2f5d3a' : b.kind === 'plaza' ? '#3a3346' : b.kind === 'landmark' ? '#4a3a2a' : d === 'downtown' ? '#1c2530' : d === 'beachfront' ? '#2a2238' : '#202a24';
  parts.push(`<rect x="${b.x0}" y="${b.z0}" width="${b.x1 - b.x0}" height="${b.z1 - b.z0}" fill="${fill}"/>`);
}
for (const l of g.roads.lanes) parts.push(`<line x1="${l.start.x}" y1="${l.start.z}" x2="${l.end.x}" y2="${l.end.z}" stroke="${l.index === 0 ? '#8891a0' : '#6c7482'}" stroke-width="1"/>`);
for (const n of g.roads.nodes) parts.push(`<circle cx="${n.x}" cy="${n.z}" r="2" fill="${n.stopSign ? '#ff3b3b' : '#9aa'}"/>`);
for (const b of c.buildings) parts.push(`<rect x="${b.x - b.w / 2}" y="${b.z - b.d / 2}" width="${b.w}" height="${b.d}" fill="#${b.color.toString(16).padStart(6, '0')}" opacity="0.9" stroke="#000" stroke-width="0.3"/>`);
for (const l of c.landmarks) parts.push(`<rect x="${l.x - l.w / 2}" y="${l.z - l.d / 2}" width="${l.w}" height="${l.d}" fill="#ff7a00" opacity="0.6"/><text x="${l.x}" y="${l.z}" font-size="9" fill="#fff" text-anchor="middle">${l.name}</text>`);
for (const p of c.props) {
  const col = p.kind === 'palm' ? '#39ff14' : p.kind === 'lamp' ? '#fff03b' : p.kind === 'bench' ? '#b87333' : '#ff2d95';
  parts.push(`<circle cx="${p.x}" cy="${p.z}" r="${p.kind === 'palm' ? 1.4 : 0.9}" fill="${col}"/>`);
}
for (const n of g.sidewalks.nodes) parts.push(`<circle cx="${n.x}" cy="${n.z}" r="${n.corner ? 1.2 : 0.8}" fill="${n.corner ? '#00e5ff' : '#8fd'}"/>`);
for (const n of g.sidewalks.nodes) for (const x of n.crossings) if (x > n.id) parts.push(`<line x1="${n.x}" y1="${n.z}" x2="${g.sidewalks.nodes[x].x}" y2="${g.sidewalks.nodes[x].z}" stroke="#00e5ff" stroke-width="0.6"/>`);
for (const s of c.parkedSpots) parts.push(`<rect x="-2.2" y="-0.9" width="4.4" height="1.8" fill="#ff7a00" stroke="#000" stroke-width="0.3" transform="translate(${s.x} ${s.z}) rotate(${(90 - (s.yaw * 180) / Math.PI).toFixed(1)})"/>`);
const pts: [string, number, number][] = [['SPAWN', c.points.playerSpawn.x, c.points.playerSpawn.z], ['H', c.points.hospital.x, c.points.hospital.z], ['P', c.points.policeStation.x, c.points.policeStation.z], ['PIER', c.points.pier.x, c.points.pier.z], ['G', c.points.garage.x, c.points.garage.z], ['DELIV', c.points.beachDelivery.x, c.points.beachDelivery.z]];
c.points.missionStarts.forEach((m, i) => pts.push([`M${i}`, m.x, m.z]));
for (const [n, x, z] of pts) parts.push(`<circle cx="${x}" cy="${z}" r="4" fill="#ffe14a" stroke="#000"/><text x="${x + 5}" y="${z - 4}" font-size="11" font-weight="bold" fill="#ffe14a">${n}</text>`);
for (const sc of c.staticColliders) if (sc.tag === 'water' || sc.tag === 'boundary') parts.push(`<rect x="${Math.max(-30, sc.minX)}" y="${Math.max(-10, sc.minZ)}" width="${Math.min(1450, sc.maxX) - Math.max(-30, sc.minX)}" height="${Math.min(1200, sc.maxZ) - Math.max(-10, sc.minZ)}" fill="${sc.tag === 'water' ? '#0d3b5c' : '#802'}" opacity="0.5"/>`);
parts.push('</svg>');
fs.writeFileSync(out, parts.join('\n'));
const problems = validateCity(g);
console.log(`wrote ${out}: ${c.buildings.length} buildings, ${c.props.length} props, ${c.parkedSpots.length} spots, ${c.staticColliders.length} colliders, ${ms.toFixed(1)} ms, ${problems.length} problems`);
for (const p of problems.slice(0, 20)) console.log('  ' + p);
