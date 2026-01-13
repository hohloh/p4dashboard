import express from "express";
import cors from "cors";
import { execFile, spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const CREDS_PATH = path.join(DATA_DIR, "creds.json");

const app = express();
app.use(cors());
app.use(express.json());

// ---------- file helpers ----------
async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch { }
}
async function readCreds() {
  try { return JSON.parse(await fs.readFile(CREDS_PATH, "utf8")); }
  catch { return null; }
}
async function writeCreds(creds) {
  await ensureDataDir();
  await fs.writeFile(CREDS_PATH, JSON.stringify(creds, null, 2), "utf8");
}
async function clearCreds() {
  try { await fs.unlink(CREDS_PATH); } catch { }
}

// ---------- p4 helpers ----------
function runP4(args, { server, user, ticket, client } = {}) {
  const base = [];
  if (server) base.push("-p", server);
  if (user) base.push("-u", user);
  if (client) base.push("-c", client);
  if (ticket) base.push("-P", ticket);

  return new Promise((resolve, reject) => {
    const cmd = ["p4", ...base, ...args];
    console.log("→", cmd.join(" "));
    execFile("p4", [...base, ...args], (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "").trim();
        console.error("p4 error:", msg);
        return reject(new Error(msg || "p4 failed"));
      }
      resolve(stdout);
    });
  });
}

// Establish trust with a P4 server (required for first-time SSL connections)
function p4Trust(server) {
  return new Promise((resolve, reject) => {
    console.log("→ p4 -p", server, "trust -y");
    execFile("p4", ["-p", server, "trust", "-y"], (err, stdout, stderr) => {
      if (err) {
        // Trust might already exist or server doesn't require it - that's fine
        console.log("p4 trust note:", (stderr || err.message || "").trim());
      }
      // Always resolve - trust errors shouldn't block login attempt
      resolve(stdout || "");
    });
  });
}

// password -> ticket
function p4LoginGetTicket({ server, user, password }) {
  return new Promise(async (resolve, reject) => {
    // Establish trust first (handles first-time SSL connections)
    await p4Trust(server);

    const child = spawn("p4", ["-p", server, "-u", user, "login", "-a", "-p"]);
    let out = "", err = "";
    child.stdout.on("data", d => (out += d.toString()));
    child.stderr.on("data", d => (err += d.toString()));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(err || "login failed"));
      resolve(out.trim());
    });
    child.stdin.write(password + "\n");
    child.stdin.end();
  });
}

// merge auth from saved creds; DO NOT drop non-auth fields from body
async function mergeAuth(body) {
  const saved = await readCreds();
  const merged = { ...(body || {}) };
  if (!merged.server && saved?.server) merged.server = saved.server;
  if (!merged.user && saved?.user) merged.user = saved.user;
  if (!merged.ticket && saved?.ticket &&
    saved.server === merged.server && saved.user === merged.user) {
    merged.ticket = saved.ticket;
  }
  return merged;
}

// ---------- static UI ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- creds API ----------
app.get("/api/p4/creds", async (_req, res) => {
  const c = await readCreds();
  if (!c) return res.json({ saved: false });
  res.json({ saved: true, server: c.server, user: c.user, hasTicket: !!c.ticket, savedAt: c.savedAt });
});

