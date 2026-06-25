const API = "https://sos.vsti.cl";

const loginView = document.getElementById("loginView");
const appView = document.getElementById("appView");
const phoneInput = document.getElementById("phoneInput");
const loginButton = document.getElementById("loginButton");
const loginError = document.getElementById("loginError");
const connectionPill = document.getElementById("connectionPill");
const resolverName = document.getElementById("resolverName");
const resolverMeta = document.getElementById("resolverMeta");
const resolverStatus = document.getElementById("resolverStatus");
const gpsStatus = document.getElementById("gpsStatus");
const accuracyStatus = document.getElementById("accuracyStatus");
const ticketCount = document.getElementById("ticketCount");
const ticketsList = document.getElementById("ticketsList");
const emptyState = document.getElementById("emptyState");
const lastUpdate = document.getElementById("lastUpdate");
const availableButton = document.getElementById("availableButton");
const busyButton = document.getElementById("busyButton");
const refreshButton = document.getElementById("refreshButton");
const logoutButton = document.getElementById("logoutButton");
const fieldPanel = document.getElementById("fieldPanel");
const fieldPanelTitle = document.getElementById("fieldPanelTitle");
const closeFieldPanelButton = document.getElementById("closeFieldPanelButton");
const fieldTextAreaWrap = document.getElementById("fieldTextAreaWrap");
const fieldTextArea = document.getElementById("fieldTextArea");
const sendFieldTextButton = document.getElementById("sendFieldTextButton");
const fieldAudioWrap = document.getElementById("fieldAudioWrap");
const startFieldAudioButton = document.getElementById("startFieldAudioButton");
const fieldAudioStatus = document.getElementById("fieldAudioStatus");
const fieldVideoWrap = document.getElementById("fieldVideoWrap");
const pickFieldVideoButton = document.getElementById("pickFieldVideoButton");
const fieldVideoInput = document.getElementById("fieldVideoInput");
const fieldVideoStatus = document.getElementById("fieldVideoStatus");
const recordingBanner = document.getElementById("recordingBanner");
const recordingTimer = document.getElementById("recordingTimer");
const routePanel = document.getElementById("routePanel");
const routeTitle = document.getElementById("routeTitle");
const routeSubtitle = document.getElementById("routeSubtitle");
const routeStatus = document.getElementById("routeStatus");
const closeRoutePanelButton = document.getElementById("closeRoutePanelButton");
const closeRoutePanelButtonBottom = document.getElementById("closeRoutePanelButtonBottom");
const recenterRouteButton = document.getElementById("recenterRouteButton");

let currentUser = null;
let currentLocation = null;
let currentStatus = localStorage.getItem("resolver_status") || "AVAILABLE";
let refreshTimer = null;
let locationTimer = null;
let activeFieldTicketId = null;
let activeFieldMode = null;
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let recordingTimeout = null;
let recordingTimerInterval = null;
let recordingStartedAt = null;
let routeMap = null;
let routeLayer = null;
let routeMarkers = [];
let activeRouteTicket = null;

function setConnection(ok) {
  connectionPill.textContent = ok ? "online" : "offline";
  connectionPill.className = ok ? "pill online" : "pill offline";
}

function saveSession(user) {
  currentUser = user;
  localStorage.setItem("resolver_user", JSON.stringify(user));
}

