/**
 * SecureTalk - WebRTC Mesh DataChannel & End-to-End Encryption Engine (AES-GCM 256-bit)
 */

class SecureTalkEngine {
  constructor({
    roomCode,
    pin,
    deviceName,
    onMessageReceived,
    onPeerListUpdated,
    onInspectorLog,
    onSystemNotice,
    onConnectionClosed,
  }) {
    this.roomCode = roomCode.trim().toUpperCase();
    this.pin = pin.trim();
    this.deviceName = deviceName.trim();
    this.clientId = `peer-${crypto.randomUUID().slice(0, 8)}`;

    // Callbacks untuk UI (dihubungkan di app.js)
    this.onMessageReceived = onMessageReceived || (() => {});
    this.onPeerListUpdated = onPeerListUpdated || (() => {});
    this.onInspectorLog = onInspectorLog || (() => {});
    this.onSystemNotice = onSystemNotice || (() => {});
    this.onConnectionClosed = onConnectionClosed || (() => {});

    this.ws = null;
    this.cryptoKey = null;
    // Map: clientId -> { pc: RTCPeerConnection, dc: RTCDataChannel, deviceName: string }
    this.peers = new Map();

    // Konfigurasi STUN ringan (optimal di jaringan lokal / Tailscale VPN)
    this.rtcConfig = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    };
  }

  /**
   * Menurunkan kunci simetris AES-GCM 256-bit dari kombinasi Room Code + Hourly PIN.
   * Kunci hanya hidup di RAM browser (Zero-Storage).
   */
  async deriveSessionKey() {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(`${this.roomCode}:${this.pin}`),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );

    this.cryptoKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: encoder.encode(`SecureTalk-Salt-${this.roomCode}`),
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Membuka koneksi ke FastAPI WebSocket Signaling Server
   */
  async connect() {
    await this.deriveSessionKey();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/${encodeURIComponent(
      this.roomCode
    )}/${encodeURIComponent(this.clientId)}?pin=${encodeURIComponent(
      this.pin
    )}&name=${encodeURIComponent(this.deviceName)}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this._emitPeerList();
      this.onSystemNotice(`Terhubung ke signaling mesh sebagai ${this.deviceName}`);
    };

    this.ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      await this._handleSignalingMessage(data);
    };

    this.ws.onclose = (event) => {
      this.cleanup();
      this.onConnectionClosed(event.reason || "Koneksi signaling terputus.");
    };
  }

  async _handleSignalingMessage(data) {
    switch (data.type) {
      case "existing_peers":
        // Peer baru memulai WebRTC Offer ke seluruh peer yang sudah ada di room
        for (const peer of data.peers) {
          await this._createPeerConnection(peer.client_id, peer.device_name, true);
        }
        this._emitPeerList();
        break;

      case "peer_joined":
        this.onSystemNotice(`${data.device_name} bergabung ke room.`);
        // Menunggu offer dari peer yang baru masuk
        if (!this.peers.has(data.client_id)) {
          this.peers.set(data.client_id, {
            pc: null,
            dc: null,
            deviceName: data.device_name,
          });
        }
        this._emitPeerList();
        break;

      case "offer":
        await this._handleOffer(data);
        break;

      case "answer":
        await this._handleAnswer(data);
        break;

      case "ice_candidate":
        await this._handleIceCandidate(data);
        break;

      case "peer_left":
        this._removePeer(data.client_id, data.device_name);
        break;
    }
  }

  async _createPeerConnection(targetId, targetName, isInitiator) {
    const pc = new RTCPeerConnection(this.rtcConfig);
    const peerEntry = { pc, dc: null, deviceName: targetName };
    this.peers.set(targetId, peerEntry);

    pc.onicecandidate = (event) => {
      if (event.candidate && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: "ice_candidate",
            target_id: targetId,
            candidate: event.candidate,
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        this._removePeer(targetId, targetName);
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel("securetalk-e2ee", { ordered: true });
      this._setupDataChannel(dc, targetId, targetName);
      peerEntry.dc = dc;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.ws.send(
        JSON.stringify({
          type: "offer",
          target_id: targetId,
          sdp: pc.localDescription,
        })
      );
    } else {
      pc.ondatachannel = (event) => {
        peerEntry.dc = event.channel;
        this._setupDataChannel(event.channel, targetId, targetName);
      };
    }

    this._emitPeerList();
    return pc;
  }

  _setupDataChannel(dc, peerId, peerName) {
    dc.onopen = () => {
      this.onSystemNotice(`Saluran P2P AES-256 aktif dengan ${peerName}.`);
      this._emitPeerList();
    };

    dc.onmessage = async (event) => {
      try {
        const packet = JSON.parse(event.data);
        const plaintext = await this._decryptPayload(packet);

        this.onInspectorLog({
          direction: "RECV",
          packetId: packet.packet_id,
          iv: packet.iv,
          ciphertext: packet.ciphertext,
          peerName,
        });

        this.onMessageReceived({
          senderId: peerId,
          senderName: packet.sender_name || peerName,
          text: plaintext,
          timestamp: this._formatClockTime(),
          ttlSeconds: 30,
        });
      } catch (err) {
        console.error("Gagal mendekripsi paket E2EE:", err);
      }
    };
  }

  async _handleOffer(data) {
    const pc = await this._createPeerConnection(
      data.sender_id,
      data.sender_name || data.sender_id,
      false
    );
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.ws.send(
      JSON.stringify({
        type: "answer",
        target_id: data.sender_id,
        sdp: pc.localDescription,
      })
    );
  }

  async _handleAnswer(data) {
    const peer = this.peers.get(data.sender_id);
    if (peer?.pc) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    }
  }

  async _handleIceCandidate(data) {
    const peer = this.peers.get(data.sender_id);
    if (peer?.pc && data.candidate) {
      await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  }

  /**
   * Mengenkripsi pesan teks dengan AES-GCM 256-bit dan mengirim ke seluruh peer di Mesh
   */
  async sendEncryptedMessage(plainText) {
    const cleanText = plainText.trim();
    if (!cleanText) return null;

    const packet = await this._encryptPayload(cleanText);
    const serialized = JSON.stringify(packet);

    let sentCount = 0;
    for (const [, peer] of this.peers.entries()) {
      if (peer.dc && peer.dc.readyState === "open") {
        peer.dc.send(serialized);
        sentCount++;
      }
    }

    this.onInspectorLog({
      direction: "SEND",
      packetId: packet.packet_id,
      iv: packet.iv,
      ciphertext: packet.ciphertext,
      peerCount: sentCount,
    });

    return {
      senderId: this.clientId,
      senderName: this.deviceName,
      text: cleanText,
      timestamp: this._formatClockTime(),
      ttlSeconds: 30,
    };
  }

  async _encryptPayload(plainText) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plainText);

    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.cryptoKey,
      encoded
    );

    return {
      packet_id: crypto.randomUUID().slice(0, 6),
      sender_name: this.deviceName,
      iv: this._bufferToHex(iv),
      ciphertext: this._bufferToHex(new Uint8Array(encryptedBuffer)),
    };
  }

  async _decryptPayload(packet) {
    const iv = this._hexToBuffer(packet.iv);
    const cipherBytes = this._hexToBuffer(packet.ciphertext);

    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      this.cryptoKey,
      cipherBytes
    );

    return new TextDecoder().decode(decryptedBuffer);
  }

  _removePeer(clientId, deviceName) {
    const peer = this.peers.get(clientId);
    if (peer) {
      try {
        peer.dc?.close();
        peer.pc?.close();
      } catch (_) {}
      this.peers.delete(clientId);
      this.onSystemNotice(`${deviceName || clientId} keluar dari room.`);
      this._emitPeerList();
    }
  }

  _emitPeerList() {
    const list = [
      { clientId: this.clientId, deviceName: `${this.deviceName} (You)`, isSelf: true },
    ];
    for (const [cid, info] of this.peers.entries()) {
      list.push({
        clientId: cid,
        deviceName: info.deviceName,
        isSelf: false,
        channelReady: info.dc?.readyState === "open",
      });
    }
    this.onPeerListUpdated(list);
  }

  _formatClockTime() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    return `${hh}.${mm}`;
  }

  _bufferToHex(uint8Array) {
    return Array.from(uint8Array)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  _hexToBuffer(hexString) {
    const matches = hexString.match(/.{1,2}/g) || [];
    return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
  }

  cleanup() {
    for (const [cid] of this.peers.entries()) {
      this._removePeer(cid);
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

window.SecureTalkEngine = SecureTalkEngine;