import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Bell,
  Check,
  Clock3,
  Copy,
  CopyPlus,
  Gift,
  Heart,
  LogOut,
  Medal,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Send,
  Ticket,
  Trophy,
  Undo2,
  UserRound,
  UsersRound,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "./src/lib/supabase.js";
import { CARD_MODE_LABELS, cardProgress, formatRelativeTime, isTerminalOutboxError, isUndoable, upsertById } from "./src/lib/domain.js";
import { appendToQueue, readQueue, removeQueuedAction, replaceQueuedReaction, writeQueue } from "./src/lib/offlineQueue.js";
import { currentPushSubscription, pushPermission, pushSupport, subscribeToPush, unsubscribeFromPush } from "./src/lib/push.js";

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
    [/Both people must be unpaired before reconnecting/i, "你們必須都還沒有新的配對，才能重新連結"],
    [/Recovery is only available to the original two people/i, "只有原本的兩人可以重新連結"],
    [/The recovery period has ended/i, "這段關係的 30 天恢復期限已結束"],
    [/No active Couple Space found/i, "找不到可結束的共同空間"],
    [/No pending pairing invite found/i, "目前沒有可取消的配對邀請"],
    [/Pending Couple Space is already paired/i, "對方剛剛已加入，正在為你開啟共同首頁"],
    [/Pending Couple Space contains records/i, "這次邀請已經有資料，無法直接取消"],
    [/Pending pairing invite cannot be cancelled/i, "這次邀請目前無法取消，請重新整理後再試"],
    [/Only the assigned partner can stamp/i, "這張個人卡只能由指定的伴侶蓋章"],
    [/Existing progress requires confirmation/i, "已有蓋章紀錄，請先確認規則變更的影響"],
    [/Reward redemption is already in progress/i, "獎勵正在兌換流程中，暫時不能修改規則"],
    [/Card reward is not ready/i, "卡片完成後才能申請兌換獎勵"],
    [/other partner must confirm reward redemption/i, "需要由另一位伴侶確認已兌換"],
    [/Cannot undo after reward redemption/i, "已進入獎勵兌換流程，不能再復原這個章"],
    [/undo window has expired/i, "十分鐘的復原時間已結束"],
    [/Card is already complete/i, "這張卡已經集滿"],
    [/A comment between/i, "留言須介於 1 到 300 個字元"],
    [/Comment ID already belongs/i, "這則留言和先前操作衝突，請再試一次"],
    [/Reaction is not supported/i, "只支援目前提供的表情回應"],
    [/Notification not found/i, "這則通知已不存在"],
    [/Push permission was not granted/i, "通知權限尚未允許，請在瀏覽器或手機設定中開啟"],
    [/Push is not_configured/i, "原生通知服務正在設定中，請稍後再試"],
    [/Push is insecure/i, "原生通知需要透過安全網站使用"],
    [/Push is unsupported/i, "這個瀏覽器目前不支援原生通知"],
    [/Push subscription .* invalid/i, "通知裝置資料無效，請重新啟用"],
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

const CARD_MODE_DESCRIPTIONS = {
  personal: "指定一人累積，另一人可以關注進度。",
  shared: "兩人的章會累積到同一個共同目標。",
  competition: "兩人各自累積，先達成目標者獲勝。",
};

const REACTION_CHOICES = ["❤️", "👏", "🥰", "💪"];

function pushTargetFromUrl(value = window.location.href) {
  const url = new URL(value, window.location.origin);
  const target = {
    spaceId: url.searchParams.get("space"),
    notificationId: url.searchParams.get("notification"),
    cardId: url.searchParams.get("card"),
    eventId: url.searchParams.get("event"),
  };
  return target.spaceId || target.notificationId || target.cardId || target.eventId ? target : null;
}

