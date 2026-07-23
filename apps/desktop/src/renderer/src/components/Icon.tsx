import type { JSX } from 'react';

/**
 * The app's icon set — inline stroke SVGs instead of emoji, so every control
 * renders identically on every platform and inherits the theme color.
 */
export type IconName =
  | 'paperclip'
  | 'sparkles'
  | 'mic'
  | 'headset'
  | 'brain'
  | 'compass'
  | 'image'
  | 'file'
  | 'play'
  | 'pause'
  | 'redo'
  | 'x'
  | 'folder'
  | 'gauge'
  | 'search';

const PATHS: Record<IconName, JSX.Element> = {
  paperclip: (
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ),
  sparkles: (
    <>
      <path d="M11 4l1.6 3.9L16.5 9.5l-3.9 1.6L11 15l-1.6-3.9L5.5 9.5l3.9-1.6L11 4z" />
      <path d="M18.5 14l.9 2.1L21.5 17l-2.1.9-.9 2.1-.9-2.1L15.5 17l2.1-.9.9-2.1z" />
    </>
  ),
  mic: (
    <>
      <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </>
  ),
  headset: (
    <>
      <path d="M3 14v-3a9 9 0 0 1 18 0v3" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3v5z" />
      <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3v5z" />
    </>
  ),
  brain: (
    <>
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44A2.5 2.5 0 0 1 4.5 17.5v-11A2.5 2.5 0 0 1 7 4a2.5 2.5 0 0 1 2.5-2z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44A2.5 2.5 0 0 0 19.5 17.5v-11A2.5 2.5 0 0 0 17 4a2.5 2.5 0 0 0-2.5-2z" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>
  ),
  play: <path d="M7 4l13 8-13 8V4z" />,
  pause: (
    <>
      <line x1="8" y1="5" x2="8" y2="19" />
      <line x1="16" y1="5" x2="16" y2="19" />
    </>
  ),
  redo: (
    <>
      <path d="M3 12a9 9 0 1 0 2.83-6.54L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  x: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  folder: (
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </>
  ),
  gauge: (
    <>
      <path d="M5 20a9 9 0 1 1 14 0" />
      <line x1="12" y1="14" x2="16.5" y2="8.5" />
      <circle cx="12" cy="14" r="1.6" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="icon"
    >
      {PATHS[name]}
    </svg>
  );
}
