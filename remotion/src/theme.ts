export const cssVariables = {
  '--font-sans':
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '--font-mono':
    'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',

  '--color-bg': '#1c1917',
  '--color-bg-elevated': '#252220',
  '--color-bg-raised': '#2d2926',
  '--color-sidebar': '#18161423',
  '--color-sidebar-solid': '#18161e',

  '--color-surface': '#232120',
  '--color-surface-hover': '#2a2724',

  '--color-border': '#322e2a',
  '--color-border-strong': '#403a35',
  '--color-border-soft': '#2a2622',

  '--color-text': '#f5f1eb',
  '--color-text-soft': '#b5ada3',
  '--color-text-muted': '#7a7167',
  '--color-text-faint': '#524a44',

  '--color-accent': '#e8a87c',
  '--color-accent-hover': '#efb88f',
  '--color-accent-soft': '#e8a87c1f',
  '--color-accent-strong': '#d99868',

  '--color-success': '#9cc88f',
  '--color-success-soft': '#9cc88f1f',
  '--color-warning': '#e5c678',
  '--color-warning-soft': '#e5c6781f',
  '--color-danger': '#dd9090',
  '--color-danger-soft': '#dd90901f',
  '--color-info': '#a3bfd9',
  '--color-info-soft': '#a3bfd91f',
  '--color-think': '#c4a5d9',
  '--color-think-soft': '#c4a5d91f',

  '--radius-sm': '6px',
  '--radius-md': '10px',
  '--radius-lg': '14px',
  '--radius-xl': '18px',

  '--shadow-soft':
    '0 1px 2px rgba(0, 0, 0, 0.18), 0 4px 16px rgba(0, 0, 0, 0.22)',
  '--shadow-modal':
    '0 8px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3)',
} as const;

export const theme = {
  fonts: {
    sans: cssVariables['--font-sans'],
    mono: cssVariables['--font-mono'],
  },
  colors: {
    bg: cssVariables['--color-bg'],
    bgElevated: cssVariables['--color-bg-elevated'],
    bgRaised: cssVariables['--color-bg-raised'],
    sidebar: cssVariables['--color-sidebar'],
    sidebarSolid: cssVariables['--color-sidebar-solid'],
    surface: cssVariables['--color-surface'],
    surfaceHover: cssVariables['--color-surface-hover'],
    border: cssVariables['--color-border'],
    borderStrong: cssVariables['--color-border-strong'],
    borderSoft: cssVariables['--color-border-soft'],
    text: {
      primary: cssVariables['--color-text'],
      soft: cssVariables['--color-text-soft'],
      muted: cssVariables['--color-text-muted'],
      faint: cssVariables['--color-text-faint'],
    },
    accent: cssVariables['--color-accent'],
    accentHover: cssVariables['--color-accent-hover'],
    accentSoft: cssVariables['--color-accent-soft'],
    accentStrong: cssVariables['--color-accent-strong'],
    success: cssVariables['--color-success'],
    successSoft: cssVariables['--color-success-soft'],
    warning: cssVariables['--color-warning'],
    warningSoft: cssVariables['--color-warning-soft'],
    danger: cssVariables['--color-danger'],
    dangerSoft: cssVariables['--color-danger-soft'],
    info: cssVariables['--color-info'],
    infoSoft: cssVariables['--color-info-soft'],
    think: cssVariables['--color-think'],
    thinkSoft: cssVariables['--color-think-soft'],
  },
  radii: {
    sm: 6,
    md: 10,
    lg: 14,
    xl: 18,
  },
  shadows: {
    soft: cssVariables['--shadow-soft'],
    modal: cssVariables['--shadow-modal'],
  },
} as const;
