import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  type PrototypeBoard,
  type PrototypeManifest,
  PrototypeManifestSchema,
  prototypeRoot,
  readPrototypeVersions,
} from '../pod-store/prototypes';
import { briefSituations } from './loop';
import {
  copyArtboardRuntime,
  readCanvasJson,
  readDesignJson,
  renderArtboard,
  requireRuntime,
} from './render';
import { ARTBOARD_RUNTIME, runtimeReleaseDir } from './runtime';
import { assertScreenDir } from './screenDir';

/**
 * `lambda design snapshot <canvas-dir> <screen-dir>` — keep the prototype in
 * the pod, so Lambda's inbox can let the owner try it (no claude.ai: its pages
 * can't be framed and need a login). Run after each publish, once the stills
 * are photographed. Each run that finds the project changed saves the next
 * version, `<screen-dir>/prototype/v<n>/` (layout: pod-store/prototypes.ts);
 * an unchanged project keeps the newest version.
 *
 * It prints the line that shows version n as a card in the chat:
 * `[Prototype: <slug> v<n>]` (the app's shared/prototypes.ts reads it).
 */

export const prototypeLine = (slug: string, version: number): string =>
  `[Prototype: ${slug} v${version}]`;

const LETTERED = /^([A-Z])\s*[·\-–—:]\s*(.+)$/;

/** "C · Your desk" → C, "Your desk"; untitled → its place on the canvas. */
export const boardName = (
  title: string | undefined,
  file: string,
  index: number
): { letter: string; title: string } => {
  const match = LETTERED.exec(title ?? '');
  const letter = String.fromCharCode(65 + index);

  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { letter: match[1], title: match[2].trim() };
  }

  return {
    letter,
    title: title ?? file.replace(/\.dc\.html$/, ''),
  };
};

/** Every file under `dir`, relative and sorted (for the content hash). */
const filesUnder = (dir: string, prefix = ''): string[] =>
  fs
    .readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = path.join(prefix, entry.name);

      return entry.isDirectory() ? filesUnder(dir, rel) : [rel];
    })
    .sort();

export const projectHash = (projectDir: string): string =>
  filesUnder(projectDir)
    .reduce(
      (hash, rel) =>
        hash
          .update(rel)
          .update('\0')
          .update(fs.readFileSync(path.join(projectDir, rel)))
          .update('\0'),
      crypto.createHash('sha256')
    )
    .digest('hex');

const DATA_STATE = /<[^>]*\bdata-state="([a-z0-9-]+)"[^>]*>\s*([^<]*?)\s*</g;

/**
 * The situations: the brief's, when the screen has one; else the boards'
 * own `data-state` switches, named by their labels.
 */
export const readSituations = (
  screenDir: string,
  boardHtml: string[]
): { slug: string; title: string }[] => {
  const brief = path.join(screenDir, 'brief.json');

  if (fs.existsSync(brief)) {
    return briefSituations(JSON.parse(fs.readFileSync(brief, 'utf8')));
  }

  return boardHtml
    .flatMap((html) =>
      Array.from(html.matchAll(DATA_STATE)).map((match) => ({
        slug: match[1] ?? '',
        title: (match[2] ?? '') === '' ? match[1] ?? '' : match[2] ?? '',
      }))
    )
    .filter(
      (situation, index, all) =>
        all.findIndex((other) => other.slug === situation.slug) === index
    );
};

const readChanges = (screenDir: string): string | undefined => {
  const brief = path.join(screenDir, 'brief.json');

  if (!fs.existsSync(brief)) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(brief, 'utf8'));
  const changes =
    typeof parsed === 'object' && parsed !== null
      ? Reflect.get(parsed, 'changes')
      : undefined;

  return typeof changes === 'string' && changes !== '' ? changes : undefined;
};

export interface SnapshotOptions {
  canvasDir: string;
  screenDir: string;
  /** Draws a board with no photographed situation. Default: renderArtboard. */
  renderPoster?: (options: {
    canvasDir: string;
    artboard: string;
    out: string;
  }) => Promise<unknown>;
  now?: Date;
  /** What this version changed from the one before. */
  note?: string;
}

/**
 * A board is one browser window: the page scrolls inside it, under a shell
 * that stays put. A taller board draws the whole page as one picture, and the
 * inbox can't show it like the app.
 */
export const WINDOW_SIZES = [
  { w: 1440, h: 900, name: 'desktop' },
  { w: 390, h: 844, name: 'phone' },
];

const assertWindowSizes = (
  boards: Record<string, { w: number; h: number }>,
  order: string[]
): void => {
  const wrong = order.filter((file) => {
    const board = boards[file];

    return (
      board !== undefined &&
      !WINDOW_SIZES.some((size) => size.w === board.w && size.h === board.h)
    );
  });

  if (wrong.length > 0) {
    throw new Error(
      `${wrong
        .map((file) => `${file} is ${boards[file]?.w}×${boards[file]?.h}`)
        .join(', ')}: a board is one window, 1440×900 (desktop) or 390×844 ` +
        '(phone). Set its w and h in canvas.json, let the page scroll inside ' +
        "the design system's app frame, and walk it again."
    );
  }
};

