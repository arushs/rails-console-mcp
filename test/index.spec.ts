import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { RailsConsole, loadConfig } from '../src/index.js';
import * as child_process from 'child_process';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Create a mock process
function createMockProcess() {
  const stdin = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn> };
  stdin.write = vi.fn();

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const mockProc = new EventEmitter() as EventEmitter & {
    stdin: typeof stdin;
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
  };

  mockProc.stdin = stdin;
  mockProc.stdout = stdout;
  mockProc.stderr = stderr;
  mockProc.kill = vi.fn();

  return mockProc;
}

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default values when no env vars set', () => {
    delete process.env.RAILS_MCP_CONTAINER;
    delete process.env.RAILS_MCP_COMMAND_TIMEOUT;
    delete process.env.RAILS_MCP_INACTIVITY_TIMEOUT;
    delete process.env.RAILS_MCP_MAX_OUTPUT;

    const config = loadConfig();

    expect(config.container).toBe('web');
    expect(config.commandTimeout).toBe(60000);
    expect(config.inactivityTimeout).toBe(7200000);
    expect(config.maxOutput).toBe(1048576);
  });

  it('reads values from environment variables', () => {
    process.env.RAILS_MCP_CONTAINER = 'mycontainer';
    process.env.RAILS_MCP_COMMAND_TIMEOUT = '30000';
    process.env.RAILS_MCP_INACTIVITY_TIMEOUT = '3600000';
    process.env.RAILS_MCP_MAX_OUTPUT = '2097152';

    const config = loadConfig();

    expect(config.container).toBe('mycontainer');
    expect(config.commandTimeout).toBe(30000);
    expect(config.inactivityTimeout).toBe(3600000);
    expect(config.maxOutput).toBe(2097152);
  });
});

describe('RailsConsole', () => {
  let mockProcess: ReturnType<typeof createMockProcess>;
  let railsConsole: RailsConsole;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    vi.mocked(child_process.spawn).mockReturnValue(mockProcess as unknown as child_process.ChildProcess);

    railsConsole = new RailsConsole({
      container: 'web',
      commandTimeout: 60000,
      inactivityTimeout: 7200000,
      maxOutput: 1048576,
    });
  });

  afterEach(() => {
    railsConsole.close();
  });

  // Helper to simulate prompt appearing
  function emitPrompt(prompt = 'irb(main):001:0> ') {
    mockProcess.stdout.emit('data', Buffer.from('\n' + prompt));
  }

  describe('exec', () => {
    it('starts session on first command and executes', async () => {
      const execPromise = railsConsole.exec('User.count');

      // Simulate boot and initial prompt
      await new Promise(r => setTimeout(r, 10));
      mockProcess.stdout.emit('data', Buffer.from('Loading development environment\n'));
      emitPrompt();

      // Wait for session to be ready
      await new Promise(r => setTimeout(r, 100));

      // Simulate command output
      mockProcess.stdout.emit('data', Buffer.from('=> 42\n'));
      emitPrompt('irb(main):002:0> ');

      const result = await execPromise;

      expect(child_process.spawn).toHaveBeenCalledWith(
        'docker',
        ['exec', '-i', 'web', 'bundle', 'exec', 'rails', 'console', '--', '--nomultiline'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      expect(mockProcess.stdin.write).toHaveBeenCalledWith('User.count\n');
      expect(result.success).toBe(true);
      expect(result.output).toBe('=> 42');
    });

    it('detects Ruby syntax errors', async () => {
      const execPromise = railsConsole.exec('def foo(');

      // Boot
      await new Promise(r => setTimeout(r, 10));
      emitPrompt();
      await new Promise(r => setTimeout(r, 100));

      // Syntax error output
      mockProcess.stdout.emit('data', Buffer.from('SyntaxError: unexpected end-of-input\n'));
      emitPrompt('irb(main):002:0> ');

      const result = await execPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Ruby error (see output)');
      expect(result.output).toContain('SyntaxError');
    });

    it('detects Ruby runtime errors', async () => {
      const execPromise = railsConsole.exec('raise "oops"');

      // Boot
      await new Promise(r => setTimeout(r, 10));
      emitPrompt();
      await new Promise(r => setTimeout(r, 100));

      // Runtime error
      mockProcess.stdout.emit('data', Buffer.from('RuntimeError: oops\n'));
      emitPrompt('irb(main):002:0> ');

      const result = await execPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Ruby error (see output)');
    });

    it('persists session between commands', async () => {
      // First command
      const exec1 = railsConsole.exec('x = 42');

      await new Promise(r => setTimeout(r, 10));
      emitPrompt();
      await new Promise(r => setTimeout(r, 100));

      mockProcess.stdout.emit('data', Buffer.from('=> 42\n'));
      emitPrompt('irb(main):002:0> ');

      const result1 = await exec1;
      expect(result1.success).toBe(true);

      // Second command - session already started, spawn should not be called again
      const spawnCallCount = vi.mocked(child_process.spawn).mock.calls.length;

      const exec2 = railsConsole.exec('x * 2');

      await new Promise(r => setTimeout(r, 100));

      mockProcess.stdout.emit('data', Buffer.from('=> 84\n'));
      emitPrompt('irb(main):003:0> ');

      const result2 = await exec2;

      expect(result2.success).toBe(true);
      expect(result2.output).toBe('=> 84');

      // Verify spawn was not called again (session reused)
      expect(vi.mocked(child_process.spawn).mock.calls.length).toBe(spawnCallCount);
    });
  });

  describe('close', () => {
    it('kills the process', async () => {
      // Start session
      const execPromise = railsConsole.exec('1');
      await new Promise(r => setTimeout(r, 10));
      emitPrompt();
      await new Promise(r => setTimeout(r, 100));
      mockProcess.stdout.emit('data', Buffer.from('=> 1\n'));
      emitPrompt('irb(main):002:0> ');
      await execPromise;

      // Close
      railsConsole.close();

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });
});

describe('PROMPT_REGEX pattern matching', () => {
  // Test the regex pattern directly to ensure it matches various prompts
  const PROMPT_REGEX = /\n(irb\([^)]+\):\d+:\d+[>*] ?|\[\d+\] [^>]+> |[^>\n]+\(\w+\)> )$/;

  it('matches IRB prompt', () => {
    expect(PROMPT_REGEX.test('some output\nirb(main):001:0> ')).toBe(true);
    expect(PROMPT_REGEX.test('=> 42\nirb(main):002:0> ')).toBe(true);
  });

  it('matches IRB continuation prompt', () => {
    expect(PROMPT_REGEX.test('def foo\nirb(main):002:0* ')).toBe(true);
  });

  it('matches Pry prompt', () => {
    expect(PROMPT_REGEX.test('=> 42\n[1] pry(main)> ')).toBe(true);
    expect(PROMPT_REGEX.test('=> 42\n[42] pry(main)> ')).toBe(true);
  });

  it('matches simple Pry prompt', () => {
    expect(PROMPT_REGEX.test('=> nil\npry(main)> ')).toBe(true);
  });
});
