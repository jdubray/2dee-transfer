// 2dee transfer — single-page client. No framework, no build step.

const card = document.getElementById("card");
const logoutBtn = document.getElementById("logout");
const veil = document.getElementById("dropveil");
const veilName = document.getElementById("dropveil-name");
const toastEl = document.getElementById("toast");

const state = {
  session: null, // { authenticated, maxFileBytes, chunkBytes }
  workspace: null, // current workspace object when on /w/:id
  files: [],
  queue: [], // upload items
  active: 0,
};

const PARALLEL_UPLOADS = 2;

// ---------- tiny helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const icons = {
  download:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  retry:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v5h5"/></svg>',
};

function icon(name) {
  return h("span", { "aria-hidden": "true", html: icons[name] });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function relative(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const units = [
    ["day", 86400e3],
    ["hour", 3600e3],
    ["minute", 60e3],
  ];
  const fmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (abs >= size || unit === "minute") return fmt.format(Math.round(diff / size), unit);
  }
}

function expiryText(ws) {
  return ws.expiresAt ? `expires ${relative(ws.expiresAt)}` : "never expires";
}

function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1) : "file";
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3200);
}

class ApiError extends Error {
  constructor(status, data) {
    super((data && data.error) || `Request failed (${status})`);
    this.status = status;
    this.data = data || {};
  }
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && path !== "/api/login") {
    state.session = { ...(state.session || {}), authenticated: false };
    render();
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Two-click confirm on a button: first click arms it, second within 4s fires. */
function armable(btn, label, onConfirm) {
  let armed = false;
  let timer;
  const original = btn.innerHTML;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    if (!armed) {
      armed = true;
      btn.classList.add("armed");
      btn.textContent = label;
      timer = setTimeout(() => {
        armed = false;
        btn.classList.remove("armed");
        btn.innerHTML = original;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    onConfirm();
  });
  return btn;
}

function uploaderName() {
  try {
    return localStorage.getItem("t2.uploader") || "";
  } catch {
    return "";
  }
}

function setUploaderName(v) {
  try {
    localStorage.setItem("t2.uploader", v);
  } catch {}
}

// ---------- routing ----------

function navigate(path) {
  if (location.pathname !== path) history.pushState(null, "", path);
  render();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});

window.addEventListener("popstate", render);

function setCard(...children) {
  card.replaceChildren(...children);
}

async function render() {
  if (!state.session) {
    try {
      state.session = await api("/api/session");
    } catch {
      setCard(h("div", { class: "loading" }, "Can't reach the server. Try again in a moment."));
      return;
    }
  }
  logoutBtn.hidden = !state.session.authenticated;
  if (!state.session.authenticated) return renderLogin();

  const m = location.pathname.match(/^\/w\/([a-z0-9]+)$/);
  if (m) return renderWorkspace(m[1]);
  state.workspace = null;
  return renderHome();
}

logoutBtn.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  state.session = { ...state.session, authenticated: false };
  render();
});

// ---------- login ----------

function renderLogin() {
  wsViews = null;
  const err = h("p", { class: "error-text" });
  const input = h("input", {
    class: "field",
    type: "password",
    name: "code",
    placeholder: "Access code",
    autocomplete: "current-password",
    required: true,
    "aria-label": "Access code",
  });
  const btn = h("button", { class: "btn btn-primary btn-block", type: "submit" }, "Come on in");
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        err.textContent = "";
        try {
          await api("/api/login", { method: "POST", body: { code: input.value } });
          state.session = await api("/api/session");
          render();
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
          input.select();
        }
      },
    },
    input,
    btn,
    err,
  );
  setCard(
    h(
      "div",
      { class: "card-body" },
      h("h2", {}, "Hey, friend 👋"),
      h("p", { class: "muted mb-18" }, "This is a private space. Enter the access code to continue."),
      form,
    ),
  );
  input.focus();
}

// ---------- home: workspaces ----------

