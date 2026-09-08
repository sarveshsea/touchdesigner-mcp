import type { Role } from "../types.js";
import type { RulePack } from "./schema.js";

const types: Array<[Role, string[]]> = [
	[
		"input",
		[
			"moviefileinTOP",
			"videodeviceinTOP",
			"ndiInTOP",
			"fileinDAT",
			"oscinDAT",
			"midiinCHOP",
			"noiseTOP",
		],
	],
	[
		"audio",
		[
			"audiodeviceinCHOP",
			"audiofileinCHOP",
			"audiodeviceoutCHOP",
			"audiofilterCHOP",
			"audiospectrumCHOP",
			"audioanalysisCHOP",
			"audiooscillatorCHOP",
		],
	],
	["timing", ["timerCHOP", "beatCHOP", "lfoCHOP", "speedCHOP", "timeCOMP"]],
	[
		"control",
		[
			"constantCHOP",
			"parameterCHOP",
			"keyboardinCHOP",
			"mouseinCHOP",
			"logicCHOP",
			"switchCHOP",
		],
	],
	[
		"geometry",
		[
			"geometryCOMP",
			"geoCOMP",
			"sphereSOP",
			"gridSOP",
			"boxSOP",
			"transformSOP",
			"mergeSOP",
			"torusSOP",
		],
	],
	[
		"simulation",
		[
			"particleSOP",
			"particlePOP",
			"feedbackTOP",
			"feedbackCHOP",
			"feedbackPOP",
			"springCHOP",
			"bulletsolverCOMP",
			"solverCOMP",
		],
	],
	[
		"rendering",
		[
			"renderTOP",
			"renderpassTOP",
			"cameraCOMP",
			"lightCOMP",
			"environmentlightCOMP",
		],
	],
	[
		"post",
		[
			"blurTOP",
			"bloomTOP",
			"levelTOP",
			"compositeTOP",
			"lookupTOP",
			"displaceTOP",
			"transformTOP",
			"resolutionTOP",
		],
	],
	["typography", ["textTOP", "textSOP", "textCOMP"]],
	[
		"output",
		[
			"outTOP",
			"outCHOP",
			"outSOP",
			"outDAT",
			"outPOP",
			"moviefileoutTOP",
			"ndioutTOP",
			"syphonspoutoutTOP",
			"windowCOMP",
		],
	],
	[
		"ui",
		[
			"buttonCOMP",
			"sliderCOMP",
			"parameterCOMP",
			"containerCOMP",
			"panelCHOP",
			"fieldCOMP",
			"selectCOMP",
		],
	],
	["documentation", ["annotateCOMP", "commentCOMP"]],
];
/** Compiled with the server; copy/edit this JSON-shaped value as a custom rulePack. */
export const defaultRulePack: RulePack = {
	rules: types.map(([role, opTypes]) => ({
		id: `builtin.type.${role}`,
		match: { opTypes },
		role,
	})),
	version: 1,
};
export const familyRoles: Readonly<Record<string, Role>> = {
	CHOP: "utilities",
	COMP: "utilities",
	DAT: "utilities",
	MAT: "materials",
	POP: "simulation",
	SOP: "geometry",
	TOP: "utilities",
};
