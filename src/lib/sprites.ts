import { matchRule } from './rules';
import { api, batched, normFile, slugify } from './wiki';
import type { Clip, Manifest, SpriteInfo } from '../types';

/**
 * Sprite matching (spec §7), four tiers descending in confidence.
 *
 *   1. Template:SFXLine reverse index — the wiki's SFX Project states the
 *      sound -> article link explicitly, so for documented articles this is
 *      not fuzzy matching at all.
 *   2. Filename derivation using the project's naming conventions, with every
 *      guess verified against a real article title.
 *   3. Article -> image, by icon naming convention first and a scored image
 *      list second.
 *   4. A generated tile, which lives in sprite.ts and needs no network.
 *
 * Every stage is best-effort: a failure anywhere degrades that clip to the
 * generated tile rather than failing the pass.
 */

export type SpriteProgress = (info: { stage: string; done: number; total: number }) => void;

export type SpriteResult = {
  sprites: Record<string, SpriteInfo>;
  /** Clip id -> what the sound is ("Attacking", "Being hit"). Independent of
   *  whether artwork resolved — the description is useful on its own. */
  descriptions: Record<string, string>;
  /** Thumbnails to fetch, deduped by destination. */
  downloads: { id: string; url: string; dest: string; bytes: number }[];
  soundMeta: Record<string, { soundId: number | null; configName: string | null }>;
};

/* ------------------------------------------------------------- tier one ---- */

const SFXLINE = /\{\{SFXLine\s*\|([^}]*)\}\}/g;

export function extractSounds(wikitext: string): { file: string; desc: string }[] {
  const rows: { file: string; desc: string }[] = [];
  for (const m of wikitext.matchAll(SFXLINE)) {
    const params = Object.fromEntries(
      m[1]
        .split('|')
        .map((kv) => {
          const i = kv.indexOf('=');
          return i < 0 ? null : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
        })
        .filter((x): x is [string, string] => !!x),
    );
    if (params.file) rows.push({ file: params.file, desc: params.desc ?? '' });
  }
  return rows;
}

/** file (normalised) -> articles that declare it. One-to-many is the norm. */
async function sfxLineIndex(
  onProgress: SpriteProgress,
  signal?: AbortSignal,
): Promise<Map<string, { articles: string[]; desc: string }>> {
  const index = new Map<string, { articles: string[]; desc: string }>();

  // 1. Every article that uses the template.
  const titles: string[] = [];
  let cont: string | null = null;
  do {
    // Annotated because `cont` feeds the request and is assigned from the
    // response, which is enough to make inference chase its own tail.
    const j: EmbeddedIn = await api<EmbeddedIn>(
      {
        action: 'query',
        list: 'embeddedin',
        eititle: 'Template:SFXLine',
        einamespace: '0',
        eilimit: '500',
        ...(cont ? { eicontinue: cont } : {}),
      },
      signal,
    );
    for (const p of j.query?.embeddedin ?? []) titles.push(p.title);
    cont = j.continue?.eicontinue ?? null;
  } while (cont);

  onProgress({ stage: 'Reading documented articles', done: 0, total: titles.length });

  // 2. Their wikitext, 50 at a time.
  const batches = batched(titles);
  let done = 0;
  for (const batch of batches) {
    const j = await api<PagesWithRevisions>(
      {
        action: 'query',
        titles: batch.join('|'),
        prop: 'revisions',
        rvslots: 'main',
        rvprop: 'content',
      },
      signal,
    );

    for (const page of j.query?.pages ?? []) {
      const text = page.revisions?.[0]?.slots?.main?.content;
      if (!text) continue;
      for (const { file, desc } of extractSounds(text)) {
        const key = normFile(file);
        const entry = index.get(key);
        if (entry) {
          if (!entry.articles.includes(page.title)) entry.articles.push(page.title);
          if (!entry.desc && desc) entry.desc = desc;
        } else {
          index.set(key, { articles: [page.title], desc });
        }
      }
    }

    done += batch.length;
    onProgress({ stage: 'Reading documented articles', done, total: titles.length });
  }

  return index;
}

/* ------------------------------------------------------------- tier two ---- */

const ACTIONS =
  /\s+(special attack( \d+)?|attack|hit|death|ringing|playing|growl|noise|opening|closing|scanning|swinging|snoring)(\s*\(.*\))?$/i;

/** Engine-style prefixes: `100 goblin falls`, `2H crush`. */
const LEADING_ID = /^\d+[a-z]?\s+/i;

/** How many candidates one filename may contribute, to bound the API cost. */
const MAX_CANDIDATES = 4;

