/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpOperationResult } from '../McpProtocol';
import { AbstractMcpAgent } from '../McpProtocol';
import type { IMcpServer } from '@/common/config/storage';
import { getEnhancedEnv } from '@process/utils/shellEnv';
import { safeExec } from '@process/utils/safeExec';

/** Env options for exec calls — ensures CLI is found from Finder/launchd launches */
const getExecEnv = () => ({
  env: { ...getEnhancedEnv(), NODE_OPTIONS: '', TERM: 'dumb', NO_COLOR: '1' } as NodeJS.ProcessEnv,
});

/**
 * Kilo CLI MCP代理实现
 * Kilo CLI 支持 stdio 传输类型
 */
export class KiloMcpAgent extends AbstractMcpAgent {
  constructor() {
    super('kilo');
  }

  getSupportedTransports(): string[] {
    return ['stdio'];
  }

  /**
   * 检测Kilo CLI的MCP配置
   */
  detectMcpServers(_cliPath?: string): Promise<IMcpServer[]> {
    const detectOperation = async () => {
      try {
        // 尝试通过Kilo CLI命令获取MCP配置
        // 假设Kilo CLI有类似"mcp list"命令
        const { stdout: result } = await safeExec('kilo mcp list', { timeout: this.timeout, ...getExecEnv() });

        // 如果没有配置任何MCP服务器，返回空数组
        if (result.includes('No MCP servers configured') || !result.trim()) {
          console.log('[KiloMcpAgent] No MCP servers configured');
          return [];
        }

        // 解析文本输出
        const mcpServers: IMcpServer[] = [];
        const lines = result.split('\n');

        for (const line of lines) {
          // 清除 ANSI 颜色代码
          // eslint-disable-next-line no-control-regex
          const cleanLine = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();

          // 查找格式如: "✓ filesystem: npx @modelcontextprotocol/server-filesystem /path - Connected"
          const match = cleanLine.match(/[✓✗]\s+([^:]+):\s+(.+?)\s*-\s*(Connected|Disconnected)/);
          if (match) {
            const [, name, commandStr, status] = match;
            const commandParts = commandStr.trim().split(/\s+/);
            const command = commandParts[0];
            const args = commandParts.slice(1);

            // 构建transport对象 (Kilo主要支持stdio)
            const transportObj: IMcpServer['transport'] = {
              type: 'stdio',
              command: command,
              args: args,
              env: {},
            };

            // 尝试获取tools信息（对所有已连接的服务器）
            let tools: Array<{ name: string; description?: string }> = [];
            if (status === 'Connected') {
              try {
                const testResult = await this.testMcpConnection(transportObj);
                tools = testResult.tools || [];
              } catch (error) {
                console.warn(`[KiloMcpAgent] Failed to get tools for ${name.trim()}:`, error);
                // 如果获取tools失败，继续使用空数组
              }
            }

            mcpServers.push({
              id: `kilo_${name.trim()}`,
              name: name.trim(),
              transport: transportObj,
              tools: tools,
              enabled: true,
              status: status === 'Connected' ? 'connected' : 'disconnected',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              description: '',
              originalJson: JSON.stringify(
                {
                  mcpServers: {
                    [name.trim()]: {
                      command: command,
                      args: args,
                      description: `Detected from Kilo CLI`,
                    },
                  },
                },
                null,
                2
              ),
            });
          }
        }

        console.log(`[KiloMcpAgent] Detection complete: found ${mcpServers.length} server(s)`);
        return mcpServers;
      } catch (error) {
        console.warn('[KiloMcpAgent] Failed to get Kilo CLI MCP config:', error);
        return [];
      }
    };

    // 使用命名函数以便在日志中显示
    Object.defineProperty(detectOperation, 'name', { value: 'detectMcpServers' });
    return this.withLock(detectOperation);
  }

  /**
   * 安装MCP服务器到Kilo CLI agent
   */
  installMcpServers(mcpServers: IMcpServer[]): Promise<McpOperationResult> {
    const installOperation = async () => {
      try {
        for (const server of mcpServers) {
          if (server.transport.type === 'stdio') {
            // 使用Kilo CLI添加MCP服务器
            // 假设格式: kilo mcp add <name> <command> [args...]
            let command = `kilo mcp add "${server.name}" "${server.transport.command}"`;
            if (server.transport.args?.length) {
              const quotedArgs = server.transport.args.map((arg: string) => `"${arg}"`).join(' ');
              command += ` ${quotedArgs}`;
            }

            try {
              await safeExec(command, { timeout: 5000, ...getExecEnv() });
              console.log(`[KiloMcpAgent] Added MCP server: ${server.name}`);
            } catch (error) {
              console.warn(`Failed to add MCP ${server.name} to Kilo CLI:`, error);
            }
          }
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    Object.defineProperty(installOperation, 'name', { value: 'installMcpServers' });
    return this.withLock(installOperation);
  }

  /**
   * 从Kilo CLI agent删除MCP服务器
   */
  removeMcpServer(mcpServerName: string): Promise<McpOperationResult> {
    const removeOperation = async () => {
      try {
        // 使用Kilo CLI命令删除MCP服务器
        const removeCommand = `kilo mcp remove "${mcpServerName}"`;

        try {
          const result = await safeExec(removeCommand, { timeout: 5000, ...getExecEnv() });

          if (result.stdout && (result.stdout.includes('removed') || result.stdout.includes('deleted'))) {
            console.log(`[KiloMcpAgent] Removed MCP server: ${mcpServerName}`);
            return { success: true };
          }
        } catch (error) {
          console.warn(`[KiloMcpAgent] Failed to remove MCP server: ${mcpServerName}`, error);
        }

        // 如果CLI命令失败，认为删除成功（服务器可能本来就不存在）
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    Object.defineProperty(removeOperation, 'name', { value: 'removeMcpServer' });
    return this.withLock(removeOperation);
  }
}