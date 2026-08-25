const SOS_CONFIG = window.SOS_CONFIG || {};
const API = SOS_CONFIG.API_BASE || "https://api.queltu.com";
const RESOLVER_TOKEN_KEY = "sos_resolver_session_token";
const HSE_SUPERVISOR_TOKEN_KEY = "queltu_hse_supervisor_session_token";
const HSE_SUPERVISOR_USER_KEY = "queltu_hse_supervisor_user";
const APP_MODE = new URLSearchParams(window.location.search).get("mode") || "field";
const SUPERVISOR_MODE = APP_MODE.toLowerCase() === "supervisor";
const SESSION_TOKEN_KEY = SUPERVISOR_MODE ? HSE_SUPERVISOR_TOKEN_KEY : RESOLVER_TOKEN_KEY;
const USER_STORAGE_KEY = SUPERVISOR_MODE ? HSE_SUPERVISOR_USER_KEY : "resolver_user";
const HSE_SUPERVISOR_ROLES = ["ADMIN", "SUPER_ADMIN"];
const GPS_TIMEOUT_MS = Number(SOS_CONFIG.RESOLVER_GPS_TIMEOUT_MS || 9000);
const POLL_MS = Number(SOS_CONFIG.RESOLVER_POLL_MS || 3000);
const GPS_HEARTBEAT_MS = Number(SOS_CONFIG.RESOLVER_GPS_HEARTBEAT_MS || 30000);
const MAX_GPS_ACCURACY_METERS = Number(SOS_CONFIG.RESOLVER_GPS_MAX_ACCURACY_METERS || 150);

// Limpieza defensiva: este parámetro técnico no debe quedar editable/persistido desde UI.
localStorage.removeItem("resolver_max_gps_accuracy_meters");
const TERMINAL_STATES = ["CLOSED", "CANCELLED", "RESOLVED"];

const $ = (id) => document.getElementById(id);

let user = JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || "null");
let portalMode = SUPERVISOR_MODE ? "SUPERVISOR_HSE" : "RESOLVER";
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
let activeFieldInspectionData = null;
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let recordingTimeout = null;
let recordingTimerInterval = null;
let recordingStartedAt = null;
let activeHseTicketId = null;
let activeHseData = null;
let routineInspectionEvidence = [];
let routineInspectionRecorder = null;
let routineInspectionAudioChunks = [];
let routineInspectionAudioStream = null;
let routineInspectionRecordingTimeout = null;
let routineInspectionRecordingTimerInterval = null;
let routineInspectionRecordingStartedAt = null;
let routineInspectionRecordingFromDock = false;
let routineInspectionDiscardRecording = false;
let routineInspectionCaptureMode = null;
let routineInspectionEditingIndex = -1;
let routineInspectionPendingMedia = null;
let routineInspectionPreviewUrl = null;
let knownAssignedTicketIds = new Set(JSON.parse(localStorage.getItem("resolver_known_assigned_ticket_ids") || "[]"));
let knownVoiceSessionIds = new Set(JSON.parse(localStorage.getItem("resolver_known_voice_session_ids") || "[]"));
let lastNotificationAt = 0;
let resolverVoice = {
  session: null,
  ua: null,
  call: null,
  ticketId: null,
  sessionId: null,
  status: "idle",
  statusMessage: "Sin llamada activa",
  peerConnection: null,
  statusPollTimer: null,
  durationTimer: null,
  connectedAt: null,
  connectedReported: false,
  ringbackContexts: new Set(),
  ringbackInterval: null,
  muted: false,
  cleanupPromise: null,
  backendFinalized: false,
  direction: null
};

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
  const token = localStorage.getItem(SESSION_TOKEN_KEY) || "";
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { status: "error", message: text }; }
  if (!res.ok || data.status === "error") {
    const err = new Error(data.message || `HTTP ${res.status}`);
    err.data = data;
    err.httpStatus = res.status;
    err.status = res.status;
    throw err;
  }
  return data;
}

const RESOLVER_OUTBOX_DB = "queltu-resolver-offline";
const RESOLVER_OUTBOX_STORE = "ticket-actions";
const RESOLVER_OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESOLVER_STATE_SNAPSHOT_KEY = "resolver_state_snapshot_city";
let resolverOutboxSyncing = false;

