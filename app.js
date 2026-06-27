const API = (localStorage.getItem("resolver_api_url") || "https://sos.vsti.cl").replace(/\/$/, "");
const GPS_TIMEOUT_MS = 9000;
const POLL_MS = 10000;
const MAX_GPS_ACCURACY_METERS = Number(localStorage.getItem("resolver_max_gps_accuracy_meters") || 150);
const TERMINAL_STATES = ["CLOSED", "CANCELLED", "RESOLVED"];

const $ = (id) => document.getElementById(id);

let user = JSON.parse(localStorage.getItem("resolver_user") || "null");
let currentStatus = localStorage.getItem("resolver_status") || "OFFLINE";
let currentPosition = null;
let activeTab = "assigned";
let stateCache = null;
let pollTimer = null;
let ticketMap = null;
let routeMap = null;
let routeLayer = null;
let routeMarkers = [];
let activeRouteTicket = null;
let activeFieldTicketId = null;
let activeFieldMode = null;
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let recordingTimeout = null;
let recordingTimerInterval = null;
let recordingStartedAt = null;

const STATUS_LABELS = {
  AVAILABLE: "Disponible",
  BUSY: "Ocupado",
  EN_ROUTE: "En camino",
  ON_SITE: "En sitio",
  OFFLINE: "Fuera de turno"
};

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { status: "error", message: text }; }
  if (!res.ok || data.status === "error") {
    const err = new Error(data.message || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[ch]));
}

function getGpsSource() {
  const ua = navigator.userAgent || "";
  if (window.Capacitor?.isNativePlatform?.()) return `capacitor-${window.Capacitor.getPlatform?.() || "native"}`;
  if (/iPhone|iPad|iPod/i.test(ua)) return "web-ios";
  if (/Android/i.test(ua)) return "web-android";
  if (/Macintosh|Windows|Linux/i.test(ua)) return "web-desktop";
  return "web";
}

function getLocation(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS no disponible"));
    const timer = setTimeout(() => reject(new Error("GPS demoró demasiado")), GPS_TIMEOUT_MS + 1200);
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(timer); resolve(pos); },
      (err) => { clearTimeout(timer); reject(new Error(err.message || "No se pudo obtener GPS")); },
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: options.maximumAge ?? 15000 }
    );
  });
}

function validatePositionQuality(pos) {
  const accuracy = Number(pos?.coords?.accuracy);
  if (Number.isFinite(accuracy) && accuracy > MAX_GPS_ACCURACY_METERS) {
    throw new Error(`GPS impreciso (${Math.round(accuracy)} m). Usa la app desde el teléfono o acércate a una zona con mejor señal.`);
  }
}

async function updateGps(status = currentStatus || "AVAILABLE") {
  if (!user) return null;
  const pos = await getLocation();
  validatePositionQuality(pos);
  currentPosition = pos;

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const accuracy = pos.coords.accuracy;
  const resp = await api("/resolver/location", {
    method: "POST",
    body: JSON.stringify({
      user_id: user.id,
      latitude: lat,
      longitude: lon,
      accuracy,
      status,
      source: getGpsSource()
    })
  });

  currentStatus = resp.effective_status || status;
  localStorage.setItem("resolver_status", currentStatus);
  $("gpsText").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} · precisión ${Math.round(accuracy)} m · ${getGpsSource()}`;
  updateStatusPill(currentStatus);
  return resp;
}

function updateStatusPill(status) {
  const pill = $("statusPill");
  const normalized = String(status || "OFFLINE").toUpperCase();
  pill.textContent = STATUS_LABELS[normalized] || normalized;
  pill.className = `status-pill ${normalized.toLowerCase()}`;
}

async function setStatus(status) {
  if (!user) return;
  try {
    currentStatus = status;
    updateStatusPill(status);
    localStorage.setItem("resolver_status", status);

    if (status === "OFFLINE") {
      await api(`/resolvers/${user.id}/status/offline`, { method: "POST", body: JSON.stringify({}) });
      $("gpsText").textContent = "Fuera de turno. No se actualiza ubicación.";
      toast("Saliste de turno");
    } else {
      await updateGps(status);
      toast(`Estado: ${STATUS_LABELS[status] || status}`);
    }

    await loadState();
  } catch (err) {
    toast(err.message);
  }
}

async function reconcileStatus() {
  if (!user) return null;
  try {
    const resp = await api(`/resolvers/${user.id}/reconcile-status`, { method: "POST", body: JSON.stringify({}) });
    if (resp.reconciled) {
      $("reconcileBox").classList.remove("hidden");
      currentStatus = resp.new_status || "AVAILABLE";
      updateStatusPill(currentStatus);
      setTimeout(() => $("reconcileBox").classList.add("hidden"), 5500);
    }
    return resp;
  } catch (err) {
    console.warn("reconcile failed", err.message);
    return null;
  }
}

function ticketAge(ticket) {
  const ts = new Date(ticket.created_at).getTime();
  if (!Number.isFinite(ts)) return "—";
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs} h ${rem ? rem + " min" : ""}`.trim();
}

