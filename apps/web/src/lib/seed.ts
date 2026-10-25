/** A stable 32-bit FNV-1a hash of a string. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** A hue (0-359) derived from a seed, so placeholder artwork keeps its color. */
export function seedHue(seed: string): number {
  return hashString(seed) % 360
}

/** A two-stop gradient for placeholder artwork and tiles, readable with white text. */
export function seedGradient(seed: string, lightness = 0.5): string {
  const hue = seedHue(seed)
  return `linear-gradient(135deg, oklch(${lightness} 0.15 ${hue}), oklch(${lightness - 0.16} 0.11 ${(hue + 40) % 360}))`
}
