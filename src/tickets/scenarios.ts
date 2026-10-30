/**
 * `lambda tickets scenarios push|pull`: screenshot scenarios travel on the
 * ticket that builds the change, on every ticket source.
 *
 *   push <id> <files…>  attach each `<id>.scenario.<ext>` and link it in the
 *                       description's `## Design` (under `### Screenshot
 *                       scenarios`), or a `## Screenshot scenarios` section
 *   pull <id>           download every linked scenario into the checkout's
 *                       `<design.pendingDir>/<id>/` (never committed); the
 *                       ticket's ship moves them into the tracked library
 *
 * A pulled scenario is a file the photo hook may run, so it is taken only
 * from the source's own file host (Linear: https on exactly
 * uploads.linear.app; Jira: the `tickets.site` host; markdown: the ticket's
 * own `./<id>/<file>`), only under a scenario file name, and only into that
 * ticket's pending folder. Anything else is skipped and named, never fetched.
 */
import { type Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { type MachineConfig, loadMachineConfig } from '../config/machineConfig';
import { type Project, loadProjectConfig } from '../config/projectConfig';
import { ensurePendingDir, trackedDirOf } from '../shot/pending';
import { SCENARIO_FILE_NAME, scenarioFileParts } from '../shot/scenario';
import { checkoutRootOf } from '../shot/shoot';
import { openTicketSource, pulledDir } from './context';
import { DEFAULT_DIR } from './markdown';
import {
  type TicketSource,
  assertTicketId,
  resolveJiraCredentials,
  resolveLinearKey,
} from './source';

type Env = Record<string, string | undefined>;

const SCENARIO_LINE = /^scenario: \[([^\]\n]*)\]\(([^)\s]*)\)\s*$/;
// `## Design reference (…)` is not it, nor is a `## Design` quoted inside a
// fenced code block (a UX sketch showing what the section looks like).
const DESIGN_HEADING = /^## Design\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SUBHEADING = '### Screenshot scenarios';
const SECTION = '## Screenshot scenarios';

const LINEAR_UPLOADS_HOST = 'uploads.linear.app';

/** A pick-up waits on this; a host that never answers mustn't stall it. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** A scenario is a few kilobytes of text; anything far bigger isn't one. */
const MAX_SCENARIO_BYTES = 1024 * 1024;

export interface ScenarioLink {
  file: string;
  ref: string;
}

export interface ScenariosDeps {
  project: Project;
  source: TicketSource;
  /** The checkout the pending folder is in (a pod's worktree, say). */
  checkout: string;
  /** Fetches a link that passed the host rules (with the source's key). */
  download: (url: string) => Promise<Buffer>;
  print: (line: string) => void;
  printError: (line: string) => void;
}

// ── the description ─────────────────────────────────────────────────────────

const scenarioLine = ({ file, ref }: ScenarioLink): string =>
  `scenario: [${file}](${ref})`;

/** First index at or after `from` whose line matches, else `lines.length`. */
const indexFrom = (
  lines: string[],
  from: number,
  stop: (line: string) => boolean
): number => {
  const found = lines.slice(from).findIndex(stop);

  return found === -1 ? lines.length : from + found;
};

/** Back off the blank lines that end `[start, end)`. */
const contentEnd = (lines: string[], start: number, end: number): number =>
  end > start && (lines[end - 1] ?? '').trim() === ''
    ? contentEnd(lines, start, end - 1)
    : end;

/** Put `added` at the end of the block that starts at `start`. */
const appendToBlock = (
  lines: string[],
  start: number,
  stop: (line: string) => boolean,
  added: string[]
): string[] => {
  const next = indexFrom(lines, start + 1, stop);
  const rest = lines.slice(next);

  return [
    ...lines.slice(0, contentEnd(lines, start, next)),
    ...added,
    ...(rest.length > 0 ? [''] : []),
    ...rest,
  ];
};

/** Whether each line sits inside a fenced code block (fence lines included). */
const fencedLines = (lines: string[]): boolean[] =>
  lines.reduce<{ open: string | null; fenced: boolean[] }>(
    ({ open, fenced }, line) => {
      const marker = FENCE.exec(line)?.[1];

      if (open === null) {
        return {
          open: marker ?? null,
          fenced: [...fenced, marker !== undefined],
        };
      }

      const closes =
        marker !== undefined &&
        marker[0] === open[0] &&
        marker.length >= open.length &&
        line.trim() === marker;

      return { open: closes ? null : open, fenced: [...fenced, true] };
    },
    { open: null, fenced: [] }
  ).fenced;

