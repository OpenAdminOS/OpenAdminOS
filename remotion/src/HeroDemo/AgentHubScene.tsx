import {theme} from '../theme';
import {PageBody, PageHeader, PageScene, RefreshButton, SearchBox} from './AppFrame';
import {Button, Card, Chip, Divider, IconBox, Label, Mono, alpha, truncate} from './ui';

const description =
  "Reads every CA policy in the tenant and produces a plain-English explanation of what they do, where they overlap, and what's missing.";

const builtInAgents = [
  {
    name: 'Conditional Access explainer',
    description,
    category: 'Policies',
    installs: '',
  },
  {
    name: 'Dormant app registrations',
    description:
      'Reads tenant app registrations, groups them by likely purpose, and recommends keep/disable/delete per group with reasoning.',
    category: 'Apps',
    installs: '',
  },
  {
    name: 'Find inactive devices',
    description:
      'Surfaces Intune-managed devices that have not synced recently, grouped by inactivity window.',
    category: 'Devices',
    installs: '1 install',
  },
];

export const AgentHubScene = ({frame}: {frame: number}) => {
  const installPressed = frame >= 94 && frame <= 104;

  return (
    <PageScene>
      <PageHeader
        eyebrow="Registry"
        title="Agent Hub"
        subtitle="9 agents · 4 dashboards · remote · refreshed 9:13:14 PM"
        actions={
          <>
            <RefreshButton />
            <SearchBox placeholder="Search agents, authors, scopes" width={376} />
          </>
        }
      />
      <PageBody>
        <HubTabs />
        <FeaturedAgent installPressed={installPressed} />
        <BuiltInRow />
      </PageBody>
    </PageScene>
  );
};

const HubTabs = () => {
  return (
    <Card
      style={{
        height: 68,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 24,
        padding: '0 16px',
        background: theme.colors.surface,
        borderRadius: theme.radii.xl,
      }}
    >
      <div
        style={{
          height: 42,
          display: 'inline-flex',
          alignItems: 'center',
          borderRadius: theme.radii.lg,
          background: theme.colors.bg,
          border: `1px solid ${theme.colors.border}`,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: '100%',
            padding: '0 15px',
            borderRadius: theme.radii.md,
            color: theme.colors.accent,
            background: theme.colors.accentSoft,
            border: `1px solid ${alpha(theme.colors.accent, 0.34)}`,
            boxSizing: 'border-box',
            fontSize: 14,
            fontWeight: 720,
          }}
        >
          <span>Agents</span>
          <Mono style={{fontSize: 12, color: theme.colors.text.muted}}>9</Mono>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: '100%',
            padding: '0 15px',
            color: theme.colors.text.soft,
            fontSize: 14,
            fontWeight: 650,
          }}
        >
          <span>Dashboards</span>
          <Mono style={{fontSize: 12, color: theme.colors.text.muted}}>4</Mono>
        </div>
      </div>
      <div
        style={{
          ...truncate,
          color: theme.colors.text.soft,
          fontSize: 14,
          lineHeight: '18px',
          textAlign: 'right',
        }}
      >
        Multi-step reasoning across Graph. Investigators, advisors, write actions with judgment.
      </div>
    </Card>
  );
};

