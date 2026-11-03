"""Local replay adapters. No network calls and no invented submissions."""
from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import io
import json
import math
import re
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath

MAX_UPLOAD = 32 * 1024 * 1024
MAX_EXPANDED = 80 * 1024 * 1024
FORMATS = {"xcpcio": "XCPCIO", "srk": "RankLand / SRK", "iccpc": "CCPC 官方外榜", "domjudge": "DOMjudge / ICPC Event Feed"}
UNITS = {"second": 1, "s": 1, "millisecond": .001, "ms": .001,
         "microsecond": .000001, "nanosecond": .000000001, "min": 60, "h": 3600, "d": 86400}
STATUS = {
    **dict.fromkeys(("AC", "ACCEPTED", "CORRECT", "FB", "YES"), "CORRECT"),
    **dict.fromkeys(("WA", "WRONG_ANSWER", "INCORRECT", "REJECTED", "RJ", "RE", "NO",
                    "PE", "PRESENTATION_ERROR", "TLE", "TIME_LIMIT", "TIME_LIMIT_EXCEEDED",
                    "MLE", "MEMORY_LIMIT", "MEMORY_LIMIT_EXCEEDED", "OLE", "OUTPUT_LIMIT_EXCEEDED",
                    "RTE", "RE", "RUNTIME_ERROR", "RUN_TIME_ERROR", "IDLE", "IDLENESS_LIMIT_EXCEEDED",
                    "NOUT", "NO_OUTPUT", "HACKED"), "INCORRECT"),
    **dict.fromkeys(("CE", "COMPILE_ERROR", "COMPILATION_ERROR"), "COMPILATION_ERROR"),
    **dict.fromkeys(("?", "PENDING", "WAITING", "PREPARING", "COMPILING", "RUNNING", "JUDGING",
                    "SUBMITTED", "FROZEN"), "PENDING"),
    **dict.fromkeys(("IGNORED", "SKIPPED", "CANCELED", "CANCELLED", "SYSTEM_ERROR", "UKE",
                    "JUDGEMENT_FAILED", "CONFIGURATION_ERROR", "FILE_ERROR", "TOO_LATE"), "IGNORED"),
}


def text(value):
    if isinstance(value, dict):
        translations = value.get("texts") or value
        return str(translations.get("zh-CN") or value.get("fallback") or translations.get("en")
                   or translations.get("en-US") or next((v for v in translations.values() if isinstance(v, str)), ""))
    return str(value) if value is not None else ""


def number(value, field):
    if isinstance(value, bool):
        raise ValueError(f"{field} 必须是有效数字")
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} 必须是有效数字") from None
    if not math.isfinite(result):
        raise ValueError(f"{field} 必须是有效数字")
    return result


def identifier(value, field):
    if value is None or isinstance(value, (bool, dict, list)) or not str(value).strip():
        raise ValueError(f"{field} 缺少有效 ID")
    return str(value)


def epoch_seconds(value, field):
    if isinstance(value, str) and not re.fullmatch(r"\d+(?:\.\d+)?", value):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError()
            return parsed.timestamp()
        except (TypeError, ValueError, OverflowError):
            raise ValueError(f"{field} 必须是时间戳或带时区的 ISO 时间") from None
    numeric = number(value, field)
    return numeric / 1000 if numeric > 10**11 else numeric


def seconds(value, field):
    if isinstance(value, list) and len(value) == 2 and value[1] in UNITS:
        return number(value[0], field) * UNITS[value[1]]
    if isinstance(value, str):
        match = re.fullmatch(r"(-?)(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)", value)
        if match:
            return (-1 if match[1] else 1) * (int(match[2]) * 3600 + int(match[3]) * 60 + float(match[4]))
    raise ValueError(f"{field} 时间格式无效")


def records(value, field):
    if isinstance(value, list):
        result = [(str(i), v) for i, v in enumerate(value)]
    elif isinstance(value, dict):
        result = list(value.items())
    else:
        raise ValueError(f"{field} 必须是数组或按 ID 索引的对象")
    if any(not isinstance(item, dict) for _, item in result):
        raise ValueError(f"{field} 中存在非对象记录")
    return result


def verdict(value, field):
    key = str(value or "").strip().upper().replace(" ", "_").replace("-", "_")
    if key not in STATUS:
        raise ValueError(f"{field} 不支持的判题结果：{key or '空值'}")
    return STATUS[key]


