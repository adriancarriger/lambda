import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { MachineConfig } from '../config/machineConfig';

const made: string[] = [];

// Each test file that imports this removes the homes its tests made.
afterEach(() =>
  made
    .splice(0)
    .forEach((home) => fs.rmSync(home, { recursive: true, force: true }))
);

/** A LAMBDA_HOME of its own holding `config`, as an env for one test. */
export const machineHome = (config: MachineConfig): { LAMBDA_HOME: string } => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-machine-'));
  made.splice(made.length, 0, home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config), {
    mode: 0o600,
  });

  return { LAMBDA_HOME: home };
};

/** A real folder, since setup skips a project whose folder is gone. */
const pawnee = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-pawnee-'));

afterAll(() => fs.rmSync(pawnee, { recursive: true, force: true }));

/** First run finished: Claude connected, one project with its tickets. */
export const SETUP_DONE: MachineConfig = {
  firstRun: {
    claude: true,
    projects: { [pawnee]: { project: true, tickets: true } },
  },
};
