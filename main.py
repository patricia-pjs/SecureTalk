"""
SecureTalk - FastAPI Signaling Server & Room Manager
"""

from pathlib import Path
from typing import Dict

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Modul keamanan yang disusun oleh Jeli (feat/security-logic) & Jona (feat/dynamic-pin)
from security import (
    create_room_session,
    get_current_pin_info,
    get_room_info,
    remove_peer_from_room,
    validate_and_register_peer,
    verify_room_pin,
)

app = FastAPI(
    title="SecureTalk Signaling Server",
    description="Zero-Storage WebRTC Signaling & Dynamic PIN Verification over Tailscale VPN",
    version="1.0.0",
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(exist_ok=True)

# Mount folder static/ untuk menyajikan HTML, CSS, dan JS
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# =============================================================================
# MODEL REQUEST API
# =============================================================================

class CreateRoomRequest(BaseModel):
    room_code: str
    mode: str = "group"  # "p2p" (maks 2 perangkat) atau "group" (maks 5 perangkat)
    device_name: str


class VerifyPinRequest(BaseModel):
    room_code: str
    pin: str


# =============================================================================
# CONNECTION MANAGER UNTUK WEBSOCKET SIGNALING (SDP & ICE ONLY)
# =============================================================================

class SignalingConnectionManager:
    def __init__(self):
        # Format: { room_code: { client_id: {"ws": WebSocket, "device_name": str} } }
        self.active_rooms: Dict[str, Dict[str, dict]] = {}

    async def connect(self, room_code: str, client_id: str, device_name: str, websocket: WebSocket):
        await websocket.accept()
        if room_code not in self.active_rooms:
            self.active_rooms[room_code] = {}

        # Kirim daftar peer yang sudah ada di dalam room kepada client yang baru bergabung
        existing_peers = [
            {"client_id": pid, "device_name": info["device_name"]}
            for pid, info in self.active_rooms[room_code].items()
        ]
        await websocket.send_json({
            "type": "existing_peers",
            "peers": existing_peers,
        })

        # Daftarkan client baru ke dalam daftar aktif
        self.active_rooms[room_code][client_id] = {
            "ws": websocket,
            "device_name": device_name,
        }

        # Beri tahu anggota lain bahwa ada peer baru yang masuk
        await self.broadcast(
            room_code,
            {
                "type": "peer_joined",
                "client_id": client_id,
                "device_name": device_name,
            },
            exclude_client_id=client_id,
        )

    def disconnect(self, room_code: str, client_id: str):
        if room_code in self.active_rooms and client_id in self.active_rooms[room_code]:
            del self.active_rooms[room_code][client_id]
            if not self.active_rooms[room_code]:
                del self.active_rooms[room_code]

    async def send_to_peer(self, room_code: str, target_id: str, message: dict):
        room = self.active_rooms.get(room_code, {})
        target = room.get(target_id)
        if target:
            await target["ws"].send_json(message)

    async def broadcast(self, room_code: str, message: dict, exclude_client_id: str = None):
        room = self.active_rooms.get(room_code, {})
        for cid, info in list(room.items()):
            if cid != exclude_client_id:
                await info["ws"].send_json(message)


manager = SignalingConnectionManager()


# =============================================================================
# ENDPOINT HALAMAN & REST API ROOM / PIN
# =============================================================================

@app.get("/")
async def serve_index():
    """Menyajikan halaman utama aplikasi SecureTalk."""
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return {"status": "SecureTalk Signaling Server aktif", "detail": "static/index.html belum tersedia"}


@app.post("/api/rooms/create")
async def api_create_room(payload: CreateRoomRequest):
    """Membuat sesi room baru beserta PIN Dinamis 6-digit per jam."""
    try:
        session = create_room_session(
            room_code=payload.room_code,
            mode=payload.mode,
            creator_name=payload.device_name,
        )
        return {
            "status": "success",
            "room": session,
        }
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))


@app.post("/api/rooms/verify")
async def api_verify_pin(payload: VerifyPinRequest):
    """Memvalidasi kecocokan Room Code dan PIN 6-digit sebelum koneksi WebRTC dibuka."""
    room = get_room_info(payload.room_code)
    if not room:
        raise HTTPException(status_code=404, detail="Room tidak ditemukan. Buat room terlebih dahulu.")

    if not verify_room_pin(payload.room_code, payload.pin):
        raise HTTPException(status_code=401, detail="PIN Dinamis salah atau sudah kedaluwarsa!")

    pin_meta = get_current_pin_info(payload.room_code)
    return {
        "status": "valid",
        "room_code": room["room_code"],
        "mode": room["mode"],
        "max_peers": room["max_peers"],
        "current_peers": len(room["peers"]),
        "remaining_seconds": pin_meta["remaining_seconds"],
    }


@app.get("/api/rooms/{room_code}/pin-status")
async def api_pin_status(room_code: str):
    """Mengambil sisa waktu hitung mundur rotasi PIN 6-digit per jam."""
    try:
        return get_current_pin_info(room_code)
    except ValueError as err:
        raise HTTPException(status_code=404, detail=str(err))


# =============================================================================
# WEBSOCKET SIGNALING ENDPOINT (PERTUKARAN SDP & ICE CANDIDATE)
# =============================================================================

@app.websocket("/ws/{room_code}/{client_id}")
async def websocket_signaling(
    websocket: WebSocket,
    room_code: str,
    client_id: str,
    pin: str = Query(...),
    name: str = Query("Anonymous-Device"),
):
    room_code = room_code.strip().upper()

    # Validasi PIN & kapasitas room di security.py sebelum menerima koneksi
    allowed, reason = validate_and_register_peer(
        room_code=room_code,
        pin=pin,
        client_id=client_id,
        device_name=name,
    )
    if not allowed:
        await websocket.accept()
        await websocket.close(code=4001, reason=reason)
        return

    await manager.connect(room_code, client_id, name, websocket)

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            target_id = data.get("target_id")

            # Server HANYA meneruskan sinyal negosiasi koneksi (SDP & ICE), tidak pernah menyentuh isi chat
            if msg_type in {"offer", "answer", "ice_candidate"} and target_id:
                data["sender_id"] = client_id
                data["sender_name"] = name
                await manager.send_to_peer(room_code, target_id, data)

    except WebSocketDisconnect:
        manager.disconnect(room_code, client_id)
        remove_peer_from_room(room_code, client_id)
        await manager.broadcast(
            room_code,
            {
                "type": "peer_left",
                "client_id": client_id,
                "device_name": name,
            },
        )