def normalize_xcpcio(raw, allow_empty_teams=False):
    if not isinstance(raw, dict) or not isinstance(raw.get("config"), dict):
        raise ValueError("XCPCIO 数据缺少 config.json")
    if "run" not in raw:
        raise ValueError("缺少逐次提交 run.json；只有最终榜单不能用于重放")
    config = copy.deepcopy(raw["config"])
    start = epoch_seconds(config.get("start_time"), "start_time")
    end = epoch_seconds(config.get("end_time"), "end_time")
    if not 0 < end - start <= 7 * 86400:
        raise ValueError("比赛时长必须在 0 至 7 天之间")
    config.update(contest_name=text(config.get("contest_name")), start_time=start, end_time=end)
    if not config["contest_name"].strip():
        raise ValueError("缺少比赛名称 contest_name")
    options = config.get("options") or {}
    if not isinstance(options, dict):
        raise ValueError("config.options 必须是对象")
    if options.get("calculation_of_penalty", "in_minutes") not in ("in_minutes", "in_seconds", "accumulate_in_seconds_and_finally_to_the_minute"):
        raise ValueError("不支持这份数据的罚时计算规则")
    for key in ("penalty_precision_seconds", "ranking_penalty_precision_seconds"):
        if key in options and number(options[key], key) not in (0, .001, 1, 60):
            raise ValueError("不支持这份数据的罚时精度")
    unit = options.get("submission_timestamp_unit", "second")
    if not isinstance(unit, str) or unit not in UNITS:
        raise ValueError(f"不支持的提交时间单位：{unit}")
    config["options"] = {**options, "submission_timestamp_unit": "second"}
    config["penalty"] = number(config.get("penalty", 1200), "penalty")
    if config["penalty"] < 0:
        raise ValueError("罚时时间不能为负数")
    freeze = config.get("frozen_time")
    if freeze is None and config.get("freeze_time") is not None:
        freeze = end - epoch_seconds(config["freeze_time"], "freeze_time")
    config["frozen_time"] = number(freeze or 0, "frozen_time")
    if not 0 <= config["frozen_time"] <= end - start:
        raise ValueError("封榜时长超出比赛范围")
    runs = records(raw["run"], "run")
    problems = config.get("problems")
    if not problems and isinstance(config.get("problem_id"), list):
        legacy = config["problem_id"]
        labels = [str(p) for p in legacy]
        indices = [str(i) for i in range(len(legacy))]
        used = {str(r.get("problem_id")) for _, r in runs}
        if used and used <= set(indices) and used <= set(labels) and labels != indices:
            raise ValueError("旧版 problem_id 的编号与数组下标存在歧义，请用 problems 显式填写 id / label")
        ids = indices if used <= set(indices) and not used <= set(labels) else labels
        colors = config.get("balloon_color") or []
        if not isinstance(colors, list):
            raise ValueError("旧版 balloon_color 必须是数组")
        problems = [{"id": ids[i], "label": labels[i], "balloon_color": colors[i] if i < len(colors) else {}} for i in range(len(legacy))]
    if not isinstance(problems, list) or not problems:
        raise ValueError("比赛缺少题目列表 problems / problem_id")
    config["problems"] = []
    problem_ids, labels = set(), set()
    for i, problem in enumerate(problems):
        if not isinstance(problem, dict):
            raise ValueError("problems 中存在非对象记录")
        pid = identifier(problem.get("id", i), f"problems[{i}]")
        label = str(problem.get("label") or chr(65 + i))
        if pid in problem_ids or label in labels:
            raise ValueError("题目 ID 或题号重复")
        problem_ids.add(pid)
        labels.add(label)
        config["problems"].append({**problem, "id": pid, "label": label})
    teams, team_ids = [], set()
    for key, team in records(raw.get("team"), "team"):
        tid = identifier(team.get("id", team.get("team_id", key)), "team")
        if tid == "__vp_team__":
            raise ValueError("队伍 ID __vp_team__ 为本队保留，请修改源队伍 ID 及对应提交引用")
        if tid in team_ids:
            raise ValueError(f"队伍 ID 重复：{tid}")
        team_ids.add(tid)
        groups = team.get("group") or []
        if not isinstance(groups, list) or any(not isinstance(g, str) for g in groups):
            raise ValueError(f"队伍 {tid} 的 group 必须是字符串数组")
        groups = list(dict.fromkeys(groups))
        if team.get("official") is False or team.get("unofficial") is True:
            groups = [g for g in groups if g != "official"] + ["unofficial"]
        elif team.get("official") is True and "official" not in groups:
            groups.append("official")
        teams.append({**team, "id": tid, "name": text(team.get("name", team.get("team_name"))) or tid,
                      "organization": text(team.get("organization")), "group": groups})
    if not teams and not allow_empty_teams:
        raise ValueError("比赛没有队伍记录")
    normalized_runs, run_ids, jury_records = [], set(), 0
    for key, run in runs:
        rid = identifier(run.get("id", run.get("submission_id", key)), "run")
        if rid in run_ids:
            raise ValueError(f"提交 ID 重复：{rid}")
        run_ids.add(rid)
        tid = identifier(run.get("team_id"), f"提交 {rid} team_id")
        pid = identifier(run.get("problem_id"), f"提交 {rid} problem_id")
        # Some official XCPCIO exports include submissions from the judge
        # account (e.g. Hangzhou 2024), which is absent from the team roster.
        if tid not in team_ids and tid.lower() in ("domjudge", "admin", "jury", "system"):
            jury_records += 1
            continue
        if tid not in team_ids or pid not in problem_ids:
            raise ValueError(f"提交 {rid} 引用了不存在的队伍或题目：{tid} / {pid}")
        normalized_runs.append({**run, "id": rid, "team_id": tid, "problem_id": pid,
                                "timestamp": number(run.get("timestamp"), f"提交 {rid} timestamp") * UNITS[unit],
                                "status": "IGNORED" if run.get("is_ignore") is True else verdict(run.get("status"), f"提交 {rid}")})
    if jury_records:
        config["replay_warnings"] = [f"忽略 {jury_records} 条不属于参赛队伍的裁判账号提交。"]
    result = {"config": config, "team": teams, "run": normalized_runs}
    organizations = raw.get("organizations")
    if organizations is None and isinstance(config.get("organizations"), list):
        organizations = config["organizations"]
    if organizations is not None:
        result["organizations"] = [{**o, "id": identifier(o.get("id", o.get("organization_id", k)), "organizations"),
                                     "name": text(o.get("name"))} for k, o in records(organizations, "organizations")]
    return result


