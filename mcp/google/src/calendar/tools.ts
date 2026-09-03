/**
 * Calendar tools.
 *
 * Writes that would e-mail somebody else — any attendee who is not the owner —
 * go through the confirm gate. Owner-only or attendee-free changes are applied
 * straight away with `sendUpdates: 'none'`, because nobody is disturbed.
 */
import { z } from 'zod';
import type { calendar_v3 } from 'googleapis';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatConfirmPrompt } from '@cxw/shared';
import type { Deps } from '../deps.js';
import type { TextResult } from '../tools/result.js';
import { UNTRUSTED_NOTE, fail, guard, ok, truncate, untrusted } from '../tools/result.js';
import {
  formatInTz,
  hasExplicitOffset,
  hasThirdParty,
  resolveDay,
  timeInTz,
  zonedDayRange,
} from './range.js';

export const CREATE_KIND = 'calendar_create_event';
export const UPDATE_KIND = 'calendar_update_event';

const attendee = z.string().trim().min(3);

export const listEventsShape = {
  day: z.string().optional().describe('today | tomorrow | yesterday | YYYY-MM-DD (default today)'),
  time_min: z.string().optional().describe('ISO timestamp; overrides `day`.'),
  time_max: z.string().optional(),
  calendar_id: z.string().optional(),
  q: z.string().optional(),
  include_description: z.boolean().optional(),
  max_results: z.number().int().min(1).max(250).optional(),
};

export const freebusyShape = {
  time_min: z.string().min(4),
  time_max: z.string().min(4),
  calendar_ids: z.array(z.string()).optional(),
};

// `summary`, `start`, `end` and `event_id` are optional in the *schema* on purpose:
// the confirming call carries `confirm_token` and nothing else (docs/CONFIRM_GATE.md),
// and the SDK validates `inputSchema` before the handler runs. They are required in
// the no-token branch instead, exactly like `gmail_send` treats `body`.
export const createEventShape = {
  summary: z.string().min(1).optional().describe('Required unless confirm_token is given.'),
  start: z
    .string()
    .min(4)
    .optional()
    .describe('ISO datetime, or YYYY-MM-DD when all_day. Required unless confirm_token is given.'),
  end: z.string().min(4).optional().describe('Required unless confirm_token is given.'),
  all_day: z.boolean().optional(),
  attendees: z.array(attendee).optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  calendar_id: z.string().optional(),
  confirm_token: z
    .string()
    .optional()
    .describe('Only ever the token from the owner’s own `yes <TOKEN>` reply.'),
};

export const updateEventShape = {
  event_id: z.string().min(1).optional().describe('Required unless confirm_token is given.'),
  calendar_id: z.string().optional(),
  summary: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  all_day: z.boolean().optional(),
  attendees: z.array(attendee).optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  confirm_token: z.string().optional(),
};

export type ListEventsArgs = z.infer<z.ZodObject<typeof listEventsShape>>;
export type FreebusyArgs = z.infer<z.ZodObject<typeof freebusyShape>>;
export type CreateEventArgs = z.infer<z.ZodObject<typeof createEventShape>>;
export type UpdateEventArgs = z.infer<z.ZodObject<typeof updateEventShape>>;

export interface CreatePayload {
  calendarId: string;
  requestBody: calendar_v3.Schema$Event;
  sendUpdates: 'all' | 'none';
}

export interface UpdatePayload extends CreatePayload {
  eventId: string;
}

function eventTime(
  value: string,
  allDay: boolean,
  tz: string,
): { date: string } | { dateTime: string; timeZone: string } {
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value.trim())) {
      throw new Error(`all-day events need YYYY-MM-DD, got ${JSON.stringify(value)}`);
    }
    return { date: value.trim() };
  }
  const trimmed = value.trim();
  if (Number.isNaN(new Date(trimmed).getTime())) {
    throw new Error(`bad timestamp ${JSON.stringify(value)}`);
  }
  // A naive wall-clock time carries no instant. Hand it to Google as-is together with
  // the owner's zone; normalising it here would resolve it in the process timezone.
  if (!hasExplicitOffset(trimmed)) return { dateTime: trimmed, timeZone: tz };
  return { dateTime: new Date(trimmed).toISOString(), timeZone: tz };
}

