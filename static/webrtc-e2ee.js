/**
 * SecureTalk - WebRTC Mesh Engine & End-to-End Encryption (AES-GCM 256-bit)
 */

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

function bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuf(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export class SecureMeshEngine {
  constructor({
    roomCode,
    pin,
    clientId,
    deviceName,
    onPeerListChange,
    onChatMessage,
    onTypingSignal,
    onReadReceipt,
    onEncryptedPacketLog,
    onSystemNotice,
  }) {
    this.roomCode = roomCode;
    this.pin = pin;
    this.clientId = clientId;
    this.deviceName = deviceName;

    this.onPeerListChange = onPeerListChange;
    this.onChatMessage = onChatMessage;
    this.onTypingSignal = onTypingSignal;
    this.onReadReceipt = onReadReceipt;
    this.onEncryptedPacketLog = onEncryptedPacketLog;
    this.onSystemNotice = onSystemNotice;

    this.ws = null;
    this.cryptoKey = null;
    this.peers = new Map(); // peerId -> { pc, dc, deviceName, state }
  }

  async initCryptoKey() {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(`${this.roomCode}:${this.pin}`),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );

    this.cryptoKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: enc.encode(`SecureTalk-Salt-${this.roomCode}`),
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async encryptPayload(payloadObj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(payloadObj));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.cryptoKey,
      encoded
    );

    return {
      iv: bufToBase64(iv),
      ciphertext: bufToBase64(ciphertext),
    };
  }

  async decryptPayload(encryptedEnvelope) {
    const iv = new Uint8Array(base64ToBuf(encryptedEnvelope.iv));
    const ciphertext = base64ToBuf(encryptedEnvelope.ciphertext);

    const decryptedBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      this.cryptoKey,
      ciphertext
    );
    return JSON.parse(new TextDecoder().decode(decryptedBuf));
  }

  async connect() {
    await this.initCryptoKey();

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${proto}://${window.location.host}/ws/${encodeURIComponent(
      this.roomCode
    )}?client_id=${encodeURIComponent(
      this.clientId
    )}&device_name=${encodeURIComponent(
      this.deviceName
    )}&pin=${encodeURIComponent(this.pin)}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "peers_snapshot") {
        for (const p of msg.peers) {
          if (p.client_id !== this.clientId) {
            await this.createPeerConnection(p.client_id, p.device_name, true);
          }
        }
        this._emitPeers();
      } else if (msg.type === "peer_joined") {
        if (msg.client_id !== this.clientId) {
          this.onSystemNotice?.(`${msg.device_name} bergabung ke mesh.`);
          await this.createPeerConnection(msg.client_id, msg.device_name, false);
          this._emitPeers();
        }
      } else if (msg.type === "peer_left") {
        this.removePeer(msg.client_id);
      } else if (msg.type === "signal") {
        await this.handleSignalingData(msg);
      }
    };

    this.ws.onclose = (ev) => {
      if (ev.code === 4403 || ev.code === 4001) {
        this.onSystemNotice?.(`Koneksi signaling ditolak: ${ev.reason}`);
      }
    };
  }

  async createPeerConnection(peerId, peerName, isInitiator) {
    if (this.peers.has(peerId)) return;

    const pc = new RTCPeerConnection(ICE_CONFIG);
    const peerEntry = {
      pc,
      dc: null,
      deviceName: peerName || peerId,
      state: "connecting",
    };
    this.peers.set(peerId, peerEntry);

    pc.onicecandidate = (event) => {
      if (event.candidate && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: "signal",
            target_id: peerId,
            signal: { candidate: event.candidate },
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      peerEntry.state = pc.connectionState;
      this._emitPeers();
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        this.removePeer(peerId);
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel("securetalk-e2ee", { ordered: true });
      this._setupDataChannel(peerId, dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.ws.send(
        JSON.stringify({
          type: "signal",
          target_id: peerId,
          signal: { sdp: pc.localDescription },
        })
      );
    } else {
      pc.ondatachannel = (event) => {
        this._setupDataChannel(peerId, event.channel);
      };
    }
  }

  _setupDataChannel(peerId, dc) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    entry.dc = dc;

    dc.onopen = () => {
      entry.state = "connected";
      this._emitPeers();
    };

    dc.onmessage = async (event) => {
      try {
        const envelope = JSON.parse(event.data);
        this.onEncryptedPacketLog?.("IN", envelope);

        const decrypted = await this.decryptPayload(envelope);
        if (decrypted.kind === "chat") {
          this.onChatMessage?.(decrypted);
        } else if (decrypted.kind === "typing") {
          this.onTypingSignal?.(decrypted);
        } else if (decrypted.kind === "read_ack") {
          this.onReadReceipt?.(decrypted);
        }
      } catch (err) {
        console.error("Gagal mendekripsi paket DataChannel:", err);
      }
    };
  }

  async handleSignalingData(msg) {
    const senderId = msg.sender_id;
    const senderName = msg.sender_name || senderId;
    if (!this.peers.has(senderId)) {
      await this.createPeerConnection(senderId, senderName, false);
    }

    const entry = this.peers.get(senderId);
    const { sdp, candidate } = msg.signal || {};

    if (sdp) {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      if (sdp.type === "offer") {
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        this.ws.send(
          JSON.stringify({
            type: "signal",
            target_id: senderId,
            signal: { sdp: entry.pc.localDescription },
          })
        );
      }
    } else if (candidate) {
      await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  async _broadcastEncrypted(payloadObj) {
    const envelope = await this.encryptPayload(payloadObj);
    this.onEncryptedPacketLog?.("OUT", envelope);
    const serialized = JSON.stringify(envelope);

    for (const [, entry] of this.peers.entries()) {
      if (entry.dc && entry.dc.readyState === "open") {
        entry.dc.send(serialized);
      }
    }
  }

  async sendChatMessage({ messageId, text, ttlSeconds, replyTo = null }) {
    const payload = {
      kind: "chat",
      messageId,
      senderId: this.clientId,
      senderName: this.deviceName,
      text,
      ttlSeconds,
      replyTo,
      timestamp: Date.now(),
    };
    await this._broadcastEncrypted(payload);
    return payload;
  }

  async sendTypingStatus(isTyping) {
    await this._broadcastEncrypted({
      kind: "typing",
      senderId: this.clientId,
      senderName: this.deviceName,
      isTyping: Boolean(isTyping),
    });
  }

  async sendReadReceipt(messageId) {
    await this._broadcastEncrypted({
      kind: "read_ack",
      messageId,
      readerId: this.clientId,
      readerName: this.deviceName,
    });
  }

  removePeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    try {
      entry.dc?.close();
      entry.pc?.close();
    } catch (_) {}
    this.peers.delete(peerId);
    this.onSystemNotice?.(`${entry.deviceName} keluar dari mesh.`);
    this._emitPeers();
  }

  _emitPeers() {
    const list = Array.from(this.peers.entries()).map(([id, entry]) => ({
      clientId: id,
      deviceName: entry.deviceName,
      state: entry.state,
    }));
    this.onPeerListChange?.(list);
  }

  disconnectAll() {
    for (const peerId of Array.from(this.peers.keys())) {
      this.removePeer(peerId);
    }
    try {
      this.ws?.close();
    } catch (_) {}
  }
}