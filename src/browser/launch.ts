/**
 * Start Chrome with remote debugging on a dedicated profile (Chrome 136+ ignores the port on the default profile).
 * Finds the Chrome binary per OS; the profile keeps the OneLogin session between runs.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/schema.ts";
import type { FetchFn } from "../sources/jira/client.ts";

export function chromeCandidates(platform: NodeJS.Platform = process.platform, env = process.env): string[] {
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe"));
  }
  if (platform === "darwin") {
    const app = "Google Chrome.app/Contents/MacOS/Google Chrome";
    return [join("/Applications", app), join(homedir(), "Applications", app)];
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
}

/** Absolute path of the Chrome binary: `browser.chromePath` if set, else the first one found for this OS. */
export function findChrome(cfg: Config["browser"]): string | null {
  if (cfg.chromePath) return existsSync(cfg.chromePath) ? cfg.chromePath : (Bun.which(cfg.chromePath) ?? null);
  for (const c of chromeCandidates()) {
    const found = c.includes("/") || c.includes("\\") ? (existsSync(c) ? c : null) : Bun.which(c);
    if (found) return found;
  }
  return null;
}

export function chromeArgs(cfg: Config["browser"]): string[] {
  const port = new URL(cfg.browserUrl).port || "9222";
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${cfg.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    cfg.appBaseUrl,
  ];
}

/** Copy-pasteable launch command for this OS (used in error messages). */
export function chromeCommandHint(cfg: Config["browser"]): string {
  const bin = findChrome(cfg) ?? chromeCandidates()[0]!;
  const args = chromeArgs(cfg).slice(0, 2).map((a) => (a.includes(" ") ? `"${a}"` : a));
  return process.platform === "win32" ? `& "${bin}" ${args.join(" ")}` : `"${bin}" ${args.join(" ")}`;
}

export async function chromeReachable(browserUrl: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  try {
    return (await fetchFn(`${browserUrl.replace(/\/+$/, "")}/json/version`)).ok;
  } catch {
    return false;
  }
}

export interface LaunchResult {
  ok: boolean;
  alreadyRunning: boolean;
  message: string;
}

/** Start Chrome detached (it keeps running after uitest exits) and wait for the debug port. */
export async function launchChrome(cfg: Config["browser"], waitMs = 20_000): Promise<LaunchResult> {
  if (await chromeReachable(cfg.browserUrl)) {
    return { ok: true, alreadyRunning: true, message: `Chrome is already listening on ${cfg.browserUrl}.` };
  }
  const bin = findChrome(cfg);
  if (!bin) {
    return {
      ok: false,
      alreadyRunning: false,
      message: `Chrome not found (looked in: ${chromeCandidates().join(", ")}). Set browser.chromePath in uitest.config.yaml.`,
    };
  }
  const child = spawn(bin, chromeArgs(cfg), { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => {});
  child.unref();

  for (const end = Date.now() + waitMs; Date.now() < end; ) {
    if (await chromeReachable(cfg.browserUrl)) {
      return { ok: true, alreadyRunning: false, message: `Started Chrome (profile ${cfg.profileDir}) on ${cfg.browserUrl}.` };
    }
    await Bun.sleep(500);
  }
  return {
    ok: false,
    alreadyRunning: false,
    message:
      `Started ${bin} but ${cfg.browserUrl} did not answer within ${waitMs / 1000}s. ` +
      `If a Chrome window using ${cfg.profileDir} was already open without debugging, close it and try again.`,
  };
}
