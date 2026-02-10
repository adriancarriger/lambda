/**
 * Stop command - Kill the lambda tmux session and clean up.
 */
import { execSync } from "child_process";
import { Command } from "commander";

import { SESSION_NAME } from "../../config";

import chalk from "chalk";

export const registerStopCommand = (program: Command): void => {
  program
    .command("stop")
    .description("Kill the lambda tmux session")
    .action(() => {
      try {
        execSync(`tmux has-session -t ${SESSION_NAME} 2>/dev/null`);
      } catch {
        console.log(chalk.yellow(`No session "${SESSION_NAME}" found.`));
        process.exit(0);
      }

      try {
        execSync(`tmux kill-session -t ${SESSION_NAME}`, { stdio: "inherit" });
        console.log(chalk.green(`Killed session: ${SESSION_NAME}`));
      } catch (error) {
        console.error(
          chalk.red(
            `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          ),
        );
        process.exit(1);
      }
    });
};
