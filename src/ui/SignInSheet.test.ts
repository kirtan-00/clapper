// The storage semantics SignInSheet.onSignIn leans on, pinned at the studio.ts
// level. Vitest runs DOM-less here (see studio.test.ts's header), so this
// mirrors the branch SignInSheet actually takes - `if (name.trim() ||
// studio.trim()) setStudio(...)`, else nothing - rather than rendering React.
//
// What this guards: SignInSheet must NEVER block sign-in on the form (both
// fields blank has to still let studioAsked() come back false, so
// StudioPrompt catches the person after sign-in), and it must NEVER ask twice
// (either field filled has to mark studioAsked() true, so StudioPrompt goes
// quiet for them).

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

import { getStudio, setStudio, setStudioLogo, studioAsked } from './studio';

/** The exact branch SignInSheet.onSignIn runs before signInWithGoogle(). */
function onSignIn(name: string, studio: string): void {
  if (name.trim() || studio.trim()) {
    setStudio({ name, studio });
  }
}

describe('SignInSheet storage semantics', () => {
  it('a filled name saves and marks the device asked', () => {
    onSignIn('Kirtan', '');
    expect(studioAsked()).toBe(true);
    expect(getStudio()).toEqual({ name: 'Kirtan', studio: '' });
  });

  it('a filled production house alone saves and marks the device asked', () => {
    onSignIn('', 'Fourside Studio');
    expect(studioAsked()).toBe(true);
    expect(getStudio()).toEqual({ name: '', studio: 'Fourside Studio' });
  });

  it('both fields blank never calls setStudio, so studioAsked stays false', () => {
    onSignIn('', '');
    expect(studioAsked()).toBe(false);
    expect(getStudio()).toEqual({ name: '', studio: '' });
  });

  it('whitespace-only fields count as blank, same as empty', () => {
    onSignIn('   ', '  \t ');
    expect(studioAsked()).toBe(false);
  });

  it('a blank pass leaves StudioPrompt able to catch the person post-sign-in', () => {
    // This is the contract StudioPrompt.tsx relies on: `studioAsked()` is the
    // only thing it checks before rendering (alongside session/rolling/
    // onboarding state, none of which this file owns). Staying false here IS
    // the guarantee that the post-sign-in ask still fires.
    onSignIn('', '');
    expect(studioAsked()).toBe(false);
  });

  it('prefill reads back an identity already stored on this device', () => {
    setStudio({ name: 'Kirtan', studio: 'Fourside Studio' });
    // SignInSheet seeds its two inputs from getStudio() on mount, so someone
    // who already answered (on this sheet or on StudioSheet) is not asked
    // to retype it.
    const existing = getStudio();
    expect(existing.name).toBe('Kirtan');
    expect(existing.studio).toBe('Fourside Studio');
  });

  it('saving through onSignIn does not disturb a logo saved earlier', () => {
    // setStudio already carries the logo forward (pinned in studio.test.ts);
    // this confirms SignInSheet's call site goes through that same
    // read-modify-write path rather than a raw write that could drop it.
    const logo = { dataUri: 'data:image/png;base64,AAAA', width: 40, height: 20 };
    setStudioLogo(logo);
    onSignIn('Kirtan', 'Fourside Studio');
    expect(getStudio()).toEqual({ name: 'Kirtan', studio: 'Fourside Studio', logo });
  });
});
