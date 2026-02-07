# Antibeaver QA Plan

**Objective:** Adversarial testing to ensure first proper look is near bug-free.

**Philosophy:** Assume everything will be misused, called at the wrong time, given garbage input, or run in degraded conditions. The system should fail gracefully, never corrupt state, and always remain responsive to `/halt`.

---

## 1. Unit Tests

Pure functions, no external dependencies. Fast, deterministic.

### 1.1 Latency Tracker

| Test | Input | Expected |
|------|-------|----------|
| `getAverage()` empty samples | No samples | Returns `simulatedLatencyMs` (0 by default) |
| `getAverage()` single sample | [100ms] | Returns 100 |
| `getAverage()` rolling window | 10 samples, window=5s, 6 outside window | Only counts 4 recent |
| `getMax()` empty | No samples | Returns `simulatedLatencyMs` |
| `getMax()` mixed | [50, 200, 100] | Returns 200 |
| `record()` overflow | 101 samples (max 100) | Oldest dropped, length stays 100 |
| `record()` negative latency | -500ms | Should clamp to 0 or reject |

### 1.2 shouldBuffer()

| Test | State | Expected |
|------|-------|----------|
| Healthy system | avg=1000ms, threshold=5000ms | `{ buffering: false, reason: 'healthy' }` |
| Degraded | avg=6000ms, threshold=5000ms | `{ buffering: true, reason: 'latency...' }` |
| Forced on | `globalForcedBuffering=true`, avg=100ms | `{ buffering: true, reason: 'manual override' }` |
| Simulated | `simulatedLatencyMs=20000`, avg=100ms | `{ buffering: true, reason: 'simulated...' }` |
| Halted | `systemHalted=true` | `{ buffering: true, reason: 'SYSTEM HALTED' }` |
| Edge: exactly at threshold | avg=5000ms, threshold=5000ms | Decide: `>=` or `>` — document and test |

### 1.3 generateSynthesisPrompt()

| Test | Input | Expected |
|------|-------|----------|
| Single thought | 1 P1 thought | Formatted prompt with 1 item |
| Multiple priorities | P0, P1, P2 mixed | P0 first, P2 last; P0 has [CRITICAL] tag |
| Empty thoughts | [] | Edge case: should handle gracefully (empty list or error?) |
| Massive content | 10KB thought | Should include (truncated?) |
| Special chars | Thought with `"`, `\n`, markdown | Escaped properly in prompt |
| Unicode | Thought with emoji 🦫 | Preserved correctly |

---

## 2. Integration Tests

SQLite operations, handler logic with mock contexts.

### 2.1 Database Operations

| Test | Scenario | Expected |
|------|----------|----------|
| Init fresh DB | No existing file | Creates tables, indices |
| Init existing DB | DB exists | No errors, no data loss |
| Init corrupt DB | Malformed SQLite file | Graceful error, logged, plugin continues (degraded?) |
| Init no permissions | Directory not writable | Graceful error, plugin loads but buffers disabled |
| Insert thought | Valid input | Returns row ID, row exists |
| Insert null content | `content=null` | Rejects or handles |
| Insert massive content | 1MB string | Works or rejects with clear error |
| Query pending | 5 pending, 3 synthesized | Returns only 5 pending |
| Mark synthesized | 3 thoughts | All marked, synthesis_events row created |
| Concurrent writes | 10 parallel inserts | All succeed, no corruption (WAL mode) |

### 2.2 Command Handlers

| Test | Command | State Before | Expected |
|------|---------|--------------|----------|
| `/buffer` status | Normal mode, 0 pending | Shows healthy status |
| `/buffer` status | 5 pending across 2 agents | Lists both agents |
| `/buffer on` | Normal | Sets `globalForcedBuffering=true`, clears halt |
| `/buffer off` | Forced/halted/simulated | Clears all, returns to auto |
| `/buffer simulate 15000` | Normal | Sets `simulatedLatencyMs=15000` |
| `/buffer simulate -100` | Normal | Clamps to 0 or rejects |
| `/buffer simulate abc` | Normal | Handles NaN gracefully |
| `/buffer garbage` | Normal | Shows status (unknown subcommand = status) |
| `/halt` | Normal | Sets `systemHalted=true`, logs |
| `/halt` | Already halted | Idempotent, no error |
| `/flush` | 0 pending | Returns "no pending thoughts" |
| `/flush` | 5 pending for main | Generates prompt, marks synthesized |
| `/flush all` | 3 agents with pending | Synthesizes all, clears all |
| `/flush all` | 0 pending | Returns "no pending thoughts" |

### 2.3 Tool Handlers

| Test | Tool | Params | Expected |
|------|------|--------|----------|
| `buffer_thought` | Valid thought | Returns `{ ok: true, id, pending }` |
| `buffer_thought` | Empty thought | Rejects or accepts empty |
| `buffer_thought` | Missing `thought` param | Error response |
| `buffer_thought` | Invalid priority "P99" | Falls back to P1 or rejects |
| `buffer_thought` | At max buffer | Returns warning about capacity |
| `buffer_thought` | DB unavailable | Graceful error, doesn't crash |
| `get_buffer_status` | Normal | Returns status JSON |
| `get_buffer_status` | DB unavailable | Returns status with `pending: 0` |

### 2.4 RPC Endpoints

