/** Reference-only catalog. These links never trigger downloads or installation. */
export const COMMUNITY_REFERENCES = Object.freeze([
	Object.freeze({
		author: "Derivative",
		autoImport: false,
		id: "op-snippets",
		license: "Derivative distribution terms; inspect the selected example.",
		name: "OP Snippets",
		summary: "Derivative operator examples to inspect in isolated projects.",
		testedBuilds: Object.freeze([] as string[]),
		url: "https://docs.derivative.ca/OP_Snippets",
	}),
	Object.freeze({
		author: "Derivative",
		autoImport: false,
		id: "palette",
		license: "Check the selected component and included notices.",
		name: "TouchDesigner Palette",
		summary: "Built-in reusable components and learning references.",
		testedBuilds: Object.freeze([] as string[]),
		url: "https://docs.derivative.ca/Palette",
	}),
	Object.freeze({
		author: "Daniel Molnar (Function Store)",
		autoImport: false,
		id: "function-store",
		license:
			"Repository MIT; verify the selected version and bundled components.",
		licenseUrl:
			"https://github.com/function-store/FunctionStore_tools/blob/main/LICENSE",
		name: "FunctionStore_tools",
		summary: "Community workflow and operator-authoring tools.",
		testedBuilds: Object.freeze([] as string[]),
		url: "https://github.com/function-store/FunctionStore_tools",
	}),
	Object.freeze({
		author: null,
		autoImport: false,
		id: "olib",
		license: "Per-component licenses; inspect each listing and distribution.",
		name: "Olib",
		summary:
			"Community component discovery; availability is not local build verification.",
		testedBuilds: Object.freeze([] as string[]),
		url: "https://olib.amb-service.net/",
	}),
]);
