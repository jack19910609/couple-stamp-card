-- The service_role is used only by trusted server-side automation (such as
-- scripts/verify-supabase.mjs). It must never be exposed through Vite.
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
