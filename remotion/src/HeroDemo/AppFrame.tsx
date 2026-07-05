import type {CSSProperties, ReactNode} from 'react';

import {theme} from '../theme';
import {Button, Card, Chip, Divider, IconBox, Label, Mono, StatusDot, alpha, truncate} from './ui';

export const WINDOW_WIDTH = 1920;
export const WINDOW_HEIGHT = 1080;
export const TITLE_BAR_HEIGHT = 36;
export const STATUS_HEIGHT = 32;
export const SIDEBAR_WIDTH = 300;
export const MAIN_WIDTH = WINDOW_WIDTH - SIDEBAR_WIDTH;
export const MAIN_HEIGHT = WINDOW_HEIGHT - TITLE_BAR_HEIGHT - STATUS_HEIGHT;
const PAGE_HEADER_HEIGHT = 154;
const PAGE_HEADER_PADDING_TOP = 39;
const PAGE_HEADER_PADDING_X = 42;
const PAGE_HEADER_PADDING_BOTTOM = 28;
const PAGE_BODY_PADDING_TOP = 32;
const PAGE_BODY_PADDING_X = 42;
const PAGE_BODY_PADDING_BOTTOM = 34;
const BUTTON_HEIGHT = 40;
const HEADER_RUN_BUTTON_WIDTH = 86;
const BORDER_WIDTH = 1;

const FEATURED_TABS_HEIGHT = 68;
const FEATURED_CARD_MARGIN_TOP = 22;
const FEATURED_CARD_PADDING = 30;
const FEATURED_CHIP_ROW_HEIGHT = 27;
const FEATURED_TITLE_MARGIN_TOP = 18;
const FEATURED_TITLE_HEIGHT = 38;
const FEATURED_META_MARGIN_TOP = 12;
const FEATURED_META_HEIGHT = 26;
const FEATURED_DESCRIPTION_MARGIN_TOP = 22;
const FEATURED_DESCRIPTION_HEIGHT = 54;
const FEATURED_ACTIONS_MARGIN_TOP = 22;

const installButtonLeft =
  SIDEBAR_WIDTH + PAGE_BODY_PADDING_X + BORDER_WIDTH + FEATURED_CARD_PADDING;
const installButtonTop =
  TITLE_BAR_HEIGHT +
  PAGE_HEADER_HEIGHT +
  PAGE_BODY_PADDING_TOP +
  FEATURED_TABS_HEIGHT +
  FEATURED_CARD_MARGIN_TOP +
  BORDER_WIDTH +
  FEATURED_CARD_PADDING +
  FEATURED_CHIP_ROW_HEIGHT +
  FEATURED_TITLE_MARGIN_TOP +
  FEATURED_TITLE_HEIGHT +
  FEATURED_META_MARGIN_TOP +
  FEATURED_META_HEIGHT +
  FEATURED_DESCRIPTION_MARGIN_TOP +
  FEATURED_DESCRIPTION_HEIGHT +
  FEATURED_ACTIONS_MARGIN_TOP;
const runButtonLeft =
  SIDEBAR_WIDTH + MAIN_WIDTH - PAGE_HEADER_PADDING_X - HEADER_RUN_BUTTON_WIDTH;
const runButtonTop =
  TITLE_BAR_HEIGHT + PAGE_HEADER_HEIGHT - PAGE_HEADER_PADDING_BOTTOM - BUTTON_HEIGHT;
const cursorTargets = {
  install: {
    x: installButtonLeft + 31,
    y: installButtonTop + 17,
  },
  run: {
    x: runButtonLeft + 29,
    y: runButtonTop + 17,
  },
} as const;

export const AppFrame = ({
  children,
  activeNav = 'Agent Hub',
}: {
  children: ReactNode;
  activeNav?: string;
}) => {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        fontFamily: theme.fonts.sans,
        color: theme.colors.text.primary,
        background: theme.colors.bg,
      }}
    >
      <div
        style={{
          width: WINDOW_WIDTH,
          height: WINDOW_HEIGHT,
          overflow: 'hidden',
          background: theme.colors.bg,
        }}
      >
        <TitleBar />
        <div style={{display: 'flex', height: MAIN_HEIGHT}}>
          <Sidebar activeNav={activeNav} />
          <main
            style={{
              position: 'relative',
              width: MAIN_WIDTH,
              height: MAIN_HEIGHT,
              overflow: 'hidden',
              background: theme.colors.bg,
            }}
          >
            {children}
          </main>
        </div>
        <StatusStrip />
      </div>
    </div>
  );
};

