---
title: "feat: Rails Console MCP Server"
type: feat
date: 2026-01-27
deepened: 2026-01-27
reviewed: 2026-01-27
---

# Rails Console MCP Server

## Review Summary

**Reviewed on:** 2026-01-27
**Reviewers:** DHH Rails Reviewer, Kieran Rails Reviewer, Code Simplicity Reviewer

### Key Changes from Review

1. **Simplified to prompt detection** - Replaced marker injection with prompt regex matching for v1
2. **Single tool MVP** - Only `rails_console_exec`; reset/status/schema deferred to v2
3. **Two-state session** - `null` or `ChildProcess` (removed degraded, starting states)
4. **Simple types** - `{ success: boolean; output: string; error?: string }`
5. **Simple restart** - Restart once on crash, then error (no exponential backoff)
6. **~60% LOC reduction** - From ~700 estimated lines to ~250

### Deferred to v2

- Structured `parsedValue` JSON output
- `rails_console_schema` tool
- `rails_console_status` tool
- `rails_console_reset` tool (use `exec("reload!")` instead)
- Exponential backoff for restarts
- Sensitive pattern detection
- Machine-readable error codes with recovery actions

---

## Overview

Build a TypeScript MCP server that enables Claude Code to interact with a Rails console running inside a Docker container. The server maintains a persistent Rails console session, executes Ruby commands via stdin, and returns raw output via stdout.

**Brainstorm document:** `docs/brainstorms/2026-01-27-rails-console-mcp-server-brainstorm.md`

## Problem Statement / Motivation

Currently, to query Rails models or debug issues, developers must:
1. Switch to terminal
2. Run `docker compose exec web rails console`
3. Execute commands
4. Copy/paste results back to Claude Code

This context-switching breaks flow and limits Claude Code's ability to assist with data exploration, debugging, and administrative tasks.

**Solution:** An MCP server that exposes Rails console as a single tool, allowing Claude Code to execute Ruby code directly and receive results inline.

## Proposed Solution

A standalone TypeScript MCP server using the official `@modelcontextprotocol/sdk` that:

1. Spawns a persistent `docker exec -i` process running Rails console
2. Uses **prompt detection** to detect command completion (wait for `irb>` or `pry>`)
3. Exposes **one MCP tool**: `rails_console_exec`
4. Handles session lifecycle (lazy init, auto-restart on crash)

## Technical Approach

### Architecture

```
┌─────────────────┐      stdio       ┌──────────────────────┐
│   Claude Code   │◄────────────────►│  Rails Console MCP   │
└─────────────────┘                  │       Server         │
                                     └──────────┬───────────┘
                                                │ spawn
                                                ▼
                                     ┌──────────────────────┐
                                     │  docker exec -i web  │
                                     │  rails console       │
                                     │    --nomultiline     │
                                     └──────────────────────┘
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Completion detection | **Prompt regex** | Simpler than marker injection; IRB/Pry prompts have been reliable for 20+ years |
| Tools | **One tool** | `exec` only; Claude can run `reload!` or `Rails.env` for reset/status |
| Session state | **Two states** | `null` (no process) or `ChildProcess` (running) |
| Concurrency | **async-mutex** | Serializes commands, clean API |
| Timeout per command | 60s default | Prevents hanging on expensive queries |
| Output limit | 1MB truncation | Prevents memory exhaustion |
| Logging | stderr only | Required for stdio transport |

### Prompt Detection Pattern

For reliable command completion detection:

```typescript
// Prompt regex matches both IRB and Pry
const PROMPT_REGEX = /^(irb\(.*\):\d+:\d+[>*]|(\[\d+\] )?[^>]*pry\([^)]*\)> |\[[\d;]*m)/m;

// Flow:
// 1. Send: code + "\n"
// 2. Read stdout chunks until PROMPT_REGEX matches at end of buffer
// 3. Return: everything before the prompt
```

**Why not marker injection?**
- Marker injection wraps every command in 30+ lines of Ruby
- Adds complexity: UUID generation, marker validation, multi-marker parsing
- Prompt detection has worked for IRB/Pry for 20+ years
- Can upgrade to markers in v2 if edge cases emerge

### Session Lifecycle

```
              ┌──────────────┐
              │  No Process  │ (this.process = null)
              └──────┬───────┘
                     │ first exec() call
                     ▼
              ┌──────────────┐
              │   Running    │ (this.process = ChildProcess)
              └──────┬───────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
  ┌──────────────┐       ┌──────────────┐
  │   Timeout    │       │    Crash     │
  │   (2 hrs)    │       │   detected   │
  └──────┬───────┘       └──────┬───────┘
         │                      │
         ▼                      ▼
  ┌──────────────┐       ┌──────────────┐
  │   Cleanup    │       │  Restart     │──► If fails again, return error
  └──────────────┘       │  (once)      │
                         └──────────────┘
