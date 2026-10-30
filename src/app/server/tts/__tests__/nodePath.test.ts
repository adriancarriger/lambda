import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { requireFromNodePath } from '../nodePath';

/** A Kokoro folder like the app's: `<dir>/node_modules/<name>`, outside any repo. */
const appKokoroFolder = (name: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-kokoro-'));
  const pkg = path.join(dir, 'node_modules', name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name, main: 'index.js' })
  );
  fs.writeFileSync(
    path.join(pkg, 'index.js'),
    'module.exports = { KokoroTTS: "fake" };\n'
  );

  return path.join(dir, 'node_modules');
};

describe("Kokoro's libraries in the Mac app", () => {
  it('load from the folder NODE_PATH names', () => {
    const nodePath = appKokoroFolder('pawnee-kokoro');

    expect(
      requireFromNodePath('pawnee-kokoro', { NODE_PATH: nodePath })
    ).toEqual({
      KokoroTTS: 'fake',
    });
  });

  it("aren't found without it", () => {
    appKokoroFolder('pawnee-kokoro-elsewhere');

    expect(() => requireFromNodePath('pawnee-kokoro-elsewhere', {})).toThrow(
      /Cannot (find|resolve) module/
    );
  });

  it('are never loaded with a native import(), which ignores NODE_PATH', () => {
    const source = fs
      .readFileSync(path.join(__dirname, '..', 'kokoroWorker.ts'), 'utf8')
      // Comments and type positions don't load anything.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/typeof import\(/g, '');

    expect(source).not.toMatch(/\bimport\(/);
    expect(source).toContain("requireFromNodePath('kokoro-js')");
  });
});