function loadSession() {
  try {
    const raw = localStorage.getItem("resolver_user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function showApp(user) {
  currentUser = user;
  loginView.hidden = true;
  appView.hidden = false;

  resolverName.textContent = user.full_name || "Resolutor";
  resolverMeta.textContent = `${user.phone || "-"} · ${user.control_center_code || "-"}`;
  resolverStatus.textContent = currentStatus;

  startLocationUpdates();
  refreshState();
  refreshTimer = setInterval(refreshState, 5000);
}

function showLogin() {
  loginView.hidden = false;
  appView.hidden = true;
  clearInterval(refreshTimer);
  clearInterval(locationTimer);
}

async function login() {
  loginError.textContent = "";
  const phone = phoneInput.value.trim();

  if (!phone) {
    loginError.textContent = "Ingresa un teléfono.";
    return;
  }

  loginButton.disabled = true;
  loginButton.textContent = "Entrando...";

  try {
    const res = await fetch(`${API}/auth/login-demo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone })
    });

    const data = await res.json();

    if (!res.ok || data.status !== "ok") {
      throw new Error(data.message || "No fue posible ingresar");
    }

    if (data.user.role !== "RESOLVER") {
      throw new Error(`El usuario existe, pero su rol es ${data.user.role}. Debe ser RESOLVER.`);
    }

    saveSession(data.user);
    showApp(data.user);
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = "Entrar";
  }
}

function startLocationUpdates() {
  updateLocation();
  locationTimer = setInterval(updateLocation, 10000);
}

function updateLocation() {
  if (!navigator.geolocation || !currentUser) {
    gpsStatus.textContent = "no disponible";
    return;
  }

  gpsStatus.textContent = "buscando...";

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      currentLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: Math.round(position.coords.accuracy)
      };

      gpsStatus.textContent = "OK";
      accuracyStatus.textContent = `${currentLocation.accuracy} m`;

      await sendResolverLocation(currentStatus);
    },
    () => {
      gpsStatus.textContent = "error";
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 5000
    }
  );
}

async function sendResolverLocation(status) {
  if (!currentUser || !currentLocation) return;

  currentStatus = status;
  localStorage.setItem("resolver_status", currentStatus);
  resolverStatus.textContent = currentStatus;

  try {
    const res = await fetch(`${API}/resolver/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: currentUser.id,
        latitude: currentLocation.latitude,
        longitude: currentLocation.longitude,
        accuracy: currentLocation.accuracy,
        status: currentStatus
      })
    });

    const data = await res.json();
    if (!res.ok || data.status !== "ok") {
      throw new Error(data.message || "Error actualizando ubicación");
    }

    setConnection(true);
  } catch (error) {
    console.error(error);
    setConnection(false);
  }
}

async function refreshState() {
  if (!currentUser) return;

  try {
    const res = await fetch(`${API}/resolver/${currentUser.id}/state`);
    const data = await res.json();

    if (!res.ok || data.status !== "ok") {
      throw new Error(data.message || "Error consultando estado");
    }

    setConnection(true);

    if (data.location?.status) {
      currentStatus = data.location.status;
      resolverStatus.textContent = currentStatus;
    }

    renderTickets(data.tickets || []);
    ticketCount.textContent = data.tickets?.length || 0;
    lastUpdate.textContent = new Date().toLocaleTimeString();
  } catch (error) {
    console.error(error);
    setConnection(false);
  }
}

function stateLabel(state) {
  const labels = {
    ACTIVE: "Activo",
    ACKNOWLEDGED: "Reconocido",
    ASSIGNED: "Asignado",
    ACCEPTED_BY_RESOLVER: "Aceptado",
    EN_ROUTE: "En camino",
    ON_SITE: "En sitio",
    RESOLVED: "Resuelto",
    CLOSED: "Cerrado"
  };

  return labels[state] || state;
}

function typeIcon(alertType) {
  const icons = {
    SOS_MANUAL: "🚨",
    MEDICAL: "🚑",
    FIRE: "🔥",
    SECURITY: "👮",
    VIF: "🏠",
    TRAFFIC_ACCIDENT: "🚗",
    URBAN_RISK: "⚠️",
    OTHER: "📝"
  };

  return icons[alertType] || "🚨";
}