function describeWhen(event: calendar_v3.Schema$Event, tz: string): string {
  const start = event.start ?? {};
  const end = event.end ?? {};
  if (start.date != null) return `all day ${start.date}`;
  const from = start.dateTime != null ? formatInTz(start.dateTime, tz) : '?';
  const to = end.dateTime != null ? timeInTz(end.dateTime, tz) : '?';
  return `${from}–${to}`;
}

export async function calendarListEvents(deps: Deps, args: ListEventsArgs): Promise<TextResult> {
  return guard(async () => {
    const calendarId = args.calendar_id ?? 'primary';
    let timeMin = args.time_min;
    let timeMax = args.time_max;
    let label: string;
    if (timeMin === undefined && timeMax === undefined) {
      const day = resolveDay(args.day ?? 'today', deps.now(), deps.tz);
      const range = zonedDayRange(day, deps.tz);
      timeMin = range.timeMin;
      timeMax = range.timeMax;
      label = day;
    } else {
      label = `${timeMin ?? '…'} → ${timeMax ?? '…'}`;
    }

    const params: calendar_v3.Params$Resource$Events$List = {
      calendarId,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: args.max_results ?? 25,
      timeZone: deps.tz,
    };
    if (timeMin !== undefined) params.timeMin = timeMin;
    if (timeMax !== undefined) params.timeMax = timeMax;
    if (args.q !== undefined && args.q.trim() !== '') params.q = args.q;

    const res = await deps.calendar.events.list(params);
    const events = res.data.items ?? [];
    if (events.length === 0) return ok(`No events on ${label} (${calendarId}).`);

    const lines = events.map((event) => {
      // Only the timing and the id are ours; summary, location, attendee addresses and
      // description all come from whoever created or was invited to the event, so the
      // whole rendered block goes inside one fence.
      const head = `- [id=${event.id ?? '?'}] ${describeWhen(event, deps.tz)}`;
      const parts = [event.summary ?? '(no title)'];
      if (event.location != null && event.location !== '') parts.push(`@${event.location}`);
      const attendees = event.attendees ?? [];
      if (attendees.length > 0) {
        parts.push(
          `· attendees: ${attendees
            .map((a) => `${a.email ?? '?'} (${a.responseStatus ?? 'needsAction'})`)
            .join(', ')}`,
        );
      }
      let content = parts.join(' ');
      if (args.include_description === true) {
        const description = (event.description ?? '').trim();
        if (description !== '') content += `\n${truncate(description, 2000)}`;
      }
      return `${head}\n  ${untrusted('CALENDAR', content).split('\n').join('\n  ')}`;
    });
    return ok(`${events.length} event(s) on ${label} (${calendarId}):\n${lines.join('\n')}`);
  });
}

export async function calendarFreebusy(deps: Deps, args: FreebusyArgs): Promise<TextResult> {
  return guard(async () => {
    const ids = args.calendar_ids ?? ['primary'];
    const res = await deps.calendar.freebusy.query({
      requestBody: {
        timeMin: args.time_min,
        timeMax: args.time_max,
        timeZone: deps.tz,
        items: ids.map((id) => ({ id })),
      },
    });
    const calendars = res.data.calendars ?? {};
    const windowStart = new Date(args.time_min).getTime();
    const windowEnd = new Date(args.time_max).getTime();
    const lines: string[] = [];
    for (const id of ids) {
      const entry = calendars[id];
      const busy = (entry?.busy ?? []).filter((b) => b.start != null && b.end != null);
      lines.push(`${id}:`);
      const errors = entry?.errors ?? [];
      if (errors.length > 0) {
        lines.push(`  error: ${errors.map((e) => e.reason ?? '?').join(', ')}`);
        continue;
      }
      if (busy.length === 0) {
        lines.push('  busy: (none)');
      } else {
        for (const block of busy) {
          lines.push(
            `  busy ${formatInTz(String(block.start), deps.tz)}–${timeInTz(String(block.end), deps.tz)}`,
          );
        }
      }
      if (!Number.isNaN(windowStart) && !Number.isNaN(windowEnd)) {
        let cursor = windowStart;
        const free: string[] = [];
        for (const block of busy) {
          const start = new Date(String(block.start)).getTime();
          const end = new Date(String(block.end)).getTime();
          if (start > cursor) {
            free.push(
              `${formatInTz(new Date(cursor).toISOString(), deps.tz)}–${timeInTz(new Date(start).toISOString(), deps.tz)}`,
            );
          }
          cursor = Math.max(cursor, end);
        }
        if (cursor < windowEnd) {
          free.push(
            `${formatInTz(new Date(cursor).toISOString(), deps.tz)}–${timeInTz(new Date(windowEnd).toISOString(), deps.tz)}`,
          );
        }
        lines.push(`  free: ${free.length > 0 ? free.join(', ') : '(none)'}`);
      }
    }
    return ok(lines.join('\n'));
  });
}

