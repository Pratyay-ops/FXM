/** The part of web-ext's programmatic API (web-ext/index.js) that the store scripts use. */
declare module 'web-ext' {
  interface LintMessage {
    code: string
    message: string
    description?: string
    file?: string
  }

  interface LintResult {
    errors: LintMessage[]
    warnings: LintMessage[]
    notices: LintMessage[]
  }

  export const cmd: {
    lint(
      params: Record<string, unknown>,
      options: { shouldExitProgram: boolean },
    ): Promise<LintResult>
  }
}