/**
 * Ordered article-name candidates for a filename, longest first.
 *
 * A real example from the library: `100 goblin falls.ogg` names a Goblin, but
 * the leading id defeats a literal lookup and `falls` is not in the known
 * action list, so the old single-guess version produced "100 goblin falls",
 * failed verification, and dropped to a tile. Offering progressively shorter
 * prefixes — "goblin falls", then "goblin" — lets verification find the entity.
 *
 * Longest first matters: `Fire Blast.ogg` must resolve to the spell, not to
 * "Fire".
 */
export function guessSubjects(filename: string): string[] {
  let n = filename.replace(/\.(wav|ogg|mp3)$/i, '').replace(/\s*\(unused\)$/i, '');
  // "Equip fun" names no entity, but "Equip whip" names a whip. Strip the verb
  // and let title verification throw out the ones that resolve to nothing —
  // that is exactly what the verification pass is for. Discarding every Equip
  // file to dodge one pathological case costs hundreds of real matches.
  n = n.replace(/^Equip\s+/i, '');
  n = n.replace(LEADING_ID, '');
  n = n.replace(ACTIONS, '').trim();

  const words = n.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let len = words.length; len >= 1; len--) {
    const candidate = words.slice(0, len).join(' ');
    // Two-letter fragments match half the wiki; they are noise, not candidates.
    if (candidate.length >= 3 && !out.includes(candidate)) out.push(candidate);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** Keep only the guesses that resolve to a real article. */
async function verifyTitles(
  guesses: string[],
  onProgress: SpriteProgress,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const unique = [...new Set(guesses)];
  let done = 0;

  for (const batch of batched(unique)) {
    const j = await api<PagesWithInfo>(
      { action: 'query', titles: batch.join('|'), prop: 'info', redirects: '1' },
      signal,
    );

    // Redirects mean the title we asked for is not the title we got back.
    const redirects = new Map((j.query?.redirects ?? []).map((r) => [r.from, r.to]));
    const live = new Set(
      (j.query?.pages ?? []).filter((p) => !p.missing && p.ns === 0).map((p) => p.title),
    );

    for (const guess of batch) {
      const target = redirects.get(guess) ?? guess;
      if (live.has(target)) resolved.set(guess, target);
    }

    done += batch.length;
    onProgress({ stage: 'Checking article names', done, total: unique.length });
  }

  return resolved;
}

/* ----------------------------------------------------------- tier three ---- */

const CHROME =
  /^File:(Wiki|.*\b(logo|licence|license|button|navigation|disambig|stub|padlock|update|chathead placeholder)\b)/i;

function conventionCandidates(title: string): string[] {
  return [`File:${title}.png`, `File:${title} detail.png`, `File:${title} chathead.png`];
}

function scoreImage(title: string, image: string): number {
  if (CHROME.test(image)) return -1;
  if (!/\.png$/i.test(image)) return -1;
  const bare = image.replace(/^File:/, '').replace(/\.png$/i, '');
  if (bare.toLowerCase() === title.toLowerCase()) return 100;
  if (bare.toLowerCase() === `${title.toLowerCase()} detail`) return 90;
  if (bare.toLowerCase() === `${title.toLowerCase()} chathead`) return 80;
  if (bare.toLowerCase().startsWith(title.toLowerCase())) return 60;
  return 10;
}

export type Thumb = { file: string; url: string };

/**
 * Article title -> a 64px thumbnail. `iiurlwidth` means the whole sprite set
 * lands around 3–5 MB rather than pulling full-size renders.
 */
export type ArtworkRequest = {
  subject: string;
  /** Explicit ordered `File:` candidates. Falls back to the naming conventions. */
  files?: string[];
};

async function resolveArtwork(
  requests: ArtworkRequest[],
  onProgress: SpriteProgress,
  signal?: AbortSignal,
): Promise<Map<string, Thumb>> {
  const found = new Map<string, Thumb>();
  const best = new Map<string, number>(); // subject -> index of the winning candidate

  // Deduplicate by subject, preferring whichever request supplied explicit files.
  const bySubject = new Map<string, ArtworkRequest>();
  for (const r of requests) {
    const existing = bySubject.get(r.subject);
    if (!existing || (!existing.files && r.files)) bySubject.set(r.subject, r);
  }
  let done = 0;

  // Pass A: explicit candidates where a rule supplied them, otherwise the
  // naming conventions that cover most items, spells and NPCs.
  const wanted = new Map<string, { subject: string; rank: number }>();
  for (const r of bySubject.values()) {
    const candidates = r.files ?? conventionCandidates(r.subject);
    candidates.forEach((c, rank) => {
      if (!wanted.has(c)) wanted.set(c, { subject: r.subject, rank });
    });
  }

  for (const batch of batched([...wanted.keys()])) {
    const j = await api<PagesWithImageInfo>(
      {
        action: 'query',
        titles: batch.join('|'),
        prop: 'imageinfo',
        iiprop: 'url',
        iiurlwidth: '64',
      },
      signal,
    );

    for (const page of j.query?.pages ?? []) {
      if (page.missing) continue;
      const ii = page.imageinfo?.[0];
      const url = ii?.thumburl ?? ii?.url;
      if (!url) continue;
      const hit = wanted.get(page.title);
      if (!hit) continue;
      // Candidates are ordered best-first, so a lower rank always wins. This
      // is simpler than re-scoring and it honours a rule's stated preference.
      const current = best.get(hit.subject);
      if (current === undefined || hit.rank < current) {
        best.set(hit.subject, hit.rank);
        found.set(hit.subject, { file: page.title, url });
      }
    }

    done += batch.length;
    onProgress({ stage: 'Finding artwork', done, total: wanted.size });
  }

  // Pass B: for whatever is still unmatched, list the article's images and
  // score. Skipped for rule-supplied subjects — a rule naming exact files and
  // missing means the icon is not there, not that we should go guessing.
  const missing = [...bySubject.values()]
    .filter((r) => !r.files && !found.has(r.subject))
    .map((r) => r.subject);
  let mdone = 0;
  for (const batch of batched(missing, 20)) {
    const j = await api<PagesWithImages>(
      { action: 'query', titles: batch.join('|'), prop: 'images', imlimit: '50' },
      signal,
    );

    const best = new Map<string, { image: string; score: number }>();
    for (const page of j.query?.pages ?? []) {
      for (const img of page.images ?? []) {
        const score = scoreImage(page.title, img.title);
        if (score < 0) continue;
        const cur = best.get(page.title);
        if (!cur || score > cur.score) best.set(page.title, { image: img.title, score });
      }
    }

    // Turn the winners into thumbnail URLs.
    const picks = [...best.entries()];
    if (picks.length) {
      const j2 = await api<PagesWithImageInfo>(
        {
          action: 'query',
          titles: picks.map(([, v]) => v.image).join('|'),
          prop: 'imageinfo',
          iiprop: 'url',
          iiurlwidth: '64',
        },
        signal,
      );
      const urls = new Map(
        (j2.query?.pages ?? [])
          .map((p) => [p.title, p.imageinfo?.[0]?.thumburl ?? p.imageinfo?.[0]?.url])
          .filter((e): e is [string, string] => !!e[1]),
      );
      for (const [subject, v] of picks) {
        const url = urls.get(v.image);
        if (url) found.set(subject, { file: v.image, url });
      }
    }

    mdone += batch.length;
    onProgress({ stage: 'Finding artwork', done: mdone, total: missing.length });
  }

  return found;
}

/* ------------------------------------------------------ bonus  metadata ---- */

const LICENSE_ID = /\|\s*id\s*=\s*(\d+)/i;
const LICENSE_NAME = /\|\s*name\s*=\s*([^\n|}]+)/i;

