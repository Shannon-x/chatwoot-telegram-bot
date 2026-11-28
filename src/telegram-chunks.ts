// Telegram's text limit is 4096 characters. A smaller UTF-16 budget leaves
// headroom for differences in counting, and iterating code points avoids
// cutting a surrogate pair in half. Content is sent without HTML parse mode.
export function splitPlainText(text: string, maxUnits = 3000): string[] {
    if (!Number.isInteger(maxUnits) || maxUnits < 2) throw new Error('Invalid chunk size');
    const chunks: string[] = [];
    let part = '';
    for (const char of text) {
        if (part.length + char.length > maxUnits) {
            chunks.push(part);
            part = '';
        }
        part += char;
    }
    if (part || !chunks.length) chunks.push(part);
    return chunks;
}
