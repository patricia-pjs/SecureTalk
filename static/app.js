/**
 * SecureTalk - DOM Event Binding, Dynamic PIN Countdown & 30s Auto-Delete Controller
 */

document.addEventListener("DOMContentLoaded", () => {
  // Views
  const lobbyView = document.getElementById("lobby-view");
  const chatView = document.getElementById("chat-view");

  // Lobby Controls
  const lobbyForm = document.getElementById("lobby-form");
  const deviceNameInput = document.getElementById("device-name");
  const roomModeInput = document.getElementById("room-mode");
  const btnModeP2P = document.getElementById("btn-mode-p2p");
  const btnModeGroup = document.getElementById("btn-mode-group");
  const roomCodeInput = document.getElementById("room-code");
  const generateRoomBtn = document.getElementById("generate-room-btn");
  const copyRoomBtn = document.getElementById("copy-room-btn");
  const pinDigits = Array.from(document.querySelectorAll(".pin-digit"));
  const lobbyAlert = document.getElementById("lobby-alert");
  const connectBtn = document.getElementById("connect-btn");

  // Chat Workspace Controls
  const activeRoomCodeEl = document.getElementById("active-room-code");
  const activeRoomPinEl = document.getElementById("active-room-pin");
  const pinCountdownEl = document.getElementById("pin-countdown");
  const peerListEl = document.getElementById("peer-list");
  const chatMessagesEl = document.getElementById("chat-messages");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");
  const inspectorLogsEl = document.getElementById("inspector-logs");
  const clearInspectorBtn = document.getElementById("clear-inspector-btn");
  const leaveRoomBtn = document.getElementById("leave-room-btn");

  let engine = null;
  let pinTimerInterval = null;
  let remainingPinSeconds = 3600;

  // 1. Toggle Mode P2P vs Group Mesh
  [btnModeP2P, btnModeGroup].forEach((btn) => {
    btn.addEventListener("click", () => {
      btnModeP2P.classList.remove("active");
      btnModeGroup.classList.remove("active");
      btn.classList.add("active");
      roomModeInput.value = btn.dataset.mode;
    });
  });

  // 2. Generate Kode Room Acak
  generateRoomBtn.addEventListener("click", () => {
    const part1 = Math.random().toString(36).substring(2, 5).toUpperCase();
    const part2 = Math.random().toString(36).substring(2, 5).toUpperCase();
    roomCodeInput.value = `ST-${part1}-${part2}`;
    pinDigits.forEach((input) => (input.value = ""));
    hideAlert();
  });

  // 3. Copy Kode Room
  copyRoomBtn.addEventListener("click", async () => {
    if (!roomCodeInput.value.trim()) return;
    await navigator.clipboard.writeText(roomCodeInput.value.trim().toUpperCase());
    copyRoomBtn.textContent = "✓";
    setTimeout(() => (copyRoomBtn.textContent = "❐"), 1200);
  });

  // 4. Navigasi Otomatis 6 Kotak PIN
  pinDigits.forEach((input, idx) => {
    input.addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 1);
      if (e.target.value && idx < pinDigits.length - 1) {
        pinDigits[idx + 1].focus();
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !e.target.value && idx > 0) {
        pinDigits[idx - 1].focus();
      }
    });

    input.addEventListener("paste", (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData.getData("text") || "")
        .replace(/\D/g, "")
        .slice(0, 6);
      pasted.split("").forEach((char, i) => {
        if (pinDigits[i]) pinDigits[i].value = char;
      });
    });
  });

  // 5. Submit Lobby (Buat Room Baru jika PIN kosong, atau Gabung jika PIN terisi)
  lobbyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAlert();

    const deviceName = deviceNameInput.value.trim();
    const roomCode = roomCodeInput.value.trim().toUpperCase();
    const mode = roomModeInput.value;
    const enteredPin = pinDigits.map((d) => d.value).join("");

    if (!deviceName || !roomCode) {
      showAlert("Device Name dan Room Code wajib diisi.");
      return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting to Mesh...";

    try {
      let activePin = enteredPin;

      if (!enteredPin) {
        // Buat sesi room baru di backend FastAPI
        const res = await fetch("/api/rooms/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room_code: roomCode,
            mode,
            creator_name: deviceName,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Gagal membuat room.");

        activePin = data.pin;
        remainingPinSeconds = data.remaining_seconds || 3600;
      } else {
        // Verifikasi PIN untuk bergabung ke room yang sudah aktif
        if (enteredPin.length !== 6) {
          throw new Error("PIN Dinamis harus terdiri dari 6 digit angka.");
        }
        const res = await fetch("/api/rooms/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room_code: roomCode,
            pin: enteredPin,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "PIN Dinamis salah atau room tidak ditemukan.");

        remainingPinSeconds = data.remaining_seconds || 3600;
      }

      // Masuk ke Workspace Chat & Jalankan WebRTC Mesh Engine
      enterChatWorkspace(roomCode, activePin, deviceName);
    } catch (err) {
      showAlert(err.message);
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = "Connect to Mesh";
    }
  });

  function enterChatWorkspace(roomCode, activePin, deviceName) {
    lobbyView.classList.add("hidden");
    chatView.classList.remove("hidden");

    activeRoomCodeEl.textContent = roomCode;
    activeRoomPinEl.textContent = activePin;
    startPinCountdown(remainingPinSeconds);

    engine = new window.SecureTalkEngine({
      roomCode,
      pin: activePin,
      deviceName,
      onMessageReceived: (msg) => renderChatBubble(msg, false),
      onPeerListUpdated: (peers) => renderPeerList(peers),
      onInspectorLog: (log) => appendInspectorLog(log),
      onSystemNotice: (notice) => appendSystemNotice(notice),
      onConnectionClosed: (reason) => {
        appendSystemNotice(`Terputus: ${reason}`);
      },
    });

    engine.connect();
  }

  // 6. Kirim Pesan Terenkripsi
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!engine) return;

    const text = chatInput.value.trim();
    if (!text) return;

    chatInput.value = "";
    const sentMsg = await engine.sendEncryptedMessage(text);
    if (sentMsg) {
      renderChatBubble(sentMsg, true);
    }
  });

  // 7. Render Gelembung Pesan + Auto-Delete 30 Detik
  function renderChatBubble({ senderName, text, timestamp, ttlSeconds = 30 }, isOutgoing) {
    const row = document.createElement("div");
    row.className = `msg-row ${isOutgoing ? "outgoing" : "incoming"}`;

    const tag = document.createElement("span");
    tag.className = "auto-delete-tag";
    tag.textContent = isOutgoing
      ? "30s Auto-Delete"
      : `${senderName} • 30s Auto-Delete`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const msgText = document.createElement("span");
    msgText.textContent = text;

    const timeSpan = document.createElement("span");
    timeSpan.className = "msg-time";
    timeSpan.textContent = timestamp;

    bubble.appendChild(msgText);
    bubble.appendChild(timeSpan);
    row.appendChild(tag);
    row.appendChild(bubble);
    chatMessagesEl.appendChild(row);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

    // Hapus otomatis dari DOM setelah 30 detik (Zero-Storage Ephemeral)
    setTimeout(() => {
      row.style.opacity = "0";
      row.style.transition = "opacity 0.35s ease";
      setTimeout(() => row.remove(), 350);
    }, ttlSeconds * 1000);
  }

  function renderPeerList(peers) {
    peerListEl.innerHTML = "";
    peers.forEach((p) => {
      const li = document.createElement("li");
      li.textContent = p.deviceName;
      peerListEl.appendChild(li);
    });
  }

  function appendInspectorLog({ direction, packetId, iv, ciphertext }) {
    const placeholder = inspectorLogsEl.querySelector(".inspector-placeholder");
    if (placeholder) placeholder.remove();

    const entry = document.createElement("div");
    entry.style.marginBottom = "0.45rem";
    entry.innerHTML = `
      <div>[P2P] ${direction} packet_id: ${packetId}</div>
      <div>IV: ${iv.slice(0, 12)}...${iv.slice(-12)}</div>
      <div>Ciphertext: ${ciphertext.slice(0, 28)}...</div>
    `;
    inspectorLogsEl.appendChild(entry);
    inspectorLogsEl.scrollTop = inspectorLogsEl.scrollHeight;
  }

  function appendSystemNotice(text) {
    const div = document.createElement("div");
    div.className = "system-notice";
    div.textContent = text;
    chatMessagesEl.appendChild(div);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function startPinCountdown(seconds) {
    if (pinTimerInterval) clearInterval(pinTimerInterval);
    let left = seconds;

    const updateText = () => {
      const mins = String(Math.floor(left / 60)).padStart(2, "0");
      const secs = String(left % 60).padStart(2, "0");
      pinCountdownEl.textContent = `${mins}:${secs}`;
      if (left > 0) left--;
    };

    updateText();
    pinTimerInterval = setInterval(updateText, 1000);
  }

  clearInspectorBtn.addEventListener("click", () => {
    inspectorLogsEl.innerHTML =
      '<div class="inspector-placeholder">[CLEARED] Log payload dibersihkan dari memori tampilan.</div>';
  });

  leaveRoomBtn.addEventListener("click", () => {
    if (engine) {
      engine.cleanup();
      engine = null;
    }
    if (pinTimerInterval) clearInterval(pinTimerInterval);
    chatMessagesEl.innerHTML = "";
    inspectorLogsEl.innerHTML =
      '<div class="inspector-placeholder">[IDLE] Menunggu paket AES-GCM 256-bit melintas di DataChannel...</div>';
    chatView.classList.add("hidden");
    lobbyView.classList.remove("hidden");
  });

  function showAlert(msg) {
    lobbyAlert.textContent = msg;
    lobbyAlert.classList.remove("hidden");
  }

  function hideAlert() {
    lobbyAlert.classList.add("hidden");
  }
});