// Shared neon-styled primitives: Panel, NeonButton, Title, BackButton used by every menu screen. Track D.
import type { ReactNode, MouseEventHandler } from 'react';
import { cn } from '@/lib/utils';
import { PANEL_CLASS } from './theme';

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(PANEL_CLASS, 'pointer-events-auto text-white', className)}>{children}</div>;
}

export function NeonButton({ children, onClick, primary, className, autoFocus }: { children: ReactNode; onClick: MouseEventHandler<HTMLButtonElement>; primary?: boolean; className?: string; autoFocus?: boolean }) {
  return (
    <button
      type="button"
      autoFocus={autoFocus}
      onClick={onClick}
      className={cn(
        'game-font pointer-events-auto w-72 select-none rounded-md border px-8 py-3 text-xl uppercase tracking-[0.18em] transition duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]',
        primary
          ? 'border-transparent bg-gradient-to-r from-[#ff7a00] to-[#ff2d95] text-[#0b0410] shadow-[0_0_22px_rgba(255,122,0,.45)] hover:shadow-[0_0_36px_rgba(255,45,149,.75)] hover:brightness-110'
          : 'border-white/15 bg-[rgba(5,3,8,.55)] text-white backdrop-blur-md hover:border-[#ff7a00] hover:text-[#ff7a00] hover:shadow-[0_0_24px_rgba(255,122,0,.5)]',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The game title with the orange->magenta gradient and the thin 'V I' badge. */
export function GameTitle({ compact }: { compact?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <h1
        className={cn(
          'game-font bg-gradient-to-r from-[#ff7a00] via-[#ff4d6d] to-[#ff2d95] bg-clip-text text-center uppercase leading-none text-transparent drop-shadow-[0_0_18px_rgba(255,122,0,.55)]',
          compact ? 'text-3xl md:text-4xl' : 'text-5xl md:text-7xl',
        )}
      >
        BAS İSTANBUL
      </h1>
      <span className="game-font rounded-sm border border-[#00e5ff]/70 px-3 py-0.5 text-[10px] tracking-[0.45em] text-[#00e5ff] shadow-[0_0_12px_rgba(0,229,255,.45)]">
        BÜYÜK ARABA SOYGUNU
      </span>
    </div>
  );
}

/** Section heading inside a panel (Kontroller / Ayarlar / Duraklatıldı). */
export function ScreenHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="game-font mb-4 text-center text-3xl uppercase tracking-[0.2em] text-white drop-shadow-[0_0_12px_rgba(0,229,255,.55)]">
      {children}
    </h2>
  );
}

/** Full-screen centered menu shell (pointer-events-auto, dark translucent scrim over the live scene). */
export function MenuShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-6 bg-[radial-gradient(ellipse_at_center,rgba(5,3,8,.25),rgba(5,3,8,.7))] p-6 text-white', className)}>
      {children}
    </div>
  );
}
