-- Admin auth hash table. Public policies intentionally omitted; service_role only.
CREATE TABLE IF NOT EXISTS admin_users (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  label          TEXT DEFAULT 'Owner',
  role           TEXT DEFAULT 'owner' CHECK (role IN ('owner')),
  password_hash  TEXT NOT NULL,
  active         BOOLEAN DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users(active, created_at);
