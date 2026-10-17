export const allowedErrors = new Set([
  'DWS_PLATFORM_UNSUPPORTED', 'DWS_BINARY_UNSAFE', 'DWS_BINARY_CHECKSUM_MISMATCH',
  'DWS_PROFILE_SELECTION_REQUIRED', 'DWS_PROFILE_MISMATCH', 'DWS_AUTH_STATUS_UNAVAILABLE', 'DWS_PROFILE_ALREADY_CONNECTED', 'DWS_GROUP_LIST_LIMIT_INVALID',
  'DWS_PROFILE_NOT_INSTALLED', 'DWS_PROFILE_NOT_AUTHENTICATED', 'DWS_GROUP_QUERY_INVALID',
  'DWS_GROUP_SEARCH_INVALID_RESULT', 'DWS_LOGOUT_READBACK_FAILED',
  'DWS_PROCESS_TIMEOUT', 'DWS_PROCESS_START_FAILED', 'DWS_PROCESS_FAILED', 'DWS_INVALID_JSON',
  'DWS_OUTPUT_TOO_LARGE', 'DWS_AUTHORIZATION_START_TIMEOUT', 'DWS_AUTHORIZATION_FAILED',
  'DWS_AUTHORIZATION_INVALID_RESULT', 'DWS_AUTHORIZATION_EXPIRED', 'DWS_PROFILE_BUSY',
  'DWS_EVENT_LISTENER_FAILED', 'DWS_EVENT_SUBSCRIPTION_REJECTED', 'DWS_EVENT_PERMISSION_DENIED',
  'DWS_EVENT_NETWORK_UNAVAILABLE', 'DWS_EVENT_COMMAND_UNSUPPORTED', 'DWS_MONITOR_ALREADY_ACTIVE',
  'DWS_DOC_AUTHORIZATION_REQUIRED', 'DWS_DOC_NAME_INVALID', 'DWS_DOC_CONTENT_INVALID',
  'DWS_DOC_CONTENT_TOO_LARGE', 'DWS_DOC_NODE_INVALID', 'DWS_DOC_LOCATION_INVALID',
  'DWS_DOC_QUERY_INVALID', 'DWS_DOC_LIMIT_INVALID', 'DWS_DOC_SEARCH_FAILED',
  'DWS_DOC_READBACK_FAILED', 'DWS_DOC_READBACK_MISMATCH', 'DWS_DOC_OPERATION_UNVERIFIED',
  'DWS_DOC_OPERATION_FAILED', 'DWS_DOC_OPERATION_MISMATCH', 'DWS_DOC_PARTIAL_SUCCESS',
  'DWS_DOC_COMMIT_UNKNOWN', 'DWS_DOC_RETRYABLE_FAILURE', 'DWS_DOC_CONFIRMATION_REQUIRED',
  'DWS_DOC_UPDATE_COMMAND_INVALID', 'DWS_DOC_REQUEST_ID_INVALID', 'DWS_DOC_REQUEST_CONFLICT',
  'DWS_DOC_OPERATION_STORAGE_FAILED', 'DINGTALK_REQUEST_TOO_LARGE',
  'DWS_CALENDAR_RANGE_INVALID', 'DWS_CALENDAR_CURSOR_INVALID', 'DWS_CALENDAR_LIST_FAILED',
  'DWS_HOST_PROFILE_USER_NOT_ALLOWED',
  'CONNECTOR_AUTHORIZATION_NOT_FOUND', 'CONNECTOR_IDENTITY_READBACK_FAILED',
]);

const allowedEventStartupCauses = new Set([
  'ready-timeout-no-stderr', 'no-stderr', 'subscription-retry-protected', 'app-key-configuration',
  'authorization-token', 'authorization-permission', 'subscription-rejected', 'subscription-limit',
  'network', 'cli-contract', 'event-bus-startup', 'dws-internal-error', 'unclassified',
]);

const allowedDwsErrorCategories = new Set(['api', 'auth', 'validation', 'pat', 'internal', 'discovery']);

