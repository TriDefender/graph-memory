/**
 * graph-memory — 跨对话召回
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * Query recall is deliberately relevance-first: vector ranking is preserved,
 * with FTS5 as an exact-term/failure fallback. Graph centrality is useful for
 * offline graph inspection, but must not displace the memories most similar
 * to the current user question.
 */
import { createHash } from "crypto";
import { searchNodes, vectorSearchWithScore, graphWalk, saveVector, getVectorHash, } from "../store/store.js";
export class Recaller {
    db;
    cfg;
    embed = null;
    embeddingFingerprint = "";
    constructor(db, cfg) {
        this.db = db;
        this.cfg = cfg;
    }
    setEmbedFn(fn, fingerprint = "") {
        this.embed = fn;
        this.embeddingFingerprint = fingerprint;
    }
    async recall(query) {
        const limit = this.cfg.recallMaxNodes;
        let queryVector;
        if (this.embed) {
            try {
                queryVector = await this.embed(query, "query");
            }
            catch {
                // The lexical path remains available when the embedding provider is
                // temporarily unavailable.
            }
        }
        return this.recallPrecise(query, limit, queryVector);
    }
    /**
     * Preserve semantic rank. FTS5 contributes exact terms and is the complete
     * fallback when the embedding provider is absent or temporarily fails.
     */
    async recallPrecise(query, limit, queryVector) {
        const lexical = searchNodes(this.db, query, limit);
        const semantic = queryVector
            ? vectorSearchWithScore(this.db, queryVector, limit, this.cfg.semanticScoreThreshold)
            : [];
        const selected = [];
        const selectedIds = new Set();
        const append = (node) => {
            if (selected.length >= limit || selectedIds.has(node.id))
                return;
            selected.push(node);
            selectedIds.add(node.id);
        };
        for (const { node } of semantic)
            append(node);
        for (const node of lexical)
            append(node);
        if (!selected.length)
            return { nodes: [], edges: [] };
        // Depth zero asks the store only for edges whose two endpoints are direct
        // query matches. No unrelated graph hub is allowed to enter the prompt.
        const { edges } = graphWalk(this.db, selected.map(node => node.id), 0);
        return { nodes: selected, edges };
    }
    /** 异步同步 embedding，不阻塞主流程 */
    async syncEmbed(node) {
        if (!this.embed)
            return;
        const temporal = Object.keys(node.temporal).length ? `\n时间语义: ${JSON.stringify(node.temporal)}` : "";
        const text = `${node.name}: ${node.description}\n${node.content}${temporal}`;
        const hashInput = this.embeddingFingerprint ? `${this.embeddingFingerprint}\0${text}` : text;
        const hash = createHash("md5").update(hashInput).digest("hex");
        if (getVectorHash(this.db, node.id) === hash)
            return;
        try {
            const vec = await this.embed(text, "db");
            if (vec.length)
                saveVector(this.db, node.id, hashInput, vec);
        }
        catch { /* 不影响主流程 */ }
    }
}
