"""
SecureTalk - Zero-Storage Room Session Manager & Capacity Enforcement
"""

import hashlib
import secrets
import time
from typing import Dict, Optional, Tuple

ROOMS_STORE: Dict[str, dict] = {}


def hash_room_identifier(room_code: str, room_salt: str) -> str:
    """Menghasilkan hash SHA-256 untuk identitas sesi room di memori."""
    raw = f"{room_code}:{room_salt}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


# Placeholder sementara sebelum dilengkapi oleh Jona (feat/dynamic-pin)
def get_current_pin_info(room_code: str) -> dict:
    code = room_code.strip().upper()
    if code not in ROOMS_STORE:
        raise ValueError(f"Room '{code}' tidak ditemukan.")
    return {
        "room_code": code,
        "pin": "000000",
        "remaining_seconds": 3600,
        "rotation_interval_seconds": 3600,
    }


def verify_room_pin(room_code: str, candidate_pin: str) -> bool:
    code = room_code.strip().upper()
    return code in ROOMS_STORE and bool(candidate_pin)


# ==========================================================================
# MANAJEMEN SESI ROOM & PEMBATASAN KAPASITAS (P2P 1-ON-1 VS GRUP)
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

    max_peers = 2 if clean_mode == "p2p" else 5
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