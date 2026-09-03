// `node:sqlite` is stable enough for our use but still prints an ExperimentalWarning.
// Filter it here only, so library code stays free of process-wide side effects.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  console.warn(`${warning.name}: ${warning.message}`);
});

import { deliver, reconcile, readAlertState, writeAlertState } from './alerts.js';
import { loadConfig } from './config.js';
import {
  capStatusLine,
  dailyCostLine,
  monthTotals,
  notifyCap,
  todayTotals,
  unpause,
} from './costs.js';
import { statusText } from './commands.js';
import { healActions, readHealth, runHealth } from './health.js';
import { panic, resume } from './killswitch.js';
import { logger } from './logger.js';
import { loadOwners } from './owners.js';
import { OpsError, purge } from './retention.js';
import { runSentinel } from './sentinel.js';
import { ensureStateDir } from './state.js';

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function cmdHealth(args: string[]): Promise<number> {
  const cfg = loadConfig();
  ensureStateDir(cfg);
  const json = args.includes('--json');
  const noAlert = args.includes('--no-alert');
  const report = await runHealth(cfg);
  const heals = healActions(report);

  if (json) {
    out(
      JSON.stringify({
        ts: report.ts,
        ok: report.ok,
        checks: report.checks.map((c) => ({
          name: c.name,
          ok: c.ok,
          detail: c.detail,
          healAction: c.healAction,
        })),
        heals,
      }),
    );
  } else {
    for (const c of report.checks) out(`${c.ok ? 'OK' : 'FAIL'} ${c.name} - ${c.detail}`);
    for (const action of heals) out(`HEAL ${action}`);
  }

  if (!noAlert) {
    try {
      const owners = loadOwners(cfg);
      const alertable = report.checks.filter((c) => c.noAlert !== true);
      const previous = readAlertState(cfg);
      const { next, toSend } = reconcile(previous, alertable, Date.now(), {
        repeatMin: cfg.alert.repeatMin,
        afterFailures: cfg.alert.afterFailures,
      });
      writeAlertState(cfg, next);
      if (toSend.length > 0) {
        const whatsappOk = report.checks.find((c) => c.name === 'whatsapp')?.ok === true;
        await deliver(
          toSend.map((a) => a.text),
          { whatsappOk, owners },
          cfg,
        );
      }
    } catch (err) {
      // Delivery problems are logged; they never change the health exit code.
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'alerting failed');
    }
  }
  return report.ok ? 0 : 1;
}

async function cmdAlertTest(args: string[]): Promise<number> {
  const cfg = loadConfig();
  ensureStateDir(cfg);
  const text = args.join(' ').trim();
  if (text === '') {
    out('usage: cxw-ops alert-test <text...>');
    return 64;
  }
  const whatsappOk = readHealth(cfg)?.checks.find((c) => c.name === 'whatsapp')?.ok === true;
  const result = await deliver([text], { whatsappOk }, cfg);
  return result.channel === null ? 1 : 0;
}

function cmdPurge(args: string[]): number {
  const cfg = loadConfig();
  ensureStateDir(cfg);
  let result;
  try {
    result = purge(
      { dryRun: args.includes('--dry-run'), emergency: args.includes('--emergency') },
      cfg,
    );
  } catch (e) {
    // A refusal is not a crash: say why on stderr, keep stdout empty, exit 2.
    if (e instanceof OpsError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
  out(JSON.stringify(result));
  return 0;
}

async function cmdCosts(args: string[]): Promise<number> {
  const cfg = loadConfig();
  ensureStateDir(cfg);
  const sub = (args[0] ?? 'line').toLowerCase();
  switch (sub) {
    case 'today':
      out(JSON.stringify(todayTotals(cfg)));
      return 0;
    case 'month':
      out(JSON.stringify(monthTotals(cfg)));
      return 0;
    case 'check': {
      // The monitor tick calls this: it is the one place that may tell the owner.
      const whatsappOk = readHealth(cfg)?.checks.find((c) => c.name === 'whatsapp')?.ok === true;
      const result = await notifyCap((text) => deliver([text], { whatsappOk }, cfg), cfg);
      // Always one status line: the operator runs this to see the cap state, and printing
      // nothing after the month's notification is spent hides an active pause.
      out(capStatusLine(result));
      if (result.delivered && result.text !== null) out(result.text);
      return 0;
    }
    case 'unpause':
      out(unpause(cfg) ? 'unpaused' : 'nothing to unpause');
      return 0;
    case 'line':
      out(dailyCostLine(cfg));
      return 0;
    default:
      out(`unknown costs subcommand: ${sub}`);
      return 64;
  }
}

function usage(): void {
  out(
    [
      'usage: cxw-ops <command>',
      '  health [--json] [--no-alert]   run all checks, write health.json, alert',
      '  purge [--dry-run] [--emergency]',
      '  costs [today|month|line|check|unpause]',
      '  panic [reason]',
      '  resume',
      '  status',
      '  alert-test <text...>',
      '  sentinel                       long-running kill-switch watcher',
    ].join('\n'),
  );
}

async function main(argv: string[]): Promise<number> {
  const [command = '', ...args] = argv;
  switch (command) {
    case 'health':
      return cmdHealth(args);
    case 'purge':
      return cmdPurge(args);
    case 'costs':
      return cmdCosts(args);
    case 'alert-test':
      return cmdAlertTest(args);
    case 'panic': {
      const cfg = loadConfig();
      ensureStateDir(cfg);
      await panic(args.join(' ') || 'cli', 'cli', cfg);
      out('🛑 Panic: scheduler and brain stopping. Send `resume` to restart.');
      return 0;
    }
    case 'resume': {
      const cfg = loadConfig();
      ensureStateDir(cfg);
      await resume(cfg);
      out('▶️ Resumed.');
      return 0;
    }
    case 'status':
      out(statusText(loadConfig()));
      return 0;
    case 'sentinel': {
      const cfg = loadConfig();
      ensureStateDir(cfg);
      const handle = runSentinel(cfg);
      const stop = (): void => handle.stop();
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await handle.done;
      return 0;
    }
    default:
      usage();
      return command === '' || command === '--help' || command === '-h' ? 0 : 64;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'cxw-ops failed');
    process.exitCode = 1;
  });
