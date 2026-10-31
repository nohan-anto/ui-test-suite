import { z } from "zod";

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
    })
    .default({ provider: "copilot", timeoutSec: 900, extraArgs: [], maxQuestionRounds: 8 }),

  browser: z.object({
    /** "chrome-devtools" preset, or a custom MCP server spec. */
    mcp: z.union([z.literal("chrome-devtools"), McpServerSchema]).default("chrome-devtools"),
    browserUrl: z.string().default("http://127.0.0.1:9222"),
    /** Use chrome-devtools-mcp --autoConnect (Chrome 144+) instead of browserUrl. */
    autoConnect: z.boolean().default(false),
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
        url: z.string().default("https://mcp.atlassian.com/v1/sse"),
      })
      .default({ enabled: false, url: "https://mcp.atlassian.com/v1/sse" }),
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
