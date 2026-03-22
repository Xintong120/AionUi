/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock safeExec before importing the class
vi.mock('@process/utils/safeExec', () => ({
  safeExec: vi.fn()
}));

// Mock AbstractMcpAgent
vi.mock('@process/services/mcpServices/McpProtocol', () => ({
  AbstractMcpAgent: class {
    timeout = 30000;
    withLock = vi.fn((operation) => operation());
    testMcpConnection = vi.fn().mockResolvedValue({ tools: [] });
  }
}));

import { KiloMcpAgent } from '../../src/process/services/mcpServices/agents/KiloMcpAgent';
import { safeExec } from '@process/utils/safeExec';

describe('KiloMcpAgent', () => {
  let agent: KiloMcpAgent;
  const mockSafeExec = vi.mocked(safeExec);

  beforeEach(() => {
    agent = new KiloMcpAgent();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns supported transports', () => {
    expect(agent.getSupportedTransports()).toEqual(['stdio']);
  });

  describe('detectMcpServers', () => {
    it('should return empty array when no config file exists', async () => {
      // Mock file not found
      mockSafeExec.mockRejectedValue(new Error('File not found'));

      const result = await agent.detectMcpServers();
      expect(result).toEqual([]);
    });

    it('should read MCP servers from kilo.json config', async () => {
      const mockConfig = {
        mcp: {
          'filesystem': {
            type: 'local',
            command: ['npx', '@modelcontextprotocol/server-filesystem', '/tmp'],
            enabled: true,
            description: 'File system access'
          }
        }
      };

      // Mock successful file read
      mockSafeExec.mockResolvedValueOnce({
        stdout: JSON.stringify(mockConfig),
        stderr: ''
      });

      // Mock successful test connection
      const mockTestResult = {
        tools: [
          { name: 'read_file', description: 'Read file contents' },
          { name: 'list_dir', description: 'List directory contents' }
        ]
      };
      vi.mocked(agent.testMcpConnection).mockResolvedValueOnce(mockTestResult);

      const result = await agent.detectMcpServers();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'kilo_filesystem',
        name: 'filesystem',
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem', '/tmp'],
          env: {}
        },
        enabled: true,
        description: 'File system access',
        tools: mockTestResult.tools
      });
    });

    it('should handle config files in different locations', async () => {
      const mockConfig = { mcp: { test: { type: 'local', command: ['echo', 'test'] } } };

      // Mock first file not found, second file found
      mockSafeExec
        .mockRejectedValueOnce(new Error('File not found')) // kilo.json
        .mockResolvedValueOnce({ stdout: JSON.stringify(mockConfig), stderr: '' }); // .kilo/kilo.json

      const result = await agent.detectMcpServers();
      expect(result).toHaveLength(1);
    });

    it('should skip remote MCP servers', async () => {
      const mockConfig = {
        mcp: {
          'remote-server': {
            type: 'remote',
            url: 'https://example.com/mcp',
            oauth: false
          },
          'local-server': {
            type: 'local',
            command: ['echo', 'local']
          }
        }
      };

      mockSafeExec.mockResolvedValueOnce({
        stdout: JSON.stringify(mockConfig),
        stderr: ''
      });

      const result = await agent.detectMcpServers();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('local-server');
    });

    it('should handle test connection failures gracefully', async () => {
      const mockConfig = {
        mcp: {
          'test-server': {
            type: 'local',
            command: ['failing-command']
          }
        }
      };

      mockSafeExec.mockResolvedValueOnce({
        stdout: JSON.stringify(mockConfig),
        stderr: ''
      });

      // Mock test connection failure
      vi.mocked(agent.testMcpConnection).mockRejectedValueOnce(new Error('Connection failed'));

      const result = await agent.detectMcpServers();

      expect(result).toHaveLength(1);
      expect(result[0].tools).toEqual([]);
    });
  });

  describe('installMcpServers', () => {
    const testServer = {
      id: 'test_server',
      name: 'test-server',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem', '/tmp'],
        env: {}
      },
      enabled: true,
      status: 'unknown' as const,
      tools: [],
      description: 'Test filesystem server'
    };

    it('should create config file if not exists', async () => {
      // Mock file not found for all config paths, then successful write
      mockSafeExec
        .mockRejectedValueOnce(new Error('File not found')) // test -f kilo.json
        .mockRejectedValueOnce(new Error('File not found')) // test -f kilo.jsonc
        .mockRejectedValueOnce(new Error('File not found')) // test -f .kilo/kilo.json
        .mockRejectedValueOnce(new Error('File not found')) // test -f .kilo/kilo.jsonc
        .mockRejectedValueOnce(new Error('File not found')) // test -f opencode.json
        .mockRejectedValueOnce(new Error('File not found')) // test -f opencode.jsonc
        .mockRejectedValueOnce(new Error('File not found')) // test -f .opencode/opencode.json
        .mockRejectedValueOnce(new Error('File not found')) // test -f .opencode/opencode.jsonc
        .mockRejectedValueOnce(new Error('File not found')) // cat kilo.json (file doesn't exist)
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // echo (write succeeds)

      const result = await agent.installMcpServers([testServer]);
      expect(result.success).toBe(true);

      // Verify the write command was called
      expect(mockSafeExec).toHaveBeenCalledWith(
        expect.stringContaining('echo \''),
        expect.any(Object)
      );
    });

    it('should add server to existing config', async () => {
      const existingConfig = { version: '1.0.0' };

      // Mock file exists and can be read/written
      mockSafeExec
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // test -f
        .mockResolvedValueOnce({ stdout: JSON.stringify(existingConfig), stderr: '' }) // cat
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // echo

      const result = await agent.installMcpServers([testServer]);
      expect(result.success).toBe(true);

      // Verify the config was updated with MCP server
      const writeCall = mockSafeExec.mock.calls.find(call =>
        call[0].includes('echo \'')
      );
      expect(writeCall).toBeDefined();

      const writtenConfig = JSON.parse(writeCall![0].match(/echo '(.+)'/s)![1]);
      expect(writtenConfig.mcp['test-server']).toEqual({
        type: 'local',
        command: ['npx', '@modelcontextprotocol/server-filesystem', '/tmp'],
        enabled: true,
        description: 'Test filesystem server'
      });
    });


  });

  describe('removeMcpServer', () => {
    it('should return success when no config file exists', async () => {
      // Mock all config files not found
      mockSafeExec.mockRejectedValue(new Error('File not found'));

      const result = await agent.removeMcpServer('nonexistent-server');
      expect(result.success).toBe(true);
    });

    it('should remove server from config', async () => {
      const existingConfig = {
        mcp: {
          'keep-server': { type: 'local', command: ['echo', 'keep'] },
          'remove-server': { type: 'local', command: ['echo', 'remove'] }
        }
      };

      mockSafeExec
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // test -f
        .mockResolvedValueOnce({ stdout: JSON.stringify(existingConfig), stderr: '' }) // cat
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // echo

      const result = await agent.removeMcpServer('remove-server');
      expect(result.success).toBe(true);

      const writeCall = mockSafeExec.mock.calls.find(call =>
        call[0].includes('echo \'')
      );
      const writtenConfig = JSON.parse(writeCall![0].match(/echo '(.+)'/s)![1]);

      expect(writtenConfig.mcp['remove-server']).toBeUndefined();
      expect(writtenConfig.mcp['keep-server']).toBeDefined();
    });

    it('should handle server not found in config', async () => {
      const existingConfig = { mcp: { 'other-server': { type: 'local', command: ['echo'] } } };

      mockSafeExec
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // test -f
        .mockResolvedValueOnce({ stdout: JSON.stringify(existingConfig), stderr: '' }); // cat
      // No write call expected

      const result = await agent.removeMcpServer('nonexistent-server');
      expect(result.success).toBe(true);

      // Should not have written to file
      const writeCalls = mockSafeExec.mock.calls.filter(call =>
        call[0].includes('echo \'')
      );
      expect(writeCalls).toHaveLength(0);
    });
  });
});