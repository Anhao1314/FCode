"""Server-side provider enumeration: the menu lists what the host configured.

The console's model selector used to hardcode three entries. Now it asks the
host what exists: the offline mock, the local endpoint probe, the built-in
presets (kimi, deepseek) and every prefix the host declared in
``FCODE_OPENAI_COMPAT_PROVIDERS``. An entry appears the moment its
configuration is complete, with honest availability — an incomplete entry
appears too, marked unavailable with the exact environment variable that is
missing. Nothing here can invent a provider that was not configured, and
nothing hides one that failed to load.
"""

from __future__ import annotations

import os
from typing import Any, Mapping

from .deepseek_config import load_deepseek_settings
from .kimi import load_kimi_settings
from .openai_compat import (
    CompatSettings,
    GENERIC_COMPAT_DEFAULTS,
    declared_compat_prefixes,
    load_compat_settings,
)

__all__ = ["provider_catalog", "compat_settings_for", "PROVIDER_PRESETS"]


def _entry_from_settings(key: str, label: str, settings: CompatSettings) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "model": settings.model,
        "supportsEffort": settings.supports_effort,
        "available": True,
        "reason": "",
        "price": {
            "inputMicrousdPerMtok": settings.price.input_microusd_per_mtok,
            "outputMicrousdPerMtok": settings.price.output_microusd_per_mtok,
        },
        "maxCompletionTokens": settings.max_completion_tokens,
    }


def _unavailable(key: str, label: str, model: str, reason: str, supports_effort: bool = False) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "model": model,
        "supportsEffort": supports_effort,
        "available": False,
        "reason": reason,
        "price": None,
        "maxCompletionTokens": None,
    }


#: The built-in presets every checkout knows about. Their behaviour is pinned
#: by their own tests; the catalog only reports what the environment says.
PROVIDER_PRESETS = ("kimi", "deepseek")


def provider_catalog(
    *,
    env: Mapping[str, str] | None = None,
    local_endpoint: str | None = None,
    local_probe=None,
) -> list[dict[str, Any]]:
    """Enumerate every provider the host has (or tried to) configure.

    ``local_probe`` is an optional callable the console supplies for the
    Ollama-style endpoint health check; offline callers pass ``None`` and the
    local entry reports its reason without touching the network.
    """
    source = os.environ if env is None else env
    entries: list[dict[str, Any]] = [
        {
            "key": "mock",
            "label": "offline-mock",
            "model": "offline-deterministic-mock-v1",
            "supportsEffort": False,
            "available": True,
            "reason": "",
            "price": None,
            "maxCompletionTokens": None,
        }
    ]

    if local_endpoint:
        probed = bool(local_probe()) if local_probe is not None else False
        entries.append(_unavailable(
            "local", "本地 Qwen", "fcode-qwen3-4b",
            "" if probed else "本地推理端点探活失败",
        ) | {"available": probed, "supportsEffort": False})
    else:
        entries.append(_unavailable("local", "本地 Qwen", "fcode-qwen3-4b", "未配置本地推理端点"))

    try:
        settings = load_kimi_settings(env=source)
        entries.append(_entry_from_settings("kimi", "Kimi 云端", settings) | {"supportsEffort": True})
    except ValueError as error:
        entries.append(_unavailable(
            "kimi", "Kimi 云端", source.get("KIMI_MODEL", "").strip() or "kimi-k2.6",
            f"Host 未配置完整：{error}", supports_effort=True,
        ))

    try:
        settings = compat_settings_for("deepseek", env=source)
        entries.append(_entry_from_settings("deepseek", "DeepSeek 云端", settings))
    except ValueError as error:
        entries.append(_unavailable(
            "deepseek", "DeepSeek 云端", source.get("DEEPSEEK_MODEL", "").strip() or "deepseek-chat",
            f"Host 未配置完整：{error}",
        ))

    for prefix in declared_compat_prefixes(source):
        key = prefix.lower()
        label = source.get(f"{prefix}_LABEL", "").strip() or key
        try:
            settings = load_compat_settings(
                prefix, env=source, label=key, defaults=GENERIC_COMPAT_DEFAULTS
            )
        except ValueError as error:
            entries.append(_unavailable(
                key, label, source.get(f"{prefix}_MODEL", "").strip() or "unset",
                f"{prefix}_* 未配置完整：{error}",
            ))
            continue
        entries.append(_entry_from_settings(key, label, settings))

    return entries


def compat_settings_for(key: str, *, env: Mapping[str, str] | None = None) -> CompatSettings | None:
    """Load the settings a configured provider key names, or ``None``.

    The console and the factory use this to construct exactly the provider
    the operator selected — never a fallback.
    """
    source = os.environ if env is None else env
    if key == "kimi":
        return load_kimi_settings(env=source)
    if key == "deepseek":
        settings = load_deepseek_settings(env=source)
        return CompatSettings(
            label="deepseek",
            api_key_env="DEEPSEEK_API_KEY",
            api_key=settings.api_key,
            base_url=settings.base_url,
            model=settings.model,
            price=settings.price,
            timeout=settings.timeout,
            max_completion_tokens=settings.max_tokens,
            temperature_mode="pin-zero",
            completion_field="max_tokens",
            receipt_detail="compact",
        )
    for prefix in declared_compat_prefixes(source):
        if prefix.lower() == key:
            return load_compat_settings(
                prefix, env=source, label=key, defaults=GENERIC_COMPAT_DEFAULTS
            )
    return None
