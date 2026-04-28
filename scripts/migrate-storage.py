#!/usr/bin/env python3
"""
S10a-3: copy all Supabase Storage buckets + objects from SOURCE to TARGET.

Supabase Storage isn't part of pg_dump, so we clone it via the REST API.

What it does:
  1. Lists every bucket on SOURCE.
  2. Creates the matching bucket on TARGET if missing (preserving public flag,
     file_size_limit, allowed_mime_types).
  3. For every object in every source bucket:
     - If the object already exists on TARGET with the same size, skip.
     - Otherwise download from SOURCE, upload to TARGET (preserving content-type).
  4. Reports: buckets processed, objects copied, objects skipped, total bytes.

Idempotent: safe to re-run. Use --refresh to force re-upload even when the
target object matches (useful for the cutover delta pass).

Usage:
  SOURCE_URL=https://faklxfakgzkpkbxfihzh.supabase.co \\
  SOURCE_KEY=<service_role_key> \\
  TARGET_URL=https://gvbvwcnmjkdpclcisqrr.supabase.co \\
  TARGET_KEY=<service_role_key> \\
    python3 scripts/migrate-storage.py [--refresh] [--bucket=cover-images]

The service role key is required (RLS would block cross-bucket listing).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

MAX_CONCURRENCY = 5
TIMEOUT = 60  # seconds per HTTP call
LIST_PAGE_SIZE = 1000


@dataclass
class Endpoint:
    url: str
    key: str

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.key}",
            "apikey": self.key,
        }


def _request(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes | None = None,
    content_type: str | None = None,
    expect_json: bool = True,
) -> tuple[int, bytes, dict[str, str]]:
    req_headers = dict(headers)
    if content_type:
        req_headers["Content-Type"] = content_type
    req = Request(url, data=body, method=method, headers=req_headers)
    try:
        with urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except HTTPError as e:
        return e.code, e.read(), dict(e.headers or {})
    except URLError as e:
        raise SystemExit(f"network error on {method} {url}: {e}")


def list_buckets(ep: Endpoint) -> list[dict]:
    status, body, _ = _request("GET", f"{ep.url}/storage/v1/bucket", ep.headers)
    if status != 200:
        raise SystemExit(f"list buckets failed ({status}): {body[:200]!r}")
    return json.loads(body)


def create_bucket(ep: Endpoint, b: dict) -> None:
    payload = {
        "id": b["name"],
        "name": b["name"],
        "public": b.get("public", False),
    }
    if b.get("file_size_limit") is not None:
        payload["file_size_limit"] = b["file_size_limit"]
    if b.get("allowed_mime_types") is not None:
        payload["allowed_mime_types"] = b["allowed_mime_types"]
    status, body, _ = _request(
        "POST",
        f"{ep.url}/storage/v1/bucket",
        ep.headers,
        body=json.dumps(payload).encode("utf-8"),
        content_type="application/json",
    )
    if status not in (200, 201):
        raise SystemExit(f"create bucket {b['name']} failed ({status}): {body[:200]!r}")


def list_objects(ep: Endpoint, bucket: str) -> list[dict]:
    """Recursively list every object in a bucket."""

    def _list(prefix: str) -> list[dict]:
        offset = 0
        out = []
        while True:
            payload = {
                "prefix": prefix,
                "limit": LIST_PAGE_SIZE,
                "offset": offset,
            }
            status, body, _ = _request(
                "POST",
                f"{ep.url}/storage/v1/object/list/{bucket}",
                ep.headers,
                body=json.dumps(payload).encode("utf-8"),
                content_type="application/json",
            )
            if status != 200:
                raise SystemExit(
                    f"list {bucket}/{prefix} failed ({status}): {body[:200]!r}"
                )
            page = json.loads(body)
            if not page:
                break
            for item in page:
                if item.get("id") is None:
                    # Folder marker — recurse
                    sub = (prefix + "/" + item["name"]).lstrip("/")
                    out.extend(_list(sub))
                else:
                    full_path = (prefix + "/" + item["name"]).lstrip("/")
                    item["full_path"] = full_path
                    out.append(item)
            if len(page) < LIST_PAGE_SIZE:
                break
            offset += LIST_PAGE_SIZE
        return out

    return _list("")


def object_info(ep: Endpoint, bucket: str, path: str) -> dict | None:
    """HEAD-ish: use the info endpoint to get object metadata if it exists."""
    url = f"{ep.url}/storage/v1/object/info/authenticated/{bucket}/{quote(path)}"
    status, body, _ = _request("GET", url, ep.headers)
    if status == 200:
        return json.loads(body)
    return None


def download(ep: Endpoint, bucket: str, path: str) -> tuple[bytes, str]:
    url = f"{ep.url}/storage/v1/object/authenticated/{bucket}/{quote(path)}"
    status, body, headers = _request("GET", url, ep.headers, expect_json=False)
    if status != 200:
        raise RuntimeError(f"download {bucket}/{path} failed ({status}): {body[:200]!r}")
    content_type = headers.get("Content-Type", "application/octet-stream")
    return body, content_type


def upload(ep: Endpoint, bucket: str, path: str, body: bytes, content_type: str) -> None:
    url = f"{ep.url}/storage/v1/object/{bucket}/{quote(path)}"
    headers = dict(ep.headers)
    headers["x-upsert"] = "true"
    status, resp, _ = _request("POST", url, headers, body=body, content_type=content_type)
    if status not in (200, 201):
        raise RuntimeError(
            f"upload {bucket}/{path} failed ({status}): {resp[:200]!r}"
        )


def process_object(
    src: Endpoint,
    dst: Endpoint,
    bucket: str,
    obj: dict,
    refresh: bool,
) -> tuple[str, int, bool]:
    """Returns (action, bytes, success). action in {'copied','skipped','failed'}."""
    path = obj["full_path"]
    src_size = (obj.get("metadata") or {}).get("size") or 0

    if not refresh:
        existing = object_info(dst, bucket, path)
        if existing and (existing.get("size") or existing.get("metadata", {}).get("size")) == src_size:
            return "skipped", src_size, True

    try:
        body, content_type = download(src, bucket, path)
        upload(dst, bucket, path, body, content_type)
        return "copied", len(body), True
    except Exception as e:
        sys.stderr.write(f"  FAIL  {bucket}/{path}: {e}\n")
        return "failed", src_size, False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true",
                        help="re-upload even if target object has matching size")
    parser.add_argument("--bucket",
                        help="only process this bucket (default: all)")
    parser.add_argument("--dry-run", action="store_true",
                        help="list what would be copied; no writes")
    args = parser.parse_args()

    for var in ("SOURCE_URL", "SOURCE_KEY", "TARGET_URL", "TARGET_KEY"):
        if not os.environ.get(var):
            sys.exit(f"error: {var} env var required")

    src = Endpoint(os.environ["SOURCE_URL"].rstrip("/"), os.environ["SOURCE_KEY"])
    dst = Endpoint(os.environ["TARGET_URL"].rstrip("/"), os.environ["TARGET_KEY"])

    print(f"source: {src.url}")
    print(f"target: {dst.url}")
    print(f"mode:   {'refresh' if args.refresh else 'incremental'}"
          f"{' (dry-run)' if args.dry_run else ''}")
    print()

    src_buckets = list_buckets(src)
    dst_buckets = {b["name"]: b for b in list_buckets(dst)}

    if args.bucket:
        src_buckets = [b for b in src_buckets if b["name"] == args.bucket]
        if not src_buckets:
            sys.exit(f"no bucket named {args.bucket!r} on source")

    totals = {"copied": 0, "skipped": 0, "failed": 0, "bytes": 0}

    for b in src_buckets:
        name = b["name"]
        print(f"=== bucket: {name} ===")
        if name not in dst_buckets:
            if args.dry_run:
                print("  [dry-run] would create bucket on target")
            else:
                print("  creating on target")
                create_bucket(dst, b)
        objects = list_objects(src, name)
        print(f"  {len(objects)} objects")

        if args.dry_run:
            for obj in objects:
                print(f"  [dry-run] would copy {name}/{obj['full_path']}")
            continue

        start = time.time()
        with ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as ex:
            futures = {
                ex.submit(process_object, src, dst, name, obj, args.refresh): obj
                for obj in objects
            }
            done = 0
            for fut in as_completed(futures):
                action, size, _ok = fut.result()
                totals[action] += 1
                totals["bytes"] += size
                done += 1
                if done % 50 == 0 or done == len(objects):
                    print(f"  [{done}/{len(objects)}] "
                          f"copied={totals['copied']} "
                          f"skipped={totals['skipped']} "
                          f"failed={totals['failed']}")
        elapsed = time.time() - start
        print(f"  done in {elapsed:.1f}s")

    print()
    print("=== summary ===")
    print(f"  copied:  {totals['copied']}")
    print(f"  skipped: {totals['skipped']}")
    print(f"  failed:  {totals['failed']}")
    print(f"  bytes:   {totals['bytes']:,}")
    return 0 if totals["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
