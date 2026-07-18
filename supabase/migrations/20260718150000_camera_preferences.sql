alter table public.profiles
  add column if not exists camera_preferences jsonb not null default
  '{"defaultFlash":"off","timerSeconds":0,"photoRatio":"4:3","showGrid":true,"showLevel":false,"mirrorSelfies":true,"preserveCaptureSettings":false,"zoom":0}'::jsonb;
