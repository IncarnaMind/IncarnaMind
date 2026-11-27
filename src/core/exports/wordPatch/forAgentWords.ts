/**
 * What the Word file written for an outside agent shows, and the check that confirms it: every word
 * of it is one the agent was given (#3751). The cleaning is meant to leave nothing else; this says
 * whether it did, so a file it didn't clean wholly is written new instead.
 */
import { textOf, walk, type XmlElement } from "../../documents/formats/xml";
import { parentsOf } from "../packagePatch/text";
import { relationshipPrefixes, SHAPE_ID } from "./forAgentParts";
import { isKnownStyleId, isKnownStyleName, STYLE_REFERENCES } from "./forAgentStyles";

/** Elements whose text a file shows or keeps; any other element's text with a letter is read too. */
const TEXTS = new Set(["w:t", "w:delText", "a:t", "c:v", "m:t"]);
/** Elements whose text is a place, a measure, a date or a switch in Word's own words. */
const NON_WORD_TEXTS = new Set([
  "wp:align",
  "wp:posOffset",
  "wp14:pctWidth",
  "wp14:pctHeight",
  "dcterms:created",
  "dcterms:modified",
  "ScaleCrop",
  "LinksUpToDate",
  "SharedDoc",
  "HyperlinksChanged",
]);

/**
 * Attributes that hold no one's words, by name: ids, sizes, measures, colours, kinds and switches,
 * dates, languages, and the names of fonts, styles and themes, which are the file's look. Any
 * other attribute is read as words, so one nobody listed sends the file new.
 */
const NON_WORD = new Set(
  [
    // The package's own: content types, relationships, markup compatibility, spaces.
    "ContentType Extension PartName Id Type Target TargetMode Requires mc:Ignorable xsi:type",
    "mc:PreserveAttributes mc:ProcessContent mc:MustUnderstand xml:space xml:lang",
    // WordprocessingML.
    "w:type w:id w:color w:themeColor w:themeTint w:themeShade w:fill w:themeFill w:themeFillTint",
    "w:themeFillShade w:ascii w:hAnsi w:eastAsia w:cs w:asciiTheme w:hAnsiTheme w:eastAsiaTheme",
    "w:cstheme w:hint w:bidi w:lineRule w:fldCharType w:hRule w:hAnchor w:vAnchor w:horzAnchor",
    "w:vertAnchor w:xAlign w:yAlign w:tblpXSpec w:tblpYSpec w:wrap w:leader w:orient w:offsetFrom",
    "w:display w:zOrder w:usb0 w:usb1 w:usb2 w:usb3 w:csb0 w:csb1 w:characterSet w:char w:font",
    "w:fmt w:tplc w:displacedByCustomXml w:spelling w:grammar w:date w:fullDate w:edGrp",
    "w:default w:customStyle w:t1 w:t2 w:bg1 w:bg2 w:accent1 w:accent2 w:accent3",
    "w:accent4 w:accent5 w:accent6 w:hyperlink w:followedHyperlink w:appName w:dirty w:lock",
    "w:fldLock w:space w:shadow w:frame w:chapStyle w:chapSep w:dropCap w:lines w:hSpace",
    "w:vSpace w:x w:y w:w w:h w:val2 w:shapeid w:pos w:restart w:start w:end w:lang",
    "w:firstRow w:lastRow w:firstColumn w:lastColumn w:noHBand w:noVBand w:history w:vMerge",
    "w14:paraId w14:textId w14:anchorId w14:editId w14:font w15:paraId w15:paraIdParent",
    "w15:done wp14:anchorId wp14:editId wp14:pctWidth wp14:pctHeight w16cid:paraId",
    "w16cid:durableId w16cex:durableId w16cex:dateUtc w16du:dateUtc",
    // VML and Office's drawing attributes.
    "type style fillcolor filled strokecolor stroked strokeweight coordsize coordorigin path",
    "adj eqn joinstyle gradientshapeok connectlocs extrusionok textpathok on fitshape fitpath",
    "trim xscale arrowok aspectratio shadowcolor color color2 opacity origin",
    "position focus focussize focusposition method angle wrapcoords v:ext o:spt",
    "o:allowincell o:allowoverlap o:connecttype o:extrusionok o:preferrelative o:hr o:hrstd",
    "o:hrnoshade o:hrpct o:hralign o:bullet o:bwmode o:userdrawn o:dgmlayout o:dgmnodekind",
    "o:oned o:regroupid o:insetmode o:connectortype o:button o:hralign o:relid o:clip",
    "inset anchorx anchory weight",
    // DrawingML, charts and diagrams.
    "algn anchor anchorCtr arg axis bwMode cap cmpd dir cxnId destId srcId fact for forName from",
    "to func horzOverflow vertOverflow idx lastClr loCatId loTypeId csCatId csTypeId qsCatId",
    "qsTypeId max min meth minVer modelId mods op presAssocID presId presName presStyleLbl",
    "presStyleIdx presStyleCnt parTransId sibTransId prst ptType refType relativeFrom relId rig",
    "rotWithShape scaled script side strike styleLbl symbol typeface panose pitchFamily charset",
    "u uniqueId vert vid wrap wrapText cstate lang x y cx cy rot flipH flipV sz spc",
    "baseline dirty err noProof smtClean smtId kern fontAlgn latinLnBrk hangingPunct rtl eaLnBrk",
    "indent marL marR lvl defTabSz numCol rtlCol spcFirstLastPara lIns tIns rIns bIns forceAA",
    "upright compatLnSpc distT distB distL distR simplePos relativeHeight behindDoc locked",
    "layoutInCell allowOverlap hidden editAs noChangeAspect noChangeArrowheads noGrp noSelect",
    "noRot noMove noResize noEditPoints noAdjustHandles noChangeShapeType noTextEdit noCrop",
    "thresh amt lum bright contrast pos ang rad prstMaterial contourW extrusionH sx sy kx ky",
    "blurRad dist endPos stPos endA stA w h l t r b fLocksText fPublished",
    "roundtripDataSignature anchorId editId",
  ]
    .join(" ")
    .split(" "),
);

