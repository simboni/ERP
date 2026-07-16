-- 0033: Allow the runtime role to edit and delete quotations.
--
-- 0012 granted the app role only SELECT/INSERT/UPDATE on quotes and
-- SELECT/INSERT on quote_lines, so editing a quote's lines (replace =
-- delete + insert) and deleting a quote were impossible. The RLS policies
-- are already FOR ALL (USING + WITH CHECK), so only the grants are needed.
GRANT DELETE ON quotes TO jenga_app;
GRANT UPDATE, DELETE ON quote_lines TO jenga_app;