function formatAge(createdAt) {
  if (!createdAt) return "-";
  const elapsed = Date.now() - new Date(createdAt).getTime();
  const min = Math.floor(elapsed / 60000);
  const sec = Math.floor((elapsed % 60000) / 1000);
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${min}m ${sec}s`;
}


function formatRecordingTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function updateRecordingTimer() {
  if (!recordingStartedAt) return;
  recordingTimer.textContent = formatRecordingTime(Date.now() - recordingStartedAt);
}

function startRecordingUI() {
  recordingStartedAt = Date.now();
  updateRecordingTimer();
  recordingBanner.hidden = false;
  navigator.vibrate?.(80);
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = setInterval(updateRecordingTimer, 500);
}

function stopRecordingUI() {
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = null;
  recordingStartedAt = null;
  recordingBanner.hidden = true;
  startFieldAudioButton.textContent = "🎙️ Iniciar grabación";
  navigator.vibrate?.([60, 80, 60]);
}

function openFieldPanel(ticketId, mode) {
  activeFieldTicketId = ticketId;
  activeFieldMode = mode;

  fieldTextAreaWrap.hidden = mode !== "text";
  fieldAudioWrap.hidden = mode !== "audio";
  fieldVideoWrap.hidden = mode !== "video";

  fieldPanelTitle.textContent = mode === "text"
    ? "Reporte de situación"
    : mode === "audio"
    ? "Audio de terreno"
    : "Video de evidencia";

  fieldTextArea.value = "";
  fieldAudioStatus.textContent = "Listo para grabar.";
  fieldVideoStatus.textContent = "Videos de hasta 25 MB para la demo.";
  fieldPanel.hidden = false;
}

function closeFieldPanel() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
  activeFieldTicketId = null;
  activeFieldMode = null;
  fieldPanel.hidden = true;
}

function requireActiveFieldTicket() {
  if (!activeFieldTicketId) {
    alert("Selecciona un caso primero.");
    return false;
  }
  return true;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getPreferredAudioOptions() {
  if (!window.MediaRecorder) return {};
  const candidates = [
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus"
  ];

  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return { mimeType };
    }
  }

  return {};
}

function extensionForMime(mimeType, fallback) {
  const clean = String(mimeType || "").split(";")[0];
  const map = {
    "audio/mp4": "m4a",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm"
  };
  return map[clean] || fallback;
}

async function sendFieldText() {
  if (!requireActiveFieldTicket()) return;

  const message = fieldTextArea.value.trim();
  if (!message) {
    alert("Escribe un reporte de situación.");
    return;
  }

  sendFieldTextButton.disabled = true;
  sendFieldTextButton.textContent = "Enviando...";

  try {
    const res = await fetch(`${API}/tickets/${activeFieldTicketId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender_role: "RESOLVER",
        sender_name: currentUser?.full_name || "Resolutor",
        message
      })
    });

    const data = await res.json();
    if (!res.ok || data.status !== "ok") {
      throw new Error(data.message || "No fue posible enviar el reporte");
    }

    fieldTextArea.value = "";
    fieldPanel.hidden = true;
    await refreshState();
    alert("Reporte enviado a la central");
  } catch (error) {
    alert(error.message);
  } finally {
    sendFieldTextButton.disabled = false;
    sendFieldTextButton.textContent = "Enviar reporte de situación";
  }
}

