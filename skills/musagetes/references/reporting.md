# 最终报告归并

报告从当前 inventory、最新历史快照、逐文件发布/清理结果、CUE 处置和[分维度评估](sources.md#分维度采用与安全部分整理)重建，不复制上轮 review 目录列表。以稳定文件 ID 联结，移动后使用当前路径，独立副本用各自 ID 并保留成品映射；同一类结果取最大 sequence，重复序号是冲突，文件名和时间不是排序依据。

至少分别列出以下类别，说明计数单位并链接实际路径及证据：

| 类别 | 计入条件 |
| --- | --- |
| 未识别音频 | 当前确实存在且实际 codec 已核验的音频，身份仍未确认；不包括已被成品取代的旧副本。未完成查询同时列[检索缺口](search.md)，不宣称有效零结果 |
| 已确认部分事实的音频 | `PARTIAL_MATCH`，列已确认录音/上下文及未知成员关系等，不归为完全未识别 |
| 缺封面 / 封面尚未核验 | 按专辑或来源组统计，独立于录音身份；缺图不撤销已确认身份 |
| CUE 缺源 / 重复 / 其它 | CUE 文档和对应实际音频的关系，不能把一份 CUE 当一首未匹配歌曲 |
| 证据与审计资料 | JSON、查询快照、日志等附件，不能计入未匹配音频数量 |
| 已发布 / 已清理重复副本 | 用当前输出与最终清理结果确认；分别列实际成品 ID 和已移除副本 ID，不能按历史尝试次数累计 |

生成新的待复核音频分组前，先排除已发布音轨和已被验证成品取代的副本。已发布音轨的身份或封面缺口仍显示在对应维度的续做清单，不重新制造旧 review 副本。分组无待处理音频就不生成空 review 事件；既有完成事件保持不变，最终快照仍列真实成品、原始文件和保留资料，不能输出空 `expected_files` 来维持一个过期分组。附件可单独保留而无需空音乐事务。

处置角色与 LRC 统计继续按[交付规则](delivery.md#状态与最终报告)输出。报告保存后，再跑历史和清理审计，核对每个现存成品的最终哈希；新增、缺失、重复、无法解释的哈希或状态差异均列阻断。报告分类不替代完整交付状态，也不能自行把 REVIEW_REQUIRED 改成 COMPLETED。

## 只读报告审计

[report-audit.py](../scripts/report-audit.py) 读取当前文件，联结已记录的最新结果并输出上述分类，不写报告或历史：

```sh
python3 -B "$skill_dir/scripts/report-audit.py" --root "$music_root" --input "$report_input"
```

`--input -` 可从 stdin 读取。输入对象仅含五个数组（可为空）：

| 数组 | 每项字段 |
| --- | --- |
| `groups` | 唯一 `id`，`cover` 为 `present`、`missing`、`unknown` 或 `not_applicable`；来自最新维度评估 |
| `files` | 唯一 `id`、所属 `group`、当前或已移除的 `path`（root 相对路径）、`sha256`（最终预期 SHA-256）、`kind`（已核验 `audio`、`cue` 或 `evidence`）、`match_status`（音频为交付词表的匹配状态，其它为 null） |
| `publications` | `file_id`、正整数 `sequence`、`status`（`published` / `pending`）、`outputs`（当前成品文件 ID 数组）、非空 `evidence`（操作记录引用/依据） |
| `cleanups` | 同上，status 为 `removed`、`pending` 或 `preserved`；removed 的源应不存在，替代成品须仍存在 |
| `cues` | `file_id`、正整数 `sequence`、`status`（`missing_source`、`duplicate`、`resolved` 或 `pending`）、非空 `evidence` |

三个结果数组各自按文件取最新 sequence；发布或移除成功必须有非空 outputs，且包含在 files 中。原路径未变的发布可指向同一 ID；独立副本指向另一个 ID。旧副本和成品均列入 files，已知移除项也保留其预期哈希以供归并。全部输入先与 inventory/history 对账，不能只提交希望统计的文件来掩盖遗漏；仍有隔离副本时保留为待办或在清理报告说明，不能伪造 removed。

输出 `categories` 是分类 ID 数组，`counts` 对应文件数，唯独封面类别为组数；`review_groups` 只包含仍存在、未发布且未被成品取代的音频 ID，不出现空数组。缺失且无有效发布/清理映射、成品哈希变化、链接/无法安全读取或虚假的移除结果令 `ok: false`；不能在此时用零个实际文件宣称待办已解决。未知引用、重复路径/ID/序号或无效输入直接报错。退出码 0 为此范围内对账通过、1 为文件/结果不一致、2 为输入错误。

`scope: recorded_files_and_latest_outcomes_only` 不证明文件类型、媒体身份、封面、证据内容、授权或未列入清单的文件；kind 必须来自实际 codec/文档检查，不能直接把 inventory 的扩展名提示当确认。helper 不执行音频解码、检索或清理；报告读者应保留这些局限与各独立审计的实际结果。
