export class DecideError extends Error {
  constructor(message: string, readonly status?: number, readonly validation?: readonly string[]) {
    super(message);
    this.name = 'TypeSafeDecideError';
  }
}

// Upstream messages, input, IDs and custom field names may contain submitted data.
// Retain only vocabulary from the fixed protocol, never arbitrary server strings.
export function validationDetails(body: unknown): string[] {
  if (!body || typeof body !== 'object' || !('detail' in body) || !Array.isArray(body.detail)) return [];
  const fields = new Set(['body', 'state', 'questions', 'type', 'instructions', 'criteria', 'model']);
  const codes = new Set(['missing', 'extra_forbidden', 'string_type', 'dict_type', 'list_type', 'too_short', 'too_long', 'literal_error', 'union_tag_invalid', 'union_tag_not_found']);
  return body.detail.slice(0, 8).flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const e = item as Record<string, unknown>;
    if (!Array.isArray(e.loc)) return [];
    const path = e.loc.slice(0, 8).map((part: unknown, i: number) =>
      // The question ID and criterion labels are always caller-controlled.
      (i === 2 && e.loc instanceof Array && e.loc[1] === 'questions') ? '*' :
      typeof part === 'string' && fields.has(part) ? part : '*').join('.');
    const code = typeof e.type === 'string' && codes.has(e.type) ? e.type : 'invalid_value';
    return [`${path}: ${code}`];
  });
}

export function httpError(status: number, body?: unknown): DecideError {
  const validation = status === 422 ? validationDetails(body) : [];
  const action = status === 401 ? 'Check the configured TypeSafe SecretRef and API-key validity.' :
    status === 422 ? 'Check state, instructions and criteria. Jev supports 255 Choice options, 2–10 Score levels, 64k total tokens and 32k for state plus the longest question.' :
    status === 429 ? 'Rate limit reached. Retry later.' :
    status === 529 ? 'TypeSafe is overloaded. Retry later.' : 'Request failed; it was not retried unless the status was 429 or 529.';
  return new DecideError(`TypeSafe HTTP ${status}. ${action}${validation.length ? ' Fields: ' + validation.join('; ') : ''}`, status, validation);
}
