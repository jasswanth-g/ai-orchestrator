/**
 * AI reading of WhatsApp group context: is a new message (or a burst of them)
 * for me? Context is read in chunks, newest first — the 5 messages before the
 * new ones, then 5 more only if the model says it can't tell yet, up to a cap.
 * Usually the first chunk is enough; the whole chat is never sent.
 *
 * The model is headless Claude Code on the user's own login, with no tools, no
 * MCP and no hooks: it only sees the text we pass and returns JSON.
 */

export interface ChatLine {
  /** Sender name if known, else their id; "You" for my own messages. */
  from: string;
  text: string;
  at: string;
}

export interface Decision {
  needMoreContext: boolean;
  forMe: boolean;
  kind: 'question' | 'request' | 'issue' | 'decision' | 'fyi' | 'none';
  /** What's being asked of me, in one line (empty when not for me). */
  summary: string;
  /** Why it is / isn't for me, in one line. */
  why: string;
}

export interface TriageResult extends Decision {
  /** Older messages that were read as context. */
  contextUsed: number;
}

export const CHUNK = 5;
export const MAX_CHUNKS = 6;

/** Runs one model call: prompt in, Decision out. Injected so tests don't call Claude. */
export type Ask = (system: string, prompt: string) => Promise<Decision>;

export const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['needMoreContext', 'forMe', 'kind', 'summary', 'why'],
  properties: {
    needMoreContext: { type: 'boolean', description: 'true only if the earlier messages shown are not enough to decide' },
    forMe: { type: 'boolean' },
    kind: { type: 'string', enum: ['question', 'request', 'issue', 'decision', 'fyi', 'none'] },
    summary: { type: 'string', maxLength: 200 },
    why: { type: 'string', maxLength: 200 },
  },
};

export function systemPrompt(me: { names: string[] }) {
  return `You triage WhatsApp group messages for one person: a software developer at Qwipo (B2B commerce on ONDC) who works with partner companies in these groups.${me.names.length ? ` They may be called: ${me.names.join(', ')}.` : ''} Their own messages are shown as "You". People marked [team] are their colleagues at Qwipo; other names are usually the partner side.

Decide whether the NEW messages need this person to act or reply:
- forMe = true: a question or request aimed at them, at Qwipo's tech side when they are the one who answers it, an issue or bug in what they own, a decision waiting on them, or a follow-up on something they said they'd do.
- forMe = false: chit-chat, greetings, thanks, acknowledgements, FYIs that need nothing, work clearly owned by someone else, or a partner's question a [team] colleague has already answered or taken (unless the partner is chasing again after that).
- A [team] colleague asking the person something directly is forMe.
- If the earlier messages you were shown are not enough to tell who it's for or what's asked, set needMoreContext = true (you will get more). Don't ask for more when it's already clear — a simple, good-enough judgement is the goal.
summary: what's asked of them, one plain line (empty if not for them). why: one line.`;
}

const render = (lines: ChatLine[]) => lines.map((l) => `[${l.at.slice(11, 16)}] ${l.from}: ${l.text}`).join('\n');

/**
 * Decides on `incoming` (new messages, oldest first) with as little history as
 * needed. `history(offset, limit)` returns earlier messages, newest first.
 */
export async function triage(o: {
  chat: string;
  incoming: ChatLine[];
  history: (offset: number, limit: number) => ChatLine[];
  ask: Ask;
  me: { names: string[] };
  /** What the group is for, written by the user. */
  purpose?: string;
}): Promise<TriageResult> {
  const system = systemPrompt(o.me);
  let context: ChatLine[] = [];
  for (let chunk = 1; chunk <= MAX_CHUNKS; chunk++) {
    const older = o.history(context.length, CHUNK);
    context = [...context, ...older];
    const exhausted = older.length < CHUNK;
    const last = chunk === MAX_CHUNKS || exhausted;
    const prompt = `Group: ${o.chat}${o.purpose ? `\nWhat this group is for (from the user): ${o.purpose}` : ''}

Earlier messages (oldest first${exhausted ? ', this is the start of what is available' : ''}):
${context.length ? render([...context].reverse()) : '(none)'}

NEW messages to decide on:
${render(o.incoming)}
${last ? '\nNo more earlier messages will be given — decide now with needMoreContext = false.' : ''}`;
    const d = await o.ask(system, prompt);
    if (!d.needMoreContext || last) return { ...d, needMoreContext: false, contextUsed: context.length };
  }
  throw new Error('unreachable');
}

/** One structured call via headless Claude Code (`claude -p`): no tools, no MCP, no hooks, not saved as a session. */
export function claudeJson<T>(schema: object, opts: { model?: string; timeoutMs?: number } = {}): (system: string, prompt: string) => Promise<T> {
  return async (system, prompt) => {
    const args = [
      'claude',
      '-p',
      prompt,
      '--system-prompt',
      system,
      '--tools',
      '',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
      '--no-session-persistence',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      ...(opts.model ? ['--model', opts.model] : []),
    ];
    const proc = Bun.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', cwd: process.env.TMPDIR ?? '/tmp' });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 90_000);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(timer);
    await proc.exited;
    let parsed: { structured_output?: T; is_error?: boolean; result?: string };
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error(`claude -p failed: ${(err || out).trim().slice(0, 200) || `exit ${proc.exitCode}`}`);
    }
    if (parsed.is_error || !parsed.structured_output) throw new Error(`claude -p: ${String(parsed.result ?? 'no structured output').slice(0, 200)}`);
    return parsed.structured_output;
  };
}

/** The triage call. */
export const claudeAsk = (opts: { model?: string; timeoutMs?: number } = {}): Ask => claudeJson<Decision>(DECISION_SCHEMA, opts);
