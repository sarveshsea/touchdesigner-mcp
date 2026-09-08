/** Iterative Kosaraju: O(nodes + edges), with no JS call-stack dependence. */
export function stronglyConnectedComponents(
	count: number,
	edges: ReadonlyArray<readonly [number, number]>,
): { components: number[][]; componentOf: Int32Array } {
	const forward: number[][] = Array.from({ length: count }, () => []);
	const reverse: number[][] = Array.from({ length: count }, () => []);
	for (const [a, b] of edges) {
		forward[a].push(b);
		reverse[b].push(a);
	}
	const seen = new Uint8Array(count);
	const order: number[] = [];
	for (let start = 0; start < count; start++) {
		if (seen[start]) continue;
		const stack = [start];
		const next = [0];
		seen[start] = 1;
		while (stack.length) {
			const top = stack.length - 1;
			const node = stack[top];
			if (next[top] < forward[node].length) {
				const neighbor = forward[node][next[top]++];
				if (!seen[neighbor]) {
					seen[neighbor] = 1;
					stack.push(neighbor);
					next.push(0);
				}
			} else {
				order.push(node);
				stack.pop();
				next.pop();
			}
		}
	}
	const componentOf = new Int32Array(count).fill(-1);
	const components: number[][] = [];
	for (let cursor = order.length - 1; cursor >= 0; cursor--) {
		const start = order[cursor];
		if (componentOf[start] !== -1) continue;
		const members: number[] = [];
		const stack = [start];
		const id = components.length;
		componentOf[start] = id;
		while (stack.length) {
			const node = stack.pop() as number;
			members.push(node);
			for (const neighbor of reverse[node])
				if (componentOf[neighbor] === -1) {
					componentOf[neighbor] = id;
					stack.push(neighbor);
				}
		}
		components.push(members);
	}
	return { componentOf, components };
}
