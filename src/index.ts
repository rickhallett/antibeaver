/**
 * Antibeaver Plugin v0.2.1
 * 
 * Traffic governance for multi-agent systems.
 * Circuit breaker and coalescing buffer for OpenClaw.
 * 
 * Storage: ~/.openclaw/antibeaver/governance.db (SQLite with WAL mode)
 * 
 * Commands:
 *   /buffer        - Show buffer status
 *   /buffer on     - Force buffering mode
 *   /buffer off    - Disable forced buffering
 *   /buffer simulate <ms> - Simulate latency for testing
 *   /flush         - Trigger synthesis
 *   /flush all     - Trigger synthesis for all agents
 *   /halt          - Kill switch (P0 interrupt)
 * 
 * Tools:
 *   buffer_thought    - Buffer a thought instead of sending directly
 *   get_buffer_status - Check buffer status and queue health
 */

import type { PluginAPI } from 'openclaw/plugin-sdk';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface BufferedThought {
  id: number;
  agent_id: string;
  channel: string;
  target: string;
  content: string;
  priority: 'P0' | 'P1' | 'P2';
  created_at: string;
  status: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBALS
// ═══════════════════════════════════════════════════════════════════════════

let db: Database.Database | null = null;
let globalForcedBuffering = false;
let simulatedLatencyMs = 0;
let systemHalted = false;

const latencyTracker = {
  samples: [] as { ts: number; latencyMs: number }[],
  maxSamples: 100,
  
  record(latencyMs: number) {
    this.samples.push({ ts: Date.now(), latencyMs });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  },
  
  getAverage(windowMs = 60000): number {
    const now = Date.now();
    const recent = this.samples.filter(s => now - s.ts < windowMs);
    if (recent.length === 0) return simulatedLatencyMs;
    return Math.max(
      recent.reduce((sum, s) => sum + s.latencyMs, 0) / recent.length,
      simulatedLatencyMs
    );
  },
  
  getMax(windowMs = 60000): number {
    const now = Date.now();
    const recent = this.samples.filter(s => now - s.ts < windowMs);
    if (recent.length === 0) return simulatedLatencyMs;
    return Math.max(...recent.map(s => s.latencyMs), simulatedLatencyMs);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════════════════

function initDatabase(dbDir: string): Database.Database {
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'governance.db');
  
  const database = new Database(dbPath);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  
  database.exec(`
    CREATE TABLE IF NOT EXISTS buffered_thoughts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      target TEXT DEFAULT '',
      content TEXT NOT NULL,
      priority TEXT DEFAULT 'P1' CHECK(priority IN ('P0', 'P1', 'P2')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT DEFAULT 'pending'
    );
    
    CREATE INDEX IF NOT EXISTS idx_pending 
      ON buffered_thoughts(agent_id, status) 
      WHERE status = 'pending';
    
    CREATE TABLE IF NOT EXISTS network_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      latency_ms INTEGER NOT NULL,
      queue_depth INTEGER,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    
    CREATE TABLE IF NOT EXISTS synthesis_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      thoughts_count INTEGER,
      final_output TEXT,
      triggered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  
  return database;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function getPendingThoughts(agentId: string): BufferedThought[] {
  if (!db) return [];
  return db.prepare(`
    SELECT * FROM buffered_thoughts 
    WHERE agent_id = ? AND status = 'pending'
    ORDER BY priority ASC, created_at ASC
  `).all(agentId) as BufferedThought[];
}

function getAllPendingAgents(): string[] {
  if (!db) return [];
  return (db.prepare(`
    SELECT DISTINCT agent_id FROM buffered_thoughts WHERE status = 'pending'
  `).all() as { agent_id: string }[]).map(r => r.agent_id);
}

function getPendingCount(agentId?: string): number {
  if (!db) return 0;
  if (agentId) {
    return (db.prepare(`
      SELECT COUNT(*) as count FROM buffered_thoughts 
      WHERE agent_id = ? AND status = 'pending'
    `).get(agentId) as { count: number }).count;
  }
  return (db.prepare(`
    SELECT COUNT(*) as count FROM buffered_thoughts WHERE status = 'pending'
  `).get() as { count: number }).count;
}

function insertThought(agentId: string, channel: string, target: string, content: string, priority: string): number {
  if (!db) return -1;
  const result = db.prepare(`
    INSERT INTO buffered_thoughts (agent_id, channel, target, content, priority)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentId, channel, target || '', content, priority || 'P1');
  return result.lastInsertRowid as number;
}

function markSynthesized(agentId: string, output?: string): void {
  if (!db) return;
  const thoughts = getPendingThoughts(agentId);
  if (thoughts.length === 0) return;
  
  const ids = thoughts.map(t => t.id);
  db.prepare(`UPDATE buffered_thoughts SET status = 'synthesized' WHERE id IN (${ids.join(',')})`).run();
  db.prepare(`INSERT INTO synthesis_events (agent_id, thoughts_count, final_output) VALUES (?, ?, ?)`).run(agentId, ids.length, output || null);
}

function shouldBuffer(threshold: number): { buffering: boolean; reason: string; latencyMs: number } {
  if (systemHalted) return { buffering: true, reason: 'SYSTEM HALTED', latencyMs: 0 };
  if (globalForcedBuffering) return { buffering: true, reason: 'manual override', latencyMs: latencyTracker.getAverage() };
  if (simulatedLatencyMs > threshold) return { buffering: true, reason: `simulated ${simulatedLatencyMs}ms`, latencyMs: simulatedLatencyMs };
  
  const maxLatency = latencyTracker.getMax();
  if (maxLatency > threshold) return { buffering: true, reason: `latency ${Math.round(maxLatency)}ms > ${threshold}ms`, latencyMs: maxLatency };
  
  return { buffering: false, reason: 'healthy', latencyMs: latencyTracker.getAverage() };
}

function generateSynthesisPrompt(thoughts: BufferedThought[]): string {
  const formatted = thoughts.map((t, i) => {
    const tag = t.priority === 'P0' ? ' [CRITICAL]' : t.priority === 'P2' ? ' [low]' : '';
    return `${i + 1}. [${t.created_at}]${tag} "${t.content}"`;
  }).join('\n');

  return `**SYSTEM: NETWORK RECOVERED**

While congested, you drafted ${thoughts.length} messages:

${formatted}

**TASK:** Review against current channel state.
- Discard obsolete/superseded thoughts
- Synthesize remaining into ONE coherent message
- Do not apologize or mention delays`;
}

// ═══════════════════════════════════════════════════════════════════════════
// PLUGIN
// ═══════════════════════════════════════════════════════════════════════════

export default function register(api: PluginAPI) {
  const logger = api.logger;
  const pluginConfig = api.config?.plugins?.entries?.['antibeaver']?.config ?? {};
  const latencyThreshold = pluginConfig.latencyThresholdMs ?? 5000;
  const dbDir = (pluginConfig.dbPath ?? '~/.openclaw/antibeaver').replace('~', process.env.HOME || '');
  const maxBuffer = pluginConfig.maxBufferSize ?? 50;

  try {
    db = initDatabase(dbDir);
    logger.info(`[antibeaver] SQLite initialized: ${dbDir}/governance.db`);
  } catch (err) {
    logger.error(`[antibeaver] DB init failed: ${err}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: buffer_thought
  // ═══════════════════════════════════════════════════════════════════════
  
  api.registerTool({
    name: 'buffer_thought',
    description: 'Buffer a thought instead of sending directly. Use when system indicates network congestion.',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'The thought/message to buffer' },
        channel: { type: 'string', description: 'Target channel (slack, telegram, etc.)' },
        target: { type: 'string', description: 'Target destination' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2'], description: 'P0=critical, P1=normal, P2=low' },
      },
      required: ['thought'],
    },
    async execute(_id, params) {
      const { thought, channel, target, priority } = params as { thought: string; channel?: string; target?: string; priority?: string };
      const agentId = 'main'; // TODO: extract from context when available
      
      const id = insertThought(agentId, channel || 'unknown', target || '', thought, priority || 'P1');
      const count = getPendingCount(agentId);
      
      logger.info(`[antibeaver] Buffered #${id}: "${thought.substring(0, 40)}..." (${count} pending)`);
      
      const warning = count >= maxBuffer ? ` Buffer at capacity (${maxBuffer}).` : '';
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            buffered: true,
            id,
            pending: count,
            hint: `Thought buffered. Do not retry.${warning}`
          })
        }]
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: get_buffer_status
  // ═══════════════════════════════════════════════════════════════════════

  api.registerTool({
    name: 'get_buffer_status',
    description: 'Check buffer status and queue health.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const status = shouldBuffer(latencyThreshold);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            buffering: status.buffering,
            reason: status.reason,
            halted: systemHalted,
            pending: getPendingCount(),
            avgLatencyMs: Math.round(latencyTracker.getAverage()),
            maxLatencyMs: Math.round(latencyTracker.getMax()),
            threshold: latencyThreshold,
            hint: status.buffering ? 'Use buffer_thought instead of direct messages.' : 'Queue healthy.'
          })
        }]
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // COMMAND: /halt
  // ═══════════════════════════════════════════════════════════════════════

  api.registerCommand({
    name: 'halt',
    description: 'Emergency halt - P0 interrupt, bypasses queue',
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx) => {
      systemHalted = true;
      const ts = new Date().toISOString();
      logger.warn(`[antibeaver] 🚨 HALT by ${ctx.senderId} at ${ts}`);
      
      return {
        text: `🚨 **SYSTEM HALTED**

Time: ${ts}
By: ${ctx.senderId}

All agent output suspended. Send \`/buffer off\` to resume.`
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // COMMAND: /buffer
  // ═══════════════════════════════════════════════════════════════════════

  api.registerCommand({
    name: 'buffer',
    description: 'Buffer status and controls',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const args = (ctx.args || '').trim().toLowerCase().split(/\s+/);
      const cmd = args[0];
      
      if (cmd === 'on') {
        globalForcedBuffering = true;
        systemHalted = false;
        return { text: `⏸️ **Buffering ENABLED**\n\nAll agents will buffer until \`/buffer off\`.` };
      }
      
      if (cmd === 'off') {
        globalForcedBuffering = false;
        systemHalted = false;
        simulatedLatencyMs = 0;
        return { text: `▶️ **Buffering DISABLED**\n\nResumed automatic mode.` };
      }
      
      if (cmd === 'simulate') {
        const ms = parseInt(args[1] || '0', 10);
        simulatedLatencyMs = Math.max(0, ms);
        systemHalted = false;
        if (simulatedLatencyMs > 0) {
          return { text: `🧪 **Simulating ${simulatedLatencyMs}ms latency**` };
        }
        return { text: `🧪 **Simulation off**` };
      }
      
      // Status
      const status = shouldBuffer(latencyThreshold);
      const agents = getAllPendingAgents();
      const agentLines = agents.map(a => `  • **${a}**: ${getPendingCount(a)} thoughts`);
      
      return {
        text: `📊 **Antibeaver Status**

**Mode:** ${systemHalted ? '🚨 HALTED' : status.buffering ? '⏸️ BUFFERING' : '▶️ NORMAL'}
**Reason:** ${status.reason}

**Queue Health:**
  • Avg: ${Math.round(latencyTracker.getAverage())}ms
  • Max: ${Math.round(latencyTracker.getMax())}ms
  • Threshold: ${latencyThreshold}ms

**Pending (${getPendingCount()} total):**
${agentLines.length > 0 ? agentLines.join('\n') : '  (none)'}

**Commands:** \`/buffer on|off\`, \`/buffer simulate <ms>\`, \`/flush\`, \`/halt\``
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // COMMAND: /flush
  // ═══════════════════════════════════════════════════════════════════════

  api.registerCommand({
    name: 'flush',
    description: 'Trigger synthesis of buffered thoughts',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const flushAll = (ctx.args || '').trim().toLowerCase() === 'all';
      const agents = flushAll ? getAllPendingAgents() : ['main'];
      
      if (agents.length === 0 || getPendingCount() === 0) {
        return { text: `📭 No pending thoughts.` };
      }
      
      const results: string[] = [];
      for (const agentId of agents) {
        const thoughts = getPendingThoughts(agentId);
        if (thoughts.length === 0) continue;
        
        const prompt = generateSynthesisPrompt(thoughts);
        markSynthesized(agentId, prompt);
        results.push(`### ${agentId} (${thoughts.length} thoughts)\n\n${prompt}`);
      }
      
      return { text: `🔄 **SYNTHESIS**\n\n${results.join('\n\n---\n\n')}` };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // RPC: Record latency
  // ═══════════════════════════════════════════════════════════════════════

  api.registerGatewayMethod('antibeaver.recordLatency', ({ respond }, params) => {
    const { latencyMs } = params as { latencyMs: number };
    latencyTracker.record(latencyMs);
    if (db) {
      db.prepare(`INSERT INTO network_metrics (latency_ms) VALUES (?)`).run(latencyMs);
    }
    respond(true, { recorded: true, avg: Math.round(latencyTracker.getAverage()) });
  });

  api.registerGatewayMethod('antibeaver.status', ({ respond }) => {
    const status = shouldBuffer(latencyThreshold);
    respond(true, {
      buffering: status.buffering,
      reason: status.reason,
      halted: systemHalted,
      pending: getPendingCount(),
      agents: getAllPendingAgents()
    });
  });

  logger.info('[antibeaver] v0.2.1 loaded. Commands: /halt, /buffer, /flush. Tools: buffer_thought, get_buffer_status');
}

export const id = 'antibeaver';
export const name = 'Antibeaver';
