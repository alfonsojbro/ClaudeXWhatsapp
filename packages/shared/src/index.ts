/**
 * @cxw/shared — types and helpers used by every service in ClaudeXWhatsapp.
 * Phase 0: identity + service banner only. Config loader, logger, and the
 * WhatsApp text chunker land in later phases.
 */

export const PROJECT = 'claudexwhatsapp' as const;

export type ServiceName =
  'bridge' | 'brain' | 'scheduler' | 'mcp-whatsapp' | 'mcp-google' | 'mcp-vault';

export interface ServiceInfo {
  readonly project: typeof PROJECT;
  readonly service: ServiceName;
  readonly node: string;
  readonly startedAt: string;
}

/** Build the identity record a service logs on start-up. */
export function serviceInfo(service: ServiceName, now: Date = new Date()): ServiceInfo {
  return {
    project: PROJECT,
    service,
    node: process.version,
    startedAt: now.toISOString(),
  };
}

/** One-line start-up banner, e.g. `claudexwhatsapp/bridge started (node v22.x)`. */
export function banner(info: ServiceInfo): string {
  return `${info.project}/${info.service} started (node ${info.node}) at ${info.startedAt}`;
}

export * from './confirm.js';
