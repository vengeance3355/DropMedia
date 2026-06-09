-- DropMedia Supabase Schema
-- Çalıştır: Supabase Dashboard → SQL Editor → New Query → yapıştır → Run

-- Hata/olay logları tablosu
CREATE TABLE IF NOT EXISTS error_logs (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  device_id     TEXT NOT NULL,          -- Rastgele UUID (cihaz bazlı kalıcı)
  hostname      TEXT,                   -- PC adı
  app_version   TEXT,
  os            TEXT,
  url           TEXT,                   -- İndirilen video URL'si
  format        TEXT,                   -- Seçilen format
  error_type    TEXT,                   -- 'download' | 'fetch' | 'update' | 'crash' | 'app_open' | 'settings' | 'clipboard'
  error_message TEXT,
  stack_trace   TEXT,                   -- Teknik detaylar: oturum, işlem, komut, stderr/stdout; gizli değerler redakte edilmeli
  ytdlp_version TEXT,
  ffmpeg        BOOLEAN,
  tor_enabled   BOOLEAN
);

-- İstatistik tablosu
CREATE TABLE IF NOT EXISTS stats (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  device_id     TEXT NOT NULL,
  hostname      TEXT,
  app_version   TEXT,
  os            TEXT,
  platform      TEXT,                   -- 'youtube' | 'twitter' | 'tiktok' ...
  format        TEXT,
  file_size_mb  DECIMAL(10,2),
  duration_sec  INTEGER,
  download_ms   INTEGER,                -- İndirme süresi (ms)
  success       BOOLEAN DEFAULT TRUE
);

-- Row Level Security: Sadece service_role okuyabilir (public erişim yok)
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE stats ENABLE ROW LEVEL SECURITY;

-- Sadece insert izni (uygulama sadece yazabilir, okuyamaz)
DROP POLICY IF EXISTS "app_insert_errors" ON error_logs;
CREATE POLICY "app_insert_errors" ON error_logs
  FOR INSERT WITH CHECK (TRUE);

DROP POLICY IF EXISTS "app_insert_stats" ON stats;
CREATE POLICY "app_insert_stats" ON stats
  FOR INSERT WITH CHECK (TRUE);

-- Index'ler (dashboard sorguları için)
CREATE INDEX IF NOT EXISTS idx_errors_device   ON error_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_errors_created  ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_type     ON error_logs(error_type);
CREATE INDEX IF NOT EXISTS idx_stats_device    ON stats(device_id);
CREATE INDEX IF NOT EXISTS idx_stats_created   ON stats(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stats_platform  ON stats(platform);

-- Kullanıcı sync ayarları: Supabase Auth kullanır.
CREATE TABLE IF NOT EXISTS user_settings (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  namespace   TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, namespace)
);

CREATE TABLE IF NOT EXISTS download_library (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_url     TEXT NOT NULL,
  title          TEXT,
  platform       TEXT,
  format         TEXT,
  duration_sec   INTEGER,
  tags           TEXT[] DEFAULT '{}',
  favorite       BOOLEAN DEFAULT FALSE,
  provenance     JSONB DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, source_url)
);

CREATE TABLE IF NOT EXISTS watch_sources (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_type      TEXT NOT NULL,
  label            TEXT NOT NULL,
  url              TEXT NOT NULL,
  enabled          BOOLEAN DEFAULT TRUE,
  interval_minutes INTEGER DEFAULT 30,
  action           TEXT DEFAULT 'notify',
  default_format   TEXT DEFAULT 'best',
  filters          JSONB DEFAULT '{}'::jsonb,
  last_checked_at  TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, url)
);

CREATE TABLE IF NOT EXISTS watch_items (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_id      UUID REFERENCES watch_sources(id) ON DELETE CASCADE,
  source_url     TEXT NOT NULL,
  title          TEXT,
  platform       TEXT,
  thumbnail_url  TEXT,
  duration_sec   INTEGER,
  status         TEXT DEFAULT 'new',
  discovered_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, source_url)
);

-- Admin giriş bilgisi. Şifre açık tutulmaz; admin panel scrypt hash doğrular.
-- RLS açık ve public policy yoktur, sadece service_role erişir.
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

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE download_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_settings_owner_all" ON user_settings;
CREATE POLICY "user_settings_owner_all" ON user_settings
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "download_library_owner_all" ON download_library;
CREATE POLICY "download_library_owner_all" ON download_library
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "watch_sources_owner_all" ON watch_sources;
CREATE POLICY "watch_sources_owner_all" ON watch_sources
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "watch_items_owner_all" ON watch_items;
CREATE POLICY "watch_items_owner_all" ON watch_items
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_library_user       ON download_library(user_id);
CREATE INDEX IF NOT EXISTS idx_watch_sources_user ON watch_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_watch_items_user   ON watch_items(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users(active, created_at);
