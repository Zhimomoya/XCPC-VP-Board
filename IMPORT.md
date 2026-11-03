# 比赛数据来源与本地导入

## 1. 使用方式

准备比赛页面的“历史比赛”仍优先显示 XCPCIO 在线目录。目录按赛季分类，搜索可同时查找在线比赛、已下载比赛和本地导入比赛。

缺失的比赛可用本地文件补充：

1. 展开“历史比赛”下方的 **导入比赛数据**。
2. 选择文件；页面会自动识别格式并检查。
3. 核对比赛名称、题数、队伍数、提交数、时长和提示。
4. 点击 **导入并选择**，然后照常连接 QOJ、设置 VP 起点。

检查阶段不保存比赛，也不会更换当前比赛。导入后只选中了准备页的数据；当前比赛和历史会话保持各自的数据引用。数据保存在 `data/contests/imports/`，迁移前停止服务，将 `data/` 复制到新安装目录后可以继续使用。

导入比赛能从 ICPC / CCPC 届次识别赛季时，按届次归类；无法识别届次时按北京时间的开赛年归类。

目前采用 **XCPCIO 在线适配 + 用户本地导入补充**。RankLand 文件由用户提供，不在后台扫描 RankLand，也不会增加 QOJ 的页面读取次数。

## 2. 支持的文件

| 格式 | 选择方式 | 要求 |
| --- | --- | --- |
| XCPCIO 分文件 | 同时选择 `config.json`、`team.json`、`run.json`；可附学校文件 | 必须包含实际逐次提交 |
| XCPCIO 单文件 | 一个 JSON，顶层含 `config`、`team`、`run` | 与分文件结构相同 |
| XCPCIO ZIP | 把上述文件放在同一个 ZIP 中，可包含一层或多层文件夹 | 只能包含一场比赛，文件名不能重复 |
| RankLand / SRK | 一个 `.srk.json` 或 `.json` | 每个有提交的题目状态必须含完整 `solutions` |
| CCPC 官方外榜 | `rank.iccpc.cn` 的单个 `rank.json` | 包含 `contest`、`team`、`problem`、逐次 `solution`；无时区时间须附 `time_context` |
| DOMjudge / ICPC Event Feed | 一个 `.ndjson`、`.jsonl`，或包含事件数组的 `.json` | 必须包含比赛配置、队伍、题目和逐次 submissions / judgements |

文件须为 UTF-8，可带 BOM。上传文件总大小不超过 **32 MiB**，解压后的数据不超过 **80 MiB**；一次最多选择 8 个文件。ZIP 不解压到用户指定路径。

### XCPCIO

适配层兼容：

- 队伍、提交、学校记录是数组，或按 ID 索引的对象。
- `id` / `team_id`、`name` / `team_name`、`submission_id`，以及多语言名称。
- 秒、毫秒、微秒、纳秒形式的提交相对时间。
- 秒或毫秒 Unix 时间戳、带时区的 ISO 开始/结束时间。
- `problems` 和旧版 `problem_id` / `balloon_color` 结构。
- `official` / `unofficial` 标识、忽略提交、待判/封榜状态。
- 逐题分钟取整、累计秒数后按分钟取整、按秒计罚时。

学校信息可以内嵌，也可附带 `organizations.json` 或配置中引用的学校文件。没有学校文件时，仍可使用队伍中已有的学校名称或机构 ID。

只有最终得分、过题时间和错误次数，没有每次提交时间的数据，不能还原比赛进程。不要根据最终结果批量生成虚构提交作为导入数据。

### RankLand / SRK

是否可用取决于文件内容，而不是网站名称。每个有活动的 `rows[].statuses[]` 应包含 `solutions`，其中每条记录有判题结果和相对提交时间，例如：

```json
{
  "result": "AC",
  "time": [79, "min"],
  "tries": 3,
  "solutions": [
    {"result": "WA", "time": [30, "min"]},
    {"result": "WA", "time": [55, "min"]},
    {"result": "AC", "time": [79, "min"]}
  ]
}
```

整个文件还需包含 `contest`、`problems` 和 `rows`，以上只是一个题目状态片段。

导入时检查逐题结果、尝试次数、通过时间、总过题数及提供的总罚时与明细是否相符。部分题目有明细、其他有提交的题目却没有明细，也会拒绝。若重判或赛后罚时调整只反映在汇总里，应获取更新后的明细，不能用汇总覆盖原始记录。