function buildEventBody(
  args: {
    summary?: string | undefined;
    start?: string | undefined;
    end?: string | undefined;
    all_day?: boolean | undefined;
    attendees?: string[] | undefined;
    description?: string | undefined;
    location?: string | undefined;
  },
  tz: string,
): calendar_v3.Schema$Event {
  const allDay = args.all_day === true;
  const body: calendar_v3.Schema$Event = {};
  if (args.summary !== undefined) body.summary = args.summary;
  if (args.start !== undefined) body.start = eventTime(args.start, allDay, tz);
  if (args.end !== undefined) body.end = eventTime(args.end, allDay, tz);
  if (args.description !== undefined) body.description = args.description;
  if (args.location !== undefined) body.location = args.location;
  if (args.attendees !== undefined) body.attendees = args.attendees.map((e) => ({ email: e }));
  return body;
}

function previewEvent(title: string, body: calendar_v3.Schema$Event, calendarId: string): string {
  const lines = [title, `Calendar: ${calendarId}`, `Summary: ${body.summary ?? '(unchanged)'}`];
  if (body.start != null) lines.push(`Start: ${body.start.dateTime ?? body.start.date ?? '?'}`);
  if (body.end != null) lines.push(`End: ${body.end.dateTime ?? body.end.date ?? '?'}`);
  if (body.location != null) lines.push(`Location: ${body.location}`);
  const attendees = body.attendees ?? [];
  if (attendees.length > 0) {
    lines.push(`Attendees (they will be e-mailed): ${attendees.map((a) => a.email).join(', ')}`);
  }
  if (body.description != null && body.description !== '') {
    lines.push('', truncate(body.description, 500));
  }
  return lines.join('\n');
}

export async function calendarCreateEvent(deps: Deps, args: CreateEventArgs): Promise<TextResult> {
  return guard(async () => {
    const token = args.confirm_token?.trim();
    if (token !== undefined && token !== '') {
      const action = await deps.confirm.take(token);
      if (action === null) {
        return fail('Token invalid, expired or already used. Ask for a new preview.');
      }
      if (action.kind !== CREATE_KIND) {
        return fail(`Token belongs to ${action.kind}, not ${CREATE_KIND}. It has been discarded.`);
      }
      // The stored payload is authoritative; args other than the token are ignored.
      const payload = action.payload as CreatePayload;
      const res = await deps.calendar.events.insert(payload);
      return ok(`Event created and invitations sent. id=${res.data.id ?? '?'}`);
    }

    const missing = (['summary', 'start', 'end'] as const).filter(
      (key) => (args[key] ?? '').trim() === '',
    );
    if (missing.length > 0) {
      return fail(`missing required field(s): ${missing.join(', ')} (or pass a confirm_token)`);
    }

    const calendarId = args.calendar_id ?? 'primary';
    const body = buildEventBody(args, deps.tz);
    if (hasThirdParty(args.attendees, deps.ownerEmail)) {
      const payload: CreatePayload = { calendarId, requestBody: body, sendUpdates: 'all' };
      const action = await deps.confirm.mint({
        kind: CREATE_KIND,
        preview: previewEvent('📅 Create event + invite', body, calendarId),
        payload,
        source: 'mcp-google',
      });
      return ok(
        `${formatConfirmPrompt(action)}\n\nconfirm_token: ${action.token}\n` +
          'Nothing has been created yet. Relay this to the owner and wait for their reply.',
      );
    }
    const res = await deps.calendar.events.insert({
      calendarId,
      requestBody: body,
      sendUpdates: 'none',
    });
    return ok(`Event created. id=${res.data.id ?? '?'} (no other attendees, nobody was e-mailed)`);
  });
}