const safeDwsErrorCodes = new Set([
  'SYSTEM_ERROR', 'UNIFIED_APP_ID_NOT_FOUND', 'INVALID_ARGUMENT', 'INVALID_PARAMETER',
  'PERMISSION_DENIED', 'UNAUTHORIZED', 'FORBIDDEN', 'TOO_MANY_REQUESTS', 'RATE_LIMITED',
]);

const dwsErrorFieldNames = new Set([
  'category', 'code', 'error', 'error_code', 'errorcode', 'error_msg', 'errormsg',
  'message', 'msg', 'reason', 'success', 'status', 'details', 'data', 'result',
  'arguments', 'subid', 'http_status', 'server_error_code', 'trace_id',
]);

function jsonObjectsIn(stderr) {
  const text = String(stderr || '').slice(-64 * 1024);
  const candidates = [text.trim()];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(text.slice(start, index + 1));
    }
  }
  return [...new Set(candidates.filter(Boolean))];
}

function findDwsErrorRecords(value, depth = 0, records = []) {
  if (!value || typeof value !== 'object' || depth > 5 || records.length >= 12) return records;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) findDwsErrorRecords(item, depth + 1, records);
    return records;
  }
  const entries = Object.entries(value);
  const fields = entries.map(([key]) => key.toLowerCase()).filter(key => dwsErrorFieldNames.has(key)).sort();
  const hasErrorText = entries.some(([key, item]) =>
    ['message', 'msg', 'error_msg', 'errormsg', 'reason'].includes(key.toLowerCase()) && typeof item === 'string');
  const hasErrorCode = entries.some(([key, item]) =>
    ['code', 'error_code', 'errorcode', 'server_error_code'].includes(key.toLowerCase()) &&
    (typeof item === 'string' || Number.isInteger(item)));
  if (hasErrorText || hasErrorCode) {
    records.push({ value, fields });
  }
  for (const [key, item] of entries) {
    if (['error', 'data', 'result', 'details', 'arguments'].includes(key.toLowerCase())) {
      findDwsErrorRecords(item, depth + 1, records);
    }
  }
  return records;
}

function structuredDwsError(stderr) {
  const text = stripTerminalControl(stderr).trim();
  for (const candidate of jsonObjectsIn(text)) {
    let value;
    try { value = JSON.parse(candidate); } catch { continue; }
    for (const record of findDwsErrorRecords(value)) {
      const error = record.value;
      const categoryValue = String(error.category || '').toLowerCase();
      const category = allowedDwsErrorCategories.has(categoryValue) ? categoryValue : undefined;
      const rawCode = error.code ?? error.errorCode ?? error.error_code ?? error.server_error_code;
      const numericCode = Number(rawCode);
      const code = Number.isInteger(numericCode) && numericCode >= 1 && numericCode <= 6
        ? numericCode
        : (typeof rawCode === 'string' && safeDwsErrorCodes.has(rawCode.toUpperCase()) ? rawCode.toUpperCase() : undefined);
      const message = [error.message, error.msg, error.errorMsg, error.error_msg, error.reason]
        .find(item => typeof item === 'string') || '';
      if (!category && code === undefined && !message) continue;
      const messageClass = /discover.{0,24}bus|busctl/i.test(message) ? 'bus-discovery' :
        /(?:start|spawn).{0,24}bus|bus.{0,24}(?:start|spawn)/i.test(message) ? 'bus-start' :
          /registerToEventCenter|subscribeUser|subscription|subscribe/i.test(message) ? 'subscription' :
            /token.{0,24}(expired|invalid)|invalid.{0,24}token|unauthorized|forbidden/i.test(message) ? 'authorization' :
              /x509|tls|certificate|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|timeout|timed out|i\/o timeout|websocket|stream|connect/i.test(message) ? 'event-transport' :
                isExplicitAppKeyFailure(message, code) ? 'event-mcp-configuration' :
                  /token|auth(?:entication|orization)?/i.test(message) ? 'authorization' : 'other';
      return { category, code, messageClass, fields: record.fields };
    }
  }
  return undefined;
}

function isExplicitAppKeyFailure(text, code) {
  if (code === 'UNIFIED_APP_ID_NOT_FOUND') return true;
  const value = String(text || '');
  const credential = '(?:app\\s*key|app.?key|client.?id|app.?id)';
  const failure = '(?:missing|required|not\\s+configured|unconfigured|invalid|unknown|not\\s+found|unavailable|rejected)';
  return new RegExp(`(?:${credential}.{0,32}${failure}|${failure}.{0,32}${credential})`, 'i').test(value);
}

