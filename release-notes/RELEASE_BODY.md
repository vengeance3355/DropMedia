## DropMedia

YouTube, Instagram, Twitter ve daha fazlasından video ve ses indirme uygulaması. yt-dlp + ffmpeg tabanlı altyapısıyla çoklu platform desteği, format/kalite seçimi, indirme kuyruğu yönetimi, otomatik pano algılama, çerez tabanlı özel içerik indirme, medya dönüştürme, altyazı çıkarma ve mini mod sunar. Windows için tasarlanmış, Electron tabanlı modern arayüz.

---

# 1.0.0
Ana sürüm

---

# 1.0.1
- Windows uyumluluğu iyileştirildi
- Sürüm yönetimi düzeltildi
- Release otomasyonu eklendi

---

# 1.0.2
- Admin panel release akışı test
- NSIS bootstrapper installer
- Kur/Güncelle/Onar/Kaldır

---

# 1.0.3
- Uygulama içi sürüm yönetimi
- Admin panel GitHub API entegrasyonu
- Installer güncelleyici iyileştirildi

---

# 1.0.4
- Merge pull request #5 from vengeance3355/claude/elastic-gagarin-fb3e2b
- feat(update): in-app güncelleme artık installer'ı açar, app indirmez
- fix(updater): in-app güncelleme artık bağımsız süreçte uygulanıyor
- fix(installer): strip UTF-8 BOM before JSON.parse in httpsGetJson
- Merge pull request #4 from vengeance3355/claude/elastic-gagarin-fb3e2b
- fix(release): installer build + upload, encoding fix, version.json 1.0.3
- Merge pull request #3 from vengeance3355/claude/elastic-gagarin-fb3e2b
- feat(admin): simplified in-app release management
- Merge pull request #1 from vengeance3355/feat/windows-compat
- Merge branch 'main' into feat/windows-compat
- Merge pull request #2 from vengeance3355/claude/elastic-gagarin-fb3e2b
- chore(admin): remove release management from admin panel
- chore: release v1.0.3
- fix: single download update, fullscreen btn, scrollable sidebar, banner in main, encoding
- fix: release.js --draft=false on edit to keep assets public
- fix: utf-8 encoding for release notes in workflow
- fix: prevent incomplete URL domain matching (CodeQL alerts 58-73)
- chore: release v1.0.2
- chore: commit all modified source files (ai.ts, adminClient, types, etc)
- fix: remove audit:package from release.js (fails on fresh CI runner)
- fix: NSIS installer - ASAR pack, window focus on launch
- fix: use shell:true for npm/npx on Windows (re-apply)
- feat: bootstrapper installer + admin panel + release pipeline
- fix: updater version.json kullan, sadece son sürüm notu göster
- fix: use shell:true for npm/npx on Windows, drop manual cmd.exe invocation
- fix: avoid shell injection in Windows npm spawn
- feat: electron-based installer + custom release pipeline
- feat: add Windows pre-extraction helper and predist:win lifecycle hook
- feat: add Windows compatibility for yt-dlp, ffmpeg, cookies, and paths
- chore: release v1.0.1
- chore: release v1.0.0
- fix: reset release baseline and updater notes
- chore: release v1.0.5
- chore: release v1.0.3
- fix: align Windows updater asset names
- chore: release v1.0.2
- fix: spawn npm during Windows releases
- fix: run release commands on Windows
- ci: publish Windows release assets
- ci: add release workflow
- fix: enforce supabase email confirmation
- fix: use supabase cli profile in auto setup
- feat: automate supabase sync checks
- fix: explain sync network failures
- fix: restore library history view
- fix: harden admin release fallback
- chore: add v1.0.1 release notes
- feat: add product hub and release admin
- feat: log copy buttons, download_ok type, download dir fix
- feat: log copy buttons, download_ok type, download dir fix
- feat: tray, clipboard, mini mode, drag-drop, playlists, Tor, subtitles, cookies, speed limit, format conversion, local stats, light theme, app icon
- fix: electron-builder GitHub owner/repo
- feat: Supabase logging, release script, env config, admin panel deploy
- feat: admin panel, Supabase logger, crash protection
- feat: DropMedia initial commit

---

# 1.0.5
- fix(ai): güvenlik review bulgularını kapat (stop, leak, injection, embed-host)
- feat(ai): AI redesign — streaming chat + RAG @video + model manager + hardening
- fix(downloader): retry respawn'da bekleyen iptal/duraklat sızıntısı
- fix(ai/security): OLLAMA_HOST'u loopback'e kısıtla
- feat(ai): aktif-model çözümleyici + benchmark kurulu modeli kullanır
- fix(ai-chat): keyword-hijack kaldır + history race düzelt
- fix(ai): geçersiz Ollama model tag'lerini düzelt (qwen3.5 -> qwen2.5)
- fix: installer logo/spinner + SubtitleTab ölü butonlar + typecheck hataları
- fix(installer): uzun release notlarına scroll ekle
- fix(release): changelog notlarını stable..HEAD aralığından üret
- chore(admin): release yönetimini komple kaldır (in-app + admin-panel API)

---

# 1.0.6
- Güncelleme döngüsü düzeltildi (installer indirmelerine cache-bust)
- Güncelleyici yoksa otomatik indirilir
- AI redesign + admin panel sadeleştirmesi (önceki sürümlerden)

---

# 1.0.7
- Güncelleme düzeltildi: "Güncelle" artık installer'ı indirip gerçekten günceller (eskiden sadece uygulamayı yeniden başlatıyordu)
