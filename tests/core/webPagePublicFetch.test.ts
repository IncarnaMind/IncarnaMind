/**
 * A saved web page is fetched only from the public internet (#2553): an
 * address on this computer or a local network is refused before any request,
 * and so is a redirect to one, whether written as an address or resolved from
 * a name. A local server stands in for the web: the guard still decides which
 * hosts are reached, and every request it heard is kept.
 */
import { describe, expect, test } from "vitest";
import { createTempDataFolder, startCore } from "../helpers/core";
import { waitForProcessing } from "../helpers/documents";
import { connectorTo, PUBLIC_ADDRESS, startWeb } from "../helpers/web";

const PAGE = `<!doctype html><html><head><title>Tea in Europe</title></head><body><article>
<h1>Tea in Europe</h1>
<p>Portuguese traders first met tea in Macau late in the sixteenth century. The leaves reached
Lisbon by way of the trading houses of the South China coast, and from there the Dutch and the
English carried them north.</p>
<p>By the seventeenth century, tea had become an ordinary drink in the ports of western Europe.
Merchants sold it by the pound in the coffee houses, and the ships that brought it also brought
porcelain cups, which the customers of those houses soon preferred to their own.</p>
<p>Taxes on the leaf were heavy and were paid at the customs house before any of it could be sold.
The trade grew all the same, and the routes it used came to shape the ports that served it.</p>
</article></body></html>`;

describe("A saved page reaches only the public internet", { timeout: 30_000 }, () => {
  /** A core whose web fetcher resolves names as `router.example` to a private address. */
  async function setUp() {
    const web = await startWeb({
      "/tea": () => ({ status: 200, body: PAGE }),
      "/secret": () => ({ status: 200, body: PAGE }),
      "/to-loopback": (port) => ({
        status: 302,
        headers: { Location: `http://127.0.0.1:${port}/secret` },
      }),
      "/to-private": () => ({ status: 302, headers: { Location: "http://10.0.0.1/admin" } }),
      "/to-link-local": () => ({
        status: 307,
        headers: { Location: "http://169.254.169.254/latest/meta-data/" },
      }),
      "/to-private-name": () => ({
        status: 301,
        headers: { Location: "http://router.example/admin" },
      }),
    });
    const core = startCore(await createTempDataFolder(), {
      web: {
        resolve: async (hostname) => [
          {
            address:
              hostname === "router.example" || hostname === "intranet.example"
                ? "10.0.0.5"
                : PUBLIC_ADDRESS,
            family: 4,
          },
        ],
        connector: connectorTo(web.port),
      },
    });
    return { core, web };
  }

  test("a public page is saved", async () => {
    const { core, web } = await setUp();

    const saved = await core.saveWebPage({ address: "http://news.example/tea" });
    if (saved.outcome !== "saved") throw new Error(JSON.stringify(saved));
    expect(saved.document.name).toBe("Tea in Europe");
    await waitForProcessing(core, [saved.document.id]);
    expect(web.heard).toEqual(["news.example/tea"]);
  });

  test("an address on this computer is refused, and nothing is fetched", async () => {
    const { core, web } = await setUp();

    expect(await core.saveWebPage({ address: `http://127.0.0.1:${web.port}/tea` })).toMatchObject({
      outcome: "failed",
      failure: { reason: "not-public" },
    });
    expect(web.heard).toEqual([]);
  });

  test("a name that resolves to a private address is refused, and nothing is fetched", async () => {
    const { core, web } = await setUp();

    expect(await core.saveWebPage({ address: "http://intranet.example/tea" })).toMatchObject({
      outcome: "failed",
      failure: { reason: "not-public" },
    });
    expect(web.heard).toEqual([]);
  });

  test.each([
    ["loopback", "/to-loopback"],
    ["a private address", "/to-private"],
    ["a cloud's metadata service", "/to-link-local"],
    ["a name that resolves to a private address", "/to-private-name"],
  ])("a redirect to %s is refused, and nothing is fetched", async (_what, path) => {
    const { core, web } = await setUp();

    expect(await core.saveWebPage({ address: `http://news.example${path}` })).toMatchObject({
      outcome: "failed",
      failure: { reason: "not-public" },
    });
    expect(web.heard).toEqual([`news.example${path}`]);
  });
});
