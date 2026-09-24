import React from 'react';
import { Zap } from 'lucide-react';

export function BrandMark({ size = 32 }: { size?: number }): React.ReactElement {
  return (
    <div
      className="flex flex-shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-accent-300 to-accent-600 text-ink-primary shadow-[0_2px_8px_rgba(0,216,111,0.35)]"
      style={{ width: size, height: size }}
    >
      <Zap size={Math.round(size * 0.55)} fill="currentColor" strokeWidth={0} />
    </div>
  );
}

export function Brand({ light = false }: { light?: boolean }): React.ReactElement {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark />
      <span className={`text-[17px] font-semibold tracking-tight ${light ? 'text-white' : 'text-ink-primary'}`}>Insightest</span>
    </div>
  );
}