function resolverClientActionId() {
  return globalThis.crypto?.randomUUID?.() || `resolver-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function openResolverOutbox() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RESOLVER_OUTBOX_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RESOLVER_OUTBOX_STORE)) {
        db.createObjectStore(RESOLVER_OUTBOX_STORE, { keyPath: "client_action_id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Cola offline no disponible"));
  });
}

async function resolverOutboxRequest(mode, operation) {
  const db = await openResolverOutbox();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(RESOLVER_OUTBOX_STORE, mode);
      const request = operation(tx.objectStore(RESOLVER_OUTBOX_STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error || new Error("Error en cola offline"));
    });
  } finally {
    db.close();
  }
}

async function listResolverQueuedActions() {
  const items = await resolverOutboxRequest("readonly", (store) => store.getAll());
  const cutoff = Date.now() - RESOLVER_OUTBOX_RETENTION_MS;
  const fresh = (items || []).filter((item) => Number(item.created_at || 0) >= cutoff);
  const expired = (items || []).filter((item) => Number(item.created_at || 0) < cutoff);
  await Promise.all(expired.map((item) => resolverOutboxRequest("readwrite", (store) => store.delete(item.client_action_id))));
  return fresh.sort((a, b) => Number(a.created_at) - Number(b.created_at));
}

async function listResolverQueuedActionsForCurrentUser() {
  const ownerId = String(user?.id || "");
  if (!ownerId) return [];
  return (await listResolverQueuedActions()).filter((item) => String(item.owner_user_id || item.body?.resolver_user_id || "") === ownerId);
}

async function queueResolverAction(entry) {
  await resolverOutboxRequest("readwrite", (store) => store.put(entry));
  await renderResolverConnectivity();
}

async function deleteResolverAction(clientActionId) {
  await resolverOutboxRequest("readwrite", (store) => store.delete(clientActionId));
}

function resolverConnectivityBanner() {
  let banner = $("resolverConnectivityBanner");
  if (banner) return banner;
  banner = document.createElement("div");
  banner.id = "resolverConnectivityBanner";
  banner.className = "resolver-connectivity-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  (document.querySelector("#appShell > main") || document.body).prepend(banner);
  return banner;
}

async function renderResolverConnectivity() {
  const banner = resolverConnectivityBanner();
  let pending = [];
  try { pending = await listResolverQueuedActionsForCurrentUser(); } catch (_) {}
  if (!navigator.onLine || pending.length) {
    banner.style.display = "block";
    banner.textContent = pending.length
      ? `Sin conexión · ${pending.length} registro${pending.length === 1 ? "" : "s"} pendiente${pending.length === 1 ? "" : "s"} de sincronizar.`
      : "Sin conexión · llegada y cierre quedarán pendientes hasta reconectar.";
  } else {
    banner.style.display = "none";
  }
}

function ticketActionPath(action, ticketId) {
  return `/tickets/${ticketId}/${action}`;
}

async function sendOrQueueResolverAction(action, ticketId, body) {
  const entry = {
    action,
    kind: "ticket-state",
    ticket_id: ticketId,
    path: ticketActionPath(action, ticketId),
    body: { ...body, client_action_id: resolverClientActionId() },
    client_action_id: null,
    owner_user_id: user?.id || body.resolver_user_id,
    created_at: Date.now()
  };
  entry.client_action_id = entry.body.client_action_id;
  if (!navigator.onLine) {
    await queueResolverAction(entry);
    return { queued: true };
  }
  try {
    return { queued: false, data: await api(entry.path, { method: "POST", body: JSON.stringify(entry.body) }) };
  } catch (error) {
    if (error.status && error.status < 500 && error.status !== 429) throw error;
    await queueResolverAction(entry);
    return { queued: true };
  }
}

async function resolverQueuedRequestBody(entry) {
  const body = { ...(entry.body || {}), client_action_id: entry.client_action_id };
  if (entry.media_blob instanceof Blob) body.data_url = await blobToDataUrl(entry.media_blob);
  return body;
}

async function sendOrQueueResolverEvidence({ ticketId, kind, body, mediaBlob = null }) {
  const clientActionId = resolverClientActionId();
  const entry = {
    action: kind,
    kind,
    ticket_id: ticketId,
    path: kind === "field-text" ? `/tickets/${ticketId}/messages` : `/tickets/${ticketId}/media`,
    body: { ...body, client_action_id: clientActionId },
    media_blob: mediaBlob,
    client_action_id: clientActionId,
    owner_user_id: user?.id || null,
    created_at: Date.now()
  };
  if (!navigator.onLine) {
    await queueResolverAction(entry);
    return { queued: true };
  }
  try {
    const requestBody = await resolverQueuedRequestBody(entry);
    return { queued: false, data: await api(entry.path, { method: "POST", body: JSON.stringify(requestBody) }) };
  } catch (error) {
    if (error.status && error.status < 500 && error.status !== 429) throw error;
    await queueResolverAction(entry);
    return { queued: true };
  }
}

function applyQueuedResolverState(ticket, action) {
  if (!ticket) return;
  const nextState = { "en-route": "EN_ROUTE", "on-site": "ON_SITE", resolve: "RESOLVED" }[action];
  if (nextState) ticket.state = nextState;
  if (action === "en-route" || action === "on-site") currentStatus = nextState;
  if (action === "resolve") currentStatus = "AVAILABLE";
  updateStatusPill(currentStatus);
  renderTickets();
}

async function overlayPendingResolverStates(targetState = stateCache) {
  const pending = await listResolverQueuedActionsForCurrentUser();
  let status = null;

  pending.forEach((entry) => {
    const nextState = { "en-route": "EN_ROUTE", "on-site": "ON_SITE", resolve: "RESOLVED" }[entry.action];
    if (!nextState) return;
    const ticket = (targetState?.tickets || []).find((item) => String(item.id) === String(entry.ticket_id));
    if (ticket) ticket.state = nextState;
    status = entry.action === "resolve" ? "AVAILABLE" : nextState;
  });

  return { pending, status };
}

async function syncResolverOutbox() {
  if (resolverOutboxSyncing || !navigator.onLine || !user?.id || !localStorage.getItem(SESSION_TOKEN_KEY)) return;
  resolverOutboxSyncing = true;
  try {
    const pending = await listResolverQueuedActionsForCurrentUser();
    for (const entry of pending) {
      try {
        const requestBody = await resolverQueuedRequestBody(entry);
        await api(entry.path, { method: "POST", body: JSON.stringify(requestBody) });
        await deleteResolverAction(entry.client_action_id);
      } catch (error) {
        if (error.status >= 400 && error.status < 500 && error.status !== 429) {
          await deleteResolverAction(entry.client_action_id);
          toast(`No se pudo sincronizar ${entry.action}: ${error.message}`);
        } else {
          break;
        }
      }
    }
    await loadState();
  } finally {
    resolverOutboxSyncing = false;
    await renderResolverConnectivity();
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[ch]));
}

function isMiningHseExperience() {
  return String(stateCache?.platform_settings?.vertical || "").toUpperCase() === "MINING";
}

function isSupervisorPortal() {
  return portalMode === "SUPERVISOR_HSE";
}

function syncFieldInspectionLauncher() {
  const shortcut = $("btnRoutineInspection");
  if (!shortcut) return;
  const resolverAppEnabled = stateCache?.platform_settings?.features?.resolver_app_enabled !== false;
  const policyEnabled = stateCache?.platform_settings?.resolver_inspection_policy?.enabled !== false;
  const visible = Boolean(user) && !isSupervisorPortal() && (isMiningHseExperience() || resolverAppEnabled);
  const blockedByPolicy = visible && !isMiningHseExperience() && !policyEnabled;
  const label = isMiningHseExperience()
    ? "Nueva inspección de rutina"
    : blockedByPolicy
      ? "Inspecciones deshabilitadas por el Centro de Control"
      : "Nueva inspección de terreno";
  shortcut.classList.toggle("hidden", !visible);
  shortcut.classList.toggle("inspection-disabled", blockedByPolicy);
  shortcut.setAttribute("aria-disabled", String(blockedByPolicy));
  shortcut.setAttribute("aria-label", label);
  shortcut.title = label;
}

function visibleTerm(key, fallback) {
  return stateCache?.platform_settings?.terminology?.[key] || fallback;
}

function endUserTerm() {
  return visibleTerm("endUser", isMiningHseExperience() ? "Trabajador" : "Vecino");
}

function responderTerm() {
  const configured = visibleTerm("responder", isMiningHseExperience() ? "Profesional HSE" : "Resolutor");
  return isMiningHseExperience() && configured === "Brigadista" ? "Profesional HSE" : configured;
}

function zoneTerm() {
  return visibleTerm("zone", isMiningHseExperience() ? "Área o faena" : "Sector");
}

function termLower(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toLocaleLowerCase("es-CL") + text.slice(1) : text;
}

function termPlural(value) {
  const text = String(value || "");
  if (!text) return text;
  return /[aeiouáéíóú]$/i.test(text) ? `${text}s` : `${text}es`;
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
    if (actionType === "MESSAGE_TEXT") title = `Mensaje enviado por ${termLower(endUserTerm())}`;
    if (actionType === "MEDIA_AUDIO") title = `Audio enviado por ${termLower(endUserTerm())}`;
    if (actionType === "MEDIA_VIDEO") title = `Video enviado por ${termLower(endUserTerm())}`;
  } else if (actorRole === "RESOLVER") {
    if (actionType === "MESSAGE_TEXT") title = `Antecedente registrado por ${termLower(responderTerm())}`;
    if (actionType === "MEDIA_AUDIO") title = `Audio de terreno del ${termLower(responderTerm())}`;
    if (actionType === "MEDIA_VIDEO") title = `Video de terreno del ${termLower(responderTerm())}`;
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
        $("gpsText").textContent = (!navigator.onLine || err.code === "NETWORK_ERROR")
          ? "Sin conexión · la última ubicación se actualizará al reconectar"
          : `No se pudo actualizar GPS automáticamente: ${err.message}`;
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

  const ok = confirm(isSupervisorPortal()
    ? "¿Cerrar la sesión del portal Supervisor HSE?"
    : "¿Cerrar sesión y cambiar de profesional? Se marcará este usuario fuera de turno en el Centro de Control.");
  if (!ok) return;

  const previousUserId = user.id;
  try {
    stopGpsHeartbeat();
    clearInterval(pollTimer);
    pollTimer = null;
    if (!isSupervisorPortal()) {
      await api(`/resolvers/${previousUserId}/status/offline`, { method: "POST", body: JSON.stringify({ reason: "logout" }) });
    }
  } catch (err) {
    console.warn("logout offline failed", err.message);
  }

  user = null;
  stateCache = null;
  currentPosition = null;
  currentStatus = "OFFLINE";
  knownAssignedTicketIds = new Set();

  localStorage.removeItem(USER_STORAGE_KEY);
  localStorage.removeItem(SESSION_TOKEN_KEY);
  localStorage.removeItem("resolver_status");
  localStorage.removeItem("resolver_known_assigned_ticket_ids");
  localStorage.removeItem("queltu_response_portal_mode");
  portalMode = SUPERVISOR_MODE ? "SUPERVISOR_HSE" : "RESOLVER";
  localStorage.removeItem(RESOLVER_STATE_SNAPSHOT_KEY);

  closeSettingsPanel();
  closeTicketModal();
  closeFieldPanel();
  closeRoutePanel();
  showLogin();
  toast("Sesión cerrada. Puedes ingresar con otro usuario.");
}

function showLogin() {
  $("mainView")?.classList.add("hidden");
  $("supervisorView")?.classList.add("hidden");
  $("loginView")?.classList.remove("hidden");
  $("btnSettings")?.classList.add("hidden");
  $("btnRoutineInspection")?.classList.add("hidden");
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

function isTerminalTicket(t) {
  return TERMINAL_STATES.includes(String(t?.state || "").toUpperCase());
}

function isPendingForMe(t) {
  return t.assignment_state === "PENDING" && !isTerminalTicket(t);
}

function isAvailableTicket(t) {
  return !t.assigned_resolver_id && !isPendingForMe(t) && !isTerminalTicket(t);
}

function acceptanceDeadlineState(ticket) {
  const dueAt = ticket?.assignment_accept_due_at ? new Date(ticket.assignment_accept_due_at).getTime() : null;
  const pending = String(ticket?.assignment_state || "").toUpperCase() === "PENDING";
  if (!pending || !Number.isFinite(dueAt)) return { pending, dueAt: null, overdue: false, remainingMs: null };
  const remainingMs = dueAt - Date.now();
  return { pending: true, dueAt, overdue: remainingMs <= 0, remainingMs };
}

function compactDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Math.abs(Number(milliseconds || 0)) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
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
  const sector = ticket?.incident_sector || ticket?.sector_estimado || ticket?.sector_aproximado;
  if (isMiningHseExperience()) {
    if (!sector || sector === "Dentro de la comuna, sin unidad vecinal identificada" || sector === "Sector no informado" || sector === "Viña del Mar") {
      return `${zoneTerm()} no informada`;
    }
    return sector;
  }
  return sector || sectorFromCoords(ticket?.latitude, ticket?.longitude);
}


function activeVoiceSessionForTicket(ticket) {
  if (!ticket) return null;
  const session = ticket.voice_session || ticket.pending_voice_session || null;
  if (session && session.id) return session;

  if (!ticket.voice_session_id && !ticket.wa_center_session_id) return null;
  const status = String(ticket.voice_status || "CREATED").toUpperCase();
  if (["FAILED", "ENDED", "EXPIRED", "NO_ANSWER", "REJECTED"].includes(status)) return null;

  return {
    id: ticket.voice_session_id,
    wa_center_session_id: ticket.wa_center_session_id,
    status,
    requested_by: ticket.voice_requested_by,
    target_type: ticket.voice_target_type,
    created_at: ticket.voice_created_at
  };
}

function isIncomingNeighborVoice(ticket) {
  const session = activeVoiceSessionForTicket(ticket);
  return !!session
    && String(session.target_type || "").toUpperCase() === "RESOLVER"
    && String(session.requested_by || "").toUpperCase() === "NEIGHBOR";
}

function voiceSessionLabel(session) {
  if (!session) return "";
  const status = String(session.status || "CREATED").toUpperCase();
  if (status === "CONNECTED") return "En llamada segura";
  if (status === "RINGING" || status === "WAITING") return `Llamada entrante del ${termLower(endUserTerm())}`;
  return `${endUserTerm()} solicita llamada segura`;
}
function resolverVoiceSessionKey(session) {
  return session?.id || session?.wa_center_session_id || null;
}

function setResolverVoiceStatus(message, status = null) {
  resolverVoice.statusMessage = message || resolverVoice.statusMessage || "Llamada segura";
  if (status) resolverVoice.status = status;
  toast(resolverVoice.statusMessage);
  try {
    if (stateCache) renderTickets();
  } catch {}
}

function isResolverVoiceActiveForTicket(ticket) {
  if (!ticket || String(resolverVoice.ticketId || "") !== String(ticket.id || "")) return false;
  return !["idle", "ended", "failed", "rejected", "no_answer"].includes(String(resolverVoice.status || "idle"));
}

function resolverVoiceControlHtml(ticket) {
  if (!isResolverVoiceActiveForTicket(ticket)) return "";
  const status = escapeHtml(resolverVoice.statusMessage || "Llamada segura activa");
  const isLive = String(resolverVoice.status || "").toLowerCase() === "connected";
  const label = isLive ? "✅ En llamada segura" : "📞 Llamada segura en curso";
  return `
    <div class="resolver-active-call-panel full">
      <strong>${label}</strong>
      <span>${status}</span>
      <button class="secondary" data-action="hangup-voice" data-id="${escapeHtml(ticket.id)}">Colgar llamada</button>
    </div>`;
}


function saveKnownVoiceSessionIds() {
  localStorage.setItem("resolver_known_voice_session_ids", JSON.stringify([...knownVoiceSessionIds].slice(-100)));
}

function renderTickets() {
  const list = $("ticketsList");
  const tickets = (stateCache?.tickets || []).filter((ticket) => !isTerminalTicket(ticket));
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
    btn.addEventListener("click", () => handleTicketAction(btn.dataset.action, btn.dataset.id, btn.dataset.sessionId));
  });
}

function ticketCard(t) {
  const pending = isPendingForMe(t);
  const acceptance = acceptanceDeadlineState(t);
  const assigned = isAssignedToMe(t);
  const available = isAvailableTicket(t);
  const canUpdateField = assigned && !TERMINAL_STATES.includes(t.state);
  const hasCoords = Number.isFinite(Number(t.latitude)) && Number.isFinite(Number(t.longitude));
  const title = `${typeIcon(t.alert_type)} ${t.title || t.alert_type || "Emergencia"}`;
  const sector = ticketIncidentSector(t);
  const meta = `${t.citizen_name || endUserTerm()} · ${sector} · ${ticketAge(t)} · ${stateLabel(t.state)}`;
  const idShort = String(t.id || "").slice(0, 8).toUpperCase();
  const reportCount = Number(t.report_count || 0);
  const incomingVoice = activeVoiceSessionForTicket(t);
  const incomingVoiceForMe = isIncomingNeighborVoice(t);

  let actions = "";

  if (pending && !acceptance.overdue) {
    actions += `<button class="primary" data-action="accept" data-id="${t.id}">Aceptar</button>`;
    actions += `<button class="secondary danger-soft" data-action="reject" data-id="${t.id}">Rechazar</button>`;
  } else if (pending && acceptance.overdue) {
    actions += `<div class="acceptance-expired-action full">Asignación vencida · actualizando con la Central</div>`;
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
    if (!isMiningHseExperience() && ["ON_SITE", "EN_ROUTE", "ACCEPTED_BY_RESOLVER", "ASSIGNED"].includes(t.state)) {
      actions += `<button class="control available full" data-action="resolve" data-id="${t.id}">Resolver caso</button>`;
    }
    if (isMiningHseExperience()) {
      actions += `<button class="hse-action full" data-action="hse" data-id="${t.id}">🦺 Informe HSE, PNR y riesgo</button>`;
    }
  }

  actions += `<button class="secondary" data-action="detail" data-id="${t.id}">Ver detalle</button>`;
  if (hasCoords) actions += `<button class="secondary" data-action="route" data-id="${t.id}">🗺️ Ver mapa y ruta</button>`;

  const hasActiveVoiceForThisTicket = isResolverVoiceActiveForTicket(t);
  if (hasActiveVoiceForThisTicket) {
    actions += resolverVoiceControlHtml(t);
  } else if (incomingVoiceForMe) {
    actions += `<div class="incoming-call-banner full"><strong>📞 ${escapeHtml(voiceSessionLabel(incomingVoice))}</strong><span>El ${termLower(endUserTerm())} espera que atiendas esta llamada segura.</span></div>`;
    actions += `<button class="primary full incoming-call-button" data-action="answer-voice" data-id="${t.id}" data-session-id="${escapeHtml(incomingVoice.id || incomingVoice.wa_center_session_id || 'latest')}">☎️ Atender llamada del ${termLower(endUserTerm())}</button>`;
  }

  if (canUpdateField) {
    actions += `<div class="action-title full">Comunicación y evidencia</div>`;
    actions += `<button class="field-action" data-action="field-text" data-id="${t.id}">📝 Antecedente</button>`;
    actions += `<button class="field-action" data-action="field-audio" data-id="${t.id}">🎙️ Audio</button>`;
    actions += `<button class="field-action" data-action="field-video" data-id="${t.id}">📹 Video</button>`;
    actions += `<button class="field-action" data-action="secure-call" data-id="${t.id}">📞 Iniciar llamada al ${termLower(endUserTerm())}</button>`;
  }

  return `
    <article class="ticket-card priority-${escapeHtml(t.priority || 3)} ${acceptance.overdue ? "acceptance-overdue" : ""}">
      <div class="ticket-head">
        <div>
          <h3 class="ticket-title">${escapeHtml(title)}</h3>
          <p class="ticket-meta">#${escapeHtml(idShort)} · ${escapeHtml(meta)}</p>
        </div>
        <span class="badge ${alertBadgeClass(t)}">${escapeHtml(t.alert_type || "SOS")}</span>
      </div>
      ${acceptance.pending ? `<div class="acceptance-sla-banner ${acceptance.overdue ? "overdue" : "pending"}"><strong>${acceptance.overdue ? "🚨 Tiempo de aceptación vencido" : "⏱️ Aceptación pendiente"}</strong><span>${acceptance.overdue ? `Venció hace ${compactDuration(acceptance.remainingMs)}. No aceptes: la Central está reasignando el caso.` : `Debes aceptar dentro de ${compactDuration(acceptance.remainingMs)}.`}</span></div>` : ""}
      <div class="ticket-body">
        <div><strong>Prioridad:</strong> ${escapeHtml(t.priority || "—")}</div>
        <div><strong>Tipo:</strong> ${escapeHtml(typeLabel(t.alert_type))}</div>
        <div><strong>${escapeHtml(zoneTerm())} del evento:</strong> ${escapeHtml(sector)}</div>
        <div><strong>${escapeHtml(endUserTerm())}:</strong> ${escapeHtml(t.citizen_name || "—")}</div>
        <div><strong>Teléfono ${escapeHtml(termLower(endUserTerm()))}:</strong> ${escapeHtml(t.citizen_phone || "—")}</div>
        ${reportCount > 1 ? `<div><strong>Reportes recibidos:</strong> 👥 ${reportCount} ${escapeHtml(termLower(termPlural(endUserTerm())))} reportaron este incidente</div>` : ""}
        <div><strong>Asignación:</strong> ${assigned ? "Asignado a mí" : available ? "Disponible" : escapeHtml(t.resolver_name || `Otro ${termLower(responderTerm())}`)}</div>
        ${incomingVoice ? `<div><strong>Llamada:</strong> ${escapeHtml(voiceSessionLabel(incomingVoice))}</div>` : ""}
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

const RESOLVER_VOICE_TERMINAL = new Set(["ended", "failed", "rejected", "no_answer"]);

function resolverVoiceShortCase(ticketId) {
  return `#${String(ticketId || "").slice(0, 8).toUpperCase()}`;
}

function showResolverVoiceOverlay(ticket, session, mode = "incoming") {
  if (!ticket || !session) return;
  resolverVoice.ticketId = ticket.id;
  resolverVoice.sessionId = resolverVoiceSessionKey(session);
  resolverVoice.session = session;
  resolverVoice.direction = mode;
  if (mode === "incoming") {
    resolverVoice.status = "ringing";
    resolverVoice.cleanupPromise = null;
    resolverVoice.backendFinalized = false;
  }

  $("resolverVoiceTitle").textContent = mode === "incoming" ? "Llamada entrante" : "Conectando llamada…";
  $("resolverVoiceCase").textContent = `Caso ${resolverVoiceShortCase(ticket.id)}`;
  $("resolverVoiceMessage").textContent = mode === "incoming"
    ? `El ${termLower(endUserTerm())} quiere entregar más detalles.`
    : `Estamos conectando el canal de audio con el ${termLower(endUserTerm())}.`;
  $("resolverVoiceTimer").classList.add("hidden");
  $("btnRejectVoice").classList.toggle("hidden", mode !== "incoming");
  $("btnAnswerVoice").classList.toggle("hidden", mode !== "incoming");
  $("btnMuteVoice").classList.add("hidden");
  $("btnHangupVoice").classList.toggle("hidden", mode === "incoming");
  $("resolverVoiceOverlay").classList.remove("hidden");
  if (mode === "incoming") startResolverRingback();
}

function hideResolverVoiceOverlay() {
  $("resolverVoiceOverlay")?.classList.add("hidden");
}

function clearResolverVoiceTimers() {
  clearInterval(resolverVoice.statusPollTimer);
  clearInterval(resolverVoice.durationTimer);
  resolverVoice.statusPollTimer = null;
  resolverVoice.durationTimer = null;
}

function stopResolverMedia() {
  const connection = resolverVoice.peerConnection || resolverVoice.call?.connection;
  try {
    connection?.getSenders?.().forEach((sender) => sender.track?.stop());
    connection?.getReceivers?.().forEach((receiver) => receiver.track?.stop());
  } catch {}
  try {
    if (connection && connection.signalingState !== "closed") connection.close();
  } catch {}
  resolverVoice.peerConnection = null;

  const audio = $("resolverRemoteAudio");
  try { audio?.srcObject?.getTracks?.().forEach((track) => track.stop()); } catch {}
  try { audio?.pause?.(); } catch {}
  if (audio) audio.srcObject = null;
}

async function notifyResolverVoiceEnded(reason = "HANGUP") {
  if (!resolverVoice.ticketId || !resolverVoice.sessionId || !user?.id || resolverVoice.backendFinalized) return;
  resolverVoice.backendFinalized = true;
  await api(
    `/resolver/tickets/${resolverVoice.ticketId}/voice/sessions/${encodeURIComponent(resolverVoice.sessionId)}/end`,
    {
      method: "POST",
      body: JSON.stringify({ resolver_user_id: user.id, reason })
    }
  );
}

function updateResolverVoiceTimer() {
  if (!resolverVoice.connectedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - resolverVoice.connectedAt) / 1000));
  const minutesText = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secondsText = String(seconds % 60).padStart(2, "0");
  $("resolverVoiceTimer").textContent = `${minutesText}:${secondsText}`;
}

function markResolverVoiceConnected() {
  stopResolverRingback();
  resolverVoice.status = "connected";
  resolverVoice.statusMessage = `En llamada con el ${termLower(endUserTerm())}`;
  resolverVoice.connectedAt = resolverVoice.connectedAt || Date.now();
  $("resolverVoiceTitle").textContent = "Llamada conectada";
  $("resolverVoiceMessage").textContent = `Ya puedes conversar con el ${termLower(endUserTerm())}.`;
  $("resolverVoiceTimer").classList.remove("hidden");
  $("btnRejectVoice").classList.add("hidden");
  $("btnAnswerVoice").classList.add("hidden");
  $("btnMuteVoice").classList.remove("hidden");
  $("btnHangupVoice").classList.remove("hidden");
  updateResolverVoiceTimer();
  clearInterval(resolverVoice.durationTimer);
  resolverVoice.durationTimer = setInterval(updateResolverVoiceTimer, 1000);
  try { if (stateCache) renderTickets(); } catch {}
}

function playResolverRingbackBurst() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const contexts = resolverVoice.ringbackContexts;
    const context = new AudioContext();
    contexts.add(context);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.22, context.currentTime + 0.03);
    gain.gain.setValueAtTime(0.22, context.currentTime + 0.72);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.85);
    gain.connect(context.destination);
    [440, 480].forEach((frequency) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, context.currentTime);
      oscillator.connect(gain);
      oscillator.start(context.currentTime);
      oscillator.stop(context.currentTime + 0.85);
    });
    setTimeout(() => {
      contexts.delete(context);
      context.close().catch(() => null);
    }, 1_100);
  } catch (error) {
    console.warn("No se pudo reproducir el tono de llamada", error);
  }
}

