import './embed.css'
import { createPlatform, createSandboxTransport } from '@fxm/platform'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { connectEmbedApi } from './api'
import { EmbedController, type EmbedPlatform, type EmbedServices } from './controller'
import { EmbedApp, InvalidEmbed } from './embed-app'
import { createEmbedServices, embedPlatformOptions, embedSandboxOptions } from './integration'
import { type EmbedTarget, parseEmbedAddress } from './target'
import { applyEmbedTheme } from './theme'
import { watchVisibility } from './visibility'
import { isWired } from './wired'

/**
 * The platform for the visitor's browser: FXM Connect when it applies, else the Lite tier's
 * sandbox documents (framed only for YouTube content, whose self-test costs one InnerTube call),
 * else free sources only.
 */
async function openPlatform({ youtube }: { youtube: boolean }): Promise<EmbedPlatform> {
  const sandbox = youtube ? createSandboxTransport(embedSandboxOptions()) : undefined
  try {
    const platform = await createPlatform({
      ...embedPlatformOptions(),
      ...(sandbox === undefined ? {} : { sandbox }),
    })
    // The platform runs the Lite self-test in the background. The player decides from the tier
    // what it can play, so it waits for the test (at most its timeout): otherwise it would show
    // the install hint first, and tell the page it can't play, wherever Lite works.
    if (sandbox !== undefined) await platform.capabilities.refresh().catch(() => undefined)
    return {
      capabilities: platform.capabilities,
      context: (options) => platform.context(options),
      dispose: () => {
        platform.dispose()
        sandbox?.dispose()
      },
    }
  } catch (error) {
    sandbox?.dispose()
    throw error
  }
}

/**
 * Whether the providers can load what the address names: a source `integration.ts` wires in.
 * The browser tests build the embed with `--mode e2e`, which swaps in test doubles that resolve
 * through the real platform and sandbox (see `e2e/embed`); every other build drops that branch,
 * so no test code ships.
 */
async function canLoad(target: EmbedTarget): Promise<boolean> {
  if (import.meta.env.MODE === 'e2e') {
    const { E2E_SOURCES } = await import('./testing/e2e-services')
    return isWired(target, E2E_SOURCES)
  }
  return isWired(target)
}

/** The providers, or in the browser tests' build their test doubles (see {@link canLoad}). */
async function loadServices(platform: EmbedPlatform): Promise<EmbedServices> {
  if (import.meta.env.MODE === 'e2e') {
    const { createE2eServices } = await import('./testing/e2e-services')
    return createE2eServices(platform)
  }
  return createEmbedServices(platform)
}

const address = parseEmbedAddress(location.pathname, location.search)
applyEmbedTheme(address.ok ? address.options.theme : 'auto')
// Opened as a page of its own (a shared player link) rather than in another site's frame.
const standalone = window.self === window.top
if (standalone) document.documentElement.dataset.standalone = ''

const container = document.getElementById('root')
if (!container) throw new Error('embed/index.html is missing the #root element')
const root = createRoot(container)

if (!address.ok) {
  root.render(
    <StrictMode>
      <InvalidEmbed origin={location.origin} />
    </StrictMode>,
  )
} else {
  const controller = new EmbedController({
    target: address.target,
    mode: address.options.mode,
    canLoad,
    createPlatform: openPlatform,
    createServices: loadServices,
  })
  root.render(
    <StrictMode>
      <EmbedApp
        controller={controller}
        layout={address.options.layout}
        origin={location.origin}
        standalone={standalone}
      />
    </StrictMode>,
  )
  // At top level there is no embedding page, so no API (and nothing to watch for it).
  if (!standalone) {
    connectEmbedApi({
      window,
      controller,
      visibility: watchVisibility(document.documentElement, window),
      ...(address.controller === undefined ? {} : { controllerOrigin: address.controller }),
    })
  }
  void controller.start()
}
