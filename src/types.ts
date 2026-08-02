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

  /** In-game config name and sound id from Template:Sound effect license.
   *  Sound ids are not unique per file, so never key anything by them. */
  soundId: number | null;
  configName: string | null;

  /** Wiki artwork for this clip, or null to fall back to a generated tile. */
  sprite: SpriteInfo | null;
};

export type SpriteInfo = {
  /** Relative path under the library root, e.g. `sprites/abyssal-whip.png`. */
  file: string;
  /** Remote thumbnail URL — used before the local copy exists. */
  url: string;
  /** Source article, e.g. "Abyssal whip". */
  subject: string;
  /** Other articles using this same sound. `Equip fun.wav` has dozens. */
  alternates: string[];
  source: 'sfxline' | 'filename' | 'manual';
  confidence: 'high' | 'medium' | 'low';
};

export type Manifest = {
  generatedAt: string;
  /** Bumped when the manifest shape changes so old libraries can be rebuilt. */
  version: number;
  clips: Clip[];
  /** Base title -> clip ids. Powers the variant chips. */
  groups: Record<string, string[]>;
};

/** Bumped to 2 when sprite metadata joined the schema. */
export const MANIFEST_VERSION = 2;

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
  /** Drag from anywhere on a pad, not just the grab handle (spec §8, B). */
  gestureDrag: boolean;
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

/** Spec §5 lists has-sprite as a filter. "none" is the interesting one: it is
 *  how you find what the matcher missed and worth fixing by hand. */
export type SpriteFilter = 'any' | 'has' | 'none';

export const SPRITE_FILTERS: { value: SpriteFilter; label: string }[] = [
  { value: 'any', label: 'Any artwork' },
  { value: 'has', label: 'Has sprite' },
  { value: 'none', label: 'No sprite' },
];

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
  gestureDrag: false,
};
