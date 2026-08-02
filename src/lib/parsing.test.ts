import { describe, expect, it } from 'vitest';

import { addToBoard, makeBoard, resizeBoard, slotForKey, swapSlots } from './boards';
import { formatBytes, formatDuration } from './format';

import { extractSounds, guessSubject } from './sprites';
import { extensionOf, normFile, parseName, slugify } from './wiki';
import { buildIndex, parseQuery, searchIndex } from './search';
import type { Clip } from '../types';

/**
 * These cover the parts that are easy to get subtly wrong and impossible to
 * eyeball: the variant whitelist, the wikitext scraping, and the board maths.
 */

describe('parseName', () => {
  it('keeps quest context but strips variant tokens', () => {
    // The spec's central example: these two are structurally identical and
    // must be treated differently.
    expect(parseName("File:A Slayer's Feat (Dragon Slayer).ogg")).toEqual({
      base: "A Slayer's Feat",
      context: 'Dragon Slayer',
      variants: [],
      isCurrent: true,
    });

    expect(parseName("File:A Slayer's Feat (Dragon Slayer) (8-bit).ogg")).toEqual({
      base: "A Slayer's Feat",
      context: 'Dragon Slayer',
      variants: ['8-bit'],
      isCurrent: false,
    });
  });

  it('treats Fossil Island as a variant, not context', () => {
    const p = parseName('File:A Tale (Forgettable Tale) (Fossil Island).ogg');
    expect(p.variants).toEqual(['Fossil Island']);
    expect(p.context).toBe('Forgettable Tale');
    expect(p.isCurrent).toBe(false);
  });

  it('handles version and dated variants', () => {
    expect(parseName('File:Adventure (v1).ogg').variants).toEqual(['v1']);
    expect(parseName('File:Arachnids of Vampyrium (2018 Version).ogg').variants).toEqual([
      '2018 Version',
    ]);
  });

  it('peels multiple trailing variants right to left', () => {
    const p = parseName('File:Sea Shanty (v2) (8-bit).ogg');
    expect(p.variants).toEqual(['v2', '8-bit']);
    expect(p.base).toBe('Sea Shanty');
  });

  it('leaves a bare name alone', () => {
    expect(parseName('File:Fire Blast.ogg')).toEqual({
      base: 'Fire Blast',
      context: null,
      variants: [],
      isCurrent: true,
    });
  });
});

