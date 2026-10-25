import { SegmentedControl } from '../../components/ui/segmented-control'
import { CATALOG_MODE_OPTIONS } from './options'
import { useSettingsStore } from './settings-store'

export interface CatalogModeControlProps {
  /** `chip` is the compact version for page headers (e.g. Search). */
  variant?: 'default' | 'chip'
  labelledBy?: string | undefined
  describedBy?: string | undefined
  className?: string | undefined
}

/** Music / Music + Video switch, bound to the persisted catalog mode setting. */
export function CatalogModeControl({
  variant = 'default',
  labelledBy,
  describedBy,
  className,
}: CatalogModeControlProps) {
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const setCatalogMode = useSettingsStore((state) => state.setCatalogMode)
  return (
    <SegmentedControl
      label="Catalog mode"
      labelledBy={labelledBy}
      describedBy={describedBy}
      value={catalogMode}
      options={CATALOG_MODE_OPTIONS}
      onChange={setCatalogMode}
      size={variant === 'chip' ? 'sm' : 'md'}
      className={className}
    />
  )
}
