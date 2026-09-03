import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRoutine } from '../src/routine.js';
import type { QueryFn } from '../src/runner/brain.js';
import { BASE_ALLOWED_TOOLS, BrainJobRunner, DISALLOWED_TOOLS } from '../src/runner/brain.js';
import type { ModelAlias, Routine } from '../src/types.js';
import { fakeQuery } from './helpers.js';

const MCP_JSON = {
  mcpServers: {
    google: { command: 'node', args: ['mcp/google/dist/index.js'] },
    whatsapp: { command: 'node', args: ['mcp/whatsapp/dist/index.js'] },
    vault: { command: 'node', args: ['mcp/vault/dist/index.js'] },
  },
};

/** An async iterable over a fixed list, without needing a generator body. */
function iterableOf(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  let i = 0;
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<SDKMessage> => ({
      next: () => {
        const value = messages[i];
        i += 1;
        return Promise.resolve(
          value === undefined ? { done: true, value: undefined } : { done: false, value },
        );
      },
    }),
  };
}

let workspaceDir: string;

function makeRoutine(
  tools: string[],
  extra: { model?: ModelAlias; maxTurns?: number } = {},
): Routine {
  const lines = [
    '---',
    'name: morning-brief',
    'schedule: "0 7 * * 1-5"',
    `tools: [${tools.join(', ')}]`,
  ];
  if (extra.model !== undefined) lines.push(`model: ${extra.model}`);
  if (extra.maxTurns !== undefined) lines.push(`max_turns: ${String(extra.maxTurns)}`);
  lines.push('---', '', 'Brief me on the day.', '');
  return parseRoutine(lines.join('\n'), path.join(workspaceDir, 'morning-brief.md'));
}

function makeRunner(queryFn?: QueryFn): BrainJobRunner {
  const options = { workspaceDir, jobTimeoutMs: 60_000 };
  return new BrainJobRunner(queryFn === undefined ? options : { ...options, queryFn });
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxw-workspace-'));
  fs.writeFileSync(
    path.join(workspaceDir, '.mcp.json'),
    JSON.stringify(MCP_JSON, null, 2) + '\n',
    'utf8',
  );
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('BrainJobRunner — SDK options', () => {
  it('selects only the MCP servers the routine names', () => {
    const options = makeRunner().buildOptions(
      makeRoutine(['google', 'vault']),
      new AbortController(),
    );
    expect(Object.keys(options.mcpServers ?? {}).sort()).toEqual(['google', 'vault']);
  });

  it('passes no MCP servers when the routine lists none', () => {
    const options = makeRunner().buildOptions(makeRoutine([]), new AbortController());
    expect(options.mcpServers).toEqual({});
  });

  it('errors naming a server that is missing from .mcp.json', () => {
    expect(() =>
      makeRunner().buildOptions(makeRoutine(['telepathy']), new AbortController()),
    ).toThrow('.mcp.json has no server named "telepathy"');
  });

  it('errors when .mcp.json is absent and the routine lists tools', () => {
    fs.rmSync(path.join(workspaceDir, '.mcp.json'));
    expect(() => makeRunner().buildOptions(makeRoutine(['google']), new AbortController())).toThrow(
      '.mcp.json not found but the routine lists tools',
    );
  });

  it('maps the model alias to the real model id', () => {
    const runner = makeRunner();
    const controller = new AbortController();
    expect(runner.buildOptions(makeRoutine([]), controller).model).toBe('claude-opus-5');
    expect(runner.buildOptions(makeRoutine([], { model: 'haiku' }), controller).model).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(runner.buildOptions(makeRoutine([], { model: 'fable' }), controller).model).toBe(
      'claude-fable-5-1',
    );
  });

  it('runs headless with no setting sources and the routine tool policy', () => {
    const options = makeRunner().buildOptions(
      makeRoutine(['google', 'whatsapp'], { maxTurns: 12 }),
      new AbortController(),
    );
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settingSources).toEqual([]);
    expect(options.cwd).toBe(workspaceDir);
    expect(options.maxTurns).toBe(12);
    expect(options.allowedTools).toEqual([
      'mcp__google__*',
      'mcp__whatsapp__*',
      ...BASE_ALLOWED_TOOLS,
    ]);
    expect(options.disallowedTools).toEqual(DISALLOWED_TOOLS);
  });

  it('appends workspace CLAUDE.md to the Claude Code preset when it exists', () => {
    const bare = makeRunner().buildOptions(makeRoutine([]), new AbortController());
    expect(bare.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });

    fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'House rules.\n', 'utf8');
    const withMd = makeRunner().buildOptions(makeRoutine([]), new AbortController());
    expect(withMd.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'House rules.\n',
    });
  });
});

describe('BrainJobRunner — results', () => {
  it('returns the text and the cost of a successful run', async () => {
    const query = fakeQuery('Here is your brief.\n\nSTATUS: done');
    const result = await makeRunner(query.fn).run(
      makeRoutine(['google']),
      'the prompt',
      new AbortController().signal,
    );

    expect(query.calls[0]?.prompt).toBe('the prompt');
    expect(result.isError).toBe(false);
    if (result.isError) return;
    expect(result.text).toBe('Here is your brief.\n\nSTATUS: done');
    expect(result.costUsd).toBe(0.03);
    expect(result.numTurns).toBe(3);
    expect(result.sessionId).toBe('fake-session');
  });

  it('treats a non-success subtype as an error carrying the subtype', async () => {
    const query = fakeQuery({ error: 'error_max_turns' });
    const result = await makeRunner(query.fn).run(
      makeRoutine([]),
      'the prompt',
      new AbortController().signal,
    );
    expect(result).toEqual({ isError: true, error: 'error_max_turns' });
  });

  it('errors with no_result when the iterator ends without a result message', async () => {
    const empty: QueryFn = () => iterableOf([]);
    const result = await makeRunner(empty).run(
      makeRoutine([]),
      'the prompt',
      new AbortController().signal,
    );
    expect(result).toEqual({ isError: true, error: 'no_result' });
  });

  it('returns a failure instead of throwing when the options cannot be built', async () => {
    const query = fakeQuery('never reached');
    const result = await makeRunner(query.fn).run(
      makeRoutine(['telepathy']),
      'the prompt',
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    if (!result.isError) return;
    expect(result.error).toContain('telepathy');
    expect(query.calls).toHaveLength(0);
  });

  it('reports a thrown query as a failure', async () => {
    const boom: QueryFn = () => ({
      [Symbol.asyncIterator]: (): AsyncIterator<SDKMessage> => ({
        next: () => Promise.reject(new Error('CLI not found')),
      }),
    });
    const result = await makeRunner(boom).run(
      makeRoutine([]),
      'the prompt',
      new AbortController().signal,
    );
    expect(result).toEqual({ isError: true, error: 'CLI not found' });
  });
});
