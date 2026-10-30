import * as fs from 'fs';
import * as path from 'path';

import { INDEX, README } from './assemble';

/**
 * `lambda design system publish`: show a built design system in Claude
 * Design, to browse it in claude.ai. Optional, and nothing reads its link:
 * planning builds from main locally. Lambda never calls claude.ai itself —
 * this prints the Artifact calls for an agent to make, and writes nothing.
 */

export const ARTIFACT_URL =
  /^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9-]+$/;

/**
 * The most files one Artifact publish sends: 255, and the service counts
 * the call's `file_path` (the README) among them, so `files` holds 254.
 */
export const MAX_FILES_PER_CALL = 254;

export const REMOVED_FILES_NOTE =
  'Files removed since an earlier publish stay in the published copy.';

export interface ArtifactCall {
  url?: string;
  type_url?: string;
  title?: string;
  root: string;
  file_path: string;
  files: Record<string, string | { from: string; contentType: string }>;
}

export interface PublishPlan {
  calls: ArtifactCall[];
  /** What to tell the agent after the calls. */
  notes: string[];
}

const listFiles = (dir: string, prefix: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${prefix}/${entry.name}`;

    return entry.isDirectory()
      ? listFiles(path.join(dir, entry.name), rel)
      : [rel];
  });

// The Artifact tool serves by extension and has none for `.ts`.
const fileSource = (rel: string): ArtifactCall['files'][string] =>
  rel.endsWith('.ts') ? { from: rel, contentType: 'text/plain' } : rel;

const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size)
  );

export const publishPlan = ({
  builtDir,
  url,
  typeUrl,
  title,
}: {
  builtDir: string;
  url?: string;
  /** The machine config's `design.systemTypeUrl`. */
  typeUrl?: string;
  title: string;
}): PublishPlan => {
  if (url !== undefined && !ARTIFACT_URL.test(url)) {
    throw new Error(
      `Refusing --url ${url}: it must be https://claude.ai/artifact/<id> or https://claude.ai/code/artifact/<id>, with nothing after the id.`
    );
  }

  const root = path.resolve(builtDir);

  if (!fs.existsSync(path.join(root, INDEX))) {
    throw new Error(
      `${builtDir} is not a built design system (no ${INDEX}): run lambda design system build first.`
    );
  }

  const built = listFiles(path.join(root, 'project'), 'project').sort();
  // The index goes last (the type writes it last).
  const entries: [string, ArtifactCall['files'][string]][] = [
    ...built
      .filter((rel) => rel !== README && rel !== INDEX)
      .map((rel): [string, ArtifactCall['files'][string]] => [
        rel,
        fileSource(rel),
      ]),
    [INDEX, fileSource(INDEX)],
  ];
  const parts = chunk(entries, MAX_FILES_PER_CALL).map((part) => ({
    root,
    file_path: path.join(root, README),
    files: Object.fromEntries(part),
  }));
  const [first] = parts;

  if (first === undefined) {
    throw new Error(`${builtDir} has nothing to publish.`);
  }

  if (url !== undefined) {
    return {
      calls: parts.map((part) => ({ url, ...part })),
      notes: [REMOVED_FILES_NOTE],
    };
  }

  if (typeUrl === undefined) {
    throw new Error(
      'No Design System type is recorded on this computer: run lambda design capability --set available … --system-type-url <url>, or publish to an existing one with --url.'
    );
  }

  return {
    calls: [{ type_url: typeUrl, title, ...first }],
    notes:
      parts.length === 1
        ? []
        : [
            `This create carries the first ${
              MAX_FILES_PER_CALL + 1
            } files. Then run: lambda design system publish --url <the new link> for the rest.`,
          ],
  };
};
