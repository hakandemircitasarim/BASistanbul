// HUD toasts stacked under the money readout, colored by kind, auto-removed 4 s after `at`. Track D.
import { useEffect, useState } from 'react';
import { useGameStore } from '@/game/state/useGameStore';
import type { Notification } from '@/game/state/GameStore';
import { cn } from '@/lib/utils';
import { countRender } from './renderCount';

export const NOTIFICATION_TTL_MS = 4000;

const KIND_CLASS: Record<Notification['kind'], string> = {
  info: 'border-[#00e5ff]/60 text-[#bff5ff] shadow-[0_0_14px_rgba(0,229,255,.35)]',
  success: 'border-[#4dff88]/60 text-[#c9ffdb] shadow-[0_0_14px_rgba(77,255,136,.35)]',
  danger: 'border-[#ff2d95]/70 text-[#ffd0e6] shadow-[0_0_14px_rgba(255,45,149,.45)]',
  police: 'border-[#3b6bff]/70 text-[#d6e0ff] shadow-[0_0_14px_rgba(59,107,255,.5)]',
};

export default function Notifications() {
  countRender('Notifications');
  const list = useGameStore((s) => s.notifications);
  const [now, setNow] = useState(() => performance.now());

  // Re-render exactly when the oldest visible toast expires (no polling).
  useEffect(() => {
    const t = performance.now();
    let next = Infinity;
    for (let i = 0; i < list.length; i++) {
      const exp = list[i].at + NOTIFICATION_TTL_MS;
      if (exp > t && exp < next) next = exp;
    }
    if (next === Infinity) return;
    const id = window.setTimeout(() => setNow(performance.now()), Math.max(16, next - t + 5));
    return () => window.clearTimeout(id);
  }, [list, now]);

  const visible = list.filter((n) => n.at + NOTIFICATION_TTL_MS > now);
  if (visible.length === 0) return null;
  return (
    <div className="absolute left-5 top-24 flex w-80 flex-col gap-1.5">
      {visible.map((n) => (
        <div
          key={n.id}
          className={cn('animate-in fade-in slide-in-from-left-4 rounded-md border bg-[rgba(5,3,8,.65)] px-3 py-1.5 text-sm font-semibold tracking-wide backdrop-blur-md duration-300', KIND_CLASS[n.kind])}
        >
          {n.text}
        </div>
      ))}
    </div>
  );
}
