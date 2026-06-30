const SOS_CONFIG = window.SOS_CONFIG || {};
const API = SOS_CONFIG.API_BASE || "https://sos.vsti.cl";
const GPS_TIMEOUT_MS = Number(SOS_CONFIG.RESOLVER_GPS_TIMEOUT_MS || 9000);
const POLL_MS = Number(SOS_CONFIG.RESOLVER_POLL_MS || 10000);
const GPS_HEARTBEAT_MS = Number(SOS_CONFIG.RESOLVER_GPS_HEARTBEAT_MS || 30000);
const MAX_GPS_ACCURACY_METERS = Number(SOS_CONFIG.RESOLVER_GPS_MAX_ACCURACY_METERS || 150);

// Limpieza defensiva: este parámetro técnico no debe quedar editable/persistido desde UI.
localStorage.removeItem("resolver_max_gps_accuracy_meters");
const TERMINAL_STATES = ["CLOSED", "CANCELLED", "RESOLVED"];

const $ = (id) => document.getElementById(id);

let user = JSON.parse(localStorage.getItem("resolver_user") || "null");
let currentStatus = localStorage.getItem("resolver_status") || "OFFLINE";
let currentPosition = null;
let activeTab = "assigned";
let stateCache = null;
let pollTimer = null;
let gpsHeartbeatTimer = null;
let gpsHeartbeatFailures = 0;
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
let knownAssignedTicketIds = new Set(JSON.parse(localStorage.getItem("resolver_known_assigned_ticket_ids") || "[]"));
let lastNotificationAt = 0;
let resolverVoice = { session: null, ua: null, call: null };

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


function resolverActivityIcon(type) {
  switch (type) {
    case "MESSAGE_TEXT": return "💬";
    case "MEDIA_AUDIO": return "🎙️";
    case "MEDIA_VIDEO": return "📹";
    case "CALL_VOICE": return "☎️";
    case "CALL_VIDEO": return "🎥";
    case "CALL_ACCEPTED": return "✅";
    case "CALL_REJECTED": return "🚫";
    case "VOICE_SESSION_CREATED":
    case "VOICE_CONNECTED":
    case "VOICE_ENDED":
    case "VOICE_FAILED":
    case "VOICE_NO_ANSWER":
    case "VOICE_EXPIRED":
    case "VOICE_RECORDING_AVAILABLE": return "📞";
    default: return "📝";
  }
}

function formatResolverActivityTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("es-CL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function normalizeTicketActionForResolver(action) {
  const metadata = action?.metadata && typeof action.metadata === "object" ? action.metadata : {};
  const actionType = action?.action_type || "NOTE";
  const actorRole = action?.actor_role || "—";
  let title = action?.description || "Antecedente del caso";
  let body = metadata.message || null;
  let mediaUrl = metadata.media_url || null;
  let fileName = metadata.file_name || null;

  if (actorRole === "NEIGHBOR") {
    if (actionType === "MESSAGE_TEXT") title = "Mensaje enviado por vecino";
    if (actionType === "MEDIA_AUDIO") title = "Audio enviado por vecino";
    if (actionType === "MEDIA_VIDEO") title = "Video enviado por vecino";
  } else if (actorRole === "RESOLVER") {
    if (actionType === "MESSAGE_TEXT") title = "Antecedente registrado por resolutor";
    if (actionType === "MEDIA_AUDIO") title = "Audio de terreno del resolutor";
    if (actionType === "MEDIA_VIDEO") title = "Video de terreno del resolutor";
  } else if (actorRole === "OPERATOR") {
    title = action?.description || "Actualización de la central";
  }

  return {
    id: action?.id,
    action_type: actionType,
    actor_role: actorRole,
    title,
    body,
    media_url: mediaUrl,
    file_name: fileName,
    created_at: action?.created_at
  };
}

