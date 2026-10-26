interface ImportMetaEnv {
  /**
   * The distribution this build is for: `standard` in the Android app from GitHub Releases
   * (`release-apk.sh build`), `fdroid` in F-Droid builds (stage R.3), otherwise empty.
   * vite.config.ts builds it in from the `FXM_DISTRIBUTION` environment variable; read it with
   * `parseDistribution` of `@fxm/platform`, or with `isGitHubReleasesBuild`
   * (features/app-update/support.ts), which only `standard` passes.
   */
  readonly FXM_DISTRIBUTION?: string
}
