# uitest: project guide for agents developing it

| App version | Doc revision | Last updated |
| --- | --- | --- |
| 0.1.0 | 9 | 2026-11-09 |

This is the single source of truth for any coding agent (Copilot, Claude, Codex or another) **working on this codebase**. `CLAUDE.md`, `AGENTS.md` and `.github/copilot-instructions.md` all point here. Keep this file current when you change structure, commands or conventions.

> **Not for runtime agents.** When uitest itself runs an agent (plan/test phases), that agent's rules are `prompts/plan.md` and `prompts/test.md`. Its working directory sits under `runs/` inside this repo, so it may also see this file. It must ignore it.

## 1. What uitest is

A CLI (TypeScript on Bun) that takes a Jira key and:

1. **Plan** (`uitest plan CIS-601`):
   - Fetches the story; for an epic, it also fetches every child story.
   - Finds the linked GitLab MRs, then reads their diffs, commits and the local repo history.
   - Indexes the local UI, gateway and downstream repos, and computes which screens are impacted.
   - Asks an AI agent to draft test cases. The agent must ask questions instead of assuming. The user answers in the terminal.
   - Output: `test-cases.md`.
2. **Test** (`uitest test CIS-601`):
   - Runs each case in the user's **already signed-in Chrome tab** (OneLogin SSO) through chrome-devtools-mcp.
   - Output: `test-report.md` with pass/fail/blocked results and a traceability matrix.

Design rule: the **orchestrator does all deterministic work** (HTTP, git, indexing, rendering). The **agent only reasons and drives the browser**. Agents are swappable through one adapter interface.

## 2. Users and environment

- Developed on Fedora Linux. The **real target is a Windows work laptop** (PowerShell, Bun ≥ 1.2, Git for Windows, Chrome, GitHub Copilot CLI). Every change must work on Windows: no POSIX-only paths, shell syntax or hard-coded `/tmp`.
- The user's systems: Jira Cloud, gitlab.com (nested groups), and three repo roles:
  - UI (gql`` tags and HTTP calls)
  - a Node schema-first GraphQL gateway (Apollo/Yoga); a REST BFF is also supported
  - downstreams in Node, .NET or Go, which can be GraphQL subgraphs (Hot Chocolate, gqlgen) **or plain REST APIs**, in any mix
- Repo: https://github.com/nohan-anto/ui-test-suite (branch `master`). **The user commits and pushes themselves. Do not commit unless asked.**

## 3. Commands

```bash
bun install
bun test                 # all tests (unit, graphql, offline e2e with mock agent + fixtures)
bun run typecheck        # tsc --noEmit
bun src/cli.ts <cmd>     # or `uitest <cmd>` after `bun link`
```

| CLI command | Purpose |
| --- | --- |
| `init` | copy `uitest.config.example.yaml` → `uitest.config.yaml`, `.env.example` → `.env` |
| `chrome [--print]` | start Chrome with remote debugging on the dedicated profile, per OS |
| `doctor [--agent id]` | check the agent CLI and its flags, Chrome tab and sign-in, Jira, GitLab and repo paths |
| `index [repo] [--force]` | build or refresh the lexical index (cached per HEAD sha + `INDEX_VERSION`) |
| `plan <ticket> [--agent] [--answers file] [--fixtures dir]` | phase 1 |
| `test <ticket> [--run id] [--only TC-001,…] [--failed] [--answers file] [--skip-preflight]` | phase 2; `--failed` re-runs the failed/blocked cases from the latest finished test run. Partial runs merge with the previous results. Exit code 2 if anything is failing overall |
| `report <ticket> [--run id]` | re-render the report from `results.json` |
| `publish <ticket> [--run] [--test-run] [--to KEY] [--dry-run] [--yes]` | post the report as a Jira comment with screenshots attached (needs `jira.publish.enabled`) |

Offline end-to-end check: `bun src/cli.ts plan DEMO-1 --agent mock --fixtures tests/fixtures` (see `tests/e2e.test.ts`).

