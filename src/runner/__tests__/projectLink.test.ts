import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type Project,
  ProjectConfigSchema,
  resolvePodsRoot,
} from '../../config/projectConfig';
import {
  PROJECT_ID_FILE,
  notLinkedMessage,
  readProjectId,
} from '../../design/system/projectId';
import { linkProject } from '../projectLink';

const pawnee = (): Project => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-link-'))
  );

  return {
    root,
    file: undefined,
    config: ProjectConfigSchema.parse({ name: 'Pawnee parks map' }),
  };
};

describe('linking a project keeps the id the mothership gave it', () => {
  const saved = process.env.LAMBDA_PODS_ROOT;

  beforeEach(() => {
    delete process.env.LAMBDA_PODS_ROOT;
  });

  afterAll(() => {
    if (saved !== undefined) {
      process.env.LAMBDA_PODS_ROOT = saved;
    }
  });

  it('sends project-link for the folder and records the answered id beside the pods', async () => {
    const project = pawnee();
    const request = jest.fn(async () => ({ projectId: 'prj_pawnee7' }));

    await expect(linkProject(project, request)).resolves.toBe('prj_pawnee7');

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'project-link',
        folder: project.root,
        name: 'Pawnee parks map',
      })
    );
    expect(readProjectId(project, 'Pawnee parks map')).toBe('prj_pawnee7');
    expect(
      fs.existsSync(path.join(resolvePodsRoot(project), PROJECT_ID_FILE))
    ).toBe(true);
  });

  it('records nothing when the answer carries no id, so the project stays unlinked', async () => {
    const project = pawnee();

    await expect(linkProject(project, async () => ({}))).resolves.toBeNull();

    expect(() => readProjectId(project, 'Pawnee parks map')).toThrow(
      notLinkedMessage('Pawnee parks map')
    );
  });

  it('refuses an id that is not one, writing nothing', async () => {
    const project = pawnee();

    await expect(
      linkProject(project, async () => ({ projectId: '../eagleton' }))
    ).rejects.toThrow('Refusing project id "../eagleton".');
    expect(
      fs.existsSync(path.join(resolvePodsRoot(project), PROJECT_ID_FILE))
    ).toBe(false);
  });
});
