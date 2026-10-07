import fs from "node:fs/promises";
import path from "node:path";
import { pack } from "../packages/core/src/zip.js";
import { NS } from "../packages/core/src/xml.js";
import { json } from "../packages/core/src/json.js";
import { repoRoot } from "../packages/core/src/runtime.js";
import { resolveMetadata } from "../packages/core/src/metadata.js";
for (const [name, uuid] of [
  ["literature", "11111111-1111-4111-8111-111111111111"],
  ["technical", "22222222-2222-4222-8222-222222222222"],
]) {
  const directory = path.join(repoRoot, "examples", name);
  await json(path.join(directory, "metadata/identity.json"), {
    uuid: `urn:uuid:${uuid}`,
  });
  await json(path.join(directory, "metadata/decisions.json"), { fields: {} });
  const resolved = await resolveMetadata(directory);
  if (resolved.status === "fail") throw new Error(JSON.stringify(resolved));
}
const entries = new Map<string, Uint8Array>();
const set = (name: string, value: string) =>
  entries.set(name, Buffer.from(value));
set("mimetype", "application/epub+zip");
set(
  "META-INF/container.xml",
  `<?xml version="1.0"?><container xmlns="${NS.container}" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
);
set(
  "OEBPS/content.opf",
  `<?xml version="1.0"?><package xmlns="${NS.opf}" version="2.0" unique-identifier="uid"><metadata xmlns:dc="${NS.dc}"><dc:identifier id="uid">urn:uuid:33333333-3333-4333-8333-333333333333</dc:identifier><dc:title>Preserved Pages</dc:title><dc:language>en</dc:language><dc:creator>Example Author</dc:creator><dc:contributor>Example Translator</dc:contributor><dc:description>An original legacy EPUB fixture.</dc:description><dc:rights>Copyright 2026 Example Author</dc:rights><meta name="custom:edition-note" content="Preserve this unknown metadata"/></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="style" href="style.css" media-type="text/css"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="chapter"/></spine></package>`,
);
set(
  "OEBPS/chapter.xhtml",
  `<?xml version="1.0"?><html xmlns="${NS.xhtml}" xml:lang="en"><head><title>Preserved Pages</title><link rel="stylesheet" href="style.css" type="text/css"/></head><body><h1 id="chapter">Preserved Pages</h1><p>A repair preserves the words, their order, and the identity of the original publication.</p><h2 id="details">Details</h2><p>This chapter links to <a href="#chapter">its beginning</a>.</p></body></html>`,
);
set(
  "OEBPS/style.css",
  "body { font-size: 16px; line-height: 24px; }\nh1, h2 { text-align: left; }\n",
);
set(
  "OEBPS/toc.ncx",
  '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:33333333-3333-4333-8333-333333333333"/></head><docTitle><text>Preserved Pages</text></docTitle><navMap><navPoint id="point" playOrder="1"><navLabel><text>Preserved Pages</text></navLabel><content src="chapter.xhtml#chapter"/></navPoint></navMap></ncx>',
);
await fs.mkdir(path.join(repoRoot, "examples/repair"), { recursive: true });
await fs.writeFile(
  path.join(repoRoot, "examples/repair/legacy.epub"),
  pack(entries, 946684800),
);
console.log(
  "Prepared deterministic literature, technical, and EPUB 2 repair fixtures.",
);
