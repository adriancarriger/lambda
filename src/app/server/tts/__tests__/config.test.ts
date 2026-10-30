import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadTtsConfig } from '../config';
import { kokoroInstalled } from '../nodePath';

describe('the audio settings', () => {
  const saved = { ...process.env };
  const fixture: { home: string } = { home: '' };

  beforeEach(() => {
    fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-tts-'));
    process.env.LAMBDA_HOME = fixture.home;
    delete process.env.ELEVENLABS_TTS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.POD_TTS_PROVIDER;
    // Set in every window the Mac app opens; it turns Kokoro on.
    delete process.env.LAMBDA_APP_BUNDLE;
  });

  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(fixture.home, { recursive: true, force: true });
  });

  it('treats an empty key as no key: audio stays off', () => {
    process.env.ELEVENLABS_TTS_API_KEY = '';
    process.env.ELEVENLABS_API_KEY = '';

    expect(loadTtsConfig(fixture.home)).toMatchObject({
      provider: 'off',
      apiKey: undefined,
    });
  });

  it('says so when config.json is broken, instead of turning audio off', () => {
    fs.writeFileSync(path.join(fixture.home, 'config.json'), '{"owner": 7}');

    expect(() => loadTtsConfig(fixture.home)).toThrow(
      path.join(fixture.home, 'config.json')
    );
  });

  it('is off with nothing set', () => {
    expect(loadTtsConfig(fixture.home).provider).toBe('off');
  });

  it('turns ElevenLabs on with a key alone', () => {
    process.env.ELEVENLABS_API_KEY = 'xi-pawnee';

    expect(loadTtsConfig(fixture.home)).toMatchObject({
      provider: 'elevenlabs',
      apiKey: 'xi-pawnee',
    });
  });

  it('reads the key from ~/.lambda/config.json', () => {
    fs.writeFileSync(
      path.join(fixture.home, 'config.json'),
      JSON.stringify({ tokens: { elevenlabs: 'xi-from-config' } })
    );

    expect(loadTtsConfig(fixture.home)).toMatchObject({
      provider: 'elevenlabs',
      apiKey: 'xi-from-config',
    });
  });

  it('lets the switch file turn it off over the environment and a key', () => {
    process.env.ELEVENLABS_API_KEY = 'xi-pawnee';
    process.env.POD_TTS_PROVIDER = 'elevenlabs';
    fs.writeFileSync(
      path.join(fixture.home, '_tts.json'),
      JSON.stringify({ provider: 'off' })
    );

    expect(loadTtsConfig(fixture.home).provider).toBe('off');
  });

  it('reads Kokoro as off where kokoro-js isn’t installed', () => {
    process.env.ELEVENLABS_API_KEY = 'xi-pawnee';
    process.env.POD_TTS_PROVIDER = 'kokoro';

    expect(loadTtsConfig(fixture.home, () => false).provider).toBe('off');
  });

  it('runs Kokoro when the switch file names it and kokoro-js is installed, over a key', () => {
    process.env.ELEVENLABS_API_KEY = 'xi-pawnee';
    fs.writeFileSync(
      path.join(fixture.home, '_tts.json'),
      JSON.stringify({ provider: 'kokoro' })
    );

    expect(loadTtsConfig(fixture.home, () => true).provider).toBe('kokoro');
  });

  it('never turns Kokoro on by itself outside the app, installed or not', () => {
    expect(loadTtsConfig(fixture.home, () => true).provider).toBe('off');
  });

  it('finds kokoro-js in a checkout of Lambda', () => {
    expect(kokoroInstalled()).toBe(true);
    expect(kokoroInstalled({ NODE_PATH: '' })).toBe(true);
  });
});
