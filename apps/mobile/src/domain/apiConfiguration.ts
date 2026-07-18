export const resolveApiUrl = (configuredUrl: string | undefined, overrideUrl: string | undefined) =>
  (configuredUrl?.trim() || overrideUrl?.trim() || '').replace(/\/$/, '');
