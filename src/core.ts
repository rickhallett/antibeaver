/**
 * Antibeaver Core - Pure functions and types
 * Extracted for testability
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface BufferedThought {
  id: number;
  agent_id: string;
  channel: string;
  target: string;
  content: string;
  priority: 'P0' | 'P1' | 'P2';
  created_at: string;
  status: string;
}

export interface LatencySample {
  ts: number;
  latencyMs: number;
}

export interface BufferStatus {
  buffering: boolean;
  reason: string;
  latencyMs: number;
}

export interface SystemState {
  globalForcedBuffering: boolean;
  simulatedLatencyMs: number;
  systemHalted: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// LATENCY TRACKER
// ═══════════════════════════════════════════════════════════════════════════

export class LatencyTracker {
  private samples: LatencySample[] = [];
  private maxSamples: number;

  constructor(maxSamples = 100) {
    this.maxSamples = maxSamples;
  }

  record(latencyMs: number): void {
    // Clamp negative values to 0
    const clamped = Math.max(0, latencyMs);
    this.samples.push({ ts: Date.now(), latencyMs: clamped });
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  getAverage(windowMs = 60000, fallback = 0): number {
    const now = Date.now();
    const recent = this.samples.filter(s => now - s.ts < windowMs);
    if (recent.length === 0) return fallback;
    return recent.reduce((sum, s) => sum + s.latencyMs, 0) / recent.length;
  }

  getMax(windowMs = 60000, fallback = 0): number {
    const now = Date.now();
    const recent = this.samples.filter(s => now - s.ts < windowMs);
    if (recent.length === 0) return fallback;
    return Math.max(...recent.map(s => s.latencyMs));
  }

  getSampleCount(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples = [];
  }

  // For testing: inject samples with specific timestamps
  _injectSample(ts: number, latencyMs: number): void {
    this.samples.push({ ts, latencyMs: Math.max(0, latencyMs) });
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BUFFER LOGIC
// ═══════════════════════════════════════════════════════════════════════════

export function shouldBuffer(
  tracker: LatencyTracker,
  threshold: number,
  state: SystemState
): BufferStatus {
  const { globalForcedBuffering, simulatedLatencyMs, systemHalted } = state;

  if (systemHalted) {
    return { buffering: true, reason: 'SYSTEM HALTED', latencyMs: 0 };
  }

  if (globalForcedBuffering) {
    return { buffering: true, reason: 'manual override', latencyMs: tracker.getAverage(60000, simulatedLatencyMs) };
  }

  if (simulatedLatencyMs > threshold) {
    return { buffering: true, reason: `simulated ${simulatedLatencyMs}ms`, latencyMs: simulatedLatencyMs };
  }

  const maxLatency = tracker.getMax(60000, simulatedLatencyMs);
  if (maxLatency > threshold) {
    return { buffering: true, reason: `latency ${Math.round(maxLatency)}ms > ${threshold}ms`, latencyMs: maxLatency };
  }

  return { buffering: false, reason: 'healthy', latencyMs: tracker.getAverage(60000, simulatedLatencyMs) };
}

// ═══════════════════════════════════════════════════════════════════════════
// SYNTHESIS PROMPT
// ═══════════════════════════════════════════════════════════════════════════

export function generateSynthesisPrompt(thoughts: BufferedThought[]): string {
  if (thoughts.length === 0) {
    return '**SYSTEM: No buffered thoughts to synthesize.**';
  }

  // Sort by priority (P0 first) then by time
  const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  const sorted = [...thoughts].sort((a, b) => {
    const pDiff = (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);
    if (pDiff !== 0) return pDiff;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  const formatted = sorted.map((t, i) => {
    const tag = t.priority === 'P0' ? ' [CRITICAL]' : t.priority === 'P2' ? ' [low]' : '';
    // Escape content for safe embedding
    const escaped = escapeContent(t.content);
    return `${i + 1}. [${t.created_at}]${tag} "${escaped}"`;
  }).join('\n');

  const p0Count = sorted.filter(t => t.priority === 'P0').length;
  const criticalNote = p0Count > 0 
    ? `\n\n**Note:** ${p0Count} CRITICAL thought(s) — preserve unless clearly obsolete.`
    : '';

  return `**SYSTEM: NETWORK RECOVERED**

While congested, you drafted ${thoughts.length} messages:

${formatted}
${criticalNote}

**TASK:** Review against current channel state.
- Discard obsolete/superseded thoughts
- Synthesize remaining into ONE coherent message
- Do not apologize or mention delays`;
}

function escapeContent(content: string): string {
  // Escape quotes and newlines for safe embedding in prompt
  return content
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

export function validatePriority(priority: unknown): 'P0' | 'P1' | 'P2' {
  if (priority === 'P0' || priority === 'P1' || priority === 'P2') {
    return priority;
  }
  return 'P1'; // Default
}

export function validateThought(thought: unknown): string | null {
  if (typeof thought !== 'string') return null;
  if (thought.trim().length === 0) return null;
  // Max 50KB per thought
  if (thought.length > 50000) return thought.substring(0, 50000);
  return thought;
}

export function validateLatency(latencyMs: unknown): number {
  if (typeof latencyMs !== 'number') return 0;
  if (!Number.isFinite(latencyMs)) return 0;
  return Math.max(0, Math.round(latencyMs));
}