function renderTicketActivityForResolver(actions = []) {
  const container = $("resolverActivityList");
  const empty = $("resolverActivityEmpty");
  if (!container || !empty) return;

  const relevant = (Array.isArray(actions) ? actions : [])
    .map(normalizeTicketActionForResolver)
    .filter((item) => ["NEIGHBOR", "OPERATOR", "RESOLVER"].includes(item.actor_role));

  empty.classList.toggle("hidden", relevant.length > 0);

  container.innerHTML = relevant.map((item) => {
    const link = item.media_url
      ? `<a class="resolver-activity-link" href="${escapeHtml(item.media_url)}" target="_blank" rel="noopener">Ver evidencia</a>`
      : "";
    return `
      <div class="resolver-activity-item actor-${escapeHtml(String(item.actor_role).toLowerCase())}">
        <div class="resolver-activity-icon">${resolverActivityIcon(item.action_type)}</div>
        <div class="resolver-activity-content">
          <div class="resolver-activity-row">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(formatResolverActivityTime(item.created_at))}</span>
          </div>
          <div class="resolver-activity-role">${escapeHtml(item.actor_role)}</div>
          ${item.body ? `<p>${escapeHtml(item.body)}</p>` : ""}
          ${item.file_name ? `<p class="resolver-activity-file">${escapeHtml(item.file_name)}</p>` : ""}
          ${link}
        </div>
      </div>
    `;
  }).join("");
}

async function loadTicketActivityForResolver(ticketId) {
  const container = $("resolverActivityList");
  const empty = $("resolverActivityEmpty");
  if (!container || !empty || !ticketId) return;

  container.innerHTML = `<div class="muted strong">Cargando antecedentes del caso...</div>`;
  empty.classList.add("hidden");

  try {
    const data = await api(`/tickets/${ticketId}/actions`);
    renderTicketActivityForResolver(data.actions || []);
  } catch (err) {
    container.innerHTML = `<div class="resolver-activity-error">No se pudieron cargar los antecedentes: ${escapeHtml(err.message)}</div>`;
  }
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
      stopGpsHeartbeat();
      toast("Saliste de turno");
    } else {
      await updateGps(status);
      startGpsHeartbeat();
      toast(`Estado: ${STATUS_LABELS[status] || status}`);
    }

    await loadState();
  } catch (err) {
    toast(err.message);
  }
}

function startGpsHeartbeat() {
  clearInterval(gpsHeartbeatTimer);
  if (!user || String(currentStatus || "OFFLINE").toUpperCase() === "OFFLINE") return;

  gpsHeartbeatTimer = setInterval(async () => {
    if (!user || String(currentStatus || "OFFLINE").toUpperCase() === "OFFLINE") return;
    try {
      await updateGps(currentStatus);
      gpsHeartbeatFailures = 0;
    } catch (err) {
      gpsHeartbeatFailures += 1;
      console.warn("resolver gps heartbeat failed", err.message);
      if (gpsHeartbeatFailures === 1 || gpsHeartbeatFailures % 5 === 0) {
        $("gpsText").textContent = `No se pudo actualizar GPS automáticamente: ${err.message}`;
      }
    }
  }, GPS_HEARTBEAT_MS);
}

function stopGpsHeartbeat() {
  clearInterval(gpsHeartbeatTimer);
  gpsHeartbeatTimer = null;
  gpsHeartbeatFailures = 0;
}

async function logout() {
  if (!user) return showLogin();

  const ok = confirm("¿Cerrar sesión y cambiar de resolutor? Se marcará este usuario fuera de turno en la central.");
  if (!ok) return;

  const previousUserId = user.id;
  try {
    stopGpsHeartbeat();
    clearInterval(pollTimer);
    pollTimer = null;
    await api(`/resolvers/${previousUserId}/status/offline`, { method: "POST", body: JSON.stringify({ reason: "logout" }) });
  } catch (err) {
    console.warn("logout offline failed", err.message);
  }

  user = null;
  stateCache = null;
  currentPosition = null;
  currentStatus = "OFFLINE";
  knownAssignedTicketIds = new Set();

  localStorage.removeItem("resolver_user");
  localStorage.removeItem("resolver_status");
  localStorage.removeItem("resolver_known_assigned_ticket_ids");

  closeSettingsPanel();
  closeTicketModal();
  closeFieldPanel();
  closeRoutePanel();
  showLogin();
  toast("Sesión cerrada. Puedes ingresar con otro resolutor.");
}

function showLogin() {
  $("mainView")?.classList.add("hidden");
  $("loginView")?.classList.remove("hidden");
  $("btnSettings")?.classList.add("hidden");
  updateStatusPill("OFFLINE");
  if ($("phoneInput")) $("phoneInput").value = "";
  if ($("loginMsg")) $("loginMsg").textContent = "";
  if ($("ticketsList")) $("ticketsList").innerHTML = "";
  if ($("gpsText")) $("gpsText").textContent = "Sin ubicación reportada";
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
  if (s.includes("vif")) return "🤫";
  if (s.includes("medical") || s.includes("méd") || s.includes("med")) return "🩺";
  if (s.includes("fire") || s.includes("incend")) return "🔥";
  if (s.includes("security") || s.includes("seg")) return "🛡️";
  if (s.includes("fall") || s.includes("caid") || s.includes("accident") || s.includes("accidente")) return "⚕️";
  if (s.includes("risk") || s.includes("riesgo")) return "⚠️";
  return "🆘";
}

