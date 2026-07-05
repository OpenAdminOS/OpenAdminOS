import type {CSSProperties, ReactNode} from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';

import {theme} from '../theme';
import {AgentHubScene} from './AgentHubScene';
import {AppFrame, Cursor} from './AppFrame';
import {DiffGateScene} from './DiffGate';
import {AgentDetailScene} from './ManifestPanel';
import {ResultScene} from './ResultsTable';
import {LiveRunScene} from './RunLog';
import {clamp, sceneFade} from './ui';

export const HeroDemo = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        background: theme.colors.bg,
        color: theme.colors.text.primary,
        overflow: 'hidden',
      }}
    >
      <AppFrame activeNav="Agent Hub">
        <SceneLayer opacity={sceneFade(frame, 0, 120)}>
          <AgentHubScene frame={frame} />
        </SceneLayer>
        <SceneLayer opacity={sceneFade(frame, 112, 240)}>
          <AgentDetailScene frame={frame} />
        </SceneLayer>
        <SceneLayer opacity={sceneFade(frame, 232, 390)}>
          <LiveRunScene frame={frame} />
        </SceneLayer>
        <SceneLayer opacity={sceneFade(frame, 382, 480)}>
          <ResultScene frame={frame} />
        </SceneLayer>
        <SceneLayer
          opacity={interpolate(frame, [472, 480], [0, 1], clamp)}
          style={{transform: `translateY(${interpolate(frame, [472, 480], [8, 0], clamp)}px)`}}
        >
          <DiffGateScene frame={frame} />
        </SceneLayer>
      </AppFrame>
      <Cursor frame={frame} />
    </AbsoluteFill>
  );
};

const SceneLayer = ({
  opacity,
  children,
  style,
}: {
  opacity: number;
  children: ReactNode;
  style?: CSSProperties;
}) => {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        opacity,
        transform: `translateY(${(1 - opacity) * 6}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};
