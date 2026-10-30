import type {
  DesignSystemInfo,
  DesignSystemPage,
  DesignSystemTicket,
  LastChange,
  MadeDesignSystem,
} from '../app/shared/designSystem';
import { type MachineConfig, loadMachineConfig } from '../config/machineConfig';
import {
  type Project,
  loadProjectConfig,
  resolvePodsRoot,
} from '../config/projectConfig';
import {
  type Detected,
  componentsLine,
  detectStack,
  lookLine,
} from '../design/system/detect';
import { defaultBranchRef, gitOk } from '../design/system/git';
import {
  type ReadManifest,
  readManifestOnBranch,
} from '../design/system/manifest';
import {
  HasDesignSystemError,
  createSetupTicket,
  openSetupTicket,
} from '../design/system/setupTicket';
import { openTicketSource } from '../tickets/context';
import type { Ticket, TicketSource } from '../tickets/source';
import { reportedMachineDesign } from './machineDesign';
import { projectName } from './projectsSetup';

/**
 * Settings → Design system, on the runner holding the project. The design
 * system is read from `origin/<default branch>` as last fetched, never the
 * working tree, so every computer shows the same design system. The Look and
 * Components lines are `detectStack`'s, which reads the app in the working
 * tree; it runs once per commit on origin.
 */

export interface DesignSystemDeps {
  /** For tests: the project's ticket source. */
  openSource?: (project: Project) => TicketSource;
  /** For tests: this machine's config. */
  machine?: () => MachineConfig | null;
}

/** Make it, answered: the ticket, or the refusal the app shows as a 409. */
export type MakeAnswer = MadeDesignSystem | { conflict: string };

const projectOf = (folder: string): Project => {
  const project = loadProjectConfig(folder);

  if (project === null) {
    throw new Error(`There's no lambda.json at ${folder}.`);
  }

  return project;
};

/** This machine's config; none when it can't be read, as the runner reports it. */
const machineOf = (deps: DesignSystemDeps): MachineConfig | null => {
  try {
    return (deps.machine ?? loadMachineConfig)();
  } catch {
    return null;
  }
};

const sourceOf = (project: Project, deps: DesignSystemDeps): TicketSource =>
  deps.openSource?.(project) ?? openTicketSource(project, machineOf(deps));

/**
 * Whether Claude Design works here: null when it was never checked, or the
 * config can't be read (`reportedMachineDesign` says why, once).
 */
const designAvailableOf = (deps: DesignSystemDeps): boolean | null => {
  const machine =
    deps.machine === undefined ? reportedMachineDesign() : deps.machine();

  return machine?.design?.available ?? null;
};

/**
 * The link to the ticket that made the design system: from the list, else
 * asked for by id, since a done ticket can drop out of the list once it's
 * archived. Null when the tracker can't say.
 */
const picturesUrlOf = async (
  source: TicketSource,
  syncedBy: string | null,
  tickets: Ticket[]
): Promise<string | null> => {
  if (syncedBy === null) {
    return null;
  }

  const listed = tickets.find((ticket) => ticket.id === syncedBy);

  if (listed !== undefined) {
    return listed.url;
  }

  return source.get(syncedBy).then(
    (ticket) => ticket.url,
    () => null
  );
};

/** A file's posix path, as `git show <ref>:<path>` wants it. */
const posix = (file: string): string => file.split('\\').join('/');

const TICKET_SUBJECT = /^([A-Za-z][A-Za-z0-9]*-\d+):\s*(.*)$/;

/** `<sha>\t<subject>` → the short sha, the ticket id and the rest. */
export const lastChangeOf = (line: string): LastChange | null => {
  const tab = line.indexOf('\t');

  if (tab < 0) {
    return null;
  }

  const sha = line.slice(0, tab).slice(0, 7);
  const subject = line.slice(tab + 1).trim();
  const match = TICKET_SUBJECT.exec(subject);

  if (match === null) {
    return { sha, ticket: subject, rest: '' };
  }

  return { sha, ticket: match[1] ?? subject, rest: match[2] ?? '' };
};

/**
 * The newest commit at `ref` that touched the design system's folder or its
 * manifest; null when that commit is the one that first added the manifest.
 */
