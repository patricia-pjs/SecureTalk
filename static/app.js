/**
 * SecureTalk - DOM Controller, Ephemeral Timer, Reply, Typing & Read Receipts
 */

import { SecureMeshEngine } from "./webrtc-e2ee.js";

const lobbyView = document.getElementById("lobbyView");
const chatView = document.getElementById("chatView");
const joinForm = document.getElementById("joinForm");
const deviceNameInput = document.getElementById("deviceNameInput");
const modeP2PBtn = document.getElementById("modeP2PBtn");
const modeGroupBtn = document.getElementById("modeGroupBtn");
const roomCodeInput = document.getElementById("roomCodeInput");
const generateRoomBtn = document.getElementById("generateRoomBtn");
const copyRoomBtn = document.getElementById("copyRoomBtn");
const ttlSelect = document.getElementById("ttlSelect");
const pinDigits = Array.from(document.querySelectorAll(".pin-digit"));
const lobbyError = document.getElementById("lobbyError");

const roomModeBadge = document.getElementById("roomModeBadge");
const sidebarRoomCode = document.getElementById("sidebarRoomCode");
const sidebarPin = document.getElementById("sidebarPin");
const pinCountdown = document.getElementById("pinCountdown");
const sidebarTtlLabel = document.getElementById("sidebarTtlLabel");
const peerCount = document.getElementById("peerCount");
const peerList = document.getElementById("peerList");
const payloadInspector = document.getElementById("payloadInspector");
const leaveRoomBtn = document.getElementById("leaveRoomBtn");

const typingIndicator = document.getElementById("typingIndicator");
const messagesContainer = document.getElementById("messagesContainer");
const replyPreviewBar = document.getElementById("replyPreviewBar");
const replyPreviewSender = document.getElementById("replyPreviewSender");
const replyPreviewText = document.getElementById("replyPreviewText");
const cancelReplyBtn = document.getElementById("cancelReplyBtn");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");

let selectedMode = "p2p";
let meshEngine = null;
let pinTimerInterval = null;
let activeReplyTarget = null;
let typingDebounceTimer = null;
let isCurrentlyTyping = false;

const activeTypingPeers = new Map(); // senderId -> { name, timeoutId }
const messageBubbles = new Map(); // messageId -> { element, readBy: Set<string> }

const clientId =
  "peer-" + Math.random().toString(36).substring(2, 10).toUpperCase();

function generateRandomRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () =>
    Array.from({ length: 3 }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length))
    ).join("");
  return `ST-${part()}-${part()}`;
}

function getPinFromBoxes() {
  return pinDigits.map((input) => input.value.trim()).join("");
}

function setPinToBoxes(pin) {
  pin.split("").forEach((digit, idx) => {
    if (pinDigits[idx]) pinDigits[idx].value = digit;
  });
}

function showLobbyError(msg) {
  lobbyError.textContent = msg;
  lobbyError.classList.remove("hidden");
}

function clearLobbyError() {
  lobbyError.textContent = "";
  lobbyError.classList.add("hidden");
}

function formatTtlLabel(seconds) {
  if (seconds === 30) return "30 Detik (Demo)";
  if (seconds === 300) return "5 Menit";
  if (seconds === 3600) return "1 Jam";
  return "Sampai Keluar Room";
}

function startPinCountdown(initialSeconds) {
  if (pinTimerInterval) clearInterval(pinTimerInterval);
  let remaining = initialSeconds;

  const updateText = () => {
    const mins = String(Math.floor(remaining / 60)).padStart(2, "0");
    const secs = String(remaining % 60).padStart(2, "0");
    pinCountdown.textContent = `${mins}:${secs}`;
    if (remaining > 0) remaining -= 1;
  };

  updateText();
  pinTimerInterval = setInterval(updateText, 1000);
}

// Mode Toggle
[modeP2PBtn, modeGroupBtn].forEach((btn) => {
  btn.addEventListener("click", () => {
    modeP2PBtn.classList.remove("active");
    modeGroupBtn.classList.remove("active");
    btn.classList.add("active");
    selectedMode = btn.dataset.mode;
  });
});

// Room Code Generator & Copy
roomCodeInput.value = generateRandomRoomCode();
generateRoomBtn.addEventListener("click", () => {
  roomCodeInput.value = generateRandomRoomCode();
});

copyRoomBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(roomCodeInput.value.trim());
  copyRoomBtn.textContent = "✓";
  setTimeout(() => (copyRoomBtn.textContent = "❐"), 1200);
});

// 6-Digit PIN Box Navigation & Paste
pinDigits.forEach((box, index) => {
  box.addEventListener("input", () => {
    box.value = box.value.replace(/\D/g, "").slice(0, 1);
    if (box.value && index < pinDigits.length - 1) {
      pinDigits[index + 1].focus();
    }
  });

  box.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !box.value && index > 0) {
      pinDigits[index - 1].focus();
    }
  });

  box.addEventListener("paste", (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData.getData("text") || "")
      .replace(/\D/g, "")
      .slice(0, 6);
    if (pasted) {
      setPinToBoxes(pasted);
      const focusIdx = Math.min(pasted.length, pinDigits.length - 1);
      pinDigits[focusIdx].focus();
    }
  });
});

