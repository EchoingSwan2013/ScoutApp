"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
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
  canChat?: boolean;
  canCall?: boolean;
  joinedAt?: any;
};

type CallDoc = {
  createdAt?: any;
  createdByUid?: string;
  offer?: any;
  answer?: any;
  status?: "open" | "connected" | "ended";
};

type VoiceStateDoc = {
  callId?: string | null;
  updatedAt?: any;
  updatedByUid?: string;
};

type VoiceMember = {
  uid: string;
  name: string;
  joinedAt?: any;
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
  const roomId = useMemo(() => {
    const parts = (pathname || "").split("/").filter(Boolean);
    return parts[1] || "";
  }, [pathname]);

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

  // VOICE ROOM STATE
  const [voiceCallId, setVoiceCallId] = useState<string | null>(null);
  const [voiceMembers, setVoiceMembers] = useState<VoiceMember[]>([]);
  const [voiceStatus, setVoiceStatus] = useState<string>("Vocale non attivo.");
  const [inVoice, setInVoice] = useState(false);

  // WebRTC
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

  // Load room and ensure defaults exist, then create member using defaults
  useEffect(() => {
    if (!roomId) return;

    const run = async () => {
      const snap = await getDoc(doc(db, "rooms", roomId));
      if (!snap.exists()) {
        setStatus("Room non trovata.");
        return;
      }

      const data0 = snap.data() as RoomData;

      const patch: Partial<RoomData> = {};
      if (typeof data0.defaultCanChat !== "boolean") patch.defaultCanChat = true;
      if (typeof data0.defaultCanCall !== "boolean") patch.defaultCanCall = true;
      if (typeof data0.lockChat !== "boolean") patch.lockChat = false;
      if (typeof data0.lockCalls !== "boolean") patch.lockCalls = false;

      if (Object.keys(patch).length > 0) {
        await updateDoc(doc(db, "rooms", roomId), patch as any);
      }

      const data: RoomData = { ...data0, ...patch };

      setRoom(data);
      setStatus("OK");

      upsertRoom({ id: roomId, name: data.name, joinCode: data.joinCode });
      setSavedRooms(loadSavedRooms());

      const u = auth.currentUser;
      if (u) {
        const isAdmin = data.adminUid === u.uid;
        await setDoc(
          doc(db, "rooms", roomId, "members", u.uid),
          {
            uid: u.uid,
            name: u.displayName ?? "utente",
            role: isAdmin ? "admin" : "member",
            canChat: isAdmin ? true : (data.defaultCanChat ?? true),
            canCall: isAdmin ? true : (data.defaultCanCall ?? true),
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

  const isAdmin = useMemo(() => myRole === "admin", [myRole]);

  // Effective permissions
  const effectiveCanChat = useMemo(() => {
    if (!user || !room) return false;
    if (isAdmin) return true;
    if (room.lockChat) return false;
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

  // -------- VOICE ROOM: Firestore state + members presence --------
  useEffect(() => {
    if (!roomId) return;

    const voiceRef = doc(db, "rooms", roomId, "voice", "current");
    const unsub = onSnapshot(voiceRef, (snap) => {
      if (!snap.exists()) {
        setVoiceCallId(null);
        setVoiceStatus("Vocale non attivo.");
        return;
      }
      const data = snap.data() as VoiceStateDoc;
      const cid = (data.callId ?? null) as any;
      setVoiceCallId(typeof cid === "string" ? cid : null);
      setVoiceStatus(typeof cid === "string" ? "Vocale attivo." : "Vocale non attivo.");
    });

    return () => unsub();
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;

    const q = query(collection(db, "rooms", roomId, "voiceMembers"), orderBy("joinedAt", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      const list: VoiceMember[] = snap.docs.map((d) => d.data() as any);
      setVoiceMembers(list);
    });

    return () => unsub();
  }, [roomId]);

  // -------- WebRTC (riusiamo la stessa logica ma senza link) --------
  const iceServers = useMemo(
    () => ({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] }),
    []
  );

  const cleanupCall = async () => {
    try {
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;

    try {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    localStreamRef.current = null;

    try {
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    } catch {}

    setInVoice(false);
  };

  const createCallDoc = async () => {
    if (!user) throw new Error("Not logged");
    const callRef = await addDoc(collection(db, "rooms", roomId, "calls"), {
      createdAt: serverTimestamp(),
      createdByUid: user.uid,
      status: "open",
    } as CallDoc);
    return callRef.id;
  };

  const startAsCaller = async (callId: string) => {
    if (!user) return;
    setVoiceStatus("Entro in vocale… (creo sessione)");

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

    const offerCandidates = collection(db, "rooms", roomId, "calls", callId, "offerCandidates");
    pc.onicecandidate = async (event) => {
      if (event.candidate) await addDoc(offerCandidates, event.candidate.toJSON());
    };

    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);

    await updateDoc(doc(db, "rooms", roomId, "calls", callId), {
      offer: { type: offerDescription.type, sdp: offerDescription.sdp },
    });

    // listen for answer
    onSnapshot(doc(db, "rooms", roomId, "calls", callId), async (snap) => {
      const data = snap.data() as any;
      if (!data) return;
      if (!pc.currentRemoteDescription && data.answer) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        setVoiceStatus("Connesso ✅ (audio)");
      }
      if (data.status === "ended") {
        setVoiceStatus("Vocale chiuso.");
        await cleanupCall();
      }
    });

    // listen for answer candidates
    const answerCandidates = collection(db, "rooms", roomId, "calls", callId, "answerCandidates");
    onSnapshot(answerCandidates, (snap) => {
      snap.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
          } catch {}
        }
      });
    });

    setInVoice(true);
    setVoiceStatus("In vocale ✅");
  };

  const joinAsCallee = async (callId: string) => {
    if (!user) return;
    setVoiceStatus("Entro in vocale… (mi unisco)");

    const callDocRef = doc(db, "rooms", roomId, "calls", callId);
    const callSnap = await getDoc(callDocRef);
    if (!callSnap.exists()) {
      setVoiceStatus("Sessione vocale non trovata.");
      return;
    }
    const callData = callSnap.data() as any;
    if (!callData.offer) {
      setVoiceStatus("Sessione non pronta (manca offer). Riprova tra 2 secondi.");
      return;
    }

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

    // offer candidates
    const offerCandidates = collection(db, "rooms", roomId, "calls", callId, "offerCandidates");
    onSnapshot(offerCandidates, (snap) => {
      snap.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
          } catch {}
        }
      });
    });

    // end handling
    onSnapshot(callDocRef, async (snap) => {
      const data = snap.data() as any;
      if (!data) return;
      if (data.status === "ended") {
        setVoiceStatus("Vocale chiuso.");
        await cleanupCall();
      }
    });

    setInVoice(true);
    setVoiceStatus("In vocale ✅");
  };

  const ensureVoiceStateDoc = async () => {
    const voiceRef = doc(db, "rooms", roomId, "voice", "current");
    const snap = await getDoc(voiceRef);
    if (!snap.exists()) {
      await setDoc(
        voiceRef,
        { callId: null, updatedAt: serverTimestamp(), updatedByUid: user?.uid ?? null } as VoiceStateDoc,
        { merge: true }
      );
    }
  };

  const enterVoice = async () => {
    if (!user || !roomId) return;
    if (!effectiveCanCall) {
      setVoiceStatus("Non hai permessi per il vocale in questa room.");
      return;
    }

    await ensureVoiceStateDoc();

    // presence
    await setDoc(
      doc(db, "rooms", roomId, "voiceMembers", user.uid),
      {
        uid: user.uid,
        name: user.displayName ?? "utente",
        joinedAt: serverTimestamp(),
      } as VoiceMember,
      { merge: true }
    );

    const voiceRef = doc(db, "rooms", roomId, "voice", "current");
    const snap = await getDoc(voiceRef);
    const data = snap.exists() ? (snap.data() as VoiceStateDoc) : { callId: null };

    // if no callId → create new call + set voice/current
    if (!data.callId) {
      setVoiceStatus("Creo stanza vocale…");
      const newCallId = await createCallDoc();
      await updateDoc(voiceRef, {
        callId: newCallId,
        updatedAt: serverTimestamp(),
        updatedByUid: user.uid,
      } as any);

      setVoiceCallId(newCallId);
      await startAsCaller(newCallId);
      return;
    }

    // else join existing
    const cid = data.callId as string;
    setVoiceCallId(cid);

    // se sono io che ho creato e non sono connesso, parto da caller solo se non esiste answer
    // (semplice: proviamo joinAsCallee; se non pronta, riproverà)
    await joinAsCallee(cid);
  };

  const exitVoice = async () => {
    if (!user || !roomId) return;

    // remove presence
    try {
      await deleteDoc(doc(db, "rooms", roomId, "voiceMembers", user.uid));
    } catch {}

    // hang up local
    await cleanupCall();
    setVoiceStatus("Sei uscito dal vocale.");
  };

  const closeVoiceForAll = async () => {
    if (!isAdmin || !roomId) return;
    const voiceRef = doc(db, "rooms", roomId, "voice", "current");
    const snap = await getDoc(voiceRef);
    const data = snap.exists() ? (snap.data() as VoiceStateDoc) : null;

    // end call doc
    if (data?.callId) {
      try {
        await updateDoc(doc(db, "rooms", roomId, "calls", data.callId), { status: "ended" } as any);
      } catch {}
    }

    // reset voice current
    await setDoc(
      voiceRef,
      { callId: null, updatedAt: serverTimestamp(), updatedByUid: user?.uid ?? null } as VoiceStateDoc,
      { merge: true }
    );

    setVoiceCallId(null);
    setVoiceStatus("Vocale chiuso per tutti.");
  };

  // Safety: on unload remove voice presence
  useEffect(() => {
    const handler = () => {
      try {
        const u = auth.currentUser;
        if (u && roomId) {
          // fire-and-forget
          deleteDoc(doc(db, "rooms", roomId, "voiceMembers", u.uid)).catch(() => {});
        }
      } catch {}
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [roomId]);

  const goToRoom = (id: string) => {
    window.location.href = `/room/${id}`;
  };

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
                        {r.joinCode ? (
                          <>
                            cod: <b>{r.joinCode}</b>
                          </>
                        ) : (
                          <>
                            id: <b>{r.id}</b>
                          </>
                        )}
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
              Chat: <b>{effectiveCanChat ? "OK" : "NO"}</b> • Vocale: <b>{effectiveCanCall ? "OK" : "NO"}</b>
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

        {/* ROOM SETTINGS */}
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
                  </div>
                  <button className="ui-btn" onClick={() => updateRoomSetting({ defaultCanChat: !(room?.defaultCanChat ?? true) })}>
                    {room?.defaultCanChat ?? true ? "ON" : "OFF"}
                  </button>
                </div>

                <div style={settingRow}>
                  <div>
                    <div style={{ fontWeight: 900 }}>Default vocale per nuovi membri</div>
                  </div>
                  <button className="ui-btn" onClick={() => updateRoomSetting({ defaultCanCall: !(room?.defaultCanCall ?? true) })}>
                    {room?.defaultCanCall ?? true ? "ON" : "OFF"}
                  </button>
                </div>

                <div style={settingRow}>
                  <div>
                    <div style={{ fontWeight: 900 }}>Blocca chat per tutti</div>
                  </div>
                  <button className="ui-btn" onClick={() => updateRoomSetting({ lockChat: !(room?.lockChat ?? false) })}>
                    {room?.lockChat ?? false ? "ON" : "OFF"}
                  </button>
                </div>

                <div style={settingRow}>
                  <div>
                    <div style={{ fontWeight: 900 }}>Blocca vocale per tutti</div>
                  </div>
                  <button className="ui-btn" onClick={() => updateRoomSetting({ lockCalls: !(room?.lockCalls ?? false) })}>
                    {room?.lockCalls ?? false ? "ON" : "OFF"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ✅ VOICE ROOM PANEL */}
        <div className="ui-card" style={{ marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>Vocale della Room</div>
              <div style={{ marginTop: 6, color: "var(--muted)" }}>
                {voiceStatus} {voiceCallId ? "• (attivo)" : "• (spento)"}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="ui-btn-primary" onClick={enterVoice} disabled={!user || !effectiveCanCall || inVoice}>
                Entra in vocale
              </button>
              <button className="ui-btn" onClick={exitVoice} disabled={!user || !inVoice}>
                Esci
              </button>

              {isAdmin && (
                <button className="ui-btn" onClick={closeVoiceForAll}>
                  Chiudi vocale (tutti)
                </button>
              )}
            </div>
          </div>

          {!effectiveCanCall && (
            <div style={{ marginTop: 10, color: "var(--muted)" }}>
              ⚠️ In questa room non hai permesso per il vocale.
            </div>
          )}

          <div style={{ marginTop: 12, borderTop: "2px solid var(--border)", paddingTop: 12 }}>
            <div style={{ fontWeight: 900 }}>In vocale adesso</div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {voiceMembers.length === 0 ? (
                <span className="ui-pill">nessuno</span>
              ) : (
                voiceMembers.map((m) => (
                  <span key={m.uid} className="ui-pill">
                    {m.name}
                  </span>
                ))
              )}
            </div>
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
