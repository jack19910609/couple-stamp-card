import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Clock3,
  Copy,
  Gift,
  Heart,
  LogOut,
  Plus,
  RefreshCw,
  Settings,
  Ticket,
  Undo2,
  UserRound,
  UsersRound,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "./src/lib/supabase.js";
import { cardProgress, formatRelativeTime, isTerminalOutboxError, isUndoable, upsertById } from "./src/lib/domain.js";
import { appendToQueue, readQueue, removeQueuedAction, writeQueue } from "./src/lib/offlineQueue.js";

function humanizeError(error) {
  const message = error?.message || String(error || "發生未知錯誤");
  const translations = [
    [/Invalid login credentials/i, "Email 或密碼不正確"],
    [/Email not confirmed/i, "請先至信箱完成驗證"],
    [/User already registered/i, "這個 Email 已經註冊"],
    [/Pairing code is invalid or expired/i, "配對碼無效或已過期"],
    [/already belong to a Couple Space/i, "你已經加入其他雙人空間"],
    [/already paired/i, "這個雙人空間已經完成配對"],
    [/own pairing code/i, "不能接受自己建立的配對碼"],
    [/undo window has expired/i, "十分鐘的復原時間已結束"],
    [/Card is already complete/i, "這張卡已經集滿"],
  ];
  return translations.find(([pattern]) => pattern.test(message))?.[1] || message;
}

function Brand({ compact = false }) {
  return (
    <header className={compact ? "brand brand--compact" : "brand"}>
      <div className="brand__eyebrow">TAIWAN LOVE STAMP CO.</div>
      <h1>愛的集點卡</h1>
    </header>
  );
}

function InitialAvatar({ name, small = false }) {
  return <span className={`avatar ${small ? "avatar--small" : ""}`}>{(name || "愛").trim().slice(0, 1)}</span>;
}

function ErrorNotice({ children, onRetry }) {
  if (!children) return null;
  return (
    <div className="notice notice--error" role="alert">
      <span>{children}</span>
      {onRetry && <button onClick={onRetry}>重試</button>}
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="app-shell app-shell--centered">
      <Brand />
      <RefreshCw className="spin" size={24} />
      <p className="muted">正在準備你們的空間…</p>
    </main>
  );
}

function SetupRequired() {
  return (
    <main className="app-shell app-shell--centered">
      <Brand />
      <section className="paper-card setup-card">
        <div className="seal">愛</div>
        <h2>還差 Supabase 連線設定</h2>
        <p>複製 <code>.env.example</code> 為 <code>.env.local</code>，填入 Project URL 與 Publishable Key，再重新啟動開發伺服器。</p>
        <p className="muted">資料表與安全規則請執行 supabase/migrations 內的 migration。</p>
      </section>
    </main>
  );
}

function useSession() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) {
        setSession(data.session);
        supabase.realtime.setAuth(data.session?.access_token || "");
        setLoading(false);
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      supabase.realtime.setAuth(nextSession?.access_token || "");
      setLoading(false);
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}

