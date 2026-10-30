import * as fs from 'fs';
import * as path from 'path';

import { ensureDesignGitignore } from '../canvasDir';

/**
 * `lambda design system install` — put a project's design system on a
 * canvas, so a prototype mounts its real components (`window.<namespace>`),
 * reads its sample data (`window.<namespace>Sample`) and can start from its
 * reference screens.
 *
 * The design system is built from the project's main branch, in a checkout
 * that has its dependencies, never in a pod worktree (which has none). This
 * only consumes that built folder: it never builds anything. The folder's
 * manifest, `design-system.json`, names the namespace; the files land under
 * `<canvas>/project/ds/<namespace in lower case>/`, as the Design type's
 * `reference/design-system-components.md` says, with one `designSystems`
 * record in `project/canvas.json`.
 *
 * `lambda design system build` lays its output out as the Design System type
 * keeps it, under `<built>/project/`; a folder given at that level is read
 * from its `project/`. A look-only system (no components) has no bundle.
 */

export const SYSTEM_MANIFEST = 'design-system.json';

/** A namespace is a JavaScript global's name: `window.<namespace>`. */
export const NAMESPACE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

/** What a canvas must have of the system: the files its README says to load. */
export const REQUIRED_SYSTEM_FILES = ['README.md', 'tokens.json'];

/** Required too whenever the system has components (`components/` exists). */
export const BUNDLE_FILES = ['components/bundle.css', 'components/bundle.js'];

/** The folder holding a built system's files: `<built>/project/` when there is one. */
export const systemFilesDir = (builtDir: string): string => {
  const project = path.join(builtDir, 'project');

  return fs.existsSync(path.join(project, SYSTEM_MANIFEST))
    ? project
    : builtDir;
};

/** Copied when the built folder has it: the system's one sample data set. */
export const SAMPLE_DATA = 'sample-data.js';

/** Copied when the built folder has them: reference screens and pictures. */
export const OPTIONAL_SYSTEM_DIRS = ['screens', 'assets'];

export interface DesignSystemRecord {
  title: string;
  namespace: string;
  copiedAt: string;
}

const isInside = (dir: string, target: string): boolean => {
  const rel = path.relative(dir, target);

  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined;

const listFiles = (dir: string, prefix: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      return listFiles(path.join(dir, entry.name), rel);
    }

    return [rel];
  });

/** The built folder's manifest: its namespace (checked) and title. */
export const readSystemManifest = (
  builtDir: string
): { namespace: string; title: string } => {
  const file = path.join(builtDir, SYSTEM_MANIFEST);

  if (!fs.existsSync(file)) {
    throw new Error(
      `${builtDir} has no ${SYSTEM_MANIFEST}: it is not a built design system.`
    );
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const namespace = field(parsed, 'namespace');
  const title = field(parsed, 'title');

  if (typeof namespace !== 'string' || !NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      `Refusing ${file}: its "namespace" ${JSON.stringify(
        namespace
      )} must match ${NAMESPACE_PATTERN} (it is a JavaScript global's name).`
    );
  }

  return {
    namespace,
    title: typeof title === 'string' && title.trim() !== '' ? title : namespace,
  };
};

/**
 * Install a built design system on a canvas folder. Every path is checked
 * before anything is copied: a missing required file, or one whose realpath
 * leaves the built folder, throws naming it. An update replaces the earlier
 * copy and its record, so running it twice leaves one record.
 */
export const installSystem = ({
  builtDir,
  canvasDir,
  namespace: expected,
  now = () => new Date(),
}: {
  builtDir: string;
  canvasDir: string;
  /** When given, the built folder's namespace must be exactly this. */
  namespace?: string;
  now?: () => Date;
}): { files: string[]; record: DesignSystemRecord } => {
  if (!fs.existsSync(builtDir)) {
    throw new Error(`${builtDir} does not exist.`);
  }

  const source = fs.realpathSync(systemFilesDir(builtDir));
  const { namespace, title } = readSystemManifest(source);

  if (expected !== undefined && expected !== namespace) {
    throw new Error(
      `${builtDir} is the design system ${namespace}, not ${expected}.`
    );
  }

  const folder = namespace.toLowerCase();
  const rels = [
    ...REQUIRED_SYSTEM_FILES,
    ...(fs.existsSync(path.join(source, 'components')) ? BUNDLE_FILES : []),
    ...(fs.existsSync(path.join(source, SAMPLE_DATA)) ? [SAMPLE_DATA] : []),
    ...OPTIONAL_SYSTEM_DIRS.flatMap((dir) =>
      fs.existsSync(path.join(source, dir))
        ? listFiles(path.join(source, dir), dir)
        : []
    ),
  ];
  const sources = rels.map((rel) => {
    const file = path.join(source, rel);

    if (!fs.existsSync(file)) {
      throw new Error(
        `${rel} is missing from ${builtDir}: build the design system again.`
      );
    }

    const real = fs.realpathSync(file);

    if (!isInside(source, real) || !fs.statSync(real).isFile()) {
      throw new Error(
        `${rel} in ${builtDir} is not a file inside that folder (it resolves to ${real}).`
      );
    }

    return { rel, real };
  });

  const project = path.join(path.resolve(canvasDir), 'project');
  const dest = path.join(project, 'ds', folder);
  const canvasFile = path.join(project, 'canvas.json');
  const canvas: unknown = fs.existsSync(canvasFile)
    ? JSON.parse(fs.readFileSync(canvasFile, 'utf8'))
    : { boards: {} };

  if (typeof canvas !== 'object' || canvas === null || Array.isArray(canvas)) {
    throw new Error(`${canvasFile} is not a JSON object.`);
  }

  const existing: unknown[] =
    'designSystems' in canvas && Array.isArray(canvas.designSystems)
      ? canvas.designSystems
      : [];
  const isOurs = (entry: unknown): boolean =>
    field(entry, 'namespace') === folder;
  const record: DesignSystemRecord = {
    title,
    namespace: folder,
    copiedAt: now().toISOString(),
  };
  const firstOurs = existing.findIndex(isOurs);
  const designSystems =
    firstOurs === -1
      ? [...existing, record]
      : existing
          .map((entry, index) => (index === firstOurs ? record : entry))
          .filter((entry, index) => index === firstOurs || !isOurs(entry));

  const targets = sources.map(({ rel, real }) => {
    const to = path.join(dest, rel);

    if (!isInside(dest, to)) {
      throw new Error(`${rel} would land outside ${dest}.`);
    }

    return { to, real };
  });

  ensureDesignGitignore(canvasDir);
  // An update replaces the earlier copy (the record is replaced too).
  fs.rmSync(dest, { recursive: true, force: true });
  targets.forEach(({ to, real }) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(real, to);
  });
  fs.writeFileSync(
    canvasFile,
    `${JSON.stringify({ ...canvas, designSystems }, null, 2)}\n`
  );

  return {
    files: targets.map(({ to }) => path.relative(path.resolve(canvasDir), to)),
    record,
  };
};
