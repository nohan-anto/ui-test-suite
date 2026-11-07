/**
 * The only Jira client that writes: adds attachments and a comment to one issue, for `uitest publish`.
 * Kept separate from the read-only JiraClient so no other code path can modify Jira.
 */
import { basename } from "node:path";
import type { FetchFn } from "./client.ts";

export class JiraPublisher {
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

  private async call<T>(method: "GET" | "POST", path: string, body?: FormData | string, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: this.auth, Accept: "application/json", ...headers },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const hint = res.status === 403 || res.status === 401 ? " (does this token have permission to add comments and attachments?)" : "";
      throw new Error(`Jira ${method} ${path} failed: ${res.status} ${res.statusText}${hint} ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** File names already attached to the issue, so re-publishing doesn't upload duplicates. */
  async attachmentNames(key: string): Promise<Set<string>> {
    const issue = await this.call<{ fields: { attachment?: { filename: string }[] } }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=attachment`,
    );
    return new Set((issue.fields.attachment ?? []).map((a) => a.filename));
  }

  async attach(key: string, filePath: string, name = basename(filePath)): Promise<void> {
    const form = new FormData();
    form.append("file", Bun.file(filePath), name);
    await this.call("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, form, { "X-Atlassian-Token": "no-check" });
  }

  /** Comment in Jira wiki markup (REST v2), which can show attached images inline with !name|thumbnail!. */
  async comment(key: string, wikiBody: string): Promise<{ id: string }> {
    return this.call<{ id: string }>("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, JSON.stringify({ body: wikiBody }), {
      "Content-Type": "application/json",
    });
  }
}