// Reply Preview Handlers
function setReplyTarget({ messageId, senderName, text }) {
  activeReplyTarget = { messageId, senderName, text };
  replyPreviewSender.textContent = `Membalas ${senderName}`;
  replyPreviewText.textContent = text;
  replyPreviewBar.classList.remove("hidden");
  messageInput.focus();
}

function clearReplyTarget() {
  activeReplyTarget = null;
  replyPreviewBar.classList.add("hidden");
  replyPreviewSender.textContent = "";
  replyPreviewText.textContent = "";
}

cancelReplyBtn.addEventListener("click", clearReplyTarget);

// Typing Indicator Render
function refreshTypingIndicator() {
  if (activeTypingPeers.size === 0) {
    typingIndicator.classList.add("hidden");
    return;
  }
  const names = Array.from(activeTypingPeers.values()).map((p) => p.name);
  typingIndicator.textContent =
    names.length === 1
      ? `${names[0]} sedang mengetik...`
      : `${names.join(", ")} sedang mengetik...`;
  typingIndicator.classList.remove("hidden");
}

function handleIncomingTyping({ senderId, senderName, isTyping }) {
  const existing = activeTypingPeers.get(senderId);
  if (existing) clearTimeout(existing.timeoutId);

  if (!isTyping) {
    activeTypingPeers.delete(senderId);
    refreshTypingIndicator();
    return;
  }

  const timeoutId = setTimeout(() => {
    activeTypingPeers.delete(senderId);
    refreshTypingIndicator();
  }, 3000);

  activeTypingPeers.set(senderId, { name: senderName, timeoutId });
  refreshTypingIndicator();
}

// Render System & Chat Messages
function appendSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "system-msg";
  div.textContent = text;
  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function renderChatBubble(msg, isOwn) {
  const bubble = document.createElement("div");
  bubble.className = `msg-bubble ${isOwn ? "own" : "peer"}`;
  bubble.dataset.messageId = msg.messageId;

  const topRow = document.createElement("div");
  topRow.className = "msg-top";

  const senderSpan = document.createElement("span");
  senderSpan.className = "msg-sender";
  senderSpan.textContent = isOwn ? `${msg.senderName} (Anda)` : msg.senderName;

  const replyBtn = document.createElement("button");
  replyBtn.type = "button";
  replyBtn.className = "reply-trigger-btn";
  replyBtn.textContent = "↩ Balas";
  replyBtn.addEventListener("click", () =>
    setReplyTarget({
      messageId: msg.messageId,
      senderName: msg.senderName,
      text: msg.text,
    })
  );

  topRow.appendChild(senderSpan);
  topRow.appendChild(replyBtn);
  bubble.appendChild(topRow);

  if (msg.replyTo) {
    const quoteBox = document.createElement("div");
    quoteBox.className = "quoted-reply";
    const quoteSender = document.createElement("strong");
    quoteSender.textContent = msg.replyTo.senderName;
    const quoteText = document.createElement("span");
    quoteText.textContent = msg.replyTo.text;
    quoteBox.appendChild(quoteSender);
    quoteBox.appendChild(quoteText);
    bubble.appendChild(quoteBox);
  }

  const bodyP = document.createElement("p");
  bodyP.className = "msg-text";
  bodyP.textContent = msg.text;
  bubble.appendChild(bodyP);

  const metaDiv = document.createElement("div");
  metaDiv.className = "msg-meta";

  const ttlSpan = document.createElement("span");
  const ttlSec = Number(msg.ttlSeconds || 0);
  ttlSpan.textContent = ttlSec > 0 ? `⏳ ${ttlSec}d` : "♾️ Sesi";
  metaDiv.appendChild(ttlSpan);

  if (isOwn) {
    const tickSpan = document.createElement("span");
    tickSpan.className = "read-ticks";
    tickSpan.textContent = "✓";
    tickSpan.title = "Terkirim via P2P";
    metaDiv.appendChild(tickSpan);
    messageBubbles.set(msg.messageId, {
      element: bubble,
      tickSpan,
      readBy: new Set(),
    });
  }

  bubble.appendChild(metaDiv);
  messagesContainer.appendChild(bubble);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  // Ephemeral Auto-Delete Timer
  if (ttlSec > 0) {
    let left = ttlSec;
    const countdownTimer = setInterval(() => {
      left -= 1;
      if (left > 0) {
        ttlSpan.textContent = `⏳ ${left}d`;
      } else {
        clearInterval(countdownTimer);
        bubble.remove();
        messageBubbles.delete(msg.messageId);
      }
    }, 1000);
  }
}