function isAssignedToMe(t) {
  return user && t.assigned_resolver_id === user.id;
}

function isPendingForMe(t) {
  return t.assignment_state === "PENDING" && !TERMINAL_STATES.includes(t.state);
}

function isAvailableTicket(t) {
  return !t.assigned_resolver_id && !isPendingForMe(t) && !TERMINAL_STATES.includes(t.state);
}

function alertBadgeClass(t) {
  const a = String(t.alert_type || "").toLowerCase();
  if (a.includes("medical") || a.includes("méd") || a.includes("med")) return "medical";
  if (a.includes("fire") || a.includes("incend")) return "fire";
  if (a.includes("vif") || a.includes("silent")) return "vif";
  if (a.includes("security") || a.includes("seg")) return "security";
  return "";
}

function stateLabel(state) {
  return ({
    ACTIVE: "Activo",
    ASSIGNED: "Asignado",
    ACCEPTED_BY_RESOLVER: "Aceptado",
    EN_ROUTE: "En camino",
    ON_SITE: "En sitio",
    RESOLVED: "Resuelto",
    CLOSED: "Cerrado",
    CANCELLED: "Cancelado"
  })[state] || state || "Activo";
}

function typeIcon(type) {
  const s = String(type || "").toLowerCase();
  if (s.includes("vif")) return "🟣";
  if (s.includes("medical") || s.includes("méd") || s.includes("med")) return "🚑";
  if (s.includes("fire") || s.includes("incend")) return "🔥";
  if (s.includes("security") || s.includes("seg")) return "🚨";
  if (s.includes("accident") || s.includes("accidente")) return "🚧";
  return "🆘";
}

function renderTickets() {
  const list = $("ticketsList");
  const tickets = stateCache?.tickets || [];
  const assigned = tickets.filter((t) => isAssignedToMe(t) || isPendingForMe(t));
  const available = tickets.filter((t) => isAvailableTicket(t));

  $("assignedCount").textContent = assigned.length;
  $("availableCount").textContent = available.length;

  const source = activeTab === "assigned" ? assigned : available;
  if (!source.length) {
    list.innerHTML = `<div class="empty">${activeTab === "assigned" ? "No tienes casos asignados." : "No hay casos disponibles."}</div>`;
    return;
  }

  list.innerHTML = source.map(ticketCard).join("");
  list.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleTicketAction(btn.dataset.action, btn.dataset.id));
  });
}