async function renderHome() {
  wsViews = null;
  document.title = "2dee transfer";
  const list = h("ul", { class: "list" }, h("li", { class: "empty" }, "Loading workspaces…"));
  const err = h("p", { class: "error-text" });
  const name = h("input", {
    class: "field grow",
    name: "name",
    placeholder: "Name a new workspace",
    maxlength: "80",
    required: true,
    "aria-label": "Workspace name",
  });
  const expiry = h(
    "select",
    { class: "field w-auto", name: "expiry", "aria-label": "Expires after" },
    h("option", { value: "1" }, "1 day"),
    h("option", { value: "7" }, "7 days"),
    h("option", { value: "30", selected: true }, "30 days"),
    h("option", { value: "90" }, "90 days"),
    h("option", { value: "never" }, "Never"),
  );
  const create = h("button", { class: "btn btn-primary btn-block", type: "submit" }, "Create workspace");
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e) => {
        e.preventDefault();
        create.disabled = true;
        err.textContent = "";
        try {
          const v = expiry.value;
          const { workspace } = await api("/api/workspaces", {
            method: "POST",
            body: { name: name.value, expiresInDays: v === "never" ? null : Number(v) },
          });
          navigate(`/w/${workspace.id}`);
        } catch (ex) {
          err.textContent = ex.message;
          create.disabled = false;
        }
      },
    },
    h("div", { class: "row" }, name, expiry),
    create,
    err,
  );

  setCard(
    h(
      "div",
      { class: "card-body" },
      h("h2", {}, "Workspaces"),
      h("p", { class: "muted" }, "Each workspace is a shared folder with its own link. Files up to 100 MB each."),
      h("div", { class: "mt-18" }, form),
      h("div", { class: "section-title" }, "Recent"),
      h("div", { class: "scroll" }, list),
    ),
  );

  try {
    const { workspaces } = await api("/api/workspaces");
    if (workspaces.length === 0) {
      list.replaceChildren(h("li", { class: "empty" }, "No workspaces yet — create the first one above."));
      return;
    }
    list.replaceChildren(
      ...workspaces.map((w) =>
        h(
          "li",
          {},
          h("div", { class: "file-icon ws-icon" }, (w.name.trim()[0] || "•").toUpperCase()),
          h(
            "div",
            { class: "meta" },
            h("a", { class: "name", href: `/w/${w.id}`, "data-link": true }, w.name),
            h(
              "div",
              { class: "sub" },
              `${w.fileCount} file${w.fileCount === 1 ? "" : "s"} · ${formatBytes(w.totalBytes)} · ${expiryText(w)}`,
            ),
          ),
        ),
      ),
    );
  } catch (ex) {
    list.replaceChildren(h("li", { class: "empty" }, ex.message));
  }
}

// ---------- workspace ----------

let wsViews = null; // live DOM handles for the open workspace

