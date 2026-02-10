/**
 * Start command - Create tmux session and launch Claude agents.
 *
 * Creates a tmux session named "lambda" with windows for each agent
 * (james, john, sam) plus a scratchPad for general commands and a
 * dev-server window for the sample Next.js app.
 */
import { execFileSync, execSync } from "child_process";
import { Command } from "commander";
import * as path from "path";

import chalk from "chalk";

import { AGENT_PANES, SESSION_NAME, WINDOW_ENV_VAR } from "../../config";
import { attachToSession } from "../connect";

function sessionExists(): boolean {
  try {
    execSync(`tmux has-session -t ${SESSION_NAME} 2>/dev/null`);

    return true;
  } catch {
    return false;
  }
}

function waitForPort(port: number, timeout = 60000): void {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      execSync(`nc -z localhost ${port} 2>/dev/null`);

      return;
    } catch {
      execSync("sleep 1");
    }
  }
  throw new Error(`Port ${port} not ready after ${timeout}ms`);
}

function createSession(): void {
  if (sessionExists()) {
    console.log(
      chalk.yellow(
        `Session "${SESSION_NAME}" already exists. Use "lambda stop" first.`,
      ),
    );
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const managerDir = path.join(projectRoot, "manager");
  const sampleDir = path.join(projectRoot, "sample");

  // Window order: james, sam, john, scratchPad, dev-server
  // First window is created with new-session
  execSync(
    `tmux new-session -d -s ${SESSION_NAME} -n james -c "${managerDir}"`,
    { stdio: "inherit" },
  );

  // Create remaining agent windows
  execSync(`tmux new-window -t ${SESSION_NAME} -n sam -c "${projectRoot}"`, {
    stdio: "inherit",
  });
  execSync(`tmux new-window -t ${SESSION_NAME} -n john -c "${projectRoot}"`, {
    stdio: "inherit",
  });

  // Create scratchPad window
  execSync(
    `tmux new-window -t ${SESSION_NAME} -n scratchPad -c "${projectRoot}"`,
    { stdio: "inherit" },
  );

  // Create dev-server window (last)
  execSync(
    `tmux new-window -t ${SESSION_NAME} -n dev-server -c "${sampleDir}"`,
    { stdio: "inherit" },
  );
  execSync(`tmux send-keys -t ${SESSION_NAME}:dev-server 'npm run dev' Enter`, {
    stdio: "inherit",
  });
  console.log(chalk.gray("Started dev-server window (Next.js on port 3000)"));

  // Wait for dev server to be ready
  console.log(chalk.gray("Waiting for dev server on port 3000..."));
  waitForPort(3000);
  console.log(chalk.green("Dev server ready on port 3000"));

  console.log(chalk.green(`Created tmux session: ${SESSION_NAME}`));
  console.log(
    chalk.gray(`  Windows: james, sam, john, scratchPad, dev-server`),
  );
}

function launchAgents(): void {
  AGENT_PANES.forEach((pane) => {
    const target = `${SESSION_NAME}:${pane}`;
    const envVar = `${WINDOW_ENV_VAR}=${SESSION_NAME}:${pane}`;

    // Launch Claude with the window env var
    execSync(`tmux send-keys -t ${target} '${envVar} claude' Enter`, {
      stdio: "inherit",
    });
  });

  console.log(chalk.green("Launched Claude in agent windows"));
}

export const registerStartCommand = (program: Command): void => {
  program
    .command("start")
    .description("Create tmux session and launch Claude agents")
    .option("--no-agents", "Create session without launching Claude")
    .option(
      "--service <cmd>",
      "Command to run in a dev-server window",
      (val: string, acc: string[]) => [...acc, val],
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- commander API requires type assertion for default value
      [] as string[],
    )
    .addHelpText(
      "after",
      `
${chalk.bold("Examples:")}
  lambda start                           Create session and launch agents
  lambda start --no-agents               Create session only
  lambda start --service "npm run dev"   Add a dev server window
`,
    )
    .action((opts: { agents: boolean; service: string[] }) => {
      createSession();

      // Create optional service windows
      opts.service.forEach((serviceCmd, i) => {
        const name = `service-${i}`;
        execSync(`tmux new-window -t ${SESSION_NAME} -n ${name}`, {
          stdio: "inherit",
        });
        execFileSync(
          "tmux",
          ["send-keys", "-t", `${SESSION_NAME}:${name}`, serviceCmd, "Enter"],
          { stdio: "inherit" },
        );
        console.log(chalk.gray(`Started service window: ${name}`));
      });

      if (opts.agents) {
        launchAgents();
      }

      console.log("");
      console.log(chalk.bold("Attaching to session..."));

      // Auto-attach to the james window
      execSync(`tmux select-window -t ${SESSION_NAME}:james`, {
        stdio: "inherit",
      });
      attachToSession();
    });
};
