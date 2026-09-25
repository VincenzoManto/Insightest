import React from 'react';
import { t } from '../i18n';

const GREEN = '#00ad59';
const RED = '#d03b3b';

/** Circular progress: a green ring that fills as the run advances (red if the run failed). */
export function RunProgressRing({
  percent,
  done,
  total,
  failed = false,
  size = 132,
}: {
  percent: number;
  done: number;
  total: number;
  failed?: boolean;
  size?: number;
}): React.ReactElement {
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const color = failed ? RED : GREEN;

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-gridline" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
          style={{ transition: 'stroke-dashoffset 0.5s ease, stroke 0.3s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[26px] font-semibold leading-none tracking-tight text-ink-primary">{clamped}%</div>
        {total > 0 && (
          <div className="mt-1 text-[11px] text-ink-muted">{t('{done} of {total} actions', { done: Math.min(done, total), total })}</div>
        )}
      </div>
    </div>
  );
}
