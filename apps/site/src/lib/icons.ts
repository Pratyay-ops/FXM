/**
 * Hand-drawn 24×24 icons used by <Icon>. Outline icons are stroked with
 * currentColor; `filled` icons are filled with it instead.
 */
export interface IconData {
  paths: readonly string[]
  filled?: boolean
}

const frame =
  'M4.5 4h15A1.5 1.5 0 0 1 21 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-13A1.5 1.5 0 0 1 4.5 4Z'

export const icons = {
  'arrow-right': { paths: ['M5 12h14', 'm13 6 6 6-6 6'] },
  ban: { paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'm5.7 5.7 12.6 12.6'] },
  browser: { paths: [frame, 'M3 8.5h18', 'M6.5 6.25h.01', 'M9 6.25h.01'] },
  check: { paths: ['m5 12.5 4.5 4.5L19 7.5'] },
  circle: { paths: ['M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z'] },
  close: { paths: ['m6 6 12 12', 'M18 6 6 18'] },
  clock: { paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 7.5V12l3 2'] },
  code: { paths: ['m8.5 7-5 5 5 5', 'm15.5 7 5 5-5 5'] },
  download: { paths: ['M12 4v11', 'm7 10 5 5 5-5', 'M5 20h14'] },
  embed: { paths: ['m8.5 8-4 4 4 4', 'm15.5 8 4 4-4 4', 'm13.5 5-3 14'] },
  'eye-off': {
    paths: [
      'm3 3 18 18',
      'M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 8.5 4.5 9.5 7a13.4 13.4 0 0 1-2.4 3.6',
      'M6.6 6.6C4.5 8 3.1 10.1 2.5 12c1 2.5 4.5 7 9.5 7 1.9 0 3.6-.6 5-1.5',
      'M9.9 9.9a3 3 0 0 0 4.2 4.2',
    ],
  },
  heart: { paths: ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z'] },
  install: { paths: [frame, 'M12 8v7', 'm9 12 3 3 3-3'] },
  library: {
    paths: [
      'M3.5 5h17v4h-17z',
      'M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9',
      'M10 13h4',
    ],
  },
  lyrics: { paths: ['M4 6.5h16', 'M4 11.5h16', 'M4 16.5h9'] },
  menu: { paths: ['M4 7h16', 'M4 12h16', 'M4 17h16'] },
  monitor: {
    paths: [
      'M4 4.5h16a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1Z',
      'M8.5 20h7',
      'M12 16v4',
    ],
  },
  music: {
    paths: [
      'M9 18V6l11-2v12',
      'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
      'M20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    ],
  },
  pause: { paths: ['M7 5h3.5v14H7z', 'M13.5 5H17v14h-3.5z'], filled: true },
  phone: {
    paths: [
      'M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5Z',
      'M11 18h2',
    ],
  },
  play: {
    paths: ['M8 5.8v12.4a1 1 0 0 0 1.5.86l10.2-6.2a1 1 0 0 0 0-1.72L9.5 4.94A1 1 0 0 0 8 5.8Z'],
    filled: true,
  },
  plug: { paths: ['M9 2.5v4', 'M15 2.5v4', 'M6.5 6.5h11V10a5.5 5.5 0 0 1-11 0Z', 'M12 15.5v6'] },
  radio: {
    paths: [
      'M12 12h.01',
      'M8.5 8.5a5 5 0 0 0 0 7',
      'M15.5 8.5a5 5 0 0 1 0 7',
      'M5.6 5.6a9 9 0 0 0 0 12.8',
      'M18.4 5.6a9 9 0 0 1 0 12.8',
    ],
  },
  search: { paths: ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'm16 16 4.5 4.5'] },
  'server-off': {
    paths: [
      'M5 4h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z',
      'M5 14h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z',
      'm3 3 18 18',
    ],
  },
  'skip-back': {
    paths: [
      'M6 5h2v14H6z',
      'M18.5 5.6v12.8a.8.8 0 0 1-1.25.66L9.5 12.66a.8.8 0 0 1 0-1.32l7.75-6.4a.8.8 0 0 1 1.25.66Z',
    ],
    filled: true,
  },
  'skip-forward': {
    paths: [
      'M16 5h2v14h-2z',
      'M5.5 5.6v12.8a.8.8 0 0 0 1.25.66l7.75-6.4a.8.8 0 0 0 0-1.32l-7.75-6.4a.8.8 0 0 0-1.25.66Z',
    ],
    filled: true,
  },
  sparkles: {
    paths: [
      'M11 3.5 12.7 8.3 17.5 10 12.7 11.7 11 16.5 9.3 11.7 4.5 10 9.3 8.3Z',
      'm18 14.5.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8Z',
    ],
  },
  'user-off': {
    paths: [
      'M12 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
      'M5 20c0-3.3 3.1-6 7-6s7 2.7 7 6',
      'm3 3 18 18',
    ],
  },
} satisfies Record<string, IconData>

export type IconName = keyof typeof icons
