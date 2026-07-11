// Public surface of the export module. UI code imports from here only.

import type { Exporter } from '../types';
import { tc } from './timecode';
import { toPdf } from './pdf';
import { toFcpXml } from './fcpxml';
import { toCsv } from './csv';
import { shareBlob } from './share';

export { tc, toPdf, toFcpXml, toCsv, shareBlob };

/** The Exporter contract, wired to the three format writers. */
export const exporter: Exporter = {
  toPdf,
  toFcpXml,
  toCsv,
};
