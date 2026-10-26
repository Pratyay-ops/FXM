/**
 * Test helpers for code that drives downloads: `@fxm/downloads/testing`. Nothing here touches
 * the network or real storage. The memory store and storage are in the main entry
 * (`createMemoryDownloadStore`, `createMemoryDownloadStorage`).
 *
 * @module
 */

export * from './fake-fxm-downloads'
export { FakeNetwork } from './fake-network'
export {
  type DownloadResolveHandler,
  downloadCandidate,
  downloadStream,
  FakeDownloadResolver,
  type FakeDownloadResolverCall,
} from './fake-resolver'
export {
  type FakeMediaFile,
  type FakeMediaRequest,
  type FakeMediaRules,
  FakeMediaServer,
  type FakeMediaServerOptions,
  testBytes,
} from './fake-server'
