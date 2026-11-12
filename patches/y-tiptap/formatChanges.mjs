/*
 * Part of @tiptap/y-tiptap, changed. The MIT License (MIT)
 *
 * Copyright (c) 2019 Kevin Jahns <kevin.jahns@protonmail.com>.
 * Copyright (c) 2025 Tiptap GmbH.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// y-tiptap's updateYText sets every run's marks again after each edit, and Yjs writes a run whose
// marks it can't prove equal, so an edit rewrote marks it didn't change: its Undo, or a change
// crossing it, then put back an older check result (#2988). patches/y-tiptap.mjs sets these into
// both builds of the package at install, and updateYText applies `formatChanges` in place of the
// whole text's marks. Everything from the first `export` on is what the package gets.

/**
 * The formatting that gives `ytext` the marks of `content`, for the runs whose marks differ only:
 * a run that already has its marks is retained with no attributes, so nothing is written for it.
 */
export const formatChanges = (ytext, content) => {
  const held = ytext.toDelta().map((d) => ({
    length: typeof d.insert === 'string' ? d.insert.length : 1,
    attributes: d.attributes || {}
  }));
  const ops = [];
  let run = 0;
  let used = 0;
  for (const c of content) {
    let left = c.insert.length;
    while (left > 0 && run < held.length) {
      const here = held[run];
      const take = Math.min(left, here.length - used);
      const last = ops[ops.length - 1];
      if (!sameValue(c.attributes, here.attributes)) {
        ops.push({ retain: take, attributes: c.attributes });
      } else if (last && last.attributes === undefined) {
        last.retain += take;
      } else {
        ops.push({ retain: take });
      }
      left -= take;
      used += take;
      if (used === here.length) {
        run++;
        used = 0;
      }
    }
  }
  return ops;
};

/**
 * Whether two marks' values are the same as stored: compared in depth, with a key whose value is
 * null or undefined the same as no key, since a format's null removes it and an update leaves an
 * undefined value out.
 */
export const sameValue = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && a.length !== b.length) return false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!sameValue(a[key], b[key])) return false;
  }
  return true;
};