async function renderWorkspace(id) {
  if (!state.workspace || state.workspace.id !== id) {
    setCard(h("div", { class: "loading" }, "Opening workspace…"));
    try {
      const data = await api(`/api/workspaces/${id}`);
      state.workspace = data.workspace;
      state.files = data.files;
    } catch (ex) {
      setCard(
        h(
          "div",
          { class: "card-body" },
          h("h2", {}, "Hmm."),
          h("p", { class: "muted" }, ex.message),
          h("p", {}, h("a", { class: "btn btn-soft mt-16", href: "/", "data-link": true }, "Back to workspaces")),
        ),
      );
      return;
    }
  }
  const ws = state.workspace;
  document.title = `${ws.name} · 2dee transfer`;
  veilName.textContent = ws.name;

  const picker = h("input", {
    type: "file",
    multiple: true,
    class: "sr-only",
    tabindex: "-1",
    onchange: () => {
      addFiles(picker.files);
      picker.value = "";
    },
  });

  const zone = h(
    "button",
    { class: "dropzone", type: "button", onclick: () => picker.click() },
    h("div", { class: "plus", "aria-hidden": "true" }),
    h(
      "div",
      {},
      h("strong", {}, "Add files"),
      h("span", { class: "faint" }, `Drop them here or click · up to ${formatBytes(state.session.maxFileBytes)} each`),
    ),
  );

  const who = h("input", {
    value: uploaderName(),
    placeholder: "your name (optional)",
    maxlength: "40",
    "aria-label": "Your name",
    oninput: (e) => setUploaderName(e.target.value.trim()),
  });

  const queueList = h("ul", { class: "list" });
  const fileList = h("ul", { class: "list" });
  const summary = h("p", { class: "muted" });
  const title = h("h2", {}, ws.name);

  const zipBtn = h("a", { class: "btn btn-primary", href: `/api/workspaces/${ws.id}/zip`, download: "" }, icon("download"), "Download all");
  const copyBtn = h(
    "button",
    {
      class: "btn btn-soft",
      type: "button",
      onclick: async () => {
        const link = `${location.origin}/w/${ws.id}`;
        try {
          await navigator.clipboard.writeText(link);
          toast("Link copied — friends will need the access code too.");
        } catch {
          prompt("Copy this link:", link);
        }
      },
    },
    "Copy link",
  );

  // settings: rename, expiry, delete
  const renameInput = h("input", { class: "field grow", value: ws.name, maxlength: "80", "aria-label": "Workspace name" });
  const expirySel = h(
    "select",
    { class: "field w-auto", "aria-label": "Expiry" },
    h("option", { value: "" }, ws.expiresAt ? `Keep (${expiryText(ws)})` : "Keep (never expires)"),
    h("option", { value: "1" }, "1 day from now"),
    h("option", { value: "7" }, "7 days from now"),
    h("option", { value: "30" }, "30 days from now"),
    h("option", { value: "90" }, "90 days from now"),
    h("option", { value: "never" }, "Never expire"),
  );
  const settingsErr = h("p", { class: "error-text" });
  const saveBtn = h(
    "button",
    {
      class: "btn btn-soft btn-small",
      type: "button",
      onclick: async () => {
        settingsErr.textContent = "";
        const body = { name: renameInput.value };
        if (expirySel.value) body.expiresInDays = expirySel.value === "never" ? null : Number(expirySel.value);
        try {
          const { workspace } = await api(`/api/workspaces/${ws.id}`, { method: "PATCH", body });
          state.workspace = workspace;
          toast("Saved.");
          render();
        } catch (ex) {
          settingsErr.textContent = ex.message;
        }
      },
    },
    "Save",
  );
  const deleteBtn = armable(
    h("button", { class: "btn btn-danger btn-small", type: "button" }, "Delete workspace"),
    "Click again to delete everything",
    async () => {
      try {
        await api(`/api/workspaces/${ws.id}`, { method: "DELETE" });
        state.workspace = null;
        toast("Workspace deleted.");
        navigate("/");
      } catch (ex) {
        settingsErr.textContent = ex.message;
      }
    },
  );

  const settings = h(
    "details",
    { class: "settings" },
    h("summary", {}, "Workspace settings"),
    h(
      "div",
      { class: "stack" },
      h("div", { class: "row" }, renameInput, expirySel),
      h("div", { class: "row between" }, saveBtn, deleteBtn),
      settingsErr,
    ),
  );

  setCard(
    h(
      "div",
      { class: "card-body" },
      h("a", { class: "linkish", href: "/", "data-link": true }, "← All workspaces"),
      h("div", { class: "mt-12" }, title, summary),
      zone,
      picker,
      h("label", { class: "uploader-line" }, "Uploading as", who),
      h("div", { class: "scroll mt-10" }, queueList, fileList),
      settings,
    ),
    h("div", { class: "card-foot" }, zipBtn, copyBtn),
  );

  wsViews = { queueList, fileList, summary, zipBtn, wsId: ws.id };
  drawQueue();
  drawFiles();
}

