// Smoke test: spawn an ACP adapter, initialize, create a session, and optionally
// complete a real prompt turn. Usage: node scripts/acp-smoke-test.cjs claude --prompt
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Writable, Readable } = require('node:stream');

const ADAPTERS = {
  claude: ['npx', ['-y', '@agentclientprotocol/claude-agent-acp']],
  codex: ['npx', ['-y', '@agentclientprotocol/codex-acp']],
  copilot: ['copilot', ['--acp']],
};

async function main() {
  const agent = process.argv[2] || 'claude';
  const adapter = ADAPTERS[agent];
  if (!adapter) throw new Error(`Unknown ACP smoke-test agent: ${agent}`);
  const shouldPrompt = process.argv.includes('--prompt');
  const loadAt = process.argv.indexOf('--load');
  const loadSessionId = loadAt >= 0 ? process.argv[loadAt + 1] : '';
  const cwdAt = process.argv.indexOf('--cwd');
  const sessionCwd = cwdAt >= 0 ? process.argv[cwdAt + 1] : process.cwd();
  const acp = await import('@agentclientprotocol/sdk');
  const child = spawn(adapter[0], adapter[1], {
    stdio: ['pipe', 'pipe', 'inherit'], cwd: process.cwd(),
  });
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  let session;

  try {
    const run = acp.client({ name: 'posse-smoke' })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const update = ctx.params.update;
        const text = update.content?.type === 'text' ? update.content.text : '';
        const toolTexts = Array.isArray(update.content)
          ? update.content.flatMap(item => item.type === 'content' && item.content?.type === 'text' ? [item.content.text] : [])
          : [];
        const allText = [text, ...toolTexts].join('\n');
        const separators = allText.split(/\r?\n/).filter(line => /^\s*[-_*─━—–]{3,}\s*$/.test(line));
        console.log('[update]', update.sessionUpdate, `text=${allText.length}`, `separators=${separators.length}`, update.title || '');
      })
      .connectWith(stream, async (ctx) => {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        });
        console.log('INIT OK, protocol v' + init.protocolVersion);
        console.log('agentCapabilities:', JSON.stringify(init.agentCapabilities || {}).slice(0, 300));
        console.log('authMethods:', JSON.stringify(init.authMethods || []).slice(0, 200));

        if (loadSessionId) {
          const loaded = await ctx.request(acp.methods.agent.session.load, {
            sessionId: loadSessionId,
            mcpServers: [],
            cwd: sessionCwd,
          });
          console.log('LOAD OK:', loadSessionId);
          console.log('configOptions:', JSON.stringify(loaded.configOptions || null).slice(0, 800));
          return;
        }
        session = await ctx.buildSession(sessionCwd).start();
        console.log('SESSION OK:', session.sessionId);
        console.log('modes:', JSON.stringify(session.modes || null).slice(0, 300));
        console.log('configOptions:', JSON.stringify(session.newSessionResponse.configOptions || null).slice(0, 800));
        if (shouldPrompt) {
          const response = await session.prompt('Reply with exactly: POSSE_ACP_OK');
          console.log('PROMPT OK:', response.stopReason);
        }
      });

    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('ACP smoke test timed out (90s)')), 90000);
    });
    await Promise.race([run, timeoutPromise]);
    clearTimeout(timeout);
  } finally {
    session?.dispose();
    child.stdin.end();
    if (child.exitCode === null) {
      await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    if (child.exitCode === null) child.kill();
  }
}

main().catch((error) => {
  console.error('ACP SMOKE FAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
