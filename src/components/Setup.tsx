import { useCallback, useRef, useState } from 'react';

import type { Manifest } from '../types';
import { cancelDownload, runDownload, type DownloadProgress } from '../lib/download';
import { probeAll } from '../lib/duration';
import { buildSprites } from '../lib/sprites';
import { formatBytes, formatCount } from '../lib/format';
import {
  applyPlan,
  buildManifest,
  libraryRoot,
  makeResolver,
  planDownload,
  saveManifest,
  scanLocalFiles,
  type DownloadPlan,
  type DownloadScope,
} from '../lib/library';

type Stage = 'intro' | 'index' | 'choose' | 'download' | 'probe' | 'sprites' | 'error';

type Props = {
  onReady: (manifest: Manifest) => void;
  /** Present when the user re-runs setup to top up an existing library. */
  existing?: Manifest | null;
  onDismiss?: () => void;
};

export function Setup({ onReady, existing, onDismiss }: Props) {
  const [stage, setStage] = useState<Stage>('intro');
  const [manifest, setManifest] = useState<Manifest | null>(existing ?? null);
  const [indexInfo, setIndexInfo] = useState<{ kind: string; count: number } | null>(null);
  const [scope, setScope] = useState<DownloadScope>('sfx+jingles');
  const [plans, setPlans] = useState<Record<DownloadScope, DownloadPlan> | null>(null);
  const [dl, setDl] = useState<DownloadProgress | null>(null);
  const [probe, setProbe] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [root, setRoot] = useState<string>('');
  const [spriteInfo, setSpriteInfo] = useState<{ stage: string; done: number; total: number } | null>(
    null,
  );

  const abort = useRef<AbortController | null>(null);
  const spriteAbort = useRef<AbortController | null>(null);

  const fetchIndex = useCallback(async () => {
    setStage('index');
    setError(null);
    abort.current = new AbortController();
    try {
      setRoot(await libraryRoot());
      const m = await buildManifest(
        ({ kind, count }) => setIndexInfo({ kind, count }),
        abort.current.signal,
      );
      setManifest(m);
      setPlans({
        sfx: planDownload(m, 'sfx'),
        'sfx+jingles': planDownload(m, 'sfx+jingles'),
      });
      setStage('choose');
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setStage('intro');
        return;
      }
      setError(
        `Could not read the wiki's file index: ${(e as Error).message}. ` +
          'Check your connection and try again.',
      );
      setStage('error');
    }
  }, []);

  /**
   * Match sounds to wiki artwork over an existing manifest. Kept separate from
   * the download flow so it can be re-run on its own when the matching rules
   * improve — nobody should have to re-fetch 80 MB of audio for new icons.
   *
   * Cosmetic by nature: it can be skipped, and any failure leaves the library
   * exactly as usable as it was.
   */
  const spritePass = useCallback(async (input: Manifest): Promise<Manifest> => {
    setStage('sprites');
    setSpriteInfo(null);
    spriteAbort.current = new AbortController();

    try {
      const result = await buildSprites(input, setSpriteInfo, spriteAbort.current.signal);
      const merged: Manifest = {
        ...input,
        clips: input.clips.map((c) => {
          const meta = result.soundMeta[c.id];
          return {
            ...c,
            sprite: result.sprites[c.id] ?? c.sprite,
            desc: result.descriptions[c.id] ?? c.desc,
            soundId: meta?.soundId ?? c.soundId,
            configName: meta?.configName ?? c.configName,
          };
        }),
      };

      if (result.downloads.length) {
        setSpriteInfo({ stage: 'Downloading artwork', done: 0, total: result.downloads.length });
        await runDownload(result.downloads, (p) =>
          setSpriteInfo({ stage: 'Downloading artwork', done: p.done, total: p.total }),
        );
      }
      return merged;
    } catch {
      // Skipped or unreachable — every clip just falls back to a tile.
      return input;
    }
  }, []);

  /** Re-match artwork only, leaving the audio library untouched. */
  const rematchArtwork = useCallback(async () => {
    if (!existing) return;
    setError(null);
    try {
      const updated = await spritePass(existing);
      await saveManifest(updated);
      onReady(updated);
    } catch (e) {
      setError(`Could not re-match artwork: ${(e as Error).message}`);
      setStage('error');
    }
  }, [existing, spritePass, onReady]);

  const start = useCallback(async () => {
    if (!manifest || !plans) return;
    const plan = plans[scope];
    const planned = applyPlan(manifest, plan);

    setStage('download');
    setDl({ done: 0, total: plan.items.length, skipped: 0, failed: 0, bytes: 0, current: '' });
    setError(null);

    try {
      const report = await runDownload(plan.items, setDl);
      setFailed(report.failed.length);

      if (report.cancelled) {
        // Everything already on disk still counts — the next run resumes here.
        setStage('choose');
        return;
      }

      // Measure whatever the wiki did not tell us, now that it is local and
      // reading metadata costs a millisecond instead of a round trip.
      setStage('probe');
      const present = await scanLocalFiles();
      const needsDuration = planned.clips.filter((c) => c.duration == null && c.file && present.has(c.file));
      let durations = new Map<string, number>();

      if (needsDuration.length) {
        const resolve = await makeResolver(present);
        const entries = needsDuration.map((c) => ({ id: c.id, url: resolve(c) }));
        setProbe({ done: 0, total: entries.length });
        durations = await probeAll(entries, (done, total) => setProbe({ done, total }));
      }

      let final: Manifest = {
        ...planned,
        clips: planned.clips.map((c) =>
          durations.has(c.id) ? { ...c, duration: durations.get(c.id)! } : c,
        ),
      };

      final = await spritePass(final);

      // Written last, so a manifest on disk always means a usable library.
      await saveManifest(final);
      onReady(final);
    } catch (e) {
      setError(`Download failed: ${(e as Error).message}`);
      setStage('error');
    }
  }, [manifest, plans, scope, onReady]);

  /* ------------------------------------------------------------- render ---- */

  return (
    <div className="setup">
      <div className="setup-card">
        <h1>OSRS Soundboard</h1>

        {stage === 'intro' && (
          <>
            {existing ? (
              <>
                <p className="lede">
                  Your library has {formatCount(existing.clips.length)} files. You can top it up
                  with anything new on the wiki, or just re-run the artwork matching.
                </p>
                <p className="fine">
                  Re-matching artwork leaves your audio alone — it only re-reads the wiki&rsquo;s
                  sound index and downloads any icons it finds. Worth doing when the matching
                  rules improve.
                </p>
                <div className="row">
                  <button className="primary" onClick={fetchIndex}>
                    Check for new files
                  </button>
                  <button className="ghost" onClick={rematchArtwork}>
                    Re-match artwork only
                  </button>
                  {onDismiss && (
                    <button className="ghost" onClick={onDismiss}>
                      Cancel
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="lede">
                  The app ships empty and assembles its own library from the Old School RuneScape
                  Wiki. First it reads the file index — a few API calls, no audio yet.
                </p>
                <p className="fine">
                  Sound effects and short jingles are stored on your machine so pads fire
                  instantly. Music streams from the wiki rather than filling 7&nbsp;GB of disk.
                </p>
                <div className="row">
                  <button className="primary" onClick={fetchIndex}>
                    Read the wiki index
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {stage === 'index' && (
          <>
            <p className="lede">Reading the file index…</p>
            <div className="bar indeterminate" />
            <p className="fine">
              {indexInfo
                ? `${indexInfo.kind}: ${formatCount(indexInfo.count)} files`
                : 'Contacting oldschool.runescape.wiki…'}
            </p>
            <button
              className="ghost"
              onClick={() => {
                abort.current?.abort();
              }}
            >
              Cancel
            </button>
          </>
        )}

        {stage === 'choose' && manifest && plans && (
          <>
            <p className="lede">
              Found {formatCount(manifest.clips.length)} files. Choose what to keep on disk.
            </p>

            <div className="choices">
              <ScopeChoice
                label="Sound effects + short jingles"
                hint="Everything that belongs on a pad. Recommended."
                plan={plans['sfx+jingles']}
                selected={scope === 'sfx+jingles'}
                onSelect={() => setScope('sfx+jingles')}
              />
              <ScopeChoice
                label="Sound effects only"
                hint="Smallest download. Jingle pads stream on first press."
                plan={plans.sfx}
                selected={scope === 'sfx'}
                onSelect={() => setScope('sfx')}
              />
            </div>

            {plans['sfx+jingles'].jingleDurationsUnknown && scope === 'sfx+jingles' && (
              <p className="warn">
                The wiki did not report clip lengths, so every jingle is included and measured
                after download. That makes this larger than the usual 60–80&nbsp;MB.
              </p>
            )}

            <p className="fine">
              Music stays on the wiki and streams on demand. Library folder:{' '}
              <code>{root || '…'}</code>
            </p>

            <div className="row">
              <button className="primary" onClick={start}>
                Download {formatBytes(plans[scope].bytes)}
              </button>
              {existing && onDismiss && (
                <button className="ghost" onClick={onDismiss}>
                  Cancel
                </button>
              )}
            </div>
          </>
        )}

        {stage === 'download' && dl && (
          <>
            <p className="lede">
              Downloading {formatCount(dl.done)} of {formatCount(dl.total)}
            </p>
            <div className="bar">
              <div className="fill" style={{ width: `${(dl.done / Math.max(dl.total, 1)) * 100}%` }} />
            </div>
            <p className="fine">
              {formatBytes(dl.bytes)} fetched
              {dl.skipped > 0 && ` · ${formatCount(dl.skipped)} already on disk`}
              {dl.failed > 0 && ` · ${formatCount(dl.failed)} failed`}
            </p>
            <p className="fine dim">
              Quitting now is safe — the next run skips whatever is already downloaded.
            </p>
            <button className="ghost" onClick={() => void cancelDownload()}>
              Stop
            </button>
          </>
        )}

        {stage === 'probe' && (
          <>
            <p className="lede">Measuring clip lengths…</p>
            <div className="bar">
              <div
                className="fill"
                style={{ width: `${((probe?.done ?? 0) / Math.max(probe?.total ?? 1, 1)) * 100}%` }}
              />
            </div>
            <p className="fine">
              {probe ? `${formatCount(probe.done)} of ${formatCount(probe.total)}` : 'Starting…'}
              {failed > 0 && ` · ${formatCount(failed)} files could not be downloaded`}
            </p>
          </>
        )}

        {stage === 'sprites' && (
          <>
            <p className="lede">Matching sounds to wiki artwork…</p>
            <div className="bar">
              <div
                className="fill"
                style={{
                  width: `${((spriteInfo?.done ?? 0) / Math.max(spriteInfo?.total ?? 1, 1)) * 100}%`,
                }}
              />
            </div>
            <p className="fine">
              {spriteInfo
                ? `${spriteInfo.stage} · ${formatCount(spriteInfo.done)} of ${formatCount(spriteInfo.total)}`
                : 'Reading the wiki’s sound index…'}
            </p>
            <p className="fine dim">
              Optional — skipping just leaves every pad with a generated tile.
            </p>
            <button className="ghost" onClick={() => spriteAbort.current?.abort()}>
              Skip artwork
            </button>
          </>
        )}

        {stage === 'error' && (
          <>
            <p className="lede error">Something went wrong</p>
            <p className="fine">{error}</p>
            <div className="row">
              <button className="primary" onClick={fetchIndex}>
                Try again
              </button>
              {existing && onDismiss && (
                <button className="ghost" onClick={onDismiss}>
                  Back
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ScopeChoice({
  label,
  hint,
  plan,
  selected,
  onSelect,
}: {
  label: string;
  hint: string;
  plan: DownloadPlan;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`choice${selected ? ' selected' : ''}`} onClick={onSelect}>
      <span className="choice-label">{label}</span>
      <span className="choice-size">
        {formatCount(plan.items.length)} files · {formatBytes(plan.bytes)}
      </span>
      <span className="choice-hint">{hint}</span>
    </button>
  );
}
