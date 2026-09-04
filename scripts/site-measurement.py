#!/usr/bin/env python3
"""Fetch reviewed public metrics and calculate privacy-safe site conversion reports.

The marketplace snapshot is safe to commit. Analytics reports are aggregate-only
and default to ``output/``, which is gitignored; API credentials are read only
from environment variables and are never accepted as command-line values.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
MARKETPLACE_ENDPOINT = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery"
MARKETPLACE_LISTING = "https://marketplace.visualstudio.com/items?itemName=vibedgc.dgc"
MARKETPLACE_PUBLISHER = "vibedgc"
MARKETPLACE_EXTENSION = "dgc"
MARKETPLACE_ITEM = f"{MARKETPLACE_PUBLISHER}.{MARKETPLACE_EXTENSION}"
DEFAULT_MARKETPLACE_OUTPUT = ROOT / "site-src" / "data" / "site-metrics.json"
DEFAULT_REPORT_OUTPUT = ROOT / "output" / "site-measurement" / "conversion-report.json"
UTC = dt.timezone.utc
ANALYTICS_RETENTION_SAFE_DAYS = 90
MARKETPLACE_BOUNDARY_MAX_LAG_HOURS = 48


class MeasurementError(ValueError):
    """A metric response or reporting request failed closed."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward metrics request headers, especially authorization, across redirects."""

    def redirect_request(self, request, file_pointer, code, message, headers, new_url):  # noqa: ANN001
        return None


def utc_now() -> dt.datetime:
    return dt.datetime.now(UTC)


def instant(value: Any, label: str) -> dt.datetime:
    if not isinstance(value, str):
        raise MeasurementError(f"{label} must be an ISO-8601 timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise MeasurementError(f"{label} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise MeasurementError(f"{label} must include a timezone")
    return parsed.astimezone(UTC)


def boundary(value: Any, label: str) -> dt.datetime:
    if not isinstance(value, str):
        raise MeasurementError(f"{label} must use YYYY-MM-DD")
    try:
        parsed = dt.datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=UTC)
    except (TypeError, ValueError) as exc:
        raise MeasurementError(f"{label} must use YYYY-MM-DD") from exc
    return parsed


