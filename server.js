require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// ── Haversine (metres) ───────────────────────────────────────
function hav(la1, ln1, la2, ln2) {
  const R = 6371000,
    toR = Math.PI / 180;
  const dLa = (la2 - la1) * toR,
    dLn = (ln2 - ln1) * toR;
  const a =
    Math.sin(dLa / 2) ** 2 +
    Math.cos(la1 * toR) * Math.cos(la2 * toR) * Math.sin(dLn / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Race rooms  { challenge_id → { ch, parts Map, finishHits Map } } ──
const rooms = new Map();

const FINISH_RADIUS = 20; // metres
const FINISH_REQUIRED = 3; // consecutive readings
const POINTS = [0, 50, 30, 20, 10]; // rank → points (index 0 unused)
const INACTIVITY_TIMEOUT_MS = 60000; // 1 minute inactivity → DNF

io.on("connection", (socket) => {
  // 1. Join lobby
  socket.on("join_race", async ({ challenge_id, user_id }) => {
    socket.join(challenge_id);
    socket.cid = challenge_id;
    socket.uid = user_id;

    if (!rooms.has(challenge_id)) {
      const { data: ch } = await db
        .from("sprint_challenges")
        .select("*")
        .eq("id", challenge_id)
        .single();
      if (!ch) {
        socket.emit("error", "Challenge not found");
        return;
      }
      rooms.set(challenge_id, { ch, parts: new Map(), finishHits: new Map(), inactivityTimers: new Map(), paused: false });
    }

    const room = rooms.get(challenge_id);
    room.parts.set(user_id, {
      user_id,
      socketId: socket.id,
      lat: null,
      lng: null,
      speed: 0,
      distanceFromEnd: Infinity,
      status: "ready",
    });

    io.to(challenge_id).emit("lobby_update", {
      participants: [...room.parts.values()].map((p) => ({
        user_id: p.user_id,
        status: p.status,
      })),
    });
  });

  // 2. Creator starts race — trigger countdown on all clients
 // backend/server.js
socket.on("start_race", async ({ challenge_id }) => {
  console.log("🏁 start_race received for:", challenge_id);
  const room = rooms.get(challenge_id);

  if (!room) {
    console.warn("⚠️  No room found for challenge:", challenge_id);
    console.warn("   Active rooms:", [...rooms.keys()]);
    // Room might not exist yet — re-fetch from DB and create it
    const { data: ch } = await db
      .from("sprint_challenges")
      .select("*")
      .eq("id", challenge_id)
      .single();
    if (!ch) {
      socket.emit("error", "Challenge not found");
      return;
    }
    rooms.set(challenge_id, { ch, parts: new Map(), finishHits: new Map(), inactivityTimers: new Map(), paused: false });
    // Re-add this creator to parts so race can proceed
    rooms.get(challenge_id).parts.set(socket.uid, {
      user_id: socket.uid,
      socketId: socket.id,
      lat: null, lng: null, speed: 0,
      distanceFromEnd: Infinity,
      status: "ready",
    });
  }

  await db
    .from("sprint_challenges")
    .update({ status: "active" })
    .eq("id", challenge_id);

  // Store server start time for synced timers
  const serverStartTime = Date.now();
  rooms.get(challenge_id).startTime = serverStartTime;

  console.log("✅ Emitting race_countdown to room:", challenge_id);
  io.to(challenge_id).emit("race_countdown", { serverStartTime });
});

  // 3. Position update during race
  socket.on(
    "position_update",
    async ({ challenge_id, user_id, lat, lng, speed, ts }) => {
      const room = rooms.get(challenge_id);
      if (!room) return;
      const p = room.parts.get(user_id);
      if (!p || p.status === "finished" || p.status === "dnf") return;

      const dist = hav(lat, lng, room.ch.end_lat, room.ch.end_lng);
      room.parts.set(user_id, {
        ...p,
        lat,
        lng,
        speed,
        distanceFromEnd: dist,
        status: "racing",
      });

      // Persist every 5 s
      const now = Date.now();
      if (!p._saved || now - p._saved > 5000) {
        // Fire-and-forget DB insert — Supabase v2 uses await + try/catch
        (async () => {
          try {
            await db.from("race_positions").insert({ challenge_id, user_id, lat, lng, speed });
          } catch (_) {}
        })();
        room.parts.get(user_id)._saved = now;
      }

      // Reset inactivity timer for this user (skip if paused)
      if (!room.paused) {
        // Clear existing inactivity timer for this user
        if (room.inactivityTimers.has(user_id)) {
          clearTimeout(room.inactivityTimers.get(user_id));
        }
        // Set new inactivity timer — fires DNF if no update for 1 min
        const timer = setTimeout(async () => {
          const r = rooms.get(challenge_id);
          if (!r || r.paused) return;
          const participant = r.parts.get(user_id);
          if (!participant || participant.status === "finished" || participant.status === "dnf") return;
          r.parts.get(user_id).status = "dnf";
          await db
            .from("sprint_participants")
            .update({ status: "dnf" })
            .eq("challenge_id", challenge_id)
            .eq("user_id", user_id);
          io.to(challenge_id).emit("participant_dnf", { user_id });
          checkAllDone(challenge_id, r, io, db);
        }, INACTIVITY_TIMEOUT_MS);
        room.inactivityTimers.set(user_id, timer);
      }

      // Broadcast all positions
      io.to(challenge_id).emit("positions_update", {
        positions: [...room.parts.values()].map(
          ({ user_id, lat, lng, speed, distanceFromEnd, status }) => ({
            user_id,
            lat,
            lng,
            speed,
            distanceFromEnd,
            status,
          }),
        ),
      });

      // Finish check — 3 consecutive readings within 20 m
      if (dist <= FINISH_RADIUS) {
        const hits = (room.finishHits.get(user_id) ?? 0) + 1;
        room.finishHits.set(user_id, hits);
        if (hits >= FINISH_REQUIRED)
          await handleFinish(challenge_id, user_id, room, io, db);
      } else {
        room.finishHits.set(user_id, 0);
      }
    },
  );

  // 4. Client signals race timed out for them
  socket.on("time_expired", ({ challenge_id, user_id }) => {
    const room = rooms.get(challenge_id);
    if (!room) return;
    const p = room.parts.get(user_id);
    if (p && p.status !== "finished") {
      room.parts.get(user_id).status = "dnf";
      // Fire-and-forget DB update
      (async () => { try { await db.from("sprint_participants").update({ status: "dnf" }).eq("challenge_id", challenge_id).eq("user_id", user_id); } catch (_) {} })();
      io.to(challenge_id).emit("participant_dnf", { user_id });
    }
    checkAllDone(challenge_id, room, io, db);
  });

  // 5. Disconnect handling
  socket.on("disconnect", async () => {
    const { cid, uid } = socket;
    if (!cid || !uid) return;
    const room = rooms.get(cid);
    if (!room) return;
    const p = room.parts.get(uid);
    if (!p || p.status === "finished") return;

    room.parts.get(uid).status = "dnf";
    try {
      await db.from("sprint_participants").update({ status: "dnf" }).eq("challenge_id", cid).eq("user_id", uid);
    } catch (_) {}
    io.to(cid).emit("participant_dnf", { user_id: uid });

    // Cancel if >50% dropped
    const all = [...room.parts.values()];
    const active = all.filter(
      (p) => p.status !== "dnf" && p.status !== "finished",
    );
    if (active.length <= all.length * 0.5) {
      io.to(cid).emit("race_cancelled", {
        reason: "Too many participants disconnected",
      });
      await db
        .from("sprint_challenges")
        .update({ status: "cancelled" })
        .eq("id", cid);
      rooms.delete(cid);
    }
  });

  // 7. Resume race
  socket.on("resume_race", ({ challenge_id }) => {
    const room = rooms.get(challenge_id);
    if (!room) return;
    room.paused = false;
    // Send adjusted start time so clients can continue synced timer
    const resumeTime = Date.now();
    const elapsedBeforePause = room.pauseStartTime
      ? resumeTime - room.pauseStartTime
      : 0;
    // New start time = original start + elapsed_before_pause
    const newStartTime = room.originalStartTime
      ? room.originalStartTime + elapsedBeforePause
      : resumeTime;
    room.originalStartTime = newStartTime;
    room.pauseStartTime = null;
    io.to(challenge_id).emit("race_resumed", { serverStartTime: newStartTime });
    console.log("▶️ Race resumed:", challenge_id);
  });

  // 6b. Pause race — record when paused so we can adjust time on resume
  socket.on("pause_race", ({ challenge_id }) => {
    const room = rooms.get(challenge_id);
    if (!room) return;
    room.paused = true;
    room.pauseStartTime = Date.now();
    if (!room.originalStartTime) {
      room.originalStartTime = room.startTime;
    }
    // Clear all inactivity timers
    for (const t of room.inactivityTimers.values()) clearTimeout(t);
    room.inactivityTimers.clear();
    io.to(challenge_id).emit("race_paused");
    console.log("⏸️ Race paused:", challenge_id);
  });

  // 8. End race (creator force-ends for everyone)
  socket.on("end_race", async ({ challenge_id }) => {
    const room = rooms.get(challenge_id);
    if (!room) return;
    // Mark all active participants as DNF
    for (const [uid, p] of room.parts) {
      if (p.status !== "finished" && p.status !== "dnf") {
        room.parts.get(uid).status = "dnf";
        try {
          await db.from("sprint_participants").update({ status: "dnf" }).eq("challenge_id", challenge_id).eq("user_id", uid);
        } catch (_) {}
      }
    }
    try {
      await db.from("sprint_challenges").update({ status: "finished" }).eq("id", challenge_id);
    } catch (_) {}
    // Clear inactivity timers
    for (const t of room.inactivityTimers.values()) clearTimeout(t);
    room.inactivityTimers.clear();
    io.to(challenge_id).emit("race_ended");
    rooms.delete(challenge_id);
    console.log("⏹️ Race ended:", challenge_id);
  });
});

async function handleFinish(challenge_id, user_id, room, io, db) {
  const p = room.parts.get(user_id);
  if (!p || p.status === "finished") return;
  room.parts.get(user_id).status = "finished";

  const finishTime = new Date().toISOString();
  const rank = [...room.parts.values()].filter(
    (p) => p.status === "finished",
  ).length;
  room.parts.get(user_id).finishRank = rank;
  const points = POINTS[rank] ?? 10;

  await db
    .from("sprint_participants")
    .update({
      status: "finished",
      finish_time: finishTime,
      finish_rank: rank,
      points,
    })
    .eq("challenge_id", challenge_id)
    .eq("user_id", user_id);

  io.to(challenge_id).emit("participant_finished", {
    user_id,
    rank,
    finishTime,
    points,
  });
  checkAllDone(challenge_id, room, io, db);
}

async function checkAllDone(challenge_id, room, io, db) {
  const all = [...room.parts.values()];
  if (all.every((p) => p.status === "finished" || p.status === "dnf")) {
    await db
      .from("sprint_challenges")
      .update({ status: "finished" })
      .eq("id", challenge_id);
    io.to(challenge_id).emit("race_finished", {
      results: all.map((p) => ({
        user_id: p.user_id,
        status: p.status,
        rank: p.finishRank ?? null,
        points: p.points ?? 0,
      })),
    });
    // Clear all inactivity timers
    for (const t of room.inactivityTimers.values()) clearTimeout(t);
    room.inactivityTimers.clear();
    rooms.delete(challenge_id);
  }
}

app.get("/health", (_, res) => res.json({ ok: true }));
server.listen(process.env.PORT ?? 3001, () =>
  console.log(`🚀 TrackyFy Socket server on :${process.env.PORT ?? 3001}`),
);
