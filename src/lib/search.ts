import { KINDS, type Clip, type Kind } from '../types';

/**
 * A scored substring match over ~4,700 records is sub-millisecond, so there is
 * no index to build beyond one lowercase haystack per clip (spec §5).
 */
export type Indexed = {
  clip: Clip;
  title: string;
  context: string;
  hay: string;
};

export function buildIndex(clips: Clip[]): Indexed[] {
  return clips.map((clip) => {
    const title = clip.title.toLowerCase();
    const context = (clip.context ?? '').toLowerCase();
    return {
      clip,
      title,
      context,
      hay: [
        title,
        context,
        clip.kind,
        clip.variant ?? '',
        clip.configName ?? '',
        clip.soundId != null ? String(clip.soundId) : '',
        clip.displayFile.toLowerCase(),
      ].join(' '),
    };
  });
}

export type Query = {
  text: string;
  terms: string[];
  cats: Kind[];
};

const CAT_ALIASES: Record<string, Kind> = {
  sfx: 'sfx',
  sound: 'sfx',
  jingle: 'jingle',
  jingles: 'jingle',
  music: 'music',
  track: 'music',
  soundbank: 'soundbank',
};

/** `cat:jingle level` finds level-up jingles. */
export function parseQuery(raw: string): Query {
  const cats: Kind[] = [];
  const rest: string[] = [];

  for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^cat:(.+)$/i);
    if (m) {
      const kind = CAT_ALIASES[m[1].toLowerCase()];
      if (kind && !cats.includes(kind)) cats.push(kind);
      continue;
    }
    rest.push(tok.toLowerCase());
  }

  return { text: rest.join(' '), terms: rest, cats };
}

/** 0 means no match. Higher is a better hit. */
function scoreOne(idx: Indexed, term: string): number {
  if (idx.title === term) return 1000;
  const t = idx.title.indexOf(term);
  if (t === 0) return 600;
  if (t > 0) return 400 - Math.min(t, 200);
  if (idx.context.includes(term)) return 180;
  const h = idx.hay.indexOf(term);
  if (h >= 0) return 90 - Math.min(h, 60);
  return 0;
}

export function searchIndex(index: Indexed[], query: Query): Clip[] {
  const { terms, cats } = query;
  const scored: { clip: Clip; score: number }[] = [];

  for (const idx of index) {
    if (cats.length && !cats.includes(idx.clip.kind)) continue;

    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      const s = scoreOne(idx, term);
      if (s === 0) {
        matchedAll = false;
        break;
      }
      score += s;
    }
    if (!matchedAll) continue;
    scored.push({ clip: idx.clip, score });
  }

  // With no search terms the score is uniformly 0, so this leaves the caller's
  // original ordering intact rather than shuffling the whole library.
  if (terms.length) scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.clip);
}

export function isKind(v: string): v is Kind {
  return (KINDS as string[]).includes(v);
}