function AuthScreen() {
  const [mode, setMode] = useState("signup");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");
    if (mode === "signup" && !displayName.trim()) {
      setError("請先告訴我們怎麼稱呼你");
      return;
    }
    setBusy(true);
    const result = mode === "signup"
      ? await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { display_name: displayName.trim() },
            emailRedirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
          },
        })
      : await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (result.error) {
      setError(humanizeError(result.error));
      return;
    }
    if (mode === "signup" && !result.data.session) {
      setMessage("註冊完成！請到信箱點擊驗證連結，再回來登入。");
      setMode("login");
    }
  };

  return (
    <main className="app-shell auth-shell">
      <Brand />
      <section className="paper-card auth-card">
        <div className="seal">愛</div>
        <div className="segmented" aria-label="登入或註冊">
          <button className={mode === "signup" ? "is-active" : ""} onClick={() => setMode("signup")}>建立帳號</button>
          <button className={mode === "login" ? "is-active" : ""} onClick={() => setMode("login")}>登入</button>
        </div>
        <h2>{mode === "signup" ? "先從認識你開始" : "歡迎回來"}</h2>
        <p className="muted">每個人使用自己的帳號，再邀請另一半進入專屬空間。</p>
        <form onSubmit={submit} className="form-stack">
          {mode === "signup" && (
            <label>
              你的名稱
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={40} placeholder="例如：小安" autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" placeholder="you@example.com" />
          </label>
          <label>
            密碼
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder="至少 6 個字元" />
          </label>
          <ErrorNotice>{error}</ErrorNotice>
          {message && <div className="notice notice--success">{message}</div>}
          <button className="primary-button" disabled={busy}>{busy ? "處理中…" : mode === "signup" ? "建立我的帳號" : "登入"}</button>
        </form>
      </section>
    </main>
  );
}

function ProfileGate({ profile, onSaved }) {
  const [name, setName] = useState(profile?.display_name || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const { data, error: saveError } = await supabase
      .from("profiles")
      .upsert({ id: profile.id, display_name: name.trim() })
      .select()
      .single();
    setBusy(false);
    if (saveError) return setError(humanizeError(saveError));
    onSaved(data);
  };

  return (
    <main className="app-shell app-shell--centered">
      <Brand />
      <section className="paper-card setup-card">
        <InitialAvatar name={name} />
        <h2>設定你的名稱</h2>
        <p className="muted">另一半會在卡片與互動紀錄中看見這個名稱。</p>
        <form onSubmit={save} className="form-stack">
          <label>顯示名稱<input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoFocus /></label>
          <ErrorNotice>{error}</ErrorNotice>
          <button className="primary-button" disabled={busy || !name.trim()}>{busy ? "儲存中…" : "儲存並繼續"}</button>
        </form>
      </section>
    </main>
  );
}

function PairingScreen({ profile, membership, invite, onRefresh }) {
  const [mode, setMode] = useState(membership ? "invite" : "invite");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const createInvite = async () => {
    setBusy(true);
    setError("");
    const { error: rpcError } = await supabase.rpc("create_pairing_invite");
    setBusy(false);
    if (rpcError) return setError(humanizeError(rpcError));
    await onRefresh();
  };

  const acceptInvite = async (event) => {
    event.preventDefault();
    if (code.length !== 6) return;
    setBusy(true);
    setError("");
    const { error: rpcError } = await supabase.rpc("accept_pairing_invite", { submitted_code: code });
    setBusy(false);
    if (rpcError) return setError(humanizeError(rpcError));
    await onRefresh();
  };

  const copyCode = async () => {
    await navigator.clipboard.writeText(invite.invite_code || invite.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const displayCode = invite?.invite_code || invite?.code;
  return (
    <main className="app-shell pairing-shell">
      <Brand />
      <div className="identity-row">
        <span><InitialAvatar name={profile.display_name} small /> 嗨，{profile.display_name}</span>
        <button className="text-button" onClick={() => supabase.auth.signOut()}><LogOut size={15} /> 登出</button>
      </div>
      <section className="paper-card pairing-card">
        <div className="pairing-illustration"><UserRound /><Heart /><UserRound /></div>
        <h2>{membership ? "等待另一半加入" : "建立你們的專屬空間"}</h2>
        <p className="muted">邀請碼只能使用一次，並會在建立後 24 小時失效。</p>

        {!membership && (
          <div className="segmented">
            <button className={mode === "invite" ? "is-active" : ""} onClick={() => setMode("invite")}>邀請伴侶</button>
            <button className={mode === "join" ? "is-active" : ""} onClick={() => setMode("join")}>輸入配對碼</button>
          </div>
        )}

        {mode === "invite" || membership ? (
          displayCode ? (
            <div className="invite-panel">
              <span className="field-caption">你的六位配對碼</span>
              <strong className="invite-code">{displayCode}</strong>
              <button className="secondary-button" onClick={copyCode}><Copy size={17} /> {copied ? "已複製" : "複製配對碼"}</button>
              <p className="tiny">有效至 {new Date(invite.invite_expires_at || invite.expires_at).toLocaleString("zh-TW")}</p>
              <button className="text-button centered" onClick={createInvite} disabled={busy}><RefreshCw size={14} /> 重新產生並使舊碼失效</button>
            </div>
          ) : (
            <button className="primary-button" onClick={createInvite} disabled={busy}>{busy ? "建立中…" : "產生配對碼"}</button>
          )
        ) : (
          <form onSubmit={acceptInvite} className="form-stack join-form">
            <label>
              六位配對碼
              <input className="code-input" inputMode="numeric" pattern="[0-9]{6}" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" autoFocus />
            </label>
            <button className="primary-button" disabled={busy || code.length !== 6}>{busy ? "加入中…" : "加入 Couple Space"}</button>
          </form>
        )}
        <ErrorNotice>{error}</ErrorNotice>
      </section>
    </main>
  );
}

function SyncBadge({ online, realtimeStatus, queueLength, syncing, error, onRetry }) {
  if (!online) {
    return <button className="sync-badge sync-badge--offline" onClick={onRetry}><WifiOff size={14} /> 離線 · {queueLength ? `${queueLength} 筆待同步` : "可繼續瀏覽"}</button>;
  }
  if (error) {
    return <button className="sync-badge sync-badge--error" onClick={onRetry}><RefreshCw size={14} /> 同步失敗，點此重試</button>;
  }
  if (syncing || queueLength) {
    return <button className="sync-badge" onClick={onRetry}><RefreshCw className="spin" size={14} /> 同步中 · {queueLength} 筆待送出</button>;
  }
  if (realtimeStatus === "SUBSCRIBED") {
    return <span className="sync-badge sync-badge--ok"><Wifi size={14} /> 已同步</span>;
  }
  return <span className="sync-badge"><RefreshCw className="spin" size={14} /> 正在連線</span>;
}

function CreateCardModal({ spaceId, userId, onClose, onCreated }) {
  const [title, setTitle] = useState("");
  const [actionLabel, setActionLabel] = useState("");
  const [targetCount, setTargetCount] = useState(10);
  const [reward, setReward] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    const { data, error: insertError } = await supabase.from("cards").insert({
      space_id: spaceId,
      created_by: userId,
      title: title.trim(),
      action_label: actionLabel.trim(),
      target_count: Number(targetCount),
      reward: reward.trim(),
    }).select().single();
    setBusy(false);
    if (insertError) return setError(humanizeError(insertError));
    onCreated(data);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div className="modal-heading"><div><span className="eyebrow">共同累積</span><h2 id="create-title">建立新卡片</h2></div><button className="icon-button" onClick={onClose}><X /></button></div>
        <form onSubmit={submit} className="form-stack">
          <label>卡片名稱<input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：一起約會 10 次" autoFocus /></label>
          <label>什麼時候可以蓋章？<input required maxLength={100} value={actionLabel} onChange={(event) => setActionLabel(event.target.value)} placeholder="例如：完成一次約會" /></label>
          <label>共同目標次數<input type="number" min="2" max="100" required value={targetCount} onChange={(event) => setTargetCount(event.target.value)} /></label>
          <label>完成獎勵<input required maxLength={120} value={reward} onChange={(event) => setReward(event.target.value)} placeholder="例如：一起去週末小旅行" /></label>
          <div className="rule-preview"><UsersRound size={18} /><span>兩人的章會累積到同一個進度，共同達成 {Number(targetCount) || 0} 次。</span></div>
          <ErrorNotice>{error}</ErrorNotice>
          <button className="primary-button" disabled={busy}>{busy ? "建立中…" : "建立並同步給伴侶"}</button>
        </form>
      </section>
    </div>
  );
}

function StampModal({ card, onClose, onStamp }) {
  const [note, setNote] = useState("");
  const suggestions = [card.action_label, "今天一起完成了", "值得紀念的一次", "給我們一個愛心"];
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="stamp-title">
        <div className="modal-heading"><div><span className="eyebrow">留下這次互動</span><h2 id="stamp-title">蓋一個章</h2></div><button className="icon-button" onClick={onClose}><X /></button></div>
        <p className="muted">這段話會和時間、蓋章者一起保存在「{card.title}」的紀錄裡。</p>
        <div className="suggestion-row">{suggestions.map((item) => <button key={item} className={note === item ? "chip is-active" : "chip"} onClick={() => setNote(item)}>{item}</button>)}</div>
        <label className="standalone-label">這次想記下什麼？<textarea maxLength={280} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：下班後一起散步到河邊" autoFocus /></label>
        <button className="primary-button" disabled={!note.trim()} onClick={() => onStamp(note.trim())}><Ticket size={18} /> 蓋章並同步</button>
      </section>
    </div>
  );
}

function StampMark({ index, small = false }) {
  const rotations = [-7, 5, -10, 8, -4, 9, -6, 4, -9, 6];
  return <span className={`stamp-mark ${small ? "stamp-mark--small" : ""}`} style={{ transform: `rotate(${rotations[index % rotations.length]}deg)` }}>愛</span>;
}

function CardTile({ card, events, memberNames, onOpen }) {
  const progress = cardProgress(card, events);
  return (
    <button className="card-tile" onClick={onOpen}>
      <div className="card-tile__top"><span className="mode-pill"><UsersRound size={13} /> 共同卡</span><span>{progress.count}/{progress.target}</span></div>
      <h3>{card.title}</h3>
      <p>{card.action_label}</p>
      <div className="progress-track"><span style={{ width: `${Math.min(100, (progress.count / progress.target) * 100)}%` }} /></div>
      <div className="contributions">
        {Object.entries(memberNames).map(([id, name]) => <span key={id}><InitialAvatar name={name} small /> {progress.contributions[id] || 0}</span>)}
      </div>
      <div className="reward-line"><Gift size={14} /> {card.reward}</div>
      {progress.complete && <span className="complete-ribbon">集滿了</span>}
    </button>
  );
}

function EventItem({ event, memberNames, currentUserId, onUndo, showCard, cardTitle }) {
  const undone = Boolean(event.undone_at);
  const name = memberNames[event.actor_id] || "伴侶";
  return (
    <div className={`event-item ${undone ? "event-item--undone" : ""}`}>
      <InitialAvatar name={name} small />
      <div className="event-copy">
        <strong>{name}{undone ? " 復原了一個章" : " 蓋了一個章"}</strong>
        {showCard && <span>在「{cardTitle}」</span>}
        <p>{event.note}</p>
        <span className="event-time">{event.pending ? "等待同步" : formatRelativeTime(event.undone_at || event.occurred_at)}</span>
      </div>
      {!undone && isUndoable(event, currentUserId) && <button className="undo-button" onClick={() => onUndo(event)}><Undo2 size={14} /> 復原</button>}
    </div>
  );
}

function Dashboard({ user, accessToken, profile, space, members }) {
  const [cards, setCards] = useState([]);
  const [events, setEvents] = useState([]);
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [stampOpen, setStampOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [realtimeStatus, setRealtimeStatus] = useState("CONNECTING");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [outbox, setOutbox] = useState(() => readQueue(user.id));
  const outboxRef = useRef(outbox);
  const flushingRef = useRef(false);

  const memberNames = useMemo(() => Object.fromEntries(members.map((member) => [member.user_id, member.profile?.display_name || "伴侶"])), [members]);
  const partner = members.find((member) => member.user_id !== user.id);
  const selectedCard = cards.find((card) => card.id === selectedCardId) || null;

  const loadData = useCallback(async () => {
    setError("");
    const [cardsResult, eventsResult] = await Promise.all([
      supabase.from("cards").select("*").eq("space_id", space.id).eq("status", "active").order("created_at", { ascending: false }),
      supabase.from("stamp_events").select("*").eq("space_id", space.id).order("occurred_at", { ascending: false }),
    ]);
    setLoading(false);
    if (cardsResult.error || eventsResult.error) {
      setError(humanizeError(cardsResult.error || eventsResult.error));
      return;
    }
    setCards(cardsResult.data || []);
    setEvents((current) => {
      const pending = current.filter((item) => item.pending && !(eventsResult.data || []).some((saved) => saved.id === item.id));
      return [...pending, ...(eventsResult.data || [])];
    });
  }, [space.id]);

  const persistOutbox = useCallback((updater) => {
    setOutbox((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      outboxRef.current = next;
      writeQueue(user.id, next);
      return next;
    });
  }, [user.id]);

  const flushOutbox = useCallback(async () => {
    if (!navigator.onLine || flushingRef.current || outboxRef.current.length === 0) return;
    flushingRef.current = true;
    setSyncing(true);
    setError("");
    try {
      while (outboxRef.current.length && navigator.onLine) {
        const action = outboxRef.current[0];
        const request = action.type === "stamp"
          ? supabase.rpc("create_stamp_event", {
              event_id: action.event.id,
              target_card_id: action.event.card_id,
              event_note: action.event.note,
              event_occurred_at: action.event.occurred_at,
            }).single()
          : supabase.rpc("undo_stamp_event", {
              target_event_id: action.eventId,
              undo_requested_at: action.requestedAt,
            }).single();
        const { data, error: mutationError } = await request;
        if (mutationError) {
          if (!isTerminalOutboxError(mutationError)) throw mutationError;
          if (action.type === "stamp") {
            setEvents((current) => current.filter((event) => event.id !== action.event.id));
          } else {
            setEvents((current) => current.map((event) => event.id === action.eventId
              ? { ...event, undone_at: null, undone_by: null, pending: false }
              : event));
          }
          persistOutbox((current) => removeQueuedAction(user.id, current, action.id));
          setError(`${humanizeError(mutationError)}；這筆離線操作未送出。`);
          continue;
        }
        setEvents((current) => upsertById(current, { ...data, pending: false }));
        persistOutbox((current) => removeQueuedAction(user.id, current, action.id));
      }
    } catch (flushError) {
      setError(humanizeError(flushError));
    } finally {
      flushingRef.current = false;
      setSyncing(false);
    }
  }, [persistOutbox, user.id]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    let cancelled = false;
    let channel;
    const subscribe = async () => {
      await supabase.realtime.setAuth(accessToken);
      if (cancelled) return;
      channel = supabase
        .channel(`couple-space-${space.id}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "cards", filter: `space_id=eq.${space.id}` }, (payload) => {
          if (payload.eventType === "DELETE") setCards((current) => current.filter((item) => item.id !== payload.old.id));
          else setCards((current) => upsertById(current, payload.new));
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "stamp_events", filter: `space_id=eq.${space.id}` }, (payload) => {
          if (payload.eventType === "DELETE") setEvents((current) => current.filter((item) => item.id !== payload.old.id));
          else setEvents((current) => upsertById(current, { ...payload.new, pending: false }));
        })
        .subscribe((status) => setRealtimeStatus(status));
    };
    subscribe().catch((realtimeError) => setError(humanizeError(realtimeError)));
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [accessToken, space.id]);

  useEffect(() => {
    const goOnline = () => { setOnline(true); window.setTimeout(flushOutbox, 0); };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [flushOutbox]);

  useEffect(() => { if (online && outbox.length) flushOutbox(); }, [online, outbox.length, flushOutbox]);

  const addStamp = (note) => {
    if (!selectedCard) return;
    const progress = cardProgress(selectedCard, events);
    if (progress.complete) return setError("這張卡已經集滿");
    const event = {
      id: crypto.randomUUID(),
      card_id: selectedCard.id,
      space_id: space.id,
      actor_id: user.id,
      note,
      occurred_at: new Date().toISOString(),
      undone_at: null,
      undone_by: null,
      pending: true,
    };
    setEvents((current) => [event, ...current]);
    persistOutbox((current) => appendToQueue(user.id, current, { id: crypto.randomUUID(), type: "stamp", event }));
    setStampOpen(false);
  };

  const undoStamp = (event) => {
    const undoneAt = new Date().toISOString();
    setEvents((current) => current.map((item) => item.id === event.id ? { ...item, undone_at: undoneAt, undone_by: user.id, pending: true } : item));
    persistOutbox((current) => appendToQueue(user.id, current, {
      id: crypto.randomUUID(),
      type: "undo",
      eventId: event.id,
      requestedAt: undoneAt,
    }));
  };

  const handleCreated = (card) => {
    setCards((current) => upsertById(current, card));
    setCreateOpen(false);
    setSelectedCardId(card.id);
  };

  if (loading) return <LoadingScreen />;

  const recentEvents = events.slice(0, 6);
  const selectedEvents = selectedCard ? events.filter((event) => event.card_id === selectedCard.id) : [];
  const selectedProgress = selectedCard ? cardProgress(selectedCard, events) : null;

  return (
    <main className="app-shell dashboard-shell">
      <Brand compact />
      <div className="topbar">
        <div className="couple-identity">
          <span className="avatar-pair"><InitialAvatar name={profile.display_name} small /><InitialAvatar name={partner?.profile?.display_name} small /></span>
          <span><strong>{profile.display_name} × {partner?.profile?.display_name || "伴侶"}</strong><small>Couple Space</small></span>
        </div>
        <button className="icon-button" aria-label="設定" onClick={() => setSettingsOpen(true)}><Settings size={20} /></button>
      </div>
      <div className="sync-row"><SyncBadge online={online} realtimeStatus={realtimeStatus} queueLength={outbox.length} syncing={syncing} error={error} onRetry={flushOutbox} /></div>
      {error && <ErrorNotice onRetry={() => { loadData(); flushOutbox(); }}>{error}</ErrorNotice>}

      {selectedCard ? (
        <section className="detail-view">
          <button className="back-button" onClick={() => setSelectedCardId(null)}><ArrowLeft size={17} /> 返回首頁</button>
          <div className="detail-heading"><span className="mode-pill"><UsersRound size={13} /> 共同卡</span><h2>{selectedCard.title}</h2><p>{selectedCard.action_label}</p></div>
          <section className="stamp-card">
            {selectedProgress.complete && <span className="complete-ribbon complete-ribbon--large">集滿了！</span>}
            <div className="stamp-grid">
              {Array.from({ length: selectedCard.target_count }).map((_, index) => (
                <span className="stamp-slot" key={index}>{index < selectedProgress.count && <StampMark index={index} />}</span>
              ))}
            </div>
            <div className="detail-progress"><strong>{selectedProgress.count}</strong> / {selectedProgress.target} 次</div>
            <div className="progress-track progress-track--large"><span style={{ width: `${Math.min(100, (selectedProgress.count / selectedProgress.target) * 100)}%` }} /></div>
            <div className="member-contribution-grid">
              {members.map((member) => <div key={member.user_id}><InitialAvatar name={member.profile?.display_name} /><span>{member.profile?.display_name}</span><strong>{selectedProgress.contributions[member.user_id] || 0} 次</strong></div>)}
            </div>
            <div className="reward-box"><Gift /><span><small>完成獎勵</small><strong>{selectedCard.reward}</strong></span></div>
            <button className={selectedProgress.complete ? "primary-button primary-button--complete" : "primary-button"} disabled={selectedProgress.complete} onClick={() => setStampOpen(true)}>
              {selectedProgress.complete ? <><Check size={18} /> 已完成共同目標</> : <><Ticket size={18} /> 蓋一個章</>}
            </button>
          </section>
          <section className="section-block">
            <div className="section-title"><div><span className="eyebrow">TRACEABLE MOMENTS</span><h3>最近蓋章紀錄</h3></div><Clock3 size={20} /></div>
            {selectedEvents.length ? selectedEvents.map((event) => <EventItem key={event.id} event={event} memberNames={memberNames} currentUserId={user.id} onUndo={undoStamp} />) : <div className="empty-inline">還沒有紀錄，蓋下第一個章吧。</div>}
          </section>
        </section>
      ) : (
        <>
          <section className="welcome-panel">
            <div><span className="eyebrow">OUR LITTLE PROGRESS</span><h2>一起完成的小事，<br />都值得被記住。</h2></div>
            <Heart className="welcome-heart" fill="currentColor" />
          </section>
          <section className="section-block cards-section">
            <div className="section-title"><div><span className="eyebrow">IN PROGRESS</span><h3>進行中的卡片</h3></div><button className="round-add" onClick={() => online ? setCreateOpen(true) : setError("離線時暫時無法建立新卡片")}><Plus /></button></div>
            {cards.length ? <div className="card-grid">{cards.map((card) => <CardTile key={card.id} card={card} events={events} memberNames={memberNames} onOpen={() => setSelectedCardId(card.id)} />)}</div> : (
              <button className="empty-card" onClick={() => setCreateOpen(true)}><span className="empty-card__icon"><Plus /></span><strong>建立你們的第一張共同卡</strong><span>選一件想一起完成的小事</span></button>
            )}
          </section>
          <section className="section-block">
            <div className="section-title"><div><span className="eyebrow">RECENT MOMENTS</span><h3>最近互動</h3></div><Clock3 size={20} /></div>
            {recentEvents.length ? recentEvents.map((event) => <EventItem key={event.id} event={event} memberNames={memberNames} currentUserId={user.id} onUndo={undoStamp} showCard cardTitle={cards.find((card) => card.id === event.card_id)?.title || "共同卡"} />) : <div className="empty-inline">你們的第一個互動會出現在這裡。</div>}
          </section>
        </>
      )}

      {createOpen && <CreateCardModal spaceId={space.id} userId={user.id} onClose={() => setCreateOpen(false)} onCreated={handleCreated} />}
      {stampOpen && selectedCard && <StampModal card={selectedCard} onClose={() => setStampOpen(false)} onStamp={addStamp} />}
      {settingsOpen && <SettingsModal profile={profile} onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}

function SettingsModal({ profile, onClose }) {
  const [name, setName] = useState(profile.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    const { error: saveError } = await supabase.from("profiles").update({ display_name: name.trim() }).eq("id", profile.id);
    setBusy(false);
    if (saveError) return setError(humanizeError(saveError));
    window.location.reload();
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-sheet" role="dialog" aria-modal="true">
        <div className="modal-heading"><div><span className="eyebrow">MY PROFILE</span><h2>設定</h2></div><button className="icon-button" onClick={onClose}><X /></button></div>
        <form onSubmit={save} className="form-stack">
          <label>顯示名稱<input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} required /></label>
          <ErrorNotice>{error}</ErrorNotice>
          <button className="primary-button" disabled={busy}>{busy ? "儲存中…" : "儲存名稱"}</button>
          <button type="button" className="secondary-button danger-button" onClick={() => supabase.auth.signOut()}><LogOut size={17} /> 登出帳號</button>
        </form>
      </section>
    </div>
  );
}

function AuthenticatedApp({ session }) {
  const [profile, setProfile] = useState(null);
  const [membership, setMembership] = useState(null);
  const [members, setMembers] = useState([]);
  const [invite, setInvite] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refreshIdentity = useCallback(async () => {
    setError("");
    const userId = session.user.id;
    const profileResult = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (profileResult.error) {
      setError(humanizeError(profileResult.error));
      setLoading(false);
      return;
    }
    const resolvedProfile = profileResult.data || { id: userId, display_name: session.user.user_metadata?.display_name || "" };
    setProfile(resolvedProfile);

    const membershipResult = await supabase.from("couple_members").select("space_id, joined_at").eq("user_id", userId).maybeSingle();
    if (membershipResult.error) {
      setError(humanizeError(membershipResult.error));
      setLoading(false);
      return;
    }
    setMembership(membershipResult.data);
    if (!membershipResult.data) {
      setMembers([]);
      setInvite(null);
      setLoading(false);
      return;
    }

    const spaceId = membershipResult.data.space_id;
    const [membersResult, inviteResult] = await Promise.all([
      supabase.from("couple_members").select("user_id, joined_at, profile:profiles!couple_members_user_id_fkey(id, display_name, avatar_url)").eq("space_id", spaceId).order("joined_at"),
      supabase.from("pairing_invites").select("*").eq("space_id", spaceId).is("used_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (membersResult.error || inviteResult.error) setError(humanizeError(membersResult.error || inviteResult.error));
    setMembers(membersResult.data || []);
    setInvite(inviteResult.data);
    setLoading(false);
  }, [session.user.id, session.user.user_metadata]);

  useEffect(() => { refreshIdentity(); }, [refreshIdentity]);

  if (loading) return <LoadingScreen />;
  if (error && !profile) return <main className="app-shell app-shell--centered"><Brand /><ErrorNotice onRetry={refreshIdentity}>{error}</ErrorNotice></main>;
  if (!profile?.display_name) return <ProfileGate profile={profile} onSaved={(saved) => { setProfile(saved); refreshIdentity(); }} />;
  if (!membership || members.length < 2) return <PairingScreen profile={profile} membership={membership} invite={invite} onRefresh={refreshIdentity} />;
  return <Dashboard user={session.user} accessToken={session.access_token} profile={profile} space={{ id: membership.space_id }} members={members} />;
}

export default function CoupleStampCard() {
  if (!isSupabaseConfigured) return <SetupRequired />;
  return <SessionRouter />;
}

function SessionRouter() {
  const { session, loading } = useSession();
  if (loading) return <LoadingScreen />;
  return session ? <AuthenticatedApp session={session} /> : <AuthScreen />;
}
