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

    // Prefer the AI interpreter (handles forwarded emails with no labels); fall
    // back to the deterministic label/regex parser if AI is unbound or fails.
    let task = null;
    if (env.AI) {
      try {
        const fields = await aiExtract(env, subject, body, isoDay(new Date()));
        if (fields) task = taskFromAI(subject, fields);
      } catch (e) {
        task = null;
      }
    }
    if (!task) task = taskFromEmail(subject, body);

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
  const f = parseFields(trimSignature(body));

  // Explicit "Date:" label wins; otherwise fall back to a date in the subject.
  // Never scan the free body for dates - signatures ("Business Centre 1/2")
  // produce false positives.
  const dueDate = parseDate(f.date || "") || parseDate(subject);
  const { start, end } = parseTimeRange(f.time || "");
  const type = f.type || (/\bvisit\b/i.test(title) ? "School Visit" : "Meeting");

  // Notes = an explicit "Notes:" label if given, else the leftover unlabelled
  // lines. Drop it if it just repeats the subject.
  let notesBody = (f.notes || f._free || "").trim();
  if (notesBody.toLowerCase() === title.trim().toLowerCase()) notesBody = "";

  return {
    id: "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    icsUid: "",
    taskType: type,
    learningCommunity: f.lc || "",
    schoolName: f.school || "",
    staffContact: f.contact || "",
    supportType: f.support || "",
    dueDate: dueDate,
    startTime: start,
    endTime: end,
    notes: title + (notesBody ? "\n\n" + notesBody : "") + " (from email)",
    followUpItems: f.followup || "",
    followUpChecked: [],
    completed: false,
    status: "Not started",
    completedDate: null,
    updatedAt: new Date().toISOString(),
  };
}

// ---- AI interpretation (Cloudflare Workers AI) -----------------------------
// Reads a whole email (often a forwarded one, with no labels) and extracts the
// task fields. Returns a plain fields object, or null if anything goes wrong so
// the caller can fall back to the deterministic parser.

const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const TASK_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    dueDate: { type: "string" },
    startTime: { type: "string" },
    endTime: { type: "string" },
    taskType: { type: "string" },
    schoolName: { type: "string" },
    staffContact: { type: "string" },
    learningCommunity: { type: "string" },
    supportType: { type: "string" },
    followUpItems: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["title", "dueDate", "startTime", "endTime", "taskType", "notes"],
};

async function aiExtract(env, subject, body, todayISO) {
  const sys =
    "You turn an email into ONE task for a personal work tracker used by a school-improvement officer. " +
    "The email is often one they received and forwarded, so read the underlying content and IGNORE " +
    "forwarding headers, quoted reply chains, email signatures and confidentiality footers. Fill these fields:\n" +
    "- title: a short task title (a few words).\n" +
    "- dueDate: the date the task/meeting happens as YYYY-MM-DD. Today is " + todayISO +
    "; resolve relative dates (e.g. 'next Tuesday', 'tomorrow') against today. If there is no clear date, use \"\". Never invent one.\n" +
    "- startTime / endTime: 24-hour HH:MM if a time or range is stated, otherwise \"\".\n" +
    "- taskType: \"School Visit\" if it is a visit to a school, else \"Meeting\" (or a short better label if obvious).\n" +
    "- schoolName, staffContact (a person's name), learningCommunity, supportType: only if clearly present, else \"\".\n" +
    "- followUpItems: array of short action strings if any are implied, else [].\n" +
    "- notes: one or two sentences on what the task is about. No signatures or legal footers.";
  const user = "Subject: " + (subject || "(none)") + "\n\nBody:\n" + (body || "(empty)");

  const out = await env.AI.run(AI_MODEL, {
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: TASK_SCHEMA },
    temperature: 0,
    max_tokens: 512,
  });

  let data = out && out.response;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (e) { return null; }
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

// Build a task from the AI's fields, validating each so a stray value can't
// produce a malformed task. Same shape as the calendar/regex paths.
function taskFromAI(subject, d) {
  const str = (v) => (v == null ? "" : String(v).trim());
  const title = str(d.title) || str(subject) || "(no subject)";
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(str(d.dueDate)) ? str(d.dueDate) : "";
  const startTime = normHM(d.startTime);
  const endTime = normHM(d.endTime);
  const followup = Array.isArray(d.followUpItems)
    ? d.followUpItems.map(str).filter(Boolean).join("\n")
    : str(d.followUpItems);
  let notes = str(d.notes);
  if (notes.toLowerCase() === title.toLowerCase()) notes = "";

  return {
    id: "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    icsUid: "",
    taskType: str(d.taskType) || "Meeting",
    learningCommunity: str(d.learningCommunity),
    schoolName: str(d.schoolName),
    staffContact: str(d.staffContact),
    supportType: str(d.supportType),
    dueDate: dueDate,
    startTime: startTime,
    endTime: endTime,
    notes: title + (notes ? "\n\n" + notes : "") + " (from email)",
    followUpItems: followup,
    followUpChecked: [],
    completed: false,
    status: "Not started",
    completedDate: null,
    updatedAt: new Date().toISOString(),
  };
}

