/**
 * Show the WhatsApp pairing QR code in a browser instead of only in a terminal.
 *
 *   pnpm pair:qr                      # run `pnpm pair`, serve the code at http://127.0.0.1:7899/
 *   pnpm pair:qr --replay data/x.log  # serve a recorded log, no WhatsApp (for testing)
 *   pnpm pair:qr --render data/x.log --out qr.svg   # one-shot: latest code to an SVG file
 *
 * What it does:
 * 1. Spawns `pnpm pair` from the repo root, with `.env` loaded into the child
 *    and relative `CXW_*` paths resolved against the repo root. Output goes to
 *    a log file (default `data/pair-qr.log`, git-ignored) and to the parser.
 * 2. Parses every half-block QR the child prints and renders the newest as SVG.
 * 3. Serves a small page on 127.0.0.1 that polls `/status.json` and swaps the
 *    image when WhatsApp rotates the code (about every 20 s).
 * 4. Relaunches `pnpm pair` when it exits without `Linked.`, because WhatsApp
 *    closes the socket after roughly 60 s with no scan. Stops after
 *    `--attempts` runs, on `Linked.`, or on `session logged out`.
 *
 * Steps 1 and 4 duplicate two fixes in flight on branch `phase-1-bridge`
 * (auto-load `.env`, reconnect through the QR timeout). Once those merge the
 * child keeps itself alive and this launcher's loop rarely fires. Both
 * behaviours are harmless together, so nothing here needs to change then.
 *
 * Nothing secret is printed: the QR itself is a one-time link token that
 * WhatsApp invalidates within a minute, and the log lives under `data/`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { blockToMatrix, extractQrBlocks, latestQr, toSvg } from './qr.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_PORT = 7899;
const DEFAULT_ATTEMPTS = 40;
const RELAUNCH_DELAY_MS = 2_000;
/** Two exits this fast in a row means `pnpm pair` cannot start at all. */
const FAST_EXIT_MS = 3_000;
const PATH_KEYS = ['CXW_DATA_DIR', 'CXW_DB_PATH', 'CXW_OWNERS_FILE', 'CXW_STATE_DIR'];

type Status = 'starting' | 'waiting' | 'linked' | 'logged-out' | 'gave-up' | 'unavailable';

interface State {
  status: Status;
  attempt: number;
  qrCount: number;
  /** Codes seen in the current `pnpm pair` run. */
  qrCountThisRun: number;
  svg: string | null;
  updatedAt: string;
  note: string;
}

interface Args {
  readonly port: number;
  readonly attempts: number;
  readonly log: string;
  readonly replay?: string;
  readonly render?: string;
  readonly out?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const port = Number(get('--port') ?? DEFAULT_PORT);
  const attempts = Number(get('--attempts') ?? DEFAULT_ATTEMPTS);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('--port must be 1-65535');
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('--attempts must be >= 1');
  const replay = get('--replay');
  const render = get('--render');
  const out = get('--out');
  return {
    port,
    attempts,
    log: resolve(REPO_ROOT, get('--log') ?? 'data/pair-qr.log'),
    ...(replay === undefined ? {} : { replay: resolve(replay) }),
    ...(render === undefined ? {} : { render: resolve(render) }),
    ...(out === undefined ? {} : { out: resolve(out) }),
  };
}