function clearPushTargetFromUrl() {
  const url = new URL(window.location.href);
  ["space", "notification", "card", "event"].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function ModeIcon({ mode, size = 13 }) {
  if (mode === "personal") return <UserRound size={size} />;
  if (mode === "competition") return <Trophy size={size} />;
  return <UsersRound size={size} />;
}

function RewardStatus({ card, currentUserId }) {
  if (!card.completed_at && !card.winner_id) return null;
  if (card.reward_state === "redeemed") return <span className="reward-status reward-status--done"><Check size={13} /> 已兌換</span>;
  if (card.reward_state === "requested") return <span className="reward-status"><Clock3 size={13} /> {card.reward_requested_by === currentUserId ? "等待伴侶確認" : "待你確認兌換"}</span>;
  return <span className="reward-status"><Gift size={13} /> 可申請兌換</span>;
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

function PairingScreen({ profile, membership, invite, archives, onOpenArchive, onRefresh }) {
  const [mode, setMode] = useState("invite");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  useEffect(() => {
    if (!membership?.space_id) return undefined;

    const checkPairingStatus = () => { onRefresh(); };
    const timer = window.setInterval(checkPairingStatus, 2_000);
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") checkPairingStatus();
    };
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [membership?.space_id, onRefresh]);

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

  const cancelPendingPairing = async () => {
    const { error: rpcError } = await supabase.rpc("cancel_pending_pairing");
    if (rpcError) {
      // A partner may have accepted the code while the confirmation sheet was
      // open. Refresh first so that successful pairing wins over a stale error.
      await onRefresh();
      throw rpcError;
    }
    setCancelOpen(false);
    setCode("");
    setMode("join");
    await onRefresh();
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
        {membership && <p className="tiny">對方完成配對後，這個畫面會自動進入你們的首頁。</p>}

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
        {membership && <button className="text-button centered pairing-cancel-button" disabled={busy} onClick={() => setCancelOpen(true)}><X size={14} /> 取消這次邀請</button>}
        <ErrorNotice>{error}</ErrorNotice>
      </section>
      {archives.length > 0 && (
        <section className="archive-preview">
          <div><span className="eyebrow">SAVED MEMORIES</span><h3>封存回憶</h3><p className="tiny">只有你與原本的伴侶可以查看這些紀錄。</p>
            <div className="archive-preview__list">{archives.map((archive, index) => <button className="text-button" key={archive.id} onClick={() => onOpenArchive(archive)}>封存空間 {index + 1}{archive.ended_at ? ` · ${formatRelativeTime(archive.ended_at)}` : ""}</button>)}</div>
          </div>
        </section>
      )}
      {cancelOpen && <CancelPendingPairingModal onClose={() => setCancelOpen(false)} onCancelled={cancelPendingPairing} />}
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

function useModalScrollLock() {
  useEffect(() => {
    document.body.classList.add("has-modal");
    return () => document.body.classList.remove("has-modal");
  }, []);
}

function CancelPendingPairingModal({ onClose, onCancelled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useModalScrollLock();

  const cancel = async () => {
    setBusy(true);
    setError("");
    try {
      await onCancelled();
    } catch (cancelError) {
      setBusy(false);
      setError(humanizeError(cancelError));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="cancel-pairing-title">
        <div className="modal-heading"><div><span className="eyebrow">PENDING INVITATION</span><h2 id="cancel-pairing-title">取消這次邀請？</h2></div><button className="icon-button" aria-label="關閉" disabled={busy} onClick={onClose}><X /></button></div>
        <div className="danger-panel">
          <strong>這只會刪除尚未配對的一人草稿空間與未使用配對碼。</strong>
          <p>不會影響已配對的共同空間、卡片、封存回憶或恢復配對紀錄。取消後，你可以改輸入另一半的配對碼。</p>
        </div>
        <div className="action-stack">
          <button className="primary-button danger-primary" disabled={busy} onClick={cancel}>{busy ? "取消中…" : "確認取消邀請"}</button>
          <button className="secondary-button" disabled={busy} onClick={onClose}>保留這次邀請</button>
        </div>
        <ErrorNotice>{error}</ErrorNotice>
      </section>
    </div>
  );
}

function CreateCardModal({ spaceId, userId, members, onClose, onCreated }) {
  const [mode, setMode] = useState("shared");
  const [participantId, setParticipantId] = useState(userId);
  const [title, setTitle] = useState("");
  const [actionLabel, setActionLabel] = useState("");
  const [targetCount, setTargetCount] = useState(10);
  const [reward, setReward] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useModalScrollLock();

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    const { data, error: insertError } = await supabase.rpc("create_card", {
      target_space_id: spaceId,
      card_mode: mode,
      card_participant_id: mode === "personal" ? participantId : null,
      card_title: title.trim(),
      card_action_label: actionLabel.trim(),
      card_target_count: Number(targetCount),
      card_reward: reward.trim(),
    });
    setBusy(false);
    if (insertError) return setError(humanizeError(insertError));
    onCreated(Array.isArray(data) ? data[0] : data);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div className="modal-heading"><div><span className="eyebrow">NEW LITTLE GOAL</span><h2 id="create-title">建立新卡片</h2></div><button className="icon-button" aria-label="關閉" onClick={onClose}><X /></button></div>
        <form onSubmit={submit} className="form-stack">
          <label>卡片模式
            <select value={mode} onChange={(event) => setMode(event.target.value)}>
              {Object.entries(CARD_MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {mode === "personal" && <label>這張卡由誰累積？
            <select value={participantId} onChange={(event) => setParticipantId(event.target.value)}>
              {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.profile?.display_name || "伴侶"}</option>)}
            </select>
          </label>}
          <label>卡片名稱<input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：一起約會 10 次" autoFocus /></label>
          <label>什麼時候可以蓋章？<input required maxLength={100} value={actionLabel} onChange={(event) => setActionLabel(event.target.value)} placeholder="例如：完成一次約會" /></label>
          <label>{mode === "competition" ? "每人目標次數" : "目標次數"}<input type="number" min="2" max="100" required value={targetCount} onChange={(event) => setTargetCount(event.target.value)} /></label>
          <label>完成獎勵<input required maxLength={120} value={reward} onChange={(event) => setReward(event.target.value)} placeholder="例如：一起去週末小旅行" /></label>
          <div className="rule-preview"><ModeIcon mode={mode} size={18} /><span>{CARD_MODE_DESCRIPTIONS[mode]}{mode === "competition" ? ` 率先完成 ${Number(targetCount) || 0} 次者獲勝。` : ""}</span></div>
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
  useModalScrollLock();
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="stamp-title">
        <div className="modal-heading"><div><span className="eyebrow">留下這次互動</span><h2 id="stamp-title">蓋一個章</h2></div><button className="icon-button" aria-label="關閉" onClick={onClose}><X /></button></div>
        <p className="muted">這段話會和時間、蓋章者一起保存在「{card.title}」的紀錄裡。</p>
        <div className="suggestion-row">{suggestions.map((item) => <button key={item} className={note === item ? "chip is-active" : "chip"} onClick={() => setNote(item)}>{item}</button>)}</div>
        <label className="standalone-label">這次想記下什麼？<textarea maxLength={280} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：下班後一起散步到河邊" autoFocus /></label>
        <button className="primary-button" disabled={!note.trim()} onClick={() => onStamp(note.trim())}><Ticket size={18} /> 蓋章並同步</button>
      </section>
    </div>
  );
}

function EditCardModal({ card, members, events, onClose, onSaved }) {
  const [mode, setMode] = useState(card.mode || "shared");
  const [participantId, setParticipantId] = useState(card.participant_id || members[0]?.user_id || "");
  const [title, setTitle] = useState(card.title);
  const [actionLabel, setActionLabel] = useState(card.action_label);
  const [targetCount, setTargetCount] = useState(card.target_count);
  const [reward, setReward] = useState(card.reward);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hasHistory = events.some((event) => event.card_id === card.id);
  useModalScrollLock();

  const submit = async (event) => {
    event.preventDefault();
    if (hasHistory && !acknowledged) return setError("請先確認了解這會影響已有進度的解讀。");
    setBusy(true);
    setError("");
    const { data, error: rpcError } = await supabase.rpc("update_card_rules", {
      target_card_id: card.id,
      next_mode: mode,
      next_participant_id: mode === "personal" ? participantId : null,
      next_title: title.trim(),
      next_action_label: actionLabel.trim(),
      next_target_count: Number(targetCount),
      next_reward: reward.trim(),
      acknowledge_existing_progress: acknowledged,
    });
    setBusy(false);
    if (rpcError) return setError(humanizeError(rpcError));
    onSaved(Array.isArray(data) ? data[0] : data);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="edit-card-title">
        <div className="modal-heading"><div><span className="eyebrow">CARD RULES</span><h2 id="edit-card-title">編輯卡片規則</h2></div><button className="icon-button" aria-label="關閉" onClick={onClose}><X /></button></div>
        <form onSubmit={submit} className="form-stack">
          <label>卡片模式<select value={mode} onChange={(event) => setMode(event.target.value)}>{Object.entries(CARD_MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {mode === "personal" && <label>累積者<select value={participantId} onChange={(event) => setParticipantId(event.target.value)}>{members.map((member) => <option key={member.user_id} value={member.user_id}>{member.profile?.display_name || "伴侶"}</option>)}</select></label>}
          <label>卡片名稱<input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>蓋章條件<input required maxLength={100} value={actionLabel} onChange={(event) => setActionLabel(event.target.value)} /></label>
          <label>{mode === "competition" ? "每人目標次數" : "目標次數"}<input type="number" min="2" max="100" required value={targetCount} onChange={(event) => setTargetCount(event.target.value)} /></label>
          <label>完成獎勵<input required maxLength={120} value={reward} onChange={(event) => setReward(event.target.value)} /></label>
          {hasHistory && <label className="impact-confirm"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> 我了解調整模式、參加者或目標會改變既有蓋章的進度解讀；系統會保留這次規則變更紀錄。</label>}
          <ErrorNotice>{error}</ErrorNotice>
          <button className="primary-button" disabled={busy}>{busy ? "儲存中…" : "儲存規則變更"}</button>
        </form>
      </section>
    </div>
  );
}

function CardActionsModal({ card, onClose, onEdit, onCopy, onArchive }) {
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useModalScrollLock();
  const archive = async () => {
    if (!confirmArchive) return setConfirmArchive(true);
    setBusy(true);
    setError("");
    try { await onArchive(); } catch (archiveError) { setBusy(false); setError(humanizeError(archiveError)); }
  };
  const copy = async () => {
    setBusy(true);
    setError("");
    try { await onCopy(); } catch (copyError) { setBusy(false); setError(humanizeError(copyError)); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="card-actions-title">
        <div className="modal-heading"><div><span className="eyebrow">CARD LIFECYCLE</span><h2 id="card-actions-title">管理「{card.title}」</h2></div><button className="icon-button" aria-label="關閉" onClick={onClose}><X /></button></div>
        <div className="action-stack">
          <button className="secondary-button" disabled={busy || card.reward_state === "requested" || card.reward_state === "redeemed"} onClick={onEdit}><Pencil size={17} /> 編輯規則</button>
          <button className="secondary-button" disabled={busy} onClick={copy}><CopyPlus size={17} /> 複製成新一輪</button>
          <button className="secondary-button danger-button" disabled={busy} onClick={archive}><Archive size={17} /> {confirmArchive ? "再次點擊，確認封存為唯讀" : "封存這張卡片"}</button>
        </div>
        <p className="tiny">封存不會刪除紀錄，會保留在你們的封存回憶中。</p>
        <ErrorNotice>{error}</ErrorNotice>
      </section>
    </div>
  );
}

function NotificationCenterModal({ notifications, memberNames, onClose, onOpenNotification, onMarkAllRead }) {
  const [busy, setBusy] = useState(false);
  useModalScrollLock();
  const unreadCount = notifications.filter((notification) => !notification.read_at).length;
  const copy = (notification) => {
    const actor = memberNames[notification.actor_id] || "伴侶";
    const title = notification.data?.title ? `「${notification.data.title}」` : "這張卡片";
    const labels = {
      card_created: `${actor} 建立了 ${title}`,
      stamp_created: `${actor} 蓋了一個章`,
      card_completed: `${actor} 完成了 ${title}`,
      comment_created: `${actor} 留下了一則回覆`,
      reaction_created: `${actor} 回應了 ${notification.data?.emoji || "表情"}`,
      reward_requested: `${actor} 申請兌換 ${title} 的獎勵`,
      reward_redeemed: `${actor} 確認 ${title} 的獎勵已兌換`,
    };
    return labels[notification.kind] || `${actor} 更新了互動`;
  };
  const markAll = async () => {
    setBusy(true);
    await onMarkAllRead();
    setBusy(false);
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-sheet notification-sheet" role="dialog" aria-modal="true" aria-labelledby="notifications-title">
        <div className="modal-heading"><div><span className="eyebrow">JUST FOR YOU</span><h2 id="notifications-title">互動通知</h2></div><button className="icon-button" aria-label="關閉" onClick={onClose}><X /></button></div>
        {unreadCount > 0 && <button className="text-button notification-read-all" disabled={busy} onClick={markAll}><Check size={16} /> 全部標示為已讀</button>}
        <div className="notification-list">
          {notifications.length ? notifications.map((notification) => <button className={`notification-item ${notification.read_at ? "" : "notification-item--unread"}`} key={notification.id} onClick={() => onOpenNotification(notification)}><InitialAvatar name={memberNames[notification.actor_id] || "伴侶"} small /><span className="notification-copy"><strong>{copy(notification)}</strong>{notification.data?.body && <small>{notification.data.body}</small>}{notification.data?.note && <small>{notification.data.note}</small>}<time>{formatRelativeTime(notification.created_at)}</time></span>{!notification.read_at && <i aria-label="未讀" />}</button>) : <div className="empty-inline">目前沒有新的互動通知。</div>}
        </div>
      </section>
    </div>
  );
}

function CardActivityItem({ activity, memberNames }) {
  const labels = {
    created: "建立了這張卡片",
    rules_changed: "更新了卡片規則",
    completed: "完成了這張卡片",
    competition_won: "鎖定了競賽結果",
    reopened: "復原蓋章並重新開啟卡片",
    archived: "封存了這張卡片",
    copied: "複製了這張卡片",
    reward_requested: "申請兌換獎勵",
    reward_redeemed: "確認獎勵已兌換",
  };
  const name = memberNames[activity.actor_id] || "伴侶";
  return <div className="activity-item"><InitialAvatar name={name} small /><span className="activity-copy"><strong>{name} {labels[activity.kind] || "更新了卡片"}</strong><small>{formatRelativeTime(activity.created_at)}</small></span></div>;
}

function StampMark({ index, tone = "red" }) {
  const rotations = [-7, 5, -10, 8, -4, 9, -6, 4, -9, 6];
  return <span className={`stamp-mark stamp-mark--${tone}`} style={{ transform: `rotate(${rotations[index % rotations.length]}deg)` }}>愛</span>;
}

function CompetitionRace({ members, contributions, target, winnerId, currentUserId }) {
  const scores = members.map((member) => contributions[member.user_id] || 0);
  const leadingScore = Math.max(0, ...scores);
  const leaderCount = scores.filter((score) => score === leadingScore && score > 0).length;

  return (
    <div className="competition-race" aria-label="競賽雙方進度">
      {members.map((member) => {
        const score = contributions[member.user_id] || 0;
        const isWinner = winnerId === member.user_id;
        const isLeader = !winnerId && score === leadingScore && leadingScore > 0;
        const status = isWinner ? "獲勝" : isLeader ? (leaderCount > 1 ? "並列領先" : "目前領先") : null;
        const tone = member.user_id === currentUserId ? "red" : "gold";
        const name = member.profile?.display_name || "伴侶";
        return (
          <section className={`race-lane race-lane--${tone}${isWinner ? " race-lane--winner" : ""}`} key={member.user_id}>
            <div className="race-lane__header">
              <div className="race-lane__identity"><InitialAvatar name={name} /><strong>{name}</strong>{member.user_id === currentUserId && <span>你</span>}</div>
              <div className="race-lane__score"><strong>{score}</strong><span> / {target}</span>{status && <em>{status}</em>}</div>
            </div>
            <div className="race-stamp-grid" aria-label={`${name} 已累積 ${score} / ${target} 點`}>
              {Array.from({ length: target }).map((_, index) => <span className="race-stamp-slot" key={index}>{index < score && <StampMark index={index} tone={tone} />}</span>)}
            </div>
            <div className="progress-track race-lane__progress"><span style={{ width: `${Math.min(100, (score / target) * 100)}%` }} /></div>
          </section>
        );
      })}
    </div>
  );
}

function CardTile({ card, events, memberNames, currentUserId, onOpen }) {
  const progress = cardProgress(card, events);
  const mode = progress.mode;
  const competitionScores = Object.keys(memberNames).map((id) => progress.contributions[id] || 0);
  const headlineProgress = mode === "competition" ? `比分 ${competitionScores.join(" : ")}` : `${progress.count}/${progress.target}`;
  return (
    <button className="card-tile" onClick={onOpen}>
      <div className="card-tile__top"><span className="mode-pill"><ModeIcon mode={mode} /> {CARD_MODE_LABELS[mode]}</span><span>{headlineProgress}</span></div>
      <h3>{card.title}</h3>
      <p>{card.action_label}</p>
      {mode !== "competition" && <div className="progress-track"><span style={{ width: `${Math.min(100, (progress.count / progress.target) * 100)}%` }} /></div>}
      <div className={`contributions ${mode === "competition" ? "contributions--race" : ""}`}>
        {Object.entries(memberNames).map(([id, name]) => <span key={id}><InitialAvatar name={name} small /> {progress.contributions[id] || 0}</span>)}
      </div>
      <div className="reward-line"><Gift size={14} /> {card.reward}</div>
      <RewardStatus card={card} currentUserId={currentUserId} />
      {progress.complete && <span className="complete-ribbon">{mode === "competition" ? "勝負已定" : "集滿了"}</span>}
    </button>
  );
}

function EventItem({ event, memberNames, currentUserId, onUndo, showCard, cardTitle, comments = [], reactions = [], onAddComment, onSetReaction, readOnly = false, highlighted = false }) {
  const undone = Boolean(event.undone_at);
  const name = memberNames[event.actor_id] || "伴侶";
  const [commentDraft, setCommentDraft] = useState("");
  const eventComments = comments.filter((comment) => comment.event_id === event.id);
  const eventReactions = reactions.filter((reaction) => reaction.event_id === event.id);
  const ownReaction = eventReactions.find((reaction) => reaction.actor_id === currentUserId)?.emoji || null;
  const canInteract = !readOnly && !event.pending;
  const addComment = (submitEvent) => {
    submitEvent.preventDefault();
    const body = commentDraft.trim();
    if (!body || !onAddComment) return;
    onAddComment(event, body);
    setCommentDraft("");
  };
  return (
    <div className={`event-item ${undone ? "event-item--undone" : ""} ${highlighted ? "event-item--highlighted" : ""}`}>
      <InitialAvatar name={name} small />
      <div className="event-copy">
        <strong>{name}{undone ? " 復原了一個章" : " 蓋了一個章"}</strong>
        {showCard && <span>在「{cardTitle}」</span>}
        <p>{event.note}</p>
        <span className="event-time">{event.pending ? "等待同步" : formatRelativeTime(event.undone_at || event.occurred_at)}</span>
        <div className="event-reactions" aria-label="表情回應">
          {REACTION_CHOICES.map((emoji) => {
            const count = eventReactions.filter((reaction) => reaction.emoji === emoji).length;
            return <button type="button" disabled={!canInteract} aria-pressed={ownReaction === emoji} className={ownReaction === emoji ? "is-active" : ""} key={emoji} onClick={() => onSetReaction?.(event, ownReaction === emoji ? null : emoji)}>{emoji}{count ? <small>{count}</small> : null}</button>;
          })}
        </div>
        {eventComments.length > 0 && <div className="comment-list">{eventComments.map((comment) => <div className="comment-item" key={comment.id}><InitialAvatar name={memberNames[comment.author_id] || "伴侶"} small /><span className="comment-copy"><strong>{memberNames[comment.author_id] || "伴侶"}</strong><p>{comment.body}</p><time>{comment.pending ? "等待同步" : formatRelativeTime(comment.created_at)}</time></span></div>)}</div>}
        {canInteract && <form className="comment-form" onSubmit={addComment}><label className="sr-only" htmlFor={`comment-${event.id}`}>回覆這次蓋章</label><input id={`comment-${event.id}`} maxLength={300} value={commentDraft} onChange={(inputEvent) => setCommentDraft(inputEvent.target.value)} placeholder="留下一句回覆…" /><button aria-label="送出回覆" disabled={!commentDraft.trim()}><Send size={15} /></button></form>}
      </div>
      {!readOnly && !undone && isUndoable(event, currentUserId) && <button className="undo-button" onClick={() => onUndo(event)}><Undo2 size={14} /> 復原</button>}
    </div>
  );
}

function Dashboard({ user, accessToken, profile, space, members, onOpenArchive, onRelationshipChanged, pushTarget, onPushTargetHandled }) {
  const [cards, setCards] = useState([]);
  const [events, setEvents] = useState([]);
  const [activities, setActivities] = useState([]);
  const [comments, setComments] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [highlightedEventId, setHighlightedEventId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [stampOpen, setStampOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [cardActionsOpen, setCardActionsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [endSpaceOpen, setEndSpaceOpen] = useState(false);
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
  const unreadNotificationCount = notifications.filter((notification) => !notification.read_at).length;

  // A queued reaction represents the user's newest desired state. Keep that
  // local state visible when a background fetch or an earlier Realtime event
  // arrives before the queued operation is acknowledged by Supabase.
  const mergeReactionsWithQueue = useCallback((serverRows, currentRows = []) => {
    const queuedByEvent = new Map(outboxRef.current
      .filter((action) => action.type === "reaction")
      .map((action) => [action.eventId, action]));
    const confirmed = serverRows.filter((reaction) => !(reaction.actor_id === user.id && queuedByEvent.has(reaction.event_id)));
    const optimistic = [...queuedByEvent.values()].flatMap((action) => {
      if (!action.emoji) return [];
      const local = currentRows.find((reaction) => reaction.event_id === action.eventId && reaction.actor_id === user.id);
      const desired = action.reaction || local;
      return desired ? [{ ...desired, emoji: action.emoji, pending: true }] : [];
    });
    return [...optimistic, ...confirmed];
  }, [user.id]);

  const loadData = useCallback(async () => {
    setError("");
    const [cardsResult, eventsResult, activitiesResult, commentsResult, reactionsResult, notificationsResult] = await Promise.all([
      supabase.from("cards").select("*").eq("space_id", space.id).eq("status", "active").order("created_at", { ascending: false }),
      supabase.from("stamp_events").select("*").eq("space_id", space.id).order("occurred_at", { ascending: false }),
      supabase.from("card_activity_events").select("*").eq("space_id", space.id).order("created_at", { ascending: false }),
      supabase.from("stamp_comments").select("*").eq("space_id", space.id).order("created_at"),
      supabase.from("stamp_reactions").select("*").eq("space_id", space.id).order("updated_at"),
      supabase.from("user_notifications").select("*").eq("space_id", space.id).eq("recipient_id", user.id).order("created_at", { ascending: false }).limit(50),
    ]);
    setLoading(false);
    if (cardsResult.error || eventsResult.error || activitiesResult.error || commentsResult.error || reactionsResult.error || notificationsResult.error) {
      setError(humanizeError(cardsResult.error || eventsResult.error || activitiesResult.error || commentsResult.error || reactionsResult.error || notificationsResult.error));
      return;
    }
    setCards(cardsResult.data || []);
    setEvents((current) => {
      const pending = current.filter((item) => item.pending && !(eventsResult.data || []).some((saved) => saved.id === item.id));
      return [...pending, ...(eventsResult.data || [])];
    });
    setActivities(activitiesResult.data || []);
    setComments((current) => {
      const pending = current.filter((item) => item.pending && !(commentsResult.data || []).some((saved) => saved.id === item.id));
      return [...pending, ...(commentsResult.data || [])];
    });
    setReactions((current) => mergeReactionsWithQueue(reactionsResult.data || [], current));
    setNotifications(notificationsResult.data || []);
  }, [mergeReactionsWithQueue, space.id, user.id]);

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
        let request;
        if (action.type === "stamp") {
          request = supabase.rpc("create_stamp_event", {
              event_id: action.event.id,
              target_card_id: action.event.card_id,
              event_note: action.event.note,
              event_occurred_at: action.event.occurred_at,
            }).single();
        } else if (action.type === "undo") {
          request = supabase.rpc("undo_stamp_event", {
              target_event_id: action.eventId,
              undo_requested_at: action.requestedAt,
            }).single();
        } else if (action.type === "comment") {
          request = supabase.rpc("create_stamp_comment", {
            comment_id: action.comment.id,
            target_event_id: action.comment.event_id,
            comment_body: action.comment.body,
          }).single();
        } else {
          request = supabase.rpc("set_stamp_reaction", {
            target_event_id: action.eventId,
            next_emoji: action.emoji,
          });
        }
        const { data, error: mutationError } = await request;
        if (mutationError) {
          if (!isTerminalOutboxError(mutationError)) throw mutationError;
          if (action.type === "stamp") {
            setEvents((current) => current.filter((event) => event.id !== action.event.id));
          } else if (action.type === "undo") {
            setEvents((current) => current.map((event) => event.id === action.eventId
              ? { ...event, undone_at: null, undone_by: null, pending: false }
              : event));
          } else if (action.type === "comment") {
            setComments((current) => current.filter((comment) => comment.id !== action.comment.id));
          } else {
            setReactions((current) => {
              const withoutCurrent = current.filter((reaction) => !(reaction.event_id === action.eventId && reaction.actor_id === user.id));
              return action.previousReaction ? [...withoutCurrent, { ...action.previousReaction, pending: false }] : withoutCurrent;
            });
          }
          persistOutbox((current) => removeQueuedAction(user.id, current, action.id));
          setError(`${humanizeError(mutationError)}；這筆離線操作未送出。`);
          continue;
        }
        if (action.type === "stamp" || action.type === "undo") {
          setEvents((current) => upsertById(current, { ...data, pending: false }));
        } else if (action.type === "comment") {
          setComments((current) => upsertById(current, { ...data, pending: false }));
        } else {
          const reaction = Array.isArray(data) ? data[0] : data;
          const hasNewerReaction = outboxRef.current.some((item) => item.type === "reaction" && item.eventId === action.eventId && item.id !== action.id);
          if (!hasNewerReaction) {
            setReactions((current) => {
              const withoutCurrent = current.filter((item) => !(item.event_id === action.eventId && item.actor_id === user.id));
              return reaction ? [...withoutCurrent, { ...reaction, pending: false }] : withoutCurrent;
            });
          }
        }
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
          else if (payload.new.status !== "active") {
            setCards((current) => current.filter((item) => item.id !== payload.new.id));
            setSelectedCardId((current) => current === payload.new.id ? null : current);
          } else setCards((current) => upsertById(current, payload.new));
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "stamp_events", filter: `space_id=eq.${space.id}` }, (payload) => {
          if (payload.eventType === "DELETE") setEvents((current) => current.filter((item) => item.id !== payload.old.id));
          else setEvents((current) => upsertById(current, { ...payload.new, pending: false }));
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "card_activity_events", filter: `space_id=eq.${space.id}` }, (payload) => {
          if (payload.eventType === "DELETE") setActivities((current) => current.filter((item) => item.id !== payload.old.id));
          else setActivities((current) => upsertById(current, payload.new));
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "stamp_comments", filter: `space_id=eq.${space.id}` }, (payload) => {
          if (payload.eventType === "DELETE") setComments((current) => current.filter((item) => item.id !== payload.old.id));
          else setComments((current) => upsertById(current, { ...payload.new, pending: false }));
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "stamp_reactions", filter: `space_id=eq.${space.id}` }, (payload) => {
          if (payload.eventType === "DELETE") setReactions((current) => current.filter((item) => item.id !== payload.old.id));
          else setReactions((current) => {
            const queuedReaction = payload.new.actor_id === user.id && outboxRef.current.find((action) => action.type === "reaction" && action.eventId === payload.new.event_id);
            if (queuedReaction) return current;
            return [
              { ...payload.new, pending: false },
              ...current.filter((item) => !(item.event_id === payload.new.event_id && item.actor_id === payload.new.actor_id)),
            ];
          });
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "user_notifications", filter: `recipient_id=eq.${user.id}` }, (payload) => {
          if (payload.eventType === "DELETE") setNotifications((current) => current.filter((item) => item.id !== payload.old.id));
          else if (payload.eventType === "INSERT") setNotifications((current) => [payload.new, ...current.filter((item) => item.id !== payload.new.id)]);
          else setNotifications((current) => upsertById(current, payload.new));
        })
        .subscribe((status) => setRealtimeStatus(status));
    };
    subscribe().catch((realtimeError) => setError(humanizeError(realtimeError)));
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [accessToken, mergeReactionsWithQueue, space.id, user.id]);

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
    if (progress.mode === "personal" && selectedCard.participant_id !== user.id) return setError("這張個人卡由指定的伴侶累積，你可以關注進度。 ");
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

  const addComment = (event, body) => {
    const comment = {
      id: crypto.randomUUID(),
      event_id: event.id,
      card_id: event.card_id,
      space_id: space.id,
      author_id: user.id,
      body,
      created_at: new Date().toISOString(),
      pending: true,
    };
    setComments((current) => [...current, comment]);
    persistOutbox((current) => appendToQueue(user.id, current, { id: crypto.randomUUID(), type: "comment", comment }));
  };

  const setReaction = (event, emoji) => {
    const currentReaction = reactions.find((reaction) => reaction.event_id === event.id && reaction.actor_id === user.id) || null;
    const queuedReaction = outboxRef.current.find((action) => action.type === "reaction" && action.eventId === event.id);
    const nextReaction = emoji ? {
      id: currentReaction?.id || crypto.randomUUID(),
      event_id: event.id,
      card_id: event.card_id,
      space_id: space.id,
      actor_id: user.id,
      emoji,
      created_at: currentReaction?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pending: true,
    } : null;
    setReactions((current) => {
      const withoutCurrent = current.filter((reaction) => !(reaction.event_id === event.id && reaction.actor_id === user.id));
      return nextReaction ? [...withoutCurrent, nextReaction] : withoutCurrent;
    });
    persistOutbox((current) => replaceQueuedReaction(user.id, current, {
      id: crypto.randomUUID(),
      type: "reaction",
      eventId: event.id,
      emoji,
      reaction: nextReaction,
      previousReaction: queuedReaction ? queuedReaction.previousReaction : currentReaction,
    }));
  };

  const markNotificationRead = async (notification) => {
    if (notification.read_at) return notification;
    const { data, error: rpcError } = await supabase.rpc("mark_notification_read", { target_notification_id: notification.id }).single();
    if (rpcError) throw rpcError;
    const updated = Array.isArray(data) ? data[0] : data;
    setNotifications((current) => upsertById(current, updated));
    return updated;
  };

  const markAllNotificationsRead = async () => {
    const { error: rpcError } = await supabase.rpc("mark_all_notifications_read", { target_space_id: space.id });
    if (rpcError) return setError(humanizeError(rpcError));
    const now = new Date().toISOString();
    setNotifications((current) => current.map((notification) => notification.read_at ? notification : { ...notification, read_at: now }));
  };

  const openNotification = async (notification) => {
    try {
      await markNotificationRead(notification);
    } catch (notificationError) {
      setError(humanizeError(notificationError));
    }
    setNotificationsOpen(false);
    setHighlightedEventId(notification.stamp_event_id || null);
    if (notification.card_id && cards.some((card) => card.id === notification.card_id)) {
      setSelectedCardId(notification.card_id);
    } else if (notification.card_id) {
      onOpenArchive({ id: space.id, status: "active", focusEventId: notification.stamp_event_id || null });
    }
  };

  useEffect(() => {
    if (!pushTarget || pushTarget.spaceId !== space.id) return;
    if (pushTarget.notificationId) {
      supabase.rpc("mark_notification_read", { target_notification_id: pushTarget.notificationId })
        .then(({ data, error: readError }) => {
          if (!readError && data) setNotifications((current) => upsertById(current, Array.isArray(data) ? data[0] : data));
        });
    }
    if (!pushTarget.cardId) {
      onPushTargetHandled();
      return;
    }
    if (cards.some((card) => card.id === pushTarget.cardId)) {
      setHighlightedEventId(pushTarget.eventId || null);
      setSelectedCardId(pushTarget.cardId);
      onPushTargetHandled();
    } else if (!loading) {
      onOpenArchive({ id: space.id, status: "active", focusEventId: pushTarget.eventId || null });
      onPushTargetHandled();
    }
  }, [cards, loading, onOpenArchive, onPushTargetHandled, pushTarget, space.id]);

  const handleCreated = (card) => {
    setCards((current) => upsertById(current, card));
    setCreateOpen(false);
    setSelectedCardId(card.id);
  };

  const handleCardUpdated = (card) => {
    setCards((current) => upsertById(current, card));
    setEditOpen(false);
    setCardActionsOpen(false);
  };

  const requestReward = async () => {
    if (!selectedCard) return;
    const { data, error: rpcError } = await supabase.rpc("request_reward_redemption", { target_card_id: selectedCard.id });
    if (rpcError) return setError(humanizeError(rpcError));
    handleCardUpdated(Array.isArray(data) ? data[0] : data);
  };

  const confirmReward = async () => {
    if (!selectedCard) return;
    const { data, error: rpcError } = await supabase.rpc("confirm_reward_redemption", { target_card_id: selectedCard.id });
    if (rpcError) return setError(humanizeError(rpcError));
    handleCardUpdated(Array.isArray(data) ? data[0] : data);
  };

  const copySelectedCard = async () => {
    if (!selectedCard) return;
    const { data, error: rpcError } = await supabase.rpc("copy_card", { target_card_id: selectedCard.id });
    if (rpcError) throw rpcError;
    const copiedCard = Array.isArray(data) ? data[0] : data;
    setCards((current) => upsertById(current, copiedCard));
    setCardActionsOpen(false);
    setSelectedCardId(copiedCard.id);
  };

  const archiveSelectedCard = async () => {
    if (!selectedCard) return;
    const { error: rpcError } = await supabase.rpc("archive_card", { target_card_id: selectedCard.id });
    if (rpcError) throw rpcError;
    setCards((current) => current.filter((card) => card.id !== selectedCard.id));
    setCardActionsOpen(false);
    setSelectedCardId(null);
  };

  const endSpace = async () => {
    const { error: endError } = await supabase.rpc("end_couple_space");
    if (endError) throw endError;
    await onRelationshipChanged();
  };

  if (loading) return <LoadingScreen />;

  const recentEvents = events.slice(0, 6);
  const selectedEvents = selectedCard ? events.filter((event) => event.card_id === selectedCard.id) : [];
  const selectedActivities = selectedCard ? activities.filter((activity) => activity.card_id === selectedCard.id) : [];
  const selectedProgress = selectedCard ? cardProgress(selectedCard, events) : null;

  return (
    <main className="app-shell dashboard-shell">
      <Brand compact />
      <div className="topbar">
        <div className="couple-identity">
          <span className="avatar-pair"><InitialAvatar name={profile.display_name} small /><InitialAvatar name={partner?.profile?.display_name} small /></span>
          <span><strong>{profile.display_name} × {partner?.profile?.display_name || "伴侶"}</strong><small>Couple Space</small></span>
        </div>
        <div className="topbar-actions"><button className="icon-button notification-button" aria-label={`互動通知${unreadNotificationCount ? `，${unreadNotificationCount} 則未讀` : ""}`} onClick={() => setNotificationsOpen(true)}><Bell size={20} />{unreadNotificationCount > 0 && <span>{unreadNotificationCount > 9 ? "9+" : unreadNotificationCount}</span>}</button><button className="icon-button" aria-label="設定" onClick={() => setSettingsOpen(true)}><Settings size={20} /></button></div>
      </div>
      <div className="sync-row"><SyncBadge online={online} realtimeStatus={realtimeStatus} queueLength={outbox.length} syncing={syncing} error={error} onRetry={flushOutbox} /></div>
      {error && <ErrorNotice onRetry={() => { loadData(); flushOutbox(); }}>{error}</ErrorNotice>}

      {selectedCard ? (
        <section className="detail-view">
          <button className="back-button" onClick={() => { setSelectedCardId(null); setHighlightedEventId(null); }}><ArrowLeft size={17} /> 返回首頁</button>
          <div className="detail-heading"><span className="mode-pill"><ModeIcon mode={selectedProgress.mode} /> {CARD_MODE_LABELS[selectedProgress.mode]}</span><button className="detail-actions" onClick={() => setCardActionsOpen(true)} aria-label="管理卡片"><Settings size={17} /></button><h2>{selectedCard.title}</h2><p>{selectedCard.action_label}</p></div>
          <section className="stamp-card">
            {selectedProgress.complete && <span className="complete-ribbon complete-ribbon--large">{selectedProgress.mode === "competition" ? "勝負已定！" : "集滿了！"}</span>}
            {selectedProgress.mode === "competition" ? <CompetitionRace members={members} contributions={selectedProgress.contributions} target={selectedProgress.target} winnerId={selectedCard.winner_id} currentUserId={user.id} /> : <>
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
            </>}
            {selectedProgress.mode === "personal" && <p className="mode-explainer">由 {memberNames[selectedCard.participant_id] || "指定伴侶"} 累積這張個人卡。</p>}
            {selectedProgress.mode === "competition" && selectedCard.winner_id && <p className="mode-explainer mode-explainer--winner"><Medal size={16} /> {memberNames[selectedCard.winner_id] || "伴侶"} 率先達成目標。</p>}
            <div className="reward-box"><Gift /><span><small>完成獎勵</small><strong>{selectedCard.reward}</strong></span></div>
            {selectedCard.reward_state === "ready" && <button className="primary-button primary-button--complete" onClick={requestReward}><Gift size={18} /> 申請兌換獎勵</button>}
            {selectedCard.reward_state === "requested" && selectedCard.reward_requested_by !== user.id && <button className="primary-button primary-button--complete" onClick={confirmReward}><Check size={18} /> 確認已兌換獎勵</button>}
            {selectedCard.reward_state === "requested" && selectedCard.reward_requested_by === user.id && <div className="reward-waiting"><Clock3 size={17} /> 已申請，等待 {partner?.profile?.display_name || "伴侶"} 確認</div>}
            {selectedCard.reward_state === "redeemed" && <div className="reward-waiting"><Check size={17} /> 獎勵已由 {memberNames[selectedCard.reward_redeemed_by] || "伴侶"} 確認兌換</div>}
            {!selectedProgress.complete && <button className="primary-button" disabled={selectedProgress.mode === "personal" && selectedCard.participant_id !== user.id} onClick={() => setStampOpen(true)}><Ticket size={18} /> {selectedProgress.mode === "personal" && selectedCard.participant_id !== user.id ? "由指定伴侶蓋章" : "蓋一個章"}</button>}
          </section>
          <section className="section-block">
            <div className="section-title"><div><span className="eyebrow">TRACEABLE MOMENTS</span><h3>最近蓋章紀錄</h3></div><Clock3 size={20} /></div>
            {selectedEvents.length ? selectedEvents.map((event) => <EventItem key={event.id} event={event} memberNames={memberNames} currentUserId={user.id} onUndo={undoStamp} comments={comments} reactions={reactions} onAddComment={addComment} onSetReaction={setReaction} highlighted={highlightedEventId === event.id} />) : <div className="empty-inline">還沒有紀錄，蓋下第一個章吧。</div>}
          </section>
          <section className="section-block">
            <div className="section-title"><div><span className="eyebrow">CARD LIFECYCLE</span><h3>規則與獎勵紀錄</h3></div><Clock3 size={20} /></div>
            {selectedActivities.length ? selectedActivities.map((activity) => <CardActivityItem key={activity.id} activity={activity} memberNames={memberNames} />) : <div className="empty-inline">這張卡的變更會保留在這裡。</div>}
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
            {cards.length ? <div className="card-grid">{cards.map((card) => <CardTile key={card.id} card={card} events={events} memberNames={memberNames} currentUserId={user.id} onOpen={() => setSelectedCardId(card.id)} />)}</div> : (
              <button className="empty-card" onClick={() => setCreateOpen(true)}><span className="empty-card__icon"><Plus /></span><strong>建立你們的第一張共同卡</strong><span>選一件想一起完成的小事</span></button>
            )}
          </section>
          <section className="section-block">
            <div className="section-title"><div><span className="eyebrow">RECENT MOMENTS</span><h3>最近互動</h3></div><Clock3 size={20} /></div>
            {recentEvents.length ? recentEvents.map((event) => <EventItem key={event.id} event={event} memberNames={memberNames} currentUserId={user.id} onUndo={undoStamp} showCard cardTitle={cards.find((card) => card.id === event.card_id)?.title || "共同卡"} comments={comments} reactions={reactions} onAddComment={addComment} onSetReaction={setReaction} />) : <div className="empty-inline">你們的第一個互動會出現在這裡。</div>}
          </section>
        </>
      )}

      {createOpen && <CreateCardModal spaceId={space.id} userId={user.id} members={members} onClose={() => setCreateOpen(false)} onCreated={handleCreated} />}
      {stampOpen && selectedCard && <StampModal card={selectedCard} onClose={() => setStampOpen(false)} onStamp={addStamp} />}
      {editOpen && selectedCard && <EditCardModal card={selectedCard} members={members} events={events} onClose={() => setEditOpen(false)} onSaved={handleCardUpdated} />}
      {cardActionsOpen && selectedCard && <CardActionsModal card={selectedCard} onClose={() => setCardActionsOpen(false)} onEdit={() => { setCardActionsOpen(false); setEditOpen(true); }} onCopy={copySelectedCard} onArchive={archiveSelectedCard} />}
      {notificationsOpen && <NotificationCenterModal notifications={notifications} memberNames={memberNames} onClose={() => setNotificationsOpen(false)} onOpenNotification={openNotification} onMarkAllRead={markAllNotificationsRead} />}
      {settingsOpen && <SettingsModal profile={profile} space={space} onClose={() => setSettingsOpen(false)} onOpenArchive={onOpenArchive} onEndSpace={() => { setSettingsOpen(false); setEndSpaceOpen(true); }} />}
      {endSpaceOpen && <EndSpaceModal onClose={() => setEndSpaceOpen(false)} onEnded={endSpace} />}
    </main>
  );
}

function EndSpaceModal({ onClose, onEnded }) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useModalScrollLock();

  const submit = async (event) => {
    event.preventDefault();
    if (confirmation !== "結束") return;
    setBusy(true);
    setError("");
    try {
      await onEnded();
    } catch (endError) {
      setBusy(false);
      setError(humanizeError(endError));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="end-space-title">
        <div className="modal-heading"><div><span className="eyebrow">RELATIONSHIP SETTINGS</span><h2 id="end-space-title">結束共同空間</h2></div><button className="icon-button" aria-label="關閉" onClick={onClose}><X /></button></div>
        <div className="danger-panel">
          <strong>這會立即停止雙方的共享與蓋章。</strong>
          <p>進行中的卡片會封存為唯讀回憶；原本兩人可在 30 天內透過配對碼重新連結，但新伴侶永遠不會看到這些舊紀錄。</p>
        </div>
        <form onSubmit={submit} className="form-stack">
          <label>輸入「結束」以確認<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoFocus /></label>
          <ErrorNotice>{error}</ErrorNotice>
          <button className="primary-button danger-primary" disabled={busy || confirmation !== "結束"}>{busy ? "封存中…" : "結束並封存共同空間"}</button>
          <button type="button" className="text-button centered" onClick={onClose} disabled={busy}>返回，不做變更</button>
        </form>
      </section>
    </div>
  );
}

function PushNotificationSettings() {
  const [support] = useState(() => pushSupport());
  const [permission, setPermission] = useState(() => pushPermission());
  const [preference, setPreference] = useState({ push_enabled: false, card_updates: true, stamp_updates: true, interaction_updates: true, reward_updates: true });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: preferenceError } = await supabase.from("notification_preferences")
      .select("push_enabled, card_updates, stamp_updates, interaction_updates, reward_updates")
      .maybeSingle();
    setLoading(false);
    if (preferenceError) return setError(humanizeError(preferenceError));
    if (data) setPreference(data);
    setPermission(pushPermission());
  }, []);

  useEffect(() => { load(); }, [load]);

  const enable = async () => {
    setBusy(true);
    setError("");
    try {
      const subscription = await subscribeToPush();
      const { error: enableError } = await supabase.rpc("enable_push_notifications", {
        subscription_endpoint: subscription.endpoint,
        subscription_p256dh: subscription.p256dh,
        subscription_auth: subscription.auth,
        subscription_device_label: navigator.userAgent.slice(0, 120),
      });
      if (enableError) throw enableError;
      setPreference((current) => ({ ...current, push_enabled: true }));
      setPermission(pushPermission());
    } catch (enableError) {
      setError(humanizeError(enableError));
      setPermission(pushPermission());
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError("");
    try {
      const existing = await currentPushSubscription();
      const { error: disableError } = await supabase.rpc("disable_push_notifications", {
        subscription_endpoint: existing?.endpoint || null,
      });
      if (disableError) throw disableError;
      await unsubscribeFromPush();
      setPreference((current) => ({ ...current, push_enabled: false }));
    } catch (disableError) {
      setError(humanizeError(disableError));
    } finally {
      setBusy(false);
    }
  };

  const updatePreference = async (key, value) => {
    const next = { ...preference, [key]: value };
    setPreference(next);
    const { data, error: updateError } = await supabase.rpc("update_push_notification_preferences", {
      next_card_updates: next.card_updates,
      next_stamp_updates: next.stamp_updates,
      next_interaction_updates: next.interaction_updates,
      next_reward_updates: next.reward_updates,
    }).single();
    if (updateError) {
      setPreference(preference);
      return setError(humanizeError(updateError));
    }
    setPreference(Array.isArray(data) ? data[0] : data);
  };

  const reason = {
    unsupported: "這個瀏覽器尚不支援 Web Push。",
    insecure: "原生通知只能在 HTTPS 的正式網站上啟用。",
    not_configured: "通知服務正在完成安全設定，暫時無法啟用。",
  }[support.reason];
  const options = [
    ["card_updates", "卡片與完成", "建立卡片、完成卡片"],
    ["stamp_updates", "蓋章", "伴侶新增蓋章"],
    ["interaction_updates", "留言與表情", "新的留言或表情回應"],
    ["reward_updates", "獎勵", "申請或確認兌換獎勵"],
  ];

  return (
    <section className="push-settings" aria-labelledby="push-settings-title">
      <span className="eyebrow">NATIVE NOTIFICATIONS</span>
      <h3 id="push-settings-title">原生通知</h3>
      <p className="tiny">只有伴侶的新互動會通知你；鎖定畫面不會顯示留言內容。</p>
      {!support.supported ? <p className="tiny push-settings__status">{reason}</p> : <>
        <p className="tiny push-settings__status">通知權限：{permission === "granted" ? "已允許" : permission === "denied" ? "已拒絕" : "尚未詢問"}</p>
        <button type="button" className="secondary-button" disabled={busy || loading} onClick={preference.push_enabled ? disable : enable}>
          {busy ? "處理中…" : preference.push_enabled ? "關閉這個帳號的 Push 通知" : "在這台裝置啟用 Push 通知"}
        </button>
        {permission === "denied" && <p className="tiny">請到瀏覽器或手機的網站通知設定中允許「愛的集點卡」，再回來啟用。</p>}
        <div className="push-preference-list" aria-label="Push 通知類型">
          {options.map(([key, label, description]) => <label key={key}><input type="checkbox" checked={preference[key]} disabled={busy || !preference.push_enabled} onChange={(event) => updatePreference(key, event.target.checked)} /><span><strong>{label}</strong><small>{description}</small></span></label>)}
        </div>
      </>}
      <ErrorNotice onRetry={load}>{error}</ErrorNotice>
    </section>
  );
}

function SettingsModal({ profile, space, onClose, onOpenArchive, onEndSpace }) {
  const [name, setName] = useState(profile.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useModalScrollLock();
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
        <div className="modal-heading"><div><span className="eyebrow">MY PROFILE</span><h2>設定</h2></div><button className="icon-button" aria-label="關閉" onClick={onClose}><X /></button></div>
        <form onSubmit={save} className="form-stack">
          <label>顯示名稱<input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} required /></label>
          <ErrorNotice>{error}</ErrorNotice>
          <button className="primary-button" disabled={busy}>{busy ? "儲存中…" : "儲存名稱"}</button>
          <button type="button" className="secondary-button" onClick={() => { onClose(); onOpenArchive({ id: space.id, status: "active" }); }}>查看封存回憶</button>
          <button type="button" className="secondary-button danger-button" onClick={onEndSpace}>結束共同空間</button>
          <button type="button" className="secondary-button danger-button" onClick={() => supabase.auth.signOut()}><LogOut size={17} /> 登出帳號</button>
        </form>
        <PushNotificationSettings />
      </section>
    </div>
  );
}

function ArchiveScreen({ profile, archive, onBack, onRefresh }) {
  const [members, setMembers] = useState([]);
  const [cards, setCards] = useState([]);
  const [events, setEvents] = useState([]);
  const [comments, setComments] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryInvite, setRecoveryInvite] = useState(null);
  const [copied, setCopied] = useState(false);
  const [copyingCardId, setCopyingCardId] = useState(null);

  const loadArchive = useCallback(async () => {
    setLoading(true);
    setError("");
    const [membersResult, cardsResult, eventsResult, commentsResult, reactionsResult] = await Promise.all([
      supabase.from("couple_members").select("user_id, joined_at, profile:profiles!couple_members_user_id_fkey(id, display_name, avatar_url)").eq("space_id", archive.id).order("joined_at"),
      supabase.from("cards").select("*").eq("space_id", archive.id).eq("status", "archived").order("created_at", { ascending: false }),
      supabase.from("stamp_events").select("*").eq("space_id", archive.id).order("occurred_at", { ascending: false }).limit(12),
      supabase.from("stamp_comments").select("*").eq("space_id", archive.id).order("created_at"),
      supabase.from("stamp_reactions").select("*").eq("space_id", archive.id).order("updated_at"),
    ]);
    setLoading(false);
    if (membersResult.error || cardsResult.error || eventsResult.error || commentsResult.error || reactionsResult.error) {
      setError(humanizeError(membersResult.error || cardsResult.error || eventsResult.error || commentsResult.error || reactionsResult.error));
      return;
    }
    setMembers(membersResult.data || []);
    setCards(cardsResult.data || []);
    setEvents(eventsResult.data || []);
    setComments(commentsResult.data || []);
    setReactions(reactionsResult.data || []);
  }, [archive.id]);

  useEffect(() => { loadArchive(); }, [loadArchive]);

  const createRecoveryInvite = async () => {
    setBusy(true);
    setError("");
    const { data, error: rpcError } = await supabase.rpc("create_recovery_invite", { target_archived_space_id: archive.id });
    setBusy(false);
    if (rpcError) return setError(humanizeError(rpcError));
    setRecoveryInvite(data?.[0] || null);
    await onRefresh();
  };

  const copyRecoveryCode = async () => {
    if (!recoveryInvite?.invite_code) return;
    await navigator.clipboard.writeText(recoveryInvite.invite_code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const copyCard = async (cardId) => {
    setCopyingCardId(cardId);
    setError("");
    const { error: rpcError } = await supabase.rpc("copy_card", { target_card_id: cardId });
    setCopyingCardId(null);
    if (rpcError) return setError(humanizeError(rpcError));
    onBack();
  };

  if (loading) return <LoadingScreen />;

  const memberNames = Object.fromEntries(members.map((member) => [member.user_id, member.profile?.display_name || "伴侶"]));
  const partner = members.find((member) => member.user_id !== profile.id);
  const canRecover = archive.status === "ended" && archive.recoverable_until && new Date(archive.recoverable_until).getTime() > Date.now();

  return (
    <main className="app-shell dashboard-shell archive-shell">
      <Brand compact />
      <button className="back-button" onClick={onBack}><ArrowLeft size={17} /> 返回目前狀態</button>
      <section className="archive-hero">
        <span className="eyebrow">PRIVATE, READ-ONLY MEMORIES</span>
        <h2>{partner?.profile?.display_name ? `與 ${partner.profile.display_name} 的封存回憶` : "封存回憶"}</h2>
        <p>{archive.status === "ended" ? "共同空間已結束，這些卡片與紀錄只開放給原本的兩人查看。" : "這裡保留已封存的卡片與互動紀錄。"}</p>
      </section>
      {error && <ErrorNotice onRetry={loadArchive}>{error}</ErrorNotice>}

      {canRecover && (
        <section className="section-block recovery-block">
          <div><span className="eyebrow">RECONNECT WINDOW</span><h3>還能重新連結</h3><p className="tiny">期限至 {new Date(archive.recoverable_until).toLocaleString("zh-TW")}。重新連結會建立新的共同空間，這些回憶仍會保持封存。</p></div>
          {recoveryInvite ? (
            <div className="invite-panel">
              <span className="field-caption">給原本伴侶的六位配對碼</span>
              <strong className="invite-code">{recoveryInvite.invite_code}</strong>
              <button className="secondary-button" onClick={copyRecoveryCode}><Copy size={17} /> {copied ? "已複製" : "複製配對碼"}</button>
              <p className="tiny">有效至 {new Date(recoveryInvite.invite_expires_at).toLocaleString("zh-TW")}</p>
            </div>
          ) : <button className="secondary-button" disabled={busy} onClick={createRecoveryInvite}>{busy ? "建立中…" : "產生重新連結配對碼"}</button>}
        </section>
      )}

      <section className="section-block">
        <div className="section-title"><div><span className="eyebrow">ARCHIVED CARDS</span><h3>已封存的卡片</h3></div><Gift size={20} /></div>
        {cards.length ? <div className="memory-grid">{cards.map((card) => {
          const progress = cardProgress(card, events);
          return <article className="memory-card" key={card.id}><span>{CARD_MODE_LABELS[card.mode] || "共同累積"} · {progress.count}/{progress.target} 次</span><h3>{card.title}</h3><p>{card.action_label}</p><div className="progress-track"><span style={{ width: `${Math.min(100, (progress.count / progress.target) * 100)}%` }} /></div><div className="reward-line"><Gift size={14} /> {card.reward}</div>{archive.status === "active" && <button className="secondary-button compact-button" disabled={copyingCardId === card.id} onClick={() => copyCard(card.id)}><CopyPlus size={16} /> {copyingCardId === card.id ? "複製中…" : "複製成新一輪"}</button>}</article>;
        })}</div> : <div className="empty-inline">目前沒有封存卡片。</div>}
      </section>
      <section className="section-block">
        <div className="section-title"><div><span className="eyebrow">ARCHIVED MOMENTS</span><h3>保留的互動紀錄</h3></div><Clock3 size={20} /></div>
        {events.length ? events.map((event) => <EventItem key={event.id} event={event} memberNames={memberNames} currentUserId={profile.id} readOnly comments={comments} reactions={reactions} highlighted={archive.focusEventId === event.id} showCard cardTitle={cards.find((card) => card.id === event.card_id)?.title || "已封存卡片"} />) : <div className="empty-inline">目前沒有蓋章紀錄。</div>}
      </section>
    </main>
  );
}

function AuthenticatedApp({ session }) {
  const [profile, setProfile] = useState(null);
  const [membership, setMembership] = useState(null);
  const [members, setMembers] = useState([]);
  const [invite, setInvite] = useState(null);
  const [archives, setArchives] = useState([]);
  const [archiveView, setArchiveView] = useState(null);
  const [pushTarget, setPushTarget] = useState(() => pushTargetFromUrl());
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

    const [membershipResult, archivesResult] = await Promise.all([
      supabase.from("couple_members").select("space_id, joined_at").eq("user_id", userId).is("departed_at", null).maybeSingle(),
      supabase.from("couple_members").select("space_id, joined_at, departed_at, space:couple_spaces!couple_members_space_id_fkey(id, status, ended_at, ended_by, recoverable_until, created_at)").eq("user_id", userId).not("departed_at", "is", null).order("departed_at", { ascending: false }),
    ]);
    if (membershipResult.error || archivesResult.error) {
      setError(humanizeError(membershipResult.error || archivesResult.error));
      setLoading(false);
      return;
    }
    setArchives((archivesResult.data || []).map((item) => ({ id: item.space_id, joined_at: item.joined_at, departed_at: item.departed_at, ...(item.space || {}) })));
    setMembership(membershipResult.data);
    if (!membershipResult.data) {
      // An explicit end makes any local stamp waiting for the former space
      // inapplicable. Do not carry it into a later Couple Space.
      writeQueue(userId, []);
      setMembers([]);
      setInvite(null);
      setLoading(false);
      return;
    }

    const spaceId = membershipResult.data.space_id;
    const [membersResult, inviteResult] = await Promise.all([
      supabase.from("couple_members").select("user_id, joined_at, profile:profiles!couple_members_user_id_fkey(id, display_name, avatar_url)").eq("space_id", spaceId).is("departed_at", null).order("joined_at"),
      supabase.from("pairing_invites").select("*").eq("space_id", spaceId).eq("is_recovery", false).is("used_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (membersResult.error || inviteResult.error) setError(humanizeError(membersResult.error || inviteResult.error));
    setMembers(membersResult.data || []);
    setInvite(inviteResult.data);
    setLoading(false);
  }, [session.user.id, session.user.user_metadata]);

  const consumePushTarget = useCallback(() => {
    clearPushTargetFromUrl();
    setPushTarget(null);
  }, []);

  useEffect(() => { refreshIdentity(); }, [refreshIdentity]);

  useEffect(() => {
    const handleNavigation = () => setPushTarget(pushTargetFromUrl());
    window.addEventListener("popstate", handleNavigation);
    return () => window.removeEventListener("popstate", handleNavigation);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let channel;
    const subscribe = async () => {
      await supabase.realtime.setAuth(session.access_token);
      if (cancelled) return;
      channel = supabase
        .channel(`identity-status-${session.user.id}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "couple_members", filter: `user_id=eq.${session.user.id}` },
          () => refreshIdentity(),
        )
        .subscribe();
    };
    subscribe();
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [refreshIdentity, session.access_token, session.user.id]);

  useEffect(() => {
    if (!membership?.space_id) return undefined;

    let cancelled = false;
    let channel;
    const subscribe = async () => {
      await supabase.realtime.setAuth(session.access_token);
      if (cancelled) return;
      channel = supabase
        .channel(`pairing-status-${membership.space_id}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "couple_members", filter: `space_id=eq.${membership.space_id}` },
          () => refreshIdentity(),
        )
        .subscribe();
    };

    subscribe();
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [membership?.space_id, refreshIdentity, session.access_token]);

  // Realtime is the fast path. This fallback protects pairing and archive
  // transitions if a foregrounded mobile PWA briefly loses its websocket.
  useEffect(() => {
    if (!membership?.space_id) return undefined;
    const interval = window.setInterval(() => { refreshIdentity(); }, 4000);
    return () => window.clearInterval(interval);
  }, [membership?.space_id, refreshIdentity]);

  useEffect(() => {
    if (loading || !pushTarget?.spaceId || membership?.space_id === pushTarget.spaceId) return;
    const targetArchive = archives.find((archive) => archive.id === pushTarget.spaceId);
    if (!targetArchive) return;
    setArchiveView({ ...targetArchive, focusEventId: pushTarget.eventId || null });
    consumePushTarget();
  }, [archives, consumePushTarget, loading, membership?.space_id, pushTarget]);

  if (loading) return <LoadingScreen />;
  if (error && !profile) return <main className="app-shell app-shell--centered"><Brand /><ErrorNotice onRetry={refreshIdentity}>{error}</ErrorNotice></main>;
  if (!profile?.display_name) return <ProfileGate profile={profile} onSaved={(saved) => { setProfile(saved); refreshIdentity(); }} />;
  if (archiveView) return <ArchiveScreen profile={profile} archive={archiveView} onBack={() => setArchiveView(null)} onRefresh={refreshIdentity} />;
  if (!membership || members.length < 2) return <PairingScreen profile={profile} membership={membership} invite={invite} archives={archives} onOpenArchive={setArchiveView} onRefresh={refreshIdentity} />;
  return <Dashboard user={session.user} accessToken={session.access_token} profile={profile} space={{ id: membership.space_id, status: "active" }} members={members} onOpenArchive={setArchiveView} onRelationshipChanged={refreshIdentity} pushTarget={pushTarget?.spaceId === membership.space_id ? pushTarget : null} onPushTargetHandled={consumePushTarget} />;
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
