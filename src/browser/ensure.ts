/** Interactive preflight: offer to start Chrome, then wait for the user to sign in instead of failing outright. */
import type { Config } from "../config/schema.ts";
import type { Asker } from "../qa/interactive.ts";
import { chromeReachable, launchChrome } from "./launch.ts";
import { preflight, type PreflightResult } from "./preflight.ts";

export async function ensureBrowser(cfg: Config, asker: Asker, maxAttempts = 3): Promise<PreflightResult> {
  let pf = await preflight(cfg);
  for (let attempt = 1; !pf.ok && attempt <= maxAttempts; attempt++) {
    if (!(await chromeReachable(cfg.browser.browserUrl))) {
      if (!(await asker.confirm(`Chrome is not running with remote debugging on ${cfg.browser.browserUrl}. Start it now?`))) break;
      const l = await launchChrome(cfg.browser);
      asker.info(l.message);
      if (!l.ok) break;
    } else {
      asker.info(pf.problems.join("\n"));
    }
    if (!(await asker.confirm(`Sign in to ${cfg.browser.appBaseUrl} in that Chrome window (through OneLogin) and keep the tab open. Done?`))) break;
    pf = await preflight(cfg);
  }
  return pf;
}
