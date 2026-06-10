/**
 * windowsIdentity.ts
 * Windows toast bildirimlerinde uygulamanın "com.dropmedia.app" ham AUMID
 * yerine "DropMedia" adı + logosuyla görünmesini sağlar.
 *
 * Kök neden: Uygulama özel (NSIS bootstrap) installer ile kurulduğundan, toast
 * kimliğini çözen yol yoktu. Windows, bir Win32 uygulamasının toast adını/ikonunu
 * şu registry anahtarından okur (Microsoft'un resmî yöntemi):
 *   HKCU\Software\Classes\AppUserModelId\<AUMID>
 *     DisplayName (REG_SZ)
 *     IconUri     (REG_SZ → png/ico dosya yolu)
 * Bu anahtar yoksa AUMID dizesi ("com.dropmedia.app") ve ikonsuz toast gösterilir.
 *
 * Çözüm: açılışta ikonu sabit bir diske (userData) çıkar ve bu registry
 * anahtarını yaz. Hâlihazırda kurulu kullanıcılarda da kendini onarır
 * (installer'ı yeniden çalıştırmak gerekmez).
 */

import { app, Notification, nativeImage } from 'electron'
import { spawn } from 'child_process'
import { copyFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'

export const APP_USER_MODEL_ID = 'com.dropmedia.app'
export const APP_DISPLAY_NAME = 'DropMedia'

let cachedIconPath: string | null = null

/** Toast/bildirim ikonu için diskteki kalıcı dosya yolu (asar dışı). */
export function getNotificationIconPath(): string | null {
  if (cachedIconPath && existsSync(cachedIconPath)) return cachedIconPath

  const candidates = [
    join(__dirname, '../../resources/icon.png'),
    join(process.resourcesPath ?? '', 'icon.png'),
    join(process.resourcesPath ?? '', 'resources', 'icon.png'),
    join(app.getAppPath(), 'resources', 'icon.png')
  ]
  const source = candidates.find(p => p && existsSync(p))
  if (!source) return null

  try {
    const dest = join(app.getPath('userData'), 'dropmedia-icon.png')
    // asar içinden okunabilir; diske çıkar (toast IconUri asar okuyamaz).
    if (!existsSync(dest)) copyFileSync(source, dest)
    cachedIconPath = dest
    return dest
  } catch {
    // Kopyalanamazsa kaynağı doğrudan dene (paketsiz/dev durumunda çalışır).
    cachedIconPath = source
    return source
  }
}

function regAdd(key: string, name: string, type: string, data: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('reg', ['add', key, '/v', name, '/t', type, '/d', data, '/f'], { stdio: 'ignore' })
    p.on('close', () => resolve())
    p.on('error', () => resolve())
  })
}

/**
 * Windows toast kimliğini (ad + ikon) registry'ye yazar. Best-effort: hata
 * kullanıcıyı ilgilendirmez (yalnızca toast ham AUMID gösterir).
 */
export async function ensureWindowsAppIdentity(): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`
    await regAdd(key, 'DisplayName', 'REG_SZ', APP_DISPLAY_NAME)
    const icon = getNotificationIconPath()
    if (icon) await regAdd(key, 'IconUri', 'REG_SZ', icon)
  } catch {
    /* sessiz */
  }
}

/**
 * Main process üzerinden toast gönderir. Renderer'ın HTML5 Notification'ı yerine
 * bunu kullanmak, ikonu doğrudan dosyadan vererek logoyu garanti eder ve
 * AUMID/registry kimliğiyle "DropMedia" başlığını kullanır.
 */
export function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return
  try {
    const iconPath = getNotificationIconPath()
    const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined
    new Notification({
      title,
      body,
      icon: icon && !icon.isEmpty() ? icon : undefined
    }).show()
  } catch {
    /* sessiz */
  }
}
