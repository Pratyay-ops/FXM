import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditLinkedFiles,
  commentsOf,
  familiesOf,
  isStatement,
  leadingHash,
  parseDependencyFile,
  parseWhyExtract,
  partLayouts,
  REVIEWED,
  renderNotices,
  splitNotice,
} from '../../../tools/ffmpeg-wasm/recipe/linked-licences.ts'
import {
  ARCHIVE_MTIME,
  collectEntries,
  RECIPE_ARCHIVE_PATHS,
  RECIPE_ARCHIVE_ROOT,
  ustar,
} from '../../../tools/ffmpeg-wasm/recipe/source-archive.ts'
import { removeTempDirs, tempDir, writeFiles } from './testing.ts'

afterEach(removeTempDirs)

const LGPL = `/*
 * Copyright (c) 2003 Someone
 *
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 */
`

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, subject to the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.`

/** A file under the MIT licence with its copyright line inside the licence's comment. */
const mit = (holder: string) =>
  `/*\n * Ogg bitstream support\n */\n\n/*\n    Copyright (C) 2005  ${holder}\n\n${MIT_TEXT.replace(/^/gm, '    ')}\n */\n\n#include "oggdec.h"\nint x;\n`

/** Opus's style: the copyright lines in a comment of their own, before the licence's. */
const opus = (holder: string) => `/* Copyright (c) 2007-2008 ${holder}
   Written by Jean-Marc Valin */
/*
   Redistribution and use in source and binary forms, with or without
   modification, are permitted provided that the following conditions
   are met:

   - Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer.
*/
#include "arch.h"
`

const CREDIT = `/*
** FFT and FHT routines
**  Copyright 1988, 1993; Ron Mayer
**
** a derivative of a routine I once released under the GPL. If it were up to me,
** I'd say go do whatever you want with it; but it would be polite to give credit.
*/
#include "util.h"
`

describe('the licence of a comment', () => {
  it('tells each family by its text', () => {
    expect(familiesOf(LGPL)).toEqual(['LGPL'])
    expect(familiesOf(commentsOf(LGPL)[0]?.text ?? '')).toEqual(['LGPL'])
    expect(familiesOf(MIT_TEXT)).toEqual(['MIT'])
    expect(familiesOf('Redistribution and use in source and binary forms, with or')).toEqual([
      'BSD',
    ])
    expect(familiesOf('and on BSD-licensed SHA-2 code by Aaron D. Gifford')).toEqual(['BSD'])
    expect(
      familiesOf(
        'Permission to use, copy, modify, and/or distribute this software for any purpose',
      ),
    ).toEqual(['ISC'])
    expect(familiesOf("This file is part of the Independent JPEG Group's software.")).toEqual([
      'IJG',
    ])
    expect(
      familiesOf("This software is provided 'as-is', without any express or implied warranty."),
    ).toEqual(['zlib'])
    expect(familiesOf('based on public domain SHA-1 code by Steve Reid')).toEqual(['public domain'])
  })

  it('tells the Boost licence from the MIT licence, and the GPL from the LGPL', () => {
    const boost =
      'Boost Software License - Version 1.0. Permission is hereby granted, free of charge, to any person or organization obtaining a copy'
    expect(familiesOf(boost)).toEqual(['Boost'])
    expect(familiesOf('the GNU Library General Public License, version 2')).toEqual(['LGPL'])
    expect(familiesOf('released under the GPL, so it may')).toEqual(['GPL'])
    expect(familiesOf('under the terms of the GNU General Public License')).toEqual(['GPL'])
  })

  it('calls a grant it can’t place unknown, and says nothing about plain comments', () => {
    expect(familiesOf('Licensed under the Apache License, Version 2.0')).toEqual(['unknown'])
    expect(familiesOf('Copyright (c) 2020 Acme. All rights reserved.')).toEqual(['unknown'])
    expect(familiesOf('Return the libavcodec license.')).toEqual([])
    expect(familiesOf('Out-of-band headers that may be used by some codecs.')).toEqual([])
  })
})

