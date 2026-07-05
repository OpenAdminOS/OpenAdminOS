export const theme = {
  colors: {
    bg: '#070709',
    panel: '#0d0e12',
    panelMuted: 'rgba(255,255,255,0.03)',
    border: 'rgba(255,255,255,0.10)',
    borderStrong: 'rgba(255,255,255,0.18)',
    text: {
      primary: '#ffffff',
      secondary: 'rgba(255,255,255,0.72)',
      muted: 'rgba(255,255,255,0.55)',
      faint: 'rgba(255,255,255,0.45)',
    },
    accents: {
      emerald: '#34d399',
      sky: '#7dd3fc',
      amber: '#fbbf24',
      danger: '#f87171',
      purple: '#a78bfa',
    },
  },
  fonts: {
    mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    sans: 'Inter, ui-sans-serif, system-ui, sans-serif',
  },
} as const;
