/** Deterministic context gathering for the plan phase: Jira → MRs → local repos → impact → context bundle on disk. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { secretsOf } from "../config/load.ts";
import type { Config, RepoConfig } from "../config/schema.ts";
import { mergeChange, parseFileDiff, parseMultiFileDiff, type RepoChanges } from "../repos/diff.ts";
import { fetchAll, hasCommit, isAncestorOfHead, isGitRepo, logGrep, showPatch } from "../repos/git.ts";
import { GraphqlLinker, graphqlChainsToMarkdown } from "../repos/graphql-impact.ts";
import { computeImpact, impactToMarkdown, linkDownstream, RepoGraph, type RepoImpact } from "../repos/impact.ts";
import { getIndex, indexSummaryMarkdown, type RepoIndex } from "../repos/indexer.ts";
import type { GitLabClient } from "../sources/gitlab/client.ts";
import { collectMergeRequests, mrsToMarkdown, sameProject, type CollectedMR } from "../sources/gitlab/collect.ts";
import type { JiraClient } from "../sources/jira/client.ts";
import { collectTicket, storyText, storyToMarkdown, type TicketBundle } from "../sources/jira/collect.ts";
import { redact, writeText } from "../util/index.ts";

export interface RepoState {
  name: string;
  role: RepoConfig["role"];
  path: string;
  head: string;
  /** For each MR commit: present locally, and included in the checked-out HEAD. */
  commits: { sha: string; mr?: string; present: boolean; inHead: boolean }[];
  localKeyCommits: { sha: string; subject: string }[];
  note?: string;
}

export interface ContextManifest {
  ticket: string;
  title: string;
  isEpic: boolean;
  children: string[];
  createdAt: string;
  mergeRequests: { ref: string; title: string; state: string; url: string; sha?: string | null; repo?: string }[];
  repos: RepoState[];
  files: string[];
}

export interface ContextDeps {
  jira: JiraClient;
  gitlab: GitLabClient | null;
  log: (msg: string) => void;
}

