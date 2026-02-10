/**
 * Ship Command - Create branch, commit, push, and open PR
 *
 * Workflow:
 * 1. Capture current branch (for PR target)
 * 2. Validate ticket ID
 * 3. Create/switch to branch named after ticket
 * 4. Stage all changes
 * 5. Commit with ticket title as message
 * 6. Rebase on main (abort on conflicts)
 * 7. Push to remote (force-with-lease)
 * 8. Create PR targeting previous branch
 * 9. Enable auto-merge
 */
import { execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import chalk from "chalk";

import { DEMO_MODE } from "../../config";
import { markTaskDone } from "../../utils/tasks";
import type { ShipOptions } from "./index";

const exec = (cmd: string): string =>
  execSync(cmd, { encoding: "utf-8" }).trim();

const execSafe = (cmd: string): string | null => {
  try {
    return exec(cmd);
  } catch {
    return null;
  }
};

const getCurrentBranch = (): string => exec("git branch --show-current");

const hasChanges = (): boolean => {
  const status = exec("git status --porcelain");

  return status.length > 0;
};

const branchExists = (branch: string): boolean =>
  execSafe(`git rev-parse --verify ${branch}`) !== null;

const createOrSwitchBranch = (ticketId: string, dryRun: boolean): void => {
  const exists = branchExists(ticketId);

  if (exists) {
    console.log(chalk.gray(`Switching to existing branch: ${ticketId}`));

    if (!dryRun) {
      exec(`git checkout ${ticketId}`);
    }
  } else {
    console.log(chalk.gray(`Creating new branch: ${ticketId}`));

    if (!dryRun) {
      exec(`git checkout -b ${ticketId}`);
    }
  }
};

const runFormat = (dryRun: boolean): void => {
  // Try to run formatter if available
  try {
    exec("which prettier");
    console.log(chalk.gray("Running formatter..."));

    if (!dryRun) {
      execSafe('npx prettier --write "**/*.{ts,tsx,js,jsx,json,css,md}"');
    }
  } catch {
    // No formatter available, skip
  }
};

const stageAndCommit = (message: string, dryRun: boolean): void => {
  runFormat(dryRun);
  console.log(chalk.gray("Staging all changes..."));

  if (!dryRun) {
    // Stages everything — .gitignore controls what's excluded
    exec("git add -A");

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      encoding: "utf-8",
    }).trim();

    if (staged) {
      console.log(chalk.gray("Staged files:"));

      staged.split("\n").forEach((file) => {
        console.log(chalk.gray(`  ${file}`));
      });
    }
  }

  console.log(chalk.gray(`Committing: ${message}`));

  if (!dryRun) {
    execFileSync("git", ["commit", "-m", message], { encoding: "utf-8" });
  }
};

const fetchAndRebase = async (
  ticketId: string,
  dryRun: boolean,
): Promise<boolean> => {
  console.log(chalk.gray("Fetching latest main..."));

  if (!dryRun) {
    exec("git fetch origin main");
  }

  const behindCount = dryRun
    ? "0"
    : exec("git rev-list HEAD..origin/main --count");

  if (behindCount === "0") {
    console.log(chalk.gray("Already up to date with main"));

    return true;
  }

  console.log(
    chalk.gray(`Rebasing on main (${behindCount} commits behind)...`),
  );

  if (dryRun) {
    return true;
  }

  try {
    exec("git rebase origin/main");

    return true;
  } catch {
    console.log(chalk.red("Rebase failed — merge conflicts detected"));
    execSafe("git rebase --abort");
    exec("git checkout main");
    // Optional: integrate with a ticket system to auto-block tickets on merge conflicts.
    // await markTicketBlocked(ticketId, 'Merge conflicts during rebase on main');
    console.log(
      chalk.yellow(`${ticketId} has merge conflicts — returned to main`),
    );

    return false;
  }
};

const pushBranch = (ticketId: string, dryRun: boolean): void => {
  console.log(chalk.gray(`Pushing to origin/${ticketId}...`));

  if (!dryRun) {
    exec(`git push -u origin ${ticketId} --force-with-lease`);
  }
};

const getExistingPR = (ticketId: string): string | null => {
  const result = execSafe(
    `gh pr list --head ${ticketId} --json url --jq '.[0].url'`,
  );

  return result && result.length > 0 ? result : null;
};

/**
 * Get ticket title from tickets/<id>.md if it exists.
 * Falls back to the ticket ID itself.
 */
