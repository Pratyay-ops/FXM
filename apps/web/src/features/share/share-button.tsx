import type { EntityId } from '@fxm/core'
import { Share2 } from 'lucide-react'
import { IconButton } from '../../components/ui/icon-button'
import { type EmbedKind, embedTargetOf, parseEmbedAddress } from '../../embed/target'
import type { PreviewInfo } from '../../embed/view'
import { canShare, useShareStore } from './share-store'

/**
 * The entity an app page's route parameter names, `<source>:<native ID>` as in
 * `/album/ytm:MPREb_…` (React Router has decoded it), or `undefined` when no embed can show it.
 */
export function pageEntityId(kind: EmbedKind, param: string | undefined): EntityId | undefined {
  if (param === undefined) return undefined
  const address = parseEmbedAddress(`/embed/${kind}/${encodeURIComponent(param)}`)
  return address.ok ? address.target.id : undefined
}

/**
 * Opens the share dialog for a track, album or playlist. Renders nothing for an entity no embed
 * can show (an artist, a Spotify track, a local file), or that the app doesn't offer to share
 * yet (`canShare`: in production builds, until the embed can play its source).
 */
export function ShareButton({
  id,
  info,
  size = 'lg',
}: {
  id: EntityId | undefined
  info: PreviewInfo
  size?: 'md' | 'lg'
}) {
  const open = useShareStore((state) => state.open)
  const target = id === undefined ? undefined : embedTargetOf(id)
  if (target === undefined || !canShare(target)) return null
  return (
    <IconButton
      label={`Share ${info.title}`}
      icon={<Share2 />}
      size={size}
      onClick={() => open({ target, info })}
    />
  )
}
