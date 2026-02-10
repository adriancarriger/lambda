/**
 * Connect command - Attach to an existing Lambda tmux session.
 *
 * Auto-detects iTerm2 and uses -CC mode for native tabs.
 */
import { execSync } from "child_process";
import { Command } from "commander";

import { SESSION_NAME } from "../../config";

import chalk from "chalk";

function sessionExists(): boolean {
  try {
    execSync(`tmux has-session -t ${SESSION_NAME} 2>/dev/null`);

    return true;
  } catch {
    return false;
  }
}

function isITerm2(): boolean {
  return process.env.TERM_PROGRAM === "iTerm.app";
}

export function attachToSession(): void {
  const useCC = isITerm2();
  const ccFlag = useCC ? "-CC " : "";

  if (useCC) {
    console.log(chalk.gray("iTerm2 detected — using native tab integration"));
  }

  execSync(`tmux ${ccFlag}attach -t ${SESSION_NAME}`, { stdio: "inherit" });
}

export const registerConnectCommand = (program: Command): void => {
  program
    .command("connect")
    .description("Attach to an existing Lambda tmux session")
    .addHelpText(
      "after",
      `
${chalk.bold("Examples:")}
  lambda connect                  Attach to session (auto-detects iTerm2)
`,
    )
    .action(() => {
      if (!sessionExists()) {
        console.log(
          chalk.red(`No Lambda session found. Run "lambda start" first.`),
        );
        process.exit(1);
      }

      attachToSession();
    });
};
