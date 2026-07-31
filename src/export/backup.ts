// The escape hatch for a signed-out shoot: sync only runs once a user signs
// in (see net/sync.ts's flush(), which bails the moment getAccessToken()
// comes back empty), so a device that never signs in has exactly one copy of
// the day anywhere — this browser's IndexedDB. Clear site data, lose the
// phone, or have iOS evict storage under memory pressure, and it is gone.
// Backup/Restore is the only export that has to work with none of that
// machinery: no account, no network, no server-side gate. Every function
// here is pure — it touches neither the store nor Supabase — so that
// guarantee is checkable by reading this file alone.
//
// `format`/`version` ride along so a FUTURE shape change can be detected and
// refused with a clear reason, rather than half-parsed into a project that
// silently drops fields nobody noticed were missing.

import type { Fps, ProjectBundle } from '../types';

export const BACKUP_FORMAT = 'clapper.backup';
export const BACKUP_VERSION = 1;

export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number; // epoch ms this file was written
  bundle: ProjectBundle;
}

export function buildBackupEnvelope(bundle: ProjectBundle, exportedAt: number = Date.now()): BackupEnvelope {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt, bundle };
}

/** The whole project, as one JSON file. */
export function buildBackupBlob(bundle: ProjectBundle, exportedAt?: number): Blob {
  const envelope = buildBackupEnvelope(bundle, exportedAt);
  return new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
}

const FPS_VALUES: readonly Fps[] = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

/**
 * Shape-check one field at a time rather than one big schema blob, so the
 * message a corrupted or hand-edited file gets back names the ACTUAL problem
 * ("scene with no id") instead of a generic "invalid backup" a person on set
 * has no way to act on. Returns the reason string, or null when the bundle
 * is well-formed enough to restore from.
 */
function validateBundleShape(bundle: Record<string, unknown>): string | null {
  const project = bundle.project;
  if (!project || typeof project !== 'object') return 'That backup file has no project data.';
  const p = project as Record<string, unknown>;
  if (typeof p.id !== 'string' || !p.id) return 'That backup file is missing the project id.';
  if (typeof p.name !== 'string') return 'That backup file is missing the project name.';
  if (typeof p.fps !== 'number' || !FPS_VALUES.includes(p.fps as Fps)) {
    return 'That backup file has an invalid frame rate.';
  }
  if (typeof p.clipPrefix !== 'string') return 'That backup file is missing the clip prefix.';
  if (typeof p.nextClipNumber !== 'number') return 'That backup file is missing the clip counter.';
  if (typeof p.clipPadding !== 'number') return 'That backup file is missing the clip padding.';
  if (!Array.isArray(p.tags)) return 'That backup file is missing its tag list.';
  if (typeof p.createdAt !== 'number' || typeof p.updatedAt !== 'number') {
    return 'That backup file is missing project timestamps.';
  }

  if (!Array.isArray(bundle.slates)) return 'That backup file has no scene list.';
  for (const s of bundle.slates) {
    if (!s || typeof s !== 'object') return 'That backup file has a corrupted scene.';
    const sl = s as Record<string, unknown>;
    if (typeof sl.id !== 'string' || !sl.id) return 'That backup file has a scene with no id.';
    if (typeof sl.name !== 'string') return 'That backup file has a scene with no name.';
    if (typeof sl.order !== 'number') return 'That backup file has a scene with no order.';
  }

  if (!Array.isArray(bundle.takes)) return 'That backup file has no take list.';
  for (const t of bundle.takes) {
    if (!t || typeof t !== 'object') return 'That backup file has a corrupted take.';
    const tk = t as Record<string, unknown>;
    if (typeof tk.id !== 'string' || !tk.id) return 'That backup file has a take with no id.';
    if (typeof tk.slateId !== 'string' || !tk.slateId) return 'That backup file has a take with no scene.';
    if (typeof tk.number !== 'number') return 'That backup file has a take with no number.';
    if (typeof tk.clipName !== 'string') return 'That backup file has a take with no clip name.';
    if (tk.status !== 'good' && tk.status !== 'discarded') {
      return 'That backup file has a take with an invalid status.';
    }
    if (typeof tk.startedAt !== 'number' || typeof tk.durationMs !== 'number') {
      return 'That backup file has a take with no timing.';
    }
  }

  if (!Array.isArray(bundle.moments)) return 'That backup file has no moment list.';
  for (const m of bundle.moments) {
    if (!m || typeof m !== 'object') return 'That backup file has a corrupted moment.';
    const mo = m as Record<string, unknown>;
    if (typeof mo.id !== 'string' || !mo.id) return 'That backup file has a moment with no id.';
    if (typeof mo.takeId !== 'string' || !mo.takeId) return 'That backup file has a moment with no take.';
    if (mo.kind !== 'point' && mo.kind !== 'range') return 'That backup file has a moment with an invalid kind.';
    if (typeof mo.atMs !== 'number') return 'That backup file has a moment with no time.';
    if (typeof mo.label !== 'string') return 'That backup file has a moment with no label.';
  }

  return null;
}

export type ParseBackupResult =
  | { ok: true; envelope: BackupEnvelope }
  | { ok: false; reason: string };

/**
 * Parse + validate a backup file's text. Never throws — a truncated download,
 * a hand-edited file, or someone picking the wrong JSON entirely all come
 * back as `{ ok: false, reason }` so the UI can show a clear message and
 * touch nothing, rather than the app crashing mid-restore.
 */
export function parseBackupText(text: string): ParseBackupResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file isn't valid JSON — it may be damaged, or not a Clapper backup at all." };
  }

  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: "That doesn't look like a Clapper backup file." };
  }
  const env = raw as Record<string, unknown>;

  if (env.format !== BACKUP_FORMAT) {
    return { ok: false, reason: "That doesn't look like a Clapper backup file." };
  }
  if (typeof env.version !== 'number' || !Number.isInteger(env.version) || env.version < 1) {
    return { ok: false, reason: 'That backup file is malformed.' };
  }
  if (env.version > BACKUP_VERSION) {
    return {
      ok: false,
      reason: 'This backup was made by a newer version of Clapper. Update the app and try again.',
    };
  }
  if (typeof env.exportedAt !== 'number') {
    return { ok: false, reason: 'That backup file is malformed.' };
  }

  const bundle = env.bundle;
  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, reason: 'That backup file has no project data.' };
  }
  const shapeError = validateBundleShape(bundle as Record<string, unknown>);
  if (shapeError) return { ok: false, reason: shapeError };

  return {
    ok: true,
    envelope: { format: BACKUP_FORMAT, version: env.version, exportedAt: env.exportedAt, bundle: bundle as ProjectBundle },
  };
}
