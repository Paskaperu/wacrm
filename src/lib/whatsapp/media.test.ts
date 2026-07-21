import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getMediaUrl = vi.fn();
const downloadMedia = vi.fn();
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: (...args: unknown[]) => getMediaUrl(...args),
  downloadMedia: (...args: unknown[]) => downloadMedia(...args),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
}));

const { downloadWhatsappMediaForAccount, WhatsappMediaError } = await import(
  './media'
);

function supabaseMock(config: Record<string, unknown> | null) {
  return {
    from: vi.fn(() => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = vi.fn(chain);
      b.eq = vi.fn(chain);
      b.single = vi.fn(async () => ({
        data: config,
        error: config ? null : { message: 'not found' },
      }));
      return b;
    }),
  };
}

describe('downloadWhatsappMediaForAccount', () => {
  beforeEach(() => {
    getMediaUrl.mockReset();
    downloadMedia.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the download URL and returns the decoded bytes', async () => {
    getMediaUrl.mockResolvedValue({
      url: 'https://cdn.example.com/file',
      mimeType: 'image/jpeg',
    });
    downloadMedia.mockResolvedValue({
      buffer: Buffer.from('hello'),
      contentType: 'image/jpeg',
    });

    const result = await downloadWhatsappMediaForAccount(
      supabaseMock({ access_token: 'enc-token' }) as never,
      'acct-1',
      'media-1'
    );

    expect(result.buffer.toString()).toBe('hello');
    expect(result.contentType).toBe('image/jpeg');
    expect(getMediaUrl).toHaveBeenCalledWith({
      mediaId: 'media-1',
      accessToken: 'plaintext-token',
    });
  });

  it('throws not_configured when the account has no whatsapp_config row', async () => {
    await expect(
      downloadWhatsappMediaForAccount(
        supabaseMock(null) as never,
        'acct-1',
        'media-1'
      )
    ).rejects.toMatchObject({ code: 'not_configured' });
    expect(getMediaUrl).not.toHaveBeenCalled();
  });

  it('wraps a Meta rejection as meta_error', async () => {
    getMediaUrl.mockRejectedValue(new Error('Media fetch failed: 404'));

    const err = await downloadWhatsappMediaForAccount(
      supabaseMock({ access_token: 'enc-token' }) as never,
      'acct-1',
      'media-1'
    ).catch((e) => e);

    expect(err).toBeInstanceOf(WhatsappMediaError);
    expect(err.code).toBe('meta_error');
    expect(err.message).toMatch(/Media fetch failed/);
  });
});
