/**
 * Structured fields (source, link, path) ride in the item's free-text
 * description as a footer, so they survive in any store that only has a
 * notes field and stay readable in the Todoist app:
 *
 *   <notes>
 *
 *   ---
 *   source: mail
 *   link: https://outlook.office.com/...
 */

const FOOTER_RULE = '---';
const META_KEYS = ['source', 'link', 'path', 'estimate', 'status', 'approach'] as const;
export type MetaKey = (typeof META_KEYS)[number];
export type Meta = Partial<Record<MetaKey, string>>;

export function encodeDescription(notes: string | undefined, meta: Meta): string {
  const lines = META_KEYS.filter((k) => meta[k]).map((k) => `${k}: ${k === 'approach' ? escapeLines(meta[k]!) : meta[k]}`);
  const body = notes?.trim() ?? '';
  if (lines.length === 0) return body;
  return [body, FOOTER_RULE, ...lines].filter(Boolean).join('\n');
}

export function decodeDescription(description: string): { notes?: string; meta: Meta } {
  const lines = description.split('\n');
  const rule = lines.lastIndexOf(FOOTER_RULE);
  if (rule === -1) return { notes: description.trim() || undefined, meta: {} };

  const meta: Meta = {};
  for (const line of lines.slice(rule + 1)) {
    const m = /^(\w+):\s?(.*)$/.exec(line);
    const key = m?.[1] as MetaKey | undefined;
    // A footer line that isn't one of ours means this "---" is the user's own text.
    if (!m || !key || !META_KEYS.includes(key)) return { notes: description.trim() || undefined, meta: {} };
    meta[key] = key === 'approach' ? unescapeLines(m[2]?.trim() ?? '') : m[2]?.trim();
  }
  const notes = lines.slice(0, rule).join('\n').trim();
  return { notes: notes || undefined, meta };
}

/** The approach is free text; its line breaks are escaped so it fits on one footer line. */
const escapeLines = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const unescapeLines = (s: string) => s.replace(/\\(\\|n)/g, (_, c: string) => (c === 'n' ? '\n' : '\\'));
