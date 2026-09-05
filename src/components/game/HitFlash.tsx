// Red vignette shown for 150 ms whenever `hitFlashAt` changes (player damaged). Track D.
import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '@/game/state/useGameStore';
import { countRender } from './renderCount';

const FLASH_MS = 150;

export default function HitFlash() {
  countRender('HitFlash');
  const at = useGameStore((s) => s.hitFlashAt);
  const first = useRef(true);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (at <= 0) return;
    setOn(true);
    const t = window.setTimeout(() => setOn(false), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [at]);
  if (!on) return null;
  return <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(255,0,40,0)_45%,rgba(255,0,40,.55)_100%)]" />;
}