describe('the comments of a C file', () => {
  it('finds block and line comments, the ones before the code first', () => {
    const comments = commentsOf(
      `/* one */\n// two\n#include "x.h"\nchar *s = "/* not a comment */"; // three\nchar c = '"';\n/** four\n * five */\n`,
    )
    expect(comments).toEqual([
      { text: 'one', leading: true },
      { text: 'two', leading: true },
      { text: 'three', leading: false },
      { text: 'four\nfive', leading: false },
    ])
  })

  it('reads only statements: comments before the code, with a copyright line or a licence', () => {
    expect(isStatement({ text: 'may be used by codecs', leading: true })).toBe(true)
    expect(isStatement({ text: 'may be used by codecs', leading: false })).toBe(false)
    expect(isStatement({ text: 'Copyright (c) 2001 X', leading: false })).toBe(true)
    expect(isStatement({ text: 'Boost Software License, Version 1.0', leading: false })).toBe(true)
  })

  it('splits a notice into its copyright lines and its licence text', () => {
    expect(
      splitNotice(
        'Copyright (c) 2012\n     MIPS Technologies, Inc., California.\n(C) COPYRIGHT 1994 Xiph\n\nRedistribution and use…\n  - kept as it is\n',
      ),
    ).toEqual({
      copyrights: [
        'Copyright (c) 2012\n  MIPS Technologies, Inc., California.',
        '(C) COPYRIGHT 1994 Xiph',
      ],
      body: 'Redistribution and use…\n  - kept as it is',
    })
  })
})

describe('what the linker took', () => {
  it('reads each archive member of --why-extract once', () => {
    const text = [
      'reference\textracted\tsymbol',
      '/tmp/fxm_convert.o\t/l/libavformat.a(demux.o)\tavformat_open_input',
      '/l/libavformat.a(demux.o)\t/l/libavformat.a(format.o)\tav_probe_input_format3',
      '/tmp/fxm_convert.o\t/l/libavformat.a(demux.o)\tavformat_find_stream_info',
      '/tmp/a.o\t/tmp/b.o\tlazy',
      '',
    ].join('\n')
    expect(parseWhyExtract(text)).toEqual([
      { archive: '/l/libavformat.a', member: 'demux.o' },
      { archive: '/l/libavformat.a', member: 'format.o' },
    ])
  })

  it('reads the first rule of a dependency file', () => {
    expect(
      parseDependencyFile('a/b.o: a/b.c \\\n a/b.h /emsdk/stdio.h\n\na/b.h:\n/emsdk/stdio.h:\n'),
    ).toEqual(['a/b.c', 'a/b.h', '/emsdk/stdio.h'])
  })
})

