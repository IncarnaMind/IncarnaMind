// What resources/notices/python.txt must credit for what Analyses run with (ADR-0023, ADR-0025).
// Each wheel is listed by name and version with the notices its code needs: its own, and those of
// the libraries compiled into its modules, which its wheel's licence files often leave out. A wheel
// not listed here, a new one or an upgrade, fails the build until someone audits its modules and
// lists what they bundle. scripts/check-package.mjs runs `noticeProblems` on every build.

/** Every notice Pyodide's own files need, whatever packages ship. */
const PYODIDE = ["Pyodide", "CPython", "Emscripten"];

/** Each audited wheel, as "name version", and the notices its code needs. */
export const AUDITED_WHEELS = {
  "contourpy 1.3.3": ["contourpy"],
  "cycler 0.12.1": ["cycler"],
  "fonttools 4.62.1": ["fonttools"],
  "joblib 1.5.3": ["joblib"],
  "kiwisolver 1.5.0": ["kiwisolver"],
  "matplotlib 3.10.8": ["matplotlib", "FreeType", "Anti-Grain Geometry", "Qhull"],
  "numpy 2.4.6": ["numpy"],
  "packaging 26.1": ["packaging"],
  "pandas 3.0.2": ["pandas"],
  "patsy 1.0.2": ["patsy"],
  "pillow 12.2.0": ["pillow", "FreeType", "IJG libjpeg", "libtiff", "zlib", "libwebp"],
  "pyparsing 3.3.2": ["pyparsing"],
  "python-dateutil 2.9.0.post0": ["python-dateutil"],
  "pytz 2026.1.post1": ["pytz"],
  "scikit-learn 1.8.0": ["scikit-learn", "libsvm", "liblinear"],
  "scipy 1.18.0": [
    "scipy",
    "OpenBLAS",
    "LAPACK",
    "libf2c",
    "SuperLU",
    "ARPACK",
    "PROPACK",
    "HiGHS",
    "UNU.RAN",
    "PRIMA",
    "MINPACK",
    "QUADPACK",
    "Boost.Math",
    "scipy's bundled code",
    "xsf's bundled code",
  ],
  "six 1.17.0": ["six"],
  "statsmodels 0.14.6": ["statsmodels"],
  "threadpoolctl 3.6.0": ["threadpoolctl"],
};

/** Each bundled font and the notice it needs. */
export const AUDITED_FONTS = { "NotoSansSC-GB2312.otf": ["Noto Sans SC"] };

/**
 * A line each notice's own section must hold: its copyright or the credit its licence asks for,
 * so a section emptied of its text fails. Null: a line in the list is enough (public domain, or a
 * licence that asks no notice of a program built from it).
 */