// Normalise a time to "HH:MM" (24h), or "" if it isn't a valid time.
function normHM(v) {
  const m = String(v == null ? "" : v).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  const h = parseInt(m[1], 10);
  if (h > 23 || parseInt(m[2], 10) > 59) return "";
  return String(h).padStart(2, "0") + ":" + m[2];
}

// Read optional "Label: value" lines out of the body and map them to task
// fields. Unknown labels and unlabelled lines are kept as free text (_free).
// Only these labels are recognised - anything else stays in the notes.
const FIELD_LABELS = {
  date: "date",
  due: "date",
  time: "time",
  when: "time",
  type: "type",
  contact: "contact",
  with: "contact",
  staff: "contact",
  school: "school",
  lc: "lc",
  community: "lc",
  "learning community": "lc",
  support: "support",
  "follow-up": "followup",
  followup: "followup",
  "follow up": "followup",
  todo: "followup",
  action: "followup",
  actions: "followup",
  notes: "notes",
  note: "notes",
};

function parseFields(body) {
  const fields = {};
  const free = [];
  for (const line of (body || "").split("\n")) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z \-]{0,20}?)\s*:\s*(.+?)\s*$/);
    const key = m ? m[1].toLowerCase().trim() : null;
    if (m && FIELD_LABELS[key]) {
      const field = FIELD_LABELS[key];
      const val = m[2].trim();
      if (field === "followup") {
        // allow "a; b; c" on one line, or several follow-up lines
        const items = val.split(/\s*;\s*/).filter(Boolean).join("\n");
        fields.followup = fields.followup ? fields.followup + "\n" + items : items;
      } else if (field === "notes") {
        fields.notes = fields.notes ? fields.notes + "\n" + val : val;
      } else {
        fields[field] = val; // last one wins for single-value fields
      }
    } else {
      free.push(line);
    }
  }
  fields._free = free.join("\n").trim();
  return fields;
}

// Parse a time or time range -> { start, end } as "HH:MM" (24h). Handles
// "9:30-10:30", "09:00 to 10:00", "9am-10:30am", "2pm". A bare number with no
// colon or am/pm is ignored, so dates like "20 Aug" are never read as a time.
function parseTimeRange(text) {
  if (!text) return { start: "", end: "" };
  const toks = [...text.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi)].filter(
    (m) => m[2] !== undefined || m[3] !== undefined
  );
  if (!toks.length) return { start: "", end: "" };
  const start = to24(toks[0]);
  // if the start had no am/pm but the end did (e.g. "9-10am"), share it
  let s = start;
  if (toks[1] && !toks[0][3] && toks[1][3]) s = to24([null, toks[0][1], toks[0][2], toks[1][3]]);
  const end = toks[1] ? to24(toks[1]) : "";
  return { start: s, end };
}

function to24(m) {
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3] ? m[3].toLowerCase() : "";
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
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

// Find a date in text -> "YYYY-MM-DD", or "" if none. Understands:
// 2026-08-20, 20/08/2026, 20/08, "20 Aug[ust][ 2026]", "Aug 20[, 2026]",
// today, tomorrow, and weekday names (-> next occurrence).
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseDate(text) {
  if (!text) return "";
  const t = text.toLowerCase();
  let m;

  // ISO
  m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // "20 Aug 2026" / "20 August" / "20 Aug"
  m = t.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?\b/);
  if (m) return ymd(m[3], MONTHS[m[2]], m[1]);

  // "Aug 20 2026" / "August 20"
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/);
  if (m) return ymd(m[3], MONTHS[m[1]], m[2]);

  // dd/mm(/yyyy)
  m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) return ymd(m[3], m[2], m[1]);

  const now = new Date();
  if (/\btoday\b/.test(t)) return isoDay(now);
  if (/\btomorrow\b/.test(t)) return isoDay(new Date(now.getTime() + 86400000));

  // weekday name -> next occurrence (never today)
  m = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/);
  if (m) {
    const target = WEEKDAYS[m[1].slice(0, 3)];
    let add = (target - now.getDay() + 7) % 7;
    if (add === 0) add = 7;
    return isoDay(new Date(now.getTime() + add * 86400000));
  }

  return "";
}

// Build a YYYY-MM-DD string. If the year is missing, use the current year, or
// the next year when that date has already passed (so "20 Aug" always resolves
// to an upcoming date).
function ymd(year, month, day) {
  const mo = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (!mo || mo > 12 || !d || d > 31) return "";
  let y;
  if (year) {
    y = parseInt(year, 10);
    if (y < 100) y += 2000;
  } else {
    const now = new Date();
    y = now.getFullYear();
    const candidate = new Date(y, mo - 1, d);
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (candidate < todayMid) y += 1;
  }
  return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
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