function ticketCard(t) {
  const pending = isPendingForMe(t);
  const assigned = isAssignedToMe(t);
  const available = isAvailableTicket(t);
  const canUpdateField = assigned && !TERMINAL_STATES.includes(t.state);
  const hasCoords = Number.isFinite(Number(t.latitude)) && Number.isFinite(Number(t.longitude));
  const title = `${typeIcon(t.alert_type)} ${t.title || t.alert_type || "Emergencia"}`;
  const meta = `${t.citizen_name || "Vecino"} · ${ticketAge(t)} · ${stateLabel(t.state)}`;
  const idShort = String(t.id || "").slice(0, 8).toUpperCase();

  let actions = "";

  if (pending) {
    actions += `<button class="primary" data-action="accept" data-id="${t.id}">Aceptar</button>`;
    actions += `<button class="secondary danger-soft" data-action="reject" data-id="${t.id}">Rechazar</button>`;
  } else if (available) {
    actions += `<button class="primary" data-action="take" data-id="${t.id}">Tomar caso</button>`;
  }

  if (assigned) {
    if (t.state === "ACCEPTED_BY_RESOLVER" || t.state === "ASSIGNED") {
      actions += `<button class="primary" data-action="en-route" data-id="${t.id}">Voy en camino</button>`;
    }
    if (t.state === "EN_ROUTE") {
      actions += `<button class="primary" data-action="on-site" data-id="${t.id}">Llegué al lugar</button>`;
    }
    if (["ON_SITE", "EN_ROUTE", "ACCEPTED_BY_RESOLVER", "ASSIGNED"].includes(t.state)) {
      actions += `<button class="control available full" data-action="resolve" data-id="${t.id}">Resolver caso</button>`;
    }
  }

  actions += `<button class="secondary" data-action="detail" data-id="${t.id}">Ver detalle</button>`;
  if (hasCoords) actions += `<button class="secondary" data-action="route" data-id="${t.id}">🗺️ Ver mapa y ruta</button>`;

  if (canUpdateField) {
    actions += `<div class="action-title full">Comunicación y evidencia</div>`;
    actions += `<button class="field-action" data-action="field-text" data-id="${t.id}">📝 Antecedente</button>`;
    actions += `<button class="field-action" data-action="field-audio" data-id="${t.id}">🎙️ Audio</button>`;
    actions += `<button class="field-action" data-action="field-video" data-id="${t.id}">📹 Video</button>`;
    actions += `<button class="field-action disabled" data-action="secure-call" data-id="${t.id}">📞 Llamada segura</button>`;
  }

  return `
    <article class="ticket-card priority-${escapeHtml(t.priority || 3)}">
      <div class="ticket-head">
        <div>
          <h3 class="ticket-title">${escapeHtml(title)}</h3>
          <p class="ticket-meta">#${escapeHtml(idShort)} · ${escapeHtml(meta)}</p>
        </div>
        <span class="badge ${alertBadgeClass(t)}">${escapeHtml(t.alert_type || "SOS")}</span>
      </div>
      <div class="ticket-body">
        <div><strong>Prioridad:</strong> ${escapeHtml(t.priority || "—")}</div>
        <div><strong>Vecino:</strong> ${escapeHtml(t.citizen_name || "—")}</div>
        <div><strong>Teléfono vecino:</strong> ${escapeHtml(t.citizen_phone || "—")}</div>
        <div><strong>Asignación:</strong> ${assigned ? "Asignado a mí" : available ? "Disponible" : escapeHtml(t.resolver_name || "Otro resolutor")}</div>
      </div>
      <div class="actions">${actions}</div>
    </article>`;
}

function findTicket(id) {
  return (stateCache?.tickets || []).find((t) => String(t.id) === String(id));
}

