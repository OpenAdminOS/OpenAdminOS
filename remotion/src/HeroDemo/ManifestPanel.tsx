import type {ReactNode} from 'react';
import {interpolate} from 'remotion';

import {theme} from '../theme';
import {Chip, Dot, Label, Panel, clamp} from './ui';

export const ManifestPanel = ({frame}: {frame: number}) => {
  const opacity = interpolate(frame, [90, 124, 214, 250], [0, 1, 1, 0], clamp);
  const translateX = interpolate(frame, [90, 130], [46, 0], clamp);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 30,
        display: 'grid',
        gridTemplateColumns: '520px 1fr',
        gap: 24,
        opacity,
        transform: `translateX(${translateX}px)`,
      }}
    >
      <Panel accent="sky" style={{padding: 28, alignSelf: 'start'}}>
        <Label>Manifest</Label>
        <div style={{marginTop: 12, color: theme.colors.text.primary, fontSize: 32, fontWeight: 760}}>
          Conditional Access explainer
        </div>
        <div style={{marginTop: 10, color: theme.colors.text.muted, fontSize: 19, lineHeight: 1.48}}>
          Reviews Conditional Access policies, report-only coverage, broad exclusions, and named
          location usage.
        </div>

        <div style={{display: 'grid', gap: 16, marginTop: 30}}>
          <ManifestRow label="Mode">
            <Chip tone="emerald">Read-only</Chip>
          </ManifestRow>
          <ManifestRow label="Scopes">
            <Chip tone="sky">Policy.Read.All</Chip>
          </ManifestRow>
          <ManifestRow label="Model">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: theme.colors.text.secondary,
                fontFamily: theme.fonts.mono,
                fontSize: 20,
              }}
            >
              <Dot />
              Local · Ollama · llama3.1
            </div>
          </ManifestRow>
        </div>
      </Panel>

      <Panel style={{padding: 28, background: 'rgba(13,14,18,0.64)', alignSelf: 'start'}}>
        <Label>Run preflight</Label>
        <div style={{display: 'grid', gap: 14, marginTop: 20}}>
          {[
            ['Tenant scope', 'contoso.onmicrosoft.com'],
            ['Permission class', 'Read-only Graph policy data'],
            ['Data residency', 'Local provider selected'],
            ['Write gate', 'Not required for this run'],
          ].map(([label, value]) => (
            <div
              key={label}
              style={{
                display: 'grid',
                gridTemplateColumns: '170px 1fr',
                gap: 14,
                alignItems: 'baseline',
                paddingBottom: 13,
                borderBottom: `1px solid ${theme.colors.border}`,
              }}
            >
              <div style={{color: theme.colors.text.faint, fontFamily: theme.fonts.mono, fontSize: 16}}>
                {label}
              </div>
              <div style={{color: theme.colors.text.secondary, fontSize: 19}}>{value}</div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
};

const ManifestRow = ({label, children}: {label: string; children: ReactNode}) => {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '120px 1fr',
        alignItems: 'center',
        gap: 20,
      }}
    >
      <div style={{color: theme.colors.text.faint, fontFamily: theme.fonts.mono, fontSize: 17}}>
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
};
