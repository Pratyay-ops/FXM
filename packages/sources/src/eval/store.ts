/**
 * Where the evaluation's files live: the labelled set (one JSON file per group, in
 * `packages/core/src/matching/eval/fixtures/groups/`, where the offline replay reads them), the
 * review checklist next to it, and the run's checkpoint in `state/` here (not in git). The
 * recorder writes every file whole, through a temporary file and a rename, so an interrupted run
 * never leaves half a file behind.
 *
 * @module
 */

import { matchingEval } from '@fxm/core'

type EvalGroup = matchingEval.EvalGroup
const { parseEvalGroup } = matchingEval

/** A track an input source gave, as the checkpoint keeps it until its group is written. */
export interface PoolTrack {
  /** The base62 Spotify ID. */
  id: string
  /** The title, with Spotify's suffixes. */
  title: string
  /** The credited names. */
  artists: string[]
  /** The album's name. */
  album?: string
  /** The duration in milliseconds. */
  durationMs?: number
  /** Spotify's explicit mark. */
  explicit?: boolean
  /** The album's release date. */
  releaseDate?: string
}

/** What a run keeps between runs, so that an interrupted one resumes where it stopped. */
export interface EvalCheckpoint {
  /** The format. */
  version: 1
  /**
   * The request budget's storage: its hour of calls and its bulk pause, so a resumed run honours
   * them (see {@link checkpointStorage}).
   */
  budget: Record<string, string>
  /** The inputs phase. */
  inputs: {
    /** The plan the pools were read for. */
    plan?: string
    /** The tracks each input source gave, in order, once read. */
    pools: Record<string, PoolTrack[]>
    /** Inputs that could not be built, by group ID, with why. */
    failed: Record<string, string>
  }
  /** The recording phase. */
  record: {
    /** Groups whose pages are all recorded. */
    done: string[]
    /** Groups that failed for now and are tried again on the next run. */
    deferred: Record<string, { attempts: number; error: string }>
  }
  /** Requests made so far, by service, across runs. */
  requests: { youtube: number; spotify: number; musicbrainz: number }
  /** When it was last written (ISO 8601). */
  updatedAt: string
}

/** A new, empty checkpoint. */
export function emptyCheckpoint(): EvalCheckpoint {
  return {
    version: 1,
    budget: {},
    inputs: { pools: {}, failed: {} },
    record: { done: [], deferred: {} },
    requests: { youtube: 0, spotify: 0, musicbrainz: 0 },
    updatedAt: new Date(0).toISOString(),
  }
}

/** A checkpoint read back, or a new one when it is missing or not one of ours. */
export function parseCheckpoint(value: unknown): EvalCheckpoint {
  const fresh = emptyCheckpoint()
  if (typeof value !== 'object' || value === null) return fresh
  const given = value as Partial<EvalCheckpoint>
  if (given.version !== 1) return fresh
  return {
    version: 1,
    budget: { ...fresh.budget, ...given.budget },
    inputs: {
      ...(given.inputs?.plan === undefined ? {} : { plan: given.inputs.plan }),
      pools: { ...given.inputs?.pools },
      failed: { ...given.inputs?.failed },
    },
    record: {
      done: [...(given.record?.done ?? [])],
      deferred: { ...given.record?.deferred },
    },
    requests: { ...fresh.requests, ...given.requests },
    updatedAt: typeof given.updatedAt === 'string' ? given.updatedAt : fresh.updatedAt,
  }
}

/**
 * The request budget's `KeyValueStorage` (from `@fxm/platform`), kept in the checkpoint: the
 * budget writes its state here on every call, and the state reaches disk with the checkpoint.
 */
export function checkpointStorage(checkpoint: EvalCheckpoint): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
} {
  return {
    getItem: (key) => checkpoint.budget[key] ?? null,
    setItem: (key, value) => {
      checkpoint.budget[key] = String(value)
    },
    removeItem: (key) => {
      delete checkpoint.budget[key]
    },
  }
}

/** Where the evaluation reads and writes its files. */
export interface EvalStore {
  /** Every group's ID, sorted. */
  listGroups(): Promise<string[]>
  /** A group, checked (see `parseEvalGroup`), or `undefined` when it has no file. */
  readGroup(id: string): Promise<EvalGroup | undefined>
  /** Writes a group's file whole. */
  writeGroup(group: EvalGroup): Promise<void>
  /** The checkpoint, or a new one. */
  readCheckpoint(): Promise<EvalCheckpoint>
  /** Writes the checkpoint. */
  writeCheckpoint(checkpoint: EvalCheckpoint): Promise<void>
  /** A text file of the evaluation folder (the review checklist), or `undefined`. */
  readText(name: string): Promise<string | undefined>
  /** Writes a text file of the evaluation folder. */
  writeText(name: string, text: string): Promise<void>
}

/** A group's file name: its ID with the first `:` as `-`, e.g. `sp-0VjIjW4GlUZAMYd2vXMi3b.json`. */
export function groupFileName(id: string): string {
  return `${id.replace(':', '-')}.json`
}

