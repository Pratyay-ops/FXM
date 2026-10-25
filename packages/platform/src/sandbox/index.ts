/**
 * The Lite tier's opaque-origin transport (stage 1.10): the page's side of the sandbox documents
 * `/sandbox/innertube.html` and `/sandbox/userhost.html`, their message protocol and allowlists,
 * and their Content-Security-Policies. See `README.md` in this folder.
 *
 * @module
 */

export {
  SANDBOX_CONNECT_SOURCES,
  type SandboxPolicyOptions,
  sandboxDocumentHeader,
  sandboxDocumentPolicy,
} from './csp'
export {
  checkSandboxRequest,
  INNERTUBE_DOCUMENT_POLICY,
  SANDBOX_DOCUMENT_POLICIES,
  SANDBOX_INNERTUBE_HOSTS,
  SANDBOX_INNERTUBE_PATHS,
  SANDBOX_MARKER_ATTRIBUTE,
  SANDBOX_MESSAGE,
  SANDBOX_PROTOCOL,
  type SandboxDocumentKind,
  type SandboxDocumentPolicy,
  type SandboxErrorCode,
  type SandboxErrorMessage,
  type SandboxRefusal,
  type SandboxRequestFields,
  type SandboxRequestMessage,
  type SandboxResponseMessage,
  USER_HOST_DOCUMENT_POLICY,
} from './document'
export { isSandboxError, isSandboxErrorCode, SANDBOX_ERROR_CODES, SandboxError } from './errors'
export {
  type BrowserSandboxTransport,
  createSandboxTransport,
  defaultSelfTestRequest,
  SANDBOX_DOCUMENT_PATHS,
  SANDBOX_LOAD_TIMEOUT_MS,
  SANDBOX_REPLY_MARGIN_MS,
  SANDBOX_SELF_TEST_CLIENT,
  type SandboxDocumentOptions,
  type SandboxHostWindow,
  type SandboxTransportOptions,
} from './transport'
