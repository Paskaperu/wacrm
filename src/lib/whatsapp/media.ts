// ============================================================
// Shared core for fetching a WhatsApp media file from Meta on behalf
// of an account. Two callers need exactly this sequence — resolve the
// account's WhatsApp config, decrypt its access token, resolve the
// media id to a download URL, then pull the bytes:
//
//   - the dashboard's media proxy, `/api/whatsapp/media/[mediaId]`
//     (browser session auth)
//   - the public API's `/api/v1/media/[mediaId]` (API key auth)
//
// Keeping the Meta round-trip in one place means there's one spot to
// fix if Meta's media API changes, instead of two copies drifting.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';

export type WhatsappMediaErrorCode = 'not_configured' | 'meta_error';

/** Thrown by `downloadWhatsappMediaForAccount` — callers map `code` to their own error envelope. */
export class WhatsappMediaError extends Error {
  readonly code: WhatsappMediaErrorCode;

  constructor(code: WhatsappMediaErrorCode, message: string) {
    super(message);
    this.name = 'WhatsappMediaError';
    this.code = code;
  }
}

export interface DownloadedMedia {
  buffer: Buffer;
  contentType: string;
}

/**
 * Resolve `accountId`'s WhatsApp access token and download `mediaId`
 * from Meta. Throws `WhatsappMediaError('not_configured')` if the
 * account has no WhatsApp config, or `WhatsappMediaError('meta_error')`
 * if Meta rejects either the URL lookup or the download.
 */
export async function downloadWhatsappMediaForAccount(
  supabase: SupabaseClient,
  accountId: string,
  mediaId: string
): Promise<DownloadedMedia> {
  const { data: config, error: configError } = await supabase
    .from('whatsapp_config')
    .select('access_token')
    .eq('account_id', accountId)
    .single();

  if (configError || !config) {
    throw new WhatsappMediaError(
      'not_configured',
      'WhatsApp not configured'
    );
  }

  const accessToken = decrypt(config.access_token);

  try {
    const mediaInfo = await getMediaUrl({ mediaId, accessToken });
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    });
    return {
      buffer,
      contentType: contentType || mediaInfo.mimeType || 'application/octet-stream',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Meta media download failed';
    throw new WhatsappMediaError('meta_error', message);
  }
}
