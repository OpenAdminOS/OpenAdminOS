import {Sequence, interpolate, spring, useVideoConfig} from 'remotion';

import {theme} from '../theme';
import {ManifestPanel} from './ManifestPanel';
import {ResultsTable} from './ResultsTable';
import {RunLog} from './RunLog';
import {Chip, Dot, Label, Panel, alpha, clamp} from './ui';

const agents = [
  {name: 'Conditional Access explainer', meta: 'Policy.Read.All'},
  {name: 'Compliance overview', meta: 'DeviceManagementConfiguration.Read.All'},
  {name: 'Tenant health report', meta: 'Directory.Read.All'},
  {name: 'Find inactive devices', meta: 'DeviceManagementManagedDevices.Read.All'},
];

const statusCells = [
  {
    label: 'Tenant',
    value: 'contoso.onmicrosoft.com',
    detail: 'Scope active',
    tone: 'emerald' as const,
  },
  {
    label: 'LLM',
    value: 'Ollama · llama3.1',
    detail: 'Local provider',
    tone: 'emerald' as const,
  },
  {
    label: 'Registry',
    value: '14 agents',
    detail: 'Community index cached',
    tone: 'sky' as const,
  },
  {
    label: 'Writes',
    value: 'Diff gate required',
    detail: 'No bypass available',
    tone: 'amber' as const,
  },
];

