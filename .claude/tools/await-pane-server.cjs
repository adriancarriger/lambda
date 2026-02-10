#!/usr/bin/env node
/**
 * MCP server for the adrian agent.
 *
 * Exposes a single tool — `await_pane` — that spawns `lambda await <pane>`.
 * Bare JSON-RPC over stdio; no SDK dependency.
 */
'use strict';

const { createInterface } = require('readline');
const { execFileSync } = require('child_process');

const SERVER_INFO = {
  name: 'await-pane',
  version: '1.0.0',
};

const TOOL = {
  name: 'await_pane',
  description:
    'Block until a tmux pane finishes its work (pattern match, shell idle, or output idle).',
  inputSchema: {
    type: 'object',
    properties: {
      pane: {
        type: 'string',
        description: 'Tmux pane name (e.g. scratchPad, john, sam)',
      },
      pattern: {
        type: 'string',
        description: 'Optional regex pattern to match in pane output',
      },
      long: {
        type: 'boolean',
        description: 'Use long idle threshold (60s) for CI/long operations',
      },
    },
    required: ['pane'],
  },
};

function handleInitialize(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    },
  };
}

function handleToolsList(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: { tools: [TOOL] },
  };
}

function handleToolsCall(id, params) {
  const { name, arguments: args } = params;

  if (name !== 'await_pane') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      },
    };
  }

  const { pane, pattern, long } = args || {};

  if (!pane) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'Missing required parameter: pane' }],
      },
    };
  }

  const cmdArgs = ['await', pane];
  if (pattern) cmdArgs.push(pattern);
  if (long) cmdArgs.push('--long');

  try {
    const output = execFileSync('lambda', cmdArgs, {
      encoding: 'utf8',
      timeout: 600_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: output || '(no output)' }],
      },
    };
  } catch (err) {
    const exitCode = err.status;
    const output = (err.stdout || '') + (err.stderr || '');

    if (exitCode === 2) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `TIMEOUT: lambda await timed out (9 min). Re-run to continue waiting.\n${output}`,
            },
          ],
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [
          {
            type: 'text',
            text: `ERROR (exit ${exitCode}): ${output || err.message}`,
          },
        ],
      },
    };
  }
}

function dispatch(msg) {
  const { method, id, params } = msg;

  switch (method) {
    case 'initialize':
      return handleInitialize(id);
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return handleToolsList(id);
    case 'tools/call':
      return handleToolsCall(id, params || {});
    default:
      if (id !== undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      }
      return null;
  }
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const response = dispatch(msg);
  if (response) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }
});
