import type { Element } from "@xmldom/xmldom";
import {
  cleanDescription,
  cleanText,
  cleanTitle,
  containsHan,
  findIsbns,
  isPlaceholder,
  normalizeDate,
  normalizeIsbn,
  normalizeLanguage,
  parseContributors,
  seriesPosition,
  type Contributor,
  type ContributorRole,
} from "./bibliography-normalize.js";
import type { CatalogEntry } from "./catalog-model.js";
import { plainText } from "./plain-text.js";
import { attr, elements, NS, textContent, xml } from "./xml.js";

const DC_NDL = "http://ndl.go.jp/dcndl/terms/";
const DC_TERMS = "http://purl.org/dc/terms/";
const MODS = "http://www.loc.gov/mods/v3";
const SRW = "http://www.loc.gov/zing/srw/";

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];
const str = (value: unknown): string =>
  typeof value === "string" || typeof value === "number"
    ? String(value).normalize("NFC").trim()
    : "";
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

const httpsCoverUrl = (
  raw: unknown,
  allowHttpUpgrade = false,
): string | undefined => {
  const value = str(raw);
  if (!value) return undefined;
  const candidate = allowHttpUpgrade
    ? value.replace(/^http:\/\//i, "https://")
    : value;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port
    )
      return undefined;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
};

/** Normalize a single MARC/ONIX personal-name string, stripping life dates and un-inverting `Last, First`. */
export function cleanCatalogPerson(value: string, inverted = false): string {
  const cleaned = value
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:,\s*|\s*[(（])\d{4}\s*-\s*\d{0,4}[)）]?\s*$/u, "")
    .replace(/[,，、;；:：]+$/u, "")
    .trim();
  if (!cleaned || isPlaceholder(cleaned)) return "";
  if (!inverted) return cleaned;
  const parts = cleaned.split(/\s*[,，]\s*/u).filter(Boolean);
  if (parts.length !== 2) return cleaned;
  return cjk.test(cleaned)
    ? `${parts[0]}${parts[1]}`
    : `${parts[1]} ${parts[0]}`;
}

function splitIsbdTitle(raw: string): { title: string; subtitle?: string } {
  const normalized = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  const [head, ...rest] = normalized.split(/\s+:\s+/);
  const mainPart = head.split(/\s+=\s+/)[0] ?? head;
  const title = cleanTitle(mainPart).value;
  const subRaw = rest
    .join(" : ")
    .split(/\s+=\s+/)[0]
    ?.trim();
  const subtitle = subRaw ? cleanText(subRaw) || undefined : undefined;
  return { title, ...(subtitle ? { subtitle } : {}) };
}

function splitSeriesLabel(raw: string): { series?: string; position?: string } {
  const head =
    raw
      .normalize("NFC")
      .split(/\s+\/\s+/)[0]
      ?.trim() ?? "";
  if (!head) return {};
  const match = /^(.+?)\s*[,;，；]\s*([^,;，；]{1,20})$/u.exec(head);
  if (match) {
    const pos = seriesPosition(match[2]);
    const series = cleanTitle(match[1], { suffixes: [] }).value;
    if (pos && series) return { series, position: pos };
  }
  const series = cleanTitle(head, { suffixes: [] }).value;
  return series ? { series } : {};
}

function addUniqueContributor(
  target: Contributor[],
  name: string,
  role: ContributorRole,
) {
  if (!name || isPlaceholder(name)) return;
  if (!target.some((item) => item.name === name && item.role === role))
    target.push({ name, role });
}

const onixRoles: Record<string, ContributorRole> = {
  A01: "aut",
  A03: "ant",
  A06: "ant",
  A07: "art",
  A12: "ill",
  A13: "pht",
  A35: "art",
  B01: "edt",
  B06: "trl",
  B09: "edt",
  B13: "edt",
};

