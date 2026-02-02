"use client";

import { useEffect, useState } from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../lib/firebase";
import { useTheme } from "./providers";

type SavedRoom = { id: string; name?: string; joinCode?: string };

function randomCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function loadSavedRooms(): SavedRoom[] {
  try {
    const raw = localStorage.getItem("scouthub.rooms.v1");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x.id === "string");
  } catch {
    return [];
  }
}

function saveRooms(list: SavedRoom[]) {
  try {
    localStorage.setItem("scouthub.rooms.v1", JSON.stringify(list));
  } catch {}
}

function upsertRoom(room: SavedRoom) {
  const cur = loadSavedRooms();
  const byId = new Map<string, SavedRoom>();
  cur.forEach((r) => byId.set(r.id, r));
  const prev = byId.get(room.id) || { id: room.id };
  byId.set(room.id, { ...prev, ...room });
  saveRooms(Array.from(byId.values()));
}

export default function Home() {
  const { theme, toggleTheme } = useTheme();

  const [user, setUser] = useState<any>(null);
  const [roomName, setRoomName] = useState("La mia Room");
  const [joinCode, setJoinCode] = useState("");
  const [savedRooms, setSavedRooms] = useState<SavedRoom[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  useEffect(() => {
    setSavedRooms(loadSavedRooms());
  }, []);

  const login = async () => {
    setMsg(null);
    await signInWithPopup(auth, new GoogleAuthProvider());
  };

  const logout = async () => {
    setMsg(null);
    await signOut(auth);
  };

  const createRoom = async () => {
    setMsg(null);
    if (!auth.currentUser) return;

    const code = randomCode(6);
    const name = roomName.trim() || "Room";

    const ref = await addDoc(collection(db, "rooms"), {
      name,
      joinCode: code,
      adminUid: auth.currentUser.uid,
      createdAt: serverTimestamp(),
    });

    upsertRoom({ id: ref.id, name, joinCode: code });
    setSavedRooms(loadSavedRooms());

    window.location.href = `/room/${ref.id}?code=${encodeURIComponent(code)}`;
  };

  const enterRoom = async () => {
    setMsg(null);
    const code = joinCode.trim().toUpperCase();
    if (!code) return setMsg("Inserisci un codice.");
    window.location.href = `/join?code=${encodeURIComponent(code)}`;
  };

  const openRoom = (id: string) => {
    upsertRoom({ id });
    setSavedRooms(loadSavedRooms());
    window.location.href = `/room/${id}`;
  };

  const forgetRoom = (id: string) => {
    const cur = loadSavedRooms().filter((r) => r.id !== id);
    saveRooms(cur);
    setSavedRooms(cur);
  };

  return (
    <main style={{ padding: 24, maxWidth: 920, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 900 }}>ScoutHub</h1>
          <p style={{ marginTop: 6, color: "var(--muted)" }}>
            Tema {theme === "dark" ? "scuro" : "chiaro"} • Room salvate • Chat • Chiamate
          </p>
        </div>

        <button className="ui-btn" onClick={toggleTheme}>
          {theme === "dark" ? "☀️ Tema chiaro" : "🌙 Tema scuro"}
        </button>
      </div>

      <div className="ui-card" style={{ marginTop: 16 }}>
        {!user ? (
          <>
            <div style={{ color: "var(--muted)" }}>Non sei loggato.</div>
            <button className="ui-btn-primary" style={{ marginTop: 10 }} onClick={login}>
              Entra con Google
            </button>
          </>
        ) : (
          <>
            <div>
              Ciao <b>{user.displayName}</b>
            </div>
            <button className="ui-btn" style={{ marginTop: 10 }} onClick={logout}>
              Esci
            </button>
          </>
        )}
      </div>

      <div className="ui-card" style={{ marginTop: 16 }}>
        <h2 style={{ fontWeight: 900 }}>Le tue room</h2>

        {!user ? (
          <div style={{ marginTop: 8, color: "var(--muted)" }}>Fai il login per vedere le room.</div>
        ) : savedRooms.length === 0 ? (
          <div style={{ marginTop: 8, color: "var(--muted)" }}>Nessuna room salvata.</div>
        ) : (
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {savedRooms.map((r) => (
              <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
                <button className="ui-btn" style={{ flex: 1, textAlign: "left" }} onClick={() => openRoom(r.id)}>
                  <div style={{ fontWeight: 900 }}>{r.name ?? "Room"}</div>
                  <div style={{ marginTop: 6 }}>
                    <span className="ui-pill">
                      {r.joinCode ? (
                        <>codice invito: <b>{r.joinCode}</b></>
                      ) : (
                        <>id: <b>{r.id}</b></>
                      )}
                    </span>
                  </div>
                </button>

                <button className="ui-btn" onClick={() => forgetRoom(r.id)} title="Rimuovi">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="ui-card" style={{ marginTop: 16 }}>
        <h2 style={{ fontWeight: 900 }}>Crea una room</h2>
        <input className="ui-input" value={roomName} onChange={(e) => setRoomName(e.target.value)} disabled={!user} />
        <button className="ui-btn-primary" style={{ marginTop: 10 }} onClick={createRoom} disabled={!user}>
          ➕ Crea room (genera codice)
        </button>
      </div>

      <div className="ui-card" style={{ marginTop: 16 }}>
        <h2 style={{ fontWeight: 900 }}>Entra con codice</h2>
        <input
          className="ui-input"
          style={{ textTransform: "uppercase" }}
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
          disabled={!user}
          placeholder="ES: AB12CD"
        />
        <button className="ui-btn" style={{ marginTop: 10 }} onClick={enterRoom} disabled={!user}>
          Entra
        </button>
        {msg && <div style={{ marginTop: 10, color: "var(--muted)" }}>{msg}</div>}
      </div>
    </main>
  );
}
