import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec } from "../src/util/index.ts";

export interface RepoChange {
  files: Record<string, string>;
  message: string;
}

/** A throwaway git repo with an initial commit, plus an optional second commit (e.g. one mentioning the ticket). */
export async function makeGitRepo(root: string, name: string, files: Record<string, string>, change?: RepoChange): Promise<string> {
  const repo = join(root, name);
  // Neutralise global git config that can block or prompt (commit signing, hooks, autocrlf rewrites).
  const iso = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "-c", "core.autocrlf=false", "-c", "user.email=t@t", "-c", "user.name=t"];
  const write = async (fs: Record<string, string>) => {
    for (const [p, c] of Object.entries(fs)) {
      mkdirSync(dirname(join(repo, p)), { recursive: true });
      await Bun.write(join(repo, p), c);
    }
  };
  const git = (...a: string[]) => exec(["git", "-C", repo, ...iso, ...a], { timeoutMs: 30_000 });
  mkdirSync(repo, { recursive: true });
  await git("init", "-q");
  await write(files);
  await git("add", ".");
  await git("commit", "-q", "--no-verify", "-m", "initial");
  if (change) {
    await write(change.files);
    await git("add", ".");
    await git("commit", "-q", "--no-verify", "-m", change.message);
  }
  return repo;
}
