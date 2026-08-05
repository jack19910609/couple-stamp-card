-- Let the person who created a pairing code receive the partner's membership
-- INSERT and leave the waiting screen without a manual refresh.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'couple_members'
  ) then
    alter publication supabase_realtime add table public.couple_members;
  end if;
end $$;
