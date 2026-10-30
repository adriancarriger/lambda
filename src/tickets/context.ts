import { execFileSync } from 'child_process';
import * as path from 'path';

import { type MachineConfig } from '../config/machineConfig';
import { type Project, type TicketsConfig } from '../config/projectConfig';
import { readKnownAssignees, readRunnerInfo } from '../runner/localFiles';
import { mergeAssignees } from './assignees';
import { createJiraSource } from './jira';
import { createLinearSource } from './linear';
import { createMarkdownSource } from './markdown';
import { type Reporter, type TicketSource } from './source';

type Env = Record<string, string | undefined>;

/** Everything a ticket source needs, so tests can hand in their own. */
export interface SourceContext {
  /** The project root (inside a pod's worktree: the main checkout). */
  root: string;
  config: TicketsConfig;
  /** The machine's tokens: `~/.lambda/config.json` `tokens`. */
  tokens: MachineConfig['tokens'];
  env: Env;
  fetch: typeof fetch;
  /** The person running the command; `create` records them as reporter. */
  runner: Reporter | null;
}

/** Where `pull` writes a Linear or Jira ticket. */
export const pulledDir = (root: string, id: string): string =>
  path.join(root, '.lambda', 'pulled', id);

const gitEmail = (cwd: string): string | undefined => {
  try {
    const email = execFileSync('git', ['config', 'user.email'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return email === '' ? undefined : email;
  } catch {
    return undefined;
  }
};

/** `owner.name`, with `git config user.email` as the email when set. */
export const runnerOf = (
  machine: MachineConfig | null,
  cwd: string
): Reporter | null => {
  const name = machine?.owner?.name?.trim();

  if (name === undefined || name === '') {
    return null;
  }

  const email = gitEmail(cwd);

  return email === undefined ? { name } : { name, email };
};

/** What a read-only project's source refuses: everything that writes. */
export const READ_ONLY_TICKETS =
  "This project's tickets are read-only here (tickets.readOnly in lambda.json): nothing is changed in the tracker.";

const refuse = (): Promise<never> =>
  Promise.reject(new Error(READ_ONLY_TICKETS));

/**
 * The source with every write refused before it reaches the tracker. Pull
 * still writes the ticket's local copy, which changes nothing there.
 */
export const readOnlySource = (source: TicketSource): TicketSource => ({
  ...source,
  readOnly: true,
  push: refuse,
  create: refuse,
  update: refuse,
  attach: refuse,
  comment: refuse,
  delete: refuse,
  block: refuse,
  unblock: refuse,
  reorder: refuse,
  place: refuse,
});

const sourceOf = (context: SourceContext): TicketSource => {
  switch (context.config.source) {
    case 'markdown':
      return createMarkdownSource(context);
    case 'linear':
      return createLinearSource(context);
    case 'jira':
      return createJiraSource(context);
  }
};

export const createTicketSource = (context: SourceContext): TicketSource =>
  context.config.readOnly === true
    ? readOnlySource(sourceOf(context))
    : sourceOf(context);

/**
 * The project's assignees: lambda.json's, then what Lambda says each
 * computer and the owner are in this tracker (this computer first). A
 * markdown project's are the computers by name; it reads ids itself.
 */
export const withKnownAssignees = (
  config: TicketsConfig,
  env: Env = process.env
): TicketsConfig => {
  if (config.source === 'markdown') {
    return config;
  }

  const known = readKnownAssignees(env);
  const merged = mergeAssignees(
    config.assignees,
    known[config.source],
    readRunnerInfo(env)?.name ?? null
  );

  return Object.keys(merged).length === 0
    ? config
    : { ...config, assignees: merged };
};

/** The project's ticket source, from its settings and this machine's. */
export const openTicketSource = (
  project: Project,
  machine: MachineConfig | null,
  env: Env = process.env
): TicketSource =>
  createTicketSource({
    root: project.root,
    config: withKnownAssignees(project.config.tickets, env),
    tokens: machine?.tokens,
    env,
    fetch: globalThis.fetch,
    runner: runnerOf(machine, project.root),
  });
