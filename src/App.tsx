import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BoardBar, BoardGrid } from './components/Boards';
import { Header, type Tab } from './components/Header';
import { Library } from './components/Library';
import type { PadEnv } from './components/PadEnv';
import { IconPicker } from './components/IconPicker';
import { Setup } from './components/Setup';
import { Soundboard } from './components/Soundboard';
import { Transport } from './components/Transport';

import { engine, type TransportState } from './lib/audio';
import { runDownload } from './lib/download';
import { beginDrag, isDraggable, prewarm, sweepDragCache } from './lib/drag';
import {
  addToBoard,
  makeBoard,
  slotForKey,
  type Board,
} from './lib/boards';
import { formatCount } from './lib/format';
import {
  groupKey,
  isLocal,
  loadManifest,
  loadOverrides,
  makeResolver,
  saveOverrides,
  scanLocalFiles,
  type UrlResolver,
} from './lib/library';
import { buildIndex, parseQuery, searchIndex } from './lib/search';
import {
  loadBoards,
  loadFavorites,
  loadPads,
  loadSettings,
  loadVariantChoices,
  pushRecent,
  saveBoards,
  saveFavorites,
  savePads,
  saveSettings,
  saveVariantChoices,
} from './lib/store';
import {
  DEFAULT_PAD,
  DEFAULT_SETTINGS,
  matchesDuration,
  type Clip,
  type DurationFilter,
  type Manifest,
  type PadSetting,
  type Settings,
  type SpriteInfo,
} from './types';

const SEARCH_DEBOUNCE_MS = 120;

