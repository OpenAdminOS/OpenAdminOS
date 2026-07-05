import {interpolate} from 'remotion';

import {theme} from '../theme';
import {Chip, Dot, Label, Panel, alpha, clamp} from './ui';

const diffLines = [
  {kind: 'same', text: 'grantControls: {'},
  {kind: 'removed', text: '-  operator: "OR",'},
  {kind: 'added', text: '+  operator: "AND",'},
  {kind: 'same', text: '   builtInControls: ['},
  {kind: 'same', text: '     "mfa",'},
  {kind: 'added', text: '+    "compliantDevice",'},
  {kind: 'same', text: '   ]'},
  {kind: 'same', text: '}'},
];

export const DiffGate = ({frame}: {frame: number}) => {
  const panelOpacity = interpolate(frame, [510, 522, 570, 600], [1, 1, 1, 0], clamp);
  const panelY = interpolate(frame, [510, 526], [0, 0], clamp);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        opacity: panelOpacity,
        transform: `translateY(${panelY}px)`,
        fontFamily: theme.fonts.sans,
      }}
    >
      <Panel
        accent="amber"
        style={{
          width: 1120,
          minHeight: 650,
          background: '#0a0b0f',
          borderColor: alpha(theme.colors.accents.amber, 0.3),
          boxShadow: '0 44px 120px rgba(0,0,0,0.68)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '26px 30px',
            borderBottom: `1px solid ${theme.colors.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: `linear-gradient(180deg, ${alpha(theme.colors.accents.amber, 0.08)}, rgba(13,14,18,0))`,
          }}
        >
          <div>
            <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
              <div style={{color: theme.colors.text.primary, fontSize: 34, fontWeight: 780}}>
                Proposed change
              </div>
              <Chip tone="amber" style={{fontSize: 17, padding: '3px 10px'}}>
                paused
              </Chip>
            </div>
            <div style={{marginTop: 7, color: theme.colors.text.muted, fontFamily: theme.fonts.mono, fontSize: 17}}>
              Conditional Access policy · Require compliant device
            </div>
          </div>
          <Chip tone="amber">
            <Dot tone="amber" />
            write review
          </Chip>
        </div>

        <div style={{display: 'grid', gridTemplateColumns: '1fr 330px', minHeight: 430}}>
          <div style={{padding: 30}}>
            <Label>Diff</Label>
            <div
              style={{
                marginTop: 16,
                overflow: 'hidden',
                borderRadius: 8,
                border: `1px solid ${theme.colors.border}`,
                background: '#08090c',
                fontFamily: theme.fonts.mono,
              }}
            >
              {diffLines.map((line, index) => {
                const color =
                  line.kind === 'added'
                    ? theme.colors.accents.emerald
                    : line.kind === 'removed'
                      ? theme.colors.accents.danger
                      : theme.colors.text.secondary;

                return (
                  <div
                    key={`${line.kind}-${line.text}`}
                    style={{
                      padding: '9px 18px',
                      borderTop: index === 0 ? undefined : '1px solid rgba(255,255,255,0.045)',
                      background:
                        line.kind === 'added'
                          ? alpha(theme.colors.accents.emerald, 0.08)
                          : line.kind === 'removed'
                            ? alpha(theme.colors.accents.danger, 0.08)
                            : 'transparent',
                      color,
                      fontSize: 19,
                      lineHeight: 1.45,
                    }}
                  >
                    {line.text}
                  </div>
                );
              })}
            </div>
          </div>

          <div
            style={{
              borderLeft: `1px solid ${theme.colors.border}`,
              padding: 28,
              background: 'rgba(255,255,255,0.018)',
            }}
          >
            <Label>Review state</Label>
            <div style={{marginTop: 16, color: theme.colors.text.primary, fontSize: 24, fontWeight: 730}}>
              Confirmation required
            </div>
            <div style={{marginTop: 10, color: theme.colors.text.muted, fontSize: 18, lineHeight: 1.5}}>
              OpenAdminOS does not apply write plans until the admin reviews the diff and types the
              confirmation phrase.
            </div>
          </div>
        </div>

        <div
          style={{
            padding: '22px 30px',
            borderTop: `1px solid ${theme.colors.border}`,
            display: 'grid',
            gridTemplateColumns: '1fr 160px',
            gap: 18,
            alignItems: 'end',
            background: theme.colors.panel,
          }}
        >
          <div>
            <div style={{color: theme.colors.text.secondary, fontFamily: theme.fonts.mono, fontSize: 18}}>
              Type APPLY CHANGE to confirm
            </div>
            <div
              style={{
                height: 48,
                marginTop: 9,
                borderRadius: 6,
                border: `1px solid ${theme.colors.borderStrong}`,
                background: '#08090c',
              }}
            />
          </div>
          <div
            style={{
              height: 48,
              borderRadius: 6,
              display: 'grid',
              placeItems: 'center',
              border: `1px solid ${theme.colors.border}`,
              background: 'rgba(255,255,255,0.04)',
              color: theme.colors.text.faint,
              fontSize: 18,
              fontWeight: 700,
            }}
          >
            Confirm
          </div>
        </div>
      </Panel>
    </div>
  );
};
