// Color palettes (buildings, neon, clothing), neon sign words and the district style picker. Track P0.
import type { Random } from '../core/Random';
import type { Building, BuildingStyle, District } from './CityData';

export const PASTELS: number[] = [0xf7c8d8, 0xbfe3f2, 0xfde9b8, 0xc9f0d4, 0xe6d3f5, 0xffd9c4, 0xd6f0f7, 0xf5e1ee];
export const NEONS: number[] = [0xff2d95, 0x00e5ff, 0xff7a00, 0xb14bff, 0x39ff14, 0xfff03b, 0xff3b3b, 0x00ffb3];
export const DOWNTOWN_COLORS: number[] = [0x3b4a5c, 0x5a6b80, 0x6f7f94, 0x2c3a4a, 0x8a96a8, 0x4d5d70, 0x9aa8b8, 0x2f4256];
export const SUBURB_COLORS: number[] = [0xd9c8a8, 0xc7b79a, 0xe0d6c0, 0xb8a888, 0xd4c0a0, 0xcbbfa4, 0xe8dcc4, 0xa89878];
export const SHIRTS: number[] = [0xff7a00, 0x00e5ff, 0xff2d95, 0xffffff, 0x2b2b2b, 0x39ff14, 0xfff03b, 0x3b6bff, 0xb14bff, 0xf7c8d8];
export const PANTS: number[] = [0x2b3a67, 0x1f1f1f, 0x5a4634, 0x3c3c50, 0x6b6b6b, 0x274060];
export const SKINS: number[] = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xa5673f];
export const SIGN_WORDS: string[] = ['TURUNCU', 'MAVİ', 'CLUB', 'OTEL', 'KAHVE', 'PLAJ', 'MALİBU', 'NEON', 'DİSKO', 'KEBAP', 'CASINO', 'BAR'];

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