/** A group's ID from its file name, or `undefined` for another file. */
export function groupIdOf(fileName: string): string | undefined {
  const match = /^(sp|fx|csv)-(.+)\.json$/u.exec(fileName)
  return match ? `${match[1]}:${match[2]}` : undefined
}

/** A group as its file holds it: two-space JSON with a final newline. */
export function serializeGroup(group: EvalGroup): string {
  return `${JSON.stringify(group, null, 2)}\n`
}

/** An {@link EvalStore} in memory, for tests. */
export function memoryStore(groups: readonly EvalGroup[] = []): EvalStore & {
  readonly files: Map<string, string>
  readonly texts: Map<string, string>
  checkpoint: EvalCheckpoint
} {
  const files = new Map(groups.map((group) => [group.id, serializeGroup(group)]))
  const texts = new Map<string, string>()
  const store = {
    files,
    texts,
    checkpoint: emptyCheckpoint(),
    listGroups: async () => [...files.keys()].sort(),
    readGroup: async (id: string) => {
      const text = files.get(id)
      return text === undefined ? undefined : parseEvalGroup(JSON.parse(text))
    },
    writeGroup: async (group: EvalGroup) => {
      files.set(group.id, serializeGroup(parseEvalGroup(JSON.parse(serializeGroup(group)))))
    },
    readCheckpoint: async () => parseCheckpoint(JSON.parse(JSON.stringify(store.checkpoint))),
    writeCheckpoint: async (checkpoint: EvalCheckpoint) => {
      store.checkpoint = parseCheckpoint(JSON.parse(JSON.stringify(checkpoint)))
    },
    readText: async (name: string) => texts.get(name),
    writeText: async (name: string, text: string) => {
      texts.set(name, text)
    },
  }
  return store
}

/** The parts of Node's `fs/promises` the file store uses. */
interface NodeFs {
  readFile(path: URL, encoding: 'utf8'): Promise<string>
  writeFile(path: URL, data: string, encoding: 'utf8'): Promise<void>
  rename(from: URL, to: URL): Promise<void>
  mkdir(path: URL, options: { recursive: true }): Promise<unknown>
  readdir(path: URL): Promise<string[]>
}

/** Loads Node's `fs/promises` at run time; this package type-checks as a web worker. */
async function nodeFs(): Promise<NodeFs> {
  const specifier = 'node:fs/promises'
  return (await import(/* @vite-ignore */ specifier)) as NodeFs
}

/** Whether `error` is Node's "no such file or directory". */
function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

/** The evaluation folder in `@fxm/core`, where the labelled set, the report and the checklist live. */
export const EVAL_DIR = new URL('../../../core/src/matching/eval/', import.meta.url)

/** Where runs keep their checkpoint (ignored by git). */
export const STATE_DIR = new URL('./state/', import.meta.url)

/** Options for {@link fileStore}. */
export interface FileStoreOptions {
  /** The evaluation folder: groups go to `fixtures/groups/` in it. Default: {@link EVAL_DIR}. */
  evalDir?: URL
  /** Where the checkpoint goes. Default: {@link STATE_DIR}. */
  stateDir?: URL
}

/** The {@link EvalStore} on disk, through Node's `fs` (Node only: the recorder's runs). */
export function fileStore(options: FileStoreOptions = {}): EvalStore {
  const evalDir = options.evalDir ?? EVAL_DIR
  const groupsDir = new URL('fixtures/groups/', evalDir)
  const stateDir = options.stateDir ?? STATE_DIR
  const checkpointFile = new URL('checkpoint.json', stateDir)

  async function readText(url: URL): Promise<string | undefined> {
    const fs = await nodeFs()
    try {
      return await fs.readFile(url, 'utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  async function writeAtomically(url: URL, text: string): Promise<void> {
    const fs = await nodeFs()
    await fs.mkdir(new URL('.', url), { recursive: true })
    const temporary = new URL(`${url.href}.tmp`)
    await fs.writeFile(temporary, text, 'utf8')
    await fs.rename(temporary, url)
  }

  return {
    async listGroups() {
      const fs = await nodeFs()
      try {
        const names = await fs.readdir(groupsDir)
        return names
          .map(groupIdOf)
          .filter((id): id is string => id !== undefined)
          .sort()
      } catch (error) {
        if (isMissing(error)) return []
        throw error
      }
    },
    async readGroup(id) {
      const text = await readText(new URL(groupFileName(id), groupsDir))
      return text === undefined ? undefined : parseEvalGroup(JSON.parse(text))
    },
    async writeGroup(group) {
      await writeAtomically(new URL(groupFileName(group.id), groupsDir), serializeGroup(group))
    },
    async readCheckpoint() {
      const text = await readText(checkpointFile)
      return parseCheckpoint(text === undefined ? undefined : JSON.parse(text))
    },
    async writeCheckpoint(checkpoint) {
      const stamped = { ...checkpoint, updatedAt: new Date().toISOString() }
      await writeAtomically(checkpointFile, `${JSON.stringify(stamped, null, 2)}\n`)
    },
    readText: (name) => readText(new URL(name, evalDir)),
    writeText: (name, text) => writeAtomically(new URL(name, evalDir), text),
  }
}