/** A small build of the three parts, as libs.sh lays it out, and an emsdk beside it. */
function fakeBuild() {
  const root = tempDir()
  const libs = join(root, 'libs')
  const emsdk = join(root, 'emsdk')
  const ffmpeg = 'src/ffmpeg-9.0.2'
  writeFiles(libs, {
    [`${ffmpeg}/libavformat/oggdec.c`]: mit('Michael Ahlberg, Måns Rullgård'),
    [`${ffmpeg}/libavformat/oggdec.h`]: LGPL,
    [`${ffmpeg}/libavformat/oggdec.o`]: '',
    [`${ffmpeg}/libavformat/oggdec.d`]: `libavformat/oggdec.o: libavformat/oggdec.c libavformat/oggdec.h \\\n ${emsdk}/include/stdio.h ../../prefix/include/opus/opus_types.h\n\nlibavformat/oggdec.h:\n`,
    [`${ffmpeg}/libavformat/oggparsespeex.c`]: mit('Reimar Döffinger'),
    [`${ffmpeg}/libavformat/oggparsespeex.o`]: '',
    [`${ffmpeg}/libavformat/oggparsespeex.d`]:
      'libavformat/oggparsespeex.o: libavformat/oggparsespeex.c\n',
    [`${ffmpeg}/fftools/ffmpeg.c`]: 'const int program_birth_year = 2000;\n',
    [`${ffmpeg}/config.h`]: '#define CONFIG_THIS_YEAR 2026\n',
    'src/lame-4.0/libmp3lame/fft.c': CREDIT,
    'src/lame-4.0/libmp3lame/fft.o': '',
    'src/lame-4.0/libmp3lame/util.h': LGPL,
    'src/lame-4.0/README': 'Copyrights (c) 1999-2011 by The LAME Project\nmore\n',
    'src/opus-1.6.1/celt/bands.c': opus('CSIRO'),
    'src/opus-1.6.1/celt/bands.o': '',
    'src/opus-1.6.1/celt/arch.h': opus('Xiph.Org Foundation'),
    'src/opus-1.6.1/celt/.deps/bands.Plo': 'celt/bands.lo: celt/bands.c celt/arch.h\n',
    'src/opus-1.6.1/include/opus_types.h': opus('Jean-Marc Valin'),
    'prefix/include/opus/opus_types.h': opus('Jean-Marc Valin'),
  })
  writeFiles(emsdk, { 'include/stdio.h': '/* GPL? No: musl. */\n' })
  const sysroot = join(emsdk, 'upstream/emscripten/cache/sysroot/lib/wasm32-emscripten')
  const whyExtract = [
    'reference\textracted\tsymbol',
    `/tmp/fxm_convert.o\t${libs}/stage/usr/lib/libavformat.a(oggdec.o)\tff_ogg_demuxer`,
    `/tmp/fxm_convert.o\t${libs}/stage/usr/lib/libavformat.a(oggparsespeex.o)\tff_speex_codec`,
    `/tmp/fxm_convert.o\t${libs}/prefix/lib/libmp3lame.a(fft.o)\tfft_long`,
    `/tmp/fxm_convert.o\t${libs}/prefix/lib/libopus.a(bands.o)\tquant_all_bands`,
    `/tmp/fxm_convert.o\t${sysroot}/libc.a(memcpy.o)\tmemcpy`,
  ].join('\n')
  const reviewed = REVIEWED.map((entry) =>
    entry.file === 'libmp3lame/fft.c' ? { ...entry, leadingSha256: leadingHash(CREDIT) } : entry,
  )
  return { libs, emsdk, ffmpeg, whyExtract, reviewed }
}

