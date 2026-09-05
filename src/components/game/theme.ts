// Vice-City neon UI tokens and tiny formatting helpers shared by the HUD/menu components. Track D.
export { formatMoney } from '@/game/state/HudPublisher';

export const NEON = { orange: '#ff7a00', magenta: '#ff2d95', cyan: '#00e5ff', panel: 'rgba(5,3,8,.55)' } as const;

/** Shared Tailwind class strings (kept here so every panel/button looks identical). */
export const PANEL_CLASS = 'rounded-lg border border-white/10 bg-[rgba(5,3,8,.55)] backdrop-blur-md shadow-[0_8px_32px_rgba(0,0,0,.45)]';
export const GLOW_TEXT = 'drop-shadow-[0_0_6px_rgba(255,255,255,.35)]';

/** `mm:ss` for mission timers. */
export function formatTimer(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60), r = s % 60;
  return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
}