function typeLabel(type) {
  const s = String(type || "").toLowerCase();
  if (s.includes("vif")) return "VIF";
  if (s.includes("medical") || s.includes("méd") || s.includes("med")) return "Médica";
  if (s.includes("fire") || s.includes("incend")) return "Incendio";
  if (s.includes("security") || s.includes("seg")) return "Seguridad";
  if (s.includes("fall") || s.includes("caid")) return "Caída";
  if (s.includes("accident") || s.includes("accidente")) return "Accidente";
  if (s.includes("risk") || s.includes("riesgo")) return "Riesgo";
  if (s.includes("other") || s.includes("otro")) return "Otro";
  return "SOS";
}

function sectorFromCoords(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "Sector no informado";
  // Estimación aproximada para demo. La versión oficial debe usar polígonos de barrios/unidades vecinales.
  if (lat > -32.981 && lon < -71.532) return "Reñaca Bajo / Jardín del Mar";
  if (lat > -32.982 && lon >= -71.532) return "Reñaca Alto";
  if (lat > -32.999 && lon > -71.510) return "Gómez Carreño / Glorias Navales";
  if (lat > -33.007 && lon > -71.522) return "Achupallas / Santa Julia";
  if (lat > -33.009 && lon <= -71.522) return "Santa Inés / Población Vergara";
  if (lat > -33.024 && lon < -71.545) return "Plan Viña / Libertad";
  if (lat > -33.026 && lon >= -71.545) return "Miraflores / Chorrillos";
  if (lat <= -33.035 && lon < -71.545) return "Recreo / Agua Santa";
  if (lat <= -33.035 && lon >= -71.545) return "Forestal / Nueva Aurora";
  return "Viña del Mar";
}

function ticketIncidentSector(ticket) {
  return ticket?.incident_sector || ticket?.sector_estimado || ticket?.sector_aproximado || sectorFromCoords(ticket?.latitude, ticket?.longitude);
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
  const sector = ticketIncidentSector(t);
  const meta = `${t.citizen_name || "Vecino"} · ${sector} · ${ticketAge(t)} · ${stateLabel(t.state)}`;
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
    actions += `<button class="field-action" data-action="secure-call" data-id="${t.id}">📞 Llamar vecino</button>`;
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
        <div><strong>Tipo:</strong> ${escapeHtml(typeLabel(t.alert_type))}</div>
        <div><strong>Sector del evento:</strong> ${escapeHtml(sector)}</div>
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


function loadResolverScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (window.JsSIP) return resolve();
    const existing = Array.from(document.scripts).find((script) => script.src && script.src.includes(src));
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function ensureResolverJsSIPLoaded() {
  if (window.JsSIP) return;
  const sources = [
    "vendor/jssip.min.js",
    "https://cdn.jsdelivr.net/npm/jssip@3.10.1/dist/jssip.min.js",
    "https://unpkg.com/jssip@3.10.1/dist/jssip.min.js"
  ];
  for (const src of sources) {
    try {
      await loadResolverScriptOnce(src);
      if (window.JsSIP) return;
    } catch (error) {
      console.warn("No se pudo cargar JsSIP desde", src, error);
    }
  }
  throw new Error("No se pudo cargar JsSIP. Agrega vendor/jssip.min.js o revisa CDN.");
}

function stopResolverVoice() {
  try { if (resolverVoice.call) resolverVoice.call.terminate(); } catch {}
  try { if (resolverVoice.ua) resolverVoice.ua.stop(); } catch {}
  resolverVoice.ua = null;
  resolverVoice.call = null;
  toast("Llamada segura finalizada");
}

async function connectResolverVoice(voiceSession) {
  const webrtc = voiceSession?.webrtc || voiceSession?.party_b_webrtc || null;
  if (!webrtc) throw new Error("No hay credenciales WebRTC para el resolutor");
  await ensureResolverJsSIPLoaded();

  const sipDomain = webrtc.sip_domain || "wa-center.vsti.cl";
  const wssUrl = webrtc.wss_url || "wss://wa-center.vsti.cl/ws";
  const destination = webrtc.destination;
  if (!webrtc.username || !destination) throw new Error("Credenciales WebRTC incompletas");

  toast("Conectando llamada segura...");
  const socket = new JsSIP.WebSocketInterface(wssUrl);
  const config = {
    sockets: [socket],
    uri: `sip:${webrtc.username}@${sipDomain}`,
    authorization_user: webrtc.username,
    register: true,
    session_timers: false,
    realm: webrtc.realm || "asterisk"
  };
  if (webrtc.ha1) config.ha1 = webrtc.ha1;
  else config.password = webrtc.password;

  const ua = new JsSIP.UA(config);
  resolverVoice.ua = ua;
  resolverVoice.session = voiceSession;

  ua.on("registered", () => {
    toast("Registrado. Entrando al bridge...");
    const target = `sip:${destination}@${sipDomain}`;
    const call = ua.call(target, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: voiceSession?.ice_servers || [] },
      eventHandlers: {
        progress: () => toast("Llamada segura en progreso..."),
        confirmed: () => toast("En llamada segura"),
        ended: () => stopResolverVoice(),
        failed: (e) => {
          console.error("WA-Center resolver call failed", e);
          toast(`Llamada fallida (${e.cause || "sin detalle"})`);
        }
      }
    });
    resolverVoice.call = call;
    call.connection.addEventListener("track", (event) => {
      let audio = $("resolverRemoteAudio");
      if (!audio) {
        audio = document.createElement("audio");
        audio.id = "resolverRemoteAudio";
        audio.autoplay = true;
        audio.playsInline = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = event.streams[0];
    });
  });
  ua.on("registrationFailed", (e) => {
    console.error("WA-Center resolver registration failed", e);
    toast(`Registro WebRTC fallido (${e.cause || "sin detalle"})`);
  });
  ua.start();
}

