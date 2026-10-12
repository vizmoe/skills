# 检索覆盖与闭环

MusicBrainz 与 Apple 的适用查询都要建立路由记录。路由是一个待解决的问题及查询策略，例如精确变体标题、无艺人限制的标题、艺人署名、ISRC、时长范围、发行上下文；不能将一次请求成功等同于整个检索完成。来源限流按 [requests.md](requests.md)，身份采用仍按 [sources.md](sources.md)。

## 查询构造

发请求前核对当前实体的官方字段和查询语法。MusicBrainz [Recording Search](https://musicbrainz.org/doc/MusicBrainz_API/Search/RecordingSearch) 的 `dur` 是毫秒；响应对象中的 length 不能当作搜索字段。字符串按 Lucene 语法转义并 URL 编码，保留完整发送 query、字段、单位和验证依据。下方表是 helper 校验显式 recording 字段的来源；执行时若官方字段变化，先核实并更新规则，不能把未知字段的零结果当成无匹配。

| 实体 | 允许的显式字段 |
| --- | --- |
| `musicbrainz-recording` | `alias arid artist artistname comment country creditname date dur firstreleasedate format isrc number position primarytype qdur recording recordingaccent reid release rgid rid secondarytype status tag tid tnum tracks tracksrelease type video` |

候选不足时，依次检查有依据的标题别名/译名/转写、精确混音或伴奏标识、曲目艺人与 creditname/artistname、无艺人限制的标题、ISRC/时长及发行上下文。不能只用专辑艺人过滤特典曲；如 FELT 的演奏曲可能署名 NAGI☆ 或 Maurits“禅”。目录号用于支持该字段的发行搜索/官方目录，不塞入 recording search 的不存在字段。每条路线记录为何需要、已完成或不适用；无依据的别名不凭空生成。

常见标题记录返回总数、limit、offset 和已读取范围。未读完的结果要继续分页或用有证据的条件缩小；截断列表即使当前页无候选也不能宣布零结果。适用查询路由未完成时，既有的“两轮无新增线索”只收束已有效执行的路线，不能跳过错误修正、必需来源或漏读分页。

## 路由状态与续做

| 状态 | 判定与下一步 |
| --- | --- |
| `HIT` | 有效响应有结果且覆盖完整；候选仍须独立核验身份 |
| `ZERO` | 字段/语法有效、响应结构有效、全部适用分页完成且结果数为零 |
| `INVALID_QUERY` | 字段、单位或语法无效；修正后重跑，保留原错误记录 |
| `TEMPORARY_FAILURE` | 实际临时网络故障或可重试 HTTP 结果；遵守来源冷却后重跑 |
| `NOT_RUN` | 尚未执行，明确列为未完成 |
| `INCOMPLETE` | 响应有效但分页/截断仍未解决，保留已见候选并继续覆盖 |
| `FAILED` | 认证、未知传输结果或响应结构等问题尚未解决；记录具体阻断 |

缓存按准确请求身份保存成功结果。错误记录是续做队列，不能因已有缓存文件就跳过；修正 query 后保留旧尝试并追加新尝试。只有当前路线最新有效且完整的结果可作为结论，历史错误单独统计。响应为 200 也须验证结构和字段；工具未暴露状态或响应结构时不能推定 ZERO。

结论分别写为“有效查询未见候选”“候选均未通过精确身份核验”或“检索未完成”。报告列必需路由、实际 query/字段、完成范围、当前错误数、历史错误尝试数、未完成项及原因；必需路由未完成时不得笼统写“未匹配/不存在”。已有可靠字段继续按分维度规则交付。

## 只读记录审计

[search-ledger.py](../scripts/search-ledger.py) 从 `--input` JSON 文件（`-` 为 stdin）读取 `routes` 非空数组。每路包含唯一 `id`、`source`（MusicBrainz 录音查询用上表实体）、布尔 `required` 和按先后排列的 `attempts`；未执行为 []。每个尝试保存完整 `query`、布尔 `syntax_valid`、`http_status`（无可见状态为 null）、布尔 `response_valid`，成功响应另有非负整数 `result_count`（已获取的总候选数）及布尔 `pages_complete`；dur 查询明确 `duration_unit: "ms"`。无状态时另记录 `transport_error`（timeout / connection / unknown）；语法依据、分页范围与原响应另存证据。

输出各路最新状态/字段、`completed_routes`、`pending`、`coverage_complete`、当前 `error_count` 与累计 `attempt_error_count`。`no_results` 只对全部列入路由均为有效 ZERO 且存在必需路由时为 true；它不是录音身份判定。返回码 0 为覆盖完整，1 为存在必需未完成路由，2 为输入/规则损坏。helper 不联网、不写缓存、不证明调用者声明的语法/分页/响应真实性；显式字段校验不能替代完整 Lucene 语法检查。
