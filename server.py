"""Local VP scoreboard server. No third-party packages required."""
from __future__ import annotations

import json
import ipaddress
import re
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlparse

from stable_clock import CLOCK
from contest_formats import MAX_UPLOAD, epoch_seconds, normalize_xcpcio, prepare_import, text as contest_text

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
BASE = "https://board.xcpcio.com/data/"
CATALOG_URL = BASE + "index/contest_list.json"
HOST = "127.0.0.1"
SESSION_FILE = DATA / "session.json"
SUBMISSION_FILE = DATA / "qoj_submissions.json"
CATALOG_FILE = DATA / "catalog_cache.json"
VP_OBSERVATION_FILE = DATA / "qoj_vp_observation.json"
QOJ_INFO_FILE = DATA / "qoj_contest_info.json"
SUBMISSION_SYNC_STATUS_FILE = DATA / "qoj_submission_sync_status.json"
HISTORY_DIR = DATA / "history"
STATE_LOCK = threading.RLock()
CATALOG_LOCK = threading.Lock()
LAN_ENABLED = False
DEBUG_ENABLED = False
DEBUG_ELAPSED = None
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(cidr) for cidr in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"
))


def now_ms():
    return CLOCK.now_ms()


def fetch_json(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": "XCPC-VP-Board/0.1"})
    with urllib.request.urlopen(request, timeout=25) as response:
        if int(response.headers.get("Content-Length", 0)) > 20_000_000:
            raise ValueError("文件过大")
        data = response.read(20_000_001)
    if len(data) > 20_000_000:
        raise ValueError("文件过大")
    return json.loads(data)


def safe_contest_path(value: str) -> str:
    value = value.strip().strip("/")
    if value.startswith(BASE):
        value = value[len(BASE):].strip("/")
    if value.endswith("/config.json"):
        value = value[:-12]
    if not re.fullmatch(r"[A-Za-z0-9_./-]+", value) or ".." in value.split("/"):
        raise ValueError("比赛路径无效")
    return value


def download_contest(path: str):
    path = safe_contest_path(path)
    if not path:
        raise ValueError("请填写 xcpcio 比赛数据路径")
    result = {}
    for name in ("config.json", "team.json", "run.json"):
        result[name[:-5]] = fetch_json(BASE + path + "/" + name)
    organization_setting = result["config"].get("organizations") if isinstance(result["config"], dict) else None
    organization_file = organization_setting.get("url") if isinstance(organization_setting, dict) else None
    organization_url = urljoin(BASE + path + "/", organization_file) if isinstance(organization_file, str) else ""
    organization_location = urlparse(organization_url)
    trusted_organization = organization_location.scheme == "https" and (organization_location.hostname or "").endswith(".xcpcio.com") and not organization_location.username and not organization_location.password and organization_location.path.endswith(".json")
    if trusted_organization:
        try:
            result["organizations"] = fetch_json(organization_url)
        except (urllib.error.URLError, ValueError, json.JSONDecodeError):
            pass
    result = normalize_xcpcio(result)
    if not result["run"]:
        raise ValueError("XCPCIO 没有提供逐次提交记录，暂不能重放这场比赛")
    source = {"kind": "xcpcio", "format": "xcpcio", "source_url": BASE + path + "/config.json", "downloaded_at_ms": now_ms()}
    store_contest(path, result, source)
    return {"path": path, "teams": len(result["team"]), "runs": len(result["run"]), "name": result["config"]["contest_name"]}


def store_contest(path, snapshot, source):
    """Install a fully checked snapshot; keep an older version for recovery."""
    path = safe_contest_path(path)
    target = DATA / "contests" / path
    staging = DATA / ".contest-staging"
    staging.mkdir(parents=True, exist_ok=True)
    with STATE_LOCK, tempfile.TemporaryDirectory(dir=staging) as folder:
        staged = Path(folder) / "snapshot"
        staged.mkdir()
        for key, value in {**snapshot, "source": source}.items():
            (staged / (key + ".json")).write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        if target.exists():
            try:
                existing = load_contest(path)
                if existing == snapshot:
                    return
            except (ValueError, OSError, KeyError):
                pass
            referenced = [session()]
            if HISTORY_DIR.exists():
                for archive in HISTORY_DIR.glob("*.json"):
                    try:
                        referenced.append(read_json(archive, {}).get("session"))
                    except (OSError, ValueError):
                        continue
            if any(value and value.get("path") == path for value in referenced):
                raise ValueError("这份数据已被当前或历史比赛使用，不能覆盖；请作为新的本地数据导入")
            backup = DATA / "contest-backups" / (path.replace("/", "__") + "-" + secrets.token_hex(6))
            backup.parent.mkdir(parents=True, exist_ok=True)
            target.replace(backup)
            try:
                staged.replace(target)
            except OSError:
                backup.replace(target)
                raise
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            staged.replace(target)


def import_contest(body, preview=False):
    snapshot, source = prepare_import(body)
    if body.get("expected_sha256") and body["expected_sha256"] != source["sha256"]:
        raise ValueError("文件内容与预览不一致，请重新检查数据")
    result = {key: value for key, value in source.items() if key not in ("files", "schema_version")}
    if not preview:
        source["imported_at_ms"] = now_ms()
        store_contest(source["path"], snapshot, source)
    return result


def load_contest(path: str):
    with STATE_LOCK:
        folder = DATA / "contests" / safe_contest_path(path)
        result = {name: json.loads((folder / (name + ".json")).read_text(encoding="utf-8")) for name in ("config", "team", "run")}
        if (folder / "organizations.json").exists():
            result["organizations"] = json.loads((folder / "organizations.json").read_text(encoding="utf-8"))
        # Preserve older locally created training boards without an opponent
        # roster; newly imported/downloaded history is checked more strictly.
        result["config"].setdefault("contest_name", path)
        return normalize_xcpcio(result, allow_empty_teams=True)


def list_contests():
    root = DATA / "contests"
    result = []
    if root.exists():
        for config in root.rglob("config.json"):
            path = config.parent.relative_to(root).as_posix()
            if (config.parent / "team.json").exists() and (config.parent / "run.json").exists():
                try:
                    value = json.loads(config.read_text(encoding="utf-8"))
                    metadata = read_json(config.parent / "source.json", {})
                    source = {key: metadata[key] for key in ("kind", "format", "format_name", "series", "season_year", "source_url") if key in metadata}
                    result.append({"path": path, "name": value.get("contest_name", path), **source})
                except (OSError, ValueError, TypeError):
                    continue
    return sorted(result, key=lambda item: item["path"], reverse=True)


def contest_season_year(series, season, start_ms=0):
    season_text = str(season or "")
    ordinal = re.fullmatch(r"(\d+)(?:st|nd|rd|th)", season_text, re.IGNORECASE)
    if ordinal and series == "icpc":
        return 1975 + int(ordinal.group(1))
    if ordinal and series == "ccpc":
        return 2014 + int(ordinal.group(1))
    if re.fullmatch(r"20\d{2}", season_text):
        return int(season_text)
    return time.gmtime(start_ms / 1000).tm_year if start_ms else None


def catalog_entries(index):
    """Find contest leaves even when a site adds another directory level."""
    entries = []
    pending = [((), index)]
    while pending:
        parts, item = pending.pop()
        if not isinstance(item, dict):
            continue
        for name, child in item.items():
            if name in ("config", "board_link") or not isinstance(child, dict):
                continue
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name in (".", "..") or name.endswith("-assets"):
                continue
            pending.append((parts + (name,), child))
        config = item.get("config")
        if len(parts) < 3 or not isinstance(config, dict):
            continue
        try:
            path = safe_contest_path("/".join(parts))
            start_ms = round(epoch_seconds(config.get("start_time"), "start_time") * 1000)
            if start_ms <= 0:
                continue
            year = time.gmtime(start_ms / 1000).tm_year
        except (ValueError, TypeError, OSError, OverflowError):
            continue
        series, season = parts[:2]
        name = contest_text(config.get("contest_name")) or parts[-1]
        browse_series = "invitational" if ("邀请" in name or "invitational" in path.lower()) else series
        entries.append({
            "path": path, "name": name, "series": series, "browse_series": browse_series,
            "season": season, "year": year,
            "season_year": contest_season_year(series, season, start_ms),
            "start_at_ms": start_ms,
            "board_url": "https://board.xcpcio.com/" + path,
        })
    return sorted(entries, key=lambda entry: (entry["start_at_ms"], entry["path"]), reverse=True)


def contest_catalog(force=False):
    """Read XCPCIO's generated contest index, with a saved offline fallback."""
    with CATALOG_LOCK:
        cached = None
        now = round(now_ms() / 1000)
        # A generated cache may be truncated or contain Git conflict markers.
        # Discard only the cache; a failed parse must not prevent a fresh read.
        try:
            value = read_json(CATALOG_FILE, None)
            if isinstance(value, dict) and isinstance(value.get("contests"), list):
                cleaned = []
                for entry in value["contests"]:
                    if not isinstance(entry, dict):
                        raise ValueError("赛事目录缓存格式无效")
                    start_ms = int(entry.get("start_at_ms") or 0)
                    path = safe_contest_path(entry.get("path", ""))
                    if not path or start_ms <= 0 or path.endswith("-assets"):
                        continue
                    cleaned.append({**entry, "path": path, "start_at_ms": start_ms,
                                    "season_year": contest_season_year(entry.get("series"), entry.get("season"), start_ms)})
                if cleaned:
                    cached = {**value, "updated_at": int(value.get("updated_at", 0)), "contests": cleaned}
        except (OSError, ValueError, TypeError, AttributeError, OverflowError):
            cached = None
        if cached and cached.get("schema_version") == 6 and not force and 0 <= now - cached.get("updated_at", 0) < 3600:
            return {**cached, "stale": False}
        try:
            index = fetch_json(CATALOG_URL)
            if not isinstance(index, dict):
                raise ValueError("赛事目录源格式无效")
            entries = catalog_entries(index)
            if not entries:
                raise ValueError("赛事目录源没有有效比赛")
            value = {"schema_version": 6, "source": CATALOG_URL, "updated_at": now, "contests": entries}
            write_json(CATALOG_FILE, value)
            return {**value, "stale": False}
        except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError):
            if cached:
                return {**cached, "stale": True}
            raise ValueError("无法读取 xcpcio 比赛目录，请检查网络后重试")


