/**
 * The Linux desktop app's AppStream metainfo and desktop entry, under the Flatpak ID
 * (`io.github.pratyay_ops.FXM.metainfo.xml` and `.desktop` in this folder). Flathub wants both
 * kept upstream, in FXM's repository, and checks them with appstreamcli and
 * desktop-file-validate (Flathub's "Requirements" and "MetaInfo guidelines", read 2026-10-26).
 * Software centres such as GNOME Software and KDE Discover read the same metainfo from a `.deb`.
 * `channels sync` writes both from ../listing.ts. The copy in the repository names no release;
 * the copy that `channels flatpak` puts next to a release's manifest names that release.
 *
 * @module
 */

import {
  APP_NAME,
  DESKTOP_BINARY,
  DEVELOPER,
  description,
  FLATPAK_ID,
  ISSUES_URL,
  KEYWORDS,
  LICENSE,
  REPO_URL,
  SITE_URL,
  SUMMARY,
} from '../listing.ts'
import { releasePageUrl, type Version } from '../version.ts'

/** The files, from the repository's root. */
export const METAINFO_FILE = `packaging/flatpak/${FLATPAK_ID}.metainfo.xml`
export const DESKTOP_FILE = `packaging/flatpak/${FLATPAK_ID}.desktop`

/** The app's icon: the desktop app's SVG mark, installed under the Flatpak ID. */
export const ICON_SOURCE = 'apps/desktop/assets/icon.svg'

/**
 * Brand colours for software centres' banners, from FXM's own palette: a light violet behind the
 * violet icon in light mode, FXM's dark background in dark mode. Never a service's colours.
 */
export const BRANDING = { light: '#ddd6fe', dark: '#0b0b0f' } as const

/** freedesktop.org menu categories: a music player. */
export const CATEGORIES = ['AudioVideo', 'Audio', 'Player'] as const

/** Text for XML: `&`, `<` and `>` escaped (attribute values here never hold quotes). */
export function xmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** A release, as the metainfo names it. */
export interface MetainfoRelease {
  readonly version: Version
  /** The day it was published, `YYYY-MM-DD`. */
  readonly date: string
  /** Its notes: the first paragraph of its summary (docs/releases/vX.Y.Z.md), if any. */
  readonly note?: string
}

/** The metainfo, naming `release` when one is given. */
export function metainfoXml(release?: MetainfoRelease): string {
  const { intro, features, paragraphs } = description('desktop')
  const p = (text: string) => `    <p>${xmlText(text)}</p>`
  const releaseLines =
    release === undefined
      ? []
      : [
          '  <releases>',
          `    <release version="${release.version.text}" date="${release.date}">`,
          `      <url type="details">${xmlText(releasePageUrl(REPO_URL, release.version))}</url>`,
          ...(release.note === undefined
            ? []
            : [
                '      <description>',
                `        <p>${xmlText(release.note)}</p>`,
                '      </description>',
              ]),
          '    </release>',
          '  </releases>',
        ]
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    release === undefined
      ? '<!-- Written by `channels sync` from packaging/listing.ts: edit that. -->'
      : `<!-- Written by \`channels flatpak\` for FXM ${release.version.text} from packaging/listing.ts. -->`,
    '<component type="desktop-application">',
    `  <id>${FLATPAK_ID}</id>`,
    '  <metadata_license>CC0-1.0</metadata_license>',
    `  <project_license>${LICENSE}</project_license>`,
    `  <name>${xmlText(APP_NAME)}</name>`,
    `  <summary>${xmlText(SUMMARY)}</summary>`,
    `  <developer id="io.github.pratyay_ops">`,
    `    <name>${xmlText(DEVELOPER)}</name>`,
    '  </developer>',
    '  <description>',
    p(intro),
    '    <ul>',
    ...features.map((feature) => `      <li>${xmlText(feature)}</li>`),
    '    </ul>',
    ...paragraphs.map(p),
    '  </description>',
    `  <launchable type="desktop-id">${FLATPAK_ID}.desktop</launchable>`,
    '  <provides>',
    `    <binary>${DESKTOP_BINARY}</binary>`,
    '  </provides>',
    `  <url type="homepage">${xmlText(SITE_URL)}</url>`,
    `  <url type="bugtracker">${xmlText(ISSUES_URL)}</url>`,
    `  <url type="vcs-browser">${xmlText(REPO_URL)}</url>`,
    '  <categories>',
    ...CATEGORIES.map((category) => `    <category>${category}</category>`),
    '  </categories>',
    '  <keywords>',
    ...KEYWORDS.map((keyword) => `    <keyword>${xmlText(keyword)}</keyword>`),
    '  </keywords>',
    '  <branding>',
    `    <color type="primary" scheme_preference="light">${BRANDING.light}</color>`,
    `    <color type="primary" scheme_preference="dark">${BRANDING.dark}</color>`,
    '  </branding>',
    '  <content_rating type="oars-1.1"/>',
    '  <supports>',
    '    <control>keyboard</control>',
    '    <control>pointing</control>',
    '    <control>touch</control>',
    '  </supports>',
    '  <requires>',
    // The window's minimum width (tauri.conf.json): the web app is laid out for phones up.
    '    <display_length compare="ge">360</display_length>',
    '  </requires>',
    ...releaseLines,
    '</component>',
    '',
  ].join('\n')
}

/** The desktop entry, which launches the app from the menu and names its icon. */
export function desktopEntry(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    'GenericName=Music Player',
    `Comment=${SUMMARY}`,
    `Exec=${DESKTOP_BINARY}`,
    `Icon=${FLATPAK_ID}`,
    'Terminal=false',
    `Categories=${CATEGORIES.join(';')};`,
    `Keywords=${KEYWORDS.join(';')};`,
    'StartupNotify=true',
    'SingleMainWindow=true',
    '',
  ].join('\n')
}
