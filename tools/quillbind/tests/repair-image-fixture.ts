import fs from "node:fs/promises";
import path from "node:path";
import { inspectBytes } from "../packages/core/src/epub.js";
import { pack } from "../packages/core/src/zip.js";
import { repoRoot } from "../packages/core/src/runtime.js";

export const repairImageChapter = "OEBPS/chapter.xhtml";
export const repairImagePath = "OEBPS/swatch.svg";
export const repairImageBody = `
<p id="paragraph"><img id="plain" class="offset" src="swatch.svg" alt="Plain swatch" width="120" height="60"/></p>
<div id="linked"><a class="wrapper" href="#details"><span class="wrapper"><img id="wrapped" src="swatch.svg" alt="Linked swatch" style="display: inline; float: left; margin: 0 0 0 1em; border: 0 solid;"/></span></a></div>
<figure id="figure"><!-- retained comment --><img id="captioned" class="offset" src="swatch.svg" alt="Captioned swatch"/><figcaption id="caption">A caption keeps its alignment.</figcaption></figure>
<figure id="nested"><p><a href="#details"><img id="nested-image" class="offset" src="swatch.svg" alt="Nested swatch"/></a></p><figcaption>A nested caption.</figcaption></figure>
<p id="inline">Before <img class="inline" src="swatch.svg" alt="Inline marker"/> after.</p>
<p id="gallery"><img src="swatch.svg" alt="First swatch"/> <img src="swatch.svg" alt="Second swatch"/></p>
<table id="table"><caption>Markers</caption><tr><th scope="col">Marker</th></tr><tr><td><p><img src="swatch.svg" alt="Table marker"/></p></td></tr></table>
`;

export async function repairImageFixture(
  options: {
    body?: string;
    direction?: "ltr" | "rtl";
    vertical?: boolean;
  } = {},
) {
  const original = await fs.readFile(
    path.join(repoRoot, "examples/repair/legacy.epub"),
  );
  const info = inspectBytes(original);
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  entries.set(
    info.packagePath,
    Buffer.from(
      entries
        .get(info.packagePath)!
        .toString()
        .replace(
          "</manifest>",
          '<item id="swatch" href="swatch.svg" media-type="image/svg+xml"/></manifest>',
        ),
    ),
  );
  entries.set(
    repairImagePath,
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><rect width="120" height="60" fill="#427788"/></svg>',
    ),
  );
  entries.set(
    repairImageChapter,
    Buffer.from(
      entries
        .get(repairImageChapter)!
        .toString()
        .replace("<html ", `<html dir="${options.direction ?? "ltr"}" `)
        .replace("</body>", `${options.body ?? repairImageBody}</body>`),
    ),
  );
  entries.set(
    "OEBPS/style.css",
    Buffer.from(
      entries.get("OEBPS/style.css")!.toString() +
        `
html { writing-mode: ${options.vertical ? "vertical-rl" : "horizontal-tb"}; }
p { text-indent: 2em; }
img { max-width: 100%; height: auto; }
img.offset { display: block; float: left; margin-left: 1em; margin-right: 0; margin-inline-start: 2em; margin-inline-end: 0; }
.wrapper { display: inline-block; }
img.inline { height: 1em; width: auto; }
figcaption { text-align: right; }
`,
    ),
  );
  return pack(entries, 946684800);
}
