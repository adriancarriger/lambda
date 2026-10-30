import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { modelsDir } from '../../../../desktop/appPaths';
import { loadTtsConfig, providerOf } from '../config';
import { encodeClip, modelCacheDir, workerEnv, workerPath } from '../kokoro';
import { WAV_TYPE, audioTypeOf, isWav } from '../wav';

describe('Kokoro in the Mac app', () => {
  it('returns WAV when ffmpeg is not installed', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);

    const clip = await encodeClip(samples, 'no-such-ffmpeg-on-this-machine');

    expect(clip.type).toBe(WAV_TYPE);
    expect(isWav(clip.audio)).toBe(true);
    expect(audioTypeOf(clip.audio)).toBe('audio/wav');
    // 44-byte header, then 16-bit samples.
    expect(clip.audio.length).toBe(44 + samples.length * 2);
    expect(clip.audio.readInt16LE(44 + 3 * 2)).toBe(0x7fff);
  });

  it('loads the worker from app.asar.unpacked inside the bundle', () => {
    expect(
      workerPath('/Applications/Lambda.app/Contents/Resources/app.asar/dist')
    ).toBe(
      '/Applications/Lambda.app/Contents/Resources/app.asar.unpacked/dist/kokoroWorker.js'
    );
    expect(workerPath('/usr/local/lib/node_modules/lambda-cli/dist')).toBe(
      '/usr/local/lib/node_modules/lambda-cli/dist/kokoroWorker.js'
    );
  });

  it("caches the model in the app's folder only inside the app", () => {
    const inApp = { LAMBDA_APP_BUNDLE: '/Applications/Lambda.app' };

    expect(modelCacheDir(inApp, '/home/leslie')).toBe(
      modelsDir('/home/leslie')
    );
    expect(modelsDir('/home/leslie')).toBe(
      '/home/leslie/Library/Application Support/Lambda/models'
    );
    expect(modelCacheDir({}, '/home/leslie')).toBeNull();
    expect(workerEnv(inApp)).toMatchObject({
      KOKORO_CACHE_DIR: modelsDir(),
      NODE_PATH:
        '/Applications/Lambda.app/Contents/Resources/kokoro/node_modules',
    });
    expect(workerEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });

  it('is the free default in the app, and off elsewhere unless a key is set', () => {
    expect(providerOf(undefined, undefined, true)).toBe('kokoro');
    expect(providerOf(undefined, undefined, false)).toBe('off');
    expect(providerOf('kokoro', undefined, false)).toBe('off');
    expect(providerOf(undefined, 'xi-key', true)).toBe('elevenlabs');
    expect(providerOf('off', undefined, true)).toBe('off');
  });
});

describe('the ElevenLabs key', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('never comes from a repo .env, only tokens.elevenlabs', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-tts-env-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-project-'));
    fs.writeFileSync(
      path.join(project, '.env'),
      'ELEVENLABS_API_KEY=xi-from-dotenv\n'
    );
    process.env.LAMBDA_HOME = home;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_TTS_API_KEY;
    delete process.env.POD_TTS_PROVIDER;
    delete process.env.LAMBDA_APP_BUNDLE;
    const cwd = process.cwd();
    process.chdir(project);

    try {
      expect(loadTtsConfig(project)).toMatchObject({
        apiKey: undefined,
        provider: 'off',
      });
    } finally {
      process.chdir(cwd);
      [home, project].forEach((dir) =>
        fs.rmSync(dir, { recursive: true, force: true })
      );
    }
  });
});
