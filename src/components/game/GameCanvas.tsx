// Full-screen game canvas: creates GameStore + Engine once (StrictMode-safe), provides contexts, debug hook. Track P0.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Engine, parseEngineOptions } from '@/game/Engine';
import { GameStore } from '@/game/state/GameStore';
import type { DebugStats } from '@/game/state/GameStore';
import { EngineReactContext, GameStoreContext, useGameStore } from '@/game/state/useGameStore';
import type { GamePhase } from '@/game/core/Types';

export interface GameDebugInfo extends DebugStats { phase: GamePhase; playerX: number; playerZ: number; errors: string[] }

declare global {
  interface Window { __GAME_DEBUG__?: () => GameDebugInfo; __GAME_SCENE__?: () => unknown }
}

function LoadingOverlay() {
  const loading = useGameStore((s) => s.loading);
  const text = useGameStore((s) => s.loadingText);
  if (!loading) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#050308] text-white game-font text-2xl">
      {text || 'Yükleniyor...'}
    </div>
  );
}

export default function GameCanvas({ children }: { children?: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const storeRef = useRef<GameStore | null>(null);
  if (!storeRef.current) storeRef.current = new GameStore();
  const store = storeRef.current;
  const engineRef = useRef<Engine | null>(null);
  const disposeTimerRef = useRef(0);
  const errorsRef = useRef<string[]>([]);
  const [engine, setEngine] = useState<Engine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (disposeTimerRef.current) {
      window.clearTimeout(disposeTimerRef.current);
      disposeTimerRef.current = 0;
    }
    const errors = errorsRef.current;
    const onError = (e: ErrorEvent): void => { errors.push(String(e.message)); };
    const onRejection = (e: PromiseRejectionEvent): void => { errors.push('unhandledrejection: ' + String(e.reason)); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    let eng = engineRef.current;
    if (!eng || eng.disposed) {
      const options = parseEngineOptions(window.location.search);
      const created = new Engine(canvas, store, options);
      eng = created;
      engineRef.current = created;
      setEngine(created);
      created.init().then(() => {
        if (!created.disposed && options.autostart) created.newGame();
      }).catch((err: unknown) => {
        errors.push('init: ' + String(err));
        console.error(err);
      });
    }
    const current = eng;
    window.__GAME_DEBUG__ = () => {
      const w = current.world;
      return { ...current.getDebugStats(), phase: w.phase, playerX: w.player.curr.x, playerZ: w.player.curr.z, errors: errors.slice() };
    };
    window.__GAME_SCENE__ = () => (current.renderer ? current.renderer.sceneBreakdown() : null);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      // Deferred so a StrictMode remount can cancel it and keep the engine alive.
      disposeTimerRef.current = window.setTimeout(() => {
        disposeTimerRef.current = 0;
        current.dispose();
        if (engineRef.current === current) engineRef.current = null;
        if (window.__GAME_DEBUG__) delete window.__GAME_DEBUG__;
        if (window.__GAME_SCENE__) delete window.__GAME_SCENE__;
      }, 0);
    };
  }, [store]);

  return (
    <GameStoreContext.Provider value={store}>
      <EngineReactContext.Provider value={engine}>
        <div className="relative h-full w-full overflow-hidden bg-[#050308]">
          <canvas ref={canvasRef} className="block h-full w-full" tabIndex={0} />
          <LoadingOverlay />
          {engine ? <div className="pointer-events-none absolute inset-0">{children}</div> : null}
        </div>
      </EngineReactContext.Provider>
    </GameStoreContext.Provider>
  );
}
