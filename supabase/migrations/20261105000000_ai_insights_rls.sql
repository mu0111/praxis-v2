-- Supabase flagged ai_insights as publicly readable/writable (rls_disabled_in_public,
-- 2026-10-31 email). Only the ai-insights edge function uses it, via the service role,
-- which bypasses RLS. Applied to prod 2026-11-05 02:3xZ.
ALTER TABLE public.ai_insights ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_insights FROM anon, authenticated;