export function parseOpenBd(payload: unknown): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const rawItem of list(payload)) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = obj(rawItem);
    const summary = obj(item.summary);
    const onix = obj(item.onix);
    const desc = obj(onix.DescriptiveDetail);
    const pubDetail = obj(onix.PublishingDetail);
    const collateral = obj(onix.CollateralDetail);

    const isbns: string[] = [];
    for (const candidate of [
      summary.isbn,
      onix.RecordReference,
      ...list(onix.ProductIdentifier).map((id) => obj(id).IDValue),
    ]) {
      const normalized = normalizeIsbn(str(candidate));
      if (normalized && !isbns.includes(normalized)) isbns.push(normalized);
    }
    const electronic = /^E[A-Z]$/i.test(str(desc.ProductForm));

    let title = "";
    let subtitle: string | undefined;
    let series: string | undefined;
    let position: string | undefined;
    for (const detail of list(desc.TitleDetail)) {
      const d = obj(detail);
      if (str(d.TitleType) && str(d.TitleType) !== "01") continue;
      for (const el of list(d.TitleElement)) {
        const e = obj(el);
        const level = str(e.TitleElementLevel);
        const text = str(obj(e.TitleText).content) || str(e.TitleText);
        if (level === "01" && text && !title) {
          title = cleanTitle(text).value;
          const sub = str(obj(e.Subtitle).content) || str(e.Subtitle);
          if (sub) subtitle = cleanText(sub) || undefined;
          const part = seriesPosition(str(e.PartNumber));
          if (part) position = part;
        } else if (level === "02" && text && !series) {
          series = cleanTitle(text, { suffixes: [] }).value || undefined;
          const part = seriesPosition(str(e.PartNumber));
          if (part && !position) position = part;
        }
      }
    }
    for (const col of list(desc.Collection)) {
      const c = obj(col);
      for (const td of list(c.TitleDetail)) {
        for (const el of list(obj(td).TitleElement)) {
          const e = obj(el);
          const text = str(obj(e.TitleText).content) || str(e.TitleText);
          if (text && !series)
            series = cleanTitle(text, { suffixes: [] }).value || undefined;
          const part = seriesPosition(str(e.PartNumber));
          if (part && !position) position = part;
        }
      }
    }
    if (!title && str(summary.title)) {
      const parsedTitle = splitIsbdTitle(str(summary.title));
      title = parsedTitle.title;
      subtitle ??= parsedTitle.subtitle;
    }
    if (!title) continue;
    if (!series && str(summary.series))
      series =
        cleanTitle(str(summary.series), { suffixes: [] }).value || undefined;
    if (!position && str(summary.volume))
      position = seriesPosition(str(summary.volume));

    const contributors: Contributor[] = [];
    for (const c of list(desc.Contributor)) {
      const node = obj(c);
      const roleCodes = list(node.ContributorRole).map(str);
      const role =
        roleCodes.map((code) => onixRoles[code]).find(Boolean) ?? "aut";
      const person =
        str(obj(node.PersonName).content) ||
        str(node.PersonName) ||
        str(obj(node.PersonNameInverted).content) ||
        str(node.PersonNameInverted) ||
        str(obj(node.CorporateName).content) ||
        str(node.CorporateName);
      const cleaned = cleanCatalogPerson(person, true);
      addUniqueContributor(contributors, cleaned, role);
    }
    if (!contributors.length && str(summary.author)) {
      for (const token of str(summary.author).split(/\s+/)) {
        const cleaned = cleanCatalogPerson(token, true);
        addUniqueContributor(contributors, cleaned, "aut");
      }
    }

    const pubNames = list(pubDetail.Publisher)
      .map((p) => cleanText(str(obj(p).PublisherName)))
      .filter(Boolean);
    const imprintNames = list(pubDetail.Imprint)
      .map((i) => cleanText(str(obj(i).ImprintName)))
      .filter(Boolean);
    const publisher =
      pubNames[0] ||
      cleanText(str(summary.publisher)) ||
      imprintNames[0] ||
      undefined;
    const imprint =
      imprintNames[0] && imprintNames[0] !== publisher
        ? imprintNames[0]
        : undefined;

    const dates = list(pubDetail.PublishingDate).map(obj);
    const preferredDate =
      dates.find((d) => str(d.PublishingDateRole) === "01")?.Date ??
      dates.find((d) => str(d.PublishingDateRole) === "11")?.Date ??
      dates[0]?.Date ??
      summary.pubdate;
    const date = normalizeDate(str(preferredDate));

    let language: string | undefined;
    for (const lang of list(desc.Language)) {
      const l = obj(lang);
      if (str(l.LanguageRole) && str(l.LanguageRole) !== "01") continue;
      language = normalizeLanguage(str(l.LanguageCode));
      if (language) break;
    }

    const texts = list(collateral.TextContent).map(obj);
    const rawSynopsis =
      texts.find((t) => str(t.TextType) === "03")?.Text ??
      texts.find((t) => str(t.TextType) === "02")?.Text;
    const description = rawSynopsis
      ? cleanDescription(str(rawSynopsis)).value || undefined
      : undefined;

    let onixCoverUrl: string | undefined;
    for (const resource of list(collateral.SupportingResource)) {
      const r = obj(resource);
      if (str(r.ResourceContentType) && str(r.ResourceContentType) !== "01")
        continue;
      for (const version of list(r.ResourceVersion)) {
        const candidate = httpsCoverUrl(obj(version).ResourceLink);
        if (candidate) {
          onixCoverUrl = candidate;
          break;
        }
      }
      if (onixCoverUrl) break;
    }
    const coverUrl = onixCoverUrl ?? httpsCoverUrl(summary.cover);

    const recordKey = isbns[0] ?? title;
    entries.push({
      provider: "openbd",
      recordId: `openbd:${recordKey}`,
      recordUrl: isbns[0]
        ? `https://api.openbd.jp/v1/get?isbn=${isbns[0]}`
        : "https://openbd.jp/",
      title,
      ...(subtitle ? { subtitle } : {}),
      contributors,
      ...(publisher ? { publisher } : {}),
      ...(imprint ? { imprint } : {}),
      ...(date ? { date } : {}),
      printIsbns: electronic ? [] : isbns,
      electronicIsbns: electronic ? isbns : [],
      ...(series ? { series } : {}),
      ...(position ? { position } : {}),
      ...(language ? { language } : {}),
      ...(description ? { description } : {}),
      ...(coverUrl ? { coverUrl } : {}),
    });
  }
  return entries;
}

