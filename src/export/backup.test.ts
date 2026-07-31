// Backup/Restore's file format: an envelope carrying a format marker + schema
// version around the existing ProjectBundle, and the defensive parser that
// reads one back. These tests pin two guarantees: a good file round-trips
// byte-for-byte, and every way a file can be bad (not JSON, wrong app, wrong
// version, missing/corrupted fields) comes back as a clear `ok: false`
// reason rather than a thrown exception or a half-parsed bundle.

import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  buildBackupBlob,
  buildBackupEnvelope,
  parseBackupText,
} from './backup';
import type { Moment, Project, ProjectBundle, Slate, Take } from '../types';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Bhoot',
    fps: 24,
    clipPrefix: 'C',
    nextClipNumber: 3,
    clipPadding: 4,
    clipExt: '.MP4',
    tags: ['GOLD', 'NOISE'],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function slate(overrides: Partial<Slate> = {}): Slate {
  return { id: 's1', projectId: 'p1', name: 'Scene 1', order: 0, createdAt: 0, updatedAt: 0, ...overrides };
}

function take(overrides: Partial<Take> = {}): Take {
  return {
    id: 't1',
    slateId: 's1',
    projectId: 'p1',
    number: 1,
    clipName: 'C0001',
    status: 'good',
    startedAt: 0,
    durationMs: 1000,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function moment(overrides: Partial<Moment> = {}): Moment {
  return { id: 'm1', takeId: 't1', kind: 'point', atMs: 500, label: '', createdAt: 0, updatedAt: 0, ...overrides };
}

function bundle(): ProjectBundle {
  return { project: project(), slates: [slate()], takes: [take()], moments: [moment()] };
}

describe('buildBackupEnvelope / buildBackupBlob', () => {
  it('carries the format marker, schema version and the bundle untouched', () => {
    const b = bundle();
    const env = buildBackupEnvelope(b, 5000);
    expect(env).toEqual({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 5000, bundle: b });
  });

  it('defaults exportedAt to now when omitted', () => {
    const before = Date.now();
    const env = buildBackupEnvelope(bundle());
    expect(env.exportedAt).toBeGreaterThanOrEqual(before);
  });

  it('produces a JSON blob a good parse round-trips exactly', async () => {
    const b = bundle();
    const blob = buildBackupBlob(b, 42);
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    const result = parseBackupText(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope).toEqual({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 42, bundle: b });
    }
  });
});

describe('parseBackupText — rejection cases change nothing (never throw, always a reason)', () => {
  it('rejects text that is not JSON at all', () => {
    const result = parseBackupText('this is not { json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/valid JSON/i);
  });

  it('rejects JSON that is not an object', () => {
    const result = parseBackupText('[1,2,3]');
    expect(result.ok).toBe(false);
  });

  it('rejects a file with the wrong format marker (some other app\'s export)', () => {
    const result = parseBackupText(JSON.stringify({ format: 'someother.app', version: 1, exportedAt: 1, bundle: bundle() }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Clapper backup/i);
  });

  it('rejects a missing format field entirely', () => {
    const result = parseBackupText(JSON.stringify({ version: 1, exportedAt: 1, bundle: bundle() }));
    expect(result.ok).toBe(false);
  });

  it('rejects a version newer than this app understands', () => {
    const result = parseBackupText(
      JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION + 1, exportedAt: 1, bundle: bundle() }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/newer version/i);
  });

  it('rejects a non-integer or negative version', () => {
    expect(
      parseBackupText(JSON.stringify({ format: BACKUP_FORMAT, version: 1.5, exportedAt: 1, bundle: bundle() })).ok,
    ).toBe(false);
    expect(
      parseBackupText(JSON.stringify({ format: BACKUP_FORMAT, version: -1, exportedAt: 1, bundle: bundle() })).ok,
    ).toBe(false);
  });

  it('rejects a bundle with no project', () => {
    const b = bundle() as unknown as Record<string, unknown>;
    delete (b as { project?: unknown }).project;
    const result = parseBackupText(JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: 1, bundle: b }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/project/i);
  });

  it('rejects a project with an invalid frame rate', () => {
    const b = bundle();
    const corrupted = { ...b, project: { ...b.project, fps: 999 } };
    const result = parseBackupText(
      JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: 1, bundle: corrupted }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/frame rate/i);
  });

  it('rejects a scene with no id', () => {
    const b = bundle();
    const corrupted = { ...b, slates: [{ ...b.slates[0], id: undefined }] };
    const result = parseBackupText(
      JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: 1, bundle: corrupted }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a take with an invalid status', () => {
    const b = bundle();
    const corrupted = { ...b, takes: [{ ...b.takes[0], status: 'maybe' }] };
    const result = parseBackupText(
      JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: 1, bundle: corrupted }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a take missing its clip name', () => {
    const b = bundle();
    const corrupted = { ...b, takes: [{ ...b.takes[0], clipName: undefined }] };
    const result = parseBackupText(
      JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: 1, bundle: corrupted }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a moment with an invalid kind', () => {
    const b = bundle();
    const corrupted = { ...b, moments: [{ ...b.moments[0], kind: 'sideways' }] };
    const result = parseBackupText(
      JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: 1, bundle: corrupted }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects truncated JSON (a download that never finished)', () => {
    const full = JSON.stringify(buildBackupEnvelope(bundle()));
    const truncated = full.slice(0, Math.floor(full.length / 2));
    const result = parseBackupText(truncated);
    expect(result.ok).toBe(false);
  });
});
