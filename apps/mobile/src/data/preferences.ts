import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFERENCES_KEY = 'exposure.preferences.v1';

export type ExposurePreferences = {
  apiUrl: string;
  detail: 'concise' | 'detailed';
  skillLevel: 'beginner' | 'enthusiast' | 'professional';
  desiredMood: string;
  exportMetadata: boolean;
  exportGps: boolean;
  recommendationFeedback: { accepted: string[]; rejected: string[] };
};

export const defaultPreferences: ExposurePreferences = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? '',
  detail: 'detailed',
  skillLevel: 'enthusiast',
  desiredMood: '',
  exportMetadata: true,
  exportGps: false,
  recommendationFeedback: { accepted: [], rejected: [] },
};

export const loadPreferences = async (): Promise<ExposurePreferences> => {
  const stored = await AsyncStorage.getItem(PREFERENCES_KEY);
  if (!stored) return defaultPreferences;
  try {
    return { ...defaultPreferences, ...(JSON.parse(stored) as Partial<ExposurePreferences>) };
  } catch {
    return defaultPreferences;
  }
};

export const savePreferences = (preferences: ExposurePreferences) =>
  AsyncStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));

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
