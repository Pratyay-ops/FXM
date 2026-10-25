/**
 * Writes the launcher icons and the splash icon (see icons.ts) into the Android project:
 *
 *   scripts/run.sh pnpm --filter @fxm/mobile icons
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { androidResources } from './icons.ts'
import { encodePng } from './png.ts'

const res = fileURLToPath(new URL('../android/app/src/main/res/', import.meta.url))

function write(path: string, content: string | Buffer) {
  const file = join(res, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  console.log(`wrote android/app/src/main/res/${path}`)
}

const { xml, png } = androidResources()
for (const [path, text] of xml) write(path, text)
for (const [path, image] of png) write(path, encodePng(image))