function startResolverRingback() {
  if (resolverVoice.ringbackInterval) return;
  playResolverRingbackBurst();
  resolverVoice.ringbackInterval = setInterval(playResolverRingbackBurst, 3_000);
}

function stopResolverRingback() {
  clearInterval(resolverVoice.ringbackInterval);
  resolverVoice.ringbackInterval = null;
  resolverVoice.ringbackContexts.forEach((context) => {
    try { context.close().catch(() => null); } catch {}
  });
  resolverVoice.ringbackContexts.clear();
}

async function reportResolverVoiceConnected() {
  if (!resolverVoice.ticketId || !resolverVoice.sessionId || !user?.id || resolverVoice.connectedReported) return;
  resolverVoice.connectedReported = true;

  try {
    const data = await api(
      `/resolver/tickets/${resolverVoice.ticketId}/voice/sessions/${encodeURIComponent(resolverVoice.sessionId)}/connected`,
      {
        method: "POST",
        body: JSON.stringify({ resolver_user_id: user.id })
      }
    );
    if (String(data.voice_session?.status || "").toUpperCase() === "CONNECTED") {
      markResolverVoiceConnected();
    }
  } catch (error) {
    resolverVoice.connectedReported = false;
    console.warn("No se pudo confirmar la entrada del resolutor al canal", error);
  }
}

async function stopResolverVoice(options = {}) {
  if (resolverVoice.cleanupPromise) return resolverVoice.cleanupPromise;
  const {
    notifyBackend = true,
    reason = "HANGUP",
    finalStatus = "ended",
    message = "Llamada segura finalizada"
  } = options;

  // Guard previo para evitar reentrada si JsSIP emite "ended" al hacer terminate().
  resolverVoice.cleanupPromise = Promise.resolve();
  const cleanupTask = (async () => {
    clearResolverVoiceTimers();
    stopResolverRingback();
    stopResolverMedia();
    try { resolverVoice.call?.terminate?.(); } catch {}
    try { resolverVoice.ua?.stop?.(); } catch {}
    resolverVoice.ua = null;
    resolverVoice.call = null;
    if (notifyBackend) {
      try { await notifyResolverVoiceEnded(reason); }
      catch (error) { console.warn("El backend no confirmó el cierre de la llamada", error); }
    }
    resolverVoice.status = finalStatus;
    resolverVoice.statusMessage = message;
    $("resolverVoiceTitle").textContent = message;
    $("resolverVoiceMessage").textContent = "El caso continúa disponible en tu bandeja.";
    $("btnRejectVoice").classList.add("hidden");
    $("btnAnswerVoice").classList.add("hidden");
    $("btnMuteVoice").classList.add("hidden");
    $("btnHangupVoice").classList.add("hidden");
    toast(message);
    setTimeout(() => {
      if (resolverVoice.status === finalStatus) hideResolverVoiceOverlay();
    }, 1800);
    try { if (stateCache) renderTickets(); } catch {}
  })();
  resolverVoice.cleanupPromise = cleanupTask;

  return cleanupTask;
}

function toggleResolverVoiceMute() {
  const connection = resolverVoice.peerConnection || resolverVoice.call?.connection;
  const tracks = (connection?.getSenders?.() || [])
    .map((sender) => sender.track)
    .filter((track) => track?.kind === "audio");
  if (!tracks.length) return;
  resolverVoice.muted = !resolverVoice.muted;
  tracks.forEach((track) => { track.enabled = !resolverVoice.muted; });
  $("btnMuteVoice").textContent = resolverVoice.muted ? "🎙️ Activar" : "🎙️ Silenciar";
}

async function pollResolverVoiceStatus() {
  if (!resolverVoice.ticketId || !resolverVoice.sessionId || !user?.id) return;
  try {
    const data = await api(
      `/resolver/tickets/${resolverVoice.ticketId}/voice/sessions/${encodeURIComponent(resolverVoice.sessionId)}/status?resolver_user_id=${encodeURIComponent(user.id)}`
    );
    const status = String(data.voice_session?.status || "").toUpperCase();
    if (status === "CONNECTED" && resolverVoice.status !== "connected") {
      markResolverVoiceConnected();
    } else if (["ENDED", "FAILED", "REJECTED", "NO_ANSWER", "EXPIRED"].includes(status)) {
      await stopResolverVoice({
        notifyBackend: false,
        reason: `REMOTE_${status}`,
        finalStatus: status === "REJECTED" ? "rejected" : status === "NO_ANSWER" ? "no_answer" : status === "FAILED" ? "failed" : "ended",
        message: status === "REJECTED" ? "Llamada rechazada" : status === "NO_ANSWER" ? "Llamada sin respuesta" : "Llamada finalizada"
      });
    }
  } catch (error) {
    console.warn("No fue posible consultar el estado de llamada", error);
  }
}

function startResolverVoiceStatusPolling() {
  clearInterval(resolverVoice.statusPollTimer);
  resolverVoice.statusPollTimer = setInterval(pollResolverVoiceStatus, 1500);
}

async function connectResolverVoice(voiceSession, options = {}) {
  const webrtc = voiceSession?.webrtc || voiceSession?.party_b_webrtc || null;
  if (!webrtc) throw new Error("No hay credenciales WebRTC para el resolutor");

  const nextSessionId = resolverVoiceSessionKey(voiceSession);
  if (resolverVoice.call && resolverVoice.sessionId && nextSessionId && resolverVoice.sessionId === nextSessionId && !["ended", "failed"].includes(String(resolverVoice.status || ""))) {
    setResolverVoiceStatus("Ya estás dentro o entrando a esta llamada segura.", resolverVoice.status || "connecting");
    return;
  }

  resolverVoice.ticketId = options.ticketId || resolverVoice.ticketId || voiceSession?.ticket_id || null;
  resolverVoice.sessionId = nextSessionId;
  resolverVoice.session = voiceSession;
  resolverVoice.cleanupPromise = null;
  resolverVoice.backendFinalized = false;
  resolverVoice.connectedReported = false;
  resolverVoice.direction = options.direction || resolverVoice.direction || "incoming";
  setResolverVoiceStatus("Entrando a llamada segura...", "connecting");
  $("resolverVoiceTitle").textContent = "Conectando llamada…";
  $("resolverVoiceMessage").textContent = "Estamos preparando el canal de audio seguro.";
  $("btnRejectVoice").classList.add("hidden");
  $("btnAnswerVoice").classList.add("hidden");
  $("btnHangupVoice").classList.remove("hidden");
  $("resolverVoiceOverlay").classList.remove("hidden");

  await ensureResolverJsSIPLoaded();

  const sipDomain = webrtc.sip_domain || "wa-center.vsti.cl";
  const wssUrl = webrtc.wss_url || "wss://wa-center.vsti.cl/ws";
  const destination = webrtc.destination;
  if (!webrtc.username || !destination) throw new Error("Credenciales WebRTC incompletas");

  setResolverVoiceStatus("Conectando audio seguro...", "connecting");
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

  ua.on("connected", () => setResolverVoiceStatus("Audio seguro conectado. Registrando llamada...", "registering"));
  ua.on("disconnected", () => {
    if (!RESOLVER_VOICE_TERMINAL.has(resolverVoice.status)) {
      void stopResolverVoice({
        notifyBackend: true,
        reason: "WEBRTC_DISCONNECTED",
        finalStatus: "failed",
        message: "La llamada se desconectó"
      });
    }
  });

  ua.on("registered", () => {
    setResolverVoiceStatus("Entrando al canal de voz seguro...", "calling");
    const target = `sip:${destination}@${sipDomain}`;
    const call = ua.call(target, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: voiceSession?.ice_servers || [] },
      eventHandlers: {
        progress: () => setResolverVoiceStatus(`Llamando... esperando que el ${termLower(endUserTerm())} entre a la llamada.`, "ringing"),
        confirmed: () => {
          // El anexo ya entró al bridge, pero esperamos la confirmación del
          // backend antes de presentar la llamada como conectada.
          setResolverVoiceStatus("Esperando confirmación del canal de voz…", "ringing");
          void reportResolverVoiceConnected();
        },
        ended: () => {
          void stopResolverVoice({ notifyBackend: true, reason: "REMOTE_ENDED" });
        },
        failed: (e) => {
          console.error("WA-Center resolver call failed", e);
          void stopResolverVoice({
            notifyBackend: true,
            reason: String(e?.cause || "WEBRTC_FAILED").toUpperCase(),
            finalStatus: "failed",
            message: "No fue posible conectar la llamada"
          });
        }
      }
    });
    resolverVoice.call = call;
    const attachConnection = (connection) => {
      if (!connection) return;
      resolverVoice.peerConnection = connection;
      connection.addEventListener("track", (event) => {
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
    };
    attachConnection(call.connection);
    call.on?.("peerconnection", (event) => attachConnection(event?.peerconnection));
  });
  ua.on("registrationFailed", (e) => {
    console.error("WA-Center resolver registration failed", e);
    void stopResolverVoice({
      notifyBackend: true,
      reason: "REGISTRATION_FAILED",
      finalStatus: "failed",
      message: "No fue posible conectar la llamada"
    });
  });
  startResolverVoiceStatusPolling();
  ua.start();
}

async function requestSecureCall(ticketId) {
  if (!user?.id) return toast(`Debes iniciar sesión como ${termLower(responderTerm())}.`);
  try {
    const data = await api(`/resolver/tickets/${ticketId}/voice/request`, {
      method: "POST",
      body: JSON.stringify({ resolver_user_id: user.id })
    });
    const waSession = data.voice_session?.wa_center_session_id || data.voice_session?.id || "";
    toast(`Llamada segura solicitada al ${termLower(endUserTerm())}. Entrando al canal de audio...`);
    const ticket = findTicket(ticketId) || { id: ticketId };
    showResolverVoiceOverlay(ticket, data.voice_session, "outgoing");
    startResolverRingback();
    await connectResolverVoice(data.voice_session, { ticketId, direction: "outgoing" });
    await loadState();
  } catch (err) {
    if (resolverVoice.sessionId) {
      await stopResolverVoice({
        notifyBackend: true,
        reason: "REQUEST_FAILED",
        finalStatus: "failed",
        message: "No fue posible conectar la llamada"
      });
    }
    toast(err.message || "No se pudo solicitar llamada segura");
  }
}

async function answerNeighborVoice(ticketId, sessionId = "latest") {
  if (!user?.id) return toast(`Debes iniciar sesión como ${termLower(responderTerm())}.`);
  stopResolverRingback();
  try {
    toast(`Atendiendo llamada segura del ${termLower(endUserTerm())}...`);
    await api(`/resolver/tickets/${ticketId}/voice/sessions/${sessionId || 'latest'}/accept`, {
      method: "POST",
      body: JSON.stringify({ resolver_user_id: user.id })
    });
    const data = await api(`/resolver/tickets/${ticketId}/voice/sessions/${sessionId || 'latest'}/join`, {
      method: "POST",
      body: JSON.stringify({ resolver_user_id: user.id })
    });
    const ticket = findTicket(ticketId) || { id: ticketId };
    showResolverVoiceOverlay(ticket, data.voice_session, "connecting");
    await connectResolverVoice(data.voice_session, { ticketId, direction: "incoming" });
    await loadState();
  } catch (err) {
    if (resolverVoice.sessionId) {
      await stopResolverVoice({
        notifyBackend: true,
        reason: "ANSWER_FAILED",
        finalStatus: "failed",
        message: "No fue posible atender la llamada"
      });
    }
    toast(err.message || "No se pudo atender la llamada segura");
  }
}

async function rejectNeighborVoice(ticketId, sessionId = "latest") {
  if (!user?.id) return toast(`Debes iniciar sesión como ${termLower(responderTerm())}.`);
  try {
    await api(`/resolver/tickets/${ticketId}/voice/sessions/${sessionId || 'latest'}/reject`, {
      method: "POST",
      body: JSON.stringify({
        resolver_user_id: user.id,
        reason: "REJECTED_BY_RESOLVER"
      })
    });
    resolverVoice.backendFinalized = true;
    await stopResolverVoice({
      notifyBackend: false,
      reason: "REJECTED_BY_RESOLVER",
      finalStatus: "rejected",
      message: "Llamada rechazada"
    });
    await loadState();
  } catch (err) {
    toast(err.message || "No fue posible rechazar la llamada");
  }
}

async function handleTicketAction(action, id, sessionId = null) {
  const t = findTicket(id);
  if (!t) return;

  try {
    if (action === "detail") return showTicketDetail(t);
    if (action === "route") return openRoutePanel(t);
    if (action === "field-text") return openFieldPanel(t.id, "text");
    if (action === "field-audio") return openFieldPanel(t.id, "audio");
    if (action === "field-video") return openFieldPanel(t.id, "video");
    if (action === "hse") return openHsePanel(t);
    if (action === "secure-call") return requestSecureCall(t.id);
    if (action === "hangup-voice") return stopResolverVoice();
    if (action === "answer-voice") {
      return answerNeighborVoice(t.id, sessionId || activeVoiceSessionForTicket(t)?.id || "latest");
    }

    if (["accept", "reject", "take"].includes(action) && !navigator.onLine) {
      return toast("Esta decisión de asignación requiere conexión para evitar que dos patrullas tomen el mismo caso.");
    }
    if (action === "accept") await api(`/tickets/${id}/accept`, { method: "POST", body: JSON.stringify({ resolver_user_id: user.id }) });
    if (action === "reject") {
      const reason = prompt("Motivo del rechazo", "No puedo tomarlo en este momento");
      if (reason === null) return;
      await api(`/tickets/${id}/reject`, { method: "POST", body: JSON.stringify({ resolver_user_id: user.id, reject_reason: reason }) });
    }
    if (action === "take") await api(`/tickets/${id}/take`, { method: "POST", body: JSON.stringify({ resolver_user_id: user.id }) });
    if (action === "en-route" || action === "on-site") {
      const result = await sendOrQueueResolverAction(action, id, { resolver_user_id: user.id });
      if (result.queued) {
        applyQueuedResolverState(t, action);
        return toast("Acción guardada en el dispositivo; se sincronizará al recuperar cobertura.");
      }
    }
    if (action === "resolve") {
      const notes = prompt("Notas de resolución", "Caso atendido en terreno");
      if (notes === null) return;
      const result = await sendOrQueueResolverAction("resolve", id, { resolver_user_id: user.id, resolution_notes: notes });
      if (result.queued) {
        applyQueuedResolverState(t, action);
        return toast("Cierre guardado en el dispositivo; la central aún no lo ha recibido.");
      }
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
    <p><strong>${escapeHtml(zoneTerm())} del evento:</strong> ${escapeHtml(ticketIncidentSector(t))}</p>
    <p><strong>Estado:</strong> ${escapeHtml(stateLabel(t.state))}</p>
    <p><strong>${escapeHtml(endUserTerm())}:</strong> ${escapeHtml(t.citizen_name || "No informado")}</p>
    <p><strong>Teléfono ${escapeHtml(termLower(endUserTerm()))}:</strong> ${escapeHtml(t.citizen_phone || "No informado")}</p>
    ${Number(t.report_count || 0) > 1 ? `<p><strong>Reportes recibidos:</strong> 👥 ${escapeHtml(t.report_count)} ${escapeHtml(termLower(termPlural(endUserTerm())))} reportaron este incidente.</p>` : ""}
    <p><strong>Descripción:</strong> ${escapeHtml(t.description || "Sin descripción")}</p>
    <p><strong>Ubicación:</strong> ${Number.isFinite(lat) ? lat.toFixed(5) : "—"}, ${Number.isFinite(lon) ? lon.toFixed(5) : "—"}</p>
    <section class="resolver-activity-card">
      <div class="resolver-activity-head">
        <span class="eyebrow">Antecedentes del caso</span>
        <h3>Bitácora y evidencia</h3>
        <p>Mensajes, audios y videos enviados por el ${escapeHtml(termLower(endUserTerm()))}, central y ${escapeHtml(termLower(responderTerm()))}.</p>
      </div>
      <div id="resolverActivityList" class="resolver-activity-list"></div>
      <p id="resolverActivityEmpty" class="resolver-activity-empty hidden">Aún no hay antecedentes adicionales asociados a este caso.</p>
    </section>
    <div class="actions detail-actions">
      ${Number.isFinite(lat) && Number.isFinite(lon) ? `<button class="secondary full" type="button" id="btnDetailRoute">🗺️ Ver mapa y ruta</button>` : ""}
      ${isIncomingNeighborVoice(t) ? `<button class="primary full incoming-call-button" type="button" id="btnDetailAnswerCall">☎️ Atender llamada del ${escapeHtml(termLower(endUserTerm()))}</button>` : ""}
      ${isAssignedToMe(t) && isMiningHseExperience() ? `<button class="hse-action full" type="button" id="btnDetailHse">🦺 Informe HSE, PNR y riesgo</button>` : ""}
      ${isAssignedToMe(t) && !TERMINAL_STATES.includes(t.state) ? `<button class="field-action" type="button" id="btnDetailText">📝 Antecedente</button><button class="field-action" type="button" id="btnDetailAudio">🎙️ Audio</button><button class="field-action" type="button" id="btnDetailVideo">📹 Video</button><button class="field-action" type="button" id="btnDetailCall">📞 Iniciar llamada al ${escapeHtml(termLower(endUserTerm()))}</button>` : ""}
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
    const answerBtn = $("btnDetailAnswerCall");
    if (answerBtn) answerBtn.onclick = () => {
      const session = activeVoiceSessionForTicket(t);
      answerNeighborVoice(t.id, session?.id || session?.wa_center_session_id || "latest");
    };
    const callBtn = $("btnDetailCall");
    if (callBtn) callBtn.onclick = () => { requestSecureCall(t.id); };
    const hseBtn = $("btnDetailHse");
    if (hseBtn) hseBtn.onclick = () => { closeTicketModal(); openHsePanel(t); };
  }, 0);
}

