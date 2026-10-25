import { APP_NAME, APP_TAGLINE } from '@fxm/core'
import { formatTime } from '@fxm/player'

/** Placeholder until the app shell lands in stage 2.1. */
export function App() {
  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>{APP_TAGLINE}</p>
      <p>
        Under construction. Player preview: {formatTime(0)} / {formatTime(215)}
      </p>
    </main>
  )
}
