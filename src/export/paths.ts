// Media paths for an NLE's <pathurl> (FCP7 xmeml) and src= (FCPXML).
//
// A path is a URL, not XML text, and the two escape differently. The exporters
// were building both out of the same already-XML-escaped string, which is wrong
// in both directions: "&" reaches the URL as the literal "&amp;", and a space
// or a "#" reaches it raw and truncates the path at that character.
//
// Nothing had broken yet only because camera files are conventionally
// [A-Za-z0-9_] — the moment a card name, an operator's initials or a project
// prefix carries a space, the editor gets a path that points at nothing and no
// error anywhere says why.
//
// So: encode from the RAW name, per segment, so the "/" separators survive.
// Percent-encoding emits only characters that are already XML-safe, which is
// why the result can be interpolated straight into the document.

/**
 * Build a percent-encoded media path from raw, unescaped parts.
 *
 * Pass folder segments first and the file name last. Empty or whitespace-only
 * parts drop out, so a caller can hand over an optional folder without
 * branching:
 *
 *   mediaPath('A_20260808', 'reel_0273.MP4')  ->  "A_20260808/reel_0273.MP4"
 *   mediaPath(undefined, 'reel_0273.MP4')     ->  "reel_0273.MP4"
 *   mediaPath('day 2/card 1', 'a b.MP4')      ->  "day%202/card%201/a%20b.MP4"
 *
 * The return value carries no leading slash. Callers own the scheme, because
 * the two formats disagree: xmeml wants `file://localhost/` and FCPXML wants
 * `file:///`.
 */
export function mediaPath(...parts: (string | undefined)[]): string {
  return parts
    .flatMap((part) => (part ?? '').split('/'))
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Join an editor's absolute root with a path relative to it, for a HUMAN and
 * for a shell — never for a URL.
 *
 * This is deliberately NOT mediaPath. The two are answering different
 * questions and the answers are incompatible: `mediaPath` percent-encodes
 * because its output goes inside `file://` in an XML document, and an editor
 * who copies "/Volumes/My%20Book/C0001.MP4" out of a CSV and into Finder or
 * ffmpeg gets nothing at all. The CSV cell has to be the path as the disk
 * actually spells it, spaces and ampersands included, because that is the
 * string the assistant editor is going to paste.
 *
 * Windows roots are joined with backslashes when the root is spelled with
 * them and no forward slash, so a DIT on Windows gets "D:\FOOTAGE\A\C1.MP4"
 * rather than a mixed-separator hybrid.
 *
 *   joinPath('/Volumes/My Book', 'CARD_A/C0001.MP4')  ->  "/Volumes/My Book/CARD_A/C0001.MP4"
 *   joinPath(undefined, 'CARD_A/C0001.MP4')           ->  "CARD_A/C0001.MP4"
 *   joinPath('D:\\FOOTAGE', 'A/C1.MP4')               ->  "D:\FOOTAGE\A\C1.MP4"
 */
export function joinPath(root: string | undefined, relative: string): string {
  const rel = relative.trim().replace(/^\/+/, '');
  const base = (root ?? '').trim().replace(/[/\\]+$/, '');
  if (!base) return rel;
  const windows = base.includes('\\') && !base.includes('/');
  return windows ? `${base}\\${rel.replace(/\//g, '\\')}` : `${base}/${rel}`;
}
