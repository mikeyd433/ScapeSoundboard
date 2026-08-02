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

export function guessSubject(filename: string): string | null {
  let n = filename.replace(/\.(wav|ogg|mp3)$/i, '').replace(/\s*\(unused\)$/i, '');
  // "Equip fun" names no entity — it is shared by dozens of items. Tier 4.
  if (/^Equip /i.test(n)) return null;
  n = n.replace(ACTIONS, '').trim();
  return n.length >= 2 ? n : null;
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
async function resolveArtwork(
  subjects: string[],
  onProgress: SpriteProgress,
  signal?: AbortSignal,
): Promise<Map<string, Thumb>> {
  const found = new Map<string, Thumb>();
  const unique = [...new Set(subjects)];
  let done = 0;

  // Pass A: the naming conventions, which cover most items, spells and NPCs.
  const wanted = new Map<string, string>(); // candidate file -> subject
  for (const s of unique) for (const c of conventionCandidates(s)) wanted.set(c, s);

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
      const subject = wanted.get(page.title);
      if (!subject) continue;
      // Candidates are generated best-first, so never downgrade an existing hit.
      const existing = found.get(subject);
      if (!existing || scoreImage(subject, page.title) > scoreImage(subject, existing.file)) {
        found.set(subject, { file: page.title, url });
      }
    }

    done += batch.length;
    onProgress({ stage: 'Finding artwork', done, total: wanted.size });
  }

  // Pass B: for whatever is still unmatched, list the article's images and score.
  const missing = unique.filter((s) => !found.has(s));
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
  const subjectOf = new Map<string, { subject: string; alternates: string[]; source: 'sfxline' | 'filename' }>();
  const undocumented: Clip[] = [];

  for (const clip of sfx) {
    const hit = index.get(normFile(clip.displayFile));
    if (hit && hit.articles.length) {
      // Shortest title is a decent representative when a sound is shared.
      const sorted = [...hit.articles].sort((a, b) => a.length - b.length);
      subjectOf.set(clip.id, { subject: sorted[0], alternates: sorted.slice(1), source: 'sfxline' });
    } else {
      undocumented.push(clip);
    }
  }

  // Tier 2 for the rest.
  const guesses = new Map<string, string>();
  for (const clip of undocumented) {
    const g = guessSubject(clip.displayFile);
    if (g) guesses.set(clip.id, g);
  }
  const verified = await verifyTitles([...guesses.values()], onProgress, signal);
  for (const [clipId, guess] of guesses) {
    const target = verified.get(guess);
    if (target) subjectOf.set(clipId, { subject: target, alternates: [], source: 'filename' });
  }

  // Tier 3: subject -> artwork.
  const artwork = await resolveArtwork(
    [...subjectOf.values()].map((v) => v.subject),
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
      confidence: info.source === 'sfxline' ? 'high' : 'medium',
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

  return { sprites, downloads, soundMeta };
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
