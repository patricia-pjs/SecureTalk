"""
SecureTalk - FastAPI Signaling Server & Tailscale CGNAT IP Guard
"""

import ipaddress
import json
from typing import Dict

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from security import (
    create_room_session,
    get_current_pin_info,
    get_room_info,
    remove_peer_from_room,
    validate_and_register_peer,
    verify_room_pin,
)

app = FastAPI(title="SecureTalk P2P Signaling & Tailscale VPN Guard")
app.mount("/static", StaticFiles(directory="static"), name="static")

# Rentang IP Virtual Tailscale (RFC 6598 CGNAT: 100.64.0.0 - 100.127.255.255)
TAILSCALE_NETWORK = ipaddress.ip_network("100.64.0.0/10")
LOCAL_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
]

ACTIVE_CONNECTIONS: Dict[str, Dict[str, WebSocket]] = {}


def is_allowed_tailscale_ip(client_host: str) -> bool:
    if not client_host:
        return False
    try:
        ip_obj = ipaddress.ip_address(client_host)
        if ip_obj.version == 4 and ip_obj in TAILSCALE_NETWORK:
            return True
        return any(ip_obj in net for net in LOCAL_NETWORKS)
    except ValueError:
        return False


@app.middleware("http")
async def tailscale_vpn_guard(request: Request, call_next):
    client_ip = request.client.host if request.client else ""
    if not is_allowed_tailscale_ip(client_ip):
        return JSONResponse(
            status_code=403,
            content={
                "error": "403 Forbidden - Non-VPN Access Blocked",
                "detail": f"IP Anda ({client_ip}) berasal dari jaringan publik/lokal non-VPN. Wajib terhubung ke Tailscale VPN (100.64.0.0/10).",
            },
        )
    return await call_next(request)


class CreateRoomRequest(BaseModel):
    room_code: str
    mode: str = "p2p"
    creator_name: str = "Host"


class VerifyRoomRequest(BaseModel):
    room_code: str
    pin: str


@app.get("/")
async def serve_index():
    return FileResponse("static/index.html")


@app.post("/api/rooms/create")
async def api_create_room(payload: CreateRoomRequest):
    try:
        return create_room_session(payload.room_code, payload.mode, payload.creator_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/rooms/verify")
async def api_verify_room(payload: VerifyRoomRequest):
    code = payload.room_code.strip().upper()
    info = get_room_info(code)
    if not info:
        raise HTTPException(status_code=404, detail="Room tidak ditemukan.")
    if not verify_room_pin(code, payload.pin):
        raise HTTPException(status_code=401, detail="PIN Dinamis salah atau kadaluarsa.")

    pin_info = get_current_pin_info(code)
    return {
        "valid": True,
        "room_code": code,
        "mode": info["mode"],
        "max_peers": info["max_peers"],
        "remaining_seconds": pin_info["remaining_seconds"],
    }


@app.websocket("/ws/{room_code}")
async def websocket_signaling(
    websocket: WebSocket,
    room_code: str,
    client_id: str,
    device_name: str = "Peer",
    pin: str = "",
):
    client_ip = websocket.client.host if websocket.client else ""
    if not is_allowed_tailscale_ip(client_ip):
        await websocket.close(code=4403, reason="Non-Tailscale IP rejected")
        return

    code = room_code.strip().upper()
    ok, msg = validate_and_register_peer(code, pin, client_id, device_name)
    if not ok:
        await websocket.close(code=4001, reason=msg)
        return

    await websocket.accept()
    ACTIVE_CONNECTIONS.setdefault(code, {})[client_id] = websocket

    room_info = get_room_info(code)
    existing_peers = [
        {"client_id": pid, "device_name": pname}
        for pid, pname in (room_info["peers"].items() if room_info else [])
    ]
    await websocket.send_text(
        json.dumps({"type": "peers_snapshot", "peers": existing_peers})
    )

    for pid, peer_ws in list(ACTIVE_CONNECTIONS.get(code, {}).items()):
        if pid != client_id:
            await peer_ws.send_text(
                json.dumps(
                    {
                        "type": "peer_joined",
                        "client_id": client_id,
                        "device_name": device_name,
                    }
                )
            )

    try:
        while True:
            raw_msg = await websocket.receive_text()
            data = json.loads(raw_msg)
            target_id = data.get("target_id")
            data["sender_id"] = client_id
            data["sender_name"] = device_name

            if target_id and target_id in ACTIVE_CONNECTIONS.get(code, {}):
                await ACTIVE_CONNECTIONS[code][target_id].send_text(json.dumps(data))
    except WebSocketDisconnect:
        pass
    finally:
        ACTIVE_CONNECTIONS.get(code, {}).pop(client_id, None)
        if not ACTIVE_CONNECTIONS.get(code):
            ACTIVE_CONNECTIONS.pop(code, None)

        remove_peer_from_room(code, client_id)

        for _, peer_ws in list(ACTIVE_CONNECTIONS.get(code, {}).items()):
            try:
                await peer_ws.send_text(
                    json.dumps({"type": "peer_left", "client_id": client_id})
                )
            except Exception:
                pass