/**
 * Verify the user's Chrome is reachable and a signed-in tab for the app is open.
 * Uses the DevTools HTTP endpoints only; never reads cookies or credentials.
 */
import type { Config } from "../config/schema.ts";
import type { FetchFn } from "../sources/jira/client.ts";

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface PreflightResult {
  ok: boolean;
  mode: "browserUrl" | "autoConnect";
  browser?: string;
  tab?: CdpTarget;
  problems: string[];
}

export function pickTab(targets: CdpTarget[], cfg: Config["browser"]): CdpTarget | undefined {
  const pages = targets.filter((t) => t.type === "page");
  const match = cfg.tabMatch ?? new URL(cfg.appBaseUrl).host;
  return pages.find((t) => t.url.includes(match));
}

export function signInProblem(tab: CdpTarget, cfg: Config["browser"]): string | null {
  const ssoHost = cfg.loggedInCheck.notUrlContains.find((s) => tab.url.includes(s));
  return ssoHost ? `Tab is on the sign-in page (${ssoHost}). Sign in through OneLogin in that tab, then re-run.` : null;
}

/** Evaluate a boolean expression in a tab over CDP (used only for the optional logged-in selector). */
async function evaluateInTab(wsUrl: string, expression: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("CDP evaluate timed out"));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result?.result?.value);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("CDP websocket error"));
    };
  });
}

export async function preflight(cfg: Config, fetchFn: FetchFn = fetch): Promise<PreflightResult> {
  const b = cfg.browser;
  if (b.autoConnect) {
    // chrome-devtools-mcp --autoConnect attaches through Chrome's own remote-debugging toggle; there is no
    // HTTP endpoint to probe, so the agent verifies the tab itself as its first step.
    return { ok: true, mode: "autoConnect", problems: [] };
  }
  const base = b.browserUrl.replace(/\/+$/, "");
  const problems: string[] = [];
  let browser: string | undefined;
  try {
    const v = (await (await fetchFn(`${base}/json/version`)).json()) as { Browser?: string };
    browser = v.Browser;
  } catch {
    return {
      ok: false,
      mode: "browserUrl",
      problems: [
        `Chrome is not reachable at ${base}. Start Chrome with remote debugging, e.g.\n` +
          `    google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.uitest-chrome"\n` +
          `  (Chrome 136+ ignores the port on the default profile), or set browser.autoConnect: true (Chrome 144+).`,
      ],
    };
  }
  const targets = (await (await fetchFn(`${base}/json/list`)).json()) as CdpTarget[];
  const tab = pickTab(targets, b);
  if (!tab) {
    problems.push(`No open tab matches "${b.tabMatch ?? new URL(b.appBaseUrl).host}". Open ${b.appBaseUrl} and sign in.`);
    return { ok: false, mode: "browserUrl", browser, problems };
  }
  const sso = signInProblem(tab, b);
  if (sso) problems.push(sso);
  if (!sso && b.loggedInCheck.selector && tab.webSocketDebuggerUrl) {
    try {
      const found = await evaluateInTab(tab.webSocketDebuggerUrl, `!!document.querySelector(${JSON.stringify(b.loggedInCheck.selector)})`);
      if (!found) problems.push(`Signed-in marker "${b.loggedInCheck.selector}" not found in tab ${tab.url}. Are you signed in?`);
    } catch (e) {
      problems.push(`Could not check signed-in marker: ${(e as Error).message}`);
    }
  }
  return { ok: problems.length === 0, mode: "browserUrl", browser, tab, problems };
}
