#!/usr/bin/env node
import { spawn, ChildProcess } from 'child_process';
import { Mutex } from 'async-mutex';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

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

// Prompt regex matches IRB and Pry prompts
// IRB: irb(main):001:0> or irb(main):001:0*
// Pry: [1] pry(main)> or pry(main)>
const PROMPT_REGEX = /\n(irb\([^)]+\):\d+:\d+[>*] ?|\[\d+\] [^>]+> |[^>\n]+\(\w+\)> )$/;

export class RailsConsole {
  private process: ChildProcess | null = null;
  private mutex = new Mutex();
  private buffer = '';
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
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
        // Truncate if too large (keep the tail)
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
          return {
            success: false,
            output: this.buffer,
            error: `Command timed out after ${this.config.commandTimeout / 1000}s. Session restarted.`
          };
        }
      }
      return {
        success: false,
        output: this.buffer,
        error: `Command timed out after ${this.config.commandTimeout / 1000}s`
      };
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
export function loadConfig(): Config {
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'rails_console_exec',
      description: 'Execute Ruby code in a persistent Rails console session. Session starts automatically on first use and persists between commands. Use reload! to reset session state.',
      inputSchema: {
        type: 'object' as const,
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'rails_console_exec') {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const args = request.params.arguments as { code: string; timeout?: number };
    const { code, timeout } = args;

    // Override timeout if provided
    const originalTimeout = config.commandTimeout;
    if (timeout) config.commandTimeout = timeout;

    const result = await session.exec(code);

    config.commandTimeout = originalTimeout;

    return {
      content: [{
        type: 'text' as const,
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
