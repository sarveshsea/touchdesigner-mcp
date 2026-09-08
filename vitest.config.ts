import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			thresholds: { branches: 80, functions: 80, lines: 80, statements: 80 },
		},
		environment: "node",
		globals: true,
		include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}"],
	},
});
