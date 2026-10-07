import type { Diagnostic } from "./model.js";

export type NovelSite = "bilinovel" | "lightnovel-fun" | "lightnovel-app";
export interface NovelAddress {
  site: NovelSite;
  id: string;
  url: string;
}
export interface NovelChapter {
  id: string;
  title: string;
  url: string;
  bookId?: number;
  sortNum?: number;
}
export interface NovelVolume {
  number: number;
  id: string;
  title: string;
  cover?: string;
  chapters: NovelChapter[];
}
export interface NovelCatalog extends NovelAddress {
  title: string;
  authors: string[];
  description: string;
  language: string;
  cover?: string;
  volumes: NovelVolume[];
  diagnostics: Diagnostic[];
}
export interface NovelPage {
  html: string;
  url: string;
}
export interface NovelSource {
  catalog(): Promise<NovelCatalog>;
  chapter(chapter: NovelChapter): Promise<NovelPage[]>;
  close(): Promise<void>;
}
