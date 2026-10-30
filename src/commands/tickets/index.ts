/**
 * `lambda tickets …`: one command set over the project's tracker (plain files,
 * Linear or Jira). Every subcommand is one `TicketSource` method, so it
 * behaves the same on all three; people see Lambda's states whatever the
 * project calls them. `list`, `get` and `next` take `--json`, for agents.
 */
import { type Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import {
  type MachineConfig,
  loadMachineConfig,
} from '../../config/machineConfig';
import {
  type Project,
  loadProjectConfig,
  resolvePodsRoot,
} from '../../config/projectConfig';
import { createPodStore } from '../../pod-store/store';
import { ownerForAgent, ownerNameIn } from '../../pod/owner';
import { openTicketSource } from '../../tickets/context';
import { registerScenariosCommand } from '../../tickets/scenarios';
import {
  NOTHING_READY,
  type Ticket,
  type TicketSource,
  assertTicketId,
  parsePriority,
  parseTicketState,
} from '../../tickets/source';
import { type GateStore, checkBlockGate } from './gate';

type Env = Record<string, string | undefined>;

/** What the commands run against; tests hand in their own. */
export interface TicketsDeps {
  project: Project;
  machine: MachineConfig | null;
  source: TicketSource;
  env: Env;
  /** The pod store the block gate reads. */
  podStore: () => GateStore;
  readStdin: () => string;
  print: (text: string) => void;
}

const loadDeps = (): TicketsDeps => {
  const project = loadProjectConfig(process.cwd());

  if (project === null) {
    throw new Error('No codebase here: run lambda init first.');
  }

  const machine = loadMachineConfig();

  return {
    project,
    machine,
    source: openTicketSource(project, machine),
    env: process.env,
    podStore: () => createPodStore(resolvePodsRoot(project)),
    readStdin: () => fs.readFileSync(0, 'utf8'),
    print: (text) => console.log(text),
  };
};

const id = (value: string): string => assertTicketId(value.trim());

const collect = (value: string, previous: string[] = []): string[] => [
  ...previous,
  value,
];

// ── output ──────────────────────────────────────────────────────────────────

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const width = (values: string[]): number =>
  values.reduce((widest, value) => Math.max(widest, value.length), 0);

/** The header: `<name> · <source>`, plus the queue file for markdown. */
const header = (project: Project): string => {
  const { tickets } = project.config;
  const name = project.config.name ?? path.basename(project.root);
  const where =
    tickets.source === 'markdown' ? ` (${tickets.queue ?? 'TASKS.md'})` : '';

  return `${name} · ${tickets.source}${where}`;
};

export const formatList = (project: Project, tickets: Ticket[]): string => {
  if (tickets.length === 0) {
    return `${header(project)}\n  No tickets.`;
  }

  const idWidth = width(tickets.map((ticket) => ticket.id)) + 2;
  const indentOf = (ticket: Ticket): string =>
    ticket.parent === null ? '  ' : '    ';
  const lead = (ticket: Ticket): string =>
    `${indentOf(ticket)}${ticket.id.padEnd(idWidth)}${ticket.title}`;
  // Statuses line up in one column, wherever a child's title starts.
  const statusColumn = width(tickets.map(lead)) + 2;
  const rows = tickets.flatMap((ticket) => {
    const indent = indentOf(ticket);
    const row = `${lead(ticket).padEnd(statusColumn)}${ticket.status}`;
    const reason =
      ticket.blockReason === null
        ? []
        : [
            `${' '.repeat(indent.length + idWidth)}(blocked: ${
              ticket.blockReason
            })`,
          ];

    return [row, ...reason];
  });

  return [header(project), ...rows].join('\n');
};

const formatGet = (ticket: Ticket & { description: string }): string =>
  [
    `${ticket.id}  ${ticket.title}  ${ticket.status}`,
    ...(ticket.description.trim() === ''
      ? []
      : ['', ticket.description.trimEnd()]),
  ].join('\n');

// ── commands ────────────────────────────────────────────────────────────────

interface ListOptions {
  json?: boolean;
  reporter?: string;
}

interface CreateOptions {
  title: string;
  parent?: string;
  status?: string;
  descriptionStdin?: boolean;
  priority?: string;
  computer?: string;
}

export interface UpdateOptions {
  status?: string;
  reason?: string;
  title?: string;
  label?: string[];
  priority?: string;
  /** A computer's name; `none` unassigns. */
  computer?: string;
}

/** `--computer none` unassigns; any other value is the computer's name. */
const assigneeOption = (value: string | undefined): string | null | undefined =>
  value === undefined ? undefined : value === 'none' ? null : value;

interface CommentFlags {
  image?: string[];
  alt?: string[];
}

/**
 * `--image` / `--alt` pairs, in order: the i-th alt goes with the i-th image.
 * Commander keeps the two lists apart, so with any --alt there must be one
 * per --image; otherwise which image an alt belongs to can't be told.
 */
export const commentImages = (
  flags: CommentFlags
): Array<{ path: string; alt?: string }> => {
  const images = flags.image ?? [];
  const alts = flags.alt ?? [];

  if (alts.length > 0 && alts.length !== images.length) {
    throw new Error(
      `${alts.length} --alt for ${images.length} --image: give one --alt per --image, in the same order, or none.`
    );
  }

  return images.map((file, index) => ({ path: file, alt: alts[index] }));
};

interface BlockOptions {
  by: string;
  qid?: string;
  checkpoint?: string;
}

/** A title or reason is one line in every source; refused before any sees it. */
const multiLineRefusal = (
  options: Partial<Record<'title' | 'reason', string>>
): string | null => {
  const spanning = (['title', 'reason'] as const).find((name) =>
    /[\r\n]/.test(options[name] ?? '')
  );

  return spanning === undefined ? null : `--${spanning} can't span lines.`;
};

/** What `update` refuses before it reaches the source, on every source. */
const updateRefusal = (options: UpdateOptions): string | null => {
  const multiLine = multiLineRefusal(options);

  if (multiLine !== null) {
    return multiLine;
  }

  if (options.reason !== undefined && options.status !== 'blocked') {
    return '--reason goes with --status blocked.';
  }

  const changes = [
    options.status,
    options.title,
    options.label,
    options.priority,
    options.computer,
  ];

  return changes.every((change) => change === undefined)
    ? 'Nothing to update: pass --status, --title, --label, --priority or --computer.'
    : null;
};

/**
 * `lambda tickets update <id>`: its refusals, then the source's update.
 * `lambda pod blocked` comes through here too (ungated: a state change, not
 * a dependency).
 */
export const runTicketsUpdate = async (
  deps: Pick<TicketsDeps, 'source' | 'print'>,
  ticketId: string,
  options: UpdateOptions
): Promise<Ticket> => {
  const refusal = updateRefusal(options);

  if (refusal !== null) {
    throw new Error(refusal);
  }

  const updated = await deps.source.update(id(ticketId), {
    status:
      options.status === undefined
        ? undefined
        : parseTicketState(options.status),
    reason: options.reason,
    title: options.title,
    labels: options.label,
    priority:
      options.priority === undefined
        ? undefined
        : parsePriority(options.priority),
    assignee: assigneeOption(options.computer),
  });

  deps.print(`${updated.id}  ${updated.title}  ${updated.status}`);

  return updated;
};

const gate = (deps: TicketsDeps, options: BlockOptions): void =>
  checkBlockGate({
    podId: deps.env.POD_ID,
    qid: options.qid,
    checkpoint: options.checkpoint,
    // Read by the pod's agent: "the owner" when no name is set.
    owner: ownerForAgent(ownerNameIn(deps.machine)),
    store: deps.podStore,
  });

/** Register `lambda tickets` and its subcommands. */
export const registerTicketsCommand = (
  program: Command,
  deps: () => TicketsDeps = loadDeps
): void => {
  const tickets = program
    .command('tickets')
    .description("Read and change the codebase's tickets");

  tickets
    .command('list')
    .description('Every ticket in queue order')
    .option('--json', 'Print the ticket shape, for agents')
    .option('--reporter <email|name>', "Only that person's tickets")
    .action(async (options: ListOptions) => {
      const d = deps();
      const found = await d.source.list({ reporter: options.reporter });

      d.print(
        options.json === true ? json(found) : formatList(d.project, found)
      );
    });

  tickets
    .command('next')
    .description('The ticket to build next')
    .option('--json', 'Print the ticket shape (or null), for agents')
    .option('--reporter <email|name>', "Only that person's tickets")
    .action(async (options: ListOptions) => {
      const d = deps();
      const next = await d.source.next({ reporter: options.reporter });

      if (options.json === true) {
        d.print(json(next));

        return;
      }

      d.print(next === null ? NOTHING_READY : `${next.id}  ${next.title}`);
    });

  tickets
    .command('get <id>')
    .description('One ticket and its description')
    .option('--json', 'Print the ticket shape, for agents')
    .action(async (ticketId: string, options: { json?: boolean }) => {
      const d = deps();
      const ticket = await d.source.get(id(ticketId));

      d.print(options.json === true ? json(ticket) : formatGet(ticket));
    });

  tickets
    .command('pull <id>')
    .description('Write a ticket to files you can edit')
    .action(async (ticketId: string) => {
      const d = deps();
      const where = await d.source.pull(id(ticketId));

      d.print(
        d.source.kind === 'markdown' ? `${where}  (edit it in place)` : where
      );
    });

  tickets
    .command('push <id>')
    .description("Send a pulled ticket's edits back")
    .action(async (ticketId: string) => {
      const d = deps();
      const { push } = d.source;

      d.print(await push(id(ticketId)));
    });

  tickets
    .command('create')
    .description('Create a ticket and print its id')
    .requiredOption('--title <title>', 'The title')
    .option('--parent <id>', 'Make it a child of this ticket')
    .option('--status <state>', 'Its state (default inbox)')
    .option('--priority <level>', 'urgent, high, medium, low or none')
    .option('--computer <name>', 'Assign it to this computer')
    .option('--description-stdin', 'Read the description from stdin')
    .action(async (options: CreateOptions) => {
      const refusal = multiLineRefusal(options);

      if (refusal !== null) {
        throw new Error(refusal);
      }

      const d = deps();
      const created = await d.source.create({
        title: options.title,
        parent: options.parent === undefined ? undefined : id(options.parent),
        status:
          options.status === undefined
            ? undefined
            : parseTicketState(options.status),
        description:
          options.descriptionStdin === true ? d.readStdin() : undefined,
        priority:
          options.priority === undefined
            ? undefined
            : parsePriority(options.priority),
        assignee: assigneeOption(options.computer),
      });

      d.print(created.id);
    });

  tickets
    .command('update <id>')
    .description("Change a ticket's state, title, labels, priority or computer")
    .option('--status <state>', "One of Lambda's states")
    .option('--priority <level>', 'urgent, high, medium, low or none')
    .option(
      '--computer <name>',
      'Assign it to this computer (only it builds it); none unassigns'
    )
    .option('--reason <text>', 'Why, with --status blocked')
    .option('--title <title>', 'A new title')
    .option('--label <key>', 'Add a label (repeatable)', collect)
    .action(async (ticketId: string, options: UpdateOptions) => {
      await runTicketsUpdate(deps(), ticketId, options);
    });

  tickets
    .command('attach <id> <file>')
    .description('Attach a file to a ticket and print its ref (a link to it)')
    .option(
      '--alt <text>',
      'What the picture shows: prints ![text](ref) instead of the ref'
    )
    .option('--name <file>', 'Attach it under this file name')
    .action(
      async (
        ticketId: string,
        file: string,
        options: { alt?: string; name?: string }
      ) => {
        const d = deps();
        const { ref } = await d.source.attach(id(ticketId), file, {
          alt: options.alt,
          name: options.name,
        });

        d.print(options.alt === undefined ? ref : `![${options.alt}](${ref})`);
      }
    );

  tickets
    .command('comment <id> <text>')
    .description(
      'Add a comment; {{image:0}} in the text is the first --image, and an image with no token goes at the end'
    )
    .option('--image <file>', 'Attach a picture first (repeatable)', collect)
    .option(
      '--alt <text>',
      'Alt text: one per --image, in the same order, or none',
      collect
    )
    .action(async (ticketId: string, text: string, options: CommentFlags) => {
      const images = commentImages(options);
      const d = deps();
      await d.source.comment(
        id(ticketId),
        text,
        images.length === 0 ? undefined : { images }
      );

      d.print(`Commented on ${ticketId}.`);
    });

  tickets
    .command('delete <id>')
    .description('Delete a ticket with no children')
    .requiredOption('--reason <text>', 'Why it goes')
    .action(async (ticketId: string, options: { reason: string }) => {
      const d = deps();
      await d.source.delete(id(ticketId), options.reason);

      d.print(`Deleted ${ticketId}.`);
    });

  const dependency = (name: 'block' | 'unblock', description: string): void => {
    tickets
      .command(`${name} <id>`)
      .description(description)
      .requiredOption('--by <id>', 'The ticket it waits on')
      .option('--qid <qid>', 'In a pod: the question the owner answered')
      .option('--checkpoint <qid>', 'In a pod: a checkpoint the owner closed')
      .action(async (ticketId: string, options: BlockOptions) => {
        const d = deps();
        gate(d, options);
        const blocked = id(ticketId);
        const by = id(options.by);

        if (name === 'block' && blocked === by) {
          throw new Error(`${blocked} can't be blocked by itself.`);
        }

        if (name === 'block') {
          await d.source.block(blocked, by);
          d.print(`${blocked} is now blocked by ${by}.`);

          return;
        }

        await d.source.unblock(blocked, by);
        d.print(`${blocked} is no longer blocked by ${by}.`);
      });
  };

  dependency(
    'block',
    "Mark a ticket as waiting on another (it can't start before)"
  );
  dependency('unblock', 'Remove that dependency');

  tickets
    .command('reorder <parent>')
    .description("Put a parent's children in a new order")
    .requiredOption('--order <ids...>', 'Exactly its children, in order')
    .action(async (parent: string, options: { order: string[] }) => {
      const d = deps();
      await d.source.reorder(id(parent), options.order.map(id));

      d.print(`${parent}'s children: ${options.order.join(', ')}.`);
    });

  tickets
    .command('place <ids...>')
    .description('Move tickets to sit right after another in queue order')
    .requiredOption('--after <id>', 'The ticket they follow')
    .action(async (ids: string[], options: { after: string }) => {
      const d = deps();
      await d.source.place(ids.map(id), id(options.after));

      d.print(`${ids.join(', ')} now follow ${options.after}.`);
    });

  registerScenariosCommand(tickets);
};
