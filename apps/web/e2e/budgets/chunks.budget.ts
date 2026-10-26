import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from '@playwright/test'
import { PAGES_DIR, REPOSITORY_ROOT } from '../target'
import { type Budget, GROUPS } from './budgets'
import { chunkReport } from './chunks'
import { format, type Measured, report } from './report'

// The chunks of make dist's app against their budgets: the entry chunk, what index.html loads
// before the app runs, and what each lazy feature adds (budgets.ts). No browser: the sizes come
// from the files and make dist's bundle inventory.

test('the chunks stay within their budgets', async () => {
  const inventory = join(dirname(PAGES_DIR), 'inventory', 'app.jsonl')
  if (!existsSync(inventory)) {
    throw new Error(`${inventory} is missing: run make dist (it keeps the inventory there)`)
  }
  // make dist names modules by the real path of the checkout it ran in.
  const chunks = chunkReport(
    join(PAGES_DIR, 'app'),
    inventory,
    realpathSync(REPOSITORY_ROOT),
    GROUPS,
  )
  const files = (list: readonly string[]) =>
    list.length <= 3 ? list.join(', ') : `${list.length} files`
  const measured: Measured[] = [
    {
      budget: 'entry',
      value: chunks.entry.transfer,
      detail: `${files(chunks.entry.files)}, ${format('entry', chunks.entry.raw)} on disk`,
    },
    {
      budget: 'initial',
      value: chunks.initial.transfer,
      detail: `${files(chunks.initial.files)}, ${format('initial', chunks.initial.raw)} on disk`,
    },
    ...GROUPS.map((group): Measured => {
      const sizes = chunks.groups[group.name]
      if (sizes === undefined) throw new Error(`No sizes for ${group.name}`)
      const loaded = sizes.initial.length > 0 ? `; in the first load: ${files(sizes.initial)}` : ''
      return {
        budget: group.name as Budget,
        value: sizes.transfer,
        detail: `${files(sizes.files)}, ${format('entry', sizes.raw)} on disk${loaded}`,
      }
    }),
  ]
  await report(test.info(), 'Chunks', measured, chunks)
})
