-- 0028: Add the "hr" membership role. Roles are app-level (enforced by the
-- API @Roles guards and scoped in the web sidebar), but the memberships table
-- carries a CHECK constraint listing the valid role strings. Widen it so an
-- owner can assign the new "hr" role. Existing rows are unaffected; this only
-- adds a value to the allowed set.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_check
  CHECK (role IN
    ('owner', 'admin', 'accountant', 'cashier',
     'storekeeper', 'payroll', 'hr', 'viewer'));