/**
 * `Template:Sound effect license` carries the in-game config name and sound id.
 * Sound ids are not unique per file, so they are searchable metadata, never a key.
 */
async function soundMetadata(
  clips: Clip[],
  onProgress: SpriteProgress,
  signal?: AbortSignal,
): Promise<Record<string, { soundId: number | null; configName: string | null }>> {
  const out: Record<string, { soundId: number | null; configName: string | null }> = {};
  const byTitle = new Map(clips.map((c) => [`File:${c.displayFile}`, c.id]));
  const titles = [...byTitle.keys()];
  let done = 0;

  for (const batch of batched(titles)) {
    const j = await api<PagesWithRevisions>(
      {
        action: 'query',
        titles: batch.join('|'),
        prop: 'revisions',
        rvslots: 'main',
        rvprop: 'content',
      },
      signal,
    );

    for (const page of j.query?.pages ?? []) {
      const text = page.revisions?.[0]?.slots?.main?.content;
      const id = byTitle.get(page.title);
      if (!text || !id) continue;
      if (!/Sound effect license/i.test(text)) continue;
      const sid = text.match(LICENSE_ID);
      const name = text.match(LICENSE_NAME);
      out[id] = {
        soundId: sid ? Number(sid[1]) : null,
        configName: name ? name[1].trim() || null : null,
      };
    }

    done += batch.length;
    onProgress({ stage: 'Reading sound metadata', done, total: titles.length });
  }

  return out;
}

/* ----------------------------------------------------------------- main ---- */

