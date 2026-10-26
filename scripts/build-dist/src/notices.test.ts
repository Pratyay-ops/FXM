import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addsToLicence,
  copyrightHolders,
  fileNotices,
  isLicenceFileName,
  isNotice,
  leadingComment,
  licenceFiles,
  packageNotices,
} from './notices.ts'
import { removeTempDirs, tempDir, writeFiles } from './testing.ts'

afterEach(removeTempDirs)

const GOOGLE_BSD = `// Copyright 2008 Google Inc.  All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met.
export function varint() {}
`

const BUF_APACHE = (years: string) => `// Copyright ${years} Buf Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
export const x = 1
`

describe('licence files', () => {
  it.each([
    'LICENSE',
    'license',
    'LICENCE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENSE-MIT',
    'LICENSE-MIT.txt',
    'LICENSE_MIT',
    'LICENSE_APACHE-2.0',
    'LICENSE.APACHE2',
    'LICENSE.BSD',
    'COPYING',
    'NOTICE',
    'NOTICE.txt',
  ])('reads %s as a licence text', (name) => {
    expect(isLicenceFileName(name)).toBe(true)
  })

  it.each([
    'LICENSE.spdx',
    'license.js',
    'license.d.ts',
    'license.json',
    'licenses',
    'README.md',
    'unlicense-notes.md',
  ])('never reads %s as one', (name) => {
    expect(isLicenceFileName(name)).toBe(false)
  })

  it('lists a package’s licence files with their texts, without SPDX metadata or folders', () => {
    const dir = tempDir()
    writeFiles(dir, {
      LICENSE_MIT: 'MIT License\n\nCopyright (c) Tauri\n',
      'LICENSE_APACHE-2.0': '  Apache License  \n',
      'LICENSE.spdx': 'SPDXVersion: SPDX-2.1\nPackageLicenseDeclared: MIT\n',
      'license/README.md': 'a folder, not a file',
      'index.js': '',
    })
    expect(licenceFiles(dir)).toEqual([
      { name: 'LICENSE_APACHE-2.0', text: 'Apache License' },
      { name: 'LICENSE_MIT', text: 'MIT License\n\nCopyright (c) Tauri' },
    ])
  })
})

describe('leadingComment', () => {
  it('reads a run of line comments, or one block comment, without the comment marks', () => {
    expect(leadingComment(GOOGLE_BSD)).toBe(
      'Copyright 2008 Google Inc.  All rights reserved.\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met.',
    )
    expect(
      leadingComment(
        '/**\n * @license React\n *\n * Copyright (c) Meta Platforms, Inc. and affiliates.\n */\n"use strict";',
      ),
    ).toBe('@license React\n\nCopyright (c) Meta Platforms, Inc. and affiliates.')
  })

  it('looks past a hashbang, use strict, blank lines and one-line imports', () => {
    // Rollup puts a file's imports above its licence header (@tauri-apps/plugin-http's dist-js).
    const code = [
      '#!/usr/bin/env node',
      '',
      "import { invoke } from '@tauri-apps/api/core';",
      "import './side-effect.js'",
      '"use strict";',
      '',
      '// Copyright 2019-2023 Tauri Programme within The Commons Conservancy',
      '// SPDX-License-Identifier: MIT',
      'export function fetch() {}',
    ].join('\n')
    expect(leadingComment(code)).toBe(
      'Copyright 2019-2023 Tauri Programme within The Commons Conservancy\nSPDX-License-Identifier: MIT',
    )
  })

  it('finds no comment after code, and none in a file without one', () => {
    expect(leadingComment('export const a = 1\n// Copyright 2020 Someone\n')).toBe('')
    expect(leadingComment('')).toBe('')
    expect(leadingComment('﻿/* Copyright (c) A */')).toBe('Copyright (c) A')
  })
})