const directChildren = (
  parent: Element,
  localName: string,
  namespace?: string,
) =>
  Array.from(parent.childNodes).filter(
    (node): node is Element =>
      node.nodeType === 1 &&
      (node as Element).localName === localName &&
      (!namespace || (node as Element).namespaceURI === namespace),
  );

export function parseNdlOpenSearch(xmlText: string): CatalogEntry[] {
  const document = xml(xmlText, "NDL OpenSearch");
  const entries: CatalogEntry[] = [];
  for (const item of elements(document, "item")) {
    const dcTitle =
      directChildren(item, "title", NS.dc)[0] ??
      directChildren(item, "title")[0];
    if (!dcTitle) continue;
    const parsedTitle = splitIsbdTitle(textContent(dcTitle));
    if (!parsedTitle.title) continue;

    const volumeText = textContent(
      directChildren(item, "volume", DC_NDL)[0] ??
        ({ textContent: "" } as Element),
    ).trim();
    const position = volumeText ? seriesPosition(volumeText) : undefined;

    const contributors: Contributor[] = [];
    const htmlSummary = textContent(
      directChildren(item, "description")[0] ??
        ({ textContent: "" } as Element),
    );
    const responsibility = /<li>\s*責任表示\s*[:：]\s*([\s\S]*?)<\/li>/iu.exec(
      htmlSummary,
    )?.[1];
    if (responsibility) {
      for (const person of parseContributors(plainText(responsibility))
        .contributors)
        addUniqueContributor(contributors, person.name, person.role);
    }
    if (!contributors.length) {
      for (const creator of directChildren(item, "creator", NS.dc)) {
        const cleaned = cleanCatalogPerson(textContent(creator), true);
        addUniqueContributor(contributors, cleaned, "aut");
      }
    }

    const publisher =
      cleanText(
        textContent(
          directChildren(item, "publisher", NS.dc)[0] ??
            ({ textContent: "" } as Element),
        ),
      ) || undefined;
    const issued = textContent(
      directChildren(item, "issued", DC_TERMS)[0] ??
        ({ textContent: "" } as Element),
    );
    const dcDate = textContent(
      directChildren(item, "date", NS.dc)[0] ??
        ({ textContent: "" } as Element),
    );
    const date = normalizeDate(issued) ?? normalizeDate(dcDate);

    const seriesRaw = textContent(
      directChildren(item, "seriesTitle", DC_NDL)[0] ??
        ({ textContent: "" } as Element),
    );
    const seriesParsed = seriesRaw ? splitSeriesLabel(seriesRaw) : {};

    const langRaw =
      textContent(
        directChildren(item, "language", DC_TERMS)[0] ??
          directChildren(item, "language", NS.dc)[0] ??
          ({ textContent: "" } as Element),
      ) || "";
    const language = normalizeLanguage(langRaw);

    const printIsbns: string[] = [];
    let bibId = "";
    for (const idNode of directChildren(item, "identifier", NS.dc)) {
      const kind = attr(idNode, "xsi:type");
      const val = textContent(idNode).trim();
      if (/ISBN$/i.test(kind)) {
        const normalized = normalizeIsbn(val);
        if (normalized && !printIsbns.includes(normalized))
          printIsbns.push(normalized);
      } else if (/NDLBibID$/i.test(kind) && val) {
        bibId = val;
      }
    }

    const link =
      textContent(
        directChildren(item, "guid")[0] ??
          directChildren(item, "link")[0] ??
          ({ textContent: "" } as Element),
      ).trim() || "https://ndlsearch.ndl.go.jp/";

    entries.push({
      provider: "ndl",
      recordId: bibId ? `ndl:${bibId}` : link,
      recordUrl: link,
      title: parsedTitle.title,
      ...(parsedTitle.subtitle ? { subtitle: parsedTitle.subtitle } : {}),
      contributors,
      ...(publisher ? { publisher } : {}),
      ...(date ? { date } : {}),
      printIsbns,
      electronicIsbns: [],
      ...(seriesParsed.series ? { series: seriesParsed.series } : {}),
      ...((position ?? seriesParsed.position)
        ? { position: position ?? seriesParsed.position }
        : {}),
      ...(language ? { language } : {}),
    });
  }
  return entries;
}

