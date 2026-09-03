/** Authenticated googleapis clients built from a refresh token. No browser, ever. */
import { google } from 'googleapis';
import type { calendar_v3, gmail_v1, people_v1 } from 'googleapis';
import type { GoogleConfig } from './config.js';

export interface GoogleClients {
  gmail: gmail_v1.Gmail;
  calendar: calendar_v3.Calendar;
  people: people_v1.People;
}

export function createClients(
  cfg: Pick<GoogleConfig, 'clientId' | 'clientSecret' | 'refreshToken'>,
): GoogleClients {
  const auth = new google.auth.OAuth2({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
  auth.setCredentials({ refresh_token: cfg.refreshToken });
  return {
    gmail: google.gmail({ version: 'v1', auth }),
    calendar: google.calendar({ version: 'v3', auth }),
    people: google.people({ version: 'v1', auth }),
  };
}