const FeaturedAgent = ({installPressed}: {installPressed: boolean}) => {
  return (
    <Card
      style={{
        height: 296,
        marginTop: 22,
        padding: 30,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 520px',
        gap: 44,
        background: theme.colors.surface,
        borderRadius: theme.radii.xl,
      }}
    >
      <div style={{minWidth: 0}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 8, minWidth: 0}}>
          <Chip tone="accent">✦ Featured</Chip>
          <Chip>Read-only</Chip>
          <Chip>Requires Entra ID P1</Chip>
        </div>
        <div
          style={{
            ...truncate,
            color: theme.colors.text.primary,
            fontSize: 30,
            fontWeight: 780,
            lineHeight: '38px',
            marginTop: 18,
          }}
        >
          Conditional Access explainer
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            minWidth: 0,
            color: theme.colors.text.muted,
            fontSize: 14,
            marginTop: 12,
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 999,
              background: theme.colors.info,
              color: theme.colors.bg,
              fontSize: 11,
              fontWeight: 800,
              flex: '0 0 auto',
            }}
          >
            OP
          </span>
          <span style={{...truncate, color: theme.colors.text.soft}}>OpenAdminOS</span>
          <span style={{color: theme.colors.accent}}>⊛</span>
          <span style={{opacity: 0.55}}>·</span>
          <Mono style={{fontSize: 13}}>v1.0.0</Mono>
        </div>
        <div
          style={{
            maxWidth: 650,
            color: theme.colors.text.soft,
            fontSize: 17,
            lineHeight: '27px',
            marginTop: 22,
          }}
        >
          {description}
        </div>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginTop: 22}}>
          <Button variant="primary" pressed={installPressed} style={{width: 82}}>
            Install
          </Button>
          <Button variant="ghost" style={{width: 128}}>
            View manifest
          </Button>
        </div>
      </div>

      <div style={{display: 'grid', alignContent: 'start', gap: 12, paddingTop: 28}}>
        <Card
          style={{
            height: 74,
            padding: 15,
            background: theme.colors.bgRaised,
            borderRadius: theme.radii.lg,
          }}
        >
          <Label style={{fontSize: 11}}>Category</Label>
          <div style={{...truncate, color: theme.colors.text.primary, fontSize: 17, marginTop: 8}}>
            Policies
          </div>
        </Card>
        <Card
          style={{
            height: 74,
            padding: 15,
            background: theme.colors.bgRaised,
            borderRadius: theme.radii.lg,
          }}
        >
          <Label style={{fontSize: 11}}>Graph scopes</Label>
          <Mono
            style={{
              display: 'inline-flex',
              marginTop: 8,
              maxWidth: '100%',
              borderRadius: 6,
              background: theme.colors.bg,
              color: theme.colors.text.soft,
              fontSize: 13,
              lineHeight: '20px',
              padding: '0 8px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Policy.Read.All
          </Mono>
        </Card>
      </div>
    </Card>
  );
};

const BuiltInRow = () => {
  return (
    <div style={{marginTop: 34}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
        <span style={{color: theme.colors.warning, fontSize: 16}}>♙</span>
        <Label style={{fontSize: 13, color: theme.colors.text.soft}}>Built-in agents</Label>
        <Divider style={{flex: 1}} />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 12,
          marginTop: 16,
        }}
      >
        {builtInAgents.map((agent) => (
          <BuiltInCard key={agent.name} agent={agent} />
        ))}
      </div>
    </div>
  );
};

const BuiltInCard = ({
  agent,
}: {
  agent: {
    name: string;
    description: string;
    category: string;
    installs: string;
  };
}) => {
  return (
    <Card
      style={{
        height: 220,
        padding: 22,
        borderRadius: theme.radii.xl,
        background: theme.colors.surface,
      }}
    >
      <div style={{display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14}}>
        <IconBox size={39}>◇</IconBox>
        <Chip tone="warning" style={{fontSize: 12, lineHeight: '18px', padding: '1px 8px'}}>
          ↗ Built-in
        </Chip>
      </div>
      <div
        style={{
          ...truncate,
          color: theme.colors.text.primary,
          fontSize: 17,
          fontWeight: 740,
          lineHeight: '23px',
          marginTop: 16,
        }}
      >
        {agent.name}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: theme.colors.text.muted,
          fontSize: 12,
          marginTop: 5,
          minWidth: 0,
        }}
      >
        <span
          style={{
            width: 16,
            height: 16,
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
        <span style={truncate}>OpenAdminOS</span>
        <span style={{color: theme.colors.accent}}>⊛</span>
      </div>
      <div
        style={{
          color: theme.colors.text.soft,
          fontSize: 14,
          lineHeight: '22px',
          marginTop: 16,
          minHeight: 45,
        }}
      >
        {agent.description}
      </div>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 20}}>
        <Mono style={{...truncate, color: theme.colors.text.muted, fontSize: 13}}>
          {agent.category}
          {agent.installs ? ` · ${agent.installs}` : ''}
        </Mono>
        <Button variant="primary" style={{height: 34, width: 72, fontSize: 14, padding: '0 12px'}}>
          Install
        </Button>
      </div>
    </Card>
  );
};
