import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Отдельно от сборки: тестовый рантайм ей не нужен. Тестируется чистая логика, поэтому без DOM.
export default defineConfig({
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
	test: { environment: "node", include: ["src/**/*.test.ts"] },
});
