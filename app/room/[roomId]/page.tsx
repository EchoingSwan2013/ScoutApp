"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { auth, db } from "../../../lib/firebase";
import { useTheme } from "../../providers";

type RoomData = {
  name: string;
  adminUid: string;
  joinCode: string;

  // ✅ Room settings
  defaultCanChat?: boolean;
  defaultCanCall?: boolean;
  lockChat?: boolean;
  lockCalls?: boolean;
};

type Msg = { id: string; text: string; uid: string; name: string };
type SavedRoom = { id: string; name?: string; joinCode?: string };

type Member = {
  uid: string;
  name: string;
  role: "admin" | "member";
  canChat?: boolean; // override per membro
  canCall?: boolean; // override per membro
  joinedAt?: any;
};

type CallDoc = {
  createdAt?: any;
  createdByUid?: string;
  offer?: any;
  answer?: any;
  status?: "open" | "connected" | "ended";
};

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

export default function RoomPage() {
  const { theme, toggleTheme } = useTheme();

  const pathname = usePathname();
  const searchParams = useSearchParams();

  const roomId = useMemo(() => {
    const parts = (pathname || "").split("/").filter(Boolean);
    return parts[1] || "";
  }, [pathname]);

  const callFromUrl = useMemo(() => searchParams.get("call") || "", [searchParams]);

  const [user, setUser] = useState<any>(null);

  const [room, setRoom] = useState<RoomData | null>(null);
  const [status, setStatus] = useState("Carico room...");

  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");

  // sidebar rooms
  const [savedRooms, setSavedRooms] = useState<SavedRoom[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // members + my perms
  const [members, setMembers] = useState<Member[]>([]);
  const [myRole, setMyRole] = useState<"admin" | "member" | "none">("none");
  const [myOverrides, setMyOverrides] = useState<{ canChat?: boolean; canCall?: boolean }>({});

  // settings UI
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingSettings, setSavingSettings] = useState<string | null>(null);

  // CALLS
  const [callId, setCallId] = useState<string>(callFromUrl);
  const [callStatus, setCallStatus] = useState<string>("Nessuna chiamata attiva.");
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setSavedRooms(loadSavedRooms());
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  // Load room and ensure defaults exist
  useEffect(() => {
    if (!roomId) return;

    const run = async () => {
      const snap = await getDoc(doc(db, "rooms", roomId));
      if (!snap.exists()) {
        setStatus("Room non trovata.");
        return;
      }

      const data = snap.data() as RoomData;

      // ✅ se mancano settings, mettiamo valori di default (solo la prima volta)
      const patch: Partial<RoomData> = {};
      if (typeof data.defaultCanChat !== "boolean") patch.defaultCanChat = true;
      if (typeof data.defaultCanCall !== "boolean") patch.defaultCanCall = true;
      if (typeof data.lockChat !== "boolean") patch.lockChat = false;
      if (typeof data.lockCalls !== "boolean") patch.lockCalls = false;

      if (Object.keys(patch).length > 0) {
        await updateDoc(doc(db, "rooms", roomId), patch as any);
        // ricarico dopo l'update (o lascio che l'onSnapshot sotto aggiorni)
      }

      setRoom({
        ...data,
        ...patch,
      });

      setStatus("OK");

      // aggiorna room salvate con nome/codice
      upsertRoom({ id: roomId, name: data.name, joinCode: data.joinCode });
      setSavedRooms(loadSavedRooms());

      // membership base: crea doc member se manca (override vuoti)
      const u = auth.currentUser;
      if (u) {
        const isAdmin = data.adminUid === u.uid;
        await setDoc(
          doc(db, "rooms", roomId, "members", u.uid),
          {
            uid: u.uid,
            name: u.displayName ?? "utente",
            role: isAdmin ? "admin" : "member",
            joinedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }
    };

    run().catch(() => setStatus("Errore caricando la room."));
  }, [roomId]);

  // Live room doc (for settings)
  useEffect(() => {
    if (!roomId) return;
    const unsub = onSnapshot(doc(db, "rooms", roomId), (snap) => {
      if (!snap.exists()) return;
      setRoom(snap.data() as any);
    });
    return () => unsub();
  }, [roomId]);

  // Messages
  useEffect(() => {
    if (!roomId) return;

    const q = query(collection(db, "rooms", roomId, "messages"), orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      const list: Msg[] = snap.docs.map((d) => {
        const data = d.data() as any;
        return { id: d.id, text: data.text, uid: data.uid, name: data.name };
      });
      setMessages(list);
    });

    return () => unsub();
  }, [roomId]);

  // Members + my role/overrides
  useEffect(() => {
    if (!roomId) return;

    const unsub = onSnapshot(collection(db, "rooms", roomId, "members"), (snap) => {
      const list: Member[] = snap.docs.map((d) => d.data() as any);
      list.sort((a, b) => {
        if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
        return (a.name || "").localeCompare(b.name || "");
      });
      setMembers(list);

      const u = auth.currentUser;
      if (!u) {
        setMyRole("none");
        setMyOverrides({});
        return;
      }
      const me = list.find((m) => m.uid === u.uid);
      setMyRole(me?.role ?? "none");
      setMyOverrides({ canChat: me?.canChat, canCall: me?.canCall });
    });

    return () => unsub();
  }, [roomId]);

  // Effective permissions: room settings + override per member + admin bypass
  const isAdmin = useMemo(() => myRole === "admin", [myRole]);

  const effectiveCanChat = useMemo(() => {
    if (!user || !room) return false;
    if (isAdmin) return true;

    // lockChat blocca tutti i membri
    if (room.lockChat) return false;

    // override member (se presente) altrimenti default della room
    if (typeof myOverrides.canChat === "boolean") return myOverrides.canChat;
    return room.defaultCanChat ?? true;
  }, [user, room, isAdmin, myOverrides.canChat]);

  const effectiveCanCall = useMemo(() => {
    if (!user || !room) return false;
    if (isAdmin) return true;

    if (room.lockCalls) return false;

    if (typeof myOverrides.canCall === "boolean") return myOverrides.canCall;
    return room.defaultCanCall ?? true;
  }, [user, room, isAdmin, myOverrides.canCall]);

  const send = async () => {
    if (!user || !effectiveCanChat) return;
    const t = text.trim();
    if (!t) return;

    setText("");
    await addDoc(collection(db, "rooms", roomId, "messages"), {
      text: t,
      uid: user.uid,
      name: user.displayName ?? "utente",
      createdAt: serverTimestamp(),
    });
  };

  // -------- CALLS (WebRTC MVP) --------
  const iceServers = useMemo(
    () => ({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] }),
    []
  );

  const cleanupCall = async () => {
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;

    try { localStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    localStreamRef.current = null;

    setCallStatus("Chiamata chiusa.");
  };

  const createCall = async () => {
    if (!user) return;
    if (!effectiveCanCall) return setCallStatus("Non hai i permessi per fare chiamate.");

    setCallStatus("Creo chiamata…");

    const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStreamRef.current = localStream;

    const pc = new RTCPeerConnection(iceServers);
    pcRef.current = pc;

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    const remoteStream = new MediaStream();
    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;
    };

    const callRef = await addDoc(collection(db, "rooms", roomId, "calls"), {
      createdAt: serverTimestamp(),
      createdByUid: user.uid,
      status: "open",
    } as CallDoc);

    const newCallId = callRef.id;
    setCallId(newCallId);

    const offerCandidates = collection(db, "rooms", roomId, "calls", newCallId, "offerCandidates");
    pc.onicecandidate = async (event) => {
      if (event.candidate) await addDoc(offerCandidates, event.candidate.toJSON());
    };

    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);

    await updateDoc(doc(db, "rooms", roomId, "calls", newCallId), {
      offer: { type: offerDescription.type, sdp: offerDescription.sdp },
    });

    setCallStatus("Chiamata creata. Condividi il link o attendi che qualcuno si unisca.");

    onSnapshot(doc(db, "rooms", roomId, "calls", newCallId), async (snap) => {
      const data = snap.data() as any;
      if (!data) return;

      if (!pc.currentRemoteDescription && data.answer) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        setCallStatus("Connesso ✅ (audio attivo)");
      }
      if (data.status === "ended") await cleanupCall();
    });

    const answerCandidates = collection(db, "rooms", roomId, "calls", newCallId, "answerCandidates");
    onSnapshot(answerCandidates, (snap) => {
      snap.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          try { await pc.addIceCandidate(new RTCIceCandidate(change.doc.data())); } catch {}
        }
      });
    });

    const url = new URL(window.location.href);
    url.searchParams.set("call", newCallId);
    window.history.replaceState({}, "", url.toString());
  };

  const joinCall = async () => {
    if (!user) return;
    if (!effectiveCanCall) return setCallStatus("Non hai i permessi per fare chiamate.");
    if (!callId) return;

    setCallStatus("Mi unisco alla chiamata…");

    const callDocRef = doc(db, "rooms", roomId, "calls", callId);
    const callSnap = await getDoc(callDocRef);
    if (!callSnap.exists()) return setCallStatus("Chiamata non trovata.");

    const callData = callSnap.data() as any;
    if (!callData.offer) return setCallStatus("Chiamata non pronta (manca offer).");

    const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStreamRef.current = localStream;

    const pc = new RTCPeerConnection(iceServers);
    pcRef.current = pc;

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    const remoteStream = new MediaStream();
    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;
    };

    const answerCandidates = collection(db, "rooms", roomId, "calls", callId, "answerCandidates");
    pc.onicecandidate = async (event) => {
      if (event.candidate) await addDoc(answerCandidates, event.candidate.toJSON());
    };

    await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));

    const answerDesc = await pc.createAnswer();
    await pc.setLocalDescription(answerDesc);

    await updateDoc(callDocRef, {
      answer: { type: answerDesc.type, sdp: answerDesc.sdp },
      status: "connected",
    });

    setCallStatus("Connesso ✅ (audio attivo)");

    const offerCandidates = collection(db, "rooms", roomId, "calls", callId, "offerCandidates");
    onSnapshot(offerCandidates, (snap) => {
      snap.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          try { await pc.addIceCandidate(new RTCIceCandidate(change.doc.data())); } catch {}
        }
      });
    });

    const url = new URL(window.location.href);
    url.searchParams.set("call", callId);
    window.history.replaceState({}, "", url.toString());
  };

  const hangUp = async () => {
    if (roomId && callId) {
      try { await updateDoc(doc(db, "rooms", roomId, "calls", callId), { status: "ended" }); } catch {}
    }
    await cleanupCall();

    const url = new URL(window.location.href);
    url.searchParams.delete("call");
    window.history.replaceState({}, "", url.toString());
  };

  const callLink = useMemo(() => {
    if (!callId) return "";
    const url = new URL(window.location.href);
    url.searchParams.set("call", callId);
    return url.toString();
  }, [callId]);

  const copyCallLink = async () => {
    if (!callLink) return;
    try {
      await navigator.clipboard.writeText(callLink);
      setCallStatus("Link copiato ✅ incollalo in chat.");
    } catch {
      setCallStatus("Non riesco a copiare. Copia manualmente il link.");
    }
  };

  const goToRoom = (id: string) => {
    setCallId("");
    setCallStatus("Nessuna chiamata attiva.");
    window.location.href = `/room/${id}`;
  };

  // ✅ Room Settings actions
  const updateRoomSetting = async (patch: Partial<RoomData>) => {
    if (!isAdmin) return;
    if (!roomId) return;
    setSavingSettings("Salvo…");
    try {
      await updateDoc(doc(db, "rooms", roomId), patch as any);
      setSavingSettings("Salvato ✅");
      setTimeout(() => setSavingSettings(null), 900);
    } catch {
      setSavingSettings("Errore salvando.");
      setTimeout(() => setSavingSettings(null), 1200);
    }
  };

  return (
    <main style={shell}>
      {/* SIDEBAR */}
      {sidebarOpen && (
        <aside style={sidebar}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <div style={{ fontWeight: 900 }}>Room</div>
            <button className="ui-btn" onClick={() => setSidebarOpen(false)} title="Nascondi">
              ◀
            </button>
          </div>

          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            {savedRooms.length === 0 ? (
              <div style={{ color: "var(--muted)", fontSize: 13 }}>Nessuna room salvata.</div>
            ) : (
              savedRooms.map((r) => {
                const active = r.id === roomId;
                return (
                  <button
                    key={r.id}
                    className="ui-btn"
                    onClick={() => goToRoom(r.id)}
                    style={{
                      textAlign: "left",
                      borderColor: active ? "var(--primary-bg)" : "var(--border)",
                      background: active ? "var(--pill)" : "var(--card)",
                    }}
                  >
                    <div style={{ fontWeight: 900 }}>{r.name ?? "Room"}</div>
                    <div style={{ marginTop: 4 }}>
                      <span className="ui-pill">
                        {r.joinCode ? <>cod: <b>{r.joinCode}</b></> : <>id: <b>{r.id}</b></>}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <button className="ui-btn" onClick={() => (window.location.href = "/")} style={{ marginTop: 12 }}>
            ← Home
          </button>

          <button className="ui-btn" onClick={toggleTheme} style={{ marginTop: 10 }}>
            {theme === "dark" ? "☀️ Tema chiaro" : "🌙 Tema scuro"}
          </button>

          <div className="ui-card" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 900 }}>Ruolo</div>
            <div style={{ marginTop: 8, color: "var(--muted)", fontSize: 13 }}>
              <b>{isAdmin ? "ADMIN" : "MEMBER"}</b>
              <br />
              Chat: <b>{effectiveCanChat ? "OK" : "NO"}</b> • Call: <b>{effectiveCanCall ? "OK" : "NO"}</b>
            </div>
          </div>
        </aside>
      )}

      {/* MAIN */}
      <section style={content}>
        {/* TOPBAR */}
        <div style={topBar}>
          {!sidebarOpen ? (
            <button className="ui-btn" onClick={() => setSidebarOpen(true)} title="Mostra sidebar">
              ▶ Room
            </button>
          ) : (
            <div />
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button className="ui-btn" onClick={() => (window.location.href = "/")}>
              ← Home
            </button>
            <button className="ui-btn" onClick={toggleTheme}>
              {theme === "dark" ? "☀️ Tema chiaro" : "🌙 Tema scuro"}
            </button>
          </div>
        </div>

        {/* ROOM HEADER */}
        <div className="ui-card" style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 900 }}>{room?.name ?? "Room"}</div>
              <div style={{ marginTop: 4, color: "var(--muted)" }}>{status}</div>
            </div>

            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Codice invito</div>
              <div style={{ fontWeight: 900 }}>{room?.joinCode ?? "—"}</div>
            </div>
          </div>
        </div>

        {/* ✅ ROOM SETTINGS */}
        {isAdmin && (
          <div className="ui-card" style={{ marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <div style={{ fontWeight: 900 }}>Impostazioni Room</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {savingSettings && <span style={{ color: "var(--muted)", fontSize: 13 }}>{savingSettings}</span>}
                <button className="ui-btn" onClick={() => setSettingsOpen((v) => !v)}>
                  {settingsOpen ? "Chiudi" : "Apri"}
                </button>
              </div>
            </div>

            {settingsOpen && (
              <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                <div style={settingRow}>
                  <div>
                    <div style={{ fontWeight: 900 }}>Default chat per nuovi membri</div>
                    <div style={{ marginTop: 4, color: "var(--muted)", fontSize: 13 }}>
                      Se ON, chi entra in room può scrivere subito (a meno di override).
                    </div>
                  </div>
                  <button
                    className="ui-btn"
                    onClick={() => updateRoomSetting({ defaultCanChat: !(room?.defaultCanChat ?? true) })}
                  >
                    {room?.defaultCanChat ?? true ? "ON" : "OFF"}
                  </button>
                </div>

                <div style={settingRow}>
                  <div>
                    <div style={{ fontWeight: 900 }}>Default chiamate per nuovi membri</div>
                    <div style={{ marginTop: 4, color: "var(--muted)", fontSize: 13 }}>
                      Se ON, chi entra può usare le chiamate subito (a meno di override).
                    </div>
                  </div>
                  <button
                    className="ui-btn"
                    onClick={() => updateRoomSetting({ defaultCanCall: !(room?.defaultCanCall ?? true) })}
                  >
                    {room?.defaultCanCall ?? true ? "ON" : "OFF"}
                  </button>
                </div>

                <div style={settingRow}>
                  <div>
                    <div style={{ fontWeight: 900 }}>Blocca chat per tutti</div>
                    <div style={{ marginTop: 4, color: "var(--muted)", fontSize: 13 }}>
                      Se ON, solo l’admin può scrivere (override ignorati).
                    </div>
                  </div>
                  <button className="ui-btn" onClick={() => updateRoomSetting({ lockChat: !(room?.lockChat ?? false) })}>
                    {room?.lockChat ?? false ? "ON" : "OFF"}
                  </button>
                </div>

                <div style={settingRow}>
                  <div>
                    <div style={{ fontWeight: 900 }}>Blocca chiamate per tutti</div>
                    <div style={{ marginTop: 4, color: "var(--muted)", fontSize: 13 }}>
                      Se ON, solo l’admin può fare chiamate (override ignorati).
                    </div>
                  </div>
                  <button
                    className="ui-btn"
                    onClick={() => updateRoomSetting({ lockCalls: !(room?.lockCalls ?? false) })}
                  >
                    {room?.lockCalls ?? false ? "ON" : "OFF"}
                  </button>
                </div>

                <div style={{ borderTop: "2px solid var(--border)", paddingTop: 12 }}>
                  <div style={{ fontWeight: 900 }}>Membri (override)</div>
                  <div style={{ marginTop: 6, color: "var(--muted)", fontSize: 13 }}>
                    Qui puoi fare eccezioni sui singoli membri (override).
                  </div>

                  <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                    {members.map((m) => {
                      const isMe = user?.uid === m.uid;
                      const isAdminRow = m.role === "admin";

                      const chatLabel =
                        typeof m.canChat === "boolean" ? (m.canChat ? "ON" : "OFF") : "DEFAULT";
                      const callLabel =
                        typeof m.canCall === "boolean" ? (m.canCall ? "ON" : "OFF") : "DEFAULT";

                      return (
                        <div key={m.uid} style={memberRow}>
                          <div>
                            <div style={{ fontWeight: 900 }}>
                              {m.name} {isMe ? "(tu)" : ""} {isAdminRow ? "👑" : ""}
                            </div>
                            <div style={{ marginTop: 4, color: "var(--muted)", fontSize: 12 }}>
                              uid: {m.uid}
                            </div>
                          </div>

                          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                            <button
                              className="ui-btn"
                              onClick={async () => {
                                if (isAdminRow) return;
                                const next =
                                  typeof m.canChat === "boolean" ? !m.canChat : false;
                                await updateDoc(doc(db, "rooms", roomId, "members", m.uid), {
                                  canChat: next,
                                } as any);
                              }}
                              disabled={isAdminRow}
                              title={isAdminRow ? "Admin non modificabile" : ""}
                            >
                              Chat: <b>{chatLabel}</b>
                            </button>

                            <button
                              className="ui-btn"
                              onClick={async () => {
                                if (isAdminRow) return;
                                const next =
                                  typeof m.canCall === "boolean" ? !m.canCall : false;
                                await updateDoc(doc(db, "rooms", roomId, "members", m.uid), {
                                  canCall: next,
                                } as any);
                              }}
                              disabled={isAdminRow}
                              title={isAdminRow ? "Admin non modificabile" : ""}
                            >
                              Call: <b>{callLabel}</b>
                            </button>

                            <button
                              className="ui-btn"
                              onClick={async () => {
                                if (isAdminRow) return;
                                await updateDoc(doc(db, "rooms", roomId, "members", m.uid), {
                                  canChat: null,
                                  canCall: null,
                                } as any);
                              }}
                              disabled={isAdminRow}
                              title={isAdminRow ? "Admin non modificabile" : "Reset override → torna a DEFAULT"}
                            >
                              Reset override
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* CALLS */}
        <div className="ui-card" style={{ marginTop: 16 }}>
          <h2 style={{ fontWeight: 900 }}>Chiamata audio</h2>
          <p style={{ marginTop: 8, color: "var(--muted)" }}>
            Crea una chiamata e condividi il link. Chi apre il link e preme “Unisciti” entra in audio.
          </p>

          {!effectiveCanCall && (
            <div style={{ marginTop: 10, color: "var(--muted)" }}>
              ⚠️ In questa room non hai permesso per le chiamate.
            </div>
          )}

          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="ui-btn-primary" onClick={createCall} disabled={!user || !effectiveCanCall}>
              Crea chiamata
            </button>

            <button className="ui-btn" onClick={joinCall} disabled={!user || !effectiveCanCall || !callId}>
              Unisciti
            </button>

            <button className="ui-btn" onClick={hangUp} disabled={!callId && !pcRef.current}>
              Chiudi
            </button>
          </div>

          <div style={{ marginTop: 10, color: "var(--muted)" }}>{callStatus}</div>

          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 900 }}>Link chiamata</div>
            <div style={{ marginTop: 6, wordBreak: "break-all" }}>
              {callLink || "— (crea una chiamata per generare il link)"}
            </div>
            <button className="ui-btn" style={{ marginTop: 10 }} onClick={copyCallLink} disabled={!callLink}>
              Copia link
            </button>
          </div>

          <audio ref={remoteAudioRef} autoPlay />
        </div>

        {/* CHAT */}
        <div className="ui-card" style={{ marginTop: 16 }}>
          <h2 style={{ fontWeight: 900 }}>Chat</h2>

          {!effectiveCanChat && (
            <div style={{ marginTop: 10, color: "var(--muted)" }}>
              ⚠️ In questa room non hai permesso per scrivere in chat.
            </div>
          )}

          <div
            style={{
              marginTop: 10,
              border: "2px solid var(--border)",
              borderRadius: 12,
              padding: 12,
              height: 320,
              overflow: "auto",
              background: "transparent",
            }}
          >
            {messages.length === 0 ? (
              <div style={{ color: "var(--muted)" }}>Nessun messaggio. Scrivi il primo 👇</div>
            ) : (
              messages.map((m) => (
                <div key={m.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    <b style={{ color: "var(--text)" }}>{m.name}</b>
                  </div>
                  <div style={{ fontSize: 15 }}>{m.text}</div>
                </div>
              ))
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <input
              className="ui-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={effectiveCanChat ? "Scrivi un messaggio…" : "Non hai permessi"}
              disabled={!effectiveCanChat}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
            />
            <button className="ui-btn-primary" onClick={send} disabled={!effectiveCanChat}>
              Invia
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

const shell: React.CSSProperties = {
  display: "flex",
  gap: 12,
  padding: 12,
  maxWidth: 1300,
  margin: "0 auto",
};

const sidebar: React.CSSProperties = {
  width: 280,
  minWidth: 280,
  border: "2px solid var(--border)",
  background: "var(--card)",
  borderRadius: 14,
  padding: 12,
  height: "calc(100vh - 24px)",
  position: "sticky",
  top: 12,
  overflow: "auto",
};

const content: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  paddingBottom: 24,
};

const topBar: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  alignItems: "center",
};

const settingRow: React.CSSProperties = {
  border: "2px solid var(--border)",
  borderRadius: 12,
  padding: 12,
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "center",
};

const memberRow: React.CSSProperties = {
  border: "2px solid var(--border)",
  borderRadius: 12,
  padding: 12,
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "center",
};
