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
    if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
      const detail = parsed.detail.trim();
      if (/GEMINI_API_KEY is required/i.test(detail)) {
        return 'AI generation is not configured. Restart the Exposure API after adding its Gemini key.';
      }
      if (
        (status === 429 || status === 503)
        && (/image.{0,24}quota/i.test(detail) || /quota.{0,24}image/i.test(detail))
      ) {
        return 'AI generation is unavailable for this Gemini project. Enable image-generation quota in Google AI Studio, then try again.';
      }
      return detail;
    }
  } catch {
    // The API may return a proxy or platform error as plain text.
  }
  return body.trim() || `Exposure service returned ${status}`;
};
