interface ImportMetaEnv {
  /**
   * The distribution this build is for: `fdroid` in F-Droid builds (stage R.3), otherwise empty
   * or `standard`. vite.config.ts builds it in from the `FXM_DISTRIBUTION` environment variable;
   * read it with `parseDistribution` of `@fxm/platform`.
   */
  readonly FXM_DISTRIBUTION?: string
}
