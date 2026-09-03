import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseEnvFile,
  readEnvFile,
  setEnvValues,
  updateEnvFile,
  writeEnvFile,
} from './envfile.js';

const REAL_FILE = `# /srv/cxw/cxw.env — root:root 0600. Read by systemd before dropping to user cxw.
# Placeholders only. Never commit the filled-in file.
NODE_ENV=production
TZ=Europe/Prague
LOG_LEVEL=info

# Paths
CXW_DATA_DIR=/srv/cxw/data
CXW_STATE_DIR=/srv/cxw/state

# Anthropic auth. Prefer the subscription.
CLAUDE_CODE_OAUTH_TOKEN=CHANGEME
ANTHROPIC_API_KEY=CHANGEME
`;

describe('parseEnvFile', () => {
  it('reads assignments and ignores comments and blanks', () => {
    const map = parseEnvFile(REAL_FILE);
    expect(map.get('NODE_ENV')).toBe('production');
    expect(map.get('CXW_STATE_DIR')).toBe('/srv/cxw/state');
    expect(map.has('#')).toBe(false);
    expect(map.size).toBe(7);
  });

  it('accepts an export prefix and trims the value', () => {
    const map = parseEnvFile('export FOO=  bar  \n');
    expect(map.get('FOO')).toBe('bar');
  });

  it('lets the last assignment win', () => {
    expect(parseEnvFile('A=1\nA=2\n').get('A')).toBe('2');
  });
});

describe('setEnvValues', () => {
  it('changes only the one line and leaves every comment and blank line alone', () => {
    const next = setEnvValues(REAL_FILE, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-xyz' });
    const before = REAL_FILE.split('\n');
    const after = next.split('\n');
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i += 1) {
      if (before[i]?.startsWith('CLAUDE_CODE_OAUTH_TOKEN=')) {
        expect(after[i]).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-xyz');
      } else {
        expect(after[i]).toBe(before[i]);
      }
    }
  });

  it('is a byte-for-byte no-op when nothing is updated', () => {
    expect(setEnvValues(REAL_FILE, {})).toBe(REAL_FILE);
  });

  it('appends an unknown key at the end', () => {
    const next = setEnvValues(REAL_FILE, { CXW_TZ: 'Europe/Prague' });
    expect(next.startsWith(REAL_FILE)).toBe(true);
    expect(next.trimEnd().endsWith('CXW_TZ=Europe/Prague')).toBe(true);
  });

  it('appends into an empty file without a leading blank line', () => {
    expect(setEnvValues('', { A: '1' })).toBe('A=1\n');
  });

  it('adds the missing final newline before appending', () => {
    expect(setEnvValues('A=1', { B: '2' })).toBe('A=1\nB=2\n');
  });

  it('rewrites every occurrence of a duplicated key', () => {
    expect(setEnvValues('A=1\nB=x\nA=2\n', { A: '9' })).toBe('A=9\nB=x\nA=9\n');
  });

  it('preserves an export prefix position and CRLF endings', () => {
    const text = '# c\r\nexport A=1\r\n';
    const next = setEnvValues(text, { A: '2', B: '3' });
    expect(next).toBe('# c\r\nexport A=2\r\nB=3\r\n');
  });

  it('preserves indentation on a replaced line', () => {
    expect(setEnvValues('  A=1\n', { A: '2' })).toBe('  A=2\n');
  });
});

describe('writeEnvFile', () => {
  it('writes at mode 0600 and reads back identically', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cxw-env-')), 'nested', 'cxw.env');
    writeEnvFile(path, REAL_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe(REAL_FILE);
  });

  it('readEnvFile returns empty for a missing file', () => {
    expect(readEnvFile(join(tmpdir(), 'cxw-no-such-file-ever'))).toBe('');
  });

  it('updateEnvFile round trips twice to the same bytes', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cxw-env-')), 'cxw.env');
    writeEnvFile(path, REAL_FILE);
    updateEnvFile(path, { ANTHROPIC_API_KEY: 'sk-ant-abc' });
    const once = readFileSync(path, 'utf8');
    updateEnvFile(path, { ANTHROPIC_API_KEY: 'sk-ant-abc' });
    expect(readFileSync(path, 'utf8')).toBe(once);
  });
});