export const AppFrame = ({frame, opacity}: {frame: number; opacity: number}) => {
  const {fps} = useVideoConfig();
  const selectionProgress = Math.min(
    1,
    spring({
      frame: Math.max(0, frame - 90),
      fps,
      config: {damping: 18, mass: 0.8, stiffness: 92},
    }),
  );
  const highlightTop = interpolate(selectionProgress, [0, 1], [248, 92], clamp);
  const localChipOpacity = interpolate(frame, [205, 230], [0, 1], clamp);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        opacity,
        transform: `translateY(${interpolate(opacity, [0, 1], [18, 0], clamp)}px)`,
      }}
    >
      <div
        style={{
          width: 1640,
          height: 900,
          overflow: 'hidden',
          borderRadius: 18,
          border: `1px solid ${theme.colors.borderStrong}`,
          background: theme.colors.bg,
          boxShadow: '0 44px 120px rgba(0,0,0,0.58)',
          fontFamily: theme.fonts.sans,
        }}
      >
        <div
          style={{
            height: 52,
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            padding: '0 18px',
            borderBottom: `1px solid ${theme.colors.border}`,
            background: theme.colors.panel,
          }}
        >
          <div style={{display: 'flex', gap: 9}}>
            {['#ff5f57', '#febc2e', '#28c840'].map((color) => (
              <div
                key={color}
                style={{width: 13, height: 13, borderRadius: 999, background: color}}
              />
            ))}
          </div>
          <div
            style={{
              flex: 1,
              textAlign: 'center',
              color: theme.colors.text.faint,
              fontFamily: theme.fonts.mono,
              fontSize: 18,
            }}
          >
            OpenAdminOS
          </div>
          <Chip tone="emerald" style={{fontSize: 17, padding: '3px 10px'}}>
            <Dot />
            local · v0.2.5
          </Chip>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            height: 86,
            borderBottom: `1px solid ${theme.colors.border}`,
            background: 'rgba(255,255,255,0.025)',
          }}
        >
          {statusCells.map((cell) => (
            <div
              key={cell.label}
              style={{
                boxSizing: 'border-box',
                minWidth: 0,
                padding: '8px 22px',
                borderRight: `1px solid ${theme.colors.border}`,
              }}
            >
              <Label
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  lineHeight: '20px',
                }}
              >
                {cell.label}
              </Label>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  minWidth: 0,
                  marginTop: 4,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  color: theme.colors.text.primary,
                  fontSize: 23,
                  fontWeight: 650,
                  lineHeight: '26px',
                }}
              >
                <Dot tone={cell.tone} />
                <span
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cell.value}
                </span>
              </div>
              <div
                style={{
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: theme.colors.text.faint,
                  fontSize: 17,
                  lineHeight: '18px',
                }}
              >
                {cell.detail}
              </div>
            </div>
          ))}
        </div>

        <div style={{display: 'grid', gridTemplateColumns: '330px 1fr', height: 762}}>
          <aside
            style={{
              position: 'relative',
              borderRight: `1px solid ${theme.colors.border}`,
              background: theme.colors.panel,
              padding: 26,
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 14, marginBottom: 34}}>
              <div
                style={{
                  width: 42,
                  height: 42,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: 8,
                  background: alpha(theme.colors.accents.sky, 0.11),
                  border: `1px solid ${alpha(theme.colors.accents.sky, 0.32)}`,
                  color: theme.colors.accents.sky,
                  fontFamily: theme.fonts.mono,
                  fontWeight: 800,
                  fontSize: 18,
                }}
              >
                OA
              </div>
              <div>
                <div style={{color: theme.colors.text.primary, fontSize: 22, fontWeight: 700}}>
                  Agents
                </div>
                <div style={{color: theme.colors.text.faint, fontFamily: theme.fonts.mono, fontSize: 15}}>
                  Open registry
                </div>
              </div>
            </div>

            <Label style={{marginBottom: 12}}>Installed</Label>
            <div
              style={{
                position: 'absolute',
                left: 18,
                right: 18,
                top: highlightTop,
                height: 54,
                borderRadius: 8,
                background: alpha(theme.colors.accents.sky, 0.1),
                border: `1px solid ${alpha(theme.colors.accents.sky, 0.24)}`,
                boxShadow: `inset 3px 0 0 ${theme.colors.accents.sky}`,
              }}
            />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr)',
                gap: 10,
                minWidth: 0,
                position: 'relative',
                width: '100%',
              }}
            >
              {agents.map((agent, index) => {
                const selected = frame >= 118 ? index === 0 : index === 2;

                return (
                  <div
                    key={agent.name}
                    style={{
                      minHeight: 54,
                      minWidth: 0,
                      maxWidth: '100%',
                      overflow: 'hidden',
                      padding: '8px 12px 8px 16px',
                      borderRadius: 8,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      color: selected ? theme.colors.text.primary : theme.colors.text.secondary,
                    }}
                  >
                    <div
                      style={{
                        minWidth: 0,
                        maxWidth: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 18,
                        fontWeight: selected ? 700 : 550,
                      }}
                    >
                      {agent.name}
                    </div>
                    <div
                      style={{
                        minWidth: 0,
                        maxWidth: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: theme.colors.text.faint,
                        fontFamily: theme.fonts.mono,
                        fontSize: 13,
                        marginTop: 2,
                      }}
                    >
                      {agent.meta}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>

          <main style={{position: 'relative', background: theme.colors.bg, overflow: 'hidden'}}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                backgroundImage:
                  'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
                backgroundSize: '44px 44px',
                maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.82), rgba(0,0,0,0.18))',
              }}
            />
            <div
              style={{
                position: 'relative',
                height: 78,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 30px',
                borderBottom: `1px solid ${theme.colors.border}`,
                background: 'rgba(13,14,18,0.84)',
              }}
            >
              <div>
                <div style={{color: theme.colors.text.primary, fontSize: 25, fontWeight: 750}}>
                  Agent run
                </div>
                <div style={{color: theme.colors.text.faint, fontFamily: theme.fonts.mono, fontSize: 15}}>
                  Conditional Access explainer · read-only
                </div>
              </div>
              <div style={{opacity: localChipOpacity}}>
                <Chip tone="emerald">
                  <Dot />
                  local — no egress
                </Chip>
              </div>
            </div>

            <div style={{position: 'relative', height: 684, padding: 30}}>
              <Sequence from={0} durationInFrames={150}>
                <EmptyState frame={frame} />
              </Sequence>
              <Sequence from={90} durationInFrames={180}>
                <ManifestPanel frame={frame} />
              </Sequence>
              <Sequence from={210} durationInFrames={180}>
                <RunLog frame={frame} />
              </Sequence>
              <Sequence from={360} durationInFrames={150}>
                <ResultsTable frame={frame} />
              </Sequence>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
};

const EmptyState = ({frame}: {frame: number}) => {
  const opacity = interpolate(frame, [0, 35, 92, 135], [0, 1, 1, 0], clamp);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 30,
        display: 'grid',
        placeItems: 'center',
        opacity,
      }}
    >
      <Panel
        style={{
          width: 610,
          minHeight: 270,
          padding: 32,
          display: 'grid',
          placeItems: 'center',
          textAlign: 'center',
          background: 'rgba(13,14,18,0.82)',
        }}
      >
        <div
          style={{
            width: 66,
            height: 66,
            borderRadius: 12,
            border: `1px solid ${theme.colors.borderStrong}`,
            display: 'grid',
            placeItems: 'center',
            color: theme.colors.text.faint,
            fontFamily: theme.fonts.mono,
            fontSize: 22,
            marginBottom: 24,
          }}
        >
          []
        </div>
        <div style={{color: theme.colors.text.primary, fontSize: 30, fontWeight: 750}}>
          No agent selected
        </div>
        <div
          style={{
            maxWidth: 450,
            marginTop: 10,
            color: theme.colors.text.muted,
            fontSize: 20,
            lineHeight: 1.48,
          }}
        >
          Choose an agent to review permissions, model requirements, and tenant impact before it runs.
        </div>
      </Panel>
    </div>
  );
};
