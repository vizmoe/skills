# Quillbind

Quillbind 把 Markdown 书籍目录或支持的轻小说网站书籍 URL 构建为可重排的 EPUB 3.3，并为已有 EPUB 提供审计、升级与受控修复。`literature` 和 `technical` 控制排版；Apple Books 和 Kindle 是同一文件的兼容性检查。

以下命令在 `tools/quillbind/` 中执行。

```sh
pnpm install --frozen-lockfile
pnpm tools:install
pnpm quillbind doctor --json
pnpm quillbind build examples/literature --json
pnpm quillbind build examples/technical --json
```

使用 [.node-version](.node-version) 与 [package.json](package.json) 指定的 Node.js 和 pnpm；[tools.lock.json](standards/tools.lock.json) 是外部工具版本与校验值的来源。`tools:install` 下载并校验 Java、EPUBCheck 和 Chromium。当前工作区也可直接运行 `./bin/quillbind.mjs`；该启动器优先使用项目内已安装的 Node。`pnpm build` 编译 TypeScript 工程，`quillbind build` 构建书籍。

正式书籍构建执行：元数据解析 → 章节预检 → 独立出版模型 → XHTML/OPF/NAV/CSS → OCF 打包 → 内部验证 → EPUBCheck → Ace → Playwright/axe → Apple/Kindle lint → 第二次构建字节比较。任何失败都会阻止生成新的发布文件。工具缺失会报告环境错误。构建不联网查询书目。

成功产物位于书籍的 `dist/book.epub` 与 `dist/reports/`；SHA-256 记录在报告中，不另行生成校验文件。正式构建失败时留下的 `candidate.epub` 仅用于诊断；已有发布文件不会被失败的候选覆盖。

`preview <书籍目录> --json` 只渲染一次，写入 `dist/preview/candidate.epub`，明确标记发布检查未运行，并保留已有正式产物和报告。ZIP 使用固定 level 9 deflate，`mimetype` 保持存储模式；不值得压缩的条目保留原样。压缩策略与方法统计记录在 `compression.json`。

源文件不设大小、图片像素或归档展开比例上限。PNG 默认进行经数据校验的最高级别 zlib 无损压缩，保留位深、透明度、ICC、EXIF 等数据；JPEG、GIF、SVG 保留原始字节，图片不缩放、不做有损重编码。详情及 WebP 的平台兼容性取舍见 [图片处理](docs/images.md)，逐图结果见 `dist/reports/images.json`。Java 仅用于运行 EPUBCheck，出版引擎是 TypeScript。

```sh
pnpm quillbind init ./my-book --theme literature
pnpm quillbind metadata resolve ./my-book --json
pnpm quillbind preflight ./my-book --json
pnpm quillbind build ./my-book --json

pnpm quillbind epub audit ./original.epub --json
pnpm quillbind epub repair-plan ./original.epub --output ./plan.json --json
pnpm quillbind epub repair ./original.epub --plan ./plan.json --output ./repaired.epub --json
```

新书填写 `book.yaml` 的书名、作者、简介、语言与受控分类。已出版版本需要明确确认电子版 ISBN，或确认无 ISBN。修复使用新路径，保护原 EPUB；语义不明确的修改会被报告并阻止发布。

中文书籍可通过[繁化姬](https://zhconvert.org/)进行繁简转换，支持 Markdown 构建与已有 EPUB 3。首次转换显式使用 `--online` 获取响应并保存锁文件，之后默认离线复用。转换保留源文件并执行全部发布检查；也支持 `china`、`taiwan`、`hongkong` 地区用词模式。

```sh
pnpm quillbind build ./my-book --to traditional --online --json
pnpm quillbind epub convert ./original.epub --to simplified --output ./simplified.epub --online --json
```

本程式使用了繁化姬的 API 服務；繁化姬商用必須付費。配置、转换范围与复现规则见[中文繁简转换](docs/chinese-conversion.md)。

Agent Skill 入口是 [skills/quillbind/SKILL.md](../../skills/quillbind/SKILL.md)，通过 `npx skills add vizmoe/skills --skill quillbind` 安装。安装后设置 `QUILLBIND_ROOT` 为本工作区的绝对路径（仓库下的 `tools/quillbind`），或提供已安装的 `quillbind` 命令；完整配置见[运行环境](../../skills/quillbind/references/environment.md)。源码中的 helper 可以自动定位本工作区。

轻小说采集支持哔哩轻小说、轻之国度和轻书架的书籍 URL，包含封面、插图、目录、章节分页与选卷合并。默认合并全书；`--split-volumes` 逐卷输出，`--prepare-only` 先保存本地书稿。完整命令、站点 URL 形式和访问限制见[轻小说采集](docs/novel-sources.md)。

```sh
./bin/quillbind.mjs novel inspect 'https://www.bilinovel.com/novel/1840.html'
./bin/quillbind.mjs novel fetch 'https://www.lightnovel.fun/book/31608' --output ./novel
./bin/quillbind.mjs novel fetch 'https://www.lightnovel.app/book/info/20247' --volumes 1 --split-volumes --output ./volumes
```

| 文档                                   | 内容                                  |
| -------------------------------------- | ------------------------------------- |
| [Authoring](docs/authoring.md)         | Markdown、扩展语法、完整章节          |
| [Configuration](docs/configuration.md) | `book.yaml`、元数据、分类、主题       |
| [Architecture](docs/architecture.md)   | 领域模型、出版流水线、EPUB 实现与 API |
| [Quality](docs/quality.md)             | QA、兼容性、可复现性与 release        |
| [Repair](docs/repair.md)               | 修复规则、完整性与限制                |
| [Images](docs/images.md)               | 无损压缩、原始数据与图片兼容性        |
| [Security](docs/security.md)           | 路径、归档完整性与执行边界            |
| [Development](docs/development.md)     | CLI、测试、容器与 skill 验证          |
| [Standards](docs/standards.md)         | 官方来源与正式状态                    |

目标格式依据 [W3C EPUB 3.3 Recommendation](https://www.w3.org/TR/epub-33/)。结果区分标准符合性、浏览器排版、平台指南与发行政策。自动检查不构成无障碍认证，也不代表在 Apple Books 或 Kindle 真机上测试。具体交付范围与平台排除项以[报告解读](../../skills/quillbind/references/quality.md)为准。
