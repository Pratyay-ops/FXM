/**
 * The Lite tier's opaque-origin transport (stage 1.10): the page's side of the sandbox documents
 * `/sandbox/innertube.html` and `/sandbox/userhost.html`, their errors, and the
 * Content-Security-Policies they are served with. This is the public part; the protocol and the
 * allowlists stay in `document.ts`. See `README.md` in this folder.
 *
 * @module
 */

export { sandboxDocumentHeader, sandboxDocumentPolicy } from './csp'
export type { SandboxErrorCode } from './document'
export {
  isSandboxError,
  type SandboxError,
  SandboxFailedError,
  SandboxRefusedError,
} from './errors'
export {
  type BrowserSandboxTransport,
  createSandboxTransport,
  type SandboxDocumentOptions,
  type SandboxHostWindow,
  type SandboxTransportOptions,
} from './transport'
