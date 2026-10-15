#!/usr/bin/env bun
import { AdoClient, adoConfig } from './ado/client.ts';

/**
 * Manages the ADO service hooks that feed src/ado-webhook.ts.
 *
 *   bun run ado-hooks list
 *   bun run ado-hooks create https://<public-host>     (needs ADO_HOOK_SECRET)
 *   bun run ado-hooks delete                          (removes the ones pointing at /hooks/ado)
 */

const EVENTS = ['workitem.created', 'workitem.updated', 'workitem.commented'] as const;
const PATH = '/hooks/ado';

const ado = new AdoClient(adoConfig());
const [cmd, base] = process.argv.slice(2);

const ours = async () => (await ado.listSubscriptions()).value.filter((s) => s.consumerInputs?.url?.endsWith(PATH));

if (cmd === 'list') {
  for (const s of await ours()) console.log(`${s.id}  ${s.eventType}  ${s.status}  ${s.consumerInputs.url}`);
} else if (cmd === 'create') {
  const secret = process.env.ADO_HOOK_SECRET;
  if (!base || !secret) throw new Error('usage: ADO_HOOK_SECRET=… bun run ado-hooks create https://<public-host>');
  const url = `${base.replace(/\/$/, '')}${PATH}`;
  const projectId = await ado.projectId();
  for (const eventType of EVENTS) {
    const { id } = await ado.createSubscription({
      publisherId: 'tfs',
      eventType,
      resourceVersion: '1.0',
      consumerId: 'webHooks',
      consumerActionId: 'httpRequest',
      publisherInputs: { projectId, workItemType: 'Bug' },
      consumerInputs: {
        url,
        basicAuthUsername: 'ado',
        basicAuthPassword: secret,
        resourceDetailsToSend: 'all',
        messagesToSend: 'none',
        detailedMessagesToSend: 'none',
      },
    });
    console.log(`created ${eventType} → ${url} (${id})`);
  }
} else if (cmd === 'delete') {
  for (const s of await ours()) {
    const res = await ado.deleteSubscription(s.id);
    console.log(`deleted ${s.eventType} ${s.id}: ${res.status}`);
  }
} else {
  console.log('usage: bun run ado-hooks list | create https://<public-host> | delete');
}
