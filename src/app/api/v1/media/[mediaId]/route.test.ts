import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateApiKey } from '@/lib/api-keys/keys';
import type { ApiKeyRow } from '@/lib/api-keys/store';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

const KEY = generateApiKey().plaintext;

// Mock the key store so requireApiKey resolves however each test needs
// (mirrors src/lib/auth/api-context.test.ts).
const findActiveKeyByHash = vi.fn<(hash: string) => Promise<ApiKeyRow | null>>();
const touchLastUsed = vi.fn();
vi.mock('@/lib/api-keys/store', () => ({
  findActiveKeyByHash: (hash: string) => findActiveKeyByHash(hash),
  touchLastUsed: (id: string) => touchLastUsed(id),
}));

// The ownership-check query (`messages` joined to `conversations`) —
// each test sets what it should "find".
let messageRows: Array<Record<string, unknown>> | null = [];
let lookupError: { message: string } | null = null;
// requireApiKey's account-suspension lookup (`accounts.status`). Table-
// agnostic mock, so this same chain also serves that query — defaults to
// an active account since no test here exercises suspension.
let accountRow: { status: string } | null = { status: 'active' };

function makeSupabaseMock() {
  return {
    from: vi.fn(() => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = vi.fn(chain);
      b.eq = vi.fn(chain);
      b.limit = vi.fn(async () => ({ data: messageRows, error: lookupError }));
      b.maybeSingle = vi.fn(async () => ({ data: accountRow, error: null }));
      return b;
    }),
  };
}
let supabaseMock = makeSupabaseMock();
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => supabaseMock,
}));

const downloadWhatsappMediaForAccount = vi.fn();
class WhatsappMediaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
vi.mock('@/lib/whatsapp/media', () => ({
  downloadWhatsappMediaForAccount: (...args: unknown[]) =>
    downloadWhatsappMediaForAccount(...args),
  WhatsappMediaError,
}));

const { GET } = await import('./route');

function row(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: 'key-1',
    account_id: 'acct-1',
    created_by: 'user-1',
    name: 'Test key',
    scopes: ['messages:read'],
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function getMedia(mediaId: string, authHeader: string | undefined = `Bearer ${KEY}`) {
  return GET(
    new Request(`https://crm.example.com/api/v1/media/${mediaId}`, {
      headers: authHeader ? { authorization: authHeader } : {},
    }),
    { params: Promise.resolve({ mediaId }) }
  );
}

describe('GET /api/v1/media/{mediaId}', () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    findActiveKeyByHash.mockReset();
    touchLastUsed.mockReset();
    downloadWhatsappMediaForAccount.mockReset();
    messageRows = [];
    lookupError = null;
    accountRow = { status: 'active' };
    supabaseMock = makeSupabaseMock();
  });

  afterEach(() => {
    __resetRateLimitForTests();
    vi.clearAllMocks();
  });

  it('returns the media base64-encoded on the happy path', async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    messageRows = [{ id: 'msg-1' }];
    downloadWhatsappMediaForAccount.mockResolvedValue({
      buffer: Buffer.from('hello'),
      contentType: 'image/jpeg',
    });

    const res = await getMedia('1234567890');
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      media_id: '1234567890',
      content_type: 'image/jpeg',
      base64: Buffer.from('hello').toString('base64'),
    });
  });

  it('403s when the key lacks the messages:read scope', async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ['contacts:read'] }));

    const res = await getMedia('1234567890');
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('forbidden');
    expect(downloadWhatsappMediaForAccount).not.toHaveBeenCalled();
  });

  it("404s for a media id belonging to another account (can't be distinguished from nonexistent)", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    messageRows = []; // ownership query, scoped to ctx.accountId, finds nothing

    const res = await getMedia('someone-elses-media-id');
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe('not_found');
    expect(downloadWhatsappMediaForAccount).not.toHaveBeenCalled();
  });

  it('404s for a media id that does not exist at all', async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    messageRows = [];

    const res = await getMedia('never-existed');
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe('not_found');
  });

  it('maps a Meta download failure to a 502 meta_error', async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    messageRows = [{ id: 'msg-1' }];
    downloadWhatsappMediaForAccount.mockRejectedValue(
      new WhatsappMediaError('meta_error', 'Meta rejected the request')
    );

    const res = await getMedia('1234567890');
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error.code).toBe('meta_error');
  });

  it('400s with whatsapp_not_configured when the account has no WhatsApp config', async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    messageRows = [{ id: 'msg-1' }];
    downloadWhatsappMediaForAccount.mockRejectedValue(
      new WhatsappMediaError('not_configured', 'WhatsApp not configured')
    );

    const res = await getMedia('1234567890');
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('whatsapp_not_configured');
  });

  it('401s with no Authorization header', async () => {
    const res = await getMedia('1234567890', '');
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('unauthorized');
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });
});