export function parseCiniiJson(payload: unknown): CatalogEntry[] {
  const graph = list(obj(payload)["@graph"]);
  const channel = obj(graph[0]);
  const entries: CatalogEntry[] = [];
  for (const rawItem of list(channel.items)) {
    const item = obj(rawItem);
    const rawTitle = str(item.title);
    if (!rawTitle) continue;
    const parsedTitle = splitIsbdTitle(rawTitle);
    if (!parsedTitle.title) continue;

    const contributors: Contributor[] = [];
    for (const creator of list(item["dc:creator"])) {
      for (const person of parseContributors(str(creator)).contributors) {
        const cleaned = cleanCatalogPerson(person.name);
        addUniqueContributor(contributors, cleaned, person.role);
      }
    }

    const rawPublishers = list(item["dc:publisher"])
      .map((p) => cleanText(str(p)))
      .filter(Boolean);
    const publisher =
      rawPublishers.find(
        (p) => !/[(（]\s*(?:总经销|總經銷|発売)\s*[)）]$/u.test(p),
      ) ?? rawPublishers[0];

    const date =
      normalizeDate(str(item["prism:publicationDate"])) ??
      normalizeDate(str(item["dc:date"]));

    let series: string | undefined;
    let position: string | undefined;
    for (const partOf of list(item["dcterms:isPartOf"])) {
      const label = str(obj(partOf)["dc:title"] ?? partOf);
      const parsedSeries = splitSeriesLabel(label);
      if (parsedSeries.series && !series) series = parsedSeries.series;
      if (parsedSeries.position && !position) position = parsedSeries.position;
    }

    const printIsbns: string[] = [];
    for (const part of list(item["dcterms:hasPart"])) {
      const id = str(obj(part)["@id"] ?? part);
      const normalized = normalizeIsbn(id);
      if (normalized && !printIsbns.includes(normalized))
        printIsbns.push(normalized);
    }

    const idUrl =
      str(item["@id"]) ||
      str(obj(item.link)["@id"]) ||
      "https://ci.nii.ac.jp/books/";
    const language = normalizeLanguage(str(item["dc:language"]));

    entries.push({
      provider: "cinii",
      recordId: idUrl,
      recordUrl: idUrl,
      title: parsedTitle.title,
      ...(parsedTitle.subtitle ? { subtitle: parsedTitle.subtitle } : {}),
      contributors,
      ...(publisher ? { publisher } : {}),
      ...(date ? { date } : {}),
      printIsbns,
      electronicIsbns: [],
      ...(series ? { series } : {}),
      ...(position ? { position } : {}),
      ...(language ? { language } : {}),
    });
  }
  return entries;
}

