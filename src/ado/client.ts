import { type Bug, bugFrom } from './events.ts';
import type { Me } from './intake.ts';

/**
 * Thin Azure DevOps REST client. Auth borrows the `az login` session
 * (`az account get-access-token`), so there is no PAT to store.
 */

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const API = 'api-version=7.0';

export interface AdoConfig {
  /** e.g. https://dev.azure.com/xavica */
  org: string;
  project: string;
}

export class AdoClient {
  private token?: { value: string; until: number };

  constructor(readonly cfg: AdoConfig) {}

  private get orgName() {
    return new URL(this.cfg.org).pathname.replace(/\//g, '');
  }
  private get projectUrl() {
    return `${this.cfg.org}/${encodeURIComponent(this.cfg.project)}`;
  }

  bugUrl = (id: number) => `${this.projectUrl}/_workitems/edit/${id}`;

  private bearer(): string {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const r = Bun.spawnSync(['az', 'account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv']);
    const value = r.stdout.toString().trim();
    if (r.exitCode !== 0 || !value) throw new Error(`az token failed — run \`az login\`: ${r.stderr.toString().trim()}`);
    this.token = { value, until: Date.now() + 45 * 60_000 };
    return value;
  }

  async call<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${this.bearer()}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    });
    if (!res.ok) throw new Error(`ADO ${init.method ?? 'GET'} ${url} → ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** My identity id (what a direct @mention carries) and email. */
  async me(): Promise<Me> {
    const email = Bun.spawnSync(['az', 'account', 'show', '--query', 'user.name', '-o', 'tsv']).stdout.toString().trim().toLowerCase();
    if (!email) throw new Error('not logged in to az — run `az login`');
    const found = await this.call<{ value: Array<{ id: string }> }>(
      `https://vssps.dev.azure.com/${this.orgName}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(email)}&${API}`,
    );
    const self = found.value[0];
    if (!self) throw new Error(`no ADO identity for ${email}`);
    return { email, identityId: self.id.toLowerCase() };
  }

  /** Comment HTML on a work item, oldest first (first 200). */
  async comments(id: number): Promise<string[]> {
    const r = await this.call<{ comments: Array<{ text: string }> }>(
      `${this.projectUrl}/_apis/wit/workItems/${id}/comments?api-version=7.0-preview.3&$top=200&order=asc`,
    );
    return r.comments.map((c) => c.text);
  }

  async wiql(query: string): Promise<number[]> {
    const r = await this.call<{ workItems: Array<{ id: number }> }>(`${this.projectUrl}/_apis/wit/wiql?${API}`, {
      method: 'POST',
      body: { query },
    });
    return r.workItems.map((w) => w.id);
  }

  async bugs(ids: number[]): Promise<Bug[]> {
    const out: Bug[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const r = await this.call<{ value: Array<{ id: number; fields: Record<string, any> }> }>(
        `${this.cfg.org}/_apis/wit/workitems?ids=${chunk.join(',')}&${API}`,
      );
      out.push(...r.value.map((w) => bugFrom(w.id, w.fields)));
    }
    return out;
  }

  async projectId(): Promise<string> {
    return (await this.call<{ id: string }>(`${this.cfg.org}/_apis/projects/${encodeURIComponent(this.cfg.project)}?${API}`)).id;
  }

  listSubscriptions() {
    return this.call<{ value: Array<{ id: string; eventType: string; consumerInputs: Record<string, string>; status: string }> }>(
      `${this.cfg.org}/_apis/hooks/subscriptions?${API}`,
    );
  }

  createSubscription(body: unknown) {
    return this.call<{ id: string }>(`${this.cfg.org}/_apis/hooks/subscriptions?${API}`, { method: 'POST', body });
  }

  deleteSubscription(id: string) {
    return fetch(`${this.cfg.org}/_apis/hooks/subscriptions/${id}?${API}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.bearer()}` },
    });
  }
}

/** Env → client config. Defaults are the Qwipo B2B project. */
export const adoConfig = (): AdoConfig => ({
  org: process.env.ADO_ORG ?? 'https://dev.azure.com/xavica',
  project: process.env.ADO_PROJECT ?? 'Qwipo B2B',
});
