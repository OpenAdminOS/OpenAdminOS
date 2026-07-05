import {interpolate, spring, useVideoConfig} from 'remotion';

import {theme} from '../theme';
import {Chip, Dot, Label, Panel, alpha, clamp} from './ui';

const logLines = [
  {at: 0, channel: 'graph', text: 'Fetching Conditional Access policies... 24 found'},
  {at: 38, channel: 'graph', text: 'Checking exclusions against directory roles...'},
  {at: 76, channel: 'policy', text: '3 policies in report-only mode'},
  {at: 114, channel: 'graph', text: 'Correlating named locations...'},
];

export const RunLog = ({frame}: {frame: number}) => {
  const {fps} = useVideoConfig();
  const localFrame = frame - 210;
  const intro = Math.min(
    1,
    spring({
      frame: Math.max(0, localFrame),
      fps,
      config: {damping: 20, mass: 0.9, stiffness: 86},
    }),
  );
  const outro = interpolate(frame, [354, 382], [1, 0], clamp);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 30,
        opacity: intro * outro,
        transform: `translateY(${interpolate(intro, [0, 1], [24, 0], clamp)}px)`,
      }}
    >
      <Panel style={{height: '100%', display: 'grid', gridTemplateRows: 'auto 1fr'}}>
        <div
          style={{
            padding: '22px 26px',
            borderBottom: `1px solid ${theme.colors.border}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <Label>Live run</Label>
            <div style={{marginTop: 6, color: theme.colors.text.primary, fontSize: 28, fontWeight: 740}}>
              Reading tenant policy state
            </div>
          </div>
          <Chip tone="emerald">
            <Dot />
            local-only
          </Chip>
        </div>

        <div style={{display: 'grid', gridTemplateColumns: '290px 1fr'}}>
          <div
            style={{
              borderRight: `1px solid ${theme.colors.border}`,
              padding: 24,
              display: 'grid',
              alignContent: 'start',
              gap: 16,
              background: 'rgba(255,255,255,0.018)',
            }}
          >
            {[
              ['Tenant', 'contoso.onmicrosoft.com'],
              ['Provider', 'Ollama'],
              ['Model', 'llama3.1'],
              ['Mode', 'Read-only'],
            ].map(([label, value]) => (
              <div key={label}>
                <div style={{color: theme.colors.text.faint, fontFamily: theme.fonts.mono, fontSize: 15}}>
                  {label}
                </div>
                <div style={{color: theme.colors.text.secondary, fontSize: 18, marginTop: 4}}>
                  {value}
                </div>
              </div>
            ))}
          </div>

          <div style={{padding: 24}}>
            <div
              style={{
                borderRadius: 8,
                overflow: 'hidden',
                border: `1px solid ${theme.colors.border}`,
                background: '#090a0d',
                fontFamily: theme.fonts.mono,
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '110px 130px 1fr',
                  padding: '11px 18px',
                  color: theme.colors.text.faint,
                  background: theme.colors.panel,
                  borderBottom: `1px solid ${theme.colors.border}`,
                  fontSize: 15,
                  textTransform: 'uppercase',
                }}
              >
                <span>Time</span>
                <span>Step</span>
                <span>Message</span>
              </div>

              <div style={{padding: '10px 0'}}>
                {logLines.map((line, index) => {
                  const progress = interpolate(
                    localFrame,
                    [line.at, line.at + 18],
                    [0, 1],
                    clamp,
                  );

                  return (
                    <div
                      key={line.text}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '110px 130px 1fr',
                        padding: '13px 18px',
                        color: theme.colors.text.secondary,
                        fontSize: 18,
                        borderBottom:
                          index === logLines.length - 1 ? undefined : `1px solid rgba(255,255,255,0.05)`,
                        opacity: progress,
                        transform: `translateY(${interpolate(progress, [0, 1], [12, 0], clamp)}px)`,
                      }}
                    >
                      <span style={{color: theme.colors.text.faint}}>
                        00:{String(7 + index * 2).padStart(2, '0')}
                      </span>
                      <span
                        style={{
                          color:
                            line.channel === 'policy'
                              ? theme.colors.accents.amber
                              : theme.colors.accents.sky,
                        }}
                      >
                        {line.channel}
                      </span>
                      <span>
                        <span
                          style={{
                            display: 'inline-block',
                            width: 9,
                            height: 9,
                            borderRadius: 999,
                            marginRight: 10,
                            background: alpha(theme.colors.accents.emerald, 0.9),
                          }}
                        />
                        {line.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
};
