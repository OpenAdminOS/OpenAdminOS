import {interpolate} from 'remotion';

import {theme} from '../theme';
import {PageBody, PageHeader, PageScene} from './AppFrame';
import {Button, Card, Chip, Divider, Field, IconBox, Label, Mono, TextBlock, alpha, clamp, truncate} from './ui';

const phrase = 'DISABLE 3 APPS';

const pendingApps = [
  {name: 'Tailspin Legacy App', id: 'app-9f8c2e31', age: 'No sign-in for 214 days'},
  {name: 'Lab Device Bridge', id: 'app-2bb4a091', age: 'Secret expired 173 days ago'},
  {name: 'Archive Sync Helper', id: 'app-775edc10', age: 'No owner assigned'},
];

export const DiffGateScene = ({frame}: {frame: number}) => {
  const localFrame = frame - 480;
  const typedLength = Math.min(
    phrase.length,
    Math.floor(interpolate(localFrame, [24, 92], [0, phrase.length + 0.99], clamp)),
  );
  const typed = phrase.slice(0, typedLength);
  const enabled = typed === phrase;
  const caretVisible = !enabled && Math.floor(localFrame / 10) % 2 === 0;

  return (
    <PageScene>
      <PageHeader
        eyebrow="Agents"
        title="Dormant app registrations"
        subtitle="Write agent · app cleanup plan · ugurlabs.com"
        actions={
          <Button variant="primary" style={{height: 40, width: 96}}>
            Run
          </Button>
        }
      />
      <PageBody>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 332px',
            gap: 22,
            height: '100%',
          }}
        >
          <Card style={{padding: 24}}>
            <Label>Write plan</Label>
            <div style={{color: theme.colors.text.primary, fontSize: 22, fontWeight: 760, marginTop: 10}}>
              Three dormant application registrations are staged for disable.
            </div>
            <TextBlock style={{marginTop: 12, maxWidth: 780}}>
              The agent found no recent sign-in activity, stale credentials, and missing ownership signals.
              Nothing is applied until the diff is approved.
            </TextBlock>
          </Card>
          <Card style={{padding: 20}}>
            <Label>Mode</Label>
            <div style={{marginTop: 14}}>
              <Chip tone="warning">Write · confirmation required</Chip>
            </div>
          </Card>
        </div>
      </PageBody>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(13, 11, 10, 0.68)',
          backdropFilter: 'blur(4px)',
        }}
      >
        <Card
          style={{
            width: 1150,
            height: 720,
            display: 'grid',
            gridTemplateRows: '86px 72px minmax(0, 1fr) 96px',
            overflow: 'hidden',
            background: theme.colors.bgElevated,
            borderColor: theme.colors.borderStrong,
            borderRadius: theme.radii.xl,
            boxShadow: theme.shadows.modal,
          }}
        >
          <ModalHeader />
          <ScopeBar />
          <DiffBody />
          <ConfirmBar typed={typed} enabled={enabled} caretVisible={caretVisible} />
        </Card>
      </div>
    </PageScene>
  );
};

const ModalHeader = () => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 24px',
        borderBottom: `1px solid ${theme.colors.borderSoft}`,
        background: theme.colors.bgElevated,
      }}
    >
      <IconBox tone="warning" size={44}>
        !
      </IconBox>
      <div style={{minWidth: 0, flex: 1}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 12, minWidth: 0}}>
          <div style={{...truncate, color: theme.colors.text.primary, fontSize: 18, fontWeight: 780}}>
            Review changes before applying
          </div>
          <Chip tone="warning" style={{fontSize: 11, lineHeight: '18px', padding: '1px 8px'}}>
            Paused
          </Chip>
        </div>
        <div style={{...truncate, color: theme.colors.text.muted, fontSize: 13, marginTop: 5}}>
          Dormant app registrations · OpenAdminOS v1.0.0 · ugurlabs.com · This change waits for your approval.
        </div>
      </div>
      <Button variant="ghost" style={{height: 36, width: 86}}>
        Cancel
      </Button>
    </div>
  );
};

