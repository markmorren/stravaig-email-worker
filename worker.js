// Stravaig email-to-task Worker.
//
// Cloudflare Email Routing delivers mail for a custom address to this Worker;
// the Worker turns the message into a Stravaig task and appends it to the same
// D1 document the app reads. Stravaig picks it up on its next 30-second poll.
//
// No dependencies on purpose: it deploys by pasting into the Workers dashboard,
// with no build step or local toolchain (matches the rest of the Stravaig setup).
//
// Deploy / bindings (all in the dashboard, see README.md):
//   - D1 binding  DB  -> database "stravaig"
//   - Plain var   ALLOWED_SENDERS  -> comma-separated from-addresses allowed to
//                 create tasks, e.g. "mmorren@me.com,mark.morren@ea.edin.sch.uk"
//   - Optional var FORWARD_TO -> address to also forward a copy to (e.g. me.com)
//
// The routed address itself is the first gate (only mail Email Routing sends
// here reaches this code); ALLOWED_SENDERS is the second. Nothing secret lives
// in this file, so it is safe to keep in git.

export default {
  async email(message, env, ctx) {
    const from = (message.from || "").toLowerCase().trim();
    const allowed = (env.ALLOWED_SENDERS || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // If an allowlist is set, enforce it. If it is empty, refuse everything
    // rather than accept anonymous mail - failing closed is the safe default.
    if (!allowed.includes(from)) {
      message.setReject("Sender not permitted");
      return;
    }

    const subject = (message.headers.get("subject") || "").replace(/^(re|fwd|fw):\s*/i, "").trim();

    let body = "";
    try {
      const raw = await new Response(message.raw).text();
      body = extractPlainText(raw);
    } catch (e) {
      body = ""; // a task with just the subject is still useful
    }

    const task = taskFromEmail(subject, body);

    try {
      await appendTask(env.DB, task);
    } catch (e) {
      // Bounce so the sender notices it did not save, rather than failing silently.
      message.setReject("Stravaig could not save this task");
      return;
    }

    // Optional: keep a copy in a normal inbox for your own record.
    if (env.FORWARD_TO) {
      try {
        await message.forward(env.FORWARD_TO);
      } catch (e) {
        /* forwarding is best-effort */
      }
    }
  },
};

// ---- Task construction ------------------------------------------------------

// Mirrors the app's taskFromEvent shape so an emailed task renders identically.
function taskFromEmail(subject, body) {
  const title = subject || "(no subject)";
  // Date from the subject ONLY. Scanning the body caught number patterns in
  // signatures (e.g. "Business Centre 1/2") as false dates.
  const dueDate = parseDate(subject);
  const type = /\bvisit\b/i.test(title) ? "School Visit" : "Meeting";
  let notesBody = trimSignature(body);
  // If the body just echoes the subject, don't repeat it in the notes.
  if (notesBody.trim().toLowerCase() === title.trim().toLowerCase()) notesBody = "";

  return {
    id: "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    icsUid: "",
    taskType: type,
    learningCommunity: "",
    schoolName: "",
    staffContact: "",
    supportType: "",
    dueDate: dueDate,
    startTime: "",
    endTime: "",
    notes: title + (notesBody ? "\n\n" + notesBody : "") + " (from email)",
    followUpItems: "",
    followUpChecked: [],
    completed: false,
    status: "Not started",
    completedDate: null,
    updatedAt: new Date().toISOString(),
  };
}

// Cut an email body at the start of its signature / footer, so the task notes
// stay short. Truncates at the earliest of several common markers; if none are
// present the body is returned whole (just trimmed).
function trimSignature(text) {
  if (!text) return "";
  const markers = [
    /^--\s*$/im, // standard signature delimiter
    /^\s*(best wishes|kind regards|kindest regards|best regards|warm regards|regards|many thanks|thanks|thank you|cheers|yours (sincerely|faithfully))[,!.]?\s*$/im,
    /^\s*sent from my /im, // mobile signature
    /\*{5,}/, // confidentiality banner (rows of asterisks)
    /\[cid:/i, // inline-image references
    /this email (and files transmitted|is confidential)/i, // council/corporate footer
  ];
  let cut = text.length;
  for (const re of markers) {
    const m = text.match(re);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

// Find a date in text -> "YYYY-MM-DD", or "" if none.
// Understands: 2026-08-20, 20/08/2026, 20/08, today, tomorrow.
function parseDate(text) {
  if (!text) return "";
  const t = text.toLowerCase();

  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const uk = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (uk) {
    const d = uk[1].padStart(2, "0");
    const m = uk[2].padStart(2, "0");
    let y = uk[3] || String(new Date().getFullYear());
    if (y.length === 2) y = "20" + y;
    return `${y}-${m}-${d}`;
  }

  const now = new Date();
  if (/\btoday\b/.test(t)) return isoDay(now);
  if (/\btomorrow\b/.test(t)) return isoDay(new Date(now.getTime() + 86400000));

  return "";
}

function isoDay(d) {
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

// ---- D1 read-modify-write ---------------------------------------------------

// The whole app state is one JSON document in row id=1; appending a task means
// parsing it, pushing to doc.tasks, and writing the whole thing back so every
// other key (settings, mileageLogs, archives, notifications) is preserved.
async function appendTask(db, task) {
  const row = await db.prepare("SELECT doc FROM state WHERE id = 1").first();
  const now = Date.now();

  let doc = {};
  if (row && row.doc) {
    try {
      doc = JSON.parse(row.doc);
    } catch (e) {
      doc = {};
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) doc = {};
  doc.tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  doc.tasks.push(task);

  const json = JSON.stringify(doc);
  if (row) {
    await db.prepare("UPDATE state SET doc = ?, updated_at = ? WHERE id = 1").bind(json, now).run();
  } else {
    await db
      .prepare("INSERT INTO state (id, doc, created_at, updated_at) VALUES (1, ?, ?, ?)")
      .bind(json, now, now)
      .run();
  }
}

// ---- Minimal MIME body extraction ------------------------------------------
// Best-effort, not RFC-complete: enough for forwarded mail from Apple Mail,
// Outlook and Gmail. Prefers text/plain; falls back to stripped text/html.

const MAX_BODY = 4000; // keep the D1 doc from bloating on long threads

function extractPlainText(raw) {
  const text = parseEntity(raw);
  return cleanup(text).slice(0, MAX_BODY);
}

function parseEntity(entity) {
  const { headers, body } = splitHeadersBody(entity);
  const ct = (headers["content-type"] || "text/plain").toLowerCase();
  const cte = (headers["content-transfer-encoding"] || "7bit").toLowerCase();

  if (ct.startsWith("multipart/")) {
    const boundary = getBoundary(headers["content-type"]);
    if (!boundary) return "";
    const parts = splitMultipart(body, boundary);
    let plain = "";
    let html = "";
    for (const part of parts) {
      const ph = splitHeadersBody(part);
      const pct = (ph.headers["content-type"] || "").toLowerCase();
      if (pct.startsWith("multipart/")) {
        const inner = parseEntity(part);
        if (inner && !plain) plain = inner;
      } else if (pct.startsWith("text/plain")) {
        if (!plain) plain = parseEntity(part);
      } else if (pct.startsWith("text/html")) {
        if (!html) html = parseEntity(part);
      }
    }
    return plain || html;
  }

  let decoded = decodeCTE(cte, body);
  if (ct.startsWith("text/html")) decoded = stripHtml(decoded);
  return decoded;
}

function splitHeadersBody(entity) {
  const idx = entity.search(/\r?\n\r?\n/);
  let head = idx === -1 ? entity : entity.slice(0, idx);
  const body = idx === -1 ? "" : entity.slice(idx).replace(/^\r?\n\r?\n/, "");

  // Unfold folded header lines (continuation lines start with whitespace).
  head = head.replace(/\r?\n[ \t]+/g, " ");
  const headers = {};
  head.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase().trim()] = m[2].trim();
  });
  return { headers, body };
}

function getBoundary(contentType) {
  if (!contentType) return "";
  const m = contentType.match(/boundary\s*=\s*"([^"]+)"/i) || contentType.match(/boundary\s*=\s*([^;\s]+)/i);
  return m ? m[1] : "";
}

function splitMultipart(body, boundary) {
  const marker = "--" + boundary;
  const chunks = body.split(marker);
  // drop the preamble (before first marker) and the closing "--" epilogue
  return chunks
    .slice(1)
    .filter((c) => c.trim() !== "" && c.trim() !== "--")
    .map((c) => c.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
}

function decodeCTE(cte, body) {
  if (cte === "base64") {
    try {
      const clean = body.replace(/\s+/g, "");
      const bin = atob(clean);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
      return body;
    }
  }
  if (cte === "quoted-printable") return decodeQP(body);
  return body;
}

function decodeQP(s) {
  s = s.replace(/=\r?\n/g, ""); // soft line breaks
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
      bytes.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(s.charCodeAt(i) & 0xff);
    }
  }
  try {
    return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
  } catch (e) {
    return s;
  }
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function cleanup(text) {
  return (text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
