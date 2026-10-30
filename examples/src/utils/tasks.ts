/**
 * Shared task utilities for reading/updating TASKS.md
 */
import * as fs from "fs";
import * as path from "path";

import chalk from "chalk";

export function findProjectRoot(): string {
  // eslint-disable-next-line no-restricted-syntax -- reassigned in loop
  let dir = process.cwd();

  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "TASKS.md"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  throw new Error(
    "Could not find TASKS.md. Run from within the project directory.",
  );
}

export function getTasksPath(): string {
  return path.join(findProjectRoot(), "TASKS.md");
}

export function markTaskDone(taskId: string): void {
  const tasksPath = getTasksPath();
  const content = fs.readFileSync(tasksPath, "utf-8");
  const lines = content.split("\n");

  const pattern = new RegExp(
    `^(\\s*-\\s+\\[)[ ](\\]\\s+${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:)`,
  );

  // eslint-disable-next-line no-restricted-syntax -- reassigned in loop
  let found = false;

  // eslint-disable-next-line no-restricted-syntax -- for loop with break needed for single-match replacement
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      lines[i] = lines[i].replace(pattern, "$1x$2");
      found = true;
      break;
    }
  }

  if (!found) {
    return;
  }

  fs.writeFileSync(tasksPath, lines.join("\n"));
  console.log(chalk.green(`Marked ${taskId} as done.`));
}
