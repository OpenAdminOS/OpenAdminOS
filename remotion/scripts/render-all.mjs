import {mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

mkdirSync(new URL('../../web/public/videos/', import.meta.url), {recursive: true});

const commands = [
  [
    'video',
    [
      'npx',
      'remotion',
      'render',
      'HeroDemo',
      '../web/public/videos/hero-demo.mp4',
      '--codec',
      'h264',
      '--crf',
      '28',
    ],
  ],
  [
    'poster',
    [
      'npx',
      'remotion',
      'still',
      'HeroDemo',
      '../web/public/videos/hero-demo-poster.jpg',
      '--frame',
      '300',
    ],
  ],
];

for (const [label, command] of commands) {
  const result = spawnSync(command[0], command.slice(1), {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    console.error(`Remotion ${label} render failed.`);
    process.exit(result.status ?? 1);
  }
}

console.log(
  'Rendered HeroDemo to ../web/public/videos/hero-demo.mp4 and ../web/public/videos/hero-demo-poster.jpg.',
);
