import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';

import {theme} from '../theme';
import {AppFrame} from './AppFrame';
import {DiffGate} from './DiffGate';
import {clamp} from './ui';

export const HeroDemo = () => {
  const frame = useCurrentFrame();
  const appOpacity = interpolate(frame, [0, 42], [0, 1], clamp);

  return (
    <AbsoluteFill
      style={{
        background: theme.colors.bg,
        color: theme.colors.text.primary,
        overflow: 'hidden',
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
          opacity: 0.42,
        }}
      />
      {frame < 510 ? <AppFrame frame={frame} opacity={appOpacity} /> : <DiffGate frame={frame} />}
    </AbsoluteFill>
  );
};
