/**
 * Chatwoot Active Storage and explicitly allowed HTTPS object-storage origins.
 * An object store or untrusted redirect never receives a Chatwoot API token.
 */
export interface DownloadOptions {
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    maxRedirects?: number;
    timeoutMs?: number;
    allowedExternalOrigins?: string[];
}

function trustedUrl(candidate: string, base: string, external: string[]): {url: URL; sendToken: boolean} {
    let url: URL;
    let origin: URL;
    try {
        origin = new URL(base);
        url = new URL(candidate, origin);
    } catch {
        throw new Error('Invalid attachment URL');
    }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
        url.username || url.password || /%(?:2f|5c|2e)/i.test(url.pathname)) {
        throw new Error('Untrusted attachment URL');
    }
    if (url.origin === origin.origin && url.pathname.startsWith('/rails/active_storage/')) return {url, sendToken:true};
    if (url.protocol === 'https:' && external.includes(url.origin)) return {url, sendToken:false};
    throw new Error('Untrusted attachment URL');
}

export async function downloadSafeChatwootAttachment(
    candidate: string,
    base: string,
    token: string,
    options: DownloadOptions = {},
): Promise<{ buffer: Buffer; mimeType?: string }> {
    if (!token) throw new Error('Missing attachment access token');
    const maxBytes = options.maxBytes ?? 45 * 1024 * 1024;
    const maxRedirects = options.maxRedirects ?? 3;
    const fetchImpl = options.fetchImpl ?? fetch;
    const signal = AbortSignal.timeout(options.timeoutMs ?? 20_000);
    const external = (options.allowedExternalOrigins ?? []).map(value => {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hostname.includes('*') || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid object storage origin');
        return parsed.origin;
    });
    let target = trustedUrl(candidate, base, external);

    for (let redirect = 0; redirect <= maxRedirects; redirect++) {
        // The redirect target is validated before a second request is issued.
        const response = await fetchImpl(target.url, {
            method: 'GET',
            headers: target.sendToken ? { Authorization: `Bearer ${token}` } : {},
            redirect: 'manual',
            signal,
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location || redirect === maxRedirects) throw new Error('Attachment redirect rejected');
            target = trustedUrl(new URL(location, target.url).toString(), base, external);
            continue;
        }
        if (!response.ok || !response.body) throw new Error('Attachment download failed');
        const size = response.headers.get('content-length');
        if (size && (!/^\d+$/.test(size) || Number(size) > maxBytes)) {
            await response.body.cancel();
            throw new Error('Attachment too large');
        }
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > maxBytes) throw new Error('Attachment too large');
                chunks.push(Buffer.from(value));
            }
        } catch (error) {
            await reader.cancel().catch(() => undefined);
            throw error;
        } finally {
            reader.releaseLock();
        }
        return { buffer: Buffer.concat(chunks), mimeType: response.headers.get('content-type') ?? undefined };
    }
    throw new Error('Attachment redirect rejected');
}
