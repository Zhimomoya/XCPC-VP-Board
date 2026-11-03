"""Network-corrected wall clock anchored to a monotonic clock."""
from __future__ import annotations

import concurrent.futures
import email.utils
import socket
import struct
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

NTP_EPOCH = 2_208_988_800
NTP_HOSTS = ("ntp.ntsc.ac.cn", "ntp.aliyun.com", "time.windows.com")
HTTPS_TIME_URLS = ("https://qoj.ac/", "https://www.baidu.com/", "https://www.microsoft.com/")


def steady_seconds():
    clock_id = getattr(time, "CLOCK_BOOTTIME", None)
    if clock_id is not None and hasattr(time, "clock_gettime"):
        return time.clock_gettime(clock_id)
    return time.monotonic()


def ntp_sample(host):
    started = steady_seconds()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
        client.settimeout(2)
        client.sendto(b"\x1b" + 47 * b"\0", (host, 123))
        payload, _ = client.recvfrom(512)
    finished = steady_seconds()
    if len(payload) < 48:
        raise ValueError("NTP response is too short")
    seconds, fraction = struct.unpack("!II", payload[40:48])
    transmitted_ms = (seconds - NTP_EPOCH + fraction / 2**32) * 1000
    return transmitted_ms + (finished - started) * 500, finished, f"NTP {host}", (finished - started) * 500


def https_sample(url):
    started = steady_seconds()
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "XCPC-VP-Clock/1.0"})
    try:
        response = urllib.request.urlopen(request, timeout=3)
    except urllib.error.HTTPError as error:
        response = error
    finished = steady_seconds()
    value = response.headers.get("Date")
    response.close()
    parsed = email.utils.parsedate_to_datetime(value) if value else None
    if parsed is None:
        raise ValueError("HTTPS response has no Date header")
    transmitted_ms = parsed.timestamp() * 1000
    # HTTP Date has one-second resolution, so uncertainty cannot be below 500 ms.
    uncertainty = max(500, (finished - started) * 500)
    return transmitted_ms + (finished - started) * 500, finished, f"HTTPS {urlparse(url).hostname}", uncertainty


class StableClock:
    def __init__(self):
        self._lock = threading.Lock()
        self._anchor_ms = time.time() * 1000
        self._anchor_steady = steady_seconds()
        self._source = "system"
        self._synchronized = False
        self._last_sync_ms = None
        self._uncertainty_ms = None

    def now_ms(self):
        with self._lock:
            return round(self._anchor_ms + (steady_seconds() - self._anchor_steady) * 1000)

    def status(self):
        now = self.now_ms()
        with self._lock:
            return {
                "synchronized": self._synchronized,
                "source": self._source,
                "last_sync_ms": self._last_sync_ms,
                "uncertainty_ms": self._uncertainty_ms,
                "system_offset_ms": round(now - time.time() * 1000),
            }

    def _apply(self, epoch_ms, source, uncertainty_ms):
        with self._lock:
            self._anchor_ms = float(epoch_ms)
            self._anchor_steady = steady_seconds()
            self._source = source
            self._synchronized = True
            self._last_sync_ms = round(epoch_ms)
            self._uncertainty_ms = round(uncertainty_ms)

    def synchronize(self):
        tasks = [(ntp_sample, host) for host in NTP_HOSTS] + [(https_sample, url) for url in HTTPS_TIME_URLS]
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks), thread_name_prefix="clock-sync")
        futures = [pool.submit(function, argument) for function, argument in tasks]
        done, pending = concurrent.futures.wait(futures, timeout=3.5)
        samples = []
        for future in done:
            try:
                samples.append(future.result())
            except (OSError, ValueError, urllib.error.URLError, TimeoutError):
                pass
        for future in pending:
            future.cancel()
        pool.shutdown(wait=False, cancel_futures=True)
        if not samples:
            return False
        reference_steady = steady_seconds()
        samples = [
            (epoch_ms + (reference_steady - sampled_steady) * 1000, source, uncertainty)
            for epoch_ms, sampled_steady, source, uncertainty in samples
        ]
        samples.sort(key=lambda item: item[0])
        epoch_ms, source, uncertainty = samples[len(samples) // 2]
        self._apply(epoch_ms, source, uncertainty)
        return True

    def start(self):
        self.synchronize()

        def refresh_loop():
            while True:
                time.sleep(300)
                self.synchronize()

        threading.Thread(target=refresh_loop, name="clock-refresh", daemon=True).start()


CLOCK = StableClock()
