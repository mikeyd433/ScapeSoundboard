import { fetch } from '@tauri-apps/plugin-http';
import type { Kind } from '../types';

const API = 'https://oldschool.runescape.wiki/api.php';

/** Weird Gloop 403s generic user agents (spec §2). Identify the project. */
const UA = 'osrs-soundboard/0.1 (https://github.com/mikeyd433/ScapeSoundboard)';

export const CATS: Record<Kind, string> = {
  sfx: 'Category:Sound effect files',
  jingle: 'Category:Jingle files',
  music: 'Category:Music track files',
  soundbank: 'Category:Soundbank files',
};

export type RawFile = {
  title: string;
  url: string;
  size: number;
  mime: string;
  sha1: string;
  /** MediaWiki returns this alongside `size` for media it can handle. It is
   *  absent on wikis without TimedMediaHandler, hence the local probe pass. */
  duration: number | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ListProgress = (info: { kind: Kind; batch: number; count: number }) => void;

/**
 * Page through a category with the MediaWiki API. Serial by design — the
 * etiquette that keeps us unblocked matters more than the two minutes saved.
 */
export async function listCategory(
  kind: Kind,
  onProgress?: ListProgress,
  signal?: AbortSignal,
): Promise<RawFile[]> {
  const out: RawFile[] = [];
  let cont: string | null = null;
  let batch = 0;

  do {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const p = new URLSearchParams({
      action: 'query',
      generator: 'categorymembers',
      gcmtitle: CATS[kind],
      gcmtype: 'file',
      gcmlimit: '500', // anon max
      prop: 'imageinfo',
      iiprop: 'url|size|mime|sha1',
      format: 'json',
      formatversion: '2',
    });
    if (cont) p.set('gcmcontinue', cont);

    const res = await fetch(`${API}?${p}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Wiki API returned HTTP ${res.status} for ${CATS[kind]}`);
    const j = (await res.json()) as WikiResponse;

    for (const page of j.query?.pages ?? []) {
      const ii = page.imageinfo?.[0];
      if (!ii?.url || !ii.sha1) continue;
      out.push({
        title: page.title,
        url: ii.url,
        size: ii.size ?? 0,
        mime: ii.mime ?? '',
        sha1: ii.sha1,
        duration: typeof ii.duration === 'number' && ii.duration > 0 ? ii.duration : null,
      });
    }

    batch += 1;
    onProgress?.({ kind, batch, count: out.length });
    cont = j.continue?.gcmcontinue ?? null;
    if (cont) await sleep(200);
  } while (cont);

  return out;
}

type WikiResponse = {
  query?: {
    pages?: {
      title: string;
      imageinfo?: {
        url?: string;
        size?: number;
        mime?: string;
        sha1?: string;
        duration?: number;
      }[];
    }[];
  };
  continue?: { gcmcontinue?: string };
};

/**
 * Variant tokens must be a whitelist, not a rule: "(Dragon Slayer)" is context
 * worth keeping and "(Fossil Island)" is a variant to strip, and the two are
 * structurally identical (spec §1).
 */
const VARIANT = /^(8-bit|v\d+|\d{4} Version|Fossil Island|Alternate|Unused)$/i;

export type ParsedName = {
  base: string;
  context: string | null;
  variants: string[];
  isCurrent: boolean;
};

export function parseName(title: string): ParsedName {
  let name = title.replace(/^File:/, '').replace(/\.(ogg|wav|mp3|flac)$/i, '');
  const variants: string[] = [];
  let m: RegExpMatchArray | null;

  // Peel trailing parentheticals right-to-left; stop at the first non-variant.
  while ((m = name.match(/\s*\(([^()]*)\)$/))) {
    if (!VARIANT.test(m[1])) break;
    variants.unshift(m[1]);
    name = name.slice(0, m.index!);
  }

  const ctx = name.match(/\s*\(([^()]*)\)$/);
  return {
    base: (ctx ? name.slice(0, ctx.index!) : name).trim(),
    context: ctx?.[1] ?? null,
    variants,
    isCurrent: variants.length === 0,
  };
}

/** Filenames carry `'`, `!`, `&`, `,` and `…`. Slugify for disk, keep the
 *  pretty name for display (spec §10). */
export function slugify(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'clip'
  );
}

export function extensionOf(title: string, mime: string): string {
  const m = title.match(/\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg')) return 'mp3';
  return 'ogg';
}