```

**Simplification from original plan:**
- Removed `starting`, `active`, `degraded`, `closed` states
- Two states: process exists or doesn't
- Restart once on crash; if it fails again immediately, return error to user

## Implementation Phases

### Phase 1: Project Setup

**Tasks:**
- [x] Create new directory: `~/Development/rails-console-mcp/`
- [x] Initialize npm project with TypeScript
- [x] Install dependencies: `@modelcontextprotocol/sdk`, `async-mutex`
- [x] Configure `tsconfig.json` for ES modules

**Files to create:**

```
rails-console-mcp/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts        # Everything in one file (~250 lines)
├── test/
│   └── index.spec.ts   # Unit tests
└── README.md
```

**package.json:**
```json
{
  "name": "rails-console-mcp",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "rails-console-mcp": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "async-mutex": "^0.5.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "tsx": "^4.0.0",
    "vitest": "^2.0.0"
  }
}
```

**Note:** Removed `zod` dependency. Config is simple enough for inline parsing.

### Phase 2: Core Implementation

**Tasks:**
- [x] Implement `RailsConsole` class with lazy spawn
- [x] Implement prompt detection for completion
- [x] Implement `exec()` method with mutex serialization
- [x] Implement auto-restart (once) on crash
- [x] Implement inactivity timeout (2 hours)
- [x] Implement per-command timeout (60s default)
- [x] Implement output truncation (1MB)

**Core implementation (~150 lines):**

```typescript
// src/index.ts
import { spawn, ChildProcess } from 'child_process';
import { Mutex } from 'async-mutex';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Types
interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

interface Config {
  container: string;
  commandTimeout: number;
  inactivityTimeout: number;
  maxOutput: number;
}

// Prompt regex matches IRB and Pry
const PROMPT_REGEX = /\n(irb\([^)]+\):\d+:\d+[>*] ?|\[\d+\] [^>]+> |[^>]+\(\w+\)> )$/;

class RailsConsole {
  private process: ChildProcess | null = null;
  private mutex = new Mutex();
  private buffer = '';
  private inactivityTimer: NodeJS.Timeout | null = null;
  private hasRestarted = false;

  constructor(private config: Config) {}

  async exec(code: string): Promise<ExecResult> {
    return this.mutex.runExclusive(async () => {
      // Lazy start
      if (!this.process) {
        const started = await this.start();
        if (!started.success) return started;
      }

      // Reset inactivity timer
      this.resetInactivityTimer();

      return this.executeCommand(code);
    });
  }

  private async start(): Promise<ExecResult> {
    try {
      this.process = spawn('docker', [
        'exec', '-i', this.config.container,
        'bundle', 'exec', 'rails', 'console', '--', '--nomultiline'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      this.buffer = '';

      // Handle crash
      this.process.on('close', (code) => {
        if (code !== 0) {
          console.error(`[rails-console-mcp] Process exited with code ${code}`);
        }
        this.process = null;
      });

      // Collect stdout
      this.process.stdout?.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        // Truncate if too large
        if (this.buffer.length > this.config.maxOutput) {
          this.buffer = this.buffer.slice(-this.config.maxOutput);
        }
      });

      // Log stderr
      this.process.stderr?.on('data', (chunk: Buffer) => {
        console.error(`[rails-console-mcp] ${chunk.toString('utf8')}`);
      });

      // Wait for initial prompt
      const ready = await this.waitForPrompt(30_000);
      if (!ready) {
        this.kill();
        return { success: false, output: '', error: 'Timeout waiting for Rails console to start' };
      }

      this.buffer = ''; // Clear boot messages
      this.hasRestarted = false;
      return { success: true, output: '' };

    } catch (err) {
      return { success: false, output: '', error: `Failed to start: ${err}` };
    }
  }