export const REQUIRED_TEXT = {
  Pyodide: ["Exhibit A - Source Code Form License Notice"],
  CPython: ["PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2"],
  Emscripten: ["University of Illinois/NCSA Open Source License"],
  contourpy: ["Copyright (c) 2021-2025, ContourPy Developers."],
  cycler: ["Copyright (c) 2015, matplotlib project"],
  fonttools: ["Copyright (c) 2017 Just van Rossum"],
  joblib: ["Copyright (c) 2008-2021, The joblib developers."],
  kiwisolver: ["Kiwi is licensed under the terms of the Modified BSD License"],
  matplotlib: ["License agreement for matplotlib versions 1.3.0 and later"],
  numpy: ["Copyright (c) 2005-2025, NumPy Developers."],
  packaging: ["Copyright (c) Donald Stufft and individual contributors."],
  pandas: ["Copyright (c) 2011-2026, Open source contributors."],
  patsy: ["Copyright (C) 2011-2012, Patsy Developers. All rights reserved."],
  pillow: ["Copyright © 1997-2011 by Secret Labs AB"],
  pyparsing: ["Copyright (c) 2003-2025  Paul McGuire"],
  "python-dateutil": ["Copyright 2017- Paul Ganssle <paul@ganssle.io>"],
  pytz: ["Copyright (c) 2003-2019 Stuart Bishop <stuart@stuartbishop.net>"],
  "scikit-learn": ["Copyright (c) 2007-2024 The scikit-learn developers."],
  scipy: ["Copyright (c) 2001-2002 Enthought, Inc. 2003, SciPy Developers."],
  six: ["Copyright (c) 2010-2024 Benjamin Peterson"],
  statsmodels: ["Copyright (C) 2006, Jonathan E. Taylor"],
  threadpoolctl: ["Copyright (c) 2019, threadpoolctl contributors"],
  "Noto Sans SC": ["This Font Software is licensed under the SIL Open Font License,"],
  FreeType: [
    "The FreeType Project LICENSE",
    "Portions of this software are copyright © 1996-2024 The FreeType Project",
  ],
  "IJG libjpeg": ["This software is based in part on the work of the Independent JPEG Group."],
  libtiff: ["Copyright © 1991-1997 Silicon Graphics, Inc."],
  zlib: ["(C) 1995-2022 Jean-loup Gailly and Mark Adler"],
  libwebp: ["Copyright (c) 2010, Google Inc. All rights reserved."],
  "Anti-Grain Geometry": ["Copyright (C) 2002-2005 Maxim Shemanarev (McSeem)"],
  Qhull: ["Qhull, Copyright (c) 1993-2020"],
  OpenBLAS: ["Copyright (c) 2011-2014, The OpenBLAS Project"],
  LAPACK: ["Copyright (c) 1992-2023 The University of Tennessee and The University"],
  libf2c: ["Copyright 1990 - 1997 by AT&T, Lucent Technologies and Bellcore."],
  SuperLU: ["Copyright (c) 2003, The Regents of the University of California, through"],
  ARPACK: ["Copyright (c) 1996-2008 Rice University."],
  PROPACK: ["Copyright (c) 2005, Rasmus Munk Larsen, Stanford University"],
  HiGHS: ["Copyright (c) 2024 HiGHS"],
  "UNU.RAN": ["Permission was granted on 23 March 2021 by Josef Leydold"],
  PRIMA: ["Copyright (c) 2020--2025, Zaikun ZHANG"],
  MINPACK: ["University of Chicago, as Operator of Argonne National"],
  QUADPACK: null,
  "Boost.Math": null,
  "scipy's bundled code": ["Name: fast_matrix_market"],
  "xsf's bundled code": ["Name: Cephes"],
  libsvm: ["Copyright (c) 2000-2009 Chih-Chung Chang and Chih-Jen Lin"],
  liblinear: ["Copyright (c) 2007-2014 The LIBLINEAR Project."],
};

const BAR = "=".repeat(80);

/** The text of `name`'s own section, between its "=== name ===" heading and the next one. */
function sectionOf(notice, name) {
  const heading = `\n${BAR}\n${name}\n${BAR}\n`;
  const at = notice.indexOf(heading);
  if (at < 0) return null;
  const from = at + heading.length;
  const next = notice.indexOf(`\n${BAR}\n`, from);
  return notice.slice(from, next < 0 ? undefined : next);
}

/** Whether `notice` lists `name` in its opening lists: a line "- name …". */
const listed = (notice, name) =>
  notice.split("\n").some((line) => line.startsWith(`- ${name} `) || line.startsWith(`- ${name},`));

/**
 * What the notice lacks for these packages and fonts (packages.json's), each as a sentence; empty
 * when it credits all of them.
 */
export function noticeProblems(notice, packages, fonts) {
  const problems = [];
  const needed = [...PYODIDE];
  for (const { name, version } of packages) {
    const audited = AUDITED_WHEELS[`${name} ${version}`];
    if (audited) needed.push(...audited);
    else {
      problems.push(
        `${name} ${version} isn't audited: list the libraries compiled into its modules in scripts/pythonNotices.mjs, with their notices`,
      );
    }
  }
  for (const font of fonts) {
    const audited = AUDITED_FONTS[font];
    if (audited) needed.push(...audited);
    else problems.push(`the font ${font} isn't audited in scripts/pythonNotices.mjs`);
  }
  for (const name of new Set(needed)) {
    if (!listed(notice, name)) problems.push(`notices/python.txt doesn't list ${name}`);
    const required = REQUIRED_TEXT[name];
    if (required === undefined) {
      problems.push(`scripts/pythonNotices.mjs gives no text ${name}'s notice must hold`);
      continue;
    }
    if (required === null) continue;
    const section = sectionOf(notice, name);
    const missing = required.filter((line) => !section?.includes(line));
    if (missing.length > 0) {
      problems.push(`notices/python.txt has no licence text for ${name} ("${missing[0]}")`);
    }
  }
  return problems;
}
