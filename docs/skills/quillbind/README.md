# Quillbind

将 Markdown 或支持的轻小说来源构建为 EPUB，检查和修复已有 EPUB，按需进行中文繁简转换，并从 BookWalker 补充轻小说/漫画书目、将扫图打包为无损 JXL CBZ。代理执行入口是 [SKILL.md](../../../skills/quillbind/SKILL.md)。

## 安装与运行条件

```sh
npx skills add vizmoe/skills --skill quillbind
```

该技能依赖本仓库的独立 [Quillbind 运行时](../../../tools/quillbind/README.md)。按[环境配置](../../../skills/quillbind/references/environment.md)准备工具链，并将 `QUILLBIND_ROOT` 指向本地 `tools/quillbind` 的绝对路径。更新时使运行时与技能保持同一 Git 修订。技能安装本身不会安装出版工具。

## 调用

在支持技能调用的代理中指定任务和文件范围，例如在 Codex 中输入：

```text
$quillbind 检查 /absolute/path/to/book.epub，报告问题并保留源文件。
$quillbind 将 /absolute/path/to/manuscript 中的 Markdown 制作为 EPUB。
$quillbind 参考中日 BookWalker 补充 /absolute/path/to/book.epub 的元数据，日期以日版为准。
$quillbind 将 /absolute/path/to/volume-01 的漫画扫图制作为 CBZ，使用 JXL 无损压缩和 ComicInfo。
```

示例路径需替换为实际路径。支持的操作、输入条件和交付检查从技能入口按任务分支查阅；发布 EPUB 前必须完成其规定的全部检查。

漫画打包还需要 libjxl 的 `cjxl` 与 `djxl`，输出需要支持 JPEG XL 的 CBZ 阅读器。输入范围、页序和校验说明见[漫画流程](../../../skills/quillbind/references/manga.md)，版本匹配与日版纸书优先日期规则见 [BookWalker 流程](../../../skills/quillbind/references/bookwalker.md)。

## 开发

修改该技能、安装辅助脚本或运行时时，阅读 [维护约定](../../../tools/quillbind/AGENTS.md)及[开发指南](../../../tools/quillbind/docs/development.md)。公共安装检查见 [CONTRIBUTING.md](../../../CONTRIBUTING.md#本地验证)，运行时的回归与出版检查保留在其工作区中。
