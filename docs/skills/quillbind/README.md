# Quillbind

以书库受控词表管理标签，将元数据直接写入 EPUB 或 CBZ 的 `ComicInfo.xml`。轻小说和漫画使用 BookWalker 专用流程，其他书籍采用出版社官方资料及书内信息；同时支持 Markdown/网站小说构建 EPUB、已有 EPUB 检查修复与套书拆分、中文繁简转换及扫图打包为无损 JXL CBZ。代理执行入口是 [SKILL.md](../../../skills/quillbind/SKILL.md)。

## 安装与运行条件

```sh
npx skills add vizmoe/skills --skill quillbind
```

标签审计和命名计划工具只依赖 Node.js，可直接从安装目录运行。元数据维护使用文件级 ZIP/XML 工具及相应验证器，无需 Calibre 数据库访问。出版、修复和漫画打包命令依赖本仓库的独立 [Quillbind 运行时](../../../tools/quillbind/README.md)。按[环境配置](../../../skills/quillbind/references/environment.md)准备工具链，并将 `QUILLBIND_ROOT` 指向本地 `tools/quillbind` 的绝对路径。更新时使运行时与技能保持同一 Git 修订，并保留仓库中的 `skills/quillbind` 共享词表及加载器。技能安装本身不会安装出版工具。

## 调用

在支持技能调用的代理中指定任务和文件范围，例如在 Codex 中输入：

```text
$quillbind 按 /absolute/library 的当前受控词表审计所选 EPUB/CBZ 的标签，生成文件修改计划。
$quillbind 统一所选轻小说系列的正传、外传、短篇集和番外命名，采用目标版本官方编号；确无官方编号时才按首次出版顺序使用本地 .5 排序。
$quillbind 从出版社官方资料补充 /absolute/path/to/book.epub 的元数据，尽可能补全 ISBN，保留有效值，直接写入 EPUB。
$quillbind 按书库标签维护所选 CBZ 的 ComicInfo.xml 和 EPUB 内嵌元数据，保留图片、页序、正文和非目标字段，不修改 Calibre 数据库。
$quillbind 检查 /absolute/path/to/book.epub，报告问题并保留源文件。
$quillbind 将 /absolute/path/to/anthology.epub 按实际目录与正文边界拆成独立卷，核对单卷元数据、章节覆盖、资源和脚注，保留原套书。
$quillbind 验证 /absolute/path/to/book.epub 的脚本弹窗注释，检查打开、关闭和返回，保留原件。
$quillbind 将 /absolute/path/to/manuscript 中的 Markdown 制作为 EPUB。
$quillbind 参考中日 BookWalker 补充这本轻小说或漫画 EPUB 的元数据，日期采用日版来源字段，无需交叉复验。
$quillbind 将 /absolute/path/to/volume-01 的漫画扫图制作为 CBZ，使用 JXL 无损压缩和 ComicInfo。
```

示例路径需替换为实际路径。支持的操作、输入条件和交付检查从技能入口按任务分支查阅；发布 EPUB 前必须完成其规定的全部检查。

[轻小说整系列命名](../../../skills/quillbind/references/naming.md)使用统一主系列名、两位起的阿拉伯编号及原文分册名，优先级为官方统一编号、官方独立子系列编号、本地 `.5` 插入编号。同一位置的多册无编号外传统一用 `.5-01`、`.5-02`；本地编号仅用于文件名和排序。命名工具生成带证据的方案，实际文件操作仍须核对源文件哈希、冲突及元数据验证。所有类型书籍的系列卷次元数据都使用阿拉伯数字，书名原文中的罗马数字等字符保持原样。

标签以书库当前受控词表为准，书库只提供分类依据。审计与出版运行时共用[词表来源及迁移规则](../../../skills/quillbind/references/tags.md)。有当前书库文件时，审计指定 `--vocabulary`，出版命令设置 `QUILLBIND_VOCABULARY`；未知标签保留待核对。审计可使用本次任务分配的整数 ID，并保留 ID 与文件路径、哈希的映射，无需 Calibre 书目 ID。

[普通书与专用来源规则](../../../skills/quillbind/references/bibliography.md)区分轻小说/漫画的 BookWalker 流程与其他书籍的出版社流程。常规补资料主动检索并尽可能补全 ISBN，保留有效值，有可靠替代时修正错号；检索失败或候选冲突不能成为清空已有 ISBN 的理由。确无可靠候选或格式无法表达时，保留现状并说明已查来源及限制。仅改标签等限定字段的任务不扩大为 ISBN 修订。发行日直接采用选定来源的日期和精度，不要求交叉复验；已有文件补 ISBN 不使用新书出版项目的 eISBN 审批门槛。

[内嵌元数据维护](../../../skills/quillbind/references/embedded-metadata.md)直接修改 EPUB 实际 OPF 或 CBZ 根目录的 `ComicInfo.xml`。ComicInfo 2.0 用 `Genre` 承载受控标签，EPUB 用 `dc:subject`。先备份目标文件、暂存并验证，再写回指定文件并独立读回。Calibre 数据库、旁置 `metadata.opf` 和 `cover.jpg` 保持不变，不要求三处同步。现有运行时没有通用全字段写入命令，代理使用文件级工具执行该流程；漫画元数据修订不经过扫图重编码，标签专用编辑也不借用会更新日期的 enrichment。

漫画打包还需要 libjxl 的 `cjxl` 与 `djxl`，输出需要支持 JPEG XL 的 CBZ 阅读器。输入范围、页序和校验说明见[漫画流程](../../../skills/quillbind/references/manga.md)，版本匹配与日版纸书优先日期规则见 [BookWalker 流程](../../../skills/quillbind/references/bookwalker.md)。

脚本弹窗检查见[注释验证](../../../skills/quillbind/references/notes.md)：默认只检查结构；明确执行时，在受限 Chromium 环境中按指定的点击、键盘、悬停或触摸用例验证。结构问题与交互结果分别报告，不能据此宣称 Apple Books/Kindle 原生弹窗兼容。

## 开发

修改该技能、安装辅助脚本或运行时时，阅读[维护指南](development.md)，其中链接行为用例、领域规则来源和专项测试。运行时另有[维护约定](../../../tools/quillbind/AGENTS.md)及[开发指南](../../../tools/quillbind/docs/development.md)。公共目录与安装检查见 [CONTRIBUTING.md](../../../CONTRIBUTING.md#本地验证)，运行时的回归与出版检查保留在其工作区中。
