"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "../../lib/firebase";
import { useTheme } from "../providers";

type ScoutEvent = {
  id: string;
  title: string;
  description: string;
  place: string;
  date: string; // datetime-local string
  createdAt?: any;
  createdBy?: string;
};

export default function CalendarPage() {
  const { theme, toggleTheme } = useTheme();

  const [user, setUser] = useState<any>(null);
  const [events, setEvents] = useState<ScoutEvent[]>([]);

  const [title, setTitle] = useState("");
  const [place, setPlace] = useState("");
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  useEffect(() => {
    const q = query(collection(db, "events"), orderBy("date", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      const list: ScoutEvent[] = snap.docs.map((d) => {
        const data = d.data() as any;
        return {
          id: d.id,
          title: data.title || "",
          place: data.place || "",
          date: data.date || "",
          description: data.description || "",
          createdAt: data.createdAt,
          createdBy: data.createdBy,
        };
      });
      setEvents(list);
    });

    return () => unsub();
  }, []);

  const createEvent = async () => {
    if (!user) {
      alert("Devi fare login per creare eventi.");
      return;
    }

    if (!title.trim() || !date.trim()) {
      alert("Titolo e data sono obbligatori.");
      return;
    }

    await addDoc(collection(db, "events"), {
      title: title.trim(),
      place: place.trim(),
      date: date.trim(),
      description: description.trim(),
      createdAt: serverTimestamp(),
      createdBy: user.uid,
    });

    setTitle("");
    setPlace("");
    setDate("");
    setDescription("");
  };

  const removeEvent = async (id: string) => {
    if (!user) return;
    if (!confirm("Vuoi eliminare questo evento?")) return;

    await deleteDoc(doc(db, "events", id));
  };

  return (
    <main style={shell}>
      <div style={topBar}>
        <button className="ui-btn" onClick={() => (window.location.href = "/")}>
          ← Home
        </button>

        <button className="ui-btn" onClick={toggleTheme}>
          {theme === "dark" ? "☀️ Tema chiaro" : "🌙 Tema scuro"}
        </button>
      </div>

      <div className="ui-card" style={{ marginTop: 14 }}>
        <div style={{ fontSize: 24, fontWeight: 900 }}>📅 Calendario Scout</div>
        <div style={{ marginTop: 6, color: "var(--muted)" }}>
          Crea e gestisci eventi scout (uscite, campi, riunioni).
        </div>
      </div>

      <div className="ui-card" style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>➕ Crea nuovo evento</div>

        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          <input
            className="ui-input"
            placeholder="Titolo evento (es: Uscita al lago)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <input
            className="ui-input"
            placeholder="Luogo (es: Monte Livata)"
            value={place}
            onChange={(e) => setPlace(e.target.value)}
          />

          <input
            className="ui-input"
            type="datetime-local"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />

          <textarea
            className="ui-input"
            placeholder="Descrizione / Note"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ minHeight: 100 }}
          />

          <button className="ui-btn-primary" onClick={createEvent} disabled={!user}>
            Crea evento
          </button>

          {!user && (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>
              ⚠️ Devi fare login per creare o eliminare eventi.
            </div>
          )}
        </div>
      </div>

      <div className="ui-card" style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>📌 Eventi programmati</div>

        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          {events.length === 0 ? (
            <div style={{ color: "var(--muted)" }}>Nessun evento creato.</div>
          ) : (
            events.map((ev) => (
              <div
                key={ev.id}
                style={{
                  border: "2px solid var(--border)",
                  borderRadius: 12,
                  padding: 12,
                }}
              >
                <div style={{ fontWeight: 900, fontSize: 16 }}>{ev.title}</div>

                <div style={{ marginTop: 6, color: "var(--muted)" }}>
                  📍 {ev.place || "Nessun luogo"} <br />
                  🕒 {ev.date}
                </div>

                {ev.description && (
                  <div style={{ marginTop: 10, fontSize: 14 }}>{ev.description}</div>
                )}

                {user && (
                  <button className="ui-btn" style={{ marginTop: 10 }} onClick={() => removeEvent(ev.id)}>
                    🗑 Elimina
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  );
}

const shell: React.CSSProperties = {
  padding: 14,
  maxWidth: 900,
  margin: "0 auto",
};

const topBar: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  alignItems: "center",
};

// deploy-trigger
