/**
 * `@cxw/ops` — the operations layer.
 *
 * Public surface used by the other phases:
 *  - brain router: `handleOpsCommand`
 *  - brain + scheduler: `recordUsage`
 *  - scheduler: `getPauseState`, `dailyCostLine`, `checkCap`
 *  - monitor: `notifyCap` (the only caller allowed to tell the owner about the cap)
 *  - monitor/CLI: `runHealth`, `purge`
 */
export { loadConfig, splitPrefix } from './config.js';
export type {
  AlertConfig,
  AlertTransport,
  ClaudeConfig,
  Config,
  CostConfig,
  CtlConfig,
  GoogleConfig,
  RetentionConfig,
  SmtpConfig,
  TelegramConfig,
} from './config.js';

export { logger, maskJid, REDACT_PATHS } from './logger.js';
export { loadOwners, isOwnerJid, normalizeOwnerJid } from './owners.js';

export { runHealth, readHealth, healActions, HEALTH_FILE, PANIC_FILE } from './health.js';
export type { Check, HealAction, HealthReport } from './health.js';

export { deliver, reconcile, readAlertState, writeAlertState, alertTargetJid } from './alerts.js';
export type { Alert, AlertChannel, AlertEntry, AlertState, DeliverResult } from './alerts.js';

export {
  purge,
  resolveMediaPath,
  OpsError,
  PURGE_EMPTY_OWNERS_MESSAGE,
  PURGE_RESULT_FILE,
} from './retention.js';
export type { PurgeOptions, PurgeResult } from './retention.js';

export {
  capStatusLine,
  checkCap,
  notifyCap,
  computeCost,
  dailyCostLine,
  monthTotals,
  priceFor,
  PRICING,
  readCostPause,
  recordUsage,
  todayTotals,
  unpause,
  COST_PAUSED_FILE,
} from './costs.js';
export type {
  CapState,
  CostLevel,
  CostPauseFlag,
  ModelPrice,
  NotifyCapResult,
  NotifyCapStatus,
  Totals,
  UsageInput,
} from './costs.js';

export {
  ctl,
  getPauseState,
  panic,
  readPanic,
  resume,
  CTL_ACTIONS,
  CTL_UNITS,
} from './killswitch.js';
export type { CtlAction, CtlResult, CtlUnit, PanicFlag, PauseState } from './killswitch.js';

export { handleOpsCommand, statusText } from './commands.js';
export type { OpsCommandContext, OpsCommandDeps } from './commands.js';

export {
  executeHit,
  isKillSwitchText,
  isHandled,
  markHandled,
  pollOnce,
  runSentinel,
  PANIC_ACK,
  RESUME_ACK,
  SENTINEL_STATE_FILE,
} from './sentinel.js';
export type { SentinelHandle, SentinelHit, SentinelState } from './sentinel.js';