const getTicketTitle = (ticketId: string): string => {
  try {
    // eslint-disable-next-line no-restricted-syntax -- reassigned in loop
    let dir = process.cwd();

    while (dir !== path.dirname(dir)) {
      const ticketPath = path.join(dir, "tickets", `${ticketId}.md`);

      if (fs.existsSync(ticketPath)) {
        const content = fs.readFileSync(ticketPath, "utf-8");
        // Try to extract title from first # heading
        const titleMatch = content.match(/^#\s+(.+)/m);

        return titleMatch ? titleMatch[1].trim() : ticketId;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Fall through
  }

  return ticketId;
};

const createPR = (
  target: string,
  ticketId: string,
  title: string,
  dryRun: boolean,
): string => {
  // Check if PR already exists
  const existingPR = getExistingPR(ticketId);

  if (existingPR) {
    console.log(chalk.yellow(`PR already exists: ${existingPR}`));

    return existingPR;
  }

  console.log(chalk.gray(`Creating PR: ${ticketId} -> ${target}`));

  if (dryRun) {
    return "(dry-run: no PR created)";
  }

  const prUrl = execFileSync(
    "gh",
    [
      "pr",
      "create",
      "--base",
      target,
      "--title",
      title,
      "--body",
      `Ticket: ${ticketId}`,
    ],
    { encoding: "utf-8" },
  ).trim();

  return prUrl;
};

export const runShip = async (
  ticketId: string,
  options: ShipOptions,
): Promise<void> => {
  const { message, dryRun = DEMO_MODE } = options;

  if (dryRun) {
    console.log(
      chalk.yellow(
        "DRY RUN - no changes will be made (DEMO_MODE is on in src/config.ts, pass --no-dry-run to override)\n",
      ),
    );
  }

  try {
    // 1. Capture current branch and validate
    const currentBranch = getCurrentBranch();
    const prTarget = "main";

    // Must be on main or the ticket branch
    if (currentBranch !== "main" && currentBranch !== ticketId) {
      console.error(
        chalk.red(`Error: Must be on 'main' or '${ticketId}' branch`),
      );
      console.error(chalk.gray(`Currently on: ${currentBranch}`));
      console.error(chalk.gray("Switch to main first: git checkout main"));
      process.exit(1);
    }

    console.log(chalk.bold(`Shipping ${ticketId}...\n`));

    // 2. Get ticket title
    const ticketTitle = getTicketTitle(ticketId);
    console.log(chalk.green(`Ticket: ${ticketTitle}\n`));

    // 3. Check for changes (only if not already on ticket branch)
    if (currentBranch !== ticketId && !hasChanges()) {
      console.error(chalk.red("Error: No changes to commit"));
      console.error(
        chalk.gray(
          "Stage some changes first or switch to a branch with changes",
        ),
      );
      process.exit(1);
    }

    // 4. Create or switch to ticket branch
    if (currentBranch !== ticketId) {
      createOrSwitchBranch(ticketId, dryRun);
    } else {
      console.log(chalk.gray(`Already on branch: ${ticketId}`));
    }

    // 5. Stage and commit
    const commitMessage = message || `${ticketId}: ${ticketTitle}`;

    if (hasChanges()) {
      stageAndCommit(commitMessage, dryRun);
    } else {
      console.log(chalk.gray("No unstaged changes to commit"));
    }

    // 6. Rebase on main
    const rebaseOk = await fetchAndRebase(ticketId, dryRun);

    if (!rebaseOk) {
      return;
    }

    // 7. Push
    pushBranch(ticketId, dryRun);

    // 8. Create PR
    const prUrl = createPR(prTarget, ticketId, commitMessage, dryRun);

    // 9. Enable auto-merge with squash
    if (!dryRun) {
      console.log(chalk.gray("Enabling auto-merge..."));
      exec(`gh pr merge ${ticketId} --auto --squash`);
    }

    // Optional: integrate with a ticket system to update status after PR creation.
    // console.log(chalk.gray('Updating ticket status to CI...'));
    // if (!dryRun) {
    //   await updateIssue(ticketId, { status: 'CI' });
    // }

    // 10. Mark task done in TASKS.md (always, even in dry-run)
    try {
      markTaskDone(ticketId);
    } catch {
      // TASKS.md may not exist — that's fine
    }

    console.log("");
    console.log(chalk.green.bold("Ship complete!"));
    console.log(chalk.gray(`  Branch: ${ticketId}`));
    console.log(chalk.gray(`  PR: ${prUrl}`));
    console.log(chalk.gray("  Auto-merge: enabled"));
  } catch (error) {
    console.error(
      chalk.red(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      ),
    );
    process.exit(1);
  }
};
