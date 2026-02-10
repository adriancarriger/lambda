#!/usr/bin/env node
import { Command } from "commander";

import { registerAgentCommand } from "./commands/agent";
import { registerAwaitCommand } from "./commands/await";
import { registerConnectCommand } from "./commands/connect";
import { registerE2ECommand } from "./commands/e2e";
import { registerShipCommand } from "./commands/ship";
import { registerStartCommand } from "./commands/start";
import { registerStopCommand } from "./commands/stop";
import { registerTasksCommand } from "./commands/tasks";
import { registerTmuxCommand } from "./commands/tmux";
import { registerTraceCommand } from "./commands/trace";

import chalk from "chalk";

const program = new Command();

program
  .name("lambda")
  .description("Lambda CLI - Multi-agent development orchestration")
  .version("0.1.0");

// Register commands
registerAgentCommand(program);
registerAwaitCommand(program);
registerConnectCommand(program);
registerE2ECommand(program);
registerShipCommand(program);
registerStartCommand(program);
registerStopCommand(program);
registerTasksCommand(program);
registerTmuxCommand(program);
registerTraceCommand(program);

// Add help text with examples
program.on("--help", () => {
  console.log("");
  console.log(chalk.bold("Commands:"));
  console.log("");
  console.log("  agent       AI agent management (context compaction)");
  console.log("  await       Block until pane is done (for delegated waiting)");
  console.log("  connect     Attach to an existing Lambda session");
  console.log("  e2e         Run E2E tests");
  console.log("  ship        Create branch, commit, push, and open PR");
  console.log("  start       Create tmux session and launch Claude agents");
  console.log("  stop        Kill the lambda tmux session");
  console.log("  tasks       Manage project tasks from TASKS.md");
  console.log("  tmux        Send commands to or read output from tmux panes");
  console.log("  trace       Debug Playwright E2E test traces");

  console.log("");
  console.log(chalk.bold("Examples:"));
  console.log("");
  console.log("  Session management:");
  console.log(
    "    $ lambda start                    Create session + launch agents",
  );
  console.log("    $ lambda stop                     Kill session");
  console.log("");
  console.log("  Tmux pane interaction:");
  console.log('    $ lambda tmux scratchPad "echo hi" Send command + Enter');
  console.log("    $ lambda tmux scratchPad           Capture current output");
  console.log("    $ lambda tmux john C-c             Send Ctrl+C");
  console.log('    $ lambda tmux john wait "pattern"  Wait for pattern');
  console.log("");
  console.log("  Task management:");
  console.log("    $ lambda tasks list                Show all tasks");
  console.log("    $ lambda tasks next                Get next task ID");
  console.log("    $ lambda tasks show DEMO-1         Print ticket spec");
  console.log("    $ lambda tasks done DEMO-1         Mark task as done");
  console.log("");
  console.log("  E2E trace debugging:");
  console.log("    $ lambda trace diagnose-all");
  console.log("    $ lambda trace summary");
  console.log("    $ lambda trace errors test-results/some-test/trace.zip");
  console.log("");
  console.log("  Ship (branch, commit, PR):");
  console.log(
    "    $ lambda ship DEMO-1               Create branch, commit, push, PR",
  );
  console.log("");
  console.log("  Agent context management:");
  console.log("    $ lambda agent compact -w lambda:john");
  console.log("    $ lambda agent whoami");
  console.log("");
  console.log(chalk.gray("For command-specific help: lambda <command> --help"));
});

program.parse();
