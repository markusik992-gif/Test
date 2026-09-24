import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import Kahoot from "kahoot.js-latest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const MAX_BATCH_SIZE = 200; // lowered for web safety (original CLI allowed 10000)
const DEFAULT_PARALLEL_JOINS = 10;

const INVIS = ["\u200B", "\u200C", "\u200D", "\u2060"];
function invisibleSuffix(index) {
  if (index === 0) return "";
  let result = "";
  let n = index;
  while (n > 0) {
    result += INVIS[(n - 1) % INVIS.length];
    n = Math.floor((n - 1) / INVIS.length);
  }
  return result;
}

function parsePin(value) {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const pin = Number(text);
  return Number.isSafeInteger(pin) && pin > 0 ? pin : 0;
}

function randomAnswer(question) {
  if (question && Array.isArray(question.quizQuestionAnswers) && question.quizQuestionAnswers.length > 0) {
    return Math.floor(Math.random() * question.quizQuestionAnswers.length);
  }
  if (question && Array.isArray(question.choices) && question.choices.length > 0) {
    return Math.floor(Math.random() * question.choices.length);
  }
  if (question && Number.isInteger(question.numberOfChoices) && question.numberOfChoices > 0) {
    return Math.floor(Math.random() * question.numberOfChoices);
  }
  return Math.floor(Math.random() * 4);
}

function parseNameExpression(raw) {
  const text = String(raw || "").trim();
  if (!text) return { names: [], error: "Invalid add command. Use: add <name> | add <name>*<count> | add <name>~<count>" };
  const pattern = text.match(/^(.*?)\s*([*~])\s*(\d+)$/);
  if (pattern) {
    const name = pattern[1].trim();
    const count = Number.parseInt(pattern[3], 10);
    if (!name) return { names: [], error: "Invalid add command" };
    if (!Number.isFinite(count) || count <= 0) return { names: [], error: "Invalid add command" };
    if (count > MAX_BATCH_SIZE) return { names: [], error: `Too many bots requested (max ${MAX_BATCH_SIZE} per command on web)` };
    const suffix = pattern[2] === "*" ? (i) => i + 1 : invisibleSuffix;
    return { names: Array.from({ length: count }, (_, i) => `${name}${suffix(i)}`), error: "" };
  }
  return { names: [text], error: "" };
}

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"), (err) => {
    if (err) {
      res.status(500).send("index.html missing on server - public/ folder was not deployed. Check GitHub repo contains public/index.html and Root Directory is blank.");
    }
  });
});

function newSession() {
  return { gamePin: 0, bots: new Map() };
}

function emitBots(socket, session) {
  const names = Array.from(session.bots.entries())
    .filter(([, s]) => s.status === "active")
    .map(([, s]) => s.name)
    .reverse();
  socket.emit("bots", names);
}

function log(socket, level, text) {
  socket.emit("log", { level, text });
}

function leaveBot(client) {
  try { client.leave(true); } catch {}
}

async function connectBot(socket, session, name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return "skipped";
  const client = new Kahoot();
  const botId = Symbol(cleanName);
  session.bots.set(botId, { client, name: cleanName, status: "joining", pendingKick: false, mutedDisconnect: false });

  client.on("QuestionStart", (question) => {
    client.answer(randomAnswer(question)).catch(() => {});
  });
  client.on("Disconnect", () => {
    const state = session.bots.get(botId);
    if (!state || state.client !== client) return;
    session.bots.delete(botId);
    if (state.status === "active") emitBots(socket, session);
    if (state.mutedDisconnect) return;
    log(socket, "warn", `${cleanName} disconnected`);
  });

  try {
    await client.join(session.gamePin, cleanName);
    const state = session.bots.get(botId);
    if (!state || state.client !== client) return "skipped";
    if (state.pendingKick) {
      state.mutedDisconnect = true;
      leaveBot(client);
      session.bots.delete(botId);
      log(socket, "info", `${cleanName} removed`);
      return "skipped";
    }
    state.status = "active";
    emitBots(socket, session);
    log(socket, "ok", `${cleanName} connected`);
    return "connected";
  } catch {
    session.bots.delete(botId);
    log(socket, "err", `${cleanName} failed to join (check PIN / name)`);
    return "failed";
  }
}

