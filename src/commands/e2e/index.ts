/**
 * E2E command - Run Playwright E2E tests.
 *
 * Configurable: works with any Playwright project structure.
 * Spawns the test runner with stdio inherited so output streams to the caller.
 */
import { spawn } from "child_process";
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";

import chalk from "chalk";

/**
 * Find the directory containing the Playwright config.
 * Searches cwd, then upward for playwright.config.ts.
 */
function findPlaywrightDir(): string {
  // eslint-disable-next-line no-restricted-syntax -- reassigned in loop
  let dir = process.cwd();

  while (dir !== path.dirname(dir)) {
    if (
      fs.existsSync(path.join(dir, "playwright.config.ts")) ||
      fs.existsSync(path.join(dir, "playwright.config.js"))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  // Default to cwd if not found
  return process.cwd();
}

function runE2E(args: string[]): void {
  const playwrightDir = findPlaywrightDir();

  const child = spawn("npx", ["playwright", "test", ...args], {
    cwd: playwrightDir,
    stdio: "inherit",
    shell: true,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

export const registerE2ECommand = (program: Command): void => {
  program
    .command("e2e")
    .description("Run E2E tests")
    .allowUnknownOption()
    .helpOption(false)
    .argument("[args...]", "Arguments passed to Playwright")
    .addHelpText(
      "after",
      `
${chalk.bold("Examples:")}
  lambda e2e todo.spec.ts             Run specific test
  lambda e2e --headed                 Run with visible browser
  lambda e2e --help                   Show Playwright help
`,
    )
    .action((args: string[]) => {
      runE2E(args);
    });
};
