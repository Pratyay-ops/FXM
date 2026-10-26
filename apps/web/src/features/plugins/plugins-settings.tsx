import {
  PACKAGE_LIMITS,
  PLUGINS_CONSENT,
  type PluginEntry,
  type PluginOffer,
  type PluginRegistry,
} from '@fxm/plugins'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { currentDevice, type DeviceInfo } from '../connect/device'
import { showStatus } from '../library/status'
import { SettingSwitch } from '../settings/setting-switch'
import { SettingRow, SettingsSection } from '../settings/settings-layout'
import { AddressDialog, OfferDialog, RemoveDialog } from './plugin-dialogs'
import {
  operationsSentences,
  originText,
  pluginFailureText,
  pluginTitle,
  problemText,
} from './plugin-text'
import { usePluginsSettingsStore } from './plugins-store'
import {
  announcePluginChange,
  currentPluginSupport,
  getPluginRegistry,
  pluginDownloadFetch,
  pluginsNeedOptIn,
  pluginWorkersRun,
  startPlugins,
  stopPlugins,
} from './runtime'

const NO_ENTRIES: readonly PluginEntry[] = []

/**
 * Why this browser offers no plugins, where its evaluator document can't start their workers
 * (`pluginWorkersRun`): every browser on iPhone and iPad, and Safari elsewhere.
 */
export function cantRunPluginsText(device: DeviceInfo): string {
  if (device.os === 'ios') {
    return 'Plugins can’t run on iPhone and iPad yet: no browser there can start the separate worker FXM runs each plugin in.'
  }
  return 'Plugins can’t run in this browser yet: it can’t start the separate worker FXM runs each plugin in, as Safari can’t. They run in Chrome, Edge, Brave and Firefox.'
}

/** Whether plugins can run in this browser (`pluginWorkersRun`), `undefined` while FXM checks. */
function usePluginWorkers(): boolean | undefined {
  const [runs, setRuns] = useState<boolean>()
  useEffect(() => {
    let live = true
    void pluginWorkersRun().then((answer) => {
      if (live) setRuns(answer)
    })
    return () => {
      live = false
    }
  }, [])
  return runs
}

/** The registry's plugins, live. */
function useEntries(registry: PluginRegistry): readonly PluginEntry[] {
  return useSyncExternalStore(registry.subscribe, registry.entries, () => NO_ENTRIES)
}

