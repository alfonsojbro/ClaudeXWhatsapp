import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  last4,
  parseDeviceFlow,
  saveApiKey,
  saveOauthToken,
  startClaudeSetupToken,
} from './claude.js';
import type { SpawnLike } from './claude.js';

function envPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cxw-claude-')), 'cxw.env');
}

describe('parseDeviceFlow', () => {
  it('finds the URL and the code in a realistic output', () => {
    const output = [
      'Opening browser to complete authentication...',
      '',
      'Visit: https://claude.ai/oauth/authorize?code=true&client_id=abc',
      'Enter code: WXYZ-1234',
      '',
    ].join('\n');
    expect(parseDeviceFlow(output)).toEqual({
      url: 'https://claude.ai/oauth/authorize?code=true&client_id=abc',
      code: 'WXYZ-1234',
    });
  });

  it('handles the case where only a URL appears', () => {
    const flow = parseDeviceFlow('Go to https://claude.ai/oauth/authorize to continue.');
    expect(flow).toEqual({ url: 'https://claude.ai/oauth/authorize', code: '' });
  });

  it('strips trailing punctuation off the URL', () => {
    expect(parseDeviceFlow('see https://example.com/x.')?.url).toBe('https://example.com/x');
  });

  it('takes the first URL when there are several', () => {
    expect(parseDeviceFlow('a https://one.example b https://two.example')?.url).toBe(
      'https://one.example',
    );
  });

  it('does not mistake an upper-case English word for a code', () => {
    const flow = parseDeviceFlow('PLEASE VISIT https://claude.ai/oauth NOW');
    expect(flow?.code).toBe('');
  });

  it('returns null when there is no URL at all', () => {
    expect(parseDeviceFlow('Error: not logged in')).toBeNull();
    expect(parseDeviceFlow('')).toBeNull();
  });
});

describe('startClaudeSetupToken', () => {
  it('runs `claude setup-token` with arguments as an array', () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const spawn = vi.fn(() => child) as unknown as SpawnLike;
    expect(startClaudeSetupToken(spawn)).toBe(child);
    const call = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call?.[0]).toBe('claude');
    expect(call?.[1]).toEqual(['setup-token']);
  });
});

describe('saveOauthToken', () => {
  it('writes the key at mode 0600 and returns only the last four characters', () => {
    const path = envPath();
    const result = saveOauthToken(path, 'sk-ant-oat-01-SECRETBODY-abcd');
    expect(result).toEqual({ saved: true, last4: 'abcd' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain(
      'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-01-SECRETBODY-abcd',
    );
  });

  it('replaces the placeholder line in an existing cxw.env without disturbing it', () => {
    const path = envPath();
    writeFileSync(path, '# c\nNODE_ENV=production\nCLAUDE_CODE_OAUTH_TOKEN=CHANGEME\nTZ=UTC\n');
    saveOauthToken(path, 'sk-ant-oat-new');
    expect(readFileSync(path, 'utf8')).toBe(
      '# c\nNODE_ENV=production\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-new\nTZ=UTC\n',
    );
  });

  it('warns but still saves a token with an unexpected prefix', () => {
    const path = envPath();
    const result = saveOauthToken(path, 'weird-token-value');
    expect(result.saved).toBe(true);
    expect(result.warning).toContain('sk-ant-oat');
    expect(readFileSync(path, 'utf8')).toContain('weird-token-value');
  });

  it('refuses an empty or truncated paste', () => {
    expect(() => saveOauthToken(envPath(), '   ')).toThrow(/Paste/);
    expect(() => saveOauthToken(envPath(), 'sk-ant-oat abc')).toThrow(/space in it/);
  });

  it('is idempotent', () => {
    const path = envPath();
    saveOauthToken(path, 'sk-ant-oat-x1234');
    const once = readFileSync(path, 'utf8');
    saveOauthToken(path, 'sk-ant-oat-x1234');
    expect(readFileSync(path, 'utf8')).toBe(once);
  });

  it('never returns the secret itself', () => {
    const secret = 'sk-ant-oat-01-THIS-IS-THE-SECRET-9999';
    const result = saveOauthToken(envPath(), secret);
    expect(JSON.stringify(result)).not.toContain('THIS-IS-THE-SECRET');
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('saveApiKey', () => {
  it('writes ANTHROPIC_API_KEY and returns only the last four', () => {
    const path = envPath();
    expect(saveApiKey(path, 'sk-ant-api03-LONGSECRET-zzzz')).toEqual({ saved: true, last4: 'zzzz' });
    expect(readFileSync(path, 'utf8')).toContain('ANTHROPIC_API_KEY=sk-ant-api03-LONGSECRET-zzzz');
  });

  it('warns on an unexpected prefix without blocking', () => {
    expect(saveApiKey(envPath(), 'oops-1234').warning).toContain('sk-ant-');
  });

  it('does not overwrite the OAuth token', () => {
    const path = envPath();
    saveOauthToken(path, 'sk-ant-oat-keepme');
    saveApiKey(path, 'sk-ant-api-other');
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-keepme');
    expect(text).toContain('ANTHROPIC_API_KEY=sk-ant-api-other');
  });
});

describe('last4', () => {
  it('returns the last four characters', () => {
    expect(last4('abcdefgh')).toBe('efgh');
  });

  it('returns nothing at all for a value too short to hide', () => {
    expect(last4('abcd')).toBe('');
    expect(last4('ab')).toBe('');
  });
});