支持 ICPC / CCPC26 类型的逐次记录。时间取整支持向下取整；暂不支持 OI 分数榜、向上取整等自定义计分规则。原始时间若只精确到分钟，导入后也不能获得额外的秒级信息。

文件明确提供金、银、铜三档名额时直接保留。例如 `[30, 60, 90]` 表示金牌 30 队、银牌 60 队、铜牌 90 队，对应 1–30、31–90、91–180 名。

### CCPC 官方外榜

支持 `rank.iccpc.cn` 当前公开的单赛事组 JSON：保留逐次提交、编译错误、正式 / 女队 / 打星身份、学校和题号；编译错误不计罚，比赛结束时间以外的提交不计成绩。非参赛管理账号及其提交会排除并提示。

时间串若没有 UTC 偏移，使用文件的 `time_context.wall_clock_timezone`，不使用 Windows / Ubuntu 的本地时区。现代 `Asia/Shanghai` 数据无需安装额外时区包。缺少时区依据时拒绝导入，避免静默把开赛时间错移数小时。其他时区若系统没有对应时区资料，可先转换成带 UTC 偏移的 ISO 时间。

保留源奖牌的数量或百分比规则，按源配置选择过题队伍、提交队伍（含编译错误）或全部正式队伍作为基数；打星队伍不计入。暂不支持一个文件混合多个赛事组。

### DOMjudge / ICPC Event Feed

可导入 ICPC Contest API 的 NDJSON 完整事件流，或等价的 JSON 事件数组。支持实体更新、删除、整集合更新及重判，忽略测试点级 `runs` 和其他与榜单无关的事件。

提交时间使用 `submissions.contest_time`，没有相对时间时使用绝对提交时间减去比赛开始时间。判题以该次提交最新的有效 judgement 为准；较早判题的迟到更新不会覆盖后续重判。判题类型提供的 `solved` 和 `penalty` 标志用于区分通过、计罚错误和不计罚结果。

只有 `/scoreboard` 的最终汇总 JSON 不属于完整事件流，不能导入。尚未判完、尚未解冻的事件流可以读取已提供的记录，但会显示提示；建议使用比赛结束、解冻后的完整导出。

## 3. 其他格式如何转换

若来源暂未直接支持，可先将真实逐次记录转换为统一的 XCPCIO 单文件格式，再在页面中导入。完整最小示例位于 [examples/contest-replay.json](examples/contest-replay.json)。

转换需要保留：

- 比赛开始、结束、罚时和题目 ID / 题号。
- 队伍 ID、名称及正式/打星标志。
- 每次提交的唯一 ID、队伍 ID、题目 ID、相对开赛时间和结果。

提交、题目和队伍 ID 必须能够互相对应。缺失原始时间的最终汇总不能通过改字段名变成真实重放数据。适配器统一放在 `contest_formats.py`，新增格式只需增加转换器和识别规则，无需改动存储和榜单页面。

## 4. 保存和保护

- 导入后的数据按内容生成稳定路径；同一份数据重复导入会复用已有副本。
- 不会覆盖当前或历史比赛已引用的另一份数据。
- 下载和导入均先校验，再安装完整数据目录；替换尚未被引用的旧目录时，在 `data/contest-backups/` 保留旧副本。
- 导入仅允许主机操作。队友仍可按已开放的权限查看榜单、Home、Analysis 和提交代码。
- 请保留原始导入文件，便于以后核对来源或升级适配规则。

## 5. 试用示例

仓库附带一份虚构的 [比赛示例](examples/contest-replay.json)，包含一道题、一支历史队伍和两次提交。选中该文件后点击 **检查数据**，核对预览再点击 **导入并选择**。

## 6. 格式参考

- [XCPCIO 数据格式](https://xcpcio.com/zh/guide/data-format)
- [XCPCIO 官方类型定义](https://github.com/xcpcio/xcpcio/tree/main/packages/libs/types/src)
- [Standard Ranklist / SRK 规范](https://github.com/algoux/standard-ranklist/blob/master/specs/ranklist.md)
- [CCPC 长春站原始榜单](https://rank.iccpc.cn/r/8a3a28e3-f6b3-4a58-b4ac-fa8039fb2c72)
- [ICPC Contest API 与 Event Feed](https://ccs-specs.icpc.io/2023-06/contest_api)
