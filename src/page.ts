/**
 * The demo page: one plain HTML page, served by the Worker itself.
 *
 * No framework and no build step — the page is a template string the
 * Worker returns, and its small script talks to the JSON routes with
 * `fetch`. Chat is the main feature: the thread and input take the
 * main pane, and the right rail only shows what the chat produced —
 * the pending approval card, the change log, and the
 * outbox. The salesperson switcher re-opens the page as the other
 * salesperson, each with their own session and thread, which is how
 * the isolation beat is run: ask, as one salesperson, about the
 * other's account and watch the refusal land in the change log.
 * Everything on the page is sample data, and prices are sample prices.
 */

export const demoPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Governed Sales Memory — demo</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f5f7; color: #1c2330; }
  header { background: #1c2330; color: #fff; padding: 16px 24px; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0; font-size: 13px; color: #c6cdd8; }
  .switcher { padding: 12px 24px 0; display: flex; gap: 8px; align-items: center; }
  .switcher span { font-size: 13px; color: #5a6577; }
  .switcher button { padding: 8px 14px; border: 1px solid #b9c2d0; border-radius: 999px; background: #fff; cursor: pointer; font-size: 14px; }
  .switcher button.active { background: #2456c8; border-color: #2456c8; color: #fff; }
  main { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; padding: 16px 24px 24px; max-width: 1240px; margin: 0 auto; }
  @media (max-width: 820px) { main { grid-template-columns: 1fr; } }
  .card { background: #fff; border: 1px solid #dde2ea; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 10px; font-size: 15px; }
  .card .empty { color: #5a6577; font-size: 13px; margin: 0; }
  #thread { display: flex; flex-direction: column; gap: 10px; min-height: 260px; max-height: 480px; overflow-y: auto; padding: 4px; }
  .msg { max-width: 85%; padding: 9px 12px; border-radius: 12px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; }
  .msg.user { align-self: flex-end; background: #2456c8; color: #fff; border-bottom-right-radius: 4px; }
  .msg.agent { align-self: flex-start; background: #eef1f6; border-bottom-left-radius: 4px; }
  .msg.system { align-self: center; background: none; color: #5a6577; font-size: 12.5px; text-align: center; }
  #chatForm { display: flex; gap: 8px; margin-top: 12px; }
  #chatText { flex: 1; padding: 10px 12px; border: 1px solid #b9c2d0; border-radius: 8px; font-size: 14px; }
  button.action { padding: 10px 16px; border: none; border-radius: 8px; background: #2456c8; color: #fff; cursor: pointer; font-size: 14px; }
  button.action:disabled { background: #9db1d8; cursor: default; }
  button.quiet { padding: 8px 12px; border: 1px solid #b9c2d0; border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px; }
  button.quiet:disabled { color: #9aa5b5; cursor: default; }
  .sessionbar { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
  .sessionbar span { font-size: 13px; color: #5a6577; margin-right: auto; }
  #approvalCard.waiting { border-color: #d9a400; background: #fffaeb; }
  #approvalText { font-size: 14px; line-height: 1.45; margin: 0 0 12px; }
  ul.log { list-style: none; margin: 0; padding: 0; font-size: 12.5px; }
  ul.log li { padding: 6px 0; border-bottom: 1px solid #eef1f6; line-height: 1.4; }
  ul.log li:last-child { border-bottom: none; }
  ul.log .hash { color: #8a94a6; font-family: ui-monospace, monospace; font-size: 11px; }
  ul.log .action { font-weight: 600; }
</style>
</head>
<body>
<header>
  <h1>Governed Sales Memory — demo</h1>
  <p>Sample data only: every account, person and price on this page is a sample, and every price is a sample price.</p>
</header>
<div class="switcher">
  <span>Acting as:</span>
  <button id="spBtn1" type="button">Salesperson 1</button>
  <button id="spBtn2" type="button">Salesperson 2</button>
</div>
<main>
  <section class="card">
    <h2>Chat</h2>
    <div id="thread"></div>
    <form id="chatForm">
      <input id="chatText" type="text" placeholder="Message the agent…" autocomplete="off">
      <button class="action" id="sendBtn" type="submit">Send</button>
    </form>
    <div class="sessionbar">
      <span id="sessionStatus">Opening session…</span>
      <button class="quiet" id="closeBtn" type="button">Close session</button>
      <button class="quiet" id="resumeBtn" type="button" disabled>Resume session</button>
    </div>
  </section>
  <aside>
    <section class="card" id="approvalCard">
      <h2>Pending approval</h2>
      <p class="empty" id="approvalEmpty">Nothing is waiting for approval.</p>
      <p id="approvalText" hidden></p>
      <button class="action" id="approveBtn" type="button" hidden>Approve</button>
    </section>
    <section class="card">
      <h2>Change log</h2>
      <ul class="log" id="changeLogList"><li class="hash">Nothing recorded yet.</li></ul>
    </section>
    <section class="card">
      <h2>Outbox (CRM stand-in)</h2>
      <ul class="log" id="outboxList"><li class="hash">Nothing sent onward yet.</li></ul>
    </section>
  </aside>
</main>
<script>
"use strict";
var OWNERS = ["acct_salesperson", "acct_salesperson_2"];
var state = { owner: "acct_salesperson", per: {} };

function current() {
  if (!state.per[state.owner]) {
    state.per[state.owner] = { sessionId: null, step: "", closed: false, pending: null, messages: [] };
  }
  return state.per[state.owner];
}

function el(id) { return document.getElementById(id); }

function api(path, options) {
  return fetch(path, options).then(function (response) {
    return response.json().then(function (body) {
      return { status: response.status, body: body };
    });
  });
}

function postJson(path, payload) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function pushMessage(who, text) {
  current().messages.push({ who: who, text: text });
  renderThread();
}

function renderThread() {
  var thread = el("thread");
  thread.textContent = "";
  current().messages.forEach(function (message) {
    var div = document.createElement("div");
    div.className = "msg " + message.who;
    div.textContent = message.text;
    thread.appendChild(div);
  });
  thread.scrollTop = thread.scrollHeight;
}

function renderSession() {
  var mine = current();
  el("spBtn1").className = state.owner === "acct_salesperson" ? "active" : "";
  el("spBtn2").className = state.owner === "acct_salesperson_2" ? "active" : "";
  el("sessionStatus").textContent = mine.sessionId
    ? "Session " + (mine.closed ? "closed" : "open") + " · step: " + (mine.step || "intake") + " · " + state.owner
    : "Opening session…";
  el("chatText").disabled = !mine.sessionId || mine.closed;
  el("sendBtn").disabled = !mine.sessionId || mine.closed;
  el("closeBtn").disabled = !mine.sessionId || mine.closed;
  el("resumeBtn").disabled = !mine.sessionId || !mine.closed;
}

function renderApproval() {
  var pending = current().pending;
  el("approvalCard").className = "card" + (pending ? " waiting" : "");
  el("approvalEmpty").hidden = !!pending;
  el("approvalText").hidden = !pending;
  el("approveBtn").hidden = !pending;
  if (pending) {
    el("approvalText").textContent = pending.description;
  }
}

function renderPanels() {
  api("/change-log?as=" + encodeURIComponent(state.owner)).then(function (result) {
    var list = el("changeLogList");
    list.textContent = "";
    var entries = result.body.entries || [];
    if (entries.length === 0) {
      list.innerHTML = "<li class='hash'>Nothing recorded yet.</li>";
      return;
    }
    entries.forEach(function (entry) {
      var li = document.createElement("li");
      var head = document.createElement("span");
      head.className = "action";
      head.textContent = "#" + entry._id + " " + entry.action + " ";
      var rest = document.createElement("span");
      rest.textContent = "by " + entry.actor + " — " + entry.detail + " ";
      var hash = document.createElement("span");
      hash.className = "hash";
      hash.textContent = entry.hash.slice(0, 10) + "…";
      li.appendChild(head);
      li.appendChild(rest);
      li.appendChild(hash);
      list.appendChild(li);
    });
  });
  api("/outbox?as=" + encodeURIComponent(state.owner)).then(function (result) {
    var list = el("outboxList");
    list.textContent = "";
    var entries = result.body.entries || [];
    if (entries.length === 0) {
      list.innerHTML = "<li class='hash'>Nothing sent onward yet.</li>";
      return;
    }
    entries.forEach(function (entry) {
      var li = document.createElement("li");
      li.textContent = entry.summary;
      list.appendChild(li);
    });
  });
}

function refresh() {
  renderThread();
  renderSession();
  renderApproval();
  renderPanels();
}

function sendChat(text) {
  var mine = current();
  pushMessage("user", text);
  return postJson("/chat?as=" + encodeURIComponent(state.owner), { sessionId: mine.sessionId, text: text }).then(function (result) {
    if (result.body.ok) {
      mine.step = result.body.step;
      mine.pending = result.body.pendingApproval || null;
      pushMessage("agent", result.body.reply);
    } else {
      pushMessage("system", "The agent refused that message (" + result.body.error + ").");
    }
    refresh();
  });
}

function openSession(owner) {
  state.owner = owner;
  var mine = current();
  refresh();
  if (mine.sessionId) {
    return;
  }
  postJson("/session?as=" + encodeURIComponent(owner), {}).then(function (result) {
    if (result.body.ok) {
      mine.sessionId = result.body.session.id;
      mine.step = result.body.session.step;
      refresh();
      sendChat("Let's start.");
    } else {
      pushMessage("system", "Could not open a session for " + owner + ".");
      refresh();
    }
  });
}

el("spBtn1").addEventListener("click", function () { openSession("acct_salesperson"); });
el("spBtn2").addEventListener("click", function () { openSession("acct_salesperson_2"); });

el("chatForm").addEventListener("submit", function (event) {
  event.preventDefault();
  var text = el("chatText").value.trim();
  if (text === "") {
    return;
  }
  el("chatText").value = "";
  sendChat(text);
});

el("approveBtn").addEventListener("click", function () {
  var mine = current();
  if (!mine.pending) {
    return;
  }
  var approvalId = mine.pending.id;
  api("/approve/" + encodeURIComponent(approvalId) + "?as=" + encodeURIComponent(state.owner), { method: "POST" }).then(function (result) {
    if (result.body.ok) {
      mine.pending = null;
      pushMessage("system", "Approved — the change was written to the outbox and recorded in the change log.");
      refresh();
      sendChat("Approved.");
    } else {
      pushMessage("system", "Approval failed (" + result.body.error + ").");
      refresh();
    }
  });
});

el("closeBtn").addEventListener("click", function () {
  var mine = current();
  api("/session/" + encodeURIComponent(mine.sessionId) + "/close?as=" + encodeURIComponent(state.owner), { method: "POST" }).then(function (result) {
    if (result.body.ok) {
      mine.closed = true;
      mine.step = result.body.session.step;
      pushMessage("system", "Session closed at step '" + mine.step + "'. Its step and data are saved — resume picks up exactly here.");
    } else {
      pushMessage("system", "Could not close the session (" + result.body.error + ").");
    }
    refresh();
  });
});

el("resumeBtn").addEventListener("click", function () {
  var mine = current();
  api("/session/" + encodeURIComponent(mine.sessionId) + "/resume?as=" + encodeURIComponent(state.owner), { method: "POST" }).then(function (result) {
    if (result.body.ok) {
      mine.closed = false;
      mine.step = result.body.session.step;
      pushMessage("agent", "Welcome back — resumed at step '" + mine.step + "' with the saved data intact, exactly where you left off.");
    } else {
      pushMessage("system", "Could not resume the session (" + result.body.error + ").");
    }
    refresh();
  });
});

openSession("acct_salesperson");
</script>
</body>
</html>
`;
