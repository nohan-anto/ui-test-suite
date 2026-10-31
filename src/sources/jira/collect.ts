import { adfToMarkdown } from "./adf-to-md.ts";
import type { JiraClient, JiraIssue } from "./client.ts";

export interface Story {
  key: string;
  url: string;
  type: string;
  summary: string;
  status: string;
  priority?: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  description: string;
  acceptanceCriteria?: string;
  comments: { author: string; created: string; body: string }[];
  attachments: { filename: string; mimeType: string; url: string }[];
  subtasks: { key: string; summary: string; status: string }[];
  links: { relation: string; key: string; summary: string; status: string }[];
  remoteLinks: { title: string; url: string }[];
}

export interface TicketBundle {
  root: Story;
  isEpic: boolean;
  children: Story[];
}

export interface CollectOptions {
  baseUrl: string;
  acceptanceCriteriaField?: string | null;
  includeComments: boolean;
  maxChildren: number;
}

export function isEpic(issue: JiraIssue): boolean {
  const t = issue.fields.issuetype;
  return t?.name?.toLowerCase() === "epic" || t?.hierarchyLevel === 1;
}

export function toStory(issue: JiraIssue, remote: { title: string; url: string }[], opts: CollectOptions): Story {
  const f = issue.fields;
  const acField = opts.acceptanceCriteriaField ?? findAcField(issue);
  return {
    key: issue.key,
    url: `${opts.baseUrl.replace(/\/+$/, "")}/browse/${issue.key}`,
    type: f.issuetype?.name ?? "Unknown",
    summary: f.summary ?? "",
    status: f.status?.name ?? "",
    priority: f.priority?.name,
    labels: f.labels ?? [],
    components: (f.components ?? []).map((c: any) => c.name),
    fixVersions: (f.fixVersions ?? []).map((v: any) => v.name),
    description: adfToMarkdown(f.description),
    acceptanceCriteria: acField && f[acField] ? adfToMarkdown(f[acField]) : undefined,
    comments: opts.includeComments
      ? (f.comment?.comments ?? []).map((c: any) => ({
          author: c.author?.displayName ?? "unknown",
          created: c.created ?? "",
          body: adfToMarkdown(c.body),
        }))
      : [],
    attachments: (f.attachment ?? []).map((a: any) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      url: a.content,
    })),
    subtasks: (f.subtasks ?? []).map((s: any) => ({
      key: s.key,
      summary: s.fields?.summary ?? "",
      status: s.fields?.status?.name ?? "",
    })),
    links: (f.issuelinks ?? []).map((l: any) => {
      const other = l.outwardIssue ?? l.inwardIssue;
      return {
        relation: l.outwardIssue ? l.type?.outward : l.type?.inward,
        key: other?.key,
        summary: other?.fields?.summary ?? "",
        status: other?.fields?.status?.name ?? "",
      };
    }),
    remoteLinks: remote,
  };
}

/** Find a custom field named like "Acceptance Criteria" using the `names` expansion. */
function findAcField(issue: JiraIssue): string | undefined {
  const names = issue.names ?? {};
  return Object.keys(names).find((id) => /acceptance\s*criteria/i.test(names[id] ?? ""));
}

async function fetchStory(client: JiraClient, key: string, opts: CollectOptions): Promise<{ issue: JiraIssue; story: Story }> {
  const issue = await client.issue(key);
  const remote = await client
    .remoteLinks(key)
    .then((ls) => ls.map((l) => ({ title: l.object.title ?? l.object.url, url: l.object.url })))
    .catch(() => []);
  return { issue, story: toStory(issue, remote, opts) };
}

export async function collectTicket(client: JiraClient, key: string, opts: CollectOptions): Promise<TicketBundle> {
  const { issue, story: root } = await fetchStory(client, key, opts);
  const epic = isEpic(issue);
  const children: Story[] = [];
  if (epic) {
    let kids = await client.search(`parent = ${key} ORDER BY rank`, opts.maxChildren).catch(() => []);
    if (!kids.length) {
      kids = await client.search(`"Epic Link" = ${key} ORDER BY rank`, opts.maxChildren).catch(() => []);
    }
    for (const k of kids) children.push((await fetchStory(client, k.key, opts)).story);
  }
  return { root, isEpic: epic, children };
}

/** All free text of a story (description, AC, comments, remote links) for link scanning. */
export function storyText(s: Story): string {
  return [
    s.description,
    s.acceptanceCriteria ?? "",
    ...s.comments.map((c) => c.body),
    ...s.remoteLinks.map((r) => r.url),
  ].join("\n");
}

export function storyToMarkdown(s: Story): string {
  const meta: [string, string | undefined][] = [
    ["Type", s.type],
    ["Status", s.status],
    ["Priority", s.priority],
    ["Labels", s.labels.join(", ")],
    ["Components", s.components.join(", ")],
    ["Fix versions", s.fixVersions.join(", ")],
    ["URL", s.url],
  ];
  const lines = [
    `# ${s.key}: ${s.summary}`,
    "",
    ...meta.filter(([, v]) => v).map(([k, v]) => `- **${k}:** ${v}`),
    "",
    "## Description",
    "",
    s.description || "_(empty)_",
  ];
  if (s.acceptanceCriteria) lines.push("", "## Acceptance Criteria", "", s.acceptanceCriteria);
  if (s.subtasks.length)
    lines.push("", "## Sub-tasks", "", ...s.subtasks.map((t) => `- ${t.key} [${t.status}] ${t.summary}`));
  if (s.links.length)
    lines.push("", "## Linked issues", "", ...s.links.map((l) => `- ${l.relation} ${l.key} [${l.status}] ${l.summary}`));
  if (s.remoteLinks.length)
    lines.push("", "## Remote links", "", ...s.remoteLinks.map((r) => `- [${r.title}](${r.url})`));
  if (s.attachments.length)
    lines.push("", "## Attachments", "", ...s.attachments.map((a) => `- ${a.filename} (${a.mimeType})`));
  if (s.comments.length)
    lines.push(
      "",
      "## Comments",
      "",
      ...s.comments.map((c) => `### ${c.author} — ${c.created.slice(0, 10)}\n\n${c.body}\n`),
    );
  return lines.join("\n") + "\n";
}