def iso(value: dt.datetime) -> str:
    return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_json(path: Path, value: Any, *, private: bool = False) -> None:
    """Atomically replace a JSON file only after the complete value is valid."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, stat.S_IRUSR | stat.S_IWUSR if private else 0o644)
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MeasurementError(f"could not read valid JSON from {path}") from exc


def marketplace_request() -> urllib.request.Request:
    payload = {
        "filters": [{
            "criteria": [{"filterType": 7, "value": MARKETPLACE_ITEM}],
            "pageNumber": 1,
            "pageSize": 1,
            "sortBy": 0,
            "sortOrder": 0,
        }],
        "assetTypes": [],
        # Microsoft gallery query flag for public statistics only.
        "flags": 256,
    }
    return urllib.request.Request(
        MARKETPLACE_ENDPOINT,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "accept": "application/json;api-version=7.2-preview.1",
            "content-type": "application/json",
            "user-agent": "dgc-site-metrics/1",
        },
        method="POST",
    )


def fetch_json(request: urllib.request.Request, *, timeout: float = 20) -> Any:
    try:
        opener = urllib.request.build_opener(NoRedirect())
        with opener.open(request, timeout=timeout) as response:
            if response.geturl() != request.full_url:
                raise MeasurementError("remote metrics API redirected unexpectedly")
            raw = response.read(2_000_001)
    except urllib.error.HTTPError as exc:
        raise MeasurementError(f"remote metrics API returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise MeasurementError("remote metrics API is unavailable") from exc
    if len(raw) > 2_000_000:
        raise MeasurementError("remote metrics response exceeded 2 MB")
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise MeasurementError("remote metrics API returned invalid JSON") from exc


def marketplace_snapshot(payload: Any, observed_at: dt.datetime) -> dict[str, Any]:
    """Extract only the public install statistic for the exact DGC listing."""
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
        raise MeasurementError("marketplace response did not contain exactly one result group")
    extensions = results[0].get("extensions")
    if not isinstance(extensions, list) or len(extensions) != 1 \
            or not isinstance(extensions[0], dict):
        raise MeasurementError("marketplace response did not identify exactly one extension")
    extension = extensions[0]
    publisher_object = extension.get("publisher")
    publisher = publisher_object.get("publisherName") if isinstance(publisher_object, dict) else None
    name = extension.get("extensionName")
    if publisher != MARKETPLACE_PUBLISHER or name != MARKETPLACE_EXTENSION:
        raise MeasurementError("marketplace response identity does not match vibedgc.dgc")
    statistics = extension.get("statistics")
    if not isinstance(statistics, list):
        raise MeasurementError("marketplace response omitted public statistics")
    installs = [row.get("value") for row in statistics
                if isinstance(row, dict) and row.get("statisticName") == "install"]
    if len(installs) != 1 or isinstance(installs[0], bool) or not isinstance(installs[0], (int, float)):
        raise MeasurementError("marketplace response omitted a numeric install statistic")
    value = float(installs[0])
    if not math.isfinite(value) or value < 0 or not value.is_integer():
        raise MeasurementError("marketplace install statistic is not a non-negative integer")
    updated = extension.get("lastUpdated")
    if not isinstance(updated, str):
        raise MeasurementError("marketplace response omitted its update timestamp")
    updated_at = instant(updated, "marketplace lastUpdated")
    if updated_at > observed_at.astimezone(UTC) + dt.timedelta(minutes=5):
        raise MeasurementError("marketplace listing update timestamp is in the future")
    observed_text = iso(observed_at)
    install_count = int(value)
    return {
        "schema_version": 1,
        "marketplace": {
            "status": "available",
            "publisher": MARKETPLACE_PUBLISHER,
            "extension": MARKETPLACE_EXTENSION,
            "install_count": install_count,
            "observed_at": observed_text,
            "listing_updated_at": updated,
            "source": "visual-studio-marketplace-gallery-api",
            "source_url": MARKETPLACE_LISTING,
            "history": [{"observed_at": observed_text, "install_count": install_count}],
        },
    }


def require_non_decreasing(previous: int | None, current: int) -> None:
    if previous is not None and current < previous:
        raise MeasurementError(
            "marketplace install count decreased; preserve the old snapshot and review the listing reset",
        )


def validate_marketplace_snapshot(value: Any, *, now: dt.datetime | None = None,
                                  max_age_hours: float | None = None) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise MeasurementError("marketplace snapshot has an unsupported schema")
    metric = value.get("marketplace")
    if not isinstance(metric, dict) or metric.get("status") != "available":
        raise MeasurementError("marketplace snapshot is not available")
    if metric.get("publisher") != MARKETPLACE_PUBLISHER or metric.get("extension") != MARKETPLACE_EXTENSION:
        raise MeasurementError("marketplace snapshot identity does not match vibedgc.dgc")
    count = metric.get("install_count")
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise MeasurementError("marketplace snapshot install_count is invalid")
    observed = instant(metric.get("observed_at", ""), "marketplace observed_at")
    current = (now or utc_now()).astimezone(UTC)
    if observed > current + dt.timedelta(minutes=5):
        raise MeasurementError("marketplace snapshot timestamp is in the future")
    if max_age_hours is not None and current - observed > dt.timedelta(hours=max_age_hours):
        raise MeasurementError(f"marketplace snapshot is older than {max_age_hours:g} hours")
    if metric.get("source") != "visual-studio-marketplace-gallery-api" \
            or metric.get("source_url") != MARKETPLACE_LISTING:
        raise MeasurementError("marketplace snapshot source is invalid")
    listing_updated = instant(metric.get("listing_updated_at", ""), "marketplace listing_updated_at")
    if listing_updated > observed + dt.timedelta(minutes=5):
        raise MeasurementError("marketplace listing update timestamp is after observation")
    history = metric.get("history")
    if not isinstance(history, list) or not history:
        raise MeasurementError("marketplace snapshot omits its observation history")
    previous_time: dt.datetime | None = None
    previous_count: int | None = None
    for item in history:
        if not isinstance(item, dict) or set(item) != {"observed_at", "install_count"}:
            raise MeasurementError("marketplace history contains an invalid observation")
        item_count = item.get("install_count")
        if isinstance(item_count, bool) or not isinstance(item_count, int) or item_count < 0:
            raise MeasurementError("marketplace history contains an invalid install count")
        item_time = instant(item.get("observed_at"), "marketplace history observed_at")
        if item_time > current + dt.timedelta(minutes=5):
            raise MeasurementError("marketplace history contains a future observation")
        if previous_time is not None and item_time <= previous_time:
            raise MeasurementError("marketplace history timestamps are not strictly increasing")
        if previous_count is not None and item_count < previous_count:
            raise MeasurementError("marketplace history install counts decreased")
        previous_time, previous_count = item_time, item_count
    if previous_time != observed or previous_count != count:
        raise MeasurementError("marketplace current value does not match its latest history observation")
    return metric


def merge_marketplace_histories(values: list[Any], *, now: dt.datetime | None = None) -> list[dict[str, Any]]:
    """Merge validated snapshot histories without hiding forks or count regressions."""
    current = (now or utc_now()).astimezone(UTC)
    observations: dict[dt.datetime, int] = {}
    for value in values:
        if marketplace_unavailable(value):
            continue
        metric = validate_marketplace_snapshot(value, now=current)
        for item in metric["history"]:
            observed = instant(item["observed_at"], "marketplace history observed_at")
            count = item["install_count"]
            previous = observations.get(observed)
            if previous is not None and previous != count:
                raise MeasurementError(
                    "marketplace histories disagree at the same observation timestamp",
                )
            observations[observed] = count
    merged = []
    previous_count: int | None = None
    for observed, count in sorted(observations.items()):
        require_non_decreasing(previous_count, count)
        merged.append({"observed_at": iso(observed), "install_count": count})
        previous_count = count
    return merged


def promote_marketplace_snapshot(candidate: Any, committed: Any | None, *,
                                 now: dt.datetime | None = None,
                                 max_age_hours: float | None = None) -> dict[str, Any]:
    """Merge a reviewed workflow candidate into the committed public snapshot."""
    current = (now or utc_now()).astimezone(UTC)
    candidate_metric = validate_marketplace_snapshot(
        candidate, now=current, max_age_hours=max_age_hours,
    )
    snapshots = [candidate]
    if committed is not None:
        if not marketplace_unavailable(committed):
            committed_metric = validate_marketplace_snapshot(committed, now=current)
            if instant(candidate_metric["observed_at"], "candidate observed_at") \
                    < instant(committed_metric["observed_at"], "committed observed_at"):
                raise MeasurementError("marketplace candidate is older than the committed snapshot")
        snapshots.insert(0, committed)
    history = merge_marketplace_histories(snapshots, now=current)
    latest = history[-1] if history else None
    expected_latest = {
        "observed_at": candidate_metric["observed_at"],
        "install_count": candidate_metric["install_count"],
    }
    if latest != expected_latest:
        raise MeasurementError("marketplace candidate is not the latest merged observation")
    promoted = json.loads(json.dumps(candidate))
    promoted["marketplace"]["history"] = history
    validate_marketplace_snapshot(promoted, now=current, max_age_hours=max_age_hours)
    return promoted


def marketplace_unavailable(value: Any) -> bool:
    """Recognize the only allowed no-claim fallback representation."""
    return isinstance(value, dict) and value.get("schema_version") == 1 \
        and value.get("marketplace") == {"status": "unavailable"}


def validate_dataset(dataset: str) -> None:
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", dataset):
        raise MeasurementError("dataset must be a simple Analytics Engine identifier")


def analytics_query(dataset: str, start: dt.datetime, end: dt.datetime) -> str:
    validate_dataset(dataset)
    begin = start.strftime("%Y-%m-%d %H:%M:%S")
    finish = end.strftime("%Y-%m-%d %H:%M:%S")
    return f"""SELECT
  formatDateTime(timestamp, '%Y-%m-%d', 'Etc/UTC') AS day,
  index1 AS event,
  SUM(_sample_interval * double1) AS count
