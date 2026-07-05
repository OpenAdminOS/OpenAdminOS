import {interpolate, spring, useVideoConfig} from 'remotion';

import {theme} from '../theme';
import {Chip, Label, Panel, clamp} from './ui';

const rows = [
  {
    policy: 'Require MFA for admins',
    finding: 'Emergency access account excluded',
    severity: 'review',
    tone: 'amber' as const,
  },
  {
    policy: 'Block legacy authentication',
    finding: 'Enabled for all users',
    severity: 'ok',
    tone: 'emerald' as const,
  },
  {
    policy: 'Report-only pilots',
    finding: '3 policies still in report-only',
    severity: 'medium',
    tone: 'sky' as const,
  },
  {
    policy: 'Trusted locations',
    finding: 'Two broad ranges need review',
    severity: 'review',
    tone: 'amber' as const,
  },
];

export const ResultsTable = ({frame}: {frame: number}) => {
  const {fps} = useVideoConfig();
  const localFrame = frame - 360;
  const intro = Math.min(
    1,
    spring({
      frame: Math.max(0, localFrame),
      fps,
      config: {damping: 19, mass: 0.82, stiffness: 88},
    }),
  );
  const opacity = interpolate(frame, [360, 386, 500, 510], [0, 1, 1, 0], clamp);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 30,
        opacity,
        transform: `translateY(${interpolate(intro, [0, 1], [28, 0], clamp)}px)`,
      }}
    >
      <Panel style={{padding: 28, height: '100%'}}>
        <Label>Result</Label>
        <div style={{marginTop: 8, color: theme.colors.text.primary, fontSize: 31, fontWeight: 760}}>
          24 policies reviewed. 4 findings need admin review; no changes proposed.
        </div>
        <div style={{marginTop: 8, color: theme.colors.text.muted, fontSize: 19}}>
          Read-only report generated locally from the active tenant scope.
        </div>

        <div
          style={{
            marginTop: 28,
            border: `1px solid ${theme.colors.border}`,
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.05fr 1.35fr 170px',
              padding: '13px 18px',
              background: 'rgba(255,255,255,0.04)',
              color: theme.colors.text.faint,
              fontFamily: theme.fonts.mono,
              fontSize: 16,
              textTransform: 'uppercase',
            }}
          >
            <span>Policy</span>
            <span>Finding</span>
            <span>Severity</span>
          </div>
          {rows.map((row, index) => {
            const rowProgress = interpolate(localFrame, [18 + index * 10, 34 + index * 10], [0, 1], clamp);

            return (
              <div
                key={row.policy}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.05fr 1.35fr 170px',
                  padding: '18px 18px',
                  borderTop: `1px solid ${theme.colors.border}`,
                  alignItems: 'center',
                  opacity: rowProgress,
                  transform: `translateX(${interpolate(rowProgress, [0, 1], [18, 0], clamp)}px)`,
                }}
              >
                <div style={{color: theme.colors.text.primary, fontSize: 20, fontWeight: 650}}>
                  {row.policy}
                </div>
                <div style={{color: theme.colors.text.secondary, fontSize: 20}}>{row.finding}</div>
                <div>
                  <Chip tone={row.tone} style={{fontSize: 17, padding: '3px 10px'}}>
                    {row.severity}
                  </Chip>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
};
