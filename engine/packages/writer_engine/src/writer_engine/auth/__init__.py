"""Auth dependencies — shared-secret (internal), API-key (B2B), Supabase JWT (UI)."""

from .api_key import ApiKeyIdentity, require_api_key
from .service_secret import require_admin_token, require_service_secret
from .supabase_jwt import JwtIdentity, require_supabase_jwt

__all__ = [
    "ApiKeyIdentity",
    "JwtIdentity",
    "require_admin_token",
    "require_api_key",
    "require_service_secret",
    "require_supabase_jwt",
]