/** One installed plugin: what it is and may contact, its switch, its update check, Remove. */
function PluginRow({
  entry,
  registry,
  onOffer,
  onRemove,
}: {
  entry: PluginEntry
  registry: PluginRegistry
  onOffer: (offer: PluginOffer) => void
  onRemove: (entry: PluginEntry) => void
}) {
  const nameId = useId()
  const detailsId = useId()
  const [checking, setChecking] = useState(false)
  const { manifest, name } = entry
  return (
    <li className="space-y-3 p-4 sm:p-5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p id={nameId} className="font-semibold">
            {pluginTitle(entry)}
          </p>
          <div id={detailsId} className="mt-1 space-y-1 text-sm text-text-muted">
            {manifest?.author !== undefined && <p>By {manifest.author}</p>}
            {manifest?.description !== undefined && <p>{manifest.description}</p>}
            {entry.problem === undefined ? (
              <>
                {operationsSentences(entry.manifest.provides, '').map((sentence) => (
                  <p key={sentence}>{sentence}</p>
                ))}
                <p className="wrap-anywhere">
                  {entry.manifest.hosts.length === 0
                    ? 'Contacts no addresses.'
                    : `Contacts ${entry.manifest.hosts.join(', ')}.`}
                </p>
              </>
            ) : (
              <p className="font-semibold text-danger">{problemText(entry.problem)}</p>
            )}
            <p className="wrap-anywhere">{originText(entry.origin)}.</p>
          </div>
        </div>
        {entry.problem === undefined && (
          <SettingSwitch
            labelledBy={nameId}
            describedBy={detailsId}
            checked={entry.enabled}
            onChange={(enabled) => {
              registry.setEnabled(entry.id, enabled).then(
                () => {
                  announcePluginChange()
                  showStatus(`${name} is ${enabled ? 'on' : 'off'}`)
                },
                (error: unknown) => showStatus(pluginFailureText(error)),
              )
            }}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        {entry.origin.kind === 'url' && (
          <button
            type="button"
            aria-label={`Check for an update of ${name}`}
            aria-disabled={checking}
            className={buttonClasses({ variant: 'secondary' })}
            onClick={() => {
              if (checking) return
              setChecking(true)
              pluginDownloadFetch()
                .then((fetch) => registry.checkForUpdate(entry.id, fetch))
                .then(
                  (offer) => {
                    setChecking(false)
                    if (offer === undefined) showStatus(`${pluginTitle(entry)} is up to date`)
                    else onOffer(offer)
                  },
                  (error: unknown) => {
                    setChecking(false)
                    showStatus(pluginFailureText(error))
                  },
                )
            }}
          >
            {checking ? 'Checking…' : 'Check for an update'}
          </button>
        )}
        <button
          type="button"
          aria-label={`Remove ${name}`}
          className={buttonClasses({ variant: 'ghost' })}
          onClick={() => onRemove(entry)}
        >
          Remove
        </button>
      </div>
    </li>
  )
}

/** The plugins: how to add one, and the installed ones. */
function PluginManager() {
  const registry = getPluginRegistry()
  const entries = useEntries(registry)
  const [askingAddress, setAskingAddress] = useState(false)
  const [offer, setOffer] = useState<PluginOffer>()
  const [removing, setRemoving] = useState<PluginEntry>()
  const fileInput = useRef<HTMLInputElement>(null)
  const helpId = useId()
  const listLabelId = useId()
  const runs = usePluginWorkers()
  const device = useMemo(currentDevice, [])

  useEffect(() => {
    void startPlugins()
  }, [])

  async function install(approved: PluginOffer) {
    const entry = await registry.install(approved)
    announcePluginChange()
    setOffer(undefined)
    showStatus(
      approved.current === undefined
        ? `Added ${entry.name}`
        : `Updated ${entry.name} to ${entry.version ?? approved.package.manifest.version}`,
    )
  }

  async function readFile(file: File) {
    if (file.size > PACKAGE_LIMITS.file) {
      showStatus(`${file.name} is too large for a plugin file.`)
      return
    }
    try {
      const text = await file.text()
      setOffer(await registry.offerFromFile(text, file.name))
    } catch (error) {
      showStatus(pluginFailureText(error))
    }
  }

  return (
    <>
      <div className="space-y-4 p-4 sm:p-5">
        <div id={helpId} className="space-y-2 text-sm text-text-muted">
          <p>
            Plugins add music sources and audio that other people write. FXM comes with none and
            suggests none: you add one from an address or a file its author gives you, after FXM
            shows you which addresses it can contact.
          </p>
          <p>
            Each plugin runs apart from the app, sends its requests only to the addresses it lists
            (though the servers its songs play from may pass the audio on to other hosts), and is
            updated only when you approve the update.
          </p>
        </div>
        {runs === false ? (
          // WebKit: every plugin would fail with "Plugins can't run in this browser".
          <p className="text-sm font-semibold text-text">{cantRunPluginsText(device)}</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              aria-describedby={helpId}
              aria-disabled={runs === undefined}
              className={buttonClasses({ variant: 'secondary' })}
              onClick={() => {
                if (runs === true) setAskingAddress(true)
              }}
            >
              Add from an address
            </button>
            <button
              type="button"
              aria-describedby={helpId}
              aria-disabled={runs === undefined}
              className={buttonClasses({ variant: 'secondary' })}
              onClick={() => {
                if (runs === true) fileInput.current?.click()
              }}
            >
              Add from a file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              data-testid="plugin-file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file !== undefined) void readFile(file)
              }}
            />
            {runs === undefined && (
              <p role="status" className="basis-full text-sm text-text-muted">
                Checking whether plugins can run in this browser…
              </p>
            )}
          </div>
        )}
      </div>
      {entries.length > 0 && (
        <div>
          <p id={listLabelId} className="sr-only">
            Installed plugins
          </p>
          <ul
            aria-labelledby={listLabelId}
            className="divide-y divide-border border-t border-border"
          >
            {entries.map((entry) => (
              <PluginRow
                key={entry.id}
                entry={entry}
                registry={registry}
                onOffer={setOffer}
                onRemove={setRemoving}
              />
            ))}
          </ul>
        </div>
      )}
      <AddressDialog
        open={askingAddress}
        onClose={() => setAskingAddress(false)}
        fetchOffer={async (address, signal) =>
          registry.offerFromAddress(address, await pluginDownloadFetch(), { signal })
        }
        onOffer={(next) => {
          setAskingAddress(false)
          setOffer(next)
        }}
      />
      <OfferDialog offer={offer} onClose={() => setOffer(undefined)} onInstall={install} />
      <RemoveDialog
        entry={removing}
        onClose={() => setRemoving(undefined)}
        onRemove={(entry) => {
          registry.remove(entry.id).then(
            () => {
              announcePluginChange()
              showStatus(`Removed ${entry.name}`)
            },
            (error: unknown) => showStatus(pluginFailureText(error)),
          )
        }}
      />
    </>
  )
}