async function uploadFieldMedia(mediaType, blob, fileName) {
  if (!requireActiveFieldTicket()) return;

  const dataUrl = await blobToDataUrl(blob);
  const res = await fetch(`${API}/tickets/${activeFieldTicketId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender_role: "RESOLVER",
      sender_name: currentUser?.full_name || "Resolutor",
      media_type: mediaType,
      file_name: fileName,
      data_url: dataUrl
    })
  });

  const data = await res.json();
  if (!res.ok || data.status !== "ok") {
    throw new Error(data.message || `No fue posible subir ${mediaType}`);
  }

  await refreshState();
}

async function toggleFieldAudioRecording() {
  if (!requireActiveFieldTicket()) return;

  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    alert("Este navegador no permite grabar audio desde la PWA.");
    return;
  }

  try {
    audioChunks = [];
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(audioStream, getPreferredAudioOptions());

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      clearTimeout(recordingTimeout);
      audioStream?.getTracks().forEach(track => track.stop());
      stopRecordingUI();

      const mimeType = mediaRecorder.mimeType || audioChunks[0]?.type || "audio/webm";
      const audioBlob = new Blob(audioChunks, { type: mimeType });
      const ext = extensionForMime(mimeType, "webm");

      fieldAudioStatus.textContent = "Subiendo audio...";

      try {
        await uploadFieldMedia("audio", audioBlob, `audio-resolutor-${Date.now()}.${ext}`);
        fieldAudioStatus.textContent = "Audio enviado a la central.";
        fieldPanel.hidden = true;
        alert("Audio enviado a la central");
      } catch (error) {
        console.error(error);
        fieldAudioStatus.textContent = "No se pudo enviar el audio.";
        alert(error.message);
      }
    };

    mediaRecorder.start();
    startFieldAudioButton.textContent = "⏹️ Detener y enviar audio";
    fieldAudioStatus.textContent = "Grabando. Describe brevemente lo que ocurre en terreno.";
    startRecordingUI();

    recordingTimeout = setTimeout(() => {
      if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    }, 30000);
  } catch (error) {
    console.error(error);
    fieldAudioStatus.textContent = "No se pudo acceder al micrófono.";
  }
}

async function uploadFieldVideo() {
  if (!requireActiveFieldTicket()) return;
  const file = fieldVideoInput.files?.[0];
  if (!file) return;

  if (file.size > 25 * 1024 * 1024) {
    alert("El video es muy grande para la demo. Usa un clip más corto.");
    fieldVideoInput.value = "";
    return;
  }

  fieldVideoStatus.textContent = "Subiendo video...";

  try {
    await uploadFieldMedia("video", file, file.name || `video-resolutor-${Date.now()}.mp4`);
    fieldVideoStatus.textContent = "Video enviado a la central.";
    fieldPanel.hidden = true;
    alert("Video enviado a la central");
  } catch (error) {
    console.error(error);
    fieldVideoStatus.textContent = "No se pudo enviar el video.";
    alert(error.message);
  } finally {
    fieldVideoInput.value = "";
  }
}


function callNeighbor(phone) {
  if (!phone) {
    alert("Este ticket no tiene teléfono de vecino registrado.");
    return;
  }

  window.location.href = `tel:${phone}`;
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "-";
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return "-";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes} min`;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (v) => v * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ticketLabel(ticket) {
  return `${typeIcon(ticket.alert_type)} ${ticket.title || ticket.alert_type || "Emergencia"} #${String(ticket.id).slice(0, 8).toUpperCase()}`;
}

function getFreshResolverPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("GPS no disponible en este dispositivo."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        currentLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Math.round(position.coords.accuracy)
        };

        gpsStatus.textContent = "OK";
        accuracyStatus.textContent = `${currentLocation.accuracy} m`;

        try {
          await sendResolverLocation(currentStatus);
        } catch (error) {
          console.warn("No se pudo reportar ubicación al backend", error);
        }

        resolve(currentLocation);
      },
      () => reject(new Error("No se pudo obtener tu ubicación actual.")),
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 3000
      }
    );
  });
}

function initRouteMap() {
  if (routeMap) return;

  routeMap = L.map("routeMap", {
    zoomControl: true
  }).setView([-33.01895, -71.55090], 15);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap"
  }).addTo(routeMap);
}

function clearRouteMap() {
  if (routeLayer) {
    routeMap.removeLayer(routeLayer);
    routeLayer = null;
  }

  routeMarkers.forEach(marker => routeMap.removeLayer(marker));
  routeMarkers = [];
}

function routeIcon(kind) {
  const html = kind === "resolver"
    ? `<div class="resolver-route-marker">👮</div>`
    : `<div class="incident-route-marker">🚨</div>`;

  return L.divIcon({
    className: "",
    html,
    iconSize: [48, 48],
    iconAnchor: [24, 24]
  });
}