describe('the licences of the linked files', () => {
  it('finds the parts in libs.sh’s folder', () => {
    const { libs } = fakeBuild()
    expect(partLayouts(libs).map((part) => [part.name, part.version])).toEqual([
      ['FFmpeg', '9.0.2'],
      ['LAME', '4.0'],
      ['Opus', '1.6.1'],
    ])
  })

  it('carries the notices of MIT and BSD files, grouped by licence text, with every holder', () => {
    const { libs, emsdk, whyExtract, reviewed } = fakeBuild()
    const parts = partLayouts(libs)
    const audit = auditLinkedFiles(parseWhyExtract(whyExtract), parts, emsdk, reviewed)
    expect(audit.problems).toEqual([])
    expect(audit.objects).toEqual({ FFmpeg: 2, LAME: 1, Opus: 1, Emscripten: 1 })
    expect(audit.notices.map((notice) => [notice.part, notice.kind, notice.files])).toEqual([
      ['FFmpeg', 'licence', ['libavformat/oggdec.c', 'libavformat/oggparsespeex.c']],
      // The installed copy of opus_types.h, which FFmpeg includes, is named by its tree path.
      ['Opus', 'licence', ['celt/arch.h', 'celt/bands.c', 'include/opus_types.h']],
      ['LAME', 'credit', ['libmp3lame/fft.c']],
    ])
    const [ogg, celt] = audit.notices
    expect(ogg?.copyrights).toEqual([
      'Copyright (C) 2005  Michael Ahlberg, Måns Rullgård',
      'Copyright (C) 2005  Reimar Döffinger',
    ])
    expect(ogg?.body).toContain('Permission is hereby granted, free of charge')
    expect(ogg?.body).not.toContain('Copyright')
    // Opus's copyright lines come from the comment before the licence's.
    expect(celt?.copyrights).toEqual([
      'Copyright (c) 2007-2008 Jean-Marc Valin\n  Written by Jean-Marc Valin',
      'Copyright (c) 2007-2008 Xiph.Org Foundation\n  Written by Jean-Marc Valin',
      'Copyright (c) 2007-2008 CSIRO\n  Written by Jean-Marc Valin',
    ])
    expect(audit.copyrights).toEqual({
      FFmpeg: ['Copyright (c) 2000-2026 the FFmpeg developers'],
      LAME: ['Copyrights (c) 1999-2011 by The LAME Project'],
      Opus: [],
    })
    const text = renderNotices(audit, parts)
    expect(text).toContain('FFmpeg 9.0.2:\n  Copyright (c) 2000-2026 the FFmpeg developers')
    expect(text).toContain(
      '=== FFmpeg 9.0.2\nThese 2 files are under this licence: libavformat/oggdec.c,\nlibavformat/oggparsespeex.c.\n\nCopyright (C) 2005  Michael Ahlberg, Måns Rullgård\nCopyright (C) 2005  Reimar Döffinger\n\n    Permission is hereby granted',
    )
    expect(text).toContain('=== LAME 4.0\nThis file asks for this credit: libmp3lame/fft.c.')
    expect(text).toContain('but it would be polite to give credit')
  })

  it('stops at the GPL, a licence it doesn’t know, a changed review and an unknown archive', () => {
    const { libs, emsdk, ffmpeg, whyExtract, reviewed } = fakeBuild()
    writeFileSync(join(libs, ffmpeg, 'libavformat/oggdec.h'), '/* Licensed under the GPL v2 */\n')
    writeFileSync(
      join(libs, 'src/opus-1.6.1/celt/arch.h'),
      '/* Copyright (c) 2020 Acme. Licensed under the Acme Licence. */\n',
    )
    const extracted = [
      ...parseWhyExtract(whyExtract),
      { archive: '/elsewhere/libsomething.a', member: 'thing.o' },
      { archive: `${libs}/stage/usr/lib/libavcodec.a`, member: 'missing.o' },
    ]
    const audit = auditLinkedFiles(extracted, partLayouts(libs), emsdk, reviewed)
    expect(audit.problems).toEqual([
      "the core links thing.o from /elsewhere/libsomething.a, which is neither FFmpeg's, LAME's, Opus's nor one of Emscripten's libraries its notice credits (EMSCRIPTEN_ARCHIVES)",
      "can't find missing.o of libavcodec.a in libavcodec",
      "FFmpeg's libavformat/oggdec.h states the GPL, which the core may not contain: if it is under the LGPL after all, record that in REVIEWED (linked-licences.ts)",
      "Opus's celt/arch.h states a licence linked-licences.ts doesn't know: read it, then teach FAMILY_PATTERNS the licence or record a decision in REVIEWED",
    ])
    // The reviewed statement, changed.
    writeFileSync(join(libs, 'src/lame-4.0/libmp3lame/fft.c'), CREDIT.replace('1993', '1994'))
    const again = auditLinkedFiles(parseWhyExtract(whyExtract), partLayouts(libs), emsdk, reviewed)
    expect(again.problems).toContain(
      "LAME's libmp3lame/fft.c no longer says what was reviewed (REVIEWED in linked-licences.ts): read its licence statement again and update the entry",
    )
  })

  it('stops at a GPL statement the review list doesn’t cover', () => {
    const { libs, emsdk, whyExtract } = fakeBuild()
    const audit = auditLinkedFiles(parseWhyExtract(whyExtract), partLayouts(libs), emsdk, [])
    expect(audit.problems).toEqual([
      "LAME's libmp3lame/fft.c states the GPL, which the core may not contain: if it is under the LGPL after all, record that in REVIEWED (linked-licences.ts)",
    ])
  })
})