export async function buildSprites(
  manifest: Manifest,
  onProgress: SpriteProgress,
  signal?: AbortSignal,
): Promise<SpriteResult> {
  const sfx = manifest.clips.filter((c) => c.kind === 'sfx' || c.kind === 'jingle');

  const index = await sfxLineIndex(onProgress, signal);

  // Tier 1 assignments.
  const subjectOf = new Map<
    string,
    {
      subject: string;
      alternates: string[];
      source: 'sfxline' | 'filename' | 'rule';
      confidence: 'high' | 'medium' | 'low';
      /** Set when a curated rule named the artwork outright. */
      files?: string[];
    }
  >();
  const descriptions: Record<string, string> = {};
  const undocumented: Clip[] = [];

  for (const clip of sfx) {
    const hit = index.get(normFile(clip.displayFile));
    // Keep the description even when the artwork lookup later comes up empty:
    // "Being hit" is what makes a sound findable, art or no art.
    if (hit?.desc) descriptions[clip.id] = hit.desc;
    if (hit && hit.articles.length) {
      // Shortest title is a decent representative when a sound is shared.
      const sorted = [...hit.articles].sort((a, b) => a.length - b.length);
      subjectOf.set(clip.id, {
        subject: sorted[0],
        alternates: sorted.slice(1),
        source: 'sfxline',
        confidence: 'high',
      });
    } else {
      undocumented.push(clip);
    }
  }

  // Tier 2 for the rest, now offering several candidates per file.
  const candidates = new Map<string, string[]>();
  for (const clip of undocumented) {
    const list = guessSubjects(clip.displayFile);
    if (list.length) candidates.set(clip.id, list);
  }

  const verified = await verifyTitles(
    [...new Set([...candidates.values()].flat())],
    onProgress,
    signal,
  );

  for (const [clipId, list] of candidates) {
    // First match wins, and the list is longest-first, so the most specific
    // article that actually exists is the one chosen.
    const i = list.findIndex((c) => verified.has(c));
    if (i < 0) continue;
    subjectOf.set(clipId, {
      subject: verified.get(list[i])!,
      alternates: [],
      source: 'filename',
      // Having to shorten the name means we guessed at the entity, so say so.
      confidence: i === 0 ? 'medium' : 'low',
    });
  }

  // Curated rules for whatever the first two tiers could not name. Narrow by
  // design and checked against the wiki like everything else, so a rule that
  // names a file which does not exist simply leaves the clip on a tile.
  for (const clip of sfx) {
    if (subjectOf.has(clip.id)) continue;
    const rule = matchRule(clip.displayFile);
    if (!rule) continue;
    subjectOf.set(clip.id, {
      subject: rule.subject,
      alternates: [],
      source: 'rule',
      confidence: 'high',
      files: rule.files,
    });
  }

  // Tier 3: subject -> artwork.
  const artwork = await resolveArtwork(
    [...subjectOf.values()].map((v) => ({ subject: v.subject, files: v.files })),
    onProgress,
    signal,
  );

  const sprites: Record<string, SpriteInfo> = {};
  const downloads: SpriteResult['downloads'] = [];
  const seenDest = new Set<string>();

  for (const [clipId, info] of subjectOf) {
    const art = artwork.get(info.subject);
    if (!art) continue;
    const dest = `sprites/${slugify(art.file.replace(/^File:/, ''))}.png`;
    sprites[clipId] = {
      file: dest,
      url: art.url,
      subject: info.subject,
      alternates: info.alternates,
      source: info.source,
      confidence: info.confidence,
    };
    if (!seenDest.has(dest)) {
      seenDest.add(dest);
      // Byte size is unknown for thumbnails, so 0 means "always fetch"; the
      // set is small and only downloaded when the sprite pass is re-run.
      downloads.push({ id: dest, url: art.url, dest, bytes: 0 });
    }
  }

  const soundMeta = await soundMetadata(
    manifest.clips.filter((c) => c.kind === 'sfx'),
    onProgress,
    signal,
  );

  return { sprites, descriptions, downloads, soundMeta };
}

/* ---------------------------------------------------------------- types ---- */

type EmbeddedIn = {
  query?: { embeddedin?: { title: string }[] };
  continue?: { eicontinue?: string };
};

type PagesWithRevisions = {
  query?: {
    pages?: {
      title: string;
      revisions?: { slots?: { main?: { content?: string } } }[];
    }[];
  };
};

type PagesWithInfo = {
  query?: {
    redirects?: { from: string; to: string }[];
    pages?: { title: string; ns?: number; missing?: boolean }[];
  };
};

type PagesWithImageInfo = {
  query?: {
    pages?: {
      title: string;
      missing?: boolean;
      imageinfo?: { url?: string; thumburl?: string }[];
    }[];
  };
};

type PagesWithImages = {
  query?: { pages?: { title: string; images?: { title: string }[] }[] };
};
