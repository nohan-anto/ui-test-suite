import { z } from "zod";

export const ROVO_URL = "https://mcp.atlassian.com/v1/mcp/authv2";
/** Retired Rovo endpoints → current one. */
export const isRetiredRovoUrl = (u: string) => /mcp\.atlassian\.com\/v1\/sse\/?$/.test(u);

export const McpServerSchema = z.object({
  name: z.string(),
  // stdio server
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  // remote (http/sse) server
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
});
export type McpServerSpec = z.infer<typeof McpServerSchema>;

export const RepoSchema = z.object({
  name: z.string(),
  path: z.string(),
  /** ui = front end; gateway = GraphQL middle service the UI talks to; downstream = services/subgraphs behind it. */
  role: z.enum(["ui", "gateway", "downstream"]).default("ui"),
  /** GitLab project path, e.g. "group/web-ui". Used to map MRs to this local repo. */
  gitlabProject: z.string().optional(),
});
export type RepoConfig = z.infer<typeof RepoSchema>;

export const ConfigSchema = z.object({
  agent: z
    .object({
      provider: z.string().default("copilot"),
      model: z.string().nullish(),
      /** Override the binary path for the provider CLI. */
      bin: z.string().nullish(),
      timeoutSec: z.number().int().positive().default(900),
      extraArgs: z.array(z.string()).default([]),
      maxQuestionRounds: z.number().int().positive().default(8),
      /** Show tokens / cost / premium requests per agent call and in reports. Env UITEST_SHOW_USAGE overrides. */
      showUsage: z.boolean().default(false),
    })
    .default({ provider: "copilot", timeoutSec: 900, extraArgs: [], maxQuestionRounds: 8, showUsage: false }),

  browser: z.object({
    /** "chrome-devtools" preset, or a custom MCP server spec. */
    mcp: z.union([z.literal("chrome-devtools"), McpServerSchema]).default("chrome-devtools"),
    browserUrl: z.string().default("http://127.0.0.1:9222"),
    /** Use chrome-devtools-mcp --autoConnect (Chrome 144+) instead of browserUrl. */
    autoConnect: z.boolean().default(false),
    /** Chrome binary for `uitest chrome`; null = auto-detect per OS. */
    chromePath: z.string().nullish(),
    /** Dedicated Chrome profile used by `uitest chrome` (keeps the SSO session between runs). */
    profileDir: z.string().default("~/.uitest-chrome"),
    appBaseUrl: z.string(),
    tabMatch: z.string().optional(),
    loggedInCheck: z
      .object({
        notUrlContains: z.array(z.string()).default(["onelogin.com"]),
        selector: z.string().nullish(),
      })
      .default({ notUrlContains: ["onelogin.com"] }),
    allowedOrigins: z.array(z.string()).default([]),
    /** Plan phase: remove click/type tools entirely (stricter than the prompt rule against submitting forms). */
    planObserveOnly: z.boolean().default(false),
    /**
     * Hard-block network access outside allowedOrigins via chrome-devtools-mcp --allowedUrlPattern (Chrome 149+).
     * Off by default: it also blocks third-party subresources (CDNs, APIs on other hosts) the app may need.
     */
    enforceAllowedOrigins: z.boolean().default(false),
  }),

  jira: z.object({
    baseUrl: z.string(),
    email: z.string(),
    token: z.string(),
    acceptanceCriteriaField: z.string().nullish(),
    includeComments: z.boolean().default(true),
    maxChildren: z.number().int().positive().default(100),
    rovo: z
      .object({
        enabled: z.boolean().default(false),
        /** Atlassian Rovo MCP, Streamable HTTP. The old HTTP+SSE endpoint (/v1/sse) was retired on 30 June 2026. */
        url: z.string().default(ROVO_URL),
        /**
         * "mcp-remote": a local npx bridge does the OAuth sign-in (works the same for every agent).
         * "http": hand the URL to the agent CLI, which must support remote MCP servers and their OAuth itself.
         */
        transport: z.enum(["mcp-remote", "http"]).default("mcp-remote"),
      })
      .default({ enabled: false, url: ROVO_URL, transport: "mcp-remote" }),
    /**
     * `uitest publish`: post the test report as a Jira comment with screenshots attached.
     * The only Jira write uitest does; off by default, and needs a token allowed to add comments and attachments.
     */
    publish: z
      .object({
        enabled: z.boolean().default(false),
        /** Defaults to jira.email / jira.token. Use a separate token here if your main one is read-only. */
        email: z.string().nullish(),
        token: z.string().nullish(),
        /** Which screenshots to attach: every case, failed/blocked cases only, or none. */
        attach: z.enum(["all", "failures", "none"]).default("all"),
        /** Also attach the full test-report.md. */
        attachReport: z.boolean().default(true),
      })
      .default({ enabled: false, attach: "all", attachReport: true }),
  }),

  gitlab: z
    .object({
      baseUrl: z.string().default("https://gitlab.com"),
      token: z.string().nullish(),
      /** Also search MRs whose title/branch mention the ticket key, scoped to these projects (or all configured repos). */
      searchByKey: z.boolean().default(true),
      maxDiffBytes: z.number().int().positive().default(200_000),
    })
    .default({ baseUrl: "https://gitlab.com", searchByKey: true, maxDiffBytes: 200_000 }),

  repos: z.array(RepoSchema).default([]),

  indexing: z
    .object({
      enabled: z.boolean().default(true),
      strategy: z.literal("lexical").default("lexical"),
      fetchBeforeIndex: z.boolean().default(false),
      exclude: z.array(z.string()).default(["node_modules", "dist", "build", ".git", "coverage"]),
      cacheDir: z.string().default(".uitest/index"),
    })
    .default({
      enabled: true,
      strategy: "lexical",
      fetchBeforeIndex: false,
      exclude: ["node_modules", "dist", "build", ".git", "coverage"],
      cacheDir: ".uitest/index",
    }),

  output: z.object({ dir: z.string().default("./runs") }).default({ dir: "./runs" }),

  /** Extra MCP servers handed to the agent in both phases. */
  extraMcpServers: z.array(McpServerSchema).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