## 4. Data flow

```
Jira (GET) ──► sources/jira/collect ──┐
GitLab (GET) ► sources/gitlab/collect ─┤
local git ───► repos/git + indexer ────┼─► phases/context ─► runs/<T>/<run>/context/*.md + manifest.json
                repos/impact, graphql-impact ┘                       │
                                                                     ▼
            prompts/plan.md + context ─► agents/<adapter> (+ chrome-devtools-mcp) ─► JSON ─► zod
                     ▲   questions ◄──► qa/interactive (terminal)                         │
                     └────────────────────────────────────────────────────────────────────┘
                                                                     ▼
                                                    artifacts/testcases ─► test-cases.md (hand-editable)
test: browser/ensure+preflight ─► per case: prompts/test.md ─► agent ─► TestReply ─► artifacts/report ─► test-report.md
```

## 5. File index

### Root
| Path | What |
| --- | --- |
| `package.json` | name/bin `uitest` → `src/cli.ts`; deps: commander, zod v4, yaml, @clack/prompts |
| `uitest.config.example.yaml` | every config option, commented. **Update it when you add a config key.** |
| `.env.example` | `JIRA_EMAIL`, `JIRA_API_TOKEN`, `GITLAB_TOKEN` |
| `README.md` | user-facing setup and usage (including the Windows notes) |
| `prompts/plan.md`, `prompts/test.md` | system prompts for the runtime agent: rules and the JSON output shape |
| `.gitignore` | ignores `uitest.config.yaml`, `.env*`, `runs/`, `.uitest/` |