const ScopeBar = () => {
  const stats = [
    ['Total changes', '3', 'staged'],
    ['Objects affected', '3', 'applications'],
    ['Action', 'Disable', 'reversible'],
    ['Confirmation', 'Typed', 'required'],
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        borderBottom: `1px solid ${theme.colors.borderSoft}`,
      }}
    >
      {stats.map(([label, value, detail], index) => (
        <div
          key={label}
          style={{
            minWidth: 0,
            padding: '13px 18px',
            borderLeft: index === 0 ? undefined : `1px solid ${theme.colors.borderSoft}`,
            boxSizing: 'border-box',
          }}
        >
          <Label style={{fontSize: 10}}>{label}</Label>
          <div style={{display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6, minWidth: 0}}>
            <span
              style={{
                ...truncate,
                color: label === 'Action' ? theme.colors.danger : theme.colors.text.primary,
                fontSize: 17,
                fontWeight: 780,
              }}
            >
              {value}
            </span>
            <span style={{...truncate, color: theme.colors.text.muted, fontSize: 12}}>{detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

const DiffBody = () => {
  return (
    <div style={{display: 'grid', gridTemplateColumns: '284px minmax(0, 1fr)', minHeight: 0}}>
      <aside
        style={{
          borderRight: `1px solid ${theme.colors.borderSoft}`,
          background: theme.colors.bg,
          minHeight: 0,
        }}
      >
        <div
          style={{
            height: 42,
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            borderBottom: `1px solid ${theme.colors.borderSoft}`,
            background: theme.colors.surface,
          }}
        >
          <Mono style={{...truncate, color: theme.colors.text.muted, fontSize: 12}}>
            // Pending changes · 3
          </Mono>
        </div>
        {pendingApps.map((app, index) => (
          <div
            key={app.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 11,
              minHeight: 72,
              padding: '14px 16px',
              boxSizing: 'border-box',
              borderBottom: `1px solid ${theme.colors.borderSoft}`,
              background: index === 0 ? theme.colors.surface : 'transparent',
              boxShadow: index === 0 ? `inset 3px 0 0 ${theme.colors.accent}` : undefined,
            }}
          >
            <IconBox tone="danger" size={22} style={{borderRadius: 6, fontSize: 14}}>
              −
            </IconBox>
            <div style={{minWidth: 0, flex: 1}}>
              <div style={{...truncate, color: theme.colors.text.primary, fontSize: 13, fontWeight: 730}}>
                {app.name}
              </div>
              <Mono style={{...truncate, display: 'block', color: theme.colors.text.muted, fontSize: 11, marginTop: 3}}>
                {app.age}
              </Mono>
            </div>
          </div>
        ))}
      </aside>

      <section style={{minWidth: 0, minHeight: 0, background: theme.colors.bg}}>
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 18,
            padding: '0 22px',
            borderBottom: `1px solid ${theme.colors.borderSoft}`,
            background: theme.colors.bgElevated,
          }}
        >
          <div style={{minWidth: 0}}>
            <div style={{...truncate, color: theme.colors.text.primary, fontSize: 15, fontWeight: 760}}>
              Tailspin Legacy App
            </div>
            <Mono style={{...truncate, display: 'block', color: theme.colors.text.muted, fontSize: 12, marginTop: 3}}>
              applications/9f8c2e31-2e88-4c1f-a219-ec6501b24a18
            </Mono>
          </div>
          <Chip tone="warning">PATCH / disable</Chip>
        </div>

        <div style={{padding: 22}}>
          <div
            style={{
              borderRadius: theme.radii.lg,
              border: `1px solid ${theme.colors.borderSoft}`,
              overflow: 'hidden',
              background: theme.colors.borderSoft,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 1,
            }}
          >
            <DiffSide label="Before · current state" tone="danger">
              <DiffLine k="displayName" value='"Tailspin Legacy App"' />
              <DiffLine k="appId" value='"9f8c2e31..."' />
              <DiffLine k="accountEnabled" value="true" highlight="danger" />
              <DiffLine k="owners" value="[]" />
              <DiffLine k="lastSignIn" value='"2025-12-03"' />
            </DiffSide>
            <DiffSide label="After · staged state" tone="success">
              <DiffLine k="displayName" value='"Tailspin Legacy App"' />
              <DiffLine k="appId" value='"9f8c2e31..."' />
              <DiffLine k="accountEnabled" value="false" highlight="success" />
              <DiffLine k="owners" value="[]" />
              <DiffLine k="disabledBy" value='"agent:dormant-app-registrations"' />
            </DiffSide>
          </div>

          <Card
            style={{
              marginTop: 18,
              padding: 16,
              background: theme.colors.warningSoft,
              borderColor: alpha(theme.colors.warning, 0.24),
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
              <span style={{color: theme.colors.warning, fontSize: 18}}>!</span>
              <div style={{color: theme.colors.text.primary, fontSize: 15, fontWeight: 760}}>
                What this will do
              </div>
            </div>
            <TextBlock style={{fontSize: 14, lineHeight: '22px', marginTop: 10}}>
              OpenAdminOS will set <Mono>accountEnabled: true → false</Mono> on three application
              registrations. Existing audit data remains in Entra. Re-enable manually if an owner
              reports legitimate use.
            </TextBlock>
          </Card>
        </div>
      </section>
    </div>
  );
};

const DiffSide = ({
  label,
  tone,
  children,
}: {
  label: string;
  tone: 'danger' | 'success';
  children: React.ReactNode;
}) => {
  return (
    <div
      style={{
        background: theme.colors.bgElevated,
        padding: 16,
        minWidth: 0,
        fontFamily: theme.fonts.mono,
      }}
    >
      <Label style={{fontSize: 10, color: tone === 'danger' ? theme.colors.danger : theme.colors.success}}>
        {label}
      </Label>
      <Divider style={{margin: '10px 0'}} />
      <div style={{display: 'grid', gap: 6}}>{children}</div>
    </div>
  );
};

const DiffLine = ({
  k,
  value,
  highlight,
}: {
  k: string;
  value: string;
  highlight?: 'danger' | 'success';
}) => {
  const color =
    highlight === 'danger'
      ? theme.colors.danger
      : highlight === 'success'
        ? theme.colors.success
        : theme.colors.text.soft;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '132px minmax(0, 1fr)',
        gap: 12,
        minWidth: 0,
        color: theme.colors.text.soft,
        fontSize: 13,
        lineHeight: '20px',
        background:
          highlight === 'danger'
            ? theme.colors.dangerSoft
            : highlight === 'success'
              ? theme.colors.successSoft
              : 'transparent',
        borderLeft:
          highlight === 'danger'
            ? `2px solid ${theme.colors.danger}`
            : highlight === 'success'
              ? `2px solid ${theme.colors.success}`
              : '2px solid transparent',
        padding: '2px 7px',
        boxSizing: 'border-box',
      }}
    >
      <span style={{...truncate, color: theme.colors.accent}}>{k}</span>
      <span style={{...truncate, color}}>{value}</span>
    </div>
  );
};

