export const ACTIVE_CARD_STATUSES = new Set(["active"]);
export const CARD_MODE_LABELS = {
  personal: "個人卡",
  shared: "共同卡",
  competition: "競賽卡",
};

export function activeStampsForCard(events, cardId) {
  return events.filter((event) => event.card_id === cardId && !event.undone_at);
}

export function cardProgress(card, events) {
  const active = activeStampsForCard(events, card.id);
  const contributions = active.reduce((result, event) => {
    result[event.actor_id] = (result[event.actor_id] || 0) + 1;
    return result;
  }, {});

  const mode = card.mode || "shared";
  const personalActive = mode === "personal"
    ? active.filter((event) => event.actor_id === card.participant_id)
    : active;
  const competitionScores = mode === "competition" ? contributions : null;
  const leadingCount = competitionScores ? Math.max(0, ...Object.values(competitionScores)) : personalActive.length;
  const complete = mode === "competition"
    ? Boolean(card.completed_at || card.winner_id || leadingCount >= card.target_count)
    : Boolean(card.completed_at || personalActive.length >= card.target_count);

  return {
    mode,
    count: leadingCount,
    target: card.target_count,
    remaining: Math.max(0, card.target_count - leadingCount),
    complete,
    contributions,
    winnerId: card.winner_id || null,
    personalParticipantId: card.participant_id || null,
  };
}

export function upsertById(items, incoming) {
  const index = items.findIndex((item) => item.id === incoming.id);
  if (index === -1) return [incoming, ...items];
  const next = [...items];
  next[index] = { ...items[index], ...incoming };
  return next;
}

export function formatRelativeTime(value, now = Date.now()) {
  const timestamp = typeof value === "number" ? value : new Date(value).getTime();
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "剛剛";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "昨天" : `${days} 天前`;
}

export function isUndoable(event, userId, now = Date.now()) {
  if (!event || event.actor_id !== userId || event.undone_at) return false;
  return now - new Date(event.occurred_at).getTime() <= 10 * 60 * 1000;
}

export function isTerminalOutboxError(error) {
  const message = error?.message || "";
  return /Card is already complete|Card is not active|undo window has expired|Stamp event not found|Only the assigned partner can stamp|Cannot undo after reward redemption|Comment ID already belongs|A comment between|Reaction is not supported/i.test(message);
}