export async function buildContext(cfg: Config, ticket: string, contextDir: string, deps: ContextDeps) {
  const { log } = deps;
  const secrets = secretsOf(cfg);
  const write = (rel: string, content: string) => writeText(join(contextDir, rel), redact(content, secrets));
  const files: string[] = [];

  log(`Fetching ${ticket} from Jira…`);
  const bundle: TicketBundle = await collectTicket(deps.jira, ticket, {
    baseUrl: cfg.jira.baseUrl,
    acceptanceCriteriaField: cfg.jira.acceptanceCriteriaField,
    includeComments: cfg.jira.includeComments,
    maxChildren: cfg.jira.maxChildren,
  });
  await write("story.md", storyToMarkdown(bundle.root));
  files.push("story.md");
  if (bundle.isEpic) log(`${ticket} is an epic with ${bundle.children.length} child issues.`);
  for (const c of bundle.children) {
    await write(`children/${c.key}.md`, storyToMarkdown(c));
    files.push(`children/${c.key}.md`);
  }

  const allStories = [bundle.root, ...bundle.children];
  let mrs: CollectedMR[] = [];
  if (deps.gitlab) {
    log("Looking for merge requests…");
    mrs = await collectMergeRequests(deps.gitlab, cfg.gitlab.baseUrl, {
      ticketKeys: allStories.map((s) => s.key),
      texts: allStories.map((s) => ({ source: `jira:${s.key}`, text: storyText(s) })),
      repos: cfg.repos,
      searchByKey: cfg.gitlab.searchByKey,
      maxDiffBytes: cfg.gitlab.maxDiffBytes,
      log,
    });
    log(`Found ${mrs.length} merge request(s).`);
  }
  await write("mrs.md", mrsToMarkdown(mrs));
  files.push("mrs.md");

  const { repoStates, impacts, indexes, graphqlMd } = await analyseRepos(cfg, allStories.map((s) => s.key), mrs, log);
  for (const ix of indexes) {
    await write(`repos/${ix.repo}.md`, indexSummaryMarkdown(ix));
    files.push(`repos/${ix.repo}.md`);
  }
  await write("impact.md", [impactToMarkdown(impacts), graphqlMd, repoStatesMarkdown(repoStates)].filter(Boolean).join("\n"));
  files.push("impact.md");

  const manifest: ContextManifest = {
    ticket,
    title: bundle.root.summary,
    isEpic: bundle.isEpic,
    children: bundle.children.map((c) => c.key),
    createdAt: new Date().toISOString(),
    mergeRequests: mrs.map((m) => ({
      ref: `${m.ref.project}!${m.ref.iid}`,
      title: m.mr.title,
      state: m.mr.state,
      url: m.mr.web_url,
      sha: m.mr.merge_commit_sha ?? m.mr.squash_commit_sha ?? m.mr.sha,
      repo: cfg.repos.find((r) => sameProject(r.gitlabProject, m.ref.project))?.name,
    })),
    repos: repoStates,
    files,
  };
  await writeText(join(contextDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { manifest, bundle, mrs };
}

async function analyseRepos(cfg: Config, keys: string[], mrs: CollectedMR[], log: (m: string) => void) {
  const repoStates: RepoState[] = [];
  const impacts: RepoImpact[] = [];
  const indexes: RepoIndex[] = [];
  const graphs = new Map<string, RepoGraph>();
  const changes = new Map<string, RepoChanges>();

  for (const repo of cfg.repos) {
    if (!existsSync(repo.path) || !(await isGitRepo(repo.path))) {
      log(`Skipping repo ${repo.name}: ${repo.path} is not a git repository.`);
      continue;
    }
    if (cfg.indexing.fetchBeforeIndex) {
      log(`git fetch in ${repo.name}…`);
      await fetchAll(repo.path);
    }
    const repoMrs = mrs.filter((m) => sameProject(m.ref.project, repo.gitlabProject));
    const state: RepoState = { name: repo.name, role: repo.role, path: repo.path, head: "", commits: [], localKeyCommits: [] };
    for (const m of repoMrs) {
      for (const c of m.commits) {
        const present = await hasCommit(repo.path, c.id);
        state.commits.push({ sha: c.id, mr: `!${m.ref.iid}`, present, inHead: present && (await isAncestorOfHead(repo.path, c.id)) });
      }
    }
    for (const k of keys) state.localKeyCommits.push(...(await logGrep(repo.path, k)));
    state.localKeyCommits = [...new Map(state.localKeyCommits.map((c) => [c.sha, c])).values()];

    // Changed files with line ranges, from MR diffs and local commits that mention the ticket.
    const repoChanges: RepoChanges = new Map();
    for (const m of repoMrs) for (const d of m.diffs) if (!d.deleted_file) mergeChange(repoChanges, d.new_path, parseFileDiff(d.diff));
    for (const c of state.localKeyCommits) {
      for (const [f, ch] of parseMultiFileDiff(await showPatch(repo.path, c.sha))) mergeChange(repoChanges, f, ch);
    }
    changes.set(repo.name, repoChanges);

    if (cfg.indexing.enabled) {
      const { index, cached } = await getIndex(repo, { exclude: cfg.indexing.exclude, cacheDir: cfg.indexing.cacheDir });
      log(`Index ${repo.name}: ${cached ? "cached" : "built"} (${index.files.length} files, ${index.routes.length} routes).`);
      indexes.push(index);
      const graph = new RepoGraph(index);
      graphs.set(repo.name, graph);
      state.head = index.headSha;
      const changed = [...repoChanges.keys()].filter((f) => index.files.includes(f));
      if (changed.length) impacts.push(await computeImpact(index, changed, 2, graph));
    }
    const missing = state.commits.filter((c) => !c.inHead).length;
    if (missing) state.note = `${missing} MR commit(s) are not in the checked-out HEAD, so local code may not match the MR.`;
    repoStates.push(state);
  }
  linkDownstream(impacts, indexes);
  const { chains, hints } = await new GraphqlLinker(indexes, graphs).build(changes);
  if (chains.length) log(`GraphQL: traced ${chains.length} changed field/operation chain(s) across repos.`);
  return { repoStates, impacts, indexes, graphqlMd: graphqlChainsToMarkdown(chains, hints) };
}

function repoStatesMarkdown(states: RepoState[]): string {
  if (!states.length) return "";
  const out = ["## Local repo state", ""];
  for (const s of states) {
    out.push(`### ${s.name} (${s.role}) — HEAD ${s.head.slice(0, 10)}`, "");
    if (s.note) out.push(`> ⚠️ ${s.note}`, "");
    for (const c of s.commits) out.push(`- ${c.mr} \`${c.sha.slice(0, 10)}\` ${c.present ? (c.inHead ? "in HEAD" : "present, not in HEAD") : "not fetched locally"}`);
    if (s.localKeyCommits.length) {
      out.push("", "Local commits mentioning the ticket:", "", ...s.localKeyCommits.map((c) => `- \`${c.sha.slice(0, 10)}\` ${c.subject}`));
    }
    out.push("");
  }
  return out.join("\n");
}