function drawFiles() {
  if (!wsViews) return;
  const { fileList, summary, zipBtn } = wsViews;
  const files = state.files;
  const total = files.reduce((s, f) => s + f.size, 0);
  summary.textContent = `${files.length} file${files.length === 1 ? "" : "s"} · ${formatBytes(total)} · ${expiryText(state.workspace)}`;
  zipBtn.hidden = files.length === 0;

  if (files.length === 0 && !state.queue.some((q) => q.wsId === wsViews.wsId)) {
    fileList.replaceChildren(h("li", { class: "empty" }, "Nothing here yet. Add the first file."));
    return;
  }
  fileList.replaceChildren(
    ...files
      .slice()
      .reverse()
      .map((f) => {
        const del = armable(
          h("button", { class: "icon-btn", type: "button", title: "Delete file", "aria-label": `Delete ${f.name}` }, icon("trash")),
          "Delete?",
          async () => {
            try {
              await api(`/api/files/${f.id}`, { method: "DELETE" });
              state.files = state.files.filter((x) => x.id !== f.id);
              drawFiles();
            } catch (ex) {
              toast(ex.message);
            }
          },
        );
        const when = new Date(f.createdAt).toLocaleDateString("en", { month: "short", day: "numeric" });
        return h(
          "li",
          {},
          h("div", { class: "file-icon" }, extOf(f.name)),
          h(
            "div",
            { class: "meta" },
            h("a", { class: "name", href: `/api/files/${f.id}/download`, download: "", title: f.name }, f.name),
            h("div", { class: "sub" }, [formatBytes(f.size), f.uploader && `from ${f.uploader}`, when].filter(Boolean).join(" · ")),
          ),
          h(
            "a",
            { class: "icon-btn", href: `/api/files/${f.id}/download`, download: "", title: "Download", "aria-label": `Download ${f.name}` },
            icon("download"),
          ),
          del,
        );
      }),
  );
}

// ---------- uploads ----------

function addFiles(fileList) {
  if (!state.workspace) return;
  for (const file of Array.from(fileList)) {
    const item = {
      id: Math.random().toString(36).slice(2),
      wsId: state.workspace.id,
      file,
      status: "queued", // queued | uploading | done | failed | cancelled
      sent: 0,
      error: "",
      uploadId: null,
      xhr: null,
    };
    if (file.size > state.session.maxFileBytes) {
      item.status = "failed";
      item.error = `Too big — the limit is ${formatBytes(state.session.maxFileBytes)}`;
    }
    state.queue.push(item);
  }
  drawQueue();
  pump();
}

function pump() {
  while (state.active < PARALLEL_UPLOADS) {
    const next = state.queue.find((q) => q.status === "queued");
    if (!next) break;
    state.active++;
    next.status = "uploading";
    runUpload(next).finally(() => {
      state.active--;
      pump();
    });
  }
  drawQueue();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendChunk(item, offset, blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open("PATCH", `/api/uploads/${item.uploadId}`);
    xhr.setRequestHeader("Upload-Offset", String(offset));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      item.sent = offset + e.loaded;
      drawItem(item);
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError(0, { error: "Network hiccup" }));
    xhr.onabort = () => reject(new ApiError(-1, { error: "Cancelled" }));
    xhr.send(blob);
  });
}

async function runUpload(item) {
  const { file } = item;
  try {
    const init = await api(`/api/workspaces/${item.wsId}/uploads`, {
      method: "POST",
      body: { name: file.name, size: file.size, type: file.type, uploader: uploaderName() },
    });
    if (init.complete) return finish(item, init.file);
    item.uploadId = init.uploadId;
    const chunk = init.chunkBytes;
    let offset = init.offset;
    let failures = 0;

    while (true) {
      if (item.status === "cancelled") return;
      try {
        const res = await sendChunk(item, offset, file.slice(offset, Math.min(offset + chunk, file.size)));
        failures = 0;
        offset = res.offset;
        item.sent = offset;
        if (res.complete) return finish(item, res.file);
      } catch (ex) {
        if (item.status === "cancelled") return;
        if (ex.status === 409 && typeof ex.data.offset === "number") {
          offset = ex.data.offset; // server tells us where to resume
          await sleep(300);
          continue;
        }
        const retriable = ex.status === 0 || ex.status >= 500 || ex.status === 408 || ex.status === 429;
        if (!retriable || ++failures > 6) throw ex;
        item.error = `Connection trouble — retrying (${failures}/6)…`;
        drawItem(item);
        await sleep(Math.min(15000, 800 * 2 ** failures));
        try {
          const status = await api(`/api/uploads/${item.uploadId}`);
          offset = status.offset;
        } catch (e2) {
          if (e2.status === 404) throw e2;
        }
        item.error = "";
      }
    }
  } catch (ex) {
    if (item.status === "cancelled") return;
    item.status = "failed";
    item.error = ex.message;
    drawItem(item);
  }
}

