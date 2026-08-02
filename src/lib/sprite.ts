import type { Clip, Kind } from '../types';

/**
 * Tier 4 of the spec's sprite plan: a procedural tile, category-keyed colour,
 * first two letters. Generated in CSS at render time rather than as files.
 *
 * Tiers 1–3 (the SFXLine reverse index and wiki artwork) are a later phase, so
 * for now every clip gets a tile — stable, because the hue is hashed from the
 * title, which means a pad keeps the same colour between runs.
 */

const BASE_HUE: Record<Kind, number> = {
  sfx: 28, // amber
  jingle: 96, // green
  music: 208, // blue
  soundbank: 280, // violet
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export type Tile = {
  background: string;
  color: string;
  label: string;
};

export function tileFor(clip: Clip): Tile {
  const h = hash(clip.title || clip.displayFile);
  // Stay inside a band around the category hue so the grid still reads as
  // categorised rather than as confetti.
  const hue = (BASE_HUE[clip.kind] + (h % 40) - 20 + 360) % 360;
  const sat = 34 + (h % 14);
  const light = 26 + ((h >> 5) % 10);

  return {
    background: `linear-gradient(150deg, hsl(${hue} ${sat}% ${light + 7}%), hsl(${hue} ${sat}% ${light - 4}%))`,
    color: `hsl(${hue} ${Math.min(sat + 30, 80)}% 76%)`,
    label: initials(clip.title || clip.displayFile),
  };
}

function initials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '??';

  // Hundreds of sound effects are named `100 blowup`, `100 bubbles`, and taking
  // initials literally turns a whole screen into 1B / 1B / 1C. The leading id
  // carries no meaning, so skip it — unless it is all there is.
  const meaningful = words.filter((w) => !/^\d+$/.test(w));
  const use = meaningful.length ? meaningful : words;

  if (use.length === 1) return use[0].slice(0, 2).toUpperCase();
  return (use[0][0] + use[1][0]).toUpperCase();
}
