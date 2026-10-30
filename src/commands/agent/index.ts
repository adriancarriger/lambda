import { execSync } from 'child_process';
import { Command } from 'commander';

import { getLogFilePath, isAgentType, readLogEntries } from './agent-logger';
import { runClear } from './subcommands/clear';
import { CompactOptions, runCompact } from './subcommands/compact';
import { runContext } from './subcommands/context';
import { WINDOW_MAP_ENV } from './subcommands/windows';

const chalk = require('chalk');

export const registerAgentCommand = (program: Command): void => {
  const agent = program
    .command('agent')
    .description('AI agent management commands');

  agent
    .command('compact')
    .description('Compact agent context (run from scratchPad)')
    .requiredOption(
      '-w, --window <window>',
      'Target tmux window (e.g., lambda:dev)'
    )
    .option('--then <message>', 'Message to type once compaction is done')
    .action(async (options: CompactOptions) => {
      await runCompact(options);
    });

  agent
    .command('clear')
    .description('Clear own context and send handoff message')
    .requiredOption('--self <message>', 'Handoff message for the fresh session')
    .action(async (options: { self: string }) => {
      await runClear(options.self);
    });

  agent
    .command('whoami')
    .description('Print current tmux window (for use with compact)')
    .action(() => {
      const tmuxPane = process.env.TMUX_PANE;

      if (!tmuxPane) {
        console.error('Error: Not running in tmux');
        process.exit(1);
      }

      try {
        const target = execSync(
          `tmux display-message -t "${tmuxPane}" -p '#{session_name}:#{window_name}'`,
          { encoding: 'utf-8' }
        ).trim();
        console.log(target);
      } catch {
        console.error('Error: Could not determine tmux window');
        process.exit(1);
      }
    });

  agent
    .command('context')
    .description('Check context/token usage for a Claude Code session')
    .requiredOption(
      '-w, --window <window>',
      'Target tmux window (e.g., lambda:dev)'
    )
    .option(
      '--warn-at <tokens>',
      'Token threshold for warning (default: 90000)',
      '90000'
    )
    .option(
      '--map <file>',
      `Window-to-session map (default: $${WINDOW_MAP_ENV}, else .lambda/window-map.json in the project)`
    )
    .option('--json', 'Output as JSON')
    .action(
      async (options: {
        window: string;
        warnAt?: string;
        map?: string;
        json?: boolean;
      }) => {
        await runContext({
          window: options.window,
          warnAt: options.warnAt ? parseInt(options.warnAt, 10) : 90000,
          map: options.map,
          json: options.json,
        });
      }
    );

  agent
    .command('log')
    .description('View agent interaction log')
    .option('--tail <n>', 'Show last N entries (default: 20)', '20')
    .option(
      '--agent <type>',
      'Filter by agent type (manager, dev, qa, unknown)'
    )
    .option('--json', 'Output as JSON')
    .option('--path', 'Show log file path')
    .action(
      (options: {
        tail?: string;
        agent?: string;
        json?: boolean;
        path?: boolean;
      }) => {
        if (options.path) {
          console.log(
            getLogFilePath() ?? 'No codebase here (run lambda init).'
          );

          return;
        }

        const agentFilter = isAgentType(options.agent)
          ? options.agent
          : undefined;
        const entries = readLogEntries({
          tail: options.tail ? parseInt(options.tail, 10) : 20,
          agent: agentFilter,
        });

        if (entries.length === 0) {
          console.log(chalk.gray('No log entries found.'));

          return;
        }

        if (options.json) {
          console.log(JSON.stringify(entries, null, 2));

          return;
        }

        // Pretty print entries
        for (const entry of entries) {
          const time = new Date(entry.ts).toLocaleTimeString();
          const agentColor =
            entry.agent === 'manager'
              ? chalk.blue
              : entry.agent === 'dev'
              ? chalk.green
              : entry.agent === 'qa'
              ? chalk.yellow
              : chalk.gray;
          const outcomeColor =
            entry.outcome === 'success' ? chalk.green : chalk.red;

          const argsStr =
            entry.args.length > 0 ? ` ${entry.args.join(' ')}` : '';
          const durationStr = entry.duration
            ? chalk.gray(` (${(entry.duration / 1000).toFixed(1)}s)`)
            : '';
          const ticketStr = entry.ticketId
            ? chalk.cyan(` [${entry.ticketId}]`)
            : '';
          const errorStr = entry.error ? chalk.red(` - ${entry.error}`) : '';

          console.log(
            `${chalk.gray(time)} ${agentColor(
              entry.agent.padEnd(7)
            )} ${outcomeColor(
              entry.outcome === 'success' ? '✓' : '✗'
            )} ${chalk.white(
              entry.cmd
            )}${argsStr}${ticketStr}${durationStr}${errorStr}`
          );
        }
      }
    );
};
