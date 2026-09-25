-- Content filter for user-generated text (App Store guideline 1.2).
-- Rejects messages, comments, names and bios containing slurs or hate terms before
-- they are stored. Reporting and blocking (20260919000000_block_report.sql) handle
-- the rest. Terms live in a table so they can be edited without a migration.

CREATE TABLE IF NOT EXISTS public.blocked_terms (
  term TEXT PRIMARY KEY CHECK (term = lower(term) AND term ~ '^[a-z0-9 ]+$')
);
ALTER TABLE public.blocked_terms ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role and SQL can read or edit the list.

INSERT INTO public.blocked_terms (term) VALUES
  ('nigger'), ('niggers'), ('nigga'), ('niggas'), ('faggot'), ('faggots'), ('fag'), ('fags'),
  ('kike'), ('kikes'), ('spic'), ('spics'), ('chink'), ('chinks'), ('gook'), ('gooks'),
  ('wetback'), ('wetbacks'), ('tranny'), ('trannies'), ('retard'), ('retards'), ('retarded'),
  ('raghead'), ('ragheads'), ('towelhead'), ('towelheads'),
  ('beaner'), ('beaners'), ('paki'), ('pakis'), ('sandnigger'),
  ('porch monkey'), ('jungle bunny'), ('white power'), ('heil hitler'), ('sieg heil'),
  ('gas the jews'), ('kill yourself'), ('kys')
ON CONFLICT DO NOTHING;

-- True when the text contains a blocked term as a whole word (case-insensitive).
CREATE OR REPLACE FUNCTION public.contains_blocked_term(input TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT input IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.blocked_terms
    WHERE regexp_replace(lower(input), '[^a-z0-9]+', ' ', 'g') ~ ('(^| )' || term || '( |$)')
  );
$$;

CREATE OR REPLACE FUNCTION public.reject_blocked_terms()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'profiles' THEN
    IF public.contains_blocked_term(NEW.username)
       OR public.contains_blocked_term(NEW.full_name)
       OR public.contains_blocked_term(NEW.bio) THEN
      RAISE EXCEPTION 'This contains language that isn''t allowed on Praxis.'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF public.contains_blocked_term(NEW.body) THEN
    RAISE EXCEPTION 'This contains language that isn''t allowed on Praxis.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_reject_blocked_terms ON public.messages;
CREATE TRIGGER messages_reject_blocked_terms
  BEFORE INSERT OR UPDATE OF body ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_terms();

DROP TRIGGER IF EXISTS comments_reject_blocked_terms ON public.comments;
CREATE TRIGGER comments_reject_blocked_terms
  BEFORE INSERT OR UPDATE OF body ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_terms();

-- Profiles are updated constantly (streaks, stats), so only check when the text changes.
DROP TRIGGER IF EXISTS profiles_reject_blocked_terms_insert ON public.profiles;
CREATE TRIGGER profiles_reject_blocked_terms_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_terms();

DROP TRIGGER IF EXISTS profiles_reject_blocked_terms_update ON public.profiles;
CREATE TRIGGER profiles_reject_blocked_terms_update
  BEFORE UPDATE OF username, full_name, bio ON public.profiles
  FOR EACH ROW
  WHEN (NEW.username IS DISTINCT FROM OLD.username
        OR NEW.full_name IS DISTINCT FROM OLD.full_name
        OR NEW.bio IS DISTINCT FROM OLD.bio)
  EXECUTE FUNCTION public.reject_blocked_terms();
