import 'react'

declare module 'react' {
  /** Allows CSS custom properties in `style`, e.g. `style={{ '--range-fill': '40%' }}`. */
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined
  }
}
