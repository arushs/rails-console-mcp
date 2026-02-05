#!/usr/bin/env node
import { spawn, ChildProcess, execSync } from 'child_process';
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
  mode: 'docker' | 'kubectl';
  // Docker mode
  container: string;
  // Kubectl mode
  kubeContext: string;
  kubeNamespace: string;
  kubeSelector: string;
  kubeContainer: string;
  // Common
  commandTimeout: number;
  inactivityTimeout: number;
  maxOutput: number;
}

// Strip ANSI escape codes for prompt detection
const ANSI_REGEX = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\].*?\x07/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

// Prompt regex matches IRB and Pry prompts
// IRB: irb(main):001:0> or irb(main):001:0*
// Pry: [1] pry(main)> or pry(main)>
// Custom: dev@us-central1[us1] (main)>
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
      const spawnArgs = this.buildSpawnArgs();
      if (!spawnArgs) {
        return { success: false, output: '', error: 'Failed to build spawn arguments' };
      }

      const [cmd, args] = spawnArgs;
      console.error(`[rails-console-mcp] Starting: ${cmd} ${args.join(' ')}`);

      this.process = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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

      // Wait for initial prompt (longer timeout for kubectl/staging)
      const startTimeout = this.config.mode === 'kubectl' ? 60_000 : 30_000;
      const ready = await this.waitForPrompt(startTimeout);
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

  private buildSpawnArgs(): [string, string[]] | null {
    if (this.config.mode === 'docker') {
      return ['docker', [
        'exec', '-i', this.config.container,
        'bundle', 'exec', 'rails', 'console', '--', '--nomultiline'
      ]];
    }

    // Kubectl mode - need to discover pod first
    const podName = this.discoverPod();
    if (!podName) {
      console.error('[rails-console-mcp] Failed to discover pod');
      return null;
    }

    console.error(`[rails-console-mcp] Discovered pod: ${podName}`);

    return ['kubectl', [
      'exec', '-i',
      '--context', this.config.kubeContext,
      '--namespace', this.config.kubeNamespace,
      '-c', this.config.kubeContainer,
      podName,
      '--',
      'bundle', 'exec', 'rails', 'console', '--', '--nomultiline'
    ]];
  }

  private discoverPod(): string | null {
    try {
      const cmd = `kubectl get pods --context ${this.config.kubeContext} --selector=${this.config.kubeSelector} --field-selector=status.phase=Running --namespace=${this.config.kubeNamespace} -o jsonpath='{.items[0].metadata.name}'`;
      console.error(`[rails-console-mcp] Discovering pod: ${cmd}`);
      const result = execSync(cmd, { encoding: 'utf8', timeout: 30_000 }).trim().replace(/'/g, '');
      return result || null;
    } catch (err) {
      console.error(`[rails-console-mcp] Pod discovery failed: ${err}`);
      return null;
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

    // Extract output (everything before the prompt), stripping ANSI codes
    const cleanBuffer = stripAnsi(this.buffer);
    const match = cleanBuffer.match(PROMPT_REGEX);
    const output = match ? cleanBuffer.slice(0, match.index) : cleanBuffer;

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
        // Strip ANSI codes before checking for prompt
        const cleanBuffer = stripAnsi(this.buffer);
        if (PROMPT_REGEX.test(cleanBuffer)) {
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
  const mode = (process.env.RAILS_MCP_MODE || 'docker') as 'docker' | 'kubectl';

  return {
    mode,
    // Docker mode
    container: process.env.RAILS_MCP_CONTAINER || 'web',
    // Kubectl mode
    kubeContext: process.env.RAILS_MCP_KUBE_CONTEXT || '',
    kubeNamespace: process.env.RAILS_MCP_KUBE_NAMESPACE || 'default',
    kubeSelector: process.env.RAILS_MCP_KUBE_SELECTOR || '',
    kubeContainer: process.env.RAILS_MCP_KUBE_CONTAINER || 'web',
    // Common
    commandTimeout: parseInt(process.env.RAILS_MCP_COMMAND_TIMEOUT || '60000', 10),
    inactivityTimeout: parseInt(process.env.RAILS_MCP_INACTIVITY_TIMEOUT || '7200000', 10),
    maxOutput: parseInt(process.env.RAILS_MCP_MAX_OUTPUT || '1048576', 10),
  };
}

// Main
async function main() {
  const config = loadConfig();

  console.error(`[rails-console-mcp] Mode: ${config.mode}`);
  if (config.mode === 'kubectl') {
    console.error(`[rails-console-mcp] Context: ${config.kubeContext}`);
    console.error(`[rails-console-mcp] Namespace: ${config.kubeNamespace}`);
    console.error(`[rails-console-mcp] Selector: ${config.kubeSelector}`);
  } else {
    console.error(`[rails-console-mcp] Container: ${config.container}`);
  }

  const session = new RailsConsole(config);

  const server = new Server(
    { name: 'rails-console-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'rails_console_exec',
      description: `Execute Ruby code in a persistent Rails console session (${config.mode} mode). Session starts automatically on first use and persists between commands. Use reload! to reset session state.`,
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
