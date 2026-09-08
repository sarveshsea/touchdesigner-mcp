/** Versioned, source-free architecture interchange shared by tools and panel. */
export type Evidence = "observed" | "static" | "unresolved";
export interface GraphNode {
	id: number;
	path: string;
	parentPath: string;
	name: string;
	family: string;
	opType: string;
	subType?: string;
	tags: string[];
	nodeX: number;
	nodeY: number;
	nodeWidth?: number;
	nodeHeight?: number;
	flags: Record<string, boolean | null>;
	ownership: string[];
	fingerprint: string;
	parameterReferences?: ParameterReference[];
	sourceHashes?: Record<string, string>;
}
export interface ParameterReference {
	name: string;
	mode: string;
	targetPaths: string[];
	evidence: Evidence;
	reason?: string;
}
export interface GraphEdge {
	id: string;
	kind:
		| "containment"
		| "wire"
		| "component-wire"
		| "parameter"
		| "expression"
		| "binding"
		| "export"
		| "ownership";
	source: string;
	target: string;
	evidence: Evidence;
	inputIndex?: number;
	outputIndex?: number;
	parameter?: string;
	reason?: string;
}
export interface ProjectGraph {
	schemaVersion: 1;
	projectId: string;
	projectPath: string;
	sessionId: string;
	build: string;
	rootPath: string;
	revision: number;
	observedAt: string;
	status: "fresh" | "stale" | "disconnected" | "scanning";
	complete: boolean;
	dependencyComplete: boolean;
	nodes: GraphNode[];
	edges: GraphEdge[];
	warnings: string[];
	coverage: { visited: number; remaining: number | null; truncated: boolean };
}
export interface BridgeExecutor {
	execute(script: string): Promise<unknown>;
}
export type Role =
	| "input"
	| "audio"
	| "timing"
	| "control"
	| "geometry"
	| "simulation"
	| "materials"
	| "rendering"
	| "post"
	| "typography"
	| "output"
	| "ui"
	| "utilities"
	| "documentation"
	| "mixed"
	| "unknown";
export interface Classification {
	confidence: number;
	path: string;
	role: Role;
	evidence: Array<{
		ruleId: string;
		role: Role;
		source: string;
		priority: number;
	}>;
	conflicts: Role[];
}
export interface LayoutProposal {
	path: string;
	x: number;
	y: number;
	group: string;
	pinned: boolean;
}
