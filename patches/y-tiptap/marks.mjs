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

// y-tiptap keys a mark's Yjs format by the mark's name, so every sentence's check shared one key,
// and two sentences side by side shared the marker that ends one and starts the next: a write at
// that marker crossing another copy's could leave one sentence with the other's check (#2996).
// patches/y-tiptap.mjs sets these two in place of the library's in both builds of the package. A
// mark whose spec has `yKey` is kept under the key it names; a mark whose spec has `yPick` is read
// as one mark when several of its keys meet on the same words. They use the library's own
// `yattr2markname` and `hashOfJSON`, so this file is read as text, not run.

export const attributesToMarks = (attrs, schema) => {
  const marks = [];
  const keyed = new Map();
  for (const markName in attrs) {
    const name = yattr2markname(markName);
    if (schema.marks[name]?.spec.yPick) {
      keyed.set(name, [...(keyed.get(name) || []), { key: markName, attrs: attrs[markName] }]);
    } else {
      marks.push(schema.mark(name, attrs[markName]));
    }
  }
  keyed.forEach((entries, name) => {
    const chosen = entries[entries.length === 1 ? 0 : schema.marks[name].spec.yPick(entries)];
    if (chosen) marks.push(schema.mark(name, chosen.attrs));
  });
  return marks
};

export const marksToAttributes = (marks, meta) => {
  const pattrs = {};
  marks.forEach((mark) => {
    if (mark.type.name !== 'ychange') {
      let isOverlapping = meta.isOMark.get(mark.type);
      if (isOverlapping === undefined) {
        isOverlapping = !mark.type.excludes(mark.type);
        meta.isOMark.set(mark.type, isOverlapping);
      }
      const keyed = mark.type.spec.yKey ? mark.type.spec.yKey(mark.attrs) : null;
      pattrs[keyed || (isOverlapping ? `${mark.type.name}--${hashOfJSON(mark.toJSON())}` : mark.type.name)] = mark.attrs;
    }
  });
  return pattrs
};
