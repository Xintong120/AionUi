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
        // 读取Kilo配置文件获取MCP服务器配置
        // 配置存储在kilo.json或相关配置文件中
        const configPaths = [
          'kilo.json',
          'kilo.jsonc',
          '.kilo/kilo.json',
          '.kilo/kilo.jsonc',
          'opencode.json',
          'opencode.jsonc',
          '.opencode/opencode.json',
          '.opencode/opencode.jsonc'
        ];

        let configContent = '';
        let configPath = '';

        for (const path of configPaths) {
          try {
            const { stdout } = await safeExec(`cat "${path}"`, { timeout: 5000, ...getExecEnv() });
            if (stdout.trim()) {
              configContent = stdout;
              configPath = path;
              break;
            }
          } catch {
            // 尝试下一个路径
            continue;
          }
        }

        if (!configContent) {
          console.log('[KiloMcpAgent] No Kilo config file found');
          return [];
        }

        // 解析JSON配置
        const config = JSON.parse(configContent);
        const mcpConfig = config.mcp || {};

        if (Object.keys(mcpConfig).length === 0) {
          console.log('[KiloMcpAgent] No MCP servers configured in config');
          return [];
        }

        // 转换配置为IMcpServer格式
        const mcpServers: IMcpServer[] = [];

        for (const [name, serverConfig] of Object.entries(mcpConfig)) {
          if (!serverConfig || typeof serverConfig !== 'object' || !('type' in serverConfig)) {
            continue;
          }

          const config = serverConfig as any;

          if (config.type === 'local' && config.command) {
            // 本地stdio服务器
            const commandParts = Array.isArray(config.command) ? config.command : config.command.split(/\s+/);
            const transportObj: IMcpServer['transport'] = {
              type: 'stdio',
              command: commandParts[0],
              args: commandParts.slice(1),
              env: config.env || {},
            };

            // 尝试测试连接获取tools信息
            let tools: Array<{ name: string; description?: string }> = [];
            try {
              const testResult = await this.testMcpConnection(transportObj);
              tools = testResult.tools || [];
            } catch (error) {
              console.warn(`[KiloMcpAgent] Failed to get tools for ${name}:`, error);
            }

            mcpServers.push({
              id: `kilo_${name}`,
              name: name,
              transport: transportObj,
              tools: tools,
              enabled: config.enabled !== false,
              status: 'unknown', // 需要额外检查状态
              createdAt: Date.now(),
              updatedAt: Date.now(),
              description: config.description || '',
              originalJson: JSON.stringify({ [name]: config }, null, 2),
            });
          } else if (config.type === 'remote' && config.url) {
            // 远程服务器 - 不支持，直接跳过
            console.log(`[KiloMcpAgent] Skipping remote MCP server ${name} - not supported in this context`);
            continue;
          }
        }

        console.log(`[KiloMcpAgent] Detection complete: found ${mcpServers.length} server(s)`);
        return mcpServers;
      } catch (error) {
        console.warn('[KiloMcpAgent] Failed to read Kilo config:', error);
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
        // 查找Kilo配置文件
        const configPaths = [
          'kilo.json',
          'kilo.jsonc',
          '.kilo/kilo.json',
          '.kilo/kilo.jsonc',
          'opencode.json',
          'opencode.jsonc',
          '.opencode/opencode.json',
          '.opencode/opencode.jsonc'
        ];

        let configPath = '';
        for (const path of configPaths) {
          try {
            await safeExec(`test -f "${path}"`, { timeout: 1000, ...getExecEnv() });
            configPath = path;
            break;
          } catch {
            continue;
          }
        }

        // 如果没有找到配置文件，使用默认路径
        if (!configPath) {
          configPath = 'kilo.json';
        }

        for (const server of mcpServers) {
          if (server.transport.type === 'stdio') {
            // 直接修改配置文件添加MCP服务器
            const mcpConfig = {
              type: 'local' as const,
              command: [server.transport.command, ...(server.transport.args || [])],
              enabled: server.enabled,
              description: server.description || '',
            };

            // 读取现有配置
            let configContent = '{}';
            try {
              const { stdout } = await safeExec(`cat "${configPath}"`, { timeout: 5000, ...getExecEnv() });
              configContent = stdout || '{}';
            } catch {
              // 文件不存在，使用空配置
            }

            // 解析并更新配置
            const config = JSON.parse(configContent);
            if (!config.mcp) {
              config.mcp = {};
            }
            config.mcp[server.name] = mcpConfig;

            // 写回配置文件
            const updatedConfig = JSON.stringify(config, null, 2);
            await safeExec(`echo '${updatedConfig.replace(/'/g, "'\\''")}' > "${configPath}"`, { timeout: 5000, ...getExecEnv() });

            console.log(`[KiloMcpAgent] Added MCP server: ${server.name} to ${configPath}`);
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
        // 查找Kilo配置文件
        const configPaths = [
          'kilo.json',
          'kilo.jsonc',
          '.kilo/kilo.json',
          '.kilo/kilo.jsonc',
          'opencode.json',
          'opencode.jsonc',
          '.opencode/opencode.json',
          '.opencode/opencode.jsonc'
        ];

        let configPath = '';
        for (const path of configPaths) {
          try {
            await safeExec(`test -f "${path}"`, { timeout: 1000, ...getExecEnv() });
            configPath = path;
            break;
          } catch {
            continue;
          }
        }

        if (!configPath) {
          console.log(`[KiloMcpAgent] No config file found to remove server: ${mcpServerName}`);
          return { success: true }; // 没有配置文件，认为删除成功
        }

        // 读取现有配置
        let configContent = '{}';
        try {
          const { stdout } = await safeExec(`cat "${configPath}"`, { timeout: 5000, ...getExecEnv() });
          configContent = stdout || '{}';
        } catch {
          console.log(`[KiloMcpAgent] Config file not found: ${configPath}`);
          return { success: true };
        }

        // 解析并删除服务器配置
        const config = JSON.parse(configContent);
        if (config.mcp && config.mcp[mcpServerName]) {
          delete config.mcp[mcpServerName];

          // 写回配置文件
          const updatedConfig = JSON.stringify(config, null, 2);
          await safeExec(`echo '${updatedConfig.replace(/'/g, "'\\''")}' > "${configPath}"`, { timeout: 5000, ...getExecEnv() });

          console.log(`[KiloMcpAgent] Removed MCP server: ${mcpServerName} from ${configPath}`);
        } else {
          console.log(`[KiloMcpAgent] MCP server not found in config: ${mcpServerName}`);
        }

        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    Object.defineProperty(removeOperation, 'name', { value: 'removeMcpServer' });
    return this.withLock(removeOperation);
  }
}