/**
 * Elements whose `w:val` (or `val`, `m:val`, `w14:val`) is a kind, a switch, a measure, a colour,
 * a language, a date's format or the name of a style, a font or a numbering format; an element
 * not listed is read as holding words in it.
 */
const VALUED = new Set(
  [
    "w:numFmt w:lvlJc w:suff w:multiLevelType w:nsid w:tmpl w:jc w:highlight w:u w:shd",
    "w:vertAlign w:em w:effect w:textDirection w:textAlignment w:vAlign w:vMerge w:hMerge w:type",
    "w:color w:lang w:lid w:calendar w:storeMappedDataAs w:docPartGallery",
    "w:gallery w:behavior w:family w:pitch w:charset w:panose1 w:altName",
    "w:encoding w:view w:zoom w:characterSpacingControl w:themeFontLang",
    "w:stylePaneFormatFilter w:stylePaneSortMethod w:targetScreenSz w:rsid w:rsidRoot w:formProt",
    "w:tab w:top w:bottom w:left w:right w:insideH w:insideV w:between w:bar w:start w:end",
    "w:tl2br w:tr2bl w:bdr w:b w:bCs w:i w:iCs w:caps w:smallCaps w:strike w:dstrike w:outline",
    "w:shadow w:emboss w:imprint w:vanish w:specVanish w:webHidden w:noProof w:snapToGrid w:rtl",
    "w:cs w:keepNext w:keepLines w:pageBreakBefore w:widowControl w:suppressLineNumbers",
    "w:suppressAutoHyphens w:kinsoku w:wordWrap w:overflowPunct w:topLinePunct w:autoSpaceDE",
    "w:autoSpaceDN w:bidi w:adjustRightInd w:contextualSpacing w:mirrorIndents w:suppressOverlap",
    "w:cantSplit w:tblHeader w:hidden w:noWrap w:tcFitText w:hideMark w:outlineLvl w:position",
    "w:kern w:sz w:szCs w:autoHyphenation w:bordersDoNotSurroundFooter",
    "w:bordersDoNotSurroundHeader w:evenAndOddHeaders w:trackRevisions w:gutterAtTop",
    "w:mirrorMargins w:titlePg w:noEndnote w:numRestart w:numStart w:cnfStyle w:tblLook",
    "w:tblStyleRowBandSize w:tblStyleColBandSize w:uiPriority w:qFormat w:semiHidden",
    "w:unhideWhenUsed w:locked w:personal w:personalCompose w:personalReply w:rsidRoot",
    "w:defaultTabStop w:proofState w:doNotTrackMoves w:doNotTrackFormatting w:updateFields",
    "w:hideSpellingErrors w:hideGrammaticalErrors w:decimalSymbol w:listSeparator w:ilvl w:numId",
    "w:abstractNumId w:lvlRestart w:isLgl w:legacy w:pos w:fitText w:w w:spacing w:effect",
    "w:docGrid w:pgNumType w:lnNumType w:cols w:textboxTightWrap w:doNotUseHTMLParagraphAutoSpacing",
    "w:styleLockTheme w:styleLockQFSet w:autoFormatOverride w:embedTrueTypeFonts",
    "w:saveSubsetFonts w:displayBackgroundShape w:doNotShadeFormData w:noPunctuationKerning",
    "w:alignBordersAndEdges w:doNotDisplayPageBoundaries w:removePersonalInformation",
    "w:removeDateAndTime w:doNotIncludeSubdocsInStats w:doNotAutoCompressPictures",
    "w:consecutiveHyphenLimit w:hyphenationZone w:doNotHyphenateCaps w:bookFoldRevPrinting",
    "w:bookFoldPrinting w:bookFoldPrintingSheets w:drawingGridHorizontalSpacing",
    "w:drawingGridVerticalSpacing w:displayHorizontalDrawingGridEvery",
    "w:displayVerticalDrawingGridEvery w:doNotUseMarginsForDrawingGridOrigin",
    "w:drawingGridHorizontalOrigin w:drawingGridVerticalOrigin w:printTwoOnOne",
    "w:strictFirstAndLastChars w:embedSystemFonts w:compatSetting w:showingPlcHdr w:temporary",
    "w:docPartUnique w:richText w:sdtLocked w:checked w:size w:sizeAuto w:maxLength",
    "w:numFmt w:footnotePr w:endnotePr w:pgMar w:pgSz w:ind w:framePr",
    "w14:ligatures w14:numForm w14:numSpacing w14:cntxtAlts w14:checked w14:checkedState",
    "w14:uncheckedState w14:docId w14:defaultImageDpi w14:discardImageEditingData",
    "w15:chartTrackingRefBased w15:collapsed w15:appearance w15:color w15:docId w15:webExtensionLinked",
    "w15:webExtensionCreated",
  ]
    .join(" ")
    .split(" "),
);
const VALUES = new Set(["w:val", "val", "m:val", "w14:val", "w15:val"]);
/** Namespaces whose `val` is a kind, a measure or a colour wherever it is: charts, drawings, diagrams, maths. */
const VALUED_NAMESPACE = /^(?:a|c|cs|dgm|c14|c15|c16|c16r2|c16r3|a14|a16|m|thm15):/;
/** Attributes whose names are a font's, which are its look: a font in the fonts' table, a setting's own name. */
const NAMED = new Set(["w:font", "w:compatSetting", "w:latentStyles"]);
/** A diagram's title and description, which are words wherever a diagram's other `val`s aren't. */
const DIAGRAM_WORDS = new Set(["dgm:title", "dgm:desc"]);
/** Elements whose `name` is a theme's or one of its schemes', the look the file was made with. */
const THEMED = new Set([
  "a:theme",
  "a:fontScheme",
  "a:clrScheme",
  "a:fmtScheme",
  "thm15:themeFamily",
]);