function closeTicketModal() {
  $("ticketModal").classList.add("hidden");
  if (ticketMap) {
    ticketMap.remove();
    ticketMap = null;
  }
}

function fieldInspectionResultLabel(value) {
  return ({
    COMPLIANT: "Sin hallazgos",
    PARTIAL: "Observación preventiva",
    NON_COMPLIANT: "Requiere gestión",
    NOT_EVALUATED: "No evaluado"
  })[String(value || "").toUpperCase()] || value || "No evaluado";
}

function renderFieldInspectionHistory(inspections = []) {
  const container = $("fieldInspectionHistory");
  if (!container) return;
  if (!inspections.length) {
    container.innerHTML = '<div class="empty">Todavía no registras inspecciones.</div>';
    return;
  }
  container.innerHTML = inspections.slice(0, 8).map(item => `
    <article class="inspection-history-item">
      <div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(fieldInspectionResultLabel(item.result))}</span></div>
      <small>${escapeHtml(formatResolverActivityTime(item.completed_at || item.created_at))}${item.area ? ` · ${escapeHtml(item.area)}` : ""}</small>
      ${item.linked_ticket_id ? `<div class="inspection-ticket-link">🚨 Alerta #${escapeHtml(String(item.linked_ticket_id).slice(0, 8).toUpperCase())} · ${escapeHtml(stateLabel(item.ticket_state))}</div>` : '<div class="inspection-no-alert">Registro preventivo sin alerta</div>'}
    </article>
  `).join("");
}

function renderFieldInspectionCategories(categories = []) {
  const select = $("fieldInspectionCategory");
  if (!select) return;
  select.innerHTML = categories.map(category => `
    <option value="${escapeHtml(category.type)}">${escapeHtml(category.icon || "📝")} ${escapeHtml(category.title || category.type)}${category.visible_to_neighbor ? "" : " · solo resolutor"}</option>
  `).join("");
}

function toggleFieldInspectionAlertFields() {
  const checked = $("fieldInspectionCreateAlert")?.checked === true;
  $("fieldInspectionAlertFields")?.classList.toggle("hidden", !checked);
}

async function openFieldInspectionPanel() {
  const panel = $("fieldInspectionPanel");
  if (!panel) return;
  panel.classList.remove("hidden");
  $("fieldInspectionStatus").classList.add("hidden");
  $("fieldInspectionTitle").value = "";
  $("fieldInspectionArea").value = "";
  $("fieldInspectionNotes").value = "";
  $("fieldInspectionScore").value = "";
  $("fieldInspectionResult").value = "COMPLIANT";
  $("fieldInspectionAlertTitle").value = "";
  $("fieldInspectionAlertDescription").value = "";
  $("fieldInspectionEvidence").value = "";
  $("fieldInspectionCreateAlert").checked = false;
  toggleFieldInspectionAlertFields();
  const position = getLastKnownLatLon();
  $("fieldInspectionGps").textContent = position
    ? `${Number(position.latitude).toFixed(5)}, ${Number(position.longitude).toFixed(5)} · se actualizará al guardar`
    : "La ubicación se capturará al guardar.";
  $("fieldInspectionHistory").innerHTML = '<div class="empty">Cargando inspecciones...</div>';
  try {
    activeFieldInspectionData = await api("/resolver/field-inspections?limit=8");
    renderFieldInspectionCategories(activeFieldInspectionData.categories || []);
    renderFieldInspectionHistory(activeFieldInspectionData.inspections || []);
    const allowAlert = activeFieldInspectionData.policy?.allow_alert_creation !== false && (activeFieldInspectionData.categories || []).length > 0;
    $("fieldInspectionCreateAlert").disabled = !allowAlert;
    if (!allowAlert) {
      $("fieldInspectionCreateAlert").checked = false;
      toggleFieldInspectionAlertFields();
    }
  } catch (error) {
    $("fieldInspectionHistory").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    toast(error.message);
  }
}

function closeFieldInspectionPanel() {
  $("fieldInspectionPanel")?.classList.add("hidden");
  activeFieldInspectionData = null;
}

function inspectionEvidenceMediaType(file) {
  const mime = String(file?.type || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "video";
}

async function saveFieldInspection() {
  const title = $("fieldInspectionTitle").value.trim();
  const notes = $("fieldInspectionNotes").value.trim();
  const createAlert = $("fieldInspectionCreateAlert").checked === true;
  const category = $("fieldInspectionCategory").value;
  if (!title) return toast("Escribe un título para la inspección.");
  if (createAlert && !category) return toast("Selecciona la categoría del hallazgo.");
  const button = $("btnSaveFieldInspection");
  button.disabled = true;
  button.textContent = "Capturando GPS...";
  try {
    const pos = await getLocation({ maximumAge: 3000 });
    validatePositionQuality(pos);
    currentPosition = pos;
    const scoreRaw = $("fieldInspectionScore").value;
    button.textContent = "Guardando inspección...";
    const data = await api("/resolver/field-inspections", {
      method: "POST",
      body: JSON.stringify({
        title,
        area: $("fieldInspectionArea").value.trim() || null,
        inspection_type: "FIELD_INSPECTION",
        result: $("fieldInspectionResult").value,
        score: scoreRaw === "" ? null : Number(scoreRaw),
        notes: notes || null,
        text_evidence: notes ? [{ text: notes, created_at: new Date().toISOString() }] : [],
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        create_alert: createAlert,
        alert_type: createAlert ? category : null,
        alert_title: $("fieldInspectionAlertTitle").value.trim() || null,
        alert_description: $("fieldInspectionAlertDescription").value.trim() || null
      })
    });

    const evidenceFile = $("fieldInspectionEvidence").files?.[0] || null;
    let evidenceWarning = null;
    if (evidenceFile) {
      if (evidenceFile.size > 25 * 1024 * 1024) {
        evidenceWarning = "La inspección quedó guardada, pero la evidencia supera 25 MB y no se adjuntó.";
      } else {
        button.textContent = "Subiendo evidencia...";
        try {
          await api(`/resolver/field-inspections/${encodeURIComponent(data.inspection.id)}/evidence`, {
            method: "POST",
            body: JSON.stringify({
              media_type: inspectionEvidenceMediaType(evidenceFile),
              file_name: evidenceFile.name || `evidencia-${Date.now()}`,
              data_url: await blobToDataUrl(evidenceFile)
            })
          });
        } catch (error) {
          evidenceWarning = `La inspección quedó guardada, pero la evidencia no pudo subirse: ${error.message}`;
        }
      }
    }

    const status = $("fieldInspectionStatus");
    status.classList.remove("hidden");
    status.innerHTML = data.ticket
      ? `<strong>✅ Inspección y alerta creadas</strong><p>Ticket #${escapeHtml(String(data.ticket.id).slice(0, 8).toUpperCase())} visible para la Central.</p>`
      : "<strong>✅ Inspección registrada</strong><p>No se generó una alerta operacional.</p>";
    if (evidenceWarning) toast(evidenceWarning);
    else toast(data.message || "Inspección registrada");
    activeFieldInspectionData = await api("/resolver/field-inspections?limit=8");
    renderFieldInspectionHistory(activeFieldInspectionData.inspections || []);
    await loadState();
    $("fieldInspectionTitle").value = "";
    $("fieldInspectionNotes").value = "";
    $("fieldInspectionEvidence").value = "";
  } catch (error) {
    toast(error.message || "No fue posible registrar la inspección");
  } finally {
    button.disabled = false;
    button.textContent = "Guardar inspección";
  }
}

function hseRiskLevel(score) {
  if (score >= 17) return { code: "critical", label: "Crítico" };
  if (score >= 10) return { code: "high", label: "Alto" };
  if (score >= 5) return { code: "moderate", label: "Moderado" };
  return { code: "low", label: "Bajo" };
}

function updateHseRiskPreview() {
  const severity = Number($("hseSeverity")?.value || 1);
  const frequency = Number($("hseFrequency")?.value || 1);
  const score = severity * frequency;
  const level = hseRiskLevel(score);
  const result = $("hseRiskResult");
  if (!result) return;
  result.className = `hse-risk-result level-${level.code}`;
  result.textContent = `Riesgo ${score} · ${level.label}`;
}

async function openHsePnrDocument(documentId) {
  const pnrDocument = (activeHseData?.pnr_documents || []).find((item) => String(item.id) === String(documentId));
  if (pnrDocument?.document_url) {
    window.open(pnrDocument.document_url, "_blank", "noopener,noreferrer");
    return;
  }
  const popup = window.open("about:blank", "_blank");
  try {
    const token = localStorage.getItem(SESSION_TOKEN_KEY) || "";
    const response = await fetch(`${API}/mobile/safety/pnr/${encodeURIComponent(documentId)}/content`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!response.ok) throw new Error(`No fue posible abrir el PNR (HTTP ${response.status})`);
    const blobUrl = URL.createObjectURL(await response.blob());
    if (popup) popup.location.href = blobUrl;
    else window.location.href = blobUrl;
    setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
  } catch (error) {
    if (popup) popup.close();
    toast(error.message || "No fue posible abrir el PNR");
  }
}

function renderHsePanel(data) {
  const ticket = data?.ticket || {};
  const documents = Array.isArray(data?.pnr_documents) ? data.pnr_documents : [];
  const assessments = Array.isArray(data?.risk_assessments) ? data.risk_assessments : [];
  const suggestion = data?.frequency_suggestion || {};
  const incident = data?.incident || {};
  const closure = data?.closure_request || null;
  $("hsePanelSubtitle").textContent = `Caso #${String(ticket.id || activeHseTicketId || "").slice(0, 8).toUpperCase()} · registra la evaluación del ${responderTerm()}.`;
  $("hsePnrArea").textContent = `Área del trabajador: ${ticket.work_area || "sin área asignada"}`;
  $("hsePnrEmpty").classList.toggle("hidden", documents.length > 0);
  $("hsePnrList").innerHTML = documents.map((item) => `
    <article class="hse-pnr-item">
      <div><strong>${escapeHtml(item.code)} · ${escapeHtml(item.title)}</strong><span>${escapeHtml(item.document_type || "PNR")} · versión ${escapeHtml(item.version || "—")}${item.work_area ? ` · ${escapeHtml(item.work_area)}` : " · General"}</span>${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}</div>
      <button class="secondary small" type="button" data-hse-pnr-id="${escapeHtml(item.id)}">Abrir</button>
    </article>`).join("");
  $("hsePnrList").querySelectorAll("[data-hse-pnr-id]").forEach((button) => {
    button.onclick = () => openHsePnrDocument(button.dataset.hsePnrId);
  });

  const suggestionBox = $("hseFrequencySuggestion");
  suggestionBox.innerHTML = suggestion.available
    ? `<div><strong>Sugerencia estadística: frecuencia ${escapeHtml(suggestion.value)}</strong><span>${escapeHtml(suggestion.sample_size)} casos del mismo tipo en ${escapeHtml(suggestion.period_days)} días.</span></div><button id="btnUseHseSuggestion" class="secondary small" type="button">Usar sugerencia</button>`
    : `<div><strong>Sin sugerencia estadística todavía</strong><span>Muestra actual: ${escapeHtml(suggestion.sample_size || 0)} de 5 casos mínimos. Usa estimación profesional.</span></div>`;
  suggestionBox.classList.remove("hidden");
  $("btnUseHseSuggestion")?.addEventListener("click", () => {
    $("hseFrequency").value = String(suggestion.value);
    $("hseFrequencySource").value = "SYSTEM_SUGGESTION";
    updateHseRiskPreview();
  });

  $("hseRiskHistoryEmpty").classList.toggle("hidden", assessments.length > 0);
  $("hseRiskHistory").innerHTML = assessments.map((item) => {
    const level = hseRiskLevel(Number(item.score || 1));
    return `<article class="hse-history-item level-${level.code}"><strong>${item.phase === "RESIDUAL" ? "Residual" : "Inicial"}: ${escapeHtml(item.score)} · ${escapeHtml(level.label)}</strong><span>Gravedad ${escapeHtml(item.severity)} × frecuencia ${escapeHtml(item.frequency)} · ${escapeHtml(item.assessed_by_name || "Profesional HSE")}</span><small>${escapeHtml(formatResolverActivityTime(item.assessed_at))}${item.notes ? ` · ${escapeHtml(item.notes)}` : ""}</small></article>`;
  }).join("");
  const inspections = Array.isArray(data?.inspections) ? data.inspections : [];
  $("hseInspectionHistory").innerHTML = inspections.map(item => `<article class="hse-history-item"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(String(item.result || "").replaceAll("_", " "))}${item.score == null ? "" : ` · ${escapeHtml(item.score)}%`}</span><small>${escapeHtml(formatResolverActivityTime(item.completed_at || item.created_at))}${item.notes ? ` · ${escapeHtml(item.notes)}` : ""}</small></article>`).join("");
  const controls = Array.isArray(data?.critical_controls) ? data.critical_controls : [];
  $("hseCriticalControl").innerHTML = '<option value="">Seleccionar control</option>' + controls.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join("");
  const verifications = Array.isArray(data?.control_verifications) ? data.control_verifications : [];
  $("hseControlHistory").innerHTML = verifications.map(item => `<article class="hse-history-item"><strong>${escapeHtml(item.control_code)} · ${escapeHtml(item.control_name)}</strong><span>${escapeHtml(String(item.result || "").replaceAll("_", " "))}</span><small>${escapeHtml(formatResolverActivityTime(item.verified_at))}${item.notes ? ` · ${escapeHtml(item.notes)}` : ""}</small></article>`).join("");
  updateHseControlQuestion();
  $("hseInvestigationNotes").value = incident.investigation_notes || "";
  $("hseImmediateActions").value = incident.immediate_actions || "";
  $("hseRootCauses").value = Array.isArray(incident.root_causes) ? incident.root_causes.join("\n") : "";
  $("hseRecommendations").value = incident.recommendations || "";
  $("hseInvestigationStatus").value = ["INVESTIGATING", "ACTION_PLAN"].includes(incident.investigation_status)
    ? incident.investigation_status
    : "INVESTIGATING";
  const closureStatus = $("hseClosureStatus");
  const closureButton = $("btnRequestHseClosure");
  if (closure) {
    const labels = { REQUESTED: "Pendiente de aprobación del Supervisor HSE", APPROVED: "Cierre aprobado", REJECTED: "Devuelto por el Supervisor HSE" };
    closureStatus.textContent = labels[closure.status] || closure.status;
    closureStatus.className = `hse-closure-status status-${String(closure.status || "").toLowerCase()}`;
    if (closure.status === "REJECTED" && closure.decision_notes) closureStatus.textContent += ` · ${closure.decision_notes}`;
    $("hseClosureSummary").value = closure.request_summary || "";
    closureButton.disabled = closure.status === "REQUESTED" || closure.status === "APPROVED";
  } else {
    closureStatus.textContent = "Sin solicitud vigente";
    closureStatus.className = "hse-closure-status";
    $("hseClosureSummary").value = "";
    closureButton.disabled = false;
  }
  updateHseRiskPreview();
}

