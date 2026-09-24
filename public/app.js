const boot = document.getElementById("boot");
const bootLog = document.getElementById("bootLog");
const bootInput = document.getElementById("bootInput");
const manager = document.getElementById("manager");
const logsEl = document.getElementById("logs");
const botsList = document.getElementById("botsList");
const botsCount = document.getElementById("botsCount");
const promptEl = document.getElementById("prompt");
const cmdInput = document.getElementById("cmdInput");

let socket = null;
let pin = 0;
let started = false;

function bootPrint(text, cls = "dim") {
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  bootLog.appendChild(div);
  boot.scrollTop = boot.scrollHeight;
}

function addLog(level, text) {
  String(text).split("\n").forEach((line) => {
    const div = document.createElement("div");
    const sym = level === "ok" ? "[+]" : level === "warn" ? "[!]" : level === "err" ? "[x]" : "[i]";
    div.innerHTML = "";
    const s = document.createElement("span");
    s.className = "log-" + level;
    s.textContent = sym + "  ";
    const t = document.createElement("span");
    t.textContent = line;
    div.appendChild(s);
    div.appendChild(t);
    logsEl.appendChild(div);
  });
  document.getElementById("logsPanel").scrollTop = 1e9;
}

function startManager() {
  if (started) return;
  started = true;
  boot.classList.add("hidden");
  manager.classList.remove("hidden");
  socket = io();
  socket.on("log", ({ level, text }) => addLog(level || "info", text || ""));
  socket.on("bots", (names) => {
    botsList.textContent = names.length ? names.join("\n") : "(none)";
    botsCount.textContent = names.length ? `(${names.length})` : "";
  });
  socket.on("pin", (p) => {
    pin = p || 0;
    promptEl.textContent = pin ? "CMD> " : "PIN> ";
  });
  socket.on("clear", () => { logsEl.innerHTML = ""; });
  cmdInput.focus();
}

bootInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const v = bootInput.value.trim();
  bootPrint("> " + v, "");
  if (v === "/run") {
    startManager();
  } else if (v === "/help" || v === "help") {
    bootPrint("Commands: /run  — start manager", "");
  } else {
    bootPrint("Unknown command. Type /run", "dim");
  }
  bootInput.value = "";
});

cmdInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const v = cmdInput.value;
  cmdInput.value = "";
  if (!v.trim()) return;
  const div = document.createElement("div");
  div.style.color = "#888";
  div.textContent = "> " + v;
  logsEl.appendChild(div);
  socket.emit("command", v);
});

// autofocus
bootInput.focus();
