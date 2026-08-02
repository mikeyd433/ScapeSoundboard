import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { invoke } from '@tauri-apps/api/core';

import type { Clip, SpriteInfo } from '../types';

/**
 * Drag-out to other applications (spec §8).
 *
 * A browser can offer a download URL at best; a real file the OS understands is
 * the whole reason this is a desktop app. Files are staged into `dragcache/`
 * under their pretty names first, because nobody wants
 * `a7f3c2-abyssal-whip-special-attack.ogg` landing on their REAPER timeline.
 */

type DragPayload = { files: (string | null)[]; icon: string };

export type DragOutcome = 'started' | 'unavailable';

/**
 * Only clips that live on disk can be handed to another app. Music streams
 * from the wiki, so it has nothing to give until it has been downloaded.
 */
export function isDraggable(clip: Clip, present: Set<string>): boolean {
  return !!clip.file && present.has(clip.file);
}

async function stage(clips: Clip[], sprite: SpriteInfo | null): Promise<DragPayload | null> {
  const items = clips
    .filter((c) => !!c.file)
    .map((c) => ({ src: c.file!, name: c.displayFile }));
  if (!items.length) return null;

  return invoke<DragPayload>('stage_drag_files', {
    items,
    icon: sprite?.file ?? null,
  });
}

/**
 * Warm the staging directory ahead of the gesture. Hard links cost nothing, so
 * hovering a grab handle is enough to make the drag itself instant.
 */
export async function prewarm(clips: Clip[], sprite: SpriteInfo | null = null): Promise<void> {
  try {
    await stage(clips, sprite);
  } catch {
    // Staging is an optimisation here; beginDrag will retry for real.
  }
}

export async function beginDrag(
  clips: Clip[],
  sprite: SpriteInfo | null,
  onFinished?: () => void,
): Promise<DragOutcome> {
  let payload: DragPayload | null = null;
  try {
    payload = await stage(clips, sprite);
  } catch {
    return 'unavailable';
  }

  const files = payload?.files.filter((f): f is string => !!f) ?? [];
  if (!files.length) return 'unavailable';

  // Deliberately not awaited: on Windows startDrag blocks until the drop
  // completes, and this runs from a pointer handler that must return at once.
  void startDrag({ item: files, icon: payload!.icon }, () => onFinished?.()).catch(() =>
    onFinished?.(),
  );

  return 'started';
}

/**
 * Swept at startup, never after a drop — there is no reliable signal for when
 * the receiving application has finished reading the file.
 */
export async function sweepDragCache(): Promise<void> {
  try {
    await invoke<number>('sweep_dragcache');
  } catch {
    // A stale cache is harmless; it just uses a little disk.
  }
}
