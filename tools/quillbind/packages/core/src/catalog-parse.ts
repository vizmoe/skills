import type { Document, Element } from "@xmldom/xmldom";
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

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined) return [];
  return [value];
}
const str = (value: unknown): string =>
  typeof value === "string" || typeof value === "number"
    ? String(value).normalize("NFC").trim()
    : "";
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function stripTrailingChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

function stripTrailingPunct(value: string, chars: string): string {
  const trimmed = value.trimEnd();
  if (trimmed.length > 0 && chars.includes(trimmed[trimmed.length - 1]))
    return trimmed.slice(0, -1).trimEnd();
  return value;
}

const isAsciiDigit = (char: string) => char >= "0" && char <= "9";

function skipBackwardSpaces(value: string, pos: number): number {
  let cursor = pos;
  while (cursor > 0 && /\s/.test(value[cursor - 1])) cursor -= 1;
  return cursor;
}

function findDashBeforeDeathYear(value: string): number {
  let pos = value.trimEnd().length;
  if (pos > 0 && (value[pos - 1] === ")" || value[pos - 1] === "）")) pos -= 1;
  let deathDigits = 0;
  while (pos > 0 && deathDigits < 4 && isAsciiDigit(value[pos - 1])) {
    pos -= 1;
    deathDigits += 1;
  }
  pos = skipBackwardSpaces(value, pos);
  if (pos === 0 || value[pos - 1] !== "-") return -1;
  return pos - 1;
}

function hasFourAsciiDigitsBefore(value: string, pos: number): boolean {
  if (pos < 4) return false;
  for (let i = 1; i <= 4; i++) {
    if (!isAsciiDigit(value[pos - i])) return false;
  }
  return true;
}

function stripTrailingLifeDates(value: string): string {
  const dashPos = findDashBeforeDeathYear(value);
  if (dashPos === -1) return value;
  const yearEnd = skipBackwardSpaces(value, dashPos);
  if (!hasFourAsciiDigitsBefore(value, yearEnd)) return value;
  const yearStart = yearEnd - 4;
  if (
    yearStart > 0 &&
    (value[yearStart - 1] === "(" || value[yearStart - 1] === "（")
  )
    return value.slice(0, skipBackwardSpaces(value, yearStart - 1));
  const beforeSpaces = skipBackwardSpaces(value, yearStart);
  if (beforeSpaces > 0 && value[beforeSpaces - 1] === ",")
    return value.slice(0, beforeSpaces - 1);
  return value;
}

type OptionalCatalogFields = Partial<
  Pick<
    CatalogEntry,
    | "subtitle"
    | "originalTitle"
    | "publisher"
    | "imprint"
    | "date"
    | "series"
    | "position"
    | "language"
    | "description"
    | "coverUrl"
  >
>;

type RequiredCatalogFields = Omit<CatalogEntry, keyof OptionalCatalogFields>;

function buildCatalogEntry(
  base: RequiredCatalogFields,
  optional: OptionalCatalogFields,
): CatalogEntry {
  const entry: CatalogEntry = { ...base };
  for (const [key, value] of Object.entries(optional)) {
    if (value) Object.assign(entry, { [key]: value });
  }
  return entry;
}

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
  const normalized = value.normalize("NFC").replace(/\s+/g, " ").trim();
  const cleaned = stripTrailingChars(
    stripTrailingLifeDates(normalized),
    ",，、;；:：",
  ).trim();
  if (!cleaned || isPlaceholder(cleaned)) return "";
  if (!inverted) return cleaned;
  const parts = cleaned
    .split(/[,，]/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 2) return cleaned;
  return cjk.test(cleaned)
    ? `${parts[0]}${parts[1]}`
    : `${parts[1]} ${parts[0]}`;
}

function splitIsbdTitle(raw: string): { title: string; subtitle?: string } {
  const normalized = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  const [head, ...rest] = normalized.split(" : ");
  const mainPart = head.split(" = ")[0] ?? head;
  const title = cleanTitle(mainPart).value;
  const subRaw = rest.join(" : ").split(" = ")[0]?.trim();
  const subtitle = subRaw ? cleanText(subRaw) || undefined : undefined;
  return { title, ...(subtitle ? { subtitle } : {}) };
}

