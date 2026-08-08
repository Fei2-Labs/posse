// browser-mcp.ts
//
// Standalone MCP server the ACP agent spawns as a stdio subprocess (ACP's only
// universally-required transport is stdio; there is no in-process option). It speaks
// the Model Context Protocol over stdin/stdout and, for each tool call, POSTs to the
// Electron main process's loopback browser-ops HTTP bridge (browser-ops-server.ts),
// which drives the user's visible embedded browser via EmbeddedBrowserController.
//
// Why a subprocess at all: ACP agents (claude/codex/copilot/kiro ACP wrappers) each
// spawn the MCP servers listed in `mcpServers` themselves. Posse cannot hand them an
// in-process function — only a command. So this file is the bridge's stdio face; the
// actual browser operations live in the Electron main process and are reached over
// authenticated loopback HTTP.
//
// Bundling: esbuild inlines @modelcontextprotocol/sdk + zod into a single
// dist/main/browser-mcp.js (see the build:browser-mcp script). No runtime node_modules
// needed — the file runs via process.execPath (Electron as node via
// ELECTRON_RUN_AS_NODE=1, or plain node in headless mode).
//
// Env (set by acp-client.ts resolveBrowserMcpCommand):
//   POSSE_BROWSER_OPS_URL   - e.g. http://127.0.0.1:<port>
//   POSSE_BROWSER_OPS_TOKEN - bearer token for the bridge

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BRIDGE_URL = process.env.POSSE_BROWSER_OPS_URL;
const BRIDGE_TOKEN = process.env.POSSE_BROWSER_OPS_TOKEN;
const BRIDGE_SESSION = process.env.POSSE_BROWSER_OPS_SESSION || '';

if (!BRIDGE_URL || !BRIDGE_TOKEN) {
  console.error('[browser-mcp] missing POSSE_BROWSER_OPS_URL / POSSE_BROWSER_OPS_TOKEN env');
  process.exit(1);
}

interface BridgeError {
  ok: false;
  error: string;
}
interface BridgeOk {
  ok: true;
  [key: string]: unknown;
}
type BridgeResponse = BridgeOk | BridgeError;

async function callBridge(op: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${BRIDGE_URL}/${op}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${BRIDGE_TOKEN}`,
      // Identify the owning ACP session so the server can enforce single-session
      // ownership of the browser (#109): a second session's call is rejected 423
      // while another session holds control.
      'x-posse-session': BRIDGE_SESSION,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 423) {
    // Locked by another agent session — surface a clear tool error, not a throw.
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    const parsed = detail ? (JSON.parse(detail) as BridgeResponse) : null;
    throw new Error(parsed && !parsed.ok ? parsed.error : 'Browser is currently controlled by another agent session. Wait for it to finish, or have the user release control.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`bridge ${op} -> HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const json = (await res.json()) as BridgeResponse;
  if (!json.ok) throw new Error(json.error || `bridge ${op} returned ok:false`);
  const { ok: _ok, ...rest } = json;
  return rest;
}

// ---- tool input schemas (zod) ----

const selectorSchema = z.union([
  z.object({ css: z.string() }),
  z.object({ role: z.string(), name: z.string().optional() }),
  z.object({ xpath: z.string() }),
  z.object({ text: z.string() }),
]);

// Keep MCP tool surface minimal + explicit (mirrors the #103 issue): get_state,
// screenshot, dom_snapshot, click, type, navigate. Plus scroll + keypress as small
// extras that make the agent able to reach content off-screen / in dialogs.

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