/**
 * The opt-in of an F-Droid build, with the wording F-Droid's inclusion policy requires: plugins
 * stay off, and FXM downloads none, until the user picks "Turn on". Both answers are buttons of
 * the same style, and neither is preselected.
 */
function OptIn({ onAccept }: { onAccept: () => void }) {
  const [declined, setDeclined] = useState(false)
  const titleId = useId()
  if (declined) {
    return (
      <SettingRow
        label="Plugins"
        labelId={titleId}
        help={<p className="text-sm text-text-muted">Off.</p>}
      >
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary' })}
          onClick={() => setDeclined(false)}
        >
          Turn on plugins…
        </button>
      </SettingRow>
    )
  }
  return (
    <fieldset className="min-w-0 space-y-3 p-4 sm:p-5">
      <legend className="float-left w-full font-semibold">{PLUGINS_CONSENT.title}</legend>
      <div className="clear-left space-y-2 text-sm text-text-muted">
        {PLUGINS_CONSENT.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary' })}
          onClick={onAccept}
        >
          {PLUGINS_CONSENT.accept}
        </button>
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary' })}
          onClick={() => setDeclined(true)}
        >
          {PLUGINS_CONSENT.decline}
        </button>
      </div>
    </fieldset>
  )
}

/**
 * Settings → Plugins (stage 8.3): add a plugin from an address or a file, after seeing what it
 * may contact; switch plugins on and off, check for updates (installed only once approved) and
 * remove them. F-Droid builds ask first. In the desktop and Android apps it says plugins come
 * later.
 */
export function PluginsSettings() {
  const optedIn = usePluginsSettingsStore((state) => state.optedIn)
  const setOptedIn = usePluginsSettingsStore((state) => state.setOptedIn)
  const settingId = useId()
  const settingHelpId = useId()
  const support = currentPluginSupport()
  const needsOptIn = pluginsNeedOptIn()

  return (
    <SettingsSection title="Plugins">
      {support !== 'supported' ? (
        <p className="p-4 text-sm text-text-muted sm:p-5">
          Plugins work in the web app for now. The desktop and Android apps get them in a later
          version.
        </p>
      ) : needsOptIn && !optedIn ? (
        <OptIn
          onAccept={() => {
            setOptedIn(true)
            void startPlugins()
          }}
        />
      ) : (
        <>
          {needsOptIn && (
            <SettingRow
              label={PLUGINS_CONSENT.setting}
              labelId={settingId}
              help={
                <p id={settingHelpId} className="text-sm text-text-muted">
                  On. Turning plugins off stops every plugin; they stay installed.
                </p>
              }
            >
              <SettingSwitch
                labelledBy={settingId}
                describedBy={settingHelpId}
                checked
                onChange={() => {
                  stopPlugins()
                  setOptedIn(false)
                }}
              />
            </SettingRow>
          )}
          <PluginManager />
        </>
      )}
    </SettingsSection>
  )
}
