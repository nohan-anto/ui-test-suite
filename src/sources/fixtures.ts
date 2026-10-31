/**
 * Offline fetch that serves recorded API responses from a directory, for tests and `--fixtures` dry runs.
 * File name = URL path (without query) with "/" replaced by "__", e.g.
 *   /rest/api/3/issue/DEMO-1            → jira/rest__api__3__issue__DEMO-1.json
 *   /api/v4/projects/g%2Fweb/merge_requests/7 → gitlab/api__v4__projects__g%2Fweb__merge_requests__7.json
 * JQL searches map to jira/search__<jql with non-word chars as _>.json. Missing files return 404.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "./jira/client.ts";

export function fixtureFetch(dir: string, sub: "jira" | "gitlab"): FetchFn {
  return async (url: string) => {
    const u = new URL(url);
    let name = u.pathname.replace(/^\/+/, "").replace(/\//g, "__");
    if (u.pathname.endsWith("/search/jql")) name = `search__${(u.searchParams.get("jql") ?? "").replace(/\W+/g, "_")}`;
    const file = join(dir, sub, `${name}.json`);
    if (!existsSync(file)) {
      // Unrecorded list endpoints default to an empty list.
      if (/merge_requests$|branches$|remotelink$|diffs$|commits$|notes$/.test(u.pathname)) return Response.json([]);
      return new Response(`fixture not found: ${file}`, { status: 404, statusText: "Not Found" });
    }
    return new Response(await Bun.file(file).text(), { headers: { "content-type": "application/json" } });
  };
}
