import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Every test file gets its own temp LAMBDA_HOME and CLAUDE_CONFIG_DIR, so
 * nothing a test writes through process.env lands in the real ~/.lambda or
 * ~/.claude.json (lambdaHome and claudeStateFile throw there under jest for
 * an env that has none).
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-jest-home-'));
process.env.LAMBDA_HOME = path.join(home, 'lambda');
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
