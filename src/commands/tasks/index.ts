/**
 * Tasks command - Markdown-based task queue.
 *
 * Parses TASKS.md in the project root for task status, and reads
 * detailed specs from tickets/<id>.md.
 *
 * Task format in TASKS.md:
 *   - [ ] DEMO-1: Add delete button to each todo item
 *   - [x] DEMO-2: Add completed checkbox (done)
 *   - [B] DEMO-3: Add filter bar (blocked)
 *
 * Supports hierarchical tasks (children are indented):
 *   - [ ] DEMO-1: Parent task
 *     - [ ] DEMO-1a: Child task
 *     - [ ] DEMO-1b: Another child
 *
 * Default mode: Hierarchical
 *   - Children within a parent are strict sequential (must complete in order)
 *   - Top-level tasks skip blocked items and move to next available
 */
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";

import chalk from "chalk";

import { findProjectRoot, getTasksPath, markTaskDone } from "../../utils/tasks";

interface Task {
  id: string;
  description: string;
  status: "todo" | "done" | "blocked";
  blockReason?: string;
  indent: number;
  line: number;
  raw: string;
}

function getTicketPath(id: string): string {
  return path.join(findProjectRoot(), "tickets", `${id}.md`);
}

function parseTasks(): Task[] {
  const tasksPath = getTasksPath();

  if (!fs.existsSync(tasksPath)) {
    return [];
  }

  const content = fs.readFileSync(tasksPath, "utf-8");
  const lines = content.split("\n");
  const tasks: Task[] = [];

  // eslint-disable-next-line no-restricted-syntax -- for loop with continue needed for line-by-line parsing
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line) {
      continue;
    }

    // Match: optional whitespace, -, space, [status], space, ID: description
    const match = line.match(
      /^(\s*)-\s+\[([ xXB])\]\s+([A-Za-z0-9_-]+):\s*(.*)/,
    );

    if (!match) {
      continue;
    }

    const [, indent, statusChar, id, description] = match;
    const indentLevel = indent ? indent.length : 0;

    // eslint-disable-next-line no-restricted-syntax -- reassigned in switch
    let status: Task["status"];
    // eslint-disable-next-line no-restricted-syntax -- reassigned in switch
    let blockReason: string | undefined;

    switch (statusChar) {
      case " ":
        status = "todo";
        break;
      case "x":
      case "X":
        status = "done";
        break;
      case "B": {
        status = "blocked";
        // Extract block reason if present: (blocked: reason)
        const reasonMatch = description.match(/\(blocked:\s*(.*?)\)/);
        blockReason = reasonMatch ? reasonMatch[1] : undefined;
        break;
      }
      default:
        status = "todo";
    }

    // eslint-disable-next-line no-restricted-syntax -- push needed for imperative loop building
    tasks.push({
      id,
      description: description.replace(/\s*\(blocked:.*?\)/, "").trim(),
      status,
      blockReason,
      indent: indentLevel,
      line: i,
      raw: line,
    });
  }

  return tasks;
}

/**
 * Hierarchical mode: children are strict sequential, top-level skips blocked.
 */
function findNextTask(tasks: Task[]): Task | null {
  // Group tasks into top-level and their children
  // eslint-disable-next-line no-restricted-syntax -- for loop with continue and index-dependent child scan
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    if (task.indent > 0) {
      continue; // Skip children in top-level scan
    }

    if (task.status === "done") {
      continue;
    }

    if (task.status === "blocked") {
      continue; // Skip blocked at top level
    }

    // Check if this top-level task has children
    const children: Task[] = [];

    // eslint-disable-next-line no-restricted-syntax -- for loop with break needed for child boundary detection
    for (let j = i + 1; j < tasks.length; j++) {
      if (tasks[j].indent <= task.indent) {
        break;
      }
      // eslint-disable-next-line no-restricted-syntax -- push needed for imperative loop building
      children.push(tasks[j]);
    }

    if (children.length === 0) {
      return task;
    }

    // Find first uncomplete child (strict sequential)
    const nextChild = children.find((c) => c.status === "todo");

    if (nextChild) {
      return nextChild;
    }

    // All children done? Check if the parent itself needs completion
    const allChildrenDone = children.every((c) => c.status === "done");

    if (allChildrenDone && task.status === "todo") {
      return task;
    }

    // Some children blocked — skip this top-level task
  }

  return null;
}

function toggleDone(taskId: string): void {
  markTaskDone(taskId);
}

