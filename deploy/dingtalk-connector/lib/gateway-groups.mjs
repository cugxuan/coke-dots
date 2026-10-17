export function sanitizeGroups(payload) {
  const raw = extractGroupRows(payload);
  if (payload?.success !== true || !raw) throw new Error('DWS_GROUP_SEARCH_INVALID_RESULT');
  const groups = sanitizeGroupRows(raw);
  const page = payload.result && !Array.isArray(payload.result) ? payload.result : payload;
  return {
    groups,
    hasMore: page.hasMore === true,
    ...(typeof page.nextCursor === 'string' || typeof page.nextCursor === 'number' ? { nextCursor: String(page.nextCursor).slice(0, 200) } : {}),
  };
}

function sanitizeGroupRows(raw) {
  if (!Array.isArray(raw)) throw new Error('DWS_GROUP_SEARCH_INVALID_RESULT');
  const groups = [];
  for (const group of raw) {
    const conversationId = groupConversationId(group);
    const name = groupName(group);
    if (!conversationId || !name) continue;
    groups.push({ conversationId: conversationId.slice(0, 512), name: name.slice(0, 200) });
  }
  if (groups.length !== raw.length) throw new Error('DWS_GROUP_SEARCH_INVALID_RESULT');
  return groups;
}

function extractGroupRows(payload) {
  return Array.isArray(payload?.result) ? payload.result :
    Array.isArray(payload?.result?.groups) ? payload.result.groups :
      Array.isArray(payload?.result?.chats) ? payload.result.chats :
        Array.isArray(payload?.result?.items) ? payload.result.items :
          Array.isArray(payload?.groups) ? payload.groups : null;
}

function groupConversationId(group) {
  return String(group?.openConversationId || group?.open_conversation_id || group?.conversationId || '').trim();
}

function groupName(group) {
  return String(group?.title || group?.name || group?.groupName || group?.conversationName || group?.chatName || '').trim();
}

export function sanitizeGroupList(payload) {
  // DWS v1.0.64's `chat +my-groups --page-all --format json` shortcut
  // writes a direct projection (`groups`, `complete`, `hasMore`,
  // `paginationKnown`, `failures`), without the `success/result` envelope
  // used by the lower-level `chat search` command.
  const shortcutPage = payload && typeof payload === 'object' &&
    Array.isArray(payload.groups) && Number.isSafeInteger(payload.count) && payload.count === payload.groups.length &&
    Number.isSafeInteger(payload.pagesFetched) && payload.pagesFetched >= 1 && payload.paginationKnown === true &&
    typeof payload.complete === 'boolean' && typeof payload.hasMore === 'boolean' &&
    Array.isArray(payload.failures) && Number.isSafeInteger(payload.failedCount) &&
    payload.failedCount >= 0 && payload.failedCount === payload.failures.length;
  let groups;
  let page;
  if (shortcutPage) {
    groups = sanitizeGroupRows(payload.groups);
    page = payload;
  } else {
    groups = sanitizeGroups(payload).groups;
    page = payload.result && !Array.isArray(payload.result) ? payload.result : payload;
    if (typeof page.complete !== 'boolean' || typeof page.hasMore !== 'boolean') throw new Error('DWS_GROUP_SEARCH_INVALID_RESULT');
  }
  const failures = Math.max(Array.isArray(page.failures) ? page.failures.length : 0,
    Number.isSafeInteger(page.failedCount) && page.failedCount >= 0 ? page.failedCount : 0);
  const hasMore = page.hasMore;
  return {
    groups,
    hasMore,
    ...(typeof page.nextCursor === 'string' || typeof page.nextCursor === 'number' ? { nextCursor: String(page.nextCursor).slice(0, 200) } : {}),
    complete: page.complete === true && !hasMore && failures === 0,
    failureCount: failures,
  };
}
