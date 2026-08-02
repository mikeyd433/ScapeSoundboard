/**
 * Audio architecture (spec §6).
 *
 *   AudioContext
 *     └── masterGain → DynamicsCompressor (soft limiter) → destination
 *           ├── sfxBus   (gain)  ← polyphonic, unlimited overlap
 *           └── musicBus (gain)
 *
 * Two engines share that bus so a music track can run under the soundboard
 * while SFX fire over it.
 *
 *   Engine A (soundboard) decodes short clips to AudioBuffers and spawns a
 *   fresh AudioBufferSourceNode per trigger, which is what makes hammering a
 *   pad give you ten overlapping voices.
 *
 *   Engine B (library) streams through HTMLAudioElements. A six-minute OGG as
 *   an AudioBuffer is ~60 MB of RAM; at this library size decoding is not an
 *   option.
 *
 * One wrinkle the spec does not cover: routing a media element through
 * `createMediaElementSource` taints the graph to silence unless the media is
 * CORS-clean. We cannot know in advance whether the wiki serves the right
 * headers, so `initMusic` probes once and falls back to driving
 * `HTMLAudioElement.volume` directly. Playback and volume work either way; the
 * only thing lost in the fallback is music passing through the shared limiter.
 */

const LRU_MAX = 300;
const CROSSFADE_MS = 600;

export type TransportState = {
  clipId: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  loop: boolean;
  /** Set when the source failed to load — usually a dead wiki URL or no network. */
  error: string | null;
};

export type PlayOptions = {
  /** Per-pad gain, 0..2. */
  gain?: number;
  /** Per-pad playbackRate, doubles as pitch since we do not time-stretch. */
  rate?: number;
};

