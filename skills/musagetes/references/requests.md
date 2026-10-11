# 上游请求调度

外部查询前先按本文件调度。请求执行器仍使用当前可用的 HTTP、浏览器或检索工具；[source-throttle.py](../scripts/source-throttle.py) 只计算决策，不联网、不等待、不写状态或媒体。响应码只决定传输调度，发行身份与采用门槛仍按 [sources.md](sources.md) 核验。

## 来源队列与复用

同一次整理由一个协调者维护所有来源的状态；同一来源串行发送，请求完成并记回状态后再放行下一项。专辑、查询词、发行 ID、商店地区和重试共享来源配额。不同来源可继续处理；不同根目录也沿用同一会话的来源冷却。并行工作者须向同一协调者领任务，不能各自启动一套额度。此 helper 不协调其它进程或共享出口 IP 上的独立客户端。

来源按 URL 主机名归组，忽略路径、查询和端口，以下别名合并。表中的数值是本 skill 的保守起始间隔；在上一次响应完成后至少等待该间隔再发下一次请求。执行时核验官方限制，有更慢的要求就通过 `minimum_interval` 提高下限；成功恢复也不能低于此下限。MusicBrainz 请求携带含应用名、当前 skill 版本及联系地址的 User-Agent，版本读取 SKILL.md，联系地址可用项目主页。

## 来源间隔

