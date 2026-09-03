#!/usr/bin/env node
// stub-services.mjs — tiny dependency-free HTTP stubs for `chaos.sh --local`.
//
//   node stub-services.mjs                  # start bridge + brain + google
//   node stub-services.mjs --only bridge    # start just one (fake-ctl.sh respawns the bridge)
//   node stub-services.mjs --help
//
// Env:
//   STUB_DIR           directory for <name>.pid files (default: the cwd)
//   STUB_BRIDGE_PORT   default 17801   GET /health, POST /send
//   STUB_BRAIN_PORT    default 17802   GET /health
//   STUB_GOOGLE_PORT   default 17803   POST /token
//   STUB_LOG           file the bridge appends every POST /send body to
//   STUB_GOOGLE_FAIL   when this file exists the google stub answers 401 invalid_grant
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const HELP = `stub-services.mjs — chaos stubs for ClaudeXWhatsapp ops

usage: node stub-services.mjs [--only bridge|brain|google] [--help]

services:
  bridge  127.0.0.1:\${STUB_BRIDGE_PORT:-17801}  GET /health, POST /send
  brain   127.0.0.1:\${STUB_BRAIN_PORT:-17802}   GET /health
  google  127.0.0.1:\${STUB_GOOGLE_PORT:-17803}  POST /token

env: STUB_DIR, STUB_BRIDGE_PORT, STUB_BRAIN_PORT, STUB_GOOGLE_PORT, STUB_LOG, STUB_GOOGLE_FAIL
`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
if (only && !['bridge', 'brain', 'google'].includes(only)) {
  process.stderr.write(`stub-services: unknown service "${only}"\n${HELP}`);
  process.exit(2);
}

const STUB_DIR = process.env.STUB_DIR || process.cwd();
const STUB_LOG = process.env.STUB_LOG || path.join(STUB_DIR, 'bridge-send.log');
const STUB_GOOGLE_FAIL = process.env.STUB_GOOGLE_FAIL || path.join(STUB_DIR, 'google-fail');
const PORTS = {
  bridge: Number(process.env.STUB_BRIDGE_PORT || 17801),
  brain: Number(process.env.STUB_BRAIN_PORT || 17802),
  google: Number(process.env.STUB_GOOGLE_PORT || 17803),
};

const startedAt = Date.now();

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => resolve(raw));
  });
}

const handlers = {
  bridge: async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      return json(res, 200, {
        ok: true,
        connected: true,
        selfJid: '10000000000@s.whatsapp.net',
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        sentToday: 0,
        dailyCap: 200,
      });
    }
    if (req.method === 'POST' && url === '/send') {
      const raw = await readBody(req);
      try {
        fs.appendFileSync(STUB_LOG, `${raw}\n`);
      } catch {
        /* the log is best-effort */
      }
      return json(res, 200, { ok: true, ids: ['stub'] });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  },

  brain: async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      return json(res, 200, { ok: true, sessions: 0 });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  },

  google: async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && (url === '/token' || url === '/')) {
      await readBody(req);
      if (fs.existsSync(STUB_GOOGLE_FAIL)) {
        return json(res, 401, { error: 'invalid_grant', error_description: 'stub failure toggled' });
      }
      return json(res, 200, { access_token: 'stub', expires_in: 3600, token_type: 'Bearer' });
    }
    return json(res, 404, { error: 'not found' });
  },
};

const names = only ? [only] : ['bridge', 'brain', 'google'];
const servers = [];

for (const name of names) {
  const server = http.createServer((req, res) => {
    handlers[name](req, res).catch(() => json(res, 500, { ok: false, error: 'stub error' }));
  });
  server.listen(PORTS[name], '127.0.0.1', () => {
    process.stdout.write(`stub ${name} listening on 127.0.0.1:${PORTS[name]}\n`);
  });
  servers.push(server);
}

try {
  fs.mkdirSync(STUB_DIR, { recursive: true });
  fs.writeFileSync(path.join(STUB_DIR, `${only || 'all'}.pid`), `${process.pid}\n`);
} catch {
  /* pid file is best-effort */
}

function shutdown() {
  for (const s of servers) s.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
