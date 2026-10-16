import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/contract/**"],
        },
      },
      {
        test: {
          name: "contract",
          include: ["test/contract/**/*.test.ts"],
        },
      },
    ],
  },
});
