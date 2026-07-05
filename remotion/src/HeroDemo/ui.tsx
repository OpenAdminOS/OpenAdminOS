import type {CSSProperties, ReactNode} from 'react';

import {theme} from '../theme';

type Tone = 'emerald' | 'sky' | 'amber' | 'danger' | 'purple' | 'neutral';

const toneColor: Record<Tone, string> = {
  emerald: theme.colors.accents.emerald,
  sky: theme.colors.accents.sky,
  amber: theme.colors.accents.amber,
  danger: theme.colors.accents.danger,
  purple: theme.colors.accents.purple,
  neutral: '#ffffff',
};

export const clamp = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

export const alpha = (hex: string, opacity: number) => {
  const value = hex.replace('#', '');
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
};

export const Panel = ({
  children,
  style,
  accent,
}: {
  children: ReactNode;
  style?: CSSProperties;
  accent?: Tone;
}) => {
  const accentColor = accent ? toneColor[accent] : undefined;

  return (
    <div
      style={{
        background: theme.colors.panel,
        border: `1px solid ${theme.colors.border}`,
        borderRadius: 8,
        boxShadow: accentColor ? `inset 2px 0 0 ${accentColor}` : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Chip = ({
  children,
  tone = 'neutral',
  style,
}: {
  children: ReactNode;
  tone?: Tone;
  style?: CSSProperties;
}) => {
  const color = toneColor[tone];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        border: `1px solid ${alpha(color, 0.34)}`,
        borderRadius: 999,
        background: alpha(color, 0.11),
        color,
        fontFamily: theme.fonts.mono,
        fontSize: 20,
        fontWeight: 600,
        lineHeight: '26px',
        padding: '5px 12px',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
};

export const Dot = ({tone = 'emerald'}: {tone?: Tone}) => {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: toneColor[tone],
        boxShadow: `0 0 18px ${alpha(toneColor[tone], 0.45)}`,
      }}
    />
  );
};

export const Label = ({children, style}: {children: ReactNode; style?: CSSProperties}) => {
  return (
    <div
      style={{
        color: theme.colors.text.faint,
        fontFamily: theme.fonts.mono,
        fontSize: 18,
        fontWeight: 700,
        letterSpacing: 0,
        textTransform: 'uppercase',
        ...style,
      }}
    >
      {children}
    </div>
  );
};
