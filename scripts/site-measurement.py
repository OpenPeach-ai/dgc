#!/usr/bin/env python3
"""Fetch, validate, and promote the reviewed public Marketplace install snapshot."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
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
UTC = dt.timezone.utc


class MeasurementError(ValueError):
    """A Marketplace response or snapshot operation failed closed."""


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


def iso(value: dt.datetime) -> str:
    return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_json(path: Path, value: Any) -> None:
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
        os.chmod(temp_path, 0o644)
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
    unavailable = {"schema_version": 1, "marketplace": {"status": "unavailable"}}
    assert marketplace_unavailable(unavailable)
    assert merge_marketplace_histories([unavailable, snap], now=observed) == [
        {"observed_at": "2026-09-04T12:00:00Z", "install_count": 12},
    ]
    malformed_time = json.loads(json.dumps(snap))
    malformed_time["marketplace"]["observed_at"] = 123
    try:
        validate_marketplace_snapshot(malformed_time, now=observed)
    except MeasurementError:
        pass
    else:
        raise AssertionError("non-string marketplace timestamp was accepted")
    try:
        require_non_decreasing(13, 12)
    except MeasurementError:
        pass
    else:
        raise AssertionError("marketplace count regression was accepted")
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

    commands.add_parser(
        "self-test", help="exercise Marketplace parsing, history merging, and unavailable-data behavior",
    )
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
        else:
            self_test()
            print("site measurement self-test passed")
    except MeasurementError as exc:
        print(f"site measurement failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
