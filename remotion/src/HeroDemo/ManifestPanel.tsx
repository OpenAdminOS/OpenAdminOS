import {theme} from '../theme';
import {HeaderRunButton, PageBody, PageHeader, PageScene} from './AppFrame';
import {Button, Card, Chip, Field, IconBox, Label, Mono, TextBlock, truncate} from './ui';

const description =
  "Reads every CA policy in the tenant and produces a plain-English explanation of what they do, where they overlap, and what's missing.";

export const AgentDetailScene = ({frame}: {frame: number}) => {
  const runPressed = frame >= 197 && frame <= 207;

  return (
    <PageScene>
      <PageHeader
        eyebrow="Agents"
        title="Conditional Access explainer"
        subtitle={
          <span style={{display: 'inline-flex', alignItems: 'center', gap: 9, minWidth: 0}}>
            <span
              style={{
                width: 18,
                height: 18,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 999,
                background: theme.colors.info,
                color: theme.colors.bg,
                fontSize: 8,
                fontWeight: 800,
                flex: '0 0 auto',
              }}
            >
              OP
            </span>
            <span>OpenAdminOS</span>
            <span style={{color: theme.colors.accent}}>⊛</span>
            <span style={{opacity: 0.5}}>·</span>
            <Mono>v1.0.0</Mono>
            <span style={{opacity: 0.5}}>·</span>
            <span>Policies</span>
            <span style={{opacity: 0.5}}>·</span>
            <Chip tone="accent" style={{fontSize: 12, lineHeight: '18px', padding: '1px 8px'}}>
              YAML template
            </Chip>
          </span>
        }
        actions={
          <>
            <Button variant="ghost" style={{height: 40, width: 126}}>
              Configure
            </Button>
            <HeaderRunButton pressed={runPressed} />
          </>
        }
      />
      <PageBody>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 334px',
            gap: 24,
            height: '100%',
          }}
        >
          <div style={{display: 'grid', gap: 20, alignContent: 'start', minWidth: 0}}>
            <Card style={{padding: 24}}>
              <Label>About</Label>
              <TextBlock style={{marginTop: 14, maxWidth: 850}}>{description}</TextBlock>
              <TextBlock style={{marginTop: 12, maxWidth: 850}}>
                This agent runs against the active tenant scope and produces a structured report.
                The result is saved locally and no tenant content leaves this device with Ollama selected.
              </TextBlock>
            </Card>

            <Card style={{padding: 24}}>
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16}}>
                <div>
                  <Label>Manifest</Label>
                  <div
                    style={{
                      ...truncate,
                      color: theme.colors.text.primary,
                      fontSize: 20,
                      fontWeight: 760,
                      lineHeight: '28px',
                      marginTop: 8,
                    }}
                  >
                    Registry declaration
                  </div>
                </div>
                <Chip>OpenAdminOS 0.1.0+</Chip>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: 12,
                  marginTop: 22,
                }}
              >
                <ManifestFact label="Declared Graph scopes" value="Policy.Read.All" mono />
                <ManifestFact label="Mode" value="Read-only" tone="success" />
                <ManifestFact label="Model requirement" value="8k context minimum" />
                <ManifestFact label="Publisher" value="OpenAdminOS" />
              </div>

              <div
                style={{
                  marginTop: 22,
                  borderRadius: theme.radii.lg,
                  border: `1px solid ${theme.colors.borderSoft}`,
                  background: theme.colors.bgRaised,
                  overflow: 'hidden',
                }}
              >
                {[
                  ['id', 'conditional-access-explainer'],
                  ['category', 'policies'],
                  ['scope', 'Policy.Read.All'],
                  ['result', 'summary + policy findings table'],
                ].map(([key, value], index) => (
                  <div
                    key={key}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '132px minmax(0, 1fr)',
                      gap: 16,
                      padding: '12px 16px',
                      borderTop: index === 0 ? undefined : `1px solid ${theme.colors.borderSoft}`,
                      fontFamily: theme.fonts.mono,
                      fontSize: 13,
                      lineHeight: '20px',
                    }}
                  >
                    <span style={{color: theme.colors.text.muted}}>{key}</span>
                    <span style={{...truncate, color: theme.colors.text.soft}}>{value}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div style={{display: 'grid', gap: 18, alignContent: 'start'}}>
            <Card style={{padding: 20}}>
              <Label>Run preflight</Label>
              <div style={{display: 'grid', gap: 12, marginTop: 16}}>
                <Field label="Tenant" value="ugurlabs.com" />
                <Field label="Provider" value="Ollama · gemma4:latest" />
                <Field label="Residency" value="Local — no egress" />
              </div>
            </Card>
            <Card style={{padding: 20}}>
              <Label>Mode</Label>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  marginTop: 16,
                  borderRadius: theme.radii.md,
                  background: theme.colors.bgRaised,
                  border: `1px solid ${theme.colors.borderSoft}`,
                  padding: 13,
                }}
              >
                <IconBox tone="success" size={36}>
                  ◇
                </IconBox>
                <div style={{minWidth: 0}}>
                  <div style={{...truncate, color: theme.colors.text.primary, fontSize: 15, fontWeight: 740}}>
                    Read-only
                  </div>
                  <div style={{...truncate, color: theme.colors.text.muted, fontSize: 12, marginTop: 3}}>
                    Cannot mutate tenant state.
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </PageBody>
    </PageScene>
  );
};

const ManifestFact = ({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'success';
}) => {
  return (
    <Card
      style={{
        minHeight: 82,
        padding: 15,
        background: theme.colors.bgRaised,
        borderRadius: theme.radii.md,
      }}
    >
      <Label style={{fontSize: 11}}>{label}</Label>
      <div style={{marginTop: 9}}>
        {tone ? (
          <Chip tone={tone}>{value}</Chip>
        ) : mono ? (
          <Mono style={{...truncate, display: 'block', color: theme.colors.text.primary, fontSize: 14}}>
            {value}
          </Mono>
        ) : (
          <div style={{...truncate, color: theme.colors.text.primary, fontSize: 16, lineHeight: '22px'}}>
            {value}
          </div>
        )}
      </div>
    </Card>
  );
};
