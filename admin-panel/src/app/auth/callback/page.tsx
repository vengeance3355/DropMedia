export default function AuthCallbackPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <section className="max-w-md rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-200">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-white">E-posta onayı tamamlandı</h1>
        <p className="mt-2 text-sm text-white/50">
          DropMedia uygulamasına dönüp hesabına giriş yapabilirsin.
        </p>
      </section>
    </main>
  )
}
