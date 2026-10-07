# 轻小说网站采集

`novel fetch` 接收书籍 URL，采集封面、插图、目录及章节，生成本地 Markdown 书籍并执行原有 EPUB 3.3 发布管线。默认合并全部分卷；每个输出 EPUB 都有封面页、可点击目录和卷／章层级。章节分页合并成同一个章节。

```sh
# 查看卷号、卷名及章节数量
./bin/quillbind.mjs novel inspect 'https://www.bilinovel.com/novel/1840.html'

# 全书合并；输出目录必须是新目录
./bin/quillbind.mjs novel fetch 'https://www.lightnovel.fun/book/31608' --output ./my-novel

# 选择并合并第 1～3、5 卷
./bin/quillbind.mjs novel fetch 'https://www.bilinovel.com/novel/1840.html' --volumes 1-3,5 --output ./selected-novel

# 每卷分别生成一个独立书籍项目和 EPUB
./bin/quillbind.mjs novel fetch 'https://www.lightnovel.app/book/info/20247' --split-volumes --output ./series

# 只采集，稍后检查或修改本地书稿，再离线构建
./bin/quillbind.mjs novel fetch 'https://www.lightnovel.fun/book/31608' --prepare-only --output ./draft
./bin/quillbind.mjs build ./draft --json
```

省略 `--output` 时使用当前目录下的 `novel-站点-书籍ID`。`--volumes` 接受 `all`、`1,3`、`1-3,5`；卷号从 1 开始，以 `novel inspect` 的目录为准。重复选择自动去重，最终顺序保持源目录顺序。逐卷输出位于 `volume-001/` 等子目录，每个项目包含自己的本地图片，能独立构建。

| 站点       | 接受的书籍 URL                                                                                                  | 采集方式                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 哔哩轻小说 | `https://www.bilinovel.com/novel/ID.html`，也接受 `/novel/ID/catalog`、卷详情 URL 及 `linovelib.com` 的同形地址 | 解析书籍元数据、分卷目录、卷封面及阅读分页；检查已知段落排序脚本，按源算法恢复顺序 |
| 轻之国度   | `https://www.lightnovel.fun/book/ID`，包括 `/cn/book/ID`、`/tw/book/ID`                                         | 解析 Nuxt 的结构化书籍／阅读数据，补齐懒加载卷章节和分页目录                       |
| 轻书架     | `https://www.lightnovel.app/book/info/ID`                                                                       | 使用官方前端的 SignalR 阅读 API；系列条目作为分卷，章节按 `SortNum` 排序           |

首页和阅读页不作为书籍输入；不支持任意 HTML 网站或旧版论坛 `/detail/ID` 帖子导入。站点需要登录时，轻书架可以从 `QUILLBIND_LIGHTNOVEL_TOKEN` 读取用户自行提供的现有会话令牌，只发送给固定 API 主机，不写入书稿或报告。不调用付费下载接口。受限章节、验证码页、空正文、加载失败提示、目录数量不一致和未知排序脚本都会阻止发布。轻书架使用专用混淆字体的章节会报告 `NOVEL_SOURCE_FONT`，避免把不对应的字符作为普通正文保存。

站点元数据缺失时可在采集命令中使用 `--title`、`--author`（可重复）、`--description`、`--language` 覆盖，或先 `--prepare-only` 后编辑 `book.yaml`。书目分类默认为 `Literature.Fiction`，ISBN 留空；不把站点标签或上传者冒充作者或正式电子版书号。哔哩及轻书架默认语言标记为 `zh-Hans`，哔哩繁体入口为 `zh-Hant`。轻之国度的 Nuxt 数据保留源中文，即使 `/tw/` 页面也可能提供简体原文，因此使用 `zh`，保留入口和原文，不把网页显示转换当成已采集文本。需要转换实际文本时，采集后使用现有 `build --to ... --online` 工作流。

封面和插图按内容哈希命名、下载去重。JPEG、PNG、GIF 和被动 SVG 保留源字节，单帧 WebP 额外保存原文件并生成 PNG 供现有共享平台目标使用，不缩放。动画 WebP 会报错而非丢帧。源替代文字优先使用；缺失时采用编号插图标签，并报告需要人工完善图片描述。正文中的脚本、样式、表单和广告控件不进入书稿；文字中的 Markdown、数学和指令符号会转义为普通文字。源网页链接作为正文文字保留。图片路径遵循默认 Markdown profile 的书籍根目录相对规则。

