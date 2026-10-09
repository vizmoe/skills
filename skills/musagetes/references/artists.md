# 艺人规则

## 署名与多值

标签保存有序、独立的艺人实体。固定组合如 `Simon & Garfunkel`、`AC/DC` 作为单一实体保留完整名称；实体边界由可靠身份依据决定。`ARTIST` 表示该轨主发行署名，`ALBUMARTIST` 表示专辑级主艺人，客席仅在有专辑级主署名依据时进入后者。TITLE 保留可信原文。

| 格式 | 存储与读回 |
| --- | --- |
| Vorbis Comment | 重复 `ARTIST` / `ALBUMARTIST` 键，保持顺序 |
| MP3 / ID3v2.4 | `TPE1`、`TPE2` 各一个文本 frame，frame 内多个字符串；读回为独立值 |
| M4A / MP4 | 标准 `©ART`、`aART` atom 内可稳定读回的多值；工具折叠时待复核，保留源文件 |

路径显示交给[路径规则](paths.md)，显示文本不回写标签。角色/CV、Featuring 和声库按下文各自的角色语义处理。

## 日本艺人姓名空格规范化（强制）

已确认是日本艺人的日文个人姓名时，移除姓名片段之间仅用于分隔的 Unicode 空格，包括半角、全角和不换行空格。例如 `麻枝 准`、`麻枝　准` 均成为 `麻枝准`；文字、姓名顺序和非空格标点保持原样。

此规范化同时适用于原内嵌标签和所有外部来源，覆盖艺人及白名单人员署名中的同一姓名，是[内嵌值优先](metadata.md#当前内嵌元数据优先)的明确例外。记录前后值，写入读回后再生成路径。

先确认个人身份与实体边界，再逐人处理。罗马字姓名、团体、专辑、曲名和歌词保持其空格；多个实体继续分值存储。角色/CV 只规范化已确认的真人日文姓名，成对 credit 同步修改姓名并保留角色格式。身份或空格语义不明时保留原值、标记 `REVIEW_REQUIRED`。

## MusicBrainz 艺人连接符处理（强制）

采用 [artist-credit 结构](https://musicbrainz.org/doc/MusicBrainz_API/Examples#Release)时，结合 `artist.id` 识别实体，以每项 `name` 保存有序署名。`joinphrase` 仅表示项间关系，按角色语义决定独立艺人或 credit；这覆盖任意连接符，包括空串、空格和未列举的 Unicode 字符。专辑和曲目分别解析自己的署名名单。

已有单值展示串经证据确认包含多个独立艺人时，同样转换为有序多值，这是内嵌值优先的结构化例外。可靠的单一组合完整保留。禁止将独立艺人的来源展示串直接作为单个标签值或路径艺人文本；路径仅从最终实体名单生成。

工具只给拼接串时，补查结构化署名或可靠实体依据；边界、角色或多值保存能力仍不明则待复核。读回逐项确认姓名独立、顺序正确，项间连接信息未混入姓名。

```text
来源：麻枝 准 × 熊木杏里（两个实体）
标签：ALBUMARTIST=麻枝准
      ALBUMARTIST=熊木杏里
路径显示：麻枝准 & 熊木杏里
```

## 角色歌曲与 CV 署名

官方完整“角色名 + CV”署名在规范化真人姓名后保留为单个 ARTIST。真人演唱者身份、角色可靠时，再按[成对 credit](metadata-whitelist.md#表演类-credit-成对规则)记录：

```text
ARTIST=月見ヤチヨ (CV: 早見沙織)
PERFORMER=早見沙織 (vocals)
PERSONNEL=早見沙織 - Vocals
```

此处 ARTIST 始终是一个完整值。官方只署真人歌手时使用该署名，角色和 CV 信息仅依据明确来源建立。

## Vocaloid 与歌声合成器

ARTIST 保存官方主艺人、Producer 或虚拟歌手署名。具体参与声库可靠时，另写表演 credit；多个声库各写一组：

```text
ARTIST=DECO*27
PERFORMER=初音ミク (voice synthesizer)
PERSONNEL=初音ミク - Voice Synthesizer
```

角色使用上述规范形式。声库身份需要参与证据，Genre 本身不能证明具体声库。

## Featuring 与客席艺人

`feat.` / `featuring` / `ft.` 明确表示主艺人与客席时，ARTIST 保存主艺人，每名客席各写一组成对 credit。可信输入别名也按[白名单映射](metadata-whitelist.md#输入别名与最终键)处理：

```text
来源：Aimer feat. Chelly
ARTIST=Aimer
PERFORMER=Chelly (featured artist)
PERSONNEL=Chelly - Featured Artist
```

这是内嵌值优先的结构化例外，仅调整 credit 存储，保留主艺人姓名、可信标题与专辑名。固定艺名或角色语义不明时保留可信信息并待复核。

## Various Artists

采用或保留单值 `ALBUMARTIST=Various Artists`，要求 Apple Music 与 MusicBrainz 均明确将所选发行的专辑级艺人标为该单值，并通过[来源门槛](sources.md#名称与艺人检索及置信度门槛)。分别记录专辑 URL / 发行 ID、Apple 商店地区与实际专辑艺人。Apple 一侧使用对应专辑页或官方目录，iTunes 搜索结果只辅助定位。

这一条件也适用于已有标签，优先于内嵌值优先规则。任一侧缺失、不可用、版本不符或署名不同，则使用有可靠专辑级依据的实际艺人名单；无法确定时待复核、保留源。双源通过也不构成覆盖已有可信实际艺人名单的理由。

艺人人数、合辑身份、各轨艺人差异和工具合辑标记均不能代替双源证据；实际专辑艺人也不能从曲目艺人机械汇总。各轨 ARTIST 保留真实署名，路径使用最终标签。
