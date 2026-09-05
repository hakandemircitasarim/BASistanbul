import { bodyGeometry } from '../../src/game/render/VehicleRenderer';
import { SPECS } from '../../src/game/entities/VehicleSpecs';
const keys = ['sedan', 'sport', 'van', 'police', 'taxi'] as const;
for (const k of keys) {
  const g = bodyGeometry(SPECS[k]);
  console.log(k, (g.index ? g.index.count : g.attributes.position.count) / 3, 'üçgen');
}