/** Each board's stills live under its letter, so two may not share one. */
const assertDistinctLetters = (
  boards: Record<string, { title?: string } | undefined>,
  order: string[]
): void => {
  order.reduce<Record<string, string>>((seen, file, index) => {
    const { letter } = boardName(boards[file]?.title, file, index);
    const other = seen[letter];

    if (other !== undefined) {
      throw new Error(
        `${other} and ${file} are both board ${letter}: give each a different letter in its canvas.json title ("C · …").`
      );
    }

    return { ...seen, [letter]: file };
  }, {});
};

export interface SnapshotResult {
  manifest: PrototypeManifest;
  /** The project hadn't changed: the newest version, as it was. */
  unchanged: boolean;
  line: string;
}

export const snapshotPrototype = async (
  options: SnapshotOptions
): Promise<SnapshotResult> => {
  const canvasDir = path.resolve(options.canvasDir);
  const projectDir = path.join(canvasDir, 'project');
  const screenDir = assertScreenDir(options.screenDir);
  const podDir = path.dirname(path.dirname(screenDir));
  const slug = path.basename(screenDir);
  const design = readDesignJson(canvasDir);
  const canvas = readCanvasJson(path.join(projectDir, 'canvas.json'));
  const runtime = requireRuntime(design);
  assertWindowSizes(canvas.boards, canvas.order);
  assertDistinctLetters(canvas.boards, canvas.order);
  const hash = projectHash(projectDir);
  const root = prototypeRoot(podDir, slug);
  const [newest] = readPrototypeVersions(root);

  if (newest !== undefined && newest.hash === hash) {
    return {
      manifest: newest,
      unchanged: true,
      line: prototypeLine(slug, newest.version),
    };
  }

  const version = (newest?.version ?? 0) + 1;
  const final = path.join(root, `v${version}`);
  // Built aside and moved in whole, so the inbox never reads half a version.
  const building = path.join(root, `.v${version}-${process.pid}`);
  fs.rmSync(building, { recursive: true, force: true });
  fs.mkdirSync(building, { recursive: true });

  try {
    fs.cpSync(projectDir, path.join(building, 'files'), { recursive: true });
    copyArtboardRuntime(
      path.join(building, 'files'),
      path.join(runtimeReleaseDir(runtime.release), ARTBOARD_RUNTIME)
    );

    const situations = readSituations(
      screenDir,
      canvas.order.map((file) =>
        fs.readFileSync(path.join(projectDir, file), 'utf8')
      )
    );
    const render = options.renderPoster ?? renderArtboard;
    const boards = await canvas.order.reduce<Promise<PrototypeBoard[]>>(
      async (sofar, file, index) => {
        const done = await sofar;
        const board = canvas.boards[file];

        if (board === undefined) {
          throw new Error(`canvas.json lost board ${file}.`);
        }

        const name = boardName(board.title, file, index);
        // The walk photographs a board into <screen>/<letter>/ when there
        // are several, or into <screen>/ itself when there is one.
        const shotDir =
          canvas.order.length === 1
            ? screenDir
            : path.join(screenDir, name.letter);
        const stillsDir = path.join(building, 'stills', name.letter);
        fs.mkdirSync(stillsDir, { recursive: true });
        const stills = Object.fromEntries(
          situations.flatMap(({ slug: situation }) => {
            const shot = path.join(shotDir, `${situation}.png`);

            if (!fs.existsSync(shot)) {
              return [];
            }

            fs.copyFileSync(shot, path.join(stillsDir, `${situation}.png`));

            return [
              [
                situation,
                path.relative(
                  podDir,
                  path.join(final, 'stills', name.letter, `${situation}.png`)
                ),
              ],
            ];
          })
        );

        if (Object.keys(stills).length === 0) {
          await render({
            canvasDir,
            artboard: file,
            out: path.join(stillsDir, 'poster.png'),
          });
          stills.poster = path.relative(
            podDir,
            path.join(final, 'stills', name.letter, 'poster.png')
          );
        }

        return [
          ...done,
          {
            file,
            letter: name.letter,
            title: name.title,
            w: board.w,
            h: board.h,
            stills,
          },
        ];
      },
      Promise.resolve([])
    );
    const changes = readChanges(screenDir);
    const manifest = PrototypeManifestSchema.parse({
      slug,
      version,
      title: canvas.title ?? slug,
      url: design.url,
      createdAt: (options.now ?? new Date()).toISOString(),
      ...(changes === undefined ? {} : { changes }),
      ...(options.note === undefined || options.note === ''
        ? {}
        : { note: options.note }),
      hash,
      situations,
      boards,
    });
    fs.writeFileSync(
      path.join(building, 'prototype.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    fs.renameSync(building, final);

    return { manifest, unchanged: false, line: prototypeLine(slug, version) };
  } catch (error) {
    fs.rmSync(building, { recursive: true, force: true });

    throw error;
  }
};
