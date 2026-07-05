import {Composition} from 'remotion';

import {HeroDemo} from './HeroDemo';

export const Root = () => {
  return (
    <Composition
      id="HeroDemo"
      component={HeroDemo}
      durationInFrames={600}
      fps={30}
      height={1080}
      width={1920}
    />
  );
};
