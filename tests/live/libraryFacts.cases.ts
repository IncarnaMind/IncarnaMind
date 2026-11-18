/**
 * Sentences about the Library itself (#2525): counts, names, kinds, Folders and notes, with decoys
 * (a wrong count, a name that isn't there, a name that appears only once, a walled Folder's count
 * from outside it, a description the lists can't settle, a sentence about the note itself, and a
 * Document's own figure). These cases are held out: none is an example in the check's or the
 * sort's instructions, in a decision model's question, or in a Tool's description.
 */
export type Outcome = "supported" | "unsupported" | "contradicted" | "not-checked" | "left-out";

export interface LibraryCase {
  sentence: string;
  /** What reads right; the first is what it should read. */
  expected: readonly Outcome[];
  /** The Library it is checked in, and where its note is. */
  library: "open" | "walled-outside" | "walled-inside";
  /** For a Supported sentence about the Library: the evidence must be the Library's own facts. */
  aboutLibrary?: true;
}

const NOT_SUPPORTED = ["contradicted", "unsupported"] as const;
/** A reading of the names, which the lists don't settle: the writer's own view, or not found. */
const UNSETTLED = ["unsupported", "not-checked"] as const;

export const LIBRARY_CASES: Record<"en" | "zh-CN", LibraryCase[]> = {
  en: [
    {
      sentence: "Your Library holds 7 Documents.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    { sentence: "Your Library holds 9 Documents.", expected: NOT_SUPPORTED, library: "open" },
    {
      sentence: "Kestrel plan shows up twice among your files.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    // Decoy: a name that appears only once.
    {
      sentence: "Harbour survey shows up twice among your files.",
      expected: NOT_SUPPORTED,
      library: "open",
    },
    // Decoy: a name that isn't there.
    {
      sentence: "One of your Documents is called Ferry timetable.",
      expected: NOT_SUPPORTED,
      library: "open",
    },
    {
      sentence: "The Research Folder contains 2 Documents.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    {
      sentence: "The Research Folder contains 4 Documents.",
      expected: NOT_SUPPORTED,
      library: "open",
    },
    {
      sentence: "Exactly one of your Documents is a Word file.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    {
      sentence: "Three of your Documents are Excel workbooks.",
      expected: NOT_SUPPORTED,
      library: "open",
    },
    {
      sentence: "You keep 2 other notes in IncarnaMind.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    // A description the facts can't settle: a reading of the names.
    {
      sentence: "Most of the files concern harbour maintenance work.",
      expected: UNSETTLED,
      library: "open",
    },
    // A right count joined to a reading of the names, and a wrong count joined to one.
    {
      sentence: "Your Library holds 7 Documents, mostly planning and survey material.",
      expected: UNSETTLED,
      library: "open",
    },
    {
      sentence: "Your Library holds 12 Documents, mostly planning and survey material.",
      expected: NOT_SUPPORTED,
      library: "open",
    },
    // About the note itself.
    {
      sentence: "The Documents are described one by one further down.",
      expected: ["left-out"],
      library: "open",
    },
    {
      sentence: "This rundown is ordered alphabetically by file name.",
      expected: ["left-out"],
      library: "open",
    },
    // A fact and words about the note: the fact is checked, the rest left out.
    {
      sentence: "You also keep 2 other notes, which appear in the next section.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    // A Document's own figure, which no Library fact decides.
    { sentence: "The Kestrel plan budget is £40,000.", expected: ["supported"], library: "open" },
    // Decoy: the walled Folder's Documents counted from outside it.
    {
      sentence: "Your Library holds 9 Documents.",
      expected: NOT_SUPPORTED,
      library: "walled-outside",
    },
    {
      sentence: "Your Library holds 7 Documents.",
      expected: ["supported"],
      library: "walled-outside",
      aboutLibrary: true,
    },
    {
      sentence: "This Folder holds 2 Documents.",
      expected: ["supported"],
      library: "walled-inside",
      aboutLibrary: true,
    },
    {
      sentence: "This Folder holds 9 Documents.",
      expected: NOT_SUPPORTED,
      library: "walled-inside",
    },
  ],
  "zh-CN": [
    {
      sentence: "你的资料库里有 7 个文档。",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    { sentence: "你的资料库里有 10 个文档。", expected: NOT_SUPPORTED, library: "open" },
    {
      sentence: "Kestrel plan 在你的文件中出现了两次。",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    {
      sentence: "Harbour survey 在你的文件中出现了两次。",
      expected: NOT_SUPPORTED,
      library: "open",
    },
    {
      sentence: "“Research”文件夹里有 2 个文档。",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    {
      sentence: "你另外还保存了 2 篇笔记。",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    { sentence: "这些文件大多与港口维修有关。", expected: UNSETTLED, library: "open" },
    {
      sentence: "你的资料库里有 7 个文档，大多是规划和勘测方面的材料。",
      expected: UNSETTLED,
      library: "open",
    },
    { sentence: "后文逐一列出了这些文档。", expected: ["left-out"], library: "open" },
    { sentence: "你的资料库里有 9 个文档。", expected: NOT_SUPPORTED, library: "walled-outside" },
    {
      sentence: "这个文件夹里有 2 个文档。",
      expected: ["supported"],
      library: "walled-inside",
      aboutLibrary: true,
    },
  ],
};