async function renderRoute(ticket) {
  initRouteMap();
  clearRouteMap();

  setTimeout(() => routeMap.invalidateSize(), 80);

  if (!ticket?.latitude || !ticket?.longitude) {
    routeStatus.textContent = "Este caso no tiene coordenadas válidas.";
    return;
  }

  routeStatus.textContent = "Obteniendo tu ubicación actual...";

  let origin;
  try {
    origin = await getFreshResolverPosition();
  } catch (error) {
    if (currentLocation?.latitude && currentLocation?.longitude) {
      origin = currentLocation;
      routeStatus.textContent = "Usando la última ubicación conocida del resolutor.";
    } else {
      routeStatus.textContent = error.message;
      return;
    }
  }

  const dest = {
    latitude: Number(ticket.latitude),
    longitude: Number(ticket.longitude)
  };

  const originLatLng = [origin.latitude, origin.longitude];
  const destLatLng = [dest.latitude, dest.longitude];

  routeMarkers.push(
    L.marker(originLatLng, { icon: routeIcon("resolver") })
      .addTo(routeMap)
      .bindPopup("Tu ubicación actual")
  );

  routeMarkers.push(
    L.marker(destLatLng, { icon: routeIcon("incident") })
      .addTo(routeMap)
      .bindPopup(ticketLabel(ticket))
  );

  const directDistance = distanceMeters(
    origin.latitude,
    origin.longitude,
    dest.latitude,
    dest.longitude
  );

  routeStatus.textContent = "Calculando ruta...";

  try {
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin.longitude},${origin.latitude};${dest.longitude},${dest.latitude}?overview=full&geometries=geojson&steps=false`;
    const res = await fetch(osrmUrl);
    const data = await res.json();

    if (!res.ok || data.code !== "Ok" || !data.routes?.length) {
      throw new Error("Ruta no disponible");
    }

    const route = data.routes[0];
    const latLngs = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);

    routeLayer = L.polyline(latLngs, {
      weight: 6,
      opacity: .9
    }).addTo(routeMap);

    routeMap.fitBounds(routeLayer.getBounds(), {
      padding: [30, 30],
      maxZoom: 17
    });

    routeStatus.innerHTML = `Ruta estimada: <strong>${formatDistance(route.distance)}</strong> · ETA: <strong>${formatEta(route.duration)}</strong> · distancia directa: ${formatDistance(directDistance)}`;
  } catch (error) {
    routeLayer = L.polyline([originLatLng, destLatLng], {
      weight: 5,
      opacity: .8,
      dashArray: "8, 8"
    }).addTo(routeMap);

    routeMap.fitBounds(routeLayer.getBounds(), {
      padding: [30, 30],
      maxZoom: 17
    });

    routeStatus.innerHTML = `No fue posible calcular ruta vial. Mostrando línea directa: <strong>${formatDistance(directDistance)}</strong>.`;
  }
}

function openRoutePanel(ticket) {
  activeRouteTicket = ticket;
  routeTitle.textContent = ticketLabel(ticket);
  routeSubtitle.textContent = `${ticket.citizen_name || "Vecino"} · ${ticket.latitude}, ${ticket.longitude}`;
  routePanel.hidden = false;
  renderRoute(ticket);
}

function closeRoutePanel() {
  routePanel.hidden = true;
  activeRouteTicket = null;
}

function refreshActiveRoute() {
  if (!activeRouteTicket) return;
  renderRoute(activeRouteTicket);
}

function renderTickets(tickets) {
  ticketsList.innerHTML = "";
  emptyState.hidden = tickets.length > 0;

  tickets.forEach((ticket) => {
    const mine = ticket.assigned_resolver_id === currentUser.id;
    const unassigned = !ticket.assigned_resolver_id;
    const pendingForMe = ticket.assignment_state === "PENDING";

    const div = document.createElement("article");
    div.className = `ticket-card priority-${ticket.priority || 3}`;

    div.innerHTML = `
      <div class="ticket-head">
        <div>
          <div class="ticket-title">${typeIcon(ticket.alert_type)} ${ticket.title || ticket.alert_type}</div>
          <div class="ticket-id">#${String(ticket.id).slice(0, 8).toUpperCase()}</div>
        </div>
        <span class="state-badge state-${ticket.state}">${stateLabel(ticket.state)}</span>
      </div>

      <div class="ticket-body">
        <div><strong>Tiempo:</strong> ${formatAge(ticket.created_at)}</div>
        <div><strong>Prioridad:</strong> ${ticket.priority || "-"}</div>
        <div><strong>Vecino:</strong> ${ticket.citizen_name || "-"}</div>
        <div><strong>Teléfono:</strong> ${ticket.citizen_phone || "-"}</div>
        <div><strong>Asignación:</strong> ${mine ? "Asignado a mí" : unassigned ? "Disponible" : ticket.resolver_name || "Otro resolutor"}</div>
        <div><strong>Distancia asignación:</strong> ${ticket.distance_meters ? Math.round(ticket.distance_meters) + " m" : "-"}</div>
      </div>

      <div class="ticket-actions" id="actions-${ticket.id}"></div>
    `;

    ticketsList.appendChild(div);

    const actions = div.querySelector(`#actions-${CSS.escape(ticket.id)}`);

    if (unassigned) {
      addButton(actions, "Tomar caso", "primary", () => takeTicket(ticket.id));
    }

    if (pendingForMe || (mine && ticket.state === "ASSIGNED")) {
      addButton(actions, "Aceptar", "primary", () => acceptTicket(ticket.id));
      addButton(actions, "Rechazar", "danger", () => rejectTicket(ticket.id));
    }

    if (mine && ticket.state === "ACCEPTED_BY_RESOLVER") {
      addButton(actions, "Voy en camino", "primary", () => enRoute(ticket.id));
    }

    if (mine && ticket.state === "EN_ROUTE") {
      addButton(actions, "Llegué al sitio", "primary", () => onSite(ticket.id));
    }

    if (mine && ticket.state === "ON_SITE") {
      addButton(actions, "Resolver", "success", () => resolveTicket(ticket.id));
    }

    if (mine && !["RESOLVED", "CLOSED", "CANCELLED"].includes(ticket.state)) {
      if (ticket.citizen_phone) {
        addActionTitle(actions, "Contacto con vecino");
        addButton(actions, "📞 Llamar vecino", "field-action-button", () => callNeighbor(ticket.citizen_phone));
      }

      addActionTitle(actions, "Bitácora de terreno");
      addButton(actions, "📝 Reporte situación", "field-action-button", () => openFieldPanel(ticket.id, "text"));
      addButton(actions, "🎙️ Audio terreno", "field-action-button", () => openFieldPanel(ticket.id, "audio"));
      addButton(actions, "📹 Video evidencia", "field-action-button", () => openFieldPanel(ticket.id, "video"));
    }

    if (ticket.latitude && ticket.longitude) {
      addButton(actions, "🗺️ Ver mapa y ruta", "secondary", () => openRoutePanel(ticket));
    }
  });
}

