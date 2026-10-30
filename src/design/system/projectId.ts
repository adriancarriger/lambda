import * as fs from 'fs';
import * as path from 'path';

import { type Project, resolvePodsRoot } from '../../config/projectConfig';

/**
 * Lambda's id for a project (`prj_…`), as the mothership gave it when this
 * computer linked the project's folder (`project-link`). The runner keeps it
 * beside the pods, so commands run in the project — the design system's
 * build cache, keyed on it — know which project they are in without asking
 * the mothership.
 */

export const PROJECT_ID_FILE = '_project.json';

const PROJECT_ID = /^[A-Za-z0-9_-]+$/;

const fileOf = (project: Project): string =>
  path.join(resolvePodsRoot(project), PROJECT_ID_FILE);

export const recordProjectId = (project: Project, id: string): void => {
  if (!PROJECT_ID.test(id)) {
    throw new Error(`Refusing project id ${JSON.stringify(id)}.`);
  }

  const file = fileOf(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ id }, null, 2)}\n`);
};

export const notLinkedMessage = (projectName: string): string =>
  `${projectName} isn't linked to Lambda on this computer yet, so it has no project id to keep its design system builds under. Start Lambda in it first (lambda start).`;

/** The recorded id; throws when this computer never linked the project. */
export const readProjectId = (
  project: Project,
  projectName: string
): string => {
  const file = fileOf(project);
  const raw: unknown = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : null;
  const id =
    typeof raw === 'object' && raw !== null && 'id' in raw ? raw.id : undefined;

  if (typeof id !== 'string' || !PROJECT_ID.test(id)) {
    throw new Error(notLinkedMessage(projectName));
  }

  return id;
};
