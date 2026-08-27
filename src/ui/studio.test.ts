// The parse guard on the stored identity, and the ask-once flag.
//
// Same DOM-less-vitest situation as rollCheckpoint.test.ts: Node's own
// `localStorage` global is wired to an invalid backing path in this sandbox
// and throws on every call, so a working in-memory shim stands in. That is
// not a workaround - both states are load-bearing here. A studio name that
// cannot be stored must never break an export, and a studio name that HAS
// been stored must come back exactly as written.

import { beforeEach, describe, expect, it } from 'vitest';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
});

import {
  getStudio,
  setStudio,
  setStudioLogo,
  studioAsked,
  hasStudio,
  hasLogo,
  fitWithinCap,
  isAcceptedLogoType,
  resizeLogoFile,
  logoEligible,
  MAX_LOGO_DIM,
} from './studio';

const KEY = 'clapper.studio.v1';

describe('studio.ts', () => {
  it('round-trips what was written', () => {
    setStudio({ name: 'Kirtan', studio: 'Fourside Studio' });
    expect(getStudio()).toEqual({ name: 'Kirtan', studio: 'Fourside Studio' });
  });

  it('reads as two empty strings before anything is stored', () => {
    expect(getStudio()).toEqual({ name: '', studio: '' });
    expect(hasStudio()).toBe(false);
  });

  it('trims, so a trailing space is not a different studio', () => {
    setStudio({ name: '  Kirtan  ', studio: '  Fourside  ' });
    expect(getStudio()).toEqual({ name: 'Kirtan', studio: 'Fourside' });
  });

  it('caps length, so a pasted paragraph cannot run off the PDF cover', () => {
    setStudio({ name: '', studio: 'x'.repeat(500) });
    expect(getStudio().studio.length).toBe(80);
  });

  // The three shapes a hand-edited or half-written value can actually take.
  // Each must degrade to blank rather than reach the PDF writer as a non-string.
  it('survives malformed JSON', () => {
    localStorage.setItem(KEY, '{not valid json');
    expect(getStudio()).toEqual({ name: '', studio: '' });
  });

  it('survives a JSON value that is not an object', () => {
    localStorage.setItem(KEY, '"Fourside"');
    expect(getStudio()).toEqual({ name: '', studio: '' });
  });

  it('survives an object whose fields are the wrong type', () => {
    localStorage.setItem(KEY, JSON.stringify({ name: 42, studio: { a: 1 } }));
    expect(getStudio()).toEqual({ name: '', studio: '' });
  });

  it('counts a SKIP as asked, so the one-time sheet stays one-time', () => {
    expect(studioAsked()).toBe(false);
    setStudio({ name: '', studio: '' });
    expect(studioAsked()).toBe(true);
    // Asked, but nothing to print: the two questions are separate.
    expect(hasStudio()).toBe(false);
  });

  // THE DISMISS RULE, which is where the data loss was. StudioSheet writes
  // blanks on a dismiss ONLY when nothing has been asked yet. The same sheet
  // reopens from Settings, and there a dismiss is a cancel - the stored studio
  // has to survive it. This pins the predicate that decision hangs on.
  it('reports asked=true once a real value is stored, so a later cancel is not a skip', () => {
    setStudio({ name: 'Kirtan', studio: 'Fourside' });
    expect(studioAsked()).toBe(true);
    // Which is what StudioSheet's `if (!studioAsked())` reads. Simulating that
    // branch: the blank write never happens, so the value stands.
    if (!studioAsked()) setStudio({ name: '', studio: '' });
    expect(getStudio().studio).toBe('Fourside');
  });

  it('treats unreadable storage as already asked, rather than asking every load', () => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem() {
        throw new Error('blocked');
      },
    };
    expect(studioAsked()).toBe(true);
    expect(getStudio()).toEqual({ name: '', studio: '' });
  });

  it('a write that throws loses the value and nothing else', () => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      setItem() {
        throw new Error('quota');
      },
      getItem: () => null,
    };
    expect(() => setStudio({ name: 'Kirtan', studio: 'Fourside' })).not.toThrow();
  });
});

const PNG = { dataUri: 'data:image/png;base64,AAAA', width: 40, height: 20 };
const JPEG = { dataUri: 'data:image/jpeg;base64,AAAA', width: 40, height: 20 };

describe('fitWithinCap', () => {
  it('never upscales a logo already inside the cap', () => {
    expect(fitWithinCap(40, 20, 320)).toEqual({ width: 40, height: 20 });
  });

  it('downscales a wide image to the cap, aspect preserved', () => {
    // 1600x320: longest side (1600) scales to 320, so height scales by the
    // same 1/5 factor to 64.
    expect(fitWithinCap(1600, 320, 320)).toEqual({ width: 320, height: 64 });
  });

  it('downscales a tall image the same way, on the other axis', () => {
    expect(fitWithinCap(320, 1600, 320)).toEqual({ width: 64, height: 320 });
  });

  it('downscales a square image to a square', () => {
    expect(fitWithinCap(3000, 3000, 320)).toEqual({ width: 320, height: 320 });
  });

  it('defaults to MAX_LOGO_DIM when no cap is given', () => {
    expect(fitWithinCap(4000, 4000)).toEqual({ width: MAX_LOGO_DIM, height: MAX_LOGO_DIM });
  });

  it('degenerates to {0,0} rather than NaN on a zero or negative dimension', () => {
    expect(fitWithinCap(0, 100)).toEqual({ width: 0, height: 0 });
    expect(fitWithinCap(100, 0)).toEqual({ width: 0, height: 0 });
    expect(fitWithinCap(-5, 100)).toEqual({ width: 0, height: 0 });
  });
});

