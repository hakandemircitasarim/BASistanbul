// Dev-only render-rate probe: counts component renders and logs Hz once after 10 s (also window.__HUD_RENDERS__). Track D.
const counts = new Map<string, number>();
let startedAt = 0;
let timer = 0;
const REPORT_AFTER_MS = 10000;

declare global {
  interface Window { __HUD_RENDERS__?: () => Record<string, number> }
}

function rates(): Record<string, number> {
  const secs = Math.max(0.001, (performance.now() - startedAt) / 1000);
  const out: Record<string, number> = {};
  counts.forEach((v, k) => { out[k] = Math.round((v / secs) * 100) / 100; });
  return out;
}

/** Call at the top of a component body; no-op in production builds. Not a hook (no React state), safe to call conditionally. */
export function countRender(name: string): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  counts.set(name, (counts.get(name) ?? 0) + 1);
  if (!timer) {
    startedAt = performance.now();
    window.__HUD_RENDERS__ = rates;
    timer = window.setTimeout(() => {
      console.info('[HUD] render rates (Hz, first 10 s):', JSON.stringify(rates()));
    }, REPORT_AFTER_MS);
  }
}