describe('the recipe’s archive', () => {
  /** A checkout with what the archive takes, and files it must leave out. */
  function checkout(): string {
    const root = tempDir()
    writeFiles(root, {
      'tools/ffmpeg-wasm/README.md': '# core\n',
      'tools/ffmpeg-wasm/core-build.ts': 'export {}\n',
      'tools/ffmpeg-wasm/recipe/build.sh': '#!/usr/bin/env bash\n',
      'tools/ffmpeg-wasm/recipe/versions.sh': 'FFMPEG_VERSION=9.0.2\n',
      'tools/ffmpeg-wasm/.DS_Store': 'Finder',
      'scripts/env.sh': 'env\n',
      'scripts/lib.sh': 'lib\n',
      'scripts/other.sh': 'not taken\n',
      LICENSE: 'Apache\n',
      '.nvmrc': '22\n',
    })
    chmodSync(join(root, 'tools/ffmpeg-wasm/recipe/build.sh'), 0o755)
    return root
  }

  it('takes the tool’s folder, the scripts it runs, the licence and .nvmrc', () => {
    const entries = collectEntries(checkout())
    expect(entries.map((entry) => [entry.path, entry.mode.toString(8)])).toEqual([
      [RECIPE_ARCHIVE_ROOT, '755'],
      [`${RECIPE_ARCHIVE_ROOT}/.nvmrc`, '644'],
      [`${RECIPE_ARCHIVE_ROOT}/LICENSE`, '644'],
      [`${RECIPE_ARCHIVE_ROOT}/scripts`, '755'],
      [`${RECIPE_ARCHIVE_ROOT}/scripts/env.sh`, '644'],
      [`${RECIPE_ARCHIVE_ROOT}/scripts/lib.sh`, '644'],
      [`${RECIPE_ARCHIVE_ROOT}/tools`, '755'],
      [`${RECIPE_ARCHIVE_ROOT}/tools/ffmpeg-wasm`, '755'],
      [`${RECIPE_ARCHIVE_ROOT}/tools/ffmpeg-wasm/README.md`, '644'],
      [`${RECIPE_ARCHIVE_ROOT}/tools/ffmpeg-wasm/core-build.ts`, '644'],
      [`${RECIPE_ARCHIVE_ROOT}/tools/ffmpeg-wasm/recipe`, '755'],
      [`${RECIPE_ARCHIVE_ROOT}/tools/ffmpeg-wasm/recipe/build.sh`, '755'],
      [`${RECIPE_ARCHIVE_ROOT}/tools/ffmpeg-wasm/recipe/versions.sh`, '644'],
    ])
    expect(RECIPE_ARCHIVE_PATHS).toContain('scripts/lib.sh')
  })

  it('is a ustar file that tar reads, the same bytes whatever the files’ dates', () => {
    const root = checkout()
    const first = ustar(collectEntries(root))
    expect(first.length % 10_240).toBe(0)
    utimesSync(join(root, 'scripts/env.sh'), new Date(2001, 1, 1), new Date(2001, 1, 1))
    expect(Buffer.compare(Buffer.from(ustar(collectEntries(root))), Buffer.from(first))).toBe(0)
    const dir = tempDir()
    writeFileSync(join(dir, 'recipe.tar'), first)
    const listing = execFileSync('tar', ['-tvf', join(dir, 'recipe.tar')], { encoding: 'utf8' })
    expect(listing).toMatch(
      /^-rwxr-xr-x .* fxm-ffmpeg-core-recipe\/tools\/ffmpeg-wasm\/recipe\/build\.sh$/m,
    )
    expect(listing).toMatch(/1980/)
    execFileSync('tar', ['-xf', join(dir, 'recipe.tar'), '-C', dir])
    expect(
      readFileSync(join(dir, RECIPE_ARCHIVE_ROOT, 'tools/ffmpeg-wasm/recipe/versions.sh'), 'utf8'),
    ).toBe('FFMPEG_VERSION=9.0.2\n')
    expect(ARCHIVE_MTIME).toBe(Date.UTC(1980, 0, 1) / 1000)
  })

  it('puts a path longer than 100 bytes into the prefix field', () => {
    const long = `${'a'.repeat(60)}/${'b'.repeat(60)}/file.txt`
    const archive = ustar([{ path: long, mode: 0o644, data: Buffer.from('x\n') }])
    const dir = tempDir()
    writeFileSync(join(dir, 'long.tar'), archive)
    expect(execFileSync('tar', ['-tf', join(dir, 'long.tar')], { encoding: 'utf8' }).trim()).toBe(
      long,
    )
  })
})
