/** Everything the tools need, injectable so tests can run fully offline. */
import { ConfirmStore } from '@cxw/shared';
import type { calendar_v3, gmail_v1, people_v1 } from 'googleapis';
import type { GoogleConfig } from './config.js';
import { createClients } from './clients.js';

export interface Deps {
  gmail: gmail_v1.Gmail;
  calendar: calendar_v3.Calendar;
  people: people_v1.People;
  confirm: ConfirmStore;
  ownerEmail: string;
  tz: string;
  /** Clock, so date-relative tools are testable. */
  now: () => Date;
  /** Config subset the token-check tool needs. */
  tokenConfig: Pick<GoogleConfig, 'clientId' | 'clientSecret' | 'refreshToken' | 'tokenUrl'>;
}

export function createDeps(cfg: GoogleConfig): Deps {
  const clients = createClients(cfg);
  return {
    gmail: clients.gmail,
    calendar: clients.calendar,
    people: clients.people,
    confirm: new ConfirmStore(cfg.confirmDir),
    ownerEmail: cfg.ownerEmail,
    tz: cfg.tz,
    now: () => new Date(),
    tokenConfig: {
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      refreshToken: cfg.refreshToken,
      tokenUrl: cfg.tokenUrl,
    },
  };
}
