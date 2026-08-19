// Public surface of the export module. UI code imports from here only.

import type { Exporter } from '../types';
import { tc } from './timecode';
import { toPdf } from './pdf';
import { toFcpXml } from './fcpxml';
import { toResolveXml } from './resolve';
import { toCsv } from './csv';
import { shareBlob } from './share';
import { BACKUP_FORMAT, BACKUP_VERSION, buildBackupBlob, parseBackupText } from './backup';
import { buildMediaIndex, countMatched, matchClip } from './medialink';

export { tc, toPdf, toFcpXml, toResolveXml, toCsv, shareBlob };
export { BACKUP_FORMAT, BACKUP_VERSION, buildBackupBlob, parseBackupText };
export { buildMediaIndex, countMatched, matchClip };
export type { BackupEnvelope, ParseBackupResult } from './backup';
export type { MediaIndex, MediaMatch, MediaMatchStatus } from './medialink';

/** The Exporter contract, wired to the four format writers. */
export const exporter: Exporter = {
  toPdf,
  toFcpXml,
  toResolveXml,
  toCsv,
};
