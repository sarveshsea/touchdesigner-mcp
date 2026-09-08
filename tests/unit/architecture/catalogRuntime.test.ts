import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	catalogHeaderScript,
	catalogPageScript,
} from "../../../src/architecture/catalog/runtime.js";

function execute(script: string, fixture = "") {
	const setup = `import sys, types, json
class Guard:
    def __new__(cls): raise AssertionError('Operator construction forbidden')
class Noise(Guard):
    opType='noiseTOP'
    family='TOP'
    label='Noise'
    isFilter=False
    isSupported=True
    minInputs=0
    maxInputs=0
class Custom(Guard):
    opType='customX'
    family='CUSTOM'
    isFilter=property(lambda self: False)
module=types.ModuleType('td')
module.app=types.SimpleNamespace(version='2025', build='33230')
module.families={'TOP':[Noise], 'CUSTOM':[Custom]}
module.opTypes={'noiseTOP':Noise,'customX':Custom}
module.noiseTOP=Noise
sys.modules['td']=module
${fixture}\n`;
	return JSON.parse(
		execFileSync("python3", ["-c", `${setup + script}\nprint(result)`], {
			encoding: "utf8",
		}),
	);
}
describe("read-only runtime registry discovery", () => {
	it("reads exact registry types without constructing or guessing descriptor values", () => {
		const result = execute(catalogPageScript(0));
		expect(result.entries).toEqual([
			{ family: "CUSTOM", opType: "customX" },
			{
				family: "TOP",
				isFilter: false,
				isSupported: true,
				label: "Noise",
				maxInputs: 0,
				minInputs: 0,
				opType: "noiseTOP",
			},
		]);
	});
	it("uses family membership when registry members are type names and opTypes is missing", () => {
		const h = execute(
			catalogHeaderScript(),
			"module.families={'TOP':['noiseTOP']}\ndel module.opTypes",
		);
		expect(h.registryCount).toBe(1);
		expect(h.families).toEqual(["TOP"]);
	});
	it("bounds pages and registry counts", () => {
		const result = execute(
			catalogPageScript(128),
			"module.families={}\nmodule.opTypes={str(i):None for i in range(9000)}",
		);
		expect(result.entries).toHaveLength(128);
		expect(result.truncated).toBe(true);
		expect(result.nextOffset).toBe(256);
		expect(() => catalogPageScript(-1)).toThrow();
		expect(() => catalogPageScript(0, 129)).toThrow();
	});
});