const modsRoles: [RegExp, ContributorRole][] = [
  [/^(?:aut|cre|author|creator|writer)$/i, "aut"],
  [/^(?:trl|translator)$/i, "trl"],
  [/^(?:edt|editor)$/i, "edt"],
  [/^(?:ill|illustrator)$/i, "ill"],
  [/^(?:pht|photographer)$/i, "pht"],
  [/^(?:art|artist)$/i, "art"],
  [/^(?:ant|bibliographic antecedent)$/i, "ant"],
];

/** Prefer native/non-Latn MARC-880 elements when an `altRepGroup` pairs vernacular CJK with transliteration. */
function preferNativeGroup(nodes: Element[]): Element[] {
  const nativeGroups = new Set<string>();
  for (const node of nodes) {
    const group = attr(node, "altRepGroup");
    const script = attr(node, "script").toLowerCase();
    if (group && (script !== "latn" || containsHan(textContent(node))))
      nativeGroups.add(group);
  }
  return nodes.filter((node) => {
    const group = attr(node, "altRepGroup");
    const script = attr(node, "script").toLowerCase();
    return !(group && script === "latn" && nativeGroups.has(group));
  });
}

export function parseLocSruMods(xmlText: string): CatalogEntry[] {
  const document = xml(xmlText, "LoC SRU MODS");
  const modsNodes = elements(document, "mods", MODS);
  const entries: CatalogEntry[] = [];
  for (const mods of modsNodes) {
    const titleInfos = preferNativeGroup(
      directChildren(mods, "titleInfo", MODS),
    );
    const primaryTitle = titleInfos.find((node) => !attr(node, "type"));
    const uniformTitle = titleInfos.find(
      (node) => attr(node, "type") === "uniform",
    );
    if (!primaryTitle) continue;
    const rawTitle = textContent(
      directChildren(primaryTitle, "title", MODS)[0] ??
        ({ textContent: "" } as Element),
    );
    const title = cleanTitle(rawTitle.replace(/\s*[/=:;,]\s*$/, "")).value;
    if (!title) continue;
    const rawSub = textContent(
      directChildren(primaryTitle, "subTitle", MODS)[0] ??
        ({ textContent: "" } as Element),
    ).replace(/\s*[/=:;,]\s*$/, "");
    const subtitle = cleanText(rawSub) || undefined;
    const partNumber = seriesPosition(
      textContent(
        directChildren(primaryTitle, "partNumber", MODS)[0] ??
          ({ textContent: "" } as Element),
      ),
    );
    const originalTitle = uniformTitle
      ? cleanText(
          textContent(
            directChildren(uniformTitle, "title", MODS)[0] ??
              ({ textContent: "" } as Element),
          ),
        ) || undefined
      : undefined;

    const contributors: Contributor[] = [];
    for (const nameNode of preferNativeGroup(
      directChildren(mods, "name", MODS),
    )) {
      const type = attr(nameNode, "type");
      const nameParts = directChildren(nameNode, "namePart", MODS)
        .filter(
          (part) => !["date", "termsOfAddress"].includes(attr(part, "type")),
        )
        .map((part) => textContent(part).trim())
        .filter(Boolean);
      const rawName = nameParts.join(" ");
      const cleaned = cleanCatalogPerson(rawName, type === "personal");
      const roleTerms = elements(nameNode, "roleTerm", MODS).map((el) =>
        textContent(el).trim(),
      );
      const role =
        roleTerms
          .map((term) => modsRoles.find(([pattern]) => pattern.test(term))?.[1])
          .find(Boolean) ?? "aut";
      addUniqueContributor(contributors, cleaned, role);
    }

    const origins = preferNativeGroup(directChildren(mods, "originInfo", MODS));
    let publisher: string | undefined;
    let date: string | undefined;
    for (const origin of origins) {
      if (!publisher) {
        const pub = cleanText(
          textContent(
            directChildren(origin, "publisher", MODS)[0] ??
              ({ textContent: "" } as Element),
          ).replace(/[,;:]\s*$/, ""),
        );
        if (pub) publisher = pub;
      }
      if (!date) {
        const dates = directChildren(origin, "dateIssued", MODS).filter(
          (node) => attr(node, "point") !== "end",
        );
        for (const d of dates) {
          const parsedDate = normalizeDate(textContent(d));
          if (parsedDate) {
            date = parsedDate;
            break;
          }
        }
      }
    }

    let language: string | undefined;
    for (const langTerm of elements(mods, "languageTerm", MODS)) {
      language = normalizeLanguage(textContent(langTerm));
      if (language) break;
    }

    const abstractText = directChildren(mods, "abstract", MODS)
      .map((el) => cleanDescription(textContent(el)).value)
      .find(Boolean);

    let series: string | undefined;
    let position = partNumber;
    for (const related of directChildren(mods, "relatedItem", MODS)) {
      if (attr(related, "type") !== "series") continue;
      const seriesTitles = preferNativeGroup(
        directChildren(related, "titleInfo", MODS),
      );
      const st = seriesTitles[0];
      if (!st) continue;
      const rawSeries = textContent(
        directChildren(st, "title", MODS)[0] ??
          ({ textContent: "" } as Element),
      ).replace(/\s*[;,]\s*$/, "");
      const parsedSeries = splitSeriesLabel(rawSeries);
      series ??= parsedSeries.series;
      position ??=
        seriesPosition(
          textContent(
            directChildren(st, "partNumber", MODS)[0] ??
              ({ textContent: "" } as Element),
          ),
        ) ?? parsedSeries.position;
    }

    const printIsbns: string[] = [];
    const electronicIsbns: string[] = [];
    for (const idNode of directChildren(mods, "identifier", MODS)) {
      if (attr(idNode, "type").toLowerCase() !== "isbn") continue;
      if (attr(idNode, "invalid") === "yes") continue;
      const raw = `${textContent(idNode)} ${attr(idNode, "qualifier")}`;
      const found = findIsbns(raw);
      const isEbook = /\b(e-?book|electronic|online|epub|pdf|kindle)\b/i.test(
        raw,
      );
      for (const isbn of found.valid) {
        const target = isEbook ? electronicIsbns : printIsbns;
        if (!target.includes(isbn)) target.push(isbn);
      }
    }

    const recordInfo = directChildren(mods, "recordInfo", MODS)[0];
    const lccn = recordInfo
      ? textContent(
          directChildren(recordInfo, "recordIdentifier", MODS)[0] ??
            ({ textContent: "" } as Element),
        ).trim()
      : "";
    const recordPosition = elements(document, "recordPosition", SRW)[0];
    const id =
      lccn ||
      textContent(recordPosition ?? ({ textContent: "1" } as Element)).trim();

    entries.push({
      provider: "loc",
      recordId: `loc:${id}`,
      recordUrl: lccn
        ? `https://lccn.loc.gov/${encodeURIComponent(lccn)}`
        : "https://catalog.loc.gov/",
      title,
      ...(subtitle ? { subtitle } : {}),
      ...(originalTitle && originalTitle !== title ? { originalTitle } : {}),
      contributors,
      ...(publisher ? { publisher } : {}),
      ...(date ? { date } : {}),
      printIsbns,
      electronicIsbns,
      ...(series ? { series } : {}),
      ...(position ? { position } : {}),
      ...(language ? { language } : {}),
      ...(abstractText ? { description: abstractText } : {}),
    });
  }
  return entries;
}

