import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number, props: IconProps) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

export const IconAgents = ({ size = 18, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

export const IconHub = ({ size = 18, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </svg>
);

export const IconActivity = ({ size = 18, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M3 12 H7 L9.5 5 L14 19 L16.5 12 H21" />
  </svg>
);

export const IconConnectors = ({ size = 18, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M8.2 11 L15.8 7" />
    <path d="M8.2 13 L15.8 17" />
  </svg>
);

export const IconSettings = ({ size = 18, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.3l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);

export const IconPlay = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M6 4 L20 12 L6 20 Z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconPlus = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 5 V19 M5 12 H19" />
  </svg>
);

export const IconSearch = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16 L20.5 20.5" />
  </svg>
);

export const IconCheck = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M5 12.5 L10 17 L19 7" />
  </svg>
);

export const IconClose = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M6 6 L18 18 M18 6 L6 18" />
  </svg>
);

export const IconChevronRight = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M9 6 L15 12 L9 18" />
  </svg>
);

export const IconArrowLeft = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M19 12 H5 M11 6 L5 12 L11 18" />
  </svg>
);

export const IconShield = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 3 L20 6 V12 C20 16.5 16.5 19.5 12 21 C7.5 19.5 4 16.5 4 12 V6 Z" />
  </svg>
);

export const IconLock = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11 V8 a4 4 0 0 1 8 0 V11" />
  </svg>
);

export const IconBolt = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M13 3 L5 13 H11 L9 21 L19 9 H13 Z" />
  </svg>
);

export const IconCloud = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M7 18 a4 4 0 0 1 0-8 a5 5 0 0 1 10 0 a3.5 3.5 0 0 1 0 8 Z" />
  </svg>
);

export const IconHardDrive = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3.5" y="13" width="17" height="7" rx="1.5" />
    <path d="M5.5 13 L8 6 H16 L18.5 13" />
    <circle cx="7" cy="16.5" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

export const IconStar = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 3.5 L14.6 9 L20.5 9.7 L16.2 13.7 L17.4 19.5 L12 16.7 L6.6 19.5 L7.8 13.7 L3.5 9.7 L9.4 9 Z" />
  </svg>
);

export const IconBadgeCheck = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 3 L14 5 L17 5 L17 8 L19 10 L17 12 L17 15 L14 15 L12 17 L10 15 L7 15 L7 12 L5 10 L7 8 L7 5 L10 5 Z" />
    <path d="M9 10 L11.2 12 L15 8" />
  </svg>
);

export const IconSparkle = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 3 L13.6 9.4 L20 11 L13.6 12.6 L12 19 L10.4 12.6 L4 11 L10.4 9.4 Z" />
  </svg>
);

export const IconLogo = ({ size = 22, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth={1.6} />
    <circle cx="12" cy="12" r="2.25" fill="currentColor" stroke="none" />
  </svg>
);

export const IconArrowRight = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M5 12 H19 M13 6 L19 12 L13 18" />
  </svg>
);

export const IconExternal = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M14 4 H20 V10" />
    <path d="M20 4 L11 13" />
    <path d="M18 13 V19 a1 1 0 0 1-1 1 H5 a1 1 0 0 1-1-1 V7 a1 1 0 0 1 1-1 H11" />
  </svg>
);

export const IconShare = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M8.2 11 L15.8 7 M8.2 13 L15.8 17" />
  </svg>
);

export const IconDownload = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 4 V15 M7 11 L12 16 L17 11" />
    <path d="M5 19 H19" />
  </svg>
);

export const IconCommand = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M9 9 a3 3 0 1 1 0-6 a3 3 0 0 1 3 3 V21 a3 3 0 0 0 3 3 a3 3 0 0 0 0-6 H3 a3 3 0 0 0-3 3 a3 3 0 0 0 3 3 V3" transform="translate(3 -3)" />
  </svg>
);

export const IconClock = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7 V12 L15.5 14.5" />
  </svg>
);

export const IconTrend = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M3 17 L9 11 L13 14 L21 6" />
    <path d="M16 6 H21 V11" />
  </svg>
);

export const IconFire = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 3 C12 7 8 8 8 12 C8 15 10 17 12 17 C14 17 16 15 16 12 C16 9 14 8 13 6 C13 8 12 9 12 11" />
    <path d="M12 17 C9 17 6 15 6 11 C6 16 9 21 12 21 C15 21 18 16 18 11 C18 15 15 17 12 17 Z" />
  </svg>
);

export const IconWarning = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 3 L21 19 H3 Z" />
    <path d="M12 10 V14 M12 17 V17.01" />
  </svg>
);

export const IconCopy = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8 V6 a2 2 0 0 0-2-2 H6 a2 2 0 0 0-2 2 V14 a2 2 0 0 0 2 2 H8" />
  </svg>
);

export const IconChevronUpDown = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M8 9 L12 5 L16 9" />
    <path d="M8 15 L12 19 L16 15" />
  </svg>
);

export const IconChevronDown = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M6 9 L12 15 L18 9" />
  </svg>
);

export const IconSlack = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3" y="9" width="6" height="2.4" rx="1.2" />
    <rect x="9" y="3" width="2.4" height="6" rx="1.2" />
    <rect x="15" y="12.6" width="6" height="2.4" rx="1.2" />
    <rect x="12.6" y="15" width="2.4" height="6" rx="1.2" />
    <rect x="9" y="12.6" width="2.4" height="2.4" rx="1.2" />
    <rect x="12.6" y="9" width="2.4" height="2.4" rx="1.2" />
  </svg>
);