每次请求默认间隔 1000 毫秒，`--delay` 可指定 0～60000 毫秒。429 和 5xx 最多重试两次并退避；超过一分钟的 `Retry-After` 会提示稍后重试。Ctrl-C 取消请求并清理未完成的临时书稿。目录和正文请求限制在该站点的主机名单中；图片允许公网 CDN。每次重定向均重新验证 URL 和公网 DNS，并固定连接到检查过的 IP，保留 TLS 主机校验。若系统 DNS 返回 VPN 使用的 `198.18.0.0/15` Fake-IP，则向固定 Google Public DNS HTTPS 端点查询真实 A 记录，再执行相同公网检查；不会直接连接 Fake-IP。其他非公网地址被拒绝。HTML/API 响应最多 16 MiB，图片最多 32 MiB；这些是网络请求边界，不改变已有本地书籍的大小策略。

`--json` 的 stdout 只包含结构化结果；进度写入人类模式的 stderr。`--prepare-only` 返回 `status: prepared`、`publicationReady: false` 和发布检查未运行的状态。默认打包调用 `buildBook`，保留 EPUBCheck、Ace、浏览器 QA、平台 lint 和重复构建字节比较；可以显式选择 `--qa-coverage stratified`。缺少工具仍然是环境错误。

`novel.json` 汇总本次采集和每个书籍项目的状态。`metadata/novel-source.json` 记录来源、卷／章顺序、各章节分页 URL、生成文件哈希、图片原始与输出哈希及转换动作。`novel-requests.json` 保存非认证请求的 URL、响应字节数和哈希。报告不保存请求头或会话令牌。采集失败不会留下半本书；完成采集后的发布失败会保留本地书稿和本次构建报告，可修正后直接 `build`，无需再次采集。逐卷构建的结果分别记录，整体只有全部发布成功才返回成功。

## 实现依据与实测范围

以下来源于 2026-09-12 检查：

- [bili_novel_packer](https://github.com/montaro2017/bili_novel_packer/tree/9774efe8221a03341f677a03aceb4929c1559220) 的分卷、分页和段落恢复实现。段落脚本数值提取方式参考该 MIT 项目，许可证保存在 [third-party/bili-novel-packer.txt](../third-party/bili-novel-packer.txt)。本实现仅解析数值表达式，不执行站点 JavaScript。当前已核对的参数为固定前 20 段、种子 `chapterId * 126 + 232`、LCG 参数 `9302, 49397, 233280`；未知数值配方报错。
- [lightnovel-crawler](https://github.com/lncrawl/lightnovel-crawler/tree/59b0382d51927953aa8120c5de62dab23ce3f731) 用于比较采集／输出职责划分，未复制其 GPL 实现。
- [LightNovelShelf 官方前端](https://github.com/LightNovelShelf/Web/tree/32e5f6097d703750784f856cc153233ca6fe5066) 的 `services/book`、`services/chapter` 和 `services/transport` 确定轻书架接口、参数、系列与章节关系；使用 [Microsoft SignalR 配置文档](https://learn.microsoft.com/en-us/aspnet/core/signalr/configuration?view=aspnetcore-10.0) 的 JSON 协议和 HTTPS Long Polling。
- [轻之国度](https://www.lightnovel.fun/book/31608) 的当前页面及前端提供的只读目录接口确定 Nuxt 数据与分页结构；通过 [devalue](https://github.com/sveltejs/devalue) 解码数据，使用 [Cheerio](https://cheerio.js.org/docs/basics/loading/) 解析 HTML。
- Fake-IP 回退遵循 [Google Public DNS JSON API](https://developers.google.com/speed/public-dns/docs/doh/json)，固定 HTTPS 主机及 IP，保留 DNSSEC 默认校验，设置 `edns_client_subnet=0.0.0.0/0`。

离线测试使用原创合成书稿，覆盖三类来源、分页、漏章检测、目录层级、图片去重及安全失败，生成候选 EPUB 后执行内部验证和重复字节比较。实际站点状态会独立变化：本次哔哩样例阅读页在普通浏览器中也返回“內容加載失敗”的截断文本，该响应会明确报错，不能作为完整采集成功的证据。
