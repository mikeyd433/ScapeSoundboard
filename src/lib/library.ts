import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { join, sep } from '@tauri-apps/api/path';
import { exists, mkdir, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';

import { KINDS, MANIFEST_VERSION, type Clip, type Kind, type Manifest } from '../types';
import { extensionOf, listCategory, parseName, slugify, type RawFile } from './wiki';

const MANIFEST_FILE = 'manifest.json';

/** Jingles at or under this default land on the soundboard as well (spec §4). */
export const DEFAULT_JINGLE_MAX = 8;

let cachedRoot: string | null = null;
export async function libraryRoot(): Promise<string> {
  if (!cachedRoot) cachedRoot = await invoke<string>('library_root');
  return cachedRoot;
}

/* --------------------------------------------------------------- build ---- */

export type BuildProgress = (info: { kind: Kind; batch: number; count: number }) => void;

function toClip(raw: RawFile, kind: Kind): Clip {
  const parsed = parseName(raw.title);
  const displayFile = raw.title.replace(/^File:/, '');
  // Sha1-prefixed so two wiki files with the same pretty name cannot collide on
  // disk, and slugified so Windows' 260-char path limit stays out of reach.
  const id = `${raw.sha1.slice(0, 8)}-${slugify(displayFile)}.${extensionOf(displayFile, raw.mime)}`;

  return {
    id,
    title: parsed.base,
    context: parsed.context,
    variant: parsed.variants.length ? parsed.variants.join(' ') : null,
    isCurrent: parsed.isCurrent,
    kind,
    // Filled in by planDownload — everything starts remote-only.
    file: null,
    remoteUrl: raw.url,
    displayFile,
    bytes: raw.size,
    duration: raw.duration,
    sha1: raw.sha1,
    soundId: null,
    configName: null,
  };
}

export function groupKey(c: Clip): string {
  return `${c.kind}|${c.title.toLowerCase()}|${(c.context ?? '').toLowerCase()}`;
}

function buildGroups(clips: Clip[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const c of clips) (groups[groupKey(c)] ??= []).push(c.id);
  // A group of one is just a clip; chips only make sense with alternatives.
  for (const k of Object.keys(groups)) if (groups[k].length < 2) delete groups[k];
  return groups;
}

/** Fetch every category and turn it into a manifest. Nothing is downloaded here. */
export async function buildManifest(
  onProgress?: BuildProgress,
  signal?: AbortSignal,
): Promise<Manifest> {
  const clips: Clip[] = [];
  const seen = new Set<string>();

  for (const kind of KINDS) {
    const raws = await listCategory(kind, onProgress, signal);
    for (const raw of raws) {
      const clip = toClip(raw, kind);
      // Duplicate titles across categories exist; sha1+slug is the real key.
      if (seen.has(clip.id)) continue;
      seen.add(clip.id);
      clips.push(clip);
    }
  }

  clips.sort((a, b) => a.title.localeCompare(b.title) || a.displayFile.localeCompare(b.displayFile));

  return {
    generatedAt: new Date().toISOString(),
    version: MANIFEST_VERSION,
    clips,
    groups: buildGroups(clips),
  };
}

/* ------------------------------------------------------------ download ---- */

export type DownloadScope = 'sfx' | 'sfx+jingles';

export type DownloadItem = { id: string; url: string; dest: string; bytes: number };

export type DownloadPlan = {
  items: DownloadItem[];
  bytes: number;
  /** True when the wiki gave us no durations, so we cannot pre-filter jingles
   *  by length and have to take the lot. Worth saying out loud in the UI. */
  jingleDurationsUnknown: boolean;
};

function destFor(clip: Clip): string {
  // The id already carries the extension, so it doubles as the on-disk name.
  return `audio/${clip.kind}/${clip.id}`;
}

/**
 * Decide what lands on disk. Music streams from the wiki — 7 GB is not a
 * first-run experience — so only pad content is fetched.
 */
export function planDownload(
  manifest: Manifest,
  scope: DownloadScope,
  jingleMaxSeconds = DEFAULT_JINGLE_MAX,
): DownloadPlan {
  const jingles = manifest.clips.filter((c) => c.kind === 'jingle');
  const jingleDurationsUnknown = jingles.length > 0 && jingles.every((c) => c.duration == null);

  const wanted = manifest.clips.filter((c) => {
    if (c.kind === 'sfx') return true;
    if (c.kind !== 'jingle' || scope === 'sfx') return false;
    // Unknown duration means we cannot judge; take it and measure locally.
    return c.duration == null || c.duration <= jingleMaxSeconds;
  });

  const items = wanted.map((c) => ({
    id: c.id,
    url: c.remoteUrl,
    dest: destFor(c),
    bytes: c.bytes,
  }));

  return {
    items,
    bytes: items.reduce((n, i) => n + i.bytes, 0),
    jingleDurationsUnknown,
  };
}

/** Record on the manifest which clips we intend to keep locally. */
export function applyPlan(manifest: Manifest, plan: DownloadPlan): Manifest {
  const byId = new Map(plan.items.map((i) => [i.id, i.dest]));
  return {
    ...manifest,
    clips: manifest.clips.map((c) => (byId.has(c.id) ? { ...c, file: byId.get(c.id)! } : c)),
  };
}

/* ------------------------------------------------------------- persist ---- */

export async function saveManifest(manifest: Manifest): Promise<void> {
  const root = await libraryRoot();
  if (!(await exists(root))) await mkdir(root, { recursive: true });
  // Written last in the setup flow, so its presence means "library is usable".
  await writeTextFile(await join(root, MANIFEST_FILE), JSON.stringify(manifest));
}

export async function loadManifest(): Promise<Manifest | null> {
  try {
    const root = await libraryRoot();
    const path = await join(root, MANIFEST_FILE);
    if (!(await exists(path))) return null;
    const parsed = JSON.parse(await readTextFile(path)) as Manifest;
    if (parsed.version !== MANIFEST_VERSION) return null;
    if (!Array.isArray(parsed.clips) || parsed.clips.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- paths ---- */

/**
 * Which local files are actually present. One directory listing per kind beats
 * an `exists()` round trip per clip, and it catches a library the user pruned
 * by hand.
 */
export async function scanLocalFiles(): Promise<Set<string>> {
  const root = await libraryRoot();
  const present = new Set<string>();
  for (const kind of KINDS) {
    const dir = `audio/${kind}`;
    try {
      const full = await join(root, dir);
      if (!(await exists(full))) continue;
      for (const entry of await readDir(full)) {
        if (entry.isFile) present.add(`${dir}/${entry.name}`);
      }
    } catch {
      // A missing or unreadable category directory just means nothing local.
    }
  }
  return present;
}

export type UrlResolver = (clip: Clip) => string;

/**
 * Builds a synchronous clip -> URL function.
 *
 * `join` is an IPC round trip, and a pad press must not wait on one — latency
 * is the entire point of a soundboard. So resolve the root and the platform
 * separator once, then it is string concatenation forever after.
 */
export async function makeResolver(present: Set<string>): Promise<UrlResolver> {
  const root = await libraryRoot();
  const s = sep();
  const base = root.endsWith(s) ? root.slice(0, -s.length) : root;

  return (clip: Clip) => {
    if (clip.file && present.has(clip.file)) {
      return convertFileSrc(`${base}${s}${clip.file.split('/').join(s)}`);
    }
    // Not on disk: stream it from the wiki.
    return clip.remoteUrl;
  };
}

export function isLocal(clip: Clip, present: Set<string>): boolean {
  return !!clip.file && present.has(clip.file);
}
