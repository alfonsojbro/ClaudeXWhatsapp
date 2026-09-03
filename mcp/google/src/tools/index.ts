/** Registers every tool this server exposes. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Deps } from '../deps.js';
import { registerGmailTools } from '../gmail/tools.js';
import { registerCalendarTools } from '../calendar/tools.js';
import { registerContactsTools } from '../contacts/tools.js';
import { registerTokenCheckTool } from '../token-check.js';

/** The 12 tool names, in registration order. Kept for tests and docs. */
export const TOOL_NAMES = [
  'gmail_search',
  'gmail_read',
  'gmail_draft',
  'gmail_send',
  'gmail_label',
  'gmail_archive',
  'calendar_list_events',
  'calendar_freebusy',
  'calendar_create_event',
  'calendar_update_event',
  'contacts_lookup',
  'google_token_check',
] as const;

export function registerTools(server: McpServer, deps: Deps): void {
  registerGmailTools(server, deps);
  registerCalendarTools(server, deps);
  registerContactsTools(server, deps);
  registerTokenCheckTool(server, deps);
}