| 主机（逗号分隔别名，首项为状态键） | 最小间隔（秒） | 依据 |
| --- | --- | --- |
| `musicbrainz.org, www.musicbrainz.org` | 1.1 | [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting) 按 IP 限速，并以 503 拒绝过量请求；额外留出余量 |
| `itunes.apple.com` | 3.1 | [iTunes Search API](https://performance-partners.apple.com/search-api) 的近似每分钟配额；search 与 lookup、所有地区共用 |
| `*` | 1 | 其它来源的起点，不代表官方配额；Apple Music API、Cover Art Archive 及图片 CDN 按各自主机与实际限制调度 |

同一运行内复用已成功且有效的完全相同请求结果，身份包括 URL、完整参数、地区及影响表示的请求头；记录原始响应证据的引用。先复用发行详情和逐轨列表，避免每首歌重复取整张专辑。空的成功搜索结果只说明这组查询无命中；429、5xx、鉴权失败和网络错误不能缓存成“无发行/无封面”。跨运行缓存须重新验证时效，304 只有对应缓存可用才算成功。

## 响应分类

下表同时供 helper 读取；未列举的结果停止当前请求并检查原因。仅对只读 GET / HEAD 自动重试。每次实际发送都计入该逻辑请求的 `attempt`；改变参数不是重试同一请求，但仍受来源冷却及[查询收束规则](sources.md#来源优先级)约束。

| 响应码或传输错误 | 分类 | 处理 |
| --- | --- | --- |
| `200-299, 304` | `success` | 核验响应内容；逐步恢复来源间隔，304 须有可用缓存 |
| `429, 503` | `throttle` | 来源整体退避；MusicBrainz 的 503 同样按限流处理 |
| `408, 500, 502, 504, timeout, connection` | `transient` | 有限重试并降低该来源速率；timeout/connection 仅指实际可判断的临时传输故障 |
| `401, 403` | `block` | 停止该来源，检查认证、权限或访问限制；有纠正证据后才解除 blocked，保留其余冷却状态 |
| `tls, unknown` | `stop` | TLS/证书失败或工具未暴露可判定结果时记录实情，不猜测为 429/成功 |

其它 4xx（包括 400、404、410）及未列举的 5xx 不重复发送原请求，不因此放慢其它来源。3xx 先核验跳转目标，再按目标来源排队；遵守原响应的 Retry-After，重定向链最多五跳并记录，不能借跳转绕过冷却。执行器若隐藏中间状态/自动重试，使用其已公开的限流机制；明确报告不可观察范围，遇到持续失败转向其它来源，不能声称 helper 控制了隐藏请求。

## 调度参数

以下参数是 helper 的唯一配置来源。`max_attempts` 包含首次发送；退避上限只限制本地间隔，不截短服务端要求。

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `max_attempts` | 3 | 同一逻辑请求最多发送次数 |
| `backoff_factor` | 2 | 每次 throttle / transient 将来源间隔乘以此值 |
| `max_interval` | 60 | 本地退避间隔上限；已核实的更高来源下限仍优先 |
| `jitter_ratio` | 0.25 | 失败等待在间隔上额外增加 0 至该比例的随机抖动 |
| `recovery_successes` | 3 | 连续成功达到此数才恢复一步；其它结果中断成功序列 |
| `recovery_factor` | 2 | 每步恢复将间隔除以此值，最低为来源下限 |
| `circuit_failures` | 3 | 来源自上次成功以来累计临时失败达到此数则冷却 |
| `circuit_seconds` | 300 | 持续失败的来源冷却时长；到期仅由协调者串行探测 |
| `max_inline_wait` | 60 | 超过此等待时间返回 defer，先做其它来源或本地工作 |

`Retry-After` 按 [HTTP 语义](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)解析非负整数秒或 HTTP-date。日期形式优先相对有效响应 `Date` 计算，缺失时使用本地接收时刻；过去日期、零、缺失或无效头仍须遵守本地间隔/退避。最终下次允许时间取已有冷却、本地等待、服务端等待中的最晚者。长等待保留完整时间戳并返回 defer，不在等待上限到达时提前重发。一次成功或换一张专辑不能清除尚未到期的冷却。

重试预算耗尽后停止该请求，继续保存其来源状态，后续专辑仍受冷却。到期探测失败会再次冷却；没有新线索时按查询收束规则结束该路线，不无限探测。因来源不可用而未能核对的字段继续按原有证据门槛和缺失例外处理。

## Helper 调用与记录

```sh
python3 -B "$skill_dir/scripts/source-throttle.py" --input "$request_event"
```

输入是 JSON；`--input -` 从 stdin 读取。每次输出的完整 `state` 由协调者串行接回下一次输入，保存在已授权运行状态目录的来源证据中，包含主机、间隔、连续成功/临时失败计数、下次允许时间及 blocked。恢复时先加载最新状态；损坏状态须复核，不能按空状态重新发请求。仅全新会话可省略 state 或传 null；同一会话的跨专辑、跨根目录请求不可重置。

| 输入键 | 约束 |
| --- | --- |
| `operation` | `check` 在发送前调用；`observe` 在拿到结果后调用 |
| `url` | 当前请求的 HTTP(S) URL，不含内嵌用户名/密码；helper 仅使用主机归组 |
| `attempt` | 当前逻辑请求的发送序号，从 1 开始，由协调者依据日志保留；check 时填拟发送的序号 |
| `now` | 可选，UTC Unix 秒，默认当前时间；测试可注入固定时间 |
| `state` | 可选，上一输出的完整状态；只在新会话初始化时省略 |
| `minimum_interval` | 可选，经核实的更慢来源下限（秒）；只提高，不降低下限 |
| `status` / `error` | observe 恰有其一；HTTP 整数状态码，或表中的 timeout / connection / tls / unknown |
| `headers` | 可选，仅输入调度所需的 Retry-After、Date 响应头，名称大小写不敏感 |
| `cache_available` | 可选布尔值，仅在 304 对应有效缓存确实可用时为 true |

check 返回 `ready` 才能发送；`wait` 等到 `not_before` 后重新 check；`defer` 记录未来时间并继续独立工作；`blocked` 等待具体访问问题被纠正；`stop` 结束已耗尽的请求。observe 的 `complete` 仅表示传输成功，`retry` 仍须先等到 `not_before` 并以递增 attempt 再 check；其它动作同上。输出还包含 `source`、`reason`、`wait_seconds`、解析的 `retry_after_seconds`（observe）以及 `scope: request_scheduling_only`。

退出码 0 表示已计算出决策，包括 stop/defer/blocked；2 表示输入或规则损坏，不能发送。helper 不代替串行执行器、缓存内容核验或调用日志。每次请求记录 URL/查询与地区、attempt、实际响应码或传输错误、相关响应头、所用状态、调度决策及采用的证据引用；不保存 Authorization、Cookie 或令牌。等待超过本轮可用时间时在报告中列出受影响来源、下次允许时间与剩余查询。
