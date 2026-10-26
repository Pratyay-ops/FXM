/**
 * Writes the launcher icons, the splash icon and the notification icon (see icons.ts) into the
 * Android project:
 *
 *   scripts/run.sh pnpm --filter @fxm/mobile icons
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { androidResources, NOTIFICATION_ICON_PATH, notificationIcon } from './icons.ts'
import { encodePng } from './png.ts'

const android = fileURLToPath(new URL('../android/', import.meta.url))

function write(path: string, content: string | Buffer) {
  const file = join(android, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  console.log(`wrote android/${path}`)
}

const { xml, png } = androidResources()
for (const [path, text] of xml) write(`app/src/main/res/${path}`, text)
for (const [path, image] of png) write(`app/src/main/res/${path}`, encodePng(image))
write(NOTIFICATION_ICON_PATH, notificationIcon())
