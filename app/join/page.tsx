"use client";

import { useEffect, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../lib/firebase";

type SavedRoom = { id: string; name?: string; joinCode?: string };

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

export default function JoinPage() {
  const [status, setStatus] = useState("Cerco la room...");

  useEffect(() => {
    const run = async () => {
      const url = new URL(window.location.href);
      const code = (url.searchParams.get("code") || "").toUpperCase().trim();
      if (!code) return setStatus("Codice mancante.");

      const q = query(collection(db, "rooms"), where("joinCode", "==", code));
      const snap = await getDocs(q);

      if (snap.empty) return setStatus("Nessuna room trovata con questo codice.");

      const roomId = snap.docs[0].id;
      const data = snap.docs[0].data() as any;

      // salva localmente così poi non reinserisci il codice
      upsertRoom({ id: roomId, name: data?.name, joinCode: data?.joinCode });

      window.location.href = `/room/${roomId}?code=${encodeURIComponent(code)}`;
    };

    run().catch(() => setStatus("Errore durante la ricerca della room."));
  }, []);

  return (
    <main style={{ padding: 24, maxWidth: 820, margin: "0 auto" }}>
      <button className="ui-btn" onClick={() => (window.location.href = "/")}>
        ← Home
      </button>

      <div className="ui-card" style={{ marginTop: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 900 }}>Join</h1>
        <p style={{ marginTop: 10, color: "var(--muted)" }}>{status}</p>
      </div>
    </main>
  );
}