async function requestSecureCall(ticketId) {
  if (!user?.id) return toast("Debes iniciar sesión como resolutor.");
  try {
    const data = await api(`/resolver/tickets/${ticketId}/voice/request`, {
      method: "POST",
      body: JSON.stringify({ resolver_user_id: user.id })
    });
    const waSession = data.voice_session?.wa_center_session_id || data.voice_session?.id || "";
    toast(waSession ? `Llamada segura creada · ${waSession}` : "Llamada segura creada");
    await connectResolverVoice(data.voice_session);
    await loadState();
  } catch (err) {
    toast(err.message || "No se pudo solicitar llamada segura");
  }
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
    if (action === "secure-call") return requestSecureCall(t.id);

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
    <h2>${escapeHtml(typeIcon(t.alert_type) + " " + (t.title || "Emergencia"))}</h2>
    <p><strong>Tipo:</strong> ${escapeHtml(typeLabel(t.alert_type))}</p>
    <p><strong>Sector del evento:</strong> ${escapeHtml(ticketIncidentSector(t))}</p>
    <p><strong>Estado:</strong> ${escapeHtml(stateLabel(t.state))}</p>
    <p><strong>Vecino:</strong> ${escapeHtml(t.citizen_name || "No informado")}</p>
    <p><strong>Teléfono vecino:</strong> ${escapeHtml(t.citizen_phone || "No informado")}</p>
    <p><strong>Descripción:</strong> ${escapeHtml(t.description || "Sin descripción")}</p>
    <p><strong>Ubicación:</strong> ${Number.isFinite(lat) ? lat.toFixed(5) : "—"}, ${Number.isFinite(lon) ? lon.toFixed(5) : "—"}</p>
    <section class="resolver-activity-card">
      <div class="resolver-activity-head">
        <span class="eyebrow">Antecedentes del caso</span>
        <h3>Bitácora y evidencia</h3>
        <p>Mensajes, audios y videos enviados por el vecino, central y resolutor.</p>
      </div>
      <div id="resolverActivityList" class="resolver-activity-list"></div>
      <p id="resolverActivityEmpty" class="resolver-activity-empty hidden">Aún no hay antecedentes adicionales asociados a este caso.</p>
    </section>
    <div class="actions detail-actions">
      ${Number.isFinite(lat) && Number.isFinite(lon) ? `<button class="secondary full" type="button" id="btnDetailRoute">🗺️ Ver mapa y ruta</button>` : ""}
      ${isAssignedToMe(t) && !TERMINAL_STATES.includes(t.state) ? `<button class="field-action" type="button" id="btnDetailText">📝 Antecedente</button><button class="field-action" type="button" id="btnDetailAudio">🎙️ Audio</button><button class="field-action" type="button" id="btnDetailVideo">📹 Video</button><button class="field-action" type="button" id="btnDetailCall">📞 Llamar vecino</button>` : ""}
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
  loadTicketActivityForResolver(t.id);
  setTimeout(() => {
    const routeBtn = $("btnDetailRoute");
    if (routeBtn) routeBtn.onclick = () => { closeTicketModal(); openRoutePanel(t); };
    const textBtn = $("btnDetailText");
    if (textBtn) textBtn.onclick = () => { closeTicketModal(); openFieldPanel(t.id, "text"); };
    const audioBtn = $("btnDetailAudio");
    if (audioBtn) audioBtn.onclick = () => { closeTicketModal(); openFieldPanel(t.id, "audio"); };
    const videoBtn = $("btnDetailVideo");
    if (videoBtn) videoBtn.onclick = () => { closeTicketModal(); openFieldPanel(t.id, "video"); };
    const callBtn = $("btnDetailCall");
    if (callBtn) callBtn.onclick = () => { requestSecureCall(t.id); };
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
  $("routeSubtitle").textContent = `${typeLabel(ticket.alert_type)} · ${ticketIncidentSector(ticket)} · ${ticket.citizen_name || "Vecino"}`;
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


function saveKnownAssignedTicketIds() {
  localStorage.setItem("resolver_known_assigned_ticket_ids", JSON.stringify([...knownAssignedTicketIds].slice(-80)));
}

function notificationTitle(ticket) {
  return `${typeIcon(ticket.alert_type)} Nuevo caso asignado`;
}

function notificationBody(ticket) {
  return `${typeLabel(ticket.alert_type)} en ${ticketIncidentSector(ticket)} · ${ticket.title || "Emergencia municipal"}`;
}

function playResolverAlertSound() {
  if (!getResolverSetting(SETTINGS_KEYS.sound, true)) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.28, ctx.currentTime + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.25);
    gain.connect(ctx.destination);
    [0, 0.22, 0.44, 0.66].forEach((offset, idx) => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(idx % 2 ? 640 : 880, ctx.currentTime + offset);
      osc.connect(gain);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.16);
    });
    setTimeout(() => ctx.close().catch(() => null), 1600);
  } catch (err) {
    console.warn("No se pudo reproducir sonido", err);
  }
}

