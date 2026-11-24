/**
 * A slide's speaker notes (#1264): the body placeholder of its notes slide is
 * written; a slide without one gets a notes slide on the deck's notes master,
 * and a deck without a notes master gets one, on a copy of its first theme.
 */

import { relationshipsPartOf } from "../../documents/formats/officePackage";
import { child, descendants, type XmlElement } from "../../documents/formats/xml";
import { PackagePartError } from "../packagePatch/package";
import { applySplices, endOf, type Splice, startOf } from "../packagePatch/text";
import { escapeXml } from "../wordml";
import {
  type Deck,
  NAMESPACE_DECLARATIONS,
  PRESENTATION_CONTENT_TYPES,
  PRESENTATION_RELATIONSHIPS,
  placeholderOf,
} from "./deck";
import { paragraphSplice } from "./shapes";

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const relativeFrom = (owner: string, part: string) => {
  const ownerFolders = owner.split("/").slice(0, -1);
  const target = part.split("/");
  let shared = 0;
  while (shared < ownerFolders.length && ownerFolders[shared] === target[shared]) shared++;
  return [...ownerFolders.slice(shared).map(() => ".."), ...target.slice(shared)].join("/");
};

const placeholderShape = (id: number, name: string, ph: string, body: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/>${body}</p:sp>`;

const TREE_START = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`;

/** A notes master as PowerPoint makes one: a slide image above a notes body, on the deck's theme. */
function notesMasterXml(): string {
  const style = (level: number) =>
    `<a:lvl${level}pPr marL="${(level - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${level}pPr>`;
  return `${DECLARATION}<p:notesMaster ${NAMESPACE_DECLARATIONS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${TREE_START}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1143000" y="685800"/><a:ext cx="4572000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(style).join("")}</p:notesStyle></p:notesMaster>`;
}

/** The notes master made for a deck that had none, so its next notes slide uses it too. */
const madeMasters = new WeakMap<Deck, string>();

/** The deck's notes master, made when it has none. */
async function notesMaster(deck: Deck): Promise<string> {
  const presentationPart = await deck.presentationPart();
  const relationships = await deck.pkg.relationshipsOf(presentationPart);
  const known =
    relationships.ofType(PRESENTATION_RELATIONSHIPS.notesMaster)?.target ?? madeMasters.get(deck);
  if (known) return known;
  // The presentation's theme, or its first master's: the notes master gets a copy of its own.
  const firstMaster = relationships.ofType(PRESENTATION_RELATIONSHIPS.slideMaster);
  const theme =
    relationships.ofType(PRESENTATION_RELATIONSHIPS.theme) ??
    (firstMaster &&
      (await deck.pkg.relationshipsOf(firstMaster.target)).ofType(
        PRESENTATION_RELATIONSHIPS.theme,
      ));
  const themeBytes = theme && (await deck.pkg.bytes(theme.target));
  if (!theme || !themeBytes)
    throw new PackagePartError(presentationPart, "has no theme for a notes master.");
  const master = deck.pkg.freeName("ppt/notesMasters/notesMaster", "xml");
  const masterTheme = deck.pkg.freeName("ppt/theme/theme", "xml");
  deck.pkg.add(master, notesMasterXml());
  deck.pkg.add(masterTheme, themeBytes);
  // The copy sits in the same folder, so the theme's own relationships (a background picture)
  // point at the same parts from it.
  const themeRelationships = await deck.pkg.bytes(relationshipsPartOf(theme.target));
  if (themeRelationships) deck.pkg.add(relationshipsPartOf(masterTheme), themeRelationships);
  await deck.pkg.addContentType(master, PRESENTATION_CONTENT_TYPES.notesMaster);
  await deck.pkg.addContentType(masterTheme, PRESENTATION_CONTENT_TYPES.theme);
  (await deck.pkg.relationshipsOf(master)).add(
    PRESENTATION_RELATIONSHIPS.theme,
    relativeFrom(master, masterTheme),
  );
  const id = relationships.add(
    PRESENTATION_RELATIONSHIPS.notesMaster,
    relativeFrom(presentationPart, master),
  );
  const presentation = await deck.pkg.part(presentationPart);
  if (!presentation) throw new PackagePartError(presentationPart, "is missing.");
  // The schema's order: sldMasterIdLst, then notesMasterIdLst.
  const masters = child(presentation.root, "p:sldMasterIdLst");
  if (!masters) throw new PackagePartError(presentationPart, "has no slide masters.");
  const at = endOf(masters);
  const list: Splice = {
    from: at,
    to: at,
    text: `<p:notesMasterIdLst><p:notesMasterId r:id="${id}"/></p:notesMasterIdLst>`,
  };
  deck.pkg.set(presentationPart, applySplices(presentation.text, [list]));
  madeMasters.set(deck, master);
  return master;
}

/** A notes slide for a slide that has none, its body holding the paragraphs. */
async function addNotesSlide(
  deck: Deck,
  slidePart: string,
  paragraphs: readonly string[],
): Promise<string> {
  const master = await notesMaster(deck);
  const notes = deck.pkg.freeName("ppt/notesSlides/notesSlide", "xml");
  const placeholder = `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody>`;
  const xml = `${DECLARATION}<p:notes ${NAMESPACE_DECLARATIONS}><p:cSld>${TREE_START}${placeholderShape(2, "Slide Image Placeholder 1", '<p:ph type="sldImg"/>', "")}${placeholderShape(3, "Notes Placeholder 2", '<p:ph type="body" idx="1"/>', placeholder)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
  deck.pkg.add(notes, xml);
  await deck.pkg.addContentType(notes, PRESENTATION_CONTENT_TYPES.notesSlide);
  const own = await deck.pkg.relationshipsOf(notes);
  own.add(PRESENTATION_RELATIONSHIPS.notesMaster, relativeFrom(notes, master));
  own.add(PRESENTATION_RELATIONSHIPS.slide, relativeFrom(notes, slidePart));
  (await deck.pkg.relationshipsOf(slidePart)).add(
    PRESENTATION_RELATIONSHIPS.notesSlide,
    relativeFrom(slidePart, notes),
  );
  await writeNotesBody(deck, notes, paragraphs);
  return notes;
}

function notesBody(root: XmlElement): XmlElement | undefined {
  return descendants(root, "p:sp").find((shape) => placeholderOf(shape)?.type === "body");
}

async function writeNotesBody(
  deck: Deck,
  notes: string,
  paragraphs: readonly string[],
): Promise<void> {
  const part = await deck.pkg.part(notes);
  if (!part) throw new PackagePartError(notes, "is missing.");
  const body = notesBody(part.root);
  if (!body) throw new PackagePartError(notes, "has no notes placeholder.");
  const txBody = child(body, "p:txBody");
  // A shape's text body comes before its p:extLst.
  const extLst = child(body, "p:extLst");
  const at = extLst ? startOf(extLst) : endOf(body) - "</p:sp>".length;
  const splice: Splice = txBody
    ? paragraphSplice(part.text, txBody, paragraphs)
    : {
        from: at,
        to: at,
        text: `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs
          .map(
            (each) =>
              `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(each)}</a:t></a:r></a:p>`,
          )
          .join("")}</p:txBody>`,
      };
  deck.pkg.set(notes, applySplices(part.text, [splice]));
}

/** Sets a slide's speaker notes; returns the notes slide's part. */
export async function setNotes(
  deck: Deck,
  slidePart: string,
  paragraphs: readonly string[],
): Promise<string> {
  const relationships = await deck.pkg.relationshipsOf(slidePart);
  const known = relationships.ofType(PRESENTATION_RELATIONSHIPS.notesSlide)?.target;
  if (!known || !deck.pkg.has(known)) return addNotesSlide(deck, slidePart, paragraphs);
  await writeNotesBody(deck, known, paragraphs);
  return known;
}
