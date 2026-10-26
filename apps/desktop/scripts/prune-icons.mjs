// Runs after `tauri icon` (the package's "icons" script). Keeps only the icons that
// tauri.conf.json lists under bundle.icon: `tauri icon` also writes Windows Store, Android
// and iOS icons, which this desktop-only app never uses.
import { readdirSync, readFileSync, rmSync } from 'node:fs'

const iconsDir = new URL('../src-tauri/icons/', import.meta.url)
const config = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
)
const keep = new Set(config.bundle.icon.map((path) => path.replace(/^icons\//, '')))

for (const entry of readdirSync(iconsDir)) {
  if (!keep.has(entry)) rmSync(new URL(entry, iconsDir), { recursive: true })
}
console.log(`Kept ${[...keep].join(', ')}`)