describe('notices', () => {
  it('tells copyright and licence statements from other comments', () => {
    expect(isNotice('Copyright 2008 Google Inc.')).toBe(true)
    expect(isNotice('(c) 2020 Someone')).toBe(true)
    expect(isNotice('SPDX-License-Identifier: MIT')).toBe(true)
    expect(isNotice('@license lucide-react v1.55.0 - ISC')).toBe(true)
    expect(isNotice('Licensed under the Apache License, Version 2.0')).toBe(true)
    expect(isNotice('Returns the licence of a track, if it has one.')).toBe(false)
    expect(isNotice('DEFLATE is a complex format; check the RFC first.')).toBe(false)
  })

  it('names who a notice’s copyright lines are for, without years', () => {
    expect(
      copyrightHolders(
        'Copyright (c) 2017 - Present Tauri Apps Contributors\nCopyright 2008 Google Inc.  All rights reserved.\nSome text with copyright in it',
      ),
    ).toEqual(['tauri apps contributors', 'google inc'])
  })

  it('keeps a notice only when the licence files lack it', () => {
    const mit = 'MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\nPermission…'
    // React's headers name the holder its LICENSE names: nothing to add.
    expect(
      addsToLicence(
        '@license React\nCopyright (c) Meta Platforms, Inc. and affiliates.\nThis source code is licensed under the MIT license.',
        [mit],
      ),
    ).toBe(false)
    // Another holder, or the package has no licence file at all: keep it.
    expect(addsToLicence('Copyright (c) Microsoft Corporation.\nPermission to use…', [mit])).toBe(
      true,
    )
    expect(addsToLicence('SPDX-License-Identifier: MIT', [])).toBe(true)
    // A licence statement without a copyright line adds nothing to a licence file.
    expect(addsToLicence('SPDX-License-Identifier: MIT', [mit])).toBe(false)
    // Whole words only: "meta" is not "metadata".
    expect(addsToLicence('Copyright Meta', ['Copyright (c) metadata tools'])).toBe(true)
  })

  it('collects the notices files open with, once each, years and code comments aside', () => {
    const dir = tempDir()
    writeFiles(dir, {
      'a.js': BUF_APACHE('2021-2025'),
      'b.js': BUF_APACHE('2021-2026'),
      // The same header, running on into a comment about the code.
      'c.js': `${BUF_APACHE('2021-2026').replace('export const x = 1\n', '')}// Native setFromBase64, if the runtime has it.\nexport {}\n`,
      'varint.js': GOOGLE_BSD,
      'plain.js': '// Reads the bytes.\nexport {}\n',
      'image.png': '// Copyright 2020 Not Text',
      'style.css': '/*! Copyright (c) 2020 CSS Author */ body{}',
    })
    const files = ['a.js', 'b.js', 'c.js', 'varint.js', 'plain.js', 'image.png', 'style.css'].map(
      (name) => join(dir, name),
    )
    const notices = fileNotices([...files, join(dir, 'missing.js')], [])
    expect(notices).toEqual([
      leadingComment(BUF_APACHE('2021-2025')),
      'Copyright (c) 2020 CSS Author',
      leadingComment(GOOGLE_BSD),
    ])
  })

  it('gives a package’s licence files and the notices its files add to them', () => {
    const dir = tempDir()
    writeFiles(dir, {
      'LICENSE-MIT': 'MIT License\n\nCopyright (c) 2017 - Present Tauri Apps Contributors',
      'LICENSE.spdx': 'PackageLicenseDeclared: MIT',
      'core.js':
        "import { x } from './tslib.js';\n\n// Copyright 2019-2024 Tauri Apps Contributors\n",
      'tslib.js':
        '/*\nCopyright (c) Microsoft Corporation.\n\nPermission to use, copy, modify…\n*/\n',
    })
    const result = packageNotices(dir, [join(dir, 'core.js'), join(dir, 'tslib.js')])
    expect(result.licenceFiles.map((file) => file.name)).toEqual(['LICENSE-MIT'])
    expect(result.fileNotices).toEqual([
      'Copyright (c) Microsoft Corporation.\n\nPermission to use, copy, modify…',
    ])
  })
})