/** Index of the `## Design` heading line outside any fence, else -1. */
const designHeadingIndex = (lines: string[]): number => {
  const fenced = fencedLines(lines);

  return lines.findIndex(
    (line, index) => !fenced[index] && DESIGN_HEADING.test(line)
  );
};

const isH2 = (line: string): boolean => line.startsWith('## ');
const isH2OrH3 = (line: string): boolean => /^#{2,3} /.test(line);

/**
 * Link each scenario in a description: an already-linked file's line is
 * replaced where it is; the rest go at the end of `### Screenshot scenarios`
 * in `## Design` (made after its last picture block when absent), or of a
 * `## Screenshot scenarios` section when there is no `## Design`.
 */
export const upsertScenarioLines = (
  description: string,
  links: ScenarioLink[]
): string => {
  // Trimmed, as `scenarioLinks` reads them.
  const replaced = description.split('\n').map((line) => {
    const file = SCENARIO_LINE.exec(line.trim())?.[1];
    const link = links.find((candidate) => candidate.file === file);

    return link === undefined ? line : scenarioLine(link);
  });
  const linked = new Set(
    replaced.flatMap((line) => SCENARIO_LINE.exec(line.trim())?.[1] ?? [])
  );
  const added = links.filter(({ file }) => !linked.has(file)).map(scenarioLine);

  if (added.length === 0) {
    return replaced.join('\n');
  }

  const lines = replaced.slice(0, contentEnd(replaced, 0, replaced.length));
  const design = designHeadingIndex(lines);
  const section = lines.findIndex((line) => line.trim() === SECTION);
  const sub =
    design === -1
      ? -1
      : lines
          .slice(design, indexFrom(lines, design + 1, isH2))
          .findIndex((line) => line.trim() === SUBHEADING);

  const placed = (() => {
    if (design !== -1 && sub !== -1) {
      return appendToBlock(lines, design + sub, isH2OrH3, added);
    }

    if (design !== -1) {
      return appendToBlock(lines, design, isH2, ['', SUBHEADING, '', ...added]);
    }

    if (section !== -1) {
      return appendToBlock(lines, section, isH2, added);
    }

    return [...lines, ...(lines.length > 0 ? [''] : []), SECTION, '', ...added];
  })();

  return `${placed.join('\n')}\n`;
};

/** Every `scenario:` link in a description. */
export const scenarioLinks = (description: string): ScenarioLink[] =>
  description.split('\n').flatMap((line) => {
    const match = SCENARIO_LINE.exec(line.trim());

    return match === null
      ? []
      : [{ file: match[1] ?? '', ref: match[2] ?? '' }];
  });

/**
 * The file a source's `pull` leaves to edit: markdown's ticket file (a path
 * from the project root), else `description.md` in the pulled folder.
 */
const descriptionFileOf = (project: Project, pulled: string): string => {
  const resolved = path.resolve(project.root, pulled);

  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? path.join(resolved, 'description.md')
    : resolved;
};

// ── push ────────────────────────────────────────────────────────────────────

/**
 * Attach each file and link it on the ticket. Refuses (exit 1, nothing
 * attached) a missing or badly named file.
 */
export const runScenariosPush = async (
  rawId: string,
  files: string[],
  deps: ScenariosDeps
): Promise<number> => {
  const id = assertTicketId(rawId);
  const refused = files.filter(
    (file) =>
      !SCENARIO_FILE_NAME.test(path.basename(file)) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
  );

  if (files.length === 0 || refused.length > 0) {
    deps.printError(
      files.length === 0
        ? 'Usage: lambda tickets scenarios push <id> <files…>'
        : `Refused, nothing attached (missing, or not named <id>.scenario.<ext>): ${refused.join(
            ', '
          )}`
    );

    return 1;
  }

  // A pull rewrites the pulled description, so edits not pushed yet would
  // be lost: refuse before anything is attached, and put them back.
  const earlier =
    deps.source.kind === 'markdown'
      ? null
      : path.join(pulledDir(deps.project.root, id), 'description.md');
  const edited =
    earlier !== null && fs.existsSync(earlier)
      ? fs.readFileSync(earlier, 'utf8')
      : null;
  const editable = descriptionFileOf(deps.project, await deps.source.pull(id));

  if (edited !== null && edited !== fs.readFileSync(editable, 'utf8')) {
    fs.writeFileSync(editable, edited);
    deps.printError(
      `Refused, nothing attached: ${editable} has edits not pushed (or ${id} changed since it was pulled). Push them with lambda tickets push ${id}, or pull again, then retry.`
    );

    return 1;
  }

  // One at a time, so a failure leaves a clear record of what went.
  const links = await files.reduce<Promise<ScenarioLink[]>>(
    async (previous, file) => {
      const done = await previous;
      const { ref } = await deps.source.attach(id, path.resolve(file));
      deps.print(`  Attached: ${path.basename(file)}`);

      return [...done, { file: path.basename(file), ref }];
    },
    Promise.resolve([])
  );

  fs.writeFileSync(
    editable,
    upsertScenarioLines(fs.readFileSync(editable, 'utf8'), links)
  );
  const { push } = deps.source;
  await push(id);

  deps.print(
    `✓ Linked ${links.length} screenshot scenario${
      links.length === 1 ? '' : 's'
    } on ${id}`
  );

  return 0;
};