type Channel = {
  el: HTMLAudioElement;
  gain: GainNode | null;
  /** Logical 0..1 fade level, kept separately because in direct mode it has to
   *  be multiplied by the master and music volumes before hitting `el.volume`. */
  level: number;
  tween: number | null;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;

  private buffers = new Map<string, AudioBuffer>();
  private inflight = new Map<string, Promise<AudioBuffer | null>>();
  private voices = new Set<AudioBufferSourceNode>();

  private vol = { master: 0.8, sfx: 1, music: 0.7 };

  private channels: Channel[] = [];
  private activeChannel = 0;
  private musicInit: Promise<void> | null = null;
  /** null until probed. false means "drive element volume directly". */
  private graphMode: boolean | null = null;

  private transport: TransportState = {
    clipId: null,
    playing: false,
    currentTime: 0,
    duration: 0,
    loop: false,
    error: null,
  };
  private transportSubs = new Set<(s: TransportState) => void>();
  private endedSubs = new Set<() => void>();

  /* ------------------------------------------------------------ context ---- */

  /**
   * An AudioContext needs a user gesture even inside a webview, so this is
   * called from click handlers rather than at startup. Everything silently
   * no-ops otherwise (spec §10).
   */
  ensure(): AudioContext {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }

    const ctx = new AudioContext();
    const master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    // A soft limiter, not a squash: it only catches the peaks you get when
    // fifteen voices land on the same sample.
    limiter.threshold.value = -6;
    limiter.knee.value = 12;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    const sfxBus = ctx.createGain();
    const musicBus = ctx.createGain();

    sfxBus.connect(master);
    musicBus.connect(master);
    master.connect(limiter);
    limiter.connect(ctx.destination);

    master.gain.value = this.vol.master;
    sfxBus.gain.value = this.vol.sfx;
    musicBus.gain.value = this.vol.music;

    this.ctx = ctx;
    this.master = master;
    this.sfxBus = sfxBus;
    this.musicBus = musicBus;
    return ctx;
  }

  get contextState(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  /* ------------------------------------------------------------ volumes ---- */

  setMasterVolume(v: number) {
    this.vol.master = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.vol.master;
    this.applyDirectVolumes();
  }

  setSfxVolume(v: number) {
    this.vol.sfx = clamp(v, 0, 1);
    if (this.sfxBus) this.sfxBus.gain.value = this.vol.sfx;
  }

  setMusicVolume(v: number) {
    this.vol.music = clamp(v, 0, 1);
    if (this.musicBus) this.musicBus.gain.value = this.vol.music;
    this.applyDirectVolumes();
  }

  /* --------------------------------------------- engine A — soundboard ---- */

  private touch(id: string, buf: AudioBuffer) {
    this.buffers.delete(id);
    this.buffers.set(id, buf);
    while (this.buffers.size > LRU_MAX) {
      const oldest = this.buffers.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.buffers.delete(oldest);
    }
  }

  private async decode(id: string, url: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(id);
    if (cached) {
      this.touch(id, cached);
      return cached;
    }
    const pending = this.inflight.get(id);
    if (pending) return pending;

    const ctx = this.ensure();
    const job = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // decodeAudioData detaches the buffer, but we never reuse the bytes.
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        this.touch(id, buf);
        return buf;
      } catch {
        return null;
      } finally {
        this.inflight.delete(id);
      }
    })();

    this.inflight.set(id, job);
    return job;
  }

  /** Fire a pad. Always overlaps — a fresh source node per trigger. */
  async playSfx(id: string, url: string, opts: PlayOptions = {}): Promise<boolean> {
    const ctx = this.ensure();
    const buf = await this.decode(id, url);
    if (!buf || !this.sfxBus) return false;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = clamp(opts.rate ?? 1, 0.25, 4);

    const gain = ctx.createGain();
    gain.gain.value = clamp(opts.gain ?? 1, 0, 2);

    src.connect(gain);
    gain.connect(this.sfxBus);
    src.onended = () => {
      this.voices.delete(src);
      try {
        gain.disconnect();
      } catch {
        /* already torn down */
      }
    };

    this.voices.add(src);
    src.start();
    return true;
  }

  /** Decode ahead of time so the first press of a pad is not the slow one. */
  async warm(
    entries: { id: string; url: string }[],
    signal?: AbortSignal,
    concurrency = 4,
  ): Promise<void> {
    // Never warm past the cache ceiling; anything beyond it would just evict
    // the work we already did.
    const budget = entries.slice(0, LRU_MAX);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        if (signal?.aborted) return;
        const i = cursor++;
        if (i >= budget.length) return;
        if (this.buffers.has(budget[i].id)) continue;
        await this.decode(budget[i].id, budget[i].url);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  get cachedCount(): number {
    return this.buffers.size;
  }

  /* ------------------------------------------------- engine B — music ---- */

  private async probeCors(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1' } });
      return res.ok || res.status === 206;
    } catch {
      return false;
    }
  }

  /**
   * Decide once whether music can go through the graph. Both a remote and a
   * local sample have to pass, because a single element cannot switch modes
   * after `createMediaElementSource` has claimed it.
   */
  async initMusic(samples: { remote?: string; local?: string }): Promise<void> {
    if (this.musicInit) return this.musicInit;

    this.musicInit = (async () => {
      const ctx = this.ensure();
      const checks: boolean[] = [];
      if (samples.remote) checks.push(await this.probeCors(samples.remote));
      if (samples.local) checks.push(await this.probeCors(samples.local));
      this.graphMode = checks.length > 0 && checks.every(Boolean);

      for (let i = 0; i < 2; i++) {
        const el = new Audio();
        el.preload = 'none';
        // Must be set before any src assignment or it has no effect.
        if (this.graphMode) el.crossOrigin = 'anonymous';

        let gain: GainNode | null = null;
        if (this.graphMode && this.musicBus) {
          gain = ctx.createGain();
          gain.gain.value = 0;
          ctx.createMediaElementSource(el).connect(gain);
          gain.connect(this.musicBus);
        } else {
          el.volume = 0;
        }

        const channel: Channel = { el, gain, level: 0, tween: null };
        el.addEventListener('timeupdate', () => this.emitIfActive(channel));
        el.addEventListener('durationchange', () => this.emitIfActive(channel));
        el.addEventListener('play', () => this.emitIfActive(channel));
        el.addEventListener('pause', () => this.emitIfActive(channel));
        el.addEventListener('ended', () => {
          this.emitIfActive(channel);
          // Looping tracks never reach 'ended', so this only advances the queue.
          if (this.channels[this.activeChannel] === channel) {
            for (const cb of this.endedSubs) cb();
          }
        });
        el.addEventListener('error', () => {
          if (this.channels[this.activeChannel] !== channel) return;
          this.patchTransport({ error: 'Could not load this track', playing: false });
        });
        this.channels.push(channel);
      }
    })();

    return this.musicInit;
  }

  get musicGraphMode(): boolean | null {
    return this.graphMode;
  }

  private emitIfActive(channel: Channel) {
    if (this.channels[this.activeChannel] !== channel) return;
    const { el } = channel;
    this.patchTransport({
      playing: !el.paused && !el.ended,
      currentTime: el.currentTime || 0,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
    });
  }

  private patchTransport(patch: Partial<TransportState>) {
    this.transport = { ...this.transport, ...patch };
    for (const sub of this.transportSubs) sub(this.transport);
  }

  subscribeTransport(cb: (s: TransportState) => void): () => void {
    this.transportSubs.add(cb);
    cb(this.transport);
    return () => this.transportSubs.delete(cb);
  }

  getTransport(): TransportState {
    return this.transport;
  }

  /** In direct mode the master and music volumes are folded into el.volume. */
  private applyDirectVolumes() {
    if (this.graphMode !== false) return;
    for (const ch of this.channels) {
      ch.el.volume = clamp(ch.level * this.vol.master * this.vol.music, 0, 1);
    }
  }

  private fade(ch: Channel, target: number, ms: number) {
    if (ch.tween !== null) {
      clearInterval(ch.tween);
      ch.tween = null;
    }

    if (ch.gain && this.ctx) {
      ch.level = target;
      const now = this.ctx.currentTime;
      ch.gain.gain.cancelScheduledValues(now);
      ch.gain.gain.setValueAtTime(ch.gain.gain.value, now);
      ch.gain.gain.linearRampToValueAtTime(target, now + ms / 1000);
      return;
    }

    // Direct mode: no gain node to ramp, so tween the element volume by hand.
    const from = ch.level;
    const started = performance.now();
    ch.tween = window.setInterval(() => {
      const t = clamp((performance.now() - started) / ms, 0, 1);
      ch.level = from + (target - from) * t;
      this.applyDirectVolumes();
      if (t >= 1 && ch.tween !== null) {
        clearInterval(ch.tween);
        ch.tween = null;
      }
    }, 16);
  }

  /** Load a track into the transport, crossfading out whatever was playing. */
  async playMusic(clipId: string, url: string, samples: { remote?: string; local?: string } = {}) {
    await this.initMusic({ remote: samples.remote ?? url, local: samples.local });
    if (!this.channels.length) return;

    const outgoing = this.channels[this.activeChannel];
    const next = (this.activeChannel + 1) % this.channels.length;
    const incoming = this.channels[next];

    if (!outgoing.el.paused) {
      this.fade(outgoing, 0, CROSSFADE_MS);
      const el = outgoing.el;
      window.setTimeout(() => {
        if (this.channels[this.activeChannel]?.el !== el) el.pause();
      }, CROSSFADE_MS);
    }

    incoming.level = 0;
    if (incoming.gain && this.ctx) incoming.gain.gain.value = 0;
    else incoming.el.volume = 0;

    incoming.el.loop = this.transport.loop;
    incoming.el.preload = 'auto';
    incoming.el.src = url;
    this.activeChannel = next;

    this.patchTransport({ clipId, currentTime: 0, duration: 0, error: null, playing: true });

    try {
      await incoming.el.play();
      this.fade(incoming, 1, CROSSFADE_MS);
    } catch {
      this.patchTransport({ playing: false, error: 'Playback was blocked or the file is unreachable' });
    }
  }

  async toggleMusic(): Promise<void> {
    const ch = this.channels[this.activeChannel];
    if (!ch?.el.src) return;
    if (ch.el.paused) {
      try {
        await ch.el.play();
      } catch {
        this.patchTransport({ error: 'Could not resume playback' });
      }
    } else {
      ch.el.pause();
    }
  }

  seek(seconds: number) {
    const ch = this.channels[this.activeChannel];
    if (!ch?.el.src) return;
    ch.el.currentTime = clamp(seconds, 0, Number.isFinite(ch.el.duration) ? ch.el.duration : seconds);
  }

  setLoop(loop: boolean) {
    this.patchTransport({ loop });
    for (const ch of this.channels) ch.el.loop = loop;
  }

  stopMusic() {
    for (const ch of this.channels) {
      ch.el.pause();
      ch.level = 0;
      if (ch.gain) ch.gain.gain.value = 0;
      else ch.el.volume = 0;
    }
    this.patchTransport({ playing: false });
  }

  /**
   * Fires when the active track runs out, so the UI can advance the queue.
   * Subscriber-based rather than element-based because callers register long
   * before `initMusic` has created any elements.
   */
  onEnded(cb: () => void): () => void {
    this.endedSubs.add(cb);
    return () => {
      this.endedSubs.delete(cb);
    };
  }

  /* --------------------------------------------------------------- panic ---- */

  /** Esc. Stops every voice instantly — the most important key on a soundboard. */
  panic() {
    for (const src of this.voices) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.voices.clear();
    this.stopMusic();
  }

  get voiceCount(): number {
    return this.voices.size;
  }
}

export const engine = new AudioEngine();
