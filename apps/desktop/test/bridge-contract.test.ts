import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MEDIA_ACTIONS,
  PLAYBACK_LOCK,
  PLAYBACK_STATES,
  SHELL_COMMANDS,
  SHELL_EVENTS,
} from '../bridge'

// Keeps the bridge (bridge/) in step with the desktop shell's Rust side (src-tauri/src/), whose
// sources are read as text, so this runs in `make test` without a Rust toolchain.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const withoutComments = (source: string) => source.replace(/\/\/.*$/gm, '')
const rust = (file: string) => withoutComments(read(`../src-tauri/src/${file}`))

/** The string value of `pub const NAME: &str = "…";` in a Rust source. */
function rustConst(source: string, name: string): string | undefined {
  return new RegExp(`pub const ${name}: &str = "([^"]*)";`).exec(source)?.[1]
}

/** The variants of a fieldless `pub enum`, in lower case, as serde names them. */
function enumVariants(source: string, name: string): string[] {
  const body = new RegExp(String.raw`pub enum ${name} \{([^}]*)\}`).exec(source)?.[1] ?? ''
  // Each variant on a line of its own, after its documentation and attributes.
  return [...body.matchAll(/^\s*(\w+),$/gm)].map(([, variant = '']) => variant.toLowerCase())
}

/** The arguments of a Rust command, as the web app names them (Tauri expects camelCase). */
function commandArguments(source: string, command: string): string[] {
  const signature = new RegExp(String.raw`pub fn ${command}(?:<[^>]*>)?\(([^)]*)\)`).exec(source)
  // Without generic arguments, whose commas (`State<'_, Playback>`) would split a parameter.
  let list = signature?.[1] ?? ''
  while (/<[^<>]*>/.test(list)) list = list.replace(/<[^<>]*>/g, '')
  const parameters = list.split(',').map((parameter) => parameter.trim())
  return parameters
    .filter((parameter) => parameter !== '' && !/:\s*(?:AppHandle|State)\b/.test(parameter))
    .map((parameter) => parameter.split(':')[0]?.trim() ?? '')
}

describe('the bridge and the shell agree on', () => {
  it('the event that carries a media action from the tray', () => {
    expect(rustConst(rust('tray.rs'), 'MEDIA_ACTION_EVENT')).toBe(SHELL_EVENTS.mediaAction)
  })

  it('the media actions, which Rust sends in lower case', () => {
    const tray = rust('tray.rs')
    expect(tray).toMatch(/#\[serde\(rename_all = "lowercase"\)\]\s*pub enum MediaAction/)
    expect(enumVariants(tray, 'MediaAction')).toEqual([...MEDIA_ACTIONS])
  })

  it('the event that says the network changed', () => {
    expect(rustConst(rust('network.rs'), 'NETWORK_EVENT')).toBe(SHELL_EVENTS.networkChange)
  })

  it('the commands, and the arguments the bridge sends them', () => {
    const playback = rust('playback.rs')
    const environment = rust('environment.rs')
    expect(playback).toContain(`pub fn ${SHELL_COMMANDS.setNowPlaying}<`)
    expect(commandArguments(playback, SHELL_COMMANDS.setNowPlaying)).toEqual(['now'])
    expect(environment).toContain(`pub fn ${SHELL_COMMANDS.environment}<`)
    expect(commandArguments(environment, SHELL_COMMANDS.environment)).toEqual([])
  })

  it('the fields of what plays, which Rust reads in camelCase and nothing more', () => {
    const playback = rust('playback.rs')
    expect(playback).toMatch(
      /#\[serde\(rename_all = "camelCase", deny_unknown_fields\)\]\s*pub struct NowPlaying/,
    )
    const fields = /pub struct NowPlaying \{([^}]*)\}/.exec(playback)?.[1] ?? ''
    expect([...fields.matchAll(/pub (\w+):/g)].map(([, name]) => name)).toEqual([
      'state',
      'title',
      'artist',
    ])
  })

  it('the states of the player, which Rust reads in lower case', () => {
    const playback = rust('playback.rs')
    expect(playback).toMatch(/#\[serde\(rename_all = "lowercase"\)\]\s*pub enum PlayState/)
    expect(enumVariants(playback, 'PlayState')).toEqual([...PLAYBACK_STATES])
  })

  it('the fields of the environment, which Rust writes in camelCase', () => {
    const environment = rust('environment.rs')
    const fields = /pub struct DesktopEnvironment \{([^}]*)\}/.exec(environment)?.[1] ?? ''
    const camel = (name = '') => name.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase())
    expect([...fields.matchAll(/pub (\w+):/g)].map(([, name]) => camel(name))).toEqual([
      'os',
      'osVersion',
      'webviewVersion',
      'tray',
    ])
  })
})

describe('src/lib.rs', () => {
  const lib = rust('lib.rs')

  it('builds the tray, except in the smoke build, which runs unattended', () => {
    expect(lib).toMatch(
      /#\[cfg\(not\(feature = "smoke"\)\)\]\s*if let Err\(error\) = tray::create\(/,
    )
  })

  it('leaves the single-instance plugin out of the smoke build, so overlapping runs never meet', () => {
    expect(lib).toMatch(
      /#\[cfg\(not\(feature = "smoke"\)\)\]\s*let builder = builder\.plugin\(tauri_plugin_single_instance::init\(/,
    )
  })

  it('handles the close button and the Dock icon in src/window.rs', () => {
    expect(lib).toMatch(/\.on_window_event\(window::on_window_event\)/)
    expect(lib).toMatch(/\.run\(\|app, event\| window::on_run_event\(app, &event\)\)/)
    // The hide that waits for the window to leave full screen (macOS).
    expect(lib).toMatch(/app\.manage\(window::PendingHide::default\(\)\)/)
  })

  it('adds Window > FXM to the macOS app menu, which brings a hidden window back', () => {
    expect(lib).toMatch(
      /#\[cfg\(target_os = "macos"\)\]\s*let builder = builder\s*\.menu\(window::app_menu\)\s*\.on_menu_event\(\|app, event\| window::on_menu_event\(app, event\.id\(\)\.as_ref\(\)\)\)/,
    )
  })

  it('watches the network for the stream lifecycle', () => {
    expect(lib).toMatch(/network::watch\(app\.handle\(\)\.clone\(\)\)/)
  })
})

describe('the Web Lock', () => {
  it('has a name of its own', () => {
    expect(PLAYBACK_LOCK).toBe('fxm-background-playback')
  })
})
