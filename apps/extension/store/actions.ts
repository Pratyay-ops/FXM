/**
 * Output for the store scripts, which run as steps of .github/workflows/release.yml: GitHub
 * Actions annotations, step outputs and the job summary. Outside Actions the same calls print
 * plain lines, so a local run reads the same.
 */
import { appendFileSync } from 'node:fs'

export interface Reporter {
  info(message: string): void
  /** A notice annotation: something the owner may want to know, nothing is wrong. */
  notice(title: string, message: string): void
  /** A warning annotation: the job goes on, but something needs the owner's attention. */
  warning(title: string, message: string): void
  error(title: string, message: string): void
  /** A step output (`steps.<id>.outputs.<name>`). */
  output(name: string, value: string): void
  /** Markdown appended to the job summary. */
  summary(markdown: string): void
}

/** Escapes the message of a workflow command (docs: "Workflow commands for GitHub Actions"). */
function escapeData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

/** Escapes a property value of a workflow command, such as `title`. */
function escapeProperty(text: string): string {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C')
}

export interface ReporterOptions {
  env?: NodeJS.ProcessEnv
  /** Standard output and standard error; tests capture them. */
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  appendFile?: (path: string, text: string) => void
}

export function createReporter({
  env = process.env,
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  appendFile = (path, text) => appendFileSync(path, text),
}: ReporterOptions = {}): Reporter {
  const inActions = env.GITHUB_ACTIONS === 'true'
  const annotate = (kind: 'notice' | 'warning' | 'error', title: string, message: string) => {
    if (inActions) {
      stdout(`::${kind} title=${escapeProperty(title)}::${escapeData(message)}`)
    } else {
      stderr(`${kind}: ${title}: ${message}`)
    }
  }
  return {
    info: (message) => stdout(message),
    notice: (title, message) => annotate('notice', title, message),
    warning: (title, message) => annotate('warning', title, message),
    error: (title, message) => annotate('error', title, message),
    output: (name, value) => {
      if (/[\r\n]/.test(value)) throw new Error(`output ${name} must be a single line`)
      if (env.GITHUB_OUTPUT) appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`)
      else stdout(`${name}=${value}`)
    },
    summary: (markdown) => {
      if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
    },
  }
}

/** Waits `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Parses `--name value` options after the subcommand; flags without a value are `'true'`. */
export function parseOptions(args: readonly string[]): Map<string, string> {
  const options = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) {
      options.set(arg.slice(2), 'true')
    } else {
      options.set(arg.slice(2), next)
      i++
    }
  }
  return options
}

/** The value of a required option, or a clear error. */
export function requireOption(options: Map<string, string>, name: string): string {
  const value = options.get(name)
  if (value === undefined || value === 'true') throw new Error(`--${name} <value> is required`)
  return value
}
