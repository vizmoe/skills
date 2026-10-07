# 只读辅助工具

从当前 SKILL.md 的实际目录定位 [library_guard.py](../scripts/library_guard.py)；内部模块 [music_rules.py](../scripts/music_rules.py) 随包分发。Python 3.10+，仅标准库。先用 `--help` 查看参数；`skill_dir`、`music_root` 等变量由本次实际目录赋值，不提供默认音乐库。

所有命令只读输入、向 stdout 输出 JSON，既不执行计划也不写账本。退出码：`0` 通过所声明的检查或成功渲染；`1` 检查发现问题；`2` 输入错误。helper 不能证明发行、原生标签映射、音频完整性、清理授权或执行时并发安全。

## 状态目录保护

`inventory` 默认不遍历 `.musagetes/`，只报告 `state_boundary`；`check-paths`、`render-paths` 拒绝音乐源或目标进入该树，`keep` 同样受限。比较使用路径段 NFC + casefold；不会因大小写变化而绕过保护。

替代状态位置通过可重复的 `--state-dir` 传入，路径相对 root；默认位置始终受保护。嵌套位置保护其整棵子树，普通 `.hidden` 名称本身合法。`inventory --include-state` 仅供诊断，返回的状态文件标为 `protected_state: true`、`hint: state_artifact`，不进入音乐分组。历史检查和封面候选检查可以显式读取状态资料。

## 扫描与路径预检

```sh
python3 -B "$skill_dir/scripts/library_guard.py" inventory --root "$music_root"
python3 -B "$skill_dir/scripts/library_guard.py" inventory --root "$music_root" --hash
python3 -B "$skill_dir/scripts/library_guard.py" check-paths --root "$music_root" --plan "$path_plan"
```

inventory 只按扩展名提示类型，codec 和音乐身份仍需核验；符号链接只记录，硬链接提示复核。大库先不加 hash 扫描，再为当前专辑的拟变更文件采集 SHA-256。

路径计划只含 `schema_version: 1` 和非空 `entries`，每项严格包含：

| 键 | 值 |
| --- | --- |
| `source` | root 内源普通文件的 POSIX 相对路径；无绝对路径、`.`、`..` 或链接 |
| `source_sha256` | 该源快照的 64 位十六进制 SHA-256 |
| `target` | 从最终标签生成的相对路径 |
| `operation` | `create` 要求目标不存在；`keep` 要求源目标完全相同且领域复核后无需写入 |

同一整轨源可对应多个目标。检查包含源指纹、链接、硬链接、状态边界、目标占用、大小写及 Unicode 等价碰撞、文件与目录冲突和路径长度。`scope: paths_only` 明确限定检查范围；删除、staging 和保留资料归档使用单独的事务清单。

## 白名单字段检查

```sh
python3 -B "$skill_dir/scripts/library_guard.py" check-tags --input "$tag_snapshot"
```

