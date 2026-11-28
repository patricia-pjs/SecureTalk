"""
SecureTalk - Zero-Storage Room Session Manager & Dynamic Hourly PIN (HMAC-SHA256)
"""

import hashlib
import hmac
import os
import secrets
import time
from typing import Dict, Optional, Tuple

SERVER_SECRET_KEY: bytes = os.environ.get(
    "SECURETALK_SECRET", secrets.token_hex(32)
).encode("utf-8")

ROOMS_STORE: Dict[str, dict] = {}
PIN_ROTATION_SECONDS = 3600


def hash_room_identifier(room_code: str, room_salt: str) -> str:
    """Menghasilkan hash SHA-256 untuk identitas sesi room di memori."""
    raw = f"{room_code}:{room_salt}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


# ==========================================================================
# BAGIAN JONA: GENERATOR, VALIDATOR & PENGHITUNG MUNDUR PIN DINAMIS PER JAM
# ==========================================================================

def _compute_hourly_pin(room_code: str, room_salt: str, time_slot: int) -> str:
    message = f"{room_code}:{room_salt}:{time_slot}".encode("utf-8")
    digest = hmac.new(SERVER_SECRET_KEY, message, hashlib.sha256).digest()

    offset = digest[-1] & 0x0F
    binary_code = (
        ((digest[offset] & 0x7F) << 24)
        | ((digest[offset + 1] & 0xFF) << 16)
        | ((digest[offset + 2] & 0xFF) << 8)
        | (digest[offset + 3] & 0xFF)
    )
    return f"{binary_code % 1_000_000:06d}"


def get_current_pin_info(room_code: str) -> dict:
    code = room_code.strip().upper()
    room = ROOMS_STORE.get(code)
    if not room:
        raise ValueError(f"Room '{code}' tidak ditemukan.")

    now = int(time.time())
    current_slot = now // PIN_ROTATION_SECONDS
    next_rotation_epoch = (current_slot + 1) * PIN_ROTATION_SECONDS
    remaining_seconds = max(0, next_rotation_epoch - now)

    current_pin = _compute_hourly_pin(code, room["salt"], current_slot)
    return {
        "room_code": code,
        "pin": current_pin,
        "remaining_seconds": remaining_seconds,
        "rotation_interval_seconds": PIN_ROTATION_SECONDS,
    }


def verify_room_pin(room_code: str, candidate_pin: str) -> bool:
    code = room_code.strip().upper()
    room = ROOMS_STORE.get(code)
    if not room or not candidate_pin:
        return False

    clean_pin = candidate_pin.strip()
    now = int(time.time())
    current_slot = now // PIN_ROTATION_SECONDS
    expected_pin = _compute_hourly_pin(code, room["salt"], current_slot)

    return hmac.compare_digest(expected_pin, clean_pin)


# ==========================================================================
# BAGIAN JELI: MANAJEMEN SESI ROOM & PEMBATASAN KAPASITAS (P2P VS GRUP)
# ==========================================================================

def create_room_session(room_code: str, mode: str, creator_name: str) -> dict:
    code = room_code.strip().upper()
    if not code or len(code) < 3:
        raise ValueError("Kode room minimal 3 karakter.")

    clean_mode = mode.strip().lower()
    if clean_mode not in {"p2p", "group"}:
        raise ValueError("Mode room harus 'p2p' atau 'group'.")

    if code in ROOMS_STORE:
        raise ValueError(f"Room '{code}' sudah aktif. Gunakan kode lain atau langsung gabung.")

    max_peers = 2 if clean_mode == "p2p" else 8
    room_salt = secrets.token_hex(8)
    session_hash = hash_room_identifier(code, room_salt)

    ROOMS_STORE[code] = {
        "room_code": code,
        "session_hash": session_hash,
        "mode": clean_mode,
        "max_peers": max_peers,
        "salt": room_salt,
        "creator": creator_name.strip() or "Host",
        "peers": {},
        "created_at": time.time(),
    }

    pin_info = get_current_pin_info(code)
    return {
        "room_code": code,
        "mode": clean_mode,
        "max_peers": max_peers,
        "pin": pin_info["pin"],
        "remaining_seconds": pin_info["remaining_seconds"],
    }


def get_room_info(room_code: str) -> Optional[dict]:
    code = room_code.strip().upper()
    room = ROOMS_STORE.get(code)
    if not room:
        return None
    return {
        "room_code": room["room_code"],
        "mode": room["mode"],
        "max_peers": room["max_peers"],
        "peers": dict(room["peers"]),
    }


def validate_and_register_peer(
    room_code: str, pin: str, client_id: str, device_name: str
) -> Tuple[bool, str]:
    code = room_code.strip().upper()
    room = ROOMS_STORE.get(code)
    if not room:
        return False, "Room tidak ditemukan atau sesi sudah berakhir."

    if not verify_room_pin(code, pin):
        return False, "PIN Dinamis tidak valid atau sudah berganti jam."

    if client_id not in room["peers"] and len(room["peers"]) >= room["max_peers"]:
        return (
            False,
            f"Room penuh! Mode '{room['mode']}' maksimal {room['max_peers']} perangkat.",
        )

    room["peers"][client_id] = device_name.strip() or client_id
    return True, "OK"


def remove_peer_from_room(room_code: str, client_id: str) -> None:
    code = room_code.strip().upper()
    room = ROOMS_STORE.get(code)
    if not room:
        return

    room["peers"].pop(client_id, None)
    if len(room["peers"]) == 0:
        ROOMS_STORE.pop(code, None)