app.post("/api/p4/saveCreds", async (req, res) => {
  const { server, user, password, ticket } = req.body || {};
  if (!server || !user || (!password && !ticket)) {
    return res.status(400).json({ error: "server, user, and password OR ticket required" });
  }
  try {
    const finalTicket = ticket || await p4LoginGetTicket({ server, user, password });
    await writeCreds({ server, user, ticket: finalTicket, savedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/p4/clearCreds", async (_req, res) => {
  await clearCreds();
  res.json({ ok: true });
});

// ---------- business API ----------
app.post("/api/p4/workspaces", async (req, res) => {
  try {
    const merged = await mergeAuth(req.body);
    const { server, user, password, ticket } = merged;

    if (!server || !user) return res.status(400).json({ error: "Missing server or user." });

    let authTicket = ticket;
    if (!authTicket && password) authTicket = await p4LoginGetTicket({ server, user, password });
    if (!authTicket) return res.status(400).json({ error: "Missing auth. Provide a password/ticket once, or save creds first." });

    const out = await runP4(["clients", "-u", user], { server, user, ticket: authTicket });
    const workspaces = out.split("\n").map(l => l.trim()).filter(Boolean)
      .map(line => ({ name: (line.match(/^Client\s+(\S+)/) || [])[1] || line }));

    res.json({ workspaces });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// REPLACE your existing /api/p4/changes route with this one
app.post("/api/p4/changes", async (req, res) => {
  try {
    console.log("POST /api/p4/changes body:", JSON.stringify(req.body));
    const merged = await mergeAuth(req.body); // keeps client & limit intact
    const { server, user, password, ticket, client } = merged;
    const limit = merged.limit ?? 50;

    if (!client) return res.status(400).json({ error: "Missing client (workspace)." });
    if (!server || !user) return res.status(400).json({ error: "Missing server or user." });

    // Ensure auth ticket
    let authTicket = ticket;
    if (!authTicket && password) authTicket = await p4LoginGetTicket({ server, user, password });
    if (!authTicket) return res.status(400).json({ error: "Missing auth. Provide a password/ticket once, or save creds first." });

    // 1) Get ALL users' submitted changes that touch the workspace view
    const filespec = `//${client}/...`;
    const changesArgs = ["-ztag", "changes", "-m", String(limit), "-s", "submitted", filespec];
    const changesStdout = await runP4(changesArgs, { server, user, ticket: authTicket, client });

    // Parse -ztag changes
    const changeLines = changesStdout.split(/\r?\n/);
    const changes = [];
    let current = null;
    for (const line of changeLines) {
      const m = line.match(/^\.\.\.\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2];
      if (key === "change") {
        if (current) changes.push(current);
        current = { change: Number(val) };
      } else if (current) {
        if (key === "time") {
          const dt = new Date(Number(val) * 1000);
          if (!isNaN(dt.getTime())) {
            current.date = dt.toISOString().slice(0, 10);
          } else {
            // Fallback for invalid dates
            current.date = "";
          }
        } else if (key === "user") current.user = val;
        else if (key === "client") current.client = val;
        else if (key === "status") current.status = val;
      }
    }
    if (current) changes.push(current);

    if (changes.length === 0) {
      return res.json({ changes: [] });
    }

    // 2) Fetch FULL multi-line descriptions
    const ids = changes.map(c => String(c.change));
    const describeArgs = ["-ztag", "describe", "-s", ...ids];
    let descStdout = "";
    try {
      descStdout = await runP4(describeArgs, { server, user, ticket: authTicket, client });
    } catch (e) {
      // If describe fails, still return basic changes
      return res.json({ changes });
    }

    // Parse -ztag describe: multiple "... desc" lines per change => append with newlines
    const descLines = descStdout.split(/\r?\n/);
    const mapById = new Map(changes.map(c => [c.change, c]));
    let curDesc = null; // { change:number, desc:string }

    let lastTag = null;

    for (const line of descLines) {
      const m = line.match(/^\.\.\.\s+(\S+)\s*(.*)$/);
      if (!m) {
        // specific handling for multiline desc:
        // if we are inside a "desc" tag, append this line
        if (curDesc && lastTag === "desc") {
          curDesc.desc += "\n" + line;
        }
        continue;
      }

      const key = m[1];
      const val = m[2] || "";
      lastTag = key;

      if (key === "change") {
        // commit previous
        if (curDesc && mapById.has(curDesc.change)) {
          const tgt = mapById.get(curDesc.change);
          tgt.desc = (curDesc.desc || "").trim();
        }
        curDesc = { change: Number(val), desc: "" };
      } else if (curDesc && key === "desc") {
        curDesc.desc += (curDesc.desc ? "\n" : "") + val;
      }
    }
    // commit last
    if (curDesc && mapById.has(curDesc.change)) {
      const tgt = mapById.get(curDesc.change);
      tgt.desc = (curDesc.desc || "").trim();
    }

    return res.json({ changes });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});




// ---------- pending files API ----------
app.post("/api/p4/pending", async (req, res) => {
  try {
    const merged = await mergeAuth(req.body);
    const { server, user, password, ticket, client, targetUser } = merged;

    if (!server || !user) return res.status(400).json({ error: "Missing server or user." });

    let authTicket = ticket;
    if (!authTicket && password) authTicket = await p4LoginGetTicket({ server, user, password });
    if (!authTicket) return res.status(400).json({ error: "Missing auth." });

    // If client is present, we look for pending changes in that client
    // If targetUser is present, we look for opened files by that user (often -u targetUser)
    let args = ["-ztag", "opened"];
    if (client && targetUser) {
      // ROBUST APPROACH: Fetch ALL opened files in the depot paths, then filter by user
      // 1. Get client view
      const clientOut = await runP4(["-ztag", "client", "-o", client], { server, user, ticket: authTicket });
      const clientLines = clientOut.split(/\r?\n/);

      const viewPaths = [];
      for (const line of clientLines) {
        const m = line.match(/^\.\.\.\s+View\d+\s+(.*)$/);
        if (m) {
          // View line format: //depot/path/... //client/path/...
          // Or for exclusions: -//depot/path/... //client/path/...
          // We want the left side (depot path), but SKIP exclusions (starting with -)
          const parts = m[1].split(' ');
          if (parts.length > 0) {
            const depotPath = parts[0];
            // Skip exclusion mappings
            if (!depotPath.startsWith('-')) {
              viewPaths.push(depotPath);
            }
          }
        }
      }

      if (viewPaths.length === 0) {
        return res.json({ files: [] });
      }

      // 2. Fetch ALL opened files in these paths (from ALL users)
      args.push("-a"); // all clients, all users
      args.push(...viewPaths);

      console.log("DEBUG Team View: p4 opened args:", args);

      const out = await runP4(args, { server, user, ticket: authTicket });
      const lines = out.split(/\r?\n/);

      // 3. Parse results
      const allFiles = [];
      let current = null;
      for (const line of lines) {
        const m = line.match(/^\.\.\.\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const key = m[1];
        const val = m[2];

        if (key === "depotFile") {
          if (current) allFiles.push(current);
          current = { depotFile: val };
        } else if (current) {
          current[key] = val;
        }
      }
      if (current) allFiles.push(current);

      // 4. FILTER by targetUser
      const files = allFiles.filter(f => f.user === targetUser);

      console.log("DEBUG Team View: Total files:", allFiles.length, "Filtered for", targetUser + ":", files.length);

      return res.json({ files });

    } else if (client) {
      args.push("-C", client); // List files opened in specific client (current user)
    } else if (targetUser) {
      args.push("-u", targetUser); // List files opened by user everywhere
      args.push("-a");
    } else {
      args.push("-u", user);
    }

    const out = await runP4(args, { server, user, ticket: authTicket, client });
    const lines = out.split(/\r?\n/);

    // Parse -ztag opened
    const files = [];
    let current = null;
    for (const line of lines) {
      const m = line.match(/^\.\.\.\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2];

      if (key === "depotFile") {
        if (current) files.push(current);
        current = { depotFile: val };
      } else if (current) {
        current[key] = val;
      }
    }
    if (current) files.push(current);

    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/p4/users", async (req, res) => {
  try {
    const merged = await mergeAuth(req.body);
    const { server, user, password, ticket } = merged;

    if (!server || !user) return res.status(400).json({ error: "Missing server or user." });

    let authTicket = ticket;
    if (!authTicket && password) authTicket = await p4LoginGetTicket({ server, user, password });

    // We essentially just need a valid login to run 'p4 users'
    if (!authTicket) return res.status(400).json({ error: "Missing auth." });

    const out = await runP4(["-ztag", "users"], { server, user, ticket: authTicket });

    const lines = out.split(/\r?\n/);
    const users = [];
    let current = null;
    for (const line of lines) {
      const m = line.match(/^\.\.\.\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2];

      if (key === "User") {
        if (current) users.push(current);
        current = { User: val };
      } else if (current) {
        if (key === "FullName" || key === "Email") current[key] = val;
      }
    }
    if (current) users.push(current);

    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.listen(4444, () => console.log("✅ Server on http://localhost:4444"))
  .on('error', (e) => console.error("SERVER ERROR:", e));
