import type { BugNote } from '../agents-settings.ts';
import type { AdoClient } from '../ado/client.ts';
import { htmlToText, toPerson } from '../ado/events.ts';

/**
 * Builds BRIEF.md: everything the Investigator needs about one bug, gathered
 * up front so the session starts with the facts instead of hunting for them —
 * the bug and its repro steps, every comment, the parent Story's requirement
 * and acceptance criteria, the Feature above it, and my own notes.
 */

const idOf = (url: string) => Number(url.split('/').pop());

/** HTML → text, keeping image and link targets visible (screenshots live in ADO attachments). */
function richText(html: string | undefined): string {
  if (!html) return '';
  const withLinks = html
    .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, ' [image: $1] ')
    .replace(/<a[^>]*href="([^"#][^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)');
  return htmlToText(withLinks);
}

const section = (title: string, body: string) => (body.trim() ? `## ${title}\n\n${body.trim()}\n` : `## ${title}\n\n_(empty)_\n`);

export interface BriefFacts {
  bugId: number;
  title: string;
  application?: string;
  parentStoryId?: number;
  markdown: string;
}

export async function buildBrief(ado: AdoClient, bugId: number, notes: BugNote[]): Promise<BriefFacts> {
  const bug = await ado.workItem(bugId);
  const f = bug.fields;
  const parentId = bug.relations.find((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse')?.url;
  const related = bug.relations.filter((r) => r.rel === 'System.LinkTypes.Related').map((r) => idOf(r.url));
  const attachments = bug.relations.filter((r) => r.rel === 'AttachedFile').map((r) => `- ${r.attributes?.name ?? 'file'}: ${r.url}`);

  const parts: string[] = [];
  parts.push(`# Bug ${bugId}: ${f['System.Title']}\n`);
  parts.push(
    [
      `- Link: ${ado.bugUrl(bugId)}`,
      `- State: ${f['System.State']}${f['System.Reason'] ? ` (${f['System.Reason']})` : ''}`,
      f['Custom.Application'] && `- Application: ${f['Custom.Application']}`,
      f['Microsoft.VSTS.Common.Severity'] && `- Severity: ${f['Microsoft.VSTS.Common.Severity']}`,
      f['Microsoft.VSTS.Common.Priority'] && `- Priority: ${f['Microsoft.VSTS.Common.Priority']}`,
      `- Raised by: ${toPerson(f['System.CreatedBy'])?.name ?? '?'} on ${String(f['System.CreatedDate']).slice(0, 10)}`,
      f['System.AssignedTo'] && `- Assigned to: ${toPerson(f['System.AssignedTo'])?.name}`,
      `- Iteration: ${f['System.IterationPath']}`,
      related.length ? `- Related work items: ${related.join(', ')}` : undefined,
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );
  parts.push(section('Repro steps', richText(f['Microsoft.VSTS.TCM.ReproSteps'])));
  if (f['System.Description']) parts.push(section('Description', richText(f['System.Description'])));
  if (f['Microsoft.VSTS.TCM.SystemInfo']) parts.push(section('System info', richText(f['Microsoft.VSTS.TCM.SystemInfo'])));
  if (attachments.length) parts.push(section('Attachments', attachments.join('\n')));

  const comments = await ado.commentThread(bugId);
  parts.push(
    section(
      `Comments (${comments.length})`,
      comments.map((c) => `**${c.by}** — ${c.at.slice(0, 16).replace('T', ' ')}\n\n${richText(c.html)}`).join('\n\n---\n\n'),
    ),
  );

  let parentStoryId: number | undefined;
  if (parentId) {
    parentStoryId = idOf(parentId);
    const story = await ado.workItem(parentStoryId);
    const sf = story.fields;
    parts.push(`# Requirement — ${sf['System.WorkItemType']} ${parentStoryId}: ${sf['System.Title']}\n\n- Link: ${ado.bugUrl(parentStoryId)}\n- State: ${sf['System.State']}\n`);
    parts.push(section('Story description', richText(sf['System.Description'])));
    parts.push(section('Acceptance criteria', richText(sf['Microsoft.VSTS.Common.AcceptanceCriteria'])));
    const featureUrl = story.relations.find((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse')?.url;
    if (featureUrl) {
      const feature = await ado.workItem(idOf(featureUrl));
      parts.push(`Parent ${feature.fields['System.WorkItemType']} ${feature.id}: ${feature.fields['System.Title']} (${ado.bugUrl(feature.id)})\n`);
    }
  } else {
    parts.push('# Requirement\n\n_No parent Story is linked to this bug. Say so in the report; look for the requirement by title/area if needed._\n');
  }

  parts.push(
    section(
      "Developer's notes (from the dashboard — use these, they come from the person you report to)",
      notes.map((n) => `- **${n.type === 'recommendation' ? 'Recommendation' : 'Comment'}** (${n.at.slice(0, 10)}): ${n.text}`).join('\n'),
    ),
  );

  return { bugId, title: f['System.Title'], application: f['Custom.Application'] || undefined, parentStoryId, markdown: parts.join('\n') };
}