def convert_srk(raw):
    contest = raw.get("contest")
    if not isinstance(contest, dict) or not isinstance(raw.get("problems"), list):
        raise ValueError("SRK 缺少 contest / problems")
    sorter = raw.get("sorter") or {}
    if sorter.get("algorithm", "ICPC") not in ("ICPC", "CCPC26"):
        raise ValueError("目前只支持 ICPC / CCPC 的逐次提交，不支持 OI 分数榜")
    start = epoch_seconds(contest.get("startAt"), "contest.startAt")
    duration = seconds(contest.get("duration"), "contest.duration")
    rule = sorter.get("config") or {}
    precision = rule.get("timePrecision")
    ranking_precision = rule.get("rankingTimePrecision")
    if precision not in (None, "s", "ms", "min") or ranking_precision not in (None, "s", "ms", "min") or precision and rule.get("timeRounding", "floor") != "floor":
        raise ValueError("暂不支持此 SRK 的时间取整规则，请转换为 XCPCIO 后导入")
    calculation = "in_minutes" if precision == "min" else "accumulate_in_seconds_and_finally_to_the_minute" if ranking_precision == "min" else "in_seconds"
    no_penalty = set(rule.get("noPenaltyResults", ["FB", "AC", "?", "NOUT", "CE", "UKE", None]))
    config = {"contest_name": text(contest.get("title")), "start_time": start, "end_time": start + duration,
              "frozen_time": seconds(contest["frozenDuration"], "frozenDuration") if contest.get("frozenDuration") else 0,
              "penalty": seconds(rule.get("penalty", [20, "min"]), "penalty"), "problems": [],
              "group": {"official": "正式队伍", "unofficial": "打星队伍"},
              "options": {"calculation_of_penalty": calculation, "penalty_precision_seconds": UNITS[precision] if precision else 0,
                          "ranking_penalty_precision_seconds": UNITS[ranking_precision] if ranking_precision else 0}}
    for series in raw.get("series") or []:
        rule_definition = series.get("rule") or {}
        segments = series.get("segments") or []
        counts = (rule_definition.get("options") or {}).get("count") or {}
        values = counts.get("value")
        if (rule_definition.get("preset") == "ICPC" and isinstance(values, list) and len(values) == 3
                and [segment.get("style") for segment in segments] == ["gold", "silver", "bronze"]):
            quotas = [number(value, "series.count.value") for value in values]
            if any(value < 0 or not value.is_integer() for value in quotas):
                raise ValueError("SRK 奖牌名额必须是非负整数")
            medal = {"official": dict(zip(("gold", "silver", "bronze"), map(int, quotas)))}
            if "medal" in config and config["medal"] != medal:
                raise ValueError("SRK 包含多套不同的奖牌名额，请先选择需要导入的赛事组")
            config["medal"] = medal
    for i, problem in enumerate(raw["problems"]):
        if not isinstance(problem, dict):
            raise ValueError("SRK 题目记录格式无效")
        style = problem.get("style") or {}
        background = style.get("backgroundColor", "") if isinstance(style, dict) else ""
        if isinstance(background, dict):
            background = background.get("light", "")
        config["problems"].append({"id": str(i), "label": str(problem.get("alias") or chr(65 + i)),
                                    "balloon_color": {"background_color": background}})
    teams, runs = [], []
    rows = raw.get("rows")
    if not isinstance(rows, list):
        raise ValueError("SRK rows 必须是数组")
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or not isinstance(row.get("user"), dict):
            raise ValueError(f"SRK rows[{index}] 缺少 user")
        user, statuses = row["user"], row.get("statuses")
        tid = identifier(user.get("id"), f"rows[{index}].user")
        teams.append({"id": tid, "name": text(user.get("name")) or tid, "organization": text(user.get("organization")),
                      "official": user.get("official", True)})
        if not isinstance(statuses, list) or len(statuses) != len(config["problems"]):
            raise ValueError(f"队伍 {tid} 的逐题状态与题目列表不匹配")
        solved, penalty_components = 0, []
        for p, cell in enumerate(statuses):
            if not isinstance(cell, dict):
                raise ValueError(f"队伍 {tid} 的题目状态格式无效")
            summary, solutions = cell.get("result"), cell.get("solutions") or []
            if not isinstance(solutions, list):
                raise ValueError(f"队伍 {tid} 的 solutions 必须是数组")
            if (summary is not None or cell.get("tries") or cell.get("time")) and not solutions:
                raise ValueError(f"队伍 {tid} · {config['problems'][p]['label']} 只有最终汇总，缺少逐次提交 solutions，不能重放")
            if solutions and summary is None:
                raise ValueError(f"队伍 {tid} 的最终空状态与提交明细不一致")
            accepted, effective, accepted_time = False, 0, None
            ordered = sorted(solutions, key=lambda s: seconds(s.get("time"), "solution.time") if isinstance(s, dict) else float("inf"))
            for j, solution in enumerate(ordered):
                if not isinstance(solution, dict):
                    raise ValueError("SRK solution 必须是对象")
                status = verdict(solution.get("result"), "solution.result")
                when = seconds(solution.get("time"), "solution.time")
                if not accepted and (solution.get("result") not in no_penalty or status == "CORRECT"):
                    effective += 1
                if status == "CORRECT" and not accepted:
                    accepted, accepted_time = True, when
                if solution.get("result") in no_penalty and status == "INCORRECT":
                    status = "COMPILATION_ERROR"
                runs.append({"id": f"{index}:{p}:{j}", "team_id": tid, "problem_id": str(p), "timestamp": when, "status": status})
            if accepted != (summary in ("AC", "FB")):
                raise ValueError(f"队伍 {tid} 的逐次结果与最终状态不一致，可能有未提供的重判记录")
            if solutions and cell.get("tries") is not None and number(cell["tries"], "tries") != effective:
                raise ValueError(f"队伍 {tid} 的逐次提交数量与 tries 不一致，明细可能不完整")
            if accepted and cell.get("time") is not None:
                summary_time = seconds(cell["time"], "status.time")
                granularity = UNITS[cell["time"][1]] if number(cell["time"][0], "status.time").is_integer() else .001
                matches = abs(summary_time-accepted_time) <= .001
                if not matches and granularity >= 1:
                    matches = summary_time <= accepted_time < summary_time+granularity
                if not matches:
                    raise ValueError(f"队伍 {tid} 的通过时间与逐次明细不一致")
            solved += accepted
            if accepted:
                component = accepted_time + (effective - 1) * config["penalty"]
                if precision:
                    component = math.floor(component / UNITS[precision] + 1e-9) * UNITS[precision]
                penalty_components.append(component)
        if isinstance(row.get("score"), dict) and row["score"].get("value") is not None and number(row["score"]["value"], "score.value") != solved:
            raise ValueError(f"队伍 {tid} 的总题数与逐次明细不一致")
        if isinstance(row.get("score"), dict) and row["score"].get("time") is not None:
            expected = sum(penalty_components)
            declared = seconds(row["score"]["time"], "score.time")
            # Some exports only retain the displayed total in whole minutes.
            granularity = UNITS[row["score"]["time"][1]] if number(row["score"]["time"][0], "score.time").is_integer() else .001
            if abs(expected-declared) > .001 and not declared <= expected < declared+granularity:
                raise ValueError(f"队伍 {tid} 的总罚时与逐次明细不一致，可能包含未提供的判罚调整")
    return normalize_xcpcio({"config": config, "team": teams, "run": runs})


