import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getAuth0IdToken } from './auth';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const configured = Boolean(
  url?.startsWith('https://')
  && !/your-project/i.test(url)
  && publishableKey
  && !/your-publishable-key/i.test(publishableKey),
);

export const supabase: SupabaseClient | null =
  configured && url && publishableKey
    ? createClient(url, publishableKey, {
        accessToken: getAuth0IdToken,
      })
    : null;
