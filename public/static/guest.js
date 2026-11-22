// Guest download page: shows one shared file and a download button. No session needed.

const card = document.getElementById("card");
const token = (location.pathname.match(/^\/d\/([a-z0-9]+)$/) || [])[1];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
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

function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1) : "file";
}

const downloadIcon =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';

function unavailable() {
  document.title = "Link unavailable · 2dee transfer";
  card.replaceChildren(
    h(
      "div",
      { class: "card-body" },
      h("h2", {}, "This link is no longer available"),
      h("p", { class: "muted" }, "It may have expired or been disabled by the sender. Ask them for a new link."),
    ),
  );
}

async function main() {
  if (!token) return unavailable();
  let meta;
  try {
    const res = await fetch(`/api/guest/${token}`);
    if (!res.ok) return unavailable();
    meta = await res.json();
  } catch {
    card.replaceChildren(h("div", { class: "loading" }, "The server is unavailable. Please try again shortly."));
    return;
  }

  document.title = `${meta.name} · 2dee transfer`;
  const details = [formatBytes(meta.size)];
  if (meta.sharedBy) details.push(`shared by ${meta.sharedBy}`);
  const until = meta.expiresAt
    ? `Available until ${new Date(meta.expiresAt).toLocaleDateString("en", { month: "long", day: "numeric", year: "numeric" })}.`
    : null;

  card.replaceChildren(
    h(
      "div",
      { class: "card-body" },
      h("p", { class: "section-title guest-kicker" }, "Shared file"),
      h(
        "div",
        { class: "guest-file" },
        h("div", { class: "file-icon guest-icon" }, extOf(meta.name)),
        h("div", { class: "meta" }, h("h2", { class: "guest-name" }, meta.name), h("p", { class: "muted" }, details.join(" · "))),
      ),
      until && h("p", { class: "faint mt-16" }, until),
    ),
    h(
      "div",
      { class: "card-foot" },
      h("a", { class: "btn btn-primary btn-block", href: `/d/${token}/download`, download: "" }, h("span", { "aria-hidden": "true", html: downloadIcon }), "Download"),
    ),
  );
}

main();