/** Whether an attribute holds anyone's words, by its name and its element's. */
function isWorded(element: XmlElement, name: string, relationships: readonly string[]): boolean {
  if (name === "xmlns" || name.startsWith("xmlns:")) return false;
  if (relationships.some((prefix) => name.startsWith(prefix))) return false;
  if (name.startsWith("w:rsid")) return false;
  if (VALUES.has(name) && DIAGRAM_WORDS.has(element.name)) return true;
  if (VALUES.has(name)) return !(VALUED.has(element.name) || VALUED_NAMESPACE.test(element.name));
  if (name === "w:name") return !NAMED.has(element.name);
  // A diagram's layout names its own nodes and rules.
  if (name === "name") return !(THEMED.has(element.name) || element.name.startsWith("dgm:"));
  return !NON_WORD.has(name);
}

/** A schema's name, or an id of a GUID's form: no one's words. */
const SCHEMA =
  /^(?:\{[0-9A-F-]{36}\}|https?:\/\/schemas\.(?:microsoft\.com|openxmlformats\.org)\/\S*|urn:schemas-microsoft-com:\S*)$/i;

/**
 * What of a number's format in a chart is shown as words: its quoted and escaped text, and any
 * letter that isn't one of the format's own (General, d, m, y, h, s, AM/PM, E).
 */
