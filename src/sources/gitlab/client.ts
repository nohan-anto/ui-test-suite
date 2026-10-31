/** Read-only GitLab REST v4 client. Only GET requests are possible through this class. */
import type { FetchFn } from "../jira/client.ts";

export class GitLabClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null | undefined,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}/api/v4${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers["PRIVATE-TOKEN"] = this.token;
    const res = await this.fetchFn(url, { method: "GET", headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitLab GET ${path} failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  private pid(project: string) {
    return `/projects/${encodeURIComponent(project)}`;
  }

  user() {
    return this.get<{ username: string }>("/user");
  }

  mergeRequest(project: string, iid: number) {
    return this.get<GitLabMR>(`${this.pid(project)}/merge_requests/${iid}`);
  }

  mrDiffs(project: string, iid: number) {
    return this.get<GitLabDiff[]>(`${this.pid(project)}/merge_requests/${iid}/diffs`, { per_page: "100" });
  }

  mrCommits(project: string, iid: number) {
    return this.get<GitLabCommit[]>(`${this.pid(project)}/merge_requests/${iid}/commits`, { per_page: "100" });
  }

  mrNotes(project: string, iid: number) {
    return this.get<GitLabNote[]>(`${this.pid(project)}/merge_requests/${iid}/notes`, {
      per_page: "100",
      sort: "asc",
    });
  }

  searchMergeRequests(project: string, term: string) {
    return this.get<GitLabMR[]>(`${this.pid(project)}/merge_requests`, {
      search: term,
      in: "title,description",
      state: "all",
      per_page: "50",
    });
  }

  branches(project: string, search: string) {
    return this.get<{ name: string }[]>(`${this.pid(project)}/repository/branches`, { search, per_page: "50" });
  }

  mergeRequestsForBranch(project: string, branch: string) {
    return this.get<GitLabMR[]>(`${this.pid(project)}/merge_requests`, {
      source_branch: branch,
      state: "all",
      per_page: "20",
    });
  }
}

export interface GitLabMR {
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  sha?: string;
  author?: { username: string };
  merged_at?: string | null;
  references?: { full?: string };
}

export interface GitLabDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  diff: string;
}

export interface GitLabCommit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  created_at: string;
}

export interface GitLabNote {
  body: string;
  system: boolean;
  author?: { username: string };
  created_at: string;
}
