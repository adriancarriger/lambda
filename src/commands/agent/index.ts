import { execSync } from "child_process";
import { Command } from "commander";

import { runClear } from "./subcommands/clear";
import { CompactOptions, runCompact } from "./subcommands/compact";

export const registerAgentCommand = (program: Command): void => {
  const agent = program
    .command("agent")
    .description("AI agent management commands");

  agent
    .command("compact")
    .description(
      "Clear agent context and trigger catchup (run from scratchPad)",
    )
    .requiredOption(
      "-w, --window <window>",
      "Target tmux window (e.g., lambda:john)",
    )
    .action(async (options: CompactOptions) => {
      await runCompact(options);
    });

  agent
    .command("clear")
    .description("Clear own context and send handoff message")
    .requiredOption("--self <message>", "Handoff message for the fresh session")
    .action(async (options: { self: string }) => {
      await runClear(options.self);
    });

  agent
    .command("whoami")
    .description("Print current tmux window (for use with compact)")
    .action(() => {
      const tmuxPane = process.env.TMUX_PANE;

      if (!tmuxPane) {
        console.error("Error: Not running in tmux");
        process.exit(1);
      }

      try {
        const target = execSync(
          `tmux display-message -t "${tmuxPane}" -p '#{session_name}:#{window_name}'`,
          { encoding: "utf-8" },
        ).trim();
        console.log(target);
      } catch {
        console.error("Error: Could not determine tmux window");
        process.exit(1);
      }
    });
};