### `src/`
| Path | What |
| --- | --- |
| `cli.ts` | commander entry point; wires every command |
| `config/schema.ts` | zod `ConfigSchema`: `agent`, `browser`, `jira`, `gitlab`, `repos[]` (role `ui`/`gateway`/`downstream`), `indexing`, `output`, `extraMcpServers` |
| `config/load.ts` | YAML load, `${VAR}` interpolation, `~` expansion (repo paths, `browser.profileDir`), `UITEST_SHOW_USAGE` → `agent.showUsage`, `secretsOf()` (≥ 6 chars, for redaction) |
| `util/index.ts` | `exec` (Bun.spawn, timeout, never throws), `redact`, `writeText`, `timestamp`, `truncate`, `uniq` |
| `util/platform.ts` | `isWindows`, `npxServer()` (`cmd /c npx` on Windows), `resolveCommand()` (runs `.cmd`/`.bat` shims through `cmd.exe`) |
| `sources/jira/client.ts` | GET-only Jira REST v3 client (`myself`, `issue`, `remoteLinks`, `search` with `nextPageToken`) |
| `sources/jira/publish.ts` | `JiraPublisher`: **the only Jira writer**. Lists existing attachment names, uploads attachments (`X-Atlassian-Token: no-check`), posts a wiki-markup comment (REST v2) |
| `sources/jira/adf-to-md.ts` | Atlassian Document Format → Markdown |
| `sources/jira/collect.ts` | `collectTicket`: epic children via `parent = KEY`, falling back to `"Epic Link"`; acceptance-criteria field auto-detected; `storyToMarkdown` |
| `sources/gitlab/client.ts` | GET-only GitLab v4 client (MR, diffs, commits, notes, search, branches) |
| `sources/gitlab/collect.ts` | MR refs from URLs (nested groups) and `group/repo!123`; search by ticket key and branch; `normaliseProject`/`sameProject` (case-insensitive) |
| `sources/fixtures.ts` | `fixtureFetch`: maps a URL path to `tests/fixtures/{jira,gitlab}/a__b__c.json` |
| `repos/git.ts` | read-only git helpers (`headSha`, `hasCommit`, `showPatch`, `lsFiles`, `logGrep`, …) |
| `repos/indexer.ts` | lexical index: routes (code + file-based), components, REST endpoints, feature flags, i18n, GraphQL ops and fields, `httpRoutes`/`httpCalls`. Bump `INDEX_VERSION` (now 3) when the shape changes |
| `repos/graphql.ts` | gql literal extraction, a small GraphQL tokenizer/parser, SDL root fields, resolver detection for JS, Go gqlgen and C# Hot Chocolate |
| `repos/diff.ts` | unified-diff parsing into changed line ranges; `touchedItems` (use `singleLine` for SDL) |
| `repos/impact.ts` | `RepoGraph` (import graph, routes reaching a file), `computeImpact`, REST `linkDownstream`, `impactToMarkdown` |
| `repos/rest.ts` | REST extraction. `scanHttpRoutes`: Express/Nest, ASP.NET controllers + minimal APIs (`MapGroup`), Go net/http/gin/echo/chi/gorilla (groups), Spring, Flask/FastAPI. `scanHttpCalls`: fetch, axios, RESTDataSource, HttpClient, Go http/Sprintf, RestTemplate, requests. Also `normalisePath`, `pathsMatch` (trailing-segment match, `*` params) |
| `repos/rest-impact.ts` | `RestLinker`: changed route (or the service function behind it, via `enclosingFunction` + `usages`, 2 hops) → gateway callers → owning resolver/BFF route (`ownersOf`) → UI ops/calls → screens; changed UI/gateway calls → the endpoints they hit; `restChainsToMarkdown` |
| `repos/graphql-impact.ts` | `GraphqlLinker`: chains from a UI op to a gateway field/resolver to a subgraph field, plus type-field hints |
| `mcp/servers.ts` | neutral MCP specs (chrome-devtools-mcp with `--browserUrl`/`--autoConnect`, Rovo at `https://mcp.atlassian.com/v1/mcp/authv2` via `mcp-remote --transport http-only` or natively with `jira.rovo.transport: http`; retired `/v1/sse` URLs are migrated by `rovoUrl`; extras) and per-agent formats (`toMcpJson`, `toCodexOverrides`) |
| `agents/types.ts` | the `AgentAdapter`, `AgentRequest` and `Invocation` contracts |
| `agents/cli-adapter.ts` | base class: `doctor()` checks `requiredFlags` against `--help`; `run()` writes temp files, runs, returns text. `cwd` = `workDirs[0]` |
| `agents/{claude,codex,copilot,mock}.ts` | build each CLI's command line and parse usage (`parseUsage`; codex now runs with `--json`). Only `claude` is verified against a real CLI; `copilot`/`codex` follow their docs |
| `agents/usage.ts` | `AgentUsage` (tokens, cache, USD cost, premium requests), parsers `claudeUsage`/`codexUsage`/`copilotUsage`, `UsageMeter` (per-label totals), `formatUsage`, `envFlag` |
| `agents/json-extract.ts` | pulls the last fenced `json` block out of agent text |
| `agents/registry.ts` | provider id → adapter factory. **Register new providers here** |
| `phases/protocol.ts` | zod contracts: `PlanReply`, `TestCase` (`TC-NNN`, P1–P3), `TestReply` (pass/fail/blocked/skipped), `Question`, `QA` |
| `phases/paths.ts` | run directory layout, `latestRunId`, `loadPrompt` |
| `phases/run-agent.ts` | `runAgentJson`: call the agent, validate, retry once with the zod error, save transcripts, record usage of every attempt in the optional `UsageMeter` |
| `phases/context.ts` | builds the context bundle (`story.md`, `children/*.md`, `mrs.md`, `repos/<name>.md`, `impact.md`, `manifest.json`); everything redacted |
| `phases/plan.ts` | plan loop: question rounds (`agent.maxQuestionRounds`), accept/feedback, writes `questions.md` and `test-cases.md` |
| `phases/publish.ts` | `uitest publish`: loads `results.json`, `collectEvidence` (listed files plus `TC-NNN-*` images, from the run each result came from), preview to `jira-comment.txt`, confirm, upload (skipping existing names), comment, log to `published.json` |
| `phases/test.ts` | browser check, confirmation for `destructive` cases, one isolated agent run per case (up to 2 clarification rounds), `results.json` and the report. `latestCompletedTestRun` + `mergeResults`: after `--failed`/`--only`, cases not re-run are carried over with `fromTestRun` set |
| `browser/preflight.ts` | CDP HTTP checks: `/json/version`, tab matched by `tabMatch` (defaults to the `appBaseUrl` host), SSO URL check, optional signed-in selector |
| `browser/launch.ts` | find Chrome per OS, start it detached with `--remote-debugging-port` and `--user-data-dir`, wait for the port |
| `browser/ensure.ts` | interactive preflight: offers to start Chrome, waits for the user to sign in |
| `qa/interactive.ts` | `Asker` interface; `TerminalAsker` (clack), `ScriptedAsker` (answers from JSON, for tests) |
| `artifacts/testcases.ts` | render **and parse** `test-cases.md` (`## TC-001: title`, `- **Priority:**`, `**Steps**` …). Users edit this file by hand, so keep the round-trip lossless |
| `artifacts/questions.ts` | `questions.md` and answers formatted for prompts |
| `artifacts/jira-comment.ts` | `buildJiraComment`: Jira wiki markup with a summary table, failure details and `!name\|thumbnail!` images; `wikiEscape`; trims to `MAX_COMMENT_CHARS` |
| `artifacts/report.ts` | summary table, failures, per-case details, traceability matrix. Carried-over results are marked `↩ <testRunId>`, and their evidence links point to that run |