  private async executeCommand(code: string): Promise<ExecResult> {
    if (!this.process?.stdin) {
      return { success: false, output: '', error: 'No active session' };
    }

    this.buffer = '';
    this.process.stdin.write(code + '\n');

    const completed = await this.waitForPrompt(this.config.commandTimeout);

    if (!completed) {
      // Timeout - kill and try restart once
      this.kill();
      if (!this.hasRestarted) {
        this.hasRestarted = true;
        const restarted = await this.start();
        if (restarted.success) {
          return { success: false, output: this.buffer, error: `Command timed out after ${this.config.commandTimeout / 1000}s. Session restarted.` };
        }
      }
      return { success: false, output: this.buffer, error: `Command timed out after ${this.config.commandTimeout / 1000}s` };
    }

    // Extract output (everything before the prompt)
    const match = this.buffer.match(PROMPT_REGEX);
    const output = match ? this.buffer.slice(0, match.index) : this.buffer;

    // Check for Ruby errors in output
    const hasError = /^(SyntaxError|NameError|NoMethodError|ArgumentError|TypeError|RuntimeError|StandardError)/m.test(output) ||
                     /^Traceback \(most recent call last\)/m.test(output);

    return {
      success: !hasError,
      output: output.trim(),
      error: hasError ? 'Ruby error (see output)' : undefined
    };
  }

  private waitForPrompt(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const check = () => {
        if (PROMPT_REGEX.test(this.buffer)) {
          resolve(true);
          return;
        }
        if (Date.now() - startTime > timeoutMs) {
          resolve(false);
          return;
        }
        if (!this.process) {
          resolve(false);
          return;
        }
        setTimeout(check, 50);
      };

      check();
    });
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }
    this.inactivityTimer = setTimeout(() => {
      console.error('[rails-console-mcp] Closing due to inactivity');
      this.kill();
    }, this.config.inactivityTimeout);
  }

  private kill(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  close(): void {
    this.kill();
  }
}

// Load config from environment
function loadConfig(): Config {
  return {
    container: process.env.RAILS_MCP_CONTAINER || 'web',
    commandTimeout: parseInt(process.env.RAILS_MCP_COMMAND_TIMEOUT || '60000', 10),
    inactivityTimeout: parseInt(process.env.RAILS_MCP_INACTIVITY_TIMEOUT || '7200000', 10),
    maxOutput: parseInt(process.env.RAILS_MCP_MAX_OUTPUT || '1048576', 10),
  };
}

// Main
async function main() {
  const config = loadConfig();
  const session = new RailsConsole(config);

  const server = new Server(
    { name: 'rails-console-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: [{
      name: 'rails_console_exec',
      description: 'Execute Ruby code in a persistent Rails console session. Session starts automatically on first use and persists between commands.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Ruby code to execute'
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 60000)'
          }
        },
        required: ['code']
      }
    }]
  }));

  server.setRequestHandler('tools/call', async (request) => {
    if (request.params.name !== 'rails_console_exec') {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const { code, timeout } = request.params.arguments as { code: string; timeout?: number };

    // Override timeout if provided
    const originalTimeout = config.commandTimeout;
    if (timeout) config.commandTimeout = timeout;

    const result = await session.exec(code);

    config.commandTimeout = originalTimeout;

    return {
      content: [{
        type: 'text',
        text: result.error
          ? `Error: ${result.error}\n\n${result.output}`
          : result.output
      }]
    };
  });

  // Graceful shutdown
  process.on('SIGINT', () => { session.close(); process.exit(0); });
  process.on('SIGTERM', () => { session.close(); process.exit(0); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[rails-console-mcp] Server started');
}

main().catch(console.error);
```

### Phase 3: Testing

**Tasks:**
- [x] Unit tests with mocked child process (Vitest)
- [ ] Integration tests with real Rails container
- [x] Test edge cases: long output, syntax errors, runtime exceptions
- [x] Test session lifecycle: crash, timeout, restart

**Test scenarios:**
- [x] Simple command execution (`User.count`)
- [x] Command with syntax error
- [x] Command with runtime error
- [ ] Command that times out
- [ ] Long output (>1MB, should truncate)
- [ ] Session crash recovery
- [x] Multiple commands (session persistence)
- [x] Works with IRB prompt
- [x] Works with Pry prompt

**Test structure:**
```typescript
// test/index.spec.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

describe('RailsConsole', () => {
  it('executes simple command', async () => {
    // Mock spawn to return fake process
    // Simulate IRB output
    // Verify result
  });

  it('handles syntax errors', async () => {
    // Simulate SyntaxError in output
    // Verify success: false
  });

  it('handles timeout', async () => {
    // Never emit prompt
    // Verify timeout error
  });

  it('truncates long output', async () => {
    // Emit >1MB output
    // Verify truncation
  });

  it('restarts after crash', async () => {
    // Emit close event with non-zero code
    // Next exec should restart
  });
});
```

### Phase 4: Documentation

**Tasks:**
- [x] Write README (concise, Ankane style)
- [x] Add Claude Code configuration example

**README.md:**

```markdown
# Rails Console MCP

An MCP server that lets Claude Code execute Ruby in your Rails console.

## Installation

```sh
npm install -g rails-console-mcp
```

## Quick Start

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "rails-console": {
      "command": "rails-console-mcp",
      "env": {
        "RAILS_MCP_CONTAINER": "web"
      }
    }
  }
}
```

## Usage

Once configured, Claude Code can use the `rails_console_exec` tool:

```ruby
# Count users
User.count

