// Public surface of the export module. UI code imports from here only.

import type { Exporter } from '../types';
import { tc } from './timecode';
import { toPdf } from './pdf';
import { toFcpXml } from './fcpxml';
import { toResolveXml } from './resolve';
import { toCsv } from './csv';
import { shareBlob } from './share';

export { tc, toPdf, toFcpXml, toResolveXml, toCsv, shareBlob };

/** The Exporter contract, wired to the four format writers. */
export const exporter: Exporter = {
  toPdf,
  toFcpXml,
  toResolveXml,
  toCsv,
};