function stripTerminalControl(value) {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

function startupErrorTextFromStdout(stdout) {
  const text = stripTerminalControl(stdout).slice(-64 * 1024);
  const diagnosticLines = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const fields = findDwsErrorRecords(parsed);
      if (fields.length || parsed.success === false || parsed.type === 'error') diagnosticLines.push(trimmed);
    } catch {
      // Event output is NDJSON. Keep only non-JSON pre-ready lines for the
      // allowlisted classifier; never log the text itself.
      diagnosticLines.push(trimmed);
    }
  }
  return diagnosticLines.join('\n');
}

export function appendBoundedStartupStderr(current, chunk, maxBytes = 64 * 1024) {
  const combined = Buffer.concat([Buffer.from(String(current || '')), Buffer.from(String(chunk || ''))]);
  return combined.length > maxBytes ? combined.subarray(-maxBytes).toString('utf8') : combined.toString('utf8');
}

export function publicError(error) {
  const code = typeof error?.message === 'string' && allowedErrors.has(error.message) ? error.message : 'DINGTALK_CONNECTOR_REQUEST_FAILED';
  const status = code === 'CONNECTOR_AUTHORIZATION_NOT_FOUND' ? 404 :
    ['DWS_DOC_AUTHORIZATION_REQUIRED', 'DWS_HOST_PROFILE_USER_NOT_ALLOWED'].includes(code) ? 403 :
      ['DWS_DOC_CONTENT_TOO_LARGE', 'DINGTALK_REQUEST_TOO_LARGE'].includes(code) ? 413 :
        ['DWS_PROFILE_BUSY', 'DWS_MONITOR_ALREADY_ACTIVE', 'DWS_DOC_PARTIAL_SUCCESS', 'DWS_DOC_COMMIT_UNKNOWN', 'DWS_DOC_REQUEST_CONFLICT'].includes(code) ? 409 :
          ['DWS_PROCESS_TIMEOUT', 'DWS_PROCESS_FAILED', 'DWS_EVENT_LISTENER_FAILED', 'DWS_EVENT_SUBSCRIPTION_REJECTED',
            'DWS_EVENT_PERMISSION_DENIED', 'DWS_EVENT_NETWORK_UNAVAILABLE', 'DWS_EVENT_COMMAND_UNSUPPORTED'].includes(code) ? 502 : 400;
  return { status, body: { ok: false, error: code } };
}

export function classifyEventStartupFailure(stderr, fallback = 'DWS_EVENT_LISTENER_FAILED') {
  const text = stripTerminalControl(stderr);
  if (/registerToEventCenter\s+failed|subscribeUser\s+failed|event.?center.{0,40}(reject|denied|fail)|subscription.{0,40}(reject|denied|fail)/i.test(text)) {
    return 'DWS_EVENT_SUBSCRIPTION_REJECTED';
  }
  if (/permission denied|forbidden|not authorized|unauthorized|missing.{0,24}(scope|permission)|insufficient.{0,24}(scope|permission)/i.test(text)) {
    return 'DWS_EVENT_PERMISSION_DENIED';
  }
  if (/x509|tls|certificate|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network is unreachable|connection timed out|i\/o timeout/i.test(text)) {
    return 'DWS_EVENT_NETWORK_UNAVAILABLE';
  }
  if (/unknown command|unknown flag|unknown option|unknown shorthand|unrecognized (?:option|flag)|flag provided but not defined|invalid choice/i.test(text)) {
    return 'DWS_EVENT_COMMAND_UNSUPPORTED';
  }
  return fallback;
}

