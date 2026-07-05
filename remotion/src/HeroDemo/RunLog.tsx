import {interpolate} from 'remotion';

import {theme} from '../theme';
import {PageBody, PageHeader, PageScene} from './AppFrame';
import {Card, Chip, Label, Mono, StatusDot, alpha, clamp, truncate} from './ui';

const logLines = [
  {
    at: 16,
    time: '00:08.2',
    step: 'graph',
    message: 'Fetching CA policies — 24 found',
    tone: 'info' as const,
  },
  {
    at: 46,
    time: '00:09.4',
    step: 'graph',
    message: 'Checking exclusions against directory roles',
    tone: 'info' as const,
  },
  {
    at: 78,
    time: '00:10.5',
    step: 'policy',
    message: 'Flagging 3 report-only policies',
    tone: 'warning' as const,
  },
  {
    at: 108,
    time: '00:11.8',
    step: 'llm',
    message: 'Composing summary with Ollama · gemma4:latest',
    tone: 'success' as const,
  },
];

export const LiveRunScene = ({frame}: {frame: number}) => {
  const localFrame = frame - 240;

  return (
    <PageScene>
      <PageHeader
        eyebrow="Run"
        title="Conditional Access explainer · read-only"
        subtitle="run_20260705_211314 · ugurlabs.com · no write operations"
        actions={
          <Chip tone="success" style={{fontSize: 13}}>
            <StatusDot tone="success" size={7} />
            local — no egress
          </Chip>
        }
      />
      <PageBody>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '310px minmax(0, 1fr)',
            gap: 22,
            height: '100%',
          }}
        >
          <Card style={{padding: 22, alignSelf: 'start'}}>
            <Label>Run context</Label>
            <div style={{display: 'grid', gap: 15, marginTop: 18}}>
              <ContextValue label="Tenant" value="ugurlabs.com" />
              <ContextValue label="Provider" value="Ollama" />
              <ContextValue label="Model" value="gemma4:latest" />
              <ContextValue label="Mode" value="Read-only" />
            </div>
            <div
              style={{
                marginTop: 22,
                borderRadius: theme.radii.md,
                background: theme.colors.successSoft,
                border: `1px solid ${alpha(theme.colors.success, 0.22)}`,
                color: theme.colors.text.soft,
                fontSize: 13,
                lineHeight: '21px',
                padding: 13,
              }}
            >
              Graph data and prompt stay on this device with the selected local provider.
            </div>
          </Card>

          <Card
            style={{
              display: 'grid',
              gridTemplateRows: 'auto 1fr',
              overflow: 'hidden',
              minHeight: 548,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                padding: '20px 22px',
                borderBottom: `1px solid ${theme.colors.borderSoft}`,
              }}
            >
              <div style={{minWidth: 0}}>
                <Label>Live activity</Label>
                <div
                  style={{
                    ...truncate,
                    color: theme.colors.text.primary,
                    fontSize: 22,
                    fontWeight: 760,
                    lineHeight: '30px',
                    marginTop: 7,
                  }}
                >
                  Reading tenant policy state
                </div>
              </div>
              <Mono style={{color: theme.colors.text.muted}}>streaming</Mono>
            </div>

            <div style={{padding: 22}}>
              <div
                style={{
                  border: `1px solid ${theme.colors.borderSoft}`,
                  borderRadius: theme.radii.lg,
                  background: theme.colors.bg,
                  overflow: 'hidden',
                  fontFamily: theme.fonts.mono,
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '108px 136px minmax(0, 1fr)',
                    gap: 14,
                    padding: '12px 18px',
                    background: theme.colors.bgRaised,
                    borderBottom: `1px solid ${theme.colors.borderSoft}`,
                    color: theme.colors.text.muted,
                    fontSize: 12,
                    lineHeight: '18px',
                    textTransform: 'uppercase',
                  }}
                >
                  <span>Time</span>
                  <span>Step</span>
                  <span>Message</span>
                </div>
                <div style={{minHeight: 266}}>
                  {logLines.map((line, index) => {
                    const progress = interpolate(localFrame, [line.at, line.at + 14], [0, 1], clamp);
                    const borderTop = index === 0 ? undefined : `1px solid ${alpha(theme.colors.text.primary, 0.045)}`;

                    return (
                      <div
                        key={line.message}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '108px 136px minmax(0, 1fr)',
                          gap: 14,
                          alignItems: 'center',
                          minHeight: 58,
                          padding: '0 18px',
                          borderTop,
                          color: theme.colors.text.soft,
                          fontSize: 15,
                          lineHeight: '20px',
                          opacity: progress,
                          transform: `translateY(${interpolate(progress, [0, 1], [8, 0], clamp)}px)`,
                        }}
                      >
                        <span style={{color: theme.colors.text.muted}}>{line.time}</span>
                        <span style={{color: tokenColor(line.tone)}}>{line.step}</span>
                        <span style={{display: 'flex', alignItems: 'center', gap: 10, minWidth: 0}}>
                          <StatusDot tone={line.tone} size={7} />
                          <span style={truncate}>{line.message}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </Card>
        </div>
      </PageBody>
    </PageScene>
  );
};

const ContextValue = ({label, value}: {label: string; value: string}) => {
  return (
    <div>
      <Label style={{fontSize: 11}}>{label}</Label>
      <div style={{...truncate, color: theme.colors.text.primary, fontSize: 15, lineHeight: '22px', marginTop: 4}}>
        {value}
      </div>
    </div>
  );
};

const tokenColor = (tone: 'info' | 'warning' | 'success') => {
  if (tone === 'info') return theme.colors.info;
  if (tone === 'warning') return theme.colors.warning;
  return theme.colors.success;
};
