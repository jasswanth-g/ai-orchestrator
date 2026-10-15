import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The work repos the Investigator may read, and the seed for REPOS.md — the
 * "what each repo contains" knowledge file. Work repos are the git clones under
 * the repos root whose origin is the team's Azure DevOps org.
 */

export interface WorkRepo {
  name: string;
  path: string;
  remote: string;
}

export function workRepos(root: string, remoteMatch: string): WorkRepo[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, '.git')))
    .map((d) => {
      const r = Bun.spawnSync(['git', '-C', join(root, d.name), 'remote', 'get-url', 'origin']);
      // Drop any credentials embedded in the URL.
      return { name: d.name, path: join(root, d.name), remote: r.stdout.toString().trim().replace(/\/\/[^/@]+@/, '//') };
    })
    .filter((r) => r.remote.includes(remoteMatch))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A short "what this is" from CLAUDE.md / README.md: the first overview-like section, else the first paragraph. */
function describe(repoPath: string): string {
  for (const file of ['CLAUDE.md', 'README.md']) {
    const p = join(repoPath, file);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split('\n');
    const start = lines.findIndex((l) => /^#{1,3}\s*(what this is|project overview|overview|about|purpose|introduction)/i.test(l));
    const body = (start >= 0 ? lines.slice(start + 1) : lines)
      .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('<!--') && !/guidance (to|for) claude/i.test(l) && !/^this file provides/i.test(l))
      .slice(0, 4)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (body) return body.length > 500 ? `${body.slice(0, 500)}…` : body;
  }
  return '_No CLAUDE.md or README.md summary — explore and fill this in._';
}

const topLevel = (repoPath: string) =>
  readdirSync(repoPath, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== 'dist')
    .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
    .slice(0, 25)
    .join(', ');

/** Seed content for REPOS.md. Written once; after that the Investigator and you keep it current. */
export function repoIndexSeed(repos: WorkRepo[]): string {
  const head = `# Work repos

What each repo contains, for the Investigator. Seeded automatically from each
repo's CLAUDE.md / README.md; **the Investigator adds what it learns** under
"Learned" (which Application lives where, key folders, flows), and you can edit
it freely. Paths are absolute.
`;
  const entries = repos.map(
    (r) => `## ${r.name}

- Path: \`${r.path}\`
- Remote: ${r.remote}
- Top level: ${topLevel(r.path)}
- Summary: ${describe(r.path)}
- Applications: _unknown yet_
- Learned: _nothing yet_
`,
  );
  return [head, ...entries].join('\n');
}
