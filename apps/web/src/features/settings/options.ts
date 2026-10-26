import { Clapperboard, type LucideIcon, Monitor, Moon, Music2, Sun } from 'lucide-react'
import type { CatalogMode, ThemePreference } from './settings-store'

export interface SettingOption<V extends string> {
  value: V
  label: string
  icon: LucideIcon
}

export const CATALOG_MODE_OPTIONS: readonly SettingOption<CatalogMode>[] = [
  { value: 'music', label: 'Music', icon: Music2 },
  { value: 'all', label: 'Music + Video', icon: Clapperboard },
]

export const CATALOG_MODE_LABELS: Readonly<Record<CatalogMode, string>> = {
  music: 'Music',
  all: 'Music + Video',
}

export const CATALOG_MODE_DESCRIPTIONS: Readonly<Record<CatalogMode, string>> = {
  music:
    'Music: songs only, from any source – YouTube Music’s album audio, Internet Archive, Jamendo and your own files.',
  all: 'Music + Video: also any YouTube video – covers, live sets, remixes – played as music.',
}

export const THEME_OPTIONS: readonly SettingOption<ThemePreference>[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
]