function extractOlText(value: unknown): string {
  if (typeof value === "string") return value;
  return str(obj(value).value);
}

export function parseOpenLibraryBooks(
  isbn: string,
  booksPayload: unknown,
  editionPayload?: unknown,
  workPayload?: unknown,
): CatalogEntry[] {
  const data = obj(obj(booksPayload)[`ISBN:${isbn}`]);
  const edition = obj(editionPayload);
  const work = obj(workPayload);
  const rawTitle = str(data.title) || str(edition.title);
  if (!rawTitle) return [];
  const parsedTitle = splitIsbdTitle(rawTitle);
  const subtitle =
    cleanText(str(data.subtitle) || str(edition.subtitle)) ||
    parsedTitle.subtitle;
  if (!parsedTitle.title) return [];

  const contributors: Contributor[] = [];
  const byStatement = str(data.by_statement) || str(edition.by_statement);
  if (byStatement) {
    for (const person of parseContributors(byStatement).contributors)
      addUniqueContributor(
        contributors,
        cleanCatalogPerson(person.name),
        person.role,
      );
  }
  for (const author of list(data.authors)) {
    const cleaned = cleanCatalogPerson(str(obj(author).name));
    if (
      cleaned &&
      !contributors.some((c) => c.name.toLowerCase() === cleaned.toLowerCase())
    )
      addUniqueContributor(contributors, cleaned, "aut");
  }

  const publisher =
    cleanText(str(obj(list(data.publishers)[0]).name)) ||
    cleanText(str(list(edition.publishers)[0])) ||
    undefined;
  const date = normalizeDate(
    str(data.publish_date) || str(edition.publish_date),
  );

  const identifiers = obj(data.identifiers);
  const printIsbns: string[] = [];
  for (const candidate of [
    isbn,
    ...list(identifiers.isbn_13),
    ...list(identifiers.isbn_10),
    ...list(edition.isbn_13),
    ...list(edition.isbn_10),
  ]) {
    const normalized = normalizeIsbn(str(candidate));
    if (normalized && !printIsbns.includes(normalized))
      printIsbns.push(normalized);
  }
  const formatText = str(edition.physical_format);
  const electronic = /\b(e-?book|electronic|epub|kindle)\b/i.test(formatText);

  let language: string | undefined;
  for (const lang of list(edition.languages)) {
    const code = str(obj(lang).key).replace(/^\/languages\//, "");
    language = normalizeLanguage(code);
    if (language) break;
  }

  let series: string | undefined;
  let position: string | undefined;
  for (const s of list(edition.series)) {
    const parsedSeries = splitSeriesLabel(str(s));
    if (parsedSeries.series && !series) series = parsedSeries.series;
    if (parsedSeries.position && !position) position = parsedSeries.position;
  }

  const rawSynopsis =
    extractOlText(edition.description) || extractOlText(work.description);
  const description = rawSynopsis
    ? cleanDescription(rawSynopsis).value || undefined
    : undefined;

  const coverObj = obj(data.cover);
  const editionCoverId = list(edition.covers).find(
    (id) => Number.isInteger(id) && Number(id) > 0,
  );
  const coverUrl =
    httpsCoverUrl(coverObj.large) ??
    httpsCoverUrl(coverObj.medium) ??
    (editionCoverId !== undefined
      ? `https://covers.openlibrary.org/b/id/${editionCoverId}-L.jpg`
      : undefined);

  const key = str(data.key) || str(edition.key) || `/isbn/${isbn}`;
  const rawUrl = str(data.url).replace(/^http:\/\//i, "https://");
  const recordUrl = rawUrl || `https://openlibrary.org${key}`;

  return [
    {
      provider: "openlibrary",
      recordId: `openlibrary:${key}`,
      recordUrl,
      title: parsedTitle.title,
      ...(subtitle ? { subtitle } : {}),
      contributors,
      ...(publisher ? { publisher } : {}),
      ...(date ? { date } : {}),
      printIsbns: electronic ? [] : printIsbns,
      electronicIsbns: electronic ? printIsbns : [],
      ...(series ? { series } : {}),
      ...(position ? { position } : {}),
      ...(language ? { language } : {}),
      ...(description ? { description } : {}),
      ...(coverUrl ? { coverUrl } : {}),
    },
  ];
}

export function parseOpenLibrarySearch(payload: unknown): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const rawDoc of list(obj(payload).docs)) {
    const doc = obj(rawDoc);
    const rawTitle = str(doc.title);
    if (!rawTitle) continue;
    const parsedTitle = splitIsbdTitle(rawTitle);
    if (!parsedTitle.title) continue;
    const subtitle = cleanText(str(doc.subtitle)) || parsedTitle.subtitle;

    const contributors: Contributor[] = [];
    for (const author of list(doc.author_name))
      addUniqueContributor(
        contributors,
        cleanCatalogPerson(str(author)),
        "aut",
      );

    const publisher = cleanText(str(list(doc.publisher)[0])) || undefined;
    const date =
      list(doc.publish_date)
        .map((d) => normalizeDate(str(d)))
        .find(Boolean) ?? normalizeDate(str(doc.first_publish_year));

    const printIsbns: string[] = [];
    for (const candidate of list(doc.isbn)) {
      const normalized = normalizeIsbn(str(candidate));
      if (normalized && !printIsbns.includes(normalized))
        printIsbns.push(normalized);
    }

    const language = list(doc.language)
      .map((l) => normalizeLanguage(str(l)))
      .find(Boolean);
    const coverId =
      Number.isInteger(doc.cover_i) && Number(doc.cover_i) > 0
        ? Number(doc.cover_i)
        : undefined;
    const coverUrl =
      coverId !== undefined
        ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
        : undefined;
    const key =
      str(doc.key) || `/search/${encodeURIComponent(parsedTitle.title)}`;

    entries.push({
      provider: "openlibrary",
      recordId: `openlibrary:${key}`,
      recordUrl: `https://openlibrary.org${key.startsWith("/") ? key : `/${key}`}`,
      title: parsedTitle.title,
      ...(subtitle ? { subtitle } : {}),
      contributors,
      ...(publisher ? { publisher } : {}),
      ...(date ? { date } : {}),
      printIsbns,
      electronicIsbns: [],
      ...(language ? { language } : {}),
      ...(coverUrl ? { coverUrl } : {}),
    });
  }
  return entries;
}

