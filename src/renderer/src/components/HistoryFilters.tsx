import { Search, SlidersHorizontal } from 'lucide-react'
import { DownloadItem } from '../types'

export type HistoryPlatform = 'all' | 'youtube' | 'x' | 'instagram' | 'tiktok' | 'discord' | 'other'
export type HistorySort = 'newest' | 'oldest' | 'az' | 'za' | 'platform' | 'size-desc' | 'size-asc'
export type HistoryStatus = 'all' | 'completed' | 'error' | 'cancelled'
export type HistoryMediaType = 'all' | 'video' | 'audio'
export type HistoryDateRange = 'all' | 'today' | 'week' | 'month'

interface Props {
  search: string
  setSearch: (value: string) => void
  status: HistoryStatus
  setStatus: (value: HistoryStatus) => void
  platform: HistoryPlatform
  setPlatform: (value: HistoryPlatform) => void
  mediaType: HistoryMediaType
  setMediaType: (value: HistoryMediaType) => void
  dateRange: HistoryDateRange
  setDateRange: (value: HistoryDateRange) => void
  sort: HistorySort
  setSort: (value: HistorySort) => void
  items: DownloadItem[]
}

const platforms: { id: HistoryPlatform; label: string }[] = [
  { id: 'all', label: 'Tümü' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'x', label: 'X/Twitter' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'discord', label: 'Discord' },
  { id: 'other', label: 'Diğer' }
]

const sortOptions: { id: HistorySort; label: string }[] = [
  { id: 'newest', label: 'En Yeni' },
  { id: 'oldest', label: 'En Eski' },
  { id: 'az', label: 'A-Z' },
  { id: 'za', label: 'Z-A' },
  { id: 'platform', label: 'Platform' },
  { id: 'size-desc', label: 'Büyük→Küçük' },
  { id: 'size-asc', label: 'Küçük→Büyük' }
]

const statuses: { id: HistoryStatus; label: string }[] = [
  { id: 'all', label: 'Hepsi' },
  { id: 'completed', label: 'Başarılı' },
  { id: 'error', label: 'Başarısız' },
  { id: 'cancelled', label: 'İptal' }
]

const mediaTypes: { id: HistoryMediaType; label: string }[] = [
  { id: 'all', label: 'Tüm Medya' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Ses' }
]

const dateRanges: { id: HistoryDateRange; label: string }[] = [
  { id: 'all', label: 'Tüm Zamanlar' },
  { id: 'today', label: 'Bugün' },
  { id: 'week', label: '7 Gün' },
  { id: 'month', label: '30 Gün' }
]

export function HistoryFilters({
  search, setSearch,
  status, setStatus,
  platform, setPlatform,
  mediaType, setMediaType,
  dateRange, setDateRange,
  sort, setSort,
  items
}: Props) {
  const counts = platforms.reduce((acc, p) => {
    acc[p.id] = p.id === 'all'
      ? items.length
      : items.filter(item => getHistoryPlatform(item) === p.id).length
    return acc
  }, {} as Record<HistoryPlatform, number>)

  return (
    <div className="mb-4 rounded-3xl premium-card p-3.5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <label className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Ara..."
            className="w-full h-10 rounded-2xl border border-white/10 bg-black/25 pl-9 pr-3 text-sm text-white/80 placeholder:text-white/25 outline-none transition-all focus:border-purple-400/50 focus:bg-purple-500/10 focus:shadow-[0_0_24px_rgba(124,58,237,0.18)]"
          />
        </label>

        <div className="relative shrink-0">
          <SlidersHorizontal className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
          <select
            value={sort}
            onChange={e => setSort(e.target.value as HistorySort)}
            className="h-10 appearance-none rounded-2xl border border-white/10 bg-black/25 pl-9 pr-9 text-xs font-medium text-white/70 outline-none transition-all hover:bg-white/8 focus:border-purple-400/50"
          >
            {sortOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-[10px]">▾</span>
        </div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        <FilterSelect value={status} onChange={v => setStatus(v as HistoryStatus)} options={statuses} />
        <FilterSelect value={mediaType} onChange={v => setMediaType(v as HistoryMediaType)} options={mediaTypes} />
        <FilterSelect value={dateRange} onChange={v => setDateRange(v as HistoryDateRange)} options={dateRanges} />
      </div>

      <div className="mt-3 flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
        {platforms.map(p => {
          const active = platform === p.id
          return (
            <button
              key={p.id}
              onClick={() => setPlatform(p.id)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-all ${
                active
                  ? 'bg-gradient-button text-white shadow-lg shadow-purple-500/25 ring-1 ring-purple-300/30'
                  : 'border border-white/10 bg-white/[0.04] text-white/45 hover:bg-white/8 hover:text-white/70'
              }`}
            >
              {p.label} <span className={active ? 'text-white/80' : 'text-white/30'}>({counts[p.id] ?? 0})</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FilterSelect<T extends string>({ value, onChange, options }: {
  value: T
  onChange: (value: T) => void
  options: { id: T; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as T)}
      className="h-9 rounded-xl border border-white/10 bg-black/25 px-3 text-xs font-medium text-white/65 outline-none transition-all hover:bg-white/8 focus:border-purple-400/50"
    >
      {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  )
}

export function getHistoryPlatform(item: DownloadItem): HistoryPlatform {
  const url = item.url.toLowerCase()
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube'
  if (url.includes('twitter.com') || url.includes('x.com')) return 'x'
  if (url.includes('instagram.com')) return 'instagram'
  if (url.includes('tiktok.com')) return 'tiktok'
  if (url.includes('discord.com') || url.includes('discordapp.com')) return 'discord'
  return 'other'
}
