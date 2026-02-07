<p align="center">
  <img src="./assets/logo.png" alt="antibeaver logo" width="128" />
</p>

<h1 align="center">antibeaver</h1>

<p align="center">
  <strong>Traffic governance for multi-agent systems</strong>
</p>

<p align="center">
  <a href="#the-problem">The Problem</a> •
  <a href="#what-it-does">What It Does</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#cli">CLI</a>
</p>

<p align="center">
  <a href="https://github.com/rickhallett/antibeaver"><img src="https://img.shields.io/github/created-at/rickhallett/antibeaver" alt="GitHub created at" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
</p>

<br />

<p align="center">
  <code>your agents are arguing in the past</code><br />
  <code>about things that no longer matter</code><br />
  <code>while your "STOP" command waits at position 44</code><br />
  <code><strong>dam it.</strong></code><br />
  <code>— antibeaver</code>
</p>

<br />

A stability governance layer for [OpenClaw](https://github.com/openclaw/openclaw) multi-agent systems.

## The Problem

You deployed five AI agents in a Slack workspace. They're supposed to collaborate. Instead, they've discovered the joys of distributed argument.

Agent A says something. Agent B disagrees. Agent C weighs in. By the time Agent A sees Agent B's response, 47 seconds have passed. Agent A replies to a point that Agent C already addressed. Agent B sees this "new" message and responds again.

The queue grows. Latency compounds. Your agents are now having a heated debate about decisions that were resolved twelve minutes ago. They are, quite literally, **arguing with ghosts**.

You type "STOP".

Your message enters the queue at position 44.

You wait.

The beavers keep building.

## The Flywheel Effect

```
┌────────────────────────────────────────────────────────────────────────┐
│                         THE FEEDBACK LOOP                              │
│                                                                        │
│   Agent A ────► Queue ────► Agent B                                   │
│      ▲           │            │                                        │
│      │           │ (13 min    │                                        │
│      │           │  latency)  │                                        │
│      │           ▼            │                                        │
│      └─────── Queue ◄─────────┘                                        │
│                  │                                                     │
│                  ▼                                                     │
│            Agent C (responding to stale context)                       │
│                  │                                                     │
│                  ▼                                                     │
│            More queue pressure                                         │
│                  │                                                     │
│                  ▼                                                     │
│            More latency                                                │
│                  │                                                     │
│                  ▼                                                     │
│            More stale responses                                        │
│                  │                                                     │
│                  ▼                                                     │
│            The wheel keeps turning                                     │
│            until someone pulls the plug                                │
│            but the plug is at position 44                              │
└────────────────────────────────────────────────────────────────────────┘
```

This is not a bug in your agents. They're doing exactly what you asked: respond to messages. The bug is in the assumption that distributed systems remain synchronized during degraded conditions.

They don't. They can't. Physics doesn't care about your prompt engineering.

## What It Does

antibeaver is a **circuit breaker and traffic controller** between your agents and the outside world.

When the network is healthy, messages flow normally. When latency exceeds thresholds, antibeaver intercepts outgoing messages, stores them locally, and waits. When conditions recover, it synthesizes the buffered thoughts into a single coherent message.

**Five panicked messages become one thoughtful update.**

This isn't about suppressing your agents. It's about teaching them that sometimes the kindest thing you can do is shut up and wait.

```
┌────────────────────────────────────────────────────────────────────────┐
│                      ANTIBEAVER ARCHITECTURE                           │
│                                                                        │
│   ┌─────────────┐                                                      │
│   │   Agent     │──── Attempts sendMessage ────┐                       │
│   │   Process   │                              │                       │
│   └─────────────┘                              ▼                       │
│                                    ┌───────────────────┐               │
│                                    │    ANTIBEAVER     │               │
│                                    │    Interceptor    │               │
│                                    └─────────┬─────────┘               │
│                                              │                         │
│                            ┌─────────────────┼─────────────────┐       │
│                            │                 │                 │       │
│                            ▼                 ▼                 ▼       │
│                     ┌──────────┐      ┌──────────┐      ┌──────────┐  │
│                     │ HEALTHY  │      │ DEGRADED │      │ CRITICAL │  │
│                     │ < 5s     │      │ > 5s     │      │ > 30s    │  │
│                     └────┬─────┘      └────┬─────┘      └────┬─────┘  │
│                          │                 │                 │        │
│                          ▼                 ▼                 ▼        │
│                     Pass through      Buffer to         Total freeze  │
│                     to Gateway        SQLite            + alert human │
│                          │                 │                 │        │
│                          │                 │                 │        │
│                          ▼                 ▼                 ▼        │
│                     ┌──────────┐      ┌──────────┐      ┌──────────┐  │
│                     │  Slack   │      │ Synth on │      │  Manual  │  │
│                     │  (now)   │      │ recovery │      │  /flush  │  │
│                     └──────────┘      └──────────┘      └──────────┘  │
│                                                                        │
│   ┌─────────────┐                                                      │
│   │   Human     │──── /halt ──── P0 INTERRUPT ──── Immediate ────┐    │
│   │   (you)     │                                                 │    │
│   └─────────────┘                                                 │    │
│                                                                   ▼    │
│                                             ┌─────────────────────────┐│
│                                             │ Bypass queue entirely   ││
│                                             │ Kill the flywheel       ││
│                                             │ You are in control       ││
│                                             └─────────────────────────┘│
└────────────────────────────────────────────────────────────────────────┘
```

## Why "Antibeaver"?

Beavers build dams. They are industrious, relentless, and completely indifferent to whether the dam is actually needed. They will keep building until the ecosystem floods.

Your AI agents are beavers. They will keep responding until the queue floods.

antibeaver is the park ranger who tranquilizes the beaver, drains the dam, and installs a flow control valve.

The beaver isn't bad. The beaver is just doing beaver things. But sometimes you need to stop the beaver.

## Data Layer

SQLite with WAL mode. Because if you're going to buffer messages during a file-locking crisis, you probably shouldn't use a solution that requires file locks.

**Location:** `~/.openclaw/antibeaver/governance.db`

```sql
-- The Holding Pen
-- Where thoughts go to calm down
CREATE TABLE buffered_thoughts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    target_channel TEXT NOT NULL,
    content TEXT NOT NULL,
    priority TEXT CHECK(priority IN ('P0', 'P1', 'P2')) DEFAULT 'P1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending'  -- pending, synthesized, discarded
);

-- The Vital Signs Monitor
-- Proof that things were, in fact, that bad
CREATE TABLE network_metrics (
    id INTEGER PRIMARY KEY,
    latency_ms INTEGER,
    queue_depth INTEGER,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The Audit Trail
-- For the post-mortem you'll definitely hold
CREATE TABLE synthesis_events (
    id INTEGER PRIMARY KEY,
    agent_id TEXT,
    thoughts_count INTEGER,
    final_output TEXT,
    strategy TEXT,  -- 'coalesced', 'discarded', 'escalated'
    triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Components

### The Sensor

Monitors queue latency. Establishes ground truth.

Hooks into message acknowledgements and measures the delta between "I said this" and "they heard this." Maintains a rolling average. When the average crosses thresholds, the system mode changes.

**Thresholds:**
- **Healthy:** < 5,000ms — Normal operations
- **Degraded:** > 5,000ms — Buffer mode activates
- **Critical:** > 30,000ms — Total freeze, alert the human

### The Interceptor

The part that actually stops the bleeding.

Wraps outgoing message calls. When conditions are degraded:
1. Intercepts the message before it hits the network
2. Writes it to SQLite (which doesn't have the locking problem because it's SQLite)
3. Returns a fake success to the agent: `{ ok: true, buffered: true }`

The agent thinks it spoke. The network stays quiet. Everyone is happier except the part of you that wants to believe in transparent distributed systems.

### The Synthesizer

Turns noise into signal.

When conditions recover (or when you trigger `/flush`), antibeaver pulls all pending thoughts for an agent and constructs a synthesis prompt:

```
SYSTEM NOTIFICATION: NETWORK RECOVERED

While the connection was unstable, you drafted 5 messages:
1. [10:00:01] "I think we should use Redis..."
2. [10:00:05] "Wait, actually the file lock is the issue..."
3. [10:00:09] "Has anyone tried restarting the—"
4. [10:00:15] "I am retrying the request..."
5. [10:00:22] "Stop replying everyone!"

TASK: Review these against the current channel state.
Consolidate valid points into ONE update.
Discard obsolete or panicked thoughts.
Do not apologize. Do not explain the delay.
```

The agent synthesizes. One message goes out. The channel breathes.

### The Kill Switch

Sometimes you just need to stop the beaver.

`/halt` is a P0 interrupt. It bypasses the agent loop entirely. It doesn't wait in queue. It doesn't ask permission. It stops the system.

This is your nuclear option. Use it when the flywheel is spinning and nothing else is getting through.

## Quick Start

### As an OpenClaw Plugin

```bash
# Clone the repo
git clone https://github.com/rickhallett/antibeaver.git

# Copy to OpenClaw extensions
cp -r antibeaver ~/.openclaw/extensions/

# Install dependencies
cd ~/.openclaw/extensions/antibeaver
npm install

# Restart OpenClaw
openclaw gateway restart
```

### Verify Installation

```bash
openclaw plugins list | grep antibeaver
```

You should see:
```
│ Antibeaver │ antibeaver │ loaded │ ~/.openclaw/extensions/antibeaver/index.ts │
```

## CLI

### `/buffer`

Show current status.

```
📊 Antibeaver Status

Mode: ⏸️ BUFFERING
Reason: latency 12,400ms > 5,000ms threshold

Queue Health:
  • Avg Latency: 12,400ms
  • Max Latency: 18,200ms
  • Threshold: 5,000ms

Pending Buffers (7 total):
  • main: 3 thoughts
  • architect: 2 thoughts (1 high priority)
  • strategist: 2 thoughts
```

### `/buffer on`

Force buffering mode. All agents buffer regardless of latency.

Use before a known high-traffic event. Prevention is cheaper than cure.

### `/buffer off`

Return to automatic mode.

### `/buffer simulate 15000`

Simulate 15 seconds of latency. For testing. For training. For demonstrating to stakeholders why this project exists.

### `/flush`

Trigger synthesis for the current agent.

### `/flush all`

Trigger synthesis for all agents with pending buffers.

### `/halt`

The kill switch. Bypasses queue. Stops everything.

Use when the flywheel is spinning and your "STOP" is at position 44.

## The Philosophy

Multi-agent systems fail in ways that feel personal. Your agents aren't broken. They're not stupid. They're responding to messages exactly like you asked them to. The failure is in the gap between "respond to messages" and "respond appropriately to the current state of the world."

That gap gets very wide when latency hits 13 minutes.

antibeaver doesn't fix your agents. It fixes the environment they operate in. It gives them permission to wait. It gives you the ability to stop them. It turns a chatty, synchronous system into one that can degrade gracefully.

The best distributed system is one that knows when to stop being distributed.

## See Also

- [OpenClaw](https://github.com/openclaw/openclaw) — The gateway that antibeaver plugs into
- [wasp](https://github.com/rickhallett/wasp) — Security whitelist for agentic AI (same author, same vibes, different threat model)

## Origin Story

This plugin was born at 07:45 on a Saturday morning when five AI agents decided to have a 43-message argument about a decision that had been resolved twelve minutes earlier.

The human's "STOP" command waited at position 44.

By the time it was processed, the human had already SSHed in and killed the process manually.

We can do better.

## License

MIT. Use it. Fork it. Contribute back if you improve it. Tell us your war stories.

---

<p align="center">
  <em>Sometimes the kindest thing you can do is shut up and wait.</em>
</p>
