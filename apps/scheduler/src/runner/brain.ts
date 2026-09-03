/**
 * The LLM runner: one fresh Agent SDK session per run.
 *
 * Option names and the result-message shape are those of the installed SDK (0.3.259); see
 * `feature-research/phase-5-routines/plan-addendum.md` section 4.
 *
 * Privacy: prompt text and result text pass through here and are never logged.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { JobResult, JobRunner, Routine } from '../types.js';

/** The `query` function of the Agent SDK, reduced to what this runner uses. */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

/** Tools a routine may always use, on top of its MCP servers. */
export const BASE_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'];

/** Tools no routine may use. */
export const DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
];

/** Construction options for {@link BrainJobRunner}. */
export interface BrainJobRunnerOptions {
  /** Directory the agent runs in; holds `CLAUDE.md` and `.mcp.json`. */
  workspaceDir: string;
  /** Wall-clock limit for one run. */
  jobTimeoutMs: number;
  /** Injected so tests never spawn the Claude CLI. */
  queryFn?: QueryFn;
  /** Injected file reader; returns null when the file does not exist. */
  readFileText?: (filePath: string) => string | null;
}

const realReadFileText = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

const lazyQuery: QueryFn = (params) => {
  async function* run(): AsyncGenerator<SDKMessage, void> {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    for await (const message of sdk.query(params)) yield message;
  }
  return run();
};

/**
 * Read `.mcp.json` and return only the servers a routine asked for.
 *
 * @throws {Error} when a named server is not in the file, or the file is missing while servers
 * were requested.
 */
export function selectMcpServers(
  mcpJsonText: string | null,
  tools: string[],
): Record<string, McpServerConfig> {
  if (tools.length === 0) return {};
  if (mcpJsonText === null) throw new Error('.mcp.json not found but the routine lists tools');

  let parsed: unknown;
  try {
    parsed = JSON.parse(mcpJsonText);
  } catch (err: unknown) {
    throw new Error(`.mcp.json is not valid JSON: ${err instanceof Error ? err.message : ''}`);
  }

  const root = parsed as { mcpServers?: Record<string, McpServerConfig> };
  const all: Record<string, McpServerConfig> =
    root.mcpServers ?? (parsed as Record<string, McpServerConfig>);

  const selected: Record<string, McpServerConfig> = {};
  for (const name of tools) {
    const server = all[name];
    if (server === undefined) throw new Error(`.mcp.json has no server named "${name}"`);
    selected[name] = server;
  }
  return selected;
}

/** Runs a routine as a fresh headless Claude Code session. */
export class BrainJobRunner implements JobRunner {
  private readonly workspaceDir: string;
  private readonly jobTimeoutMs: number;
  private readonly queryFn: QueryFn;
  private readonly readFileText: (filePath: string) => string | null;

  constructor(options: BrainJobRunnerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.jobTimeoutMs = options.jobTimeoutMs;
    this.queryFn = options.queryFn ?? lazyQuery;
    this.readFileText = options.readFileText ?? realReadFileText;
  }

  /** Build the SDK options for one routine. Exposed for tests. */
  buildOptions(routine: Routine, controller: AbortController): Options {
    const tools = routine.frontmatter.tools;
    const mcpServers = selectMcpServers(
      this.readFileText(path.join(this.workspaceDir, '.mcp.json')),
      tools,
    );

    const claudeMd = this.readFileText(path.join(this.workspaceDir, 'CLAUDE.md'));
    const systemPrompt: Options['systemPrompt'] =
      claudeMd === null
        ? { type: 'preset', preset: 'claude_code' }
        : { type: 'preset', preset: 'claude_code', append: claudeMd };

    return {
      abortController: controller,
      cwd: this.workspaceDir,
      model: routine.modelId,
      maxTurns: routine.frontmatter.max_turns,
      permissionMode: 'dontAsk',
      allowedTools: [...tools.map((t) => `mcp__${t}__*`), ...BASE_ALLOWED_TOOLS],
      disallowedTools: DISALLOWED_TOOLS,
      mcpServers,
      settingSources: [],
      systemPrompt,
    };
  }

  /**
   * Run one job.
   *
   * Aborts on the caller's signal or after `jobTimeoutMs`, whichever comes first. Never throws:
   * every failure comes back as a {@link JobResult} with `isError: true`.
   */
  async run(routine: Routine, prompt: string, signal: AbortSignal): Promise<JobResult> {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.jobTimeoutMs);
    const onAbort = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      let options: Options;
      try {
        options = this.buildOptions(routine, controller);
      } catch (err: unknown) {
        return { isError: true, error: err instanceof Error ? err.message : String(err) };
      }

      for await (const message of this.queryFn({ prompt, options })) {
        if (message.type !== 'result') continue;
        if (message.subtype === 'success') {
          return {
            isError: false,
            text: message.result,
            costUsd: message.total_cost_usd,
            numTurns: message.num_turns,
            sessionId: message.session_id,
          };
        }
        return { isError: true, error: message.subtype };
      }
      if (timedOut) return { isError: true, error: 'timeout' };
      if (signal.aborted) return { isError: true, error: 'aborted' };
      return { isError: true, error: 'no_result' };
    } catch (err: unknown) {
      if (timedOut) return { isError: true, error: 'timeout' };
      if (signal.aborted) return { isError: true, error: 'aborted' };
      return { isError: true, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
