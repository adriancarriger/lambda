import * as fs from 'fs';
import * as path from 'path';

import { loadMachineConfig } from '../../../config/machineConfig';
import { appBundle } from '../../../desktop/appPaths';
import { kokoroInstalled } from './nodePath';

/**
 * The inbox's audio settings. Lambda reads its ElevenLabs key from
 * `~/.lambda/config.json` (`tokens.elevenlabs`) or the environment — never a
 * file in the project (never a repo `.env`). With no key and no provider
 * set, audio is off, except in the Mac app, which packages Kokoro (free, on
 * this machine). Named (`{"provider": "kokoro"}` in the switch file), Kokoro
 * also runs from a checkout that installed kokoro-js.
 */
export interface TtsConfig {
  /**
   * Who renders the audio. `elevenlabs`: the paid API. `off`: no rendering;
   * the page reads items with the browser's own voice. `kokoro`: local, in
   * the Mac app or wherever kokoro-js is installed (the switch file
   * `<pods root>/_tts.json`, `{"provider": "off"}`, wins over the
   * environment).
   */
  provider: 'kokoro' | 'elevenlabs' | 'off';
  kokoroVoice: string;
  /** fp32 is both faster and more accurate than q8 on Apple CPUs (measured). */
  kokoroDtype: 'fp32' | 'fp16' | 'q8' | 'q4';
  /** Pieces rendered at once (POD_TTS_KOKORO_WORKERS). */
  kokoroWorkers: number;
  apiKey: string | undefined;
  voiceId: string;
  modelId: string;
  /** Estimated cost, for the monthly cap. Errs high. */
  usdPer1kChars: number;
  monthlyCapUsd: number;
  /** Pre-render only the next N inbox items — the rest may never be reached. */
  prefetch: number;
}

/** "Rachel" — a clear ElevenLabs stock voice that holds up at 2.5×. */
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

const numberFrom = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);

  return value !== undefined && Number.isFinite(parsed) ? parsed : fallback;
};

const KOKORO_DTYPES = ['fp32', 'fp16', 'q8', 'q4'] as const;

const kokoroDtype = (value: string | undefined): TtsConfig['kokoroDtype'] =>
  KOKORO_DTYPES.find((dtype) => dtype === value) ?? 'fp32';

/** `<pods root>/_tts.json` → its provider, if it names one. */
const switchedProvider = (podsRoot: string): string | undefined => {
  const file = path.join(podsRoot, '_tts.json');

  if (!fs.existsSync(file)) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));

  return typeof parsed === 'object' &&
    parsed !== null &&
    'provider' in parsed &&
    typeof parsed.provider === 'string'
    ? parsed.provider
    : undefined;
};

/**
 * A provider named (switch file, then POD_TTS_PROVIDER) wins; else
 * ElevenLabs when there's a key. Kokoro is the free default only in the Mac
 * app, which packages it. Elsewhere it runs when named and kokoro-js is
 * installed (a checkout of Lambda has it), and reads as off when it isn't:
 * never on by itself, since it downloads a model and works the CPU.
 */
export const providerOf = (
  named: string | undefined,
  apiKey: string | undefined,
  inApp: boolean,
  installed = false
): TtsConfig['provider'] => {
  if (named === 'elevenlabs') {
    return 'elevenlabs';
  }

  if (named === 'kokoro') {
    return inApp || installed ? 'kokoro' : 'off';
  }

  if (named !== undefined) {
    return 'off';
  }

  if (apiKey !== undefined) {
    return 'elevenlabs';
  }

  return inApp ? 'kokoro' : 'off';
};

export const loadTtsConfig = (
  podsRoot: string,
  /** For tests: whether kokoro-js can be loaded here. */
  installed: () => boolean = kokoroInstalled
): TtsConfig => {
  // An empty value counts as unset. A broken config.json throws: audio
  // silently off would hide it.
  const apiKey =
    process.env.ELEVENLABS_TTS_API_KEY ||
    process.env.ELEVENLABS_API_KEY ||
    loadMachineConfig()?.tokens?.elevenlabs ||
    undefined;

  return {
    provider: providerOf(
      switchedProvider(podsRoot) ?? process.env.POD_TTS_PROVIDER,
      apiKey,
      appBundle() !== null,
      installed()
    ),
    kokoroVoice: process.env.POD_TTS_KOKORO_VOICE ?? 'af_heart',
    kokoroDtype: kokoroDtype(process.env.POD_TTS_KOKORO_DTYPE),
    kokoroWorkers: Math.max(
      1,
      Math.floor(numberFrom(process.env.POD_TTS_KOKORO_WORKERS, 1))
    ),
    apiKey,
    voiceId: process.env.POD_TTS_VOICE_ID ?? DEFAULT_VOICE,
    modelId: process.env.POD_TTS_MODEL_ID ?? 'eleven_flash_v2_5',
    usdPer1kChars: numberFrom(process.env.POD_TTS_USD_PER_1K_CHARS, 0.11),
    // No app-side cap by default: the ElevenLabs account's own credit limit
    // is the limit. Set POD_TTS_MONTHLY_CAP_USD to add one.
    monthlyCapUsd: numberFrom(
      process.env.POD_TTS_MONTHLY_CAP_USD,
      Number.POSITIVE_INFINITY
    ),
    prefetch: numberFrom(process.env.POD_TTS_PREFETCH, 3),
  };
};
