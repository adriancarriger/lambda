import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { type DesignSeverity } from '../loop';
import { MANIFEST_NAMESPACE } from './namespace';

/**
 * The committed manifest of a project's design system (`<dir>/
 * design-system.json` unless `design.system.manifest` names another file).
 * "Has a design system" means this file exists at the ref being read, and
 * everything that asks reads it at a ref (`git show <ref>:<path>`), never
 * from the working tree.
 *
 * Lambda writes no time into it, so the file is the same on every computer.
 * Fields Lambda doesn't know are kept, in their places, on every write: a
 * hand-made manifest (a `url`, `publishedSha`, `createdAt` and `files` list)
 * stays as it was apart from what a write sets.
 */

const SHA = /^[0-9a-f]{7,40}$/;

const SEVERITIES: [DesignSeverity, ...DesignSeverity[]] = [
  'high',
  'medium',
  'medium-low',
  'low',
];

export const MANIFEST_SOURCES = ['code', 'photos', 'code+photos'] as const;
export type ManifestSource = (typeof MANIFEST_SOURCES)[number];

export const CHECK_RESULTS = ['match', 'close', 'not-checked'] as const;

const CheckSchema = z.object({
  result: z.enum(CHECK_RESULTS),
  rounds: z.number().int().min(0),
  photos: z.number().int().min(0),
  issues: z.array(
    z.object({
      severity: z.enum(SEVERITIES),
      where: z.string(),
      what: z.string(),
    })
  ),
  reason: z.string().optional(),
});

export type ManifestCheck = z.infer<typeof CheckSchema>;

export const ManifestSchema = z
  .object({
    namespace: z
      .string()
      .regex(MANIFEST_NAMESPACE, `must match ${MANIFEST_NAMESPACE}`),
    version: z.number().int().min(1).optional(),
    builtFrom: z
      .string()
      .regex(SHA, 'must be a 7- to 40-character hex sha')
      .optional(),
    /** A hand-made manifest's stand-in for `builtFrom`. */
    publishedSha: z
      .string()
      .regex(SHA, 'must be a 7- to 40-character hex sha')
      .optional(),
    syncedBy: z.string().min(1).optional(),
    source: z.enum(MANIFEST_SOURCES).optional(),
    check: CheckSchema.optional(),
    components: z.array(z.string()).optional(),
    patterns: z.array(z.string()).optional(),
    screens: z.array(z.string()).optional(),
    leftOut: z
      .array(z.object({ name: z.string(), why: z.string() }))
      .optional(),
  })
  .passthrough();

export type Manifest = z.infer<typeof ManifestSchema>;

/** A manifest as read: its fields, and the raw object whose order a write keeps. */
export interface ReadManifest {
  manifest: Manifest;
  raw: Record<string, unknown>;
  /** `builtFrom`, else a hand-made manifest's `publishedSha`. */
  builtFrom: string | undefined;
  /** No `version`: the design system was made by hand, not by Lambda. */
  madeByHand: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `JSON.parse`, throwing "<from> is not valid JSON: <why>" on bad text. */
export const parseJsonText = (text: string, from: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${from} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

/** Parse a manifest's text; throws naming the field on anything wrong. */
export const parseManifest = (text: string, from: string): ReadManifest => {
  const raw = parseJsonText(text, from);

  if (!isRecord(raw)) {
    throw new Error(`${from} must be a JSON object.`);
  }

  const parsed = ManifestSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${from}: ${issue.path.join('.')} ${issue.message}`)
        .join('\n')
    );
  }

  return {
    manifest: parsed.data,
    raw,
    builtFrom: parsed.data.builtFrom ?? parsed.data.publishedSha,
    madeByHand: parsed.data.version === undefined,
  };
};

/** The manifest in the working tree, or null when there is none. */
export const readManifestFile = (file: string): ReadManifest | null =>
  fs.existsSync(file)
    ? parseManifest(fs.readFileSync(file, 'utf8'), file)
    : null;

/** Whether `ref` names a commit in the repo holding `root`. */
export const isCommit = (root: string, ref: string): boolean => {
  try {
    execFileSync(
      'git',
      [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${ref}^{commit}`,
      ],
      { cwd: root, stdio: 'ignore' }
    );

    return true;
  } catch {
    return false;
  }
};

/**
 * `<ref>:<file>`, or null when the ref is a commit without that path. A ref
 * that isn't a commit (a typo, not fetched, not a repo) throws: it must
 * never read as "no design system".
 */
const showAt = (root: string, ref: string, file: string): string | null => {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    if (isCommit(root, ref)) {
      return null;
    }

    throw new Error(
      `Couldn't read ${file} at ${ref}: ${ref} is not a commit in ${root}.`,
      { cause: error }
    );
  }
};

/**
 * The manifest as committed at `ref` (a sha, `main`, `origin/main`), or null
 * when the ref has none. `manifestPath` is relative to `root`, the project
 * root, which may be a subfolder of its repo.
 */
export const readManifestAt = (
  root: string,
  ref: string,
  manifestPath: string
): ReadManifest | null => {
  // `./` reads it relative to `root`, not the repo's top.
  const text = showAt(root, ref, `./${manifestPath.split(path.sep).join('/')}`);

  return text === null ? null : parseManifest(text, `${ref}:${manifestPath}`);
};

/**
 * The manifest on the default branch `ref` (`defaultBranchRef`). A folder
 * with nothing committed yet (no repo, no first commit) reads `HEAD` and has
 * no committed design system; any other ref must be a commit.
 */
export const readManifestOnBranch = (
  root: string,
  ref: string,
  manifestPath: string
): ReadManifest | null =>
  ref === 'HEAD' && !isCommit(root, ref)
    ? null
    : readManifestAt(root, ref, manifestPath);

/**
 * Merge `fields` into a manifest's raw object: known keys keep their place,
 * new ones go at the end, and every other field stays as it was.
 */
export const mergeManifest = (
  raw: Record<string, unknown>,
  fields: Partial<Manifest>
): Record<string, unknown> => {
  const defined = Object.entries(fields).filter(
    ([, value]) => value !== undefined
  );
  const kept = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => {
      const update = defined.find(([name]) => name === key);

      return [key, update === undefined ? value : update[1]];
    })
  );

  return {
    ...kept,
    ...Object.fromEntries(defined.filter(([key]) => !(key in raw))),
  };
};

export const manifestText = (raw: Record<string, unknown>): string =>
  `${JSON.stringify(raw, null, 2)}\n`;