async function openHsePanel(ticket) {
  if (!ticket?.id || !isMiningHseExperience()) return;
  activeHseTicketId = ticket.id;
  activeHseData = null;
  $("hsePnrList").innerHTML = `<div class="empty">Cargando PNR y evaluación...</div>`;
  $("hseRiskHistory").innerHTML = "";
  $("hseRiskNotes").value = "";
  $("hseRiskPhase").value = "INITIAL";
  $("hseSeverity").value = "1";
  $("hseFrequency").value = "1";
  $("hseFrequencySource").value = "PROFESSIONAL_ESTIMATE";
  $("hseInspectionTitle").value = "";
  $("hseInspectionResult").value = "COMPLIANT";
  $("hseInspectionScore").value = "";
  $("hseInspectionNotes").value = "";
  $("hseCriticalControl").innerHTML = '<option value="">Seleccionar control</option>';
  $("hseControlResult").value = "EFFECTIVE";
  $("hseControlNotes").value = "";
  $("hseCriticalControlQuestion").textContent = "";
  $("hseInvestigationNotes").value = "";
  $("hseImmediateActions").value = "";
  $("hseRootCauses").value = "";
  $("hseRecommendations").value = "";
  $("hseInvestigationStatus").value = "INVESTIGATING";
  $("hseClosureSummary").value = "";
  $("hseClosureStatus").textContent = "Sin solicitud vigente";
  $("hsePanel").classList.remove("hidden");
  updateHseRiskPreview();
  try {
    activeHseData = await api(`/resolver/tickets/${ticket.id}/safety`);
    renderHsePanel(activeHseData);
  } catch (error) {
    toast(error.message || "No fue posible cargar Seguridad Operacional");
    closeHsePanel();
  }
}

function closeHsePanel() {
  $("hsePanel")?.classList.add("hidden");
  activeHseTicketId = null;
  activeHseData = null;
}

async function saveHseRisk() {
  if (!activeHseTicketId) return;
  const button = $("btnSaveHseRisk");
  button.disabled = true;
  try {
    await api(`/resolver/tickets/${activeHseTicketId}/safety/risk`, {
      method: "POST",
      body: JSON.stringify({
        phase: $("hseRiskPhase").value,
        severity: Number($("hseSeverity").value),
        frequency: Number($("hseFrequency").value),
        frequency_source: $("hseFrequencySource").value,
        notes: $("hseRiskNotes").value.trim() || null
      })
    });
    toast("Evaluación HSE guardada");
    activeHseData = await api(`/resolver/tickets/${activeHseTicketId}/safety`);
    $("hseRiskNotes").value = "";
    renderHsePanel(activeHseData);
  } catch (error) {
    toast(error.message || "No fue posible guardar la evaluación");
  } finally {
    button.disabled = false;
  }
}

async function saveHseInvestigation() {
  if (!activeHseTicketId) return;
  const button = $("btnSaveHseInvestigation");
  button.disabled = true;
  try {
    await api(`/resolver/tickets/${activeHseTicketId}/safety/investigation`, {
      method: "PATCH",
      body: JSON.stringify({
        investigation_notes: $("hseInvestigationNotes").value.trim() || null,
        immediate_actions: $("hseImmediateActions").value.trim() || null,
        root_causes: $("hseRootCauses").value.split("\n").map(value => value.trim()).filter(Boolean),
        recommendations: $("hseRecommendations").value.trim() || null,
        investigation_status: $("hseInvestigationStatus").value
      })
    });
    toast("Avance de investigación guardado");
    activeHseData = await api(`/resolver/tickets/${activeHseTicketId}/safety`);
    renderHsePanel(activeHseData);
  } catch (error) {
    toast(error.message || "No fue posible guardar la investigación");
  } finally {
    button.disabled = false;
  }
}

function updateHseControlQuestion() {
  const controlId = $("hseCriticalControl")?.value;
  const control = (activeHseData?.critical_controls || []).find(item => String(item.id) === String(controlId));
  $("hseCriticalControlQuestion").textContent = control
    ? `${control.verification_question}${control.performance_standard ? ` · Estándar: ${control.performance_standard}` : ""}`
    : "";
}

