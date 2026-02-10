import { Command } from "commander";

import { runShip } from "./run";

import chalk from "chalk";

export interface ShipOptions {
  message?: string;
  dryRun?: boolean;
}

export const registerShipCommand = (program: Command): void => {
  program
    .command("ship <ticket-id>")
    .description("Create branch, commit, push, and open PR")
    .option(
      "-m, --message <msg>",
      "Override commit message (default: ticket title)",
    )
    .option("--dry-run", "Preview what would happen without executing")
    .addHelpText(
      "after",
      `
${chalk.bold("Examples:")}
  lambda ship DEMO-1                Create branch, commit, push, and open PR
  lambda ship DEMO-1 --dry-run      Preview without executing
  lambda ship DEMO-1 -m "Custom"    Use custom commit message
`,
    )
    .action(async (ticketId: string, options: ShipOptions) => {
      await runShip(ticketId, options);
    });
};
