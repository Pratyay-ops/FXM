/**
 * The conversion worker (stage 4.2): FXM's ffmpeg core runs here, off the page, loaded from the
 * app's `ffmpeg/` folder on first use. The page talks to it through `@fxm/convert`'s
 * `createConverter` (converter.ts).
 *
 * @module
 */

import { type ConversionWorkerScope, serveConversions } from '@fxm/convert/worker'

// The worker's global scope, typed by hand: the app's TypeScript program has the DOM library.
serveConversions(globalThis as unknown as ConversionWorkerScope)
