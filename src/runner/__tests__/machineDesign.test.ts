import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { reportedMachineDesign } from '../machineDesign';

/** A `LAMBDA_HOME` whose config.json holds `text`. */
const homeWith = (text: string): string => {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-machine-design-'))
  );
  fs.writeFileSync(path.join(home, 'config.json'), text);

  return home;
};

describe('reportedMachineDesign', () => {
  it('reports unknown for a config it cannot read, and says why once', () => {
    const warned: string[] = [];
    const warn = (line: string): void => {
      warned.splice(warned.length, 0, line);
    };
    const env = { LAMBDA_HOME: homeWith('{ not json') };

    expect(reportedMachineDesign(env, warn)).toEqual({});
    expect(reportedMachineDesign(env, warn)).toEqual({});
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('config.json');
  });
});