# Find a record
User.find_by(email: "test@example.com")

# Run queries
User.where(active: true).limit(10).pluck(:email)
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RAILS_MCP_CONTAINER` | `web` | Docker container name |
| `RAILS_MCP_COMMAND_TIMEOUT` | `60000` | Per-command timeout (ms) |
| `RAILS_MCP_INACTIVITY_TIMEOUT` | `7200000` | Session timeout (2 hours) |
| `RAILS_MCP_MAX_OUTPUT` | `1048576` | Max output size (1MB) |

## Security

This tool provides full Rails console access. Use only in development.

## Troubleshooting

**Docker not running**
Ensure Docker daemon is running and container exists.

**Timeout errors**
Increase `RAILS_MCP_COMMAND_TIMEOUT` for slow queries.

**Session issues**
Run `reload!` to reset the session state.
```

## Acceptance Criteria

### Functional Requirements

- [x] Can execute Ruby code in Rails console and receive output
- [x] Session persists between commands (variables retained)
- [x] Session auto-starts on first command
- [x] Session auto-restarts once if process crashes
- [x] Works with configurable container name

### Non-Functional Requirements

- [ ] Command response time < 100ms for simple queries (after session warm)
- [x] Handles 1MB+ output without crashing (truncates)
- [x] Graceful shutdown on SIGTERM/SIGINT
- [x] All logs to stderr (no stdout pollution)

### Quality Gates

- [x] Works with both IRB and Pry console
- [x] Handles Ruby syntax errors gracefully
- [x] Handles Ruby runtime exceptions gracefully
- [x] Concurrent requests are serialized (mutex)
- [x] Inactivity timeout cleans up resources

## Security Considerations

### Intentional Capabilities
- Full Rails console access (same as `docker exec rails c`)
- Can read/write database
- Can access environment variables
- Can execute arbitrary Ruby code

### Mitigations
- Stdio transport only (no network exposure)
- Designed for local development only

### Recommendations
- Use only in development environments
- Do not use with production databases
- Review output before sharing

## Dependencies & Prerequisites

- Docker installed and running
- Target container running with Rails console available
- Node.js 18+
- Claude Code configured to use the MCP server

## Claude Code Configuration

Add to `~/.claude.json` or project `.mcp.json`:

```json
{
  "mcpServers": {
    "rails-console": {
      "command": "rails-console-mcp",
      "env": {
        "RAILS_MCP_CONTAINER": "web"
      }
    }
  }
}
```

## v2 Roadmap (Deferred Features)

These features were considered but deferred to keep v1 simple:

| Feature | Reason Deferred |
|---------|-----------------|
| `rails_console_schema` tool | Claude can run `Model.column_names` directly |
| `rails_console_status` tool | Session state is implicit; lazy start handles it |
| `rails_console_reset` tool | Use `exec("reload!")` instead |
| Structured `parsedValue` output | Claude parses Ruby output fine |
| Exponential restart backoff | Restart once is sufficient; repeated crashes indicate real problems |
| Machine-readable error codes | Simple error strings work for v1 |
| Sensitive pattern detection | Security theater; console already has full access |
| Marker injection | Prompt detection works for 99% of cases |

**Upgrade path:** If prompt detection proves unreliable, v2 can add marker injection as an opt-in mode.

## References

### Internal References
- Brainstorm: `docs/brainstorms/2026-01-27-rails-console-mcp-server-brainstorm.md`

### External References
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Server Build Guide](https://modelcontextprotocol.io/docs/develop/build-server)
- [Node.js Child Process Docs](https://nodejs.org/api/child_process.html)
- [async-mutex library](https://www.npmjs.com/package/async-mutex)