function addActionTitle(container, label) {
  const title = document.createElement("div");
  title.className = "field-actions-title";
  title.textContent = label;
  container.appendChild(title);
}

function addButton(container, label, cssClass, handler) {
  const button = document.createElement("button");
  button.className = cssClass;
  button.textContent = label;
  button.onclick = handler;
  container.appendChild(button);
}

async function postTicketAction(ticketId, path, body = {}) {
  try {
    const res = await fetch(`${API}/tickets/${ticketId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resolver_user_id: currentUser.id,
        ...body
      })
    });

    const data = await res.json();

    if (!res.ok || data.status !== "ok") {
      throw new Error(data.message || "No fue posible actualizar el caso");
    }

    await refreshState();
  } catch (error) {
    alert(error.message);
  }
}

function takeTicket(ticketId) {
  postTicketAction(ticketId, "take");
}

function acceptTicket(ticketId) {
  postTicketAction(ticketId, "accept");
}

function rejectTicket(ticketId) {
  const reason = prompt("Motivo del rechazo", "No puedo atender este caso");
  if (reason === null) return;
  postTicketAction(ticketId, "reject", { reject_reason: reason });
}

function enRoute(ticketId) {
  postTicketAction(ticketId, "en-route");
}

function onSite(ticketId) {
  postTicketAction(ticketId, "on-site");
}

function resolveTicket(ticketId) {
  const notes = prompt("Notas de resolución", "Caso atendido en terreno");
  if (notes === null) return;
  postTicketAction(ticketId, "resolve", { resolution_notes: notes });
}

closeFieldPanelButton.onclick = closeFieldPanel;
sendFieldTextButton.onclick = sendFieldText;
startFieldAudioButton.onclick = toggleFieldAudioRecording;
pickFieldVideoButton.onclick = () => fieldVideoInput.click();
fieldVideoInput.onchange = uploadFieldVideo;

closeRoutePanelButton.onclick = closeRoutePanel;
closeRoutePanelButtonBottom.onclick = closeRoutePanel;
recenterRouteButton.onclick = refreshActiveRoute;

loginButton.onclick = login;
refreshButton.onclick = refreshState;
availableButton.onclick = async () => {
  currentStatus = "AVAILABLE";
  await sendResolverLocation(currentStatus);
  await refreshState();
};
busyButton.onclick = async () => {
  currentStatus = "BUSY";
  await sendResolverLocation(currentStatus);
  await refreshState();
};
logoutButton.onclick = () => {
  localStorage.removeItem("resolver_user");
  currentUser = null;
  showLogin();
};

const sessionUser = loadSession();
if (sessionUser) {
  showApp(sessionUser);
} else {
  showLogin();
}
