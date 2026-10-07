# 元数据字段白名单

本文件集中维护当前允许的 **47 个 FLAC / Vorbis Comment 用户字段**：11 个必填或按场景必填字段（其中 2 个允许按下文例外记录缺失）、8 个选填发行与识别字段、28 个选填人员署名与作品字段。封面另用原生图片结构，不计入文本字段数。

读取、映射、写入或校验标签时，以本文件查询字段范围、输入别名、存储格式和排除项。元数据保留与覆盖条件遵循[元数据规则](METADATA.md)；艺人署名规则见[艺人规则](ARTISTS.md)，Genre 与封面分别见[流派规则](METADATA.md#genre-受控词表)和[封面规则](COVER.md)。

## 必填白名单

下表列出最终 Vorbis 键及适用范围；适用字段缺失且不符合[可靠信息缺失例外](#可靠信息缺失例外)时进入 `REVIEW_REQUIRED`。标题、艺人和专辑名称均受[元数据规则](METADATA.md)的“当前内嵌元数据优先”规则约束。

| Vorbis 键 / 语义 | 适用范围 | 要求 |
| --- | --- | --- |
| `TITLE` / 标题 | 所有音轨 | 保留可信值，仅在缺失或明显错误时可靠补正 |
| `ARTIST` / 艺人 | 所有音轨 | 按[艺人规则](ARTISTS.md)保存有序多值 |
| `DATE` / 发行日期 | 所有音轨 | 至少确定四位年份；有可靠月日时优先保存完整日期，路径只取年份 |
| `COUNTRY` / 国家或地区 | 所有音轨；可记录缺失 | 使用所选发行的国家或地区名称；可靠信息不可得时按下文例外省略，不以艺人国籍代替 |
| `GENRE` / 流派 | 所有音轨；可记录缺失 | 使用[流派规则](METADATA.md#genre-受控词表)受控英文词表；可靠信息不可得时按下文例外省略 |
| 封面 | 格式支持嵌入时 | 唯一、正确且符合[封面规则](COVER.md)比例要求的正面封面；FLAC 使用原生 picture block，不写为文本键 |
| `ALBUM` / 专辑 | 有专辑归属的音轨 | 保留可信值；补正条件与 Apple 发行类型后缀清理见[元数据规则](METADATA.md) |
| `ALBUMARTIST` / 专辑艺人 | 有专辑归属的音轨 | 保留可信实际艺人名单；补正、多值及 `Various Artists` 的写入与保留条件见[艺人规则](ARTISTS.md) |
| `TRACKNUMBER` / 轨号 | 有专辑归属的音轨 | 当前轨号明确；FLAC 至少两位补零 |
| `TRACKTOTAL` / 总轨数 | 有专辑归属的音轨 | 所在音乐碟最终实际轨数明确，不含被排除的 DVD / BD 曲目；FLAC 至少两位补零 |
| `DISCNUMBER` / 碟号 | 有专辑归属的音轨 | 按[下文计数规则](#轨号碟号与日期)对排除 DVD / BD 后的音乐碟连续编号；FLAC 至少两位补零，单碟为 `01` |
| `DISCTOTAL` / 总碟数 | 有专辑归属的音轨 | 排除 DVD / BD 后最终纳入成品的音乐碟数；计数规则见[下文](#轨号碟号与日期)，FLAC 至少两位补零，单碟为 `01` |

表格是字段集合的唯一数据源；只读脚本解析这两个白名单章节的首列键及必填表的适用范围，包括“可记录缺失”标记。维护时保留这些结构，字段增删同步调整本文件的说明与测试输入。

无专辑归属的单曲（singleton）不适用 Album、Album Artist、Track、Disc，不得为满足必填要求伪造这些值。

## 可靠信息缺失例外

冷门、同人或自主发行按[来源规则](SOURCES.md)完成适用查证后，仍无法可靠确定 COUNTRY 或受控 GENRE 时，允许分别省略其中一项或两项。将受影响音轨、缺失字段、查询证据和具体原因记入计划、恢复记录及最终报告；其它完成条件满足后可正常发布、清理并标记 `COMPLETED`，仅这些已记录的缺失不触发 `REVIEW_REQUIRED`。

已有可信 COUNTRY 或可靠且符合受控词表的 GENRE 继续保留，有可靠来源时补齐。缺失以不写该键表示，不写空值、Unknown 或猜测值；无法可靠映射的原始信息保存在快照中。发行身份不明、版本存在阻断性冲突或其它必填项缺失仍按对应规则复核。

调用字段校验与路径生成时，用[工具的 omissions 输入](TOOLS.md#白名单字段检查)逐字段提供缺失原因，原因引用相应查询记录；工具只检查例外范围和记录结构，可靠性仍由调用者核验。

## 选填白名单

以下 36 个字段仅在已有可信值，或来源可靠且语义明确时写入；没有可靠信息时不写入，不为补齐标签猜测。

### 发行与识别

| Vorbis 键 | 语义与要求 |
| --- | --- |
| `ORIGINALRELEASEDATE` | 作品或专辑最初发行日期；仅在能与当前版本的 `DATE` 可靠区分时写入 |
| `VERSION` | 适用于当前音乐部分的发行版本说明，如 Deluxe、Remaster、Limited Edition；须为发行本身具有的信息，不从被排除 DVD / BD 的介质或章节信息生成 |
| `LABEL` | 厂牌；可重复多值 |
| `PUBLISHER` | 发行方或出版方；不因名称相似而与 `LABEL` 互相复制 |
| `CATALOGNUMBER` | 厂牌目录号；多个可靠目录号可重复多值 |
| `UPC` | 当前专辑或发行的商品码 |
| `ISRC` | 通常为音轨级录音识别码，须对应当前具体录音 |
| `ASIN` | 须可靠对应当前发行或商品 |

### 人员署名、古典乐与作品层级

古典乐优先考虑 `COMPOSER`、`CONDUCTOR`、`WORK`、`PART`、`MOVEMENTNAME`、`MOVEMENT`、`MOVEMENTTOTAL`。Roon 建议古典表演署名优先使用 `ENSEMBLE`、`SOLOIST`、`PERSONNEL`，避免仅以笼统的 `ARTIST` 表示。

| Vorbis 键 | 语义与要求 |
| --- | --- |
| `COMPOSER` | 作曲者；可重复多值 |
| `LYRICIST` | 作词者；可重复多值，与歌词正文 `LYRICS` 区分 |
| `LYRICS` | 歌词正文；保留原文与换行，不自行翻译或罗马字化 |
| `CONDUCTOR` | 指挥；可重复多值 |
| `ARRANGER` | 编曲或改编者；可重复多值 |
| `WORK` | 作品或大作品标题 |
| `PART` | Roon 多乐章或多部分作品的当前部分名称 |
| `SECTION` | Roon 多层作品的中间层级，如歌剧 Act；须有可靠结构依据 |
| `WORKID` | 区分同一专辑内同一 `WORK` 的不同演出；同场演出的相关音轨使用同值，不生成无意义 ID |
| `MOVEMENTNAME` | 通用乐章标题 |
| `MOVEMENT` | 乐章序号 |
| `MOVEMENTTOTAL` | 总乐章数 |
| `PERFORMER` | 通用跨播放器表演者 credit；可重复，格式及成对规则见下文 |
| `ENSEMBLE` | 乐团或组合；古典乐优先 |
| `SOLOIST` | 独奏者或独唱者；角色须可靠，可重复 |
| `PERSONNEL` | Roon 人员 credit；可重复，格式及成对规则见下文 |
| `PRODUCER` | 制作人；可重复 |
| `ENGINEER` | 工程或录音工程 credit；角色须可靠，可重复 |
| `MIXER` | 混音 credit；可重复 |
| `MIXARTIST` | Roon 可解析的混音字段；保留已有可信值，新增优先选用语义更明确的字段 |
| `DJMIXER` | DJ mix credit；仅在角色明确时写入 |
| `REMIXER` | Remix credit；可重复 |
| `REMIXED BY` | Roon 可解析的 remix 字段；保留已有可信值，不与 `REMIXER` 机械复制 |
| `VOCALS` | 演唱 credit；角色须可靠，可重复 |
| `VOCALIST` | Roon 可解析的演唱字段；保留已有可信值，不与 `VOCALS` 机械复制 |
| `AUTHOR` | 作者 credit；仅在来源明确采用该语义时保留或写入 |
| `WRITER` | Writer credit；无法区分 Composer、Lyricist、Writer 时不猜测 |
| `ORGANIZATION` | 来源明确的组织 credit；不因存在 `LABEL` 而机械复制 |

## 表演类 credit 成对规则

身份与角色可靠的演唱、演奏、客席、Voice Synthesizer 等表演类 credit，须同时维护：

- `PERFORMER=Name (role)`：通用 Vorbis/Picard 表示。
- `PERSONNEL=Name - Credit Role`：角色使用 Roon Credit Roles 的 canonical role，如 `Vocals`、`Featured Artist`、`Voice Synthesizer`。

每项 credit 各用一个独立重复值；两字段姓名必须一致，角色语义必须一致。Producer、Engineer、Mixer 等非表演类 credit 不得为成对而伪造 `PERFORMER`。具体署名示例见[艺人规则](ARTISTS.md)。

`ORCHESTRA` 不在 Roon 支持标签中，不输出该独立键；可靠的乐团信息优先使用 `ENSEMBLE`。需明确 Orchestra 表演 credit 时，成对写入 `PERFORMER=Name (orchestra)` 与 `PERSONNEL=Name - Orchestra`。

## 输入别名与最终键

Roon Import Settings 支持下列跨格式输入别名及上表 credit 键。扫描时先解析语义，不得在映射前作为未知字段丢弃；最终 FLAC 仅输出上述白名单 Vorbis 键，不照搬 ID3 frame 名或其它容器别名。

| 输入别名 | 最终语义或表示 |
| --- | --- |
| `YEAR` | 当前发行 `DATE` 的年份信息 |
| `TRACKNUM` | `TRACKNUMBER` |
| `TOTALDISC`、`TOTALDISCS` | `DISCTOTAL`；输入值仅作核对线索，按[下文计数规则](#轨号碟号与日期)排除 DVD / BD 后重新计算 |
| `TCOM` | `COMPOSER` |
| `TPE1` | `ARTIST` |
| `TPE2`、`ALBUM ARTIST`、`ALBUM_ARTIST`、`ALBUM_PERFORMER` | `ALBUMARTIST` |
| `SOLOISTS` | `SOLOIST` |
| `STYLE`、`GENRES`、`STYLES` | 重复 `GENRE`，受[流派规则](METADATA.md#genre-受控词表)词表约束 |
| `FEATURING` | [艺人规则](ARTISTS.md)的成对 Featured Artist credit，不输出独立 `FEATURING` |
| `TPE3`、`IPRO`、`TPUB` | 按官方定义解析到本文件对应语义 |

无法可靠判断等价关系时，保留信息并标记复核，不静默丢失。最终字段名大小写按白名单表中形式输出。FLAC 多值使用重复键，不压成单个 `A & B` 字符串；`LYRICS` 保留为一个多行值，不按行拆成重复键。

总数统一使用 `TRACKTOTAL`、`DISCTOTAL`，不同时保留 `TOTALTRACKS`、`TOTALDISC`、`TOTALDISCS`。`YEAR` 与 `DATE` 一致时合并为 `DATE`；冲突时结合当前内嵌元数据与发行证据判断，最终不机械保留两份同义日期。

## 明确删除的字段

最终写标签前删除 `ROONALBUMTAG`、`ROONTRACKTAG`、`IMPORTDATE` 及所有 `REPLAYGAIN_*`，包括 `REPLAYGAIN_ALBUM_GAIN`、`REPLAYGAIN_ALBUM_PEAK`、`REPLAYGAIN_TRACK_GAIN`、`REPLAYGAIN_TRACK_PEAK`、`REPLAYGAIN_REFERENCE_LOUDNESS`。

资料库分类、导入时间、播放器状态和响度分析由播放器在资料库层维护，不写回成品标签；其它白名单外用户元数据同样删除。

## 其它标签格式

MP3/ID3v2.4、M4A/MP4 等按相同语义白名单映射到常用原生字段，可参考 Roon Import Settings 的跨格式别名。不因格式改变扩大白名单，也无需在本文件维护完整 frame/atom 对照表。

选填语义无稳定表示时可省略，不制造私有字段；写后必须读回校验。常见映射：ID3v2.4 的 Lyricist 为 `TEXT`、Lyrics 为 `USLT`，MP4 的 Lyrics 为 `©lyr`；其余以当前工具链稳定读回为准。

## 轨号、碟号与日期

总碟数（含输入别名 `TOTALDISC` / `TOTALDISCS`）按[DVD 与 BD 排除与计数规则](AUDIO.md#dvd-与-bd-碟排除与计数)计算，最终 FLAC 写为 `DISCTOTAL`。DVD / BD 不占用碟号、不计入总碟数或总轨数；`DISCNUMBER` 按保留音乐碟的相对顺序连续编号。该计数语义同样适用于 ID3 的 `TPOS` 和 MP4 的 `disk`，不能直接照搬含 DVD / BD 的来源总数。

| 格式 | Track / Disc 表示 |
| --- | --- |
| FLAC / Vorbis Comment | 当前值与总数分键存储，均至少补零到两位，如 `TRACKNUMBER=01`、`TRACKTOTAL=04`；单碟为 `DISCNUMBER=01`、`DISCTOTAL=01` |
| ID3v2.4 | `TRCK` / `TPOS` 可保存 `01/04`、`01/02` |
| MP4 | `trkn` / `disk` 使用原生“当前值 + 总数”结构 |

FLAC 的 `01/04`、`01/01` 仅为逻辑表示，不写为单字段斜杠字符串；其它格式也不得将原生数值对降为自定义文本。文件名只取当前值并补零到两位。有可靠月日时优先在 `DATE` 保存完整发行日期，路径年份始终取四位。

## Roon 兼容范围与依据

本 skill 以 **FLAC / Vorbis Comment** 为主要规范。Roon 官方支持的音乐内容、发行、作品结构与人员署名（credit）语义可纳入白名单；资料库管理、播放器组织和响度分析字段不属于成品元数据，即使 Roon 可读取也须删除。

判断字段语义与角色名称时，以以下官方页面为准，不依第三方标签表扩充。新增字段须先显式加入白名单或有 Roon 官方文档依据。

| 官方依据 | 用途 |
| --- | --- |
| [File Tag Best Practice](https://help.roonlabs.com/portal/en/kb/articles/file-tag-best-practice) | 作品层级、credit、发行识别、`PERSONNEL` |
| [Import Settings](https://help.roonlabs.com/portal/en/kb/articles/import-settings) | Artist、Composer、Label、Credit、Genre 的解析规则及跨格式别名 |
| [Tags](https://help.roonlabs.com/portal/en/kb/articles/tags) | 确认 `ROONALBUMTAG`、`ROONTRACKTAG` 属于资料库组织字段 |
| [Volume Leveling](https://help.roonlabs.com/portal/en/kb/articles/volume-leveling) | 确认 Roon 可读取、本项目须删除的 `REPLAYGAIN_*` |
| [Credit Roles](https://help.roonlabs.com/portal/en/kb/articles/credit-roles) | `PERSONNEL` 的规范角色名称（canonical role） |
| [Metadata Model](https://help.roonlabs.com/portal/en/kb/articles/metadata-model) | 可从文件获取的专辑及音轨元数据范围，如 Product Code |
| [MusicBrainz Picard Tag Mapping](https://picard-docs.musicbrainz.org/en/latest/appendices/tag_mapping.html) | Vorbis `PERFORMER={artist} (instrument/role)` 表示 |