function formatWords(code: string): string {
  const literal = [...code.matchAll(/"([^"]*)"|\\(.)/g)].map(
    ([, quoted, escaped]) => quoted ?? escaped,
  );
  const rest = code
    .replace(/"[^"]*"|\\.|\[[^\]]*\]/g, " ")
    .replace(/General|AM\/PM|A\/P|[dmyhsbgeE]+/gi, " ");
  return [...literal, rest].join(" ");
}

/** What of a date's picture is shown as words: its quoted text and any letter that isn't one of its own. */
function dateWords(picture: string): string {
  const literal = [...picture.matchAll(/'([^']*)'/g)].map(([, quoted]) => quoted);
  const rest = picture.replace(/'[^']*'/g, " ").replace(/am\/pm|[dMyHhms]+/gi, " ");
  return [...literal, rest].join(" ");
}

/** A list level's number as words: its text without the numbers it shows, unless it is a bullet. */
function levelWords(level: XmlElement | undefined, text: string): string {
  const format = level?.children.find(
    (each): each is XmlElement => typeof each !== "string" && each.name === "w:numFmt",
  );
  return format?.attrs["w:val"] === "bullet" ? "" : text.replace(/%\d/g, " ");
}

/**
 * What of an attribute is anyone's words, by its name, its element's and its parent's; null when
 * none. A value with no letter in it is a number or a measure, and a bookmark Word names itself,
 * from "_", is no one's words.
 */
function attributeWords(
  element: XmlElement,
  parent: XmlElement | undefined,
  name: string,
  value: string,
  relationships: readonly string[],
): string | null {
  if (!/\p{L}/u.test(value)) return null;
  if (name === "w:instr") return instructionWords(value);
  if ((name === "w:name" || name === "w:anchor") && value.startsWith("_")) return null;
  if (name === "formatCode") return formatWords(value);
  if (name === "uri" || name === "w:uri") return SCHEMA.test(value) ? null : value;
  // A VML shape's id and its type's, which Word gives them itself.
  if (name === "id" || name === "o:spid") {
    return SHAPE_ID.test(value) || SCHEMA.test(value) ? null : value;
  }
  if (name === "type" && element.name.startsWith("v:") && value.startsWith("#")) {
    return SHAPE_ID.test(value.slice(1)) ? null : value;
  }
  if (name === "w:styleId") return isKnownStyleId(value) ? null : value;
  if (name === "w:name" && element.name === "w:lsdException") {
    return isKnownStyleName(value) ? null : value;
  }
  if (VALUES.has(name)) {
    if (STYLE_REFERENCES.has(element.name)) return isKnownStyleId(value) ? null : value;
    if (element.name === "w:name" && parent?.name === "w:style") {
      return isKnownStyleName(value) ? null : value;
    }
    if (element.name === "w:lvlText") return levelWords(parent, value);
    if (element.name === "w:dateFormat") return dateWords(value);
  }
  return isWorded(element, name, relationships) ? value : null;
}

/** Word's own fields, whose names are its words rather than anyone's. */
const FIELD_NAMES = new Set(
  (
    "TOC REF PAGEREF NOTEREF PAGE NUMPAGES SECTION SECTIONPAGES DATE TIME CREATEDATE SAVEDATE " +
    "PRINTDATE EDITTIME DOCPROPERTY DOCVARIABLE SEQ STYLEREF HYPERLINK TC TA TOA INDEX XE IF " +
    "QUOTE NUMWORDS NUMCHARS LISTNUM AUTONUM AUTONUMLGL AUTONUMOUT SYMBOL EQ FORMTEXT " +
    "FORMCHECKBOX FORMDROPDOWN ADVANCE BIBLIOGRAPHY CITATION REVNUM ="
  ).split(" "),
);
/** Switches whose argument is a format or a picture of one, in Word's own words. */
const FORMAT_SWITCHES = new Set(["\\*", "\\@", "\\#"]);
const TOKENS = /"[^"]*"|\S+/g;

/**
 * What of a field's instruction is anyone's words: not the field's name, its switches and their
 * formats, the bookmarks Word names itself, or a table of contents' levels.
 */
