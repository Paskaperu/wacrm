// ============================================================
// GET /api/v1/media/{mediaId} — download a WhatsApp media file by
// the id embedded in a message's `media_url`
// (`/api/whatsapp/media/{mediaId}`, as returned by inbound messages
// via `message.received` webhooks and
// GET /api/v1/conversations/{id}/messages). Scope: messages:read.
//
// The media id must belong to a message in a conversation owned by
// the key's account — verified against `messages` (joined to
// `conversations` for `account_id`) before Meta is ever called, so a
// key can't fetch another account's media by guessing/reusing a
// media id. Unlike the dashboard's binary media proxy, the caller
// here is an automation, not a browser: the file comes back
// base64-encoded inside the standard `{ data }` envelope.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  downloadWhatsappMediaForAccount,
  WhatsappMediaError,
} from '@/lib/whatsapp/media';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { mediaId } = await params;

    // Gate on account ownership before ever calling Meta.
    const { data: rows, error: lookupError } = await ctx.supabase
      .from('messages')
      .select('id, conversations!inner(account_id)')
      .eq('media_url', `/api/whatsapp/media/${mediaId}`)
      .eq('conversations.account_id', ctx.accountId)
      .limit(1);

    if (lookupError) {
      console.error('[api/v1/media] lookup error:', lookupError);
      return fail('internal', 'Failed to look up media', 500);
    }
    if (!rows || rows.length === 0) {
      return fail('not_found', 'Media not found', 404);
    }

    let media;
    try {
      media = await downloadWhatsappMediaForAccount(
        ctx.supabase,
        ctx.accountId,
        mediaId
      );
    } catch (err) {
      if (err instanceof WhatsappMediaError) {
        if (err.code === 'not_configured') {
          return fail('whatsapp_not_configured', err.message, 400);
        }
        return fail('meta_error', err.message, 502);
      }
      throw err;
    }

    return ok({
      media_id: mediaId,
      content_type: media.contentType,
      base64: media.buffer.toString('base64'),
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
