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

let currentUser = null;
let currentLocation = null;
let currentStatus = localStorage.getItem("resolver_status") || "AVAILABLE";
let refreshTimer = null;
let locationTimer = null;

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

    if (ticket.latitude && ticket.longitude) {
      addButton(actions, "Ver mapa", "secondary", () => {
        window.open(`https://maps.google.com/?q=${ticket.latitude},${ticket.longitude}`, "_blank");
      });
    }
  });
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
