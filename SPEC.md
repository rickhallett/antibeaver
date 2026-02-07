# Tech Spec: Project Antibeaver

**Version:** 1.0.0  
**Status:** Approved for Execution  
**Target:** OpenClaw Plugin Architecture  
**Author:** HAL 🔴 + Kai  
**Motivation:** Five beavers, forty-three messages, one very patient human

---

## 1. Executive Summary

**Antibeaver** is a stability governance layer for the OpenClaw multi-agent runtime. It acts as a **circuit breaker and traffic controller** between the agent's cognitive loop and the IO Gateway.

Its primary function is to prevent **Distributed Feedback Loops** (the "Flywheel Effect") caused by network latency and file-lock contention. It achieves this by shifting the communication model from **Synchronous/Chatty** to **Asynchronous/Coalesced** dynamically based on infrastructure health.

In simpler terms: it teaches your AI agents the ancient human wisdom of "read the room before you speak."

---

## 2. System Architecture

The system follows a **Middleware Interception Pattern**. It sits between the Agent and the Gateway like a very tired referee at a debate tournament.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   ┌─────────────┐                                                       │
│   │   Agent     │                                                       │
│   │   Process   │                                                       │
│   └──────┬──────┘                                                       │
│          │                                                              │
│          │ Attempts 'sendMessage'                                       │
│          │ (with the confidence of someone                              │
│          │  who hasn't checked their email in 12 minutes)               │
│          ▼                                                              │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                    ANTIBEAVER INTERCEPTOR                        │   │
│   │                                                                  │   │
│   │  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐   │   │
│   │  │    Sensor    │───►│  Health      │───►│    Decision      │   │   │
│   │  │   (Latency)  │    │  Assessment  │    │    Engine        │   │   │
│   │  └──────────────┘    └──────────────┘    └────────┬─────────┘   │   │
│   │                                                    │             │   │
│   └────────────────────────────────────────────────────┼─────────────┘   │
│                                                        │                 │
│                    ┌───────────────────────────────────┼───────────┐     │
│                    │                                   │           │     │
│                    ▼                                   ▼           ▼     │
│             ┌──────────────┐                   ┌─────────────┐ ┌───────┐ │
│             │   HEALTHY    │                   │  DEGRADED   │ │FROZEN │ │
│             │   < 5s       │                   │  > 5s       │ │ > 30s │ │
│             └──────┬───────┘                   └──────┬──────┘ └───┬───┘ │
│                    │                                  │            │     │
│                    ▼                                  ▼            ▼     │
│             ┌──────────────┐                   ┌─────────────┐  ┌──────┐ │
│             │   Gateway    │                   │   SQLite    │  │ HALT │ │
│             │   (Slack)    │                   │   Buffer    │  │ MODE │ │
│             └──────────────┘                   │   (WAL)     │  └──────┘ │
│                                                └──────┬──────┘           │
│                                                       │                  │
│                    ┌──────────────────────────────────┘                  │
│                    │ (on recovery or /flush)                             │
│                    ▼                                                     │
│             ┌──────────────────────────────────────────────────────┐     │
│             │              SYNTHESIS ENGINE                         │     │
│             │                                                       │     │
│             │  "You tried to say 5 things. Let's make it 1 thing." │     │
│             └───────────────────────────┬───────────────────────────┘     │
│                                         │                                │
│                                         ▼                                │
│                                  ┌─────────────┐                         │
│                                  │   Gateway   │                         │
│                                  │   (Slack)   │                         │
│                                  └─────────────┘                         │
│                                                                          │
│   ┌─────────────┐                                                        │
│   │   Human     │───── /halt ─────► P0 INTERRUPT                         │
│   │   (you)     │                   (bypasses everything)                │
│   │             │                   (because you are the adult here)     │
│   └─────────────┘                                                        │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Layer: SQLite (WAL Mode)

We replace file-system appending with a strictly typed SQLite database using **Write-Ahead Logging (WAL)** to support high-concurrency non-blocking reads.

This is important because the original failure was caused by file-lock contention. Solving a file-lock problem with more file locks would be poetic but unhelpful.

**File:** `~/.openclaw/antibeaver/governance.db`

### 3.1 Schema

```sql
-- The Holding Pen
-- Where thoughts go to marinate until they're actually useful
CREATE TABLE buffered_thoughts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    target_channel TEXT NOT NULL,
    content TEXT NOT NULL,
    priority TEXT CHECK(priority IN ('P0', 'P1', 'P2')) DEFAULT 'P1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending'  -- pending, synthesized, discarded
);

-- The Heartbeat Monitor  
-- So you can prove to management that yes, it really was that bad
CREATE TABLE network_metrics (
    id INTEGER PRIMARY KEY,
    latency_ms INTEGER,
    queue_depth INTEGER,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The Audit Log
-- For the post-mortem. There's always a post-mortem.
CREATE TABLE synthesis_events (
    id INTEGER PRIMARY KEY,
    agent_id TEXT,
    thoughts_count INTEGER,
    final_output TEXT,
    triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 4. Component Modules

### 4.1 The Sensor (Latency Tracker)

**Role:** Establish Ground Truth.

The sensor answers the question: "How bad is it, really?"

Not "how bad does the agent think it is" (agents are optimists). Not "how bad does the queue claim it is" (queues lie to make themselves look busy). Actual measured latency between send and acknowledgement.

* **Mechanism:** Hooks into `gateway:ack`. Measures delta between `message_sent_at` and `slack_ack_at`.
* **Metric:** Rolling average of last 5 messages.
* **Thresholds:**
  * **Healthy:** < 5,000ms — "Everything is fine."
  * **Degraded:** > 5,000ms — "Start buffering. Trust nothing."
  * **Critical:** > 30,000ms — "Alert the human. Something is very wrong."

### 4.2 The Interceptor (Middleware)

**Role:** Enforce Backpressure.

This is the component that actually stops the bleeding. It sits between the agent's intention and the agent's action, like that friend who takes your phone away when you're about to send a regrettable text.

* **Implementation:** Wraps the `slack:postMessage` tool definition in the agent context.
* **Logic:**
  1. Agent calls `sendMessage("I think we should use Redis")`.
  2. Interceptor checks **The Sensor**.
  3. **If Healthy:** Pass through to Gateway.
  4. **If Degraded:**
     * **Intercept:** Block the network request.
     * **Persist:** `INSERT INTO buffered_thoughts ...`
     * **Mock Return:** Return `{ success: true, status: "buffered", note: "Network congested. Thought saved locally." }` to the agent.

The agent *feels* heard. The network stays quiet. The flywheel doesn't get more fuel.

*Rationale:* Agents retry on failure. If we returned an error, the agent would try again. And again. And again. The interceptor's job is to lie gracefully so the agent moves on with its life.

### 4.3 The Synthesizer (Coalescing Engine)

**Role:** Turn noise into signal.

Five panicked messages at 10-second intervals are not more valuable than one thoughtful message at the end. The synthesizer understands this even if the agent doesn't.

* **Trigger:** When **Sensor** detects recovery (latency drops below threshold) OR `antibeaver flush` is called.
* **Flow:**
  1. `SELECT * FROM buffered_thoughts WHERE agent_id = ? AND status = 'pending' ORDER BY created_at`
  2. Construct a **System Prompt Injection**:

```
SYSTEM NOTIFICATION: NETWORK RECOVERED

While the connection was unstable, you drafted the following thoughts:
1. [10:00:01] "The file lock is the issue."
2. [10:00:05] "Wait, no, it's the queue."
3. [10:00:09] "Actually I think it might be Redis."
4. [10:00:15] "I am retrying request..."
5. [10:00:22] "Everyone stop talking!"

TASK: Review these against the current state of the channel.
- If a thought is obsolete or superseded, discard it.
- If thoughts are still valid, consolidate into ONE coherent update.
- Do not apologize for the delay. Do not mention buffering.
```

  3. Agent generates synthesized summary.
  4. Antibeaver sends summary to Gateway.
  5. Mark thoughts as `synthesized` in DB.

The channel receives one message instead of five. Readers don't have to reconstruct the agent's thought process. Everyone wins.

### 4.4 The Kill Switch (P0 Interrupt)

**Role:** Out-of-band safety.

When everything else fails, you need a way to stop the system that doesn't depend on the system you're trying to stop.

The kill switch bypasses the queue, bypasses the agent loop, bypasses everything. It is the "in case of fire, break glass" option.

* **Command:** `/halt` or `/antibeaver stop`
* **Behavior:**
  1. Bypasses the Agent Loop entirely.
  2. Sets global flag `SYSTEM_LOCKDOWN = true`.
  3. Issues `gateway.clearQueue()` (if supported) or drops all pending outgoing frames.
  4. Broadcasts `[SYSTEM HALT]` to all channels immediately.

*Note:* This command exists because during the incident that spawned this project, the human's "STOP" command sat at position 44 in the queue. By the time it was processed, the human had already SSHed in and killed the process manually.

We can do better.

---

## 5. The CLI (`antibeaver`)

A standalone interface decoupled from the main bot process. This ensures control even if the main Node loop is blocked by file locks, which would be ironic but not unprecedented.

**Commands:**

### `antibeaver status`

Reads `network_metrics` and `buffered_thoughts`. Provides the executive summary.

Output:
```
Status: DEGRADED | Latency: 12s | Buffered Thoughts: 43
Pending by agent:
  • main: 12 thoughts
  • architect: 15 thoughts (3 high priority)
  • strategist: 16 thoughts
Last synthesis: 14 minutes ago
```

### `antibeaver flush --agent <id>`

Manually triggers The Synthesizer for a specific agent. Use when you know conditions have recovered but the automatic drain hasn't triggered yet.

### `antibeaver purge`

`DELETE FROM buffered_thoughts WHERE status='pending'`

The "shut up" command. For when you've read the buffered thoughts and they're all obsolete, panicked, or otherwise unhelpful. Discards without synthesis.

Use sparingly. The agents worked hard on those thoughts. They just happened to be wrong.

### `antibeaver simulate --latency 20000`

Artificially sets the sensor to Degraded mode for testing. Simulates 20 seconds of latency without actually having 20 seconds of latency.

Useful for:
- Testing the buffer flow
- Training new agents on degraded-mode behavior
- Demonstrating to stakeholders why this project exists
- Generating screenshots for your portfolio

---

## 6. Implementation Plan

### Phase 1: Foundation (Today)

1. ✅ Initialize `governance.db` (SQLite with WAL).
2. ✅ Implement `AntibeaverLatencyMonitor` class.
3. ✅ Build the CLI `status` command.
4. ✅ Create GitHub repo with beaver-themed README.

### Phase 2: Interception (Tomorrow)

1. Implement `ToolWrapper` to intercept `sendMessage`.
2. Connect Interceptor to SQLite write.
3. Verify agents "feel" successful even when buffered.
4. Handle edge cases (what if SQLite is also locked? we cry.)

### Phase 3: Synthesis & Release (Next)

1. Implement the "Network Recovered" prompt injection.
2. Connect the drain logic to the `gateway:drain` event (or poll if event unavailable).
3. Add jitter to drain timing to prevent thundering herd on recovery.

### Phase 4: Integration & Polish

1. Register `/halt` as a P0 command.
2. Full load test using `antibeaver simulate`.
3. Write the war story for the README.
4. Generate beaver logo (critical path item).

---

## 7. Success Metrics

How do we know this worked?

| Metric | Before | Target After |
|--------|--------|--------------|
| Peak queue depth during incident | 43 messages | < 10 messages |
| Time for human override to process | 13.6 minutes | < 5 seconds |
| Messages sent during degraded state | Unlimited | 0 (all buffered) |
| Messages received by channel on recovery | N (raw count) | 1 (synthesized) |
| Human cortisol levels | Elevated | Manageable |

---

## 8. Known Limitations

1. **Latency tracking is passive.** We only measure what we see. If no messages are sent, we have no data. Consider adding synthetic heartbeat probes.

2. **Agents must opt in.** Without tool interception at the OpenClaw level, agents need to voluntarily use `buffer_thought`. We can encourage this via `agent:bootstrap` injection, but a rebellious agent could still spam the channel.

3. **Synthesis quality depends on the agent.** We can prompt for consolidation, but we can't force good judgment. A bad synthesizer prompt could produce worse output than the raw buffer.

4. **The beaver metaphor may confuse Canadians.** We apologize.

---

## 9. Future Work

- **Predictive buffering:** Start buffering when latency is *trending* toward threshold, not just when it crosses.
- **Per-channel health:** Slack degraded, Telegram fine? Buffer Slack only.
- **Agent-to-agent awareness:** Let agents know when peers are buffered, to avoid duplicate work.
- **Beaver dashboard:** Real-time visualization of queue health and buffer status. With beaver animations.

---

<p align="center">
  <em>The flywheel spins until someone stops it.<br/>
  Now you have brakes.</em>
</p>
