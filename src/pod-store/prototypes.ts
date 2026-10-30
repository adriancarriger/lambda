import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

/**
 * A Claude Design prototype, kept in the pod so the inbox can let the owner try
 * it without claude.ai (a saved snapshot of each version). Each publish is its own version,
 * never edited after:
 *
 *   <pod>/designs/<slug>/prototype/v<n>/
 *     prototype.json   this manifest
 *     files/…          the canvas's project/, with the runtime's support.js
 *                      beside every artboard — what the inbox serves
 *     stills/<L>/…     one picture per situation of board L (or a poster)
 *
 * A message shows version n as a card with the line `[Prototype: <slug> v<n>]`
 * on its own (src/app/shared/prototypes.ts reads it).
 */

export const PROTOTYPE_SLUG = /^[a-z0-9-]+$/;

export const PrototypeBoardSchema = z.object({
  /** The artboard's file, relative to `files/` ("Desk.dc.html"). */
  file: z.string(),
  /** "C": the board's letter, from its title or its place on the canvas. */
  letter: z.string(),
  /** "Your desk": the title without its letter. */
  title: z.string(),
  w: z.number(),
  h: z.number(),
  /**
   * Situation slug → its picture, pod-relative. `poster` when no situation
   * was photographed: the board as it opens.
   */
  stills: z.record(z.string()),
});

export type PrototypeBoard = z.infer<typeof PrototypeBoardSchema>;

export const PrototypeManifestSchema = z.object({
  slug: z.string().regex(PROTOTYPE_SLUG),
  version: z.number().int().positive(),
  title: z.string(),
  /** The canvas on claude.ai, for "Open in Claude Design". */
  url: z.string().optional(),
  createdAt: z.string(),
  /** What the design changes (the brief's `changes`). */
  changes: z.string().optional(),
  /** What this version changed from the one before (`--note`). */
  note: z.string().optional(),
  /** The project's content hash: an unchanged project makes no new version. */
  hash: z.string(),
  situations: z.array(z.object({ slug: z.string(), title: z.string() })),
  boards: z.array(PrototypeBoardSchema).min(1),
});

export type PrototypeManifest = z.infer<typeof PrototypeManifestSchema>;

/** Every version of one prototype, newest first. */
export interface PrototypeGroup {
  slug: string;
  versions: PrototypeManifest[];
}

export const prototypeRoot = (podDir: string, slug: string): string =>
  path.join(podDir, 'designs', slug, 'prototype');

export const prototypeVersionDir = (
  podDir: string,
  slug: string,
  version: number
): string => path.join(prototypeRoot(podDir, slug), `v${version}`);

/** The versions saved under one prototype folder, newest first (bad ones skipped). */
export const readPrototypeVersions = (root: string): PrototypeManifest[] =>
  !fs.existsSync(root)
    ? []
    : fs
        .readdirSync(root)
        .filter((name) => /^v\d+$/.test(name))
        .flatMap((name) => {
          try {
            const parsed = PrototypeManifestSchema.safeParse(
              JSON.parse(
                fs.readFileSync(path.join(root, name, 'prototype.json'), 'utf8')
              )
            );

            return parsed.success && `v${parsed.data.version}` === name
              ? [parsed.data]
              : [];
          } catch {
            return [];
          }
        })
        .sort((a, b) => b.version - a.version);

/** Every prototype in a pod, the most recently saved first. */
export const listPrototypes = (podDir: string): PrototypeGroup[] => {
  const designs = path.join(podDir, 'designs');

  return !fs.existsSync(designs)
    ? []
    : fs
        .readdirSync(designs)
        .filter((slug) => PROTOTYPE_SLUG.test(slug))
        .map((slug) => ({
          slug,
          versions: readPrototypeVersions(prototypeRoot(podDir, slug)),
        }))
        .filter((group) => group.versions.length > 0)
        .sort((a, b) =>
          (b.versions[0]?.createdAt ?? '').localeCompare(
            a.versions[0]?.createdAt ?? ''
          )
        );
};