async function addMany(socket, session, names) {
  const clean = names.map((n) => String(n || "").trim()).filter(Boolean);
  if (clean.length === 0) {
    log(socket, "warn", "No bot names provided");
    return;
  }
  const workers = Math.max(1, Math.min(DEFAULT_PARALLEL_JOINS, clean.length));
  let index = 0;
  async function runWorker() {
    while (index < clean.length) {
      const current = clean[index];
      index += 1;
      await connectBot(socket, session, current);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => runWorker()));
}

function kickAll(socket, session, silent = false) {
  for (const [id, state] of session.bots) {
    if (state.status === "joining") {
      state.pendingKick = true;
    } else {
      state.mutedDisconnect = true;
      session.bots.delete(id);
      leaveBot(state.client);
    }
  }
  if (!silent) emitBots(socket, session);
}

function kickBot(socket, session, name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) {
    log(socket, "warn", "Enter a bot name");
    return;
  }
  const entry = Array.from(session.bots.entries()).reverse().find(([, s]) => s.name === cleanName);
  if (!entry) {
    log(socket, "warn", "Bot not found");
    return;
  }
  const [id, state] = entry;
  if (state.status === "joining") {
    state.pendingKick = true;
    log(socket, "info", `${cleanName} removed`);
    return;
  }
  state.mutedDisconnect = true;
  session.bots.delete(id);
  leaveBot(state.client);
  emitBots(socket, session);
  log(socket, "info", `${cleanName} removed`);
}

function showHelp(socket) {
  log(socket, "info", "Commands:\n  pin <pin>\n  add <name>\n  add <name>*<count>\n  add <name>~<count>\n  kick <name>\n  kick all\n  help\n  clear");
}

async function handleCommand(socket, session, rawText) {
  const clean = String(rawText || "").trim();
  if (!clean) return;
  const [command, ...tokens] = clean.split(/\s+/);
  const name = command.toLowerCase();
  const argument = tokens.join(" ");

  if (name === "help") {
    showHelp(socket);
    return;
  }
  if (name === "clear") {
    socket.emit("clear");
    return;
  }

  if (!session.gamePin) {
    const pin = parsePin(name === "pin" && tokens.length === 1 ? tokens[0] : command);
    if (!pin) {
      log(socket, "err", "Enter a valid PIN first. Example: pin 123456");
      socket.emit("pin", 0);
      return;
    }
    session.gamePin = pin;
    log(socket, "ok", `PIN set to ${pin}`);
    socket.emit("pin", pin);
    return;
  }

  if (name === "pin") {
    if (tokens.length !== 1) {
      log(socket, "err", "Invalid PIN. Use: pin <pin>");
      return;
    }
    const nextPin = parsePin(tokens[0]);
    if (!nextPin) {
      log(socket, "err", "Invalid PIN");
      return;
    }
    if (nextPin !== session.gamePin) {
      kickAll(socket, session);
      session.gamePin = nextPin;
      log(socket, "ok", `PIN set to ${nextPin}`);
      socket.emit("pin", nextPin);
    } else {
      log(socket, "info", `PIN already ${session.gamePin}`);
    }
    return;
  }

  if (name === "add") {
    if (!argument) {
      log(socket, "err", "Invalid add command");
      return;
    }
    const parsed = parseNameExpression(argument);
    if (parsed.error) {
      log(socket, "err", parsed.error);
      return;
    }
    log(socket, "info", `Joining ${parsed.names.length} bot(s)...`);
    await addMany(socket, session, parsed.names);
    return;
  }

  if (name === "kick") {
    if (tokens.length === 1 && tokens[0].toLowerCase() === "all") {
      kickAll(socket, session);
      log(socket, "info", "All bots removed");
      return;
    }
    if (tokens.length < 1) {
      log(socket, "err", "kick requires a bot name");
      return;
    }
    kickBot(socket, session, argument);
    return;
  }

  log(socket, "err", "Unknown command. Run help to list commands");
}

io.on("connection", (socket) => {
  const session = newSession();
  log(socket, "info", "Enter PIN to start");
  log(socket, "info", "Run help to list commands");
  emitBots(socket, session);
  socket.emit("pin", 0);

  socket.on("command", async (text) => {
    try {
      await handleCommand(socket, session, String(text || ""));
    } catch (e) {
      log(socket, "err", `Error: ${e?.message || e}`);
    }
  });

  socket.on("disconnect", () => {
    try {
      for (const [, state] of session.bots) {
        try { state.client.leave(true); } catch {}
      }
      session.bots.clear();
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`hackoot web running on :${PORT}`);
});
