import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createPodStore } from '../../pod-store';
import { sessionName } from '../context';
import './podProject';

const temps: string[] = [];

const tmp = (name: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  temps.splice(temps.length, 0, dir);

  return dir;
};

afterEach(() => {
  temps.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true }));
});

describe('sessionName', () => {
  it('names a pod with no record by its own session', () => {
    const store = createPodStore(tmp('lambda-pods-'));

    expect(sessionName('ice-town-1a2b', store)).toBe(
      'lambda-pod-ice-town-1a2b'
    );
  });

  it("refuses a record it can't read, rather than guess the wrong session", () => {
    const store = createPodStore(tmp('lambda-pods-'));
    fs.mkdirSync(path.dirname(store.file('ice-town-1a2b', 'pod.json')), {
      recursive: true,
    });
    fs.writeFileSync(store.file('ice-town-1a2b', 'pod.json'), '{ not json');

    expect(() => sessionName('ice-town-1a2b', store)).toThrow(
      /Couldn't read pod ice-town-1a2b/
    );
  });
});