export const PageScene = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) => {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const PageHeader = ({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow: string;
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
}) => {
  return (
    <header
      style={{
        height: PAGE_HEADER_HEIGHT,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 28,
        borderBottom: `1px solid ${theme.colors.borderSoft}`,
        padding: `${PAGE_HEADER_PADDING_TOP}px ${PAGE_HEADER_PADDING_X}px ${PAGE_HEADER_PADDING_BOTTOM}px`,
      }}
    >
      <div style={{minWidth: 0, flex: 1}}>
        <Label style={{fontSize: 13, marginBottom: 12}}>{eyebrow}</Label>
        <div
          style={{
            ...truncate,
            color: theme.colors.text.primary,
            fontSize: 30,
            fontWeight: 760,
            letterSpacing: 0,
            lineHeight: '36px',
          }}
        >
          {title}
        </div>
        <div
          style={{
            ...truncate,
            color: theme.colors.text.soft,
            fontSize: 17,
            lineHeight: '24px',
            marginTop: 8,
          }}
        >
          {subtitle}
        </div>
      </div>
      {actions ? <div style={{display: 'flex', alignItems: 'center', gap: 10}}>{actions}</div> : null}
    </header>
  );
};

export const PageBody = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) => {
  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        padding: `${PAGE_BODY_PADDING_TOP}px ${PAGE_BODY_PADDING_X}px ${PAGE_BODY_PADDING_BOTTOM}px`,
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const SearchBox = ({placeholder, width = 360}: {placeholder: string; width?: number}) => {
  return (
    <div
      style={{
        width,
        height: 40,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderRadius: theme.radii.lg,
        background: theme.colors.surface,
        border: `1px solid ${theme.colors.border}`,
        color: theme.colors.text.muted,
        boxSizing: 'border-box',
        padding: '0 15px',
      }}
    >
      <span style={{fontSize: 18, lineHeight: 1}}>⌕</span>
      <span style={{...truncate, fontSize: 15, lineHeight: '18px'}}>{placeholder}</span>
    </div>
  );
};

export const RefreshButton = () => {
  return (
    <div
      style={{
        width: 40,
        height: 40,
        display: 'grid',
        placeItems: 'center',
        borderRadius: theme.radii.lg,
        background: theme.colors.surface,
        border: `1px solid ${theme.colors.border}`,
        color: theme.colors.text.soft,
        boxSizing: 'border-box',
        fontSize: 19,
      }}
    >
      ↻
    </div>
  );
};

export const Cursor = ({frame}: {frame: number}) => {
  const sceneOne = frame < 120;
  const x = sceneOne
    ? interpolatePiecewise(
        frame,
        [0, 26, 84, 108, 120],
        [
          1320,
          1190,
          cursorTargets.install.x,
          cursorTargets.install.x,
          cursorTargets.install.x,
        ],
      )
    : interpolatePiecewise(
        frame,
        [120, 158, 194, 214],
        [cursorTargets.install.x, 1560, cursorTargets.run.x, cursorTargets.run.x],
      );
  const y = sceneOne
    ? interpolatePiecewise(
        frame,
        [0, 26, 84, 108, 120],
        [266, 276, cursorTargets.install.y, cursorTargets.install.y, cursorTargets.install.y],
      )
    : interpolatePiecewise(
        frame,
        [120, 158, 194, 214],
        [cursorTargets.install.y, 250, cursorTargets.run.y, cursorTargets.run.y],
      );
  const visible = frame < 226 ? 1 : 0;
  const intro = Math.min(1, Math.max(0, frame / 18));
  const outro = frame > 210 ? Math.max(0, (226 - frame) / 16) : 1;
  const pressed =
    (frame >= 94 && frame <= 104) || (frame >= 197 && frame <= 207);

  if (visible === 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: 28,
        height: 34,
        opacity: intro * outro,
        transform: `scale(${pressed ? 0.9 : 1})`,
        transformOrigin: '4px 4px',
        zIndex: 60,
        filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.55))',
      }}
    >
      <div
        style={{
          width: 24,
          height: 31,
          clipPath: 'polygon(0 0, 0 28px, 7px 22px, 12px 33px, 17px 31px, 12px 20px, 22px 20px)',
          background: theme.colors.text.primary,
        }}
      />
    </div>
  );
};

