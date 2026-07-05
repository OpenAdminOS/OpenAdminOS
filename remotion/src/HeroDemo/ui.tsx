import type {CSSProperties, ReactNode} from 'react';

import {theme} from '../theme';

export type Tone =
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'think'
  | 'neutral'
  | 'muted';

export const clamp = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

export const alpha = (hex: string, opacity: number) => {
  const value = hex.replace('#', '').slice(0, 6);
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
};

const toneColor: Record<Tone, string> = {
  accent: theme.colors.accent,
  success: theme.colors.success,
  warning: theme.colors.warning,
  danger: theme.colors.danger,
  info: theme.colors.info,
  think: theme.colors.think,
  neutral: theme.colors.text.soft,
  muted: theme.colors.text.muted,
};

const toneBg: Record<Tone, string> = {
  accent: theme.colors.accentSoft,
  success: theme.colors.successSoft,
  warning: theme.colors.warningSoft,
  danger: theme.colors.dangerSoft,
  info: theme.colors.infoSoft,
  think: theme.colors.thinkSoft,
  neutral: alpha(theme.colors.text.soft, 0.08),
  muted: alpha(theme.colors.text.muted, 0.08),
};

export const truncate: CSSProperties = {
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const cardBase: CSSProperties = {
  background: theme.colors.surface,
  border: `1px solid ${theme.colors.borderSoft}`,
  borderRadius: theme.radii.lg,
  boxSizing: 'border-box',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.025)',
  minWidth: 0,
};

export const Card = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) => {
  return <div style={{...cardBase, ...style}}>{children}</div>;
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
        justifyContent: 'center',
        gap: 7,
        maxWidth: '100%',
        minWidth: 0,
        border: `1px solid ${alpha(color, 0.28)}`,
        borderRadius: 999,
        background: toneBg[tone],
        color,
        fontSize: 14,
        fontWeight: 650,
        lineHeight: '21px',
        padding: '2px 9px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        ...style,
      }}
    >
      {children}
    </span>
  );
};

export const StatusDot = ({
  tone = 'success',
  size = 7,
}: {
  tone?: Tone;
  size?: number;
}) => {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 999,
        background: toneColor[tone],
        flex: '0 0 auto',
      }}
    />
  );
};

export const Button = ({
  children,
  variant = 'secondary',
  pressed = false,
  disabled = false,
  style,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  pressed?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
}) => {
  const primary = variant === 'primary';
  const danger = variant === 'danger';
  const ghost = variant === 'ghost';
  const background = primary
    ? pressed
      ? theme.colors.accentStrong
      : theme.colors.accent
    : danger
      ? theme.colors.dangerSoft
      : ghost
        ? 'transparent'
        : theme.colors.bgRaised;
  const border = primary
    ? alpha(theme.colors.accent, 0.6)
    : danger
      ? alpha(theme.colors.danger, 0.28)
      : ghost
        ? theme.colors.borderSoft
        : theme.colors.border;
  const color = primary
    ? theme.colors.bg
    : danger
      ? theme.colors.danger
      : theme.colors.text.soft;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        minWidth: 0,
        height: 40,
        borderRadius: theme.radii.md,
        border: `1px solid ${border}`,
        background,
        color,
        boxSizing: 'border-box',
        fontSize: 15,
        fontWeight: 700,
        lineHeight: '18px',
        padding: '0 17px',
        opacity: disabled ? 0.48 : 1,
        transform: pressed ? 'translateY(1px)' : 'translateY(0)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Label = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) => {
  return (
    <div
      style={{
        color: theme.colors.text.muted,
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: 0,
        lineHeight: '16px',
        textTransform: 'uppercase',
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Mono = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) => {
  return (
    <span
      style={{
        fontFamily: theme.fonts.mono,
        fontSize: 13,
        letterSpacing: 0,
        ...style,
      }}
    >
      {children}
    </span>
  );
};

export const Field = ({
  label,
  value,
  children,
  style,
}: {
  label: string;
  value?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}) => {
  return (
    <Card
      style={{
        background: theme.colors.bgRaised,
        borderRadius: theme.radii.md,
        padding: 15,
        ...style,
      }}
    >
      <Label style={{fontSize: 11}}>{label}</Label>
      {value ? (
        <div
          style={{
            ...truncate,
            color: theme.colors.text.primary,
            fontSize: 16,
            lineHeight: '22px',
            marginTop: 7,
          }}
        >
          {value}
        </div>
      ) : null}
      {children}
    </Card>
  );
};

export const TextBlock = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) => {
  return (
    <div
      style={{
        color: theme.colors.text.soft,
        fontSize: 16,
        lineHeight: '25px',
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const IconBox = ({
  children,
  tone = 'neutral',
  size = 38,
  style,
}: {
  children: ReactNode;
  tone?: Tone;
  size?: number;
  style?: CSSProperties;
}) => {
  return (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        width: size,
        height: size,
        borderRadius: theme.radii.md,
        background: toneBg[tone],
        color: toneColor[tone],
        border: `1px solid ${alpha(toneColor[tone], 0.22)}`,
        boxSizing: 'border-box',
        flex: `0 0 ${size}px`,
        fontSize: Math.round(size * 0.42),
        fontWeight: 800,
        lineHeight: 1,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Divider = ({style}: {style?: CSSProperties}) => {
  return (
    <div
      style={{
        height: 1,
        background: theme.colors.borderSoft,
        ...style,
      }}
    />
  );
};

export const sceneFade = (
  frame: number,
  start: number,
  end: number,
  fade = 8,
) => {
  if (frame < start || frame > end) return 0;
  const inProgress = Math.min(1, Math.max(0, (frame - start) / fade));
  const outProgress = Math.min(1, Math.max(0, (end - frame) / fade));
  return Math.min(inProgress, outProgress);
};
