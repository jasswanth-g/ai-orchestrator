/**
 * Effort estimates: "2h", "30m", "1h30m", "1.5h", "90" (bare number = minutes).
 * Stored as whole minutes; shown back as "1h30m".
 */

export class EstimateParseError extends Error {
  constructor(input: string) {
    super(`Can't read estimate "${input}". Use e.g. 30m, 2h, 1h30m or 1.5h.`);
  }
}

export function parseEstimate(input: string): number {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  let minutes: number | undefined;

  if (/^\d+$/.test(s)) minutes = Number(s);
  else {
    const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m(?:in)?)?$/.exec(s);
    if (m && (m[1] || m[2])) minutes = Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0));
  }
  if (!minutes || minutes <= 0 || minutes > 24 * 60 * 5) throw new EstimateParseError(input);
  return minutes;
}

export function formatEstimate(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}h${m}m` : h ? `${h}h` : `${m}m`;
}
