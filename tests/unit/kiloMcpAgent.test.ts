/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { KiloMcpAgent } from '../../src/process/services/mcpServices/agents/KiloMcpAgent';

describe('KiloMcpAgent', () => {
  it('returns supported transports', () => {
    const agent = new KiloMcpAgent();
    expect(agent.getSupportedTransports()).toEqual(['stdio']);
  });
});