### `tests/`
| Path | What |
| --- | --- |
| `unit.test.ts` | config, ADF, MR refs, test-case round-trip, report, JSON extraction, adapter command lines, indexer, preflight, Chrome launch args |
| `rest.test.ts` | REST extraction per framework, path matching, and two chains: UI → GraphQL gateway → .NET REST (service change reached via the controller), and all-REST UI → Express BFF → Go gin, plus a changed UI call |
| `helpers.ts` | `makeGitRepo`: temp git repo with an initial commit and an optional ticket commit (git isolated) |
| `graphql.test.ts` | parsers, diff helpers, a 4-repo chain (UI → gateway → Go and .NET subgraphs) |
| `e2e.test.ts` | offline plan, test, `--only` merge and `--failed` re-run cycle with the mock agent and fixtures in temp git repos (git isolated: no gpg signing, no hooks) |
| `fixtures/` | DEMO-1 epic with child DEMO-2; MR `demo/web-ui!7` |

## 6. Run output layout

```
runs/<TICKET>/<runId>/
  context/        story.md, children/*.md, mrs.md, repos/*.md, impact.md, manifest.json
  questions.md    Q&A from planning
  test-cases.md   approved cases (editable)
  test-report.md  copy of the latest test run's report
  transcripts/    raw agent I/O
  test-runs/<testRunId>/{evidence/, results.json, test-report.md, transcripts/}
.uitest/index/<repo>.json   index cache
```

## 7. Invariants (do not break)

1. **Read-only integrations.**
   - Jira and GitLab clients expose GET only. Git helpers never checkout, commit, push or reset (`fetch` only when `indexing.fetchBeforeIndex`).
   - **The single exception** is `uitest publish`, through `JiraPublisher`. It is opt-in (`jira.publish.enabled`), only adds a comment and attachments to the named issue, previews, and asks for confirmation. Never call it from `plan` or `test`, and never add other write paths.