/** `.env` fills in what the shell did not set; relative CXW paths become absolute. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  const envFile = resolve(REPO_ROOT, '.env');
  if (env.NODE_ENV !== 'production' && existsSync(envFile)) {
    for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
      if (env[key] === undefined && value !== undefined) env[key] = value;
    }
  }
  for (const key of PATH_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '' && !isAbsolute(value))
      env[key] = resolve(REPO_ROOT, value);
  }
  return env;
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link WhatsApp</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#172420;font:15px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
  main{text-align:center;padding:24px;max-width:560px}
  img{width:min(72vmin,480px);height:auto;display:block;margin:0 auto 14px;background:#fff}
  img[hidden]{display:none}
  p{margin:0 0 4px;color:#5b6b65}
  b{color:#172420}
  #st{font-family:ui-monospace,Menlo,monospace;font-size:12px;margin-top:10px}
  .done{font-size:22px;color:#1f7a4d;font-weight:600}
</style>
<main>
  <img id="qr" alt="WhatsApp link QR code" hidden>
  <p id="lead"><b>Waiting for the first code</b></p>
  <p>On the phone: <b>WhatsApp → Settings → Linked devices → Link a device</b></p>
  <p>The code changes every ~20 s. This page follows it. Keep the terminal running.</p>
  <p id="st"></p>
</main>
<script>
  const img=document.getElementById('qr'),st=document.getElementById('st'),lead=document.getElementById('lead');
  let shown=0;
  async function tick(){
    try{
      const r=await fetch('/status.json?t='+Date.now(),{cache:'no-store'});
      const s=await r.json();
      if(s.status==='linked'){img.hidden=true;lead.className='done';lead.textContent='Linked. You can close this tab.';st.textContent='';return;}
      if(s.status==='logged-out'||s.status==='gave-up'||s.status==='unavailable'){img.hidden=true;lead.textContent=s.note;st.textContent='';return;}
      if(s.qrCount>0){ if(s.qrCount!==shown){img.src='/qr.svg?v='+s.qrCount;shown=s.qrCount;} img.hidden=false;lead.innerHTML='<b>Scan this code</b>'; }
      st.textContent='code '+s.qrCount+' · run '+s.attempt+' · '+s.status;
    }catch(e){st.textContent='page lost the local server; is pair:qr still running?';}
    setTimeout(tick,2000);
  }
  tick();
</script>
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.render !== undefined) {
    const matrix = latestQr(readFileSync(args.render, 'utf8'), { final: true });
    if (matrix === null) {
      console.error(`no QR block found in ${args.render}`);
      process.exit(1);
    }
    const svg = toSvg(matrix);
    if (args.out === undefined) process.stdout.write(svg);
    else {
      writeFileSync(args.out, svg);
      console.log(`wrote ${args.out} (${String(matrix.width)}x${String(matrix.height)} modules)`);
    }
    return;
  }

  const state: State = {
    status: 'starting',
    attempt: 0,
    qrCount: 0,
    qrCountThisRun: 0,
    svg: null,
    updatedAt: new Date().toISOString(),
    note: '',
  };
  const setStatus = (status: Status, note = ''): void => {
    state.status = status;
    state.note = note;
    state.updatedAt = new Date().toISOString();
    console.log(`[pair-qr] ${status}${note === '' ? '' : `: ${note}`}`);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/status.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(
        JSON.stringify({
          status: state.status,
          attempt: state.attempt,
          qrCount: state.qrCount,
          updatedAt: state.updatedAt,
          note: state.note,
        }),
      );
      return;
    }
    if (path === '/qr.svg') {
      if (state.svg === null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no code yet');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(state.svg);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  server.listen(args.port, '127.0.0.1', () => {
    console.log(`[pair-qr] open http://127.0.0.1:${String(args.port)}/ to scan the code`);
  });

  /** Feed the parser. `buffer` is the output of the current run only. */
  let buffer = '';
  const ingest = (chunk: string): void => {
    buffer += chunk;
    const blocks = extractQrBlocks(buffer);
    if (blocks.length > state.qrCountThisRun) {
      const last = blocks[blocks.length - 1];
      if (last !== undefined) {
        state.svg = toSvg(blockToMatrix(last));
        state.qrCount += blocks.length - state.qrCountThisRun;
        state.qrCountThisRun = blocks.length;
        setStatus('waiting', `code ${String(state.qrCount)} ready`);
      }
    }
    if (/^Linked\./m.test(buffer)) setStatus('linked');
    if (/session logged out/.test(buffer)) {
      setStatus(
        'logged-out',
        'WhatsApp says this session is logged out. Delete the session folder and pair again.',
      );
    }
  };

  let child: ChildProcess | null = null;
  let fastExits = 0;
  const finish = (code: number): void => {
    // Give the page a few polls to show the final state before we go.
    setTimeout(() => {
      server.close();
      process.exit(code);
    }, 6_000).unref();
  };

  const launch = (): void => {
    if (state.status === 'linked' || state.status === 'logged-out') return;
    if (state.attempt >= args.attempts) {
      setStatus(
        'gave-up',
        `no scan after ${String(args.attempts)} runs. Run pnpm pair:qr again with the phone in hand.`,
      );
      finish(1);
      return;
    }
    state.attempt += 1;
    state.qrCountThisRun = 0;
    buffer = '';
    const startedAt = Date.now();
    const log = createWriteStream(args.log, { flags: 'a' });
    log.write(`=== pair run ${String(state.attempt)} ${new Date().toISOString()}\n`);
    child = spawn('pnpm', ['pair'], {
      cwd: REPO_ROOT,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (data: Buffer): void => {
      const text = data.toString('utf8');
      log.write(text);
      ingest(text);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => {
      log.end();
      setStatus('unavailable', `could not start pnpm: ${error.message}`);
      finish(1);
    });
    child.on('exit', (code) => {
      log.end();
      child = null;
      if (state.status === 'linked') {
        finish(0);
        return;
      }
      if (state.status === 'logged-out') {
        finish(1);
        return;
      }
      if (Date.now() - startedAt < FAST_EXIT_MS && state.qrCountThisRun === 0) {
        fastExits += 1;
        if (fastExits >= 2) {
          setStatus(
            'unavailable',
            `pnpm pair exited at once (code ${String(code)}) twice. It lands with phase 1; check the log at ${args.log}.`,
          );
          finish(1);
          return;
        }
      } else {
        fastExits = 0;
      }
      console.log(`[pair-qr] pnpm pair exited (code ${String(code)}); relaunching in 2 s`);
      setTimeout(launch, RELAUNCH_DELAY_MS);
    });
  };

  const stop = (): void => {
    if (child !== null) child.kill('SIGINT');
    server.close();
    process.exit(130);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  mkdirSync(dirname(args.log), { recursive: true });

  if (args.replay !== undefined) {
    // Feed a recorded log through the same parser, one line every 150 ms, so
    // the page can be tested without a phone or a WhatsApp socket.
    state.attempt = 1;
    state.qrCountThisRun = 0;
    const lines = readFileSync(args.replay, 'utf8').split('\n');
    let i = 0;
    const step = (): void => {
      const line = lines[i];
      if (line === undefined) return;
      i += 1;
      ingest(`${line}\n`);
      if (state.status === 'linked') {
        finish(0);
        return;
      }
      setTimeout(step, 150);
    };
    step();
    return;
  }

  launch();
}

main();
