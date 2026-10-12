
CREATE OR REPLACE FUNCTION public.exec_readonly_sql(q text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF q !~* '^\s*(select|with)\b' THEN
    RAISE EXCEPTION 'Only SELECT/WITH allowed';
  END IF;
  IF q ~* '\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy)\b' THEN
    RAISE EXCEPTION 'Forbidden keyword';
  END IF;
  EXECUTE 'SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (' || q || ') t' INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.exec_readonly_sql(text) FROM public, anon, authenticated;