export function classifyEventStartupCause(text, stage) {
  const value = String(text || '');
  if (!value.trim()) return stage === 'ready-timeout' ? 'ready-timeout-no-stderr' : 'no-stderr';
  const dwsError = structuredDwsError(value);
  if (dwsError?.messageClass === 'bus-discovery' || dwsError?.messageClass === 'bus-start') return 'event-bus-startup';
  if (dwsError?.messageClass === 'subscription') return 'subscription-rejected';
  if (dwsError?.messageClass === 'authorization') return 'authorization-token';
  if (dwsError?.messageClass === 'event-transport') return 'network';
  if (dwsError?.messageClass === 'event-mcp-configuration') return 'app-key-configuration';
  if (dwsError?.category === 'internal') return 'dws-internal-error';
  if (/terminal_hold|retry.{0,24}(budget|limit)|attempt.{0,24}(limit|exhaust)|cooldown/i.test(value)) return 'subscription-retry-protected';
  if (/x509|tls|certificate|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network is unreachable|connection timed out|i\/o timeout|timed out/i.test(value)) return 'network';
  if (/token.{0,24}(expired|invalid)|invalid.{0,24}token|unauthorized/i.test(value)) return 'authorization-token';
  if (/registerToEventCenter\s+failed|subscribeUser\s+failed|event.?center.{0,40}(reject|denied|fail)|subscription.{0,40}(reject|denied|fail)/i.test(value)) return 'subscription-rejected';
  if (/permission denied|forbidden|not authorized|unauthorized|scope|permission/i.test(value)) return 'authorization-permission';
  if (/too many subscriptions|subscription.{0,24}(limit|quota)|rate.?limit/i.test(value)) return 'subscription-limit';
  if (/unknown command|unknown flag|unknown option|unknown shorthand|unrecognized (?:option|flag)|flag provided but not defined|invalid choice/i.test(value)) return 'cli-contract';
  if (isExplicitAppKeyFailure(value, dwsError?.code)) return 'app-key-configuration';
  return 'unclassified';
}

export function eventStartupDiagnostic({ stage, code, cause, exitCode, signal, stderr = '', stderrBytes, stdout = '', stdoutBytes, osErrorCode, elapsedMs } = {}) {
  const allowedStages = new Set(['prepare-workspace', 'inspect-profile', 'list-profiles', 'spawn-listener', 'await-ready', 'child-exit', 'spawn-error', 'ready-timeout']);
  const raw = String(stderr || '');
  const stdoutError = startupErrorTextFromStdout(stdout);
  const diagnosticText = [raw, stdoutError].filter(Boolean).join('\n');
  const dwsError = structuredDwsError(diagnosticText);
  const classifiedCode = classifyEventStartupFailure(diagnosticText);
  const classifiedCause = classifyEventStartupCause(diagnosticText, stage);
  return {
    component: 'dws-im-monitor',
    stage: allowedStages.has(stage) ? stage : 'unknown',
    code: code === 'DWS_EVENT_LISTENER_FAILED' || !allowedErrors.has(code) ? classifiedCode : code,
    cause: cause === 'unclassified' || !allowedEventStartupCauses.has(cause) ? classifiedCause : cause,
    ...(dwsError ? {
      ...(dwsError.category ? { dwsErrorCategory: dwsError.category } : {}),
      ...(dwsError.code !== undefined ? { dwsErrorCode: dwsError.code } : {}),
      ...(dwsError.messageClass ? { dwsMessageClass: dwsError.messageClass } : {}),
      ...(dwsError.fields?.length ? { dwsErrorFields: dwsError.fields } : {}),
    } : {}),
    stderrBytes: Number.isSafeInteger(stderrBytes) && stderrBytes >= 0 ? stderrBytes : Buffer.byteLength(raw),
    ...(Number.isSafeInteger(stdoutBytes) && stdoutBytes >= 0 ? { stdoutBytes } : {}),
    ...(raw.trim() && stdoutError ? { diagnosticChannels: ['stderr', 'stdout'] } :
      raw.trim() ? { diagnosticChannels: ['stderr'] } :
        stdoutError ? { diagnosticChannels: ['stdout'] } : {}),
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
    ...(typeof signal === 'string' && /^[A-Z0-9]+$/.test(signal) ? { signal } : {}),
    ...(typeof osErrorCode === 'string' && /^[A-Z0-9_]{1,32}$/.test(osErrorCode) ? { osErrorCode } : {}),
    ...(Number.isFinite(elapsedMs) && elapsedMs >= 0 ? { elapsedMs: Math.round(elapsedMs) } : {}),
  };
}
