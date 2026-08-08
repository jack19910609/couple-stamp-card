export function updateBlockReason({ online, queueLength, syncing }) {
  if (!online) return "目前離線。恢復網路後再更新，才能確認每一筆互動都已安全送出。";
  if (syncing || queueLength > 0) return `還有 ${queueLength || "正在處理的"} 筆互動待同步，完成後即可更新。`;
  return null;
}

export function canApplyPwaUpdate(syncState) {
  return updateBlockReason(syncState) === null;
}