export async function calendarUpdateEvent(deps: Deps, args: UpdateEventArgs): Promise<TextResult> {
  return guard(async () => {
    const token = args.confirm_token?.trim();
    if (token !== undefined && token !== '') {
      const action = await deps.confirm.take(token);
      if (action === null) {
        return fail('Token invalid, expired or already used. Ask for a new preview.');
      }
      if (action.kind !== UPDATE_KIND) {
        return fail(`Token belongs to ${action.kind}, not ${UPDATE_KIND}. It has been discarded.`);
      }
      const payload = action.payload as UpdatePayload;
      const res = await deps.calendar.events.patch(payload);
      return ok(`Event updated and attendees notified. id=${res.data.id ?? payload.eventId}`);
    }

    const eventId = (args.event_id ?? '').trim();
    if (eventId === '')
      return fail('missing required field(s): event_id (or pass a confirm_token)');

    const calendarId = args.calendar_id ?? 'primary';
    const body = buildEventBody(args, deps.tz);
    const existing = await deps.calendar.events.get({ calendarId, eventId });
    const gate =
      hasThirdParty(existing.data.attendees ?? [], deps.ownerEmail) ||
      hasThirdParty(args.attendees, deps.ownerEmail);
    if (gate) {
      const payload: UpdatePayload = {
        calendarId,
        eventId,
        requestBody: body,
        sendUpdates: 'all',
      };
      const action = await deps.confirm.mint({
        kind: UPDATE_KIND,
        preview: previewEvent(
          `📅 Update event "${existing.data.summary ?? eventId}"`,
          body,
          calendarId,
        ),
        payload,
        source: 'mcp-google',
      });
      return ok(
        `${formatConfirmPrompt(action)}\n\nconfirm_token: ${action.token}\n` +
          'Nothing has been changed yet. Relay this to the owner and wait for their reply.',
      );
    }
    const res = await deps.calendar.events.patch({
      calendarId,
      eventId,
      requestBody: body,
      sendUpdates: 'none',
    });
    return ok(`Event updated. id=${res.data.id ?? eventId} (no other attendees)`);
  });
}

export function registerCalendarTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'calendar_list_events',
    {
      title: 'List calendar events',
      description: `List events for a day or an explicit range, in the owner's timezone. Use day: 'tomorrow' for "what's on tomorrow?". ${UNTRUSTED_NOTE}`,
      inputSchema: listEventsShape,
    },
    async (args) => calendarListEvents(deps, args),
  );

  server.registerTool(
    'calendar_freebusy',
    {
      title: 'Free/busy lookup',
      description: 'Busy blocks and the free gaps between them, for one or more calendars.',
      inputSchema: freebusyShape,
    },
    async (args) => calendarFreebusy(deps, args),
  );

  server.registerTool(
    'calendar_create_event',
    {
      title: 'Create a calendar event (confirmation when others are invited)',
      description:
        'Creates an event. With no attendees other than the owner it is created immediately. ' +
        'With other attendees it returns a preview and a confirm_token and creates nothing; call it ' +
        'again with that token only after the owner replies `yes <TOKEN>` themselves.',
      inputSchema: createEventShape,
    },
    async (args) => calendarCreateEvent(deps, args),
  );

  server.registerTool(
    'calendar_update_event',
    {
      title: 'Update a calendar event (confirmation when others are involved)',
      description:
        'Patches an existing event. If the event has, or gains, attendees other than the owner it ' +
        'returns a preview and a confirm_token and changes nothing until the owner confirms.',
      inputSchema: updateEventShape,
    },
    async (args) => calendarUpdateEvent(deps, args),
  );
}
