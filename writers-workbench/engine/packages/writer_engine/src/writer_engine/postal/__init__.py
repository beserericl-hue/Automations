"""Postal email + archive permalink delivery."""

from .client import PostalAttachment, PostalClient, PostalResult, send_email

__all__ = ["PostalAttachment", "PostalClient", "PostalResult", "send_email"]
