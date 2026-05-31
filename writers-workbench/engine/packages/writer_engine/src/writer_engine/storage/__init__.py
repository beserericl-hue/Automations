"""Supabase Storage adapter — upload/download blobs for newsletter renders, cover art, etc."""

from .adapter import StorageError, download_text, upload_text

__all__ = ["StorageError", "download_text", "upload_text"]
