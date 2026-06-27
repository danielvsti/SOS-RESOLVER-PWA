const API = localStorage.getItem("resolver_api_url") || "https://sos.vsti.cl";
const GPS_TIMEOUT_MS = 9000;
const POLL_MS = 10000;

const $ = (id) => document.getElementById(id);
let user = JSON.parse(localStorage.getItem("resolver_user") || "null");
let currentStatus = "OFFLINE";
let currentPosition = null;
let activeTab = "assigned";
let stateCache = null;
let pollTimer = null;
let ticketMap = null;

const STATUS_LABELS = {
  AVAILABLE: "Disponible",
  BUSY: "Ocupado",
  EN_ROUTE: "En camino",
  ON_SITE: "En sitio",
  OFFLINE: "Fuera de turno"
};

const TERMINAL_STATES = ["CLOSED", "CANCELLED", "RESOLVED"];

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function api(path, options = {}) {
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  }).then(async (r) => {
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { status: "error", message: text }; }
    if (!r.ok) {
      const err = new Error(data.message || `HTTP ${r.status}`);
      err.data = data;
      throw err;
    }
    return data;
  });
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS no disponible"));
    const timer = setTimeout(() => reject(new Error("GPS demoró demasiado")), GPS_TIMEOUT_MS + 1200);
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(timer); resolve(pos); },
      (err) => { clearTimeout(timer); reject(new Error(err.message || "No se pudo obtener GPS")); },
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 15000 }
    );
  });
}

async function updateGps(status = currentStatus || "AVAILABLE") {
  if (!user) return;
  try {
    const pos = await getLocation();
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
        status
      })
    });
    currentStatus = resp.effective_status || status;
    $("gpsText").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} · precisión ${Math.round(accuracy)} m`;
    updateStatusPill(currentStatus);
    return resp;
  } catch (e) {
    $("gpsText").textContent = `GPS pendiente: ${e.message}`;
    throw e;
  }
}

function updateStatusPill(status) {
  const pill = $("statusPill");
  const normalized = String(status || "OFFLINE").toUpperCase();
  pill.textContent = STATUS_LABELS[normalized] || normalized;
  pill.className = `status-pill ${normalized.toLowerCase()}`;
}

async function setStatus(status) {
  try {
    currentStatus = status;
    updateStatusPill(status);
    await updateGps(status);
    if (status === "OFFLINE") {
      toast("Saliste de turno");
    } else {
      toast(`Estado: ${STATUS_LABELS[status] || status}`);
    }
    await loadState();
  } catch (e) {
    toast(e.message);
  }
}

async function reconcileStatus() {
  if (!user) return null;
  try {
    const resp = await api(`/resolvers/${user.id}/reconcile-status`, {
      method: "POST",
      body: JSON.stringify({})
    });
    if (resp.reconciled) {
      $("reconcileBox").classList.remove("hidden");
      currentStatus = resp.new_status || "AVAILABLE";
      updateStatusPill(currentStatus);
      setTimeout(() => $("reconcileBox").classList.add("hidden"), 5500);
    }
    return resp;
  } catch (e) {
    console.warn("reconcile failed", e.message);
    return null;
  }
}

function ticketAge(ticket) {
  const ts = new Date(ticket.created_at).getTime();
  if (!Number.isFinite(ts)) return "";
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins} min`;
  return `${Math.round(mins / 60)} h`;
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

  list.innerHTML = source.map((t) => ticketCard(t)).join("");
  list.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleTicketAction(btn.dataset.action, btn.dataset.id));
  });
}

function alertBadgeClass(t) {
  const a = String(t.alert_type || "").toLowerCase();
  if (a.includes("medical")) return "medical";
  if (a.includes("fire") || a.includes("incend")) return "fire";
  if (a.includes("vif") || a.includes("silent")) return "vif";
  if (a.includes("security") || a.includes("seg")) return "security";
  return "";
}

