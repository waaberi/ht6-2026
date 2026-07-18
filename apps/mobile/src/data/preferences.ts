import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFERENCES_KEY = 'exposure.preferences.v4';
const PREVIOUS_PREFERENCES_KEY = 'exposure.preferences.v3';
const OLDER_PREFERENCES_KEY = 'exposure.preferences.v2';
const LEGACY_PREFERENCES_KEY = 'exposure.preferences.v1';

export type CameraPreferences = {
  defaultFlash: 'off' | 'auto' | 'on';
  timerSeconds: 0 | 3 | 10;
  photoRatio: '4:3' | '16:9';
  showGrid: boolean;
  showLevel: boolean;
  mirrorSelfies: boolean;
  preserveCaptureSettings: boolean;
  zoom: number;
};

export type ExposurePreferences = {
  apiUrl: string;
  detail: 'concise' | 'detailed';
  skillLevel: 'beginner' | 'enthusiast' | 'professional';
  desiredMood: string;
  exportMetadata: boolean;
  exportGps: boolean;
  recommendationFeedback: { accepted: string[]; rejected: string[] };
  camera: CameraPreferences;
};

export const defaultPreferences: ExposurePreferences = {
  apiUrl: '',
  detail: 'detailed',
  skillLevel: 'enthusiast',
  desiredMood: '',
  exportMetadata: true,
  exportGps: false,
  recommendationFeedback: { accepted: [], rejected: [] },
  camera: {
    defaultFlash: 'off',
    timerSeconds: 0,
    photoRatio: '4:3',
    showGrid: true,
    showLevel: false,
    mirrorSelfies: true,
    preserveCaptureSettings: false,
    zoom: 0,
  },
};

const mergePreferences = (stored: Partial<ExposurePreferences>): ExposurePreferences => ({
  ...defaultPreferences,
  ...stored,
  recommendationFeedback: {
    ...defaultPreferences.recommendationFeedback,
    ...stored.recommendationFeedback,
  },
  camera: {
    ...defaultPreferences.camera,
    ...stored.camera,
    zoom: Math.max(0, Math.min(1, stored.camera?.zoom ?? defaultPreferences.camera.zoom)),
  },
});

export const loadPreferences = async (): Promise<ExposurePreferences> => {
  const stored = await AsyncStorage.getItem(PREFERENCES_KEY);
  if (!stored) {
    const legacy =
      (await AsyncStorage.getItem(PREVIOUS_PREFERENCES_KEY)) ??
      (await AsyncStorage.getItem(OLDER_PREFERENCES_KEY)) ??
      (await AsyncStorage.getItem(LEGACY_PREFERENCES_KEY));
    if (!legacy) return defaultPreferences;
    try {
      const parsed = JSON.parse(legacy) as Partial<ExposurePreferences>;
      const migrated = mergePreferences({
        ...parsed,
        camera: {
          ...parsed.camera,
          showLevel: false,
          preserveCaptureSettings: false,
          zoom: 0,
          timerSeconds: 0,
        } as CameraPreferences,
      });
      await AsyncStorage.setItem(PREFERENCES_KEY, JSON.stringify(migrated));
      return migrated;
    } catch {
      return defaultPreferences;
    }
  }
  try {
    return mergePreferences(JSON.parse(stored) as Partial<ExposurePreferences>);
  } catch {
    return defaultPreferences;
  }
};

export const savePreferences = (preferences: ExposurePreferences) =>
  AsyncStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));

export const updateCameraPreferences = async (changes: Partial<CameraPreferences>) => {
  const current = await loadPreferences();
  const next = mergePreferences({
    ...current,
    camera: { ...current.camera, ...changes },
  });
  await savePreferences(next);
  return next.camera;
};

export const recordRecommendationFeedback = async (issueId: string, accepted: boolean) => {
  const preferences = await loadPreferences();
  const acceptedIds = preferences.recommendationFeedback.accepted.filter((id) => id !== issueId);
  const rejectedIds = preferences.recommendationFeedback.rejected.filter((id) => id !== issueId);
  if (accepted) acceptedIds.push(issueId);
  else rejectedIds.push(issueId);
  const next = {
    ...preferences,
    recommendationFeedback: { accepted: acceptedIds, rejected: rejectedIds },
  };
  await savePreferences(next);
  return next;
};
