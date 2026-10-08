# Quillbind

以 Calibre 书库受控词表管理 Tags，审计标签并生成逐书修改计划；将 Markdown 或支持的轻小说来源构建为 EPUB，检查和修复已有 EPUB，按需进行中文繁简转换，并从 BookWalker 补充轻小说/漫画书目、将扫图打包为无损 JXL CBZ。代理执行入口是 [SKILL.md](../../../skills/quillbind/SKILL.md)。

## 安装与运行条件

```sh
npx skills add vizmoe/skills --skill quillbind
```

标签审计工具只依赖 Node.js，可直接从安装目录运行；实际写库另需 Calibre。EPUB 和漫画操作依赖本仓库的独立 [Quillbind 运行时](../../../tools/quillbind/README.md)。按[环境配置](../../../skills/quillbind/references/environment.md)准备工具链，并将 `QUILLBIND_ROOT` 指向本地 `tools/quillbind` 的绝对路径。更新时使运行时与技能保持同一 Git 修订，并保留仓库中的 `skills/quillbind` 共享词表及加载器。技能安装本身不会安装出版工具。

## 调用

在支持技能调用的代理中指定任务和文件范围，例如在 Codex 中输入：

```text
$quillbind 按 /absolute/library 的当前受控词表审计所选书籍的 Tags，生成修改计划，保留书库原状。
$quillbind 根据已核实的出版信息整理所选轻小说的类型和题材标签，按书库规则同步并验证。
$quillbind 检查 /absolute/path/to/book.epub，报告问题并保留源文件。
$quillbind 验证 /absolute/path/to/book.epub 的脚本弹窗注释，检查打开、关闭和返回，保留原件。
$quillbind 将 /absolute/path/to/manuscript 中的 Markdown 制作为 EPUB。
$quillbind 参考中日 BookWalker 补充 /absolute/path/to/book.epub 的元数据，日期以日版为准。
$quillbind 将 /absolute/path/to/volume-01 的漫画扫图制作为 CBZ，使用 JXL 无损压缩和 ComicInfo。
```

示例路径需替换为实际路径。支持的操作、输入条件和交付检查从技能入口按任务分支查阅；发布 EPUB 前必须完成其规定的全部检查。

标签以书库当前受控词表为准，外部分类与书目依据继续使用 BookWalker 和出版社官方源。审计与出版运行时共用[词表来源及迁移规则](../../../skills/quillbind/references/tags.md)。有当前书库文件时，审计指定 `--vocabulary`，出版命令设置 `QUILLBIND_VOCABULARY`；未知标签保留待核对。生成计划不代表已写库，写库验收需要核对数据库、旁置 OPF 和目标格式内部元数据。

漫画打包还需要 libjxl 的 `cjxl` 与 `djxl`，输出需要支持 JPEG XL 的 CBZ 阅读器。输入范围、页序和校验说明见[漫画流程](../../../skills/quillbind/references/manga.md)，版本匹配与日版纸书优先日期规则见 [BookWalker 流程](../../../skills/quillbind/references/bookwalker.md)。

脚本弹窗检查见[注释验证](../../../skills/quillbind/references/notes.md)：默认只检查结构；明确执行时，在受限 Chromium 环境中按指定的点击、键盘、悬停或触摸用例验证。结构问题与交互结果分别报告，不能据此宣称 Apple Books/Kindle 原生弹窗兼容。

## 开发

修改该技能、安装辅助脚本或运行时时，阅读 [维护约定](../../../tools/quillbind/AGENTS.md)及[开发指南](../../../tools/quillbind/docs/development.md)。公共安装检查见 [CONTRIBUTING.md](../../../CONTRIBUTING.md#本地验证)，运行时的回归与出版检查保留在其工作区中。