// ── pull ────────────────────────────────────────────────────────────────────

const parsedUrl = (ref: string): URL | null => {
  try {
    return new URL(ref);
  } catch {
    return null;
  }
};

const ticketsDirOf = (project: Project): string =>
  path.resolve(project.root, project.config.tickets.dir ?? DEFAULT_DIR);

/** Inside `dir` by realpath, and a file. */
const fileInside = (dir: string, file: string): boolean => {
  if (!fs.existsSync(dir) || !fs.existsSync(file)) {
    return false;
  }

  const away = path.relative(fs.realpathSync(dir), fs.realpathSync(file));

  return (
    away !== '' &&
    !away.startsWith('..') &&
    !path.isAbsolute(away) &&
    fs.statSync(file).isFile()
  );
};

type Fetch = { kind: 'download'; url: string } | { kind: 'copy'; file: string };

/** How a link is taken from this source, or why it isn't. */
const takeFrom = (
  deps: ScenariosDeps,
  id: string,
  link: ScenarioLink
): Fetch | { kind: 'skip'; why: string } => {
  const { source, project } = deps;

  if (source.kind === 'markdown') {
    const own = `./${id}/${link.file}`;
    const file = path.join(ticketsDirOf(project), id, link.file);

    if (link.ref !== own) {
      return { kind: 'skip', why: `not this ticket's own ${own}` };
    }

    return fileInside(ticketsDirOf(project), file)
      ? { kind: 'copy', file }
      : { kind: 'skip', why: `no file at ${file}` };
  }

  const why = offHostReason(source.kind, project, link.ref);

  return why === null
    ? { kind: 'download', url: link.ref }
    : { kind: 'skip', why };
};

/**
 * Why `ref` isn't on the source's own https file host (Linear: exactly
 * uploads.linear.app; Jira: the `tickets.site` host), or null when it is.
 */
const offHostReason = (
  kind: 'linear' | 'jira',
  project: Project,
  ref: string
): string | null => {
  const url = parsedUrl(ref);

  if (kind === 'linear') {
    return url !== null &&
      url.protocol === 'https:' &&
      url.host === LINEAR_UPLOADS_HOST
      ? null
      : `not a file on ${LINEAR_UPLOADS_HOST}`;
  }

  const site = parsedUrl(project.config.tickets.site ?? '');

  return url !== null &&
    site !== null &&
    url.protocol === 'https:' &&
    url.host === site.host
    ? null
    : `not a file on ${site?.host ?? 'the Jira site (tickets.site)'}`;
};

/**
 * Download every `scenario:` link on the ticket into
 * `<design.pendingDir>/<id>/`. Throws only when the ticket can't be read or
 * a download fails.
 */
export const runScenariosPull = async (
  rawId: string,
  deps: ScenariosDeps
): Promise<void> => {
  const id = assertTicketId(rawId);
  const { description } = await deps.source.get(id);
  const links = scenarioLinks(description);

  if (links.length === 0) {
    deps.print(`No screenshot scenarios on ${id}`);

    return;
  }

  const tracked = trackedDirOf(deps.project, deps.checkout);

  await links.reduce(async (previous, link) => {
    await previous;

    if (!SCENARIO_FILE_NAME.test(link.file)) {
      deps.print(
        `Skipped ${link.file} (${link.ref}): not a scenario file name`
      );

      return;
    }

    const { scenarioExt } = deps.project.config.design;

    if (scenarioFileParts(link.file)?.ext !== scenarioExt) {
      deps.print(
        `Skipped ${link.file} (${link.ref}): not a .${scenarioExt} scenario (design.scenarioExt)`
      );

      return;
    }

    const how = takeFrom(deps, id, link);

    if (how.kind === 'skip') {
      deps.print(`Skipped ${link.file} (${link.ref}): ${how.why}`);

      return;
    }

    if (fs.existsSync(path.join(tracked, link.file))) {
      deps.print(`Skipped ${link.file}: already in the tracked library`);

      return;
    }

    const bytes =
      how.kind === 'copy'
        ? fs.readFileSync(how.file)
        : await deps.download(how.url);
    const dir = ensurePendingDir(deps.project, deps.checkout, id);
    fs.writeFileSync(path.join(dir, link.file), bytes);
    deps.print(`  Downloaded: ${link.file}`);
  }, Promise.resolve());
};