/** Board keys are bare letters and digits, so never steal them from a field. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  );
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [present, setPresent] = useState<Set<string>>(() => new Set());
  const [resolve, setResolve] = useState<UrlResolver | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const [pads, setPads] = useState<Record<string, PadSetting>>({});
  const [variantChoices, setVariantChoices] = useState<Record<string, string>>({});

  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  /** null means the browse-everything grid rather than a saved board. */
  const [boardView, setBoardView] = useState<string | null>(null);
  const [editingBoard, setEditingBoard] = useState(false);

  const [tab, setTab] = useState<Tab>('board');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [durationFilter, setDurationFilter] = useState<DurationFilter>('any');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const [extraDurations, setExtraDurations] = useState<Record<string, number>>({});
  const [overrides, setOverrides] = useState<Record<string, SpriteInfo>>({});
  const [iconFor, setIconFor] = useState<Clip | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [transport, setTransport] = useState<TransportState>(() => engine.getTransport());
  const [nowPlaying, setNowPlaying] = useState<Clip | null>(null);
  const [shuffle, setShuffle] = useState(false);
  const [voices, setVoices] = useState(0);

  const searchRef = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);

  /* ---------------------------------------------------------------- boot ---- */

  const attach = useCallback(async (m: Manifest) => {
    const [found, saved] = await Promise.all([scanLocalFiles(), loadOverrides()]);
    const r = await makeResolver(found);
    setPresent(found);
    setResolve(() => r);
    setOverrides(saved);
    setManifest(m);
  }, []);

  useEffect(() => {
    void (async () => {
      const [s, f, p, v, b] = await Promise.all([
        loadSettings(),
        loadFavorites(),
        loadPads(),
        loadVariantChoices(),
        loadBoards(),
      ]);
      setSettings(s);
      setFavorites(f);
      setPads(p);
      setVariantChoices(v);
      setBoards(b.boards);
      setActiveBoardId(b.activeId ?? b.boards[0]?.id ?? null);
      engine.setMasterVolume(s.masterVolume);
      engine.setSfxVolume(s.sfxVolume);
      engine.setMusicVolume(s.musicVolume);

      // Stale staging files from the last session, cleared before anything can
      // hand one to another app (spec §8: sweep on startup, not on drop).
      void sweepDragCache();

      const m = await loadManifest();
      if (m) await attach(m);
      else setShowSetup(true);

      loaded.current = true;
      setBooting(false);
    })();
  }, [attach]);

  /* ---------------------------------------------------------- persistence ---- */

  useEffect(() => {
    if (loaded.current) void saveSettings(settings);
    engine.setMasterVolume(settings.masterVolume);
    engine.setSfxVolume(settings.sfxVolume);
    engine.setMusicVolume(settings.musicVolume);
  }, [settings]);

  useEffect(() => {
    if (loaded.current) void saveFavorites(favorites);
  }, [favorites]);

  useEffect(() => {
    if (loaded.current) void savePads(pads);
  }, [pads]);

  useEffect(() => {
    if (loaded.current) void saveVariantChoices(variantChoices);
  }, [variantChoices]);

  useEffect(() => {
    if (loaded.current) void saveBoards({ boards, activeId: activeBoardId });
  }, [boards, activeBoardId]);

  /* -------------------------------------------------------------- engine ---- */

  useEffect(() => engine.subscribeTransport(setTransport), []);

  useEffect(() => {
    const id = window.setInterval(() => setVoices(engine.voiceCount), 200);
    return () => window.clearInterval(id);
  }, []);

  // The SFX set is small enough to hold decoded, but an AudioContext needs a
  // user gesture — so warm the cache on whatever the first interaction is.
  useEffect(() => {
    if (!manifest || !resolve) return;
    const ac = new AbortController();
    let started = false;
    const onFirst = () => {
      if (started) return;
      started = true;
      engine.ensure();
      const sfx = manifest.clips.filter((c) => c.kind === 'sfx' && isLocal(c, present));
      void engine.warm(
        sfx.map((c) => ({ id: c.id, url: resolve(c) })),
        ac.signal,
      );
    };
    window.addEventListener('pointerdown', onFirst);
    window.addEventListener('keydown', onFirst);
    return () => {
      ac.abort();
      window.removeEventListener('pointerdown', onFirst);
      window.removeEventListener('keydown', onFirst);
    };
  }, [manifest, resolve, present]);

  /* --------------------------------------------------------------- data ---- */

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const byId = useMemo(
    () => new Map((manifest?.clips ?? []).map((c) => [c.id, c])),
    [manifest],
  );
  const index = useMemo(() => buildIndex(manifest?.clips ?? []), [manifest]);
  const groups = manifest?.groups ?? {};

  const durationOf = useCallback(
    (c: Clip): number | null => c.duration ?? extraDurations[c.id] ?? null,
    [extraDurations],
  );

  const parsed = useMemo(() => parseQuery(debounced), [debounced]);
  const hasQuery = parsed.terms.length > 0 || parsed.cats.length > 0;

  /** Clip id -> rank. null when nothing is being searched for. */
  const ranks = useMemo(() => {
    if (!hasQuery) return null;
    const hits = searchIndex(index, parsed);
    return new Map(hits.map((c, i) => [c.id, i]));
  }, [index, parsed, hasQuery]);

  const boardBase = useMemo(() => {
    if (!manifest) return [];
    return manifest.clips.filter((c) => {
      if (c.kind === 'sfx') return true;
      if (c.kind !== 'jingle' || settings.sfxOnly) return false;
      // Level-ups, quest completes, diary jingles — the short ones belong on a board.
      const d = durationOf(c);
      return d != null && d <= settings.jingleBoardMaxSeconds;
    });
  }, [manifest, settings.sfxOnly, settings.jingleBoardMaxSeconds, durationOf]);

  const libraryBase = useMemo(
    () => (manifest ? manifest.clips.filter((c) => c.kind !== 'sfx') : []),
    [manifest],
  );

  const refine = useCallback(
    (list: Clip[]) => {
      let out = list.filter(
        (c) =>
          (!settings.currentOnly || c.isCurrent) &&
          (!favoritesOnly || favorites.has(c.id)) &&
          matchesDuration(durationOf(c), durationFilter),
      );
      if (ranks) {
        out = out
          .filter((c) => ranks.has(c.id))
          .sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
      }
      return out;
    },
    [settings.currentOnly, favoritesOnly, favorites, durationFilter, durationOf, ranks],
  );

  const boardClips = useMemo(() => refine(boardBase), [refine, boardBase]);
  const libraryClips = useMemo(() => refine(libraryBase), [refine, libraryBase]);

  /* ------------------------------------------------------------ playback ---- */

  const corsSamples = useMemo(() => {
    if (!manifest || !resolve) return {};
    const remote = manifest.clips.find((c) => !isLocal(c, present));
    const local = manifest.clips.find((c) => isLocal(c, present));
    return { remote: remote?.remoteUrl, local: local ? resolve(local) : undefined };
  }, [manifest, resolve, present]);

  const playTrack = useCallback(
    (clip: Clip) => {
      if (!resolve) return;
      engine.ensure();
      setNowPlaying(clip);
      void pushRecent(clip.id);
      void engine.playMusic(clip.id, resolve(clip), corsSamples);
    },
    [resolve, corsSamples],
  );

  const step = useCallback(
    (delta: number) => {
      if (!libraryClips.length) return;
      if (shuffle) {
        playTrack(libraryClips[Math.floor(Math.random() * libraryClips.length)]);
        return;
      }
      const i = nowPlaying ? libraryClips.findIndex((c) => c.id === nowPlaying.id) : -1;
      const next = (i + delta + libraryClips.length) % libraryClips.length;
      playTrack(libraryClips[next]);
    },
    [libraryClips, nowPlaying, shuffle, playTrack],
  );

  useEffect(() => engine.onEnded(() => step(1)), [step]);

  /* ------------------------------------------------------------ keyboard ---- */

  useEffect(() => {
    const typing = isTyping;

    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        const board = boards[Number(e.key) - 1];
        if (board) {
          e.preventDefault();
          setBoardView(board.id);
          setActiveBoardId(board.id);
          setTab('board');
        }
        return;
      }
      if (e.key === '/' && !typing(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        // Esc has two jobs in the spec. Clearing a live search wins; otherwise
        // it is the panic key, which is the more important of the two.
        const searchActive = document.activeElement === searchRef.current || query.length > 0;
        if (searchActive) {
          setQuery('');
          searchRef.current?.blur();
        } else {
          engine.panic();
        }
        return;
      }
      if (e.key === ' ' && !typing(e.target) && nowPlaying) {
        e.preventDefault();
        void engine.toggleMusic();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [query, nowPlaying, boards]);

  /* -------------------------------------------------------------- render ---- */

  const patchSettings = useCallback(
    (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((f) => {
      const next = new Set(f);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setVariant = useCallback((group: string, clipId: string) => {
    setVariantChoices((v) => ({ ...v, [group]: clipId }));
  }, []);

  const noteDuration = useCallback(
    (id: string, seconds: number) => setExtraDurations((d) => (d[id] ? d : { ...d, [id]: seconds })),
    [],
  );

  /* -------------------------------------------------------------- boards ---- */

  const activeBoard = useMemo(
    () => boards.find((b) => b.id === boardView) ?? null,
    [boards, boardView],
  );

  const createBoard = useCallback(() => {
    const board = makeBoard(`Board ${boards.length + 1}`);
    setBoards((list) => [...list, board]);
    setActiveBoardId(board.id);
    setBoardView(board.id);
    setEditingBoard(false);
  }, [boards.length]);

  const updateBoard = useCallback((board: Board) => {
    setBoards((list) => list.map((b) => (b.id === board.id ? board : b)));
  }, []);

  const deleteBoard = useCallback((id: string) => {
    setBoards((list) => list.filter((b) => b.id !== id));
    setBoardView((v) => (v === id ? null : v));
    setActiveBoardId((a) => (a === id ? null : a));
    setEditingBoard(false);
  }, []);

  const addClipToBoard = useCallback((boardId: string, clipId: string) => {
    setBoards((list) =>
      list.map((b) => (b.id === boardId ? addToBoard(b, clipId) ?? b : b)),
    );
  }, []);

  /** Slots 1–16 fire from the number and QWERTY rows while a board is open. */
  useEffect(() => {
    if (!activeBoard || editingBoard || !resolve) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const slot = slotForKey(e.key);
      if (slot < 0) return;
      const id = activeBoard.slots[slot];
      const clip = id ? byId.get(id) : null;
      if (!clip) return;
      e.preventDefault();
      const s = pads[clip.id] ?? DEFAULT_PAD;
      void engine.playSfx(clip.id, resolve(clip), { gain: s.gain, rate: s.rate });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeBoard, editingBoard, resolve, byId, pads]);

  /* -------------------------------------------------------------- sprites ---- */

  /** Prefer the local copy; fall back to the wiki thumbnail until it lands. */
  const spriteUrlFor = useCallback(
    (clip: Clip): string | null => {
      const sprite = overrides[clip.id] ?? clip.sprite;
      if (!sprite) return null;
      return present.has(sprite.file) ? resolve?.path(sprite.file) ?? sprite.url : sprite.url;
    },
    [overrides, present, resolve],
  );

  const applyIcon = useCallback(
    async (clip: Clip, sprite: SpriteInfo) => {
      const next = { ...overrides, [clip.id]: sprite };
      setOverrides(next);
      setIconFor(null);
      void saveOverrides(next);
      try {
        await runDownload([{ id: sprite.file, url: sprite.url, dest: sprite.file, bytes: 0 }], () => {});
        // Re-scan so the pad switches from the remote thumbnail to the local file.
        setPresent(await scanLocalFiles());
      } catch {
        // The remote thumbnail keeps working; only the offline copy is missing.
      }
    },
    [overrides],
  );

  /* ------------------------------------------------------------ drag-out ---- */

  const canDrag = useCallback((clip: Clip) => isDraggable(clip, present), [present]);

  /** Dragging a selected pad takes the whole selection with it. */
  const dragSet = useCallback(
    (clip: Clip): Clip[] => {
      if (selection.has(clip.id) && selection.size > 1) {
        return [...selection].map((id) => byId.get(id)).filter((c): c is Clip => !!c);
      }
      return [clip];
    },
    [selection, byId],
  );

  const onGrab = useCallback(
    (clip: Clip) => {
      const clips = dragSet(clip).filter((c) => canDrag(c));
      if (!clips.length) return;
      void beginDrag(clips, overrides[clip.id] ?? clip.sprite);
    },
    [dragSet, canDrag, overrides],
  );

  const onGrabHover = useCallback(
    (clip: Clip) => {
      const clips = dragSet(clip).filter((c) => canDrag(c));
      if (clips.length) void prewarm(clips);
    },
    [dragSet, canDrag],
  );

  const onSelect = useCallback((clipId: string) => {
    setSelection((sel) => {
      const next = new Set(sel);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return next;
    });
  }, []);

  const env: PadEnv | null = useMemo(() => {
    if (!resolve) return null;
    const pick = (clip: Clip) => {
      const chosen = variantChoices[groupKey(clip)];
      return chosen && chosen !== clip.id ? byId.get(chosen) ?? clip : clip;
    };
    return {
      resolve,
      lookup: (id) => byId.get(id) ?? null,
      effective: pick,
      groupOf: groupKey,
      variantsOf: (clip) =>
        (groups[groupKey(clip)] ?? []).map((id) => byId.get(id)).filter((c): c is Clip => !!c),
      pads,
      onPad: (id, s) => setPads((p) => ({ ...p, [id]: s })),
      onVariant: setVariant,
      favorites,
      onFavorite: toggleFavorite,
      boards,
      onAddToBoard: addClipToBoard,
      spriteUrlFor,
      onChangeIcon: setIconFor,
      selection,
      onSelect,
      onGrab,
      onGrabHover,
      gestureDrag: settings.gestureDrag,
      canDrag,
    };
  }, [
    resolve,
    byId,
    groups,
    variantChoices,
    pads,
    favorites,
    boards,
    setVariant,
    toggleFavorite,
    addClipToBoard,
    spriteUrlFor,
    selection,
    onSelect,
    onGrab,
    onGrabHover,
    settings.gestureDrag,
    canDrag,
  ]);

  if (booting) {
    return <div className="boot">Loading library…</div>;
  }

  if (showSetup || !manifest || !resolve || !env) {
    return (
      <Setup
        existing={manifest}
        onDismiss={manifest ? () => setShowSetup(false) : undefined}
        onReady={(m) => {
          void attach(m).then(() => setShowSetup(false));
        }}
      />
    );
  }

  const otherCount = tab === 'board' ? libraryClips.length : boardClips.length;

  return (
    <div className="app">
      <Header
        tab={tab}
        onTab={setTab}
        query={query}
        onQuery={setQuery}
        searchRef={searchRef}
        settings={settings}
        onSettings={patchSettings}
        durationFilter={durationFilter}
        onDurationFilter={setDurationFilter}
        favoritesOnly={favoritesOnly}
        onFavoritesOnly={setFavoritesOnly}
        counts={{ board: boardClips.length, library: libraryClips.length }}
        onOpenSetup={() => setShowSetup(true)}
        voices={voices}
      />

      {settings.searchAll && hasQuery && otherCount > 0 && (
        <button className="cross-tab" onClick={() => setTab(tab === 'board' ? 'library' : 'board')}>
          {formatCount(otherCount)} more {tab === 'board' ? 'in the Library' : 'on the Soundboard'} →
        </button>
      )}

      <main className="main">
        {tab === 'board' ? (
          <div className="board-pane">
            <BoardBar
              boards={boards}
              view={boardView}
              onView={(v) => {
                setBoardView(v);
                if (v) setActiveBoardId(v);
                setEditingBoard(false);
              }}
              onCreate={createBoard}
              onUpdate={updateBoard}
              onDelete={deleteBoard}
              editing={editingBoard}
              onEditing={setEditingBoard}
            />
            {activeBoard ? (
              <BoardGrid
                board={activeBoard}
                padSize={settings.padSize}
                env={env}
                editing={editingBoard}
                onUpdate={updateBoard}
              />
            ) : (
              <Soundboard
                clips={boardClips}
                padSize={settings.padSize}
                env={env}
                emptyHint={
                  hasQuery
                    ? 'No pads match that search.'
                    : 'No pads to show — try turning off the filters above.'
                }
              />
            )}
          </div>
        ) : (
          <Library
            clips={libraryClips}
            resolve={resolve}
            groups={groups}
            byId={byId}
            variantChoices={variantChoices}
            onVariant={setVariant}
            favorites={favorites}
            onFavorite={toggleFavorite}
            nowPlaying={transport.clipId}
            onPlay={playTrack}
            spriteUrlFor={spriteUrlFor}
            canDrag={canDrag}
            onGrab={onGrab}
            onGrabHover={onGrabHover}
            durationOf={durationOf}
            onDuration={noteDuration}
            emptyHint={hasQuery ? 'Nothing in the library matches that.' : 'Nothing to show.'}
          />
        )}
      </main>

      {iconFor && (
        <IconPicker
          clip={iconFor}
          onPick={(sprite) => void applyIcon(iconFor, sprite)}
          onClose={() => setIconFor(null)}
        />
      )}

      <Transport
        clip={nowPlaying}
        state={transport}
        onToggle={() => void engine.toggleMusic()}
        onSeek={(s) => engine.seek(s)}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onLoop={(v) => engine.setLoop(v)}
        shuffle={shuffle}
        onShuffle={setShuffle}
        musicVolume={settings.musicVolume}
        onMusicVolume={(v) => patchSettings({ musicVolume: v })}
      />
    </div>
  );
}
