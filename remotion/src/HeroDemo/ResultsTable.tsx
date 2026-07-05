import {interpolate} from 'remotion';

import {theme} from '../theme';
import {PageBody, PageHeader, PageScene} from './AppFrame';
import {Button, Card, Chip, Label, Mono, TextBlock, alpha, clamp, truncate} from './ui';

const rows = [
  {
    name: 'CA - Admin MFA pilot',
    state: 'Report-only',
    note: 'Still excludes one emergency access account. Confirm that exclusion is intended.',
  },
  {
    name: 'CA - Require compliant device',
    state: 'Report-only',
    note: 'No planned promotion date is recorded in the policy notes.',
  },
  {
    name: 'CA - Guest baseline review',
    state: 'Report-only',
    note: 'Applies only to guest users. Owner review is needed before enforcement.',
  },
];

export const ResultScene = ({frame}: {frame: number}) => {
  const localFrame = frame - 390;

  return (
    <PageScene>
      <PageHeader
        eyebrow="Result"
        title="Conditional Access explainer"
        subtitle="Completed locally · 24 policies reviewed · no tenant changes made"
        actions={
          <>
            <Button variant="ghost" style={{height: 40, width: 114}}>
              Export
            </Button>
            <Button variant="primary" style={{height: 40, width: 96}}>
              Save
            </Button>
          </>
        }
      />
      <PageBody>
        <div style={{display: 'grid', gap: 22, alignContent: 'start'}}>
          <Card style={{padding: 26}}>
            <div style={{display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24}}>
              <div style={{minWidth: 0, maxWidth: 820}}>
                <Label>Summary</Label>
                <div
                  style={{
                    color: theme.colors.text.primary,
                    fontSize: 24,
                    fontWeight: 760,
                    lineHeight: '32px',
                    marginTop: 10,
                  }}
                >
                  Three report-only policies need owner review before enforcement.
                </div>
                <TextBlock style={{marginTop: 12}}>
                  The tenant has baseline MFA and legacy-auth controls in place. The main gap is policy
                  lifecycle: three policies remain in report-only state and one admin exclusion should be
                  checked against the break-glass account process.
                </TextBlock>
              </div>
              <Card
                style={{
                  width: 320,
                  padding: 16,
                  background: theme.colors.bgRaised,
                  borderRadius: theme.radii.lg,
                }}
              >
                <Label>Evidence</Label>
                <div style={{display: 'grid', gap: 9, marginTop: 13}}>
                  <Evidence value="24" label="Policies read" />
                  <Evidence value="3" label="Report-only" />
                  <Evidence value="0" label="Writes proposed" />
                </div>
              </Card>
            </div>
          </Card>

          <Card style={{overflow: 'hidden'}}>
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
              <div>
                <Label>Flagged policies</Label>
                <div style={{color: theme.colors.text.soft, fontSize: 14, marginTop: 6}}>
                  Review these before changing enforcement.
                </div>
              </div>
              <Mono style={{color: theme.colors.text.muted}}>run_20260705_211314</Mono>
            </div>

            <div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1.1fr) 150px minmax(0, 1.4fr)',
                  gap: 18,
                  padding: '13px 22px',
                  background: theme.colors.bgRaised,
                  color: theme.colors.text.muted,
                  fontFamily: theme.fonts.mono,
                  fontSize: 12,
                  lineHeight: '18px',
                  textTransform: 'uppercase',
                }}
              >
                <span>Policy</span>
                <span>State</span>
                <span>Note</span>
              </div>
              {rows.map((row, index) => {
                const progress = interpolate(localFrame, [16 + index * 9, 30 + index * 9], [0, 1], clamp);
                return (
                  <div
                    key={row.name}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1.1fr) 150px minmax(0, 1.4fr)',
                      gap: 18,
                      alignItems: 'center',
                      minHeight: 72,
                      padding: '0 22px',
                      borderTop: `1px solid ${theme.colors.borderSoft}`,
                      opacity: progress,
                      transform: `translateX(${interpolate(progress, [0, 1], [8, 0], clamp)}px)`,
                    }}
                  >
                    <div style={{...truncate, color: theme.colors.text.primary, fontSize: 16, fontWeight: 720}}>
                      {row.name}
                    </div>
                    <div>
                      <Chip tone="warning" style={{fontSize: 12, lineHeight: '18px', padding: '1px 8px'}}>
                        {row.state}
                      </Chip>
                    </div>
                    <div style={{color: theme.colors.text.soft, fontSize: 15, lineHeight: '22px'}}>
                      {row.note}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </PageBody>
    </PageScene>
  );
};

const Evidence = ({value, label}: {value: string; label: string}) => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 14,
        borderBottom: `1px solid ${alpha(theme.colors.text.primary, 0.055)}`,
        paddingBottom: 8,
      }}
    >
      <Mono style={{color: theme.colors.text.primary, fontSize: 19}}>{value}</Mono>
      <span style={{...truncate, color: theme.colors.text.muted, fontSize: 13}}>{label}</span>
    </div>
  );
};
