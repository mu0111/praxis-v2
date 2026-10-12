-- App Store 5.1.2: nobody appears on a leaderboard without consent.
-- NULL = never asked (the app prompts once), true = opted in, false = declined.
-- Leaderboard queries list only rows where this is true.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS show_on_leaderboard boolean;

CREATE INDEX IF NOT EXISTS idx_profiles_show_on_leaderboard
  ON public.profiles (show_on_leaderboard) WHERE show_on_leaderboard;