function instructionWords(instruction: string): string {
  const tokens = [...instruction.matchAll(TOKENS)].map(([token]) => token);
  const name = (tokens[0] ?? "").toUpperCase();
  if (!FIELD_NAMES.has(name)) return instruction;
  const words: string[] = [];
  for (let at = 1; at < tokens.length; at++) {
    const token = tokens[at] ?? "";
    const bare = token.replace(/^"|"$/g, "");
    if (token.startsWith("\\")) {
      if (FORMAT_SWITCHES.has(token) || name === "TOC") at++;
    } else if (!bare.startsWith("_")) words.push(bare);
  }
  return words.join(" ");
}

/**
 * Every text a part holds, in its elements and in every attribute not known to hold none: a value
 * with no letter in it is a number or a measure, and a bookmark Word names itself, from "_", is no
 * one's words.
 */
export function textsOf(root: XmlElement): string[] {
  const relationships = relationshipPrefixes(root);
  const parents = parentsOf(root);
  const texts: string[] = [];
  // A field's instruction can be written in several runs: it is read whole.
  const instructions: string[] = [];
  for (const element of [root, ...walk(root)]) {
    if (element.name === "w:fldChar") {
      const type = element.attrs["w:fldCharType"];
      if (type === "begin") instructions.push("");
      else if (type === "end" && instructions.length > 0) {
        texts.push(instructionWords(instructions.pop() ?? ""));
      }
    } else if (element.name === "w:instrText" || element.name === "w:delInstrText") {
      if (instructions.length > 0) instructions[instructions.length - 1] += textOf(element);
      else texts.push(textOf(element));
    } else if (TEXTS.has(element.name)) texts.push(textOf(element));
    else if (!NON_WORD_TEXTS.has(element.name)) {
      const own = element.children.filter((each) => typeof each === "string").join("");
      if (/\p{L}/u.test(own)) texts.push(element.name === "c:formatCode" ? formatWords(own) : own);
    }
    const parent = parents.get(element);
    for (const [name, value] of Object.entries(element.attrs)) {
      const words = attributeWords(element, parent, name, value, relationships);
      if (words !== null) texts.push(words);
    }
  }
  return [...texts, ...instructions];
}

/** What a cleaned part must not hold any more: a tracked change, an author, a chart's formula. */
const LEFT = new Set([
  "w:ins",
  "w:del",
  "w:moveFrom",
  "w:moveTo",
  "w:delText",
  "w:delInstrText",
  "w:commentReference",
  "w:dataBinding",
  "w:placeholder",
]);

/** A chart's formula into its workbook, in the chart namespaces Word writes. */
const CHART_FORMULA = /^(?:c|cx|c\d+\w*):f$/;

/** What of `LEFT` the part still holds, by its name; null when nothing. */
export function leftIn(root: XmlElement): string | null {
  for (const element of [root, ...walk(root)]) {
    if (LEFT.has(element.name) || element.name.endsWith("Change")) return element.name;
    if (element.attrs["w:author"] !== undefined) return "w:author";
    if (CHART_FORMULA.test(element.name)) return element.name;
  }
  return null;
}

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const CLOSE_WRITTEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
/** A number of a page, a list or a count: shown by the file's layout, not anyone's words. */
const SMALL_NUMBER = /^\p{N}{1,4}$/u;

/** The words of what the agent was given, to look a file's words up in. */
export interface Vocabulary {
  words: Set<string>;
  /** Text in scripts written without spaces, a line a run, for a run of it to be found in. */
  close: string;
}

export function vocabularyOf(texts: readonly string[]): Vocabulary {
  const words = new Set<string>();
  const close: string[] = [];
  for (const text of texts) {
    for (const [word] of text.matchAll(WORD)) {
      for (const [run] of word.matchAll(CLOSE_WRITTEN)) close.push(run);
      for (const rest of word.split(CLOSE_WRITTEN)) if (rest) words.add(rest.toLowerCase());
    }
  }
  return { words, close: close.join("\n") };
}

/** Whether every word of `text` is in `vocabulary`. */
export function knownIn(text: string, vocabulary: Vocabulary): boolean {
  for (const [word] of text.matchAll(WORD)) {
    for (const [run] of word.matchAll(CLOSE_WRITTEN)) {
      if (!vocabulary.close.includes(run)) return false;
    }
    for (const rest of word.split(CLOSE_WRITTEN)) {
      if (rest && !SMALL_NUMBER.test(rest) && !vocabulary.words.has(rest.toLowerCase())) {
        return false;
      }
    }
  }
  return true;
}
