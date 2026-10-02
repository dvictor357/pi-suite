import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ["extensions/subagent/**/*.test.ts"], setupFiles: ["./test/isolate-home.ts"] },
});
