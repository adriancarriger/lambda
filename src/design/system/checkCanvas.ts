import * as fs from 'fs';
import * as path from 'path';

import { newestManifest, runtimeStatus } from '../runtime';

/**
 * A canvas folder Lambda lays out itself to check a design system: the
 * newest cached Design runtime pinned in `design.json`, and `canvas.json`
 * listing the boards. Nothing on it is ever published.
 */

/** Never a real artifact: these canvases are only drawn on this computer. */
const LOCAL_CANVAS = 'local:design-system-check';

/** The newest Design runtime cached ready; throws naming how to cache one. */
export const readyRelease = (what: string): string => {
  const manifest = newestManifest();

  if (manifest === null || runtimeStatus(manifest.release) !== 'ready') {
    throw new Error(
      `No Design runtime is cached, so ${what}. Artifact-read the Design type's runtime files from any canvas, then run lambda design runtime import <the folder they were saved to> --release <its release>.`
    );
  }

  return manifest.release;
};

/** Pin `release` and list `boards` (file under `project/` → its window). */
export const writeCheckCanvas = ({
  canvasDir,
  release,
  boards,
}: {
  canvasDir: string;
  release: string;
  boards: { file: string; w: number; h: number }[];
}): void => {
  const project = path.join(canvasDir, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(canvasDir, 'design.json'),
    `${JSON.stringify({ url: LOCAL_CANVAS, release })}\n`
  );
  const canvasFile = path.join(project, 'canvas.json');
  const existing: unknown = fs.existsSync(canvasFile)
    ? JSON.parse(fs.readFileSync(canvasFile, 'utf8'))
    : {};
  const kept =
    typeof existing === 'object' && existing !== null ? existing : {};
  fs.writeFileSync(
    canvasFile,
    `${JSON.stringify(
      {
        ...kept,
        boards: Object.fromEntries(
          boards.map(({ file, w, h }, index) => [
            file,
            {
              x: boards
                .slice(0, index)
                .reduce((x, before) => x + before.w + 80, 0),
              y: 0,
              w,
              h,
              is_interactive: true,
              expand: 'fill',
            },
          ])
        ),
        order: boards.map(({ file }) => file),
      },
      null,
      2
    )}\n`
  );
};
