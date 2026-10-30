import { type Project } from '../config/projectConfig';
import { buildFromRef } from '../design/system/cache';
import { defaultBranchRef, gitOk } from '../design/system/git';
import { installSystem } from '../design/system/install';
import { readManifestAt } from '../design/system/manifest';
import { openSetupTicket } from '../design/system/setupTicket';
import { type Ticket } from '../tickets/source';

/**
 * `lambda design system prepare <canvas-dir>`: step 0 of a planning design.
 * Designs always mount the design system as committed at the pod's base
 * (main as the pod was made from it), built on this computer in the
 * runner's build checkout — never in the pod's worktree, which has no
 * packages installed — and shared by every pod on the same base through the
 * cache. A setup ticket that hasn't shipped isn't used.
 *
 * Nothing here stops the ux phase: with no design system, or one that won't
 * build, nothing is installed and the design uses Claude Design's own look.
 * `summary` is the line for the CP4 summary, when there is one.
 */

export const NO_SYSTEM_LINE =
  "No design system: designs use Claude Design's default look.";

export const ticketsUnreadLine = (reason: string): string =>
  `No design system on main: designs use Claude Design's default look (couldn't read the tickets: ${reason.replace(
    /\.+$/,
    ''
  )}).`;

export const makingLine = (ticketId: string): string =>
  `${ticketId} is making the design system; these designs use Claude Design's default look.`;

export const couldNotBuildLine = (reason: string): string =>
  `The design system on main couldn't be built: ${reason.replace(/\.+$/, '')}.`;

export interface PrepareResult {
  /** The canvas folder it was installed into, or null. */
  installed: string | null;
  /** The built folder used. */
  builtDir: string | null;
  summary: string | null;
}

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/** The pod's base: where its worktree forked from origin's default branch. */
export const podBaseSha = (worktree: string, project: Project): string => {
  const ref = defaultBranchRef(project.root);
  const base = gitOk(worktree, ['merge-base', 'HEAD', ref]);

  if (base === undefined) {
    throw new Error(
      `Can't tell this pod's base: HEAD shares no commit with ${ref}. Pass --base <sha>.`
    );
  }

  return base;
};

/**
 * Never throws: whatever goes wrong — the base can't be told, the manifest
 * at it is invalid, the build fails — the design goes on in Claude Design's
 * own look and `summary` says why.
 */
export const prepareDesignSystem = async ({
  project,
  projectName,
  base,
  worktree,
  canvasDir,
  listTickets,
  build = buildFromRef,
}: {
  project: Project;
  projectName: string;
  /** The pod's base sha; absent, it is read from `worktree`. */
  base?: string;
  /** The pod's working folder, where its base is read from. */
  worktree: string;
  canvasDir: string;
  listTickets: () => Promise<Ticket[]>;
  build?: typeof buildFromRef;
}): Promise<PrepareResult> => {
  const nothing = (summary: string | null): PrepareResult => ({
    installed: null,
    builtDir: null,
    summary,
  });

  try {
    const at = base ?? podBaseSha(worktree, project);
    const atBase = readManifestAt(
      project.root,
      at,
      project.config.design.system.manifest
    );

    if (atBase === null) {
      const open = await listTickets()
        .then(openSetupTicket)
        .catch((error: unknown) => ticketsUnreadLine(firstLine(error)));

      if (typeof open === 'string') {
        return nothing(open);
      }

      return nothing(open === undefined ? NO_SYSTEM_LINE : makingLine(open.id));
    }

    const { folder } = await build({ project, projectName, ref: at });
    installSystem({
      builtDir: folder,
      canvasDir,
      namespace: atBase.manifest.namespace,
    });

    return { installed: canvasDir, builtDir: folder, summary: null };
  } catch (error) {
    return nothing(couldNotBuildLine(firstLine(error)));
  }
};