function markBlocked(taskId: string, reason: string): void {
  const tasksPath = getTasksPath();
  const content = fs.readFileSync(tasksPath, "utf-8");
  const lines = content.split("\n");

  const pattern = new RegExp(
    `^(\\s*-\\s+\\[)[ ](\\]\\s+${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*)(.*)`,
  );

  // eslint-disable-next-line no-restricted-syntax -- reassigned in loop
  let found = false;

  // eslint-disable-next-line no-restricted-syntax -- for loop with break needed for single-match replacement
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      lines[i] = lines[i].replace(pattern, `$1B$2$3 (blocked: ${reason})`);
      found = true;
      break;
    }
  }

  if (!found) {
    console.error(chalk.red(`Task ${taskId} not found.`));
    process.exit(1);
  }

  fs.writeFileSync(tasksPath, lines.join("\n"));
  console.log(chalk.yellow(`Marked ${taskId} as blocked: ${reason}`));
}

export const registerTasksCommand = (program: Command): void => {
  const tasks = program
    .command("tasks")
    .description("Manage project tasks from TASKS.md");

  tasks
    .command("next")
    .description("Print the next available task")
    .action(() => {
      const allTasks = parseTasks();
      const next = findNextTask(allTasks);

      if (!next) {
        console.log("");
        process.exit(0);
      }

      console.log(next.id);
    });

  tasks
    .command("show <id>")
    .description("Print the contents of a ticket spec")
    .action((id: string) => {
      const ticketPath = getTicketPath(id);

      if (!fs.existsSync(ticketPath)) {
        console.error(chalk.red(`Ticket not found: ${ticketPath}`));
        process.exit(1);
      }

      console.log(fs.readFileSync(ticketPath, "utf-8"));
    });

  tasks
    .command("done [id]")
    .description("Mark a task as done (defaults to current task from `next`)")
    .action((id?: string) => {
      const taskId =
        id ||
        (() => {
          const allTasks = parseTasks();
          const next = findNextTask(allTasks);

          if (!next) {
            console.error(chalk.red("No current task to mark done."));
            process.exit(1);
          }

          return next.id;
        })();

      toggleDone(taskId);
    });

  tasks
    .command("block [id]")
    .description("Mark a task as blocked")
    .requiredOption("--reason <reason>", "Reason for blocking")
    .action((id: string | undefined, opts: { reason: string }) => {
      const taskId =
        id ||
        (() => {
          const allTasks = parseTasks();
          const next = findNextTask(allTasks);

          if (!next) {
            console.error(chalk.red("No current task to block."));
            process.exit(1);
          }

          return next.id;
        })();

      markBlocked(taskId, opts.reason);
    });

  tasks
    .command("list")
    .description("Show all tasks with status")
    .action(() => {
      const allTasks = parseTasks();

      if (allTasks.length === 0) {
        console.log(chalk.gray("No tasks found in TASKS.md"));

        return;
      }

      allTasks.forEach((task) => {
        const indent = " ".repeat(task.indent);
        const statusIcon =
          task.status === "done"
            ? chalk.green("[x]")
            : task.status === "blocked"
              ? chalk.yellow("[B]")
              : chalk.white("[ ]");
        const desc =
          task.status === "done"
            ? chalk.gray(`${task.id}: ${task.description}`)
            : task.status === "blocked"
              ? chalk.yellow(
                  `${task.id}: ${task.description}${
                    task.blockReason ? ` (blocked: ${task.blockReason})` : ""
                  }`,
                )
              : `${task.id}: ${task.description}`;

        console.log(`${indent}${statusIcon} ${desc}`);
      });
    });

  // Alternative task-scheduling modes. Uncomment one to change how `lambda tasks next` picks work:
  // - findNextTaskSimple: strict order, stops at first todo
  // - findNextTaskStrict: strict order, stops if any task is blocked
  //
  // function findNextTaskSimple(tasks: Task[]): Task | null {
  //   return tasks.find((t) => t.status === 'todo') || null;
  // }
  //
  // function findNextTaskStrict(tasks: Task[]): Task | null {
  //   for (const task of tasks) {
  //     if (task.status === 'todo') return task;
  //     if (task.status === 'blocked') return null; // blocked = stop
  //   }
  //   return null;
  // }

  // Optional: integrate with a ticket system (e.g. Linear, Jira) to pull tasks automatically.
  // tasks
  //   .command('pull')
  //   .description('Fetch tasks from Linear')
  //   .action(async () => {
  //     // const { getIssues } = require('./linear-integration');
  //     // const issues = await getIssues();
  //     // writeTasks(issues);
  //     console.log('Linear integration not configured');
  //   });
};
