-- Let a subscription be owned by an organization, as 0007 intended.
--
-- 0007_organizations.sql moved subscriptions from users to organizations but
-- left subscriptions.user_id NOT NULL, so the organization-owned row the whole
-- change exists to allow could not be inserted. SubscriptionRecord.userId had
-- already been widened to `string | null` in TypeScript, which is where the two
-- descriptions of the same column parted company.
--
-- 0007 also tried to relax "one live subscription per account" with
--
--   ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_user_key;
--
-- but 0001 created subscriptions_user_key as an index, not a constraint, so
-- that statement matched nothing and the unique index is still there. It is
-- left alone deliberately: NULLs are distinct in a PostgreSQL unique index, so
-- it constrains accounts without saying anything about organization-owned rows,
-- which is exactly the guarantee 0001 wrote it for.

ALTER TABLE subscriptions ALTER COLUMN user_id DROP NOT NULL;

-- Every row is owned by an account, an organization, or both. Without this a
-- subscription could name neither and belong to nobody.
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_owner_present
  CHECK (user_id IS NOT NULL OR organization_id IS NOT NULL);