const TitleBar = () => {
  return (
    <div
      style={{
        height: TITLE_BAR_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        boxSizing: 'border-box',
        background: theme.colors.bg,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
        {['#ff5f57', '#febc2e', '#28c840'].map((color) => (
          <span key={color} style={{width: 16, height: 16, borderRadius: 999, background: color}} />
        ))}
      </div>
    </div>
  );
};

const Sidebar = ({activeNav}: {activeNav: string}) => {
  const nav = [
    {label: 'Agents', icon: '◇', badge: '0'},
    {label: 'Agent Hub', icon: '▦'},
    {label: 'Connectors', icon: '⌯'},
    {label: 'Activity', icon: '⌁'},
    {label: 'Settings', icon: '⚙'},
  ];

  return (
    <aside
      style={{
        width: SIDEBAR_WIDTH,
        height: MAIN_HEIGHT,
        boxSizing: 'border-box',
        borderRight: `1px solid ${theme.colors.borderSoft}`,
        background: theme.colors.sidebarSolid,
        padding: '17px 12px 16px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 10, height: 40, padding: '0 4px'}}>
        <IconBox tone="accent" size={25} style={{borderRadius: 8, fontSize: 13}}>
          ⊙
        </IconBox>
        <div style={{display: 'flex', alignItems: 'center', gap: 8, minWidth: 0}}>
          <span style={{...truncate, color: theme.colors.text.primary, fontSize: 14, fontWeight: 740}}>
            OpenAdminOS
          </span>
          <Mono
            style={{
              display: 'inline-flex',
              borderRadius: 4,
              background: theme.colors.bgRaised,
              color: theme.colors.text.muted,
              fontSize: 11,
              lineHeight: '17px',
              padding: '0 6px',
            }}
          >
            v0.2.5
          </Mono>
        </div>
        <StatusDot tone="success" size={6} />
      </div>

      <Card
        style={{
          height: 66,
          marginTop: 12,
          padding: 11,
          borderRadius: theme.radii.xl,
          background: theme.colors.surface,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div
          style={{
            width: 38,
            height: 38,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 999,
            background: theme.colors.accent,
            color: theme.colors.bg,
            fontSize: 15,
            fontWeight: 800,
            flex: '0 0 auto',
          }}
        >
          UG
        </div>
        <div style={{minWidth: 0, flex: 1}}>
          <div style={{...truncate, color: theme.colors.text.primary, fontSize: 14, fontWeight: 760}}>
            ugurlabs.com
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              marginTop: 2,
              color: theme.colors.text.muted,
              fontSize: 12,
            }}
          >
            <StatusDot tone="success" size={6} />
            <span style={truncate}>administrator@ugurlabs.com</span>
          </div>
        </div>
        <span style={{color: theme.colors.text.faint, fontSize: 15}}>⌄</span>
      </Card>

      <div
        style={{
          height: 38,
          marginTop: 9,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          borderRadius: theme.radii.lg,
          background: theme.colors.bgRaised,
          color: theme.colors.text.muted,
          border: `1px solid ${theme.colors.borderSoft}`,
          boxSizing: 'border-box',
          padding: '0 11px',
          fontSize: 13,
        }}
      >
        <span style={{fontSize: 14}}>⌘</span>
        <span style={{...truncate, flex: 1}}>Quick search</span>
        <Mono style={{fontSize: 11, color: theme.colors.text.faint}}>⌘K</Mono>
      </div>

      <Divider style={{margin: '11px 3px 12px'}} />

      <nav style={{display: 'grid', gap: 4}}>
        <Label style={{fontSize: 11, padding: '0 9px 5px'}}>Workspace</Label>
        {nav.map((item) => {
          const active = item.label === activeNav;
          return (
            <div
              key={item.label}
              style={{
                position: 'relative',
                height: 38,
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                borderRadius: theme.radii.lg,
                padding: '0 10px',
                boxSizing: 'border-box',
                color: active ? theme.colors.text.primary : theme.colors.text.soft,
                background: active
                  ? `linear-gradient(90deg, ${theme.colors.surfaceHover}, ${theme.colors.surface})`
                  : 'transparent',
                boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.04)' : undefined,
              }}
            >
              {active ? (
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 11,
                    width: 3,
                    height: 17,
                    borderRadius: 999,
                    background: theme.colors.accent,
                  }}
                />
              ) : null}
              <span
                style={{
                  width: 18,
                  color: active ? theme.colors.accent : theme.colors.text.muted,
                  fontSize: 17,
                  textAlign: 'center',
                }}
              >
                {item.icon}
              </span>
              <span style={{...truncate, flex: 1, fontSize: 14, fontWeight: 680}}>{item.label}</span>
              {item.badge ? (
                <Mono
                  style={{
                    color: active ? theme.colors.accent : theme.colors.text.muted,
                    background: active ? theme.colors.accentSoft : theme.colors.bgRaised,
                    borderRadius: 8,
                    fontSize: 11,
                    lineHeight: '19px',
                    minWidth: 20,
                    textAlign: 'center',
                  }}
                >
                  {item.badge}
                </Mono>
              ) : null}
            </div>
          );
        })}
      </nav>

      <Card
        style={{
          height: 132,
          marginTop: 28,
          padding: 14,
          borderRadius: theme.radii.xl,
          background: theme.colors.surface,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10}}>
          <Label style={{fontSize: 11}}>Runs · last 7d</Label>
          <Mono style={{fontSize: 12, color: theme.colors.text.soft}}>0</Mono>
        </div>
        <div
          style={{
            height: 40,
            marginTop: 18,
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            alignItems: 'end',
            gap: 7,
            padding: '0 12px',
          }}
        >
          {[3, 5, 4, 7, 5, 8, 5].map((height, index) => (
            <div
              key={`${height}-${index}`}
              style={{
                height,
                borderRadius: 999,
                background: alpha(theme.colors.text.faint, 0.45),
              }}
            />
          ))}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            color: theme.colors.text.faint,
            fontFamily: theme.fonts.mono,
            fontSize: 10,
            textAlign: 'center',
            marginTop: 4,
          }}
        >
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
            <span key={`${day}-${index}`}>{day}</span>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            marginTop: 10,
            color: theme.colors.text.muted,
            fontSize: 12,
          }}
        >
          <StatusDot tone="warning" size={6} />
          <span style={truncate}>No runs recorded yet</span>
        </div>
      </Card>

      <div style={{flex: 1}} />
    </aside>
  );
};

