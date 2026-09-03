/**
 * The last page: what this box can actually do, right now.
 *
 * The wording comes from the getting-started guide's "What you get" list. The difference is
 * that every item carries the phase that provides it, and an item whose phase has not merged
 * renders as "lands with phase N" instead of as a promise. That rule exists because this page
 * is the last thing a new person reads before they try the assistant: a list that overstates
 * what works turns into ten minutes of them thinking they set it up wrong.
 *
 * `mergedPhases` is passed in rather than detected. Detection would mean probing for files that
 * may exist in a worktree but not on the branch, which is exactly the kind of guess that would
 * put a false promise on this page.
 */

import type { SetupState } from '../state.js';
import { TESTING_REFRESH_TOKEN_DAYS } from './google.js';

export interface Capability {
  /** One sentence, in the guide's voice. */
  readonly text: string;
  /** The phase that makes it true. */
  readonly phase: number;
}

export const CAPABILITIES: readonly Capability[] = [
  { text: 'Message the assistant on WhatsApp and get an answer.', phase: 1 },
  { text: 'Ask about your own WhatsApp history: it searches the chats it has synced.', phase: 1 },
  { text: 'Hold a conversation with memory across messages, and start over with /new.', phase: 2 },
  { text: 'Tell it to remember something, and find it again weeks later.', phase: 2 },
  { text: 'Send it a photo, a PDF, a voice note or a video and get a summary back.', phase: 3 },
  { text: 'Ask what is on your calendar, and what arrived in Gmail.', phase: 4 },
  { text: 'Have it draft a reply or an event, then approve it by answering in WhatsApp.', phase: 4 },
  { text: 'Get a morning brief, an evening close and a weekly review on a schedule.', phase: 5 },
  { text: 'Watch a second brain grow: Markdown notes, committed to your own git vault.', phase: 6 },
  { text: 'See the whole box in a web console, and stop it from there.', phase: 8 },
];

export interface DoneItem {
  readonly text: string;
  readonly phase: number;
  readonly available: boolean;
}

export function capabilityItems(mergedPhases: readonly number[]): readonly DoneItem[] {
  const merged = new Set(mergedPhases);
  return CAPABILITIES.map((capability) => ({
    ...capability,
    available: merged.has(capability.phase),
  }));
}

/**
 * The standing warning about a Google consent screen still in Testing.
 *
 * Only shown when Google was actually connected and the person did not confirm production.
 * A box with no Google at all does not need to hear about it.
 */
export function googleWarning(state: SetupState): string | null {
  if (state.steps.google.status !== 'done') return null;
  if (state.googleConsentConfirmed === true) return null;
  return (
    `Your Google consent screen was not confirmed as "In production". While it is in Testing, ` +
    `Google expires the refresh token after ${String(TESTING_REFRESH_TOKEN_DAYS)} days and Gmail ` +
    `and Calendar stop answering with no other warning. Publish the app, then run the Google step again.`
  );
}

export interface DoneView {
  readonly items: readonly DoneItem[];
  readonly warning: string | null;
  readonly skipped: readonly string[];
}

export function renderDone(state: SetupState, mergedPhases: readonly number[]): DoneView {
  const skipped = Object.entries(state.steps)
    .filter(([, record]) => record.status === 'skipped')
    .map(([id]) => id);
  return { items: capabilityItems(mergedPhases), warning: googleWarning(state), skipped };
}

/** How one item reads on the page. Kept here so the "lands with" wording has one source. */
export function capabilityLabel(item: DoneItem): string {
  return item.available ? item.text : `${item.text} — lands with phase ${String(item.phase)}`;
}
