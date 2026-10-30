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
  .name("lambda-demo")
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
  console.log("  stop        Kill the lambda-demo tmux session");
  console.log("  tasks       Manage project tasks from TASKS.md");
  console.log("  tmux        Send commands to or read output from tmux panes");
  console.log("  trace       Debug Playwright E2E test traces");

  console.log("");
  console.log(chalk.bold("Examples:"));
  console.log("");
  console.log("  Session management:");
  console.log(
    "    $ lambda-demo start                    Create session + launch agents",
  );
  console.log("    $ lambda-demo stop                     Kill session");
  console.log("");
  console.log("  Tmux pane interaction:");
  console.log('    $ lambda-demo tmux scratchPad "echo hi" Send command + Enter');
  console.log("    $ lambda-demo tmux scratchPad           Capture current output");
  console.log("    $ lambda-demo tmux ron C-c             Send Ctrl+C");
  console.log('    $ lambda-demo tmux ron wait "pattern"  Wait for pattern');
  console.log("");
  console.log("  Task management:");
  console.log("    $ lambda-demo tasks list                Show all tasks");
  console.log("    $ lambda-demo tasks next                Get next task ID");
  console.log("    $ lambda-demo tasks show DEMO-1         Print ticket spec");
  console.log("    $ lambda-demo tasks done DEMO-1         Mark task as done");
  console.log("");
  console.log("  E2E trace debugging:");
  console.log("    $ lambda-demo trace diagnose-all");
  console.log("    $ lambda-demo trace summary");
  console.log("    $ lambda-demo trace errors test-results/some-test/trace.zip");
  console.log("");
  console.log("  Ship (branch, commit, PR):");
  console.log(
    "    $ lambda-demo ship DEMO-1               Create branch, commit, push, PR",
  );
  console.log("");
  console.log("  Agent context management:");
  console.log("    $ lambda-demo agent compact -w lambda:ron");
  console.log("    $ lambda-demo agent whoami");
  console.log("");
  console.log(chalk.gray("For command-specific help: lambda-demo <command> --help"));
});

program.parse();
