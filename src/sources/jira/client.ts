/** Read-only Jira Cloud REST v3 client. Only GET requests are possible through this class. */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class JiraClient {
  private readonly auth: string;

  constructor(
    private readonly baseUrl: string,
    email: string,
    token: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: { Authorization: this.auth, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jira GET ${path} failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  myself() {
    return this.get<{ accountId: string; displayName: string }>("/rest/api/3/myself");
  }

  issue(key: string) {
    return this.get<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      fields: "*all",
      expand: "renderedFields,names",
    });
  }

  remoteLinks(key: string) {
    return this.get<JiraRemoteLink[]>(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`);
  }

  /** Enhanced JQL search (GET /rest/api/3/search/jql), following nextPageToken. */
  async search(jql: string, max = 100): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const params: Record<string, string> = {
        jql,
        fields: "summary,issuetype,status",
        maxResults: String(Math.min(50, max - out.length)),
      };
      if (nextPageToken) params.nextPageToken = nextPageToken;
      const page = await this.get<{ issues: JiraIssue[]; nextPageToken?: string }>("/rest/api/3/search/jql", params);
      out.push(...page.issues);
      nextPageToken = page.nextPageToken;
    } while (nextPageToken && out.length < max);
    return out;
  }
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, any>;
  renderedFields?: Record<string, any>;
  names?: Record<string, string>;
}

export interface JiraRemoteLink {
  id: number;
  object: { url: string; title?: string };
  application?: { name?: string; type?: string };
}
