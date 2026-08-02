export type Kind = 'sfx' | 'jingle' | 'music' | 'soundbank';

export const KINDS: Kind[] = ['sfx', 'jingle', 'music', 'soundbank'];

export type Clip = {
  /** Stable slug: sha1 prefix + slugified title. Sha1-keyed because duplicate
   *  titles across categories exist (spec §10). */
  id: string;
  title: string;
  /** Quest / event / holiday, e.g. "Dragon Slayer". Kept, not stripped. */
  context: string | null;
  /** null for the current in-game version; "8-bit", "v2", "2018 Version"… */
  variant: string | null;
  isCurrent: boolean;
  kind: Kind;

  /** Relative path under the library root, or null when the clip lives only on
   *  the wiki. Music streams by default, so most music clips have a null file. */
  file: string | null;
  /** Direct wiki URL. Always present — it is how we stream, and how we
   *  re-download if the local copy goes missing. */
  remoteUrl: string;
  /** Pretty filename, preserved for display and future drag-out (spec §8). */
  displayFile: string;
  bytes: number;
  /** Seconds. null until the wiki tells us or we probe the file locally. */
  duration: number | null;
  sha1: string;

  /** Populated by the sprite pass (spec §7), which is a later phase. */
  soundId: number | null;
  configName: string | null;
};

export type Manifest = {
  generatedAt: string;
  /** Bumped when the manifest shape changes so old libraries can be rebuilt. */
  version: number;
  clips: Clip[];
  /** Base title -> clip ids. Powers the variant chips. */
  groups: Record<string, string[]>;
};

export const MANIFEST_VERSION = 1;

export type Settings = {
  /** Jingles at or under this many seconds also appear on the soundboard. */
  jingleBoardMaxSeconds: number;
  sfxOnly: boolean;
  currentOnly: boolean;
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  padSize: number;
  searchAll: boolean;
};

export type DurationFilter = 'any' | 'lt2' | '2to8' | '8to60' | 'gt60';

export const DURATION_FILTERS: { value: DurationFilter; label: string }[] = [
  { value: 'any', label: 'Any length' },
  { value: 'lt2', label: 'Under 2s' },
  { value: '2to8', label: '2–8s' },
  { value: '8to60', label: '8s–1min' },
  { value: 'gt60', label: 'Over 1min' },
];

export function matchesDuration(d: number | null, f: DurationFilter): boolean {
  if (f === 'any') return true;
  if (d == null) return false;
  switch (f) {
    case 'lt2':
      return d < 2;
    case '2to8':
      return d >= 2 && d <= 8;
    case '8to60':
      return d > 8 && d <= 60;
    case 'gt60':
      return d > 60;
  }
}

/** Per-pad tweaks from the right-click menu. */
export type PadSetting = { gain: number; rate: number };

export const DEFAULT_PAD: PadSetting = { gain: 1, rate: 1 };

export const DEFAULT_SETTINGS: Settings = {
  jingleBoardMaxSeconds: 8,
  sfxOnly: false,
  currentOnly: true,
  masterVolume: 0.8,
  sfxVolume: 1,
  musicVolume: 0.7,
  padSize: 116,
  searchAll: false,
};