async function saveHseInspection() {
  if (!activeHseTicketId) return;
  const title = $("hseInspectionTitle").value.trim();
  if (!title) return toast("Indica la inspección realizada");
  const button = $("btnSaveHseInspection");
  button.disabled = true;
  try {
    await api(`/resolver/tickets/${activeHseTicketId}/safety/inspections`, {
      method: "POST",
      body: JSON.stringify({
        title,
        inspection_type: "FIELD_INSPECTION",
        result: $("hseInspectionResult").value,
        score: $("hseInspectionScore").value === "" ? null : Number($("hseInspectionScore").value),
        notes: $("hseInspectionNotes").value.trim() || null
      })
    });
    activeHseData = await api(`/resolver/tickets/${activeHseTicketId}/safety`);
    renderHsePanel(activeHseData);
    $("hseInspectionTitle").value = "";
    $("hseInspectionScore").value = "";
    $("hseInspectionNotes").value = "";
    toast("Inspección registrada en el expediente");
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

async function saveHseControlVerification() {
  if (!activeHseTicketId) return;
  const controlId = $("hseCriticalControl").value;
  if (!controlId) return toast("Selecciona un control crítico");
  const button = $("btnSaveHseControl");
  button.disabled = true;
  try {
    await api(`/resolver/tickets/${activeHseTicketId}/safety/control-verifications`, {
      method: "POST",
      body: JSON.stringify({
        control_id: controlId,
        result: $("hseControlResult").value,
        notes: $("hseControlNotes").value.trim() || null
      })
    });
    activeHseData = await api(`/resolver/tickets/${activeHseTicketId}/safety`);
    renderHsePanel(activeHseData);
    $("hseControlNotes").value = "";
    toast("Control crítico verificado");
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

async function requestHseClosure() {
  if (!activeHseTicketId) return;
  const summary = $("hseClosureSummary").value.trim();
  if (!summary) return toast("Escribe el resumen ejecutivo para solicitar el cierre");
  const button = $("btnRequestHseClosure");
  button.disabled = true;
  try {
    await api(`/resolver/tickets/${activeHseTicketId}/safety/closure-request`, {
      method: "POST",
      body: JSON.stringify({ request_summary: summary })
    });
    toast("Solicitud enviada al Supervisor HSE");
    activeHseData = await api(`/resolver/tickets/${activeHseTicketId}/safety`);
    renderHsePanel(activeHseData);
  } catch (error) {
    toast(error.message || "No fue posible solicitar el cierre");
    button.disabled = false;
  }
}

function openFieldPanel(ticketId, mode) {
  activeFieldTicketId = ticketId;
  activeFieldMode = mode;
  $("fieldTitle").textContent = mode === "text" ? "Agregar antecedente" : mode === "audio" ? "Audio de terreno" : "Video de evidencia";
  $("fieldSubtitle").textContent = "Quedará asociado al ticket; sin conexión se guardará en este dispositivo hasta sincronizar.";
  $("fieldTextWrap").classList.toggle("hidden", mode !== "text");
  $("fieldAudioWrap").classList.toggle("hidden", mode !== "audio");
  $("fieldVideoWrap").classList.toggle("hidden", mode !== "video");
  $("fieldTextArea").value = "";
  $("fieldAudioStatus").textContent = "Listo para grabar.";
  $("fieldVideoStatus").textContent = "Videos de hasta 25 MB; sin conexión quedarán pendientes.";
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
    const result = await sendOrQueueResolverEvidence({
      ticketId: activeFieldTicketId,
      kind: "field-text",
      body: {
        sender_role: "RESOLVER",
        sender_name: user?.full_name || "Resolutor",
        message
      }
    });
    toast(result.queued
      ? "Antecedente guardado; la central lo recibirá al reconectar."
      : "Antecedente enviado a la central");
    closeFieldPanel();
    if (!result.queued) await loadState();
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
  return sendOrQueueResolverEvidence({
    ticketId: activeFieldTicketId,
    kind: mediaType === "audio" ? "field-audio" : "field-video",
    mediaBlob: blobOrFile,
    body: {
      media_type: mediaType,
      file_name: fileName,
      sender_role: "RESOLVER",
      sender_name: user?.full_name || "Resolutor"
    }
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
      $("fieldAudioStatus").textContent = navigator.onLine ? "Enviando audio..." : "Guardando audio en el dispositivo...";
      try {
        const result = await uploadFieldMedia("audio", audioBlob, `audio-resolutor-${Date.now()}.${ext}`);
        $("fieldAudioStatus").textContent = result.queued ? "Audio pendiente de sincronizar." : "Audio enviado a la central.";
        toast(result.queued ? "Audio guardado; se enviará al reconectar." : "Audio enviado a la central");
        closeFieldPanel();
        if (!result.queued) await loadState();
      } catch (err) {
        $("fieldAudioStatus").textContent = "No se pudo enviar el audio.";
        toast(err.message);
      }
    };

    mediaRecorder.start();
    $("btnStartAudio").textContent = "⏹️ Detener y guardar audio";
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

  $("fieldVideoStatus").textContent = navigator.onLine ? "Enviando video..." : "Guardando video en el dispositivo...";
  try {
    const result = await uploadFieldMedia("video", file, file.name || `video-resolutor-${Date.now()}.mp4`);
    $("fieldVideoStatus").textContent = result.queued ? "Video pendiente de sincronizar." : "Video enviado a la central.";
    toast(result.queued ? "Video guardado; se enviará al reconectar." : "Video enviado a la central");
    closeFieldPanel();
    if (!result.queued) await loadState();
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
      $("routeStatus").textContent = `Usando la última ubicación conocida del ${termLower(responderTerm())}.`;
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
  $("routeSubtitle").textContent = `${typeLabel(ticket.alert_type)} · ${ticketIncidentSector(ticket)} · ${ticket.citizen_name || endUserTerm()}`;
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


async function notifyIncomingVoiceCalls(tickets) {
  if (!Array.isArray(tickets) || !user) return;
  const incoming = tickets.filter(t => isAssignedToMe(t) && isIncomingNeighborVoice(t));
  const newOnes = incoming.filter(t => {
    const session = activeVoiceSessionForTicket(t);
    const key = session?.id || session?.wa_center_session_id;
    return key && !knownVoiceSessionIds.has(String(key));
  });

  incoming.forEach(t => {
    const session = activeVoiceSessionForTicket(t);
    const key = session?.id || session?.wa_center_session_id;
    if (key) knownVoiceSessionIds.add(String(key));
  });
  saveKnownVoiceSessionIds();
  if (!newOnes.length) return;

  const ticket = newOnes[0];
  playResolverAlertSound();
  vibrateResolverAlert();
  if (getResolverSetting(SETTINGS_KEYS.browserNotification, true)) {
    const ok = await ensureBrowserNotificationPermission();
    if (ok) {
      try {
        new Notification(`📞 Llamada entrante del ${termLower(endUserTerm())}`, {
          body: `${ticket.citizen_name || endUserTerm()} solicita llamada segura por ${typeLabel(ticket.alert_type)}`,
          tag: `voice-${activeVoiceSessionForTicket(ticket)?.id || ticket.id}`,
          requireInteraction: true
        });
      } catch (_) {}
    }
  }
  toast(`📞 Llamada entrante del ${termLower(endUserTerm())} · ${ticket.citizen_name || endUserTerm()}`);
}

function syncIncomingVoiceOverlay(tickets) {
  if (!Array.isArray(tickets) || !user) return;
  if (["connecting", "calling", "ringing", "connected"].includes(resolverVoice.status) &&
      resolverVoice.direction !== "incoming") return;

  const ticket = tickets.find(t => isAssignedToMe(t) && isIncomingNeighborVoice(t));
  if (!ticket) {
    if (resolverVoice.direction === "incoming" && resolverVoice.status === "ringing" && !resolverVoice.call) {
      resolverVoice.status = "ended";
      stopResolverRingback();
      hideResolverVoiceOverlay();
    }
    return;
  }

  const session = activeVoiceSessionForTicket(ticket);
  const nextKey = resolverVoiceSessionKey(session);
  if (nextKey && nextKey === resolverVoice.sessionId && !$("resolverVoiceOverlay").classList.contains("hidden")) return;
  showResolverVoiceOverlay(ticket, session, "incoming");
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
    const pendingOverlay = await overlayPendingResolverStates(stateCache);
    if (!SUPERVISOR_MODE) {
      const snapshotTickets = (data.tickets || [])
        .filter((ticket) => String(ticket.assigned_resolver_id || ticket.assignment_resolver_id || "") === String(user.id))
        .filter((ticket) => !isTerminalTicket(ticket))
        .map((ticket) => Object.fromEntries([
          "id", "state", "priority", "alert_type", "title", "description", "latitude", "longitude", "accuracy",
          "created_at", "updated_at", "assigned_at", "assigned_resolver_id", "assignment_resolver_id", "assignment_state",
          "assignment_accept_due_at", "assignment_sla_policy",
          "citizen_name", "incident_sector", "sector_estimado", "sector_aproximado", "report_count"
        ].filter((key) => ticket[key] !== undefined).map((key) => [key, ticket[key]])));
      localStorage.setItem(RESOLVER_STATE_SNAPSHOT_KEY, JSON.stringify({
        saved_at: Date.now(), resolver: data.resolver, location: data.location,
        platform_settings: data.platform_settings, tickets: snapshotTickets
      }));
    }
    user = data.resolver;
    updateHeaderActions();
    localStorage.setItem("resolver_user", JSON.stringify(user));
    $("resolverName").textContent = user.full_name || responderTerm();
    const roleLabel = document.querySelector("#mainView .status-card .eyebrow");
    if (roleLabel) roleLabel.textContent = responderTerm();
    $("resolverCenter").textContent = user.control_center_name || user.control_center_code || "Centro de control";
    currentStatus = pendingOverlay.status || data.location?.status || data.reconciliation?.new_status || currentStatus || "OFFLINE";
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
    await notifyIncomingVoiceCalls(data.tickets || []);
    syncIncomingVoiceOverlay(data.tickets || []);
    syncFieldInspectionLauncher();
    renderTickets();
  } catch (err) {
    const cached = JSON.parse(localStorage.getItem(RESOLVER_STATE_SNAPSHOT_KEY) || "null");
    if (!SUPERVISOR_MODE && cached?.saved_at && Date.now() - Number(cached.saved_at) < 12 * 60 * 60 * 1000) {
      cached.tickets = (cached.tickets || []).filter((ticket) => !isTerminalTicket(ticket));
      stateCache = cached;
      const pendingOverlay = await overlayPendingResolverStates(stateCache);
      if (pendingOverlay.status) {
        currentStatus = pendingOverlay.status;
        updateStatusPill(currentStatus);
      }
      syncFieldInspectionLauncher();
      renderTickets();
      await renderResolverConnectivity();
    } else {
      toast(err.message);
    }
  }
}

function renderSupervisorClosures(rows = []) {
  const list = $("supervisorClosureList");
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = '<div class="empty">No hay solicitudes de cierre pendientes.</div>';
    return;
  }
  list.innerHTML = rows.map(item => `
    <article class="ticket-card supervisor-closure-card">
      <div class="ticket-head"><div><h3 class="ticket-title">🦺 ${escapeHtml(item.ticket_title || "Caso HSE")}</h3><p class="ticket-meta">#${escapeHtml(String(item.ticket_id || "").slice(0, 8).toUpperCase())} · ${escapeHtml(item.event_sector_name || "Área no indicada")}</p></div><span class="badge security">${escapeHtml(item.status)}</span></div>
      <div class="ticket-body">
        <p><strong>Profesional HSE:</strong> ${escapeHtml(item.resolver_name || item.requested_by_name || "—")}</p>
        <p><strong>Resumen:</strong> ${escapeHtml(item.request_summary || "—")}</p>
        <p><strong>Riesgo residual:</strong> ${escapeHtml(item.residual_risk_score ?? "—")} · ${escapeHtml(item.residual_risk_level || "Sin evaluar")}</p>
        <p><strong>Investigación:</strong> ${escapeHtml(item.investigation_notes || "Sin antecedentes")}</p>
        <p><strong>Acciones inmediatas:</strong> ${escapeHtml(item.immediate_actions || "—")}</p>
        <p><strong>Recomendaciones:</strong> ${escapeHtml(item.recommendations || "—")}</p>
      </div>
      <div class="actions"><button class="primary" type="button" data-supervisor-decision="APPROVED" data-request-id="${escapeHtml(item.id)}">Aprobar cierre</button><button class="secondary danger-soft" type="button" data-supervisor-decision="REJECTED" data-request-id="${escapeHtml(item.id)}">Devolver al HSE</button></div>
    </article>`).join("");
  list.querySelectorAll("[data-supervisor-decision]").forEach(button => {
    button.addEventListener("click", () => decideHseClosure(button.dataset.requestId, button.dataset.supervisorDecision));
  });
}

async function loadSupervisorClosures() {
  if (!isSupervisorPortal()) return;
  const list = $("supervisorClosureList");
  if (list) list.innerHTML = '<div class="empty">Cargando solicitudes HSE...</div>';
  try {
    const data = await api("/hse/supervisor/closure-requests?status=REQUESTED");
    renderSupervisorClosures(data.closure_requests || []);
  } catch (error) {
    if (list) list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function decideHseClosure(requestId, decision) {
  const approved = decision === "APPROVED";
  const notes = prompt(approved ? "Comentario de aprobación (opcional)" : "Motivo de devolución al Profesional HSE", "");
  if (notes === null || (!approved && !notes.trim())) return;
  try {
    await api(`/hse/supervisor/closure-requests/${encodeURIComponent(requestId)}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision, decision_notes: notes.trim() || null })
    });
    toast(approved ? "Cierre aprobado" : "Caso devuelto al Profesional HSE");
    await loadSupervisorClosures();
  } catch (error) {
    toast(error.message || "No fue posible registrar la decisión");
  }
}

function routineInspectionAreas() {
  const settings = stateCache?.platform_settings || {};
  const configured = [
    settings?.safety?.work_areas,
    settings?.safety_modules?.work_areas,
    settings?.work_areas,
    settings?.areas
  ].find(Array.isArray) || [];
  const values = [
    user?.work_area,
    ...configured.map((item) => typeof item === "string" ? item : item?.name || item?.label),
    "Toda la operación",
    "Mina subterránea",
    "Planta de procesamiento",
    "Mantenimiento / Taller",
    "Depósito de relaves",
    "Servicios / Superficie"
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return [...new Set(values)];
}

function populateRoutineInspectionAreas() {
  const select = $("routineInspectionArea");
  if (!select) return;
  const selected = select.value || user?.work_area || "";
  select.innerHTML = routineInspectionAreas().map((area) => `<option value="${escapeHtml(area)}">${escapeHtml(area)}</option>`).join("");
  if (selected && [...select.options].some((option) => option.value === selected)) select.value = selected;
}

function routineEvidenceSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function routineEvidenceKind(item = {}) {
  return String(item.media_type || item.type || "text").toLowerCase();
}

function releaseRoutineInspectionPreview() {
  if (routineInspectionPreviewUrl) URL.revokeObjectURL(routineInspectionPreviewUrl);
  routineInspectionPreviewUrl = null;
  const audio = $("routineEvidenceAudioPreview");
  const video = $("routineEvidenceVideoPreview");
  [audio, video].forEach((element) => {
    if (!element) return;
    element.pause?.();
    element.removeAttribute("src");
    element.load?.();
    element.classList.add("hidden");
  });
  const photo = $("routineEvidencePhotoPreview");
  if (photo) {
    photo.removeAttribute("src");
    photo.classList.add("hidden");
  }
}

function stopRoutineInspectionRecorder() {
  clearTimeout(routineInspectionRecordingTimeout);
  routineInspectionRecordingTimeout = null;
  routineInspectionAudioStream?.getTracks().forEach((track) => track.stop());
  routineInspectionAudioStream = null;
}

function setRoutineInspectionDockRecordingUI(active) {
  clearInterval(routineInspectionRecordingTimerInterval);
  routineInspectionRecordingTimerInterval = null;
  const banner = $("routineRecordingBanner");
  const timer = $("routineRecordingTimer");
  const button = $("routineInspectionAudioTool");
  if (active) {
    routineInspectionRecordingStartedAt = Date.now();
    if (timer) timer.textContent = "00:00";
    banner?.classList.remove("hidden");
    button?.classList.add("recording-active");
    if (button) button.innerHTML = "<span>⏹️</span><small>Detener audio</small>";
    routineInspectionRecordingTimerInterval = setInterval(() => {
      if (timer && routineInspectionRecordingStartedAt) timer.textContent = formatRecordingTime(Date.now() - routineInspectionRecordingStartedAt);
    }, 500);
    navigator.vibrate?.(80);
    return;
  }
  routineInspectionRecordingStartedAt = null;
  banner?.classList.add("hidden");
  button?.classList.remove("recording-active");
  if (button) button.innerHTML = "<span>🎙️</span><small>Audio</small>";
  navigator.vibrate?.([60, 80, 60]);
}

function showRoutineInspectionMediaPreview(blob, mode) {
  releaseRoutineInspectionPreview();
  if (!blob) return;
  const element = mode === "audio"
    ? $("routineEvidenceAudioPreview")
    : mode === "image"
      ? $("routineEvidencePhotoPreview")
      : $("routineEvidenceVideoPreview");
  if (!element) return;
  routineInspectionPreviewUrl = URL.createObjectURL(blob);
  element.src = routineInspectionPreviewUrl;
  element.classList.remove("hidden");
}

function setRoutineEvidenceModalMessage(message) {
  const element = $("routineEvidenceModalMsg");
  if (element) element.textContent = message || "";
}

function setRoutineEvidenceConfirmEnabled(enabled) {
  const button = $("btnConfirmRoutineEvidence");
  if (button) button.disabled = !enabled;
}

function openRoutineEvidenceCapture(mode, index = -1) {
  if (!["text", "audio", "image", "video"].includes(mode)) return;
  if (routineInspectionRecorder?.state === "recording") routineInspectionRecorder.stop();
  stopRoutineInspectionRecorder();
  releaseRoutineInspectionPreview();
  routineInspectionCaptureMode = mode;
  routineInspectionEditingIndex = Number.isInteger(index) ? index : -1;
  const existing = routineInspectionEditingIndex >= 0 ? routineInspectionEvidence[routineInspectionEditingIndex] : null;
  routineInspectionPendingMedia = existing && mode !== "text" ? { ...existing } : null;
  setRoutineEvidenceModalMessage("");

  $("routineEvidenceTextMode")?.classList.toggle("hidden", mode !== "text");
  $("routineEvidenceAudioMode")?.classList.toggle("hidden", mode !== "audio");
  $("routineEvidencePhotoMode")?.classList.toggle("hidden", mode !== "image");
  $("routineEvidenceVideoMode")?.classList.toggle("hidden", mode !== "video");
  const labels = {
    text:[existing ? "Editar nota" : "Agregar nota", "Registra un hallazgo independiente dentro de la bitácora."],
    audio:[existing ? "Revisar o reemplazar audio" : "Agregar audio", "Graba y escucha el audio antes de incorporarlo."],
    image:[existing ? "Revisar o reemplazar fotografía" : "Agregar fotografía", "Toma una foto y revísala antes de incorporarla."],
    video:[existing ? "Revisar o reemplazar video" : "Agregar video", "Graba o selecciona un video y revísalo antes de incorporarlo."]
  };
  $("routineEvidenceModalTitle").textContent = labels[mode][0];
  $("routineEvidenceModalSubtitle").textContent = labels[mode][1];
  $("routineEvidenceText").value = mode === "text" ? String(existing?.text || "") : "";
  if ($("routineEvidencePhotoInput")) $("routineEvidencePhotoInput").value = "";
  if ($("routineEvidenceVideoInput")) $("routineEvidenceVideoInput").value = "";
  if ($("btnRoutineEvidenceRecord")) $("btnRoutineEvidenceRecord").textContent = existing ? "Reemplazar grabación" : "Iniciar grabación";
  if ($("routineEvidenceAudioStatus")) $("routineEvidenceAudioStatus").textContent = existing ? "Audio listo para revisar" : "Listo para grabar";
  $("routineEvidenceAudioIndicator")?.classList.remove("recording");
  if (routineInspectionPendingMedia?.blob) showRoutineInspectionMediaPreview(routineInspectionPendingMedia.blob, mode);
  setRoutineEvidenceConfirmEnabled(mode === "text" ? !!String(existing?.text || "").trim() : !!routineInspectionPendingMedia?.blob);
  $("routineEvidencePanel")?.classList.remove("hidden");
  if (mode === "text") setTimeout(() => $("routineEvidenceText")?.focus(), 100);
}

function closeRoutineEvidenceCapture() {
  if (routineInspectionRecorder?.state === "recording") {
    routineInspectionRecorder.ondataavailable = null;
    routineInspectionRecorder.onstop = null;
    routineInspectionRecorder.stop();
  }
  stopRoutineInspectionRecorder();
  releaseRoutineInspectionPreview();
  routineInspectionRecorder = null;
  routineInspectionAudioChunks = [];
  routineInspectionCaptureMode = null;
  routineInspectionEditingIndex = -1;
  routineInspectionPendingMedia = null;
  $("routineEvidencePanel")?.classList.add("hidden");
}

function confirmRoutineEvidence() {
  const mode = routineInspectionCaptureMode;
  let evidence = null;
  if (mode === "text") {
    const value = $("routineEvidenceText")?.value.trim() || "";
    if (!value) return setRoutineEvidenceModalMessage("Escribe una nota antes de agregarla.");
    evidence = { media_type:"text", text:value, created_at:new Date().toISOString() };
  } else if (routineInspectionPendingMedia?.blob) {
    evidence = { ...routineInspectionPendingMedia };
  }
  if (!evidence) return setRoutineEvidenceModalMessage("Prepara la evidencia antes de agregarla.");
  if (routineInspectionEditingIndex >= 0) routineInspectionEvidence.splice(routineInspectionEditingIndex, 1, evidence);
  else routineInspectionEvidence.push(evidence);
  renderRoutineInspectionEvidence();
  closeRoutineEvidenceCapture();
  toast(`${mode === "text" ? "Nota" : mode === "audio" ? "Audio" : mode === "image" ? "Fotografía" : "Video"} agregado a la bitácora`);
}

function renderRoutineInspectionEvidence() {
  const list = $("routineInspectionEvidenceList");
  const status = $("routineInspectionEvidenceStatus");
  if (!list || !status) return;
  status.textContent = routineInspectionEvidence.length
    ? `${routineInspectionEvidence.length} evidencia${routineInspectionEvidence.length === 1 ? "" : "s"}`
    : "Sin evidencia";
  list.innerHTML = routineInspectionEvidence.map((item, index) => {
    const kind = routineEvidenceKind(item);
    const icon = kind === "text" ? "📝" : kind === "audio" ? "🎙️" : kind === "image" ? "📷" : "📹";
    const title = kind === "text" ? "Nota de terreno" : kind === "audio" ? "Nota de audio" : kind === "image" ? "Fotografía de terreno" : "Video de terreno";
    const detail = kind === "text" ? item.text : `${item.file_name || "Archivo"} · ${routineEvidenceSize(item.blob?.size || item.size_bytes)}`;
    return `
    <div class="routine-evidence-item">
      <span class="routine-evidence-item-icon">${icon}</span>
      <button class="routine-review-evidence" type="button" data-routine-evidence-review="${index}"><strong>${title}</strong><small>${escapeHtml(detail)}</small></button>
      <button class="routine-remove-evidence" type="button" data-routine-evidence-index="${index}" aria-label="Quitar evidencia">×</button>
    </div>`;
  }).join("");
  list.querySelectorAll("[data-routine-evidence-review]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.routineEvidenceReview);
      openRoutineEvidenceCapture(routineEvidenceKind(routineInspectionEvidence[index]), index);
    });
  });
  list.querySelectorAll("[data-routine-evidence-index]").forEach((button) => {
    button.addEventListener("click", () => {
      routineInspectionEvidence.splice(Number(button.dataset.routineEvidenceIndex), 1);
      renderRoutineInspectionEvidence();
    });
  });
}

function setRoutineInspectionMessage(message, success = false) {
  const element = $("routineInspectionMsg");
  if (!element) return;
  element.textContent = message || "";
  element.classList.toggle("success", !!success);
}

function selectedRoutineInspectionCategory() {
  const type = String($("routineInspectionCategory")?.value || "").toUpperCase();
  return (activeFieldInspectionData?.categories || []).find((category) => String(category.type || "").toUpperCase() === type) || null;
}

function populateRoutineInspectionCategories(categories = []) {
  const select = $("routineInspectionCategory");
  if (!select) return;
  const selected = select.value;
  select.innerHTML = categories.map((category) => `<option value="${escapeHtml(category.type)}">${escapeHtml(category.icon || "📝")} ${escapeHtml(category.title || category.type)}${category.visible_to_neighbor ? "" : " · exclusiva resolutor"}</option>`).join("");
  if (selected && [...select.options].some((option) => option.value === selected)) select.value = selected;
}

function syncRoutineInspectionPresentation() {
  const mining = isMiningHseExperience();
  $("routineCityClassification")?.classList.toggle("hidden", mining);
  $("routineMiningAreaField")?.classList.toggle("hidden", !mining);
  $("routineCityAreaField")?.classList.toggle("hidden", mining);
  $("routineInspectionAlertToggle")?.classList.toggle("hidden", mining);
  $("routineInspectionGps")?.classList.toggle("hidden", mining);
  if ($("routineInspectionEyebrow")) $("routineInspectionEyebrow").textContent = mining ? "Seguridad operacional" : "Patrullaje e inspección municipal";
  if ($("routineInspectionHeading")) $("routineInspectionHeading").textContent = mining ? "Inspección de rutina" : "Nueva inspección de terreno";
  if ($("routineInspectionIntro")) $("routineInspectionIntro").textContent = mining
    ? "Registra un recorrido preventivo independiente de los casos y emergencias."
    : "Clasifica la inspección, registra antecedentes y evidencia, y decide si el hallazgo debe convertirse en una alerta georreferenciada para la Central.";
  if ($("routineInspectionTitleLabel")) $("routineInspectionTitleLabel").textContent = mining ? "Título de la inspección" : "Asunto o título (opcional)";
  if ($("routineInspectionTitle")) $("routineInspectionTitle").placeholder = mining ? "Ej. Inspección preoperacional del nivel 850" : "Ej. Obstáculo peligroso en vía pública";
  if ($("routineInspectionNotesLabel")) $("routineInspectionNotesLabel").textContent = mining ? "Resumen general (opcional)" : "Antecedentes observados";
  if ($("routineInspectionNotes")) $("routineInspectionNotes").placeholder = mining
    ? "Síntesis de la inspección. Agrega cada hallazgo desde la bitácora de evidencias..."
    : "Describe objetivamente la condición observada, las medidas inmediatas y cualquier antecedente útil para la Central...";
  if ($("btnSaveRoutineInspection")) $("btnSaveRoutineInspection").textContent = mining ? "Finalizar y guardar inspección" : "Guardar inspección";
}

function resetRoutineInspectionDraft() {
  $("routineInspectionTitle").value = "";
  $("routineInspectionNotes").value = "";
  if ($("routineInspectionLocation")) $("routineInspectionLocation").value = "";
  if ($("routineInspectionCreateAlert")) $("routineInspectionCreateAlert").checked = false;
  routineInspectionEvidence = [];
  renderRoutineInspectionEvidence();
  setRoutineInspectionMessage("");
}

async function loadCityFieldInspections() {
  const list = $("routineInspectionRecentList");
  if (list) list.innerHTML = '<p class="muted">Cargando inspecciones...</p>';
  try {
    const data = await api("/resolver/field-inspections?limit=6");
    activeFieldInspectionData = data;
    populateRoutineInspectionCategories(data.categories || []);
    const allowAlert = data.policy?.allow_alert_creation !== false && (data.categories || []).length > 0;
    if ($("routineInspectionCreateAlert")) {
      $("routineInspectionCreateAlert").disabled = !allowAlert;
      if (!allowAlert) $("routineInspectionCreateAlert").checked = false;
    }
    const rows = data.inspections || [];
    if (!rows.length) {
      list.innerHTML = '<p class="muted">Aún no has registrado inspecciones.</p>';
      return;
    }
    const categoryMap = new Map((data.categories || []).map((category) => [String(category.type || "").toUpperCase(), category]));
    list.innerHTML = rows.map((item) => {
      const date = new Date(item.completed_at || item.created_at);
      const dateLabel = Number.isNaN(date.getTime()) ? "Fecha no disponible" : date.toLocaleString("es-CL", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
      const category = categoryMap.get(String(item.category_type || item.alert_type || "").toUpperCase());
      const classification = category ? `${category.icon || "📝"} ${category.title || category.type}` : "Inspección de terreno";
      const alert = item.linked_ticket_id ? `🚨 Alerta #${String(item.linked_ticket_id).slice(0, 8).toUpperCase()}` : "Registro preventivo sin alerta";
      return `<article class="routine-recent-item"><div class="routine-recent-item-head"><div><h4>${escapeHtml(item.title || classification)}</h4><p>${escapeHtml(classification)} · ${escapeHtml(item.area || "Ubicación GPS")} · ${escapeHtml(dateLabel)}</p><small>${escapeHtml(alert)}</small></div><span class="routine-recent-badge">GUARDADA</span></div></article>`;
    }).join("");
  } catch (error) {
    if (list) list.innerHTML = `<p class="msg">${escapeHtml(error.message || "No fue posible cargar las inspecciones")}</p>`;
  }
}

async function loadRoutineInspections() {
  if (!isMiningHseExperience()) return loadCityFieldInspections();
  const list = $("routineInspectionRecentList");
  if (!list) return;
  list.innerHTML = '<p class="muted">Cargando inspecciones...</p>';
  try {
    const data = await api("/resolver/safety/inspections?limit=6");
    const rows = data.inspections || [];
    if (!rows.length) {
      list.innerHTML = '<p class="muted">Aún no has registrado inspecciones.</p>';
      return;
    }
    list.innerHTML = rows.map((item) => {
      const date = new Date(item.completed_at || item.created_at);
      const dateLabel = Number.isNaN(date.getTime()) ? "Fecha no disponible" : date.toLocaleString("es-CL", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
      const evidence = Array.isArray(item.evidence) ? item.evidence.length : 0;
      return `<article class="routine-recent-item"><div class="routine-recent-item-head"><div><h4>${escapeHtml(item.title || "Inspección de rutina")}</h4><p>${escapeHtml(item.area || "Toda la operación")} · ${escapeHtml(dateLabel)} · ${evidence} evidencia${evidence === 1 ? "" : "s"}</p></div><span class="routine-recent-badge">GUARDADA</span></div></article>`;
    }).join("");
  } catch (error) {
    list.innerHTML = `<p class="msg">${escapeHtml(error.message || "No fue posible cargar las inspecciones")}</p>`;
  }
}

function openRoutineInspectionPanel() {
  syncRoutineInspectionPresentation();
  if (isMiningHseExperience()) populateRoutineInspectionAreas();
  else {
    const position = getLastKnownLatLon();
    if ($("routineInspectionGps")) $("routineInspectionGps").textContent = position
      ? `📍 ${Number(position.latitude).toFixed(5)}, ${Number(position.longitude).toFixed(5)} · se actualizará al guardar`
      : "📍 La ubicación se capturará al guardar.";
  }
  renderRoutineInspectionEvidence();
  setRoutineInspectionMessage("");
  $("routineInspectionPanel")?.classList.remove("hidden");
  $("routineInspectionToolbar")?.classList.remove("hidden");
  void loadRoutineInspections();
}

function closeRoutineInspectionPanel() {
  if (routineInspectionRecorder?.state === "recording") {
    routineInspectionDiscardRecording = true;
    routineInspectionRecorder.stop();
  }
  setRoutineInspectionDockRecordingUI(false);
  closeRoutineEvidenceCapture();
  $("routineInspectionPanel")?.classList.add("hidden");
  $("routineInspectionToolbar")?.classList.add("hidden");
}

async function toggleRoutineInspectionDockAudio() {
  if (routineInspectionRecorder?.state === "recording") {
    routineInspectionRecorder.stop();
    return;
  }
  routineInspectionCaptureMode = "audio";
  routineInspectionEditingIndex = -1;
  routineInspectionPendingMedia = null;
  routineInspectionRecordingFromDock = true;
  routineInspectionDiscardRecording = false;
  await startRoutineInspectionAudioRecording(true);
}

async function toggleRoutineInspectionAudio() {
  if (routineInspectionRecorder?.state === "recording") {
    routineInspectionRecorder.stop();
    return;
  }
  routineInspectionRecordingFromDock = false;
  routineInspectionDiscardRecording = false;
  await startRoutineInspectionAudioRecording(false);
}

async function startRoutineInspectionAudioRecording(fromDock = false) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("Este dispositivo no permite grabar audio desde la app.");
  try {
    releaseRoutineInspectionPreview();
    routineInspectionPendingMedia = null;
    setRoutineEvidenceConfirmEnabled(false);
    routineInspectionAudioChunks = [];
    routineInspectionAudioStream = await navigator.mediaDevices.getUserMedia({ audio:true });
    const recorder = new MediaRecorder(routineInspectionAudioStream, preferredAudioOptions());
    routineInspectionRecorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data?.size > 0) routineInspectionAudioChunks.push(event.data);
    };
    recorder.onstop = () => {
      clearTimeout(routineInspectionRecordingTimeout);
      stopRoutineInspectionRecorder();
      if (fromDock) setRoutineInspectionDockRecordingUI(false);
      $("routineEvidenceAudioIndicator")?.classList.remove("recording");
      if ($("btnRoutineEvidenceRecord")) $("btnRoutineEvidenceRecord").textContent = "Reemplazar grabación";
      const mimeType = recorder.mimeType || routineInspectionAudioChunks[0]?.type || "audio/webm";
      const blob = new Blob(routineInspectionAudioChunks, { type:mimeType });
      if (!blob.size || routineInspectionDiscardRecording) {
        routineInspectionDiscardRecording = false;
        routineInspectionRecordingFromDock = false;
        return;
      }
      if (blob.size > 8 * 1024 * 1024) {
        routineInspectionRecordingFromDock = false;
        return toast("El audio supera el máximo de 8 MB.");
      }
      const ext = fileExtensionForMime(mimeType, "webm");
      const evidence = { media_type:"audio", blob, file_name:`inspeccion-audio-${Date.now()}.${ext}`, created_at:new Date().toISOString() };
      if (fromDock) {
        routineInspectionEvidence.push(evidence);
        routineInspectionRecordingFromDock = false;
        renderRoutineInspectionEvidence();
        toast("Audio agregado a la bitácora");
        return;
      }
      routineInspectionPendingMedia = evidence;
      showRoutineInspectionMediaPreview(blob, "audio");
      if ($("routineEvidenceAudioStatus")) $("routineEvidenceAudioStatus").textContent = "Audio listo para revisar";
      setRoutineEvidenceConfirmEnabled(true);
    };
    recorder.start();
    if (fromDock) setRoutineInspectionDockRecordingUI(true);
    $("routineEvidenceAudioIndicator")?.classList.add("recording");
    if ($("routineEvidenceAudioStatus")) $("routineEvidenceAudioStatus").textContent = "Grabando audio...";
    if ($("btnRoutineEvidenceRecord")) $("btnRoutineEvidenceRecord").textContent = "Detener grabación";
    routineInspectionRecordingTimeout = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 60_000);
  } catch (error) {
    stopRoutineInspectionRecorder();
    routineInspectionRecorder = null;
    routineInspectionRecordingFromDock = false;
    routineInspectionDiscardRecording = false;
    setRoutineInspectionDockRecordingUI(false);
    $("routineEvidenceAudioIndicator")?.classList.remove("recording");
    if ($("routineEvidenceAudioStatus")) $("routineEvidenceAudioStatus").textContent = "No fue posible iniciar la grabación";
    toast(error.message || "No fue posible acceder al micrófono");
  }
}

function queueRoutineInspectionVideo(event) {
  const input = event?.target || $("routineEvidenceVideoInput");
  const file = input?.files?.[0];
  if (!file) return;
  if (!String(file.type || "").startsWith("video/")) return toast("Selecciona un archivo de video válido.");
  if (file.size > 20 * 1024 * 1024) return toast("El video supera el máximo de 20 MB.");
  routineInspectionPendingMedia = { media_type:"video", blob:file, file_name:file.name || `inspeccion-video-${Date.now()}.mp4` };
  input.value = "";
  showRoutineInspectionMediaPreview(file, "video");
  setRoutineEvidenceConfirmEnabled(true);
  setRoutineEvidenceModalMessage("");
}

function queueRoutineInspectionPhoto(event) {
  const input = event?.target || $("routineEvidencePhotoInput");
  const file = input?.files?.[0];
  if (!file) return;
  if (!String(file.type || "").startsWith("image/")) return toast("Selecciona una fotografía válida.");
  if (file.size > 12 * 1024 * 1024) return toast("La fotografía supera el máximo de 12 MB.");
  routineInspectionPendingMedia = { media_type:"image", blob:file, file_name:file.name || `inspeccion-foto-${Date.now()}.jpg` };
  input.value = "";
  showRoutineInspectionMediaPreview(file, "image");
  setRoutineEvidenceConfirmEnabled(true);
  setRoutineEvidenceModalMessage("");
}

async function saveCityFieldInspection() {
  const category = selectedRoutineInspectionCategory();
  const notes = $("routineInspectionNotes")?.value.trim() || "";
  if (!category) {
    setRoutineInspectionMessage("Selecciona una categoría autorizada por el Centro de Control.");
    $("routineInspectionCategory")?.focus();
    return;
  }
  if (!notes && !routineInspectionEvidence.length) {
    setRoutineInspectionMessage("Registra antecedentes o agrega evidencia antes de guardar.");
    $("routineInspectionNotes")?.focus();
    return;
  }
  if (routineInspectionRecorder?.state === "recording") {
    setRoutineInspectionMessage("Detén la grabación de audio antes de guardar.");
    return;
  }
  const createAlert = $("routineInspectionCreateAlert")?.checked === true;
  const title = $("routineInspectionTitle")?.value.trim() || `Inspección de terreno · ${category.title || category.type}`;
  const button = $("btnSaveRoutineInspection");
  button.disabled = true;
  button.textContent = "Capturando GPS...";
  setRoutineInspectionMessage("Validando ubicación y preparando el registro...");
  try {
    const pos = await getLocation({ maximumAge:3000 });
    validatePositionQuality(pos);
    currentPosition = pos;
    const textEvidence = routineInspectionEvidence
      .filter((evidence) => routineEvidenceKind(evidence) === "text")
      .map((evidence) => ({
        media_type:"text",
        text:String(evidence.text || "").trim(),
        created_at:evidence.created_at || new Date().toISOString()
      }))
      .filter((evidence) => evidence.text);
    button.textContent = createAlert ? "Creando inspección y alerta..." : "Guardando inspección...";
    const created = await api("/resolver/field-inspections", {
      method:"POST",
      body:JSON.stringify({
        title,
        area:$("routineInspectionLocation")?.value.trim() || null,
        category_type:String(category.type || "").toUpperCase(),
        inspection_type:"FIELD_INSPECTION",
        result:createAlert ? "NON_COMPLIANT" : "NOT_EVALUATED",
        notes:notes || null,
        text_evidence:textEvidence,
        latitude:pos.coords.latitude,
        longitude:pos.coords.longitude,
        accuracy:pos.coords.accuracy,
        create_alert:createAlert,
        alert_type:createAlert ? String(category.type || "").toUpperCase() : null,
        alert_title:createAlert ? title : null,
        alert_description:createAlert ? notes || `Hallazgo detectado durante la inspección: ${title}` : null
      })
    });
    const inspectionId = created.inspection?.id;
    if (!inspectionId) throw new Error("La plataforma no devolvió el identificador de la inspección.");
    let uploaded = 0;
    const failed = [];
    for (const evidence of routineInspectionEvidence.filter((item) => ["audio", "image", "video"].includes(routineEvidenceKind(item)))) {
      try {
        await api(`/resolver/field-inspections/${encodeURIComponent(inspectionId)}/evidence`, {
          method:"POST",
          body:JSON.stringify({
            media_type:evidence.media_type,
            data_url:await blobToDataUrl(evidence.blob),
            file_name:evidence.file_name
          })
        });
        uploaded += 1;
      } catch (error) {
        failed.push(error.message || "Error de carga");
      }
    }
    resetRoutineInspectionDraft();
    await loadCityFieldInspections();
    await loadState();
    const ticketLabel = created.ticket ? ` Alerta #${String(created.ticket.id).slice(0, 8).toUpperCase()} visible en el mapa.` : " Sin generar alerta operacional.";
    const evidenceLabel = failed.length ? ` ${uploaded} evidencia(s) enviada(s) y ${failed.length} pendiente(s).` : "";
    setRoutineInspectionMessage(`Inspección clasificada como ${category.title || category.type} guardada.${ticketLabel}${evidenceLabel}`, true);
    toast(created.ticket ? "Inspección y alerta creadas" : "Inspección registrada");
  } catch (error) {
    setRoutineInspectionMessage(error.message || "No fue posible guardar la inspección.");
  } finally {
    button.disabled = false;
    button.textContent = "Guardar inspección";
  }
}

async function saveRoutineInspection() {
  if (!isMiningHseExperience()) return saveCityFieldInspection();
  const title = $("routineInspectionTitle")?.value.trim();
  if (!title) {
    setRoutineInspectionMessage("Escribe el título de la inspección.");
    $("routineInspectionTitle")?.focus();
    return;
  }
  if (routineInspectionRecorder?.state === "recording") {
    setRoutineInspectionMessage("Detén la grabación de audio antes de guardar.");
    return;
  }
  const button = $("btnSaveRoutineInspection");
  button.disabled = true;
  button.textContent = "Guardando inspección...";
  setRoutineInspectionMessage("Creando registro y cargando evidencia...");
  try {
    const textEvidence = routineInspectionEvidence
      .filter((evidence) => routineEvidenceKind(evidence) === "text")
      .map((evidence) => ({
        media_type:"text",
        text:String(evidence.text || "").trim(),
        created_at:evidence.created_at || new Date().toISOString()
      }))
      .filter((evidence) => evidence.text);
    const created = await api("/resolver/safety/inspections", {
      method:"POST",
      body:JSON.stringify({
        title,
        area:$("routineInspectionArea")?.value || user?.work_area || null,
        notes:$("routineInspectionNotes")?.value.trim() || null,
        text_evidence:textEvidence,
        inspection_type:"ROUTINE_INSPECTION",
        result:"NOT_EVALUATED"
      })
    });
    const inspectionId = created.inspection?.id;
    if (!inspectionId) {
      throw new Error("La plataforma no devolvió el identificador de la inspección.");
    }
    let uploaded = 0;
    const failed = [];
    for (const evidence of routineInspectionEvidence.filter((item) => ["audio", "image", "video"].includes(routineEvidenceKind(item)))) {
      try {
        const dataUrl = await blobToDataUrl(evidence.blob);
        await api(`/resolver/safety/inspections/${encodeURIComponent(inspectionId)}/evidence`, {
          method:"POST",
          body:JSON.stringify({ media_type:evidence.media_type, data_url:dataUrl, file_name:evidence.file_name })
        });
        uploaded += 1;
      } catch (error) {
        failed.push(error.message || "Error de carga");
      }
    }
    resetRoutineInspectionDraft();
    await loadRoutineInspections();
    if (failed.length) {
      setRoutineInspectionMessage(`Inspección guardada. ${uploaded} evidencia(s) cargada(s) y ${failed.length} pendiente(s).`, true);
      toast("Inspección guardada con evidencia pendiente");
    } else {
      const evidenceCount = textEvidence.length + uploaded;
      setRoutineInspectionMessage(`Inspección guardada correctamente${evidenceCount ? ` con ${evidenceCount} evidencia(s)` : ""}.`, true);
      toast("Inspección de rutina registrada");
    }
  } catch (error) {
    setRoutineInspectionMessage(error.message || "No fue posible guardar la inspección.");
  } finally {
    button.disabled = false;
    button.textContent = "Finalizar y guardar inspección";
  }
}

function updateHeaderActions() {
  $("btnSettings")?.classList.toggle("hidden", isSupervisorPortal());
  syncFieldInspectionLauncher();
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
  const code = $("otpInput").value.trim();
  $("loginMsg").textContent = "";
  if (!phone) {
    $("loginMsg").textContent = "Ingresa un teléfono.";
    return;
  }
  try {
    const resp = await api(SUPERVISOR_MODE ? "/auth/panel-login" : "/resolver/auth/login", {
      method: "POST",
      body: JSON.stringify({
        phone,
        code: code || undefined,
        channel: SOS_CONFIG.DEMO_MODE ? "demo" : undefined,
        ...(SUPERVISOR_MODE ? { panel_type: "RESOLVER" } : {})
      })
    });
    if (resp.requires_verification) {
      $("loginMsg").textContent = resp.demo_code
        ? `Código demo: ${resp.demo_code}`
        : `Código enviado por ${resp.otp_channel || "SMS"}.`;
      $("otpInput").focus();
      return;
    }
    if (!SUPERVISOR_MODE && resp.user.role !== "RESOLVER") throw new Error("Este usuario no tiene rol Profesional HSE");
    if (SUPERVISOR_MODE && !HSE_SUPERVISOR_ROLES.includes(resp.user.role)) throw new Error("Este usuario no tiene permisos de Supervisor HSE");
    localStorage.setItem(SESSION_TOKEN_KEY, resp.token);
    user = resp.user;
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    localStorage.setItem("queltu_response_portal_mode", portalMode);
    showMain();
    if (isSupervisorPortal()) {
      await loadSupervisorClosures();
    } else {
      await updateGps("AVAILABLE").catch((err) => toast(err.message));
      startGpsHeartbeat();
      await reconcileStatus();
      await loadState();
    }
    startPolling();
  } catch (err) {
    $("loginMsg").textContent = err.message;
  }
}

function showMain() {
  $("loginView").classList.add("hidden");
  $("mainView").classList.toggle("hidden", isSupervisorPortal());
  $("supervisorView")?.classList.toggle("hidden", !isSupervisorPortal());
  updateHeaderActions();
  if (isSupervisorPortal()) {
    $("supervisorName").textContent = user?.full_name || "Supervisor HSE";
    $("supervisorCenter").textContent = user?.control_center_name || user?.control_center_code || "Centro de control";
    return;
  }
  $("resolverName").textContent = user?.full_name || responderTerm();
  $("resolverCenter").textContent = user?.control_center_name || user?.control_center_code || "Centro de control";
  updateStatusPill(currentStatus);
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(isSupervisorPortal() ? loadSupervisorClosures : loadState, POLL_MS);
}

function renderAppVersion() {
  const appScript = [...document.scripts].find((script) => script.src.includes("/app.js"));
  const release = appScript ? new URL(appScript.src).searchParams.get("v") : null;
  if ($("appVersion")) $("appVersion").textContent = `Resolutor · ${release || "desarrollo local"}`;
}

function init() {
  renderAppVersion();
  if (SUPERVISOR_MODE) {
    $("loginTitle").textContent = "Ingreso Supervisor HSE";
    $("loginSubtitle").textContent = "Revisa y decide solicitudes de cierre del Centro de Control asignado a tu cuenta.";
  }
  void renderResolverConnectivity();
  $("btnLogin").addEventListener("click", login);
  $("btnAvailable").addEventListener("click", () => setStatus("AVAILABLE"));
  $("btnBusy").addEventListener("click", () => setStatus("BUSY"));
  $("btnOffline").addEventListener("click", () => setStatus("OFFLINE"));
  $("btnUpdateGps").addEventListener("click", () => updateGps(currentStatus === "OFFLINE" ? "AVAILABLE" : currentStatus).then(() => toast("GPS actualizado")).catch((err) => toast(err.message)));
  $("btnCloseFieldInspection")?.addEventListener("click", closeFieldInspectionPanel);
  $("btnSaveFieldInspection")?.addEventListener("click", saveFieldInspection);
  $("fieldInspectionCreateAlert")?.addEventListener("change", toggleFieldInspectionAlertFields);
  $("fieldInspectionResult")?.addEventListener("change", () => {
    if ($("fieldInspectionResult").value === "NON_COMPLIANT" && !$("fieldInspectionCreateAlert").disabled) {
      $("fieldInspectionCreateAlert").checked = true;
      toggleFieldInspectionAlertFields();
    }
  });
  $("fieldInspectionPanel")?.addEventListener("click", (event) => {
    if (event.target === $("fieldInspectionPanel")) closeFieldInspectionPanel();
  });
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
  $("btnCloseHsePanel")?.addEventListener("click", closeHsePanel);
  $("btnSaveHseRisk")?.addEventListener("click", saveHseRisk);
  $("btnSaveHseInvestigation")?.addEventListener("click", saveHseInvestigation);
  $("btnSaveHseInspection")?.addEventListener("click", saveHseInspection);
  $("btnSaveHseControl")?.addEventListener("click", saveHseControlVerification);
  $("hseCriticalControl")?.addEventListener("change", updateHseControlQuestion);
  $("btnRequestHseClosure")?.addEventListener("click", requestHseClosure);
  $("btnRefreshSupervisor")?.addEventListener("click", loadSupervisorClosures);
  $("hseSeverity")?.addEventListener("change", updateHseRiskPreview);
  $("hseFrequency")?.addEventListener("change", () => {
    if ($("hseFrequencySource")?.value === "SYSTEM_SUGGESTION" && Number(activeHseData?.frequency_suggestion?.value) !== Number($("hseFrequency").value)) {
      $("hseFrequencySource").value = "PROFESSIONAL_ESTIMATE";
    }
    updateHseRiskPreview();
  });
  $("hsePanel")?.addEventListener("click", (event) => {
    if (event.target === $("hsePanel")) closeHsePanel();
  });
  $("btnAnswerVoice").addEventListener("click", () => {
    if (resolverVoice.ticketId && resolverVoice.sessionId) {
      answerNeighborVoice(resolverVoice.ticketId, resolverVoice.sessionId);
    }
  });
  $("btnRejectVoice").addEventListener("click", () => {
    if (resolverVoice.ticketId && resolverVoice.sessionId) {
      rejectNeighborVoice(resolverVoice.ticketId, resolverVoice.sessionId);
    }
  });
  $("btnMuteVoice").addEventListener("click", toggleResolverVoiceMute);
  $("btnHangupVoice").addEventListener("click", () => {
    void stopResolverVoice({ notifyBackend: true, reason: "HANGUP" });
  });

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    renderTickets();
  }));

  $("btnSettings").addEventListener("click", openSettingsPanel);
  $("btnRoutineInspection")?.addEventListener("click", () => {
    if (!isMiningHseExperience() && stateCache?.platform_settings?.resolver_inspection_policy?.enabled === false) {
      toast("Las inspecciones están deshabilitadas por la configuración del Centro de Control");
    } else openRoutineInspectionPanel();
  });
  $("btnCloseRoutineInspection")?.addEventListener("click", closeRoutineInspectionPanel);
  $("routineInspectionPanel")?.addEventListener("click", (event) => {
    if (event.target === $("routineInspectionPanel")) closeRoutineInspectionPanel();
  });
  $("routineInspectionNoteTool")?.addEventListener("click", () => openRoutineEvidenceCapture("text"));
  $("routineInspectionAudioTool")?.addEventListener("click", toggleRoutineInspectionDockAudio);
  $("routineInspectionPhotoTool")?.addEventListener("click", () => openRoutineEvidenceCapture("image"));
  $("routineInspectionVideoTool")?.addEventListener("click", () => openRoutineEvidenceCapture("video"));
  $("btnCloseRoutineEvidence")?.addEventListener("click", closeRoutineEvidenceCapture);
  $("btnCancelRoutineEvidence")?.addEventListener("click", closeRoutineEvidenceCapture);
  $("btnConfirmRoutineEvidence")?.addEventListener("click", confirmRoutineEvidence);
  $("btnRoutineEvidenceRecord")?.addEventListener("click", toggleRoutineInspectionAudio);
  $("btnRoutineEvidencePickPhoto")?.addEventListener("click", () => $("routineEvidencePhotoInput")?.click());
  $("routineEvidencePhotoInput")?.addEventListener("change", queueRoutineInspectionPhoto);
  $("btnRoutineEvidencePickVideo")?.addEventListener("click", () => $("routineEvidenceVideoInput")?.click());
  $("routineEvidenceVideoInput")?.addEventListener("change", queueRoutineInspectionVideo);
  $("routineInspectionCategory")?.addEventListener("change", () => {
    const category = selectedRoutineInspectionCategory();
    if (!$("routineInspectionTitle")?.value.trim() && category) {
      $("routineInspectionTitle").value = `Inspección de terreno · ${category.title || category.type}`;
    }
  });
  $("routineEvidenceText")?.addEventListener("input", () => {
    setRoutineEvidenceConfirmEnabled(!!$("routineEvidenceText")?.value.trim());
  });
  $("routineEvidencePanel")?.addEventListener("click", (event) => {
    if (event.target === $("routineEvidencePanel")) closeRoutineEvidenceCapture();
  });
  $("btnSaveRoutineInspection")?.addEventListener("click", saveRoutineInspection);
  $("btnRefreshRoutineInspections")?.addEventListener("click", loadRoutineInspections);
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
  $("btnSupervisorLogout")?.addEventListener("click", logout);

  if (user && localStorage.getItem(SESSION_TOKEN_KEY)) {
    showMain();
    if (isSupervisorPortal()) {
      loadSupervisorClosures();
    } else {
    const cached = JSON.parse(localStorage.getItem(RESOLVER_STATE_SNAPSHOT_KEY) || "null");
    if (cached?.saved_at && Date.now() - Number(cached.saved_at) < 12 * 60 * 60 * 1000) {
      cached.tickets = (cached.tickets || []).filter((ticket) => !isTerminalTicket(ticket));
      stateCache = cached;
      void overlayPendingResolverStates(stateCache)
        .then((pendingOverlay) => {
          if (pendingOverlay.status) {
            currentStatus = pendingOverlay.status;
            updateStatusPill(currentStatus);
          }
        })
        .catch((error) => console.warn("[OFFLINE] no se pudo aplicar la cola al inicio", error))
        .finally(() => {
          syncFieldInspectionLauncher();
          renderTickets();
        });
    }
      loadState();
      if (currentStatus !== "OFFLINE") {
        updateGps(currentStatus).catch(() => null);
        startGpsHeartbeat();
      }
    }
    startPolling();
  } else if (user) {
    user = null;
    localStorage.removeItem(USER_STORAGE_KEY);
  }
}

init();

window.addEventListener("online", () => {
  void renderResolverConnectivity();
  void syncResolverOutbox();
});
window.addEventListener("offline", () => void renderResolverConnectivity());
setInterval(() => void syncResolverOutbox(), 15000);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch((error) => console.warn("[PWA]", error));
  });
}
