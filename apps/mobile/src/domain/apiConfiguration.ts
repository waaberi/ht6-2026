export const resolveApiUrl = (
  launcherUrl: string | undefined,
  configuredUrl: string | undefined,
  fallbackUrl: string | undefined,
) => (launcherUrl?.trim() || configuredUrl?.trim() || fallbackUrl?.trim() || '').replace(/\/$/, '');
