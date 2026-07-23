/**
 * Read-only built-in tools run without a permission prompt anywhere — in-app
 * chats, Telegram chats, and missions. Everything else (writes, commands, MCP
 * calls) keeps its gate.
 */
export const AUTO_ALLOWED_TOOLS = new Set([
  'ws_list',
  'ws_read',
  'look_at_image',
  'file_identify',
  'web_search',
  'web_fetch',
  'mission_list',
  'memory_recall',
  'memory_note',
  'archive_search',
  'archive_read',
  'map_query',
  'map_update',
]);