// ── downloads with the source's key ─────────────────────────────────────────

/**
 * A download for links that passed `takeFrom`: Linear's key or Jira's
 * credentials go along, and only to the host each was checked against.
 */
export const sourceDownload =
  (
    project: Project,
    machine: MachineConfig | null,
    env: Env = process.env,
    doFetch: typeof fetch = globalThis.fetch,
    timeoutMs = DOWNLOAD_TIMEOUT_MS
  ) =>
  async (url: string): Promise<Buffer> => {
    const kind = project.config.tickets.source;
    const offHost =
      kind === 'markdown' ? null : offHostReason(kind, project, url);

    if (offHost !== null) {
      throw new Error(`Refusing to download ${url}: ${offHost}.`);
    }

    const headers: Record<string, string> =
      kind === 'linear'
        ? { Authorization: resolveLinearKey(machine?.tokens, env) }
        : kind === 'jira'
        ? (() => {
            const { email, apiToken } = resolveJiraCredentials(
              machine?.tokens,
              env
            );

            return {
              Authorization: `Basic ${Buffer.from(
                `${email}:${apiToken}`
              ).toString('base64')}`,
            };
          })()
        : {};
    // A redirect would carry the key to wherever it points. Jira's attachment
    // content answers with one unless asked not to.
    const target = new URL(url);

    if (kind === 'jira') {
      target.searchParams.set('redirect', 'false');
    }

    const response = await doFetch(target.href, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Couldn't download ${url} (${response.status}).`);
    }

    const tooBig = new Error(
      `Couldn't download ${url}: bigger than ${MAX_SCENARIO_BYTES} bytes, which no scenario is.`
    );

    if (Number(response.headers.get('content-length')) > MAX_SCENARIO_BYTES) {
      throw tooBig;
    }

    const bytes = Buffer.from(await response.arrayBuffer());

    if (bytes.length > MAX_SCENARIO_BYTES) {
      throw tooBig;
    }

    return bytes;
  };

/** The deps for a project, from its settings and this machine's. */
export const scenariosDepsFor = (
  project: Project,
  checkout: string,
  options: {
    source?: TicketSource;
    machine?: MachineConfig | null;
    env?: Env;
    print?: (line: string) => void;
    printError?: (line: string) => void;
  } = {}
): ScenariosDeps => {
  const machine =
    options.machine === undefined ? loadMachineConfig() : options.machine;
  const env = options.env ?? process.env;

  return {
    project,
    source: options.source ?? openTicketSource(project, machine, env),
    checkout,
    download: sourceDownload(project, machine, env),
    print: options.print ?? ((line) => console.log(line)),
    printError: options.printError ?? ((line) => console.error(line)),
  };
};

const loadDeps = (): ScenariosDeps => {
  const project = loadProjectConfig(process.cwd());

  if (project === null) {
    throw new Error('No codebase here: run lambda init first.');
  }

  return scenariosDepsFor(project, checkoutRootOf(process.cwd(), project.root));
};

/** `lambda tickets scenarios push|pull`, under `lambda tickets`. */
export const registerScenariosCommand = (
  tickets: Command,
  deps: () => ScenariosDeps = loadDeps
): void => {
  const scenarios = tickets
    .command('scenarios')
    .description('Screenshot scenarios that travel on a ticket');

  scenarios
    .command('push <id> <files...>')
    .description('Attach scenario files and link them in the description')
    .action(async (ticketId: string, files: string[]) => {
      process.exitCode = await runScenariosPush(ticketId.trim(), files, deps());
    });

  scenarios
    .command('pull <id>')
    .description(
      "Download a ticket's scenarios into the pending folder (design.pendingDir)"
    )
    .action(async (ticketId: string) => {
      await runScenariosPull(ticketId.trim(), deps());
    });
};
