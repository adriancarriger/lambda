import * as fs from 'fs';
import * as path from 'path';

import { podsRoot } from '../pod/context';

/**
 * The cache of the Claude Design type's runtime, one folder per release:
 * `<pods root>/_design-runtime/<release>/` holding the type's files at their
 * published paths plus `manifest.json`. Canvases are pinned to the release they
 * were made with, so old releases stay.
 *
 * The Design type's URL is never written here: it comes from the account,
 * recorded on this machine by the capability check (`design.typeUrl` in the
 * machine config), or from `--type-url`.
 */

/** The artboard runtime. An artboard loads it as `./support.js`. */
export const ARTBOARD_RUNTIME = 'artifact-type/dc-runtime.js';

const MANIFEST = 'manifest.json';

export interface RuntimeManifest {
  release: string;
  typeUrl: string;
  files: string[];
  importedAt: string;
}

export type RuntimeStatus = 'ready' | 'missing' | 'incomplete';

/** A release names a folder: no `/`, no `..`, no whitespace. */
export const assertRelease = (release: string): void => {
  if (
    release === '' ||
    release.includes('/') ||
    release.includes('\\') ||
    release.includes('..') ||
    /\s/.test(release)
  ) {
    throw new Error(
      `Invalid release ${JSON.stringify(
        release
      )}: it may not be empty or contain "/", "..", or whitespace.`
    );
  }
};

export const designRuntimeRoot = (): string =>
  path.join(podsRoot(), '_design-runtime');

export const runtimeReleaseDir = (release: string): string => {
  assertRelease(release);

  return path.join(designRuntimeRoot(), release);
};

const listFiles = (dir: string, prefix = ''): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      return listFiles(path.join(dir, entry.name), rel);
    }

    return entry.isFile() ? [rel] : [];
  });

/** Parse a `manifest.json` body, throwing a clear Error on a bad shape. */
export const parseManifest = (raw: string, file: string): RuntimeManifest => {
  const parsed: unknown = JSON.parse(raw);

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('release' in parsed) ||
    typeof parsed.release !== 'string' ||
    !('typeUrl' in parsed) ||
    typeof parsed.typeUrl !== 'string' ||
    !('files' in parsed) ||
    !Array.isArray(parsed.files) ||
    !('importedAt' in parsed) ||
    typeof parsed.importedAt !== 'string'
  ) {
    throw new Error(
      `${file} is not a runtime manifest (needs "release", "typeUrl", "files" and "importedAt").`
    );
  }

  const files = parsed.files.filter(
    (entry: unknown): entry is string => typeof entry === 'string'
  );

  if (files.length !== parsed.files.length) {
    throw new Error(`${file} lists a file that is not a string.`);
  }

  return {
    release: parsed.release,
    typeUrl: parsed.typeUrl,
    files,
    importedAt: parsed.importedAt,
  };
};

export const readManifest = (release: string): RuntimeManifest | null => {
  const file = path.join(runtimeReleaseDir(release), MANIFEST);

  if (!fs.existsSync(file)) {
    return null;
  }

  return parseManifest(fs.readFileSync(file, 'utf8'), file);
};

/**
 * Copy the files an agent fetched with Artifact read (they land in its
 * scratchpad, at their published paths) into the cache, and write the manifest.
 * The release folder is replaced whole, so a re-import never mixes two fetches.
 */
export const importRuntime = (
  sourceDir: string,
  release: string,
  typeUrl: string
): RuntimeManifest => {
  assertRelease(release);

  const files = listFiles(sourceDir).filter((file) => file !== MANIFEST);

  if (!files.includes(ARTBOARD_RUNTIME)) {
    throw new Error(
      `${sourceDir} has no ${ARTBOARD_RUNTIME}, the runtime every artboard loads. Fetch the Design type's files with Artifact read first.`
    );
  }

  const target = runtimeReleaseDir(release);
  const incoming = `${target}.importing-${process.pid}`;
  fs.rmSync(incoming, { recursive: true, force: true });

  for (const file of files) {
    const to = path.join(incoming, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, file), to);
  }

  const manifest: RuntimeManifest = {
    release,
    typeUrl,
    files,
    importedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(incoming, MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(incoming, target);

  return manifest;
};

export const runtimeStatus = (release: string): RuntimeStatus => {
  const manifest = readManifest(release);

  if (manifest === null) {
    return 'missing';
  }

  const dir = runtimeReleaseDir(release);

  return manifest.files.every((file) => fs.existsSync(path.join(dir, file)))
    ? 'ready'
    : 'incomplete';
};

/** The most recently imported release's manifest, if any release is cached. */
export const newestManifest = (): RuntimeManifest | null => {
  const root = designRuntimeRoot();

  if (!fs.existsSync(root)) {
    return null;
  }

  return fs
    .readdirSync(root)
    .flatMap((release) => {
      try {
        const manifest = readManifest(release);

        return manifest === null ? [] : [manifest];
      } catch {
        return [];
      }
    })
    .reduce<RuntimeManifest | null>(
      (newest, manifest) =>
        newest === null || manifest.importedAt > newest.importedAt
          ? manifest
          : newest,
      null
    );
};
