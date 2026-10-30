import { type Project } from '../config/projectConfig';
import { recordProjectId } from '../design/system/projectId';
import { randomId } from '../mothership/crypto';
import { projectIdentity } from './projectsSetup';

/**
 * Link the project in a folder to the mothership (`project-link`) and keep
 * the id it answers beside the project's pods, so commands run in the
 * project know Lambda's id for it (the design system's build cache is kept
 * under it). Answers that id, or null when the answer carried none.
 */
export const linkProject = async (
  project: Project,
  request: (
    message: Record<string, unknown> & { type: string; id: string }
  ) => Promise<unknown>
): Promise<string | null> => {
  const answer = await request({
    type: 'project-link',
    id: randomId('ln'),
    folder: project.root,
    ...projectIdentity(project),
  });
  const projectId =
    typeof answer === 'object' && answer !== null && 'projectId' in answer
      ? answer.projectId
      : undefined;

  if (typeof projectId !== 'string') {
    return null;
  }

  recordProjectId(project, projectId);

  return projectId;
};
