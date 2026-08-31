export const DEFAULT_EXTRACTION_DRAIN_POLICY = {
    maxBatchChars: 8_000,
    maxBatchMessages: 15,
    existingNamesMaxEntries: 150,
    existingNamesMaxChars: 3_000,
    streamTimeoutMs: 180_000,
    maxRetries: 2,
    retryDelaysMs: [5_000, 15_000],
    shutdownGraceMs: 30_000,
};
function integer(value, name, fallback, min, max) {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || Number(resolved) < min || Number(resolved) > max) {
        throw new TypeError(`[graph-memory] extractionDrain.${name} must be an integer between ${min} and ${max}, received ${String(resolved)}`);
    }
    return Number(resolved);
}
export function normalizeExtractionDrainPolicy(input) {
    const maxRetries = integer(input?.maxRetries, "maxRetries", DEFAULT_EXTRACTION_DRAIN_POLICY.maxRetries, 0, 10);
    const retryDelays = input?.retryDelaysMs ?? DEFAULT_EXTRACTION_DRAIN_POLICY.retryDelaysMs;
    if (!Array.isArray(retryDelays) || retryDelays.length < maxRetries || retryDelays.length > 10) {
        throw new TypeError(`[graph-memory] extractionDrain.retryDelaysMs must contain between ${maxRetries} and 10 delays`);
    }
    const retryDelaysMs = retryDelays.map((delay, index) => (integer(delay, `retryDelaysMs[${index}]`, 0, 0, 300_000)));
    return {
        maxBatchChars: integer(input?.maxBatchChars, "maxBatchChars", DEFAULT_EXTRACTION_DRAIN_POLICY.maxBatchChars, 64, 1_000_000),
        maxBatchMessages: integer(input?.maxBatchMessages, "maxBatchMessages", DEFAULT_EXTRACTION_DRAIN_POLICY.maxBatchMessages, 1, 1_000),
        existingNamesMaxEntries: integer(input?.existingNamesMaxEntries, "existingNamesMaxEntries", DEFAULT_EXTRACTION_DRAIN_POLICY.existingNamesMaxEntries, 0, 10_000),
        existingNamesMaxChars: integer(input?.existingNamesMaxChars, "existingNamesMaxChars", DEFAULT_EXTRACTION_DRAIN_POLICY.existingNamesMaxChars, 0, 1_000_000),
        streamTimeoutMs: integer(input?.streamTimeoutMs, "streamTimeoutMs", DEFAULT_EXTRACTION_DRAIN_POLICY.streamTimeoutMs, 10, 900_000),
        maxRetries,
        retryDelaysMs,
        shutdownGraceMs: integer(input?.shutdownGraceMs, "shutdownGraceMs", DEFAULT_EXTRACTION_DRAIN_POLICY.shutdownGraceMs, 0, 300_000),
    };
}
/**
 * Split only the temporary extraction projection. The durable message stays
 * byte-for-byte unchanged in gm_messages. Boundaries prefer paragraphs and
 * whitespace, and Array.from keeps surrogate pairs intact.
 */
export function splitExtractionContent(content, maxChars) {
    const points = Array.from(content);
    if (points.length <= maxChars)
        return [content];
    const chunks = [];
    let offset = 0;
    while (offset < points.length) {
        const hardEnd = Math.min(offset + maxChars, points.length);
        let end = hardEnd;
        if (hardEnd < points.length) {
            const softStart = offset + Math.floor(maxChars * 0.6);
            for (let cursor = hardEnd - 1; cursor >= softStart; cursor -= 1) {
                if (/\s/u.test(points[cursor])) {
                    end = cursor + 1;
                    break;
                }
            }
        }
        chunks.push(points.slice(offset, end).join(""));
        offset = end;
    }
    return chunks;
}