const server = new McpServer(
  { name: 'posse-browser', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.tool(
  'browser_get_state',
  'Return the current URL, title, loading state, and navigation flags of the user\'s visible embedded browser. No arguments.',
  {},
  async () => {
    const state = await callBridge('state');
    return { content: [{ type: 'text', text: asText(state) }] };
  },
);

server.tool(
  'browser_navigate',
  'Navigate the user\'s visible embedded browser to a URL. Uses the same validation as manual address-bar navigation (browser-controller normalizeBrowserUrl). The user\'s persisted login session is reused.',
  { url: z.string().describe('Absolute URL to load (http/https). Relative paths rejected.') },
  async ({ url }) => {
    const result = await callBridge('navigate', { url });
    return { content: [{ type: 'text', text: asText(result) }] };
  },
);

server.tool(
  'browser_screenshot',
  'Capture a PNG screenshot of the user\'s visible embedded browser. No macOS Screen Recording permission required — uses the WebContents backing store. Returns base64 PNG. No DOM/secret content embedded, pixels only.',
  {},
  async () => {
    const result = (await callBridge('screenshot')) as { data?: string };
    if (typeof result.data !== 'string' || !result.data.startsWith('data:image/png;base64,')) {
      throw new Error('screenshot did not return a base64 PNG data URL');
    }
    const base64 = result.data.slice('data:image/png;base64,'.length);
    return { content: [{ type: 'image', data: base64, mimeType: 'image/png' }] };
  },
);

server.tool(
  'browser_dom_snapshot',
  'Return a sanitized DOM snapshot (tag, role, name, type, truncated text, bounding rect, attributes) for the matched element or document.body. Password/hidden input values, <script>/<style> contents, and secret-looking attributes are stripped. maxDepth bounds payload size.',
  {
    selector: selectorSchema.optional().describe('Optional element selector. Omit for the whole body.'),
    maxDepth: z.number().int().min(1).max(8).optional().describe('Max nesting depth (1-8, default 4).'),
  },
  async (args) => {
    const result = await callBridge('dom-snapshot', args as Record<string, unknown>);
    return { content: [{ type: 'text', text: asText(result) }] };
  },
);

server.tool(
  'browser_click',
  'Simulate a mouse click at the given x/y pixel coordinates in the browser viewport (from a dom_snapshot bounding rect or screenshot). Optional button.',
  {
    x: z.number().describe('X pixel coordinate.'),
    y: z.number().describe('Y pixel coordinate.'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Default left.'),
  },
  async (args) => {
    const result = await callBridge('click', args as Record<string, unknown>);
    return { content: [{ type: 'text', text: asText(result) }] };
  },
);

server.tool(
  'browser_type',
  'Type text into the focused element, or into an element matched by selector (which is focused first). Synthesizes per-character input events so React/Vue controlled inputs update. Optional submit presses Enter after.',
  {
    text: z.string().describe('Text to type.'),
    selector: selectorSchema.optional().describe('Element to focus before typing. Omit to use current focus.'),
    submit: z.boolean().optional().describe('Press Enter after typing.'),
  },
  async (args) => {
    const result = await callBridge('type', args as Record<string, unknown>);
    return { content: [{ type: 'text', text: asText(result) }] };
  },
);

server.tool(
  'browser_keypress',
  'Send a single keydown+keyup. Use for Enter, Tab, Escape, Arrow keys, etc. keyCode names follow Electron key codes (e.g. "Return", "Tab", "Escape", "Backspace", "ArrowDown").',
  { key: z.string().describe('Key code name, e.g. "Return", "Tab", "Escape".') },
  async ({ key }) => {
    const result = await callBridge('keypress', { key });
    return { content: [{ type: 'text', text: asText(result) }] };
  },
);

server.tool(
  'browser_scroll',
  'Scroll the viewport (or a matched element) by x/y pixel deltas.',
  {
    x: z.number().optional().describe('Horizontal delta. Default 0.'),
    y: z.number().optional().describe('Vertical delta. Default 0.'),
    selector: selectorSchema.optional().describe('Scroll container to target. Omit for the page.'),
  },
  async (args) => {
    const result = await callBridge('scroll', args as Record<string, unknown>);
    return { content: [{ type: 'text', text: asText(result) }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[browser-mcp] ready on stdio ->', BRIDGE_URL);
}

main().catch((error) => {
  console.error('[browser-mcp] fatal:', error);
  process.exit(1);
});
