import { load, type Store } from '@tauri-apps/plugin-store';
import type { Board } from './boards';
import { DEFAULT_SETTINGS, type PadSetting, type Settings } from '../types';

const FILE = 'settings.json';
const RECENT_LIMIT = 50;

let storePromise: Promise<Store> | null = null;
function store(): Promise<Store> {
  storePromise ??= load(FILE, { autoSave: 300 });
  return storePromise;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const s = await store();
    const saved = await s.get<Partial<Settings>>('settings');
    // Merge rather than replace, so a new setting gets its default instead of
    // undefined when the user has an older settings file.
    return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  try {
    (await store()).set('settings', settings);
  } catch {
    // Settings are a convenience; losing them must never break playback.
  }
}

export async function loadFavorites(): Promise<Set<string>> {
  try {
    const ids = await (await store()).get<string[]>('favorites');
    return new Set(ids ?? []);
  } catch {
    return new Set();
  }
}

export async function saveFavorites(favorites: Set<string>): Promise<void> {
  try {
    (await store()).set('favorites', [...favorites]);
  } catch {
    /* ignore */
  }
}

export async function loadPads(): Promise<Record<string, PadSetting>> {
  try {
    return (await (await store()).get<Record<string, PadSetting>>('pads')) ?? {};
  } catch {
    return {};
  }
}

export async function savePads(pads: Record<string, PadSetting>): Promise<void> {
  try {
    (await store()).set('pads', pads);
  } catch {
    /* ignore */
  }
}

/** Group key -> chosen clip id, so a pad can play the 8-bit take instead. */
export async function loadVariantChoices(): Promise<Record<string, string>> {
  try {
    return (await (await store()).get<Record<string, string>>('variants')) ?? {};
  } catch {
    return {};
  }
}

export async function saveVariantChoices(choices: Record<string, string>): Promise<void> {
  try {
    (await store()).set('variants', choices);
  } catch {
    /* ignore */
  }
}

export type BoardsState = { boards: Board[]; activeId: string | null };

export async function loadBoards(): Promise<BoardsState> {
  try {
    const saved = await (await store()).get<BoardsState>('boards');
    if (!saved || !Array.isArray(saved.boards)) return { boards: [], activeId: null };
    return saved;
  } catch {
    return { boards: [], activeId: null };
  }
}

export async function saveBoards(state: BoardsState): Promise<void> {
  try {
    (await store()).set('boards', state);
  } catch {
    /* ignore */
  }
}

export async function loadRecent(): Promise<string[]> {
  try {
    return (await (await store()).get<string[]>('recent')) ?? [];
  } catch {
    return [];
  }
}

export async function pushRecent(id: string): Promise<string[]> {
  const current = await loadRecent();
  const next = [id, ...current.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
  try {
    (await store()).set('recent', next);
  } catch {
    /* ignore */
  }
  return next;
}