function ticketCard(t) {
  const pending = isPendingForMe(t);
  const assigned = isAssignedToMe(t);
  const available = isAvailableTicket(t);
  const title = t.title || t.alert_type || "Emergencia";
  const meta = `${t.citizen_name || "Vecino"} · ${ticketAge(t)} · ${t.state || "ACTIVE"}`;
  let actions = "";
  if (pending) {
    actions = `
      <button class="primary" data-action="accept" data-id="${t.id}">Aceptar</button>
      <button class="secondary" data-action="reject" data-id="${t.id}">Rechazar</button>`;
  } else if (assigned) {
    actions = `
      <button class="secondary" data-action="detail" data-id="${t.id}">Ver detalle</button>
      ${t.state === "ACCEPTED_BY_RESOLVER" ? `<button class="primary" data-action="en-route" data-id="${t.id}">Voy en camino</button>` : ""}
      ${t.state === "EN_ROUTE" ? `<button class="primary" data-action="on-site" data-id="${t.id}">Llegué al lugar</button>` : ""}
      ${["ON_SITE", "EN_ROUTE", "ACCEPTED_BY_RESOLVER"].includes(t.state) ? `<button class="control available full" data-action="resolve" data-id="${t.id}">Resolver caso</button>` : ""}`;
  } else if (available) {
    actions = `
      <button class="secondary" data-action="detail" data-id="${t.id}">Ver detalle</button>
      <button class="primary" data-action="take" data-id="${t.id}">Tomar caso</button>`;
  }

  return `
    <article class="ticket-card">
      <div class="ticket-head">
        <div>
          <h3 class="ticket-title">${escapeHtml(title)}</h3>
          <p class="ticket-meta">${escapeHtml(meta)}</p>
        </div>
        <span class="badge ${alertBadgeClass(t)}">${escapeHtml(t.alert_type || "SOS")}</span>
      </div>
      <div class="actions">${actions}</div>
    </article>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
}

function findTicket(id) {
  return (stateCache?.tickets || []).find((t) => t.id === id);
}

async function handleTicketAction(action, id) {
  const t = findTicket(id);
  if (!t) return;
  try {
    if (action === "detail") return showTicketDetail(t);
    if (action === "accept") await api(`/tickets/${id}/accept`, { method:"POST", body:JSON.stringify({ resolver_user_id:user.id }) });
    if (action === "reject") {
      const reason = prompt("Motivo del rechazo", "No puedo tomarlo en este momento") || "";
      await api(`/tickets/${id}/reject`, { method:"POST", body:JSON.stringify({ resolver_user_id:user.id, reject_reason:reason }) });
    }
    if (action === "take") await api(`/tickets/${id}/take`, { method:"POST", body:JSON.stringify({ resolver_user_id:user.id }) });
    if (action === "en-route") await api(`/tickets/${id}/en-route`, { method:"POST", body:JSON.stringify({ resolver_user_id:user.id }) });
    if (action === "on-site") await api(`/tickets/${id}/on-site`, { method:"POST", body:JSON.stringify({ resolver_user_id:user.id }) });
    if (action === "resolve") {
      const notes = prompt("Notas de resolución", "Caso atendido en terreno") || "";
      await api(`/tickets/${id}/resolve`, { method:"POST", body:JSON.stringify({ resolver_user_id:user.id, resolution_notes:notes }) });
    }
    toast("Acción registrada");
    await loadState();
  } catch (e) {
    toast(e.message);
  }
}

function showTicketDetail(t) {
  const lat = Number(t.latitude), lon = Number(t.longitude);
  $("modalContent").innerHTML = `
    <h2>${escapeHtml(t.title || "Emergencia")}</h2>
    <p><strong>Tipo:</strong> ${escapeHtml(t.alert_type || "SOS")}</p>
    <p><strong>Estado:</strong> ${escapeHtml(t.state || "ACTIVE")}</p>
    <p><strong>Vecino:</strong> ${escapeHtml(t.citizen_name || "No informado")}</p>
    <p><strong>Descripción:</strong> ${escapeHtml(t.description || "Sin descripción")}</p>
    <p><strong>Ubicación:</strong> ${Number.isFinite(lat) ? lat.toFixed(5) : "—"}, ${Number.isFinite(lon) ? lon.toFixed(5) : "—"}</p>
  `;
  const mapEl = $("ticketMap");
  if (Number.isFinite(lat) && Number.isFinite(lon) && window.L) {
    mapEl.classList.remove("hidden");
    setTimeout(() => {
      if (ticketMap) ticketMap.remove();
      ticketMap = L.map("ticketMap").setView([lat, lon], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(ticketMap);
      L.marker([lat, lon]).addTo(ticketMap).bindPopup("Evento").openPopup();
      if (currentPosition) {
        const my = [currentPosition.coords.latitude, currentPosition.coords.longitude];
        L.circleMarker(my, { radius: 7 }).addTo(ticketMap).bindPopup("Mi ubicación");
        L.polyline([my, [lat, lon]], { weight: 4, opacity: .6 }).addTo(ticketMap);
      }
      ticketMap.invalidateSize();
    }, 150);
  } else {
    mapEl.classList.add("hidden");
  }
  $("ticketModal").classList.remove("hidden");
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
    currentStatus = data.location?.status || data.reconciliation?.new_status || "OFFLINE";
    updateStatusPill(currentStatus);
    if (data.location?.latitude && data.location?.longitude) {
      $("gpsText").textContent = `${Number(data.location.latitude).toFixed(5)}, ${Number(data.location.longitude).toFixed(5)} · ${new Date(data.location.updated_at).toLocaleTimeString()}`;
    }
    if (data.reconciliation?.reconciled) {
      $("reconcileBox").classList.remove("hidden");
      setTimeout(() => $("reconcileBox").classList.add("hidden"), 5500);
    }
    renderTickets();
  } catch (e) {
    toast(e.message);
  }
}

async function login() {
  const phone = $("phoneInput").value.trim();
  $("loginMsg").textContent = "";
  try {
    const resp = await api("/auth/login-demo", { method:"POST", body:JSON.stringify({ phone }) });
    if (resp.user.role !== "RESOLVER") throw new Error("Este usuario no tiene rol RESOLVER");
    user = resp.user;
    localStorage.setItem("resolver_user", JSON.stringify(user));
    showMain();
    await updateGps("AVAILABLE").catch(() => null);
    await reconcileStatus();
    await loadState();
    startPolling();
  } catch (e) {
    $("loginMsg").textContent = e.message;
  }
}

function showMain() {
  $("loginView").classList.add("hidden");
  $("mainView").classList.remove("hidden");
  $("btnSettings").classList.remove("hidden");
  $("resolverName").textContent = user?.full_name || "Resolutor";
  $("resolverCenter").textContent = user?.control_center_name || "Centro de control";
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
  $("btnUpdateGps").addEventListener("click", () => updateGps(currentStatus).then(() => toast("GPS actualizado")).catch((e)=>toast(e.message)));
  $("btnCloseModal").addEventListener("click", () => $("ticketModal").classList.add("hidden"));
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    renderTickets();
  }));
  $("btnSettings").addEventListener("click", () => {
    const newApi = prompt("URL API", API);
    if (newApi && newApi !== API) {
      localStorage.setItem("resolver_api_url", newApi.replace(/\/$/, ""));
      location.reload();
    }
  });
  if (user) {
    showMain();
    loadState();
    updateGps(currentStatus).catch(() => null);
    startPolling();
  }
}

init();
