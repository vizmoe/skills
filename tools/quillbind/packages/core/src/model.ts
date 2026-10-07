export interface SourceLocation {
  source: string;
  line?: number;
  column?: number;
}
export interface Diagnostic extends Partial<SourceLocation> {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  standard?: string;
  standardUrl?: string;
  ruleId?: string;
  suggestion?: string;
}
export interface ValidationResult {
  status: "pass" | "fail";
  diagnostics: Diagnostic[];
}
export interface Author {
  name: string;
}
export interface Identifier {
  scheme: "uuid" | "isbn";
  value: string;
}
export interface SubjectTag {
  id: string;
  label: string;
}
export interface PublicationMetadata {
  title: string;
  authors: Author[];
  description: string;
  language: string;
  identifier: Identifier;
  tags: SubjectTag[];
  modified: string;
  publication: { isbn: string | null };
}
interface Located {
  source?: SourceLocation;
}
export interface MathExpression {
  tex: string;
  mathml: string;
  display: boolean;
}
export type Inline = Located &
  (
    | { kind: "text" | "code"; text: string }
    | { kind: "emphasis" | "strong" | "delete"; children: Inline[] }
    | { kind: "link"; target: string; title?: string; children: Inline[] }
    | { kind: "image"; target: string; alt: string; title?: string }
    | { kind: "math"; expression: MathExpression }
    | { kind: "footnoteRef"; target: string; id: string; text: string }
    | { kind: "ruby"; children: Inline[]; annotation: string }
    | { kind: "citation"; target: string; text: string }
    | { kind: "break" }
  );
export type Block = Located & { classes?: string[] } & (
    | { kind: "paragraph"; inlines: Inline[] }
    | { kind: "heading"; id: string; level: number; inlines: Inline[] }
    | { kind: "quote" | "listItem"; children: Block[] }
    | {
        kind: "list";
        ordered: boolean;
        start?: number;
        spread?: boolean;
        children: Block[];
      }
    | { kind: "code"; text: string; language: string; caption?: string }
    | { kind: "thematicBreak" | "bibliography" }
    | {
        kind: "table";
        caption: string;
        rows: Inline[][][];
        alignment?: ("left" | "center" | "right" | null)[];
      }
    | { kind: "math"; expression: MathExpression }
    | { kind: "figure"; target: string; alt: string; caption: string }
    | { kind: "admonition" | "definition"; title: string; children: Block[] }
    | { kind: "pagebreak"; id: string; title?: string }
  );
export interface Section {
  id: string;
  title: string;
  level: number;
  children: Section[];
}
export interface Footnote {
  id: string;
  blocks: Block[];
  references: string[];
}
export interface Citation {
  id: string;
  text: string;
  url?: string;
}
export interface Document {
  id: string;
  title: string;
  language: string;
  direction: "ltr" | "rtl";
  writingMode: "horizontal-tb" | "vertical-rl";
  source: string;
  href: string;
  blocks: Block[];
  sections: Section[];
  footnotes: Footnote[];
  chapterMetadata?: {
    authors?: string[];
    date?: string;
    source?: string;
    display: "byline" | "hidden";
  };
}
export interface Resource {
  id: string;
  href: string;
  mediaType: string;
  bytes: Uint8Array;
  source?: string;
  sourceAliases?: string[];
  properties?: string[];
  imageProcessing?: {
    source: string;
    action: "preserved" | "png-lossless";
    reason: string;
    inputBytes: number;
    outputBytes: number;
    sourceSha256: string;
    outputSha256: string;
    verification: "original-bytes" | "exact-scanlines-and-metadata";
  }[];
}
export interface NavigationTree {
  title: string;
  href: string;
  children: NavigationTree[];
}
export interface Publication {
  metadata: PublicationMetadata;
  documents: Document[];
  resources: Resource[];
  navigation: NavigationTree[];
  theme: "literature" | "technical";
  citations: Citation[];
  cover?: string;
  pageProgression?: "ltr" | "rtl" | "default";
}
export interface Artifact {
  path: string;
  mediaType: string;
  sha256: string;
  size: number;
}
export interface CompatibilityReport extends ValidationResult {
  platform: string;
  distribution: "compatible" | "warning";
  checkedAt: string;
  ruleVersion: string;
}