def iccpc_epoch(value, context, field):
    """Use the export's declared wall-clock zone, never the host OS zone."""
    try:
        return epoch_seconds(value, field)
    except ValueError:
        pass
    try:
        parsed = datetime.fromisoformat(value)
    except (ValueError, TypeError):
        raise ValueError(f"{field} 不是有效时间") from None
    zone_name = context.get("wall_clock_timezone")
    if parsed.tzinfo is not None or context.get("encoding") != "naive_app_wall" or not zone_name:
        raise ValueError(f"{field} 缺少带时区时间或 time_context.wall_clock_timezone")
    # Windows need not install tzdata for modern Chinese contest exports.
    if zone_name == "Asia/Shanghai" and parsed.year >= 1992:
        zone = timezone(timedelta(hours=8))
    elif zone_name in ("UTC", "Etc/UTC", "Etc/GMT"):
        zone = timezone.utc
    else:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            zone = ZoneInfo(zone_name)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError(f"无法读取导出时区 {zone_name}，请将源时间转换为带 UTC 偏移的 ISO 时间") from None
    aware = parsed.replace(tzinfo=zone)
    if (aware.utcoffset() != parsed.replace(tzinfo=zone, fold=1).utcoffset()
            or datetime.fromtimestamp(aware.timestamp(), zone).replace(tzinfo=None) != parsed):
        raise ValueError(f"{field} 位于夏令时歧义或跳过时段，请使用带 UTC 偏移的 ISO 时间")
    return aware.timestamp()


