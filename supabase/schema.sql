-- DropMedia Supabase Schema
-- Çalıştır: Supabase Dashboard → SQL Editor → New Query → yapıştır → Run

-- Hata logları tablosu
CREATE TABLE IF NOT EXISTS error_logs (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  device_id     TEXT NOT NULL,          -- Rastgele UUID (cihaz bazlı kalıcı)
  hostname      TEXT,                   -- PC adı
  app_version   TEXT,
  os            TEXT,
  url           TEXT,                   -- İndirilen video URL'si
  format        TEXT,                   -- Seçilen format
  error_type    TEXT,                   -- 'download' | 'fetch' | 'update' | 'crash'
  error_message TEXT,
  stack_trace   TEXT,
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
CREATE POLICY "app_insert_errors" ON error_logs
  FOR INSERT WITH CHECK (TRUE);

CREATE POLICY "app_insert_stats" ON stats
  FOR INSERT WITH CHECK (TRUE);

-- Index'ler (dashboard sorguları için)
CREATE INDEX idx_errors_device   ON error_logs(device_id);
CREATE INDEX idx_errors_created  ON error_logs(created_at DESC);
CREATE INDEX idx_errors_type     ON error_logs(error_type);
CREATE INDEX idx_stats_device    ON stats(device_id);
CREATE INDEX idx_stats_created   ON stats(created_at DESC);
CREATE INDEX idx_stats_platform  ON stats(platform);