describe('slugify', () => {
  it('survives apostrophes, bangs and commas', () => {
    expect(slugify("A New Champion! (Champion's Challenge)")).toBe(
      'a-new-champion-champion-s-challenge',
    );
    expect(slugify('Bell (Prifddinas, Ithell)')).toBe('bell-prifddinas-ithell');
  });

  it('never returns an empty string', () => {
    expect(slugify('!!!')).toBe('clip');
  });

  it('caps length so Windows paths stay sane', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('extensionOf', () => {
  it('reads the real extension rather than assuming ogg', () => {
    expect(extensionOf('Whip attack.wav', 'audio/wav')).toBe('wav');
    expect(extensionOf('Equip salamander.ogg', 'audio/ogg')).toBe('ogg');
  });

  it('falls back to the mime type when there is no extension', () => {
    expect(extensionOf('Mystery', 'audio/ogg')).toBe('ogg');
  });
});

describe('extractSounds', () => {
  it('pulls file and desc pairs out of SFXLine calls', () => {
    const wikitext = `
      ==Sound effects==
      {{SFXTableHead}}
      {{SFXLine|file=Whip attack.wav|desc=Attacking}}
      {{SFXLine|file=Abyssal whip special attack.wav|desc=Special attack}}
      {{SFXTableBottom}}
    `;
    expect(extractSounds(wikitext)).toEqual([
      { file: 'Whip attack.wav', desc: 'Attacking' },
      { file: 'Abyssal whip special attack.wav', desc: 'Special attack' },
    ]);
  });

  it('tolerates a missing desc and extra parameters', () => {
    expect(extractSounds('{{SFXLine|file=Bell.wav}}')).toEqual([{ file: 'Bell.wav', desc: '' }]);
    expect(extractSounds('{{SFXLine|id=1|file=Bell.wav|desc=Ringing}}')).toEqual([
      { file: 'Bell.wav', desc: 'Ringing' },
    ]);
  });

  it('ignores unrelated templates', () => {
    expect(extractSounds('{{Infobox Item|name=Whip}}')).toEqual([]);
  });
});

describe('guessSubject', () => {
  it('strips action suffixes', () => {
    expect(guessSubject('Icefiend attack.wav')).toBe('Icefiend');
    expect(guessSubject('Windchimes playing.wav')).toBe('Windchimes');
    expect(guessSubject('Brine sabre attack (stab).wav')).toBe('Brine sabre');
  });

  it('strips the Equip verb and leaves the item to be verified', () => {
    // "whip" resolves to a real article and survives; "fun" does not and gets
    // dropped by the verification pass rather than by a blanket rule here.
    expect(guessSubject('Equip whip.wav')).toBe('whip');
    expect(guessSubject('Equip fun.wav')).toBe('fun');
    expect(guessSubject('Equip dragon claws.ogg')).toBe('dragon claws');
  });

  it('passes bare spell and prayer names through', () => {
    expect(guessSubject('Fire Blast.ogg')).toBe('Fire Blast');
    expect(guessSubject('Piety.ogg')).toBe('Piety');
  });
});

describe('normFile', () => {
  it('treats underscores and spaces as the same', () => {
    expect(normFile('File:Whip_attack.wav')).toBe(normFile('Whip attack.wav'));
  });
});

describe('parseQuery', () => {
  it('splits the cat: token out of the search terms', () => {
    const q = parseQuery('cat:jingle level');
    expect(q.cats).toEqual(['jingle']);
    expect(q.terms).toEqual(['level']);
  });

  it('ignores an unknown category', () => {
    expect(parseQuery('cat:nonsense whip').cats).toEqual([]);
  });

  it('returns nothing to match on for an empty query', () => {
    expect(parseQuery('   ').terms).toEqual([]);
  });
});

describe('search over descriptions', () => {
  const clip = (over: Partial<Clip>): Clip => ({
    id: 'x',
    title: 'Whip attack',
    context: null,
    variant: null,
    isCurrent: true,
    kind: 'sfx',
    file: null,
    remoteUrl: '',
    displayFile: 'Whip attack.wav',
    bytes: 0,
    duration: null,
    sha1: '',
    desc: null,
    soundId: null,
    configName: null,
    sprite: null,
    ...over,
  });

  it('finds a sound by what it is, not just what it is called', () => {
    // The whole point: you know the sound as "being hit", not as its filename.
    const index = buildIndex([
      clip({ id: 'a', title: 'Human hit', desc: 'Being hit' }),
      clip({ id: 'b', title: 'Whip attack', desc: 'Attacking' }),
    ]);
    const hits = searchIndex(index, parseQuery('being hit'));
    expect(hits.map((c) => c.id)).toEqual(['a']);
  });

  it('ranks a description match above an incidental filename match', () => {
    const index = buildIndex([
      clip({ id: 'filename', title: 'Cave goblin attack', desc: null }),
      clip({ id: 'described', title: 'Dwarf noise', desc: 'Attacking' }),
    ]);
    const hits = searchIndex(index, parseQuery('attacking'));
    expect(hits[0].id).toBe('described');
  });

  it('still works when no description was ever collected', () => {
    const index = buildIndex([clip({ id: 'a', title: 'Icefiend attack' })]);
    expect(searchIndex(index, parseQuery('icefiend')).map((c) => c.id)).toEqual(['a']);
  });
});

describe('boards', () => {
  it('fills the first empty slot', () => {
    let b = makeBoard('Test', '4x4');
    b = addToBoard(b, 'a')!;
    b = addToBoard(b, 'b')!;
    expect(b.slots.slice(0, 2)).toEqual(['a', 'b']);
  });

  it('reports a full board rather than dropping the clip', () => {
    let b = makeBoard('Tiny', '4x4');
    for (let i = 0; i < 16; i++) b = addToBoard(b, `c${i}`)!;
    expect(addToBoard(b, 'overflow')).toBeNull();
  });

  it('keeps what fits when resizing down', () => {
    let b = makeBoard('Test', '8x8');
    b = addToBoard(b, 'first')!;
    const small = resizeBoard(b, '4x4');
    expect(small.slots).toHaveLength(16);
    expect(small.slots[0]).toBe('first');
  });

  it('swaps two slots', () => {
    let b = makeBoard('Test', '4x4');
    b = addToBoard(b, 'a')!;
    b = addToBoard(b, 'b')!;
    const swapped = swapSlots(b, 0, 1);
    expect(swapped.slots.slice(0, 2)).toEqual(['b', 'a']);
  });

  it('maps the number and QWERTY rows to the first 16 slots', () => {
    expect(slotForKey('1')).toBe(0);
    expect(slotForKey('8')).toBe(7);
    expect(slotForKey('q')).toBe(8);
    expect(slotForKey('Q')).toBe(8);
    expect(slotForKey('i')).toBe(15);
    expect(slotForKey('9')).toBe(-1);
    expect(slotForKey('p')).toBe(-1);
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(null)).toBe('—');
  });

  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(7 * 1024 ** 3)).toBe('7.0 GB');
  });
});