function vibrateResolverAlert() {
  if (!getResolverSetting(SETTINGS_KEYS.vibrate, true)) return;
  try { navigator.vibrate?.([450, 160, 450, 160, 650]); } catch (_) {}
}

async function ensureBrowserNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const permission = await Notification.requestPermission();
    return permission === "granted";
  } catch (_) { return false; }
}

async function showBrowserNotification(ticket) {
  if (!getResolverSetting(SETTINGS_KEYS.browserNotification, true)) return;
  const ok = await ensureBrowserNotificationPermission();
  if (!ok) return;
  try {
    new Notification(notificationTitle(ticket), {
      body: notificationBody(ticket),
      tag: `ticket-${ticket.id}`,
      requireInteraction: true
    });
  } catch (err) {
    console.warn("No se pudo mostrar notificación", err);
  }
}

function isTicketAssignedOrPendingForMe(ticket) {
  return isAssignedToMe(ticket) || isPendingForMe(ticket);
}

async function notifyNewAssignedTickets(tickets) {
  if (!Array.isArray(tickets) || !user) return;
  const assigned = tickets.filter(t => isTicketAssignedOrPendingForMe(t) && !TERMINAL_STATES.includes(t.state));
  const newOnes = assigned.filter(t => t.id && !knownAssignedTicketIds.has(String(t.id)));
  assigned.forEach(t => t.id && knownAssignedTicketIds.add(String(t.id)));
  saveKnownAssignedTicketIds();
  if (!newOnes.length) return;

  const now = Date.now();
  if (now - lastNotificationAt < 1200) return;
  lastNotificationAt = now;
  const ticket = newOnes[0];
  playResolverAlertSound();
  vibrateResolverAlert();
  showBrowserNotification(ticket);
  toast(`${notificationTitle(ticket)} · ${notificationBody(ticket)}`);
}

function testResolverNotification() {
  const ticket = {
    id: "TEST",
    alert_type: "FIRE",
    title: "Prueba de notificación",
    latitude: -33.019,
    longitude: -71.548
  };
  playResolverAlertSound();
  vibrateResolverAlert();
  showBrowserNotification(ticket);
  toast("Prueba de notificación ejecutada");
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
    await notifyNewAssignedTickets(data.tickets || []);
    renderTickets();
  } catch (err) {
    toast(err.message);
  }
}