function handleIncomingReadReceipt({ messageId, readerId }) {
  const entry = messageBubbles.get(messageId);
  if (!entry) return;
  entry.readBy.add(readerId);
  entry.tickSpan.textContent = "✓✓";
  entry.tickSpan.classList.add("read");
  entry.tickSpan.title = `Dibaca oleh ${entry.readBy.size} peer`;
}

// Form Submit: Create or Join Room
joinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearLobbyError();

  const deviceName = deviceNameInput.value.trim();
  const roomCode = roomCodeInput.value.trim().toUpperCase();
  const enteredPin = getPinFromBoxes();
  const selectedTtl = Number(ttlSelect.value);

  if (!deviceName || !roomCode) {
    showLobbyError("Nama perangkat dan kode room wajib diisi.");
    return;
  }

  try {
    let activePin = enteredPin;
    let remainingSeconds = 3600;
    let finalMode = selectedMode;

    if (!enteredPin) {
      // Buat room baru
      const res = await fetch("/api/rooms/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room_code: roomCode,
          mode: selectedMode,
          creator_name: deviceName,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showLobbyError(data.detail || "Gagal membuat room baru.");
        return;
      }
      activePin = data.pin;
      remainingSeconds = data.remaining_seconds;
      finalMode = data.mode;
    } else {
      // Gabung ke room yang sudah ada
      if (enteredPin.length !== 6) {
        showLobbyError("PIN Dinamis harus 6 digit angka.");
        return;
      }
      const res = await fetch("/api/rooms/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room_code: roomCode, pin: enteredPin }),
      });
      const data = await res.json();
      if (!res.ok) {
        showLobbyError(data.detail || "PIN Dinamis salah atau room tidak ditemukan.");
        return;
      }
      remainingSeconds = data.remaining_seconds;
      finalMode = data.mode;
    }

    // Switch ke Chat View
    lobbyView.classList.add("hidden");
    chatView.classList.remove("hidden");

    sidebarRoomCode.textContent = roomCode;
    sidebarPin.textContent = activePin;
    roomModeBadge.textContent =
      finalMode === "p2p" ? "P2P 1-on-1" : "Group Mesh (Max 8)";
    sidebarTtlLabel.textContent = formatTtlLabel(selectedTtl);
    startPinCountdown(remainingSeconds);

    meshEngine = new SecureMeshEngine({
      roomCode,
      pin: activePin,
      clientId,
      deviceName,
      onPeerListChange: (peers) => {
        peerCount.textContent = peers.length;
        peerList.innerHTML = "";
        peers.forEach((p) => {
          const li = document.createElement("li");
          li.textContent = `${p.deviceName} • ${p.state}`;
          peerList.appendChild(li);
        });
      },
      onChatMessage: async (msg) => {
        renderChatBubble(msg, false);
        await meshEngine.sendReadReceipt(msg.messageId);
      },
      onTypingSignal: (sig) => handleIncomingTyping(sig),
      onReadReceipt: (ack) => handleIncomingReadReceipt(ack),
      onEncryptedPacketLog: (direction, envelope) => {
        payloadInspector.textContent = `[${direction}] AES-GCM-256\nIV: ${envelope.iv}\nCiphertext: ${envelope.ciphertext}`;
      },
      onSystemNotice: (notice) => appendSystemMessage(notice),
    });

    await meshEngine.connect();
    appendSystemMessage(
      `Terhubung ke room ${roomCode} (Auto-Delete: ${formatTtlLabel(selectedTtl)}).`
    );
  } catch (err) {
    showLobbyError("Terjadi kesalahan jaringan saat menghubungkan ke server.");
  }
});

// Typing Event Emitter
messageInput.addEventListener("input", () => {
  if (!meshEngine) return;

  if (!isCurrentlyTyping && messageInput.value.trim().length > 0) {
    isCurrentlyTyping = true;
    meshEngine.sendTypingStatus(true);
  }

  clearTimeout(typingDebounceTimer);
  typingDebounceTimer = setTimeout(() => {
    if (isCurrentlyTyping) {
      isCurrentlyTyping = false;
      meshEngine.sendTypingStatus(false);
    }
  }, 1500);
});

// Send Chat Message
messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !meshEngine) return;

  const messageId =
    "msg-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6);
  const ttlSeconds = Number(ttlSelect.value);

  const sentPayload = await meshEngine.sendChatMessage({
    messageId,
    text,
    ttlSeconds,
    replyTo: activeReplyTarget,
  });

  renderChatBubble(sentPayload, true);

  messageInput.value = "";
  clearReplyTarget();
  if (isCurrentlyTyping) {
    isCurrentlyTyping = false;
    clearTimeout(typingDebounceTimer);
    meshEngine.sendTypingStatus(false);
  }
});

// Leave & Purge Session
leaveRoomBtn.addEventListener("click", () => {
  meshEngine?.disconnectAll();
  if (pinTimerInterval) clearInterval(pinTimerInterval);
  messagesContainer.innerHTML = "";
  messageBubbles.clear();
  activeTypingPeers.clear();
  clearReplyTarget();
  chatView.classList.add("hidden");
  lobbyView.classList.remove("hidden");
});