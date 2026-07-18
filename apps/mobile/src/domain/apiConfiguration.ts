export const resolveApiUrl = (configuredUrl: string | undefined, overrideUrl: string | undefined) =>
  (overrideUrl?.trim() || configuredUrl?.trim() || '').replace(/\/$/, '');