export function parseGoogleBooks(payload: unknown): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const rawItem of list(obj(payload).items)) {
    const item = obj(rawItem);
    const info = obj(item.volumeInfo);
    const sale = obj(item.saleInfo);
    const rawTitle = str(info.title);
    if (!rawTitle) continue;
    const title = cleanTitle(rawTitle).value;
    if (!title) continue;
    const subtitle = cleanText(str(info.subtitle)) || undefined;

    const contributors: Contributor[] = [];
    for (const author of list(info.authors)) {
      for (const person of parseContributors(str(author)).contributors)
        addUniqueContributor(
          contributors,
          cleanCatalogPerson(person.name),
          person.role,
        );
    }

    const publisher = cleanText(str(info.publisher)) || undefined;
    const date = normalizeDate(str(info.publishedDate));
    const language = normalizeLanguage(str(info.language));
    const description = str(info.description)
      ? cleanDescription(str(info.description)).value || undefined
      : undefined;

    const imageLinks = obj(info.imageLinks);
    const rawCover =
      str(imageLinks.extraLarge) ||
      str(imageLinks.large) ||
      str(imageLinks.medium) ||
      str(imageLinks.small) ||
      str(imageLinks.thumbnail);
    const coverUrl = httpsCoverUrl(
      rawCover,
      /^http:\/\/(?:books\.google\.com|books\.googleusercontent\.com)\//i.test(
        rawCover,
      ),
    );

    const isbns: string[] = [];
    for (const id of list(info.industryIdentifiers)) {
      const entry = obj(id);
      if (!/^ISBN_1[03]$/i.test(str(entry.type))) continue;
      const normalized = normalizeIsbn(str(entry.identifier));
      if (normalized && !isbns.includes(normalized)) isbns.push(normalized);
    }
    const electronic = sale.isEbook === true;
    const id = str(item.id) || isbns[0] || title;
    const rawLink = str(info.canonicalVolumeLink) || str(info.infoLink);
    const recordUrl = rawLink
      ? rawLink.replace(/^http:\/\//i, "https://")
      : `https://books.google.com/books?id=${encodeURIComponent(id)}`;

    entries.push({
      provider: "google-books",
      recordId: `google-books:${id}`,
      recordUrl,
      title,
      ...(subtitle ? { subtitle } : {}),
      contributors,
      ...(publisher ? { publisher } : {}),
      ...(date ? { date } : {}),
      printIsbns: electronic ? [] : isbns,
      electronicIsbns: electronic ? isbns : [],
      ...(language ? { language } : {}),
      ...(description ? { description } : {}),
      ...(coverUrl ? { coverUrl } : {}),
    });
  }
  return entries;
}