const lastChanged = (
  root: string,
  ref: string,
  dir: string,
  manifest: string
): LastChange | null => {
  const newest = gitOk(root, [
    'log',
    '-1',
    '--format=%H%x09%s',
    ref,
    '--',
    dir,
    manifest,
  ]);

  if (newest === undefined || newest === '') {
    return null;
  }

  const added = gitOk(root, [
    'log',
    '--diff-filter=A',
    '--format=%H',
    ref,
    '--',
    manifest,
  ]);
  const first = (added ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .at(-1);

  if (first !== undefined && newest.startsWith(`${first}\t`)) {
    return null;
  }

  return lastChangeOf(newest);
};

/** Just past the `]` that closes a list opened before `from`. */
const closeOf = (text: string, from: number): number =>
  [...text.slice(from)].reduce<{ depth: number; end: number | null }>(
    (found, char, index) => {
      if (found.end !== null) {
        return found;
      }

      const depth = found.depth + (char === '[' ? 1 : char === ']' ? -1 : 0);

      return { depth, end: depth === 0 ? from + index + 1 : null };
    },
    { depth: 1, end: null }
  ).end ?? text.length;

/** The text with each `situations: [...]` list cut out, brackets matched. */
const withoutSituations = (text: string): string => {
  const start = /\bsituations\s*:\s*\[/.exec(text);

  if (start === null) {
    return text;
  }

  const open = start.index + start[0].length;

  return (
    text.slice(0, start.index) +
    withoutSituations(text.slice(closeOf(text, open)))
  );
};

/**
 * The screens' `title:` values in `<dir>/screens/index.ts` at the ref, read,
 * never run; their situations' titles aren't screens.
 */
const screenTitles = (root: string, ref: string, dir: string): string[] => {
  const text = gitOk(root, ['show', `${ref}:${posix(dir)}/screens/index.ts`]);

  if (text === undefined) {
    return [];
  }

  return [
    ...withoutSituations(text).matchAll(
      /\btitle\s*:\s*(['"`])((?:(?!\1).)*)\1/g
    ),
  ].map((match) => match[2] ?? '');
};

const existsAt = (root: string, ref: string, file: string): boolean =>
  gitOk(root, ['cat-file', '-e', `${ref}:${posix(file)}`]) !== undefined;

const ticketOf = (ticket: Ticket): DesignSystemTicket => ({
  id: ticket.id,
  title: ticket.title,
  url: ticket.url,
  status: ticket.status,
  blockReason: ticket.blockReason,
});

const systemOf = ({
  read,
  root,
  ref,
  dir,
  manifest,
  picturesUrl,
}: {
  read: ReadManifest;
  root: string;
  ref: string;
  dir: string;
  manifest: string;
  picturesUrl: string | null;
}): DesignSystemInfo => {
  const fields = read.manifest;
  const syncedBy = fields.syncedBy ?? null;
  const screens =
    fields.screens !== undefined && fields.screens.length > 0
      ? fields.screens
      : screenTitles(root, ref, dir);

  return {
    version: fields.version ?? null,
    madeByHand: read.madeByHand,
    syncedBy,
    builtFrom: read.builtFrom ?? null,
    source: fields.source ?? null,
    check: fields.check ?? null,
    components: fields.components ?? [],
    patterns: fields.patterns ?? [],
    screens,
    sampleData: existsAt(root, ref, `${dir}/sampleData.ts`),
    lastChanged: lastChanged(root, ref, dir, manifest),
    picturesUrl,
  };
};

/** `detectStack`'s answers by checkout and origin commit, the newest last. */
const detected = new Map<string, Detected>();
const DETECTED_KEPT = 8;

/** `detectStack`, once per (checkout, commit on origin): it walks the app. */
const detectAt = (project: Project, ref: string): Detected => {
  const { root, config } = project;
  const key = `${root}\0${gitOk(root, ['rev-parse', ref]) ?? ref}`;
  const kept = detected.get(key);

  if (kept !== undefined) {
    return kept;
  }

  const fresh = detectStack(root, config, {
    ref,
    podsRoot: resolvePodsRoot(project),
  });
  detected.set(key, fresh);

  for (const old of [...detected.keys()].slice(0, -DETECTED_KEPT)) {
    detected.delete(old);
  }

  return fresh;
};

/** The page's state, read from the default branch as last fetched. */
export const readDesignSystemPage = async (
  folder: string,
  deps: DesignSystemDeps = {}
): Promise<DesignSystemPage> => {
  const project = projectOf(folder);
  const { root, config } = project;
  const { dir, manifest } = config.design.system;
  const ref = defaultBranchRef(root);
  const read = readManifestOnBranch(root, ref, manifest);
  const source = sourceOf(project, deps);
  const listed = await source.list().then(
    (tickets) => ({ tickets, error: null }),
    (error: unknown) => {
      // With no design system, the open setup ticket decides Make it.
      if (read === null) {
        throw error;
      }

      return {
        tickets: [],
        error: `Couldn't read the codebase's tickets: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  );
  const { tickets } = listed;
  const open = openSetupTicket(tickets);
  const stack = detectAt(project, ref);

  return {
    project: projectName(project),
    branch: ref.replace(/^origin\//, ''),
    dir,
    look: lookLine(stack),
    components: componentsLine(stack),
    designAvailable: designAvailableOf(deps),
    setupTicket: open === undefined ? null : ticketOf(open),
    system:
      read === null
        ? null
        : systemOf({
            read,
            root,
            ref,
            dir,
            manifest,
            picturesUrl: await picturesUrlOf(
              source,
              read.manifest.syncedBy ?? null,
              tickets
            ),
          }),
    ticketsError: listed.error,
  };
};

/**
 * Make it: the setup ticket, created in Ready, or the open one. A design
 * system already on the default branch is answered as a conflict, with
 * nothing created.
 */
export const makeDesignSystem = async (
  folder: string,
  by: string,
  deps: DesignSystemDeps = {}
): Promise<MakeAnswer> => {
  const project = projectOf(folder);

  try {
    const made = await createSetupTicket({
      project,
      projectName: projectName(project),
      by,
      source: sourceOf(project, deps),
    });

    return {
      id: made.id,
      title: made.title,
      url: made.url,
      existing: made.existing,
    };
  } catch (error) {
    if (error instanceof HasDesignSystemError) {
      return { conflict: error.message };
    }

    throw error;
  }
};