async function handleTicketAction(action, id) {
  const t = findTicket(id);
  if (!t) return;

  try {
    if (action === "detail") return showTicketDetail(t);
    if (action === "route") return openRoutePanel(t);
    if (action === "field-text") return openFieldPanel(t.id, "text");
    if (action === "field-audio") return openFieldPanel(t.id, "audio");
    if (action === "field-video") return openFieldPanel(t.id, "video");
    if (action === "secure-call") return toast("Llamada segura vía WA-CENTER/WebRTC en preparación.");

    if (action === "accept") await api(`/tickets/${id}/accept`, { method: "POST", body: JSON.stringify({ resolver_user_id: user.id }) });
    if (action === "reject") {
      const reason = prompt("Motivo del rechazo", "No puedo tomarlo en este momento");
      if (reason === null) return;
      await api(`/tickets/${id}/reject`, { method: "POST", body: JSON.stringify({ resolver_user_id: user.id, reject_reason: reason }) });
    }
    if (action === "take") await api(`/tickets/${id}/take`, { method: "POST", body: JSON.stringify({ resolver_user_id: user.id }) });
    if (action === "en-route") await api(`/tickets/${id}/en-route`, { method: "POST", body: JSON.stringify({ resolver_user_id: user.id }) });
    if (action === "on-site") await api(`/tickets/${id}/on-site`, { method: "POST", body: JSON.stringify({ resolver_user_id: user.id }) });
    if (action === "resolve") {
      const notes = prompt("Notas de resolución", "Caso atendido en terreno");
      if (notes === null) return;
      await api(`/tickets/${id}/resolve`, { method: "POST", body: JSON.stringify({ resolver_user_id: user.id, resolution_notes: notes }) });
    }

    toast("Acción registrada");
    await loadState();
  } catch (err) {
    toast(err.message);
  }
}