const ConfirmBar = ({
  typed,
  enabled,
  caretVisible,
}: {
  typed: string;
  enabled: boolean;
  caretVisible: boolean;
}) => {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 96px 152px',
        gap: 14,
        alignItems: 'end',
        padding: '15px 22px',
        borderTop: `1px solid ${theme.colors.borderSoft}`,
        background: theme.colors.bgElevated,
      }}
    >
      <div style={{minWidth: 0}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 8, minWidth: 0}}>
          <span style={{...truncate, color: theme.colors.text.soft, fontSize: 13}}>
            Type
          </span>
          <Mono
            style={{
              color: theme.colors.danger,
              background: theme.colors.bgRaised,
              borderRadius: 5,
              fontSize: 12,
              lineHeight: '20px',
              padding: '0 7px',
            }}
          >
            {phrase}
          </Mono>
          <span style={{color: theme.colors.text.soft, fontSize: 13}}>to confirm</span>
        </div>
        <div
          style={{
            height: 38,
            display: 'flex',
            alignItems: 'center',
            marginTop: 8,
            borderRadius: theme.radii.sm,
            border: `1px solid ${enabled ? alpha(theme.colors.accent, 0.48) : theme.colors.border}`,
            background: theme.colors.bg,
            color: theme.colors.text.primary,
            boxSizing: 'border-box',
            padding: '0 12px',
            fontFamily: theme.fonts.mono,
            fontSize: 14,
            lineHeight: '18px',
            overflow: 'hidden',
          }}
        >
          <span style={truncate}>{typed}</span>
          {caretVisible ? <span style={{color: theme.colors.accent}}>▌</span> : null}
        </div>
      </div>
      <Button variant="ghost" style={{height: 38, width: 96}}>
        Cancel
      </Button>
      <Button variant="primary" disabled={!enabled} style={{height: 38, width: 152}}>
        Disable 3 apps
      </Button>
    </div>
  );
};
