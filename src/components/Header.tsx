import type { RefObject } from 'react';
import {
  DURATION_FILTERS,
  type DurationFilter,
  type Settings,
} from '../types';
import { formatCount } from '../lib/format';

export type Tab = 'board' | 'library';

type Props = {
  tab: Tab;
  onTab: (t: Tab) => void;
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement>;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  durationFilter: DurationFilter;
  onDurationFilter: (f: DurationFilter) => void;
  favoritesOnly: boolean;
  onFavoritesOnly: (v: boolean) => void;
  counts: { board: number; library: number };
  onOpenSetup: () => void;
  voices: number;
};

export function Header({
  tab,
  onTab,
  query,
  onQuery,
  searchRef,
  settings,
  onSettings,
  durationFilter,
  onDurationFilter,
  favoritesOnly,
  onFavoritesOnly,
  counts,
  onOpenSetup,
  voices,
}: Props) {
  return (
    <header className="header">
      <div className="header-top">
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'board'}
            className={tab === 'board' ? 'tab active' : 'tab'}
            onClick={() => onTab('board')}
          >
            Soundboard <span className="tab-count">{formatCount(counts.board)}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'library'}
            className={tab === 'library' ? 'tab active' : 'tab'}
            onClick={() => onTab('library')}
          >
            Library <span className="tab-count">{formatCount(counts.library)}</span>
          </button>
        </div>

        <div className="search-wrap">
          <input
            ref={searchRef}
            className="search"
            type="search"
            value={query}
            placeholder="Search sounds…    /  or Ctrl+F"
            onChange={(e) => onQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button className="search-clear" onClick={() => onQuery('')} title="Clear (Esc)">
              ×
            </button>
          )}
        </div>

        <div className="header-right">
          <label className="vol" title="Master volume">
            <span className="vol-label">Vol</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={settings.masterVolume}
              onChange={(e) => onSettings({ masterVolume: Number(e.target.value) })}
            />
          </label>
          <span className={voices > 0 ? 'voices live' : 'voices'} title="Voices playing — Esc stops everything">
            {voices}
          </span>
          <button className="ghost small" onClick={onOpenSetup} title="Fetch new files from the wiki">
            Update
          </button>
        </div>
      </div>

      <div className="header-filters">
        <Toggle
          label="Current only"
          title="Hide 8-bit reworks, v1/v2 revisions and dated re-renders"
          checked={settings.currentOnly}
          onChange={(v) => onSettings({ currentOnly: v })}
        />
        {tab === 'board' && (
          <Toggle
            label="SFX only"
            title="Drop short jingles back out of the pad grid"
            checked={settings.sfxOnly}
            onChange={(v) => onSettings({ sfxOnly: v })}
          />
        )}
        <Toggle label="Favourites" checked={favoritesOnly} onChange={onFavoritesOnly} />

        <select
          className="select"
          value={durationFilter}
          onChange={(e) => onDurationFilter(e.target.value as DurationFilter)}
        >
          {DURATION_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>

        {tab === 'board' && (
          <Toggle
            label="Drag from pad"
            title="Drag a file out from anywhere on a pad, not just the grab handle"
            checked={settings.gestureDrag}
            onChange={(v) => onSettings({ gestureDrag: v })}
          />
        )}

        <Toggle
          label="Search all tabs"
          title="Match across both tabs instead of just this one"
          checked={settings.searchAll}
          onChange={(v) => onSettings({ searchAll: v })}
        />

        {tab === 'board' && (
          <label className="vol pad-size" title="Pad size">
            <span className="vol-label">Size</span>
            <input
              type="range"
              min={78}
              max={190}
              step={2}
              value={settings.padSize}
              onChange={(e) => onSettings({ padSize: Number(e.target.value) })}
            />
          </label>
        )}
      </div>
    </header>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <button
      className={checked ? 'chip on' : 'chip'}
      onClick={() => onChange(!checked)}
      title={title}
      aria-pressed={checked}
    >
      {label}
    </button>
  );
}
