/**
 * Downloads in the background on Android (stage 6.4). The download manager runs in the WebView's
 * JavaScript, which Android freezes in an app it has cached: an app in the background without a
 * foreground service. So while the queue has work, the app runs a `dataSync` foreground service
 * with a progress notification (`FxmDownloads.setBackground`), which keeps the process, and the
 * page with it, going, also with the screen off; it stops a few seconds after the queue runs dry.
 *
 * @module
 */

import type { DownloadNetwork } from '../manager'
import type { DownloadStore } from '../store'
import type { FxmDownloadsPlugin, FxmDownloadsQueueReport } from './plugin'

/** Options for {@link connectBackgroundDownloads}. */
export interface BackgroundDownloadsOptions {
  /** The plugin. */
  plugin: Pick<FxmDownloadsPlugin, 'setBackground'>
  /** The download records, whose statuses say whether the queue has work. */
  store: Pick<DownloadStore, 'list' | 'subscribe'>
  /** Whether the device is online. */
  network: DownloadNetwork
}

/** What the queue holds: the counts the service needs, and a song to name. */
async function queueReport(
  store: Pick<DownloadStore, 'list'>,
  online: boolean,
): Promise<FxmDownloadsQueueReport> {
  const records = await store.list(['downloading', 'queued'])
  const downloading = records.filter((record) => record.status === 'downloading')
  const title = downloading[0]?.track.title
  return {
    downloading: downloading.length,
    queued: records.length - downloading.length,
    online,
    ...(title === undefined ? {} : { title }),
  }
}

/**
 * Reports the download queue to the app whenever it changes (a download starts, ends, is queued
 * or paused; the device goes on or offline), so the foreground service runs while the queue has
 * work. Call it where the manager runs the queue. Returns a function that stops it and reports
 * an empty queue, so the service stops too.
 */
export function connectBackgroundDownloads(options: BackgroundDownloadsOptions): () => void {
  const { plugin, store, network } = options
  let sent: string | undefined
  let stopped = false
  let pending = false
  let again = false

  const send = (report: FxmDownloadsQueueReport) => {
    const key = JSON.stringify(report)
    if (key === sent) return
    sent = key
    void plugin.setBackground(report).catch(() => {
      // The next change reports again.
      sent = undefined
    })
  }

  const update = () => {
    if (stopped) return
    if (pending) {
      again = true
      return
    }
    pending = true
    queueReport(store, network.online)
      .then((report) => {
        if (!stopped) send(report)
      })
      .catch(() => {
        // The store failed (IndexedDB went away): the next change tries again.
      })
      .finally(() => {
        pending = false
        if (again) {
          again = false
          update()
        }
      })
  }

  const stops = [store.subscribe(update), network.subscribe(update)]
  update()
  return () => {
    if (stopped) return
    stopped = true
    for (const stop of stops) stop()
    send({ downloading: 0, queued: 0, online: network.online })
  }
}