function splitSeriesComma(head: string): [string, string] | undefined {
  const sep = Math.max(
    head.lastIndexOf(","),
    head.lastIndexOf(";"),
    head.lastIndexOf("，"),
    head.lastIndexOf("；"),
  );
  if (sep <= 0) return undefined;
  const left = head.slice(0, sep).trimEnd();
  const right = head.slice(sep + 1).trimStart();
  if (!left || !right || right.length > 20) return undefined;
  return [left, right];
}

function splitSeriesLabel(raw: string): { series?: string; position?: string } {
  const head =
    raw.normalize("NFC").replace(/\s+/g, " ").split(" / ")[0]?.trim() ?? "";
  if (!head) return {};
  const split = splitSeriesComma(head);
  if (split) {
    const pos = seriesPosition(split[1]);
    const series = cleanTitle(split[0], { suffixes: [] }).value;
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

function extractOpenBdIsbns(
  summary: Record<string, unknown>,
  onix: Record<string, unknown>,
): string[] {
  const isbns: string[] = [];
  for (const candidate of [
    summary.isbn,
    onix.RecordReference,
    ...list(onix.ProductIdentifier).map((id) => obj(id).IDValue),
  ]) {
    const normalized = normalizeIsbn(str(candidate));
    if (normalized && !isbns.includes(normalized)) isbns.push(normalized);
  }
  return isbns;
}

function readOnixTitleElements(
  titleDetails: unknown,
  onElement: (el: Record<string, unknown>) => void,
  onlyType01: boolean,
) {
  for (const detail of list(titleDetails)) {
    const d = obj(detail);
    if (onlyType01 && str(d.TitleType) && str(d.TitleType) !== "01") continue;
    for (const el of list(d.TitleElement)) onElement(obj(el));
  }
}

interface OpenBdTitles {
  title: string;
  subtitle?: string;
  series?: string;
  position?: string;
}

function applyOpenBdTitleElement(
  e: Record<string, unknown>,
  acc: OpenBdTitles,
) {
  const level = str(e.TitleElementLevel);
  const text = str(obj(e.TitleText).content) || str(e.TitleText);
  if (level === "01" && text && !acc.title) {
    acc.title = cleanTitle(text).value;
    const sub = str(obj(e.Subtitle).content) || str(e.Subtitle);
    if (sub) acc.subtitle = cleanText(sub) || undefined;
    acc.position = seriesPosition(str(e.PartNumber)) ?? acc.position;
    return;
  }
  if (level === "02" && text && !acc.series) {
    acc.series = cleanTitle(text, { suffixes: [] }).value || undefined;
    acc.position ??= seriesPosition(str(e.PartNumber));
  }
}

function applyOpenBdCollectionElement(
  e: Record<string, unknown>,
  acc: OpenBdTitles,
) {
  const text = str(obj(e.TitleText).content) || str(e.TitleText);
  if (text && !acc.series)
    acc.series = cleanTitle(text, { suffixes: [] }).value || undefined;
  acc.position ??= seriesPosition(str(e.PartNumber));
}

function extractOpenBdTitles(
  desc: Record<string, unknown>,
  summary: Record<string, unknown>,
): OpenBdTitles {
  const acc: OpenBdTitles = { title: "" };
  readOnixTitleElements(
    desc.TitleDetail,
    (e) => applyOpenBdTitleElement(e, acc),
    true,
  );
  for (const col of list(desc.Collection)) {
    readOnixTitleElements(
      obj(col).TitleDetail,
      (e) => applyOpenBdCollectionElement(e, acc),
      false,
    );
  }
  if (!acc.title && str(summary.title)) {
    const parsedTitle = splitIsbdTitle(str(summary.title));
    acc.title = parsedTitle.title;
    acc.subtitle ??= parsedTitle.subtitle;
  }
  if (!acc.series && str(summary.series))
    acc.series =
      cleanTitle(str(summary.series), { suffixes: [] }).value || undefined;
  if (!acc.position && str(summary.volume))
    acc.position = seriesPosition(str(summary.volume));
  return acc;
}

function extractOpenBdContributors(
  desc: Record<string, unknown>,
  summary: Record<string, unknown>,
): Contributor[] {
  const contributors: Contributor[] = [];
  for (const c of list(desc.Contributor)) {
    const node = obj(c);
    const role =
      list(node.ContributorRole)
        .map((code) => onixRoles[str(code)])
        .find(Boolean) ?? "aut";
    const person =
      str(obj(node.PersonName).content) ||
      str(node.PersonName) ||
      str(obj(node.PersonNameInverted).content) ||
      str(node.PersonNameInverted) ||
      str(obj(node.CorporateName).content) ||
      str(node.CorporateName);
    addUniqueContributor(contributors, cleanCatalogPerson(person, true), role);
  }
  if (!contributors.length && str(summary.author)) {
    for (const token of str(summary.author).split(/\s+/))
      addUniqueContributor(
        contributors,
        cleanCatalogPerson(token, true),
        "aut",
      );
  }
  return contributors;
}

function extractOpenBdLanguage(
  desc: Record<string, unknown>,
): string | undefined {
  for (const lang of list(desc.Language)) {
    const l = obj(lang);
    if (str(l.LanguageRole) && str(l.LanguageRole) !== "01") continue;
    const normalized = normalizeLanguage(str(l.LanguageCode));
    if (normalized) return normalized;
  }
  return undefined;
}

function extractOpenBdCover(
  collateral: Record<string, unknown>,
  summary: Record<string, unknown>,
): string | undefined {
  for (const resource of list(collateral.SupportingResource)) {
    const r = obj(resource);
    if (str(r.ResourceContentType) && str(r.ResourceContentType) !== "01")
      continue;
    for (const version of list(r.ResourceVersion)) {
      const candidate = httpsCoverUrl(obj(version).ResourceLink);
      if (candidate) return candidate;
    }
  }
  return httpsCoverUrl(summary.cover);
}

function extractOpenBdPublisher(
  pubDetail: Record<string, unknown>,
  summary: Record<string, unknown>,
) {
  const firstPub = list(pubDetail.Publisher)
    .map((p) => cleanText(str(obj(p).PublisherName)))
    .find(Boolean);
  const firstImprint = list(pubDetail.Imprint)
    .map((i) => cleanText(str(obj(i).ImprintName)))
    .find(Boolean);
  const publisher =
    firstPub || cleanText(str(summary.publisher)) || firstImprint || undefined;
  const imprint =
    firstImprint && firstImprint !== publisher ? firstImprint : undefined;
  return { publisher, imprint };
}

function extractOpenBdDate(
  pubDetail: Record<string, unknown>,
  summary: Record<string, unknown>,
) {
  const dates = list(pubDetail.PublishingDate).map(obj);
  const preferredDate =
    dates.find((d) => str(d.PublishingDateRole) === "01")?.Date ??
    dates.find((d) => str(d.PublishingDateRole) === "11")?.Date ??
    dates[0]?.Date ??
    summary.pubdate;
  return normalizeDate(str(preferredDate));
}

function extractOpenBdDescription(collateral: Record<string, unknown>) {
  const texts = list(collateral.TextContent).map(obj);
  const rawSynopsis =
    texts.find((t) => str(t.TextType) === "03")?.Text ??
    texts.find((t) => str(t.TextType) === "02")?.Text;
  return rawSynopsis
    ? cleanDescription(str(rawSynopsis)).value || undefined
    : undefined;
}

function parseOpenBdItem(rawItem: unknown): CatalogEntry | undefined {
  if (!rawItem || typeof rawItem !== "object") return undefined;
  const item = obj(rawItem);
  const summary = obj(item.summary);
  const onix = obj(item.onix);
  const desc = obj(onix.DescriptiveDetail);
  const pubDetail = obj(onix.PublishingDetail);
  const collateral = obj(onix.CollateralDetail);

  const { title, subtitle, series, position } = extractOpenBdTitles(
    desc,
    summary,
  );
  if (!title) return undefined;

  const isbns = extractOpenBdIsbns(summary, onix);
  const electronic = /^E[A-Z]$/i.test(str(desc.ProductForm));
  const { publisher, imprint } = extractOpenBdPublisher(pubDetail, summary);
  const recordKey = isbns[0] ?? title;

  return buildCatalogEntry(
    {
      provider: "openbd",
      recordId: `openbd:${recordKey}`,
      recordUrl: isbns[0]
        ? `https://api.openbd.jp/v1/get?isbn=${isbns[0]}`
        : "https://openbd.jp/",
      title,
      contributors: extractOpenBdContributors(desc, summary),
      printIsbns: electronic ? [] : isbns,
      electronicIsbns: electronic ? isbns : [],
    },
    {
      subtitle,
      publisher,
      imprint,
      date: extractOpenBdDate(pubDetail, summary),
      series,
      position,
      language: extractOpenBdLanguage(desc),
      description: extractOpenBdDescription(collateral),
      coverUrl: extractOpenBdCover(collateral, summary),
    },
  );
}

export function parseOpenBd(payload: unknown): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const rawItem of list(payload)) {
    const entry = parseOpenBdItem(rawItem);
    if (entry) entries.push(entry);
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

const childText = (parent: Element, localName: string, namespace?: string) => {
  const node = directChildren(parent, localName, namespace)[0];
  return node ? textContent(node) : "";
};

function extractNdlResponsibility(htmlSummary: string): string | undefined {
  const lower = htmlSummary.toLowerCase();
  let pos = 0;
  while (pos < lower.length) {
    const open = lower.indexOf("<li>", pos);
    if (open === -1) return undefined;
    const close = lower.indexOf("</li>", open + 4);
    if (close === -1) return undefined;
    const trimmed = htmlSummary.slice(open + 4, close).trimStart();
    if (trimmed.startsWith("責任表示")) {
      const afterLabel = trimmed.slice(4).trimStart();
      if (afterLabel.startsWith(":") || afterLabel.startsWith("："))
        return afterLabel.slice(1).trimStart();
    }
    pos = close + 5;
  }
  return undefined;
}

function extractNdlContributors(item: Element): Contributor[] {
  const contributors: Contributor[] = [];
  const responsibility = extractNdlResponsibility(
    childText(item, "description"),
  );
  if (responsibility) {
    for (const person of parseContributors(plainText(responsibility))
      .contributors)
      addUniqueContributor(contributors, person.name, person.role);
  }
  if (!contributors.length) {
    for (const creator of directChildren(item, "creator", NS.dc))
      addUniqueContributor(
        contributors,
        cleanCatalogPerson(textContent(creator), true),
        "aut",
      );
  }
  return contributors;
}

function extractNdlIdentifiers(item: Element) {
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
  return { printIsbns, bibId };
}

function parseNdlItem(item: Element): CatalogEntry | undefined {
  const dcTitle =
    directChildren(item, "title", NS.dc)[0] ?? directChildren(item, "title")[0];
  if (!dcTitle) return undefined;
  const parsedTitle = splitIsbdTitle(textContent(dcTitle));
  if (!parsedTitle.title) return undefined;

  const volumeText = childText(item, "volume", NS.dcndl).trim();
  const volumePosition = volumeText ? seriesPosition(volumeText) : undefined;
  const contributors = extractNdlContributors(item);
  const publisher = cleanText(childText(item, "publisher", NS.dc)) || undefined;
  const date =
    normalizeDate(childText(item, "issued", NS.dcterms)) ??
    normalizeDate(childText(item, "date", NS.dc));
  const seriesRaw = childText(item, "seriesTitle", NS.dcndl);
  const seriesParsed = seriesRaw ? splitSeriesLabel(seriesRaw) : {};
  const position = volumePosition ?? seriesParsed.position;
  const language = normalizeLanguage(
    childText(item, "language", NS.dcterms) ||
      childText(item, "language", NS.dc),
  );
  const { printIsbns, bibId } = extractNdlIdentifiers(item);
  const link =
    (childText(item, "guid") || childText(item, "link")).trim() ||
    "https://ndlsearch.ndl.go.jp/";

  return buildCatalogEntry(
    {
      provider: "ndl",
      recordId: bibId ? `ndl:${bibId}` : link,
      recordUrl: link,
      title: parsedTitle.title,
      contributors,
      printIsbns,
      electronicIsbns: [],
    },
    {
      subtitle: parsedTitle.subtitle,
      publisher,
      date,
      series: seriesParsed.series,
      position,
      language,
    },
  );
}

export function parseNdlOpenSearch(xmlText: string): CatalogEntry[] {
  const document = xml(xmlText, "NDL OpenSearch");
  const entries: CatalogEntry[] = [];
  for (const item of elements(document, "item")) {
    const entry = parseNdlItem(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

function extractCiniiSeries(item: Record<string, unknown>) {
  let series: string | undefined;
  let position: string | undefined;
  for (const partOf of list(item["dcterms:isPartOf"])) {
    const label = str(obj(partOf)["dc:title"] ?? partOf);
    const parsedSeries = splitSeriesLabel(label);
    if (parsedSeries.series && !series) series = parsedSeries.series;
    if (parsedSeries.position && !position) position = parsedSeries.position;
  }
  return { series, position };
}

function extractCiniiContributors(
  item: Record<string, unknown>,
): Contributor[] {
  const contributors: Contributor[] = [];
  for (const creator of list(item["dc:creator"])) {
    for (const person of parseContributors(str(creator)).contributors)
      addUniqueContributor(
        contributors,
        cleanCatalogPerson(person.name),
        person.role,
      );
  }
  return contributors;
}

function extractCiniiIsbns(item: Record<string, unknown>): string[] {
  const printIsbns: string[] = [];
  for (const part of list(item["dcterms:hasPart"])) {
    const normalized = normalizeIsbn(str(obj(part)["@id"] ?? part));
    if (normalized && !printIsbns.includes(normalized))
      printIsbns.push(normalized);
  }
  return printIsbns;
}

function parseCiniiItem(rawItem: unknown): CatalogEntry | undefined {
  const item = obj(rawItem);
  const rawTitle = str(item.title);
  if (!rawTitle) return undefined;
  const parsedTitle = splitIsbdTitle(rawTitle);
  if (!parsedTitle.title) return undefined;

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
  const { series, position } = extractCiniiSeries(item);
  const idUrl =
    str(item["@id"]) ||
    str(obj(item.link)["@id"]) ||
    "https://ci.nii.ac.jp/books/";

  return buildCatalogEntry(
    {
      provider: "cinii",
      recordId: idUrl,
      recordUrl: idUrl,
      title: parsedTitle.title,
      contributors: extractCiniiContributors(item),
      printIsbns: extractCiniiIsbns(item),
      electronicIsbns: [],
    },
    {
      subtitle: parsedTitle.subtitle,
      publisher,
      date,
      series,
      position,
      language: normalizeLanguage(str(item["dc:language"])),
    },
  );
}

export function parseCiniiJson(payload: unknown): CatalogEntry[] {
  const graph = list(obj(payload)["@graph"]);
  const channel = obj(graph[0]);
  const entries: CatalogEntry[] = [];
  for (const rawItem of list(channel.items)) {
    const entry = parseCiniiItem(rawItem);
    if (entry) entries.push(entry);
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

function extractModsTitleInfo(mods: Element) {
  const titleInfos = preferNativeGroup(
    directChildren(mods, "titleInfo", NS.mods),
  );
  const primaryTitle = titleInfos.find((node) => !attr(node, "type"));
  if (!primaryTitle) return undefined;
  const rawTitle = stripTrailingPunct(
    childText(primaryTitle, "title", NS.mods),
    "/=:;,",
  );
  const title = cleanTitle(rawTitle).value;
  if (!title) return undefined;
  const rawSub = stripTrailingPunct(
    childText(primaryTitle, "subTitle", NS.mods),
    "/=:;,",
  );
  const subtitle = cleanText(rawSub) || undefined;
  const partNumber = seriesPosition(
    childText(primaryTitle, "partNumber", NS.mods),
  );
  const uniformTitle = titleInfos.find(
    (node) => attr(node, "type") === "uniform",
  );
  const originalTitle = uniformTitle
    ? cleanText(childText(uniformTitle, "title", NS.mods)) || undefined
    : undefined;
  return { title, subtitle, partNumber, originalTitle };
}

function extractModsContributors(mods: Element): Contributor[] {
  const contributors: Contributor[] = [];
  for (const nameNode of preferNativeGroup(
    directChildren(mods, "name", NS.mods),
  )) {
    const type = attr(nameNode, "type");
    const nameParts = directChildren(nameNode, "namePart", NS.mods)
      .filter(
        (part) => !["date", "termsOfAddress"].includes(attr(part, "type")),
      )
      .map((part) => textContent(part).trim())
      .filter(Boolean);
    const cleaned = cleanCatalogPerson(
      nameParts.join(" "),
      type === "personal",
    );
    const roleTerms = elements(nameNode, "roleTerm", NS.mods).map((el) =>
      textContent(el).trim(),
    );
    const role =
      roleTerms
        .map((term) => modsRoles.find(([pattern]) => pattern.test(term))?.[1])
        .find(Boolean) ?? "aut";
    addUniqueContributor(contributors, cleaned, role);
  }
  return contributors;
}

function extractModsOrigin(mods: Element) {
  let publisher: string | undefined;
  let date: string | undefined;
  for (const origin of preferNativeGroup(
    directChildren(mods, "originInfo", NS.mods),
  )) {
    if (!publisher) {
      const rawPub = stripTrailingPunct(
        childText(origin, "publisher", NS.mods),
        ",;:",
      );
      publisher = cleanText(rawPub) || undefined;
    }
    if (!date) {
      date = directChildren(origin, "dateIssued", NS.mods)
        .filter((node) => attr(node, "point") !== "end")
        .map((node) => normalizeDate(textContent(node)))
        .find(Boolean);
    }
  }
  return { publisher, date };
}

function extractModsSeries(mods: Element, initialPosition: string | undefined) {
  let series: string | undefined;
  let position = initialPosition;
  for (const related of directChildren(mods, "relatedItem", NS.mods)) {
    if (attr(related, "type") !== "series") continue;
    const st = preferNativeGroup(
      directChildren(related, "titleInfo", NS.mods),
    )[0];
    if (!st) continue;
    const rawSeries = stripTrailingPunct(childText(st, "title", NS.mods), ";,");
    const parsedSeries = splitSeriesLabel(rawSeries);
    series ??= parsedSeries.series;
    position ??=
      seriesPosition(childText(st, "partNumber", NS.mods)) ??
      parsedSeries.position;
  }
  return { series, position };
}

function extractModsIsbns(mods: Element) {
  const printIsbns: string[] = [];
  const electronicIsbns: string[] = [];
  for (const idNode of directChildren(mods, "identifier", NS.mods)) {
    if (attr(idNode, "type").toLowerCase() !== "isbn") continue;
    if (attr(idNode, "invalid") === "yes") continue;
    const raw = `${textContent(idNode)} ${attr(idNode, "qualifier")}`;
    const isEbook = /\b(e-?book|electronic|online|epub|pdf|kindle)\b/i.test(
      raw,
    );
    const target = isEbook ? electronicIsbns : printIsbns;
    for (const isbn of findIsbns(raw).valid) {
      if (!target.includes(isbn)) target.push(isbn);
    }
  }
  return { printIsbns, electronicIsbns };
}

function parseLocModsItem(
  document: Document,
  mods: Element,
): CatalogEntry | undefined {
  const titleInfo = extractModsTitleInfo(mods);
  if (!titleInfo) return undefined;
  const { title, subtitle, partNumber, originalTitle } = titleInfo;
  const contributors = extractModsContributors(mods);
  const { publisher, date } = extractModsOrigin(mods);
  const language = elements(mods, "languageTerm", NS.mods)
    .map((el) => normalizeLanguage(textContent(el)))
    .find(Boolean);
  const abstractText = directChildren(mods, "abstract", NS.mods)
    .map((el) => cleanDescription(textContent(el)).value)
    .find(Boolean);
  const { series, position } = extractModsSeries(mods, partNumber);
  const { printIsbns, electronicIsbns } = extractModsIsbns(mods);

  const recordInfo = directChildren(mods, "recordInfo", NS.mods)[0];
  const lccn = recordInfo
    ? childText(recordInfo, "recordIdentifier", NS.mods).trim()
    : "";
  const recordPosition = elements(document, "recordPosition", NS.srw)[0];
  const id =
    lccn || (recordPosition ? textContent(recordPosition).trim() : "1");

  return buildCatalogEntry(
    {
      provider: "loc",
      recordId: `loc:${id}`,
      recordUrl: lccn
        ? `https://lccn.loc.gov/${encodeURIComponent(lccn)}`
        : "https://catalog.loc.gov/",
      title,
      contributors,
      printIsbns,
      electronicIsbns,
    },
    {
      subtitle,
      originalTitle: originalTitle !== title ? originalTitle : undefined,
      publisher,
      date,
      series,
      position,
      language,
      description: abstractText,
    },
  );
}

export function parseLocSruMods(xmlText: string): CatalogEntry[] {
  const document = xml(xmlText, "LoC SRU MODS");
  const entries: CatalogEntry[] = [];
  for (const mods of elements(document, "mods", NS.mods)) {
    const entry = parseLocModsItem(document, mods);
    if (entry) entries.push(entry);
  }
  return entries;
}

function extractOlText(value: unknown): string {
  if (typeof value === "string") return value;
  return str(obj(value).value);
}

function extractOlBookContributors(
  data: Record<string, unknown>,
  edition: Record<string, unknown>,
): Contributor[] {
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
  return contributors;
}

function extractOlBookIsbns(
  isbn: string,
  data: Record<string, unknown>,
  edition: Record<string, unknown>,
): string[] {
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
  return printIsbns;
}

function extractOlBookSeries(edition: Record<string, unknown>) {
  let series: string | undefined;
  let position: string | undefined;
  for (const s of list(edition.series)) {
    const parsedSeries = splitSeriesLabel(str(s));
    if (parsedSeries.series && !series) series = parsedSeries.series;
    if (parsedSeries.position && !position) position = parsedSeries.position;
  }
  return { series, position };
}

function extractOlBookCover(
  data: Record<string, unknown>,
  edition: Record<string, unknown>,
): string | undefined {
  const coverObj = obj(data.cover);
  const editionCoverId = list(edition.covers).find(
    (id): id is number =>
      typeof id === "number" && Number.isInteger(id) && id > 0,
  );
  return (
    httpsCoverUrl(coverObj.large) ??
    httpsCoverUrl(coverObj.medium) ??
    (editionCoverId !== undefined
      ? `https://covers.openlibrary.org/b/id/${editionCoverId}-L.jpg`
      : undefined)
  );
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

  const contributors = extractOlBookContributors(data, edition);
  const publisher =
    cleanText(str(obj(list(data.publishers)[0]).name)) ||
    cleanText(str(list(edition.publishers)[0])) ||
    undefined;
  const date = normalizeDate(
    str(data.publish_date) || str(edition.publish_date),
  );
  const printIsbns = extractOlBookIsbns(isbn, data, edition);
  const electronic = /\b(e-?book|electronic|epub|kindle)\b/i.test(
    str(edition.physical_format),
  );
  const language = list(edition.languages)
    .map((lang) =>
      normalizeLanguage(str(obj(lang).key).replace(/^\/languages\//, "")),
    )
    .find(Boolean);
  const { series, position } = extractOlBookSeries(edition);
  const rawSynopsis =
    extractOlText(edition.description) || extractOlText(work.description);
  const description = rawSynopsis
    ? cleanDescription(rawSynopsis).value || undefined
    : undefined;
  const coverUrl = extractOlBookCover(data, edition);

  const key = str(data.key) || str(edition.key) || `/isbn/${isbn}`;
  const rawUrl = str(data.url).replace(/^http:\/\//i, "https://");
  const recordUrl = rawUrl || `https://openlibrary.org${key}`;

  return [
    buildCatalogEntry(
      {
        provider: "openlibrary",
        recordId: `openlibrary:${key}`,
        recordUrl,
        title: parsedTitle.title,
        contributors,
        printIsbns: electronic ? [] : printIsbns,
        electronicIsbns: electronic ? printIsbns : [],
      },
      {
        subtitle,
        publisher,
        date,
        series,
        position,
        language,
        description,
        coverUrl,
      },
    ),
  ];
}

function extractOlDocIsbns(doc: Record<string, unknown>): string[] {
  const printIsbns: string[] = [];
  for (const candidate of list(doc.isbn)) {
    const normalized = normalizeIsbn(str(candidate));
    if (normalized && !printIsbns.includes(normalized))
      printIsbns.push(normalized);
  }
  return printIsbns;
}

function parseOpenLibrarySearchDoc(rawDoc: unknown): CatalogEntry | undefined {
  const doc = obj(rawDoc);
  const rawTitle = str(doc.title);
  if (!rawTitle) return undefined;
  const parsedTitle = splitIsbdTitle(rawTitle);
  if (!parsedTitle.title) return undefined;
  const subtitle = cleanText(str(doc.subtitle)) || parsedTitle.subtitle;

  const contributors: Contributor[] = [];
  for (const author of list(doc.author_name))
    addUniqueContributor(contributors, cleanCatalogPerson(str(author)), "aut");

  const publisher = cleanText(str(list(doc.publisher)[0])) || undefined;
  const date =
    list(doc.publish_date)
      .map((d) => normalizeDate(str(d)))
      .find(Boolean) ?? normalizeDate(str(doc.first_publish_year));
  const language = list(doc.language)
    .map((l) => normalizeLanguage(str(l)))
    .find(Boolean);
  const coverId =
    typeof doc.cover_i === "number" &&
    Number.isInteger(doc.cover_i) &&
    doc.cover_i > 0
      ? doc.cover_i
      : undefined;
  const coverUrl =
    coverId !== undefined
      ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
      : undefined;
  const key =
    str(doc.key) || `/search/${encodeURIComponent(parsedTitle.title)}`;
  const recordPath = key.startsWith("/") ? key : `/${key}`;

  return buildCatalogEntry(
    {
      provider: "openlibrary",
      recordId: `openlibrary:${key}`,
      recordUrl: `https://openlibrary.org${recordPath}`,
      title: parsedTitle.title,
      contributors,
      printIsbns: extractOlDocIsbns(doc),
      electronicIsbns: [],
    },
    { subtitle, publisher, date, language, coverUrl },
  );
}

export function parseOpenLibrarySearch(payload: unknown): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const rawDoc of list(obj(payload).docs)) {
    const entry = parseOpenLibrarySearchDoc(rawDoc);
    if (entry) entries.push(entry);
  }
  return entries;
}

function extractGoogleBooksIsbns(info: Record<string, unknown>): string[] {
  const isbns: string[] = [];
  for (const id of list(info.industryIdentifiers)) {
    const entry = obj(id);
    if (!/^ISBN_1[03]$/i.test(str(entry.type))) continue;
    const normalized = normalizeIsbn(str(entry.identifier));
    if (normalized && !isbns.includes(normalized)) isbns.push(normalized);
  }
  return isbns;
}

function extractGoogleBooksCover(
  info: Record<string, unknown>,
): string | undefined {
  const imageLinks = obj(info.imageLinks);
  const rawCover =
    str(imageLinks.extraLarge) ||
    str(imageLinks.large) ||
    str(imageLinks.medium) ||
    str(imageLinks.small) ||
    str(imageLinks.thumbnail);
  return httpsCoverUrl(
    rawCover,
    /^http:\/\/(?:books\.google\.com|books\.googleusercontent\.com)\//i.test(
      rawCover,
    ),
  );
}

function extractGoogleContributors(
  info: Record<string, unknown>,
): Contributor[] {
  const contributors: Contributor[] = [];
  for (const author of list(info.authors)) {
    for (const person of parseContributors(str(author)).contributors)
      addUniqueContributor(
        contributors,
        cleanCatalogPerson(person.name),
        person.role,
      );
  }
  return contributors;
}

function parseGoogleBooksItem(rawItem: unknown): CatalogEntry | undefined {
  const item = obj(rawItem);
  const info = obj(item.volumeInfo);
  const sale = obj(item.saleInfo);
  const rawTitle = str(info.title);
  if (!rawTitle) return undefined;
  const title = cleanTitle(rawTitle).value;
  if (!title) return undefined;

  const isbns = extractGoogleBooksIsbns(info);
  const electronic = sale.isEbook === true;
  const id = str(item.id) || isbns[0] || title;
  const rawLink = str(info.canonicalVolumeLink) || str(info.infoLink);
  const recordUrl = rawLink
    ? rawLink.replace(/^http:\/\//i, "https://")
    : `https://books.google.com/books?id=${encodeURIComponent(id)}`;
  const rawDescription = str(info.description);

  return buildCatalogEntry(
    {
      provider: "google-books",
      recordId: `google-books:${id}`,
      recordUrl,
      title,
      contributors: extractGoogleContributors(info),
      printIsbns: electronic ? [] : isbns,
      electronicIsbns: electronic ? isbns : [],
    },
    {
      subtitle: cleanText(str(info.subtitle)) || undefined,
      publisher: cleanText(str(info.publisher)) || undefined,
      date: normalizeDate(str(info.publishedDate)),
      language: normalizeLanguage(str(info.language)),
      description: rawDescription
        ? cleanDescription(rawDescription).value || undefined
        : undefined,
      coverUrl: extractGoogleBooksCover(info),
    },
  );
}

export function parseGoogleBooks(payload: unknown): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const rawItem of list(obj(payload).items)) {
    const entry = parseGoogleBooksItem(rawItem);
    if (entry) entries.push(entry);
  }
  return entries;
}