function showTicketDetail(t) {
  const lat = Number(t.latitude);
  const lon = Number(t.longitude);
  $("modalContent").innerHTML = `
    <h2>${escapeHtml(t.title || "Emergencia")}</h2>
    <p><strong>Tipo:</strong> ${escapeHtml(t.alert_type || "SOS")}</p>
    <p><strong>Estado:</strong> ${escapeHtml(stateLabel(t.state))}</p>
    <p><strong>Vecino:</strong> ${escapeHtml(t.citizen_name || "No informado")}</p>
    <p><strong>Teléfono vecino:</strong> ${escapeHtml(t.citizen_phone || "No informado")}</p>
    <p><strong>Descripción:</strong> ${escapeHtml(t.description || "Sin descripción")}</p>
    <p><strong>Ubicación:</strong> ${Number.isFinite(lat) ? lat.toFixed(5) : "—"}, ${Number.isFinite(lon) ? lon.toFixed(5) : "—"}</p>
    <div class="actions detail-actions">
      ${Number.isFinite(lat) && Number.isFinite(lon) ? `<button class="secondary full" type="button" id="btnDetailRoute">🗺️ Ver mapa y ruta</button>` : ""}
      ${isAssignedToMe(t) && !TERMINAL_STATES.includes(t.state) ? `<button class="field-action" type="button" id="btnDetailText">📝 Antecedente</button><button class="field-action" type="button" id="btnDetailAudio">🎙️ Audio</button><button class="field-action" type="button" id="btnDetailVideo">📹 Video</button>` : ""}
    </div>
  `;

  const mapEl = $("ticketMap");
  if (Number.isFinite(lat) && Number.isFinite(lon) && window.L) {
    mapEl.classList.remove("hidden");
    setTimeout(() => {
      if (ticketMap) ticketMap.remove();
      ticketMap = L.map("ticketMap").setView([lat, lon], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(ticketMap);
      L.marker([lat, lon]).addTo(ticketMap).bindPopup("Evento").openPopup();
      const my = getLastKnownLatLon();
      if (my) {
        L.circleMarker([my.latitude, my.longitude], { radius: 7 }).addTo(ticketMap).bindPopup("Mi ubicación");
        L.polyline([[my.latitude, my.longitude], [lat, lon]], { weight: 4, opacity: .6 }).addTo(ticketMap);
      }
      ticketMap.invalidateSize();
    }, 150);
  } else {
    mapEl.classList.add("hidden");
  }

  $("ticketModal").classList.remove("hidden");
  setTimeout(() => {
    const routeBtn = $("btnDetailRoute");
    if (routeBtn) routeBtn.onclick = () => { closeTicketModal(); openRoutePanel(t); };
    const textBtn = $("btnDetailText");
    if (textBtn) textBtn.onclick = () => { closeTicketModal(); openFieldPanel(t.id, "text"); };
    const audioBtn = $("btnDetailAudio");
    if (audioBtn) audioBtn.onclick = () => { closeTicketModal(); openFieldPanel(t.id, "audio"); };
    const videoBtn = $("btnDetailVideo");
    if (videoBtn) videoBtn.onclick = () => { closeTicketModal(); openFieldPanel(t.id, "video"); };
  }, 0);
}

function closeTicketModal() {
  $("ticketModal").classList.add("hidden");
  if (ticketMap) {
    ticketMap.remove();
    ticketMap = null;
  }
}

function openFieldPanel(ticketId, mode) {
  activeFieldTicketId = ticketId;
  activeFieldMode = mode;
  $("fieldTitle").textContent = mode === "text" ? "Agregar antecedente" : mode === "audio" ? "Audio de terreno" : "Video de evidencia";
  $("fieldSubtitle").textContent = "Este antecedente quedará asociado al ticket y visible para la central.";
  $("fieldTextWrap").classList.toggle("hidden", mode !== "text");
  $("fieldAudioWrap").classList.toggle("hidden", mode !== "audio");
  $("fieldVideoWrap").classList.toggle("hidden", mode !== "video");
  $("fieldTextArea").value = "";
  $("fieldAudioStatus").textContent = "Listo para grabar.";
  $("fieldVideoStatus").textContent = "Videos de hasta 25 MB para la demo.";
  $("fieldPanel").classList.remove("hidden");
}

function closeFieldPanel() {
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  $("fieldPanel").classList.add("hidden");
  activeFieldTicketId = null;
  activeFieldMode = null;
}

async function sendFieldText() {
  const message = $("fieldTextArea").value.trim();
  if (!activeFieldTicketId) return;
  if (!message) return toast("Escribe un antecedente antes de enviar.");

  try {
    await api(`/tickets/${activeFieldTicketId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        sender_role: "RESOLVER",
        sender_name: user?.full_name || "Resolutor",
        message
      })
    });
    toast("Antecedente enviado a la central");
    closeFieldPanel();
    await loadState();
  } catch (err) {
    toast(err.message);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function preferredAudioOptions() {
  if (!window.MediaRecorder) return {};
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported?.(mimeType)) return { mimeType };
  }
  return {};
}

function fileExtensionForMime(mimeType, fallback) {
  const clean = String(mimeType || "").split(";")[0].toLowerCase();
  return ({
    "audio/mp4": "m4a",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm"
  })[clean] || fallback;
}

async function uploadFieldMedia(mediaType, blobOrFile, fileName) {
  if (!activeFieldTicketId) throw new Error("No hay ticket activo para adjuntar evidencia.");
  const dataUrl = await blobToDataUrl(blobOrFile);
  await api(`/tickets/${activeFieldTicketId}/media`, {
    method: "POST",
    body: JSON.stringify({
      media_type: mediaType,
      data_url: dataUrl,
      file_name: fileName,
      sender_role: "RESOLVER",
      sender_name: user?.full_name || "Resolutor"
    })
  });
}

function formatRecordingTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = String(Math.floor(total / 60)).padStart(2, "0");
  const sec = String(total % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function startRecordingUI() {
  recordingStartedAt = Date.now();
  $("recordingTimer").textContent = "00:00";
  $("recordingBanner").classList.remove("hidden");
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = setInterval(() => {
    if (recordingStartedAt) $("recordingTimer").textContent = formatRecordingTime(Date.now() - recordingStartedAt);
  }, 500);
}

function stopRecordingUI() {
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = null;
  recordingStartedAt = null;
  $("recordingBanner").classList.add("hidden");
  $("btnStartAudio").textContent = "🎙️ Iniciar grabación";
}

async function toggleFieldAudioRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return toast("Este dispositivo/navegador no permite grabar audio desde la app.");
  }

  try {
    audioChunks = [];
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(audioStream, preferredAudioOptions());

    mediaRecorder.ondataavailable = (event) => {
      if (event.data?.size > 0) audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      clearTimeout(recordingTimeout);
      audioStream?.getTracks().forEach((track) => track.stop());
      stopRecordingUI();

      const mimeType = mediaRecorder.mimeType || audioChunks[0]?.type || "audio/webm";
      const audioBlob = new Blob(audioChunks, { type: mimeType });
      const ext = fileExtensionForMime(mimeType, "webm");
      $("fieldAudioStatus").textContent = "Subiendo audio...";
      try {
        await uploadFieldMedia("audio", audioBlob, `audio-resolutor-${Date.now()}.${ext}`);
        $("fieldAudioStatus").textContent = "Audio enviado a la central.";
        toast("Audio enviado a la central");
        closeFieldPanel();
        await loadState();
      } catch (err) {
        $("fieldAudioStatus").textContent = "No se pudo enviar el audio.";
        toast(err.message);
      }
    };

    mediaRecorder.start();
    $("btnStartAudio").textContent = "⏹️ Detener y enviar audio";
    $("fieldAudioStatus").textContent = "Grabando. Describe brevemente lo que ocurre en terreno.";
    startRecordingUI();
    recordingTimeout = setTimeout(() => {
      if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    }, 30000);
  } catch (err) {
    $("fieldAudioStatus").textContent = "No se pudo acceder al micrófono.";
    toast(err.message);
  }
}

async function uploadFieldVideo() {
  const file = $("fieldVideoInput").files?.[0];
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    $("fieldVideoInput").value = "";
    return toast("El video es muy grande para la demo. Usa un clip más corto.");
  }

  $("fieldVideoStatus").textContent = "Subiendo video...";
  try {
    await uploadFieldMedia("video", file, file.name || `video-resolutor-${Date.now()}.mp4`);
    $("fieldVideoStatus").textContent = "Video enviado a la central.";
    toast("Video enviado a la central");
    closeFieldPanel();
    await loadState();
  } catch (err) {
    $("fieldVideoStatus").textContent = "No se pudo enviar el video.";
    toast(err.message);
  } finally {
    $("fieldVideoInput").value = "";
  }
}

function getLastKnownLatLon() {
  if (currentPosition?.coords) {
    return { latitude: currentPosition.coords.latitude, longitude: currentPosition.coords.longitude, accuracy: currentPosition.coords.accuracy };
  }
  const loc = stateCache?.location;
  if (loc?.latitude && loc?.longitude) {
    return { latitude: Number(loc.latitude), longitude: Number(loc.longitude), accuracy: loc.accuracy };
  }
  return null;
}

async function getFreshResolverPosition() {
  const pos = await getLocation({ maximumAge: 3000 });
  validatePositionQuality(pos);
  currentPosition = pos;
  await updateGps(currentStatus === "OFFLINE" ? "AVAILABLE" : currentStatus).catch(() => null);
  return { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy };
}

function initRouteMap() {
  if (routeMap) return;
  routeMap = L.map("routeMap", { zoomControl: true }).setView([-33.01895, -71.5509], 15);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(routeMap);
}

function clearRouteMap() {
  if (!routeMap) return;
  if (routeLayer) {
    routeMap.removeLayer(routeLayer);
    routeLayer = null;
  }
  routeMarkers.forEach((marker) => routeMap.removeLayer(marker));
  routeMarkers = [];
}

function routeIcon(kind) {
  const html = kind === "resolver" ? `<div class="resolver-route-marker">👮</div>` : `<div class="incident-route-marker">🚨</div>`;
  return L.divIcon({ className: "", html, iconSize: [48, 48], iconAnchor: [24, 24] });
}

function toRad(n) { return n * Math.PI / 180; }
function distanceMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function formatDistance(m) { return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; }
function formatEta(s) { const min = Math.max(1, Math.round(s / 60)); return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`; }

async function renderRoute(ticket) {
  initRouteMap();
  clearRouteMap();
  setTimeout(() => routeMap.invalidateSize(), 120);

  const dest = { latitude: Number(ticket.latitude), longitude: Number(ticket.longitude) };
  if (!Number.isFinite(dest.latitude) || !Number.isFinite(dest.longitude)) {
    $("routeStatus").textContent = "Este caso no tiene coordenadas válidas.";
    return;
  }

  $("routeStatus").textContent = "Obteniendo tu ubicación actual...";
  let origin;
  try {
    origin = await getFreshResolverPosition();
  } catch (err) {
    origin = getLastKnownLatLon();
    if (origin) {
      $("routeStatus").textContent = "Usando la última ubicación conocida del resolutor.";
    } else {
      $("routeStatus").textContent = err.message;
      return;
    }
  }

  const originLatLng = [origin.latitude, origin.longitude];
  const destLatLng = [dest.latitude, dest.longitude];
  routeMarkers.push(L.marker(originLatLng, { icon: routeIcon("resolver") }).addTo(routeMap).bindPopup("Tu ubicación"));
  routeMarkers.push(L.marker(destLatLng, { icon: routeIcon("incident") }).addTo(routeMap).bindPopup(ticket.title || "Emergencia"));

  const direct = distanceMeters(origin.latitude, origin.longitude, dest.latitude, dest.longitude);
  $("routeStatus").textContent = "Calculando ruta vial...";

  try {
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin.longitude},${origin.latitude};${dest.longitude},${dest.latitude}?overview=full&geometries=geojson&steps=false`;
    const res = await fetch(osrmUrl);
    const data = await res.json();
    if (!res.ok || data.code !== "Ok" || !data.routes?.length) throw new Error("Ruta no disponible");
    const route = data.routes[0];
    const latLngs = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    routeLayer = L.polyline(latLngs, { weight: 6, opacity: .9 }).addTo(routeMap);
    routeMap.fitBounds(routeLayer.getBounds(), { padding: [30, 30], maxZoom: 17 });
    $("routeStatus").innerHTML = `Ruta estimada: <strong>${formatDistance(route.distance)}</strong> · ETA: <strong>${formatEta(route.duration)}</strong> · distancia directa: ${formatDistance(direct)}`;
  } catch (err) {
    routeLayer = L.polyline([originLatLng, destLatLng], { weight: 5, opacity: .85, dashArray: "8,8" }).addTo(routeMap);
    routeMap.fitBounds(routeLayer.getBounds(), { padding: [30, 30], maxZoom: 17 });
    $("routeStatus").innerHTML = `No fue posible calcular ruta vial. Mostrando línea directa: <strong>${formatDistance(direct)}</strong>.`;
  }
}

function openRoutePanel(ticket) {
  activeRouteTicket = ticket;
  $("routeTitle").textContent = ticket.title || ticket.alert_type || "Emergencia";
  $("routeSubtitle").textContent = `${ticket.citizen_name || "Vecino"} · ${ticket.latitude}, ${ticket.longitude}`;
  $("routePanel").classList.remove("hidden");
  renderRoute(ticket);
}

function closeRoutePanel() {
  $("routePanel").classList.add("hidden");
  activeRouteTicket = null;
}

function refreshActiveRoute() {
  if (activeRouteTicket) renderRoute(activeRouteTicket);
}

function openExternalNavigation(kind) {
  if (!activeRouteTicket) return;
  const lat = Number(activeRouteTicket.latitude);
  const lon = Number(activeRouteTicket.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return toast("El ticket no tiene coordenadas válidas.");

  let url;
  if (kind === "google") url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
  if (kind === "apple") url = `maps://?daddr=${lat},${lon}&dirflg=d`;
  if (kind === "waze") url = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
  window.open(url, "_blank");
}

async function loadState() {
  if (!user) return;
  try {
    const data = await api(`/resolver/${user.id}/state`);
    stateCache = data;
    user = data.resolver;
    localStorage.setItem("resolver_user", JSON.stringify(user));
    $("resolverName").textContent = user.full_name || "Resolutor";
    $("resolverCenter").textContent = user.control_center_name || user.control_center_code || "Centro de control";
    currentStatus = data.location?.status || data.reconciliation?.new_status || currentStatus || "OFFLINE";
    localStorage.setItem("resolver_status", currentStatus);
    updateStatusPill(currentStatus);
    if (data.location?.latitude && data.location?.longitude) {
      const acc = data.location.accuracy != null ? ` · precisión ${Math.round(Number(data.location.accuracy))} m` : "";
      $("gpsText").textContent = `${Number(data.location.latitude).toFixed(5)}, ${Number(data.location.longitude).toFixed(5)}${acc} · ${new Date(data.location.updated_at).toLocaleTimeString()}`;
    }
    if (data.reconciliation?.reconciled) {
      $("reconcileBox").classList.remove("hidden");
      setTimeout(() => $("reconcileBox").classList.add("hidden"), 5500);
    }
    renderTickets();
  } catch (err) {
    toast(err.message);
  }
}

async function login() {
  const phone = $("phoneInput").value.trim();
  $("loginMsg").textContent = "";
  if (!phone) {
    $("loginMsg").textContent = "Ingresa un teléfono.";
    return;
  }
  try {
    const resp = await api("/auth/login-demo", { method: "POST", body: JSON.stringify({ phone }) });
    if (resp.user.role !== "RESOLVER") throw new Error("Este usuario no tiene rol RESOLVER");
    user = resp.user;
    localStorage.setItem("resolver_user", JSON.stringify(user));
    showMain();
    await updateGps("AVAILABLE").catch((err) => toast(err.message));
    await reconcileStatus();
    await loadState();
    startPolling();
  } catch (err) {
    $("loginMsg").textContent = err.message;
  }
}

function showMain() {
  $("loginView").classList.add("hidden");
  $("mainView").classList.remove("hidden");
  $("btnSettings").classList.remove("hidden");
  $("resolverName").textContent = user?.full_name || "Resolutor";
  $("resolverCenter").textContent = user?.control_center_name || user?.control_center_code || "Centro de control";
  updateStatusPill(currentStatus);
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(loadState, POLL_MS);
}

function init() {
  $("btnLogin").addEventListener("click", login);
  $("btnAvailable").addEventListener("click", () => setStatus("AVAILABLE"));
  $("btnBusy").addEventListener("click", () => setStatus("BUSY"));
  $("btnOffline").addEventListener("click", () => setStatus("OFFLINE"));
  $("btnUpdateGps").addEventListener("click", () => updateGps(currentStatus === "OFFLINE" ? "AVAILABLE" : currentStatus).then(() => toast("GPS actualizado")).catch((err) => toast(err.message)));
  $("btnCloseModal").addEventListener("click", closeTicketModal);
  $("btnCloseFieldPanel").addEventListener("click", closeFieldPanel);
  $("btnSendFieldText").addEventListener("click", sendFieldText);
  $("btnStartAudio").addEventListener("click", toggleFieldAudioRecording);
  $("btnPickVideo").addEventListener("click", () => $("fieldVideoInput").click());
  $("fieldVideoInput").addEventListener("change", uploadFieldVideo);
  $("btnCloseRoute").addEventListener("click", closeRoutePanel);
  $("btnRefreshRoute").addEventListener("click", refreshActiveRoute);
  $("btnOpenGoogleMaps").addEventListener("click", () => openExternalNavigation("google"));
  $("btnOpenAppleMaps").addEventListener("click", () => openExternalNavigation("apple"));
  $("btnOpenWaze").addEventListener("click", () => openExternalNavigation("waze"));

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    renderTickets();
  }));

  $("btnSettings").addEventListener("click", () => {
    const newApi = prompt("URL API", API);
    if (newApi && newApi.replace(/\/$/, "") !== API) {
      localStorage.setItem("resolver_api_url", newApi.replace(/\/$/, ""));
      location.reload();
    }
  });

  if (user) {
    showMain();
    loadState();
    if (currentStatus !== "OFFLINE") updateGps(currentStatus).catch(() => null);
    startPolling();
  }
}

init();
