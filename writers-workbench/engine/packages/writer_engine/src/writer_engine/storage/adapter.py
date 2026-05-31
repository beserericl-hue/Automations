"""Lightweight async helpers over Supabase Storage. Bucket choice is up to the caller."""

from __future__ import annotations

from writer_engine.supabase.client import get_supabase_admin


class StorageError(RuntimeError):
    pass


async def upload_text(
    *, bucket: str, path: str, content: str, content_type: str = "text/plain", upsert: bool = True
) -> str:
    """Upload a UTF-8 text blob and return its storage path."""
    client = await get_supabase_admin()
    file_options = {"content-type": content_type, "x-upsert": "true" if upsert else "false"}
    await client.storage.from_(bucket).upload(path, content.encode("utf-8"), file_options=file_options)  # type: ignore[arg-type]
    return path


async def download_text(*, bucket: str, path: str) -> str:
    """Download a text blob and return it as a string."""
    client = await get_supabase_admin()
    data = await client.storage.from_(bucket).download(path)
    if data is None:
        raise StorageError(f"missing blob: {bucket}/{path}")
    return data.decode("utf-8")
