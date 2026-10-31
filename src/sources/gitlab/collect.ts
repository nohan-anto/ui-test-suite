import type { RepoConfig } from "../../config/schema.ts";
import { truncate, uniq } from "../../util/index.ts";
import type { GitLabClient, GitLabCommit, GitLabDiff, GitLabMR } from "./client.ts";

export interface MrRef {
  project: string; // full path, e.g. group/sub/repo
  iid: number;
}

export interface CollectedMR {
  ref: MrRef;
  mr: GitLabMR;
  diffs: GitLabDiff[];
  commits: GitLabCommit[];
  discussion: { author: string; body: string }[];
  foundVia: string[];
}

/** Extract GitLab MR references (full URLs) from free text. */
export function extractMrRefs(text: string, gitlabBaseUrl: string): MrRef[] {
  const host = new URL(gitlabBaseUrl).host.replace(/\./g, "\\.");
  const re = new RegExp(`https?://${host}/([\\w.\\-/]+?)/-/merge_requests/(\\d+)`, "g");
  const seen = new Set<string>();
  const out: MrRef[] = [];
  for (const m of text.matchAll(re)) {
    const ref = { project: m[1]!, iid: Number(m[2]) };
    const id = `${ref.project}!${ref.iid}`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(ref);
    }
  }
  return out;
}

/** Short refs like "group/repo!123" in text. */
export function extractShortMrRefs(text: string): MrRef[] {
  const out: MrRef[] = [];
  for (const m of text.matchAll(/(?<![\w/])([\w.\-]+(?:\/[\w.\-]+)+)!(\d+)\b/g)) {
    out.push({ project: m[1]!, iid: Number(m[2]) });
  }
  return out;
}

export interface MrCollectOptions {
  ticketKeys: string[];
  texts: { source: string; text: string }[];
  repos: RepoConfig[];
  searchByKey: boolean;
  maxDiffBytes: number;
  log?: (msg: string) => void;
}

export async function collectMergeRequests(client: GitLabClient, gitlabBaseUrl: string, opts: MrCollectOptions) {
  const found = new Map<string, { ref: MrRef; via: Set<string> }>();
  const add = (ref: MrRef, via: string) => {
    const id = `${ref.project}!${ref.iid}`;
    if (!found.has(id)) found.set(id, { ref, via: new Set() });
    found.get(id)!.via.add(via);
  };

  for (const { source, text } of opts.texts) {
    for (const ref of [...extractMrRefs(text, gitlabBaseUrl), ...extractShortMrRefs(text)]) add(ref, source);
  }

  if (opts.searchByKey) {
    const projects = uniq(opts.repos.map((r) => r.gitlabProject).filter((p): p is string => !!p));
    for (const project of projects) {
      for (const key of opts.ticketKeys) {
        try {
          for (const mr of await client.searchMergeRequests(project, key)) add({ project, iid: mr.iid }, `search:${key}`);
          for (const b of await client.branches(project, key)) {
            for (const mr of await client.mergeRequestsForBranch(project, b.name))
              add({ project, iid: mr.iid }, `branch:${b.name}`);
          }
        } catch (e) {
          opts.log?.(`GitLab search in ${project} for ${key} failed: ${(e as Error).message}`);
        }
      }
    }
  }

  const out: CollectedMR[] = [];
  for (const { ref, via } of found.values()) {
    try {
      const [mr, diffs, commits, notes] = await Promise.all([
        client.mergeRequest(ref.project, ref.iid),
        client.mrDiffs(ref.project, ref.iid).catch(() => []),
        client.mrCommits(ref.project, ref.iid).catch(() => []),
        client.mrNotes(ref.project, ref.iid).catch(() => []),
      ]);
      let budget = opts.maxDiffBytes;
      const trimmed = diffs.map((d) => {
        const diff = truncate(d.diff, Math.max(0, budget));
        budget -= diff.length;
        return { ...d, diff };
      });
      out.push({
        ref,
        mr,
        diffs: trimmed,
        commits,
        discussion: notes.filter((n) => !n.system).map((n) => ({ author: n.author?.username ?? "?", body: n.body })),
        foundVia: [...via],
      });
    } catch (e) {
      opts.log?.(`Could not load MR ${ref.project}!${ref.iid}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function mrsToMarkdown(mrs: CollectedMR[]): string {
  if (!mrs.length) return "# Merge requests\n\n_No merge requests found for this ticket._\n";
  const parts = ["# Merge requests", ""];
  for (const c of mrs) {
    parts.push(
      `## ${c.ref.project}!${c.ref.iid}: ${c.mr.title}`,
      "",
      `- **State:** ${c.mr.state}${c.mr.merged_at ? ` (merged ${c.mr.merged_at.slice(0, 10)})` : ""}`,
      `- **Branch:** ${c.mr.source_branch} → ${c.mr.target_branch}`,
      `- **URL:** ${c.mr.web_url}`,
      `- **Found via:** ${c.foundVia.join(", ")}`,
      "",
      "### Description",
      "",
      c.mr.description?.trim() || "_(empty)_",
      "",
      "### Commits",
      "",
      ...c.commits.map((k) => `- \`${k.short_id}\` ${k.title} (${k.author_name})`),
      "",
      "### Changed files",
      "",
      ...c.diffs.map((d) => `- ${d.new_file ? "A" : d.deleted_file ? "D" : d.renamed_file ? "R" : "M"} ${d.new_path}`),
      "",
    );
    if (c.discussion.length) {
      parts.push("### Discussion", "", ...c.discussion.map((n) => `- **${n.author}:** ${n.body.replace(/\n/g, " ")}`), "");
    }
    parts.push("### Diff", "", "```diff", ...c.diffs.map((d) => `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff}`), "```", "");
  }
  return parts.join("\n");
}