const SETTINGS_KEYS = {
  sound: "resolver_setting_sound",
  vibrate: "resolver_setting_vibrate",
  browserNotification: "resolver_setting_browser_notification",
  navigation: "resolver_setting_navigation",
  autoRoute: "resolver_setting_auto_route"
};

function getResolverSetting(key, fallback) {
  const value = localStorage.getItem(key);
  if (value == null) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function setResolverSetting(key, value) {
  localStorage.setItem(key, String(value));
}

function openSettingsPanel() {
  const panel = $("settingsPanel");
  if (!panel) return;
  $("settingsStatus").textContent = STATUS_LABELS[currentStatus] || currentStatus || "—";
  $("settingsCenter").textContent = user?.control_center_name || user?.control_center_code || "—";
  $("settingsUser").textContent = user?.full_name || "—";
  $("settingsGpsAccuracy").textContent = currentPosition?.coords?.accuracy ? `${Math.round(currentPosition.coords.accuracy)} m` : "Sin lectura reciente";
  $("settingsGpsUpdated").textContent = currentPosition ? new Date(currentPosition.timestamp || Date.now()).toLocaleString("es-CL") : "—";
  $("settingsSound").checked = !!getResolverSetting(SETTINGS_KEYS.sound, true);
  $("settingsVibrate").checked = !!getResolverSetting(SETTINGS_KEYS.vibrate, true);
  if ($("settingsBrowserNotification")) $("settingsBrowserNotification").checked = !!getResolverSetting(SETTINGS_KEYS.browserNotification, true);
  $("settingsNavigationApp").value = getResolverSetting(SETTINGS_KEYS.navigation, "google");
  $("settingsAutoRoute").checked = !!getResolverSetting(SETTINGS_KEYS.autoRoute, false);
  panel.classList.remove("hidden");
}

function closeSettingsPanel() {
  $("settingsPanel")?.classList.add("hidden");
}

function saveSettingsFromPanel() {
  setResolverSetting(SETTINGS_KEYS.sound, $("settingsSound")?.checked ?? true);
  setResolverSetting(SETTINGS_KEYS.vibrate, $("settingsVibrate")?.checked ?? true);
  setResolverSetting(SETTINGS_KEYS.browserNotification, $("settingsBrowserNotification")?.checked ?? true);
  setResolverSetting(SETTINGS_KEYS.navigation, $("settingsNavigationApp")?.value || "google");
  setResolverSetting(SETTINGS_KEYS.autoRoute, $("settingsAutoRoute")?.checked ?? false);
}

async function login() {
  const phone = $("phoneInput").value.trim();
  $("loginMsg").textContent = "";
  if (!phone) {
    $("loginMsg").textContent = "Ingresa un teléfono.";
    return;
  }
  try {
    const resp = await api("/resolver/auth/login", { method: "POST", body: JSON.stringify({ phone }) });
    if (resp.user.role !== "RESOLVER") throw new Error("Este usuario no tiene rol RESOLVER");
    user = resp.user;
    localStorage.setItem("resolver_user", JSON.stringify(user));
    showMain();
    await updateGps("AVAILABLE").catch((err) => toast(err.message));
    startGpsHeartbeat();
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

  $("btnSettings").addEventListener("click", openSettingsPanel);
  $("btnCloseSettings")?.addEventListener("click", closeSettingsPanel);
  $("settingsPanel")?.addEventListener("click", (event) => {
    if (event.target === $("settingsPanel")) closeSettingsPanel();
  });
  ["settingsSound", "settingsVibrate", "settingsBrowserNotification", "settingsNavigationApp", "settingsAutoRoute"].forEach((id) => {
    $(id)?.addEventListener("change", saveSettingsFromPanel);
  });
  $("settingsUpdateGps")?.addEventListener("click", () => {
    updateGps(currentStatus === "OFFLINE" ? "AVAILABLE" : currentStatus)
      .then(() => { toast("GPS actualizado"); openSettingsPanel(); })
      .catch((err) => toast(err.message));
  });
  $("settingsTestNotification")?.addEventListener("click", testResolverNotification);
  $("settingsLogout")?.addEventListener("click", logout);

  if (user) {
    showMain();
    loadState();
    if (currentStatus !== "OFFLINE") {
      updateGps(currentStatus).catch(() => null);
      startGpsHeartbeat();
    }
    startPolling();
  }
}

init();