FROM {dataset}
WHERE timestamp >= toDateTime('{begin}', 'Etc/UTC')
  AND timestamp < toDateTime('{finish}', 'Etc/UTC')
  AND blob1 = 'vibedgc.com'
  AND blob2 = '/'
  AND (blob3 = 'desktop' OR blob3 = 'mobile')
  AND (index1 = 'page_view' OR index1 = 'install_copy')
GROUP BY day, event
ORDER BY day, event
FORMAT JSON"""


def fetch_analytics(dataset: str, start: dt.datetime, end: dt.datetime,
                    account_env: str, token_env: str) -> Any:
    account = os.environ.get(account_env, "")
    token = os.environ.get(token_env, "")
    if not re.fullmatch(r"[0-9a-fA-F]{32}", account):
        raise MeasurementError(f"{account_env} must contain a 32-character Cloudflare account id")
    if not token:
        raise MeasurementError(f"{token_env} is not set")
    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}/analytics_engine/sql",
        data=analytics_query(dataset, start, end).encode("utf-8"),
        headers={"authorization": f"Bearer {token}", "content-type": "text/plain; charset=utf-8",
                 "user-agent": "dgc-site-metrics/1"},
        method="POST",
    )
    return fetch_json(request)


def validate_fetch_window(start: dt.datetime, end: dt.datetime,
                          now: dt.datetime | None = None) -> None:
    current = (now or utc_now()).astimezone(UTC)
    if start >= end:
        raise MeasurementError("analytics fetch window must have a positive duration")
    if end > current:
        raise MeasurementError("analytics fetch window cannot end in the future")
    if current - start > dt.timedelta(days=ANALYTICS_RETENTION_SAFE_DAYS):
        raise MeasurementError(
            "analytics fetch starts outside the 90-day safe retention window; "
            "use a previously saved aggregate input for the baseline",
        )


def payload_rows(payload: Any) -> list[Any]:
    rows = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise MeasurementError("analytics response must be a row list or a JSON data object")
    return rows


def aggregate_snapshot(value: Any, expected_dataset: str,
                       generated_at: dt.datetime) -> tuple[dt.datetime, dt.datetime, list[Any]]:
    if not isinstance(value, dict) or value.get("schema_version") != 1 \
            or value.get("source") != "cloudflare-analytics-engine-aggregate":
        raise MeasurementError("saved analytics input has an unsupported schema or source")
    if value.get("dataset") != expected_dataset:
        raise MeasurementError("saved analytics input dataset does not match --dataset")
    collected = instant(value.get("collected_at"), "analytics collected_at")
    window = value.get("window")
    if not isinstance(window, dict):
        raise MeasurementError("saved analytics input omits its declared window")
    start = instant(window.get("start"), "analytics window start")
    end = instant(window.get("end"), "analytics window end")
    if start.time() != dt.time() or end.time() != dt.time() or start >= end:
        raise MeasurementError("saved analytics input must declare a positive whole-day UTC window")
    if collected < end or collected > generated_at + dt.timedelta(minutes=5):
        raise MeasurementError("saved analytics input collection time is incompatible with its window")
    aggregate_rows(value, start, end)
    return start, end, payload_rows(value)


def merge_aggregate_snapshots(values: list[Any], expected_dataset: str,
                              required_start: dt.datetime, required_end: dt.datetime,
                              generated_at: dt.datetime) -> dict[str, list[Any]]:
    snapshots = sorted(
        (aggregate_snapshot(value, expected_dataset, generated_at) for value in values),
        key=lambda item: item[0],
    )
    if not snapshots:
        raise MeasurementError("at least one saved analytics input is required")
    cursor = required_start
    rows: list[Any] = []
    for start, end, snapshot_rows in snapshots:
        if start != cursor or end > required_end:
            raise MeasurementError(
                "saved analytics input windows must exactly and consecutively cover the requested window",
            )
        cursor = end
        rows.extend(snapshot_rows)
    if cursor < required_end:
        raise MeasurementError("saved analytics inputs do not cover the complete requested window")
    # Re-validating the merged rows catches duplicate day/event values at file boundaries.
    aggregate_rows({"data": rows}, required_start, required_end)
    return {"data": rows}


def aggregate_rows(payload: Any, start: dt.datetime, end: dt.datetime) -> dict[tuple[dt.date, str], float]:
    rows = payload_rows(payload)
    totals: dict[tuple[dt.date, str], float] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise MeasurementError("analytics response contains a non-object row")
        event = row.get("event")
        if not isinstance(event, str) or event not in {"page_view", "install_copy"}:
            raise MeasurementError("analytics response contains an unexpected event")
        try:
            day = dt.date.fromisoformat(str(row.get("day")))
        except ValueError as exc:
            raise MeasurementError("analytics response contains an invalid day") from exc
        count = row.get("count")
        if isinstance(count, str) and re.fullmatch(r"\d+(?:\.\d+)?", count):
            count = float(count)
        if isinstance(count, bool) or not isinstance(count, (int, float)):
            raise MeasurementError("analytics response contains a non-numeric count")
        number = float(count)
        if not math.isfinite(number) or number < 0:
            raise MeasurementError("analytics response contains an invalid count")
        if not (start.date() <= day < end.date()):
            raise MeasurementError("analytics response contains a day outside the requested window")
        key = (day, event)
        if key in totals:
            raise MeasurementError("analytics inputs overlap or contain duplicate day/event rows")
        totals[key] = number
    return totals


def conversion_counts(totals: dict[tuple[dt.date, str], float], start: dt.datetime,
                      end: dt.datetime) -> tuple[float, float, list[dt.date]]:
    days = [start.date() + dt.timedelta(days=offset) for offset in range((end - start).days)]
    landings = sum(totals.get((day, "page_view"), 0) for day in days)
    copies = sum(totals.get((day, "install_copy"), 0) for day in days)
    return landings, copies, days


def conversion_window(totals: dict[tuple[dt.date, str], float], start: dt.datetime,
                      end: dt.datetime) -> dict[str, Any]:
    landings, copies, days = conversion_counts(totals, start, end)
    observed_days = sum(totals.get((day, "page_view"), 0) > 0 for day in days)
    available = landings > 0
    complete_daily_coverage = observed_days == len(days)
    return {
        "start": iso(start),
        "end": iso(end),
        "status": "available" if available else "unavailable",
        "days_with_observed_home_landings": observed_days,
        "window_days": len(days),
        "complete_daily_coverage": complete_daily_coverage,
        "coverage": "observed-every-day" if observed_days == len(days)
                    else "partially-observed" if observed_days else "no-landing-data",
        "estimated_home_landings": round(landings, 2),
        "estimated_install_command_copies": round(copies, 2),
        "copies_per_100_home_landings": round(100 * copies / landings, 2) if available else None,
    }


def marketplace_boundary(metric: dict[str, Any], boundary_at: dt.datetime) -> dict[str, Any] | None:
    candidates = []
    for item in metric["history"]:
        observed = instant(item["observed_at"], "marketplace history observed_at")
        if boundary_at <= observed <= boundary_at + dt.timedelta(hours=MARKETPLACE_BOUNDARY_MAX_LAG_HOURS):
            candidates.append((observed, item["install_count"]))
    if not candidates:
        return None
    observed, count = min(candidates, key=lambda item: item[0])
    return {
        "target_boundary": iso(boundary_at),
        "observed_at": iso(observed),
        "cumulative_install_count": count,
    }


def marketplace_interval(metric: dict[str, Any], start: dt.datetime,
                         end: dt.datetime) -> dict[str, Any]:
    first = marketplace_boundary(metric, start)
    last = marketplace_boundary(metric, end)
    if first is None or last is None:
        return {
            "start": iso(start),
            "end": iso(end),
            "status": "unavailable",
            "start_observation": first,
            "end_observation": last,
            "reported_install_count_delta": None,
        }
    return {
        "start": iso(start),
        "end": iso(end),
        "status": "available",
        "start_observation": first,
        "end_observation": last,
        "reported_install_count_delta": (
            last["cumulative_install_count"] - first["cumulative_install_count"]
        ),
    }


def marketplace_install_report(value: Any | None, baseline_start: dt.datetime,
                               baseline_end: dt.datetime, period_end: dt.datetime,
                               generated_at: dt.datetime) -> dict[str, Any]:
    if value is None or marketplace_unavailable(value):
        return {
            "status": "unavailable",
            "reason": "no validated marketplace history was supplied",
            "metric": "install",
            "baseline": None,
            "weeks": [],
        }
    metric = validate_marketplace_snapshot(value, now=generated_at)
    baseline = marketplace_interval(metric, baseline_start, baseline_end)
    baseline_delta = baseline["reported_install_count_delta"]
    weeks = []
    cursor = baseline_end
    while cursor < period_end:
        next_cursor = cursor + dt.timedelta(days=7)
        week = marketplace_interval(metric, cursor, next_cursor)
        delta = week["reported_install_count_delta"]
        comparable = baseline_delta is not None and baseline_delta > 0 and delta is not None
        week["delta_vs_baseline"] = delta - baseline_delta \
            if baseline_delta is not None and delta is not None else None
        week["multiple_vs_baseline"] = round(delta / baseline_delta, 4) if comparable else None
        week["meets_two_x_baseline"] = bool(delta >= 2 * baseline_delta) if comparable else None
        weeks.append(week)
        cursor = next_cursor
    all_available = baseline["status"] == "available" \
        and all(week["status"] == "available" for week in weeks)
    any_available = baseline["status"] == "available" \
        or any(week["status"] == "available" for week in weeks)
    return {
        "status": "available" if all_available else "partially-available" if any_available else "unavailable",
        "metric": "install",
        "source": "visual-studio-marketplace-gallery-api",
        "source_url": MARKETPLACE_LISTING,
        "boundary_rule": (
            "earliest validated cumulative install observation at or within "
            f"{MARKETPLACE_BOUNDARY_MAX_LAG_HOURS} hours after each UTC boundary"
        ),
        "interpretation": (
            "Changes are deltas in the Marketplace's reported install-count statistic; "
            "they are not asserted to be unique new users or download counts."
        ),
        "baseline": baseline,
        "weeks": weeks,
    }


def conversion_report(payload: Any, first_complete_day: dt.datetime,
                      baseline_start: dt.datetime, baseline_end: dt.datetime,
                      period_start: dt.datetime, period_end: dt.datetime,
                      generated_at: dt.datetime) -> dict[str, Any]:
    generated_at = generated_at.astimezone(UTC)
    if first_complete_day > baseline_start:
        raise MeasurementError("baseline cannot start before the first complete UTC telemetry day")
    if baseline_end - baseline_start != dt.timedelta(days=7):
        raise MeasurementError("baseline must be exactly seven UTC days")
    if period_start != baseline_end:
        raise MeasurementError("weekly reporting must begin exactly when the baseline ends")
    duration = period_end - period_start
    if duration <= dt.timedelta(0) or duration.days % 7 or duration.seconds:
        raise MeasurementError("reporting period must contain complete seven-day UTC windows")
    if max(baseline_end, period_end) > generated_at:
        raise MeasurementError("baseline and weekly windows must be complete, not future or partial")
    query_start = min(baseline_start, period_start)
    query_end = max(baseline_end, period_end)
    totals = aggregate_rows(payload, query_start, query_end)
    baseline = conversion_window(totals, baseline_start, baseline_end)
    baseline_landings, baseline_copies, _ = conversion_counts(totals, baseline_start, baseline_end)
    weeks = []
    cursor = period_start
    while cursor < period_end:
        next_cursor = cursor + dt.timedelta(days=7)
        week = conversion_window(totals, cursor, next_cursor)
        week_landings, week_copies, _ = conversion_counts(totals, cursor, next_cursor)
        comparable = (
            baseline["complete_daily_coverage"]
            and week["complete_daily_coverage"]
            and baseline_landings > 0
            and baseline_copies > 0
            and week_landings > 0
        )
        week["multiple_vs_baseline"] = round(
            (week_copies * baseline_landings) / (week_landings * baseline_copies), 2,
        ) if comparable else None
        week["meets_two_x_baseline"] = bool(
            week_copies * baseline_landings >= 2 * baseline_copies * week_landings
        ) if comparable else None
        cursor = next_cursor
        weeks.append(week)
    return {
        "schema_version": 1,
        "generated_at": iso(generated_at),
        "first_complete_telemetry_day": iso(first_complete_day),
        "source": "cloudflare-analytics-engine-aggregate",
        "sampling_adjusted_estimates": True,
        "privacy": "aggregate counts only; DNT and GPC requests are excluded at collection",
        "definition": {
            "home_landing": "page_view on vibedgc.com path /",
            "install_command_copy": "install_copy on vibedgc.com path /",
            "rate": "100 * install_command_copies / home_landings",
            "unit": "sampling-adjusted event estimates, not unique people",
            "target": "weekly rate at least 2.0 times the baseline rate",
            "complete_daily_coverage": (
                "at least one positive sampling-adjusted home page_view observation on every "
                "UTC day in both the seven-day baseline and the compared seven-day week"
            ),
        },
        "coverage_note": (
            "A 2x verdict is withheld unless both seven-day windows have complete daily coverage. "
            "Observed days show event presence, not an independent telemetry-uptime guarantee."
        ),
        "baseline": baseline,
        "weeks": weeks,
    }


def self_test() -> None:
    observed = dt.datetime(2026, 9, 4, 12, tzinfo=UTC)
    assert NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://example.test/") is None
    extension = {
        "publisher": {"publisherName": MARKETPLACE_PUBLISHER},
        "extensionName": MARKETPLACE_EXTENSION,
        "lastUpdated": "2026-09-04T11:00:00Z",
        "statistics": [{"statisticName": "install", "value": 12.0}],
    }
    snap = marketplace_snapshot({"results": [{"extensions": [extension]}]}, observed)
    assert validate_marketplace_snapshot(snap, now=observed)["install_count"] == 12
    malformed_time = json.loads(json.dumps(snap))
    malformed_time["marketplace"]["observed_at"] = 123
    try:
        validate_marketplace_snapshot(malformed_time, now=observed)
    except MeasurementError:
        pass
    else:
        raise AssertionError("non-string marketplace timestamp was accepted")
    query = analytics_query("dgc_site_events", observed - dt.timedelta(days=7), observed)
    assert "SUM(_sample_interval * double1)" in query
    assert "blob3 = 'desktop' OR blob3 = 'mobile'" in query
    try:
        require_non_decreasing(13, 12)
    except MeasurementError:
        pass
    else:
        raise AssertionError("marketplace count regression was accepted")
    market_history = json.loads(json.dumps(snap))
    market_history["marketplace"].update({
        "install_count": 20,
        "observed_at": "2026-09-07T02:00:00Z",
        "history": [
            {"observed_at": "2026-08-24T02:00:00Z", "install_count": 7},
            {"observed_at": "2026-08-31T02:00:00Z", "install_count": 12},
            {"observed_at": "2026-09-07T02:00:00Z", "install_count": 20},
        ],
    })
    market_report = marketplace_install_report(
        market_history,
        boundary("2026-08-24", "baseline-start"), boundary("2026-08-31", "baseline-end"),
        boundary("2026-09-07", "period-end"), dt.datetime(2026, 9, 8, tzinfo=UTC),
    )
    assert market_report["baseline"]["reported_install_count_delta"] == 5
    assert market_report["weeks"][0]["reported_install_count_delta"] == 8
    assert market_report["weeks"][0]["delta_vs_baseline"] == 3
    assert market_report["weeks"][0]["multiple_vs_baseline"] == 1.6
    assert market_report["weeks"][0]["meets_two_x_baseline"] is False
    history_branch = json.loads(json.dumps(snap))
    history_branch["marketplace"].update({
        "install_count": 15,
        "observed_at": "2026-09-06T02:00:00Z",
        "history": [
            {"observed_at": "2026-09-05T02:00:00Z", "install_count": 13},
            {"observed_at": "2026-09-06T02:00:00Z", "install_count": 15},
        ],
    })
    merged_history = merge_marketplace_histories(
        [snap, history_branch, snap], now=dt.datetime(2026, 9, 7, tzinfo=UTC),
    )
    assert merged_history == [
        {"observed_at": "2026-09-04T12:00:00Z", "install_count": 12},
        {"observed_at": "2026-09-05T02:00:00Z", "install_count": 13},
        {"observed_at": "2026-09-06T02:00:00Z", "install_count": 15},
    ]
    promoted = promote_marketplace_snapshot(
        history_branch, snap, now=dt.datetime(2026, 9, 7, tzinfo=UTC),
        max_age_hours=48,
    )
    assert promoted["marketplace"]["history"] == merged_history
    try:
        promote_marketplace_snapshot(
            snap, history_branch, now=dt.datetime(2026, 9, 7, tzinfo=UTC),
            max_age_hours=None,
        )
    except MeasurementError:
        pass
    else:
        raise AssertionError("an older marketplace artifact replaced the committed snapshot")
    try:
        promote_marketplace_snapshot(
            history_branch, snap, now=dt.datetime(2026, 9, 8, 3, tzinfo=UTC),
            max_age_hours=48,
        )
    except MeasurementError:
        pass
    else:
        raise AssertionError("a stale marketplace artifact was promoted")
    regressed_history = json.loads(json.dumps(history_branch))
    regressed_history["marketplace"].update({
        "install_count": 11,
        "observed_at": "2026-09-06T03:00:00Z",
        "history": [{"observed_at": "2026-09-06T03:00:00Z", "install_count": 11}],
    })
    try:
        merge_marketplace_histories(
            [history_branch, regressed_history], now=dt.datetime(2026, 9, 7, tzinfo=UTC),
        )
    except MeasurementError:
        pass
    else:
        raise AssertionError("a regressing marketplace history merge was accepted")
    rows = {"data": [
        {"day": "2026-08-24", "event": "page_view", "count": 200},
        {"day": "2026-08-24", "event": "install_copy", "count": 10},
        {"day": "2026-08-31", "event": "page_view", "count": 400},
        {"day": "2026-08-31", "event": "install_copy", "count": 28},
    ]}
    report = conversion_report(
        rows, boundary("2026-08-24", "first-complete-day"),
        boundary("2026-08-24", "baseline-start"), boundary("2026-08-31", "baseline-end"),
        boundary("2026-08-31", "period-start"), boundary("2026-09-07", "period-end"),
        dt.datetime(2026, 9, 8, tzinfo=UTC),
    )
    assert report["baseline"]["copies_per_100_home_landings"] == 5.0
    assert report["weeks"][0]["copies_per_100_home_landings"] == 7.0
    assert report["baseline"]["complete_daily_coverage"] is False
    assert report["weeks"][0]["multiple_vs_baseline"] is None
    assert report["weeks"][0]["meets_two_x_baseline"] is None
    complete_rows = {"data": []}
    for offset in range(14):
        day = dt.date(2026, 8, 24) + dt.timedelta(days=offset)
        complete_rows["data"].append({
            "day": day.isoformat(), "event": "page_view",
            "count": 200 if offset < 7 else 400,
        })
        complete_rows["data"].append({
            "day": day.isoformat(), "event": "install_copy",
            "count": 10 if offset < 7 else 40,
        })
    complete_report = conversion_report(
        complete_rows, boundary("2026-08-24", "first-complete-day"),
        boundary("2026-08-24", "baseline-start"), boundary("2026-08-31", "baseline-end"),
        boundary("2026-08-31", "period-start"), boundary("2026-09-07", "period-end"),
        dt.datetime(2026, 9, 8, tzinfo=UTC),
    )
    assert complete_report["baseline"]["complete_daily_coverage"] is True
    assert complete_report["weeks"][0]["multiple_vs_baseline"] == 2.0
    assert complete_report["weeks"][0]["meets_two_x_baseline"] is True
    saved = {
        "schema_version": 1,
        "source": "cloudflare-analytics-engine-aggregate",
        "dataset": "dgc_site_events",
        "collected_at": "2026-09-07T01:00:00Z",
        "window": {"start": "2026-08-24T00:00:00Z", "end": "2026-09-07T00:00:00Z"},
        "data": rows["data"],
    }
    merged = merge_aggregate_snapshots(
        [saved], "dgc_site_events",
        boundary("2026-08-24", "start"), boundary("2026-09-07", "end"),
        dt.datetime(2026, 9, 8, tzinfo=UTC),
    )
    assert len(merged["data"]) == 4
    invalid_saved = dict(saved, schema_version=999)
    try:
        merge_aggregate_snapshots(
            [invalid_saved], "dgc_site_events",
            boundary("2026-08-24", "start"), boundary("2026-09-07", "end"),
            dt.datetime(2026, 9, 8, tzinfo=UTC),
        )
    except MeasurementError:
        pass
    else:
        raise AssertionError("untrusted analytics envelope was accepted")
    try:
        aggregate_rows(
            {"data": [{"day": "2026-08-24", "event": [], "count": 1}]},
            boundary("2026-08-24", "start"), boundary("2026-08-31", "end"),
        )
    except MeasurementError:
        pass
    else:
        raise AssertionError("non-string analytics event was accepted")
    empty = conversion_report(
        {"data": []}, boundary("2026-08-24", "first-complete-day"),
        boundary("2026-08-24", "baseline-start"), boundary("2026-08-31", "baseline-end"),
        boundary("2026-08-31", "period-start"), boundary("2026-09-07", "period-end"),
        dt.datetime(2026, 9, 8, tzinfo=UTC),
    )
    assert empty["baseline"]["status"] == "unavailable"
    assert empty["baseline"]["copies_per_100_home_landings"] is None
    try:
        conversion_report(
            rows, boundary("2026-08-24", "first-complete-day"),
            boundary("2026-08-24", "baseline-start"), boundary("2026-08-31", "baseline-end"),
            boundary("2026-08-31", "period-start"), boundary("2026-09-07", "period-end"),
            dt.datetime(2026, 9, 6, tzinfo=UTC),
        )
    except MeasurementError:
        pass
    else:
        raise AssertionError("future or partial reporting period was accepted")
    try:
        conversion_report(
            rows, boundary("2026-08-24", "first-complete-day"),
            boundary("2026-08-24", "baseline-start"), boundary("2026-08-31", "baseline-end"),
            boundary("2026-09-01", "period-start"), boundary("2026-09-08", "period-end"),
            dt.datetime(2026, 9, 9, tzinfo=UTC),
        )
    except MeasurementError:
        pass
    else:
        raise AssertionError("shifted weekly cadence was accepted")
    worker_source = (ROOT / "site" / "_worker.js").read_text(encoding="utf-8")
    browser_source = (ROOT / "site-src" / "assets" / "site.js").read_text(encoding="utf-8")
    docs_source = (ROOT / "scripts" / "generate-docs-site.py").read_text(encoding="utf-8")
    assert 'measure(env, "page_view"' in worker_source
    assert '"docs_getting_started_reached"' in worker_source
    assert "[data-page-event]" in browser_source
    assert 'data-page-event="docs_getting_started_reached"' in docs_source


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    refresh = commands.add_parser("refresh-marketplace", help="fetch a validated public install snapshot")
    refresh.add_argument("--output", type=Path, default=DEFAULT_MARKETPLACE_OUTPUT)
    refresh.add_argument("--response", type=Path, help="validate a saved gallery response instead of using the network")
    refresh.add_argument(
        "--history-input", type=Path, action="append", default=[], metavar="FILE",
        help="validated snapshot history to merge before appending the new observation; repeatable",
    )

    check = commands.add_parser("check-marketplace", help="validate a committed or generated snapshot")
    check.add_argument("--input", type=Path, default=DEFAULT_MARKETPLACE_OUTPUT)
    check.add_argument("--max-age-hours", type=float)
    check.add_argument(
        "--allow-unavailable", action="store_true",
        help="accept the exact neutral fallback object when the public API has no usable data",
    )

    promote = commands.add_parser(
        "promote-marketplace",
        help="validate and merge a reviewed workflow artifact into the committed snapshot",
    )
    promote.add_argument("--input", type=Path, required=True, help="downloaded workflow snapshot")
    promote.add_argument("--output", type=Path, default=DEFAULT_MARKETPLACE_OUTPUT)
    promote.add_argument(
        "--max-age-hours", type=float, default=48,
        help="reject a candidate older than this many hours (default: 48)",
    )

    collect = commands.add_parser(
        "collect-analytics", help="save a bounded aggregate Analytics Engine response for later reports",
    )
    collect.add_argument("--dataset", required=True, help="Analytics Engine dataset name")
    collect.add_argument("--start", required=True, help="inclusive UTC date, YYYY-MM-DD")
    collect.add_argument("--end", required=True, help="exclusive UTC date, YYYY-MM-DD")
    collect.add_argument("--account-id-env", default="CLOUDFLARE_ACCOUNT_ID")
    collect.add_argument("--api-token-env", default="CLOUDFLARE_ANALYTICS_TOKEN")
    collect.add_argument("--output", type=Path, required=True)

    report = commands.add_parser("report", help="produce baseline and weekly copies-per-100 aggregates")
    source = report.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--input", type=Path, action="append", metavar="FILE",
        help="saved aggregate response; repeat for consecutive retained windows",
    )
    source.add_argument("--fetch", action="store_true", help="query Analytics Engine with environment credentials")
    report.add_argument("--dataset", required=True, help="expected Analytics Engine dataset name")
    report.add_argument("--account-id-env", default="CLOUDFLARE_ACCOUNT_ID")
    report.add_argument("--api-token-env", default="CLOUDFLARE_ANALYTICS_TOKEN")
    report.add_argument(
        "--marketplace-input", type=Path,
        help="optional validated site-metrics.json history for cumulative install deltas",
    )
    report.add_argument(
        "--first-complete-day", required=True,
        help="first full UTC day after production telemetry activation, YYYY-MM-DD",
    )
    report.add_argument("--baseline-start", required=True, help="inclusive UTC date, YYYY-MM-DD")
    report.add_argument("--baseline-end", required=True, help="exclusive UTC date, exactly 7 days later")
    report.add_argument("--period-start", required=True, help="inclusive UTC date, equal to baseline end")
    report.add_argument("--period-end", required=True, help="exclusive UTC date, after complete 7-day windows")
    report.add_argument("--output", type=Path, default=DEFAULT_REPORT_OUTPUT)

    commands.add_parser("self-test", help="exercise parsers, unavailable-data behavior, and rate math")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.command == "refresh-marketplace":
            observed = utc_now()
            payload = load_json(args.response) if args.response else fetch_json(marketplace_request())
            snapshot = marketplace_snapshot(payload, observed)
            metric = validate_marketplace_snapshot(snapshot, now=observed)
            prior_snapshots = [load_json(path) for path in args.history_input]
            if args.output.exists():
                prior_snapshots.append(load_json(args.output))
            metric["history"] = merge_marketplace_histories(
                [*prior_snapshots, snapshot], now=observed,
            )
            validate_marketplace_snapshot(snapshot, now=observed)
            write_json(args.output, snapshot)
            print(f"wrote validated marketplace snapshot to {args.output}")
        elif args.command == "check-marketplace":
            candidate = load_json(args.input)
            if args.allow_unavailable and marketplace_unavailable(candidate):
                print("marketplace metric unavailable: neutral proof fallback is valid")
            else:
                metric = validate_marketplace_snapshot(
                    candidate, max_age_hours=args.max_age_hours,
                )
                print(f"marketplace snapshot valid: {metric['install_count']} reported installs")
        elif args.command == "promote-marketplace":
            candidate = load_json(args.input)
            committed = load_json(args.output) if args.output.exists() else None
            promoted = promote_marketplace_snapshot(
                candidate, committed, max_age_hours=args.max_age_hours,
            )
            write_json(args.output, promoted)
            print(f"promoted reviewed marketplace snapshot to {args.output}")
        elif args.command == "collect-analytics":
            start = boundary(args.start, "start")
            end = boundary(args.end, "end")
            observed = utc_now()
            validate_fetch_window(start, end, observed)
            payload = fetch_analytics(
                args.dataset, start, end, args.account_id_env, args.api_token_env,
            )
            aggregate_rows(payload, start, end)
            saved = {
                "schema_version": 1,
                "source": "cloudflare-analytics-engine-aggregate",
                "dataset": args.dataset,
                "collected_at": iso(observed),
                "window": {"start": iso(start), "end": iso(end)},
                "data": payload_rows(payload),
            }
            write_json(args.output, saved, private=True)
            print(f"wrote aggregate analytics input to {args.output}")
        elif args.command == "report":
            validate_dataset(args.dataset)
            first_complete_day = boundary(args.first_complete_day, "first-complete-day")
            baseline_start = boundary(args.baseline_start, "baseline-start")
            baseline_end = boundary(args.baseline_end, "baseline-end")
            period_start = boundary(args.period_start, "period-start")
            period_end = boundary(args.period_end, "period-end")
            query_start = min(baseline_start, period_start)
            query_end = max(baseline_end, period_end)
            observed = utc_now()
            if args.fetch:
                validate_fetch_window(query_start, query_end, observed)
                payload = fetch_analytics(
                    args.dataset, query_start, query_end, args.account_id_env, args.api_token_env,
                )
            else:
                payload = merge_aggregate_snapshots(
                    [load_json(path) for path in args.input], args.dataset,
                    query_start, query_end, observed,
                )
            result = conversion_report(
                payload, first_complete_day, baseline_start, baseline_end,
                period_start, period_end, observed,
            )
            result["dataset"] = args.dataset
            result["marketplace_installs"] = marketplace_install_report(
                load_json(args.marketplace_input) if args.marketplace_input else None,
                baseline_start, baseline_end, period_end, observed,
            )
            write_json(args.output, result, private=True)
            print(f"wrote aggregate conversion report to {args.output}")
        else:
            self_test()
            print("site measurement self-test passed")
    except MeasurementError as exc:
        print(f"site measurement failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
