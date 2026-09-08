/** Explicit opt-in test against local TD; only owns its temporary COMP. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const url = "http://127.0.0.1:9981/api/td/server/exec";
async function exec(script) {
	const response = await fetch(url, {
		body: JSON.stringify({ script }),
		headers: { "Content-Type": "application/json" },
		method: "POST",
		signal: AbortSignal.timeout(30000),
	});
	assert(response.ok, `TD HTTP ${response.status}`);
	const body = await response.json();
	if (!body.success) throw new Error(body.error || "TD execution failed");
	return JSON.parse(body.data.result);
}
const client = new Client({ name: "set-design-live-smoke", version: "1" });
const root = "/project1/__setdesign_mcp_smoke";
let ownerId = null;
const checks = [];
try {
	const setup = await exec(
		`import json,td\np=op('/project1')\nif p.op('__setdesign_mcp_smoke') is not None: raise RuntimeError('Smoke target already exists; refusing to replace it')\nr=p.create(td.baseCOMP,'__setdesign_mcp_smoke')\na=r.create(td.constantTOP,'source');a.par.outputresolution='custom';a.par.resolutionw=320;a.par.resolutionh=180\nb=r.create(td.nullTOP,'output');b.inputConnectors[0].connect(a)\nx=r.create(td.textDAT,'__mcp_tmp_res__source');x.text='owned fixture remains'\nresult=json.dumps({'id':r.id,'collision':x.id,'paths':[a.path,b.path,x.path]})`,
	);
	ownerId = setup.id;
	await client.connect(
		new StdioClientTransport({
			args: [
				process.env.TD_MCP_CLI ||
					fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
				"--stdio",
				"--host=http://127.0.0.1",
				"--port=9981",
			],
			command: process.execPath,
			stderr: "ignore",
		}),
	);
	const { tools } = await client.listTools();
	assert(
		tools.some(
			(t) =>
				t.name === "get_td_network_snapshot" &&
				t.annotations?.readOnlyHint === true,
		),
	);
	checks.push("built MCP stdio registration and read-only annotation");
	async function call(name, args) {
		const res = await client.callTool({ arguments: args, name });
		assert(!res.isError, JSON.stringify(res));
		return res;
	}
	async function report(name, args) {
		const res = await call(name, args);
		return JSON.parse(res.content.find((c) => c.type === "text").text);
	}
	const snapshot = await report("get_td_network_snapshot", {
		maxDepth: 1,
		maxNodes: 10,
		parentPath: root,
	});
	assert(snapshot.ok && snapshot.nodeCount === 4);
	assert(snapshot.connections.length >= 1);
	checks.push("live TD hierarchy and wire snapshot");
	const truncated = await report("get_td_network_snapshot", {
		maxDepth: 1,
		maxNodes: 2,
		parentPath: root,
	});
	assert(truncated.truncated && truncated.nodeCount === 2);
	const preview = await report("layout_td_network", {
		columns: 2,
		nodePaths: setup.paths,
		parentPath: root,
	});
	assert(preview.dryRun === true);
	const unchanged = await report("layout_td_network", {
		columns: 2,
		nodePaths: setup.paths,
		parentPath: root,
	});
	assert.deepEqual(unchanged.changes, preview.changes);
	const applied = await report("layout_td_network", {
		columns: 2,
		dryRun: false,
		nodePaths: setup.paths,
		parentPath: root,
	});
	assert(applied.dryRun === false);
	const after = await report("layout_td_network", {
		columns: 2,
		nodePaths: setup.paths,
		parentPath: root,
	});
	assert(
		after.changes.every(
			(c) => c.before.x === c.after.x && c.before.y === c.after.y,
		),
	);
	checks.push("dry-run and applied coordinate layout");
	const image = await call("get_top_image", {
		maxSize: 96,
		nodePath: `${root}/source`,
	});
	assert(
		image.content.some(
			(c) =>
				c.type === "image" && c.mimeType === "image/jpeg" && c.data.length > 10,
		),
	);
	const kept = await exec(
		`import json\nr=op('${root}');x=r.op('__mcp_tmp_res__source')\nresult=json.dumps({'id':x.id,'text':x.text,'children':len(r.children)})`,
	);
	assert.equal(kept.id, setup.collision);
	assert.equal(kept.text, "owned fixture remains");
	assert.equal(kept.children, 3);
	checks.push(
		"real JPEG capture preserves colliding node and cleans own temporary TOP",
	);
	process.stdout.write(
		`${JSON.stringify(
			{ checks, ok: true, scope: "isolated temporary COMP; no artwork edited" },
			null,
			2,
		)}\n`,
	);
} finally {
	await client.close();
	if (ownerId !== null)
		await exec(
			`import json\nr=op('${root}')\nif r is not None and r.id==${ownerId}:r.destroy()\nresult=json.dumps({'cleaned':op('${root}') is None})`,
		);
}