| Test | Method | Params | Expected |
|------|--------|--------|----------|
| `antibeaver.recordLatency` | `{ latencyMs: 500 }` | Records, returns avg |
| `antibeaver.recordLatency` | `{ latencyMs: -100 }` | Handles negative |
| `antibeaver.recordLatency` | `{}` | Handles missing param |
| `antibeaver.status` | - | Returns full status object |

---

## 3. E2E Tests

Full OpenClaw gateway integration. Slower, but proves real behavior.

### 3.1 Happy Path

```gherkin
Given a running OpenClaw gateway with antibeaver plugin
When I send "/buffer" in webchat
Then I receive a status message showing "NORMAL" mode

Given buffering is forced on
When an agent calls buffer_thought with "Test message"
Then the thought is stored in SQLite
And the tool returns success

Given 3 buffered thoughts
When I send "/flush"
Then I receive a synthesis prompt
And all thoughts are marked synthesized in DB
```

### 3.2 Adversarial Scenarios

| Scenario | Steps | Expected |
|----------|-------|----------|
| Kill switch under load | Simulate 30s latency, buffer 10 thoughts, send `/halt` | Halt succeeds immediately, buffering stops |
| Recovery after halt | `/halt`, then `/buffer off` | System resumes, status shows NORMAL |
| Rapid fire commands | Send `/buffer on`, `/buffer off`, `/halt` in <1s | No race conditions, final state correct |
| Orphaned thoughts | Buffer thoughts, restart gateway | Thoughts persist, visible after restart |
| Corrupt DB recovery | Manually corrupt DB, restart gateway | Plugin logs error, loads in degraded mode |
| Memory pressure | Buffer 1000 thoughts | No memory leak, DB handles fine |

### 3.3 Multi-Agent

| Scenario | Steps | Expected |
|----------|-------|----------|
| Separate buffers | Agent A and B both buffer | Each has separate pending count |
| `/flush` isolation | `/flush` without "all" | Only main agent flushed |
| `/flush all` | Both have pending | Both synthesized |
| Agent ID undefined | Tool called without context | Falls back to 'main' |

---

## 4. Test Infrastructure

### 4.1 Directory Structure

```
antibeaver/
├── src/
│   └── index.ts
├── tests/
│   ├── unit/
│   │   ├── latency-tracker.test.ts
│   │   ├── should-buffer.test.ts
│   │   └── synthesis-prompt.test.ts
│   ├── integration/
│   │   ├── database.test.ts
│   │   ├── commands.test.ts
│   │   └── tools.test.ts
│   └── e2e/
│       ├── happy-path.test.ts
│       └── adversarial.test.ts
├── vitest.config.ts
└── package.json
```

### 4.2 Test Utilities

```typescript
// tests/utils/mock-context.ts
export function createMockCommandContext(overrides = {}) {
  return {
    senderId: 'test-user',
    channel: 'webchat',
    isAuthorizedSender: true,
    args: '',
    ...overrides
  };
}

// tests/utils/test-db.ts
export function createTestDatabase() {
  const db = new Database(':memory:');
  // Run schema migrations
  return db;
}

export function seedThoughts(db, count, agent = 'main') {
  for (let i = 0; i < count; i++) {
    db.prepare(`INSERT INTO buffered_thoughts (agent_id, channel, content, priority) VALUES (?, ?, ?, ?)`)
      .run(agent, 'test', `Thought ${i}`, 'P1');
  }
}
```

### 4.3 Vitest Config

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80
      }
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
```

---

## 5. Execution Plan

### Phase 1: Unit Tests (30 min)

1. Extract pure functions from index.ts into separate modules
2. Write unit tests for latencyTracker, shouldBuffer, generateSynthesisPrompt
3. Target: 100% coverage on pure functions

### Phase 2: Integration Tests (1 hour)

1. Create test database utilities
2. Write database operation tests
3. Mock command/tool contexts
4. Write handler tests
5. Target: 80% coverage on handlers

### Phase 3: E2E Tests (1 hour)

1. Set up test OpenClaw instance (or mock gateway)
2. Write happy path scenarios
3. Write adversarial scenarios
4. Target: All critical paths covered

### Phase 4: CI Integration (15 min)

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm install
      - run: npm test
      - run: npm run test:coverage
```

---

## 6. Adversarial Checklist

Before declaring "ready":

- [ ] Empty/null inputs don't crash
- [ ] Negative numbers handled
- [ ] Very large inputs handled (or rejected with clear error)
- [ ] Unicode and special characters preserved
- [ ] DB unavailable = degraded mode, not crash
- [ ] Concurrent operations don't corrupt state
- [ ] `/halt` ALWAYS works, regardless of system state
- [ ] State persists across gateway restarts
- [ ] Memory doesn't grow unbounded
- [ ] All error paths logged with context
- [ ] No secrets in logs or error messages

---

## 7. Manual QA Checklist

For the "first proper look":

```
[ ] Fresh install works (no prior state)
[ ] /buffer shows status
[ ] /buffer on enables forced buffering
[ ] /buffer off disables
[ ] /buffer simulate 15000 enables simulation
[ ] /halt stops everything
[ ] buffer_thought tool works from agent
[ ] get_buffer_status returns accurate data
[ ] /flush generates synthesis prompt
[ ] /flush all handles multiple agents
[ ] SQLite file created in correct location
[ ] Gateway restart preserves buffered thoughts
[ ] No errors in gateway logs during normal operation
```

---

*"The first look should be boring. All the excitement should have happened in QA."*