describe('isAcceptedLogoType', () => {
  it('accepts PNG and JPEG, the only two pdf-lib can embed', () => {
    expect(isAcceptedLogoType('image/png')).toBe(true);
    expect(isAcceptedLogoType('image/jpeg')).toBe(true);
  });

  it('refuses everything else, including a lookalike and a blank type', () => {
    expect(isAcceptedLogoType('image/gif')).toBe(false);
    expect(isAcceptedLogoType('image/svg+xml')).toBe(false);
    expect(isAcceptedLogoType('image/heic')).toBe(false);
    expect(isAcceptedLogoType('')).toBe(false);
  });
});

describe('resizeLogoFile - the fallback paths', () => {
  it('rejects an unsupported type before ever touching the DOM', async () => {
    const file = new File(['x'], 'logo.gif', { type: 'image/gif' });
    await expect(resizeLogoFile(file)).rejects.toThrow(/unsupported/i);
  });

  it('rejects in this DOM-less test environment - the same path a WebView with a blocked canvas takes, and every caller treats it as "no logo"', async () => {
    // This suite runs with no jsdom (see the header above): there is no
    // `document`/`Image` for the resize pipeline to reach for, which is
    // exactly the environment `resizeLogoFile`'s own feature-detect guards
    // against. A PNG-typed file still gets this far and still fails cleanly.
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    await expect(resizeLogoFile(file)).rejects.toThrow();
  });
});

describe('logoEligible - the soft gate', () => {
  it('is true only for an ACTIVE studio_plus subscription', () => {
    expect(logoEligible({ subscriptionActive: true, subscriptionProduct: 'studio_plus' })).toBe(true);
  });

  it('is false for every other product, even if active', () => {
    expect(logoEligible({ subscriptionActive: true, subscriptionProduct: 'pro_monthly' })).toBe(false);
    expect(logoEligible({ subscriptionActive: true, subscriptionProduct: null })).toBe(false);
  });

  it('is false for studio_plus that has lapsed', () => {
    expect(logoEligible({ subscriptionActive: false, subscriptionProduct: 'studio_plus' })).toBe(false);
  });

  it('is false when entitlements have not resolved (signed out, or the read has not settled)', () => {
    expect(logoEligible(null)).toBe(false);
  });
});

describe('getStudio - logo round-trip and malformed shapes', () => {
  it('round-trips a stored logo', () => {
    setStudioLogo(PNG);
    expect(getStudio().logo).toEqual(PNG);
    expect(hasLogo()).toBe(true);
  });

  it('round-trips a JPEG logo the same way', () => {
    setStudioLogo(JPEG);
    expect(getStudio().logo).toEqual(JPEG);
  });

  it('clearing with null removes it', () => {
    setStudioLogo(PNG);
    setStudioLogo(null);
    expect(getStudio().logo).toBeUndefined();
    expect(hasLogo()).toBe(false);
  });

  it('degrades a data URI outside png/jpeg to no logo, not a bad logo', () => {
    localStorage.setItem(
      'clapper.studio.v1',
      JSON.stringify({ name: '', studio: '', logo: { dataUri: 'data:image/gif;base64,AAAA', width: 10, height: 10 } }),
    );
    expect(getStudio().logo).toBeUndefined();
  });

  it('degrades a logo with non-numeric or zero dimensions to no logo', () => {
    localStorage.setItem(
      'clapper.studio.v1',
      JSON.stringify({ name: '', studio: '', logo: { dataUri: PNG.dataUri, width: 0, height: 20 } }),
    );
    expect(getStudio().logo).toBeUndefined();
  });

  it('degrades a logo that is not an object at all', () => {
    localStorage.setItem('clapper.studio.v1', JSON.stringify({ name: '', studio: '', logo: 'not an object' }));
    expect(getStudio().logo).toBeUndefined();
  });

  it('a malformed logo never takes name/studio down with it', () => {
    localStorage.setItem(
      'clapper.studio.v1',
      JSON.stringify({ name: 'Kirtan', studio: 'Fourside', logo: { dataUri: 'nonsense' } }),
    );
    expect(getStudio()).toEqual({ name: 'Kirtan', studio: 'Fourside' });
  });
});

describe('setStudio preserves a stored logo (the regression this file exists to pin)', () => {
  it('editing name/studio through setStudio does not erase a saved logo', () => {
    setStudioLogo(PNG);
    setStudio({ name: 'Kirtan', studio: 'Fourside Studio' });
    expect(getStudio()).toEqual({ name: 'Kirtan', studio: 'Fourside Studio', logo: PNG });
  });

  it('setStudioLogo does not erase a saved name/studio', () => {
    setStudio({ name: 'Kirtan', studio: 'Fourside Studio' });
    setStudioLogo(PNG);
    expect(getStudio()).toEqual({ name: 'Kirtan', studio: 'Fourside Studio', logo: PNG });
  });
});
