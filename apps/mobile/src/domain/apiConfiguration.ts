export const resolveApiUrl = (
  launcherUrl: string | undefined,
  configuredUrl: string | undefined,
  fallbackUrl: string | undefined,
) => {
  const normalized = (launcherUrl?.trim() || configuredUrl?.trim() || fallbackUrl?.trim() || '').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(normalized)) return '';
  if (/replace-with|your-api|example\.com/i.test(normalized)) return '';
  return normalized;
};

export const apiErrorMessage = (body: string, status: number) => {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail;
  } catch {
    // The API may return a proxy or platform error as plain text.
  }
  return body.trim() || `Exposure service returned ${status}`;
};
