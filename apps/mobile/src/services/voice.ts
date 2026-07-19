import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';

import { synthesizeCoachSpeech } from './api';

const COACH_VOICE_CACHE_VERSION = 'elevenlabs-flash-v1';

export const prepareCoachNarrationAudio = async (text: string) => {
  const digest = await digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    `${COACH_VOICE_CACHE_VERSION}:${text}`,
  );
  const audio = new File(Paths.cache, `exposure-coach-${digest}.mp3`);
  if (audio.exists && audio.size > 0) return audio.uri;

  const bytes = await synthesizeCoachSpeech(text);
  audio.create({ overwrite: true });
  audio.write(new Uint8Array(bytes));
  return audio.uri;
};