def convert_iccpc(raw):
    """rank.iccpc.cn's public CSGOJ snapshot, with actual solution records."""
    contest, context = raw.get("contest"), raw.get("time_context") or {}
    if not isinstance(contest, dict) or not isinstance(context, dict):
        raise ValueError("CCPC 外榜缺少有效的 contest / time_context")
    if "solution" not in raw:
        raise ValueError("CCPC 外榜缺少逐次提交 solution；只有最终榜单不能重放")
    groups = raw.get("contest_group") or []
    if len(groups) > 1 or number(raw.get("is_multi_group", 0), "is_multi_group") != 0:
        raise ValueError("暂不支持多赛事组的 CCPC 外榜，请分别导出一场比赛")
    start = iccpc_epoch(contest.get("start_time"), context, "contest.start_time")
    end = iccpc_epoch(contest.get("end_time"), context, "contest.end_time")
    cid = identifier(contest.get("contest_id"), "contest.contest_id")
    config = {"contest_name": text(contest.get("title")), "start_time": start, "end_time": end,
              "frozen_time": number(contest.get("frozen_minute", 0), "frozen_minute") * 60,
              "penalty": 1200, "problems": [], "group": {"official": "正式队伍", "unofficial": "打星队伍"},
              "options": {"calculation_of_penalty": "accumulate_in_seconds_and_finally_to_the_minute",
                          "penalty_precision_seconds": 1, "ranking_penalty_precision_seconds": 60}}
    seen_ordinals = set()
    for _, problem in sorted(records(raw.get("problem"), "problem"), key=lambda p: number(p[1].get("num"), "problem.num")):
        ordinal = number(problem.get("num"), "problem.num")
        if ordinal < 0 or not ordinal.is_integer() or ordinal in seen_ordinals:
            raise ValueError("CCPC 外榜题目 num 必须是不同的非负整数")
        seen_ordinals.add(ordinal)
        label, position = "", int(ordinal) + 1
        while position:
            position, digit = divmod(position - 1, 26)
            label = chr(65 + digit) + label
        config["problems"].append({"id": identifier(problem.get("problem_id"), "problem.problem_id"),
                                    "label": label, "name": text(problem.get("title")),
                                    "balloon_color": {"background_color": text(problem.get("color"))}})

    def team_id(value):
        result = identifier(value, "team_id")
        prefix = f"#cpc{cid}_"
        return result[len(prefix):] if result.startswith(prefix) else result

    teams, runs, excluded, all_teams = [], [], set(), set()
    for _, team in records(raw.get("team"), "team"):
        tid = team_id(team.get("team_id"))
        if tid in all_teams:
            raise ValueError(f"队伍 ID 重复：{tid}")
        all_teams.add(tid)
        if str(team.get("privilege") or "").strip() or not text(team.get("name")).strip():
            excluded.add(tid)
            continue
        kind = number(team.get("tkind", 0), "team.tkind")
        if kind not in (0, 1, 2):
            raise ValueError(f"不支持的 CCPC 队伍类别：{kind}")
        teams.append({"id": tid, "name": text(team.get("name")), "organization": text(team.get("school")),
                      "official": kind != 2})
    results = {**dict.fromkeys(range(4), "PENDING"), 4: "CORRECT", 5: "INCORRECT", 6: "INCORRECT",
               7: "INCORRECT", 8: "INCORRECT", 9: "INCORRECT", 10: "INCORRECT", 11: "COMPILATION_ERROR"}
    submission_totals, accepted_totals = {}, {}
    for _, solution in records(raw["solution"], "solution"):
        if solution.get("contest_id") is not None and str(solution["contest_id"]) != cid:
            raise ValueError("CCPC 外榜混入了其他比赛的提交")
        tid = team_id(solution.get("team_id"))
        pid = identifier(solution.get("problem_id"), "solution.problem_id")
        result = number(solution.get("result"), "solution.result")
        if not result.is_integer() or result >= 0 and result not in results:
            raise ValueError(f"不支持的 CCPC 判题码：{result}")
        submission_totals[pid] = submission_totals.get(pid, 0) + 1
        if result == 4:
            accepted_totals[pid] = accepted_totals.get(pid, 0) + 1
        if tid in excluded:
            continue
        runs.append({"id": identifier(solution.get("solution_id"), "solution.solution_id"), "team_id": tid,
                     "problem_id": pid,
                     "timestamp": iccpc_epoch(solution.get("in_date"), context, "solution.in_date") - start,
                     "status": "PENDING" if result < 0 else results[result]})
    for _, problem in records(raw.get("problem"), "problem"):
        pid = str(problem["problem_id"])
        for field, totals in (("submit", submission_totals), ("accepted", accepted_totals)):
            if problem.get(field) is not None and number(problem[field], f"problem.{field}") != totals.get(pid, 0):
                raise ValueError(f"题目 {pid} 的 {field} 汇总与逐次提交数量不一致，明细可能不完整或不是同一版数据")
    if excluded:
        config["replay_warnings"] = [f"忽略 {len(excluded)} 个非参赛账号及其提交。"]
    # Official snapshot: per-medal counts or cumulative percentage boundaries.
    group = groups[0] if groups else {}
    packed = contest.get("award_ratio")
    if packed is not None or all(f"award_ratio_{key}" in group for key in ("gold", "silver", "bronze")):
        packed = number(packed if packed is not None else 30020010, "award_ratio")
        if packed < 0 or not packed.is_integer():
            raise ValueError("CCPC 奖牌配置必须是非负整数")
        if packed == 0:
            packed = 30020010  # The official renderer's default percentage tuple.
        components = [number(group.get(f"award_ratio_{key}", int(packed) // (1000 ** i) % 1000), f"award_ratio_{key}")
                      for i, key in enumerate(("gold", "silver", "bronze"))]
        if any(value < 0 or not value.is_integer() for value in components):
            raise ValueError("CCPC 奖牌分量必须是非负整数")
        base_mode = number(contest.get("flg_award_base", 0), "flg_award_base")
        quantity = number(group.get("flg_award_qty_mode", contest.get("flg_award_qty_mode", 0)), "flg_award_qty_mode")
        if base_mode not in (0, 1, 2) or quantity not in (0, 1):
            raise ValueError("不支持的 CCPC 奖牌基数或名额模式")
        active = {r["team_id"] for r in runs if 0 <= r["timestamp"] < end - start
                  and (base_mode == 1 or r["status"] == "CORRECT")}
        base = sum(t["official"] and (base_mode == 2 or t["id"] in active) for t in teams)
        cutoffs, previous, cumulative = [], 0, 0
        for component in components:
            if quantity:
                limit = min(base, previous + int(component))
            else:
                # Ratio components are percentages per tier, rounded cumulatively.
                cumulative += min(100, int(component))
                limit = min(base, (base * cumulative + 99) // 100)
            cutoffs.append(limit - previous)
            previous = limit
        config["medal"] = {"official": dict(zip(("gold", "silver", "bronze"), cutoffs))}
    return normalize_xcpcio({"config": config, "team": teams, "run": runs})


def convert_domjudge(events):
    tables = {name: {} for name in ("teams", "problems", "organizations", "groups", "submissions", "judgements", "judgement-types")}
    contest, judgement_order, serial = None, {}, 0
    if not isinstance(events, list):
        raise ValueError("Event Feed 必须是事件数组或 NDJSON 文件")
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("Event Feed 存在非对象事件")
        kind, data = event.get("type"), event.get("data")
        if kind in ("contest", "contests"):
            if not isinstance(data, dict):
                raise ValueError("Event Feed 缺少完整比赛配置")
            if contest and contest.get("id") != data.get("id"):
                raise ValueError("一个文件中包含多场比赛，请分别导出")
            contest = data
        elif kind in tables:
            table = tables[kind]
            if isinstance(data, list):
                table.clear()
                items = data
            elif isinstance(data, dict):
                items = [data]
            elif data is None:
                table.pop(str(event.get("id")), None)
                continue
            else:
                raise ValueError(f"Event Feed {kind} 格式无效")
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError(f"Event Feed {kind} 存在非对象记录")
                key = identifier(item.get("id"), kind)
                if event.get("op") == "delete":
                    table.pop(key, None)
                else:
                    table[key] = item
                    if kind == "judgements" and key not in judgement_order:
                        serial += 1
                        judgement_order[key] = serial
    if not contest or not tables["submissions"]:
        raise ValueError("缺少完整比赛配置或逐次 submissions；只有最终榜单不能重放")
    if contest.get("scoreboard_type", "pass-fail") != "pass-fail":
        raise ValueError("只支持 ICPC pass-fail 计分，不支持 OI 分数榜")
    start = epoch_seconds(contest.get("start_time"), "contest.start_time")
    duration = seconds(contest.get("duration"), "contest.duration")
    config = {"contest_name": text(contest.get("formal_name") or contest.get("name")), "start_time": start, "end_time": start + duration,
              "penalty": number(contest.get("penalty_time", 20), "penalty_time") * 60,
              "frozen_time": seconds(contest["scoreboard_freeze_duration"], "scoreboard_freeze_duration") if contest.get("scoreboard_freeze_duration") else 0,
              "problems": [], "group": {"official": "正式队伍", "unofficial": "打星队伍"}}
    problems = sorted(tables["problems"].values(), key=lambda p: number(p.get("ordinal", 0), "ordinal"))
    for p in problems:
        config["problems"].append({"id": p["id"], "label": p.get("label", p["id"]), "balloon_color": {"background_color": p.get("rgb") or p.get("color", "")}})
    teams = []
    for team in tables["teams"].values():
        hidden = team.get("hidden") or any(tables["groups"].get(g, {}).get("hidden") for g in team.get("group_ids", []))
        teams.append({"id": team["id"], "name": team.get("display_name") or team.get("name"),
                      "organization_id": team.get("organization_id"), "official": not bool(hidden)})
    latest = {}
    for key, judgement in tables["judgements"].items():
        sid = str(judgement.get("submission_id"))
        if sid not in tables["submissions"]:
            raise ValueError(f"判题 {key} 引用了缺失的提交 {sid}")
        order = (epoch_seconds(judgement["start_time"], "judgement.start_time") if judgement.get("start_time") else 0, judgement_order[key])
        if judgement.get("valid") is not False and (sid not in latest or order > latest[sid][0]):
            latest[sid] = order, judgement
    runs = []
    for sid, submission in tables["submissions"].items():
        judgement = latest.get(sid, (None, {}))[1]
        result = judgement.get("judgement_type_id")
        info = tables["judgement-types"].get(str(result), {})
        if not result:
            status = "PENDING"
        elif info.get("solved") is True:
            status = "CORRECT"
        elif info.get("penalty") is False:
            status = "COMPILATION_ERROR"
        elif info.get("penalty") is True:
            status = "INCORRECT"
        else:
            status = verdict(result, f"判题 {sid}")
        when = seconds(submission["contest_time"], "submission.contest_time") if submission.get("contest_time") is not None else epoch_seconds(submission.get("time"), "submission.time") - start
        runs.append({"id": sid, "team_id": submission.get("team_id"), "problem_id": submission.get("problem_id"), "timestamp": when, "status": status})
    return normalize_xcpcio({"config": config, "team": teams, "run": runs, "organizations": list(tables["organizations"].values())})


# New formats only need a detector/converter here; storage and replay stay shared.
ADAPTERS = {"xcpcio": normalize_xcpcio, "srk": convert_srk, "iccpc": convert_iccpc, "domjudge": convert_domjudge}


def parse_json(data, label):
    try:
        return json.loads(data.decode("utf-8-sig"), parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
    except (UnicodeError, ValueError, RecursionError):
        raise ValueError(f"{label} 不是有效的 UTF-8 JSON 文件") from None


def unpack_files(files):
    if not isinstance(files, list) or not 1 <= len(files) <= 8:
        raise ValueError("请选择 1 至 8 个比赛数据文件")
    unpacked, total, uploaded = {}, 0, 0

    def add(name, data):
        nonlocal total
        if name.lower() in {key.lower() for key in unpacked}:
            raise ValueError(f"文件名重复，无法确定比赛：{name}")
        total += len(data)
        if total > MAX_EXPANDED:
            raise ValueError("解压后的比赛数据超过 80 MiB")
        unpacked[name] = data

    for file in files:
        if not isinstance(file, dict) or not isinstance(file.get("data"), str):
            raise ValueError("文件上传数据无效")
        name = str(file.get("name", "")).replace("\\", "/").split("/")[-1]
        try:
            data = base64.b64decode(file["data"], validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("文件编码无效") from None
        uploaded += len(data)
        if uploaded > MAX_UPLOAD:
            raise ValueError("上传文件总计不能超过 32 MiB")
        if name.lower().endswith(".zip"):
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    candidates = [i for i in archive.infolist() if not i.is_dir() and not i.filename.startswith("__MACOSX/") and i.filename.lower().endswith((".json", ".jsonl", ".ndjson"))]
                    if not 1 <= len(candidates) <= 8:
                        raise ValueError("ZIP 中应只有一场比赛的数据文件（最多 8 个）")
                    if sum(i.file_size for i in candidates) + total > MAX_EXPANDED:
                        raise ValueError("解压后的比赛数据超过 80 MiB")
                    for item in candidates:
                        path = PurePosixPath(item.filename.replace("\\", "/"))
                        if path.is_absolute() or ".." in path.parts or ":" in item.filename:
                            raise ValueError("ZIP 中存在无效路径")
                        add(path.name, archive.read(item))
            except (zipfile.BadZipFile, RuntimeError, NotImplementedError):
                raise ValueError("无法读取 ZIP；请选择未加密的标准 ZIP 数据包") from None
        elif name.lower().endswith((".json", ".jsonl", ".ndjson")):
            add(name, data)
        else:
            raise ValueError("支持 JSON、JSONL、NDJSON 和 ZIP 文件")
    return unpacked


def prepare_import(body):
    files = unpack_files(body.get("files"))
    names = {name.lower(): name for name in files}
    if {"config.json", "team.json", "run.json"} <= names.keys():
        raw = {key: parse_json(files[names[key + ".json"]], names[key + ".json"]) for key in ("config", "team", "run")}
        org = raw["config"].get("organizations") if isinstance(raw["config"], dict) else None
        org_name = str(org.get("url", "")).replace("\\", "/").split("/")[-1].lower() if isinstance(org, dict) else "organizations.json"
        if org_name in names:
            raw["organizations"] = parse_json(files[names[org_name]], org_name)
        detected = "xcpcio"
    elif len(files) == 1:
        name, data = next(iter(files.items()))
        if name.lower().endswith((".ndjson", ".jsonl")):
            raw = [parse_json(line, f"{name} 第 {i} 行") for i, line in enumerate(data.splitlines(), 1) if line.strip()]
        else:
            raw = parse_json(data, name)
        if isinstance(raw, dict) and isinstance(raw.get("config"), dict):
            detected = "xcpcio"
        elif isinstance(raw, dict) and "contest" in raw and "rows" in raw:
            detected = "srk"
        elif isinstance(raw, dict) and all(key in raw for key in ("contest", "team", "problem")):
            detected = "iccpc"
        elif isinstance(raw, list) and raw and isinstance(raw[0], dict) and "type" in raw[0]:
            detected = "domjudge"
        else:
            raise ValueError("未识别到可重放数据。需要 XCPCIO、带 solutions 的 SRK、带 solution 的 CCPC 外榜或 DOMjudge Event Feed；只有最终榜单不能导入")
    else:
        raise ValueError("XCPCIO 请同时选择 config.json、team.json、run.json；其他格式请选择单个文件")
    requested = body.get("format", "auto")
    if requested not in ("auto", detected):
        raise ValueError("所选格式与文件内容不一致，请使用自动识别")
    try:
        snapshot = ADAPTERS[detected](raw)
    except (TypeError, AttributeError, KeyError, OverflowError, RecursionError) as error:
        raise ValueError(f"比赛数据字段类型不符合 {FORMATS[detected]} 格式") from error
    runs, config = snapshot["run"], snapshot["config"]
    in_range = [r for r in runs if 0 <= r["timestamp"] < config["end_time"] - config["start_time"]]
    if not any(r["status"] != "IGNORED" for r in in_range):
        raise ValueError("没有有效比赛时间内的逐次提交记录，不能作为历史重放数据")
    warnings = list(config.get("replay_warnings") or [])
    if any(r["status"] == "PENDING" for r in in_range):
        warnings.append("存在待判或封榜记录，只能重放已提供的结果；建议导入解冻后的完整数据。")
    if len(in_range) != len(runs):
        warnings.append(f"{len(runs) - len(in_range)} 条提交位于比赛时间范围外，不计入成绩。")
    if config.get("options", {}).get("calculation_of_penalty") == "in_seconds":
        warnings.append("源数据按秒计罚时，榜单以分钟显示；排名使用未舍入的精确罚时。")
    payload = json.dumps(snapshot, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    digest = hashlib.sha256(payload).hexdigest()
    title = config["contest_name"]
    series = "ccpc" if re.search(r"\bccpc\b|中国大学生程序设计竞赛", title, re.I) else "icpc" if re.search(r"\bicpc\b|国际大学生程序设计竞赛", title, re.I) else "imported"
    try:
        year = datetime.fromtimestamp(config["start_time"], timezone(timedelta(hours=8))).year
    except (ValueError, OSError, OverflowError):
        raise ValueError("比赛开始日期超出支持范围") from None
    ordinal = re.search(r"(?:第\s*|\b)(\d+)(?:\s*届|st\b|nd\b|rd\b|th\b)", title, re.I)
    if ordinal and series in ("icpc", "ccpc"):
        year = (1975 if series == "icpc" else 2014) + int(ordinal[1])
    summary = {"name": title, "format": detected, "format_name": FORMATS[detected], "teams": len(snapshot["team"]),
               "problems": len(config["problems"]), "runs": len(runs), "duration_seconds": config["end_time"] - config["start_time"],
               "series": series, "season_year": year, "warnings": warnings, "sha256": digest,
               "path": f"imports/{year}/{detected}-{digest[:20]}"}
    source = {**summary, "kind": "import", "files": list(files), "schema_version": 1}
    return snapshot, source
