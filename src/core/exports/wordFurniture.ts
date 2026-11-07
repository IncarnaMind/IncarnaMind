/**
 * The page numbers and watermark a Word file carries as its own (#1258): a footer with Word's
 * PAGE field, which Word updates and the User can edit there, and a header with Word's watermark
 * shape, which Design › Watermark › Remove Watermark takes out. Both ../docx and wordPatch write
 * the same parts.
 */
import { escapeXml, W_NAMESPACE, XML_DECLARATION } from "./wordml";

export const HEADER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
export const FOOTER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";
export const HEADER_RELATIONSHIP =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header";
export const FOOTER_RELATIONSHIP =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";

const VML_NAMESPACE = "urn:schemas-microsoft-com:vml";
const OFFICE_NAMESPACE = "urn:schemas-microsoft-com:office:office";

/** A footer that says nothing but the page number: Word's own PAGE field, which it updates and prints. */
export function pageNumberFooter(): string {
  return (
    `${XML_DECLARATION}<w:ftr xmlns:w="${W_NAMESPACE}">` +
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    "<w:r><w:t>1</w:t></w:r>" +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>'
  );
}

/**
 * A header holding Word's watermark: the VML shape its Watermark command writes, named
 * `PowerPlusWaterMarkObject`, which is what its Remove Watermark command finds.
 */
export function watermarkHeader(text: string): string {
  return (
    `${XML_DECLARATION}<w:hdr xmlns:w="${W_NAMESPACE}" xmlns:v="${VML_NAMESPACE}" xmlns:o="${OFFICE_NAMESPACE}">` +
    "<w:p><w:r><w:rPr><w:noProof/></w:rPr><w:pict>" +
    '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e">' +
    "<v:formulas>" +
    '<v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/>' +
    '<v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/>' +
    '<v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/>' +
    '<v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/>' +
    '<v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/>' +
    "</v:formulas>" +
    '<v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/>' +
    '<v:textpath on="t" fitshape="t"/>' +
    '<v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles>' +
    "</v:shapetype>" +
    '<v:shape id="PowerPlusWaterMarkObject357477219" o:spid="_x0000_s1025" type="#_x0000_t136"' +
    ' style="position:absolute;margin-left:0;margin-top:0;width:527.85pt;height:105.6pt;rotation:315;z-index:-251654144;mso-wrap-edited:f;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin"' +
    ' o:allowincell="f" fillcolor="silver" stroked="f">' +
    '<v:fill opacity=".5"/>' +
    `<v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="${escapeXml(text)}"/>` +
    "</v:shape></w:pict></w:r></w:p></w:hdr>"
  );
}

/** What a section says to use the header and footer parts it is given. */
export function pageMarksReferences({
  headerId,
  footerId,
}: {
  headerId?: string;
  footerId?: string;
}): string {
  return (
    (headerId ? `<w:headerReference w:type="default" r:id="${headerId}"/>` : "") +
    (footerId ? `<w:footerReference w:type="default" r:id="${footerId}"/>` : "")
  );
}