2. **No credentials in the browser.** The agent never types passwords or SSO details. It uses the signed-in tab and stays within `allowedOrigins`. Cases tagged `destructive` need terminal confirmation.
3. **No assumptions.** Prompts make the agent ask instead of guess. Every test case has `tracesTo` (AC-n, story key, comment, MR).
4. **Secrets are redacted** from the context bundle and transcripts (`secretsOf` + `redact`).
5. **Agent-agnostic.** Provider-specific code lives only in `agents/<id>.ts` and in the MCP format helpers. Phases talk to `AgentAdapter` only. Replies are JSON validated by zod.
6. **Tests are isolated from the developer's machine.** Bun loads `.env` automatically, even under `bun test`, so tests always pass an explicit env to `parseConfig` (`parseConfig(yaml, {})` or a small object), and never rely on `process.env`.
7. **Windows-safe.** Use `node:path` `join`/`resolve`, `resolveCommand` for spawning, `npxServer` for MCP servers, and pass long prompts through files rather than argv. In tests, build YAML paths with `JSON.stringify`.
8. **`test-cases.md` format round-trips** through `renderTestCases`/`parseTestCases`.
9. **Test history is append-only.** Every `uitest test` writes a new `test-runs/<testRunId>/` and never edits earlier runs. `results.json` of a finished run is `{ meta, results }` covering every planned case; an unfinished run is a bare array.

## 8. How to extend

- **New agent provider:** add `src/agents/<id>.ts` extending `CliAdapter` (`requiredFlags` + `buildInvocation`), register it in `registry.ts`, add a command-line unit test, add it to the `agent.provider` comment in the example config and to the README.
- **New config key:** `config/schema.ts` (with a default), `uitest.config.example.yaml`, the README if user-facing.
- **New context source:** collect in `phases/context.ts`, write a Markdown file into the bundle, add it to the manifest, and mention it in `prompts/plan.md` if the agent should use it.
- **Indexer changes:** bump `INDEX_VERSION`, add tests in `unit.test.ts` or `graphql.test.ts`.
- **Prompt changes:** keep the JSON shape in the prompt in sync with `phases/protocol.ts`.

## 9. Status and open items

- 49 tests pass on Linux. The Windows laptop passed 35 at the last sync. The typecheck is clean.
- Verified on the laptop: `doctor` (Copilot CLI 1.0.105, Jira, GitLab, 3 repos, Chrome tab after fixing `tabMatch`).
- **Not yet verified with real systems:**
  - a full `plan`/`test` run with Copilot
  - the codex adapter
  - `uitest chrome` actually launching Chrome on Windows
  - usage parsing against real Copilot/Codex output (Copilot `-p` may not print its summary; Codex `--json` field names vary by version)
  - Rovo MCP on the new endpoint (OAuth via mcp-remote, admin allowance). It is also not yet limited to read-only tools or to the plan phase, so keep it off
  - `uitest publish` against real Jira (wiki rendering of the comment, thumbnails, attachment permissions)
  - GraphQL and REST extraction on the user's real repos (check the per-repo counts `uitest index` prints)
- Next steps:
  - Run `uitest index`, then plan a small real story, then `test --only TC-001` on the laptop.
  - Fix any adapter flag or parsing issues found.
  - Consider making the runtime agent's working directory sit outside this repo, or passing "no custom instructions" flags, so this file and the agent instruction files never reach runtime agents.

## 10. Maintaining this file

This guide grows with the application. Any agent that changes the code updates it **in the same change**:

1. **Every change:**
   - Add a line under **Unreleased** in the version history below (Added / Changed / Fixed / Removed).
   - Bump **Doc revision** by 1 and set **Last updated** to today.
2. **Structure changes:**
   - New, moved or deleted file: update the file index (section 5).
   - New command or flag: update section 3.
   - New config key: add it to `uitest.config.example.yaml`.
   - New rule the code must follow: add it to section 7.
3. **Status:** keep section 9 true. Move items out of "Not yet verified" once they are verified on the laptop, and keep the test count current.
4. **Releases:** the app uses semver, with `package.json` `version` as the source of truth. Before 1.0:
   - minor bump: features or config changes
   - patch bump: fixes

   On a release, set the new version in `package.json` and in the header table, then rename **Unreleased** to `[x.y.z] — date`. A unit test fails if the header and `package.json` disagree.
5. **Keep it lean.** This file is an index and a rulebook, not a copy of the code. Describe what a file is for, not how it works line by line. If a section passes about 150 lines, split it into `docs/<topic>.md` and link to it from here.

## 11. Version history

