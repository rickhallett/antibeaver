/**
 * Thought Buffer Plugin v0.2.0
 * 
 * Write-behind buffering with SQLite storage and intelligent coalescing.
 * 
 * Architecture:
 *   Agent Thought → buffer_thought tool → SQLite → Coalesce → Channel
 * 
 * Storage: ~/.openclaw/buffers/thoughts.db (SQLite with WAL mode)
 * 
 * Commands:
 *   /buffer        - Show buffer status for all agents
 *   /buffer on     - Force buffering mode (manual override)
 *   /buffer off    - Disable forced buffering
 *   /buffer simulate <ms> - Simulate latency for testing
 *   /flush         - Trigger synthesis for current session's agent
 *   /flush all     - Trigger synthesis for all agents with pending buffers
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
  priority: 'low' | 'normal' | 'high';
  created_at: string;
  synthesized_at: string | null;
  discarded: number;
  metadata: string | null;
}

interface LatencySample {
  id: number;
  recorded_at: string;
  latency_ms: number;
  channel: string | null;
  agent_id: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBALS
// ═══════════════════════════════════════════════════════════════════════════

let db: Database.Database | null = null;
let globalForcedBuffering = false;
let simulatedLatencyMs = 0;

// In-memory latency tracker for fast queries
const latencyTracker = {
  samples: [] as { ts: number; latencyMs: number; channel?: string }[],
  maxSamples: 100,
  
  record(latencyMs: number, channel?: string) {
    this.samples.push({ ts: Date.now(), latencyMs, channel });
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  },
  
  getAverage(windowMs = 60000, channel?: string): number {
    const now = Date.now();
    let recent = this.samples.filter(s => now - s.ts < windowMs);
    if (channel) recent = recent.filter(s => s.channel === channel);
    if (recent.length === 0) return simulatedLatencyMs;
    return Math.max(
      recent.reduce((sum, s) => sum + s.latencyMs, 0) / recent.length,
      simulatedLatencyMs
    );
  },
  
  getMax(windowMs = 60000, channel?: string): number {
    const now = Date.now();
    let recent = this.samples.filter(s => now - s.ts < windowMs);
    if (channel) recent = recent.filter(s => s.channel === channel);
    if (recent.length === 0) return simulatedLatencyMs;
    return Math.max(...recent.map(s => s.latencyMs), simulatedLatencyMs);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE SETUP
// ═══════════════════════════════════════════════════════════════════════════

function initDatabase(bufferDir: string): Database.Database {
  fs.mkdirSync(bufferDir, { recursive: true });
  const dbPath = path.join(bufferDir, 'thoughts.db');
  
  const database = new Database(dbPath);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  
  // Create tables
  database.exec(`
    CREATE TABLE IF NOT EXISTS buffered_thoughts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      target TEXT DEFAULT '',
      content TEXT NOT NULL,
      priority TEXT DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      synthesized_at TEXT,
      discarded INTEGER DEFAULT 0,
      metadata TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_pending 
      ON buffered_thoughts(agent_id, synthesized_at) 
      WHERE synthesized_at IS NULL AND discarded = 0;
    
    CREATE INDEX IF NOT EXISTS idx_agent_created 
      ON buffered_thoughts(agent_id, created_at);
    
    CREATE TABLE IF NOT EXISTS latency_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      latency_ms INTEGER NOT NULL,
      channel TEXT,
      agent_id TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_latency_time 
      ON latency_samples(recorded_at);
    
    CREATE TABLE IF NOT EXISTS synthesis_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
      thought_count INTEGER,
      result TEXT CHECK(result IN ('sent', 'discarded', 'partial', 'pending')),
      output_content TEXT
    );
  `);
  
  return database;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function getPendingThoughts(agentId: string): BufferedThought[] {
  if (!db) return [];
  const stmt = db.prepare(`
    SELECT * FROM buffered_thoughts 
    WHERE agent_id = ? AND synthesized_at IS NULL AND discarded = 0
    ORDER BY created_at ASC
  `);
  return stmt.all(agentId) as BufferedThought[];
}

function getAllPendingAgents(): string[] {
  if (!db) return [];
  const stmt = db.prepare(`
    SELECT DISTINCT agent_id FROM buffered_thoughts 
    WHERE synthesized_at IS NULL AND discarded = 0
  `);
  return (stmt.all() as { agent_id: string }[]).map(r => r.agent_id);
}

function getPendingCount(agentId?: string): number {
  if (!db) return 0;
  if (agentId) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM buffered_thoughts 
      WHERE agent_id = ? AND synthesized_at IS NULL AND discarded = 0
    `);
    return (stmt.get(agentId) as { count: number }).count;
  }
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM buffered_thoughts 
    WHERE synthesized_at IS NULL AND discarded = 0
  `);
  return (stmt.get() as { count: number }).count;
}

function insertThought(
  agentId: string,
  channel: string,
  target: string,
  content: string,
  priority: string,
  metadata?: Record<string, unknown>
): number {
  if (!db) return -1;
  const stmt = db.prepare(`
    INSERT INTO buffered_thoughts (agent_id, channel, target, content, priority, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    agentId,
    channel,
    target || '',
    content,
    priority || 'normal',
    metadata ? JSON.stringify(metadata) : null
  );
  return result.lastInsertRowid as number;
}

function markSynthesized(agentId: string, result: string, output?: string): void {
  if (!db) return;
  
  const thoughts = getPendingThoughts(agentId);
  const thoughtIds = thoughts.map(t => t.id);
  
  if (thoughtIds.length === 0) return;
  
  // Mark thoughts as synthesized
  const updateStmt = db.prepare(`
    UPDATE buffered_thoughts 
    SET synthesized_at = datetime('now')
    WHERE id IN (${thoughtIds.join(',')})
  `);
  updateStmt.run();
  
  // Log the synthesis
  const logStmt = db.prepare(`
    INSERT INTO synthesis_log (agent_id, thought_count, result, output_content)
    VALUES (?, ?, ?, ?)
  `);
  logStmt.run(agentId, thoughtIds.length, result, output || null);
}

function shouldBuffer(latencyThreshold: number): { buffering: boolean; reason: string; latencyMs: number } {
  const avgLatency = latencyTracker.getAverage();
  const maxLatency = latencyTracker.getMax();
  
  if (globalForcedBuffering) {
    return { buffering: true, reason: 'manual override (/buffer on)', latencyMs: avgLatency };
  }
  
  if (simulatedLatencyMs > latencyThreshold) {
    return { buffering: true, reason: `simulated latency ${simulatedLatencyMs}ms`, latencyMs: simulatedLatencyMs };
  }
  
  if (maxLatency > latencyThreshold) {
    return { buffering: true, reason: `latency ${Math.round(maxLatency)}ms > ${latencyThreshold}ms threshold`, latencyMs: maxLatency };
  }
  
  return { buffering: false, reason: 'queue healthy', latencyMs: avgLatency };
}

function shouldDrain(drainThreshold: number): boolean {
  if (globalForcedBuffering) return false;
  if (simulatedLatencyMs > 0) return false;
  const avgLatency = latencyTracker.getAverage();
  return avgLatency < drainThreshold;
}

function generateSynthesisPrompt(thoughts: BufferedThought[]): string {
  // Sort by priority (high first) then by time
  const priorityOrder = { high: 0, normal: 1, low: 2 };
  const sorted = [...thoughts].sort((a, b) => {
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  const formattedThoughts = sorted
    .map((t, i) => {
      const priorityTag = t.priority === 'high' ? ' [HIGH PRIORITY]' : t.priority === 'low' ? ' [low]' : '';
      return `${i + 1}. [${t.created_at}]${priorityTag} "${t.content}"`;
    })
    .join('\n');

  const highPriorityCount = sorted.filter(t => t.priority === 'high').length;
  const highPriorityNote = highPriorityCount > 0 
    ? `\n\n**Note:** ${highPriorityCount} thought(s) marked HIGH PRIORITY — these should be preserved unless clearly obsolete.`
    : '';

  return `**SYSTEM EVENT: NETWORK RECOVERED**

While the network was congested, you attempted to send ${thoughts.length} messages that were buffered:

${formattedThoughts}
${highPriorityNote}

**INSTRUCTION:**
Review these buffered thoughts against the current state of the conversation.
- If they are obsolete (already addressed, superseded, no longer relevant), discard them.
- If they are still relevant, **synthesize them into ONE concise, coherent message**.
- Preserve the essence of HIGH PRIORITY thoughts unless clearly obsolete.
- Do not apologize for delays or mention the buffering system.

Respond with your synthesized message, or "NO_REPLY" if all thoughts are obsolete.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// PLUGIN REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

export default function register(api: PluginAPI) {
  const logger = api.logger;
  const config = api.config?.plugins?.entries?.['thought-buffer']?.config ?? {};
  const latencyThreshold = config.latencyThresholdMs ?? 10000;
  const drainThreshold = config.drainThresholdMs ?? 5000;
  const bufferDir = (config.bufferDir ?? '~/.openclaw/buffers').replace('~', process.env.HOME || '');
  const maxBufferSize = config.maxBufferSize ?? 20;

  // Initialize SQLite
  try {
    db = initDatabase(bufferDir);
    logger.info(`[thought-buffer] SQLite database initialized at ${bufferDir}/thoughts.db`);
  } catch (err) {
    logger.error(`[thought-buffer] Failed to initialize SQLite: ${err}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: buffer_thought
  // ═══════════════════════════════════════════════════════════════════════
  
  api.registerTool({
    name: 'buffer_thought',
    description: `Buffer a thought instead of sending directly. Use when the system indicates network congestion, or when you want to accumulate thoughts before sending a coherent message. Buffered thoughts are synthesized into a single message when network health recovers.`,
    parameters: {
      type: 'object',
      properties: {
        thought: {
          type: 'string',
          description: 'The thought/message content to buffer',
        },
        channel: {
          type: 'string',
          description: 'Target channel (e.g., "slack", "telegram")',
        },
        target: {
          type: 'string',
          description: 'Target destination (channel name or user ID)',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'Priority level. High priority thoughts are preserved during synthesis unless clearly obsolete.',
        },
      },
      required: ['thought'],
    },
    handler: async ({ thought, channel, target, priority }, ctx) => {
      const agentId = ctx.agentId || 'main';
      
      const id = insertThought(
        agentId,
        channel || ctx.channel || 'unknown',
        target || '',
        thought,
        priority || 'normal',
        { sessionKey: ctx.sessionKey }
      );
      
      const count = getPendingCount(agentId);
      const bufferStatus = shouldBuffer(latencyThreshold);
      
      logger.info(`[thought-buffer] Buffered thought #${id} for ${agentId}: "${thought.substring(0, 50)}..." (${count} total)`);
      
      if (count >= maxBufferSize) {
        return {
          ok: true,
          buffered: true,
          thoughtId: id,
          count,
          warning: `Buffer at capacity (${maxBufferSize}). Consider triggering synthesis.`,
          hint: 'Buffer is full. Synthesis should be triggered soon.',
        };
      }
      
      return {
        ok: true,
        buffered: true,
        thoughtId: id,
        count,
        reason: bufferStatus.reason,
        hint: 'Message buffered. Do not retry. It will be synthesized when network recovers.',
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL: get_buffer_status  
  // ═══════════════════════════════════════════════════════════════════════

  api.registerTool({
    name: 'get_buffer_status',
    description: 'Check the current buffer status and queue health metrics.',
    parameters: { type: 'object', properties: {} },
    handler: async (_, ctx) => {
      const agentId = ctx.agentId || 'main';
      const pendingCount = getPendingCount(agentId);
      const bufferStatus = shouldBuffer(latencyThreshold);
      
      return {
        agentId,
        buffering: bufferStatus.buffering,
        reason: bufferStatus.reason,
        pendingThoughts: pendingCount,
        totalPending: getPendingCount(),
        avgLatencyMs: Math.round(latencyTracker.getAverage()),
        maxLatencyMs: Math.round(latencyTracker.getMax()),
        forcedBuffering: globalForcedBuffering,
        simulatedLatencyMs,
        hint: bufferStatus.buffering 
          ? 'Use buffer_thought tool instead of direct messages.'
          : 'Queue is healthy. Normal messaging is safe.',
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // COMMAND: /buffer
  // ═══════════════════════════════════════════════════════════════════════

  api.registerCommand({
    name: 'buffer',
    description: 'Buffer status and controls (on/off/simulate)',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim().toLowerCase().split(/\s+/) || [];
      const subcommand = args[0];
      
      if (subcommand === 'on') {
        globalForcedBuffering = true;
        return { text: `⏸️ **Forced buffering ENABLED**\n\nAll agents will buffer thoughts until \`/buffer off\`.` };
      }
      
      if (subcommand === 'off') {
        globalForcedBuffering = false;
        simulatedLatencyMs = 0;
        return { text: `▶️ **Forced buffering DISABLED**\n\nAgents will use automatic latency-based buffering.` };
      }
      
      if (subcommand === 'simulate') {
        const ms = parseInt(args[1] || '0', 10);
        simulatedLatencyMs = Math.max(0, ms);
        if (simulatedLatencyMs > 0) {
          return { text: `🧪 **Simulating ${simulatedLatencyMs}ms latency**\n\nBuffering will activate. Use \`/buffer off\` to disable.` };
        }
        return { text: `🧪 **Simulation disabled**\n\nReturned to real latency tracking.` };
      }
      
      // Show status
      const bufferStatus = shouldBuffer(latencyThreshold);
      const agentsWithPending = getAllPendingAgents();
      
      const agentLines = agentsWithPending.map(agentId => {
        const count = getPendingCount(agentId);
        const thoughts = getPendingThoughts(agentId);
        const highCount = thoughts.filter(t => t.priority === 'high').length;
        const highNote = highCount > 0 ? ` (${highCount} high priority)` : '';
        return `  • **${agentId}**: ${count} thoughts${highNote}`;
      });
      
      return {
        text: `📊 **Thought Buffer Status**

**Mode:** ${bufferStatus.buffering ? '⏸️ BUFFERING' : '▶️ NORMAL'}
**Reason:** ${bufferStatus.reason}

**Controls:**
  • Forced: ${globalForcedBuffering ? 'Yes' : 'No'}
  • Simulated latency: ${simulatedLatencyMs > 0 ? `${simulatedLatencyMs}ms` : 'Off'}

**Queue Health:**
  • Avg Latency: ${Math.round(latencyTracker.getAverage())}ms
  • Max Latency: ${Math.round(latencyTracker.getMax())}ms
  • Buffer threshold: ${latencyThreshold}ms
  • Drain threshold: ${drainThreshold}ms

**Pending Buffers (${getPendingCount()} total):**
${agentLines.length > 0 ? agentLines.join('\n') : '  (none)'}

**Commands:**
  \`/buffer on\` — Force buffering
  \`/buffer off\` — Disable forced buffering  
  \`/buffer simulate 15000\` — Simulate 15s latency
  \`/flush\` — Synthesize buffered thoughts
  \`/flush all\` — Synthesize for all agents`
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // COMMAND: /flush
  // ═══════════════════════════════════════════════════════════════════════

  api.registerCommand({
    name: 'flush',
    description: 'Synthesize buffered thoughts',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim().toLowerCase();
      const flushAll = args === 'all';
      
      const agentsToFlush = flushAll 
        ? getAllPendingAgents()
        : getAllPendingAgents().filter(id => id === 'main'); // Default to main
      
      if (agentsToFlush.length === 0) {
        return { text: `📭 No pending thoughts to flush.` };
      }
      
      const results: string[] = [];
      
      for (const agentId of agentsToFlush) {
        const thoughts = getPendingThoughts(agentId);
        if (thoughts.length === 0) continue;
        
        const synthesisPrompt = generateSynthesisPrompt(thoughts);
        
        // Mark as pending synthesis (will be marked complete when agent responds)
        markSynthesized(agentId, 'pending', synthesisPrompt);
        
        results.push(`### ${agentId} (${thoughts.length} thoughts)\n\n${synthesisPrompt}`);
      }
      
      return {
        text: `🔄 **SYNTHESIS REQUIRED**

The following buffers have been marked for synthesis. Each agent should process their prompt:

---

${results.join('\n\n---\n\n')}`
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // HOOK: agent:bootstrap — Inject buffer context
  // ═══════════════════════════════════════════════════════════════════════

  api.registerHook('agent:bootstrap', async (event) => {
    const agentId = event.context?.agentId || 'main';
    const pendingThoughts = getPendingThoughts(agentId);
    const bufferStatus = shouldBuffer(latencyThreshold);
    
    // If we have pending thoughts and queue has recovered, inject synthesis prompt
    if (pendingThoughts.length > 0 && shouldDrain(drainThreshold)) {
      const synthesisPrompt = generateSynthesisPrompt(pendingThoughts);
      
      event.context.bootstrapFiles = event.context.bootstrapFiles || [];
      event.context.bootstrapFiles.push({
        path: 'BUFFER_RECOVERY.md',
        content: synthesisPrompt,
        source: 'plugin:thought-buffer',
      });
      
      // Mark as synthesized
      markSynthesized(agentId, 'pending', synthesisPrompt);
      
      logger.info(`[thought-buffer] Injected synthesis prompt for ${agentId} (${pendingThoughts.length} thoughts)`);
    }
    
    // If buffering is active, inject warning
    if (bufferStatus.buffering) {
      event.context.bootstrapFiles = event.context.bootstrapFiles || [];
      event.context.bootstrapFiles.push({
        path: 'BUFFER_WARNING.md',
        content: `⚠️ **NETWORK CONGESTION DETECTED**

Queue latency: ${Math.round(bufferStatus.latencyMs)}ms (threshold: ${latencyThreshold}ms)
Reason: ${bufferStatus.reason}

**INSTRUCTION:** Do not send messages directly. Use the \`buffer_thought\` tool instead.
Your thoughts will be buffered and synthesized into coherent messages when the network recovers.

This prevents feedback loops where delayed messages trigger stale responses.`,
        source: 'plugin:thought-buffer',
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GATEWAY RPC: Latency recording
  // ═══════════════════════════════════════════════════════════════════════

  api.registerGatewayMethod('thought-buffer.recordLatency', ({ respond }, params) => {
    const { latencyMs, channel, agentId } = params as { latencyMs: number; channel?: string; agentId?: string };
    latencyTracker.record(latencyMs, channel);
    
    // Also persist to SQLite for historical analysis
    if (db) {
      const stmt = db.prepare(`
        INSERT INTO latency_samples (latency_ms, channel, agent_id)
        VALUES (?, ?, ?)
      `);
      stmt.run(latencyMs, channel || null, agentId || null);
    }
    
    respond(true, { 
      recorded: true, 
      avgLatency: Math.round(latencyTracker.getAverage()),
      buffering: shouldBuffer(latencyThreshold).buffering
    });
  });

  api.registerGatewayMethod('thought-buffer.getStatus', ({ respond }) => {
    const status = shouldBuffer(latencyThreshold);
    respond(true, {
      buffering: status.buffering,
      reason: status.reason,
      avgLatencyMs: Math.round(latencyTracker.getAverage()),
      maxLatencyMs: Math.round(latencyTracker.getMax()),
      forcedBuffering: globalForcedBuffering,
      simulatedLatencyMs,
      pendingTotal: getPendingCount(),
      agentsWithPending: getAllPendingAgents(),
    });
  });

  logger.info('[thought-buffer] Thought Buffer v0.2.0 loaded (SQLite backend). Commands: /buffer, /flush. Tools: buffer_thought, get_buffer_status');
}

export const id = 'thought-buffer';
export const name = 'Thought Buffer';