const StatusStrip = () => {
  return (
    <footer
      style={{
        height: STATUS_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderTop: `1px solid ${theme.colors.borderSoft}`,
        background: theme.colors.bg,
        color: theme.colors.text.muted,
        boxSizing: 'border-box',
        padding: '0 16px',
        fontFamily: theme.fonts.mono,
        fontSize: 12,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 10, minWidth: 0}}>
        <span style={{color: theme.colors.info}}>☁</span>
        <span style={{...truncate, color: theme.colors.text.soft}}>tenant: ugurlabs.com</span>
        <span
          style={{
            border: `1px solid ${theme.colors.borderSoft}`,
            borderRadius: 5,
            color: theme.colors.text.muted,
            fontSize: 10,
            lineHeight: '16px',
            padding: '0 6px',
            textTransform: 'uppercase',
          }}
        >
          ENTRA P2
        </span>
        <span style={{opacity: 0.45}}>·</span>
        <span style={{color: theme.colors.success}}>▵</span>
        <span style={{...truncate, color: theme.colors.text.soft}}>Ollama · gemma4:latest</span>
      </div>
      <div style={{color: theme.colors.text.faint, flex: '0 0 auto'}}>v0.2.5 · local-first</div>
    </footer>
  );
};

const interpolatePiecewise = (frame: number, points: number[], values: number[]) => {
  if (points.length !== values.length || points.length === 0) return 0;
  const firstPoint = points[0] ?? 0;
  const firstValue = values[0] ?? 0;
  const lastPoint = points[points.length - 1] ?? firstPoint;
  const lastValue = values[values.length - 1] ?? firstValue;

  if (frame <= firstPoint) return firstValue;
  if (frame >= lastPoint) return lastValue;

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index] ?? lastPoint;
    if (frame <= point) {
      const prevPoint = points[index - 1] ?? firstPoint;
      const prevValue = values[index - 1] ?? firstValue;
      const value = values[index] ?? lastValue;
      const progress = (frame - prevPoint) / (point - prevPoint);
      const eased = 1 - Math.pow(1 - progress, 3);
      return prevValue + (value - prevValue) * eased;
    }
  }

  return lastValue;
};

export const HeaderRunButton = ({pressed = false}: {pressed?: boolean}) => {
  return (
    <Button
      variant="primary"
      pressed={pressed}
      style={{height: 40, minWidth: 86, fontSize: 15}}
    >
      Run
    </Button>
  );
};
