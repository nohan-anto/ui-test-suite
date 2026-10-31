/** Read-only git operations on local repos. Nothing here modifies a working tree or refs (except an opt-in fetch). */
import { exec, truncate } from "../util/index.ts";

async function git(repo: string, args: string[], timeoutMs = 60_000) {
  return exec(["git", "-C", repo, ...args], { timeoutMs });
}

export async function isGitRepo(repo: string): Promise<boolean> {
  return (await git(repo, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
}

export async function headSha(repo: string): Promise<string> {
  return (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
}

export async function fetchAll(repo: string): Promise<boolean> {
  return (await git(repo, ["fetch", "--all", "--quiet"], 300_000)).code === 0;
}

export async function hasCommit(repo: string, sha: string): Promise<boolean> {
  return (await git(repo, ["cat-file", "-e", `${sha}^{commit}`])).code === 0;
}

/** Is `sha` contained in the currently checked-out HEAD? Tells whether the local build includes the change. */
export async function isAncestorOfHead(repo: string, sha: string): Promise<boolean> {
  return (await git(repo, ["merge-base", "--is-ancestor", sha, "HEAD"])).code === 0;
}

export async function showStat(repo: string, sha: string): Promise<string> {
  return (await git(repo, ["show", "--stat", "--format=%H %an %ad%n%s%n%b", "--date=short", sha])).stdout;
}

export async function showDiff(repo: string, sha: string, maxChars = 50_000): Promise<string> {
  return truncate((await git(repo, ["show", "--format=", sha])).stdout, maxChars);
}

export async function logGrep(repo: string, term: string, max = 50): Promise<{ sha: string; subject: string }[]> {
  const r = await git(repo, ["log", "--all", `--max-count=${max}`, "-i", `--grep=${term}`, "--format=%H%x09%s"]);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split("\t");
      return { sha: sha!, subject: rest.join("\t") };
    });
}

export async function lsFiles(repo: string): Promise<string[]> {
  return (await git(repo, ["ls-files"], 120_000)).stdout.split("\n").filter(Boolean);
}

export async function changedFilesInCommit(repo: string, sha: string): Promise<string[]> {
  return (await git(repo, ["show", "--name-only", "--format=", sha])).stdout.split("\n").filter(Boolean);
}
