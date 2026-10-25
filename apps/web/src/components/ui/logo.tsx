import { APP_NAME } from '@fxm/core'
import { useId } from 'react'
import { cn } from '../../lib/cn'

// Five rounded bars whose tops trace an "M": the FXM mark (same art as the favicon).
const BARS = [
  { x: 4.8, y: 15, height: 9 },
  { x: 9.6, y: 8, height: 16 },
  { x: 14.4, y: 13, height: 11 },
  { x: 19.2, y: 8, height: 16 },
  { x: 24, y: 15, height: 9 },
] as const

export function LogoMark({ className }: { className?: string }) {
  const gradientId = `fxm-mark-${useId().replace(/[^\w-]/g, '')}`
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#5b21b6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradientId})`} />
      <g fill="#ffffff">
        {BARS.map((bar) => (
          <rect key={bar.x} x={bar.x} y={bar.y} width="3.2" height={bar.height} rx="1.6" />
        ))}
      </g>
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('text-xl font-black tracking-tight', className)}>{APP_NAME}</span>
}
