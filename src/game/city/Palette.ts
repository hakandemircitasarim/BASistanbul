// Color palettes (buildings, neon, clothing), neon sign words and the district style picker. Track P0.
import type { Random } from '../core/Random';
import type { Building, BuildingStyle, District } from './CityData';

export const PASTELS: number[] = [0xf7c8d8, 0xbfe3f2, 0xfde9b8, 0xc9f0d4, 0xe6d3f5, 0xffd9c4, 0xd6f0f7, 0xf5e1ee];
export const NEONS: number[] = [0xff2d95, 0x00e5ff, 0xff7a00, 0xb14bff, 0x39ff14, 0xfff03b, 0xff3b3b, 0x00ffb3];
// Downtown alternates warm stone and cool glass so the skyline reads as two materials, not one grey mass.
export const DOWNTOWN_COLORS: number[] = [0x8c7f6c, 0x4c5a6e, 0xb59c86, 0x3e4a5e, 0xa6957f, 0x6b5648, 0x9aa4ae, 0x5c6b78];
export const SUBURB_COLORS: number[] = [0xd9c8a8, 0xc7b79a, 0xe0d6c0, 0xb8a888, 0xd4c0a0, 0xcbbfa4, 0xe8dcc4, 0xa89878, 0xc98a6a, 0x9fa27a];
// Neon-plate shirts pulled ~15% toward grey (same hues) so crowds stop looking like traffic cones.
export const SHIRTS: number[] = [0xee7d15, 0x1bdef4, 0xe7358d, 0xffffff, 0x2b2b2b, 0x4ef62e, 0xfbef55, 0x426be9, 0xa750e9, 0xf2cad7];
export const PANTS: number[] = [0x2b3a67, 0x1f1f1f, 0x5a4634, 0x3c3c50, 0x6b6b6b, 0x274060];
export const SKINS: number[] = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xa5673f];
/**
 * Names a VENUE puts on its roof: a hotel, a casino, a beach club, an office plaza. A rooftop sign 20 m up belongs
 * to the whole building, so it must never be dealt a corner-shop word - a seafront hotel whose roof reads BERBER
 * (a barber) is the bug this split fixes. Rooftop / facade neon (CityLots.makeSign) draws from here only.
 */
export const VENUE_WORDS: readonly string[] = [
  'OTEL', 'TURUNCU', 'MAVİ', 'CLUB', 'MALİBU', 'PLAJ',
  'CASINO', 'DİSKO', 'GAZİNO', 'TAVERNA', 'PLAZA', 'MARİNA',
];
/**
 * Street-trade words: what a single unit at the foot of a building sells. Used by the big painted signs on blank
 * side walls (BuildingGeometry emits an index, CityRenderer looks it up here) and by any shop-scale neon.
 */
export const SHOP_WORDS: readonly string[] = [
  'KAHVE', 'KEBAP', 'BAR', 'LOKANTA', 'PASTANE', 'BAKKAL', 'MEYHANE', 'ÇAY EVİ', 'BERBER', 'ECZANE',
  'MARKET', 'PİDECİ', 'DÖNER', 'BALIKÇI', 'HAMAM', 'MANAV', 'SİMİT', 'BÜFE', 'KUAFÖR', 'ŞARKÜTERİ',
];
/**
 * Every word the neon atlas has to carry: the venue pool first, then the shop pool. TextureFactory.neonAtlas lays
 * the list out in columns of at most ATLAS_ROWS words, so adding a word costs atlas width, not glyph height - but a
 * sign is 2.2 m tall and read from 5 m, so keep the list inside two columns (32 words) or the rows start to shrink
 * again. 12 + 20 = 32 keeps the round-7 glyph height exactly.
 */
export const SIGN_WORDS: readonly string[] = [...VENUE_WORDS, ...SHOP_WORDS];

const DOWNTOWN_STYLES: BuildingStyle[] = ['glass', 'glass', 'artdeco', 'concrete'];
const BEACH_STYLES: BuildingStyle[] = ['artdeco', 'artdeco', 'neon', 'residential'];
const SUBURB_STYLES: BuildingStyle[] = ['residential', 'residential', 'concrete'];

export function pickStyle(district: District, rng: Random): { style: BuildingStyle; color: number; accent: number; roofKind: Building['roofKind'] } {
  let style: BuildingStyle;
  let color: number;
  if (district === 'downtown') {
    style = rng.pick(DOWNTOWN_STYLES);
    color = rng.pick(DOWNTOWN_COLORS);
  } else if (district === 'beachfront') {
    style = rng.pick(BEACH_STYLES);
    color = rng.pick(PASTELS);
  } else {
    style = rng.pick(SUBURB_STYLES);
    color = rng.pick(SUBURB_COLORS);
  }
  const accent = rng.pick(NEONS);
  let roofKind: Building['roofKind'];
  if (style === 'artdeco') roofKind = rng.chance(0.35) ? 'spire' : 'stepped';
  else if (style === 'glass') roofKind = rng.chance(0.2) ? 'stepped' : 'flat';
  else roofKind = rng.chance(0.25) ? 'stepped' : 'flat';
  return { style, color, accent, roofKind };
}
