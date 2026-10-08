import { pack } from "../packages/core/src/zip.js";

export const noteScript = `document.addEventListener('click', function(event) {
  const link = event.target.closest('a');
  if (!link) return;
  if (link.id === 'ref' || link.id === 'ref2') {
    event.preventDefault();
    document.getElementById('note').hidden = false;
    document.getElementById('back').dataset.returnTo = link.id;
  }
  if (link.id === 'back') {
    event.preventDefault();
    document.getElementById('note').hidden = true;
    document.getElementById(link.dataset.returnTo || 'ref').focus();
  }
});`;

export function noteEntries() {
  return new Map(
    Object.entries({
      mimetype: "application/epub+zip",
      "META-INF/container.xml":
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      "OEBPS/package.opf":
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:10000000-0000-4000-8000-000000000001</dc:identifier><dc:title>Popup notes</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-08T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" properties="scripted"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="notes" href="notes.js" media-type="text/javascript"/><item id="css" href="notes.css" media-type="text/css"/></manifest><spine><itemref idref="chapter"/></spine></package>',
      "OEBPS/nav.xhtml":
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>',
      "OEBPS/chapter.xhtml":
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en"><head><title>Chapter</title><link rel="stylesheet" href="notes.css"/><script src="notes.js"></script></head><body><h1>Chapter</h1><p>Text <a id="ref" href="#note" epub:type="noteref" role="doc-noteref">1</a>.</p><aside id="note" epub:type="footnote" role="doc-footnote" hidden="hidden"><p>A popup note. <a id="back" href="#ref" role="doc-backlink">Back</a></p></aside></body></html>',
      "OEBPS/notes.css":
        "body { font-size: 16px; } [hidden] { display: none; } aside { border: 1px solid; padding: 1em; }",
      "OEBPS/notes.js": noteScript,
    }).map(([name, value]) => [name, Buffer.from(value)]),
  );
}
export function noteFixture(edit?: (entries: Map<string, Buffer>) => void) {
  const entries = noteEntries();
  edit?.(entries);
  return pack(entries, 946684800);
}