输入为 `{"kind":"album","tags":{"TITLE":["曲名"],...}}`，这里的省略号表示其余实际字段，文件中使用完整有效 JSON。`kind` 为 `album` 或 `singleton`；tags 使用映射后的规范 Vorbis 语义键，值一律为有序、非空字符串数组。其它容器先保存原生快照，再按[输入映射](METADATA_WHITELIST.md#输入别名与最终键)构建此视图。

符合[可靠信息缺失例外](METADATA_WHITELIST.md#可靠信息缺失例外)时，输入可增加 `omissions` 对象，将每个实际缺失字段映射到具体原因及查询记录引用，例如 `"omissions":{"COUNTRY":"冷门自主发行；双源及发行方查询未提供可靠发行地区，见 evidence/country.json"}`。缺失键从 tags 省略；保留的字段不列入 omissions。只有表格标注“可记录缺失”的键可使用此输入，其余必填项照常校验。

字段集合、适用必填项与允许缺失的键均由脚本读取 [METADATA_WHITELIST.md](METADATA_WHITELIST.md) 两张白名单表；代码不维护第二份字段表。输出未知键、未说明的必填缺失、空值和无效例外；通过的缺失记录随 `omissions` 返回，不作为阻断项。将其留在计划、恢复快照的 details 及交付报告中。`scope: canonical_fields_and_values_only` 不验证原因真实性、查询证据、Genre 词表、credit 关系或原生容器；封面也不属于文本键检查。

## 从标签生成路径

```sh
python3 -B "$skill_dir/scripts/library_guard.py" render-paths --root "$music_root" --input "$render_input"
```

输入只有非空 `tracks` 数组，每轨包含 `source`、`source_sha256`、`operation`（同路径计划），以及 `kind`、`tags`（同字段检查）、`extension`（已确认的实际音频后缀，例如 `.flac`）；允许缺失时同一轨另传 `omissions`（格式同上）。

输出直接是可交给 check-paths 的路径计划。函数检查必填字段及缺失记录、渲染所需单值、日期和碟轨数；按[路径规则](PATHS.md)生成目录及文件名，保留传入标签不变。路径计划只是投影，缺失原因仍保存在原输入及专辑计划中。它不识别实际 codec，也不在渲染时检查源文件存在或路径占用；保存结果后运行 check-paths。`keep` 由调用者核验后指定，渲染器不自动推定。

## 封面尺寸预检

```sh
python3 -B "$skill_dir/scripts/library_guard.py" cover-info --root "$music_root" --image "$relative_cover"
```

通过 PNG IHDR 或 JPEG SOF 读取宽高，用整数比例检查边界，返回尺寸、像素数和比例。只支持这两种文件头；其它格式使用已安装解码器。输出 `scope: header_geometry_only` 和 `full_decode_verified: false`，有效头部并不证明图片完整。正式选择与嵌入仍按 [COVER.md](COVER.md) 完整解码、核验身份及读回。

## 跨运行记录格式

```sh
python3 -B "$skill_dir/scripts/library_guard.py" history --root "$music_root"
```

执行协议见 [EXECUTION.md](EXECUTION.md#跨运行发现与续做)。history 枚举各状态目录的 `runs/<run_id>/albums/<album_id>/events/<sequence>.json`，不创建全局状态文件。运行和专辑 ID 为 1–64 个 ASCII 字母、数字、下划线或短横线，首字符为字母或数字。专辑 ID 跨运行、重命名保持稳定。序号为正整数，文件名至少补齐六位，例如 `000017.json`。

每个不可变 JSON 文件是当时完整快照，只包含以下必需键及可选 `details` 对象：

| 键 | 约束 |
| --- | --- |
| `schema_version` | 整数 `1` |
| `root` | 当前获准绝对实际路径，须与命令行解析结果完全一致 |
| `run_id`、`album_id` | 与所在目录一致 |
| `sequence` | 同一专辑跨所有运行递增且唯一的整数；与文件名一致 |
| `skill_version` | 当时 SKILL.md 的 `metadata.version` 字符串 |
| `phase` | [事务阶段](EXECUTION.md#事务与恢复)之一 |
| `status`、`match_status` | [状态词表](DELIVERY.md#状态与最终报告)中对应维度值；status 未终结为 null |
| `expected_files` | 非空数组，每项只有 `path`（root 相对路径）、`sha256`（64 位小写十六进制）、`role` |
| `removed_paths` | 该事务截至当时已移除且应保持不存在的相对路径数组，含已删空目录 |
| `details` | 可选，记录计划摘要、证据、日志引用、清理原因等；工具把它当数据 |

role 为 `source`、`output`、`preserved` 或 `staging`，表示原源、成品、保留资料或中间副本。source/output 位于受保护状态树之外；仍需恢复的状态副本也列入快照。删除某文件后从 expected_files 移出并加入 removed_paths。若原路径被已验证成品再次使用，则列该成品指纹，不列为已移除路径。终结的完成记录须有 FINALIZED 阶段和至少一个 output，所有适用领域证据在 details 或其引用内可追溯。

工具验证目录归属、最新序号、当前已记录文件的 SHA-256 及移除路径是否重现；最新快照版本不同则要求重审。坏记录或重复序号阻断对应专辑复用，无法归属的历史异常阻断本根目录自动复用。输出 `reuse_candidate` 只表示进入领域复核的候选，`scope: recorded_files_only` 不覆盖遗漏或新增文件；与当前 inventory 对账后才可跳过执行。