function finish(item, file) {
  item.status = "done";
  item.sent = item.file.size;
  if (state.workspace && state.workspace.id === item.wsId && !state.files.some((f) => f.id === file.id)) {
    state.files.push(file);
  }
  // Completed items fold into the file list.
  state.queue = state.queue.filter((q) => q !== item);
  drawQueue();
  drawFiles();
}

function cancel(item) {
  const wasActive = item.status === "uploading";
  item.status = "cancelled";
  item.xhr?.abort();
  if (item.uploadId) api(`/api/uploads/${item.uploadId}`, { method: "DELETE" }).catch(() => {});
  state.queue = state.queue.filter((q) => q !== item);
  if (!wasActive) drawQueue();
  drawFiles();
}

function retry(item) {
  item.status = "queued";
  item.error = "";
  item.sent = 0;
  item.uploadId = null;
  pump();
}

const itemNodes = new Map();

function drawQueue() {
  if (!wsViews) return;
  const items = state.queue.filter((q) => q.wsId === wsViews.wsId);
  itemNodes.clear();
  wsViews.queueList.replaceChildren(
    ...items.map((item) => {
      const bar = h("span");
      const sub = h("div", { class: "sub" });
      const actions = [];
      if (item.status === "failed" && item.file.size <= state.session.maxFileBytes) {
        actions.push(h("button", { class: "icon-btn", type: "button", title: "Retry", onclick: () => retry(item) }, icon("retry")));
      }
      actions.push(
        h("button", { class: "icon-btn", type: "button", title: item.status === "failed" ? "Dismiss" : "Cancel", onclick: () => cancel(item) }, icon("x")),
      );
      const li = h(
        "li",
        {},
        h("div", { class: "file-icon" }, extOf(item.file.name)),
        h("div", { class: "meta" }, h("span", { class: "name", title: item.file.name }, item.file.name), sub, h("div", { class: "progress" }, bar)),
        ...actions,
      );
      itemNodes.set(item.id, { li, bar, sub });
      drawItem(item);
      return li;
    }),
  );
  if (state.files.length === 0) drawFiles();
}

function drawItem(item) {
  const n = itemNodes.get(item.id);
  if (!n) return;
  const pct = item.file.size ? Math.min(100, (item.sent / item.file.size) * 100) : 100;
  n.bar.style.width = `${pct}%`;
  n.li.className = item.status === "failed" ? "failed" : item.status === "done" ? "done" : "";
  if (item.status === "failed") n.sub.textContent = item.error;
  else if (item.status === "queued") n.sub.textContent = `${formatBytes(item.file.size)} · waiting…`;
  else n.sub.textContent = item.error || `${formatBytes(item.sent)} of ${formatBytes(item.file.size)} · ${pct.toFixed(0)}%`;
}

window.addEventListener("beforeunload", (e) => {
  if (state.queue.some((q) => q.status === "uploading" || q.status === "queued")) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---------- drag & drop anywhere on the page ----------

let dragDepth = 0;
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");

window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || !state.workspace || !wsViews) return;
  e.preventDefault();
  dragDepth++;
  veil.hidden = false;
});

window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = state.workspace ? "copy" : "none";
});

window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) veil.hidden = true;
});

window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  veil.hidden = true;
  if (state.workspace && wsViews) addFiles(e.dataTransfer.files);
});

render();
