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
  namesOtherLicence,
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

  it('lists a package’s licence files and their texts, without SPDX metadata or folders', () => {
    // Texts come with Unix line endings, whatever the file has: LICENSE_MIT has Windows ones.
    const dir = tempDir()
    writeFiles(dir, {
      LICENSE_MIT: 'MIT License\r\n\r\nCopyright (c) Tauri\r\n',
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
    expect(leadingComment('\uFEFF/* Copyright (c) A */')).toBe('Copyright (c) A')
  })

  it('reads files with Windows line endings like any others', () => {
    expect(leadingComment('// Copyright 2020 X\r\n// MIT\r\nexport {}\r\n')).toBe(
      'Copyright 2020 X\nMIT',
    )
    expect(leadingComment('/*\r\n * Copyright (c) A\r\n * MIT\r\n */\r\nexport {}')).toBe(
      'Copyright (c) A\nMIT',
    )
    expect(leadingComment('"use strict";\r\n\r\n// (c) 2021 B\rexport {}')).toBe('(c) 2021 B')
  })
})

describe('notices', () => {
  it('tells copyright and licence statements from other comments', () => {
    expect(isNotice('Copyright 2008 Google Inc.')).toBe(true)
    expect(isNotice('(c) 2020 Someone')).toBe(true)
    expect(isNotice('SPDX-License-Identifier: MIT')).toBe(true)
    expect(isNotice('@license lucide-react v1.55.0 - ISC')).toBe(true)
    expect(isNotice('Licensed under the Apache License, Version 2.0')).toBe(true)
    expect(isNotice('Portions Copyright 2008 Google Inc.')).toBe(true)
    expect(isNotice('SPDX-FileCopyrightText: 2023 Someone')).toBe(true)
    expect(isNotice('Returns the licence of a track, if it has one.')).toBe(false)
    expect(isNotice('DEFLATE is a complex format; check the RFC first.')).toBe(false)
    expect(isNotice('Reads the copyright field of a track.')).toBe(false)
  })

  it('names who a notice’s copyright marks are for, anywhere in a line, without years', () => {
    expect(
      copyrightHolders(
        [
          'Copyright (c) 2017 - Present Tauri Apps Contributors',
          'Copyright 2008 Google Inc.  All rights reserved.',
          'Portions Copyright 2010 Example Corp., licensed under BSD-3-Clause',
          'Foo Bar (c) 2020',
          'SPDX-FileCopyrightText: 2023 Some One',
          'A line without a mark',
        ].join('\n'),
      ),
    ).toEqual([
      'tauri apps contributors',
      'google inc',
      'example corp licensed under bsd 3 clause',
      'foo bar',
      'some one',
    ])
  })

  it('keeps a notice only when the licence files lack it', () => {
    const mit = 'MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\nPermission…'
    // React's headers name the holder its LICENSE names, and the licence it offers.
    expect(
      addsToLicence(
        '@license React\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\nThis source code is licensed under the MIT license found in the\nLICENSE file in the root directory of this source tree.',
        [mit],
        'MIT',
      ),
    ).toBe(false)
    // Another holder, or the package has no licence file at all: keep it.
    expect(addsToLicence('Copyright (c) Microsoft Corporation.\nPermission to use…', [mit])).toBe(
      true,
    )
    expect(addsToLicence('SPDX-License-Identifier: MIT', [])).toBe(true)
    // A licence statement the package's own licence covers adds nothing to its licence file.
    expect(addsToLicence('SPDX-License-Identifier: MIT', [mit], 'MIT')).toBe(false)
    // Whole words only: "meta" is not "metadata".
    expect(addsToLicence('Copyright Meta', ['Copyright (c) metadata tools'])).toBe(true)
  })

  it('keeps a third party’s copyright that a line names after other words', () => {
    const foo = 'MIT License\n\nCopyright (c) Foo\n\nPermission is hereby granted…'
    const notice =
      'Copyright (c) Foo\nPortions Copyright 2008 Google Inc., licensed under BSD-3-Clause'
    expect(addsToLicence(notice, [foo], 'MIT')).toBe(true)
    // The words of the licence the package has, such as MIT's "the above copyright notice…",
    // name no one new.
    const mitText =
      'Copyright (c) 2020 Foo\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.'
    expect(
      addsToLicence(mitText.replace('2020', '2021'), [`MIT License\n\n${mitText}`], 'MIT'),
    ).toBe(false)
  })

  it('keeps a notice that names a licence the package doesn’t offer', () => {
    const mit = 'MIT License\n\nCopyright (c) Foo\n\nPermission is hereby granted…'
    expect(addsToLicence('SPDX-License-Identifier: Apache-2.0', [mit], 'MIT')).toBe(true)
    expect(
      addsToLicence('Copyright (c) Foo\nSPDX-License-Identifier: Apache-2.0', [mit], 'MIT'),
    ).toBe(true)
    expect(addsToLicence('This file is licensed under BSD-3-Clause.', [mit], 'MIT')).toBe(true)
    expect(addsToLicence('@license foo v1.0.0 - ISC', [mit], 'MIT')).toBe(true)
    expect(addsToLicence('@license foo v1.0.0 - MIT', [mit], 'MIT')).toBe(false)
    // An expression with several licences offers each of them.
    expect(
      namesOtherLicence(
        'SPDX-License-Identifier: Apache-2.0\nSPDX-License-Identifier: MIT',
        'Apache-2.0 OR MIT',
      ),
    ).toBe(false)
    expect(namesOtherLicence('SPDX-License-Identifier: MIT OR Apache-2.0', 'MIT')).toBe(true)
    // Prose names a licence by its words, and "the License" only points back at it.
    const apacheHeader =
      'Copyright 2021 Buf Technologies, Inc.\n\nLicensed under the Apache License, Version 2.0 (the "License");\nyou may not use this file except in compliance with the License.\n\nUnless required by applicable law or agreed to in writing, software\ndistributed under the License is distributed on an "AS IS" BASIS.'
    expect(namesOtherLicence(apacheHeader, 'Apache-2.0')).toBe(false)
    expect(namesOtherLicence(apacheHeader, 'MIT')).toBe(true)
    expect(namesOtherLicence('Distributed under the terms of the License.', 'MIT')).toBe(false)
    expect(
      namesOtherLicence(
        'Use of this source code is governed by an MIT-style license that can be found in the LICENSE file.',
        'MIT',
      ),
    ).toBe(false)
    expect(
      namesOtherLicence('Use of this source code is governed by a BSD-style license.', 'MIT'),
    ).toBe(true)
    // Without an expression, every licence named counts.
    expect(namesOtherLicence('SPDX-License-Identifier: MIT')).toBe(true)
    expect(namesOtherLicence('Copyright (c) Foo')).toBe(false)
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

  it('never drops licence text that runs on after a shorter notice, in either order', () => {
    const dir = tempDir()
    const header = '// Copyright 2008 Google Inc.\nexport {}\n'
    writeFiles(dir, {
      'first/a.js': header,
      'first/b.js': GOOGLE_BSD,
      'second/a.js': GOOGLE_BSD,
      'second/b.js': header,
    })
    for (const folder of ['first', 'second']) {
      const files = ['a.js', 'b.js'].map((name) => join(dir, folder, name))
      expect(fileNotices(files, [])).toEqual([leadingComment(GOOGLE_BSD)])
      // The package's MIT licence names another holder: Google's notice adds to it.
      expect(fileNotices(files, ['MIT License\n\nCopyright (c) Foo'], 'MIT')).toEqual([
        leadingComment(GOOGLE_BSD),
      ])
    }
  })

  it('keeps both of two notices that differ within a line', () => {
    const dir = tempDir()
    writeFiles(dir, {
      'a.js': '// Copyright 2020 Foo\nexport {}\n',
      'b.js': '// Copyright 2020 Foo. Licensed under the MIT License.\nexport {}\n',
    })
    expect(fileNotices([join(dir, 'a.js'), join(dir, 'b.js')], [])).toEqual([
      'Copyright 2020 Foo',
      'Copyright 2020 Foo. Licensed under the MIT License.',
    ])
  })

  it('reads the notices of files with Windows line endings', () => {
    const dir = tempDir()
    writeFiles(dir, { 'a.js': GOOGLE_BSD.replaceAll('\n', '\r\n') })
    expect(fileNotices([join(dir, 'a.js')], [])).toEqual([leadingComment(GOOGLE_BSD)])
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
    const result = packageNotices(dir, [join(dir, 'core.js'), join(dir, 'tslib.js')], 'MIT')
    expect(result.licenceFiles.map((file) => file.name)).toEqual(['LICENSE-MIT'])
    expect(result.fileNotices).toEqual([
      'Copyright (c) Microsoft Corporation.\n\nPermission to use, copy, modify…',
    ])
  })
})
