/**
 * Agent Compact - Self-clearing context for Claude
 *
 * This command triggers context compaction by sending /compact to the target window
 * and polls for completion. With --then, it types a follow-up message once done.
 *
 * Usage (from scratchPad):
 *   lambda agent compact --window lambda:dev
 *   lambda agent compact --window lambda:dev --then "Carry on with the trail map."
 *
 * Workflow:
 *   1. Claude runs `lambda agent whoami` to get window name
 *   2. Claude runs via tmux: `tmux send-keys -t lambda:scratchPad 'lambda agent compact -w lambda:dev' Enter`
 *   3. This command (running in scratchPad) sends /compact and polls; with --then, sends that message
 */
import { execSync } from 'child_process';

import { isScratchWindow } from './windows';

const MAX_WAIT_MS = 120000; // 2 minutes max wait
const POLL_INTERVAL_MS = 1000; // Check every second
const MIN_WAIT_MS = 5000; // Minimum wait before polling

export interface CompactOptions {
  window: string;
  /** A message to type into the window once compaction is done. */
  then?: string;
}

/**
 * Poll tmux pane output until compaction complete message appears or timeout
 */
async function waitForCompaction(target: string): Promise<boolean> {
  const startTime = Date.now();

  // Minimum wait before starting to poll
  console.log(`Waiting ${MIN_WAIT_MS / 1000}s before polling...`);
  await new Promise((resolve) => setTimeout(resolve, MIN_WAIT_MS));

  console.log('Polling for completion...');

  while (Date.now() - startTime < MAX_WAIT_MS) {
    try {
      // Only capture last 5 lines to avoid false positives
      const output = execSync(`tmux capture-pane -t ${target} -p -S -5`, {
        encoding: 'utf-8',
      });

      // Look for the specific compaction completion message
      if (output.includes('ctrl+o to see full summary')) {
        return true;
      }
    } catch {
      // Ignore capture errors, keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    process.stdout.write('.');
  }

  return false;
}

export async function runCompact(options: CompactOptions): Promise<void> {
  try {
    const target = options.window;

    if (!target) {
      console.error('Error: --window parameter is required.');
      console.error('');
      console.error('Usage: lambda agent compact --window lambda:dev');
      console.error('');
      console.error('First run `lambda agent whoami` to get your window name.');
      process.exit(1);
    }

    const [, windowName] = target.split(':');

    // Verify targeting an agent window, not a scratch one (the project's shells)
    if (isScratchWindow(windowName)) {
      console.error('Error: Cannot compact scratch windows.');
      process.exit(1);
    }

    console.log(`Target window: ${target}`);
    console.log('');

    // Wait 3 seconds before sending to let Claude settle
    console.log('Waiting 3s before starting...');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Send /compact and confirm autocomplete
    console.log('Sending /compact...');
    execSync(`tmux send-keys -t ${target} '/compact' C-m`);

    // Small delay then send Enter again to confirm autocomplete selection
    await new Promise((resolve) => setTimeout(resolve, 300));
    execSync(`tmux send-keys -t ${target} C-m`);

    // Poll for compaction completion
    const completed = await waitForCompaction(target);

    if (!completed) {
      console.log('');
      console.error('Warning: Timed out waiting for compaction to complete.');
      process.exit(1);
    }

    console.log(' done!');
    console.log('');

    if (options.then !== undefined && options.then !== '') {
      console.log('Sending the follow-up message...');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const escaped = options.then.replace(/'/g, "'\\''");
      execSync(`tmux send-keys -t ${target} '${escaped}' C-m`);
    }

    console.log('Compaction complete!');
  } catch (error) {
    console.error(
      'Error:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    process.exit(1);
  }
}
