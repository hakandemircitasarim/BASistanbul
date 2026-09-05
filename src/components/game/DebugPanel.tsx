// F3 debug panel: fps / draw calls / triangles / tick ms / entity counts from store.debug. Track D.
import { useGameStore } from '@/game/state/useGameStore';
import { countRender } from './renderCount';

function Row({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex justify-between gap-6">
      <span className="text-white/60">{k}</span>
      <span className="tabular-nums text-[#00e5ff]">{v}</span>
    </div>
  );
}

export default function DebugPanel() {
  countRender('DebugPanel');
  const show = useGameStore((s) => s.showDebug);
  const d = useGameStore((s) => s.debug);
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute right-5 top-16 w-52 rounded-md border border-[#00e5ff]/40 bg-[rgba(5,3,8,.7)] px-3 py-2 font-mono text-xs text-white backdrop-blur-md">
      <div className="mb-1 text-[10px] uppercase tracking-[0.3em] text-[#ff7a00]">Hata ayıklama (F3)</div>
      {d ? (
        <>
          <Row k="FPS" v={d.fps} />
          <Row k="Çizim" v={d.drawCalls} />
          <Row k="Üçgen" v={d.triangles.toLocaleString('tr-TR')} />
          <Row k="Tick ms" v={d.tickMs.toFixed(2)} />
          <Row k="Araç" v={d.vehicles} />
          <Row k="Yaya" v={d.peds} />
          <Row k="Polis" v={d.police} />
          <Row k="Trafik" v={d.traffic} />
        </>
      ) : (
        <div className="text-white/50">...</div>
      )}
    </div>
  );
}
