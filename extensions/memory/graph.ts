import type { MemoryEdge } from "../../core";

interface GraphEdgeIndex {
	length: number;
	byKey: Map<string, MemoryEdge>;
}

const indexes = new WeakMap<MemoryEdge[], GraphEdgeIndex>();
const edgeKey = (edge: MemoryEdge): string => JSON.stringify([edge.from, edge.to, edge.kind]);

function getIndex(edges: MemoryEdge[]): GraphEdgeIndex {
	const cached = indexes.get(edges);
	if (cached?.length === edges.length) return cached;

	const byKey = new Map<string, MemoryEdge>();
	for (const edge of edges) {
		const key = edgeKey(edge);
		if (!byKey.has(key)) byKey.set(key, edge);
	}
	const index = { length: edges.length, byKey };
	indexes.set(edges, index);
	return index;
}

export function upsertGraphEdge(edges: MemoryEdge[], edge: MemoryEdge): "added" | "updated" {
	const index = getIndex(edges);
	const existing = index.byKey.get(edgeKey(edge));
	if (existing) {
		existing.label = edge.label;
		return "updated";
	}

	edges.push(edge);
	index.byKey.set(edgeKey(edge), edge);
	index.length = edges.length;
	return "added";
}
