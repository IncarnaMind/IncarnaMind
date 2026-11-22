/**
 * The app's own links (#3534): one item by its id, and every other shape read as no item, so an
 * outside link can only ever bring the app forward or show one item of the User's.
 */
import { describe, expect, it } from "vitest";
import {
  APP_LINK_SCHEME,
  appLink,
  appLinkIn,
  isAppLink,
  readAppLink,
} from "../../src/shared/appLinks";

const ID = "3f6c2a1e-8b1d-4c1e-9a2b-1f0e7d6c5b4a";
const at = (rest: string) => `${APP_LINK_SCHEME}://${rest}`;

describe("the app's own links", () => {
  // protects=a link names one item by its kind and id and nothing else, and reads back as that item (#3534); fails_when=a link carries anything beyond the kind and the id, or doesn't read back
  it("names a Note, a file or a Canvas by its id, and reads back as it", () => {
    for (const kind of ["note", "file", "canvas"] as const) {
      const link = appLink({ kind, id: ID });
      expect(link).toBe(at(`${kind}/${ID}`));
      expect(readAppLink(link)).toEqual({ kind, id: ID });
    }
    expect(appLink({ kind: "note", id: ID.toUpperCase() })).toBe(at(`note/${ID}`));
    expect(readAppLink(`${APP_LINK_SCHEME.toUpperCase()}://note/${ID}`)).toEqual({
      kind: "note",
      id: ID,
    });
  });

  // protects=any other shape names no item, so it can only bring the app forward (#3534); fails_when=a link with another kind, a malformed id, more path, a query, a fragment, user info or a port is read as an item
  it.each([
    ["another kind", at(`document/${ID}`)],
    ["a kind in capitals", at(`NOTE/${ID}`)],
    ["an id that isn't a UUID", at("note/42")],
    ["an id in capitals", at(`note/${ID.toUpperCase()}`)],
    ["no id", at("note/")],
    ["a second path part", at(`note/${ID}/edit`)],
    ["a trailing slash", at(`note/${ID}/`)],
    ["a query", at(`note/${ID}?delete=1`)],
    ["a fragment", at(`note/${ID}#top`)],
    ["user info", at(`someone@note/${ID}`)],
    ["a port", at(`note:80/${ID}`)],
    ["a path climbing out", at(`note/../${ID}`)],
    ["a verb", at(`open/note/${ID}`)],
    ["nothing after the scheme", at("")],
    ["another scheme", `https://note/${ID}`],
    ["an overlong link", at(`note/${ID}${"0".repeat(200)}`)],
  ])("reads %s as no item", (_, link) => {
    expect(readAppLink(link)).toBeNull();
  });

  // protects=a link handed over in a start's arguments (Windows and Linux) is found among them, whatever else is there (#3534); fails_when=another argument is taken for a link, or the link is missed
  it("is found among a start's arguments", () => {
    const link = at(`canvas/${ID}`);
    expect(appLinkIn(["/opt/IncarnaMind/incarnamind", "--no-sandbox", link])).toBe(link);
    expect(appLinkIn(["/opt/IncarnaMind/incarnamind", "--no-sandbox"])).toBeNull();
    expect(isAppLink(`https://example.com/${APP_LINK_SCHEME}://note/${ID}`)).toBe(false);
  });
});