def read_json(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def session():
    return read_json(SESSION_FILE, None)


def contest_duration_ms(path):
    config = read_json(DATA / "contests" / safe_contest_path(path) / "config.json", {})
    return round((epoch_seconds(config["end_time"], "end_time") - epoch_seconds(config["start_time"], "start_time")) * 1000)


def submission_window(active, timestamp=None):
    if not active:
        return {"can_submit": False, "reason": "当前没有比赛"}
    now = now_ms() if timestamp is None else timestamp
    start = int(active.get("clock_start_at_ms") or active["start_at_ms"])
    try:
        duration = contest_duration_ms(active["path"])
    except (ValueError, FileNotFoundError, KeyError):
        return {"can_submit": False, "reason": "比赛数据不可用，请重新下载比赛"}
    if duration <= 0:
        return {"can_submit": False, "reason": "比赛时长无效"}
    end = start + duration
    reason = "比赛尚未开始" if now < start else "比赛已结束，不能再发起提交" if now >= end else ""
    return {"can_submit": not reason, "reason": reason, "start_at_ms": start, "end_at_ms": end}


def require_submission_window(active, timestamp=None):
    window = submission_window(active, timestamp)
    if not window["can_submit"]:
        raise ValueError(window["reason"])
    return window


def _archive_current_locked(current=None):
    current = current or session()
    if not current:
        return None
    now = now_ms()
    if not current.get("session_id"):
        current["session_id"] = f"{int(current.get('created_at_ms') or current.get('start_at_ms') or now)}-{secrets.token_hex(4)}"
        active = session()
        if active and active.get("created_at_ms") == current.get("created_at_ms"):
            write_json(SESSION_FILE, current)
    anchor = int(current.get("clock_start_at_ms") or current["start_at_ms"])
    try:
        duration_ms = contest_duration_ms(current["path"])
    except (ValueError, FileNotFoundError, KeyError):
        duration_ms = 24 * 3600_000
    elapsed = max(0, min(duration_ms, now - anchor))
    value = {
        "session": current,
        "submissions": read_json(SUBMISSION_FILE, []),
        "elapsed_seconds": elapsed / 1000,
        "updated_at_ms": now,
    }
    write_json(HISTORY_DIR / f"{current['session_id']}.json", value)
    return value


def _history_elapsed_seconds(value, timestamp=None):
    archived = value["session"]
    current_time = now_ms() if timestamp is None else int(timestamp)
    anchor = int(archived.get("clock_start_at_ms") or archived["start_at_ms"])
    try:
        duration_ms = contest_duration_ms(archived["path"])
    except (ValueError, FileNotFoundError, KeyError):
        duration_ms = 24 * 3600_000
    return max(0, min(duration_ms, current_time - anchor)) / 1000


def history_list():
    current = session()
    current_id = current.get("session_id") if current else None
    result = []
    if HISTORY_DIR.exists():
        for path in HISTORY_DIR.glob("*.json"):
            try:
                value = read_json(path, {})
                archived = value["session"]
                if path.stem == current_id:
                    continue
                result.append({
                    "id": path.stem,
                    "name": archived.get("name", archived.get("path", path.stem)),
                    "path": archived.get("path", ""),
                    "mode": archived.get("mode", "icpc"),
                    "scenario": archived.get("scenario", "original"),
                    "qoj_contest_id": archived.get("qoj_contest_id", ""),
                    "start_at_ms": archived.get("start_at_ms", 0),
                    "updated_at_ms": value.get("updated_at_ms", 0),
                    "elapsed_seconds": _history_elapsed_seconds(value),
                    "submission_count": len(value.get("submissions", [])),
                    "current": False,
                })
            except (ValueError, KeyError, TypeError, json.JSONDecodeError):
                continue
    return sorted(result, key=lambda item: (item["start_at_ms"], item["updated_at_ms"]), reverse=True)


def history_entry(ident):
    if not re.fullmatch(r"[0-9]{10,16}-[a-f0-9]{8}", str(ident or "")):
        raise ValueError("历史比赛 ID 无效")
    path = HISTORY_DIR / f"{ident}.json"
    if not path.exists():
        raise ValueError("没有找到这场历史比赛")
    value = read_json(path, None)
    value["elapsed_seconds"] = _history_elapsed_seconds(value)
    return value


def archive_current_session():
    global DEBUG_ELAPSED
    with STATE_LOCK:
        current = session()
        if not current:
            raise ValueError("当前没有可归档的比赛")
        value = _archive_current_locked(current)
        SESSION_FILE.unlink(missing_ok=True)
        write_json(SUBMISSION_FILE, [])
        SUBMISSION_SYNC_STATUS_FILE.unlink(missing_ok=True)
        VP_OBSERVATION_FILE.unlink(missing_ok=True)
        DEBUG_ELAPSED = None
    return value


def activate_history(ident):
    global DEBUG_ELAPSED
    with STATE_LOCK:
        if session():
            raise ValueError("请先归档当前比赛，再将历史比赛设为当前比赛")
        entry = history_entry(ident)
        restored = dict(entry["session"])
        write_json(SUBMISSION_FILE, entry.get("submissions", []))
        write_json(SESSION_FILE, restored)
        SUBMISSION_SYNC_STATUS_FILE.unlink(missing_ok=True)
        VP_OBSERVATION_FILE.unlink(missing_ok=True)
        DEBUG_ELAPSED = None
        (HISTORY_DIR / f"{ident}.json").unlink(missing_ok=True)
    return restored


def delete_history(ident):
    with STATE_LOCK:
        entry = history_entry(ident)
        current = session()
        if current and current.get("session_id") == ident:
            raise ValueError("当前比赛不能删除")
        (HISTORY_DIR / f"{ident}.json").unlink()
        submission_details_file(ident).unlink(missing_ok=True)
        return {"deleted": ident, "name": entry.get("session", {}).get("name", "")}


def reveal_history(ident):
    if not re.fullmatch(r"[0-9]{10,16}-[a-f0-9]{8}", str(ident or "")):
        raise ValueError("历史比赛 ID 无效")
    with STATE_LOCK:
        path = HISTORY_DIR / f"{ident}.json"
        if not path.exists():
            raise ValueError("没有找到这场历史比赛")
        entry = read_json(path, None)
        archived = entry["session"]
        duration_ms = contest_duration_ms(archived["path"])
        if _history_elapsed_seconds(entry) * 1000 < duration_ms:
            raise ValueError("比赛结束后才能公布最终榜单")
        if not archived.get("revealed_at_ms"):
            archived["revealed_at_ms"] = now_ms()
            entry["session"] = archived
            entry["elapsed_seconds"] = duration_ms / 1000
            entry["updated_at_ms"] = now_ms()
            write_json(path, entry)
    return archived


def reveal_session():
    with STATE_LOCK:
        current = session()
        if not current:
            raise ValueError("当前没有比赛")
        duration_ms = contest_duration_ms(current["path"])
        anchor = int(current.get("clock_start_at_ms") or current["start_at_ms"])
        elapsed_ms = DEBUG_ELAPSED * 1000 if DEBUG_ENABLED and DEBUG_ELAPSED is not None else now_ms() - anchor
        if elapsed_ms < duration_ms:
            raise ValueError("比赛结束后才能公布最终榜单")
        if not current.get("revealed_at_ms"):
            current["revealed_at_ms"] = now_ms()
            write_json(SESSION_FILE, current)
    return current


def vp_observation():
    value = read_json(VP_OBSERVATION_FILE, None)
    if not value or value.get("observed_at_ms", 0) < now_ms() - 6 * 3600_000:
        return None
    return value


def valid_qoj_contest_name(value):
    name = re.sub(r"\s+", " ", str(value or "")).strip().rstrip("|-· ").strip()
    if not 2 <= len(name) <= 160:
        return None
    if re.fullmatch(r"(?:QOJ(?:\.ac)?|Public Judge|pjudge|Dashboard|Contest|Login)", name, re.IGNORECASE):
        return None
    return name


def qoj_contest_info():
    value = read_json(QOJ_INFO_FILE, None)
    if not value or value.get("observed_at_ms", 0) < now_ms() - 6 * 3600_000:
        return None
    name = valid_qoj_contest_name(value.get("name"))
    if not name:
        return None
    value["name"] = name
    return value


def save_qoj_contest_info(body):
    contest_id = str(body.get("qoj_contest_id", ""))
    name = valid_qoj_contest_name(body.get("name"))
    if not re.fullmatch(r"\d{1,10}", contest_id) or not name:
        raise ValueError("QOJ 比赛名称无效")
    value = {"qoj_contest_id": contest_id, "name": name, "observed_at_ms": now_ms()}
    with STATE_LOCK:
        write_json(QOJ_INFO_FILE, value)
    return value


def save_vp_observation(body):
    contest_id = str(body.get("qoj_contest_id", ""))
    source = body.get("source")
    observed_at = now_ms()
    if not re.fullmatch(r"\d{1,10}", contest_id) or source not in ("finish-confirmed", "countdown", "not-started"):
        raise ValueError("QOJ VP 观察数据无效")
    value = {"qoj_contest_id": contest_id, "source": source, "observed_at_ms": observed_at,
             "handle": str(body.get("handle", ""))[:64]}
    if source == "finish-confirmed":
        try:
            raw_start_at = int(body.get("start_at_ms"))
            client_sent_at = int(body.get("client_sent_at_ms", raw_start_at))
        except (TypeError, ValueError):
            raise ValueError("Finish 时间无效") from None
        client_clock_offset = observed_at - client_sent_at
        start_at = raw_start_at + client_clock_offset
        if not observed_at - 120_000 <= start_at <= observed_at + 10_000:
            raise ValueError("Finish 时间无效")
        value["start_at_ms"] = start_at
        value["browser_clock_offset_ms"] = client_clock_offset
        offset = int(body.get("submission_clock_offset_ms") or 0)
        if not 0 <= offset <= 10 * 60_000:
            raise ValueError("QOJ 提交计时偏移无效")
        value["submission_clock_offset_ms"] = offset
    elif source == "countdown":
        try:
            remaining = float(body.get("remaining_seconds"))
            raw_sampled_at = int(body.get("sampled_at_ms"))
            client_sent_at = int(body.get("client_sent_at_ms", raw_sampled_at))
        except (TypeError, ValueError):
            raise ValueError("QOJ 倒计时数据无效") from None
        if not 0 < remaining <= 24 * 3600:
            raise ValueError("QOJ 剩余时间无效")
        client_clock_offset = observed_at - client_sent_at
        sampled_at = raw_sampled_at + client_clock_offset
        value["remaining_seconds"] = remaining
        if abs(sampled_at - observed_at) > 30_000:
            raise ValueError("QOJ 倒计时采样时间无效")
        value["sampled_at_ms"] = sampled_at
        value["browser_clock_offset_ms"] = client_clock_offset
    with STATE_LOCK:
        previous = vp_observation()
        if previous and previous.get("qoj_contest_id") == contest_id and previous.get("source") == "finish-confirmed" and source == "countdown" and observed_at - previous["observed_at_ms"] < 15 * 60_000:
            return previous
        if source == "countdown":
            current = session()
            if current and current.get("qoj_contest_id") == contest_id and current.get("timing_source", "qoj") == "qoj":
                duration_ms = contest_duration_ms(current["path"])
                clock_start = round(sampled_at - (duration_ms - remaining * 1000))
                value["clock_start_at_ms"] = clock_start
                if abs(clock_start - int(current["start_at_ms"])) <= 120_000:
                    current["clock_start_at_ms"] = clock_start
                    write_json(SESSION_FILE, current)
        write_json(VP_OBSERVATION_FILE, value)
    return value


def qoj_contest_id(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ("qoj.ac", "training.qoj.ac", "pjudge.ac"):
        raise ValueError("QOJ 比赛 URL 无效")
    match = re.fullmatch(r"/contest/(\d+)/?", parsed.path)
    if not match:
        raise ValueError("QOJ 比赛 URL 需要是 /contest/数字")
    return match.group(1)


def start_session(body):
    global DEBUG_ELAPSED
    path = safe_contest_path(str(body.get("path", "")))
    contest = load_contest(path)
    qoj_url = str(body.get("qoj_url", "")).strip()
    contest_id = qoj_contest_id(qoj_url)
    parsed_qoj_url = urlparse(qoj_url)
    qoj_url = f"https://{parsed_qoj_url.hostname}/contest/{contest_id}"
    mode = body.get("mode")
    scenario = body.get("scenario", "original")
    if mode not in ("icpc", "ccpc") or scenario not in ("original", "adjusted"):
        raise ValueError("赛制或历史行为选项无效")
    if mode == "icpc":
        scenario = "original"
    start_at = int(body.get("start_at_ms") or now_ms())
    current_time_ms = now_ms()
    if start_at > current_time_ms + 30 * 24 * 3600_000:
        raise ValueError("VP 开始时间不能晚于未来 30 天")
    raw_language_defaults = body.get("language_defaults") or {}
    if not isinstance(raw_language_defaults, dict):
        raise ValueError("提交语言设置无效")
    language_defaults = {}
    for key in ("c", "cpp", "java", "python3"):
        selected = raw_language_defaults.get(key)
        if selected is not None:
            selected = str(selected).strip()
            if not selected or len(selected) > 100:
                raise ValueError("提交语言设置无效")
            language_defaults[key] = selected
    value = {
        "session_id": f"{current_time_ms}-{secrets.token_hex(4)}",
        "path": path, "name": contest["config"].get("contest_name", path),
        "qoj_url": qoj_url, "qoj_contest_id": contest_id,
        "mode": mode, "scenario": scenario,
        "own_name": str(body.get("own_name") or "我的 VP 队伍")[:80],
        "qoj_submission_clock_offset_ms": max(0, min(10 * 60_000, int(body.get("qoj_submission_clock_offset_ms") or 0))),
        "timing_source": "manual" if body.get("timing_source") == "manual" else "qoj",
        "ignore_previous_submissions": bool(body.get("ignore_previous_submissions")),
        "language_defaults": language_defaults,
        "start_at_ms": start_at, "created_at_ms": current_time_ms,
    }
    value["submission_ignore_before_seconds"] = max(0, (current_time_ms - start_at) / 1000) if value["ignore_previous_submissions"] else 0
    with STATE_LOCK:
        if session():
            raise ValueError("已有当前比赛，请先归档后再启动新比赛")
        write_json(SUBMISSION_FILE, [])
        write_json(SESSION_FILE, value)
        SUBMISSION_SYNC_STATUS_FILE.unlink(missing_ok=True)
        VP_OBSERVATION_FILE.unlink(missing_ok=True)
        DEBUG_ELAPSED = None
    return value


def lan_addresses():
    addresses = set()
    try:
        addresses.update(item[4][0] for item in socket.getaddrinfo(socket.gethostname(), None, family=socket.AF_INET))
    except OSError:
        pass
    # Ubuntu commonly resolves its hostname only to 127.0.1.1. A UDP connect
    # selects the active route without sending application data.
    for target in ("1.1.1.1", "8.8.8.8"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.connect((target, 80))
                addresses.add(probe.getsockname()[0])
            break
        except OSError:
            continue
    # iproute2 is present on ordinary Ubuntu installations and also covers
    # isolated LANs that have no default route to probe.
    try:
        result = subprocess.run(
            ["ip", "-j", "-4", "addr", "show", "up"],
            capture_output=True, text=True, timeout=2, check=False,
        )
        if result.returncode == 0:
            for interface in json.loads(result.stdout or "[]"):
                addresses.update(
                    item.get("local", "") for item in interface.get("addr_info", [])
                    if item.get("family") == "inet"
                )
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        pass
    return sorted(address for address in addresses if private_client(address))


def private_client(address):
    try:
        value = ipaddress.ip_address(str(address).split("%", 1)[0])
    except ValueError:
        return False
    return any(value in network for network in PRIVATE_NETWORKS)


def may_sync_client(address):
    try:
        value = ipaddress.ip_address(str(address).split("%", 1)[0])
    except ValueError:
        return False
    return value.is_loopback or (LAN_ENABLED and private_client(address))


def merge_submissions(rows):
    if not isinstance(rows, list) or len(rows) > 500 or any(not isinstance(row, dict) for row in rows):
        raise ValueError("QOJ 提交批次无效")
    with STATE_LOCK:
        return _merge_submissions_locked(rows)


def sync_submission_batch(body, error=False):
    # Validate and commit against the same session under one lock. A slow QOJ
    # request must not deliver the previous VP's submissions into a new VP.
    with STATE_LOCK:
        active = session()
        if not active or str(body.get("qoj_contest_id")) != str(active["qoj_contest_id"]):
            raise ValueError("QOJ 比赛 ID 与当前 VP 不一致")
        if body.get("session_id") != active.get("session_id"):
            raise ValueError("比赛已切换，请重新加载 QOJ 页面及扩展后同步")
        if error:
            return record_submission_sync_error(body.get("error"), active["qoj_contest_id"])
        rows = body.get("rows")
        if not isinstance(rows, list) or len(rows) > 500 or any(not isinstance(row, dict) for row in rows):
            raise ValueError("QOJ 提交批次无效")
        result = _merge_submissions_locked(rows)
        record_submission_sync(result, active["qoj_contest_id"])
        return result


def record_submission_sync(result, contest_id):
    active = session() or {}
    value = {
        "session_id": active.get("session_id"),
        "qoj_contest_id": str(contest_id),
        "observed_at_ms": now_ms(),
        "count": int(result.get("count", 0)),
        "changed": int(result.get("changed", 0)),
    }
    write_json(SUBMISSION_SYNC_STATUS_FILE, value)
    return value


def record_submission_sync_error(error, contest_id):
    active = session() or {}
    previous = submission_sync_status() or {}
    message = str(error or "未知同步错误").strip()[:240]
    value = {
        "session_id": active.get("session_id"),
        "qoj_contest_id": str(contest_id),
        "observed_at_ms": now_ms(),
        "count": int(previous.get("count", len(read_json(SUBMISSION_FILE, [])))),
        "changed": 0,
        "error": message,
    }
    write_json(SUBMISSION_SYNC_STATUS_FILE, value)
    return value


def submission_sync_status():
    value = read_json(SUBMISSION_SYNC_STATUS_FILE, None)
    active = session() or {}
    if not value or value.get("session_id") != active.get("session_id"):
        return None
    return value


def submission_details_file(session_id):
    if not re.fullmatch(r"[0-9]{10,16}-[a-f0-9]{8}", str(session_id or "")):
        raise ValueError("比赛会话无效")
    return DATA / "submission_details" / f"{session_id}.json"


def submission_records(session_id):
    active = session()
    if active and active.get("session_id") == session_id:
        return read_json(SUBMISSION_FILE, []), None
    entry = history_entry(session_id)
    return entry.get("submissions", []), entry


def save_submission_records(session_id, rows, archive=None):
    if archive is None:
        write_json(SUBMISSION_FILE, rows)
    else:
        archive["submissions"] = rows
        archive["updated_at_ms"] = now_ms()
        write_json(HISTORY_DIR / f"{session_id}.json", archive)


def expire_submission_attempts(session_id, rows, archive=None, now=None):
    """Release abandoned send attempts without guessing what QOJ received."""
    now = now_ms() if now is None else now
    changed = False
    for row in rows:
        if not row.get("from_submit") or row.get("qoj_id"):
            continue
        status = row.get("status")
        started = row.get("send_started_at_ms")
        when = started or row.get("submitted_at_ms")
        # The LAN queue has its own expiry, including end time and permission checks.
        if status == "awaiting_sync" or (status == "sending" and isinstance(when, (int, float)) and now - when > 120_000):
            unsent = row.get("delivery_tracked") and started is None
            row.update(status="send_failed" if unsent else "send_uncertain",
                       message="等待发送超时，代码未发送。" if unsent else "没有收到 QOJ 提交编号，请先核对 QOJ 提交记录。")
            changed = True
    if changed:
        save_submission_records(session_id, rows, archive)
    return rows


def prepare_submission(body):
    with STATE_LOCK:
        active = session()
        if not active or body.get("session_id") != active.get("session_id"):
            raise ValueError("比赛已切换，请重新打开 Submit")
        now = now_ms()
        anchor = require_submission_window(active, now)["start_at_ms"]
        problem = str(body.get("problem", "")).strip().upper()
        config = read_json(DATA / "contests" / safe_contest_path(active["path"]) / "config.json", {})
        labels = [str(p.get("label", chr(65 + index))).upper() for index, p in enumerate(config.get("problems", []))]
        if problem not in labels:
            raise ValueError("比赛题号无效")
        source = body.get("source")
        if not isinstance(source, str) or not source.strip() or len(source.encode("utf-8")) > 262144:
            raise ValueError("源码不能为空，且不能超过 256 KiB")
        language = str(body.get("language", "")).strip()[:100]
        if not language:
            raise ValueError("请选择语言")
        request_id = str(body.get("request_id", ""))
        if not re.fullmatch(r"[a-f0-9-]{32,36}", request_id):
            raise ValueError("提交请求 ID 无效")
        ident = "submit-" + request_id
        rows = expire_submission_attempts(active["session_id"], read_json(SUBMISSION_FILE, []), now=now)
        if any(row["id"] == ident for row in rows):
            raise ValueError("这次提交已经登记，请先核对提交记录，避免重复提交")
        row = {"id": ident, "problem": problem, "status": "sending", "from_submit": True,
               "contest_time_seconds": (now - anchor) / 1000, "submitted_at_ms": now,
               "judged_at_ms": None, "language": language, "time_provisional": True, "delivery_tracked": True}
        details_path = submission_details_file(active["session_id"])
        details = read_json(details_path, {})
        details[ident] = {"source": source, "filename": Path(str(body.get("filename") or "solution.txt").replace("\\", "/")).name[:120],
                          "language": language, "requested_at_ms": now, "request_id": request_id}
        write_json(details_path, details)
        # Keep the private source and accept a late positive receipt, but retire
        # the visible placeholder once the team makes another normal submission.
        for previous in rows:
            if (previous.get("from_submit") and not previous.get("qoj_id") and not previous.get("rejudge_id")
                    and previous.get("status") in ("send_failed", "send_uncertain")):
                previous["status"] = "send_cancelled"
        rows.append(row)
        write_json(SUBMISSION_FILE, rows)
        return {"submission": row, "qoj_url": active["qoj_url"], "session_id": active["session_id"]}


def begin_submission(body):
    with STATE_LOCK:
        active = session()
        if not active or active.get("session_id") != body.get("session_id"):
            raise ValueError("比赛已切换，代码未发送")
        rows = read_json(SUBMISSION_FILE, [])
        row = next((r for r in rows if r.get("from_submit") and r["id"] == body.get("id")), None)
        if not row or row["status"] != "sending" or row.get("send_started_at_ms") is not None:
            raise ValueError("本次提交已取消或开始发送，请勿重复提交")
        now = now_ms()
        window = submission_window(active, now)
        if not window["can_submit"]:
            row.update({"status": "send_failed", "message": window["reason"] + "，代码未发送"})
            write_json(SUBMISSION_FILE, rows)
            raise ValueError(window["reason"])
        source = saved_source_for_send(active["session_id"], row["id"], body)
        row["send_started_at_ms"] = now
        write_json(SUBMISSION_FILE, rows)
        return {"ok": True, "source": source}


def saved_source_for_send(sid, ident, body):
    path = submission_details_file(sid)
    details = read_json(path, {})
    saved = details.get(ident, {})
    source = saved.get("source")
    if not isinstance(source, str) or not source.strip() or len(source.encode("utf-8")) > 262144:
        raise ValueError("No saved source is available. Code was not sent.")
    identity = {key: str(body[key])[:150] for key in ("qoj_handle", "qoj_language", "qoj_problem_id") if body.get(key)}
    if identity:
        saved.update(identity)
        write_json(path, details)
    return source


def apply_submission_receipt(rows, row, outcome, qoj_id, message):
    if outcome not in ("accepted", "uncertain", "failed"):
        raise ValueError("提交状态无效")
    if (outcome == "accepted") != bool(qoj_id) or qoj_id and not re.fullmatch(r"\d{1,15}", qoj_id):
        raise ValueError("只有确认 QOJ 提交编号后才能登记提交成功")
    if qoj_id and any(r is not row and r.get("qoj_id") == qoj_id for r in rows):
        raise ValueError("这个 QOJ 提交编号已关联到另一条提交")
    row.update(status={"accepted": "awaiting_sync", "uncertain": "send_uncertain", "failed": "send_failed"}[outcome],
               message=message[:400])
    row.pop("delivery_checked_by_host", None)
    if qoj_id:
        row["qoj_id"] = qoj_id
        scanned = next((r for r in rows if r["id"] == qoj_id and not r.get("from_submit")), None)
        if scanned:
            row.update({key: value for key, value in scanned.items() if key != "id"})
            row["time_provisional"] = False
            rows.remove(scanned)


def finish_submission(body):
    with STATE_LOCK:
        session_id, ident = body.get("session_id"), str(body.get("id", ""))
        rows, archive = submission_records(session_id)
        row = next((r for r in rows if r["id"] == ident and r.get("from_submit")), None)
        if row is None:
            raise ValueError("没有找到这次提交")
        outcome = body.get("outcome")
        qoj_id = str(body.get("qoj_id") or "")
        if row.get("rejudge_send_id"):
            return row  # A receipt from the original request cannot modify a resend.
        recovered = (row.get("status") == "send_uncertain" and outcome != "uncertain"
                     or (row.get("status") == "send_cancelled" or row.get("delivery_checked_by_host")) and outcome == "accepted")
        if row.get("status") != "sending" and not recovered:
            return row  # Never reset a judged row, but accept a late definitive receipt.
        message = str(body.get("message") or "")[:400]
        if outcome == "uncertain" and row.get("delivery_tracked") and row.get("send_started_at_ms") is None:
            outcome, message = "failed", "主机未开始发送代码。" + message
        apply_submission_receipt(rows, row, outcome, qoj_id, message)
        save_submission_records(session_id, rows, archive)
        return row


def mark_submission_not_sent(body):
    with STATE_LOCK:
        sid, ident = body.get("session_id"), body.get("id")
        rows, archive = submission_records(sid)
        expire_submission_attempts(sid, rows, archive)
        row = next((r for r in rows if r["id"] == ident and r.get("from_submit")), None)
        if row and not row.get("qoj_id") and row.get("status") == "send_failed":
            return row
        if not row or row.get("qoj_id") or row.get("status") != "send_uncertain":
            raise ValueError("只能标记未确认的本地发送尝试，请刷新后查看")
        row.update(status="send_failed", message="主机已核对 QOJ，未找到对应提交。", delivery_checked_by_host=True)
        save_submission_records(sid, rows, archive)
        return row


def submission_details_view(details, prefer_original=False):
    result = dict(details)
    qoj_source = result.pop("qoj_source", None)
    if qoj_source and not prefer_original:
        result["source"] = qoj_source
    return result


def get_submission_details(session_id, ident, *, prefer_original=False):
    rows, _ = submission_records(session_id)
    row = next((r for r in rows if r["id"] == ident), None)
    if row is None:
        raise ValueError("没有找到这条提交记录")
    details = read_json(submission_details_file(session_id), {}).get(ident, {})
    return {"submission": row, "details": submission_details_view(details, prefer_original)}


def cache_submission_details(body):
    with STATE_LOCK:
        session_id, ident = body.get("session_id"), str(body.get("id", ""))
        rows, archive = submission_records(session_id)
        row = next((item for item in rows if item["id"] == ident), None)
        if row is None:
            raise ValueError("没有找到这条提交记录")
        path = submission_details_file(session_id)
        all_details = read_json(path, {})
        details = all_details.setdefault(ident, {})
        incoming = body.get("details", {})
        if not isinstance(incoming, dict):
            raise ValueError("提交详情无效")
        for key in ("source", "compile_output", "language", "runtime", "memory"):
            value = incoming.get(key)
            if isinstance(value, str) and value:
                if key == "source" and row.get("from_submit") and details.get("source"):
                    if row.get("qoj_id"):
                        details["qoj_source"] = value[:262144]
                    continue  # Refresh the viewer without changing the saved original.
                details[key] = value[:262144 if key in ("source", "compile_output") else 150]
                if key in ("language", "runtime", "memory"):
                    row[key] = value[:100]
        write_json(path, all_details)
        save_submission_records(session_id, rows, archive)
        return {"submission": row, "details": submission_details_view(details)}


def lan_settings():
    saved = read_json(DATA / "lan_settings.json", {})
    if not isinstance(saved, dict):
        saved = {}
    settings = {key: saved.get(key) is True for key in ("home", "analysis", "submit")}
    # Older settings may allow Submit while keeping Home private. Keep Home
    # private until the host explicitly enables the new linked permissions.
    settings["submit"] = settings["submit"] and settings["home"]
    return settings


def client_permissions(local, address):
    shared = LAN_ENABLED and private_client(address)
    settings = lan_settings() if shared and not local else {}
    return {key: bool(local or shared and settings.get(key)) for key in ("home", "analysis", "submit")}


def save_lan_settings(body):
    with STATE_LOCK:
        if not body or any(key not in ("home", "analysis", "submit") or type(value) is not bool for key, value in body.items()):
            raise ValueError("共享设置无效")
        settings = {**lan_settings(), **body}
        if body.get("home") is False:
            settings["submit"] = False
        elif settings["submit"]:
            settings["home"] = True
        write_json(DATA / "lan_settings.json", settings)
        expire_lan_submit_jobs()
        return settings


def lan_submit_file(ident):
    if not re.fullmatch(r"[a-f0-9-]{32,36}", str(ident or "")):
        raise ValueError("转发请求 ID 无效")
    return DATA / "submit_queue" / f"{ident}.json"


def save_lan_submit_job(job):
    write_json(lan_submit_file(job["id"]), job)


def fail_lan_submit_job(job, message, uncertain=False):
    job["status"] = "uncertain" if uncertain else "failed"
    job["result"] = {"outcome": "uncertain" if uncertain else "failed", "message": message}
    job["finished_at_ms"] = now_ms()
    if job["action"] in ("send", "rejudge"):
        try:
            rows, archive = submission_records(job["session_id"])
            row = next((r for r in rows if r["id"] == job.get("submission_id", "submit-" + job["id"])), None)
            if row and job["action"] == "rejudge" and row.get("rejudge_id") == job["id"]:
                row.pop("rejudge_id", None)
                if not row.get("qoj_id"):
                    if uncertain:
                        row["status"] = "send_uncertain"
                    row["message"] = message
                save_submission_records(job["session_id"], rows, archive)
            elif row and job["action"] == "send" and row["status"] in ("queued", "sending"):
                row["status"] = "send_uncertain" if uncertain else "send_failed"
                row["message"] = message
                save_submission_records(job["session_id"], rows, archive)
        except (ValueError, FileNotFoundError):
            pass  # A deleted archive must not cause an old code request to be replayed.
    save_lan_submit_job(job)


def expire_lan_submit_jobs():
    """Called with STATE_LOCK held. Never replay a job that crossed the send gate."""
    active, settings, now = session(), lan_settings(), now_ms()
    jobs = []
    for path in (DATA / "submit_queue").glob("*.json"):
        job = read_json(path, {})
        if not job.get("id"):
            continue
        status = job.get("status")
        if status in ("done", "failed") and now - job.get("finished_at_ms", now) > 7 * 86400_000:
            path.unlink(missing_ok=True)  # Public records and private source have separate permanent storage.
            continue
        if status in ("queued", "claimed"):
            reading_source = job["action"] == "source"
            rejudge = job["action"] == "rejudge"
            enabled = rejudge and job.get("local") or LAN_ENABLED and settings["home" if reading_source else "submit"]
            if not enabled:
                fail_lan_submit_job(job, "主机已关闭 Home，源码读取已取消" if reading_source else "主机已关闭局域网提交，代码未发送")
            elif not active or active.get("session_id") != job["session_id"]:
                fail_lan_submit_job(job, "当前比赛已切换，源码读取已取消" if reading_source else "当前比赛已切换，代码未发送")
            elif not reading_source and not rejudge and not submission_window(active, now)["can_submit"]:
                fail_lan_submit_job(job, submission_window(active, now)["reason"] + "，代码未发送")
            elif now - job["created_at_ms"] > 120_000:
                fail_lan_submit_job(job, "等待主机扩展超时，请检查主机浏览器后重新读取源码" if reading_source else "等待主机扩展超时，代码未发送；请检查主机扩展后重新提交")
            elif status == "claimed" and now - job["claimed_at_ms"] > 60_000:
                # A preparation may be retried; its old claim can no longer open the send gate.
                job["status"] = "queued"
                job.pop("claim", None)
                save_lan_submit_job(job)
        elif status == "sending" and now - job["started_at_ms"] > 120_000:
            fail_lan_submit_job(job, "主机提交回执暂未确认，请先检查 QOJ，勿重复发送", uncertain=True)
        jobs.append(job)
    return jobs


def read_lan_submit_job(ident, token):
    job = read_json(lan_submit_file(ident), {})
    if not job or not secrets.compare_digest(str(job.get("token", "")), str(token or "")):
        raise PermissionError("转发请求不存在或无权访问")
    return job


def public_lan_submit_job(job):
    return {key: job[key] for key in ("id", "action", "status", "result") if key in job}


def lan_submit_status(ident, token):
    with STATE_LOCK:
        expire_lan_submit_jobs()
        return public_lan_submit_job(read_lan_submit_job(ident, token))


def queue_rejudge(body, active, ident, token, local):
    sid = active["session_id"]
    rows = expire_submission_attempts(sid, read_json(SUBMISSION_FILE, []))
    row = next((r for r in rows if r["id"] == body.get("submission_id") and r.get("from_submit")), None)
    if not row or row.get("qoj_id") or row.get("status") not in ("send_failed", "send_uncertain") or row.get("rejudge_id"):
        raise ValueError("此提交已确认或正在处理，请刷新后查看")
    source = body.get("source")
    if source is not None:
        if not isinstance(source, str) or not source.strip() or len(source.encode("utf-8")) > 262144:
            raise ValueError("源码不能为空，且不能超过 256 KiB")
        path = submission_details_file(sid)
        details = read_json(path, {})
        saved = details.setdefault(row["id"], {})
        if not saved.get("source"):
            filename = Path(str(body.get("filename") or "solution.txt").replace("\\", "/")).name[:120]
            saved.update(source=source, filename=filename)
            write_json(path, details)
    job = {"id": ident, "token": token, "session_id": sid, "submission_id": row["id"],
           "action": "rejudge", "local": local, "status": "queued", "created_at_ms": now_ms()}
    save_lan_submit_job(job)
    row["rejudge_id"] = ident
    if source is not None:
        row.pop("rejudge_needs_source", None)
    save_submission_records(sid, rows)
    return public_lan_submit_job(job)


def queue_lan_submit(body, local=False):
    with STATE_LOCK:
        reading_source = body.get("action") == "source"
        rejudge = body.get("action") == "rejudge"
        if not (rejudge and local or LAN_ENABLED and lan_settings()["home" if reading_source else "submit"]):
            raise PermissionError("主机未开放 Home 源码查看" if reading_source else "主机未开放局域网提交")
        active = session()
        if not active or active.get("session_id") != body.get("session_id"):
            raise ValueError("当前比赛已切换，请重新打开源码" if reading_source else "当前比赛已切换，请重新打开 Submit")
        ident, token = str(body.get("request_id", "")), str(body.get("token", ""))
        path = lan_submit_file(ident)
        if not re.fullmatch(r"[a-f0-9-]{32,36}", token):
            raise ValueError("转发请求凭证无效")
        if path.exists():
            return public_lan_submit_job(read_lan_submit_job(ident, token))
        if not reading_source and not rejudge:
            require_submission_window(active)
        jobs = expire_lan_submit_jobs()
        if sum(job["status"] in ("queued", "claimed", "sending") for job in jobs) >= 20:
            raise ValueError("主机当前有较多待处理请求，请稍后再试")
        if rejudge:
            return queue_rejudge(body, active, ident, token, local)
        if reading_source:
            record = get_submission_details(active["session_id"], str(body.get("submission_id", "")))["submission"]
            qoj_id = str(record.get("qoj_id") or record["id"])
            if not re.fullmatch(r"\d{1,15}", qoj_id):
                raise ValueError("等待 QOJ 提交 ID 确认后才能重新读取源码")
            job = {"id": ident, "token": token, "session_id": active["session_id"], "submission_id": record["id"],
                   "qoj_id": qoj_id, "action": "source", "status": "queued", "created_at_ms": now_ms()}
            save_lan_submit_job(job)
            return public_lan_submit_job(job)
        problem = str(body.get("problem", "")).strip().upper()
        config = read_json(DATA / "contests" / safe_contest_path(active["path"]) / "config.json", {})
        labels = [str(p.get("label", chr(65 + i))).upper() for i, p in enumerate(config.get("problems", []))]
        if problem not in labels:
            raise ValueError("比赛题号无效")
        job = {"id": ident, "token": token, "session_id": active["session_id"], "problem": problem,
               "action": body.get("action"), "status": "queued", "created_at_ms": now_ms()}
        if job["action"] == "send":
            form = read_lan_submit_job(body.get("form_key"), body.get("form_token"))
            info = form.get("result", {})
            if (form["action"] != "inspect" or form["status"] != "done" or form["session_id"] != active["session_id"]
                    or form["problem"] != problem or now_ms() - form["created_at_ms"] > 900_000):
                raise ValueError("主机提交表单已失效，请重新选择题目")
            language = str(body.get("qoj_language") or "")
            if not any(option["value"] == language for option in info.get("languages", [])):
                raise ValueError("主机 QOJ 不支持所选语言")
            job.update({"language": language, "handle": info["handle"], "problem_id": info["problem_id"]})
            row = prepare_submission(body)["submission"]
            row["status"] = "queued"
            rows = read_json(SUBMISSION_FILE, [])
            next(r for r in rows if r["id"] == row["id"])["status"] = "queued"
            write_json(SUBMISSION_FILE, rows)
        elif job["action"] != "inspect":
            raise ValueError("转发操作无效")
        save_lan_submit_job(job)
        return public_lan_submit_job(job)


def cancel_lan_submit(body):
    with STATE_LOCK:
        job = read_lan_submit_job(body.get("id"), body.get("token"))
        if job["status"] in ("queued", "claimed") or job["action"] == "inspect":
            fail_lan_submit_job(job, "源码读取已取消" if job["action"] == "source" else "本次请求已取消，代码未发送")
        return public_lan_submit_job(job)


def claim_lan_submit():
    with STATE_LOCK:
        jobs = expire_lan_submit_jobs()
        pending = sorted((job for job in jobs if job["status"] == "queued"), key=lambda job: job["created_at_ms"])
        if not pending:
            return {"job": None}
        job = pending[0]
        job.update({"status": "claimed", "claim": secrets.token_hex(16), "claimed_at_ms": now_ms()})
        save_lan_submit_job(job)
        task = {key: job[key] for key in ("id", "action", "claim", "problem", "language", "handle", "problem_id", "submission_id", "qoj_id") if key in job}
        task["session"] = session()
        if job["action"] == "send":
            task["source"] = get_submission_details(job["session_id"], "submit-" + job["id"], prefer_original=True)["details"].get("source", "")
        elif job["action"] == "rejudge":
            record = get_submission_details(job["session_id"], job["submission_id"], prefer_original=True)
            row, details = record["submission"], record["details"]
            task.update(problem=row["problem"], source=details.get("source", ""), language=row.get("language", ""),
                        attempt={key: row.get(key) for key in ("qoj_id", "status", "submitted_at_ms", "send_started_at_ms", "delivery_checked_by_host")},
                        identity={key: details.get(key) for key in ("qoj_handle", "qoj_language", "qoj_problem_id")},
                        window=submission_window(task["session"]), now_ms=now_ms())
        return {"job": task}


def relay_job(body):
    job = read_json(lan_submit_file(body.get("relay_job_id")), {})
    if not job or not secrets.compare_digest(str(job.get("claim", "")), str(body.get("relay_claim", ""))):
        raise ValueError("主机转发请求已失效")
    return job


def begin_lan_submit(body):
    with STATE_LOCK:
        expire_lan_submit_jobs()
        job = relay_job(body)
        if job["action"] not in ("send", "rejudge") or job["status"] != "claimed":
            raise ValueError("转发已取消、过期或开始发送，请勿重复提交")
        window = submission_window(session())
        if not window["can_submit"]:
            fail_lan_submit_job(job, window["reason"] + "，代码未发送")
            raise ValueError(window["reason"])
        # This gate is used once, immediately before the extension can POST to QOJ.
        rows, archive = submission_records(job["session_id"])
        row = next((row for row in rows if row["id"] == job.get("submission_id", "submit-" + job["id"])), None)
        rejudge = job["action"] == "rejudge"
        if (row is None or row.get("qoj_id") or (row.get("rejudge_id") != job["id"] if rejudge else row.get("status") != "queued")):
            raise ValueError("提交已取消或过期，代码未发送")
        source = saved_source_for_send(job["session_id"], row["id"], body)
        job.update({"status": "sending", "started_at_ms": now_ms()})
        row.update(status="sending", send_started_at_ms=job["started_at_ms"])
        if rejudge:
            row.update(rejudge_send_id=job["id"], submitted_at_ms=job["started_at_ms"], delivery_tracked=True,
                       time_provisional=True, contest_time_seconds=(job["started_at_ms"] - window["start_at_ms"]) / 1000)
        save_lan_submit_job(job)
        save_submission_records(job["session_id"], rows, archive)
        return {"ok": True, "source": source}


def finish_rejudge(job, body):
    if job["status"] not in ("claimed", "sending", "uncertain"):
        raise ValueError("Rejudge 请求已失效")
    rows, archive = submission_records(job["session_id"])
    row = next((r for r in rows if r["id"] == job["submission_id"] and r.get("from_submit")), None)
    outcome = body.get("outcome")
    result = {"outcome": outcome, "message": str(body.get("message") or "")[:400]}
    if row and row.get("qoj_id"):
        result = {"outcome": "accepted", "qoj_id": row["qoj_id"], "message": "已找到 QOJ 提交"}
    elif row and (row.get("rejudge_id") == job["id"] or row.get("rejudge_send_id") == job["id"] and outcome == "accepted"):
        qoj_id = str(body.get("qoj_id") or "")
        if qoj_id and any(r is not row and r.get("qoj_id") == qoj_id for r in rows):
            result = {"outcome": "uncertain", "message": "找到的 QOJ 编号已关联另一条提交，未重新发送。"}
            qoj_id = ""
        apply_submission_receipt(rows, row, result["outcome"], qoj_id, result["message"])
        if qoj_id:
            result["qoj_id"] = qoj_id
        if body.get("needs_source") is True:
            result["needs_source"] = True
    else:
        result = {"outcome": "uncertain", "message": "原记录已变化，请刷新后核对 QOJ。"}
    if row:
        if row.get("rejudge_id") == job["id"]:
            row.pop("rejudge_id", None)
            if result.get("needs_source"):
                row["rejudge_needs_source"] = True
            else:
                row.pop("rejudge_needs_source", None)
        save_submission_records(job["session_id"], rows, archive)
    return result


def finish_lan_submit(body):
    with STATE_LOCK:
        job = relay_job(body)
        if job["action"] == "source":
            expire_lan_submit_jobs()
            job = relay_job(body)
        if job["status"] in ("done", "failed"):
            return public_lan_submit_job(job)
        if job["action"] == "source":
            details = body.get("source_details")
            source = details.get("source") if isinstance(details, dict) else None
            if job["status"] != "claimed" or not isinstance(source, str) or not source.strip() or len(source.encode("utf-8")) > 262144:
                fail_lan_submit_job(job, str(body.get("message") or "主机未能读取 QOJ 源码")[:400])
                return public_lan_submit_job(job)
            cache_submission_details({"session_id": job["session_id"], "id": job["submission_id"],
                                      "details": {"source": source, "language": details.get("language")}})
            result = {"ready": True, "submission_id": job["submission_id"]}
            job["status"] = "done"
        elif job["action"] == "rejudge":
            result = finish_rejudge(job, body)
            job["status"] = {"accepted": "done", "failed": "failed", "uncertain": "uncertain"}[result["outcome"]]
        elif job["action"] == "send":
            if job["status"] not in ("sending", "uncertain", "claimed"):
                raise ValueError("转发状态无效")
            if job["status"] == "claimed":
                if body.get("outcome") != "failed":
                    raise ValueError("尚未开始发送代码")
                fail_lan_submit_job(job, str(body.get("message") or "主机未能发送代码")[:400])
                return public_lan_submit_job(job)
            finish_submission({**body, "session_id": job["session_id"], "id": "submit-" + job["id"]})
            result = {key: body[key] for key in ("outcome", "qoj_id", "message") if key in body}
            job["status"] = "done" if result["outcome"] == "accepted" else "uncertain" if result["outcome"] == "uncertain" else "failed"
        else:
            info = body.get("info", {})
            if (job["status"] != "claimed" or not info.get("ready") or not info.get("handle")
                    or not re.fullmatch(r"\d{1,10}", str(info.get("problem_id", "")))):
                fail_lan_submit_job(job, str(body.get("message") or "主机未能读取 QOJ 提交表单")[:400])
                return public_lan_submit_job(job)
            languages = [{"value": str(option["value"])[:150], "label": str(option["label"])[:150]}
                         for option in info.get("languages", [])[:100] if isinstance(option, dict) and option.get("value") and option.get("label")]
            result = {"ready": True, "handle": str(info["handle"])[:100], "problem_id": str(info["problem_id"]),
                      "languages": languages, "selected": str(info.get("selected", ""))[:150]}
            job["status"] = "done"
        job.update({"result": result, "finished_at_ms": now_ms()})
        save_lan_submit_job(job)
        return public_lan_submit_job(job)


def _merge_submissions_locked(rows):
    original_rows = read_json(SUBMISSION_FILE, [])
    # Merge mutates rows in place; keep the original bytes' values for comparison.
    original_snapshot = json.dumps(original_rows, ensure_ascii=False, sort_keys=True)
    current = {str(item["id"]): item for item in original_rows if item.get("status") != "ignored"}
    active = session() or {}
    cutoff_seconds = float(active.get("submission_ignore_before_seconds") or 0)
    session_changed = "excluded_submission_ids" in active
    active.pop("excluded_submission_ids", None)
    try:
        duration_seconds = contest_duration_ms(active["path"]) / 1000
    except (ValueError, FileNotFoundError, KeyError):
        duration_seconds = 24 * 3600
    now = now_ms()
    changed = 0
    for item in rows:
        ident = str(item.get("id", ""))
        if not re.fullmatch(r"\d{1,15}", ident):
            continue
        managed = next((row for row in current.values() if row.get("from_submit") and row.get("qoj_id") == ident), None)
        qoj_id = ident
        if managed:
            ident = managed["id"]
        submitted = item.get("submitted_at_ms")
        try:
            submitted = int(submitted)
        except (TypeError, ValueError):
            continue
        if submitted > now + 60_000:
            continue
        time_source = str(item.get("time_source") or "relative")
        expected_time_source = "absolute" if active.get("timing_source") == "manual" else "relative"
        if time_source != expected_time_source and not (managed and time_source == "absolute"):
            continue
        absolute_contest_time = None
        if time_source == "absolute":
            absolute_contest_time = (submitted - int((active.get("clock_start_at_ms") if managed else None) or active.get("start_at_ms", 0))) / 1000
            if not 0 <= absolute_contest_time or (absolute_contest_time >= duration_seconds and not managed):
                if current.pop(ident, None) is not None:
                    changed += 1
                continue
        contest_time = item.get("contest_time_seconds")
        try:
            contest_time = float(contest_time) if contest_time is not None else None
        except (TypeError, ValueError):
            contest_time = None
        if absolute_contest_time is not None:
            contest_time = absolute_contest_time
        elif time_source == "relative" and contest_time is not None:
            if not 0 <= contest_time < (7 * 86400 if managed else duration_seconds):
                continue
            submitted = round(int(active.get("start_at_ms", 0)) + contest_time * 1000)
        if contest_time is not None and (not 0 <= contest_time or (contest_time >= duration_seconds and not managed)):
            if current.pop(ident, None) is not None:
                changed += 1
            continue
        if cutoff_seconds and ((contest_time is not None and contest_time < cutoff_seconds) or
                               (contest_time is None and submitted < int(active.get("start_at_ms", 0) + cutoff_seconds * 1000))):
            continue
        problem = str(item.get("problem", "")).strip().upper()
        if not re.fullmatch(r"[A-Z][A-Z0-9]?", problem):
            continue
        status = str(item.get("status", "pending")).lower()
        if status not in ("correct", "incorrect", "wrong_answer", "memory_limit", "time_limit", "runtime_error", "output_limit", "presentation_error", "pending", "compile_error", "ignored"):
            continue
        if status == "ignored":
            current.pop(ident, None)
            continue
        old = current.get(ident)
        if old and (old["problem"] != problem or (not managed and old["submitted_at_ms"] != submitted)):
            continue
        if old is None:
            old = {"id": ident, "problem": problem, "submitted_at_ms": submitted,
                   "status": "pending", "judged_at_ms": None}
        if contest_time is not None:
            old["contest_time_seconds"] = contest_time
        old["time_source"] = time_source
        if managed:
            old["submitted_at_ms"] = submitted
            old["time_provisional"] = False
            old["qoj_status"] = status
            old["qoj_id"] = qoj_id
            if contest_time is not None and contest_time >= duration_seconds:
                status = "too_late"
        for key in ("language", "runtime", "memory"):
            if isinstance(item.get(key), str) and item[key]:
                old[key] = item[key][:100]
        if old["status"] == "correct" and status not in ("correct", "too_late"):
            continue  # VP uses the formal result; later Extra test / Hack cannot revoke this AC.
        if old["status"] != status:
            old["status"] = status
            old["judged_at_ms"] = now if status != "pending" else None
            changed += 1
        current[ident] = old
    if session_changed:
        write_json(SESSION_FILE, active)
    merged = sorted(current.values(), key=lambda row: (row["submitted_at_ms"], row["id"]))
    if json.dumps(merged, ensure_ascii=False, sort_keys=True) != original_snapshot:
        write_json(SUBMISSION_FILE, merged)
    return {"count": len(current), "changed": changed, "observed_at_ms": now}


class Handler(BaseHTTPRequestHandler):
    def _local_client(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def _may_sync(self):
        return may_sync_client(self.client_address[0])

    def _permissions(self):
        return client_permissions(self._local_client(), self.client_address[0])

    def _allowed_origin(self):
        origin = self.headers.get("Origin", "")
        if not origin:
            return ""
        host = urlparse(origin).hostname or ""
        if (origin.startswith("chrome-extension://") or
                (urlparse(origin).scheme == "https" and (host == "qoj.ac" or host.endswith(".qoj.ac"))) or
                (urlparse(origin).scheme == "http" and host in (HOST, self.headers.get("Host", "").split(":")[0]))):
            return origin
        return None

    def _json(self, value, status=200):
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        origin = self._allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self._write_payload(payload)

    def _write_payload(self, payload):
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            # Browsers routinely cancel superseded refresh requests. The
            # response is no longer needed, so this is not a server failure.
            return None

    def do_OPTIONS(self):
        if self._allowed_origin() is None:
            return self._json({"error": "跨站请求被拒绝"}, 403)
        self._json({})

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/contests":
                return self._json(list_contests())
            if parsed.path == "/api/catalog":
                return self._json(contest_catalog(force=query.get("refresh") == ["1"] and self._local_client()))
            if parsed.path == "/api/session":
                with STATE_LOCK:
                    active = session()
                    now = now_ms()
                    rows = expire_submission_attempts(active["session_id"], read_json(SUBMISSION_FILE, []), now=now) if active else []
                    submit_ids = [r["qoj_id"] for r in rows if r.get("from_submit") and r.get("qoj_id")]
                    submit_refs = [{"id": r["qoj_id"], "problem": r["problem"]} for r in rows
                                   if r.get("from_submit") and r.get("qoj_id") and (r.get("time_provisional") or r.get("status") in ("awaiting_sync", "pending") or r.get("qoj_status") == "pending")] if self._local_client() else []
                    pending_refs = [{key: r[key] for key in ("id", "problem", "submitted_at_ms", "contest_time_seconds", "time_source", "status") if key in r}
                                    for r in rows if not r.get("from_submit") and r.get("status") == "pending"
                                    and re.fullmatch(r"\d{1,15}", str(r.get("id", "")))][:500] if self._local_client() else []
                    value = {"session": active, "submit_ids": submit_ids, "submit_refs": submit_refs, "pending_refs": pending_refs, "submission_window": submission_window(active, now), "can_manage": self._local_client(), "permissions": self._permissions(), "server_time_ms": now, "clock": CLOCK.status()}
                return self._json(value)
            if parsed.path in ("/api/home", "/api/analysis"):
                with STATE_LOCK:
                    permission = parsed.path.rsplit("/", 1)[1]
                    if not self._permissions()[permission]:
                        raise PermissionError("主机未开放此页面")
                    active = session()
                    if not active:
                        raise ValueError("当前没有已启动的比赛")
                    if permission == "analysis" and (not active.get("revealed_at_ms") or now_ms() < active["start_at_ms"] + contest_duration_ms(active["path"])):
                        raise PermissionError("最终榜单公布后才能查看 Analysis")
                    value = {"session": active, "submissions": expire_submission_attempts(active["session_id"], read_json(SUBMISSION_FILE, []))}
                return self._json(value)
            if parsed.path == "/api/submit-relay/status":
                return self._json(lan_submit_status(query.get("id", [""])[0], query.get("token", [""])[0]))
            if parsed.path == "/api/history":
                if not self._local_client():
                    raise PermissionError("只有主机可管理历史比赛")
                ident = query.get("id", [None])[0]
                return self._json(history_entry(ident) if ident else history_list())
            if parsed.path == "/api/qoj-vp-observation":
                if not self._local_client():
                    return self._json({"error": "只有主机可读取 VP 识别结果"}, 403)
                return self._json({"observation": vp_observation()})
            if parsed.path == "/api/qoj-contest-info":
                return self._json({"contest": qoj_contest_info()})
            if parsed.path == "/api/debug-time":
                return self._json({"enabled": DEBUG_ENABLED, "elapsed_seconds": DEBUG_ELAPSED if DEBUG_ENABLED else None})
            if parsed.path == "/api/host-info":
                if not self._local_client():
                    return self._json({"error": "只有主机可查看服务信息"}, 403)
                return self._json({"lan_enabled": LAN_ENABLED, "lan_settings": lan_settings(), "lan_urls": [f"http://{address}:{self.server.server_port}" for address in lan_addresses()] if LAN_ENABLED else []})
            if parsed.path == "/api/submissions":
                with STATE_LOCK:
                    expected = query.get("session_id", [None])[0]
                    active = session()
                    if expected is not None and expected != (active or {}).get("session_id"):
                        raise ValueError("比赛已切换，请重新读取榜单")
                    rows = read_json(SUBMISSION_FILE, [])
                    if active:
                        expire_submission_attempts(active["session_id"], rows)
                return self._json(rows)
            if parsed.path == "/api/submission-details":
                with STATE_LOCK:
                    ident = query.get("session_id", [""])[0]
                    if not self._local_client():
                        if not self._permissions()["home"]:
                            raise PermissionError("主机未开放 Home 源码查看")
                        if ident != (session() or {}).get("session_id"):
                            raise PermissionError("局域网只共享当前比赛的源码")
                    value = get_submission_details(ident, query.get("id", [""])[0])
                    if not self._local_client():
                        value["details"] = {key: value["details"][key] for key in ("source", "filename") if key in value["details"]}
                return self._json(value)
            if parsed.path == "/api/submission-sync-status":
                if not self._local_client():
                    raise PermissionError("只有主机可读取 QOJ 连接信息")
                return self._json({"sync": submission_sync_status(), "server_time_ms": now_ms()})
            if parsed.path == "/api/contest":
                path = query.get("path", [""])[0]
                if not self._local_client() and path != (session() or {}).get("path"):
                    raise PermissionError("局域网只共享当前比赛")
                return self._json(load_contest(path))
            if parsed.path == "/api/team-runs":
                if not self._local_client():
                    raise PermissionError("只有主机可读取导入记录")
                path = query.get("path", [""])[0]
                file = DATA / "own" / (safe_contest_path(path).replace("/", "__") + ".json")
                return self._json(json.loads(file.read_text(encoding="utf-8")) if file.exists() else [])
            if parsed.path in ("/", "/app.js", "/style.css"):
                name = "index.html" if parsed.path == "/" else parsed.path[1:]
                payload = (ROOT / "static" / name).read_bytes()
                mime = {"index.html": "text/html", "app.js": "text/javascript", "style.css": "text/css"}[name]
                self.send_response(200)
                self.send_header("Content-Type", mime + "; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store, max-age=0")
                self.send_header("Pragma", "no-cache")
                self.end_headers()
                return self._write_payload(payload)
            self._json({"error": "找不到页面"}, 404)
        except PermissionError as exc:
            self._json({"error": str(exc)}, 403)
        except (ValueError, FileNotFoundError, KeyError) as exc:
            self._json({"error": str(exc)}, 400)

    def do_POST(self):
        try:
            if self._allowed_origin() is None:
                return self._json({"error": "跨站请求被拒绝"}, 403)
            size = int(self.headers.get("Content-Length", "0"))
            import_request = self.path in ("/api/contests/import-preview", "/api/contests/import")
            if import_request and not self._local_client():
                raise PermissionError("只有主机可导入比赛数据")
            if size < 0 or size > (MAX_UPLOAD * 4 // 3 + 65536 if import_request else 5_000_000):
                raise ValueError("请求过大")
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError("请求必须是 JSON 对象")
            if import_request:
                return self._json(import_contest(body, preview=self.path.endswith("import-preview")))
            if self.path == "/api/lan-settings":
                if not self._local_client():
                    raise PermissionError("只有主机可修改局域网共享设置")
                return self._json(save_lan_settings(body))
            if self.path in ("/api/submit-relay/claim", "/api/submit-relay/begin", "/api/submit-relay/finish"):
                if not self._local_client():
                    raise PermissionError("只有主机扩展可处理转发")
                action = {"/api/submit-relay/claim": lambda body: claim_lan_submit(),
                          "/api/submit-relay/begin": begin_lan_submit, "/api/submit-relay/finish": finish_lan_submit}[self.path]
                return self._json(action(body))
            if self.path == "/api/submit-relay/status":
                return self._json(lan_submit_status(body.get("id"), body.get("token")))
            if self.path == "/api/submit/rejudge":
                if not self._local_client():
                    raise PermissionError("Rejudge here is only available on the host. Use the LAN submission queue instead.")
                return self._json(queue_lan_submit({**body, "action": "rejudge"}, local=True))
            if self.path in ("/api/submit-relay/queue", "/api/submit-relay/cancel"):
                if not self._may_sync():
                    raise PermissionError("只允许局域网设备请求提交")
                return self._json(queue_lan_submit(body, self._local_client()) if self.path.endswith("/queue") else cancel_lan_submit(body))
            if self.path in ("/api/submit/prepare", "/api/submit/begin", "/api/submit/finish", "/api/submit/mark-not-sent", "/api/submission-details"):
                if not self._local_client():
                    return self._json({"error": "只有主机可提交代码或保存提交详情"}, 403)
                action = {"/api/submit/prepare": prepare_submission, "/api/submit/begin": begin_submission, "/api/submit/finish": finish_submission, "/api/submit/mark-not-sent": mark_submission_not_sent,
                          "/api/submission-details": cache_submission_details}[self.path]
                return self._json(action(body))
            if self.path == "/api/download":
                if not self._local_client():
                    return self._json({"error": "只有主机可下载数据"}, 403)
                return self._json(download_contest(body.get("path", "")))
            if self.path == "/api/session/start":
                if not self._local_client():
                    return self._json({"error": "只有主机可启动比赛"}, 403)
                return self._json(start_session(body))
            if self.path == "/api/session/reveal":
                if not self._local_client():
                    return self._json({"error": "只有主机可公布最终榜单"}, 403)
                return self._json(reveal_session())
            if self.path == "/api/session/archive":
                if not self._local_client():
                    return self._json({"error": "只有主机可归档当前比赛"}, 403)
                return self._json(archive_current_session())
            if self.path == "/api/history/activate":
                if not self._local_client():
                    return self._json({"error": "只有主机可恢复历史比赛"}, 403)
                return self._json(activate_history(body.get("id")))
            if self.path == "/api/history/reveal":
                if not self._local_client():
                    return self._json({"error": "只有主机可公布历史比赛最终榜单"}, 403)
                return self._json(reveal_history(body.get("id")))
            if self.path == "/api/history/delete":
                if not self._local_client():
                    return self._json({"error": "只有主机可删除历史比赛"}, 403)
                return self._json(delete_history(body.get("id")))
            if self.path == "/api/qoj-vp-observation":
                if not self._local_client():
                    return self._json({"error": "只有主机本机扩展可记录 VP 起点"}, 403)
                return self._json(save_vp_observation(body))
            if self.path == "/api/qoj-contest-info":
                if not self._local_client():
                    return self._json({"error": "只有主机本机扩展可记录 QOJ 比赛名称"}, 403)
                return self._json(save_qoj_contest_info(body))
            if self.path == "/api/debug-time":
                if not DEBUG_ENABLED or not self._local_client():
                    return self._json({"error": "时间预览未开启或只能由主机控制"}, 403)
                global DEBUG_ELAPSED
                value = body.get("elapsed_seconds")
                if value is None:
                    DEBUG_ELAPSED = None
                else:
                    elapsed = float(value)
                    if not 0 <= elapsed <= 86400:
                        raise ValueError("预览时间超出范围")
                    DEBUG_ELAPSED = elapsed
                return self._json({"enabled": True, "elapsed_seconds": DEBUG_ELAPSED})
            if self.path == "/api/submissions":
                if not self._may_sync():
                    return self._json({"error": "只允许主机或已启用的私有局域网设备同步提交"}, 403)
                return self._json(sync_submission_batch(body))
            if self.path == "/api/submission-sync-error":
                if not self._may_sync():
                    return self._json({"error": "只允许主机或已启用的私有局域网设备报告同步错误"}, 403)
                return self._json(sync_submission_batch(body, error=True))
            if self.path == "/api/team-runs":
                if not self._local_client():
                    return self._json({"error": "只有主机可导入提交"}, 403)
                path = safe_contest_path(body.get("path", ""))
                runs = body.get("runs")
                if not path or not isinstance(runs, list) or len(runs) > 10000:
                    raise ValueError("提交数据无效")
                folder = DATA / "own"
                folder.mkdir(parents=True, exist_ok=True)
                (folder / (path.replace("/", "__") + ".json")).write_text(json.dumps(runs, ensure_ascii=False), encoding="utf-8")
                return self._json({"count": len(runs)})
            self._json({"error": "找不到接口"}, 404)
        except PermissionError as exc:
            self._json({"error": str(exc)}, 403)
        except (ValueError, FileNotFoundError, KeyError, json.JSONDecodeError, urllib.error.URLError) as exc:
            self._json({"error": str(exc)}, 400)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--lan", action="store_true", help="also listen on the local network")
    parser.add_argument("--debug", action="store_true", help="enable host-only contest time controls")
    args = parser.parse_args()
    CLOCK.start()
    LAN_ENABLED = args.lan
    DEBUG_ENABLED = args.debug
    host = "0.0.0.0" if args.lan else HOST
    print(f"Open http://{HOST}:{args.port}", flush=True)
    print(f"Project root: {ROOT}", flush=True)
    try:
        downloaded_count = len(list_contests())
    except (OSError, ValueError, json.JSONDecodeError):
        downloaded_count = "scan failed"
    print(f"Contest data: {downloaded_count} downloaded", flush=True)
    clock = CLOCK.status()
    print(f"Clock: {clock['source']} (system offset {clock['system_offset_ms']} ms)" if clock["synchronized"] else "Clock: system fallback; network time unavailable", flush=True)
    if args.lan:
        addresses = lan_addresses()
        for address in addresses:
            print(f"LAN viewers: http://{address}:{args.port}", flush=True)
        if not addresses:
            print("LAN enabled. Use this computer's private IPv4 address.", flush=True)
    ThreadingHTTPServer((host, args.port), Handler).serve_forever()
