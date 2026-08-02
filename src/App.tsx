import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Header, type Tab } from './components/Header';
import { Library } from './components/Library';
import { Setup } from './components/Setup';
import { Soundboard } from './components/Soundboard';
import { Transport } from './components/Transport';

import { engine, type TransportState } from './lib/audio';
import { formatCount } from './lib/format';
import {
  isLocal,
  loadManifest,
  makeResolver,
  scanLocalFiles,
  type UrlResolver,
} from './lib/library';
import { buildIndex, parseQuery, searchIndex } from './lib/search';
import {
  loadFavorites,
  loadPads,
  loadSettings,
  loadVariantChoices,
  pushRecent,
  saveFavorites,
  savePads,
  saveSettings,
  saveVariantChoices,
} from './lib/store';
import {
  DEFAULT_SETTINGS,
  matchesDuration,
  type Clip,
  type DurationFilter,
  type Manifest,
  type PadSetting,
  type Settings,
} from './types';

const SEARCH_DEBOUNCE_MS = 120;

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

  const [tab, setTab] = useState<Tab>('board');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [durationFilter, setDurationFilter] = useState<DurationFilter>('any');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const [extraDurations, setExtraDurations] = useState<Record<string, number>>({});
  const [transport, setTransport] = useState<TransportState>(() => engine.getTransport());
  const [nowPlaying, setNowPlaying] = useState<Clip | null>(null);
  const [shuffle, setShuffle] = useState(false);
  const [voices, setVoices] = useState(0);

  const searchRef = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);

  /* ---------------------------------------------------------------- boot ---- */

  const attach = useCallback(async (m: Manifest) => {
    const found = await scanLocalFiles();
    const r = await makeResolver(found);
    setPresent(found);
    setResolve(() => r);
    setManifest(m);
  }, []);

  useEffect(() => {
    void (async () => {
      const [s, f, p, v] = await Promise.all([
        loadSettings(),
        loadFavorites(),
        loadPads(),
        loadVariantChoices(),
      ]);
      setSettings(s);
      setFavorites(f);
      setPads(p);
      setVariantChoices(v);
      engine.setMasterVolume(s.masterVolume);
      engine.setSfxVolume(s.sfxVolume);
      engine.setMusicVolume(s.musicVolume);

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
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

    const onKey = (e: KeyboardEvent) => {
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
  }, [query, nowPlaying]);

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

  if (booting) {
    return <div className="boot">Loading library…</div>;
  }

  if (showSetup || !manifest || !resolve) {
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
          <Soundboard
            clips={boardClips}
            resolve={resolve}
            padSize={settings.padSize}
            pads={pads}
            onPad={(id, s) => setPads((p) => ({ ...p, [id]: s }))}
            groups={groups}
            byId={byId}
            variantChoices={variantChoices}
            onVariant={setVariant}
            favorites={favorites}
            onFavorite={toggleFavorite}
            emptyHint={
              hasQuery
                ? 'No pads match that search.'
                : 'No pads to show — try turning off the filters above.'
            }
          />
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
            durationOf={durationOf}
            onDuration={noteDuration}
            emptyHint={hasQuery ? 'Nothing in the library matches that.' : 'Nothing to show.'}
          />
        )}
      </main>

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