Newest first. Commit hashes are from `master`.

### Unreleased
- **Changed:** Rovo MCP moved from the retired HTTP+SSE endpoint (`/v1/sse`, shut down 30 June 2026) to Streamable HTTP at `https://mcp.atlassian.com/v1/mcp/authv2`.
  - `mcp-remote` is pinned to `--transport http-only`.
  - New `jira.rovo.transport` (`mcp-remote` | `http`).
  - Old URLs are migrated automatically, and `doctor` warns.
- **Fixed:** tests failed on a machine whose `.env` had `UITEST_SHOW_USAGE=true` (Bun loads `.env` in tests too). Test configs now get an empty env.
- **Added:** AI usage reporting, toggled by `UITEST_SHOW_USAGE=true|false` (or `agent.showUsage`).
  - Shown per plan round and per test case, with totals; an *AI usage* column and run total in `test-report.md`; `usage.json` per run.
  - Sources: Claude (tokens and USD cost), Codex (`--json` token events), Copilot (premium-request and token estimates from its summary).
  - Never included in Jira comments.
- **Added:** REST-aware impact for downstreams (and BFF gateways) that are plain HTTP APIs.
  - REST routes and HTTP calls are indexed for Node, .NET, Go, Java and Python (`INDEX_VERSION` 3).
  - `impact.md` gains "REST impact chains": changed endpoint, or the service behind it, → gateway resolver/BFF route → UI operation/call → screens.
  - `uitest index` prints GraphQL and REST counts per repo.
  - `prompts/plan.md` covers REST chains and downstream error states.
  - `tests/helpers.ts` holds the shared temp-repo helper.
- **Added:** `uitest publish`, which posts the report to the Jira story as a comment with screenshots attached and the full report attached.
  - New config `jira.publish.{enabled,email,token,attach,attachReport}`; `JIRA_WRITE_TOKEN` in `.env.example`.
  - `doctor` checks the publish token.
  - The publish token is redacted too.
  - Read-only invariant updated to name this single exception.
- **Added:** README "Quick start" section listing the everyday commands in order.
- **Added:** `uitest test --failed`, which re-runs only the failed or blocked cases from the latest finished test run.
- **Changed:** a partial run (`--failed`/`--only`) now merges with the previous run, so `results.json`, `test-report.md` and the exit code cover every case. Cases not re-run are marked `↩ <testRunId>`. Before, the report listed only the cases that ran.
- **Added:**
  - `docs/PROJECT.md`, the shared guide for agents, with version tracking.
  - `CLAUDE.md`, `AGENTS.md` and `.github/copilot-instructions.md`, all pointing to it.
  - A test that keeps the header version in sync with `package.json`.

### [0.1.0] — 2026-10-31 → 2026-11-01
- `5e4c38d` **Added:**
  - `uitest chrome [--print]`, which finds and starts Chrome per OS with the debug profile.
  - `test` offers to start Chrome and waits for sign-in.
  - Config keys `browser.chromePath` and `browser.profileDir`.
  - `tabMatch`/`allowedOrigins` default to `appBaseUrl`.
- `abaccef` **Fixed:** case-insensitive GitLab project matching for nested groups (`normaliseProject`/`sameProject`).
- `93d2cc5` **Added:** GraphQL-aware impact.
  - UI op → gateway field/resolver → subgraph (Node/Go/.NET) chains, using diff line ranges.
  - Repo role `gateway`.
  - `INDEX_VERSION` 2.

  **Fixed:** short secrets no longer corrupt redaction.
- `1f85ed2` **Fixed:** Windows compatibility.
  - `cmd /c npx`
  - `.cmd` shims run through `cmd.exe`
  - prompts passed in files
  - path-safe tests
  - git isolation and timeouts in e2e
- `a4d0c46` **Added:** initial version.
  - Jira and GitLab collectors (read-only), epic expansion
  - lexical indexer, context bundle
  - claude/codex/copilot/mock adapters
  - plan Q&A loop, test runner, Markdown test cases and report
