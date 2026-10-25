import './embed.css'
import { createPlatform, createSandboxTransport } from '@fxm/platform'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { connectEmbedApi } from './api'
import { EmbedController, type EmbedPlatform, type EmbedServices } from './controller'
import { EmbedApp, InvalidEmbed } from './embed-app'
import { createEmbedServices, embedPlatformOptions, embedSandboxOptions } from './integration'
import { parseEmbedAddress } from './target'
import { applyEmbedTheme } from './theme'

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
 * The providers. The browser tests build the embed with `--mode e2e`, which swaps in test
 * doubles that resolve through the real platform and sandbox (see `e2e/embed`); every other
 * build drops that branch, so no test code ships.
 */
async function loadServices(platform: EmbedPlatform): Promise<EmbedServices> {
  if (import.meta.env.MODE === 'e2e') {
    const { createE2eServices } = await import('./testing/e2e-services')
    return createE2eServices(platform)
  }
  return createEmbedServices(platform)
}

const address = parseEmbedAddress(location.pathname, location.search)
applyEmbedTheme(address.ok ? address.options.theme : 'auto')

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
    createPlatform: openPlatform,
    createServices: loadServices,
  })
  root.render(
    <StrictMode>
      <EmbedApp controller={controller} layout={address.options.layout} origin={location.origin} />
    </StrictMode>,
  )
  connectEmbedApi({
    window,
    controller,
    ...(address.controller === undefined ? {} : { controllerOrigin: address.controller }),
  })
  void controller.start()
}
