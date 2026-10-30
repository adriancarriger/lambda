import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Project, ProjectConfigSchema } from '../../config/projectConfig';
import {
  ensurePendingDir,
  moveScenariosForShip,
  trackedDirOf,
} from '../pending';

describe('moveScenariosForShip', () => {
  it("adds only files with the codebase's scenario extension", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-pending-'));
    const project = {
      root,
      file: path.join(root, 'lambda.json'),
      config: ProjectConfigSchema.parse({}),
    } satisfies Project;
    const pending = ensurePendingDir(project, root, 'PAWNEE-5');
    fs.writeFileSync(path.join(pending, 'trail-map.scenario.json'), '{}');
    fs.writeFileSync(path.join(pending, 'x.scenario.sh'), 'rm -rf /');

    const { added } = moveScenariosForShip(project, root, 'PAWNEE-5', () => {});

    expect(added.map((file) => path.basename(file))).toEqual([
      'trail-map.scenario.json',
    ]);
    expect(
      fs.existsSync(path.join(trackedDirOf(project, root), 'x.scenario.sh'))
    ).toBe(false);
  });
});
